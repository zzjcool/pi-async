import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPanel, resetPanelForTests } from "../src/tui/panel.ts";
import { makeSnapshot } from "./helpers/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * Fixture paths live in a per-file temp dir (review item 7) instead of a fixed
 * `/tmp/*.log` that a developer machine may already own.
 */
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "pi-async-d-tui-keys-"));
const OUTPUT_FILE = join(FIXTURE_DIR, "task-1.log");
test.after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

/**
 * Fake registry + fake ui for the 0.3.0 kill/copy key contract (§2.9).
 * The ui deliberately exposes `copyToClipboard`: `c` must never reach it.
 */
function setup(opts: { tasks?: TaskSnapshot[]; killMode?: "ok" | "reject" | "throw"; initialTaskId?: string; logsText?: string } = {}) {
  resetPanelForTests();
  const tasks = opts.tasks ?? [makeSnapshot({ taskId: "task-1", name: "alpha", metadata: { outputFile: OUTPUT_FILE } })];
  const killed: string[] = [];
  const killKinds: string[] = [];
  const submitted: unknown[] = [];
  const copied: string[] = [];
  const notified: { message: string; level?: string }[] = [];
  const registry = {
    list: () => tasks,
    get: (id: string) => tasks.find((task) => task.taskId === id),
    logs: () => ({ text: opts.logsText ?? "line\n", truncated: false, fullPath: OUTPUT_FILE }),
    kill: (id: string, kind: string): Promise<void> => {
      // Some hosts throw synchronously instead of rejecting — both must be handled.
      if (opts.killMode === "throw") throw new Error("kill exploded");
      if (opts.killMode === "reject") return Promise.reject(new Error("kill denied"));
      killed.push(id);
      killKinds.push(kind);
      return Promise.resolve();
    },
    submit: (options: unknown) => { submitted.push(options); return tasks[0]!; },
  };
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  let closed = false;
  const ui = {
    custom: (next: typeof factory) => { factory = next; return Promise.resolve(); },
    copyToClipboard: (value: string) => { copied.push(value); },
    notify: (message: string, level?: string) => { notified.push({ message, level }); },
  };
  openPanel({ mode: "tui", ui } as never, registry as never, opts.initialTaskId);
  const component = factory!({ requestRender() {} }, {}, {}, () => { closed = true; });
  return {
    component,
    killed,
    killKinds,
    submitted,
    copied,
    notified,
    get closed() { return closed; },
  };
}

test("x needs two presses before it kills a running task", async () => {
  const panel = setup();
  panel.component.handleInput("\r");
  panel.component.handleInput("x");
  assert.deepEqual(panel.killed, [], "one x only arms the confirmation");
  assert.match(panel.component.render(100).join("\n"), /press x again to confirm/);
  panel.component.handleInput("x");
  await Promise.resolve();
  assert.deepEqual(panel.killed, ["task-1"]);
  assert.deepEqual(panel.killKinds, ["user"]);
  panel.component.dispose();
});

test("X and K are accepted kill keys too", async () => {
  for (const key of ["X", "K"]) {
    const panel = setup();
    panel.component.handleInput("\r");
    panel.component.handleInput(key);
    assert.deepEqual(panel.killed, [], `${key} must also require confirmation`);
    panel.component.handleInput(key);
    await Promise.resolve();
    assert.deepEqual(panel.killed, ["task-1"], `${key} must kill after confirmation`);
    panel.component.dispose();
  }
});

test("x cancels a pending (delayed) task", async () => {
  const pending = makeSnapshot({ taskId: "pend-1", name: "sched", status: "pending", mode: "delayed", metadata: { outputFile: join(FIXTURE_DIR, "pend-1.log") } });
  const panel = setup({ tasks: [pending] });
  panel.component.handleInput("\r");
  panel.component.handleInput("x");
  assert.match(panel.component.render(100).join("\n"), /Cancel this pending task/);
  panel.component.handleInput("x");
  await Promise.resolve();
  assert.deepEqual(panel.killed, ["pend-1"]);
  panel.component.dispose();
});

