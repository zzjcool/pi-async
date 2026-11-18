import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { RAIL_WIDGET_KEY, createRailFactory, registerRail } from "../src/tui/rail.ts";
import { bindTuiHost, resetTuiHostForTests, tuiHost } from "../src/tui/host.ts";
import { ensureRailSurface, mountRailDetail, railMounted, railShowsTasks, resetRailSurfaceForTests } from "../src/tui/surfaces.ts";
import { registerHold } from "../src/guard/hold.ts";
import { makeSnapshot } from "./helpers/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * Rail liveness (0.4.7, §7.1 修订 7). The product rule these tests freeze:
 *
 * **a task that is running must have a rail** — the list above the editor is driven by task state,
 * never by a hold, and a rail the host dropped must come back instead of leaving the user blind.
 *
 * 0.4.6 believed `registerRail` had run ⇒ the rail was visible. That chain is broken by the host
 * itself: `resetExtensionUI()` → `clearExtensionWidgets()` disposes and drops every extension widget
 * (`interactive-mode.js:2004-2014`, reached from session invalidate `:383` and `/reload` `:5510`),
 * and a mounted factory can still paint zero rows. So the tests below drive the *host* behaviour,
 * not a flag.
 */

/**
 * A host shaped like pi's `InteractiveMode` widget surface:
 *
 * - `setWidget(key, content)` disposes + deletes **only that key** (`setExtensionWidget`, :1970-2003);
 * - `clearWidgets()` is `clearExtensionWidgets()` (:2004-2014): dispose everything, then empty the map;
 * - nothing re-creates a cleared widget on its own — that is the extension's job.
 */
function makeHost() {
  const widgets = new Map<string, { render(width?: number): string[]; dispose?(): void }>();
  let installs = 0;
  const ui = {
    setWidget(key: string, content: unknown, _options?: unknown) {
      widgets.get(key)?.dispose?.();
      widgets.delete(key);
      if (content === undefined) return;
      installs++;
      const component = Array.isArray(content)
        ? { render: () => content as string[] }
        : (content as (tui: unknown, theme: unknown) => { render(width?: number): string[]; dispose?(): void })(
            { requestRender() {} },
            { fg: (_token: string, text: string) => text },
          );
      widgets.set(key, component);
    },
  };
  return {
    ui,
    widgets,
    installs: () => installs,
    /** Paint exactly what the host would paint for that widget key. */
    render(key: string, width = 120): string[] {
      return widgets.get(key)?.render(width) ?? [];
    },
    /** `resetExtensionUI()`: session invalidate (/new, /resume, /fork) or /reload. */
    clearWidgets(): void {
      for (const widget of widgets.values()) widget.dispose?.();
      widgets.clear();
    },
    dispose(): void {
      this.clearWidgets();
    },
  };
}

/** A registry whose rows the test drives; `list` is the only surface the rail and the hold read. */
function makeRegistry(initial: TaskSnapshot[] = []) {
  let tasks = initial;
  return {
    list: (_opts?: { includeHistory?: boolean }) => tasks,
    get: (taskId: string) => tasks.find((task) => task.taskId === taskId),
    set(next: TaskSnapshot[]) {
      tasks = next;
    },
  };
}

const running = (taskId: string, name: string, startedAt = Date.now() - 60_000): TaskSnapshot =>
  makeSnapshot({ taskId, name, status: "running", startedAt });

function wire(registry: ReturnType<typeof makeRegistry>) {
  const host = makeHost();
  resetTuiHostForTests();
  resetRailSurfaceForTests();
  bindTuiHost({ mode: "tui", ui: host.ui });
  registerRail({} as never, registry as never);
  return host;
}

afterEach(() => {
  resetRailSurfaceForTests();
  resetTuiHostForTests();
});

test("a running task has a rail row — with no hold anywhere in the picture", () => {
  const registry = makeRegistry([running("t1", "watch-yamlfix")]);
  const host = wire(registry);

  const rows = host.render(RAIL_WIDGET_KEY);
  assert.ok(rows.length >= 1, `the rail paints without any hold (got ${JSON.stringify(rows)})`);
  assert.ok(rows.some((row) => row.includes("watch-yamlfix")), `the task is named on the rail (got ${JSON.stringify(rows)})`);
  assert.ok(rows.some((row) => row.includes("running")), "the row carries the state");
  assert.ok(tuiHost() !== undefined, "the host is bound, so a later task can be shown too");
});

