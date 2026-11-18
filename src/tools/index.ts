import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { isTaskStatus, isTerminal, TASK_STATUSES, type TaskSnapshot, type TaskStatus, type WatchSpec } from "../core/task.ts";

/**
 * Structural view of pi's event-handler context (`ExtensionToolContext`).
 *
 * 0.3.0 deliberately does NOT import pi's `ExtensionToolContext` type: the
 * package keeps its type baseline at pi 1.2.0, where the 5th `execute`
 * argument existed but surface details moved between 1.2 and 1.5. Only `cwd`
 * (session working directory) and `sessionManager` (data-dir resolution) are
 * read, so a structural type is enough and stays compatible across hosts.
 */
export interface ToolContext {
  cwd?: string;
  sessionManager?: {
    getSessionDir?: () => string;
    getSessionId?: () => string;
  };
}

/**
 * Wrap an extension-tool return value into pi's ToolResultMessage shape.
 *
 * pi 1.2.0 does NOT auto-wrap extension tool return values (the executor
 * passes `await tool.execute(...)` through verbatim; only builtin tools
 * return `{content:[{type:"text",...}]}`). A bare object without `content`
 * crashes the TUI's ToolExecutionComponent.getTextOutput
 * (`result.content.filter` on undefined) and persists as content:[] —
 * see the user-reported uncaughtException on 2026-10-15.
 *
 * Every async_* tool MUST route its return value through this helper so the
 * result satisfies the ToolResultMessage contract: content is an array of
 * typed blocks, and the original payload rides along in `details` for tests
 * and structured consumers.
 */
function toolResult(payload: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; details: unknown; isError: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: { payload }, isError };
}

/**
 * `async_wait` is **not** registered by default (D4, 0.5.0): the wait primitive is opt-in for hosts
 * that want a blocking collect step (`PI_ASYNC_EXPOSE_WAIT=1`). The default tool surface is five.
 */
export const WAIT_TOOL = "async_wait";

/**
 * Whether this session exposes `async_wait`. Read on **every** call — never cached at module load —
 * so a reload (or a test toggling the env between registration and use) is honoured immediately.
 */
export function waitToolExposed(): boolean {
  return process.env.PI_ASYNC_EXPOSE_WAIT === "1";
}

/**
 * Degraded `async_wait` result (D4): a registration from an older session (or a host that kept a
 * first-wins registration) can still be invoked after the env stopped exposing the tool. That call
 * must not throw and must not silently look like a real timeout — it reports why and how to enable.
 */
export const WAIT_UNAVAILABLE = "async_wait is not available in this configuration (it is not registered by default; set PI_ASYNC_EXPOSE_WAIT=1 and reload the session to expose it). Use async_status and async_logs instead.";

/** Copy that mentions `async_wait` only when this session really exposes it (D4/D6). */
const waitMention = (exposed: string, otherwise: string): string => (waitToolExposed() ? exposed : otherwise);

/**
 * Per-call notification exception (PLAN-CONTEXT §D-C5, revised).
 *
 * The general rule ("a completion notification wakes you") lives in the system prompt and in the
 * `<async-state>` line; repeating it in every receipt would bill the same sentence on every call.
 * Only the exception is per-call truth, so only the exception is reported here.
 *
 * D4 (0.5.0): the hint may not advertise `async_wait` when the session does not expose it; the
 * fallback points at the always-registered readers instead.
 */
function notificationException(params: Record<string, unknown>): { willNotify?: false; willWake?: false; hint: string } | undefined {
  if (params.notifyOnCompletion === false) {
    return {
      willNotify: false,
      hint: waitMention(
        "Notifications are off for this task; collect it with async_wait or async_logs.",
        "Notifications are off for this task; collect it with async_logs.",
      ),
    };
  }
  if (params.triggerOnCompletion === false) {
    return {
      willWake: false,
      hint: waitMention(
        "This task will notify but will not start a new turn; collect it with async_wait if you need the result now.",
        "This task will notify but will not start a new turn; collect it with async_logs if you need the result now.",
      ),
    };
  }
  return undefined;
}

const MAX_LOG_BYTES = 50 * 1024;

