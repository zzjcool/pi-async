import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTaskActivity, raiseTaskActivity, reportActivity } from "../src/core/bus.ts";
import { sendCompletionNotification, sendReminder } from "../src/core/notify.ts";
import { registerNudges } from "../src/context/nudges.ts";
import { registerSkillDiscovery } from "../src/context/resources.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { isTerminal, type TaskSnapshot } from "../src/core/task.ts";
import { registerHold } from "../src/guard/hold.ts";
import { HoldNotificationRelay } from "../src/guard/hold-notify.ts";
import { SettleGuard } from "../src/guard/settle-guard.ts";
import { registerTools, type ToolContext } from "../src/tools/index.ts";
import { registerRail } from "../src/tui/rail.ts";
import { initStatus } from "../src/tui/status.ts";
import { registerPanelCommands } from "../src/tui/panel.ts";
import { bindTuiHost } from "../src/tui/host.ts";

export type PiCtx = ExtensionAPI;

/** Structural view of pi's session manager: 0.3.0 only reads dir + id (validated at runtime). */
type SessionManagerLike = {
  getSessionDir?: () => string | undefined;
  getSessionId?: () => string | undefined;
};

type RuntimeContext = PiCtx & {
  cwd?: string;
  sessionManager?: SessionManagerLike;
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  registerTool?: (...args: unknown[]) => unknown;
  registerMessageRenderer?: (...args: unknown[]) => unknown;
};

/**
 * Session-scoped data directory (D-16 / PLAN §2.8):
 * `<sessionDir>/pi-async/<sessionId>`, or undefined when the host exposes no
 * session directory (degraded hosts, factory-time calls) so the caller can
 * fall back to the library default. Nothing is created here — the registry
 * creates directories lazily on first persist/configure (D-04).
 */
function sessionDataDir(ctx?: { sessionManager?: SessionManagerLike }): string | undefined {
  const dir = ctx?.sessionManager?.getSessionDir?.();
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof dir !== "string" || dir.length === 0) return undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return join(dir, "pi-async", sessionId);
}

/** Library fallback when no session directory is available: per-process `~/.pi/async/<pid>`. */
function fallbackDataDir(): string {
  return join(homedir(), ".pi", "async", String(process.pid));
}

/**
 * Previous init generation. Retired (guard disposed, registry suspended — never
 * killed) at the start of the next init: `/reload` must be able to adopt the
 * running tasks, and a timer that outlives the invalidated ctx would crash the
 * whole process (#44 / crash 2026-10-21). Killing is reserved for
 * `session_shutdown` with quit/new/fork.
 */
let activeRegistry: TaskRegistry | undefined;

/** Previous generation's settle guard; disposed up front instead of trusting a teardown event. */
let activeGuard: SettleGuard | undefined;

/** Previous generation's context nudges (tool_result / context hooks); released like the guard. */
let activeNudges: (() => void) | undefined;

/** Previous generation's settle hold (PLAN-HOLD D-1); released up front like the guard. */
let activeHold: (() => void) | undefined;

/**
 * S7 (0.4.2) hardening: true while `init()` is awaiting the previous generation's `suspend()`.
 *
 * Between clearing `activeRegistry` and that await completing, "no live generation + a retired
 * instance" is momentarily true — exactly the shape `ensureConfigured` revives on, so a lifecycle
 * event landing in that window could start a second adoption of the same work. `suspend()` has no
 * await points today, so the window cannot currently be entered; this sentinel keeps a future
 * `await` inside it from creating two owners of one data dir.
 */
let suspending = false;

/** One-line card for completion notifications (PLAN §2.8), rendered from message.details. */
function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function firstContentLine(content: unknown): string {
  if (typeof content === "string") {
    return content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
      if (line) return line.trim();
    }
  }
  return "";
}

/**
 * `✓ name (completed, 1.2s) · exit 0` / `✗ name (failed, 1.2s) · exit 7 · kill timeout`.
 * Duration comes from the live snapshot (details does not carry timings); without
 * a snapshot the duration is omitted. Falls back to the message content's first
 * line when the custom message carries no details.
 */
