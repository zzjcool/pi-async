import type { PiCtx } from "./notify.ts";

/**
 * Host activity shim (CONTRACT §7). `ui.setActivity` is write-only and feature-detected: callers cannot
 * read the value back, absence of activity is not evidence of idleness, and pi 1.2–1.5 does not expose
 * the API at all. Never use activity as a work-in-flight signal.
 */

/** Aggregate activity source id (frozen §7). */
const AGGREGATE_ACTIVITY_ID = "pi-async";

/** Per-task activity id — legion #156 / osc-busy-plugin: `plugin/<name>/…`. */
export function taskActivityId(taskId: string): string {
  return `plugin/pi-async/${taskId}`;
}

/**
 * Report aggregate async work through Pi's activity API when the host exposes it.
 *
 * Returns `false` only when the host rejected the call (a stale ctx throws on `pi.ui` or
 * `setActivity`); callers may use that signal to detach a dead generation. A host without the API
 * returns `true` — nothing failed, there is just nothing to report. The throw is swallowed here so
 * a best-effort activity write can never decide a settle boundary (0.3.2 stale-ctx fix).
 */
export function reportActivity(pi: PiCtx, active: { running: number; pending: number }): boolean {
  try {
    // SAFETY: PiCtx is the installed extension API; ui.setActivity is feature-detected for versions without it.
    const ui = (pi as unknown as { ui?: { setActivity?: (id: string, activity: { message: string } | undefined) => void } }).ui;
    if (typeof ui?.setActivity !== "function") return true;
    const count = active.running + active.pending;
    ui.setActivity(AGGREGATE_ACTIVITY_ID, count === 0 ? undefined : { message: `${count} async tasks` });
    // Activity uses the host API; never emit terminal OSC/printf escapes. In particular,
    // leave PI_PROGRAM_STATUS untouched for hosts which own that status channel.
    return true;
  } catch {
    return false;
  }
}

/** Raise task-scoped activity when the host supports Pi's optional activity API. */
export function raiseTaskActivity(pi: PiCtx, taskId: string, message = "Async task running"): void {
  // SAFETY: PiCtx is the installed extension API; ui.setActivity is feature-detected for versions without it.
  const ui = (pi as unknown as { ui?: { setActivity?: (id: string, activity: { message: string } | undefined) => void } }).ui;
  if (typeof ui?.setActivity !== "function") return;
  ui.setActivity(taskActivityId(taskId), { message });
}

/** Clear task-scoped activity when the host supports Pi's optional activity API. */
export function clearTaskActivity(pi: PiCtx, taskId: string): void {
  // SAFETY: PiCtx is the installed extension API; ui.setActivity is feature-detected for versions without it.
  const ui = (pi as unknown as { ui?: { setActivity?: (id: string, activity: { message: string } | undefined) => void } }).ui;
  if (typeof ui?.setActivity !== "function") return;
  ui.setActivity(taskActivityId(taskId), undefined);
}
