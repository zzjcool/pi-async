import assert from "node:assert/strict";
import test from "node:test";
import { registerTools } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tool schemas enforce sync/wait timeout requirements and output byte budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-tools-"));
  type Tool = { parameters: { required?: string[]; properties?: Record<string, unknown> }; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> };
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: { name: string; parameters: NonNullable<Tool["parameters"]>; execute: Tool["execute"] }) => tools.set(tool.name, tool) };
  const registry = new TaskRegistry({ dataDir: dir, maxTasks: 1 });
  try {
    registerTools(pi as never, registry);
    // 0.4.0 (REV-23): the surface grew to six tools — async_extend renews reminder/timeout deadlines.
    assert.equal(tools.size, 6);
    assert.ok(tools.get("async_wait")?.parameters.required?.includes("timeoutMs"));
    await assert.rejects(tools.get("async_run")!.execute("call", { command: "true", mode: "sync" }), /timeoutMs is required/);
    // 0.3.0: onTimeout is a sync-only knob; non-sync calls must be rejected, not silently ignored.
    await assert.rejects(tools.get("async_run")!.execute("call", { command: "true", mode: "background", onTimeout: "promote" }), /onTimeout is only valid for sync mode/);
    await assert.rejects(tools.get("async_run")!.execute("call", { command: "true", mode: "delayed" }), /delayMs is required/);
    await assert.rejects(tools.get("async_wait")!.execute("call", { taskIds: [] }), /timeoutMs is required/);
    assert.equal((tools.get("async_logs")?.parameters.properties?.maxBytes as { maximum: number }).maximum, 50 * 1024);
    registry.submit({ command: "sleep 5" });
    await assert.rejects(tools.get("async_run")!.execute("call", { command: "true" }), /Maximum active/);
  } finally { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
