import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";
import { formatElapsedMs } from "../core/duration.ts";

/**
 * Discoverability layer (PLAN-CONTEXT §D-C4/§D-C5).
 *
 * Snippets in the system prompt are static: they can say *what* the tools do, never *what is
 * true right now*. These two nudges close that gap at the only two places a model actually
 * decides:
 *
 *  - `tool_result` after a long foreground `bash` call — the model's own evidence sits right
 *    next to the nudge, so it learns the alternative where the mistake happened;
 *  - the request context before each provider call — one line of live task state, injected
 *    only while work is in flight (idle sessions pay zero tokens).
 *
 * Every hook is best-effort: a nudge is advice, never a tool failure and never a thrown error.
 */

/** A foreground call at or above this wall time is cheaper to run detached next time. */
const LONG_FOREGROUND_SECONDS = 60;

/** Task rows per async-state line; the rest collapse into `+K more`. */
const DEFAULT_MAX_TASKS = 5;

/** Commands that are structurally long-lived even when their wall time is short (yet). */
const LONG_COMMAND_PATTERN = /\btail\s+-[fF]\b|\buntil\s|\bwatch\s+\S|\bsleep\s+\d{2,}/;

/** `true` when the command shape alone says "this will wait" (exported for the adoption report). */
export function isLongShapedCommand(command: string): boolean {
  return LONG_COMMAND_PATTERN.test(command);
}

/** `PI_ASYNC_NUDGE=0` disarms every nudge in this module. */
const nudgesDisabled = (): boolean => process.env.PI_ASYNC_NUDGE === "0";

/**
 * One-line advice after a long foreground shell call, or undefined when the call was quick
 * and did not look like a watcher. Text is frozen by PLAN-CONTEXT §D-C4 (tests assert it).
 */
export function bashNudge(input: { command: string; wallTimeSeconds?: number }): string | undefined {
  const raw = input.wallTimeSeconds;
  const seconds = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : undefined;
  // Threshold uses the raw value: rounding 59.6 up to "60s" must not trigger the nudge.
  const overBudget = typeof raw === "number" && Number.isFinite(raw) && raw >= LONG_FOREGROUND_SECONDS;
  if (!overBudget && !isLongShapedCommand(input.command)) return undefined;
  // A host that reports no wall time still gets the advice, just without the duration claim.
  const prefix = seconds === undefined ? "" : `took ${seconds}s in the foreground; `;
  return `(${prefix}async_run could have run it in the background — use mode=background with watch for servers/builds, or mode=sync with timeoutMs when you need the result soon)`;
}

/**
 * Whether a task's completion will actually wake the model: both the message and its
 * turn-triggering must be on. This is a per-task fact, never an assumption.
 */
function wakesYou(task: TaskSnapshot): boolean {
  return task.metadata.notifyOnCompletion !== false && task.metadata.triggerOnCompletion !== false;
}

/**
 * One line describing in-flight tasks, or undefined when there are none (zero-cost idle).
 * Shape is frozen by PLAN-CONTEXT §D-C5 (tests assert it). The closing sentence follows what is
 * actually true for these tasks: a task started with notifications off cannot wake anyone, so
 * claiming otherwise would be the same class of lie the 0.3.0 review was about.
 */
export function asyncStateLine(tasks: TaskSnapshot[], now: number, max: number = DEFAULT_MAX_TASKS): string | undefined {
  if (tasks.length === 0) return undefined;
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : DEFAULT_MAX_TASKS;
  const shown = tasks.slice(0, limit);
  const items = shown
    .map((task) => {
      const elapsed = formatElapsedMs(now - (task.startedAt ?? task.createdAt));
      const quiet = wakesYou(task) ? "" : ", no-notify";
      return `${task.name ?? task.taskId} (${task.status}, ${elapsed}${quiet})`;
    })
    .join(" · ");
  const hidden = tasks.length - shown.length;
  const more = hidden > 0 ? ` +${hidden} more` : "";
  const wakeable = tasks.filter(wakesYou).length;
  const tail = wakeable === 0
    ? "— none of these will notify you; collect them with async_wait before you need the result."
    : wakeable === tasks.length
      ? "— end the turn and the completion notification wakes you, or call async_wait if you need one now."
      : "— end the turn and let notifications wake you where enabled, or call async_wait for the rest.";
  return `<async-state>${tasks.length} async task(s) active: ${items}${more} ${tail}</async-state>`;
}

/** Structural view of the pi hooks this module needs (same feature-detected style as SettleGuard). */
type HostHooks = {
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  off?: (event: string, handler: (...args: unknown[]) => unknown) => void;
};

type ToolResultSlice = {
  toolName?: unknown;
  toolCallId?: unknown;
  input?: { command?: unknown };
  content?: unknown[];
  structuredContent?: unknown;
};

type ContextSlice = { messages?: unknown[] };

