import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { openPanel, outputSection, resetPanelForTests } from "../src/tui/panel.ts";
import { stripAnsi } from "../src/core/output.ts";
import { makeSnapshot } from "./helpers/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * 0.4.1 W1: the detail overlay is the place where a running task's stdout is read live.
 *   D-30 output window = remaining body height (no more fixed 12 rows)
 *   D-31 1Hz self-refresh while the registry publishes nothing
 *   D-32 an arriving output chunk must not push a scrolled-up view away
 *   D-33 the output label marks a live task
 */

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

/**
 * Fake registry whose `logs` text is mutable, so a test can model output that grows
 * between two renders. `renders` counts host repaint requests, which is how the ticker
 * (D-31) is observed without waiting on a real clock.
 */
function createPanel(opts: {
  task?: Partial<TaskSnapshot>;
  logsText?: string;
  truncated?: boolean;
} = {}) {
  resetPanelForTests();
  const task = makeSnapshot({ metadata: {}, ...opts.task });
  const logs = { text: opts.logsText ?? "", truncated: opts.truncated ?? false };
  let renders = 0;
  let closed = false;
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  const ui = { custom: (next: typeof factory) => { factory = next; return Promise.resolve(); } };
  const registry = {
    list: () => [task],
    get: (id: string) => (task.taskId === id ? task : undefined),
    logs: () => ({ text: logs.text, truncated: logs.truncated, fullPath: "/tmp/live.log" }),
  };
  openPanel({ mode: "tui", ui } as never, registry as never, task.taskId);
  const component = factory!({ requestRender() { renders += 1; } }, {}, {}, () => { closed = true; });
  const plain = (width = 80): string[] => (component.render(width) as string[]).map(stripAnsi);
  return {
    component,
    task,
    logs,
    plain,
    get renders() { return renders; },
    get closed() { return closed; },
  };
}

const rows = (count: number): string[] => Array.from({ length: count }, (_, i) => `row ${String(i + 1).padStart(3, "0")}`);

// ---------------------------------------------------------------------------
// D-33 — the label says the output is live
// ---------------------------------------------------------------------------

test("D-33: outputSection marks live output and keeps the 4-argument label unchanged", () => {
  const theme = { fg: (_token: string, text: string) => text };
  assert.equal(outputSection(["a"], false, theme, 80)[0], "output:", "no flags");
  assert.equal(outputSection(["a"], true, theme, 80)[0], "output (tail truncated):", "the original 4-argument call");
  assert.equal(outputSection(["a"], false, theme, 80, true)[0], "output (live):", "running task");
  assert.equal(outputSection(["a"], true, theme, 80, true)[0], "output (live, tail truncated):", "both flags");
});

