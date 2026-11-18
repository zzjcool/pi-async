import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { withExposedWaitAsync } from "./helpers/index.ts";

/**
 * Host-contract tests: mock the pi host (registerTool collector) and assert
 * every async_* tool satisfies the ToolResultMessage contract pi 1.2.0
 * expects from extension tools: { content: Array<{type,text}>, ... }.
 *
 * Regression: 2026-10-15 user-reported uncaughtException —
 * ToolExecutionComponent.getTextOutput crashed on result.content undefined
 * because our tools returned bare objects (pi does NOT auto-wrap extension
 * tool return values; only builtin tools self-wrap).
 *
 * 0.5.0 (D3): the three `mode=sync` cases are gone with the mode itself; the
 * background/delayed paths below cover the same wrapping contract.
 */

type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
function makeHost() {
  const tools = new Map<string, { execute: Execute }>();
  const pi = {
    registerTool: (tool: { name: string; execute: Execute }) => {
      tools.set(tool.name, tool);
    },
  };
  return { pi, tools };
}

function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-host-contract-"));
  const registry = new TaskRegistry({ dataDir: dir, maxTasks: 8, maxOutputBytes: 64 * 1024 });
  return { registry, cleanup: () => { registry.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

/** The pi 1.2.0 TUI contract: getTextOutput does result.content.filter. */
function assertToolResultShape(name: string, result: unknown) {
  const r = result as { content?: unknown; isError?: unknown };
  assert.ok(Array.isArray(r?.content), `${name}: content must be an array (TUI getTextOutput filters it), got: ${typeof r?.content}`);
  for (const block of r.content as unknown[]) {
    const b = block as { type?: unknown; text?: unknown };
    assert.equal(typeof b?.type, "string", `${name}: content blocks must have string type`);
    if (b.type === "text") assert.equal(typeof b.text, "string", `${name}: text blocks must have string text`);
  }
  assert.equal(typeof r.isError, "boolean", `${name}: isError must be boolean`);
}

test("async_run returns a ToolResultMessage-shaped result (TUI-safe)", async () => {
  const host = makeHost();
  const { registry, cleanup } = makeRegistry();
  try {
    registerTools(host.pi as never, registry);
    const run = host.tools.get("async_run")!;
    const result = await run.execute("call-1", { command: "true", mode: "background" });
    assertToolResultShape("async_run", result);
    // payload survives in details and parses back to the receipt
    const details = (result as { details: { payload: { taskId: string } } }).details;
    assert.ok(details.payload.taskId, "async_run payload.taskId must survive in details");
    // drain the task before cleanup so no finalize races the removed tempdir
    await registry.wait([details.payload.taskId], 5000);
  } finally { cleanup(); }
});

test("async_run delayed mode returns a wrapped, not-yet-started receipt (D3 replacement for mode=sync)", async () => {
  const host = makeHost();
  const { registry, cleanup } = makeRegistry();
  try {
    registerTools(host.pi as never, registry);
    const run = host.tools.get("async_run")!;
    const result = await run.execute("call-1", { command: "echo delayed-ok", mode: "delayed", delayMs: 50 });
    assertToolResultShape("async_run(delayed)", result);
    assert.equal((result as { isError: boolean }).isError, false, "a pending delayed task is not a tool error");
    const payload = (result as { details: { payload: { taskId: string; status: string; mode: string } } }).details.payload;
    assert.equal(payload.status, "pending");
    assert.equal(payload.mode, "delayed");
    await registry.wait([payload.taskId], 5000);
  } finally { cleanup(); }
});

test("async_wait/async_logs/async_status/async_kill all return ToolResultMessage shapes", async () => {
  const host = makeHost();
  const { registry, cleanup } = makeRegistry();
  try {
    // D4: async_wait is opt-in, so this test registers and runs with the switch on.
    await withExposedWaitAsync(async () => {
      registerTools(host.pi as never, registry);
      const run = host.tools.get("async_run")!;
      const submitted = await run.execute("call-1", { command: "echo hi", mode: "background" }) as { details: { payload: { taskId: string } } };
      const id = submitted.details.payload.taskId;

      const wait = host.tools.get("async_wait")!;
      const waited = await wait.execute("call-2", { taskIds: [id], timeoutMs: 5000 });
      assertToolResultShape("async_wait", waited);

      const logs = host.tools.get("async_logs")!;
      assertToolResultShape("async_logs", await logs.execute("call-3", { taskId: id }));

      const status = host.tools.get("async_status")!;
      assertToolResultShape("async_status", await status.execute("call-4", {}));

      const kill = host.tools.get("async_kill")!;
      assertToolResultShape("async_kill", await kill.execute("call-5", { taskId: id }));
    });
  } finally { cleanup(); }
});