test("a task that starts after the rail exists shows up, and its row leaves when it settles", () => {
  // The linger window is read when the widget is built, so close it before registering.
  const previous = process.env.PI_ASYNC_RAIL_LINGER_MS;
  process.env.PI_ASYNC_RAIL_LINGER_MS = "0";
  const registry = makeRegistry([]);
  const host = wire(registry);
  try {
    assert.deepEqual(host.render(RAIL_WIDGET_KEY), [], "nothing to show before any task exists");

    registry.set([running("t1", "later")]);
    assert.ok(host.render(RAIL_WIDGET_KEY).some((row) => row.includes("later")), "the new task appears");

    // Terminal rows linger (30s) by design so the outcome is visible; with the linger window closed
    // the row must be gone — an idle session paints nothing.
    const finished = makeSnapshot({ taskId: "t1", name: "later", status: "completed", startedAt: Date.now() - 5_000, finishedAt: Date.now() });
    registry.set([finished]);
    assert.deepEqual(host.render(RAIL_WIDGET_KEY), [], "a settled task drops off the rail");
  } finally {
    host.dispose();
    if (previous === undefined) delete process.env.PI_ASYNC_RAIL_LINGER_MS;
    else process.env.PI_ASYNC_RAIL_LINGER_MS = previous;
  }
});

test("no tasks never paint a phantom rail row", () => {
  const registry = makeRegistry([]);
  const factory = createRailFactory({} as never, registry as never);
  const widget = factory({ requestRender() {} } as never, { fg: (_token: string, text: string) => text } as never);
  try {
    assert.deepEqual(widget.render(120), [], "an empty registry paints nothing");
  } finally {
    widget.dispose?.();
  }
});

test("the rail reads the live registry, so an adopted generation still paints its tasks", () => {
  const retired = makeRegistry([]); // the generation the rail was installed with
  const adopted = makeRegistry([running("t9", "adopted-task")]);
  let current = retired;
  resetTuiHostForTests();
  resetRailSurfaceForTests();
  const host = makeHost();
  bindTuiHost({ mode: "tui", ui: host.ui });
  registerRail({} as never, () => current as never);
  assert.deepEqual(host.render(RAIL_WIDGET_KEY), [], "the retired registry paints nothing");

  current = adopted; // ensureConfigured() adopted the work into another instance
  assert.ok(
    host.render(RAIL_WIDGET_KEY).some((row) => row.includes("adopted-task")),
    "the rail follows the live registry instead of the one captured at registration",
  );
});

test("a widget the host cleared is re-installed instead of staying dark", () => {
  const registry = makeRegistry([running("t1", "watch-yamlfix")]);
  const host = wire(registry);
  assert.ok(host.render(RAIL_WIDGET_KEY).length > 0, "the rail is there to begin with");
  assert.equal(railMounted(), true, "the widget records itself as mounted");
  const installsBefore = host.installs();

  host.clearWidgets(); // session invalidate / /reload: the host drops every extension widget
  assert.deepEqual(host.render(RAIL_WIDGET_KEY), [], "the user is looking at no rail");
  assert.equal(railMounted(), false, "dispose() withdrew the mounted detail — the old flag lied here");
  assert.equal(railShowsTasks(["t1"]), false, "nothing claims the detail is on screen");

  assert.equal(ensureRailSurface(), true, "the self-heal re-installs the widget");
  assert.equal(host.installs(), installsBefore + 1, "exactly one new install");
  assert.ok(host.render(RAIL_WIDGET_KEY).some((row) => row.includes("watch-yamlfix")), "the list is back");

  // Registration is idempotent: an installed rail is not re-created on every lifecycle event.
  registerRail({} as never, registry as never);
  assert.equal(host.installs(), installsBefore + 1, "no churn while the widget is mounted");
});

test("with no setWidget host the rail stays absent and the hold keeps the task names", () => {
  resetTuiHostForTests();
  resetRailSurfaceForTests();
  bindTuiHost({ mode: "tui", ui: {} });
  registerRail({} as never, makeRegistry([running("t1", "x")]) as never);
  assert.equal(railMounted(), false);
  assert.equal(ensureRailSurface(), false, "there is no surface to install into");
  assert.equal(railShowsTasks(["t1"]), false, "and nothing may claim the detail is visible");
});

