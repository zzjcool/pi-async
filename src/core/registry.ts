import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { killTree, spawnDetached, streamPaths } from "./spawn.ts";
import { stripLogControls, truncateUtf8Bytes } from "./output.ts";
import { assertSafeEnvKeys, envNumber } from "./env.ts";
import { capName, deriveName, isTaskStatus, isTerminal, type FailureKind, type KillKind, type RunOptions, type SyncResult, type TaskMode, type TaskSnapshot, type TaskStatus, type WatchSpec, type WaitOutcome } from "./task.ts";
import { evalConditions, validateWatchSpec, WatchLoop, type WatchOutput } from "./watch.ts";

export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;
  onStateChange(snapshot: TaskSnapshot): void;
}
export interface RegistryConfig { dataDir: string; cwd?: string; maxTasks?: number; maxOutputBytes?: number; retentionMs?: number; retentionCount?: number; }
export interface ListOptions { includeHistory?: boolean; status?: TaskStatus | "active"; name?: string; limit?: number; }
export type LogStream = "merged" | "stdout" | "stderr";
export interface LogSlice { text: string; truncated: boolean; fullPath: string; missing?: boolean; }

/** Registry fan-out event (REV-14/TUI refresh): `state` for every mutation, `finalize` once per terminal transition. */
export type RegistryEvent =
  | { type: "state"; snapshot: TaskSnapshot }
  | { type: "finalize"; snapshot: TaskSnapshot };

interface LiveTask { outputFile: string; exit?: Promise<{ code: number }>; timer?: ReturnType<typeof setTimeout>; delayTimer?: ReturnType<typeof setTimeout>; watcher?: ReturnType<typeof setInterval>; killKind?: KillKind; processExited?: boolean; }
interface Waiter { ids: Set<string>; resolve: () => void; }
const DEFAULT_MAX_OUTPUT = 20 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_COUNT = 100;
const MAX_LIST_LIMIT = 50;
const DEFAULT_RESEND_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESEND_MAX_ATTEMPTS = 2;
/** Default read window for `logs`; callers (tools/TUI) own the policy above this. */
const DEFAULT_LOG_BYTES = 50 * 1024;
/** Defensive ceiling for a single `logs` read: an accidental huge window is clamped, not honoured. */
const MAX_LOG_WINDOW = 8 * 1024 * 1024;
/** Artifacts owned by one task; migrated wholesale between data dirs. */
const ARTIFACT_SUFFIXES = [".json", ".output", ".stdout", ".stderr"] as const;

