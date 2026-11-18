import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { RAIL_MAX_LINES, RAIL_TASK_SLOTS, RAIL_WIDGET_KEY, registerRail } from "../src/tui/rail.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";
import { holdSurface, resetRailSurfaceForTests, type HoldSurface } from "../src/tui/surfaces.ts";
import { HOLD_FALLBACK_WIDGET_KEY, registerHold } from "../src/guard/hold.ts";
import { makeSnapshot } from "./helpers/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * The hold waits **inside** the rail (0.4.8, CONTRACT §7.1 修订 8).
 *
 * The user's ruling: `⠙ waiting 2m 28s — Esc stops waiting` above the input box is not wanted — the
 * wait is one row, so it becomes the rail's first row and displaces the summary while it lasts:
 *
 *     ⠙ async_wait · running 2m 28s — Esc stops waiting
 *     ▶ watch-t71 · running · 4m 6s
 *     ▶ watch-t6z2 · running · 4m 6s
 *     ▶ watch-t73 · running · 4m 6s
 *
 * Four things are frozen here; each is a regression if it comes back:
 *
 * 1. row 0 carries the hold's own frame **and** its own elapsed, while three task names still fit in
 *    `RAIL_MAX_LINES` (shrinking `RAIL_TASK_SLOTS` to make room is forbidden — it would drop a task
 *    row, make `railShowsTasks` false and bring the fallback line back, saying it twice);
 * 2. the wait **displaces** the summary row, it does not add one;
 * 3. `async_wait` appears exactly **once** on the whole screen in every state — rail carrying it, rail
 *    gone (fallback line), hold over (no waiting text at all);
 * 4. when the hold ends, row 0 is the summary row again.
 *
 * The rail is the real `createRailFactory` (through `registerRail`); only the host is a stub, shaped
 * like pi's `setExtensionWidget` / `clearExtensionWidgets` (`interactive-mode.js:1970-2014`). See
 * `tests/e-rail-liveness.test.ts` for the same stub driving the lifecycle wiring.
 */

/** A host shaped like pi's widget surface, plus the raw-terminal-input channel the hold subscribes to. */
function makeHost() {
  const widgets = new Map<string, { render(width?: number): string[]; dispose?(): void }>();
  /** One snapshot per `requestRender()`: what the rail would paint at that instant. */
  const repaints: Array<HoldSurface | undefined> = [];
  let press: ((data: string) => undefined) | undefined;
  /** When true the host refuses to take the rail back (a widget surface that is gone for good). */
  let blockInstall = false;
  let installs = 0;
  const tui = { requestRender: () => repaints.push(holdSurface()) };
  const ui = {
    setStatus: (_key: string, _text: string | undefined) => undefined,
    setWidget(key: string, content: unknown, _options?: unknown) {
      widgets.get(key)?.dispose?.();
      widgets.delete(key);
      if (content === undefined) return;
      if (key === RAIL_WIDGET_KEY && blockInstall) return;
      installs++;
      const component = Array.isArray(content)
        ? { render: () => content as string[] }
        : (content as (tui: unknown, theme: unknown) => { render(width?: number): string[]; dispose?(): void })(
            tui,
            { fg: (_token: string, text: string) => text },
          );
      widgets.set(key, component);
    },
    onTerminalInput: (handler: (data: string) => undefined): (() => void) => {
      press = handler;
      return () => { press = undefined; };
    },
  };
  return {
    ui,
    widgets,
    repaints,
    pressEscape: () => press?.("\x1b"),
    /** Paint exactly what the host would paint for that widget key. */
    render(key: string, width = 120): string[] {
      return widgets.get(key)?.render(width) ?? [];
    },
    /** Everything the user can read right now: both widget slots plus whatever the footer says. */
    screen(footer = ""): string {
      return [...this.render(RAIL_WIDGET_KEY), ...this.render(HOLD_FALLBACK_WIDGET_KEY), footer].join("\n");
    },
    /** A host that drops the rail and will not take it back (the only honest fallback frame). */
    blockRail(on: boolean): void {
      blockInstall = on;
    },
    installs: () => installs,
    /** `resetExtensionUI()`: session invalidation (/new, /resume, /fork) or `/reload`. */
    clearWidgets(): void {
      for (const widget of widgets.values()) widget.dispose?.();
      widgets.clear();
    },
    dispose(): void {
      this.clearWidgets();
    },
  };
}

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

/** The real rail installed into the stub host, exactly the way `registerRail` does it. */
function wire(registry: ReturnType<typeof makeRegistry>) {
  const host = makeHost();
  resetTuiHostForTests();
  resetRailSurfaceForTests();
  bindTuiHost({ mode: "tui", ui: host.ui });
  registerRail({} as never, registry as never);
  return host;
}

