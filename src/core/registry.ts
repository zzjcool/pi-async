import type { KillKind, RunOptions, SyncResult, TaskSnapshot, WatchSpec, WaitOutcome } from "./task.ts";

export interface RegistryEvents {
  onFinalize(snapshot: TaskSnapshot): void;
  onStateChange(snapshot: TaskSnapshot): void;
}

export interface RegistryConfig { dataDir: string; maxTasks?: number; maxOutputBytes?: number; }

export class TaskRegistry {
  constructor(_config: RegistryConfig) { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  setEvents(_events: RegistryEvents): void { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  submit(_opts: RunOptions): TaskSnapshot { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  scheduleDelayed(_opts: RunOptions, _delayMs: number): TaskSnapshot { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  runSync(_opts: RunOptions, _timeoutMs: number, _onTimeout: "promote" | "abort", _signal?: AbortSignal): Promise<SyncResult> { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  attachWatch(_taskId: string, _spec: WatchSpec): void { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  markWatchSuccess(_taskId: string, _detail: string): void { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  get(_taskId: string): TaskSnapshot | undefined { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  list(_opts?: { includeHistory?: boolean }): TaskSnapshot[] { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  wait(_taskIds: string[], _timeoutMs: number, _signal?: AbortSignal): Promise<WaitOutcome> { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  logs(_taskId: string, _opts: { maxBytes?: number; tail?: boolean }): { text: string; truncated: boolean; fullPath: string } { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  kill(_taskId: string, _kind: KillKind): Promise<void> { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  cancel(_taskId: string): boolean { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  consume(_taskId: string): void { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  activeCount(): { running: number; pending: number } { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  hasActiveWork(): boolean { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  shutdown(): Promise<void> { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
  reloadFromDisk(): Promise<void> { throw new Error("pi-async: not implemented (src/core/registry.ts)"); }
}
