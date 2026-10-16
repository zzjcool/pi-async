import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { reportActivity } from "../core/bus.ts";
import { formatElapsedMs } from "../core/duration.ts";
import { tuiHost } from "./host.ts";

export interface SummaryCounts {
  running: number;
  pending: number;
  completed: number;
  failed: number;
  longestRunningStartedAt?: number;
}

export type SummaryToken = "accent" | "dim" | "success" | "error";
export interface SummarySegment { text: string; token: SummaryToken }

export function summarySegments(c: SummaryCounts, now = Date.now()): SummarySegment[] {
  const elapsed = c.running > 0 && c.longestRunningStartedAt !== undefined
    ? formatElapsedMs(now - c.longestRunningStartedAt)
    : "—";
  return [
    { text: "▶", token: c.running + c.pending > 0 ? "accent" : "dim" },
    { text: ` ${c.running} running`, token: "accent" },
    ...(c.pending > 0 ? [{ text: ` · ${c.pending} pending`, token: "dim" as const }] : []),
    { text: ` · ${elapsed}`, token: "dim" },
    // ✓ and ✗ are symmetric: both only appear when non-zero, so an all-failed run shows no green 0.
    ...(c.completed > 0 ? [{ text: ` · ✓${c.completed}`, token: "success" as const }] : []),
    ...(c.failed > 0 ? [{ text: ` · ✗${c.failed}`, token: "error" as const }] : []),
  ];
}

export function formatSummary(c: SummaryCounts, now = Date.now()): string {
  return summarySegments(c, now).map((segment) => segment.text).join("");
}

let clearedAt = 0;

/** Shared /async-clear watermark used by footer and panel (#31). */
export function clearedAtMs(): number {
  return clearedAt;
}

/**
 * Shared clear predicate: running/pending always visible; otherwise compare
 * finishedAt ?? createdAt against the watermark (footer semantics).
 */
export function survivesClearCutoff(
  task: { status: string; createdAt: number; finishedAt?: number },
  cutoffMs: number = clearedAt,
): boolean {
  if (task.status === "running" || task.status === "pending") return true;
  return (task.finishedAt ?? task.createdAt) >= cutoffMs;
}

export function clearDoneStatus(): void {
  clearedAt = Date.now();
}

export function initStatus(pi: PiCtx, registry: TaskRegistry): void {
  if (!tuiHost()) return;
  reportActivity(pi, registry.activeCount());
}
