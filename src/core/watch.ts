import type { Condition, WatchSpec } from "./task.ts";

export function validateWatchSpec(_spec: WatchSpec): { ok: true } | { ok: false; error: string } { throw new Error("pi-async: not implemented (src/core/watch.ts)"); }
export function evalConditions(_conds: Condition[], _ctx: { output: string; exitCode?: number }): boolean { throw new Error("pi-async: not implemented (src/core/watch.ts)"); }

export interface WatchLoopDeps {
  taskId: string;
  spec: WatchSpec;
  readOutput: () => string;
  getExitCode: () => number | undefined;
  onSuccess: (detail: string) => void;
  onFailure: () => void;
  onBlindExhausted: () => void;
  onWatchTimeout: () => void;
}

export class WatchLoop {
  constructor(_deps: WatchLoopDeps) { throw new Error("pi-async: not implemented (src/core/watch.ts)"); }
  start(): void { throw new Error("pi-async: not implemented (src/core/watch.ts)"); }
  stop(): void { throw new Error("pi-async: not implemented (src/core/watch.ts)"); }
}
