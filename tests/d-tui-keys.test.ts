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

test("detail k scrolls up instead of killing", async () => {
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
  assert.match(panel.component.render(100).join("\n"), /\[a\]/, "k in detail moves to the previous task");
  panel.component.dispose();
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
