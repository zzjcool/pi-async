import type { PiCtx } from "./notify.ts";

/** Report aggregate async work through Pi's activity API when the host exposes it. */
export function reportActivity(pi: PiCtx, active: { running: number; pending: number }): void {
  // SAFETY: PiCtx is the installed extension API; ui.setActivity is feature-detected for versions without it.
  const ui = (pi as unknown as { ui?: { setActivity?: (id: string, activity: { message: string } | undefined) => void } }).ui;
  if (typeof ui?.setActivity !== "function") return;
  const count = active.running + active.pending;
  ui.setActivity("pi-async", count === 0 ? undefined : { message: `${count} async tasks` });
  // Activity uses the host API; never emit terminal OSC/printf escapes. In particular,
  // leave PI_PROGRAM_STATUS untouched for hosts which own that status channel.
}

/** Raise task-scoped activity when the host supports Pi's optional activity API. */
export function raiseTaskActivity(pi: PiCtx, taskId: string, message = "Async task running"): void {
  // SAFETY: PiCtx is the installed extension API; ui.setActivity is feature-detected for versions without it.
  const ui = (pi as unknown as { ui?: { setActivity?: (id: string, activity: { message: string } | undefined) => void } }).ui;
  if (typeof ui?.setActivity !== "function") return;
  ui.setActivity(`pi-async/${taskId}`, { message });
}

/** Clear task-scoped activity when the host supports Pi's optional activity API. */
export function clearTaskActivity(pi: PiCtx, taskId: string): void {
  // SAFETY: PiCtx is the installed extension API; ui.setActivity is feature-detected for versions without it.
  const ui = (pi as unknown as { ui?: { setActivity?: (id: string, activity: { message: string } | undefined) => void } }).ui;
  if (typeof ui?.setActivity !== "function") return;
  ui.setActivity(`pi-async/${taskId}`, undefined);
}
