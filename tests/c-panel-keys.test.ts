import assert from "node:assert/strict";
import test from "node:test";
import { isEscapeKey, openPanel, registerPanelCommands } from "../src/tui/panel.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";
import { makeSnapshot } from "./helpers/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

function create(opts: {
  tasks?: TaskSnapshot[];
  submit?: (options: unknown) => TaskSnapshot;
  notify?: (message: string, level?: string) => void;
} = {}) {
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  let closed = false;
  const killed: string[] = [];
  const submitted: unknown[] = [];
  const copied: string[] = [];
  const notified: { message: string; level?: string }[] = [];
  const task = opts.tasks?.[0] ?? makeSnapshot({ metadata: { outputFile: "/tmp/task.log" } });
  const tasks = opts.tasks ?? [task];
  const registry = {
    list: () => tasks,
    get: (id: string) => tasks.find((t) => t.taskId === id),
    logs: () => ({ text: "\u001b]0;pwned\u0007line\n", truncated: false, fullPath: "/tmp/task.log" }),
    kill: async (id: string) => { killed.push(id); },
    submit: (options: unknown) => {
      submitted.push(options);
      if (opts.submit) return opts.submit(options);
      return task;
    },
  };
  const ui = {
    custom: (f: typeof factory, options: unknown) => { factory = f; assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 } }); return Promise.resolve(); },
    copyToClipboard: (value: string) => copied.push(value),
    notify: (message: string, level?: string) => {
      notified.push({ message, level });
      opts.notify?.(message, level);
    },
  };
  openPanel({ mode: "tui", ui } as never, registry as never);
  const component = factory!({ requestRender() {} }, {}, {}, () => { closed = true; });
  return { component, task, tasks, killed, submitted, copied, notified, get closed() { return closed; } };
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

test("k can cancel a pending task (#11)", async () => {
  const pending = makeSnapshot({ taskId: "pend-1", name: "sched", status: "pending", mode: "delayed" });
  const { component, killed } = create({ tasks: [pending] });
  component.handleInput("\r");
  const confirm = component.render(100).join("\n");
  component.handleInput("k");
  assert.match(component.render(100).join("\n"), /Cancel this pending task/);
  component.handleInput("k");
  await Promise.resolve();
  assert.deepEqual(killed, ["pend-1"]);
  void confirm;
});

test("h toggles historical tasks and q closes the panel", () => {
  const panel = create();
  panel.component.handleInput("h");
  panel.component.handleInput("q");
  assert.equal(panel.closed, true);
});

test("detail R reruns and follows the new task (#9)", () => {
  const original = makeSnapshot({ taskId: "old", name: "victim", command: "sleep 1", metadata: { outputFile: "/tmp/old.log" } });
  const created = makeSnapshot({ taskId: "new", name: "victim", command: "sleep 1", metadata: { outputFile: "/tmp/new.log" } });
  const tasks = [original];
  const panel = create({
    tasks,
    submit: (options) => {
      tasks.push(created);
      return created;
    },
  });
  panel.component.handleInput("\r");
  assert.ok(panel.component.render(100).some((line: string) => line.includes("[old]")));
  panel.component.handleInput("R");
  assert.deepEqual(panel.submitted, [{ command: "sleep 1", name: "victim", mode: "background" }]);
  const detail = panel.component.render(100).join("\n");
  assert.ok(detail.includes("[new]"), `expected detail to follow new task, got:\n${detail}`);
  assert.equal(detail.includes("[old]"), false);
});