/**
 * "Told once, to exactly one consumer" (CONTRACT §7.2, 0.4.3).
 *
 * A tool that puts a **terminal** snapshot in front of the model claims that task's single
 * announcement: `onFinalize` will not send a completion notification for it, and `resendUnnotified`
 * will not replay one later. Only terminal rows are latched — reading partial output of a running
 * task (or listing it as `running`) must never silence its completion. Failures are swallowed: a
 * tool call must not fail because the latch could not be persisted.
 */
function consumeTerminal(registry: TaskRegistry, snapshots: Array<{ taskId: string; status: TaskStatus }>): void {
  for (const snapshot of snapshots) {
    if (!isTerminal(snapshot.status)) continue;
    try { registry.markConsumed(snapshot.taskId); } catch { /* best effort: the tool result still stands */ }
  }
}

const MAX_STATUS_LIMIT = 50;
const DEFAULT_STATUS_LIMIT = 50;

/**
 * One-line snippets shown in the default system prompt's "Available tools" section (D-C1).
 *
 * The host only lists tools that carry a `promptSnippet`, so every registered tool must have one —
 * five by default, six when `PI_ASYNC_EXPOSE_WAIT=1` also registers `async_wait` (D4) — each is
 * single-line and <=140 chars because the host squeezes it into a bullet line.
 */
const PROMPT_SNIPPETS = {
  async_run: "Run a long or gating shell command detached (build/test over a minute, server, watcher); returns a taskId, not output.",
  async_wait: "Block until async tasks finish or the budget expires; results land in context. Never kills.",
  async_logs: "Read the bounded, ANSI-stripped output of an async task, including while it is still running.",
  async_status: "List active async tasks with elapsed time; includeHistory for recent finished ones.",
  async_kill: "Stop an async task and its whole process group.",
  async_extend: "Renew a running task: move its reminder and/or hard-timeout deadline. Never kills; use async_kill to stop.",
} as const;

/**
 * The four always-on guidelines (D-C3 + D-34), verbatim and in order. The fifth one is appended only
 * while `async_wait` is not exposed (D4): the prompt must never sell a tool this session lacks.
 */
const ASYNC_RUN_PROMPT_GUIDELINES = [
  "Reach for async_run before bash when a command may outlive ~60s or never exit (builds, test suites, dev servers, watchers, network waits); quick file operations stay in bash.",
  "Do not sit in async_wait only to end a turn: if you do not need the result yet, end the turn and the completion notification wakes you. In a legion child, collect with async_wait before returning a verdict.",
  "Pass name so later calls address the task by name, and read output with async_logs (works while running) instead of re-running the command.",
  "Plan the batch first: launch independent long commands together (several async_run calls in one message) and collect them with a single async_wait later.",
];

/** Appended as the fifth guideline when `async_wait` is not registered (D4). */
const WAIT_UNAVAILABLE_GUIDELINE = "async_wait is not available in this session (set PI_ASYNC_EXPOSE_WAIT=1 to expose it); end the turn and the completion notification wakes you, and read output with async_logs.";

/** The guideline list the host sees: four frozen lines, plus the no-wait note when it applies. */
function asyncRunGuidelines(): string[] {
  return waitToolExposed() ? [...ASYNC_RUN_PROMPT_GUIDELINES] : [...ASYNC_RUN_PROMPT_GUIDELINES, WAIT_UNAVAILABLE_GUIDELINE];
}

