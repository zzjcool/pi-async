import assert from "node:assert/strict";
import test from "node:test";
import { isEscapeKey, openPanel } from "../src/tui/panel.ts";
import { makeSnapshot } from "./helpers/index.ts";

function create() {
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  let closed = false;
  const killed: string[] = [];
  const submitted: unknown[] = [];
  const copied: string[] = [];
  const task = makeSnapshot({ metadata: { outputFile: "/tmp/task.log" } });
  const registry = {
    list: () => [task],
    get: (id: string) => id === task.taskId ? task : undefined,
    logs: () => ({ text: "\u001b]0;pwned\u0007line\n", truncated: false, fullPath: "/tmp/task.log" }),
    kill: async (id: string) => { killed.push(id); },
    submit: (options: unknown) => { submitted.push(options); return task; },
  };
  const ui = {
    custom: (f: typeof factory, options: unknown) => { factory = f; assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 } }); return Promise.resolve(); },
    copyToClipboard: (value: string) => copied.push(value),
  };
  openPanel({ mode: "tui", ui } as never, registry as never);
  const component = factory!({ requestRender() {} }, {}, {}, () => { closed = true; });
  return { component, task, killed, submitted, copied, get closed() { return closed; } };
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

test("detail R reruns the original command", () => {
  const panel = create();
  panel.component.handleInput("\r");
  panel.component.handleInput("R");
  assert.deepEqual(panel.submitted, [{ command: panel.task.command, name: panel.task.name, mode: "background" }]);
});

test("detail c copies the output path", () => {
  const panel = create();
  panel.component.handleInput("\r");
  panel.component.handleInput("c");
  assert.deepEqual(panel.copied, ["/tmp/task.log"]);
});

test("detail sanitizes ANSI and bare control characters in task fields and output", () => {
  const panel = create();
  panel.task.name = "\u001b]0;pwned\u0007line";
  panel.task.command = "echo \u001b]0;pwned\u0007line";
  panel.component.handleInput("\r");
  const rendered = panel.component.render(100).join("\\n");
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("\u0007"), false);
});

test("RPC mode does not call custom UI", () => {
  let called = false;
  openPanel({ mode: "rpc", ui: { custom: () => { called = true; return Promise.resolve(); } } } as never, {} as never);
  assert.equal(called, false);
});

test("panel list opens a task only after a matching press and click", () => {
  const panel = create();
  panel.component.handleMouse({ type: "press", button: "left", y: 2 });
  panel.component.handleMouse({ type: "click", button: "left", y: 2 });
  assert.ok(panel.component.render(100).some((line: string) => line.includes("command:")));
});

test("isEscapeKey recognises bare Esc and Kitty CSI-u variants", () => {
  assert.equal(isEscapeKey("\u001b"), true);
  assert.equal(isEscapeKey("\u001b["), true);
  assert.equal(isEscapeKey("\u001b[27u"), true);
  assert.equal(isEscapeKey("\u001b[27;1u"), true);
  assert.equal(isEscapeKey("\u001b[A"), false);
  assert.equal(isEscapeKey("\u001b[B"), false);
  assert.equal(isEscapeKey("q"), false);
});

test("Kitty Escape returns from details to the list", () => {
  const { component } = create();
  component.handleInput("\r");
  assert.ok(component.render(80).some((line: string) => line.includes("command:")));
  component.handleInput("\u001b[27u");
  assert.ok(component.render(80).some((line: string) => line.includes("Enter details")));
});

test("panel frame title/body/bottom share the same code-point width", () => {
  const { component } = create();
  for (const w of [120, 60, 30]) {
    const lines = component.render(w) as string[];
    for (const line of lines) {
      assert.equal(Array.from(line).length, w, `w=${w} line=${JSON.stringify(line)} len=${Array.from(line).length}`);
    }
  }
});
