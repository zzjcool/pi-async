import assert from "node:assert/strict";
import test from "node:test";
import { createRailFactory } from "../src/tui/rail.ts";
import { makeSnapshot } from "./helpers/index.ts";

function setup() {
  const calls: string[] = [];
  const tasks = [makeSnapshot({ taskId: "a" }), makeSnapshot({ taskId: "b", name: "second" })];
  const registry = { list: () => tasks };
  const factory = createRailFactory({} as never, registry as never, { onOpenTask: (id) => calls.push(id) });
  let renders = 0;
  const widget = factory({ requestRender: () => { renders++; } } as never, { fg: (_token: string, text: string) => text } as never);
  widget.render(80);
  return { calls, widget, get renders() { return renders; } };
}

test("rail opens only after press then click on the same task", () => {
  const { calls, widget } = setup();
  widget.handleMouse({ type: "press", button: "left", x: 1, y: 0 } as never);
  widget.handleMouse({ type: "click", button: "left", x: 1, y: 0 } as never);
  assert.deepEqual(calls, ["a"]);
});

test("rail ignores a click on a different task than the latched press", () => {
  const { calls, widget } = setup();
  widget.handleMouse({ type: "press", button: "left", x: 1, y: 0 } as never);
  widget.handleMouse({ type: "click", button: "left", x: 1, y: 1 } as never);
  assert.deepEqual(calls, []);
});

test("rail consumes wheel to scroll overflow rows", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => makeSnapshot({ taskId: `${i}`, startedAt: Date.now() - i }));
  const registry = { list: () => tasks };
  const factory = createRailFactory({} as never, registry as never);
  let renders = 0;
  const widget = factory({ requestRender: () => { renders++; } } as never, { fg: (_token: string, text: string) => text } as never);
  widget.render(80);
  assert.deepEqual(widget.handleMouse({ type: "wheel", wheelDelta: 1 } as never), { handled: true });
  assert.equal(renders, 1);
});
