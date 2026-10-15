import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { reportActivity } from "../core/bus.ts";
import { tuiHost } from "./host.ts";

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
  // TUI surfaces bind from event contexts; the factory API has no mode/ui.
  const bound = tuiHost();
  if (!bound) return;
  const setStatus = bound.ui["setStatus"] as ((key: string, text: string | undefined) => void) | undefined;
  const refresh = (): void => {
    const active = registry.activeCount();
    const done = registry.list({ includeHistory: true }).filter((task) => task.status === "completed" && (task.finishedAt ?? task.createdAt) >= clearedAt).length;
    setStatus?.("pi-async", formatStatus(active, done));
    reportActivity(pi, active);
  };
  refreshCurrent = refresh;
  refresh();
  // Registry intentionally exposes no event subscription API; keep the footer current without replacing its core events.
  refreshInterval = setInterval(refresh, 1_000);
  refreshInterval.unref?.();
}
