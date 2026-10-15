import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";

export class SettleGuard {
  private readonly maxReminders: number;
  private readonly heartbeatMs: number;
  private reminders = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private removeHooks: Array<() => void> = [];
  private readonly pi: PiCtx;
  private readonly registry: TaskRegistry;

  constructor(pi: PiCtx, registry: TaskRegistry, opts?: { maxReminders?: number; heartbeatMs?: number }) {
    this.pi = pi;
    this.registry = registry;
    this.maxReminders = opts?.maxReminders ?? 3;
    this.heartbeatMs = opts?.heartbeatMs ?? Number(process.env.PI_ASYNC_HEARTBEAT_MS ?? 60_000);
  }

  register(): void {
    // SAFETY: PiCtx hooks vary by runtime; these optional operations are only invoked after presence checks.
    const hooks = this.pi as unknown as {
      on?: (event: string, handler: (...args: unknown[]) => unknown) => void;
      off?: (event: string, handler: (...args: unknown[]) => unknown) => void;
      appendEntry?: (customType: string, data: unknown) => void;
    };
    const beforeSettle = () => {
      const active = this.registry.list({ includeHistory: false });
      if (active.length === 0) { this.reminders = 0; return; }
      this.reportActivity();
      if (this.reminders >= this.maxReminders) {
        hooks.appendEntry?.("async-task-unresolved", { message: `${active.length} async task(s) remain unresolved: ${active.map((task) => task.taskId).join(", ")}` });
        return;
      }
      this.reminders++;
      hooks.appendEntry?.("async-task-settle-reminder", { message: `${active.length} async task(s) not collected (${active.map((task) => task.taskId).join(", ")}); use async_wait/async_status before reporting verdict.` });
      return { continue: true };
    };
    const beforeRun = () => { this.reminders = 0; };
    // SAFETY: PI_LEGION_NODE_ID is the documented legion-child marker; presence opts into settle reminders.
    const legionChild = process.env.PI_LEGION_NODE_ID !== undefined;
    if (legionChild) hooks.on?.("agent_before_settle", beforeSettle);
    hooks.on?.("agent_start", beforeRun);
    const cleanup = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (legionChild) hooks.off?.("agent_before_settle", beforeSettle);
      hooks.off?.("agent_start", beforeRun);
      this.removeHooks = [];
    };
    hooks.on?.("session_shutdown", cleanup);
    this.removeHooks.push(cleanup);
    this.startHeartbeat(hooks);
    this.reportActivity();
  }

  private reportActivity(): void {
    // SAFETY: setActivity is feature-detected because older Pi hosts do not implement the optional API.
    const ui = (this.pi as unknown as { ui?: { setActivity?: (id: string, value: { message: string } | undefined) => void } }).ui;
    if (typeof ui?.setActivity !== "function") return;
    const count = this.registry.activeCount();
    const total = count.running + count.pending;
    ui.setActivity("pi-async", total ? { message: `${total} async tasks` } : undefined);
  }

  private startHeartbeat(hooks: { appendEntry?: (customType: string, data: unknown) => void }): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      if (!this.registry.hasActiveWork()) return;
      hooks.appendEntry?.("async-task-heartbeat", { timestamp: Date.now(), active: this.registry.activeCount() });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }
}
