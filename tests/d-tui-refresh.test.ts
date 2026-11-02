import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPanel, resetPanelForTests } from "../src/tui/panel.ts";
import { TaskRegistry, type RegistryEvent } from "../src/core/registry.ts";
import { createRailFactory } from "../src/tui/rail.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";
import { refreshFooter } from "../src/tui/status.ts";
import { makeSnapshot } from "./helpers/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * Fixture paths live in a per-file temp dir (review item 7): the panel asks the registry
 * for output, and a real registry enforces the dataDir boundary, so fixed `/tmp/*.log`
 * paths would be both unrealistic and unsafe.
 */
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "pi-async-d-tui-"));
const OUTPUT_FILE = join(FIXTURE_DIR, "task-1.log");
writeFileSync(OUTPUT_FILE, "line 1\nline 2\n");
test.after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

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
 * Fake registry mirroring the `subscribe(listener) => unsubscribe` contract.
 * `subscribe: false` models the 0.2.x registry that has no event surface at all;
 * `logsThrows` models a pruned task or an out-of-dataDir outputFile (D-11).
 */
function setup(opts: {
  subscribe?: boolean;
  tasks?: TaskSnapshot[];
  initialTaskId?: string;
  logsThrows?: boolean;
  logsText?: string;
} = {}) {
  resetPanelForTests();
  const tasks = opts.tasks ?? [makeSnapshot({ taskId: "task-1", name: "alpha", metadata: { outputFile: OUTPUT_FILE } })];
  const listeners = new Set<(event: unknown) => void>();
  const unsubscribes: string[] = [];
  const logsCalls: string[] = [];
  let customCalls = 0;
  let renders = 0;
  const notified: { message: string; level?: string }[] = [];
  const registry: Record<string, unknown> = {
    list: () => tasks,
    get: (id: string) => tasks.find((task) => task.taskId === id),
    logs: (id: string) => {
      logsCalls.push(id);
      if (opts.logsThrows) throw new Error("outputFile is outside the data dir");
      return { text: opts.logsText ?? "line\n", truncated: false, fullPath: OUTPUT_FILE };
    },
    kill: async () => undefined,
    submit: () => tasks[0],
  };
  if (opts.subscribe !== false) {
    registry["subscribe"] = (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) unsubscribes.push("off");
      };
    };
  }
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  let closed = false;
  const ui = {
    custom: (next: typeof factory) => { customCalls += 1; factory = next; return Promise.resolve(); },
    notify: (message: string, level?: string) => { notified.push({ message, level }); },
  };
  const open = (): void => { openPanel({ mode: "tui", ui } as never, registry as never, opts.initialTaskId); };
  open();
  const component = factory!({ requestRender() { renders += 1; } }, {}, {}, () => { closed = true; });
  return {
    component,
    registry,
    listeners,
    unsubscribes,
    logsCalls,
    notified,
    open,
    get customCalls() { return customCalls; },
    get renders() { return renders; },
    get closed() { return closed; },
    get factory() { return factory; },
    get task() { return tasks[0]!; },
  };
}

test("panel subscribes to registry events and re-renders on finalize", () => {
  const panel = setup();
  assert.equal(panel.listeners.size, 1, "opening the panel must register exactly one listener");
  const [listener] = [...panel.listeners];
  listener!({ type: "finalize", snapshot: { ...panel.task, status: "completed" } });
  assert.equal(panel.renders, 1, "a finalize event must request a render");
  listener!({ type: "state", snapshot: panel.task });
  assert.equal(panel.renders, 2, "state events refresh too (running elapsed/last line)");
  panel.component.dispose();
});

test("dispose unsubscribes so a stale registry event never renders again", () => {
  const panel = setup();
  const [listener] = [...panel.listeners];
  panel.component.dispose();
  assert.equal(panel.listeners.size, 0, "dispose must unsubscribe from the registry");
  assert.deepEqual(panel.unsubscribes, ["off"], "unsubscribe returned by subscribe must be called exactly once");
  listener!({ type: "finalize", snapshot: panel.task });
  assert.equal(panel.renders, 0, "a listener fired after dispose must not requestRender (no leak)");
  panel.component.dispose();
  assert.equal(panel.unsubscribes.length, 1, "dispose is idempotent: one unsubscribe only");
});