/** pi's `on()` contract: returns the unsubscribe. Only `agent_before_settle` is needed here. */
function makePi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    pi: {
      on(event: string, handler: (...args: unknown[]) => unknown): () => void {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {
          const current = handlers.get(event) ?? [];
          const index = current.indexOf(handler);
          if (index >= 0) current.splice(index, 1);
        };
      },
    },
    fire: (ctx: unknown): Promise<unknown> => {
      const handler = (handlers.get("agent_before_settle") ?? [])[0];
      assert.ok(handler, "agent_before_settle is registered");
      return Promise.resolve(handler!({ entries: [] }, ctx));
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spin until `predicate` holds: frame counts must never become a wall-clock race under load. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/** The frozen wording, one source: `waitingRow()` in `src/tui/surfaces.ts`. */
const WAITING_ROW = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] async_wait · running \d+s — Esc stops waiting$/;
/** How often the string appears — §8's "one wait, one line" invariant is decidable this way. */
const occurrences = (text: string): number => text.split("async_wait").length - 1;

afterEach(() => {
  resetRailSurfaceForTests();
  resetTuiHostForTests();
});

test("while a hold waits, the rail's first row is the wait and the three task rows stay", async () => {
  const startedAt = Date.now() - 246_000;
  const tasks = [
    running("t7100001-aaaa-bbbb-cccc-dddddddddddd", "watch-t71", startedAt),
    running("t6z20002-aaaa-bbbb-cccc-dddddddddddd", "watch-t6z2", startedAt),
    running("t7300003-aaaa-bbbb-cccc-dddddddddddd", "watch-t73", startedAt),
  ];
  const registry = makeRegistry(tasks);
  const host = wire(registry);
  const { pi, fire } = makePi();
  registerHold(pi as never, registry as never, { holdMs: 3_000, pollMs: 30 });

  const frames = (): HoldSurface[] => host.repaints.filter((snapshot): snapshot is HoldSurface => snapshot !== undefined);
  const pending = fire({ mode: "tui", ui: host.ui });
  // Wait for the frames themselves: a loaded machine may stretch a 250 ms tick, and the invariant here is
  // "the hold's own elapsed advances while the rail carries the row", not a wall-clock milestone.
  const ticked = await waitUntil(() => new Set(frames().map((snapshot) => snapshot.elapsed)).size >= 2);
  const midHold = host.render(RAIL_WIDGET_KEY);
  const midScreen = host.screen();
  await pending;

  // 1. Row 0 is the wait, carrying the **hold's** elapsed (never a task's).
  assert.equal(RAIL_TASK_SLOTS, 3, "the task slots stay at three: the wait must not eat a task row");
  assert.equal(RAIL_MAX_LINES, 4, "the rail's four-line cap is frozen");
  assert.equal(midHold.length, RAIL_MAX_LINES, `the wait plus three task rows fills the rail (got ${JSON.stringify(midHold)})`);
  assert.match(String(midHold[0]), WAITING_ROW, `row 0 is the waiting row (got: ${midHold[0]})`);
  assert.equal(midHold.filter((row) => row.startsWith("▶")).length, 3, "all three waited tasks keep a row");
  for (const task of tasks) {
    assert.match(
      String(midHold.find((row) => row.includes(task.name)) ?? ""),
      new RegExp(`^▶ ${task.name} · running · \\d+m \\d+s$`),
      `the task row format is unchanged for ${task.name} (got ${JSON.stringify(midHold)})`,
    );
  }

  // 2. The animation really runs: the frame changes and the hold's elapsed advances with it.
  assert.ok(frames().length >= 2, `the hold repainted the rail per frame (got ${frames().length})`);
  assert.ok(new Set(frames().map((snapshot) => snapshot.frame)).size >= 2, "the braille frame changes every 250 ms");
  assert.ok(
    ticked,
    `the hold's elapsed ticks while the rail carries the row (got ${JSON.stringify([...new Set(frames().map((snapshot) => snapshot.elapsed))])})`,
  );

  // 3. Nothing is painted above the editor: the rail is the only place the wait lives.
  assert.deepEqual(host.render(HOLD_FALLBACK_WIDGET_KEY), [], "no separate waiting line while the rail carries it");
  assert.equal(occurrences(midScreen), 1, `the whole screen says it once (got: ${midScreen})`);
});

test("the waiting row displaces the summary row instead of adding a row of its own", async () => {
  const task = running("t4q00001-aaaa-bbbb-cccc-dddddddddddd", "watch-t4q-yamlfix", Date.now() - 64_000);
  const registry = makeRegistry([task]);
  const host = wire(registry);
  const { pi, fire } = makePi();
  registerHold(pi as never, registry as never, { holdMs: 700, pollMs: 30 });

  const pending = fire({ mode: "tui", ui: host.ui });
  await sleep(300);
  const rows = host.render(RAIL_WIDGET_KEY);
  await pending;

  assert.equal(rows.filter((row) => row.startsWith("▶")).length, 1, `only the task row starts with ▶ (got ${JSON.stringify(rows)})`);
  assert.ok(!rows.some((row) => /^▶ \d/.test(row)), `no summary count row while the hold waits (got ${JSON.stringify(rows)})`);
  assert.match(String(rows[0]), WAITING_ROW);
});