const schema = (properties: Record<string, unknown>, required: string[] = [], allOf: unknown[] = []) => ({ type: "object", properties, required, additionalProperties: false, ...(allOf.length ? { allOf } : {}) });
const stringField = { type: "string" };
const timeoutField = { type: "number", minimum: 0 };
/** `async_run` fields that carry their own description instead of the bare `stringField` (D-C2). */const commandField = { type: "string", description: "Shell command to execute (/bin/sh -c) in the session cwd." };
const nameField = { type: "string", description: "Short handle for later async_logs/async_kill calls (max 48 chars)." };
const conditionSchema = {
  oneOf: [
    { type: "object", properties: { type: { const: "exit_code" }, equals: { type: "number", description: "Exit code that matches; evaluated only once the process has exited." } }, required: ["type", "equals"], additionalProperties: false },
    ...["stdout_contains", "stderr_contains"].map((type) => ({ type: "object", properties: { type: { const: type }, value: { type: "string", description: "Literal substring — no regex syntax, so no escaping needed." } }, required: ["type", "value"], additionalProperties: false })),
    { type: "object", properties: {
      type: { const: "json_path_exists" },
      path: { type: "string", pattern: "^\\$", description: "JSONPath rooted at $; e.g. $.ready or $.items[0].state (bare names like \"ready\" are rejected)" },
    }, required: ["type", "path"], additionalProperties: false },
    { type: "object", properties: {
      type: { const: "output_matches" },
      regex: { type: "string", description: "JavaScript regex, compiled with the m flag only. Inline flags such as (?i) are rejected at validation — use a character class for case-insensitivity." },
    }, required: ["type", "regex"], additionalProperties: false },
  ],
};
const watchSchema = {
  type: "object", properties: {
    intervalMs: { type: "number", minimum: 1000, description: "Poll interval in ms; required, at least 1000." },
    timeoutMs: { type: "number", minimum: 1, description: "Watch deadline in ms from start; required. On expiry the task is marked failed and its process group is killed — use taskTimeoutMs to bound process lifetime instead." },
    success_when: { type: "array", items: conditionSchema, description: "OR-ed: the first match marks the task completed and leaves the process running." },
    failure_when: { type: "array", items: conditionSchema, description: "OR-ed: the first match marks the task failed and kills the process group." },
    blind_checks: { type: "number", minimum: 1, description: "Consecutive infrastructure failures tolerated before the watch gives up (default 3). Only unreadable output or a malformed check counts; 'not yet decidable' is pending and never accumulates." },
  }, required: ["intervalMs", "timeoutMs", "success_when", "failure_when"], additionalProperties: false,
  description: "Poll output (>=1s) for success_when/failure_when; conditions are OR-ed, first match wins, and checks must not swallow errors (no `|| true`).",
};

/** Number of the clamped `async_status` limit: default 50, clamped to 1–50 (D-08). */
function clampStatusLimit(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_STATUS_LIMIT;
  return Math.min(MAX_STATUS_LIMIT, Math.max(1, Math.floor(raw)));
}

/**
 * `async_status` redaction (PLAN §2.7): `metadata.delayedEnv` values become
 * `"***"` while keys survive. Returns a shallow copy — the registry's live
 * snapshot must never be mutated by a read-only tool.
 */
function redactSnapshot(task: TaskSnapshot): TaskSnapshot {
  const metadata = { ...task.metadata };
  const delayedEnv = metadata.delayedEnv;
  if (delayedEnv && typeof delayedEnv === "object" && !Array.isArray(delayedEnv)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(delayedEnv as Record<string, unknown>)) redacted[key] = "***";
    metadata.delayedEnv = redacted;
  }
  return { ...task, metadata };
}

