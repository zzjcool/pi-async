import assert from "node:assert/strict";
import test from "node:test";
import { registerPrintWait } from "../src/guard/print-wait.ts";
import { HoldNotificationRelay } from "../src/guard/hold-notify.ts";
import { isTerminal, type TaskSnapshot } from "../src/core/task.ts";
import { makeSnapshot } from "./helpers/index.ts";

/**
 * D5 (0.5.0): the headless (`pi -p`) backstop.
 *
 * These tests drive the boundary handler directly against a fake host and a fake registry — no real
 * `pi`, no child process, no data dir. What they pin, one test each:
 *
 * 1. the settle boundary really waits for a running task (and produces the results draft);
 * 2. a notification intercepted by the shared relay is not announced a second time;
 * 3. the continuation cap ends the wait loudly (stderr + non-zero `process.exitCode`);
 * 4. the overall budget does the same and releases what it intercepted;
 * 5. any mode that is not `print` (including a missing ctx) returns before reading the registry;
 * 6. `PI_ASYNC_PRINT_WAIT=0` registers nothing at all;
 * 7. the results entry is bounded to name/status/exit — never an output tail.
 */

type Handler = (...args: unknown[]) => unknown;

/** Fake pi host: `on` returns an unsubscribe function and records handlers in registration order. */
function makePi() {
  const handlers = new Map<string, Handler[]>();
  const unsubscribed: string[] = [];
  let onCalls = 0;
  const pi = {
    on(event: string, handler: Handler): () => void {
      onCalls++;
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        unsubscribed.push(event);
        const current = handlers.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) handlers.delete(event);
      };
    },
  };
  const fire = (event: string, ...args: unknown[]): unknown[] => (handlers.get(event) ?? []).map((handler) => handler(...args));
  const fireOne = (event: string, ...args: unknown[]): unknown => fire(event, ...args)[0];
  return { pi, handlers, unsubscribed, fire, fireOne, onCalls: () => onCalls };
}

/** ~9 KiB of text the results entry must never inline (bounded-content rule). */
const OUTPUT_TAIL_MARKER = "<8KiB-output-tail-marker>";

/**
 * Fake registry: `list()` serves whatever the test last put in, `includeHistory: false` drops
 * terminal rows exactly like the real registry (`src/core/registry.ts`), and the delivery API is
 * spied on so a test can prove the wait never consumes output or flips a consumer latch.
 */
function makeRegistry(initial: TaskSnapshot[]) {
  let rows = initial;
  let listCalls = 0;
  const notified: string[] = [];
  const spy = { wait: 0, consume: 0, claimNotification: 0, logs: 0 };
  return {
    list(opts: { includeHistory?: boolean } = {}): TaskSnapshot[] {
      listCalls++;
      return opts.includeHistory === false ? rows.filter((task) => !isTerminal(task.status)) : rows.slice();
    },
    markNotified(taskId: string): void {
      notified.push(taskId);
    },
    logs(): { text: string; truncated: boolean } {
      spy.logs++;
      return { text: OUTPUT_TAIL_MARKER.repeat(400), truncated: false };
    },
    wait(): Promise<{ results: unknown[] }> {
      spy.wait++;
      return Promise.resolve({ results: [] });
    },
    consume(): void {
      spy.consume++;
    },
    claimNotification(): boolean {
      spy.claimNotification++;
      return true;
    },
    setRows(next: TaskSnapshot[]): void {
      rows = next;
    },
    rows: (): TaskSnapshot[] => rows,
    notified,
    spy,
    listCalls: () => listCalls,
  };
}

const running = (taskId: string, name: string) => makeSnapshot({ taskId, name, status: "running" });
const completed = (taskId: string, name: string, exitCode = 0) => makeSnapshot({ taskId, name, status: "completed", exitCode });
const failed = (taskId: string, name: string, exitCode = 7) => makeSnapshot({ taskId, name, status: "failed", exitCode });

type Draft = { type?: unknown; customType?: unknown; content?: unknown; display?: unknown };
type Result = { entries?: unknown[]; continue?: unknown };

