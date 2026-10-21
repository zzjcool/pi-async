import assert from "node:assert/strict";
import test from "node:test";
import { SettleGuard } from "../src/guard/settle-guard.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("settle guard reminds three times, then permits settle while retaining unresolved list", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const entries: Array<[string, unknown]> = [];
  const pi = { on: (event: string, cb: (...args: unknown[]) => unknown) => handlers.set(event, cb), appendEntry: (type: string, data: unknown) => entries.push([type, data]) };
  const registry = {
    list: () => [makeSnapshot({ taskId: "pending-1" })],
    activeCount: () => ({ running: 1, pending: 0 }),
    hasActiveWork: () => true,
  };
  const previous = process.env.PI_LEGION_NODE_ID;
  process.env.PI_LEGION_NODE_ID = "test-node";
  try {
    new SettleGuard(pi as never, registry as never, { heartbeatMs: 0 }).register();
    const beforeSettle = handlers.get("agent_before_settle")!;
    for (let i = 0; i < 3; i++) assert.deepEqual(beforeSettle(), { continue: true });
    assert.equal(beforeSettle(), undefined);
    assert.equal(entries.length, 4);
    assert.match(JSON.stringify(entries[3]), /pending-1/);
    assert.match(JSON.stringify(entries[0]), /async_wait/);
  } finally { if (previous === undefined) delete process.env.PI_LEGION_NODE_ID; else process.env.PI_LEGION_NODE_ID = previous; }
});

test("settle guard clears activity when no tasks remain", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const pi = { on: (event: string, cb: (...args: unknown[]) => unknown) => handlers.set(event, cb), ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
  const registry = { list: () => [], activeCount: () => ({ running: 0, pending: 0 }), hasActiveWork: () => false };
  const previous = process.env.PI_LEGION_NODE_ID;
  process.env.PI_LEGION_NODE_ID = "test-node";
  try {
    new SettleGuard(pi as never, registry as never, { heartbeatMs: 0 }).register();
    handlers.get("agent_before_settle")!();
  } finally { if (previous === undefined) delete process.env.PI_LEGION_NODE_ID; else process.env.PI_LEGION_NODE_ID = previous; }
  assert.equal(calls.at(-1)?.[0], "pi-async");
  assert.equal(calls.at(-1)?.[1], undefined);
});

test("a new agent run rearms the reminder limit", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on: (event: string, cb: (...args: unknown[]) => unknown) => handlers.set(event, cb) };
  const registry = { list: () => [makeSnapshot()], activeCount: () => ({ running: 1, pending: 0 }), hasActiveWork: () => true };
  const prev = process.env.PI_LEGION_NODE_ID; process.env.PI_LEGION_NODE_ID = "test-node";
  try {
    new SettleGuard(pi as never, registry as never, { heartbeatMs: 0 }).register();
    const hook = handlers.get("agent_before_settle")!;
    hook(); hook(); hook(); assert.equal(hook(), undefined);
    handlers.get("agent_start")!();
    assert.deepEqual(hook(), { continue: true });
  } finally { if (prev === undefined) delete process.env.PI_LEGION_NODE_ID; else process.env.PI_LEGION_NODE_ID = prev; }
});

/**
 * Regression: 2026-10-21 crash (pi 1.3.0, legion worktree-green-field-1393).
 *
 * After `/reload` or a session replacement pi invalidates the captured
 * factory-time API, so `appendEntry` throws "This extension ctx is stale...".
 * The heartbeat runs in a `setInterval` callback, i.e. outside pi's event-loop
 * try/catch, so that throw escaped as `uncaughtException` and killed pi:
 *
 *     at Object.assertActive (.../chunk-66G7ITPS.js)
 *     at Object.appendEntry (...)
 *     at Timeout._onTimeout (.../pi-async/src/guard/settle-guard.ts:70:26)
 */
test("a stale ctx stops the heartbeat instead of crashing the process", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let live = true;
  let appends = 0;
  const pi = {
    on: (event: string, cb: (...args: unknown[]) => unknown) => { handlers.set(event, cb); return () => handlers.delete(event); },
    appendEntry: () => {
      if (!live) throw new Error("This extension ctx is stale after session replacement or reload.");
      appends++;
    },
  };
  const registry = { list: () => [makeSnapshot()], activeCount: () => ({ running: 1, pending: 0 }), hasActiveWork: () => true };
  const guard = new SettleGuard(pi as never, registry as never, { heartbeatMs: 5 });
  guard.register();
  const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 40); });

  await tick();
  assert.ok(appends > 0, "heartbeat appends while the ctx is live");

  live = false;
  const before = appends;
  await tick();
  assert.equal(appends, before, "a stale appendEntry is never retried");
  assert.equal(handlers.has("agent_start"), false, "the stale generation detaches its hooks");
  await tick();
  assert.equal(appends, before, "the heartbeat timer is cleared, so nothing keeps firing");
});

test("a stale ui getter in reportActivity does not throw out of a timer", async () => {
  let live = true;
  const pi = {
    on: () => () => undefined,
    get ui() {
      if (!live) throw new Error("This extension ctx is stale after session replacement or reload.");
      return { setActivity: () => undefined };
    },
  };
  const registry = { list: () => [], activeCount: () => ({ running: 0, pending: 0 }), hasActiveWork: () => false };
  const guard = new SettleGuard(pi as never, registry as never, { heartbeatMs: 5 });
  guard.register();
  live = false;
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.doesNotThrow(() => guard.dispose());
});