function notificationCard(message: unknown, registry: TaskRegistry): string {
  const details = (message as { details?: unknown })?.details;
  if (!details || typeof details !== "object") {
    return firstContentLine((message as { content?: unknown })?.content) || "async task notification";
  }
  const d = details as { taskId?: unknown; name?: unknown; status?: unknown; exitCode?: unknown; killKind?: unknown; failureKind?: unknown };
  const taskId = typeof d.taskId === "string" ? d.taskId : undefined;
  const snapshot: TaskSnapshot | undefined = taskId ? registry.get(taskId) : undefined;
  const status = typeof d.status === "string" ? d.status : snapshot?.status ?? "unknown";
  const name = typeof d.name === "string" ? d.name : snapshot?.name ?? "async task";
  const finishedAt = snapshot?.finishedAt;
  const duration = finishedAt === undefined ? "" : `, ${formatDuration(finishedAt - (snapshot?.startedAt ?? snapshot?.createdAt ?? finishedAt))}`;
  const parts = [`${status === "completed" ? "✓" : "✗"} ${name} (${status}${duration})`];
  const exitCode = typeof d.exitCode === "number" ? d.exitCode : snapshot?.exitCode;
  if (exitCode !== undefined) parts.push(`exit ${exitCode}`);
  const killKind = typeof d.killKind === "string" ? d.killKind : undefined;
  const failureKind = typeof d.failureKind === "string" ? d.failureKind : undefined;
  if (killKind) parts.push(`kill ${killKind}`);
  else if (failureKind) parts.push(`failure ${failureKind}`);
  return parts.join(" · ");
}

