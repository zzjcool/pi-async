import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SettleGuard } from "../src/guard/settle-guard.ts";
import { makeSnapshot } from "./helpers/index.ts";

type Handler = (...args: unknown[]) => unknown;
type Draft = { type?: string; customType?: string; content?: string; display?: boolean };
type BeforeSettleResult = { entries?: Draft[]; continue?: boolean };

/** Runs `fn` as a legion child (PI_LEGION_NODE_ID set), restoring the environment afterwards. */
function asLegionChild<T>(fn: () => T): T {
  const previous = process.env.PI_LEGION_NODE_ID;
  process.env.PI_LEGION_NODE_ID = "test-node";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_LEGION_NODE_ID;
    else process.env.PI_LEGION_NODE_ID = previous;
  }
}

test("settle guard reminds three times, then permits settle while retaining unresolved list", () => {
  asLegionChild(() => {
    const handlers = new Map<string, Handler>();
    const pi = { on: (event: string, cb: Handler) => handlers.set(event, cb) };
    const registry = {
      list: () => [makeSnapshot({ taskId: "pending-1" })],
      activeCount: () => ({ running: 1, pending: 0 }),
      hasActiveWork: () => true,
    };
    new SettleGuard(pi as never, registry as never).register();
    const beforeSettle = () => handlers.get("agent_before_settle")!({ entries: [] }) as BeforeSettleResult | undefined;

    for (let i = 0; i < 3; i++) {
      const result = beforeSettle();
      assert.equal(result?.continue, true);
      const draft = result?.entries?.at(-1);
      assert.equal(draft?.type, "custom_message");
      assert.equal(draft?.customType, "async-task-settle-reminder");
      assert.equal(draft?.display, false);
      assert.match(JSON.stringify(draft), /pending-1/);
      // D4 (0.5.0): the default session has no async_wait tool, so the reminder points at the readers.
      assert.match(JSON.stringify(draft), /async_status or async_logs/);
      assert.doesNotMatch(JSON.stringify(draft), /async_wait/);
    }
    const last = beforeSettle();
    assert.equal("continue" in (last ?? {}), false, "no forced provider request once the budget is spent");
    assert.equal(last?.entries?.at(-1)?.customType, "async-task-unresolved");
    assert.match(JSON.stringify(last?.entries?.at(-1)), /pending-1/);
  });
});

