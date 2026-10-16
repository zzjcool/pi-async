import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { killTree, spawnDetached, streamPaths } from "./spawn.ts";
import { stripLogControls, truncateUtf8Bytes } from "./output.ts";
import { envNumber } from "./env.ts";
import { capName, deriveName, isTaskStatus, isTerminal, type FailureKind, type KillKind, type RunOptions, type SyncResult, type TaskMode, type TaskSnapshot, type WatchSpec, type WaitOutcome } from "./task.ts";
import { evalConditions, validateWatchSpec, WatchLoop, type WatchOutput } from "./watch.ts";

export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;
  onStateChange(snapshot: TaskSnapshot): void;
}
export interface RegistryConfig { dataDir: string; maxTasks?: number; maxOutputBytes?: number; retentionMs?: number; retentionCount?: number; }
interface LiveTask { outputFile: string; exit?: Promise<{ code: number }>; timer?: ReturnType<typeof setTimeout>; delayTimer?: ReturnType<typeof setTimeout>; watcher?: ReturnType<typeof setInterval>; killKind?: KillKind; processExited?: boolean; }
interface Waiter { ids: Set<string>; resolve: () => void; }
const DEFAULT_MAX_OUTPUT = 20 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_COUNT = 100;

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly live = new Map<string, LiveTask>();
  private readonly waiters = new Set<Waiter>();
  private readonly notifyClaims = new Set<string>();
  private readonly watchLoops = new Map<string, WatchLoop>();
  private events: RegistryEvents = { onFinalize: () => undefined, onStateChange: () => undefined };
  private readonly maxTasks: number;
  private readonly maxOutputBytes: number;
  private readonly retentionMs: number;
  private readonly retentionCount: number;
  private closed = false;
  private reloading = false;
  private shutdownPromise?: Promise<void>;

  private readonly config: RegistryConfig;
  constructor(config: RegistryConfig) {
    this.config = config;
    this.maxTasks = config.maxTasks ?? envNumber("PI_ASYNC_MAX_TASKS", 32, { integer: true, min: 1 });
    this.maxOutputBytes = config.maxOutputBytes ?? envNumber("PI_ASYNC_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT, { integer: true, min: 0 });
    this.retentionMs = config.retentionMs ?? envNumber("PI_ASYNC_RETENTION_MS", DEFAULT_RETENTION_MS, { integer: true, min: 0 });
    this.retentionCount = config.retentionCount ?? envNumber("PI_ASYNC_RETENTION_COUNT", DEFAULT_RETENTION_COUNT, { integer: true, min: 0 });
    mkdirSync(config.dataDir, { recursive: true });
  }

  setEvents(events: RegistryEvents): void { this.events = events; }

  submit(opts: RunOptions): TaskSnapshot {
    if (opts.mode && opts.mode !== "background") throw new Error("submit only accepts background mode");
    return this.createAndStart(opts, "background");
  }

  scheduleDelayed(opts: RunOptions, delayMs: number): TaskSnapshot {
    this.assertAdmission(opts);
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must be a non-negative finite number");
    this.validateRunWatch(opts, "delayed");
    const createdAt = Date.now();
    const taskId = randomUUID();
    const outputFile = join(this.config.dataDir, `${taskId}.output`);
    const task: TaskSnapshot = {
      taskId, name: opts.name ? capName(opts.name) : deriveName(opts.command), command: opts.command, mode: "delayed", status: "pending",
      createdAt, dueAt: createdAt + delayMs, taskTimeoutMs: opts.taskTimeoutMs, notified: false, outputConsumed: false,
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

  attachWatch(taskId: string, spec: WatchSpec): void {
    const validation = validateWatchSpec(spec);
    if (!validation.ok) throw new Error(`Invalid watch spec: ${validation.error}`);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    if (isTerminal(task.status)) throw new Error(`Cannot attach watch to terminal task ${taskId}`);
    const existing = this.watchLoops.get(taskId);
    existing?.stop();
    const loop = new WatchLoop({
      taskId, spec,
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
    if (task.status === "running") loop.start();
  }
  private assertAdmission(opts: RunOptions): void {
    if (this.closed) throw new Error("Async task admission is closed");
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
    const handle = spawnDetached(task.command, { outputFile: live.outputFile, env: { ...opts.env, PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES: String(this.maxOutputBytes) } });
    task.pid = handle.pid;
    live.exit = handle.exit.then(({ code }) => {
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
      live.processExited = true;
      if (!isTerminal(task.status)) this.finalize(task, "failed", 1);
      return { code: 1 };
    });
    this.persist(task);
    if (opts.taskTimeoutMs !== undefined && opts.taskTimeoutMs > 0) live.timer = setTimeout(() => {
      if (isTerminal(task.status)) {
        if (!live.processExited && task.pid) void killTree(task.pid).catch((error: unknown) => console.error(`pi-async: timeout kill failed for completed task ${task.taskId}`, error));
        return;
      }
      void this.kill(task.taskId, "timeout").catch((error: unknown) => console.error(`pi-async: timeout kill failed for task ${task.taskId}`, error));
    }, opts.taskTimeoutMs);
    this.emitState(task);
    const watch = this.watchLoops.get(task.taskId);
    if (watch) watch.start();
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
      };
      try { this.startTask(task, opts); }
      catch { this.finalize(task, "failed", 1); }
    }, delayMs);
  }

  private readWatchOutput(taskId: string): WatchOutput {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    const outputFile = String(task.metadata.outputFile ?? this.live.get(taskId)?.outputFile ?? join(this.config.dataDir, `${taskId}.output`));
    // Missing primary output must throw so WatchLoop blind_checks can fire (#37/#68 + CONTRACT).
    // stripLogControls: ANSI + bare C0 for model/watch paths (#18); streams stay distinct (#4).
    const output = stripLogControls(readFileSync(outputFile, "utf8"));
    const { stdoutFile, stderrFile } = streamPaths(outputFile);
    const readSide = (file: string): string => existsSync(file) ? stripLogControls(readFileSync(file, "utf8")) : "";
    return { output, stdout: readSide(stdoutFile), stderr: readSide(stderrFile) };
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
  list(opts?: { includeHistory?: boolean }): TaskSnapshot[] { const all = [...this.tasks.values()]; return opts?.includeHistory === false ? all.filter((task) => !isTerminal(task.status)) : all; }

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

  logs(taskId: string, opts: { maxBytes?: number; tail?: boolean }): { text: string; truncated: boolean; fullPath: string } {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    const fullPath = String(task.metadata.outputFile ?? this.live.get(taskId)?.outputFile ?? join(this.config.dataDir, `${taskId}.output`));
    if (!existsSync(fullPath)) return { text: "", truncated: false, fullPath };
    const data = readFileSync(fullPath);
    const maxBytes = Math.min(50 * 1024, Math.max(0, opts.maxBytes ?? 50 * 1024));
    const truncated = data.length > maxBytes;
    const text = stripLogControls(truncateUtf8Bytes(data, maxBytes, opts.tail !== false));
    return { text, truncated, fullPath };
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
  claimNotification(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.notified || task.outputConsumed || this.notifyClaims.has(taskId)) return false;
    this.notifyClaims.add(taskId); task.notified = true; this.persist(task); return true;
  }
  rollbackNotification(taskId: string): void { const task = this.tasks.get(taskId); this.notifyClaims.delete(taskId); if (task) { task.notified = false; this.persist(task); } }
  activeCount(): { running: number; pending: number } { let running = 0; let pending = 0; for (const task of this.tasks.values()) { if (task.status === "running") running++; else if (task.status === "pending") pending++; } return { running, pending }; }
  hasActiveWork(): boolean { const count = this.activeCount(); return count.running + count.pending > 0; }
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
      for (const file of readdirSync(this.config.dataDir).filter((name) => name.endsWith(".json"))) {
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
            if (snapshot.status === "running" && snapshot.watch) this.attachWatch(snapshot.taskId, snapshot.watch);
          } else if (snapshot.status === "running") {
            snapshot.status = "failed"; snapshot.failureKind = "lost"; snapshot.finishedAt = Date.now(); this.persist(snapshot); this.events.onFinalize(snapshot);
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
   * (.json + .output via metadata.outputFile) and removed from memory.
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
    try { rmSync(outputFile, { force: true }); } catch { /* force already ignores ENOENT; swallow other rare races */ }
    try { rmSync(join(this.config.dataDir, `${task.taskId}.json`), { force: true }); } catch { /* same */ }
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
    this.persist(task); this.emitState(task); this.events.onFinalize(task);
    for (const waiter of [...this.waiters]) if (waiter.ids.has(task.taskId)) waiter.resolve();
    if (!this.reloading) this.prune();
  }
  private emitState(task: TaskSnapshot): void { this.persist(task); this.events.onStateChange(task); }
  private persist(task: TaskSnapshot): void {
    const file = join(this.config.dataDir, `${task.taskId}.json`); const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(task), { mode: 0o600 }); renameSync(temp, file);
  }
  private isOutputCapped(task: TaskSnapshot): boolean {
    try {
      const persisted = JSON.parse(readFileSync(join(this.config.dataDir, `${task.taskId}.json`), "utf8")) as TaskSnapshot;
      return persisted.metadata.capped === true;
    } catch { return task.metadata.capped === true; }
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

