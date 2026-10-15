import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";

/**
 * Host-contract tests: mock the pi host (registerTool collector) and assert
 * every async_* tool satisfies the ToolResultMessage contract pi 1.2.0
 * expects from extension tools: { content: Array<{type,text}>, ... }.
 *
 * Regression: 2026-10-15 user-reported uncaughtException —
 * ToolExecutionComponent.getTextOutput crashed on result.content undefined
 * because our tools returned bare objects (pi does NOT auto-wrap extension
 * tool return values; only builtin tools self-wrap).
 */

function makeHost() {
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }>();
  const pi = {
    registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }) => {
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

test("async_wait/async_logs/async_status/async_kill all return ToolResultMessage shapes", async () => {
  const host = makeHost();
  const { registry, cleanup } = makeRegistry();
  try {
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
  } finally { cleanup(); }
});

test("async_run sync mode also wraps (regression for mode=sync crash path)", async () => {
  const host = makeHost();
  const { registry, cleanup } = makeRegistry();
  try {
    registerTools(host.pi as never, registry);
    const run = host.tools.get("async_run")!;
    const result = await run.execute("call-1", { command: "echo sync-ok", mode: "sync", timeoutMs: 5000 });
    assertToolResultShape("async_run(sync)", result);
    const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
    assert.match(text, /sync-ok/, "sync output must ride inside the wrapped content text");
  } finally { cleanup(); }
});

test("sync mode abort keeps result wrapped and task alive", async () => {
  const host = makeHost();
  const { registry, cleanup } = makeRegistry();
  try {
    registerTools(host.pi as never, registry);
    const run = host.tools.get("async_run")!;
    const result = await run.execute("call-1", { command: "sleep 2", mode: "sync", timeoutMs: 300, onTimeout: "abort" });
    assertToolResultShape("async_run(sync-abort)", result);
    const payload = (result as { details: { payload: { promoted: boolean; status: string; taskId: string } } }).details.payload;
    assert.equal(payload.promoted, false, "abort ends the wait without promoting");
    assert.equal(payload.status, "running", "abort keeps the task alive in sync mode");
    assert.equal(registry.get(payload.taskId)?.status, "running", "task survives in the registry");
    await registry.kill(payload.taskId, "user");
  } finally { cleanup(); }
});