/** The frozen normal-path shape: `continue: true` plus our draft as the last entry. */
function resultsDraft(result: unknown): Draft {
  assert.ok(result !== null && typeof result === "object", "the normal path returns a result object");
  const shape = result as Result;
  assert.equal(shape.continue, true, "the normal path forces one more provider request");
  const entries = Array.isArray(shape.entries) ? shape.entries : [];
  const draft = (entries.at(-1) ?? undefined) as Draft | undefined;
  assert.equal(draft?.type, "custom_message");
  assert.equal(draft?.customType, "async-task-print-results");
  assert.equal(draft?.display, false);
  return draft!;
}

type EnvName =
  | "PI_ASYNC_PRINT_WAIT"
  | "PI_ASYNC_PRINT_WAIT_MS"
  | "PI_ASYNC_PRINT_POLL_MS"
  | "PI_ASYNC_PRINT_MAX_CONTINUATIONS";

/** Every knob off by default, so an ambient value in the developer shell cannot change a test. */
const CLEAN: Record<EnvName, undefined> = {
  PI_ASYNC_PRINT_WAIT: undefined,
  PI_ASYNC_PRINT_WAIT_MS: undefined,
  PI_ASYNC_PRINT_POLL_MS: undefined,
  PI_ASYNC_PRINT_MAX_CONTINUATIONS: undefined,
};

/** Applies env overrides (undefined deletes) for the duration of `fn`, then restores all of them. */
async function withEnv<T>(env: Partial<Record<EnvName, string | undefined>>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<EnvName, string | undefined>();
  for (const name of Object.keys(env) as EnvName[]) {
    saved.set(name, process.env[name]);
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Runs `fn` with `console.error` captured, then restores `process.exitCode`.
 *
 * stderr is the only reporting channel a headless run has, and `process.exitCode` is shared by the
 * whole node:test process — a leaked `1` would fail unrelated suites, so the observed value is
 * returned *before* the restore and the restore itself always happens.
 */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[]; exitCode: typeof process.exitCode }> {
  const saved = process.exitCode;
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await fn();
    return { result, lines, exitCode: process.exitCode };
  } finally {
    console.error = original;
    process.exitCode = saved;
  }
}

test("a running task keeps the print turn unsettled until it finishes", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T1", "slow job")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000 });
    const flip = setTimeout(() => registry.setRows([completed("T1", "slow job", 0)]), 120);
    try {
      const startedAt = performance.now();
      const result = await fireOne("agent_before_settle", {}, { mode: "print" });
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 100, `the boundary waited for the task (${elapsed.toFixed(0)}ms)`);
      const draft = resultsDraft(result);
      assert.match(String(draft.content), /slow job/, "the entry names the task that finished");
      assert.match(String(draft.content), /async_logs/, "and points the reader at the output");
      assert.ok(registry.listCalls() >= 2, "at least one poll happened after the opening read");
      assert.deepEqual(registry.spy, { wait: 0, consume: 0, claimNotification: 0, logs: 0 }, "the wait consumes nothing");
    } finally {
      clearTimeout(flip);
      dispose();
    }
  });
});

test("a completion intercepted by the relay is announced once, and latched", async () => {
  await withEnv(CLEAN, async () => {
    const relay = new HoldNotificationRelay();
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T2", "dedupe job")]);
    let sendCalls = 0;
    let claimed: boolean | undefined;
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000, notify: relay });
    // Exactly what extensions/index.ts's `onFinalize` does while a wait is armed.
    const flip = setTimeout(() => {
      registry.setRows([completed("T2", "dedupe job", 0)]);
      claimed = relay.claim("T2", () => {
        sendCalls++;
      });
    }, 60);
    try {
      const result = await fireOne("agent_before_settle", {}, { mode: "print" });
      const draft = resultsDraft(result);
      assert.equal(claimed, true, "the relay claimed the deferred completion (the wait was armed)");
      assert.equal(sendCalls, 0, "the results entry is the only announcement — no second followUp");
      assert.deepEqual(registry.notified, ["T2"], "the id is latched so resendUnnotified skips it");
      assert.match(String(draft.content), /dedupe job/);
    } finally {
      clearTimeout(flip);
      dispose();
    }
  });
});

