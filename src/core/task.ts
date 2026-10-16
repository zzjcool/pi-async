export const TASK_STATUSES = ["pending", "running", "completed", "failed", "killed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskMode = "background" | "sync" | "delayed";
export type KillKind = "user" | "timeout" | "output_cap" | "shutdown" | "watch_failure";
export type FailureKind = "lost" | "blind_exhausted" | "watch_timeout";

export const TERMINAL_STATUSES = ["completed", "failed", "killed"] as const satisfies readonly TaskStatus[];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number]);
}

/** Cap a task name at `limit` Unicode code points without splitting surrogate pairs (#28). */
export function capName(name: string, limit = 48): string {
  const characters = Array.from(name);
  return characters.length <= limit ? name : characters.slice(0, limit - 1).join("") + "…";
}

/** Derive a concise, single-line display name from a shell command.
 *  Uses the first non-blank line so a leading newline does not collapse to the fallback (#23). */
export function deriveName(command: string): string {
  const firstContentLine = command.split(/\r?\n/).find((line) => line.trim().length > 0);
  const normalized = firstContentLine?.trim().replace(/\s+/g, " ") ?? "";
  if (normalized.length === 0) return "async task";
  return capName(normalized);
}

export type Condition =
  | { type: "exit_code"; equals: number }
  | { type: "stdout_contains"; value: string }
  | { type: "stderr_contains"; value: string }
  | { type: "json_path_exists"; path: string }
  | { type: "output_matches"; regex: string };

export interface WatchSpec {
  intervalMs: number;
  timeoutMs: number;
  success_when: Condition[];
  failure_when: Condition[];
  blind_checks?: number;
}

export interface RunOptions {
  command: string;
  name?: string;
  mode?: TaskMode;
  delayMs?: number;
  timeoutMs?: number;
  onTimeout?: "promote" | "abort";
  taskTimeoutMs?: number;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  env?: Record<string, string>;
  watch?: WatchSpec;
}

export interface RunReceipt {
  taskId: string;
  name: string;
  status: TaskStatus;
  mode: TaskMode;
  outputHint: string;
}

export interface SyncResult extends RunReceipt {
  exitCode?: number;
  outputTail: string;
  promoted: boolean;
}

export type WaitResultItem = { taskId: string; status: TaskStatus; exitCode?: number; outputTail: string; killKind?: KillKind; failureKind?: FailureKind };
export type WaitNotReadyItem = { taskId: string; status: "running" | "pending"; elapsedMs: number };
/** All-terminal → { results }; timeout-only → { notReady }; mixed timeout → { results, notReady } (REV-7 / #43 + #37 kinds). */
export type WaitOutcome =
  | { results: WaitResultItem[] }
  | { notReady: WaitNotReadyItem[] }
  | { results: WaitResultItem[]; notReady: WaitNotReadyItem[] };

export interface TaskSnapshot {
  taskId: string;
  name: string;
  command: string;
  mode: TaskMode;
  status: TaskStatus;
  pid?: number;
  exitCode?: number;
  killKind?: KillKind;
  failureKind?: FailureKind;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  dueAt?: number;
  taskTimeoutMs?: number;
  notified: boolean;
  outputConsumed: boolean;
  watch?: WatchSpec;
  metadata: Record<string, unknown>;
}
