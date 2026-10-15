import assert from "node:assert/strict";
import test from "node:test";
import { openPanel } from "../src/tui/panel.ts";
import { makeSnapshot } from "./helpers/index.ts";

function create() {
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  let closed = false;
  const killed: string[] = [];
  const task = makeSnapshot({ metadata: { outputFile: "/tmp/task.log" } });
  const registry = {
    list: () => [task],
    get: (id: string) => id === task.taskId ? task : undefined,
    logs: () => ({ text: "output\n", truncated: false, fullPath: "/tmp/task.log" }),
    kill: async (id: string) => { killed.push(id); },
    submit: () => task,
  };
  const ui = { custom: (f: typeof factory, options: unknown) => { factory = f; assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 } }); } };
  openPanel({ mode: "tui", ui } as never, registry as never);
  const component = factory!({ requestRender() {} }, {}, {}, () => { closed = true; });
  return { component, task, killed, get closed() { return closed; } };
}

test("Enter opens task details and Escape returns to the list", () => {
  const { component } = create();
  component.handleInput("\r");
  assert.ok(component.render(80).some((line: string) => line.includes("command:")));
  component.handleInput("\u001b");
  assert.ok(component.render(80).some((line: string) => line.includes("Enter details")));
});

test("kill requires a second confirmation key", async () => {
  const { component, killed } = create();
  component.handleInput("\r");
  component.handleInput("k");
  assert.deepEqual(killed, []);
  component.handleInput("k");
  await Promise.resolve();
  assert.deepEqual(killed, ["task-1"]);
});

test("h toggles historical tasks and q closes the panel", () => {
  const panel = create();
  panel.component.handleInput("h");
  panel.component.handleInput("q");
  assert.equal(panel.closed, true);
});
