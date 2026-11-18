/**
 * Which TUI surface carries per-task detail (0.4.7, §7.1 修订 7).
 *
 * The rail is the single detail surface: `▶ name · state · elapsed` per task, plus the summary row.
 * The hold row asks *here* whether the rail really lists the tasks it is waiting for, because
 * naming them twice was noise while not naming them at all was a blackout.
 *
 * **0.4.6 was wrong**: it recorded "the rail was registered once" and treated that as "the detail is
 * on screen". Registration is not visibility:
 *
 * - the host disposes and drops every extension widget on `resetExtensionUI()`
 *   (`interactive-mode.js:2030` → `clearExtensionWidgets()` `:2004-2014`), which runs on session
 *   invalidate (`:383`, i.e. `/new`, `/resume`, `/fork`) and on `/reload` (`:5510`);
 * - our own `setWidget` on the same key replaces the component (and disposes the old one);
 * - a mounted factory can still render zero rows (empty / retired registry).
 *
 * So the record is **live**: the mounted widget publishes the task ids it would render right now
 * (`mountRailDetail`), `dispose()` withdraws it, and the hold asks per frame. When no widget is
 * mounted, `ensureRailSurface` re-installs one — the rail heals itself instead of staying dark.
 *
 * §7.1 修订 8 (0.4.8) moves the hold's own row *into* the rail (first row, with the frame/elapsed the
 * hold owns), so the record also carries a `repaint` channel and the hold publishes a `HoldSurface`
 * instead of a widget of its own.
 */
export interface RailDetail {
  /** Task ids the rail renders right now, in row order (the same window `render()` paints). */
  taskIds(): string[];
  /** Ask the host to paint again — the hold's 250 ms frame is faster than the rail's own 1 Hz ticker. */
  repaint?(): void;
}

/** How to (re)install the rail widget — held separately from the widget, which the host may drop. */
export interface RailSurface {
  rearm(): boolean;
}

let surface: RailSurface | undefined;
let mounted: RailDetail | undefined;
let lastRearmAt = Number.NEGATIVE_INFINITY;
/** At most one re-install attempt per second: a host that rejects widgets must not be hammered. */
const REARM_INTERVAL_MS = 1_000;

/**
 * The hold's own contribution to the rail's first row (§7.1 修订 8): one animation frame plus how long
 * *this turn* has been held. Both are formatted already — the rail is a renderer, not a clock.
 */
export interface HoldSurface {
  /** One braille frame of `SPINNER_FRAMES`; it changes every 250 ms while the hold waits. */
  frame: string;
  /** How long this turn has been held, e.g. `2m 28s` (never a task's own elapsed). */
  elapsed: string;
}

let hold: HoldSurface | undefined;

/** Publish (or withdraw, with `undefined`) the hold's waiting row; the rail paints it as row 0. */
export function setHoldSurface(state: HoldSurface | undefined): void {
  hold = state;
}

/** What the hold is waiting with right now; `undefined` once the wait is over. */
export function holdSurface(): HoldSurface | undefined {
  return hold;
}

/**
 * §7.1 修订 8: the **only** place the waiting row's wording is built — the rail's first row and the
 * hold's fallback widget both call this, so the two surfaces can never drift apart, and 0.4.8's
 * "exactly one `async_wait` on screen" invariant is decidable by counting the string.
 *
 * `detail` lists the waited tasks (`name (status, elapsed) · …`) and is only passed when the rail
 * cannot carry them itself. Task rows on the rail never go through here.
 */
export function waitingRow(frame: string, elapsed: string, detail?: string): string {
  const head = `${frame} async_wait · running ${elapsed}`;
  const tail = " — Esc stops waiting";
  const body = typeof detail === "string" && detail.length > 0 ? ` — ${detail}` : "";
  return `${head}${body}${tail}`;
}

/** Repaint the mounted rail through its own request channel; best-effort, never fatal. */
export function railRepaint(): void {
  try {
    mounted?.repaint?.();
  } catch {
    // A stale/disposed host must not take the hold down with it (same rule as every TUI surface).
  }
}

/** Record how to install the rail widget. Called by `registerRail`; the widget itself mounts later. */
export function armRailSurface(rearm: () => boolean): void {
  surface = { rearm };
}

/** Record the widget that is mounted *now*. Called by the rail factory the host invoked. */
export function mountRailDetail(detail: RailDetail): void {
  mounted = detail;
}

/** Withdraw a widget the host disposed. Identity-guarded: a late dispose never unmounts its successor. */
export function unmountRailDetail(detail: RailDetail): void {
  if (mounted === detail) mounted = undefined;
}

/** True while a rail widget the host accepted is still mounted. */
export function railMounted(): boolean {
  return mounted !== undefined;
}

/** Task ids the live rail would paint now; empty when there is no live rail (or it throws). */
export function railTaskIds(): string[] {
  try {
    return mounted?.taskIds() ?? [];
  } catch {
    return [];
  }
}

/**
 * §7.1 修订 7 (the product invariant): the hold may omit task names **only** when the rail is
 * demonstrably listing every task it waits for. Anything else — no widget, a cleared widget, a rail
 * whose window does not cover them — keeps the names in the hold row.
 */
export function railShowsTasks(taskIds: readonly string[]): boolean {
  if (taskIds.length === 0) return false;
  const live = new Set(railTaskIds());
  return taskIds.every((taskId) => live.has(taskId));
}

/**
 * Self-heal: re-install the rail when the host dropped it (dispose observed, or none ever mounted).
 * Throttled, best-effort, and never fatal — a host without `setWidget` simply stays without a rail
 * and the hold keeps naming tasks.
 */
export function ensureRailSurface(now = Date.now()): boolean {
  if (mounted) return true;
  if (!surface) return false;
  if (now - lastRearmAt < REARM_INTERVAL_MS) return false;
  lastRearmAt = now;
  try {
    return surface.rearm();
  } catch {
    return false;
  }
}

/** Test-only: forget the installation recipe, the mounted widget and any published hold surface. */
export function resetRailSurfaceForTests(): void {
  surface = undefined;
  mounted = undefined;
  lastRearmAt = Number.NEGATIVE_INFINITY;
  hold = undefined;
}
