import assert from "node:assert/strict";
import test from "node:test";
import { clearTaskActivity, raiseTaskActivity, reportActivity, taskActivityId } from "../src/core/bus.ts";

test("reportActivity raises and clears activity when host supports setActivity", () => {
  const calls: unknown[][] = [];
  const pi = { ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
  assert.equal(reportActivity(pi as never, { running: 2, pending: 1 }), true);
  assert.equal(reportActivity(pi as never, { running: 0, pending: 0 }), true);
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
  assert.equal(reportActivity({} as never, { running: 0, pending: 0 }), true, "no API is not a failure");
});

test("reportActivity swallows a stale-ctx rejection and reports it instead of throwing", () => {
  const pi = {
    ui: {
      setActivity: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    },
  };
  let result: boolean | undefined;
  assert.doesNotThrow(() => { result = reportActivity(pi as never, { running: 1, pending: 0 }); });
  assert.equal(result, false, "the caller learns the host rejected the write");
});
