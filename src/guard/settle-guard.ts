import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";

export class SettleGuard {
  constructor(_pi: PiCtx, _registry: TaskRegistry, _opts?: { maxReminders?: number; heartbeatMs?: number }) { throw new Error("pi-async: not implemented (src/guard/settle-guard.ts)"); }
  register(): void { throw new Error("pi-async: not implemented (src/guard/settle-guard.ts)"); }
}