/** Descending by `finishedAt ?? createdAt` (D-08 history ordering). */
function byRecency(a: TaskSnapshot, b: TaskSnapshot): number {
  return (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
}

/** Elapsed run time: live tasks count to now, terminal ones to their finish (REV-23 §18.7 report field). */
function elapsedMsOf(task: TaskSnapshot, now = Date.now()): number {
  return Math.max(0, (task.finishedAt ?? now) - (task.startedAt ?? task.createdAt));
}

/**
 * Register the async tool surface: five tools by default, six when `PI_ASYNC_EXPOSE_WAIT=1` adds
 * `async_wait` (D4, 0.5.0).
 *
 * `ensureConfigured` lets the extension wire a lazy, once-only
 * `registry.configure({dataDir, cwd})` before the first tool call — tools may
 * run before `session_start` (e.g. an immediate tool call), and the registry
 * then still needs its session cwd/dataDir (PLAN §2.8). Tools stay usable
 * without it (tests, direct embedding).
 */
export function registerTools(pi: PiCtx, registrySource: TaskRegistry | (() => TaskRegistry), ensureConfigured?: (ctx?: ToolContext) => void): void {
  type ToolDef = {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: ToolContext) => Promise<unknown>;
  };
  // SAFETY: ExtensionAPI exposes registerTool at runtime; this local structural view keeps schemas dependency-free.
  const api = pi as unknown as { registerTool?: (tool: ToolDef) => void };
  if (!api.registerTool) throw new Error("Pi host does not expose registerTool");
  const configure = (ctx?: ToolContext): void => ensureConfigured?.(ctx);
  /**
   * Resolve the registry **at call time**, not at registration time.
   *
   * A tool registration can outlive its generation: the host keeps the first registration for a
   * tool name (first-wins across extensions) while a later `init()` suspends the registry the
   * original closure captured. That combination used to route every call into a retired registry,
   * so `async_run` refused admission forever with no way out but a session restart.
   * Passing the live registry as a resolver lets such a call reach the generation that owns the
   * work; passing a plain registry keeps the old behaviour for embedders and tests.
   */
  const resolveRegistry: () => TaskRegistry = typeof registrySource === "function" ? registrySource : () => registrySource;

  api.registerTool({
    name: "async_run", label: "Run async command",
    description: "Run a shell command as a managed async task. mode=background (default) returns a taskId immediately; mode=delayed starts after delayMs.",
    promptSnippet: PROMPT_SNIPPETS.async_run,
    promptGuidelines: asyncRunGuidelines(),
    // Mode-conditional required fields + mode-scoped rejects enforced in execute (#45/#42),
    // not allOf/then (host validator emits opaque "must match then schema").
    // D3 (0.5.0): the blocking mode is gone — with `additionalProperties: false`, a host still passing
    // either retired knob is rejected by the schema instead of being silently ignored.
    parameters: schema({
      command: commandField, name: nameField,
      mode: { type: "string", enum: ["background", "delayed"], default: "background", description: "background (default) returns a taskId now; delayed starts after delayMs." },
      delayMs: { type: "number", minimum: 0, description: "delayed only: milliseconds to wait before starting." },
      taskTimeoutMs: { type: "number", minimum: 0, description: "Kill the task after this many ms, in any mode." },
      remindAfterMs: { type: "number", minimum: 0, description: "Remind me once the task has run this many ms (backs off 2x, at most 3 times; never kills). 0 disables; default is 20 minutes, or off when watch is set." },
      notifyOnCompletion: { type: "boolean", description: "Send a completion notification (default true)." },
      triggerOnCompletion: { type: "boolean", description: "Start a new turn when the task finishes (default true)." },
      env: { type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables for the child process (safe policy applied)." },
      watch: watchSchema,
    }, ["command"]),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
      const registry = resolveRegistry();
      const mode = String(params.mode ?? "background");
      if (mode !== "background" && mode !== "delayed") throw new Error(`Unsupported async_run mode: ${mode}`);
      const command = String(params.command ?? "");
      if (mode === "delayed" && params.delayMs === undefined) throw new Error("delayMs is required for delayed mode (milliseconds, e.g. 60000 for one minute)");
      if (mode !== "delayed" && params.delayMs !== undefined) throw new Error('delayMs is only valid for delayed mode (pass mode: "delayed" to schedule it, or omit delayMs)');
      const options = {
        command,
        cwd: sessionCwd(ctx),
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        ...(typeof params.taskTimeoutMs === "number" ? { taskTimeoutMs: params.taskTimeoutMs } : {}),
        ...(typeof params.remindAfterMs === "number" ? { remindAfterMs: params.remindAfterMs } : {}),
        ...(typeof params.notifyOnCompletion === "boolean" ? { notifyOnCompletion: params.notifyOnCompletion } : {}),
        ...(typeof params.triggerOnCompletion === "boolean" ? { triggerOnCompletion: params.triggerOnCompletion } : {}),
        ...(params.env && typeof params.env === "object" ? { env: params.env as Record<string, string> } : {}),
        ...(params.watch && typeof params.watch === "object" ? { watch: params.watch as WatchSpec } : {}),
      };
      const task = mode === "delayed"
        ? registry.scheduleDelayed(options, Number(params.delayMs))
        : registry.submit({ ...options, mode: "background" });
      const note = notificationException(params);
      return toolResult({
        taskId: task.taskId,
        name: task.name,
        status: task.status,
        mode: task.mode,
        ...(note?.willNotify === false ? { willNotify: false } : {}),
        ...(note?.willWake === false ? { willWake: false } : {}),
        outputHint: note?.hint ?? `Use async_logs with taskId ${task.taskId} to inspect early output.`,
      });
    },
  });
  // D4 (0.5.0): `async_wait` is opt-in — the default surface (including headless) is five tools.
  // A stale registration from an older session still resolves, but its execute reports why and how
  // to enable it instead of blocking (see WAIT_UNAVAILABLE).
  if (waitToolExposed()) api.registerTool({
    name: WAIT_TOOL, label: "Wait for async tasks",
    description: "Wait for tasks (taskId or name) to finish or return notReady; waiting does not kill tasks.",
    promptSnippet: PROMPT_SNIPPETS.async_wait,
    parameters: schema({ taskIds: { type: "array", items: stringField }, timeoutMs: timeoutField }, ["taskIds", "timeoutMs"]),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      // Call-time gate (env read per call, never cached): a registration can outlive the env that
      // exposed it. Degrade with a readable reason instead of throwing or blocking forever.
      if (!waitToolExposed()) {
        return toolResult({
          taskId: null,
          available: false,
          error: WAIT_UNAVAILABLE,
          enableWith: "PI_ASYNC_EXPOSE_WAIT=1",
          alternatives: ["async_status", "async_logs"],
        }, true);
      }
      configure(ctx);
      const registry = resolveRegistry();
      if (params.timeoutMs === undefined) throw new Error("timeoutMs is required");
      const taskIds = Array.isArray(params.taskIds) ? params.taskIds.map((id) => registry.resolveTaskId(String(id)).taskId) : [];
      const outcome = await registry.wait(taskIds, Number(params.timeoutMs), signal);
      // CONTRACT §7.2: those terminal rows are in front of the model now — the notification would
      // repeat them (this is the 138 s "late receipt" of 2026-11-17: wait at 02:57:10, notify 02:59:23).
      if ("results" in outcome) consumeTerminal(registry, outcome.results);
      return toolResult(outcome);
    },
  });
  api.registerTool({
    name: "async_logs", label: "Read async output",
    description: "Read bounded, ANSI-stripped task output (taskId or name). stream selects merged/stdout/stderr.",
    promptSnippet: PROMPT_SNIPPETS.async_logs,
    parameters: schema({
      taskId: stringField,
      maxBytes: { type: "number", minimum: 0, maximum: MAX_LOG_BYTES },
      tail: { type: "boolean" },
      stream: { type: "string", enum: ["merged", "stdout", "stderr"], default: "merged" },
    }, ["taskId"]),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
      const registry = resolveRegistry();
      const maxBytes = params.maxBytes === undefined ? MAX_LOG_BYTES : Number(params.maxBytes);
      if (maxBytes > MAX_LOG_BYTES) throw new Error("maxBytes must be at most 50 KiB");
      const stream = params.stream === "stdout" || params.stream === "stderr" ? params.stream : "merged";
      const { taskId } = registry.resolveTaskId(String(params.taskId));
      const slice = registry.logs(taskId, { maxBytes, tail: params.tail !== false, stream });
      // CONTRACT §7.2: reading a finished task's output is a consumer of its terminal event too.
      const snapshot = registry.get(taskId);
      if (snapshot !== undefined) consumeTerminal(registry, [snapshot]);
      return toolResult(slice);
    },
  });
  api.registerTool({
    name: "async_status", label: "Async task status",
    description: "List async tasks and current status. Defaults to active (running/pending) only; pass includeHistory:true (or an explicit status) for up to 50 recent tasks, newest first.",
    promptSnippet: PROMPT_SNIPPETS.async_status,
    parameters: schema({
      includeHistory: { type: "boolean" },
      status: { type: "string", enum: [...TASK_STATUSES, "active"] },
      name: stringField,
      limit: { type: "number", minimum: 1, maximum: MAX_STATUS_LIMIT },
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
      const registry = resolveRegistry();
      const includeHistory = params.includeHistory === true;
      const status: TaskStatus | "active" | undefined = isTaskStatus(params.status) ? params.status : params.status === "active" ? "active" : undefined;
      const name = typeof params.name === "string" && params.name.length > 0 ? params.name : undefined;
      const limit = clampStatusLimit(params.limit);
      const tasks = registry.list({
        // An explicit status promises history visibility (a status filter is a history query).
        includeHistory: includeHistory || status !== undefined,
        ...(status === undefined ? {} : { status }),
        ...(name === undefined ? {} : { name }),
        limit,
      });
      // D-08: history views are newest-first; the default active view keeps insertion order.
      const ordered = includeHistory || status !== undefined ? [...tasks].sort(byRecency) : tasks;
      // CONTRACT §7.2: a terminal row that the model can read here has been told once already.
      consumeTerminal(registry, ordered);
      return toolResult(ordered.map(redactSnapshot));
    },
  });
  api.registerTool({
    name: "async_kill", label: "Kill async task", description: "Terminate an async task (taskId or name) and its process group.",
    promptSnippet: PROMPT_SNIPPETS.async_kill,
    parameters: schema({ taskId: stringField }, ["taskId"]),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
      const registry = resolveRegistry();
      // Unknown id/name throws here (registry message: "Unknown task or name: ...") → host isError result.
      const resolved = registry.resolveTaskId(String(params.taskId));
      const taskId = resolved.taskId;
      const before = registry.get(taskId);
      const alreadyTerminal = before !== undefined && isTerminal(before.status);
      let warning: string | undefined;
      try {
        await registry.kill(taskId, "user");
      } catch (error) {
        // Kill may still have finalized the task; surface confirmation failures as warning (#6).
        warning = error instanceof Error ? error.message : String(error);
      }
      const after = registry.get(taskId);
      return toolResult({
        taskId,
        status: after?.status,
        ...(after?.killKind ? { killKind: after.killKind } : {}),
        alreadyTerminal,
        processAlive: registry.isProcessAlive(taskId),
        ...(warning ? { warning } : {}),
      }, Boolean(warning && after?.status !== "killed"));
    },
  });
  api.registerTool({
    name: "async_extend", label: "Renew async task",
    description: "Renew a task (taskId or name) without touching its process: move the next reminder (remindAfterMs) and/or the hard kill deadline (taskTimeoutMs); either value resets its clock, 0 clears it. A finished task returns alreadyTerminal instead of an error.",
    promptSnippet: PROMPT_SNIPPETS.async_extend,
    parameters: schema({
      taskId: stringField,
      remindAfterMs: { type: "number", minimum: 0, description: "New reminder delay from now; resets the reminder count and backoff. 0 disarms reminders." },
      taskTimeoutMs: { type: "number", minimum: 0, description: "New hard deadline from now; the task is killed when it passes. 0 removes the task timeout." },
    }, ["taskId"]),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
      const registry = resolveRegistry();
      // Unknown id/name throws here (registry message: "Unknown task or name: ...") → host isError result.
      const resolved = registry.resolveTaskId(String(params.taskId));
      const remindAfterMs = typeof params.remindAfterMs === "number" ? params.remindAfterMs : undefined;
      const taskTimeoutMs = typeof params.taskTimeoutMs === "number" ? params.taskTimeoutMs : undefined;
      // A renewal with no knob would report success while changing nothing.
      if (remindAfterMs === undefined && taskTimeoutMs === undefined) throw new Error("async_extend needs remindAfterMs or taskTimeoutMs");
      const before = registry.get(resolved.taskId) ?? resolved;
      // §18.7: renewing a finished task is not an error — report the terminal shape (aligned with async_kill).
      if (isTerminal(before.status)) {
        return toolResult({ taskId: resolved.taskId, name: before.name, status: before.status, alreadyTerminal: true, elapsedMs: elapsedMsOf(before) });
      }
      const task = registry.extend(resolved.taskId, {
        ...(remindAfterMs === undefined ? {} : { remindAfterMs }),
        ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      });
      return toolResult({
        taskId: task.taskId,
        name: task.name,
        status: task.status,
        elapsedMs: elapsedMsOf(task),
        ...(task.remindAt === undefined ? {} : { remindAt: task.remindAt }),
        remindCount: task.remindCount ?? 0,
        ...(task.timeoutAt === undefined ? {} : { timeoutAt: task.timeoutAt }),
      });
    },
  });
}

/** Session cwd for tool-initiated runs: `ctx.cwd` when present, else the host process cwd (PLAN §2.7). */
function sessionCwd(ctx?: ToolContext): string {
  return typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}
