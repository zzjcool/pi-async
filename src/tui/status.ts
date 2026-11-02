import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";
import { reportActivity } from "../core/bus.ts";
import { envNumber } from "../core/env.ts";
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

const TERMINAL = new Set(["completed", "failed", "killed"]);

/** Terminal-task linger window on the rail, overridable for tests. */
export function railLingerMs(): number {
  return envNumber("PI_ASYNC_RAIL_LINGER_MS", 30_000, { integer: true, min: 0 });
}

/**
 * The single rail visibility window: live tasks always show, terminal tasks linger.
 * Rows and summary counts both go through this predicate so `✓N` can never show a
 * number without a matching row (0.3.0 §2.9).
 */
export function inRailWindow(
  task: { status: string; createdAt: number; startedAt?: number; finishedAt?: number },
  now = Date.now(),
  lingerMs = railLingerMs(),
): boolean {
  if (task.status === "running" || task.status === "pending") return true;
  return now - (task.finishedAt ?? task.startedAt ?? task.createdAt) < lingerMs;
}

/** Counts drawn from exactly the rows the rail renders (same linger window + clear watermark). */
export function railWindowCounts(tasks: TaskSnapshot[], now = Date.now(), lingerMs = railLingerMs()): SummaryCounts {
  const window = tasks.filter((task) => inRailWindow(task, now, lingerMs));
  const running = window.filter((task) => task.status === "running");
  const pending = window.filter((task) => task.status === "pending").length;
  const terminal = window.filter((task) => TERMINAL.has(task.status) && survivesClearCutoff(task));
  return {
    running: running.length,
    pending,
    completed: terminal.filter((task) => task.status === "completed").length,
    failed: terminal.filter((task) => task.status === "failed" || task.status === "killed").length,
    ...(running.length ? { longestRunningStartedAt: Math.min(...running.map((task) => task.startedAt ?? task.createdAt)) } : {}),
  };
}

/** Opt-in single-line footer (`PI_ASYNC_FOOTER=1`); the rail is the default status surface. */
export function footerEnabled(): boolean {
  return process.env.PI_ASYNC_FOOTER === "1";
}

/** Publish the summary line when the footer is opted in; no timers, callers drive it. */
export function refreshFooter(registry: TaskRegistry, now = Date.now()): void {
  if (!footerEnabled()) return;
  const ui = tuiHost()?.ui as { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  if (typeof ui?.setStatus !== "function") return;
  try {
    ui.setStatus("pi-async", formatSummary(railWindowCounts(registry.list({ includeHistory: true }), now)));
  } catch {
    // Status rendering is best-effort: a host that rejects setStatus must not break the session.
  }
}

export function initStatus(pi: PiCtx, registry: TaskRegistry): void {
  if (!tuiHost()) return;
  reportActivity(pi, registry.activeCount());
  refreshFooter(registry);
}
