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

const promptGuidelines = "Check commands must not swallow errors with || true; map unknown states to failure; prefer structured output and jq -e; anchor output_matches regexes (compiled with multiline `m`: ^/$ are line boundaries) to avoid premature matches; prefer stdout_contains for simple cases and avoid nested quantifiers.";
const MAX_LOG_BYTES = 50 * 1024;
const DEFAULT_MAX_SYNC_TIMEOUT_MS = 600_000;
const MAX_STATUS_LIMIT = 50;
const DEFAULT_STATUS_LIMIT = 50;

/** One-line snippet shown in the default system prompt's "Available tools" section (D-17). */
const ASYNC_RUN_PROMPT_SNIPPET = "Run a shell command in the background, with optional watch conditions and completion notification.";

/** Guidelines appended to the default system prompt while async_run is active (D-17). */
const ASYNC_RUN_PROMPT_GUIDELINES = [
  "Use async_run for long-running commands (servers, watchers, builds over a minute) instead of a blocking bash call; short commands belong in bash.",
  "Collect background work with async_wait, inspect it with async_logs, and use async_status to see what is still active before ending a turn.",
  "Pass name so later async_wait/async_logs/async_kill calls can address the task by name instead of its opaque taskId.",
];

/** `PI_ASYNC_MAX_SYNC_TIMEOUT_MS`, defaulting to 10 minutes when unset/invalid. */
function resolveMaxSyncTimeoutMs(): number {
  const parsed = Number(process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_SYNC_TIMEOUT_MS;
}

const schema = (properties: Record<string, unknown>, required: string[] = [], allOf: unknown[] = []) => ({ type: "object", properties, required, additionalProperties: false, ...(allOf.length ? { allOf } : {}) });
const stringField = { type: "string" };
const timeoutField = { type: "number", minimum: 0 };
const conditionSchema = {
  oneOf: [
    { type: "object", properties: { type: { const: "exit_code" }, equals: { type: "number" } }, required: ["type", "equals"], additionalProperties: false },
    ...["stdout_contains", "stderr_contains"].map((type) => ({ type: "object", properties: { type: { const: type }, value: stringField }, required: ["type", "value"], additionalProperties: false })),
    { type: "object", properties: {
      type: { const: "json_path_exists" },
      path: { type: "string", pattern: "^\\$", description: "JSONPath rooted at $; e.g. $.ready or $.items[0].state (bare names like \"ready\" are rejected)" },
    }, required: ["type", "path"], additionalProperties: false },
    { type: "object", properties: { type: { const: "output_matches" }, regex: stringField }, required: ["type", "regex"], additionalProperties: false },
  ],
};
const watchSchema = {
  type: "object", properties: {
    intervalMs: { type: "number", minimum: 1000 }, timeoutMs: { type: "number", minimum: 1 },
    success_when: { type: "array", items: conditionSchema }, failure_when: { type: "array", items: conditionSchema },
    blind_checks: { type: "number", minimum: 1 },
  }, required: ["intervalMs", "timeoutMs", "success_when", "failure_when"], additionalProperties: false,
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

/**
 * Register the frozen five-tool surface.
 *
 * `ensureConfigured` lets the extension wire a lazy, once-only
 * `registry.configure({dataDir, cwd})` before the first tool call — tools may
 * run before `session_start` (e.g. an immediate tool call), and the registry
 * then still needs its session cwd/dataDir (PLAN §2.8). Tools stay usable
 * without it (tests, direct embedding).
 */
export function registerTools(pi: PiCtx, registry: TaskRegistry, ensureConfigured?: (ctx?: ToolContext) => void): void {
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
  const maxSyncTimeoutMs = resolveMaxSyncTimeoutMs();
  const configure = (ctx?: ToolContext): void => ensureConfigured?.(ctx);

  api.registerTool({
    name: "async_run", label: "Run async command",
    description: `Run a background, delayed, or synchronous shell command. mode=sync requires timeoutMs; mode=delayed requires delayMs. onTimeout (sync only): "promote" (default) hands the still-running task to background and returns; "abort" stops WAITING only — the command keeps running in the background and will still notify on completion (Esc semantics; does not kill). ${promptGuidelines}`,
    promptSnippet: ASYNC_RUN_PROMPT_SNIPPET,
    promptGuidelines: ASYNC_RUN_PROMPT_GUIDELINES,
    // Mode-conditional required fields + mode-scoped rejects enforced in execute (#45/#42),
    // not allOf/then (host validator emits opaque "must match then schema").
    parameters: schema({
      command: stringField, name: stringField,
      mode: { type: "string", enum: ["background", "sync", "delayed"], default: "background" },
      timeoutMs: { type: "number", minimum: 0, maximum: maxSyncTimeoutMs, description: `Sync-mode wait budget in ms (max ${maxSyncTimeoutMs}, from PI_ASYNC_MAX_SYNC_TIMEOUT_MS).` },
      delayMs: timeoutField, taskTimeoutMs: timeoutField,
      onTimeout: { type: "string", enum: ["promote", "abort"], default: "promote" },
      notifyOnCompletion: { type: "boolean" }, triggerOnCompletion: { type: "boolean" },
      env: { type: "object", additionalProperties: { type: "string" } },
      watch: watchSchema,
    }, ["command"]),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      configure(ctx);
      const mode = String(params.mode ?? "background");
      if (mode !== "background" && mode !== "sync" && mode !== "delayed") throw new Error(`Unsupported async_run mode: ${mode}`);
      const command = String(params.command ?? "");
      if (mode === "sync" && params.timeoutMs === undefined) throw new Error("timeoutMs is required for sync mode");
      if (mode === "delayed" && params.delayMs === undefined) throw new Error("delayMs is required for delayed mode");
      if (params.watch !== undefined && mode === "sync") throw new Error("watch is only supported for background and delayed modes");
      if (mode !== "sync" && params.timeoutMs !== undefined) throw new Error("timeoutMs is only valid for sync mode (use taskTimeoutMs to bound background/delayed tasks)");
      if (mode !== "sync" && params.onTimeout !== undefined) throw new Error("onTimeout is only valid for sync mode");
      if (mode !== "delayed" && params.delayMs !== undefined) throw new Error("delayMs is only valid for delayed mode");
      const options = {
        command,
        cwd: sessionCwd(ctx),
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        ...(typeof params.taskTimeoutMs === "number" ? { taskTimeoutMs: params.taskTimeoutMs } : {}),
        ...(typeof params.notifyOnCompletion === "boolean" ? { notifyOnCompletion: params.notifyOnCompletion } : {}),
        ...(typeof params.triggerOnCompletion === "boolean" ? { triggerOnCompletion: params.triggerOnCompletion } : {}),
        ...(params.env && typeof params.env === "object" ? { env: params.env as Record<string, string> } : {}),
        ...(mode !== "sync" && params.watch && typeof params.watch === "object" ? { watch: params.watch as WatchSpec } : {}),
      };
      if (mode === "sync") {
        const timeoutMs = Number(params.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative finite number");
        if (timeoutMs > maxSyncTimeoutMs) {
          throw new Error(`timeoutMs must be at most ${maxSyncTimeoutMs} ms for sync mode (raise PI_ASYNC_MAX_SYNC_TIMEOUT_MS to allow longer waits; promote the task to background instead)`);
        }
        const result = await registry.runSync({ ...options, mode: "sync" }, timeoutMs, params.onTimeout === "abort" ? "abort" : "promote", signal);
        // D-19 (narrowing D-18 to PLAN §2.7's exact wording): only a *finished* sync run with a
        // non-zero exit is a tool error. promote/abort timeouts leave the task running
        // (status "running") — that is not a non-zero exit and must not read as a failure;
        // the payload still carries the full SyncResult (status/promoted/exitCode/outputTail).
        const ended = result.status === "completed" || result.status === "failed" || result.status === "killed";
        const isError = ended && (result.status !== "completed" || (result.exitCode !== undefined && result.exitCode !== 0));
        return toolResult(result, isError);
      }
      const task = mode === "delayed"
        ? registry.scheduleDelayed(options, Number(params.delayMs))
        : registry.submit({ ...options, mode: "background" });
      return toolResult({ taskId: task.taskId, name: task.name, status: task.status, mode: task.mode, outputHint: `Use async_logs with taskId ${task.taskId} to inspect early output.` });
    },
  });
  api.registerTool({
    name: "async_wait", label: "Wait for async tasks",
    description: "Wait for tasks (taskId or name) to finish or return notReady; waiting does not kill tasks.",
    parameters: schema({ taskIds: { type: "array", items: stringField }, timeoutMs: timeoutField }, ["taskIds", "timeoutMs"]),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      configure(ctx);
      if (params.timeoutMs === undefined) throw new Error("timeoutMs is required");
      const taskIds = Array.isArray(params.taskIds) ? params.taskIds.map((id) => registry.resolveTaskId(String(id)).taskId) : [];
      return toolResult(await registry.wait(taskIds, Number(params.timeoutMs), signal));
    },
  });
  api.registerTool({
    name: "async_logs", label: "Read async output",
    description: "Read bounded, ANSI-stripped task output (taskId or name). stream selects merged/stdout/stderr.",
    parameters: schema({
      taskId: stringField,
      maxBytes: { type: "number", minimum: 0, maximum: MAX_LOG_BYTES },
      tail: { type: "boolean" },
      stream: { type: "string", enum: ["merged", "stdout", "stderr"], default: "merged" },
    }, ["taskId"]),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
      const maxBytes = params.maxBytes === undefined ? MAX_LOG_BYTES : Number(params.maxBytes);
      if (maxBytes > MAX_LOG_BYTES) throw new Error("maxBytes must be at most 50 KiB");
      const stream = params.stream === "stdout" || params.stream === "stderr" ? params.stream : "merged";
      const { taskId } = registry.resolveTaskId(String(params.taskId));
      return toolResult(registry.logs(taskId, { maxBytes, tail: params.tail !== false, stream }));
    },
  });
  api.registerTool({
    name: "async_status", label: "Async task status",
    description: "List async tasks and current status. Defaults to active (running/pending) only; pass includeHistory:true (or an explicit status) for up to 50 recent tasks, newest first.",
    parameters: schema({
      includeHistory: { type: "boolean" },
      status: { type: "string", enum: [...TASK_STATUSES, "active"] },
      name: stringField,
      limit: { type: "number", minimum: 1, maximum: MAX_STATUS_LIMIT },
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
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
      return toolResult(ordered.map(redactSnapshot));
    },
  });
  api.registerTool({
    name: "async_kill", label: "Kill async task", description: "Terminate an async task (taskId or name) and its process group.",
    parameters: schema({ taskId: stringField }, ["taskId"]),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      configure(ctx);
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
}

/** Session cwd for tool-initiated runs: `ctx.cwd` when present, else the host process cwd (PLAN §2.7). */
function sessionCwd(ctx?: ToolContext): string {
  return typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}
