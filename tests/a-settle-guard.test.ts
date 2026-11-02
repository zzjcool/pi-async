import assert from "node:assert/strict";
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
      assert.match(JSON.stringify(draft), /async_wait/);
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

test("settle guard activity message singularizes for one task", () => {
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
    assert.deepEqual(calls.at(-1)?.[1], { message: "1 async task" });
    tasks = [makeSnapshot({ taskId: "A" }), makeSnapshot({ taskId: "B" })];
    handlers.get("agent_before_settle")!({ entries: [] });
    assert.deepEqual(calls.at(-1)?.[1], { message: "2 async tasks" });
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
