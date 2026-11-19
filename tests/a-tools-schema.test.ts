import assert from "node:assert/strict";
import test from "node:test";
import { registerTools } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExposedWaitAsync } from "./helpers/index.ts";

/**
 * The exposed (PI_ASYNC_EXPOSE_WAIT=1) surface: six tools. The default five-tool surface and the
 * degraded `async_wait` path are pinned by `tests/k-toolsurface.test.ts` (D4, 0.5.0).
 */
test("tool schemas enforce wait timeout requirements and output byte budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-tools-"));
  type Tool = { parameters: { required?: string[]; properties?: Record<string, unknown> }; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> };
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: { name: string; parameters: NonNullable<Tool["parameters"]>; execute: Tool["execute"] }) => tools.set(tool.name, tool) };
  const registry = new TaskRegistry({ dataDir: dir, maxTasks: 1 });
  try {
    await withExposedWaitAsync(async () => {
      registerTools(pi as never, registry);
      // 0.5.0 (D4): async_wait is opt-in, so the exposed surface is the only place with six tools.
      assert.equal(tools.size, 6);
      assert.ok(tools.get("async_wait")?.parameters.required?.includes("timeoutMs"));
      // 0.5.0 (D3): `mode=sync` no longer exists — the execute whitelist still names the rejected value
      // instead of silently treating it as background.
      await assert.rejects(tools.get("async_run")!.execute("call", { command: "true", mode: "sync" }), /Unsupported async_run mode: sync/);
      await assert.rejects(tools.get("async_run")!.execute("call", { command: "true", mode: "delayed" }), /delayMs is required/);
      await assert.rejects(tools.get("async_wait")!.execute("call", { taskIds: [] }), /timeoutMs is required/);
      assert.equal((tools.get("async_logs")?.parameters.properties?.maxBytes as { maximum: number }).maximum, 50 * 1024);
      const runSchema = tools.get("async_run")!.parameters.properties ?? {};
      assert.equal(runSchema.timeoutMs, undefined, "D3: timeoutMs is not an async_run parameter");
      assert.equal(runSchema.onTimeout, undefined, "D3: onTimeout is not an async_run parameter");
      registry.submit({ command: "sleep 5" });
      await assert.rejects(tools.get("async_run")!.execute("call", { command: "true" }), /Maximum active/);
    });
  } finally { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
