import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTaskActivity, raiseTaskActivity, reportActivity } from "../src/core/bus.ts";
import { sendCompletionNotification } from "../src/core/notify.ts";
import { registerNudges } from "../src/context/nudges.ts";
import { registerSkillDiscovery } from "../src/context/resources.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { isTerminal, type TaskSnapshot } from "../src/core/task.ts";
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
  activeGuard = undefined;
  activeRegistry = undefined;
  activeNudges = undefined;
  if (previousNudges) {
    try {
      previousNudges();
    } catch (error) {
      console.error("pi-async: previous context nudges disposal during reload failed", error);
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
    try {
      await previousRegistry.suspend();
    } catch (error) {
      console.error("pi-async: previous registry suspension during reload failed", error);
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
  // NOTE: pi's factory-time ExtensionAPI exposes no `mode`/`ui`/`sessionManager` — those live on
  // event-handler contexts (pi.on("session_start", (event, ctx) => ...)), so data dir, cwd and TUI
  // binding are resolved lazily from the first ctx.
  let configured = false;
  let tui = false;

  /** One-time `configure({dataDir, cwd})` from whatever ctx is available (session event or tool call). */
  const ensureConfigured = (ctx?: { cwd?: string; sessionManager?: SessionManagerLike }): void => {
    if (configured) return;
    configured = true;
    try {
      registry.configure({ dataDir: sessionDataDir(ctx) ?? factoryDataDir, cwd: typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : undefined });
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

  // First session_start / message_start: configure → resend missed notifications, and bind
  // the TUI synchronously on the first TUI-capable ctx (pi exposes ui only on event ctxs).
  // Idempotent: repeated events neither re-configure nor re-send.
  let startup: Promise<void> | undefined;
  const onLifecycle = (ctx: unknown): Promise<void> => {
    if (!startup) {
      ensureConfigured(ctx as RuntimeContext);
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
      const failureNotes: string[] = [];
      if (snapshot.failureKind === "lost") failureNotes.push("Exit status unknown after session reload; output may be incomplete.");
      if (startError !== undefined) failureNotes.push(`Start error: ${startError}`);
      if (snapshot.status === "failed") failureNotes.push(`Inspect task output with async_logs (taskId: ${snapshot.taskId}).`);
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
      void sendCompletionNotification(pi, registry, payload, { triggerTurn: snapshot.metadata.triggerOnCompletion !== false })
        .then((outcome) => {
          if (outcome === "failed") {
            console.error(`pi-async: completion notification failed for ${snapshot.taskId}; it will be re-sent on the next session_start`);
          }
        })
        .catch((error: unknown) => console.error(`pi-async: completion notification failed for ${snapshot.taskId}`, error));
    },
    onStateChange: (snapshot) => {
      const active = registry.activeCount();
      reportActivity(pi, active);
      if (isTerminal(snapshot.status)) clearTaskActivity(pi, snapshot.taskId);
      else raiseTaskActivity(pi, snapshot.taskId);
      if (tui) initStatus(pi, registry);
    },
  });

  if (typeof context.registerTool === "function") registerTools(pi, registry, ensureConfigured);

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

    // agent_settled / agent_before_settle are registered by SettleGuard itself.
    activeGuard = new SettleGuard(pi, registry);
    activeGuard.register();
  }

  let shutdownPromise: Promise<void> | undefined;
  if (typeof context.on === "function") {
    context.on("session_shutdown", async (event: unknown) => {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
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
