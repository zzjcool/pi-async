export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";
export type TaskMode = "background" | "sync" | "delayed";
export type KillKind = "user" | "timeout" | "output_cap" | "shutdown" | "watch_failure";
export type FailureKind = "lost" | "blind_exhausted" | "watch_timeout";

export const TERMINAL_STATUSES = ["completed", "failed", "killed"] as const satisfies readonly TaskStatus[];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number]);
}

/** Derive a concise, single-line display name from a shell command. */
export function deriveName(command: string): string {
  const normalized = command.split(/\r?\n/, 1)[0]?.trim().replace(/\s+/g, " ") ?? "";
  if (normalized.length === 0) return "async task";
  const characters = Array.from(normalized);
  return characters.length <= 48 ? normalized : characters.slice(0, 47).join("") + "…";
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

export type WaitOutcome =
  | { results: Array<{ taskId: string; status: TaskStatus; exitCode?: number; outputTail: string; killKind?: KillKind; failureKind?: FailureKind }> }
  | { notReady: Array<{ taskId: string; status: "running" | "pending"; elapsedMs: number }> };

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
