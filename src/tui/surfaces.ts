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
 */
export interface RailDetail {
  /** Task ids the rail renders right now, in row order (the same window `render()` paints). */
  taskIds(): string[];
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

/** Test-only: forget both the installation recipe and the mounted widget. */
export function resetRailSurfaceForTests(): void {
  surface = undefined;
  mounted = undefined;
  lastRearmAt = Number.NEGATIVE_INFINITY;
}