test("D-33: a running/pending detail is labelled live, a finished one is not", () => {
  const running = createPanel({ task: { taskId: "run-1", status: "running" }, logsText: "out\n" });
  assert.match(running.plain().join("\n"), /output \(live\):/);
  running.component.dispose();

  const pending = createPanel({ task: { taskId: "pend-1", status: "pending", mode: "delayed" } });
  assert.match(pending.plain().join("\n"), /output \(live\):/);
  pending.component.dispose();

  const done = createPanel({ task: { taskId: "done-1", status: "completed", finishedAt: Date.now() }, logsText: "out\n" });
  const body = done.plain().join("\n");
  assert.match(body, /output:/, "a finished task keeps the plain label");
  assert.doesNotMatch(body, /\(live/);
  done.component.dispose();

  const truncated = createPanel({ task: { taskId: "run-2", status: "running" }, logsText: "out\n", truncated: true });
  assert.match(truncated.plain().join("\n"), /output \(live, tail truncated\):/);
  truncated.component.dispose();
});

// ---------------------------------------------------------------------------
// D-30 — the output window fills the remaining body height
// ---------------------------------------------------------------------------

test("D-30: a 40-row terminal renders a whole output window, not the old fixed 12 rows", () => {
  const logsText = `${rows(200).join("\n")}\n`;
  withTerminalSize(40, 100, () => {
    const panel = createPanel({ task: { taskId: "big-1", status: "running" }, logsText });
    const lines = panel.plain(80);
    // Detail ratio 0.8 → 40 rows give a 32-line frame and a 30-line body.
    assert.equal(lines.length, 32, `detail frame must stay height-bounded, got:\n${lines.join("\n")}`);
    assert.match(lines[0]!, /^╭─/);
    assert.match(lines.at(-1)!, /^╰─+╯$/);
    for (const line of lines) {
      assert.equal(Array.from(line).length, 80, `padded to the requested width: ${JSON.stringify(line)}`);
    }
    assert.doesNotMatch(lines.join("\n"), /… \(\+\d+ lines\)/, "a taller body must not be collapsed into a marker");

    const outputRows = lines.filter((line) => /^│\s+row \d{3}\s+│$/.test(line)).length;
    assert.ok(
      outputRows >= 20,
      `expected >= 20 rendered output rows at 40 terminal rows (the old window was 12), got ${outputRows}:\n${lines.join("\n")}`,
    );
    assert.match(lines.join("\n"), /row 200/, "the window is glued to the newest line");
    assert.match(lines.at(-2)!, /x kill/, "the key hints survive below the output window");
    panel.component.dispose();
  });
});

test("D-30: PageUp/PageDown step by the current output window, not a fixed 12 lines", () => {
  const logsText = `${rows(100).join("\n")}\n`;
  withTerminalSize(40, 100, () => {
    const panel = createPanel({ task: { taskId: "step-1", status: "running" }, logsText });
    panel.plain(80); // 20-row window at 40 terminal rows
    panel.component.handleInput("\u001b[5~");
    const paged = panel.plain(80).join("\n");
    // 100 lines, window 20, one page up → rows 061..080.
    assert.match(paged, /row 061/, `one PageUp must move a whole window, got:\n${paged}`);
    assert.doesNotMatch(paged, /row 100/, "PageUp leaves the tail");
    panel.component.handleInput("\u001b[6~");
    const back = panel.plain(80).join("\n");
    assert.match(back, /row 100/, "PageDown returns to the tail");
    panel.component.dispose();
  });
});

// ---------------------------------------------------------------------------
// D-32 — new output does not push a scrolled-up view away
// ---------------------------------------------------------------------------

test("D-32: output arriving while scrolled up keeps the visible lines in place", () => {
  const first = rows(100);
  withTerminalSize(40, 100, () => {
    const panel = createPanel({ task: { taskId: "anchor-1", status: "running" }, logsText: `${first.join("\n")}\n` });
    const initial = panel.plain(80).join("\n");
    assert.match(initial, /row 081/);
    assert.match(initial, /row 100/, "following the tail shows the newest line");

    panel.component.handleInput("\u001b[5~"); // one window up
    const paged = panel.plain(80).join("\n");
    assert.match(paged, /row 061/);
    assert.doesNotMatch(paged, /row 100/, "precondition: the view left the tail");

    // The task keeps writing: five more lines land in the log.
    panel.logs.text = `${[...first, "row 101", "row 102", "row 103", "row 104", "row 105"].join("\n")}\n`;
    const after = panel.plain(80).join("\n");
    assert.match(after, /row 061/, "the line the user was reading is still on screen");
    assert.doesNotMatch(after, /row 081/, "the window did not slide down with the new output (the old behaviour showed rows 066..085)");
    assert.doesNotMatch(after, /row 105/, "the new output stayed below the window");

    // Follow mode still pins to the tail: two pages down and the newest line shows.
    panel.component.handleInput("\u001b[6~");
    panel.component.handleInput("\u001b[6~");
    assert.match(panel.plain(80).join("\n"), /row 105/, "follow mode is still glued to the tail");
    panel.component.dispose();
  });
});

// ---------------------------------------------------------------------------
// D-31 — the panel repaints itself at 1Hz (mock timers, no real sleep)
// ---------------------------------------------------------------------------

test("D-31: the panel repaints on its own ticker with no registry event, and stops on dispose", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const panel = createPanel({ task: { taskId: "tick-1", status: "running" }, logsText: "out\n" });
    assert.equal(panel.renders, 0, "opening the overlay does not repaint by itself");

    mock.timers.tick(999);
    assert.equal(panel.renders, 0, "nothing happens before the first 1Hz tick");
    mock.timers.tick(1);
    assert.equal(panel.renders, 1, "one tick repaints even though the registry published nothing");
    mock.timers.tick(2_000);
    assert.equal(panel.renders, 3, "one repaint per second, no registry events involved");

    panel.component.dispose();
    mock.timers.tick(5_000);
    assert.equal(panel.renders, 3, "a torn-down panel must never repaint again");
  } finally {
    mock.timers.reset();
  }
});