/**
 * Register both nudges and return an idempotent disposer.
 *
 * `context_with_system` is the 1.5 hook that may rewrite the message list per request; older
 * hosts expose plain `context`. The fallback is chosen at registration time so a host never
 * gets both.
 */
export function registerNudges(pi: PiCtx, registry: TaskRegistry, opts?: { max?: number }): () => void {
  if (nudgesDisabled()) return () => undefined;
  // SAFETY: PiCtx hooks vary by runtime; `on` is probed rather than assumed (degraded hosts).
  const hooks = pi as unknown as HostHooks;
  if (typeof hooks.on !== "function") return () => undefined;

  const max = opts?.max ?? DEFAULT_MAX_TASKS;
  const unsubscribers: Array<() => void> = [];
  // Fallback clock: `tool_result` fires inside afterToolCall, BEFORE `tool_execution_end`, so
  // durationMs is not available yet. Start timestamps keyed by toolCallId are the only honest
  // source when the host drops `structuredContent.wall_time_seconds`.
  const startedAt = new Map<string, number>();
  let disposed = false;
  let lastSignature: string | undefined;

  const rememberStart = (event?: unknown): void => {
    try {
      const slice = event as { toolCallId?: unknown; toolName?: unknown } | undefined;
      if (typeof slice?.toolCallId !== "string" || slice.toolName !== "bash") return;
      if (startedAt.size > 128) startedAt.clear();
      startedAt.set(slice.toolCallId, Date.now());
    } catch { /* best effort */ }
  };

  const forgetEnd = (event?: unknown): void => {
    try {
      const slice = event as { toolCallId?: unknown } | undefined;
      if (typeof slice?.toolCallId === "string") startedAt.delete(slice.toolCallId);
    } catch { /* best effort */ }
  };

  const listen = (event: string, handler: (...args: unknown[]) => unknown): void => {
    const result = hooks.on?.(event, handler);
    // SAFETY: pi.on() returns an unsubscribe function; older/mocked hosts may return void.
    if (typeof result === "function") unsubscribers.push(result as () => void);
    else unsubscribers.push(() => hooks.off?.(event, handler));
  };

  const onToolResult = (event?: unknown): unknown => {
    if (disposed) return undefined;
    try {
      const slice = event as ToolResultSlice | undefined;
      if (slice?.toolName !== "bash") return undefined;
      const structured = (slice.structuredContent ?? undefined) as { wall_time_seconds?: unknown } | undefined;
      let wall = typeof structured?.wall_time_seconds === "number" ? structured.wall_time_seconds : undefined;
      // Fallback: elapsed since tool_execution_start (rounded by bashNudge).
      if (wall === undefined && typeof slice.toolCallId === "string") {
        const started = startedAt.get(slice.toolCallId);
        if (started !== undefined) wall = (Date.now() - started) / 1000;
      }
      if (typeof slice.toolCallId === "string") startedAt.delete(slice.toolCallId);
      const nudge = bashNudge({
        command: typeof slice.input?.command === "string" ? slice.input.command : "",
        ...(wall === undefined ? {} : { wallTimeSeconds: wall }),
      });
      if (!nudge) return undefined;
      const content = Array.isArray(slice.content) ? slice.content : [];
      // Replacing content without structuredContent would drop it (host contract), so keep it.
      return {
        content: [...content, { type: "text", text: nudge }],
        ...(slice.structuredContent === undefined ? {} : { structuredContent: slice.structuredContent }),
      };
    } catch {
      return undefined;
    }
  };

  const onContext = (event?: unknown): unknown => {
    if (disposed) return undefined;
    try {
      const tasks = registry.list({ includeHistory: false });
      const now = Date.now();
      const line = asyncStateLine(tasks, now, max);
      if (!line) return undefined;
      // Re-inject only when the live set changed (task ids/statuses). Elapsed is deliberately
      // excluded: it ticks every second and would turn the line into per-request chatter.
      const signature = `${tasks.length}:${tasks.map((task) => `${task.taskId}/${task.status}`).join(",")}`;
      if (signature === lastSignature) return undefined;
      lastSignature = signature;
      const messages = Array.isArray((event as ContextSlice | undefined)?.messages) ? (event as ContextSlice).messages! : [];
      // UserMessage requires a timestamp (pi-ai types), not just role+content: a missing one
      // becomes `undefined` downstream and can break ordering/rendering on the real host.
      return { messages: [...messages, { role: "user", content: line, timestamp: Date.now() }] };
    } catch {
      return undefined;
    }
  };

  const onAgentStart = (): void => {
    // A new run re-arms the state line: the model should see live state again, even if unchanged.
    lastSignature = undefined;
  };

  listen("tool_execution_start", rememberStart);
  listen("tool_execution_end", forgetEnd);
  listen("tool_result", onToolResult);
  listen("context_with_system", onContext);
  listen("context", onContext);
  listen("agent_start", onAgentStart);

  return () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* best effort: the host ctx may already be stale */ }
    }
  };
}