test("any other key disarms the kill confirmation", async () => {
  const panel = setup();
  panel.component.handleInput("\r");
  panel.component.handleInput("x");
  panel.component.handleInput("j"); // disarms instead of moving
  assert.doesNotMatch(panel.component.render(100).join("\n"), /press x again/);
  panel.component.handleInput("x");
  assert.deepEqual(panel.killed, [], "the confirmation must be re-armed first");
  panel.component.handleInput("x");
  await Promise.resolve();
  assert.deepEqual(panel.killed, ["task-1"]);
  panel.component.dispose();
});

test("list k only moves up and never kills", async () => {
  const tasks = [
    makeSnapshot({ taskId: "a", name: "alpha", metadata: { outputFile: join(FIXTURE_DIR, "a.log") } }),
    makeSnapshot({ taskId: "b", name: "beta", metadata: { outputFile: join(FIXTURE_DIR, "b.log") } }),
  ];
  const panel = setup({ tasks });
  const before = panel.component.render(100).join("\n");
  assert.match(before, /▶ alpha/);
  panel.component.handleInput("j");
  assert.match(panel.component.render(100).join("\n"), /▶ beta/);
  panel.component.handleInput("k");
  const after = panel.component.render(100).join("\n");
  assert.match(after, /▶ alpha/, "k must move the selection up");
  assert.doesNotMatch(after, /press x again/, "k must not arm a kill");
  await Promise.resolve();
  assert.deepEqual(panel.killed, []);
  panel.component.dispose();
});

test("detail k scrolls the body without killing or switching tasks (#101)", async () => {
  const tasks = [
    makeSnapshot({ taskId: "a", name: "alpha", metadata: { outputFile: join(FIXTURE_DIR, "a.log") } }),
    makeSnapshot({ taskId: "b", name: "beta", metadata: { outputFile: join(FIXTURE_DIR, "b.log") } }),
  ];
  const panel = setup({ tasks });
  panel.component.handleInput("j");
  panel.component.handleInput("\r");
  assert.match(panel.component.render(100).join("\n"), /\[b\]/);
  panel.component.handleInput("k");
  assert.equal(panel.killed.length, 0);
  // #101 D1: `k` is a scroll key in the detail view, so the task under the cursor cannot move.
  assert.match(panel.component.render(100).join("\n"), /\[b\]/, "k in detail must not switch tasks");
  // …and switching tasks still has its own keys.
  panel.component.handleInput("[");
  assert.match(panel.component.render(100).join("\n"), /\[a\]/, "[ moves to the previous task in detail");
  panel.component.handleInput("]");
  assert.match(panel.component.render(100).join("\n"), /\[b\]/, "] moves to the next task in detail");
  panel.component.dispose();
});

/** Terminal geometry is part of the contract here, so pin it instead of reading the runner's tty. */
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

