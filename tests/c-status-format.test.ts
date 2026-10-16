import assert from "node:assert/strict";
import test from "node:test";
import { disposeStatus, formatStatus, initStatus } from "../src/tui/status.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("footer separates running from pending and counts all terminal as done", () => {
  assert.equal(formatStatus({ running: 3, pending: 2 }, 7), " 3 running · 2 pending · 7 done ");
  assert.equal(formatStatus({ running: 3, pending: 0 }, 7), " 3 running · 7 done ");
  assert.equal(formatStatus({ running: 0, pending: 1 }, 0), " 0 running · 1 pending · 0 done ");
});

test("status refresh counts failed and killed toward done", () => {
  const statuses: string[] = [];
  const ui = { setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); } };
  bindTuiHost({ mode: "tui", ui });
  const originalSetInterval = globalThis.setInterval;
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = (() => {
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  try {
    const now = Date.now();
    const registry = {
      activeCount: () => ({ running: 0, pending: 0 }),
      list: () => [
        makeSnapshot({ status: "completed", taskId: "ok", finishedAt: now }),
        makeSnapshot({ status: "failed", taskId: "bad", finishedAt: now }),
        makeSnapshot({ status: "killed", taskId: "dead", finishedAt: now }),
      ],
    } as never;
    initStatus({} as never, registry);
    assert.equal(statuses.at(-1), " 0 running · 3 done ");
  } finally {
    disposeStatus();
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
  }
});

test("status init replaces its interval and dispose clears it", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const cleared: unknown[] = [];
  let nextId = 0;
  (globalThis as unknown as { setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval> }).setInterval = () => ({ id: ++nextId, unref() {} } as unknown as ReturnType<typeof setInterval>);
  (globalThis as unknown as { clearInterval: (id: ReturnType<typeof setInterval>) => void }).clearInterval = (id) => { cleared.push(id); };
  try {
    const ui = { setStatus() {} };
    bindTuiHost({ mode: "tui", ui });
    const pi = {} as never;
    const registry = { activeCount: () => ({ running: 0, pending: 0 }), list: () => [] } as never;
    initStatus(pi, registry);
    initStatus(pi, registry);
    assert.equal(cleared.length, 1);
    disposeStatus();
    assert.equal(cleared.length, 2);
  } finally {
    disposeStatus();
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
