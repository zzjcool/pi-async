export const TASK_STATUSES = ["pending", "running", "completed", "failed", "killed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskMode = "background" | "delayed";
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
  taskTimeoutMs?: number;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  /** 0.4.0 (REV-23): running-time ms before the first reminder; 0 disables; omitted → CONTRACT §18.2 default. */
  remindAfterMs?: number;
  env?: Record<string, string>;
  watch?: WatchSpec;
  /** 0.3.0: directory the task runs in; defaults to the registry/session cwd, then process.cwd(). */
  cwd?: string;
}

export interface RunReceipt {
  taskId: string;
  name: string;
  status: TaskStatus;
  mode: TaskMode;
  outputHint: string;
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
  // 0.3.0 additions (all optional so pre-0.3.0 snapshots stay readable).
  /** Working directory the task executes in (REV-13). */
  cwd?: string;
  /** Absolute deadline for `taskTimeoutMs` (reload re-arms the remaining time). */
  timeoutAt?: number;
  /** Absolute deadline for the watch window (reload restores the remaining budget). */
  watchDeadline?: number;
  /** Number of completion-notification attempts so far (honesty accounting, no retries). */
  notifyAttempts?: number;
  /** Absolute time of the next runtime reminder (REV-23 / CONTRACT §18.8); absent = no reminder pending. */
  remindAt?: number;
  /** Reminders delivered so far; capped at 3, reset by `async_extend` (REV-23 / §18.4). */
  remindCount?: number;
  /**
   * D-07 (#116 / CONTRACT §27 REV-35): what the snapshot may honestly claim about the process.
   *
   * `false` = the exit was **observed**; `null` = nothing was observed (the snapshot does not know);
   * absent = no claim at all (a live snapshot, or a pre-0.5.4 snapshot that never wrote it).
   * `null` is written explicitly so it can never be confused with "this old snapshot has no field".
   */
  processAlive?: boolean | null;
  /**
   * D-07 (#116): `true` **only** when `processAlive` is the conclusion of an observation, never a
   * default. Read `processAlive` alone and a pre-0.5.4 `false` (written unconditionally by
   * `finalize()`) looks like evidence — this flag is what tells the two apart.
   */
  processAliveKnown?: boolean;
  /**
   * D-07 (#116): the child's exit status. A number = observed; `null` = not observed (never "exit 0");
   * absent = no claim yet (a running snapshot).
   */
  exitCode?: number | null;
  /** D-07 (#116): `true` only when `exitCode` is an observed number. */
  exitCodeKnown?: boolean;
  /**
   * 0.5.3 (#113 / REV-34): how many `output_matches` evaluations exceeded the 25 ms budget.
   * An over-budget round is treated as **not matched** — never a failure, never a kill. Only
   * increases, and it stays readable on a terminal snapshot.
   */
  matchBudgetExceeded?: number;
  /**
   * 0.4.3 (CONTRACT §7.2): the terminal state was already handed to the model by a tool that
   * returned it (`async_wait` / `async_status` / `async_logs`). One terminal event is told once, to
   * exactly one consumer — a consumed task never produces a completion notification.
   */
  consumedAt?: number;
}

/**
 * D-07 (#116 / CONTRACT §27 REV-35): what a snapshot may claim about its process.
 *
 * `alive` / `exited` / `unknown` — and `unknown` is a real answer, not a failure to answer.
 *
 * The gate is `processAliveKnown`, **never** `processAlive` alone: 0.5.3 and earlier wrote
 * `processAlive: false` unconditionally in `finalize()`, so a `false` without the flag is a default,
 * not an observation. Old snapshots therefore read as `unknown` — no migration, no inference.
 */
export type ProcessLiveness = "alive" | "exited" | "unknown";

export function snapshotLiveness(task: Pick<TaskSnapshot, "processAlive" | "processAliveKnown">): ProcessLiveness {
  if (task.processAliveKnown !== true) return "unknown";
  if (task.processAlive === false) return "exited";
  if (task.processAlive === true) return "alive";
  return "unknown";
}

/**
 * D-07 (#116): `true` only when the snapshot carries an observed exit status.
 *
 * A legacy snapshot carries a number without `exitCodeKnown`; that number is still evidence (the old
 * code only ever wrote it from an observed exit), so it counts as observed. The asymmetric rule is
 * deliberate: `processAlive: false` was a **default**, `exitCode: <number>` was never one.
 */
export function hasObservedExitCode(task: Pick<TaskSnapshot, "exitCode" | "exitCodeKnown">): boolean {
  if (task.exitCodeKnown === false) return false;
  return typeof task.exitCode === "number";
}

/** D-07 (#116): `exit 7` / `exit unknown` — the one wording for every result line and detail view. */
export function formatExitStatus(exitCode: number | null | undefined): string {
  return typeof exitCode === "number" ? `exit ${exitCode}` : "exit unknown";
}

/**
 * D-07 (#116): `, exit 7` / `, exit unknown` for the settlement result lines (hold, `pi -p` backstop).
 *
 * Both callers render **terminal** rows only, so a missing field is a 0.5.3 snapshot that could not
 * write one — that is "unknown" too (`exitSuffix` never says nothing about a finished task).
 */
export function exitSuffix(exitCode: number | null | undefined): string {
  return `, ${formatExitStatus(exitCode)}`;
}
