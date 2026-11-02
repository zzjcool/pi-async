import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../extensions/index.ts";
import { resetTuiHostForTests } from "../src/tui/host.ts";

/**
 * Factory-API contract hardening (postmortem 2026-10-15):
 *
 * Two production bugs slipped past 85 green tests because unit-test mocks
 * invented fields the real pi host never provides at factory time:
 *
 *   1. TUI crash — tools returned bare objects; pi 1.2.0 does NOT auto-wrap
 *      extension tool results into {content:[...]} (ToolResultMessage).
 *   2. TUI never registered — (pi as any).mode === "tui" at init() is always
 *      false: the factory ExtensionAPI has no `mode`/`ui`; those live on
 *      event-handler contexts only.
 *
 * These tests pin the REAL factory-API surface our init() may rely on. If
 * pi changes the surface (adds ui, renames registerTool, ...), these tests
 * fail and force a conscious migration instead of silent breakage.
 */

/** The minimum surface init() needs from the factory-time pi object. */
type FactoryPi = {
  cwd?: string;
  registerTool?: unknown;
  registerMessageRenderer?: unknown;
  on?: unknown;
  sendMessage?: unknown;
  appendEntry?: unknown;
  sessionManager?: { getSessionDir?: () => string | undefined; getSessionId?: () => string | undefined };
};

/** Build a factory pi that mirrors the REAL host surface: NO mode, NO ui, NO cwd at factory time. */
function realFactoryPi(overrides: Partial<FactoryPi> = {}): Record<string, unknown> {
  return {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: () => () => undefined,
    sendMessage: () => undefined,
    registerMessageRenderer: () => undefined,
    appendEntry: () => undefined,
    setLabel: () => undefined,
    getSessionName: () => "contract-test",
    // D-16: never fall back to the repo cwd or the real ~/.pi — a test that needs a data dir
    // must override sessionManager with its own mkdtemp directory.
    sessionManager: {
      getSessionDir: () => { throw new Error("test must provide a session dir (D-16)"); },
      getSessionId: () => "contract-test-session",
    },
    ...overrides,
  };
}

test("init tolerates a factory API without mode/ui (the real pi 1.2.0 surface)", async () => {
  resetTuiHostForTests();
  const dir = mkdtempSync(join(tmpdir(), "pi-async-factory-contract-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  const widgets: string[] = [];
  const statuses: string[] = [];
  const pi = realFactoryPi({
    cwd: dir,
    sessionManager: { getSessionDir: () => dir, getSessionId: () => "contract-test-session" },
    on: (event: string, handler: (e: unknown, c: unknown) => void) => {
      hooks.set(event, handler as (event: unknown, ctx: unknown) => void);
      return () => hooks.delete(event);
    },
  });
  try {
    // must not throw, must not require pi.mode / pi.ui to exist
    await init(pi as never);

    // No TUI surfaces may bind from the factory object alone.
    hooks.get("message_start")?.({ type: "message_start" }, {});
    // (session_start ctx without mode==="tui" must not bind either — e.g. RPC)
    hooks.get("session_start")?.({ type: "session_start", reason: "new" }, { mode: "rpc", hasUI: true, ui: {} });
    assert.equal(widgets.length, 0, "RPC contexts must never register rail widget");

    // A tui ctx must bind — and only through ctx.ui, never factory pi.ui.
    const ctxUi = {
      setWidget: (key: string) => { widgets.push(key); },
      setStatus: (key: string) => { statuses.push(key); },
    };
    hooks.get("session_start")?.({ type: "session_start", reason: "new" }, { mode: "tui", hasUI: true, ui: ctxUi });
    hooks.get("message_start")?.({ type: "message_start" }, { mode: "tui", hasUI: true, ui: ctxUi });
    // D-16: the session-scoped data dir (<sessionDir>/pi-async/<sessionId>) is created lazily on
    // first persist — factory/configure must not leave artifacts, and tests never touch ~/.pi.
    assert.equal(existsSync(join(dir, ".pi")), false, "the legacy <cwd>/.pi data dir is gone");
    assert.ok(widgets.includes("pi-async-rail"), "tui session_start ctx binds the rail widget");
    assert.ok(!statuses.includes("pi-async"), "footer status is retired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetTuiHostForTests();
  }
});

test("init never throws when the factory API is missing optional methods entirely", async () => {
  resetTuiHostForTests();
  const dir = mkdtempSync(join(tmpdir(), "pi-async-factory-minimal-"));
  try {
    // Degraded hosts: no on(), no registerTool(), no sessionManager.
    await init({} as never);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetTuiHostForTests();
  }
});

/**
 * Regression: 2026-10-21 crash (fixed differently in 0.3.0). The old fix added a
 * heartbeat timer that had to be cleared on reload; 0.3.0 deletes the heartbeat
 * entirely (D-12), so `init()` must not create ANY interval, and a second init must
 * retire the previous generation without throwing (never killing adopted work —
 * reload adoption is covered in tests/d-reload.test.ts).
 */
test("init() creates no interval timer and a second init() retires the previous generation without throwing", async () => {
  resetTuiHostForTests();
  const dir = mkdtempSync(join(tmpdir(), "pi-async-reload-guard-"));
  const created: ReturnType<typeof setInterval>[] = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  // SAFETY: the test swaps only the two timer functions for the duration of one init pair.
  globalThis.setInterval = ((handler: never, ms?: number) => {
    const handle = realSet(handler, ms);
    created.push(handle);
    return handle;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: never) => realClear(handle)) as unknown as typeof globalThis.clearInterval;
  const generation = (): Record<string, unknown> => ({
    cwd: dir,
    pid: process.pid,
    sessionManager: { getSessionDir: () => dir, getSessionId: () => "reload-guard-session" },
    registerTool: () => undefined,
    registerMessageRenderer: () => undefined,
    on: () => () => undefined,
    appendEntry: () => undefined,
  });
  try {
    await init(generation() as never);
    assert.equal(created.length, 0, "the factory must not start any interval timer (heartbeat removed, D-12)");
    await init(generation() as never);
    assert.equal(created.length, 0, "re-init must not start an interval timer either");
    assert.equal(existsSync(join(dir, "pi-async", "reload-guard-session")), false, "the factory must not create the data dir (D-04)");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    rmSync(dir, { recursive: true, force: true });
    resetTuiHostForTests();
  }
});