test("the continuation cap ends the wait loudly (stderr + exit code 1)", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T3", "capped job")]);
    const { result, lines, exitCode } = await captureStderr(async () => {
      const dispose = registerPrintWait(pi as never, registry as never, { maxContinuations: 0 });
      try {
        const startedAt = performance.now();
        const value = await fireOne("agent_before_settle", {}, { mode: "print" });
        assert.ok(performance.now() - startedAt < 100, "a spent cap must not wait at all");
        return value;
      } finally {
        dispose();
      }
    });
    assert.equal(result, undefined, "the throttled path returns no entries and no continue");
    assert.equal(exitCode, 1, "the caller must see a non-zero exit instead of empty stdout");
    assert.ok(
      lines.some((line) => line.includes("pi-async:") && line.includes("still running") && line.includes("T3")),
      `stderr names the task id: ${JSON.stringify(lines)}`,
    );
  });
});

test("the overall budget ends the wait loudly and releases what it intercepted", async () => {
  await withEnv(CLEAN, async () => {
    const relay = new HoldNotificationRelay();
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T4", "forever job")]);
    let released = 0;
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 150, notify: relay });
    const claim = setTimeout(() => {
      relay.claim("T4", () => {
        released++;
      });
    }, 40);
    try {
      const startedAt = performance.now();
      const { result, lines, exitCode } = await captureStderr(() => fireOne("agent_before_settle", {}, { mode: "print" }) as Promise<unknown>);
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 120, `waited for the budget (${elapsed.toFixed(0)}ms)`);
      assert.equal(result, undefined, "the throttled path returns no entries and no continue");
      assert.equal(exitCode, 1);
      assert.ok(lines.some((line) => line.includes("T4") && line.includes("still running")), JSON.stringify(lines));
      assert.equal(released, 1, "release() handed the deferred notification back to its sender");
    } finally {
      clearTimeout(claim);
      dispose();
    }
  });
});

test("every mode but print returns immediately, without reading the registry", async () => {
  await withEnv(CLEAN, async () => {
    const savedExitCode = process.exitCode;
    const cases: Array<[string, unknown[]]> = [
      ["tui ctx", [{}, { mode: "tui" }]],
      ["rpc ctx", [{}, { mode: "rpc" }]],
      ["json ctx", [{}, { mode: "json" }]],
      ["missing ctx", [{}]],
      ["undefined event and ctx", []],
    ];
    try {
      for (const [label, args] of cases) {
        const { pi, fireOne } = makePi();
        const registry = makeRegistry([running("T0", "not ours")]);
        const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000 });
        const startedAt = performance.now();
        const result = await (fireOne("agent_before_settle", ...args) as Promise<unknown>);
        const elapsed = performance.now() - startedAt;
        dispose();
        assert.equal(result, undefined, `${label}: nothing is returned`);
        assert.ok(elapsed < 100, `${label}: returned without waiting (${elapsed.toFixed(0)}ms)`);
        assert.equal(registry.listCalls(), 0, `${label}: the gate returns before any liveness read`);
        assert.equal(process.exitCode, savedExitCode, `${label}: no exit code is imposed`);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

test("PI_ASYNC_PRINT_WAIT=0 registers no hook at all", async () => {
  await withEnv({ ...CLEAN, PI_ASYNC_PRINT_WAIT: "0" }, () => {
    const { pi, onCalls, handlers } = makePi();
    const registry = makeRegistry([running("T-Off", "ignored")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20 });
    assert.equal(onCalls(), 0, "the switch registers nothing, not even a teardown hook");
    assert.equal(handlers.size, 0);
    assert.equal(registry.listCalls(), 0);
    assert.doesNotThrow(() => {
      dispose();
      dispose();
    });
  });
});

test("the results entry is bounded to name/status/exit — never an output tail", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T7", "bounded job"), running("T7b", "second job")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000 });
    const flip = setTimeout(() => registry.setRows([completed("T7", "bounded job", 3), failed("T7b", "second job", 7)]), 60);
    try {
      const result = await fireOne("agent_before_settle", {}, { mode: "print" });
      const content = String(resultsDraft(result).content);
      assert.ok(!content.includes(OUTPUT_TAIL_MARKER), "no output tail is inlined");
      assert.ok(!content.includes("T7"), "the entry lists names, not ids");
      assert.match(content, /bounded job \(completed, exit 3\)/);
      assert.match(content, /second job \(failed, exit 7\)/);
      assert.match(content, /Read the output with async_logs/);
      assert.equal(registry.spy.logs, 0, "the wait never reads the output at all");
    } finally {
      clearTimeout(flip);
      dispose();
    }
  });
});

test("the budget spans turns: a second turn may continue once, then the cap stops it", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fire, fireOne } = makePi();
    const registry = makeRegistry([running("T5", "turn job")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000, maxContinuations: 1 });
    const flip = setTimeout(() => registry.setRows([completed("T5", "turn job", 0)]), 60);
    try {
      const { result, lines, exitCode } = await captureStderr(async () => {
        const first = await fireOne("agent_before_settle", { entries: [{ type: "custom_message", customType: "host-draft" }] }, { mode: "print" });
        // The next turn starts and another task is somehow still running: the cap is now spent.
        registry.setRows([running("T5", "turn job")]);
        fire("agent_start");
        const second = await fireOne("agent_before_settle", {}, { mode: "print" });
        return { first, second };
      });
      const shape = result.first as Result;
      assert.equal(shape.continue, true, "the first turn continues");
      assert.deepEqual((shape.entries ?? [])[0], { type: "custom_message", customType: "host-draft" }, "host drafts stay in front");
      assert.equal(result.second, undefined, "the cap is spent across turns, not per turn");
      assert.equal(exitCode, 1);
      assert.ok(lines.some((line) => line.includes("T5") && line.includes("1 continuation(s)")), JSON.stringify(lines));
      assert.equal(lines.length, 1, "exactly one loud exit");
    } finally {
      clearTimeout(flip);
      dispose();
    }
  });
});

