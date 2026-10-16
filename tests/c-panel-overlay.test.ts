import assert from "node:assert/strict";
import test from "node:test";
import { openPanel } from "../src/tui/panel.ts";
import { makeSnapshot } from "./helpers/index.ts";

function createPanel(initialTaskId?: string) {
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  let closed = false;
  let options: unknown;
  const task = makeSnapshot({ taskId: "overlay-task", metadata: { outputFile: "/tmp/overlay-task.log" } });
  const ui = {
    custom: (f: typeof factory, overlayOptions: unknown) => {
      factory = f;
      options = overlayOptions;
      return Promise.resolve();
    },
  };
  const registry = {
    list: () => [task],
    logs: () => ({ text: "output\n", truncated: false, fullPath: "/tmp/overlay-task.log" }),
  };
  openPanel({ mode: "tui", ui } as never, registry as never, initialTaskId);
  const component = factory!({ requestRender() {} }, {}, {}, () => { closed = true; });
  return { component, get closed() { return closed; }, options };
}

function withTerminalSize(rows: number, columns: number, run: () => void): void {
  const previousRows = process.stdout.rows;
  const previousColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: previousRows, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: previousColumns, configurable: true });
  }
}

test("list overlay is centered and sized to terminal percentages", () => {
  withTerminalSize(20, 100, () => {
    const panel = createPanel();
    assert.deepEqual(panel.options, {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" },
    });
    const lines = panel.component.render() as string[];
    assert.equal(lines.length, 14);
    assert.ok(lines.every((line) => Array.from(line).length === 80));
  });
});

test("rail detail overlay is centered, sized to terminal percentages, and Esc closes", () => {
  withTerminalSize(20, 100, () => {
    const panel = createPanel("overlay-task");
    assert.deepEqual(panel.options, {
      overlay: true,
      overlayOptions: { width: "85%", maxHeight: "80%", anchor: "center" },
    });
    const lines = panel.component.render() as string[];
    assert.equal(lines.length, 16);
    assert.ok(lines.every((line) => Array.from(line).length === 85));
    assert.ok(lines.some((line) => line.includes("Esc close")));
    panel.component.handleInput("\u001b");
    assert.equal(panel.closed, true);
  });
});

test("list-origin detail Esc returns to list", () => {
  const panel = createPanel();
  panel.component.handleInput("\r");
  panel.component.handleInput("\u001b");
  assert.equal(panel.closed, false);
  assert.ok((panel.component.render(80) as string[]).some((line: string) => line.includes("Enter details")));
});