test("detail R surfaces submit failure in the panel (#9)", () => {
  const panel = create({
    submit: () => { throw new Error("admission denied"); },
  });
  panel.component.handleInput("\r");
  panel.component.handleInput("R");
  const detail = panel.component.render(100).join("\n");
  assert.match(detail, /error:.*admission denied/);
  assert.ok(panel.notified.some((n) => n.message.includes("admission denied")));
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

test("detail shows multiline command without folding newlines (#14)", () => {
  const task = makeSnapshot({
    taskId: "ml",
    name: "multi",
    command: "echo one\necho two\nsleep 5",
    metadata: { outputFile: "/tmp/ml.log" },
  });
  const { component } = create({ tasks: [task] });
  component.handleInput("\r");
  const lines = component.render(100) as string[];
  assert.ok(lines.some((line) => line.includes("command:")));
  assert.ok(lines.some((line) => /  echo one/.test(line)));
  assert.ok(lines.some((line) => /  echo two/.test(line)));
  assert.ok(lines.some((line) => /  sleep 5/.test(line)));
  assert.equal(lines.some((line) => line.includes("echo one echo two")), false);
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

function withDockShortcutEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.PI_ASYNC_DOCK_SHORTCUT;
  try {
    if (value === undefined) delete process.env.PI_ASYNC_DOCK_SHORTCUT;
    else process.env.PI_ASYNC_DOCK_SHORTCUT = value;
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_ASYNC_DOCK_SHORTCUT;
    else process.env.PI_ASYNC_DOCK_SHORTCUT = previous;
  }
}

function registerWithMockHost(): string[] {
  resetTuiHostForTests();
  bindTuiHost({ mode: "tui", ui: {} });
  const shortcuts: string[] = [];
  registerPanelCommands({
    mode: "tui",
    registerShortcut: (key: string) => { shortcuts.push(key); },
  } as never, {} as never);
  return shortcuts;
}

test("PI_ASYNC_DOCK_SHORTCUT=off/none/false/empty skips registerShortcut (#30)", () => {
  for (const value of ["off", "OFF", "none", "false", "", "  off  ", "  "]) {
    withDockShortcutEnv(value, () => {
      const shortcuts = registerWithMockHost();
      assert.deepEqual(shortcuts, [], `expected no registration for ${JSON.stringify(value)}`);
    });
  }
});

test("PI_ASYNC_DOCK_SHORTCUT unset or custom still registers (#30)", () => {
  withDockShortcutEnv(undefined, () => {
    assert.deepEqual(registerWithMockHost(), ["ctrl+alt+a"]);
  });
  withDockShortcutEnv("ctrl+shift+p", () => {
    assert.deepEqual(registerWithMockHost(), ["ctrl+shift+p"]);
  });
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

test("list scrolls so selection stays visible (#38)", () => {
  const tasks = Array.from({ length: 40 }, (_, i) => makeSnapshot({
    taskId: `t${String(i).padStart(2, "0")}`,
    name: `task${String(i).padStart(2, "0")}`,
    status: "running",
    startedAt: Date.now() - i,
  }));
  const { component } = create({ tasks });
  const prevRows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 14, configurable: true });
  try {
    for (let i = 0; i < 25; i++) component.handleInput("\u001b[B");
    const lines = component.render(80) as string[];
    const body = lines.join("\n");
    assert.ok(body.includes("▶"), `selection marker missing after scroll:\n${body}`);
    assert.ok(/▶\s+task2[0-9]/.test(body) || /▶\s+task3[0-9]/.test(body), `expected selected row in view:\n${body}`);
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: prevRows, configurable: true });
  }
});

test("toggling history keeps a visible selection (#39)", () => {
  const tasks = [
    makeSnapshot({ taskId: "run0", name: "run0", status: "running", startedAt: 1 }),
    makeSnapshot({ taskId: "run1", name: "run1", status: "running", startedAt: 2 }),
    makeSnapshot({ taskId: "run2", name: "run2", status: "running", startedAt: 3 }),
    makeSnapshot({ taskId: "done0", name: "done0", status: "completed", finishedAt: 10, startedAt: 5 }),
    makeSnapshot({ taskId: "done1", name: "done1", status: "completed", finishedAt: 11, startedAt: 6 }),
    makeSnapshot({ taskId: "done2", name: "done2", status: "completed", finishedAt: 12, startedAt: 7 }),
  ];
  const { component } = create({ tasks });
  // history defaults on; move to last terminal task
  for (let i = 0; i < 5; i++) component.handleInput("\u001b[B");
  let body = component.render(100).join("\n");
  assert.ok(body.includes("▶"), "precondition: selection visible with history on");
  component.handleInput("h"); // history off → terminal tasks filtered
  body = component.render(100).join("\n");
  assert.ok(body.includes("▶"), `selection should remain after history off:\n${body}`);
  assert.ok(/▶\s+run/.test(body), `expected a running task selected:\n${body}`);
});