test("the results entry counts rows the registry can no longer produce", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T8a", "kept"), running("T8b", "pruned one"), running("T8c", "pruned two")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000 });
    // Two of the three rows are gone from history by the time the entry is built (pruned retention).
    const flip = setTimeout(() => registry.setRows([completed("T8a", "kept")]), 60);
    try {
      const content = String(resultsDraft(await fireOne("agent_before_settle", {}, { mode: "print" })).content);
      assert.match(content, /Waited for 3 async task\(s\)/, "the count is the snapshot, not the surviving rows");
      assert.match(content, /kept \(completed, exit 0\)/);
      assert.match(content, /\+2 more/, "missing rows are counted instead of silently dropped");
    } finally {
      clearTimeout(flip);
      dispose();
    }
  });
});

test("the throttle exit names every still-running taskId, not just the first", async () => {
  await withEnv({ ...CLEAN, PI_ASYNC_PRINT_MAX_CONTINUATIONS: "0" }, async () => {
    const savedExitCode = process.exitCode;
    const { pi, fireOne } = makePi();
    const registry = makeRegistry([running("T9a", "first job"), running("T9b", "second job")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000 });
    try {
      const { result, lines, exitCode } = await captureStderr(async () => fireOne("agent_before_settle", {}, { mode: "print" }));
      assert.equal(result, undefined);
      assert.equal(exitCode, 1);
      const notice = lines.find((line) => line.includes("still running"));
      assert.ok(notice, JSON.stringify(lines));
      assert.match(String(notice), /2 async task\(s\)/);
      assert.ok(String(notice).includes("T9a") && String(notice).includes("T9b"), "every id is named");
    } finally {
      process.exitCode = savedExitCode;
      dispose();
    }
  });
});

test("exactly three hooks, and dispose is idempotent and final", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, handlers, fire, fireOne, unsubscribed } = makePi();
    const registry = makeRegistry([running("T6", "job")]);
    const dispose = registerPrintWait(pi as never, registry as never, { pollMs: 20, waitMs: 5_000 });
    assert.deepEqual([...handlers.keys()].sort(), ["agent_before_settle", "agent_start", "session_shutdown"]);

    // session_shutdown is the teardown path the host uses; after it the handler is inert.
    fire("session_shutdown", { reason: "quit" });
    assert.deepEqual([...handlers.keys()], [], "every hook is unsubscribed on shutdown");
    assert.ok(unsubscribed.length >= 3);
    const afterShutdown = await fireOne("agent_before_settle", {}, { mode: "print" });
    assert.equal(afterShutdown, undefined, "a retired generation never waits");
    assert.equal(registry.listCalls(), 0);

    assert.doesNotThrow(() => {
      dispose();
      dispose();
    });
  });
});