test("settle guard clears activity when no tasks remain", () => {
  asLegionChild(() => {
    const handlers = new Map<string, Handler>();
    const calls: unknown[][] = [];
    const pi = { on: (event: string, cb: Handler) => handlers.set(event, cb), ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
    const registry = { list: () => [], activeCount: () => ({ running: 0, pending: 0 }), hasActiveWork: () => false };
    new SettleGuard(pi as never, registry as never).register();
    handlers.get("agent_before_settle")!({ entries: [] });
    assert.equal(calls.at(-1)?.[0], "pi-async");
    assert.equal(calls.at(-1)?.[1], undefined);
  });
});

test("settle guard reports through the bus wording: one implementation, one literal", () => {
  asLegionChild(() => {
    const handlers = new Map<string, Handler>();
    const calls: unknown[][] = [];
    let tasks = [makeSnapshot({ taskId: "A" })];
    const pi = { on: (event: string, cb: Handler) => handlers.set(event, cb), ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
    const registry = {
      list: () => tasks,
      activeCount: () => ({ running: tasks.length, pending: 0 }),
      hasActiveWork: () => tasks.length > 0,
    };
    new SettleGuard(pi as never, registry as never).register();
    // §7 / #105: the aggregate message is bus's literal — the private singular copy is gone.
    assert.deepEqual(calls, [["pi-async", { message: "1 async tasks" }]], "one report at register, bus wording");
    tasks = [makeSnapshot({ taskId: "A" }), makeSnapshot({ taskId: "B" })];
    handlers.get("agent_before_settle")!({ entries: [] });
    assert.equal(calls.length, 2, "the settle boundary reports exactly once");
    assert.deepEqual(calls.at(-1), ["pi-async", { message: "2 async tasks" }]);
  });
});

test("settle-guard keeps no private activity copy; the bus shim is the only writer (§7 / #105)", () => {
  const source = readFileSync(new URL("../src/guard/settle-guard.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ reportActivity \} from "\.\.\/core\/bus\.ts"/, "the guard must import the shared shim");
  assert.doesNotMatch(source, /\.setActivity\s*\(/, "a direct host activity call would be a second implementation");
});

test("a throwing setActivity cannot change the settle decision; the stale generation detaches after answering", () => {
  asLegionChild(() => {
    const handlers = new Map<string, Handler>();
    const unsubscribed: string[] = [];
    let live = true;
    const pi = {
      on: (event: string, cb: Handler) => {
        handlers.set(event, cb);
        return () => { handlers.delete(event); unsubscribed.push(event); };
      },
      ui: {
        setActivity: () => {
          if (!live) throw new Error("This extension ctx is stale after session replacement or reload.");
        },
      },
    };
    const registry = {
      list: () => [makeSnapshot({ taskId: "A" })],
      activeCount: () => ({ running: 1, pending: 0 }),
      hasActiveWork: () => true,
    };
    const guard = new SettleGuard(pi as never, registry as never);
    assert.doesNotThrow(() => guard.register());
    assert.equal(unsubscribed.length, 0, "a live host leaves the generation attached");

    live = false;
    let result: BeforeSettleResult | undefined;
    assert.doesNotThrow(() => {
      result = handlers.get("agent_before_settle")!({ entries: [] }) as BeforeSettleResult | undefined;
    }, "the host rejection is swallowed by the shared shim");
    assert.equal(result?.continue, true, "the reminder still fires: activity is not part of the decision");
    assert.equal(result?.entries?.at(-1)?.customType, "async-task-settle-reminder");
    assert.deepEqual(
      [...unsubscribed].sort(),
      ["agent_before_settle", "agent_settled", "agent_start", "session_shutdown"],
      "the dead generation detaches after answering, as the 0.3.2 stale-ctx fix requires",
    );
  });
});

test("a new agent run rearms the reminder limit", () => {
  asLegionChild(() => {
    const handlers = new Map<string, Handler>();
    const pi = { on: (event: string, cb: Handler) => handlers.set(event, cb) };
    const registry = { list: () => [makeSnapshot()], activeCount: () => ({ running: 1, pending: 0 }), hasActiveWork: () => true };
    new SettleGuard(pi as never, registry as never).register();
    const hook = () => handlers.get("agent_before_settle")!({ entries: [] }) as BeforeSettleResult | undefined;

    hook(); hook(); hook();
    assert.equal("continue" in (hook() ?? {}), false);
    handlers.get("agent_start")!();
    assert.equal(hook()?.continue, true);
  });
});

/**
 * Regression: 2026-10-21 crash (pi 1.3.0, legion worktree-green-field-1393).
 *
 * After `/reload` or a session replacement pi invalidates the captured factory-time API, so
 * reading `pi.ui` throws "This extension ctx is stale...". The deleted heartbeat did that from
 * a `setInterval` callback — outside pi's event-loop try/catch — and the throw escaped as
 * `uncaughtException`, killing pi (crash report at `Timeout._onTimeout`). 0.3.0 has no timer,
 * but the remaining paths (register / an event handler / dispose) must still never leak it.
 */
test("a stale ui getter never throws out of register, a handler or dispose", () => {
  asLegionChild(() => {
    let live = true;
    let unsubscribed = 0;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (event: string, cb: Handler) => {
        handlers.set(event, cb);
        return () => { unsubscribed++; handlers.delete(event); };
      },
      get ui() {
        if (!live) throw new Error("This extension ctx is stale after session replacement or reload.");
        return { setActivity: () => undefined };
      },
    };
    const registry = { list: () => [makeSnapshot()], activeCount: () => ({ running: 1, pending: 0 }), hasActiveWork: () => true };
    const guard = new SettleGuard(pi as never, registry as never);

    assert.doesNotThrow(() => guard.register());
    live = false;
    assert.doesNotThrow(() => handlers.get("agent_before_settle")!({ entries: [] }), "a stale activity read is swallowed");
    assert.ok(unsubscribed > 0, "the stale generation detaches its hooks");
    assert.doesNotThrow(() => guard.dispose());
  });
});
