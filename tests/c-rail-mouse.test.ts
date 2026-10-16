import assert from "node:assert/strict";
import test from "node:test";
import { createRailFactory, registerRail } from "../src/tui/rail.ts";
import { makeSnapshot } from "./helpers/index.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";

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

test("rail summary row is not clickable and task rows open only after press then click", () => {
  const { calls, widget } = setup();
  widget.handleMouse({ type: "press", button: "left", x: 1, y: 0 } as never);
  widget.handleMouse({ type: "click", button: "left", x: 1, y: 0 } as never);
  assert.deepEqual(calls, []);
  widget.handleMouse({ type: "press", button: "left", x: 1, y: 1 } as never);
  widget.handleMouse({ type: "click", button: "left", x: 1, y: 1 } as never);
  assert.deepEqual(calls, ["a"]);
});

test("rail ignores a click on a different task than the latched press", () => {
  const { calls, widget } = setup();
  widget.handleMouse({ type: "press", button: "left", x: 1, y: 1 } as never);
  widget.handleMouse({ type: "click", button: "left", x: 1, y: 2 } as never);
  assert.deepEqual(calls, []);
});

test("registerRail does not register a widget outside TUI mode", () => {
  let calls = 0;
  registerRail({ mode: "rpc", ui: { setWidget: () => { calls++; } } } as never, {} as never);
  assert.equal(calls, 0);
});

test("registered rail opens a selected task in the panel", () => {
  resetTuiHostForTests();
  const task = makeSnapshot({ taskId: "opened" });
  let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[]; handleMouse(event: unknown): unknown }) | undefined;
  let panelFactory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => { render(width: number): string[] }) | undefined;
  const registry = { list: () => [task], logs: () => ({ text: "output\n", truncated: false, fullPath: "" }) };
  const ui = { setWidget: (_key: string, next: typeof factory) => { factory = next; }, custom: (next: typeof panelFactory) => { panelFactory = next; return Promise.resolve(); } };
  // TUI surfaces bind from event contexts; simulate one before registering.
  bindTuiHost({ mode: "tui", ui });
  registerRail({} as never, registry as never);
  const widget = factory!({ requestRender() {} }, { fg: (_token: string, text: string) => text });
  widget.render(80);
  widget.handleMouse({ type: "press", button: "left", y: 1 });
  widget.handleMouse({ type: "click", button: "left", y: 1 });
  assert.ok(panelFactory!({ requestRender() {} }, {}, {}, () => {}).render(80).some((line) => line.includes("command:")));
});

test("rail does not consume wheel without overflow", () => {
  const { widget } = setup();
  assert.equal(widget.handleMouse({ type: "wheel", wheelDelta: 1 } as never), undefined);
});

test("rail consumes wheel to scroll overflow rows", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => makeSnapshot({ taskId: `${i}`, startedAt: Date.now() - i }));
  const registry = { list: () => tasks };
  const factory = createRailFactory({} as never, registry as never);
  let renders = 0;
  const widget = factory({ requestRender: () => { renders++; } } as never, { fg: (_token: string, text: string) => text } as never);
  widget.render(80);
  assert.deepEqual(widget.handleMouse({ type: "wheel", wheelDelta: 1 } as never), { handled: true });
  assert.equal(renders, 1);
});

test("rail keyboard PageDown/PageUp scrolls overflow (#13)", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => makeSnapshot({ taskId: `${i}`, name: `job-${i}`, startedAt: Date.now() - i }));
  const registry = { list: () => tasks };
  let renders = 0;
  const widget = createRailFactory({} as never, registry as never)({ requestRender: () => { renders++; } } as never, { fg: (_token: string, text: string) => text } as never);
  const before = widget.render(80).join("\n");
  assert.ok(before.includes("more"));
  const down = widget.handleInput?.("\u001b[6~");
  assert.deepEqual(down, { handled: true });
  assert.ok(renders >= 1);
  const afterDown = widget.render(80).join("\n");
  // After scrolling down, the first job should leave the window
  assert.equal(afterDown.includes("job-0"), false, `after PageDown still has job-0:\n${afterDown}`);
  widget.handleInput?.("\u001b[5~");
  const afterUp = widget.render(80).join("\n");
  assert.ok(afterUp.includes("job-0") || afterUp.includes("more"), `after PageUp:\n${afterUp}`);
});

test("rail Ctrl+arrow scrolls by page (#13)", () => {
  const tasks = Array.from({ length: 8 },  (_, i) => makeSnapshot({ taskId: `${i}`, name: `n${i}`, startedAt: Date.now() - i }));
  let renders = 0;
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender: () => { renders++; } } as never, { fg: (_t: string, text: string) => text } as never);
  widget.render(80);
  assert.deepEqual(widget.handleInput?.("\u001b[1;5B"), { handled: true });
  assert.ok(renders >= 1);
  assert.equal(widget.handleInput?.("x"), undefined);
});