test("closing the panel through q unsubscribes as well", () => {
  const panel = setup();
  assert.equal(panel.listeners.size, 1);
  panel.component.handleInput("q");
  assert.equal(panel.closed, true);
  assert.equal(panel.listeners.size, 0, "the done() path must unsubscribe");
});

test("a registry without subscribe still opens and renders", () => {
  const panel = setup({ subscribe: false });
  assert.equal(panel.listeners.size, 0);
  assert.doesNotThrow(() => panel.component.render(80));
  assert.ok((panel.component.render(80) as string[]).length > 0);
  panel.component.dispose();
});

test("second openPanel does not stack another overlay and notifies instead", () => {
  const panel = setup();
  assert.equal(panel.customCalls, 1);
  panel.open();
  assert.equal(panel.customCalls, 1, "a second /async must not call ui.custom again");
  assert.ok(
    panel.notified.some((entry) => entry.message === "Async panel is already open" && entry.level === "info"),
    `expected the singleton notice, got ${JSON.stringify(panel.notified)}`,
  );
  panel.component.dispose();
});

test("done() releases the singleton so the panel can be reopened", () => {
  const panel = setup();
  panel.open();
  assert.equal(panel.customCalls, 1);
  panel.component.handleInput("q"); // q → done
  assert.equal(panel.closed, true);
  panel.open();
  assert.equal(panel.customCalls, 2, "after the previous panel closed a new overlay may open");
  panel.component.dispose();
});

test("dispose() also releases the singleton", () => {
  const panel = setup();
  panel.component.dispose();
  panel.open();
  assert.equal(panel.customCalls, 2);
  panel.component.dispose();
});

test("detail keeps the footer visible and marks omitted lines on a short terminal", () => {
  withTerminalSize(12, 100, () => {
    const panel = setup({ initialTaskId: "task-1" });
    const lines = panel.component.render(80) as string[];
    const body = lines.join("\n");
    // 12 rows * 0.8 => height 9 => 7 body lines, well below the full detail body.
    assert.equal(lines.length, 9, `detail frame height must stay height-bounded, got:\n${body}`);
    assert.match(body, /… \(\+\d+ lines\)/, "omitted lines must be marked, not silently dropped");
    assert.match(body, /x kill/, "the key hints must survive the body budget");
    assert.doesNotMatch(body, /k kill/, "the old k-kill hint is gone");
    assert.match(body, /c show output path/);
    // The footer is the last body line, i.e. directly above the bottom border.
    assert.match(lines[lines.length - 2]!, /x kill/);
    for (const line of lines) {
      assert.equal(Array.from(line).length, 80, `padded to the requested width: ${JSON.stringify(line)}`);
    }
    panel.component.dispose();
  });
});

test("degenerate height still shows the key hints", () => {
  withTerminalSize(6, 100, () => {
    const panel = setup({ initialTaskId: "task-1" });
    const body = (panel.component.render(80) as string[]).join("\n");
    assert.match(body, /x kill/);
    assert.doesNotThrow(() => panel.component.render(80));
    panel.component.dispose();
  });
});

test("list body stays within the frame budget", () => {
  withTerminalSize(12, 100, () => {
    const tasks = Array.from({ length: 30 }, (_, i) => makeSnapshot({
      taskId: `t${String(i).padStart(2, "0")}`,
      name: `task${String(i).padStart(2, "0")}`,
      status: "running",
      startedAt: Date.now() - i,
    }));
    const panel = setup({ subscribe: false, tasks });
    const lines = panel.component.render(100) as string[];
    // List ratio is 0.7: 12 rows => height 8.
    assert.equal(lines.length, 8, "list height stays exactly at the overlay budget");
    assert.match(lines.join("\n"), /Enter details/);
    panel.component.dispose();
  });
});

test("rail summary counts only tasks that also render a row (one linger window)", () => {
  const now = Date.now();
  const tasks = [
    makeSnapshot({ taskId: "fresh", name: "fresh-job", status: "completed", finishedAt: now - 1_000, startedAt: now - 2_000 }),
    makeSnapshot({ taskId: "stale", name: "stale-job", status: "completed", finishedAt: now - 200_000, startedAt: now - 201_000 }),
  ];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)(
    { requestRender() {} } as never,
    { fg: (_token: string, text: string) => text } as never,
  );
  const rows = widget.render(100);
  assert.match(rows[0]!, /✓1/, "one terminal task is inside the linger window");
  assert.equal(rows.filter((row) => row.includes("fresh-job")).length, 1, "✓N always has a matching row");
  assert.equal(rows.some((row) => row.includes("stale-job")), false);
  widget.dispose?.();
});

