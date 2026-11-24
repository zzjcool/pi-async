import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DEFAULT_EXIT_GRACE_MS, killTree, spawnDetached, streamPaths } from "./spawn.ts";
import {
  MAX_SCAN_DIRS,
  OWNER_MARKER_NAME,
  STORAGE_ARTIFACT_SUFFIXES,
  compareIds,
  formatBytes,
  formatDuration,
  orderSiblings,
  planEvictions,
  sameDir,
  siblingVerdict,
  surveyDataDir,
  type DirSurvey,
  type EvictionCandidate,
  type StorageReport,
} from "./storage.ts";
import { stripLogControls } from "./output.ts";
import { assertSafeEnvKeys, envNumber } from "./env.ts";
import { capName, deriveName, isTaskStatus, isTerminal, type FailureKind, type KillKind, type RunOptions, type TaskSnapshot, type TaskStatus, type WatchSpec, type WaitOutcome } from "./task.ts";
import { evalConditions, validateWatchSpec, WatchLoop, type WatchOutput } from "./watch.ts";

export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;
  onStateChange(snapshot: TaskSnapshot): void;
  /**
   * Runtime reminder (REV-23 / CONTRACT §18.3). Optional on purpose: existing mocks and
   * embedders keep compiling, and a registry without a listener still evaluates the policy
   * (arming, backoff, suppression) instead of silently skipping it.
   */
  onReminder?(snapshot: TaskSnapshot): void;
  /**
   * REV-34 ruling 2 (#113): this task's `output_matches` evaluation burned its 25 ms budget for the
   * first time. Fires **once per task** (latched in metadata, survives reload) so a pathological
   * pattern cannot spam the session; the semantics are "treated as no match", never a failure.
   */
  onMatchBudgetNotice?(snapshot: TaskSnapshot): void;
}
export interface RegistryConfig {
  dataDir: string;
  cwd?: string;
  maxTasks?: number;
  maxOutputBytes?: number;
  retentionMs?: number;
  retentionCount?: number;
  /** REV-28c (0.4.2): runtime liveness sweep interval; `<= 0` disables the sweep. */
  livenessIntervalMs?: number;
  /** REV-28d (0.4.2): spawn exit-fallback grace window; `<= 0` disables the fallback. */
  spawnExitGraceMs?: number;
  /** #102 / REV-32: reclaim idle sibling data dirs under `dirname(dataDir)`. Default off. */
  sweepSiblings?: boolean;
  /** #102 / REV-32: age gate for a sibling dir; clamped to stay strictly above `retentionMs`. */
  sweepSiblingAgeMs?: number;
  /** #102 / REV-32: global artifact byte quota across the sweep root; `<= 0` disables it. */
  totalBytes?: number;
  /** #102 / REV-32: also evict terminal artifacts the retention window still keeps. Default off. */
  quotaHard?: boolean;
  /** #102 / REV-32: throttle for the `configure()`-driven pass; `<= 0` runs it on every configure. */
  sweepIntervalMs?: number;
}
export interface ListOptions { includeHistory?: boolean; status?: TaskStatus | "active"; name?: string; limit?: number; }
export type LogStream = "merged" | "stdout" | "stderr";
export interface LogSlice { text: string; truncated: boolean; fullPath: string; missing?: boolean; }

/** Registry fan-out event (REV-14/TUI refresh): `state` for every mutation, `finalize` once per terminal transition. */
export type RegistryEvent =
  | { type: "state"; snapshot: TaskSnapshot }
  | { type: "finalize"; snapshot: TaskSnapshot };

interface LiveTask {
  outputFile: string;
  exit?: Promise<{ code: number }>;
  timer?: ReturnType<typeof setTimeout>;
  delayTimer?: ReturnType<typeof setTimeout>;
  reminderTimer?: ReturnType<typeof setTimeout>;
  watcher?: ReturnType<typeof setInterval>;
  killKind?: KillKind;
  processExited?: boolean;
  /**
   * REV-28a (0.4.2): set by `fenceRetiredHandles()` when a revival retires this handle. A late child
   * exit or a `kill()` still awaiting the process group must then be a no-op — it may never overwrite
   * the snapshot of the (possibly revived) owner of that id. `suspend()` itself does **not** set
   * this: it fences through `suspended` and keeps the handles so the same instance can revive.
   */
  retired?: boolean;
  /** REV-28c/S2: the spawn handle's "child exit was observed" probe (undefined for adopted tasks). */
  exitObserved?: () => boolean;
}
interface Waiter { ids: Set<string>; resolve: () => void; }
const DEFAULT_MAX_OUTPUT = 20 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_COUNT = 100;
const MAX_LIST_LIMIT = 50;
const DEFAULT_RESEND_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESEND_MAX_ATTEMPTS = 2;
/**
 * REV-28c (0.4.2): low-frequency sweep for a `running` task whose exit was never observed (the
 * process died while a retired generation owned it, or the host lost the handle). Never kills.
 */
const DEFAULT_LIVENESS_INTERVAL_MS = 5000;
/**
 * REV-28c (0.4.2, revised): consecutive dead observations before the sweep settles a task. With
 * one strike, a tick landing in the "OS exited / Node has not dispatched `exit` yet" window would
 * report a healthy exit-0 task as `failed/lost` (measured: 33/40 at a 1 ms interval), and it would
 * race the REV-28d fallback (default sweep 5 s vs. exit-code fallback 5 s after exit).
 * Two strikes make the sweep strictly slower than the fallback at equal intervals.
 */
const LIVENESS_STRIKES = 2;
/** CONTRACT §18.2 rule 3: a background task with no watch is reminded after 20 minutes. */
const DEFAULT_REMIND_MS = 20 * 60 * 1000;
/** CONTRACT §18.4: at most three reminders per run, then silence (never a kill). */
const MAX_REMINDERS = 3;
/** CONTRACT §18.4: every re-arm doubles the interval (1× → 2× → 4×). */
const REMIND_BACKOFF = 2;
/** Default read window for `logs`; callers (tools/TUI) own the policy above this. */
const DEFAULT_LOG_BYTES = 50 * 1024;
/** Defensive ceiling for a single `logs` read: an accidental huge window is clamped, not honoured. */
const MAX_LOG_WINDOW = 8 * 1024 * 1024;
/**
 * How much trailing output one watch tick reads (REV-25).
 *
 * A watch decides on the tail, so the read is bounded by the same defensive ceiling as any other
 * output read rather than loading the whole file: a marker that scrolled beyond this window is
 * invisible to the check, and a large log (the write cap defaults to 20 MiB) costs one bounded
 * read per interval instead of a full load. `output_matches` is then narrowed again to `MAX_MATCH_CHARS`
 * (64K UTF-16 units) — a memory/trade-off bound, not a ReDoS defence (REV-34); the eval budget is
 * that defence — two different bounds for two different reasons.
 */
