import assert from "node:assert/strict";
import test from "node:test";
import { clearTaskActivity, raiseTaskActivity, reportActivity, taskActivityId } from "../src/core/bus.ts";

test("reportActivity raises and clears activity when host supports setActivity", () => {
  const calls: unknown[][] = [];
  const pi = { ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
  reportActivity(pi as never, { running: 2, pending: 1 });
  reportActivity(pi as never, { running: 0, pending: 0 });
  assert.deepEqual(calls, [["pi-async", { message: "3 async tasks" }], ["pi-async", undefined]]);
});

test("task activity uses plugin/pi-async/<task-id> (legion #156 / CONTRACT §7)", () => {
  const calls: unknown[][] = [];
  const pi = { ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
  raiseTaskActivity(pi as never, "task-123", "working");
  clearTaskActivity(pi as never, "task-123");
  assert.equal(taskActivityId("task-123"), "plugin/pi-async/task-123");
  assert.deepEqual(calls, [
    ["plugin/pi-async/task-123", { message: "working" }],
    ["plugin/pi-async/task-123", undefined],
  ]);
});

test("reportActivity silently degrades without optional UI api and does not emit OSC", () => {
  assert.doesNotThrow(() => reportActivity({} as never, { running: 0, pending: 0 }));
});