test("detail tails a long output and scrolling survives the body budget", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
  withTerminalSize(12, 100, () => {
    const panel = setup({ subscribe: false, initialTaskId: "task-1", logsText: lines });
    const first = (panel.component.render(80) as string[]).join("\n");
    assert.match(first, /line 40/, "the newest output line is visible");
    assert.match(first, /… \(\+\d+ lines\)/);
    panel.component.handleInput("\u001b[A"); // scroll the output window up one line
    const second = (panel.component.render(80) as string[]).join("\n");
    assert.notEqual(second, first, "scrolling must not be clamped away by the body budget");
    assert.equal(second.includes("line 40"), false, "scrolling up leaves the newest line behind");
    assert.match(second, /x kill/, "the hint footer survives scrolling");
    panel.component.dispose();
  });
});

test("output is read through registry.logs, never from metadata.outputFile", () => {
  // A real file at metadata.outputFile whose content must never reach the panel:
  // only the registry decides whether the path is inside the data dir (D-11).
  const outside = join(FIXTURE_DIR, "outside-secret.log");
  writeFileSync(outside, "TOPSECRET-DO-NOT-READ\n");
  const task = makeSnapshot({ taskId: "task-1", name: "alpha", status: "running", metadata: { outputFile: outside } });
  const panel = setup({ subscribe: false, tasks: [task], logsThrows: true, logsText: "FRESH-FROM-REGISTRY\n" });
  const list = (panel.component.render(100) as string[]).join("\n");
  assert.equal(list.includes("TOPSECRET"), false, "the list must not read outputFile directly");
  panel.component.handleInput("\r");
  const detail = (panel.component.render(100) as string[]).join("\n");
  assert.equal(detail.includes("TOPSECRET"), false, "the detail must not read outputFile directly");
  assert.match(detail, /output:/, "the output section still renders (empty) when reads are refused");
  assert.match(detail, /x kill/);
  assert.ok(panel.logsCalls.length >= 2, "both list and detail ask the registry for output");
  for (const id of panel.logsCalls) assert.equal(id, "task-1");
  panel.component.dispose();
});

test("the newest list line comes from registry.logs", () => {
  const panel = setup({ subscribe: false, logsText: "older\nFRESH-FROM-REGISTRY\n" });
  const list = (panel.component.render(120) as string[]).join("\n");
  assert.match(list, /FRESH-FROM-REGISTRY/, "the tail line is read through the registry");
  panel.component.dispose();
});

test("detail masks delayedEnv values but keeps the keys", () => {
  const task = makeSnapshot({
    taskId: "delayed-1",
    name: "later",
    status: "pending",
    mode: "delayed",
    metadata: { outputFile: OUTPUT_FILE, delayedEnv: { FOO_TOKEN: "s3cr3t-value", CI: "1" } },
  });
  const panel = setup({ subscribe: false, initialTaskId: "delayed-1", tasks: [task] });
  const body = (panel.component.render(100) as string[]).join("\n");
  assert.match(body, /delayedEnv:/, "the metadata key stays visible");
  assert.match(body, /FOO_TOKEN: "\*\*\*"/, "env names are kept…");
  assert.match(body, /CI: "\*\*\*"/);
  assert.equal(body.includes("s3cr3t-value"), false, "…values are masked");
  panel.component.dispose();
});

test("status footer is opt-in via PI_ASYNC_FOOTER and needs setStatus", () => {
  const previous = process.env.PI_ASYNC_FOOTER;
  const statuses: { key: string; text: string | undefined }[] = [];
  resetTuiHostForTests();
  try {
    const registry = {
      list: () => [makeSnapshot({ taskId: "run", status: "running", startedAt: Date.now() - 1_000 })],
      activeCount: () => ({ running: 1, pending: 0 }),
    } as never;
    // No bound host: nothing to publish to and nothing thrown.
    assert.doesNotThrow(() => refreshFooter(registry));
    bindTuiHost({ mode: "tui", ui: { setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text }); } } });
    delete process.env.PI_ASYNC_FOOTER;
    refreshFooter(registry);
    assert.equal(statuses.length, 0, "the footer stays off by default");
    process.env.PI_ASYNC_FOOTER = "1";
    refreshFooter(registry);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.key, "pi-async");
    assert.match(statuses[0]!.text ?? "", /1 running/);
  } finally {
    if (previous === undefined) delete process.env.PI_ASYNC_FOOTER;
    else process.env.PI_ASYNC_FOOTER = previous;
    resetTuiHostForTests();
  }
});