test("#101 D1: ↑/↓/j/k scroll the detail body and never move the selection", () => {
  const logsText = `${Array.from({ length: 40 }, (_, i) => `row ${String(i + 1).padStart(2, "0")}`).join("\n")}\n`;
  const tasks = [
    makeSnapshot({ taskId: "a", name: "alpha", metadata: { outputFile: join(FIXTURE_DIR, "a.log") } }),
    makeSnapshot({ taskId: "b", name: "beta", metadata: { outputFile: join(FIXTURE_DIR, "b.log") } }),
  ];
  withTerminalSize(24, 100, () => {
    const panel = setup({ tasks, logsText });
    const body = (): string => (panel.component.render(100) as string[]).join("\n");

    // List mode keeps the keys as pure selection (unchanged).
    assert.match(body(), /▶ alpha/);
    panel.component.handleInput("\u001b[B");
    assert.match(body(), /▶ beta/, "list ↓ moves the selection");
    panel.component.handleInput("\u001b[A");
    assert.match(body(), /▶ alpha/, "list ↑ moves the selection");

    // Detail mode: the same keys scroll, and the selection stays put.
    panel.component.handleInput("\r");
    assert.match(body(), /\[a\]/, "precondition: the detail view shows the selected task");
    assert.match(body(), /row 40/, "precondition: the viewport is glued to the newest line");

    for (const key of ["\u001b[A", "k"]) {
      panel.component.handleInput(key);
      const scrolled = body();
      assert.match(scrolled, /\[a\]/, `↑/${key} in detail must not switch tasks`);
      assert.doesNotMatch(scrolled, /row 40/, `↑/${key} in detail must scroll one line off the tail`);
      assert.match(scrolled, /row 39/, "the line just above the tail is now the newest visible one");
      panel.component.handleInput("\u001b[B"); // back to the tail before the next key
      assert.match(body(), /row 40/, "↓ returns to the tail");
      assert.match(body(), /\[a\]/, "↓ in detail must not switch tasks either");
    }

    panel.component.handleInput("j");
    assert.match(body(), /row 40/, "j in detail scrolls down at the tail without leaving it");
    assert.match(body(), /\[a\]/, "j in detail must not switch tasks");

    panel.component.handleInput("]");
    assert.match(body(), /\[b\]/, "] is the detail-mode \"next task\" key");
    panel.component.handleInput("[");
    assert.match(body(), /\[a\]/, "[ is the detail-mode \"previous task\" key");
    panel.component.dispose();
  });
});

test("a rejected kill surfaces as an error line and a notification instead of throwing", async () => {
  const panel = setup({ killMode: "reject" });
  panel.component.handleInput("\r");
  panel.component.handleInput("x");
  assert.doesNotThrow(() => panel.component.handleInput("x"));
  await new Promise((resolve) => setImmediate(resolve));
  const body = panel.component.render(100).join("\n");
  assert.match(body, /error:.*kill denied/);
  assert.ok(
    panel.notified.some((entry) => entry.level === "error" && entry.message.includes("kill denied")),
    `expected an error notify, got ${JSON.stringify(panel.notified)}`,
  );
  panel.component.dispose();
});

