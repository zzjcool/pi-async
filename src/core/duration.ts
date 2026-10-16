import type { TaskSnapshot } from "./task.ts";

/**
 * Format a task's elapsed duration for TUI surfaces.
 * - pending → em dash (not started)
 * - end base = finishedAt ?? now (terminal states freeze; live tasks tick)
 * - three tiers: Ns / Mm Ss / Hh Mm
 */
export function formatDuration(task: TaskSnapshot, now: number): string {
  if (task.status === "pending") return "—";
  const end = task.finishedAt ?? now;
  const seconds = Math.floor(Math.max(0, end - (task.startedAt ?? task.createdAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
