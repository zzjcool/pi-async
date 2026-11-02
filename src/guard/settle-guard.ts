import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";

/** `custom_message` draft pi accepts from `agent_before_settle` (PLAN §2.6). */
interface CustomMessageDraft {
  type: "custom_message";
  customType: string;
  content: string;
  display: false;
}

/** The slice of pi's `AgentBeforeSettleEvent` this guard reads; `entries` may be absent. */
interface BeforeSettleEvent {
  entries?: unknown[];
}

/** The slice of pi's `AgentSettledEvent` this guard reads. */
interface SettledEvent {
  aborted?: boolean;
}

/** `agent_before_settle` result: appended drafts plus an optional extra provider request. */
interface BeforeSettleResult {
  entries: unknown[];
  continue?: boolean;
}

type HostHooks = {
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  off?: (event: string, handler: (...args: unknown[]) => unknown) => void;
};

type MessageHost = {
  sendMessage?: (message: unknown, options: unknown) => unknown;
};

const idsOf = (active: TaskSnapshot[]): string => active.map((task) => task.taskId).join(", ");

/**
 * Keeps a legion child from reporting a verdict while async tasks are still in flight.
 *
 * 0.3.0 (D-12) removed the old `setInterval` heartbeat: it only ever wrote
 * `async-task-heartbeat` entries nobody read, and because timer callbacks run outside pi's
 * event-loop `try/catch` a stale ctx there escaped as an `uncaughtException` (crash
 * 2026-10-21, `Timeout._onTimeout` at settle-guard heartbeat). Reminders are now produced
 * inside the `agent_before_settle` boundary, where pi tolerates (and contains) extension
 * errors, and `agent_settled` (`aborted` runs) sends at most one follow-up per generation.
 */
export class SettleGuard {
  private readonly maxReminders: number;
  private reminders = 0;
  private settledSent = false;
  private removeHooks: Array<() => void> = [];
  private disposed = false;
  private readonly pi: PiCtx;
  private readonly registry: TaskRegistry;

  constructor(pi: PiCtx, registry: TaskRegistry, opts?: { maxReminders?: number }) {
    this.pi = pi;
    this.registry = registry;
    this.maxReminders = opts?.maxReminders ?? 3;
  }

  register(): void {
    // D-12: one env switch disarms the guard entirely — it registers nothing at all.
    if (process.env.PI_ASYNC_SETTLE_GUARD === "0") return;
    if (this.disposed) return;
    // SAFETY: PiCtx hooks vary by runtime; `on` returns the unsubscribe function (the real
    // host has no `pi.off`), so both shapes are feature-detected before use.
    const hooks = this.pi as unknown as HostHooks;
    const unsubscribers: Array<() => void> = [];
    const listen = (event: string, handler: (...args: unknown[]) => unknown): void => {
      const result = hooks.on?.(event, handler);
      // SAFETY: pi.on() returns an unsubscribe function; older/mocked hosts may return void, in
      // which case there is nothing to release and the guard relies on `off`/`disposed` alone.
      if (typeof result === "function") unsubscribers.push(result as () => void);
      else unsubscribers.push(() => hooks.off?.(event, handler));
    };

    const beforeSettle = (event?: unknown): BeforeSettleResult | undefined => {
      if (this.disposed) return undefined;
      const active = this.registry.list({ includeHistory: false });
      this.reportActivity();
      // A stale ctx made reportActivity tear us down; the generation is gone, so stay silent.
      if (this.disposed) return undefined;
      if (active.length === 0) {
        this.reminders = 0;
        return undefined;
      }
      // Any drafts pi already queued for this boundary are preserved in front of ours.
      const entries = [...((event as BeforeSettleEvent | undefined)?.entries ?? [])];
      const ids = idsOf(active);
      if (this.reminders >= this.maxReminders) {
        // Budget spent: record the unresolved list for the transcript, then let the run settle
        // (`continue` omitted so pi does not force another provider request).
        const unresolved: CustomMessageDraft = {
          type: "custom_message",
          customType: "async-task-unresolved",
          content: `${active.length} async task(s) left unresolved: ${ids}. Collect them with async_wait or async_status before finishing.`,
          display: false,
        };
        return { entries: [...entries, unresolved] };
      }
      this.reminders++;
      const reminder: CustomMessageDraft = {
        type: "custom_message",
        customType: "async-task-settle-reminder",
        content: `${active.length} async task(s) not collected yet: ${ids}. Call async_wait or async_status before reporting a verdict.`,
        display: false,
      };
      return { entries: [...entries, reminder], continue: true };
    };

    const agentStart = (): void => {
      this.reminders = 0;
      this.settledSent = false;
    };

    const agentSettled = (event?: unknown): void => {
      if (this.disposed || this.settledSent) return;
      if ((event as SettledEvent | undefined)?.aborted !== true) return;
      if (!this.registry.hasActiveWork()) return;
      // D-13: at most one follow-up per generation; latch before the host call so a throw
      // cannot turn into a retry storm.
      this.settledSent = true;
      let ids = "";
      try {
        ids = idsOf(this.registry.list({ includeHistory: false }));
      } catch { /* best effort: the snapshot is decoration for the message body */ }
      const content = `This run was aborted with async task(s) still running${ids ? `: ${ids}` : ""}. Use async_wait or async_status to collect them.`;
      try {
        // SAFETY: sendMessage is part of ExtensionAPI; feature-detected because mocks and older
        // hosts may omit it, and a stale ctx getter throws on access.
        const host = this.pi as unknown as MessageHost;
        const send = host.sendMessage;
        if (typeof send !== "function") return;
        const result = send.call(host, { customType: "async-task-unresolved", content }, { deliverAs: "followUp" });
        // SAFETY: hosts return void; a mock/future host may return a promise, which must never
        // surface as an unhandled rejection.
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined);
        }
      } catch { /* best effort: sending is advisory, never fatal to settle */ }
    };

    // SAFETY: PI_LEGION_NODE_ID is the documented legion-child marker; presence opts into settle reminders.
    const legionChild = process.env.PI_LEGION_NODE_ID !== undefined;
    if (legionChild) listen("agent_before_settle", beforeSettle);
    listen("agent_start", agentStart);
    // Thread 2 of the guard: registered for every session (not only legion children).
    listen("agent_settled", agentSettled);
    listen("session_shutdown", () => { this.dispose(); });
    this.removeHooks.push(() => {
      for (const unsubscribe of unsubscribers.splice(0)) {
        try { unsubscribe(); } catch { /* best effort: the host ctx may already be stale */ }
      }
    });
    this.reportActivity();
  }

  /** Idempotent teardown; a second call is a no-op. */
  dispose(): void {
    this.disposed = true;
    for (const remove of this.removeHooks.splice(0)) {
      try { remove(); } catch { /* best effort: the host ctx may already be stale */ }
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
      // The host abandoned this generation; detach instead of retrying into a dead API.
      this.dispose();
    }
  }
}
