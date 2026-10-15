import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { killTree, spawnDetached } from "./spawn.ts";
import { stripAnsi } from "./output.ts";
import { deriveName, isTerminal, type KillKind, type RunOptions, type SyncResult, type TaskMode, type TaskSnapshot, type WatchSpec, type WaitOutcome } from "./task.ts";
import { evalConditions, validateWatchSpec, WatchLoop } from "./watch.ts";

export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;
  onStateChange(snapshot: TaskSnapshot): void;
}
export interface RegistryConfig { dataDir: string; maxTasks?: number; maxOutputBytes?: number; }
interface LiveTask { outputFile: string; exit?: Promise<{ code: number }>; timer?: ReturnType<typeof setTimeout>; delayTimer?: ReturnType<typeof setTimeout>; watcher?: ReturnType<typeof setInterval>; killKind?: KillKind; processExited?: boolean; }
interface Waiter { ids: Set<string>; resolve: () => void; }
const DEFAULT_MAX_OUTPUT = 20 * 1024 * 1024;

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly live = new Map<string, LiveTask>();
  private readonly waiters = new Set<Waiter>();
  private readonly notifyClaims = new Set<string>();
  private readonly watchLoops = new Map<string, WatchLoop>();
  private events: RegistryEvents = { onFinalize: () => undefined, onStateChange: () => undefined };
  private readonly maxTasks: number;
  private readonly maxOutputBytes: number;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  private readonly config: RegistryConfig;
  constructor(config: RegistryConfig) {
    this.config = config;
    this.maxTasks = config.maxTasks ?? finiteEnvNumber("PI_ASYNC_MAX_TASKS", 32);
    this.maxOutputBytes = config.maxOutputBytes ?? finiteEnvNumber("PI_ASYNC_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT);
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
      taskId, name: opts.name?.slice(0, 48) ?? deriveName(opts.command), command: opts.command, mode: "delayed", status: "pending",
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
      if ("notReady" in outcome && onTimeout === "promote" && !isTerminal(task.status)) {
        task.mode = "background";
        promoted = true;
        this.emitState(task);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
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
      onBlindExhausted: () => { const current = this.tasks.get(taskId); if (current && !isTerminal(current.status)) this.finalize(current, "failed"); },
      onWatchTimeout: () => { const current = this.tasks.get(taskId); if (current && !isTerminal(current.status)) this.finalize(current, "failed"); },
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
      taskId, name: opts.name?.slice(0, 48) ?? deriveName(opts.command), command: opts.command, mode, status: "running",
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
      if (task.metadata.capped) this.persist(task);
      if (!isTerminal(task.status) && task.watch) {
        try {
          const output = this.readWatchOutput(task.taskId);
          if (evalConditions(task.watch.failure_when, { output, exitCode: code })) this.finalize(task, "killed", undefined, "watch_failure");
          else if (evalConditions(task.watch.success_when, { output, exitCode: code })) {
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

  private readWatchOutput(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task id: ${taskId}`);
    const outputFile = String(task.metadata.outputFile ?? this.live.get(taskId)?.outputFile ?? join(this.config.dataDir, `${taskId}.output`));
    return stripAnsi(readFileSync(outputFile, "utf8"));
  }

  private syncResult(task: TaskSnapshot, promoted: boolean): SyncResult {
    let outputTail = this.logs(task.taskId, { maxBytes: 8192, tail: true }).text;
    const lines = outputTail.split("\n");
    if (lines.length > 200) outputTail = lines.slice(-200).join("\n");
    const bytes = Buffer.from(outputTail, "utf8");
    if (bytes.byteLength > 8192) outputTail = bytes.subarray(bytes.byteLength - 8192).toString("utf8");
    return {
      taskId: task.taskId, name: task.name, status: task.status, mode: task.mode,
      outputHint: `Use async_logs with taskId ${task.taskId} to inspect early output.`,
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }), outputTail, promoted,
    };
  }

  markWatchSuccess(taskId: string, detail: string): void { const task = this.tasks.get(taskId); if (!task || isTerminal(task.status)) return; task.metadata.watchSuccess = detail; this.finalize(task, "completed", task.exitCode); }
  get(taskId: string): TaskSnapshot | undefined { return this.tasks.get(taskId); }
  list(opts?: { includeHistory?: boolean }): TaskSnapshot[] { const all = [...this.tasks.values()]; return opts?.includeHistory === false ? all.filter((task) => !isTerminal(task.status)) : all; }

  wait(taskIds: string[], timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    const uniqueIds = [...new Set(taskIds)];
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
        resolve({ notReady: pending().map((task) => ({ taskId: task.taskId, status: task.status as "running" | "pending", elapsedMs: Date.now() - task.createdAt })) });
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
    const selected = opts.tail === false ? data.subarray(0, maxBytes) : data.subarray(Math.max(0, data.length - maxBytes));
    return { text: stripAnsi(selected.toString("utf8")), truncated: data.length > selected.length, fullPath };
  }

  async kill(taskId: string, kind: KillKind): Promise<void> {
    const task = this.tasks.get(taskId);
    const live = this.live.get(taskId);
    if (!task || !live) return;
    if (task.status === "pending") {
      if (kind === "user") this.cancel(taskId);
      else this.finalize(task, "killed", undefined, kind);
      return;
    }
    if (isTerminal(task.status) && (live.processExited || task.metadata.watchSuccess === undefined)) return;
    live.killKind = kind;
    if (task.pid && !live.processExited) {
      const result = await killTree(task.pid);
      if (!result.confirmed) throw new Error("Descendant processes may have leaked");
    }
    if (!isTerminal(task.status)) this.finalize(task, "killed", undefined, kind);
    else if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
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
      const ids = [...this.tasks.values()].filter((task) => !isTerminal(task.status) || (task.metadata.watchSuccess !== undefined && !this.live.get(task.taskId)?.processExited)).map((task) => task.taskId);
      await Promise.all(ids.map(async (id) => {
        try { await this.kill(id, "shutdown"); } catch (error) { console.error(`pi-async: shutdown could not confirm task ${id} process-group exit`, error); }
        return undefined;
      }));
      await Promise.all([...this.live.values()].map((item) => item.exit).filter((exit): exit is Promise<{ code: number }> => Boolean(exit)));
    })();
    return this.shutdownPromise;
  }
  async reloadFromDisk(): Promise<void> {
    for (const file of readdirSync(this.config.dataDir).filter((name) => name.endsWith(".json"))) {
      try {
        const snapshot = JSON.parse(readFileSync(join(this.config.dataDir, file), "utf8")) as TaskSnapshot;
        if (!snapshot.taskId || this.tasks.has(snapshot.taskId)) continue;
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
  }

  private waitResult(task: TaskSnapshot): { taskId: string; status: TaskSnapshot["status"]; exitCode?: number; outputTail: string } {
    this.consume(task.taskId);
    return { taskId: task.taskId, status: task.status, ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }), outputTail: this.logs(task.taskId, { maxBytes: 8192, tail: true }).text };
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
    this.persist(task); this.emitState(task); this.events.onFinalize(task);
    for (const waiter of [...this.waiters]) if (waiter.ids.has(task.taskId)) waiter.resolve();
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
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
}

function finiteEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}
