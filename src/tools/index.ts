import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";

const promptGuidelines = "Check commands must not swallow errors with || true; map unknown states to failure; prefer structured output and jq -e; anchor output_matches regexes to avoid premature matches.";
const MAX_LOG_BYTES = 50 * 1024;
const schema = (properties: Record<string, unknown>, required: string[] = [], allOf: unknown[] = []) => ({ type: "object", properties, required, additionalProperties: false, ...(allOf.length ? { allOf } : {}) });
const stringField = { type: "string" };
const timeoutField = { type: "number", minimum: 0 };

/** Register the frozen five-tool surface. */
export function registerTools(pi: PiCtx, registry: TaskRegistry): void {
  type ToolDef = { name: string; label: string; description: string; parameters: unknown; execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };
  // SAFETY: ExtensionAPI exposes registerTool at runtime; this local structural view keeps schemas dependency-free.
  const api = pi as unknown as { registerTool?: (tool: ToolDef) => void };
  if (!api.registerTool) throw new Error("Pi host does not expose registerTool");
  api.registerTool({
    name: "async_run", label: "Run async command", description: `Start a background shell command. ${promptGuidelines}`,
    parameters: schema({ command: stringField, name: stringField, mode: { type: "string", enum: ["background", "sync", "delayed"] }, timeoutMs: timeoutField, delayMs: timeoutField, taskTimeoutMs: timeoutField, onTimeout: { type: "string", enum: ["promote", "abort"] }, notifyOnCompletion: { type: "boolean" }, triggerOnCompletion: { type: "boolean" }, env: { type: "object", additionalProperties: { type: "string" } } }, ["command"], [
      { if: { properties: { mode: { const: "sync" } }, required: ["mode"] }, then: { required: ["timeoutMs"] } },
      { if: { properties: { mode: { const: "delayed" } }, required: ["mode"] }, then: { required: ["delayMs"] } },
    ]),
    execute: async (_id, params) => {
      const command = String(params.command ?? "");
      const mode = String(params.mode ?? "background");
      if (mode === "sync" && params.timeoutMs === undefined) throw new Error("timeoutMs is required for sync mode");
      if (mode === "delayed") return "not implemented (line B)";
      if (mode === "sync") return "not implemented (line B)";
      const task = registry.submit({
        command,
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        mode: "background",
        ...(typeof params.taskTimeoutMs === "number" ? { taskTimeoutMs: params.taskTimeoutMs } : {}),
        ...(typeof params.notifyOnCompletion === "boolean" ? { notifyOnCompletion: params.notifyOnCompletion } : {}),
        ...(typeof params.triggerOnCompletion === "boolean" ? { triggerOnCompletion: params.triggerOnCompletion } : {}),
        ...(params.env && typeof params.env === "object" ? { env: params.env as Record<string, string> } : {}),
      });
      return { taskId: task.taskId, name: task.name, status: task.status, mode: task.mode, outputHint: `Use async_logs with taskId ${task.taskId} to inspect early output.` };
    },
  });
  api.registerTool({ name: "async_wait", label: "Wait for async tasks", description: "Wait for tasks to finish or return notReady; waiting does not kill tasks.", parameters: schema({ taskIds: { type: "array", items: stringField }, timeoutMs: timeoutField }, ["taskIds", "timeoutMs"]), execute: async (_id, params, signal) => {
    if (params.timeoutMs === undefined) throw new Error("timeoutMs is required");
    const outcome = await registry.wait(params.taskIds as string[], Number(params.timeoutMs), signal);
    return outcome;
  } });
  api.registerTool({ name: "async_logs", label: "Read async output", description: "Read bounded, ANSI-stripped task output.", parameters: schema({ taskId: stringField, maxBytes: { type: "number", minimum: 0, maximum: MAX_LOG_BYTES }, tail: { type: "boolean" } }, ["taskId"]), execute: async (_id, params) => {
    const maxBytes = params.maxBytes === undefined ? MAX_LOG_BYTES : Number(params.maxBytes);
    if (maxBytes > MAX_LOG_BYTES) throw new Error("maxBytes must be at most 50 KiB");
    return registry.logs(String(params.taskId), { maxBytes, tail: params.tail !== false });
  } });
  api.registerTool({ name: "async_status", label: "Async task status", description: "List async tasks and current status.", parameters: schema({ includeHistory: { type: "boolean" } }), execute: async (_id, params) => registry.list({ includeHistory: params.includeHistory !== false }) });
  api.registerTool({ name: "async_kill", label: "Kill async task", description: "Terminate an async task and its process group.", parameters: schema({ taskId: stringField }, ["taskId"]), execute: async (_id, params) => { await registry.kill(String(params.taskId), "user"); return { taskId: params.taskId, status: registry.get(String(params.taskId))?.status }; } });
}
