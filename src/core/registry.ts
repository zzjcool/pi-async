import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { killTree, spawnDetached } from "./spawn.ts";
import { stripAnsi } from "./output.ts";
import { deriveName, isTerminal, type KillKind, type RunOptions, type SyncResult, type TaskSnapshot, type WatchSpec, type WaitOutcome } from "./task.ts";

export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;
  onStateChange(snapshot: TaskSnapshot): void;
}
export interface RegistryConfig { dataDir: string; maxTasks?: number; maxOutputBytes?: number; }
interface LiveTask { outputFile: string; exit?: Promise<{ code: number }>; timer?: ReturnType<typeof setTimeout>; killKind?: KillKind; }
interface Waiter { ids: Set<string>; resolve: () => void; }
const DEFAULT_MAX_OUTPUT = 20 * 1024 * 1024;

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly live = new Map<string, LiveTask>();
  private readonly waiters = new Set<Waiter>();
  private readonly notifyClaims = new Set<string>();
  private events: RegistryEvents = { onFinalize: () => undefined, onStateChange: () => undefined };
  private readonly maxTasks: number;
  private readonly maxOutputBytes: number;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  private readonly config: RegistryConfig;
  constructor(config: RegistryConfig) {
    this.config = config;
    this.maxTasks = config.maxTasks ?? Number(process.env.PI_ASYNC_MAX_TASKS ?? 32);
    this.maxOutputBytes = config.maxOutputBytes ?? Number(process.env.PI_ASYNC_MAX_OUTPUT_BYTES ?? DEFAULT_MAX_OUTPUT);
    mkdirSync(config.dataDir, { recursive: true });
  }

  setEvents(events: RegistryEvents): void { this.events = events; }

  submit(opts: RunOptions): TaskSnapshot {
    if (this.closed) throw new Error("Async task admission is closed");
    if (opts.mode && opts.mode !== "background") throw new Error("not implemented (line B)");
    if (this.activeCount().running + this.activeCount().pending >= this.maxTasks) throw new Error(`Maximum active async tasks reached (${this.maxTasks})`);
    if (!opts.command.trim()) throw new Error("command must not be empty");
    const taskId = randomUUID();
    const outputFile = join(this.config.dataDir, `${taskId}.output`);
    const task: TaskSnapshot = {
      taskId, name: opts.name?.slice(0, 48) ?? deriveName(opts.command), command: opts.command, mode: "background", status: "running",
      pid: undefined, createdAt: Date.now(), startedAt: Date.now(), taskTimeoutMs: opts.taskTimeoutMs,
      notified: false, outputConsumed: false, metadata: { notifyOnCompletion: opts.notifyOnCompletion ?? true, triggerOnCompletion: opts.triggerOnCompletion ?? true, outputFile },
    };
    this.tasks.set(taskId, task);
    const live: LiveTask = { outputFile };
    this.live.set(taskId, live);
    try {
      const handle = spawnDetached(opts.command, { outputFile, env: { ...opts.env, PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES: String(this.maxOutputBytes) } });
      task.pid = handle.pid;
      live.exit = handle.exit.then(({ code }) => {
        const capped = existsSync(`${outputFile}.capped`);
        if (!isTerminal(task.status)) {
          if (live.killKind === "shutdown" || live.killKind === "user" || live.killKind === "timeout" || live.killKind === "watch_failure") this.finalize(task, "killed", undefined, live.killKind);
          else if (capped) this.finalize(task, "failed", code, "output_cap");
          else this.finalize(task, code === 0 ? "completed" : "failed", code);
        }
        return { code };
      }).catch(() => {
        if (!isTerminal(task.status)) this.finalize(task, "failed", 1);
        return { code: 1 };
      });
      this.persist(task);
      if (opts.taskTimeoutMs !== undefined && opts.taskTimeoutMs > 0) live.timer = setTimeout(() => { void this.kill(taskId, "timeout"); }, opts.taskTimeoutMs);
      this.emitState(task);
    } catch (error) {
      this.live.delete(taskId);
      this.tasks.delete(taskId);
      throw error;
    }
    return task;
  }

  scheduleDelayed(_opts: RunOptions, _delayMs: number): TaskSnapshot { throw new Error("pi-async: not implemented (line B)"); }
  runSync(_opts: RunOptions, _timeoutMs: number, _onTimeout: "promote" | "abort", _signal?: AbortSignal): Promise<SyncResult> { throw new Error("pi-async: not implemented (line B)"); }
  attachWatch(_taskId: string, _spec: WatchSpec): void { throw new Error("pi-async: not implemented (line B)"); }
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
    if (!task || isTerminal(task.status)) return;
    const live = this.live.get(taskId);
    if (!live) return;
    live.killKind = kind;
    if (task.pid) {
      const result = await killTree(task.pid);
      if (!result.confirmed) throw new Error("Descendant processes may have leaked");
    }
    this.finalize(task, "killed", undefined, kind);
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
      const ids = [...this.tasks.values()].filter((task) => !isTerminal(task.status)).map((task) => task.taskId);
      await Promise.all(ids.map(async (id) => {
        try { await this.kill(id, "shutdown"); } catch { /* Preserve shutdown progress; kill reports its own leak error to callers. */ }
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
        if (snapshot.status === "running" && (!snapshot.pid || !this.pidAlive(snapshot.pid))) {
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
    const live = this.live.get(task.taskId); if (live?.timer) clearTimeout(live.timer);
    this.persist(task); this.emitState(task); this.events.onFinalize(task);
    for (const waiter of [...this.waiters]) if (waiter.ids.has(task.taskId)) waiter.resolve();
  }
  private emitState(task: TaskSnapshot): void { this.persist(task); this.events.onStateChange(task); }
  private persist(task: TaskSnapshot): void {
    const file = join(this.config.dataDir, `${task.taskId}.json`); const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(task), { mode: 0o600 }); renameSync(temp, file);
  }
  private pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
}
