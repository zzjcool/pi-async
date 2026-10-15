import assert from "node:assert/strict";
import test from "node:test";
import { registerTools } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tool schemas enforce sync/wait timeout requirements and output byte budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-tools-"));
  const tools = new Map<string, { parameters: { required?: string[]; properties?: Record<string, unknown> }; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  const pi = { registerTool: (tool: { name: string; parameters: typeof tools extends Map<string, infer T> ? T extends { parameters: infer P } ? P : never : never; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => tools.set(tool.name, tool) };
  const registry = new TaskRegistry({ dataDir: dir, maxTasks: 1 });
  try {
    registerTools(pi as never, registry);
    assert.equal(tools.size, 5);
    assert.ok(tools.get("async_wait")?.parameters.required?.includes("timeoutMs"));
    await assert.rejects(tools.get("async_run")!.execute("call", { command: "true", mode: "sync" }), /timeoutMs is required/);
    await assert.rejects(tools.get("async_wait")!.execute("call", { taskIds: [] }), /timeoutMs is required/);
    assert.equal((tools.get("async_logs")?.parameters.properties?.maxBytes as { maximum: number }).maximum, 50 * 1024);
    registry.submit({ command: "sleep 5" });
    await assert.rejects(tools.get("async_run")!.execute("call", { command: "true" }), /Maximum active/);
  } finally { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