test("a synchronously throwing kill is caught too", async () => {
  const panel = setup({ killMode: "throw" });
  panel.component.handleInput("\r");
  panel.component.handleInput("x");
  assert.doesNotThrow(() => panel.component.handleInput("x"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(panel.component.render(100).join("\n"), /error:.*kill exploded/);
  panel.component.dispose();
});

test("#101: a kill error from the previous task does not follow a detail task switch", async () => {
  const tasks = [
    makeSnapshot({ taskId: "a", name: "alpha", metadata: { outputFile: join(FIXTURE_DIR, "a.log") } }),
    makeSnapshot({ taskId: "b", name: "beta", metadata: { outputFile: join(FIXTURE_DIR, "b.log") } }),
  ];
  const panel = setup({ tasks, killMode: "reject", initialTaskId: "a" });
  panel.component.handleInput("x");
  panel.component.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(panel.component.render(100).join("\n"), /error:.*kill denied/, "precondition: alpha's kill failed");

  panel.component.handleInput("]");
  const after = panel.component.render(100).join("\n");
  assert.match(after, /\[b\]/, "the detail view switched to beta");
  assert.doesNotMatch(after, /kill denied/, "beta must not inherit alpha's error row");
  panel.component.dispose();
});

test("c only notifies the output path and never calls copyToClipboard", () => {
  const panel = setup();
  panel.component.handleInput("\r");
  panel.component.handleInput("c");
  assert.deepEqual(panel.copied, [], "pi has no copyToClipboard API — the panel must not use it");
  assert.ok(panel.notified.some((entry) => entry.message === OUTPUT_FILE));
  assert.match(panel.component.render(100).join("\n"), /c show output path/);
  panel.component.dispose();
});

test("PageUp/PageDown page the detail body (PLAN §2.9)", () => {
  const lines = `${Array.from({ length: 60 }, (_, i) => `row ${String(i + 1).padStart(2, "0")}`).join("\n")}\n`;
  const panel = setup({ initialTaskId: "task-1", logsText: lines });
  const newest = (panel.component.render(100) as string[]).join("\n");
  assert.match(newest, /row 60/, "the newest output line shows first");

  panel.component.handleInput("\u001b[5~"); // PageUp → older lines
  const paged = (panel.component.render(100) as string[]).join("\n");
  assert.notEqual(paged, newest, "PageUp must move the body window");
  assert.equal(paged.includes("row 60"), false, "PageUp scrolls away from the tail");
  assert.match(paged, /x kill/, "the footer survives paging");

  panel.component.handleInput("\u001b[6~"); // PageDown → back to the tail
  const back = (panel.component.render(100) as string[]).join("\n");
  assert.match(back, /row 60/, "PageDown returns to the newest lines");
  panel.component.dispose();
});

test("PageUp/PageDown are inert in the list view", () => {
  const tasks = [
    makeSnapshot({ taskId: "a", name: "alpha", metadata: { outputFile: join(FIXTURE_DIR, "a.log") } }),
    makeSnapshot({ taskId: "b", name: "beta", metadata: { outputFile: join(FIXTURE_DIR, "b.log") } }),
  ];
  const panel = setup({ tasks, logsText: "row 1\nrow 2\n" });
  const before = (panel.component.render(100) as string[]).join("\n");
  panel.component.handleInput("\u001b[5~");
  panel.component.handleInput("\u001b[6~");
  assert.equal((panel.component.render(100) as string[]).join("\n"), before, "the list must not scroll on page keys");
  assert.deepEqual(panel.killed, []);
  panel.component.dispose();
});

test("R rerun carries the original task cwd (REV-13)", () => {
  const task = makeSnapshot({
    taskId: "task-1",
    name: "alpha",
    command: "make test",
    cwd: "/work/original",
    metadata: { outputFile: OUTPUT_FILE },
  });
  const panel = setup({ tasks: [task] });
  panel.component.handleInput("\r");
  panel.component.handleInput("R");
  assert.deepEqual(panel.submitted, [{ command: "make test", name: "alpha", mode: "background", cwd: "/work/original" }]);
  panel.component.dispose();
});

test("R rerun omits cwd when the original task has none", () => {
  const panel = setup();
  panel.component.handleInput("\r");
  panel.component.handleInput("R");
  assert.deepEqual(panel.submitted, [{ command: "echo example", name: "alpha", mode: "background" }]);
  panel.component.dispose();
});

test("#101 D3: a degenerate viewport keeps the alerts and the key hints", async () => {
  const previousRows = process.stdout.rows;
  const previousColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "rows", { value: 8, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
  try {
    // 8 rows * 0.8 => a 6-line frame / 4-line body: the footer can grow to 3 rows (error + kill
    // confirmation + hints), which used to leave `viewportRows = -1` and slice the hints off.
    const panel = setup({ killMode: "reject" });
    panel.component.handleInput("\r");
    panel.component.handleInput("x"); // arm the confirmation
    assert.match(panel.component.render(100).join("\n"), /press x again/, "the confirmation row survives a 4-row body");
    assert.match(panel.component.render(100).join("\n"), /x kill/, "the key hints stay the last body line");

    panel.component.handleInput("x"); // rejected kill → the error row joins the footer
    await new Promise((resolve) => setImmediate(resolve));
    panel.component.handleInput("x"); // re-arm: error + confirmation + hints = 3 footer rows
    const lines = panel.component.render(100) as string[];
    const body = lines.join("\n");
    assert.equal(lines.length, 6, `the frame must stay height-bounded, got:\n${body}`);
    assert.match(body, /error:.*kill denied/, "the error row survives");
    assert.match(body, /press x again/, "the kill confirmation survives");
    assert.match(lines.at(-2)!, /x kill/, "the key hints are still directly above the bottom border");
    panel.component.dispose();
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: previousRows, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: previousColumns, configurable: true });
  }
});