// ---------------------------------------------------------------------------
// The emitter side: a real TaskRegistry (review item 1). Deleting the
// `this.listeners` loop in registry.emit() must turn these red.
// ---------------------------------------------------------------------------

test("real TaskRegistry publishes state then finalize and stops after unsubscribe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-tui-registry-"));
  const registry = new TaskRegistry({ dataDir: dir, maxOutputBytes: 4096 });
  const events: RegistryEvent[] = [];
  const off = registry.subscribe((event) => { events.push(event); });
  try {
    const task = registry.submit({ command: "printf hello" });
    assert.ok(
      events.some((event) => event.type === "state" && event.snapshot.taskId === task.taskId),
      "submit must publish a state event to subscribers",
    );
    const outcome = await registry.wait([task.taskId], 5_000);
    assert.ok("results" in outcome, "the task must settle");
    const finalized = events.filter((event) => event.type === "finalize" && event.snapshot.taskId === task.taskId);
    assert.equal(finalized.length, 1, `exactly one finalize event, got ${JSON.stringify(finalized.map((e) => e.type))}`);
    assert.equal(finalized[0]!.snapshot.status, "completed");

    off();
    const seen = events.length;
    const second = registry.submit({ command: "printf again" });
    await registry.wait([second.taskId], 5_000);
    assert.equal(events.length, seen, "after unsubscribe no further events may arrive");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing listener cannot break other listeners or finalize persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-tui-listener-"));
  const registry = new TaskRegistry({ dataDir: dir, maxOutputBytes: 4096 });
  const seen: string[] = [];
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  registry.subscribe(() => { throw new Error("listener boom"); });
  registry.subscribe((event) => { seen.push(event.type); });
  try {
    const task = registry.submit({ command: "printf ok" });
    const outcome = await registry.wait([task.taskId], 5_000);
    assert.ok("results" in outcome);
    assert.ok(seen.includes("state"), `the healthy listener must still see state events, got ${seen.join(",")}`);
    assert.ok(seen.includes("finalize"), `the healthy listener must still see finalize, got ${seen.join(",")}`);
    const persisted = JSON.parse(readFileSync(join(dir, `${task.taskId}.json`), "utf8")) as TaskSnapshot;
    assert.equal(persisted.status, "completed", "finalize must still persist the snapshot");
    assert.ok(logged.length >= 1, "the throwing listener is reported, not swallowed silently");
  } finally {
    console.error = originalError;
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing requestRender cannot crash the rail ticker", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const callbacks: (() => void)[] = [];
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((callback: () => void) => {
    callbacks.push(callback);
    return { unref() { return this; } } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = (() => undefined) as typeof clearInterval;
  try {
    const widget = createRailFactory({} as never, { list: () => [makeSnapshot({ taskId: "run", status: "running" })] } as never)(
      { requestRender() { throw new Error("host is gone"); } } as never,
      { fg: (_token: string, text: string) => text } as never,
    );
    assert.equal(callbacks.length, 1, "the rail owns exactly one repaint ticker");
    assert.doesNotThrow(() => callbacks[0]!(), "the ticker must swallow host repaint failures");
    widget.dispose?.();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("a real registry feeds the detail output section", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-tui-real-"));
  const registry = new TaskRegistry({ dataDir: dir, maxOutputBytes: 4096 });
  try {
    const task = registry.submit({ command: "printf 'REAL-OUTPUT-LINE\\n'" });
    await registry.wait([task.taskId], 5_000);
    resetPanelForTests();
    let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
    const ui = { custom: (next: typeof factory) => { factory = next; return Promise.resolve(); } };
    openPanel({ mode: "tui", ui } as never, registry as never, task.taskId);
    const component = factory!({ requestRender() {} }, {}, {}, () => undefined);
    const body = (component.render(100) as string[]).join("\n");
    assert.match(body, /REAL-OUTPUT-LINE/, "detail reads the task output through registry.logs");
    assert.match(body, /completed/);
    assert.match(body, /x kill/);
    component.dispose();
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