/** Wire the task runtime to the host API, degrading optional Pi features gracefully. */
export async function init(pi: PiCtx): Promise<void> {
  // Retire the previous generation first: dispose its guard and SUSPEND its registry
  // (timers/watches stopped, processes left running) so a /reload can adopt the work
  // from disk. Never kill here — killing is quit/new/fork's job (PLAN §2.8).
  const previousGuard = activeGuard;
  const previousRegistry = activeRegistry;
  const previousNudges = activeNudges;
  const previousHold = activeHold;
  activeGuard = undefined;
  activeRegistry = undefined;
  activeNudges = undefined;
  activeHold = undefined;
  if (previousNudges) {
    try {
      previousNudges();
    } catch (error) {
      console.error("pi-async: previous context nudges disposal during reload failed", error);
    }
  }
  if (previousHold) {
    try {
      previousHold();
    } catch (error) {
      console.error("pi-async: previous settle hold disposal during reload failed", error);
    }
  }
  if (previousGuard) {
    try {
      previousGuard.dispose();
    } catch (error) {
      console.error("pi-async: previous settle guard disposal during reload failed", error);
    }
  }
  if (previousRegistry) {
    // S7 (0.4.2): `ensureConfigured` must not revive the retired instance while this generation is
    // still tearing down — see the `suspending` sentinel. Always reset, even on failure.
    suspending = true;
    try {
      await previousRegistry.suspend();
    } catch (error) {
      console.error("pi-async: previous registry suspension during reload failed", error);
    } finally {
      suspending = false;
    }
  }

  const context = pi as RuntimeContext;
  // The factory creates the registry only — no mkdir, no reloadFromDisk, no timers.
  // Data dir and cwd land in `configure()` on the first session/tool context (D-04).
  // Real pi exposes no sessionManager at factory time, so this is usually the library
  // fallback until the first session ctx arrives (PLAN §2.8: "no sessionManager → fallback").
  const factoryDataDir = sessionDataDir(context) ?? fallbackDataDir();
  const registry = new TaskRegistry({ dataDir: factoryDataDir });
  activeRegistry = registry;
  // CONTRACT §7.1 修订 3: the settle hold and the finalize hook both have to know who owns a
  // terminal event, so they share one relay per generation (`hold-notify.ts`).
  const holdNotify = new HoldNotificationRelay();
  /**
   * CONTRACT §7.2 (0.4.3): a completion decided while this session's run is live is deferred to the
   * run's settle boundary instead of being queued as a `followUp` right away.
   *
   * pi only enqueues a streaming followUp and delivers it after the model stops
   * (`agent-session.js:1959-1962` → `agent-loop.js:196-203`). That is how a task the model had
   * already collected with `async_wait` still produced a second announcement 85–138 s later (session
   * `2026-11-17T02-35-00-296Z_01a1e75b`: wait at 02:57:10 / 02:58:16, notifications at 02:59:23 /
   * 02:59:35, each +9–12 ms after an assistant message stopped). By the boundary, a tool that
   * handed the terminal state to the model has latched `consumedAt`, so the deferred send is a
   * no-op and exactly one consumer won.
   */
  const pendingNotifications = new Map<string, () => void>();
  /** Whether a run is live right now (event-driven: `agent_start` → `agent_settled`). */
  let runActive = false;

  /**
   * §7.2: decide every deferred completion. `sendCompletionNotification` re-checks the consumer
   * latches (`consumedAt`, `notified`, `outputConsumed`), so a task the model already collected is
   * skipped and a task nobody saw is announced exactly once.
   */
  const flushPendingNotifications = (): void => {
    if (pendingNotifications.size === 0) return;
    const queued = [...pendingNotifications.values()];
    pendingNotifications.clear();
    for (const send of queued) {
      try { void send(); } catch { /* send() already reports its own failures */ }
    }
  };
  // NOTE: pi's factory-time ExtensionAPI exposes no `mode`/`ui`/`sessionManager` — those live on
  // event-handler contexts (pi.on("session_start", (event, ctx) => ...)), so data dir, cwd and TUI
  // binding are resolved lazily from the first ctx.
  let configured = false;
  let tui = false;

  /**
   * `configure({dataDir, cwd})` for the generation that is actually alive.
   *
   * Normally this is our own `registry` and the call is one-time. But a tool registration can
   * outlive its generation (the host keeps the first registration while a later `init()` suspends
   * the registry that closure captured), so a call arriving through a stale closure must configure
   * the LIVE registry — otherwise it starts work in the new generation with no data dir or cwd
   * applied. `configure()` is idempotent, so re-entry through a stale closure is harmless.
   *
   * REV-28b (0.4.2): "configured" must not short-circuit a **suspended** instance. When a
   * reload/resume retires this generation and the host never builds a successor, this registry is
   * the only one left; the next `session_start`/`message_start`/ctx-bearing tool call configures it
   * again, which is exactly the revival path (`configure()` re-adopts the persisted work).
   * Registering it as the live generation again also puts the TUI and the resolver back on it.
   */
  const ensureConfigured = (ctx?: { cwd?: string; sessionManager?: SessionManagerLike }): void => {
    // S7 (0.4.2): during another generation's teardown the retired instance is already suspended and
    // `activeRegistry` may already be cleared; configuring here would revive it and let two
    // generations adopt the same work. Do nothing for that window (the next event retries).
    if (suspending) return;
    const target = activeRegistry ?? registry;
    if (target === registry) {
      const retired = registry.isSuspended();
      if (configured && !retired) return;
      configured = true;
      if (retired && activeRegistry === undefined) activeRegistry = registry;
    }
    try {
      target.configure({ dataDir: sessionDataDir(ctx) ?? factoryDataDir, cwd: typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : undefined });
    } catch (error) {
      // configure() is contractually non-throwing (D-05); never let a wiring hiccup break a tool call.
      console.error("pi-async: registry configure failed", error);
    }
  };

  const bindTui = (ctx: unknown): void => {
    if (!bindTuiHost(ctx)) return;
    tui = true;
    initStatus(pi, registry);
    registerRail(pi, registry);
    registerPanelCommands(pi, registry);
  };

  // Lifecycle events: configure → (first only) resend missed notifications, and bind the TUI
  // synchronously on the first TUI-capable ctx (pi exposes ui only on event ctxs).
  //
  // REV-28b (0.4.2): `ensureConfigured` must run on **every** lifecycle event, not only the first one.
  // `startup` is a latch for the one-shot `resendUnnotified` backfill; keeping configure inside it
  // meant the self-heal in REV-28b could only be triggered by a tool call, so a generation that had
  // already seen a `session_start` (every real one) never revived from a session event.
  // `configure()` is idempotent: only first / data-dir-change / revival do any work.
  let startup: Promise<void> | undefined;
  const onLifecycle = (ctx: unknown): Promise<void> => {
    ensureConfigured(ctx as RuntimeContext);
    if (!startup) {
      startup = (async () => {
        try {
          await registry.resendUnnotified();
        } catch (error) {
          console.error("pi-async: re-sending missed notifications failed", error);
        }
      })();
    }
    bindTui(ctx);
    return startup;
  };

  registry.setEvents({
    onFinalize: (snapshot) => {
      clearTaskActivity(pi, snapshot.taskId);
      reportActivity(pi, registry.activeCount());
      if (tui) initStatus(pi, registry);
      if (snapshot.metadata.notifyOnCompletion === false) return;
      let outputTail = "";
      let truncated = false;
      try {
        const logSlice = registry.logs(snapshot.taskId, { maxBytes: 8192, tail: true });
        outputTail = logSlice.text;
        truncated = logSlice.truncated;
      } catch (error) {
        // Out-of-dataDir outputFile (D-11) must not crash finalization or the notification path.
        console.error(`pi-async: could not read output for ${snapshot.taskId}`, error);
      }
      const outputFile = String(snapshot.metadata.outputFile ?? "");
      // `lost` = adopted after /reload but the exit status was never observed; saying only "failed"
      // would misreport a normal reload ending. `startError` (W1a) explains a failed spawn/delayed start.
      const startError = typeof snapshot.metadata.startError === "string" && snapshot.metadata.startError.length > 0
        ? snapshot.metadata.startError
        : undefined;
      // S5 (0.4.2): a `delayed` task that never started has no process whose exit could be unknown
      // and no output to inspect — both the "lost" note and the "read the logs" hint would be wrong.
      const lostBeforeStart = snapshot.failureKind === "lost" && snapshot.mode === "delayed" && snapshot.startedAt === undefined;
      const failureNotes: string[] = [];
      if (snapshot.failureKind === "lost") {
        failureNotes.push(lostBeforeStart
          ? "Delayed task was lost before it started; it never ran and produced no output."
          : "Exit status unknown after session reload; output may be incomplete.");
      }
      if (startError !== undefined) failureNotes.push(`Start error: ${startError}`);
      if (snapshot.status === "failed" && !lostBeforeStart) failureNotes.push(`Inspect task output with async_logs (taskId: ${snapshot.taskId}).`);
      // D-C8: a timeout kill is `killed`, not `failed`, but it is the case that most needs a
      // next step — say what to change instead of leaving the model with a dead end.
      if (snapshot.killKind === "timeout") failureNotes.push("Killed at taskTimeoutMs. Rerun with a larger taskTimeoutMs, or watch for a success_when condition instead of a hard deadline.");
      const guidance = failureNotes.length > 0 ? failureNotes.join(" ") : undefined;
      const payload = {
        taskId: snapshot.taskId,
        name: snapshot.name,
        status: snapshot.status,
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        outputFile,
        ...(outputTail ? { summary: outputTail } : {}),
        ...(guidance ? { guidance } : {}),
        ...(snapshot.killKind ? { killKind: snapshot.killKind } : {}),
        ...(snapshot.failureKind ? { failureKind: snapshot.failureKind } : {}),
        ...(truncated || snapshot.metadata.capped === true ? { summaryTruncated: true } : {}),
      };
      // Honest notification (PLAN §2.4/§2.8): no fake retries here. A failed send keeps
      // notified=false / notifyAttempts>0 in the registry and is re-sent at the next session_start.
      // Delivery channel (0.4.4, CONTRACT §7.2 修订 2): a live run gets `steer`, which the host drains
      // at the *next turn boundary* (`agent-loop.js:191`); `followUp` would wait until the model stops
      // asking for tools (`:197`) — 178 s in session 01a1e7… when the parent kept calling tools.
      // An idle session keeps `followUp` + `triggerTurn`, which starts the wake-up run immediately.
      const send = () => sendCompletionNotification(pi, registry, payload, {
        triggerTurn: snapshot.metadata.triggerOnCompletion !== false,
        deliverAs: runActive ? "steer" : "followUp",
      })
        .then((outcome) => {
          if (outcome === "failed") {
            console.error(`pi-async: completion notification failed for ${snapshot.taskId}; it will be re-sent on the next session_start`);
          }
        })
        .catch((error: unknown) => console.error(`pi-async: completion notification failed for ${snapshot.taskId}`, error));
      // CONTRACT §7.1 修订 3: a hold already waiting for this task reports it in the in-run
      // `async-task-settle-results` entry. pi would deliver this followUp only after the model
      // stops, as an extra turn repeating an outcome the entry already announced — the 0.4.2
      // "late receipt" (session 01a1e5b5 ln393→ln404, 49.6 s). The relay hands it back on every
      // hold exit that does not produce an entry (timeout/dispose), so nothing is lost.
      if (holdNotify.claim(snapshot.taskId, send)) return;
      // §7.2: while a run is live, do not enqueue at finalize — hand the send to the next **turn
      // boundary** (`turn_end` below), where a consumer (wait/status/logs) may already have latched
      // the terminal state. Deferring every completion keeps one rule: the first boundary after the
      // task finishes decides, and `triggerOnCompletion: false` only stops the *idle* wake-up turn.
      if (runActive) {
        pendingNotifications.set(snapshot.taskId, send);
        return;
      }
      void send();
    },
    onStateChange: (snapshot) => {
      const active = registry.activeCount();
      reportActivity(pi, active);
      if (isTerminal(snapshot.status)) clearTaskActivity(pi, snapshot.taskId);
      else raiseTaskActivity(pi, snapshot.taskId);
      if (tui) initStatus(pi, registry);
    },
    // REV-23 (§18.3): the reminder is delivered on the completion channel (followUp + a turn),
    // but it is not a completion — no claim, no `notified` latch, and the registry has already
    // applied §18.2/§18.4/§18.6 before calling this hook. The registry owns the policy; this
    // owns the delivery, exactly like `onFinalize` above.
    onReminder: (snapshot) => {
      if (tui) initStatus(pi, registry);
      void sendReminder(pi, registry, snapshot)
        .then((outcome) => {
          if (outcome === "failed") console.error(`pi-async: reminder delivery failed for ${snapshot.taskId}`);
        })
        .catch((error: unknown) => console.error(`pi-async: reminder delivery failed for ${snapshot.taskId}`, error));
    },
  });

  // REV-24: the resolver, not the captured instance, so a registration the host kept from a
  // retired generation still reaches the live one. `activeRegistry` is cleared on shutdown, and
  // the fallback then reports the retired registry's own (actionable) admission error.
  if (typeof context.registerTool === "function") registerTools(pi, () => activeRegistry ?? registry, ensureConfigured);

  // Discoverability layer (PLAN-CONTEXT §D-C4/§D-C5): post-hoc advice after long foreground
  // bash calls, plus one live task-state line before each request while work is in flight.
  activeNudges = registerNudges(pi, registry);
  // D-C7: the procedural playbook (checks, watch semantics, promotion) ships as a skill so the
  // system prompt keeps one routing line instead of a wall of instructions.
  registerSkillDiscovery(pi);

  // Completion notification card (PLAN §2.8). Local component implementation: the TUI lane owns
  // src/tui/*, so this renderer must not import from there.
  if (typeof context.registerMessageRenderer === "function") {
    context.registerMessageRenderer("async-task-notification", (message: unknown) => ({
      render: () => [notificationCard(message, registry)],
      invalidate: () => undefined,
    }));
  }

  if (typeof context.on === "function") {
    context.on("session_start", (_event: unknown, ctx: unknown) => onLifecycle(ctx));
    context.on("message_start", (_event: unknown, ctx: unknown) => onLifecycle(ctx));

    // §7.2: the run is over — every deferred completion is decided now. `agent_settled` fires after
    // the boundary, so this also covers a task that finished between the last boundary and settle.
    context.on("agent_start", () => { runActive = true; });
    context.on("agent_settled", () => { runActive = false; flushPendingNotifications(); });

    // PLAN-HOLD D-1: the hold registers BEFORE the guard, so the settle boundary waits first and
    // the guard's advisory still runs afterwards on the same boundary. The relay is what lets the
    // hold own the completion of a task that finishes inside that wait (CONTRACT §7.1 修订 3).
    activeHold = registerHold(pi, registry, { notify: holdNotify });
    // §7.2 (0.4.4): the turn boundary is the earliest honest delivery point — the host drains the
    // steering queue right after `turn_end` (`agent-loop.js:188-199`), so a steer queued here reaches
    // the very next request instead of waiting for the model to stop calling tools.
    context.on("turn_end", () => { flushPendingNotifications(); return undefined; });
    // §7.2: registered AFTER the hold, so a task the results entry owns is already latched
    // `notified` and this flush skips it. Runs before the guard (which only reads active tasks).
    context.on("agent_before_settle", () => { flushPendingNotifications(); return undefined; });
    // agent_settled / agent_before_settle are registered by SettleGuard itself.
    activeGuard = new SettleGuard(pi, registry);
    activeGuard.register();
  }

  let shutdownPromise: Promise<void> | undefined;
  if (typeof context.on === "function") {
    context.on("session_shutdown", async (event: unknown) => {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          // §7.2: a deferred completion is dropped here on purpose (not sent): the generation is
          // tearing down, `notified` stays false, and the next `session_start` retries it via
          // `resendUnnotified` instead of racing a dead host.
          pendingNotifications.clear();
          runActive = false;
          // D-16 / PLAN §2.8: reload + resume suspend (next generation adopts from disk);
          // quit/new/fork (and an unknown/undefined reason) shut down and kill.
          const reason = (event as { reason?: string } | undefined)?.reason;
          const suspendOnly = reason === "reload" || reason === "resume";
          if (activeRegistry === registry) activeRegistry = undefined;
          try {
            if (suspendOnly) await registry.suspend();
            else await registry.shutdown();
          } catch (error) {
            console.error(`pi-async: session shutdown (${String(reason ?? "unknown")}) failed`, error);
          }
        })();
      }
      await shutdownPromise;
    });
  }
}

export default init;