test("a rail the host clears mid-turn comes back while the hold is waiting", async () => {
  const task = running("t5r00002-aaaa-bbbb-cccc-dddddddddddd", "watch-dropped-rail", Date.now() - 64_000);
  const registry = makeRegistry([task]);
  const host = wire(registry);
  const handlers: Array<(...args: unknown[]) => unknown> = [];
  const pi = { on: (_event: string, handler: (...args: unknown[]) => unknown) => { handlers.push(handler); return () => {}; } };
  const holdRows: Array<string[] | undefined> = [];
  let stop = false;
  const polled = { list: () => (stop ? [] : [task]) };
  registerHold(pi as never, polled as never, { holdMs: 5_000, pollMs: 30 });
  const ctx = {
    mode: "tui",
    ui: {
      setStatus: () => undefined,
      setWidget: (key: string, content: string[] | undefined) => {
        if (key === "pi-async-hold") holdRows.push(content);
        host.ui.setWidget(key, content);
      },
      onTerminalInput: () => () => {},
    },
  };
  const pending = handlers[0]!({ entries: [] }, ctx) as Promise<unknown>;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(host.render(RAIL_WIDGET_KEY).some((row) => row.includes(task.name)), "the rail carries the task");
    const installsBefore = host.installs();

    host.clearWidgets(); // the host drops every widget while the hold is still waiting
    await new Promise((resolve) => setTimeout(resolve, 400)); // a couple of 250 ms paint frames

    assert.ok(host.installs() > installsBefore, "the hold asking for the detail re-installs the rail");
    assert.ok(host.render(RAIL_WIDGET_KEY).some((row) => row.includes(task.name)), "the list is back above the editor");
    // And no silent frame: the very first row written after the clear already names the task.
    const afterClear = holdRows.filter((row) => row !== undefined).at(-1);
    assert.ok(String(afterClear?.[0]).includes("waiting"), `the hold row is still painting (got: ${afterClear})`);
  } finally {
    stop = true;
    await pending;
  }
});

test("hold + rail are one source: the rail lists exactly the tasks the hold waits for", async () => {
  const task = running("t4q00001-aaaa-bbbb-cccc-dddddddddddd", "watch-t4q-yamlfix", Date.now() - 64_000);
  const registry = makeRegistry([task]);
  const host = wire(registry);
  const railRows = () => host.render(RAIL_WIDGET_KEY).filter((row) => row.startsWith("▶"));

  const handlers: Array<(...args: unknown[]) => unknown> = [];
  const pi = { on: (_event: string, handler: (...args: unknown[]) => unknown) => { handlers.push(handler); return () => {}; } };
  const writes: Array<string[] | undefined> = [];
  let stop = false;
  const polled = {
    list: (opts?: { includeHistory?: boolean }) => {
      if (stop) return [];
      return registry.list(opts);
    },
  };
  registerHold(pi as never, polled as never, { holdMs: 300, pollMs: 30 });
  const ctx = {
    mode: "tui",
    ui: {
      setStatus: () => undefined,
      setWidget: (key: string, content: string[] | undefined) => {
        if (key === "pi-async-hold") writes.push(content);
        host.ui.setWidget(key, content);
      },
      onTerminalInput: () => () => {},
    },
  };
  const pending = handlers[0]!({ entries: [] }, ctx) as Promise<unknown> | undefined;
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Same source: the rail's task rows are exactly the set the hold is waiting for — the probe the
  // hold reads (`railShowsTasks`) agrees with what the rail paints.
  assert.equal(railShowsTasks([task.taskId]), true, `the rail covers the waited task (got ${JSON.stringify(railRows())})`);
  assert.equal(railRows().filter((row) => row.includes(task.name)).length, 1, `exactly one rail row for the waited task (got ${JSON.stringify(railRows())})`);
  assert.equal(railRows().length, 2, "one summary row plus the task row");
  const holdRow = String(writes.at(-1)?.[0] ?? "");
  assert.ok(!holdRow.includes(task.name), `the rail owns the detail, so the hold does not repeat it (got: ${holdRow})`);
  assert.match(holdRow, /waiting \d+s — Esc stops waiting$/);

  stop = true;
  await pending;
  assert.equal(registry.list().length, 1, "the registry itself was never mutated");
  void handlers;
});
/**
 * The wiring tests: the product invariant has to survive the real `init()` path, because that is where
 * 0.4.6's bug lived — the rail was installed once from the first TUI bind (behind the `bindTuiHost`
 * latch) and never re-ensured, so one host-side widget clear left the session without a list.
 *
 * Kept last in this file: `init()` installs process-wide state (`activeRegistry`, the bound host).
 */
