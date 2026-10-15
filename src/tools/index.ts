import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { WatchSpec } from "../core/task.ts";

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

const promptGuidelines = "Check commands must not swallow errors with || true; map unknown states to failure; prefer structured output and jq -e; anchor output_matches regexes to avoid premature matches.";
const MAX_LOG_BYTES = 50 * 1024;
const schema = (properties: Record<string, unknown>, required: string[] = [], allOf: unknown[] = []) => ({ type: "object", properties, required, additionalProperties: false, ...(allOf.length ? { allOf } : {}) });
const stringField = { type: "string" };
const timeoutField = { type: "number", minimum: 0 };
const conditionSchema = {
  oneOf: [
    { type: "object", properties: { type: { const: "exit_code" }, equals: { type: "number" } }, required: ["type", "equals"], additionalProperties: false },
    ...["stdout_contains", "stderr_contains"].map((type) => ({ type: "object", properties: { type: { const: type }, value: stringField }, required: ["type", "value"], additionalProperties: false })),
    { type: "object", properties: { type: { const: "json_path_exists" }, path: stringField }, required: ["type", "path"], additionalProperties: false },
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

/** Register the frozen five-tool surface. */
export function registerTools(pi: PiCtx, registry: TaskRegistry): void {
  type ToolDef = { name: string; label: string; description: string; parameters: unknown; execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };
  // SAFETY: ExtensionAPI exposes registerTool at runtime; this local structural view keeps schemas dependency-free.
  const api = pi as unknown as { registerTool?: (tool: ToolDef) => void };
  if (!api.registerTool) throw new Error("Pi host does not expose registerTool");
  api.registerTool({
    name: "async_run", label: "Run async command", description: `Run a background, delayed, or synchronous shell command. ${promptGuidelines}`,
    parameters: schema({ command: stringField, name: stringField, mode: { type: "string", enum: ["background", "sync", "delayed"], default: "background" }, timeoutMs: timeoutField, delayMs: timeoutField, taskTimeoutMs: timeoutField, onTimeout: { type: "string", enum: ["promote", "abort"], default: "promote" }, notifyOnCompletion: { type: "boolean" }, triggerOnCompletion: { type: "boolean" }, env: { type: "object", additionalProperties: { type: "string" } }, watch: watchSchema }, ["command"], [
      { if: { properties: { mode: { const: "sync" } }, required: ["mode"] }, then: { required: ["timeoutMs"] } },
      { if: { properties: { mode: { const: "delayed" } }, required: ["mode"] }, then: { required: ["delayMs"] } },
      { if: { properties: { mode: { const: "sync" } }, required: ["mode"] }, then: { not: { required: ["watch"] } } },
    ]),
    execute: async (_id, params, signal) => {
      const mode = String(params.mode ?? "background");
      if (mode !== "background" && mode !== "sync" && mode !== "delayed") throw new Error(`Unsupported async_run mode: ${mode}`);
      const command = String(params.command ?? "");
      if (mode === "sync" && params.timeoutMs === undefined) throw new Error("timeoutMs is required for sync mode");
      if (mode === "delayed" && params.delayMs === undefined) throw new Error("delayMs is required for delayed mode");
      if (params.watch !== undefined && mode === "sync") throw new Error("watch is only supported for background and delayed modes");
      const options = {
        command,
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        ...(typeof params.taskTimeoutMs === "number" ? { taskTimeoutMs: params.taskTimeoutMs } : {}),
        ...(typeof params.notifyOnCompletion === "boolean" ? { notifyOnCompletion: params.notifyOnCompletion } : {}),
        ...(typeof params.triggerOnCompletion === "boolean" ? { triggerOnCompletion: params.triggerOnCompletion } : {}),
        ...(params.env && typeof params.env === "object" ? { env: params.env as Record<string, string> } : {}),
        ...(params.watch && typeof params.watch === "object" ? { watch: params.watch as WatchSpec } : {}),
      };
      if (mode === "sync") { const r = await registry.runSync({ ...options, mode: "sync" }, Number(params.timeoutMs), params.onTimeout === "abort" ? "abort" : "promote", signal); return toolResult(r); }
      const task = mode === "delayed"
        ? registry.scheduleDelayed({ ...options, mode: "delayed" }, Number(params.delayMs))
        : registry.submit({ ...options, mode: "background" });
      return toolResult({ taskId: task.taskId, name: task.name, status: task.status, mode: task.mode, outputHint: `Use async_logs with taskId ${task.taskId} to inspect early output.` });
    },
  });
  api.registerTool({ name: "async_wait", label: "Wait for async tasks", description: "Wait for tasks to finish or return notReady; waiting does not kill tasks.", parameters: schema({ taskIds: { type: "array", items: stringField }, timeoutMs: timeoutField }, ["taskIds", "timeoutMs"]), execute: async (_id, params, signal) => {
    if (params.timeoutMs === undefined) throw new Error("timeoutMs is required");
    return toolResult(await registry.wait(params.taskIds as string[], Number(params.timeoutMs), signal));
  } });
  api.registerTool({ name: "async_logs", label: "Read async output", description: "Read bounded, ANSI-stripped task output.", parameters: schema({ taskId: stringField, maxBytes: { type: "number", minimum: 0, maximum: MAX_LOG_BYTES }, tail: { type: "boolean" } }, ["taskId"]), execute: async (_id, params) => {
    const maxBytes = params.maxBytes === undefined ? MAX_LOG_BYTES : Number(params.maxBytes);
    if (maxBytes > MAX_LOG_BYTES) throw new Error("maxBytes must be at most 50 KiB");
    return toolResult(registry.logs(String(params.taskId), { maxBytes, tail: params.tail !== false }));
  } });
  api.registerTool({ name: "async_status", label: "Async task status", description: "List async tasks and current status.", parameters: schema({ includeHistory: { type: "boolean" } }), execute: async (_id, params) => toolResult(registry.list({ includeHistory: params.includeHistory !== false })) });
  api.registerTool({ name: "async_kill", label: "Kill async task", description: "Terminate an async task and its process group.", parameters: schema({ taskId: stringField }, ["taskId"]), execute: async (_id, params) => { await registry.kill(String(params.taskId), "user"); return toolResult({ taskId: params.taskId, status: registry.get(String(params.taskId))?.status }); } });
}