/** Read `length` bytes at `start`, tolerating short reads from a partially written file. */
function readExactly(handle: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const got = readSync(handle, buffer, read, length - read, start + read);
    if (got <= 0) break;
    read += got;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

/** UTF-8-safe decode of an already bounded window; mirrors `truncateUtf8Bytes` without the whole file. */
function truncateUtf8Window(buffer: Buffer, maxBytes: number, tail: boolean, truncated: boolean): string {
  if (!truncated) return buffer.toString("utf8");
  if (tail) {
    let start = 0;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
    return buffer.subarray(start).toString("utf8");
  }
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly live = new Map<string, LiveTask>();
  private readonly waiters = new Set<Waiter>();
  private readonly notifyClaims = new Set<string>();
  private readonly watchLoops = new Map<string, WatchLoop>();
  private readonly listeners = new Set<(event: RegistryEvent) => void>();
  private events: RegistryEvents = { onFinalize: () => undefined, onStateChange: () => undefined };
  private readonly maxTasks: number;
  private readonly maxOutputBytes: number;
  private readonly retentionMs: number;
  private readonly retentionCount: number;
  private config: RegistryConfig;
  private closed = false;
  /** Set by `suspend()`: this generation is retired and must not settle adopted work (REV-17). */
  private suspended = false;
  private reloading = false;
  private shutdownPromise?: Promise<void>;
  private configured = false;
  private dataDirReady = false;

  constructor(config: RegistryConfig) {
    // NOTE (D-04): the constructor no longer creates the data dir — the factory must stay
    // side-effect free. `persist()` and `configure()` create it on demand.
    this.config = { ...config };
    this.maxTasks = config.maxTasks ?? envNumber("PI_ASYNC_MAX_TASKS", 32, { integer: true, min: 1 });
    this.maxOutputBytes = config.maxOutputBytes ?? envNumber("PI_ASYNC_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT, { integer: true, min: 0 });
    this.retentionMs = config.retentionMs ?? envNumber("PI_ASYNC_RETENTION_MS", DEFAULT_RETENTION_MS, { integer: true, min: 0 });
    this.retentionCount = config.retentionCount ?? envNumber("PI_ASYNC_RETENTION_COUNT", DEFAULT_RETENTION_COUNT, { integer: true, min: 0 });
  }

  setEvents(events: RegistryEvents): void { this.events = events; }

  /** Subscribe to registry state/finalize events; returns an unsubscribe function. */
  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Session-scoped configuration (REV-13/REV-17). Idempotent.
   *
   * First call switches this registry to the session data dir + cwd and loads persisted
   * tasks. Later calls only react to changes; a data-dir change migrates task artifacts
   * instead of dropping them. Migration failures keep the old dir and never throw (D-05):
   * this runs inside a `session_start` handler where a throw becomes extension noise.
   */
  configure(opts: { dataDir?: string; cwd?: string }): void {
    const first = !this.configured;
    this.configured = true;
    if (opts.cwd !== undefined && opts.cwd.length > 0) this.config = { ...this.config, cwd: opts.cwd };
    const nextDataDir = opts.dataDir;
    const changed = nextDataDir !== undefined && nextDataDir !== this.config.dataDir;
    if (changed) {
      if (this.tasks.size > 0) {
        if (!this.migrateDataDir(nextDataDir)) {
          this.ensureDataDirQuietly();
          if (first) {
            void this.reloadFromDisk();
            this.reapOrphans();
          }
          return;
        }
      } else {
        this.switchDataDir(nextDataDir);
      }
    }
    // D-04: the session data dir is created here or on first persist — never in the constructor.
    this.ensureDataDirQuietly();
    if (first || changed) {
      // reloadFromDisk() has no await points, so it is fully applied when it returns; reaping
      // keeps this generation from adopting snapshots whose processes are already gone (#44).
      void this.reloadFromDisk();
      this.reapOrphans();
    }
  }

  submit(opts: RunOptions): TaskSnapshot {
    if (opts.mode && opts.mode !== "background") throw new Error("submit only accepts background mode");
    return this.createAndStart(opts, "background");
  }

  scheduleDelayed(opts: RunOptions, delayMs: number): TaskSnapshot {
    // Fail fast: delayed tasks spawn later, so dangerous env overrides must be rejected at submit
    // time exactly like background/sync (spawnDetached would otherwise only fail at due time).
    assertSafeEnvKeys(opts.env, "safe");
    this.assertAdmission(opts);
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must be a non-negative finite number");
    this.validateRunWatch(opts, "delayed");
    const createdAt = Date.now();
    const taskId = randomUUID();
    const outputFile = join(this.config.dataDir, `${taskId}.output`);
    const task: TaskSnapshot = {
      taskId, name: opts.name ? capName(opts.name) : deriveName(opts.command), command: opts.command, mode: "delayed", status: "pending",
      createdAt, dueAt: createdAt + delayMs, taskTimeoutMs: opts.taskTimeoutMs, notified: false, outputConsumed: false,
      cwd: opts.cwd ?? this.config.cwd ?? process.cwd(),
      ...(opts.watch ? { watch: opts.watch } : {}),
      metadata: { notifyOnCompletion: opts.notifyOnCompletion ?? true, triggerOnCompletion: opts.triggerOnCompletion ?? true, outputFile, ...(opts.env ? { delayedEnv: opts.env } : {}) },
    };
    this.tasks.set(taskId, task);
    const live: LiveTask = { outputFile };
    this.live.set(taskId, live);
    this.persist(task);
    this.emitState(task);
    if (opts.watch) this.attachWatch(taskId, opts.watch);
    this.scheduleDelayedStart(task, Math.max(0, (task.dueAt ?? createdAt) - Date.now()));
    return task;
  }

  async runSync(opts: RunOptions, timeoutMs: number, onTimeout: "promote" | "abort", signal?: AbortSignal): Promise<SyncResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative finite number");
    this.validateRunWatch(opts, "sync");
    const task = this.createAndStart(opts, "sync");
    let promoted = false;
    try {
      const outcome = await this.wait([task.taskId], timeoutMs, signal);
      // Timeout / Esc: stop waiting. promote → background + promoted flag; abort → Esc semantics
      // (keep process, bookkeeping mode becomes background so the receipt is not "sync+running").
      if ("notReady" in outcome && !isTerminal(task.status)) {
        task.mode = "background";
        if (onTimeout === "promote") promoted = true;
        this.emitState(task);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
      if (!isTerminal(task.status) && task.mode === "sync") {
        task.mode = "background";
        this.emitState(task);
      }
    }
    return this.syncResult(task, promoted);
  }

  /**
   * Resolve a user-supplied task reference. Ids win; otherwise an exact (case-insensitive)
   * name is required, and duplicate names are an error listing candidate ids (REV-15).
   */
  resolveTaskId(idOrName: string): TaskSnapshot {
    const direct = this.tasks.get(idOrName);
    if (direct) return direct;
    const needle = idOrName.trim().toLowerCase();
    const matches = needle.length === 0 ? [] : [...this.tasks.values()].filter((task) => task.name.toLowerCase() === needle);
    const [match] = matches;
    if (match && matches.length === 1) return match;
    if (matches.length > 1) {
      throw new Error(`Ambiguous task name "${idOrName}": matches ${matches.map((task) => task.taskId).join(", ")}`);
    }
    throw new Error(`Unknown task or name: ${idOrName}`);
  }

  attachWatch(taskId: string, spec: WatchSpec, deadline?: number): void {
    const validation = validateWatchSpec(spec);
    if (!validation.ok) throw new Error(`Invalid watch spec: ${validation.error}`);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    if (isTerminal(task.status)) throw new Error(`Cannot attach watch to terminal task ${taskId}`);
    const existing = this.watchLoops.get(taskId);
    existing?.stop();
    const now = Date.now();
    // Persist the absolute watch deadline so a reload can restore the remaining budget (D-03).
    // Pending delayed tasks get their deadline when the task actually starts (startTask).
    if (deadline !== undefined) task.watchDeadline = deadline;
    else if (task.status === "running") task.watchDeadline = now + spec.timeoutMs;
    else delete task.watchDeadline;
    // The loop only understands relative timeouts; feed it the remaining budget without
    // rewriting the user-visible spec (`task.watch.timeoutMs` stays the original value).
    const loopSpec: WatchSpec = task.watchDeadline === undefined ? spec : { ...spec, timeoutMs: Math.max(1, task.watchDeadline - now) };
    const loop = new WatchLoop({
      taskId, spec: loopSpec,
      readOutput: () => this.readWatchOutput(taskId),
      getExitCode: () => this.tasks.get(taskId)?.exitCode,
      onSuccess: (detail) => this.markWatchSuccess(taskId, detail),
      onFailure: () => { void this.kill(taskId, "watch_failure").catch((error: unknown) => console.error(`pi-async: watch failure kill failed for task ${taskId}`, error)); },
      onBlindExhausted: () => {
        const current = this.tasks.get(taskId);
        if (current && !isTerminal(current.status)) {
          current.failureKind = "blind_exhausted";
          this.finalize(current, "failed", undefined, "watch_failure");
          void this.kill(taskId, "watch_failure").catch((error: unknown) => console.error(`pi-async: blind-check kill failed for task ${taskId}`, error));
        }
      },
      onWatchTimeout: () => {
        const current = this.tasks.get(taskId);
        if (current && !isTerminal(current.status)) {
          current.failureKind = "watch_timeout";
          this.finalize(current, "failed", undefined, "watch_failure");
          void this.kill(taskId, "watch_failure").catch((error: unknown) => console.error(`pi-async: watch-timeout kill failed for task ${taskId}`, error));
        }
      },
    });
    this.watchLoops.set(taskId, loop);
    this.persist(task);
    if (task.status === "running") loop.start();
  }
  private assertAdmission(opts: RunOptions): void {
    if (this.closed) throw new Error("Async task admission is closed");
    // A retired generation must not start work: the next generation owns the session data dir.
    if (this.suspended) throw new Error("Async task admission is closed (registry suspended)");
    const active = this.activeCount();
    if (active.running + active.pending >= this.maxTasks) throw new Error(`Maximum active async tasks reached (${this.maxTasks})`);
    if (!opts.command.trim()) throw new Error("command must not be empty");
  }

  private validateRunWatch(opts: RunOptions, mode: TaskMode): void {
    if (!opts.watch) return;
    if (mode === "sync") throw new Error("watch is only supported for background and delayed modes");
    const result = validateWatchSpec(opts.watch);
    if (!result.ok) throw new Error(`Invalid watch spec: ${result.error}`);
  }

  private createAndStart(opts: RunOptions, mode: "background" | "sync"): TaskSnapshot {
    this.assertAdmission(opts);
    this.validateRunWatch(opts, mode);
    const taskId = randomUUID();
    const outputFile = join(this.config.dataDir, `${taskId}.output`);
    const task: TaskSnapshot = {
      taskId, name: opts.name ? capName(opts.name) : deriveName(opts.command), command: opts.command, mode, status: "running",
      createdAt: Date.now(), startedAt: Date.now(), taskTimeoutMs: opts.taskTimeoutMs, notified: false, outputConsumed: false,
      ...(opts.watch ? { watch: opts.watch } : {}),
      metadata: { notifyOnCompletion: opts.notifyOnCompletion ?? true, triggerOnCompletion: opts.triggerOnCompletion ?? true, outputFile },
    };
    this.tasks.set(taskId, task);
    this.live.set(taskId, { outputFile });
    try {
      this.startTask(task, opts);
      if (opts.watch) this.attachWatch(taskId, opts.watch);
    } catch (error) {
      this.live.delete(taskId);
      this.tasks.delete(taskId);
      throw error;
    }
    return task;
  }

  private startTask(task: TaskSnapshot, opts: RunOptions): void {
    const live = this.live.get(task.taskId)!;
    if (live.delayTimer) { clearTimeout(live.delayTimer); live.delayTimer = undefined; }
    task.status = "running";
    task.startedAt = Date.now();
    // REV-13: always run in the resolved session cwd, never the host process cwd.
    task.cwd = opts.cwd ?? this.config.cwd ?? process.cwd();
    if (task.watch) task.watchDeadline = Date.now() + task.watch.timeoutMs;
    const handle = spawnDetached(task.command, {
      outputFile: live.outputFile,
      env: { ...opts.env, PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES: String(this.maxOutputBytes) },
      cwd: task.cwd,
    });
    task.pid = handle.pid;
    live.exit = handle.exit.then(({ code }) => {
      // A retired generation no longer owns this process: the next generation adopted it via
      // reloadFromDisk and its snapshot wins (no finalize, no persist, no emit).
      if (this.suspended) return { code };
      live.processExited = true;
      if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
      task.exitCode = code;
      task.metadata.capped = this.isOutputCapped(task);
      if (task.metadata.capped || task.metadata.watchSuccess !== undefined) this.persist(task);
      if (!isTerminal(task.status) && task.watch) {
        try {
          const streams = this.readWatchOutput(task.taskId);
          if (evalConditions(task.watch.failure_when, { ...streams, exitCode: code })) this.finalize(task, "killed", undefined, "watch_failure");
          else if (evalConditions(task.watch.success_when, { ...streams, exitCode: code })) {
            task.metadata.watchSuccess = `success_when matched after process exit: ${JSON.stringify(task.watch.success_when)}`;
            this.finalize(task, "completed", code);
          }
        } catch { /* WatchLoop owns infrastructure-failure accounting while active. */ }
      }
      if (!isTerminal(task.status)) {
        if (live.killKind === "shutdown" || live.killKind === "user" || live.killKind === "timeout" || live.killKind === "watch_failure") this.finalize(task, "killed", undefined, live.killKind);
        else if (task.metadata.capped) this.finalize(task, "failed", code, "output_cap");
        else this.finalize(task, code === 0 ? "completed" : "failed", code);
      }
      return { code };
    }).catch(() => {
      if (this.suspended) return { code: 1 };
      live.processExited = true;
      if (!isTerminal(task.status)) this.finalize(task, "failed", 1);
      return { code: 1 };
    });
    if (opts.taskTimeoutMs !== undefined && opts.taskTimeoutMs > 0) {
      // Absolute deadline so a reload can re-arm only the remaining time (D-03).
      task.timeoutAt = task.timeoutAt ?? Date.now() + opts.taskTimeoutMs;
      live.timer = this.armTaskTimeout(task, Math.max(1, task.timeoutAt - Date.now()));
    }
    this.persist(task);
    this.emitState(task);
    const watch = this.watchLoops.get(task.taskId);
    if (watch) watch.start();
  }

  /** Arm (or re-arm) the task-timeout kill for a running task. */
  private armTaskTimeout(task: TaskSnapshot, remainingMs: number, opts: { unref?: boolean } = {}): ReturnType<typeof setTimeout> {
    const live = this.live.get(task.taskId);
    const timer = setTimeout(() => {
      if (isTerminal(task.status)) {
        if (live && !live.processExited && task.pid) void killTree(task.pid).catch((error: unknown) => console.error(`pi-async: timeout kill failed for completed task ${task.taskId}`, error));
        return;
      }
      void this.kill(task.taskId, "timeout").catch((error: unknown) => console.error(`pi-async: timeout kill failed for task ${task.taskId}`, error));
    }, remainingMs);
    // A timeout restored from disk must not be the only thing keeping the host process alive.
    if (opts.unref) timer.unref?.();
    return timer;
  }

  private scheduleDelayedStart(task: TaskSnapshot, delayMs: number): void {
    const live = this.live.get(task.taskId);
    if (!live || task.status !== "pending") return;
    live.delayTimer = setTimeout(() => {
      live.delayTimer = undefined;
      if (task.status !== "pending") return;
      const rawEnv = task.metadata.delayedEnv;
      const opts: RunOptions = {
        command: task.command, mode: "delayed", name: task.name, taskTimeoutMs: task.taskTimeoutMs,
        notifyOnCompletion: task.metadata.notifyOnCompletion !== false,
        triggerOnCompletion: task.metadata.triggerOnCompletion !== false,
        ...(rawEnv && typeof rawEnv === "object" ? { env: rawEnv as Record<string, string> } : {}),
        ...(task.watch ? { watch: task.watch } : {}),
        ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
      };
      try { this.startTask(task, opts); }
      catch (error) {
        console.error(`pi-async: delayed task ${task.taskId} failed to start`, error);
        task.metadata = { ...task.metadata, startError: error instanceof Error ? error.message : String(error) };
        this.finalize(task, "failed", 1);
      }
    }, delayMs);
  }

  private readWatchOutput(taskId: string): WatchOutput {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    const outputFile = this.assertInsideDataDir(String(task.metadata.outputFile ?? this.live.get(taskId)?.outputFile ?? join(this.config.dataDir, `${taskId}.output`)));
    // Missing primary output must throw so WatchLoop blind_checks can fire (#37/#68 + CONTRACT).
    // stripLogControls: ANSI + bare C0 for model/watch paths (#18); streams stay distinct (#4).
    const output = stripLogControls(readFileSync(outputFile, "utf8"));
    const { stdout, stderr } = streamPaths(outputFile);
    const readSide = (file: string): string => existsSync(file) ? stripLogControls(readFileSync(file, "utf8")) : "";
    return { output, stdout: readSide(stdout), stderr: readSide(stderr) };
  }

  private syncResult(task: TaskSnapshot, promoted: boolean): SyncResult {
    let outputTail = this.logs(task.taskId, { maxBytes: 8192, tail: true }).text;
    const lines = outputTail.split("\n");
    if (lines.length > 200) outputTail = lines.slice(-200).join("\n");
    const bytes = Buffer.from(outputTail, "utf8");
    if (bytes.byteLength > 8192) outputTail = truncateUtf8Bytes(bytes, 8192, true);
    return {
      taskId: task.taskId, name: task.name, status: task.status, mode: task.mode,
      outputHint: `Use async_logs with taskId ${task.taskId} to inspect early output.`,
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }), outputTail, promoted,
    };
  }

  markWatchSuccess(taskId: string, detail: string): void { const task = this.tasks.get(taskId); if (!task || isTerminal(task.status)) return; task.metadata.watchSuccess = detail; this.finalize(task, "completed", task.exitCode); }
  get(taskId: string): TaskSnapshot | undefined { return this.tasks.get(taskId); }

  /**
   * List snapshots. `includeHistory`/`status`/`name` filter; `limit` clamps to 1–50 when given
   * (the tool layer supplies the default so internal prune/reload callers stay unbounded).
   * History-wide queries sort newest-first (D-08).
   */
  list(opts: ListOptions = {}): TaskSnapshot[] {
    let items = [...this.tasks.values()];
    if (opts.includeHistory === false) items = items.filter((task) => !isTerminal(task.status));
    if (opts.status !== undefined) {
      const status = opts.status;
      items = status === "active" ? items.filter((task) => !isTerminal(task.status)) : items.filter((task) => task.status === status);
    }
    if (opts.name !== undefined) {
      const needle = opts.name.trim().toLowerCase();
      items = items.filter((task) => task.name.toLowerCase().includes(needle));
    }
    if (opts.includeHistory === true || opts.status !== undefined) {
      items = [...items].sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
    }
    if (opts.limit !== undefined && Number.isFinite(opts.limit)) {
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(opts.limit)));
      items = items.slice(0, limit);
    }
    return items;
  }

  wait(taskIds: string[] | string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    // A bare string is one id; String is iterable so `[...new Set("uuid")]` would split into characters (#40).
    const idList = typeof taskIds === "string" ? [taskIds] : taskIds;
    if (!Array.isArray(idList) || idList.some((id) => typeof id !== "string")) {
      return Promise.reject(new TypeError(`taskIds must be an array of strings (got ${typeof taskIds})`));
    }
    const uniqueIds = [...new Set(idList)];
    const unknown = uniqueIds.filter((id) => !this.tasks.has(id));
    if (unknown.length) return Promise.reject(new Error(`Unknown task id(s): ${unknown.join(", ")}`));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Wait aborted"));
    const pending = () => uniqueIds.map((id) => this.tasks.get(id)!).filter((task) => !isTerminal(task.status));
    if (pending().length === 0) return Promise.resolve({ results: uniqueIds.map((id) => this.waitResult(this.tasks.get(id)!)) });
    return new Promise<WaitOutcome>((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = { ids: new Set(uniqueIds), resolve: () => {
        if (settled || pending().length) return;
        settled = true; cleanup();
        resolve({ results: uniqueIds.map((id) => this.waitResult(this.tasks.get(id)!)) });
      } };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        const still = pending();
        const finishedIds = uniqueIds.filter((id) => !still.some((task) => task.taskId === id));
        const notReady = still.map((task) => ({ taskId: task.taskId, status: task.status as "running" | "pending", elapsedMs: Date.now() - task.createdAt }));
        // REV-7: no finished → pure { notReady }; mixed → { results, notReady }.
        if (finishedIds.length === 0) resolve({ notReady });
        else resolve({ results: finishedIds.map((id) => this.waitResult(this.tasks.get(id)!)), notReady });
      }, Math.max(0, timeoutMs));
      const abort = () => { if (settled) return; settled = true; cleanup(); reject(signal?.reason ?? new Error("Wait aborted")); };
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); this.waiters.delete(waiter); };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Read bounded task output. `stream` selects merged/stdout/stderr; a missing file returns
   * `missing: true` instead of throwing, while a path outside the data dir throws (D-11).
   *
   * Only the requested window is read (open/fstat/read, tail by default), so a multi-GB output
   * file costs one bounded read instead of a full-file load. The size policy belongs to the
   * caller (`maxBytes` defaults to 50 KiB; tools cap `async_logs`, the TUI may ask for a larger
   * window), while `MAX_LOG_WINDOW` keeps a mistaken huge request from allocating unboundedly.
   */
  logs(taskId: string, opts: { maxBytes?: number; tail?: boolean; stream?: LogStream } = {}): LogSlice {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    const mergedPath = String(task.metadata.outputFile ?? this.live.get(taskId)?.outputFile ?? join(this.config.dataDir, `${taskId}.output`));
    const stream = opts.stream ?? "merged";
    const { stdout, stderr } = streamPaths(mergedPath);
    const requestPath = stream === "stdout" ? stdout : stream === "stderr" ? stderr : mergedPath;
    const fullPath = this.assertInsideDataDir(requestPath);
    const requestedBytes = opts.maxBytes ?? DEFAULT_LOG_BYTES;
    const boundedBytes = Number.isFinite(requestedBytes) ? Math.max(0, Math.trunc(requestedBytes)) : DEFAULT_LOG_BYTES;
    const maxBytes = Math.min(boundedBytes, MAX_LOG_WINDOW);
    const tail = opts.tail !== false;
    let handle: number | undefined;
    try {
      handle = openSync(fullPath, "r");
      const { size } = fstatSync(handle);
      const truncated = size > maxBytes;
      if (maxBytes === 0) return { text: "", truncated, fullPath };
      // Non-tail reads take one extra byte so the UTF-8 cut can inspect the excluded byte.
      const start = tail ? Math.max(0, size - maxBytes) : 0;
      const length = Math.min(size, tail ? maxBytes : maxBytes + (truncated ? 1 : 0));
      const buffer = readExactly(handle, start, length);
      return { text: stripLogControls(truncateUtf8Window(buffer, maxBytes, tail, truncated)), truncated, fullPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", truncated: false, fullPath, missing: true };
      throw error;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }

  async kill(taskId: string, kind: KillKind): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const live = this.live.get(taskId) ?? (task.pid !== undefined
      ? { outputFile: String(task.metadata.outputFile ?? join(this.config.dataDir, `${task.taskId}.output`)), processExited: !this.pidAlive(task.pid) }
      : undefined);
    if (!live) return;
    if (task.status === "pending") {
      if (kind === "user") this.cancel(taskId);
      else this.finalize(task, "killed", undefined, kind);
      return;
    }
    if (isTerminal(task.status) && live.processExited) return;
    live.killKind = kind;
    let confirmed = true;
    if (task.pid && !live.processExited) {
      const result = await killTree(task.pid);
      confirmed = result.confirmed;
    }
    // Finalize first so async_kill can always return { taskId, status } even when the
    // confirmation probe cannot prove the group is gone (#6).
    if (!isTerminal(task.status)) this.finalize(task, "killed", undefined, kind);
    else {
      // D4 / leftover process: record kill without flipping the settled observation status (#33).
      task.killKind = kind;
      try { this.persist(task); } catch { /* dataDir may already be gone during teardown */ }
      if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
    }
    // Finalize-first (#6): still surface confirmation failure after status is settled.
    if (!confirmed) throw new Error("Descendant processes may have leaked");
  }
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") return false;
    this.finalize(task, "killed", undefined, "user");
    return true;
  }
  consume(taskId: string): void { const task = this.tasks.get(taskId); if (!task) return; task.outputConsumed = true; this.persist(task); }

  /** In-memory send claim only (D-01): `notified` is owned by `markNotified`. */
  claimNotification(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.notified || task.outputConsumed || this.notifyClaims.has(taskId)) return false;
    this.notifyClaims.add(taskId);
    return true;
  }
  /** Record a delivery attempt before calling the host (no retries: attempts stay honest). */
  noteNotifyAttempt(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.notifyAttempts = (task.notifyAttempts ?? 0) + 1;
    this.persist(task);
  }
  /** Host accepted the message; the claim is kept for the rest of the generation. */
  markNotified(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.notified = true;
    this.persist(task);
  }
  /**
   * Release the in-memory claim after a failed delivery. `notified` is untouched: it is only
   * ever set by `markNotified`, so a failed send leaves it false and `resendUnnotified` can retry.
   */
  releaseNotification(taskId: string): void {
    this.notifyClaims.delete(taskId);
  }

  activeCount(): { running: number; pending: number } { let running = 0; let pending = 0; for (const task of this.tasks.values()) { if (task.status === "running") running++; else if (task.status === "pending") pending++; } return { running, pending }; }
  hasActiveWork(): boolean { const count = this.activeCount(); return count.running + count.pending > 0; }

  /** Liveness probe for `async_kill` (D-07): no pid (or an exited child) → false. */
  isProcessAlive(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.pid === undefined) return false;
    const live = this.live.get(taskId);
    if (live?.processExited) return false;
    return this.pidAlive(task.pid);
  }

  /**
   * Stop every timer/watcher and persist, but never kill (REV-17 `/reload`):
   * the next generation adopts the surviving processes via `reloadFromDisk`.
   */
  async suspend(): Promise<void> {
    // Retire first, so a child exit landing during teardown is already ignored.
    this.suspended = true;
    for (const task of this.tasks.values()) {
      const live = this.live.get(task.taskId);
      if (live?.delayTimer) { clearTimeout(live.delayTimer); live.delayTimer = undefined; }
      if (live?.timer) { clearTimeout(live.timer); live.timer = undefined; }
      if (live?.watcher) { clearInterval(live.watcher); live.watcher = undefined; }
      this.watchLoops.get(task.taskId)?.stop();
      this.watchLoops.delete(task.taskId);
      try { this.persist(task); } catch (error) { console.error(`pi-async: suspend could not persist task ${task.taskId}`, error); }
    }
    // Pending waiters belong to the retired generation; never wake them with stale results.
    this.waiters.clear();
  }

  /**
   * Re-send completion notifications the host never accepted (REV-14 `session_start` backfill).
   * Only the existing `onFinalize` hook is replayed (D-02) — the registry owns no notifier.
   */
  async resendUnnotified(opts: { maxAgeMs?: number; maxAttempts?: number } = {}): Promise<number> {
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RESEND_MAX_AGE_MS;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_RESEND_MAX_ATTEMPTS;
    const now = Date.now();
    let resent = 0;
    for (const task of [...this.tasks.values()]) {
      if (!isTerminal(task.status)) continue;
      if (task.notified === true || task.outputConsumed === true) continue;
      if (task.metadata.notifyOnCompletion === false) continue;
      if ((task.notifyAttempts ?? 0) >= maxAttempts) continue;
      if (now - (task.finishedAt ?? task.createdAt) > maxAgeMs) continue;
      try {
        this.events.onFinalize(task);
        this.emit({ type: "finalize", snapshot: task });
        resent++;
      } catch (error) {
        console.error(`pi-async: resend of completion notification failed for ${task.taskId}`, error);
      }
    }
    return resent;
  }

  /**
   * Mark orphaned non-terminal tasks `failed/lost` (REV-16 startup hygiene):
   * a running task whose process group is gone is dead; pending delayed tasks are kept.
   */
  reapOrphans(now: number = Date.now()): number {
    let reaped = 0;
    for (const task of [...this.tasks.values()]) {
      if (isTerminal(task.status)) continue;
      if (task.status === "pending") {
        // Pending delayed tasks hold no OS resources — their due timer is the source of truth…
        // …unless the due time itself fell out of the retention window (PLAN §2.4).
        if (task.dueAt === undefined || now - task.dueAt <= this.retentionMs) continue;
        task.failureKind = "lost";
        this.finalize(task, "failed");
        reaped++;
        continue;
      }
      const pid = task.pid;
      if (pid !== undefined && this.pidAlive(pid)) continue;
      task.failureKind = "lost";
      this.finalize(task, "failed");
      reaped++;
    }
    return reaped;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      // Pending delayed tasks hold no OS resources. Clear their timers but leave snapshots
      // as pending so same-process /reload can restore them (CONTRACT reload / #20).
      for (const task of this.tasks.values()) {
        if (task.status !== "pending") continue;
        const live = this.live.get(task.taskId);
        if (live?.delayTimer) { clearTimeout(live.delayTimer); live.delayTimer = undefined; }
        const watch = this.watchLoops.get(task.taskId);
        watch?.stop();
        this.watchLoops.delete(task.taskId);
      }
      const ids = [...this.tasks.values()].filter((task) => {
        if (task.status === "pending") return false;
        const live = this.live.get(task.taskId);
        return !isTerminal(task.status) || (task.pid !== undefined && (live ? !live.processExited : this.pidAlive(task.pid)));
      }).map((task) => task.taskId);
      await Promise.all(ids.map(async (id) => {
        try {
          await this.kill(id, "shutdown");
          await this.live.get(id)?.exit;
        } catch (error) {
          // A failed bounded kill must be reported, but must not turn shutdown into an unbounded wait.
          console.error(`pi-async: shutdown could not confirm task ${id} process-group exit`, error);
        }
        return undefined;
      }));
    })();
    return this.shutdownPromise;
  }

  async reloadFromDisk(): Promise<void> {
    this.reloading = true;
    try {
      let files: string[] = [];
      try { files = readdirSync(this.config.dataDir); } catch { /* data dir not created yet */ }
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        try {
          const snapshot = JSON.parse(readFileSync(join(this.config.dataDir, file), "utf8")) as TaskSnapshot;
          // #34: skip unknown status values from disk.
          if (!snapshot.taskId || !isTaskStatus(snapshot.status) || this.tasks.has(snapshot.taskId)) continue;
          this.tasks.set(snapshot.taskId, snapshot);
          if (snapshot.status === "pending" && snapshot.mode === "delayed") {
            const outputFile = String(snapshot.metadata.outputFile ?? join(this.config.dataDir, `${snapshot.taskId}.output`));
            this.live.set(snapshot.taskId, { outputFile });
            if (snapshot.watch) this.attachWatch(snapshot.taskId, snapshot.watch);
            const dueAt = snapshot.dueAt ?? Date.now();
            this.scheduleDelayedStart(snapshot, Math.max(0, dueAt - Date.now()));
            continue;
          }
          if ((snapshot.status === "running" || snapshot.metadata.watchSuccess !== undefined) && snapshot.pid && this.pidAlive(snapshot.pid)) {
            const outputFile = String(snapshot.metadata.outputFile ?? join(this.config.dataDir, `${snapshot.taskId}.output`));
            const live: LiveTask = { outputFile };
            this.live.set(snapshot.taskId, live);
            live.watcher = setInterval(() => {
              if (snapshot.pid && !this.pidAlive(snapshot.pid)) {
                if (live.watcher) clearInterval(live.watcher);
                live.processExited = true;
                if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
                snapshot.metadata.capped = this.isOutputCapped(snapshot);
                if (!isTerminal(snapshot.status)) {
                  if (live.killKind) this.finalize(snapshot, "killed", undefined, live.killKind);
                  else if (snapshot.metadata.capped) this.finalize(snapshot, "failed", undefined, "output_cap");
                  else { snapshot.failureKind = "lost"; this.finalize(snapshot, "failed"); }
                }
              }
            }, 100);
            live.watcher.unref?.();
            // D-03: re-arm only the remaining task-timeout budget instead of a fresh full window.
            if (snapshot.status === "running" && snapshot.taskTimeoutMs !== undefined && snapshot.taskTimeoutMs > 0) {
              const anchor = snapshot.timeoutAt ?? (snapshot.startedAt ?? snapshot.createdAt) + snapshot.taskTimeoutMs;
              live.timer = this.armTaskTimeout(snapshot, Math.max(1, anchor - Date.now()), { unref: true });
            }
            // D-03: restore the watch window from the persisted absolute deadline.
            if (snapshot.status === "running" && snapshot.watch) this.attachWatch(snapshot.taskId, snapshot.watch, snapshot.watchDeadline);
          } else if (snapshot.status === "running") {
            // Orphaned on disk: settle it through the same path as `reapOrphans()` so the
            // snapshot also records `processAlive = false` (D-07) and emits one finalize.
            snapshot.failureKind = "lost";
            this.finalize(snapshot, "failed");
          }
        } catch { /* Ignore incomplete/corrupt metadata files; atomic writer leaves prior version intact. */ }
      }
    } finally {
      this.reloading = false;
      this.prune();
    }
  }

  /**
   * Drop terminal-task artifacts that fall outside the retention window.
   *
   * Policy (per dataDir): keep the union of (1) the newest `retentionCount`
   * terminal tasks by finishedAt/createdAt and (2) any terminal task still
   * younger than `retentionMs`. Everything else terminal is deleted
   * (.json + .output/.stdout/.stderr via metadata.outputFile) and removed from memory.
   * Non-terminal tasks are never touched. Missing files are ignored.
   */
  prune(now = Date.now()): { pruned: number } {
    const terminal = this.list({ includeHistory: true })
      .filter((task) => isTerminal(task.status))
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
    let pruned = 0;
    for (let i = 0; i < terminal.length; i++) {
      const task = terminal[i]!;
      const ageAnchor = task.finishedAt ?? task.createdAt;
      const withinCount = i < this.retentionCount;
      const withinAge = now - ageAnchor < this.retentionMs;
      if (withinCount || withinAge) continue;
      this.removeArtifacts(task);
      pruned++;
    }
    return { pruned };
  }

  private removeArtifacts(task: TaskSnapshot): void {
    const outputFile = String(task.metadata.outputFile ?? join(this.config.dataDir, `${task.taskId}.output`));
    const { stdout, stderr } = streamPaths(outputFile);
    // D-11: never delete outside the data dir (skip silently so prune cannot crash).
    for (const file of [outputFile, stdout, stderr, join(this.config.dataDir, `${task.taskId}.json`)]) {
      if (!this.isInsideDataDir(file)) continue;
      try { rmSync(file, { force: true }); } catch { /* force already ignores ENOENT; swallow other rare races */ }
    }
    const live = this.live.get(task.taskId);
    if (live?.timer) clearTimeout(live.timer);
    if (live?.delayTimer) clearTimeout(live.delayTimer);
    if (live?.watcher) clearInterval(live.watcher);
    this.live.delete(task.taskId);
    this.watchLoops.get(task.taskId)?.stop();
    this.watchLoops.delete(task.taskId);
    this.tasks.delete(task.taskId);
    this.notifyClaims.delete(task.taskId);
  }

  private waitResult(task: TaskSnapshot): { taskId: string; status: TaskSnapshot["status"]; exitCode?: number; outputTail: string; killKind?: KillKind; failureKind?: FailureKind } {
    this.consume(task.taskId);
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      outputTail: this.logs(task.taskId, { maxBytes: 8192, tail: true }).text,
      ...(task.killKind ? { killKind: task.killKind } : {}),
      ...(task.failureKind ? { failureKind: task.failureKind } : {}),
    };
  }
  private finalize(task: TaskSnapshot, status: TaskSnapshot["status"], code?: number, killKind?: KillKind): void {
    if (isTerminal(task.status)) return;
    task.status = status; task.exitCode = code; task.killKind = killKind; task.finishedAt = Date.now();
    // D-07: a terminal snapshot never claims a live process.
    task.processAlive = false;
    const live = this.live.get(task.taskId);
    if (live?.delayTimer) { clearTimeout(live.delayTimer); live.delayTimer = undefined; }
    const watch = this.watchLoops.get(task.taskId); watch?.stop(); this.watchLoops.delete(task.taskId);
    if (live?.watcher) clearInterval(live.watcher);
    // D4: watch success settles the observed task but leaves the process under its task timeout.
    if (live?.timer && !(task.metadata.watchSuccess !== undefined && !live.processExited)) { clearTimeout(live.timer); live.timer = undefined; }
    // #15: a waiter already owns this result — set the suppression latch before onFinalize
    // can claimNotification / sendCompletionNotification.
    if ([...this.waiters].some((waiter) => waiter.ids.has(task.taskId))) {
      task.outputConsumed = true;
    }
    this.emitState(task);
    this.finalizeEvent(task);
    for (const waiter of [...this.waiters]) if (waiter.ids.has(task.taskId)) waiter.resolve();
    if (!this.reloading) this.prune();
  }
  private finalizeEvent(task: TaskSnapshot): void {
    this.events.onFinalize(task);
    this.emit({ type: "finalize", snapshot: task });
  }
  private emitState(task: TaskSnapshot): void {
    this.persist(task);
    this.events.onStateChange(task);
    this.emit({ type: "state", snapshot: task });
  }
  private emit(event: RegistryEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { console.error("pi-async: registry event listener failed", error); }
    }
  }

  private ensureDataDir(): void {
    if (this.dataDirReady) return;
    mkdirSync(this.config.dataDir, { recursive: true });
    this.dataDirReady = true;
  }
  /** `configure()` is contractually non-throwing (D-05); a bad data dir surfaces on persist. */
  private ensureDataDirQuietly(): void {
    try { this.ensureDataDir(); } catch (error) { console.error(`pi-async: cannot create data dir ${this.config.dataDir}`, error); }
  }
  private persist(task: TaskSnapshot): void {
    this.ensureDataDir();
    const file = join(this.config.dataDir, `${task.taskId}.json`); const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(task), { mode: 0o600 }); renameSync(temp, file);
  }
  private isOutputCapped(task: TaskSnapshot): boolean {
    try {
      const persisted = JSON.parse(readFileSync(join(this.config.dataDir, `${task.taskId}.json`), "utf8")) as TaskSnapshot;
      return persisted.metadata.capped === true;
    } catch { return task.metadata.capped === true; }
  }

  private switchDataDir(nextDataDir: string): void {
    this.config = { ...this.config, dataDir: nextDataDir };
    this.dataDirReady = false;
  }

  /**
   * Move every task artifact from the current data dir to `nextDataDir` (copy + rename),
   * then repoint snapshots. On failure nothing is lost: the old dir stays authoritative
   * and the error is reported, never thrown (D-05).
   */
  private migrateDataDir(nextDataDir: string): boolean {
    const oldDir = this.config.dataDir;
    let names: string[] = [];
    try {
      names = readdirSync(oldDir).filter((name) => ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix)));
    } catch { /* Old dir missing: nothing to migrate. */ }
    const copied: string[] = [];
    try {
      mkdirSync(nextDataDir, { recursive: true });
      for (const name of names) {
        const target = join(nextDataDir, name);
        const temp = `${target}.${process.pid}.tmp`;
        copyFileSync(join(oldDir, name), temp);
        renameSync(temp, target);
        copied.push(target);
      }
    } catch (error) {
      for (const file of copied) { try { rmSync(file, { force: true }); } catch { /* best-effort rollback */ } }
      console.error(`pi-async: data dir migration failed; keeping ${oldDir}`, error);
      return false;
    }
    this.switchDataDir(nextDataDir);
    this.ensureDataDir();
    for (const task of this.tasks.values()) {
      const outputFile = join(nextDataDir, `${task.taskId}.output`);
      task.metadata = { ...task.metadata, outputFile };
      const live = this.live.get(task.taskId);
      if (live) live.outputFile = outputFile;
      try { this.persist(task); } catch (error) { console.error(`pi-async: could not rewrite task ${task.taskId} after data dir migration`, error); }
    }
    for (const name of names) { try { rmSync(join(oldDir, name), { force: true }); } catch { /* best-effort cleanup */ } }
    return true;
  }

  /** Absolute data dir (realpath when it exists) for boundary checks. */
  private resolvedDataDir(): string {
    try { return realpathSync(this.config.dataDir); } catch { return resolve(this.config.dataDir); }
  }

  private isInsideDataDir(target: string): boolean {
    const root = this.resolvedDataDir();
    let resolvedTarget: string;
    try { resolvedTarget = realpathSync(target); } catch { resolvedTarget = resolve(target); }
    return resolvedTarget === root || resolvedTarget.startsWith(root + sep);
  }

  /** D-11: reject reads of `metadata.outputFile` outside the data dir. */
  private assertInsideDataDir(target: string): string {
    const root = this.resolvedDataDir();
    let resolvedTarget: string;
    try { resolvedTarget = realpathSync(target); } catch { resolvedTarget = resolve(target); }
    if (resolvedTarget !== root && !resolvedTarget.startsWith(root + sep)) {
      throw new Error(`Refusing to read task output outside the async data directory: ${target}`);
    }
    return resolvedTarget;
  }

  private pidAlive(pid: number): boolean {
    // Prefer /proc so a zombie-only group is not treated as alive (#6 / reload lost detection).
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(join("/proc", entry, "stat"), "utf8");
          const closeParen = stat.lastIndexOf(") ");
          if (closeParen < 0) continue;
          const rest = stat.slice(closeParen + 2).split(" ");
          const state = rest[0];
          const pgrp = Number(rest[2]);
          if (pgrp === pid && state !== "Z") return true;
        } catch { /* raced with exit */ }
      }
      return false;
    } catch {
      try { process.kill(-pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    }
  }
}
