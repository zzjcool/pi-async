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