const WATCH_READ_BYTES = MAX_LOG_WINDOW;
/** Artifacts owned by one task; migrated wholesale between data dirs (single source of truth). */
const ARTIFACT_SUFFIXES = STORAGE_ARTIFACT_SUFFIXES;
/** #102 / REV-32: default sibling age gate — twice the default retention window. */
const DEFAULT_SWEEP_SIBLING_AGE_MS = 2 * DEFAULT_RETENTION_MS;
/** #102 / REV-32: `configure()` runs on every tool call; one storage pass per minute is plenty. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

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
  private readonly livenessIntervalMs: number;
  private readonly spawnExitGraceMs: number;
  /** #102 / REV-32: storage lifecycle switches (both default off; documented in CONTRACT §11). */
  private readonly sweepSiblings: boolean;
  private readonly sweepSiblingAgeMs: number;
  private readonly totalBytes: number;
  private readonly quotaHard: boolean;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;
  private lastSweepReport?: StorageReport;
  private config: RegistryConfig;
  private closed = false;
  /** Set by `suspend()`: this generation is retired and must not settle adopted work (REV-17). */
  private suspended = false;
  /** REV-28c: lazy, `unref()`ed liveness sweep; only alive while there is non-terminal work. */
  private livenessTimer?: ReturnType<typeof setInterval>;
  /** REV-28c: consecutive "process is gone" observations per task id (two-strike settlement). */
  private readonly livenessStrikes = new Map<string, number>();
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
    this.livenessIntervalMs = config.livenessIntervalMs ?? envNumber("PI_ASYNC_LIVENESS_INTERVAL_MS", DEFAULT_LIVENESS_INTERVAL_MS, { integer: true, min: 0 });
    this.spawnExitGraceMs = config.spawnExitGraceMs ?? envNumber("PI_ASYNC_SPAWN_EXIT_GRACE_MS", DEFAULT_EXIT_GRACE_MS, { integer: true, min: 0 });
    // #102 / REV-32. Every switch is off by default: an untouched install keeps the 0.5.x
    // per-dataDir prune and nothing else (see CONTRACT §10 and the acceptance list of #102).
    this.sweepSiblings = config.sweepSiblings ?? envNumber("PI_ASYNC_SWEEP_SIBLINGS", 0, { integer: true, min: 0 }) > 0;
    const configuredSiblingAge = config.sweepSiblingAgeMs ?? envNumber("PI_ASYNC_SWEEP_SIBLING_AGE_MS", DEFAULT_SWEEP_SIBLING_AGE_MS, { integer: true, min: 0 });
    // Gate 3 is "older than N days **and** N > retention": the retention window is the floor.
    this.sweepSiblingAgeMs = Math.max(configuredSiblingAge, this.retentionMs + 1);
    this.totalBytes = config.totalBytes ?? envNumber("PI_ASYNC_TOTAL_BYTES", 0, { integer: true, min: 0 });
    this.quotaHard = config.quotaHard ?? envNumber("PI_ASYNC_QUOTA_HARD", 0, { integer: true, min: 0 }) > 0;
    this.sweepIntervalMs = config.sweepIntervalMs ?? envNumber("PI_ASYNC_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS, { integer: true, min: 0 });
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
   *
   * REV-28a (0.4.2): a `configure()` on a **suspended** instance is the no-successor revival path —
   * the host retired this generation (reload/resume) but never built the next one, so this very
   * instance takes its own work back from disk. Ordering matters and is frozen:
   * 1. `fenceRetiredHandles()` drops the fence and retires every live handle;
   * 2. the normal cwd/data-dir decision runs **while the non-terminal snapshots are still in memory**
   *    (a data-dir migration rewrites their `metadata.outputFile`; dropping them first would leave
   *    them un-migrated or pointing at the old directory);
   * 3. `dropForReAdoption()` frees the ids right before `reloadFromDisk()`.
   */
  configure(opts: { dataDir?: string; cwd?: string }): void {
    const first = !this.configured;
    this.configured = true;
    const revived = this.suspended;
    if (revived) this.fenceRetiredHandles();
    let dropped: TaskSnapshot[] = [];
    if (opts.cwd !== undefined && opts.cwd.length > 0) this.config = { ...this.config, cwd: opts.cwd };
    const nextDataDir = opts.dataDir;
    const changed = nextDataDir !== undefined && nextDataDir !== this.config.dataDir;
    if (changed) {
      if (this.tasks.size > 0) {
        if (!this.migrateDataDir(nextDataDir)) {
          this.ensureDataDirQuietly();
          if (first || revived) {
            if (revived) dropped = this.dropForReAdoption();
            // S6 (0.4.2): never let a rejection escape silently — `reapOrphans()` and the
            // lost-snapshot backfill below must still run, or a dropped task would be in neither memory nor disk.
            void this.reloadFromDisk().catch((error: unknown) => console.error("pi-async: reload during revival failed", error));
            this.reapOrphans();
            this.settleDroppedSnapshots(dropped);
          }
          return;
        }
      } else {
        this.switchDataDir(nextDataDir);
      }
    }
    // D-04: the session data dir is created here or on first persist — never in the constructor.
    this.ensureDataDirQuietly();
    if (first || changed || revived) {
      if (revived) dropped = this.dropForReAdoption();
      // reloadFromDisk() has no await points, so it is fully applied when it returns; reaping
      // keeps this generation from adopting snapshots whose processes are already gone (#44).
      // S6 (0.4.2): the rejection is logged, never swallowed — `reapOrphans()`/the lost-snapshot backfill still run.
      void this.reloadFromDisk().catch((error: unknown) => console.error("pi-async: reload during revival failed", error));
      this.reapOrphans();
      this.settleDroppedSnapshots(dropped);
    }
    this.refreshLiveness();
    // #102 / REV-32: the low-frequency storage pass lives here — `configure()` is idempotent and
    // throttled, while the constructor stays side-effect free (D-04) and no per-task path pays for it.
    this.maybeSweepStorage();
  }

  /**
   * REV-28b (0.4.2): true while `suspend()` has retired this generation and no later `configure()`
   * revoked that fence. The extension uses this to tell "already configured" from "retired with no
   * successor": only the second case may configure (and thereby revive) this instance.
   */
  isSuspended(): boolean { return this.suspended; }

  submit(opts: RunOptions): TaskSnapshot {
    if (opts.mode && opts.mode !== "background") throw new Error("submit only accepts background mode");
    return this.createAndStart(opts);
  }

  scheduleDelayed(opts: RunOptions, delayMs: number): TaskSnapshot {
    // Fail fast: delayed tasks spawn later, so dangerous env overrides must be rejected at submit
    // time exactly like background ones (spawnDetached would otherwise only fail at due time).
    assertSafeEnvKeys(opts.env, "safe");
    this.assertAdmission(opts);
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must be a non-negative finite number");
    this.validateRunWatch(opts);
    const createdAt = Date.now();
    const taskId = randomUUID();
    const outputFile = join(this.config.dataDir, `${taskId}.output`);
    const task: TaskSnapshot = {
      taskId, name: opts.name ? capName(opts.name) : deriveName(opts.command), command: opts.command, mode: "delayed", status: "pending",
      createdAt, dueAt: createdAt + delayMs, taskTimeoutMs: opts.taskTimeoutMs, notified: false, outputConsumed: false,
      cwd: opts.cwd ?? this.config.cwd ?? process.cwd(),
      ...(opts.watch ? { watch: opts.watch } : {}),
      metadata: {
        notifyOnCompletion: opts.notifyOnCompletion ?? true, triggerOnCompletion: opts.triggerOnCompletion ?? true, outputFile,
        ...(opts.env ? { delayedEnv: opts.env } : {}),
        // REV-23 §18.2: the interval is evaluated when the task actually starts, so the explicit
        // knob has to survive the pending window (and a reload of it).
        ...(opts.remindAfterMs !== undefined ? { remindAfterMs: opts.remindAfterMs } : {}),
      },
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
      onMatchBudgetExceeded: (count) => this.noteMatchBudgetExceeded(taskId, count),
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
    if (this.closed) throw new Error("Async task admission is closed (this session shut down; start a new session to run async tasks)");
    // A retired generation must not start work: the next generation owns the session data dir.
    if (this.suspended) throw new Error("Async task admission is closed (registry suspended: a reload or resume retired this generation and a newer one owns new work; reload the session if this tool still points here)");
    const active = this.activeCount();
    if (active.running + active.pending >= this.maxTasks) throw new Error(`Maximum active async tasks reached (${this.maxTasks})`);
    if (!opts.command.trim()) throw new Error("command must not be empty");
  }

  private validateRunWatch(opts: RunOptions): void {
    if (!opts.watch) return;
    const result = validateWatchSpec(opts.watch);
    if (!result.ok) throw new Error(`Invalid watch spec: ${result.error}`);
  }

  private createAndStart(opts: RunOptions): TaskSnapshot {
    this.assertAdmission(opts);
    this.validateRunWatch(opts);
    const taskId = randomUUID();
    const outputFile = join(this.config.dataDir, `${taskId}.output`);
    const task: TaskSnapshot = {
      taskId, name: opts.name ? capName(opts.name) : deriveName(opts.command), command: opts.command, mode: "background", status: "running",
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
      exitGraceMs: this.spawnExitGraceMs,
    });
    task.pid = handle.pid;
    live.exitObserved = handle.exitObserved;
    live.exit = handle.exit.then(async ({ code }) => {
      // A retired generation no longer owns this process: the next generation adopted it via
      // reloadFromDisk and its snapshot wins (no finalize, no persist, no emit). REV-28a (0.4.2): a
      // later `configure()` on this same instance revives it and retires this handle, so the
      // guard is on the handle too — the revived owner (not this callback) settles the task.
      if (this.suspended || live.retired) return { code };
      live.processExited = true;
      // S1 (0.4.2): infrastructure cleanup is unconditional. `finalize()` deliberately keeps the
      // timeout timer of a watch-success task alive while its process still runs (D4/#33), so this
      // callback is the only place that can clear it once the process is really gone — a ref'd
      // timer left behind would pin the host until `taskTimeoutMs` for an already settled task.
      if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
      task.metadata.capped = this.isOutputCapped(task);
      if (task.metadata.capped || task.metadata.watchSuccess !== undefined) this.persist(task);
      // S1/REV-28a (0.4.2): a terminal snapshot is the record — it was settled by the sweep or a
      // kill while this exit was in flight. Nothing below may rewrite status/exitCode/watch; the
      // bookkeeping above (timer, capped, output) already happened.
      if (isTerminal(task.status)) return { code };
      task.exitCode = code;
      const watchSpec = task.watch;
      if (watchSpec) {
        try {
          const streams = this.readWatchOutput(task.taskId);
          const failureMatched = await evalConditions(watchSpec.failure_when, { ...streams, exitCode: code });
          // REV-34 ruling 5 (REV-R5): the exit-time evaluation now awaits the budgeted worker, so
          // re-read the invariants from above — a terminal snapshot settled while the regex ran is
          // the record, and a retired generation owns nothing here.
          if (this.suspended || live.retired || isTerminal(task.status)) return { code };
          if (failureMatched) this.finalize(task, "killed", undefined, "watch_failure");
          else if (await evalConditions(watchSpec.success_when, { ...streams, exitCode: code })) {
            if (this.suspended || live.retired || isTerminal(task.status)) return { code };
            task.metadata.watchSuccess = `success_when matched after process exit: ${JSON.stringify(watchSpec.success_when)}`;
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
      if (this.suspended || live.retired) return { code: 1 };
      live.processExited = true;
      if (!isTerminal(task.status)) this.finalize(task, "failed", 1);
      return { code: 1 };
    });
    if (opts.taskTimeoutMs !== undefined && opts.taskTimeoutMs > 0) {
      // Absolute deadline so a reload can re-arm only the remaining time (D-03).
      task.timeoutAt = task.timeoutAt ?? Date.now() + opts.taskTimeoutMs;
      live.timer = this.armTaskTimeout(task, Math.max(1, task.timeoutAt - Date.now()));
    }
    // REV-23 (§18.2): the reminder interval is evaluated here — at start, never at createdAt —
    // and after `timeoutAt` exists so rule 4 can compare the two deadlines.
    this.armReminderForStart(task, live, opts.remindAfterMs);
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

  /**
   * Effective first-reminder interval for a task (CONTRACT §18.2), in order:
   * explicit knob (`0` = off) → a `watch` already owns a deadline, so off → 20 minutes.
   */
  private evaluateRemindMs(task: TaskSnapshot, explicit: number | undefined): number | undefined {
    const stored = task.metadata.remindAfterMs;
    const requested = explicit ?? (typeof stored === "number" ? stored : undefined);
    if (requested !== undefined) return Number.isFinite(requested) && requested > 0 ? requested : undefined;
    if (task.watch) return undefined;
    return DEFAULT_REMIND_MS;
  }

  /** Base interval recorded when the task started; undefined = reminders off for this task. */
  private reminderBaseMs(task: TaskSnapshot): number | undefined {
    const stored = task.metadata.remindIntervalMs;
    return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : undefined;
  }

  /**
   * Arm the one-shot reminder timer (CONTRACT §18.9 / D-12).
   *
   * Never `setInterval`: the callback closes over the task **id** only and re-reads the registry,
   * so a retired generation cannot fire against a stale snapshot, and `fireReminder` cannot leak
   * an exception into the event loop.
   */
  private armReminder(taskId: string, delayMs: number, opts: { unref?: boolean } = {}): void {
    const live = this.live.get(taskId);
    if (live?.reminderTimer) { clearTimeout(live.reminderTimer); live.reminderTimer = undefined; }
    const timer = setTimeout(() => {
      try { this.fireReminder(taskId); }
      catch (error) { console.error(`pi-async: reminder for task ${taskId} failed`, error); }
    }, Math.max(0, delayMs));
    // §18.8: a reminder restored from disk must not be the only thing keeping the host alive.
    if (opts.unref) timer.unref?.();
    if (live) live.reminderTimer = timer;
  }

  /** §18.2 at start time: evaluate, apply rule 4, and arm. Also the single place that clears stale state. */
  private armReminderForStart(task: TaskSnapshot, live: LiveTask, explicit: number | undefined): void {
    const base = this.evaluateRemindMs(task, explicit);
    const now = Date.now();
    // Rule 4: when the hard deadline lands first, a reminder is a message nobody can act on.
    const beatenByDeadline = base !== undefined && task.timeoutAt !== undefined && now + base >= task.timeoutAt;
    if (base === undefined || beatenByDeadline) {
      delete task.remindAt;
      delete task.metadata.remindIntervalMs;
      return;
    }
    task.metadata.remindIntervalMs = base;
    task.remindCount = 0;
    task.remindAt = now + base;
    if (live.reminderTimer) { clearTimeout(live.reminderTimer); live.reminderTimer = undefined; }
    this.armReminder(task.taskId, base);
  }

  /**
   * Deliver one runtime reminder for `taskId` (CONTRACT §18.3–§18.6).
   *
   * §18.5 is this method's invariant: it never kills, never writes `status` and never writes
   * `failureKind`. Suppression (§18.6) both skips the delivery and disarms — a reminder that
   * arrives after the agent collected the output is noise, and re-arming would only make more.
   */
  private fireReminder(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const live = this.live.get(taskId);
    if (live?.reminderTimer) { clearTimeout(live.reminderTimer); live.reminderTimer = undefined; }
    const suppressed = this.closed || this.suspended || task.status !== "running"
      || task.outputConsumed || task.metadata.notifyOnCompletion === false;
    if (suppressed) {
      // §18.6: skipped AND not re-armed; clearing the past deadline keeps the surface honest.
      delete task.remindAt;
      try { this.persist(task); } catch (error) { console.error(`pi-async: cannot persist suppressed reminder for task ${taskId}`, error); }
      return;
    }
    const count = (task.remindCount ?? 0) + 1;
    task.remindCount = count;
    const base = this.reminderBaseMs(task);
    if (base === undefined || count >= MAX_REMINDERS) {
      // §18.4: budget spent — stop arming, keep running, write no terminal state.
      delete task.remindAt;
    } else {
      // Backoff: the re-arm after reminder N waits base × 2^N (1× → 2× → 4×).
      const delay = base * REMIND_BACKOFF ** count;
      task.remindAt = Date.now() + delay;
      this.armReminder(taskId, delay);
    }
    try { this.persist(task); } catch (error) { console.error(`pi-async: cannot persist reminder state for task ${taskId}`, error); }
    // Delivered last, with the next schedule already settled so a listener reads post-fire state.
    try { this.events.onReminder?.(task); } catch (error) { console.error(`pi-async: reminder listener failed for task ${taskId}`, error); }
  }

  /**
   * Renew a live task (CONTRACT §18.7 `async_extend`): move the reminder schedule and/or the hard
   * kill deadline, resetting the reminder count. Terminal tasks come back untouched — renewing a
   * finished task is not an error (same shape as `async_kill` on one).
   */
  extend(taskId: string, opts: { remindAfterMs?: number; taskTimeoutMs?: number }): TaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    if (isTerminal(task.status)) return task;
    const live = this.live.get(taskId);
    const now = Date.now();
    if (opts.remindAfterMs !== undefined) {
      if (live?.reminderTimer) { clearTimeout(live.reminderTimer); live.reminderTimer = undefined; }
      if (Number.isFinite(opts.remindAfterMs) && opts.remindAfterMs > 0) {
        // Any renewal resets both the count and the interval (§18.4, last line).
        task.metadata.remindAfterMs = opts.remindAfterMs;
        task.metadata.remindIntervalMs = opts.remindAfterMs;
        task.remindCount = 0;
        task.remindAt = now + opts.remindAfterMs;
        // A pending delayed task is armed by startTask, which re-evaluates §18.2 at the real start.
        if (live && task.status === "running") this.armReminder(taskId, opts.remindAfterMs);
      } else {
        // `0` disarms: no deadline, no timer, no count to carry into a later renewal.
        delete task.remindAt;
        delete task.metadata.remindAfterMs;
        delete task.metadata.remindIntervalMs;
        task.remindCount = 0;
      }
    }
    if (opts.taskTimeoutMs !== undefined) {
      if (live?.timer) { clearTimeout(live.timer); live.timer = undefined; }
      if (Number.isFinite(opts.taskTimeoutMs) && opts.taskTimeoutMs > 0) {
        task.taskTimeoutMs = opts.taskTimeoutMs;
        task.timeoutAt = now + opts.taskTimeoutMs;
        if (live && task.status === "running") live.timer = this.armTaskTimeout(task, opts.taskTimeoutMs);
      } else {
        // `0` clears the hard deadline and its timer without touching the process.
        delete task.timeoutAt;
        delete task.taskTimeoutMs;
      }
    }
    this.emitState(task);
    return task;
  }

  /**
   * Re-arm a reminder restored from disk (CONTRACT §18.8): remaining budget only, `unref` so the
   * adopted timer cannot keep the host alive. An expired deadline fires once immediately and then
   * continues the normal backoff; a spent budget stays spent.
   */
  private rearmReminderFromDisk(task: TaskSnapshot): void {
    if ((task.remindCount ?? 0) >= MAX_REMINDERS) { delete task.remindAt; return; }
    const base = this.reminderBaseMs(task);
    if (base === undefined || task.outputConsumed || task.metadata.notifyOnCompletion === false) { delete task.remindAt; return; }
    // No absolute deadline on disk is only possible for a snapshot written before arming.
    const delay = task.remindAt === undefined ? base : Math.max(0, task.remindAt - Date.now());
    task.remindAt = Date.now() + delay;
    this.armReminder(task.taskId, delay, { unref: true });
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
        ...(typeof task.metadata.remindAfterMs === "number" ? { remindAfterMs: task.metadata.remindAfterMs } : {}),
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
    // Bounded tail reads: the watch only ever decides on recent output, and a multi-GB log must
    // not be loaded once per polling tick. `logs()` opens the file, reads the requested window and
    // strips control characters — the same path every other output read uses.
    //
    // Two behaviours have to be preserved exactly: a path outside the data dir must throw (D-11),
    // and a *missing merged file* must throw so `blind_checks` can count it as an infrastructure
    // failure (#37/#68). `logs()` reports a missing file instead of throwing, so that case is
    // turned back into a throw here. The side streams keep the lenient empty-string behaviour.
    const merged = this.logs(taskId, { maxBytes: WATCH_READ_BYTES, tail: true });
    if (merged.missing) throw new Error(`Task output file is missing: ${merged.fullPath}`);
    const stdout = this.logs(taskId, { maxBytes: WATCH_READ_BYTES, tail: true, stream: "stdout" });
    const stderr = this.logs(taskId, { maxBytes: WATCH_READ_BYTES, tail: true, stream: "stderr" });
    // Streams stay distinct (#4); merged is the concatenation the watch has always evaluated.
    return { output: merged.text, stdout: stdout.text, stderr: stderr.text };
  }

  markWatchSuccess(taskId: string, detail: string): void { const task = this.tasks.get(taskId); if (!task || isTerminal(task.status)) return; task.metadata.watchSuccess = detail; this.finalize(task, "completed", task.exitCode); }
  /**
   * REV-34 ruling 2 (#113): `count` of this round's `output_matches` evaluations ran out of budget.
   * Counter only — the round is a plain "not matched" round: no `failureKind`, no kill, no change to
   * `blind_checks`/`timeoutMs`. The first occurrence per task tells the model once.
   */
  private noteMatchBudgetExceeded(taskId: string, count: number): void {
    const task = this.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return;
    task.matchBudgetExceeded = (task.matchBudgetExceeded ?? 0) + count;
    const firstTime = task.metadata.matchBudgetNotified !== true;
    if (firstTime) task.metadata.matchBudgetNotified = true;
    // One persist + one state emit carries both the counter and the latch.
    this.emitState(task);
    if (!firstTime) return;
    try { this.events.onMatchBudgetNotice?.(task); } catch (error) { console.error(`pi-async: match-budget notice failed for task ${taskId}`, error); }
  }

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
    const owned = this.live.get(taskId);
    const live = owned ?? (task.pid !== undefined
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
    // REV-28a (0.4.2): `killTree` can take seconds (TERM ignored → 3s grace → KILL). If the registry was
    // suspended+revived meanwhile, this handle no longer owns the task: the process death is the
    // revived generation's business (its watcher / the liveness sweep settle it as `lost`), and a
    // finalize here would clobber the adopted snapshot. Still report an unconfirmed kill.
    const currentLive = this.live.get(taskId);
    if (live.retired === true || (currentLive !== undefined && currentLive !== live)) {
      if (!confirmed) throw new Error("Descendant processes may have leaked");
      return;
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

  /**
   * 0.4.3 (CONTRACT §7.2): record that a tool handed this task's **terminal** state to the model.
   *
   * One terminal event is told once, to exactly one consumer — a consumed task must never produce a
   * completion notification, whether it is sent now (`onFinalize`) or replayed later
   * (`resendUnnotified`). Idempotent: the first consumer wins and the timestamp is not rewritten.
   * Returns `true` only when it actually latched (so a caller can tell "was already told").
   */
  markConsumed(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.consumedAt !== undefined) return false;
    task.consumedAt = Date.now();
    this.persist(task);
    return true;
  }

  /** Whether a terminal state was already delivered to the model by a tool (0.4.3 / §7.2). */
  isConsumed(taskId: string): boolean {
    return this.tasks.get(taskId)?.consumedAt !== undefined;
  }

  /** In-memory send claim only (D-01): `notified` is owned by `markNotified`. */
  claimNotification(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.notified || task.outputConsumed || task.consumedAt !== undefined || this.notifyClaims.has(taskId)) return false;
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

  /** Clear every timer/watcher one live handle owns (shared by `suspend()` and the revival fence). */
  private clearLiveTimers(live: LiveTask): void {
    if (live.delayTimer) { clearTimeout(live.delayTimer); live.delayTimer = undefined; }
    if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
    if (live.reminderTimer) { clearTimeout(live.reminderTimer); live.reminderTimer = undefined; }
    if (live.watcher) { clearInterval(live.watcher); live.watcher = undefined; }
  }

  /**
   * REV-28a (0.4.2), step 1 of the revival: drop the retirement fence and retire every live handle.
   *
   * The non-terminal snapshots deliberately stay in `tasks` here — the data-dir decision that runs
   * right after still has to see them so a migration rewrites their `metadata.outputFile` (see
   * `configure()`'s frozen ordering).
   * Retired handles keep their late exit callbacks harmless: only `dropForReAdoption()` frees the
   * ids, immediately before `reloadFromDisk()` adopts the disk truth.
   */
  private fenceRetiredHandles(): void {
    this.suspended = false;
    this.stopLiveness();
    for (const [taskId, live] of [...this.live]) {
      live.retired = true;
      this.clearLiveTimers(live);
      this.watchLoops.get(taskId)?.stop();
      this.watchLoops.delete(taskId);
    }
  }

  /**
   * REV-28a (0.4.2), step 3 of the revival: free every non-terminal id for `reloadFromDisk()`.
   *
   * `suspend()` already persisted these snapshots, so disk is authoritative; the returned array is
   * what `settleDroppedSnapshots()` needs if disk cannot give one of them back. Terminal
   * snapshots stay in memory — they are settled, and pruning owns them.
   */
  private dropForReAdoption(): TaskSnapshot[] {
    const dropped: TaskSnapshot[] = [];
    for (const [taskId, live] of [...this.live]) {
      const task = this.tasks.get(taskId);
      if (task !== undefined && isTerminal(task.status)) continue;
      if (task !== undefined) dropped.push(task);
      this.tasks.delete(taskId);
      this.live.delete(taskId);
      // Claims belong to the retired handle; the adopted snapshot carries `notified` from disk.
      this.notifyClaims.delete(taskId);
    }
    // A non-terminal snapshot can also lack a live handle; it must be dropped too, or
    // `reloadFromDisk()` would skip it by id and keep the stale in-memory object alive.
    for (const task of [...this.tasks.values()]) {
      if (isTerminal(task.status)) continue;
      dropped.push(task);
      this.tasks.delete(task.taskId);
      this.notifyClaims.delete(task.taskId);
    }
    return dropped;
  }

  /**
   * REV-28a (0.4.2): a dropped snapshot that disk never gave back (file deleted, unreadable or
   * corrupt) must not vanish silently — that would leave a per-task activity spinner with no
   * `finalize` and no terminal record. Re-register it and settle it through the normal path.
   *
   * A `delayed` snapshot that never started has no process whose exit could be unknown; the
   * notification layer says so instead of claiming incomplete output (see `extensions/index.ts`).
   */
  private settleDroppedSnapshots(dropped: TaskSnapshot[]): void {
    for (const snapshot of dropped) {
      if (this.tasks.has(snapshot.taskId)) continue;
      this.tasks.set(snapshot.taskId, snapshot);
      snapshot.failureKind = "lost";
      this.finalize(snapshot, "failed");
    }
  }

  /**
   * Stop every timer/watcher and persist, but never kill (REV-17 `/reload`):
   * the next generation adopts the surviving processes via `reloadFromDisk`.
   * The same instance can also adopt them again through `configure()` (REV-28a, 0.4.2).
   */
  async suspend(): Promise<void> {
    // Retire first, so a child exit landing during teardown is already ignored.
    this.suspended = true;
    this.stopLiveness();
    for (const task of this.tasks.values()) {
      const live = this.live.get(task.taskId);
      if (live !== undefined) this.clearLiveTimers(live);
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
      if (task.notified === true || task.outputConsumed === true || task.consumedAt !== undefined) continue;
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

  /**
   * REV-28c (0.4.2): start the liveness sweep only while there is non-terminal work; never in the
   * constructor, and `unref()`ed so an idle host is not held open by it.
   */
  private refreshLiveness(): void {
    const wanted = this.hasActiveWork() && !this.closed && !this.suspended
      && Number.isFinite(this.livenessIntervalMs) && this.livenessIntervalMs > 0;
    if (!wanted) { this.stopLiveness(); return; }
    if (this.livenessTimer !== undefined) return;
    const timer = setInterval(() => this.sweepLiveness(), this.livenessIntervalMs);
    timer.unref?.();
    this.livenessTimer = timer;
  }

  private stopLiveness(): void {
    this.livenessStrikes.clear();
    if (this.livenessTimer === undefined) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  /**
   * REV-28c (0.4.2): settle a `running` task whose process group is gone but whose exit was never
   * observed (a retired generation owned the child, or the host lost the handle). Same shape as
   * the load-time path: `failed` + `failureKind: "lost"`. Pending work is untouched, and the sweep
   * never kills anything.
   *
   * Settlement needs **two consecutive** dead observations: a single tick can land in the window
   * where the OS already reaped the child but Node has not dispatched `exit` yet, which would report
   * a healthy `exit 0` task as `failed/lost`. A live observation resets the count.
   *
   * The sweep also skips any task whose spawn handle saw the child's `exit` (REV-28d fallback owns
   * settlement from then on). That keeps the two settlers from racing regardless of how their two
   * intervals are configured — see `SpawnHandle.exitObserved`.
   */
  private sweepLiveness(): void {
    if (this.closed || this.suspended) { this.stopLiveness(); return; }
    for (const task of [...this.tasks.values()]) {
      if (task.status !== "running") { this.livenessStrikes.delete(task.taskId); continue; }
      const live = this.live.get(task.taskId);
      if (live?.processExited) { this.livenessStrikes.delete(task.taskId); continue; }
      if (this.spawnExitGraceMs > 0 && live?.exitObserved?.() === true) {
        // REV-28c/S2: the child's exit was observed, so the REV-28d fallback will settle this task;
        // the sweep must never race it. This is structural — it does not depend on how the two
        // configurable intervals compare (grace > interval used to let the sweep win).
        this.livenessStrikes.delete(task.taskId);
        continue;
      }
      if (task.pid !== undefined && this.pidAlive(task.pid)) { this.livenessStrikes.delete(task.taskId); continue; }
      const strikes = (this.livenessStrikes.get(task.taskId) ?? 0) + 1;
      if (strikes < LIVENESS_STRIKES) { this.livenessStrikes.set(task.taskId, strikes); continue; }
      this.livenessStrikes.delete(task.taskId);
      if (live) live.processExited = true;
      if (live?.timer) { clearTimeout(live.timer); live.timer = undefined; }
      task.failureKind = "lost";
      this.finalize(task, "failed");
    }
    for (const id of [...this.livenessStrikes.keys()]) if (!this.tasks.has(id)) this.livenessStrikes.delete(id);
    if (!this.hasActiveWork()) this.stopLiveness();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.stopLiveness();
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
            // §18.8: re-arm the reminder from its absolute deadline (same shape as D-03 above).
            if (snapshot.status === "running") this.rearmReminderFromDisk(snapshot);
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
      // REV-28c: adopting snapshots can leave this generation owning work, so the sweep may need to start.
      this.refreshLiveness();
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
      // REV-32: same age key *and* the same id tie-break as `expiredTaskIds()`, so the quota's
      // soft tier and this prune can never disagree about which equal-aged task is the outsider.
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || compareIds(a.taskId, b.taskId));
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

  /**
   * #102 / REV-32 — one storage lifecycle pass (CONTRACT §10).
   *
   * Two independent halves, both **off by default**:
   *
   * 1. **Cross-dataDir reclamation** (`PI_ASYNC_SWEEP_SIBLINGS=1`): a sibling directory of this
   *    data dir (i.e. another session's `pi-async/<sessionId>`) is removed wholesale only when all
   *    three gates hold — it is not this data dir, no non-terminal snapshot inside it points at an
   *    alive pid, and it has been idle for longer than `PI_ASYNC_SWEEP_SIBLING_AGE_MS` (clamped to
   *    stay strictly above `PI_ASYNC_RETENTION_MS`). Doubt always skips: foreign content, an
   *    unparsable snapshot and anything that is not a plain directory are never deleted.
   * 2. **Global byte quota** (`PI_ASYNC_TOTAL_BYTES`, unit = bytes of task artifacts across the
   *    whole sweep root): evict terminal-task artifact sets in a deterministic order (tier, then
   *    oldest `finishedAt ?? createdAt`, then taskId). Non-terminal tasks and the data dirs holding
   *    a live task are never candidates. A soft pass only evicts what the retention union would drop
   *    anyway; if that is not enough the pass stops and reports `overQuota` instead of eating results
   *    the retention window still promises (`PI_ASYNC_QUOTA_HARD=1` opts into evicting those too).
   *
   * Every removal is logged **before** the unlink and summarised in the returned report — a pass
   * that deletes data is never silent, and the contract forbids using task activity as evidence.
   */
  sweepStorage(now = Date.now()): StorageReport {
    const dataDir = resolve(this.config.dataDir);
    const root = dirname(dataDir);
    const report: StorageReport = {
      at: now, root, dataDir, quotaBytes: this.totalBytes,
      usedBytesBefore: 0, usedBytesAfter: 0, overQuota: false,
      removedDirs: [], skipped: [], evicted: [], protectedDirs: [], unreadableDirs: [], freedBytes: 0, lines: [],
    };
    // Both switches off is the shipped default: not one stat call, so 0.5.x behaviour is untouched.
    if (!this.sweepSiblings && this.totalBytes <= 0) return report;
    const log = (line: string): void => { report.lines.push(line); console.warn(`pi-async: ${line}`); };

    // A sweep root is a *session container*. The filesystem root is never one: refusing it here keeps
    // a mis-pointed dataDir (`/`) from turning the quota into a filesystem-wide walk.
    if (dirname(root) === root) {
      log(`storage: refusing to sweep the filesystem root (${root}); set a session-scoped data dir`);
      this.lastSweepReport = report;
      return report;
    }

    // One survey of the sweep root feeds both phases and keeps the byte accounting exact.
    const surveys: DirSurvey[] = [];
    let names: string[] = [];
    try { names = readdirSync(root).sort(); } catch { /* the root may not exist yet */ }
    for (const name of names) {
      const path = join(root, name);
      if (surveys.length >= MAX_SCAN_DIRS) { report.skipped.push({ path, reason: "scan_limit" }); continue; }
      const survey = surveyDataDir(path);
      if (survey === undefined) { report.skipped.push({ path, reason: "not_a_directory" }); continue; }
      surveys.push(survey);
    }
    // A data dir is recognised by positive evidence: it is *this* data dir, or it holds at least one
    // parseable snapshot, or nothing in it contradicts the layout. A junk-tainted directory that is
    // still clearly a data dir keeps its artifact bytes in the accounting — dropping the current
    // data dir on one stray `.DS_Store` would make an exceeded quota report itself as satisfied.
    const isDataDir = (survey: DirSurvey): boolean =>
      sameDir(survey.path, dataDir) || !survey.foreign || survey.snapshots.length > 0;
    for (const survey of surveys) {
      if (isDataDir(survey) || survey.bytes === 0) continue;
      report.skipped.push({ path: survey.path, reason: "not_a_data_dir", detail: `${formatBytes(survey.bytes)} ignored by the quota` });
    }
    report.usedBytesBefore = surveys.reduce((total, survey) => total + (isDataDir(survey) ? survey.bytes : 0), 0);

    // Phase 1 — cross-dataDir reclamation behind the three gates.
    let survivors = surveys;
    if (this.sweepSiblings) {
      const keep: DirSurvey[] = [];
      for (const survey of orderSiblings(surveys)) {
        const verdict = siblingVerdict(survey, {
          currentDataDir: dataDir, now, minAgeMs: this.sweepSiblingAgeMs,
          pidAlive: (pid) => this.pidAlive(pid),
          // REV-33: the marker holds a session pid, not a process-group id.
          processAlive: (pid) => this.processAlive(pid),
        });
        if (!verdict.deletable) {
          report.skipped.push({ path: survey.path, reason: verdict.reason ?? "recently_active", ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) });
          keep.push(survey);
          continue;
        }
        // Logged before the unlink: deleting a directory is never silent.
        log(`storage: removing sibling data dir ${survey.path} (idle ${formatDuration(now - survey.lastActivityMs)}, no live task, ${formatBytes(survey.bytes)})`);
        try {
          rmSync(survey.path, { recursive: true, force: true });
          report.removedDirs.push(survey.path);
          report.freedBytes += survey.bytes;
        } catch (error) {
          // Could not prove the removal: keep it in the accounting rather than lying about it.
          report.skipped.push({ path: survey.path, reason: "delete_failed", detail: String(error) });
          keep.push(survey);
        }
      }
      survivors = keep;
    }

    // Phase 2 — global byte quota over the surviving data dirs. `isDataDir()` is the filter: a
    // directory holding only foreign content (no snapshot, no identity with this data dir) is not a
    // pi-async data dir, so its bytes are neither counted nor made into candidates — a wrong
    // `dirname(dataDir)` can neither inflate the quota nor lose data to it. A *foreign* directory
    // that still holds a parseable snapshot **does** count (and may yield candidates): the snapshot
    // is positive evidence that this is a pi-async data dir with a stray file in it, which is the
    // same call `surveyDataDir()` makes for the current data dir.
    if (this.totalBytes > 0) {
      const dataDirs = survivors.filter((survey) => isDataDir(survey));
      const used = dataDirs.reduce((total, survey) => total + survey.bytes, 0);
      const plan = planEvictions(dataDirs, {
        now, usedBytes: used, quotaBytes: this.totalBytes,
        retentionMs: this.retentionMs, retentionCount: this.retentionCount,
        hard: this.quotaHard, currentDataDir: dataDir, pidAlive: (pid) => this.pidAlive(pid),
      });
      let evictedBytes = 0;
      for (const candidate of plan.selected) {
        const reason = candidate.tier === 0 ? "orphan" : candidate.tier === 1 ? "expired" : "unexpired";
        const what = candidate.kind === "task" ? `task ${candidate.taskId}` : "unreferenced artifact";
        log(`storage: evicting ${what} from ${candidate.dataDir} (${reason}, ${formatBytes(candidate.bytes)})`);
        const freed = this.evictCandidate(candidate, dataDir);
        evictedBytes += freed.bytes;
        report.evicted.push({
          dataDir: candidate.dataDir,
          ...(candidate.taskId === undefined ? {} : { taskId: candidate.taskId }),
          files: freed.files, bytes: freed.bytes, reason,
        });
      }
      report.freedBytes += evictedBytes;
      report.protectedDirs = plan.protectedDirs;
      report.unreadableDirs = plan.unreadableDirs;
      report.overQuota = used - evictedBytes > this.totalBytes;
      if (report.overQuota) {
        log(`storage: quota still exceeded after ${plan.selected.length} eviction(s): ${formatBytes(used - evictedBytes)} used > ${formatBytes(this.totalBytes)} quota — kept the remaining artifacts (raise PI_ASYNC_TOTAL_BYTES, or set PI_ASYNC_QUOTA_HARD=1 to also drop results the retention window still keeps)`);
      }
    }

    report.usedBytesAfter = report.usedBytesBefore - report.freedBytes;
    if (report.removedDirs.length > 0 || report.evicted.length > 0) {
      log(`storage: pass freed ${formatBytes(report.freedBytes)} (${report.removedDirs.length} dir(s), ${report.evicted.length} artifact set(s)); ${formatBytes(report.usedBytesAfter)} left under ${root}`);
    }
    this.lastSweepReport = report;
    return report;
  }

  /**
   * Delete one planned candidate and return the bytes actually freed.
   *
   * Current-dataDir task sets go through `removeArtifacts()` so the in-memory snapshot, timers and
   * notification claim disappear together with the files (a half-evicted task would be a ghost).
   */
  private evictCandidate(candidate: EvictionCandidate, currentDataDir: string): { bytes: number; files: number } {
    if (candidate.kind === "task" && sameDir(candidate.dataDir, currentDataDir)) {
      const snapshot = candidate.taskId === undefined ? undefined : this.tasks.get(candidate.taskId);
      if (snapshot !== undefined) return this.removeArtifacts(snapshot);
    }
    const dir = resolve(candidate.dataDir);
    let bytes = 0;
    let files = 0;
    for (const file of candidate.files) {
      const target = resolve(file);
      // Boundary: only plain files that live directly in the surveyed directory are ever unlinked
      // (a symlink is never followed, so a crafted entry cannot reach outside its data dir).
      if (target !== dir && !target.startsWith(dir + sep)) continue;
      try {
        const stat = lstatSync(target);
        if (!stat.isFile()) continue;
        rmSync(target, { force: true });
        bytes += stat.size;
        files++;
      } catch { /* already gone / not a plain file: nothing freed */ }
    }
    return { bytes, files };
  }

  /**
   * `configure()` entry point: throttled and non-throwing (D-05 — it runs inside a session-start
   * handler, where a throw becomes extension noise). Runs at most once per
   * `PI_ASYNC_SWEEP_INTERVAL_MS`. `0` means every configure; a negative value only reaches here
   * through the programmatic `sweepIntervalMs` (the env knob is floored at `0` by `envNumber`, so
   * `PI_ASYNC_SWEEP_INTERVAL_MS=-1` falls back to the 60 s default rather than meaning "always").
   */
  private maybeSweepStorage(now = Date.now()): void {
    if (!this.sweepSiblings && this.totalBytes <= 0) return;
    if (this.sweepIntervalMs > 0 && this.lastSweepAt !== 0 && now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    try { this.sweepStorage(now); }
    catch (error) { console.error("pi-async: storage sweep failed", error); }
  }

  /**
   * Last storage pass this instance ran (REV-32): the observable record of what was deleted and
   * why. The `async_status` payload stays frozen (CONTRACT §12), so this is a library surface plus
   * the log lines the pass emitted — never task activity, which is a write-only shim.
   */
  lastStorageCleanup(): StorageReport | undefined { return this.lastSweepReport; }

  private removeArtifacts(task: TaskSnapshot): { bytes: number; files: number } {
    const outputFile = String(task.metadata.outputFile ?? join(this.config.dataDir, `${task.taskId}.output`));
    const { stdout, stderr } = streamPaths(outputFile);
    // D-11: never delete outside the data dir (skip silently so prune cannot crash).
    let bytes = 0;
    let files = 0;
    for (const file of [outputFile, stdout, stderr, join(this.config.dataDir, `${task.taskId}.json`)]) {
      if (!this.isInsideDataDir(file)) continue;
      // REV-32: count only what was really unlinked (a vanished or non-plain file frees nothing).
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) continue;
        rmSync(file, { force: true });
        bytes += stat.size;
        files++;
      } catch { /* already gone / not a plain file: nothing freed */ }
    }
    const live = this.live.get(task.taskId);
    if (live?.timer) clearTimeout(live.timer);
    if (live?.delayTimer) clearTimeout(live.delayTimer);
    if (live?.reminderTimer) clearTimeout(live.reminderTimer);
    if (live?.watcher) clearInterval(live.watcher);
    this.live.delete(task.taskId);
    this.watchLoops.get(task.taskId)?.stop();
    this.watchLoops.delete(task.taskId);
    this.tasks.delete(task.taskId);
    this.notifyClaims.delete(task.taskId);
    return { bytes, files };
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
    // REV-28a (0.4.2): a stale snapshot object must never settle this id. A `kill()` that awaited the
    // process group across a revival lands here with the *old* object while the adopted snapshot
    // owns the id — finalizing it would persist a terminal state the revived owner never agreed to
    // and would clear the adopted handle's watcher/timer through the id lookup below.
    const current = this.tasks.get(task.taskId);
    if (current !== undefined && current !== task) return;
    if (isTerminal(task.status)) return;
    task.status = status; task.exitCode = code; task.killKind = killKind; task.finishedAt = Date.now();
    // D-07: a terminal snapshot never claims a live process.
    task.processAlive = false;
    const live = this.live.get(task.taskId);
    if (live?.delayTimer) { clearTimeout(live.delayTimer); live.delayTimer = undefined; }
    // §18.5: a terminal task has no next reminder — drop the timer and the deadline, not the count.
    if (live?.reminderTimer) { clearTimeout(live.reminderTimer); live.reminderTimer = undefined; }
    delete task.remindAt;
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
    // REV-28c: every state mutation is the choke point for "is there work to sweep for".
    this.refreshLiveness();
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
    this.writeOwnerMarker();
    this.dataDirReady = true;
  }
  /**
   * REV-32: claim this data dir for this process. Without it a sweep cannot tell "abandoned" from
   * "alive but idle with only terminal tasks" — one sweep root is shared by every session of a
   * directory, so the second kind would lose its data. Atomic like a snapshot, 0600, and never
   * throwing: a marker that cannot be written must not break `persist()`.
   */
  private writeOwnerMarker(): void {
    const file = join(this.config.dataDir, OWNER_MARKER_NAME);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ pid: process.pid, at: Date.now(), marker: "pi-async-owner" }), { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      console.error(`pi-async: cannot write the data dir owner marker ${file}`, error);
    }
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
    // The claim moves with the session: a stale marker in the old dir would keep it alive forever.
    try { rmSync(join(oldDir, OWNER_MARKER_NAME), { force: true }); } catch { /* best-effort cleanup */ }
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

  /**
   * Does *process* `pid` exist (REV-33)? Direct-pid semantics, deliberately different from
   * `pidAlive()` below.
   *
   * `pidAlive()` answers a **process-group** question (`/proc` row with `pgrp === pid`, else
   * `kill(-pid, 0)`) because every task child is spawned `detached` and therefore *is* its own group
   * leader — that is what lets a group whose leader already exited still count as alive (#6).
   *
   * The owner marker records `process.pid` of a pi **session**, and a session process is usually a
   * member of its shell's process group, not a leader. Probing it with group semantics makes a live
   * session look dead, which is the one direction the storage sweep must never guess: it would
   * reclaim the whole data dir of a session that is still running (fail-open, found in the #102
   * post-merge audit). Fail-closed rules: `EPERM` means "exists, not mine" and counts as alive; a
   * pid that cannot be signalled at all counts as dead; a Linux zombie (state `Z`) is dead because
   * only the exit status is left. Pid reuse can only make a dead owner look alive — stale safe.
   */
  private processAlive(pid: number): boolean {
    // An out-of-range pid can never name a process, so it carries no evidence of death: answering
    // "alive" keeps the directory. (`surveyDataDir()` already refuses such markers as unreadable;
    // this is the second line of defence, and the `ERR_INVALID_ARG_TYPE` case is why it exists.)
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return true;
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    // Signalling succeeded (or was refused as EPERM, i.e. it exists): refine only the zombie case.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(") ");
      if (closeParen >= 0) return stat.slice(closeParen + 2, closeParen + 3) !== "Z";
    } catch { /* no /proc (macOS), or raced with exit: the signal probe already answered */ }
    return true;
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
