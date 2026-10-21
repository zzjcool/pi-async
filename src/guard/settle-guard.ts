import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { envNumber } from "../core/env.ts";

/**
 * A captured factory-time ExtensionAPI becomes unusable once pi replaces the
 * session (`newSession` / `fork` / `switchSession`) or reloads the extension:
 * every accessor then throws "This extension ctx is stale ...". Timer callbacks
 * run outside pi's event-loop `emit()` try/catch, so a single throw there
 * escapes as `uncaughtException` and kills the whole pi process (crash
 * 2026-10-21, `Timeout._onTimeout` at settle-guard heartbeat).
 *
 * The heartbeat therefore treats staleness as terminal: it stops itself and
 * detaches every hook, which is exactly what `session_shutdown` would do for a
 * session replacement (session replacement does emit it) and what the next
 * `init()` does for `/reload` via {@link SettleGuard.dispose}.
 */
export class SettleGuard {
  private readonly maxReminders: number;
  private readonly heartbeatMs: number;
  private reminders = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private removeHooks: Array<() => void> = [];
  private disposed = false;
  private readonly pi: PiCtx;
  private readonly registry: TaskRegistry;

  constructor(pi: PiCtx, registry: TaskRegistry, opts?: { maxReminders?: number; heartbeatMs?: number }) {
    this.pi = pi;
    this.registry = registry;
    this.maxReminders = opts?.maxReminders ?? 3;
    this.heartbeatMs = opts?.heartbeatMs ?? envNumber("PI_ASYNC_HEARTBEAT_MS", 60_000, { integer: true, min: 0 });
  }
  register(): void {
    // SAFETY: PiCtx hooks vary by runtime; `on` returns the unsubscribe function (the real
    // host has no `pi.off`), so both shapes are feature-detected before use.
    const hooks = this.pi as unknown as {
      on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
      off?: (event: string, handler: (...args: unknown[]) => unknown) => void;
      appendEntry?: (customType: string, data: unknown) => void;
    };
    const unsubscribers: Array<() => void> = [];
    const listen = (event: string, handler: (...args: unknown[]) => unknown): void => {
      const result = hooks.on?.(event, handler);
      // SAFETY: pi.on() returns an unsubscribe function; older/mocked hosts may return void, in
      // which case there is nothing to release and the guard relies on `disposed` alone.
      if (typeof result === "function") unsubscribers.push(result as () => void);
      else unsubscribers.push(() => hooks.off?.(event, handler));
    };
    const beforeSettle = () => {
      if (this.disposed) return;
      const active = this.registry.list({ includeHistory: false });
      if (active.length === 0) { this.reminders = 0; this.reportActivity(); return; }
      this.reportActivity();
      if (this.reminders >= this.maxReminders) {
        this.append(hooks, "async-task-unresolved", { message: `${active.length} async task(s) remain unresolved: ${active.map((task) => task.taskId).join(", ")}` });
        return;
      }
      this.reminders++;
      this.append(hooks, "async-task-settle-reminder", { message: `${active.length} async task(s) not collected (${active.map((task) => task.taskId).join(", ")}); use async_wait/async_status before reporting verdict.` });
      return { continue: true };
    };
    const beforeRun = () => { this.reminders = 0; };
    // SAFETY: PI_LEGION_NODE_ID is the documented legion-child marker; presence opts into settle reminders.
    const legionChild = process.env.PI_LEGION_NODE_ID !== undefined;
    if (legionChild) listen("agent_before_settle", beforeSettle);
    listen("agent_start", beforeRun);
    const cleanup = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.disposed = true;
      for (const unsubscribe of unsubscribers.splice(0)) {
        try { unsubscribe(); } catch { /* best effort: the host ctx may already be stale */ }
      }
      this.removeHooks = [];
    };
    listen("session_shutdown", () => { void cleanup(); });
    this.removeHooks.push(cleanup);
    this.startHeartbeat(hooks);
    this.reportActivity();
  }

  /** Idempotent teardown; also called by the next `init()` so `/reload` cannot leak a timer. */
  dispose(): void {
    this.disposed = true;
    for (const remove of this.removeHooks.splice(0)) {
      try { remove(); } catch { /* best effort: the host ctx may already be stale */ }
    }
  }

  private append(hooks: { appendEntry?: (customType: string, data: unknown) => void }, type: string, data: unknown): void {
    try {
      hooks.appendEntry?.(type, data);
    } catch {
      // A stale ctx means the host abandoned this generation; stop rather than retry into a dead API.
      this.dispose();
    }
  }

  private reportActivity(): void {
    if (this.disposed) return;
    try {
      // SAFETY: `pi.ui` itself throws on a stale ctx, so the read is guarded with the call.
      const ui = (this.pi as unknown as { ui?: { setActivity?: (id: string, value: { message: string } | undefined) => void } }).ui;
      if (typeof ui?.setActivity !== "function") return;
      const count = this.registry.activeCount();
      const total = count.running + count.pending;
      ui.setActivity("pi-async", total ? { message: `${total} async task${total === 1 ? "" : "s"}` } : undefined);
    } catch {
      this.dispose();
    }
  }

  private startHeartbeat(hooks: { appendEntry?: (customType: string, data: unknown) => void }): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      if (this.disposed) { this.dispose(); return; }
      if (!this.registry.hasActiveWork()) return;
      this.append(hooks, "async-task-heartbeat", { timestamp: Date.now(), active: this.registry.activeCount() });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }
}
