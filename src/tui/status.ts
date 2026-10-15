import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { reportActivity } from "../core/bus.ts";

export function formatStatus(active: { running: number; pending: number }, done: number): string {
  return ` ${active.running + active.pending} running · ${done} done `;
}

let clearedAt = 0;
let refreshCurrent: (() => void) | undefined;
let refreshInterval: ReturnType<typeof setInterval> | undefined;

export function disposeStatus(): void {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = undefined;
  refreshCurrent = undefined;
}

export function clearDoneStatus(): void {
  clearedAt = Date.now();
  refreshCurrent?.();
}

export function initStatus(pi: PiCtx, registry: TaskRegistry): void {
  disposeStatus();
  // SAFETY: ExtensionAPI omits `mode` in some peer typings; runtime TUI entrypoints provide it.
  const host = pi as unknown as { mode?: string; ui?: { setStatus?: (key: string, text: string | undefined) => void } };
  if (host.mode !== "tui") return;
  const refresh = (): void => {
    const active = registry.activeCount();
    const done = registry.list({ includeHistory: true }).filter((task) => task.status === "completed" && (task.finishedAt ?? task.createdAt) >= clearedAt).length;
    host.ui?.setStatus?.("pi-async", formatStatus(active, done));
    reportActivity(pi, active);
  };
  refreshCurrent = refresh;
  refresh();
  // Registry intentionally exposes no event subscription API; keep the footer current without replacing its core events.
  refreshInterval = setInterval(refresh, 1_000);
  refreshInterval.unref?.();
}