test("D-31: closing through q stops the ticker on the same teardown path", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const panel = createPanel({ task: { taskId: "tick-2", status: "running" }, logsText: "out\n" });
    mock.timers.tick(1_000);
    assert.equal(panel.renders, 1);

    panel.component.handleInput("q");
    assert.equal(panel.closed, true, "q closes the panel");
    mock.timers.tick(5_000);
    assert.equal(panel.renders, 1, "done() shares teardown, so the ticker is cleared too");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// R2 review fixes: the window floor, the follow invariant, and the two clean-up paths
// ---------------------------------------------------------------------------

/** A real task carries these three metadata keys, which is what eats the body on 24 rows. */
const REAL_TASK_METADATA = { outputFile: "/tmp/live.log", notifyOnCompletion: true, triggerOnCompletion: false };

test("R2-3: 24 rows with a real task's three metadata keys still render a full output window", () => {
  const logsText = `${rows(50).join("\n")}\n`;
  withTerminalSize(24, 100, () => {
    const panel = createPanel({ task: { taskId: "small-1", status: "running", metadata: REAL_TASK_METADATA }, logsText });
    const lines = panel.plain(80);
    assert.equal(lines.length, 19, "24 rows * 0.8 => a 19-line frame");
    assert.match(lines[0]!, /^╭─/);
    assert.match(lines.at(-1)!, /^╰─+╯$/, "the bottom border survives the overflow");
    for (const line of lines) assert.equal(Array.from(line).length, 80, `padded to the requested width: ${JSON.stringify(line)}`);

    // chrome (13) is taller than the body budget (17 - 13 = 4), so the window keeps its floor
    // and withBodyBudget collapses the overflow into the `… (+K lines)` marker.
    assert.match(lines.join("\n"), /… \(\+\d+ lines\)/, "the overflow is marked, not silently dropped");
    const outputRows = lines.filter((line) => /^│\s+row \d{3}\s+│$/.test(line)).length;
    assert.ok(
      outputRows >= 8,
      `a 24-row terminal must still show >= 8 output rows (the old implementation showed 4 here), got ${outputRows}:\n${lines.join("\n")}`,
    );
    assert.match(lines.join("\n"), /row 050/, "the newest line is among them");
    assert.match(lines.at(-2)!, /x kill/, "the footer is still the last body line");
    panel.component.dispose();
  });
});

test("R2-1: a scroll key on output that does not fill the window keeps following the tail", () => {
  const four = "row 001\nrow 002\nrow 003\nrow 004\n";

  // A. no repaint between the key and the growth (worst case): with nothing scrolled out of
  //    view there is nothing to anchor to, so the arriving output must still reach the window.
  withTerminalSize(40, 100, () => {
    const panel = createPanel({ task: { taskId: "grow-1", status: "running" }, logsText: four });
    assert.match(panel.plain(80).join("\n"), /row 004/);
    panel.component.handleInput("k");
    const tail = Array.from({ length: 36 }, (_, i) => `row ${String(i + 5).padStart(3, "0")}`);
    panel.logs.text = `${tail.join("\n")}\n`;
    const after = panel.plain(80).join("\n");
    assert.match(after, /row 040/, "the newest line must appear once the log grows past the window");
    assert.doesNotMatch(after, /row 001/, "the view did not stay pinned to the 4 lines it started on");
    panel.component.dispose();
  });

  // B. the host repaints right after a key: the clamp restores follow, so the *next* growth
  //    steps still reach the tail instead of anchoring to the lines that happened to be visible.
  withTerminalSize(40, 100, () => {
    const panel = createPanel({ task: { taskId: "grow-2", status: "running" }, logsText: four });
    panel.component.handleInput("k");
    panel.plain(80); // the repaint the host performs right after the key (follow back to true)
    panel.logs.text = `${rows(40).join("\n")}\n`;
    panel.plain(80);
    panel.logs.text = `${rows(45).join("\n")}\n`;
    const after = panel.plain(80).join("\n");
    assert.match(after, /row 045/, "a second growth step must still follow the tail");
    assert.match(after, /row 026/, "the window is glued to the tail, not to the first lines");
    panel.component.dispose();
  });

  // C. the page keys share the invariant (PageUp on an unfilled window also clamps to 0).
  withTerminalSize(40, 100, () => {
    const panel = createPanel({ task: { taskId: "grow-3", status: "running" }, logsText: "row 001\nrow 002\n" });
    panel.plain(80); // the overlay is painted before the user can press a key
    panel.component.handleInput("\u001b[5~");
    panel.logs.text = `${rows(40).join("\n")}\n`;
    assert.match(panel.plain(80).join("\n"), /row 040/, "PageUp on an unfilled window must not stop following");
    panel.component.dispose();
  });
});

test("R2-2: a rejecting custom() tears down the ticker the factory already started", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    resetPanelForTests();
    const task = makeSnapshot({ taskId: "reject-1", status: "running" });
    const registry = {
      list: () => [task],
      get: () => task,
      logs: () => ({ text: "out\n", truncated: false, fullPath: "/tmp/live.log" }),
    };
    let renders = 0;
    let customCalls = 0;
    let rejectNext = true;
    const ui = {
      custom: (next: (tui: unknown, theme: unknown, keys: unknown, done: (value?: unknown) => void) => unknown) => {
        customCalls += 1;
        next({ requestRender() { renders += 1; } }, {}, {}, () => undefined);
        if (!rejectNext) return Promise.resolve();
        rejectNext = false;
        return Promise.reject(new Error("host refused the overlay"));
      },
    };
    openPanel({ mode: "tui", ui } as never, registry as never, "reject-1");
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection handler run
    mock.timers.tick(2_500);
    assert.equal(renders, 0, "a rejected custom() must clear the ticker the factory already started");

    // The singleton was released with it: a second open is a fresh widget, not a stacked one.
    openPanel({ mode: "tui", ui } as never, registry as never, "reject-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(customCalls, 2, "the failed open must not keep the singleton latched");
    mock.timers.tick(1_000);
    assert.equal(renders, 1, "only the second widget's ticker is alive");
  } finally {
    mock.timers.reset();
    resetPanelForTests();
  }
});

test("R2-4: dispose calls clearInterval with the very handle it created", () => {
  const intervalSpy = mock.method(globalThis, "setInterval");
  const clearSpy = mock.method(globalThis, "clearInterval");
  try {
    const panel = createPanel({ task: { taskId: "clear-1", status: "running" }, logsText: "out\n" });
    assert.equal(intervalSpy.mock.calls.length, 1, "opening the widget starts exactly one ticker");
    const handle = intervalSpy.mock.calls[0]!.result;
    assert.ok(handle, "setInterval returned a handle to remember");

    panel.component.dispose();
    assert.equal(clearSpy.mock.calls.length, 1, "teardown must clear the ticker exactly once");
    assert.equal(clearSpy.mock.calls[0]!.arguments[0], handle, "clearInterval must receive the ticker handle");

    panel.component.dispose();
    assert.equal(clearSpy.mock.calls.length, 1, "teardown is idempotent: no second clearInterval");
  } finally {
    clearSpy.mock.restore();
    intervalSpy.mock.restore();
  }
});