test("a host that cannot take the rail back gets the fallback line, and the screen still says it once", async () => {
  const task = running("t4q00001-aaaa-bbbb-cccc-dddddddddddd", "watch-t4q-yamlfix", Date.now() - 64_000);
  const registry = makeRegistry([task]);
  const host = wire(registry);
  const { pi, fire } = makePi();
  registerHold(pi as never, registry as never, { holdMs: 1_600, pollMs: 30 });

  const pending = fire({ mode: "tui", ui: host.ui });
  await sleep(200);
  // Phase A: the rail carries the row.
  assert.match(String(host.render(RAIL_WIDGET_KEY)[0]), WAITING_ROW);
  assert.equal(occurrences(host.screen("waiting for 1 task 0s")), 1, "one wait while the rail carries it");

  // Phase B: the host drops every widget and will not take the rail back — the one frame where the
  // hold's own line is the only waiting row there can be.
  host.blockRail(true);
  host.clearWidgets();
  await sleep(400);
  const fallbackRows = host.render(HOLD_FALLBACK_WIDGET_KEY);
  const screen = host.screen("waiting for 1 task 0s");
  host.blockRail(false);
  await pending;

  assert.ok(fallbackRows.length >= 1, `the hold painted its own line (got ${JSON.stringify(fallbackRows)})`);
  assert.match(
    String(fallbackRows[0]),
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] async_wait · running \d+s — watch-t4q-yamlfix \(running, 1m 4s\) — Esc stops waiting$/,
    "the fallback names the task, because nothing else on screen does",
  );
  assert.equal(occurrences(screen), 1, `still exactly one wait on screen (got: ${screen})`);
});

test("a host with no widget surface at all still names the tasks — in the footer", async () => {
  const task = running("t4q00001-aaaa-bbbb-cccc-dddddddddddd", "watch-t4q-yamlfix", Date.now() - 64_000);
  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    mode: "tui",
    ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) },
  };
  const { pi, fire } = makePi();
  registerHold(pi as never, makeRegistry([task]) as never, { holdMs: 400, pollMs: 25 });

  await fire(ctx);

  const texts = statuses.filter(([key]) => key === "pi-async-hold").map(([, value]) => value);
  assert.equal(texts[0], "waiting for 1 task 0s — watch-t4q-yamlfix (running, 1m 4s)", "§8's last resort: the footer names it");
  assert.equal(texts.at(-1), undefined, "and it is cleared when the hold ends");
});

test("when the hold ends the rail's first row is the summary row again", async () => {
  const task = running("t4q00001-aaaa-bbbb-cccc-dddddddddddd", "watch-t4q-yamlfix", Date.now() - 64_000);
  const registry = makeRegistry([task]);
  const host = wire(registry);
  const { pi, fire } = makePi();
  registerHold(pi as never, registry as never, { holdMs: 900, pollMs: 30 });

  const pending = fire({ mode: "tui", ui: host.ui });
  await sleep(300);
  assert.match(String(host.render(RAIL_WIDGET_KEY)[0]), WAITING_ROW, "the wait is on row 0 while it lasts");
  await pending;

  assert.equal(holdSurface(), undefined, "the hold withdrew its claim in `finally`");
  const rows = host.render(RAIL_WIDGET_KEY);
  assert.ok(String(rows[0]).startsWith("▶ 1 running"), `the summary row is back, unchanged (got: ${rows[0]})`);
  assert.ok(!String(rows[0]).includes("async_wait"), `no waiting text survives the hold (got: ${rows[0]})`);
  assert.equal(occurrences(host.screen("")), 0, "and the hold's fallback slot is empty");
});

test("Esc ends the wait exactly like any other exit: the rail's first row is the summary again", async () => {
  const task = running("t4q00001-aaaa-bbbb-cccc-dddddddddddd", "watch-t4q-yamlfix", Date.now() - 64_000);
  const registry = makeRegistry([task]);
  const host = wire(registry);
  const { pi, fire } = makePi();
  registerHold(pi as never, registry as never, { holdMs: 60_000, pollMs: 5_000 });

  const pending = fire({ mode: "tui", ui: host.ui });
  await sleep(60);
  assert.match(String(host.render(RAIL_WIDGET_KEY)[0]), WAITING_ROW);
  host.pressEscape();
  await pending;

  assert.equal(holdSurface(), undefined);
  assert.ok(!String(host.render(RAIL_WIDGET_KEY)[0]).includes("async_wait"), "Esc hands row 0 back to the summary");
  assert.equal(occurrences(host.screen("")), 0);
});
