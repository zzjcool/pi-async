import assert from "node:assert/strict";
import test from "node:test";
import { reportActivity } from "../src/core/bus.ts";

test("reportActivity raises and clears activity when host supports setActivity", () => {
  const calls: unknown[][] = [];
  const pi = { ui: { setActivity: (...args: unknown[]) => calls.push(args) } };
  reportActivity(pi as never, { running: 2, pending: 1 });
  reportActivity(pi as never, { running: 0, pending: 0 });
  assert.deepEqual(calls, [["pi-async", { message: "3 async tasks" }], ["pi-async", undefined]]);
});

test("reportActivity silently degrades without optional UI api and does not emit OSC", () => {
  assert.doesNotThrow(() => reportActivity({} as never, { running: 0, pending: 0 }));
});