async function makeExtensionHarness() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { init } = await import("../extensions/index.ts");

  const dir = mkdtempSync(join(tmpdir(), "pi-async-rail-e2e-"));
  resetTuiHostForTests();
  resetRailSurfaceForTests();
  const host = makeHost();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ details?: { payload?: unknown }; isError?: boolean }> }>();
  const sessionManager = { getSessionDir: () => dir, getSessionId: () => `rail-e2e-${process.pid}` };
  const pi = {
    sessionManager,
    registerTool: (tool: { name: string } & Record<string, unknown>) => { tools.set(tool.name, tool as never); },
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
      return () => { const current = hooks.get(event); if (current) current.splice(current.indexOf(handler), 1); };
    },
  };
  const ctx = {
    mode: "tui",
    cwd: dir,
    sessionManager,
    ui: { ...host.ui, setStatus: () => undefined, custom: () => Promise.resolve() },
  };
  const dispatch = async (event: string, payload?: unknown): Promise<void> => {
    for (const handler of [...(hooks.get(event) ?? [])]) await handler(payload, ctx);
  };
  const startTask = async (name: string): Promise<void> => {
    const run = tools.get("async_run");
    assert.ok(run, "async_run is registered");
    const started = await run!.execute(`call-${name}`, { command: "sleep 5", name }, undefined, undefined, ctx);
    assert.notEqual(started.isError, true);
  };
  await init(pi as never);
  await dispatch("session_start", { reason: "startup" });
  return {
    host,
    startTask,
    dispatch,
    async cleanup(): Promise<void> {
      await dispatch("session_shutdown", { reason: "quit" });
      host.dispose();
      resetRailSurfaceForTests();
      resetTuiHostForTests();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("init() re-ensures the rail after the host clears its widgets", async () => {
  const h = await makeExtensionHarness();
  try {
    assert.ok(h.host.widgets.has(RAIL_WIDGET_KEY), "the first lifecycle event installs the rail");
    await h.startTask("watch-e2e");
    assert.ok(h.host.render(RAIL_WIDGET_KEY).some((row) => row.includes("watch-e2e")), "a running task shows on the rail");

    // Session invalidate / /reload: the host wipes every extension widget.
    h.host.clearWidgets();
    assert.deepEqual(h.host.render(RAIL_WIDGET_KEY), [], "the rail is gone while the task keeps running");

    await h.dispatch("message_start", {});
    const rows = h.host.render(RAIL_WIDGET_KEY);
    assert.ok(rows.some((row) => row.includes("watch-e2e")), `the next lifecycle event brings the list back (got ${JSON.stringify(rows)})`);
  } finally {
    await h.cleanup();
  }
});

/**
 * Product invariant, the exact shape the user reported: the rail was there, the host dropped it, and
 * the *next task* has to bring it back — no lifecycle event in between, no hold involved. This is the
 * `registry` state hook in `init()`; deleting it turns this test red.
 */
test("init() re-installs the rail when a task appears after the host cleared widgets", async () => {
  const h = await makeExtensionHarness();
  try {
    await h.startTask("watch-before");
    assert.ok(h.host.render(RAIL_WIDGET_KEY).some((row) => row.includes("watch-before")), "the rail works before the clear");

    h.host.clearWidgets();
    assert.deepEqual(h.host.render(RAIL_WIDGET_KEY), [], "the host dropped the widget");

    await h.startTask("watch-after"); // no session_start / message_start in between
    const rows = h.host.render(RAIL_WIDGET_KEY);
    assert.ok(rows.some((row) => row.includes("watch-after")), `the new task's own state event reinstalls the rail (got ${JSON.stringify(rows)})`);
  } finally {
    await h.cleanup();
  }
});
