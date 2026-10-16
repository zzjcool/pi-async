import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { registerTools } from "../src/tools/index.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-sync-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return { registry, cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("sync mode blocks for a short command and returns exit code and bounded output", async () => {
  const f = fixture();
  try {
    const result = await f.registry.runSync({ command: "printf 'one\\ntwo\\n'" }, 3000, "promote");
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputTail, "one\ntwo\n");
    assert.equal(result.promoted, false);

    const big = await f.registry.runSync({ command: "seq 500" }, 3000, "promote");
    assert.equal(big.status, "completed");
    assert.ok(Buffer.byteLength(big.outputTail) <= 8192);
    assert.ok(big.outputTail.split("\n").length <= 200);
  } finally { await f.cleanup(); }
});

test("sync timeout promote returns while the task continues in background", async () => {
  const f = fixture();
  try {
    const result = await f.registry.runSync({ command: "sleep 0.35; printf done" }, 30, "promote");
    assert.equal(result.promoted, true);
    assert.equal(result.mode, "background");
    assert.equal(result.status, "running");
    assert.equal(f.registry.get(result.taskId)?.status, "running");
    const completed = await f.registry.wait([result.taskId], 3000);
    assert.ok("results" in completed);
    assert.equal(completed.results[0]?.status, "completed");
  } finally { await f.cleanup(); }
});

test("async_run dispatches sync and delayed modes and only permits watch on background or delayed", async () => {
  const f = fixture();
  const tools = new Map<string, { parameters: Record<string, unknown>; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }>();
  const pi = { registerTool: (tool: { name: string; parameters: Record<string, unknown>; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }) => tools.set(tool.name, tool) };
  try {
    registerTools(pi as never, f.registry);
    const run = tools.get("async_run")!;
    const schema = run.parameters as { properties: Record<string, unknown>; allOf?: unknown[] };
    assert.ok(schema.properties.watch);
    // Mode-conditional required fields are enforced in execute (#45), not opaque allOf/then.
    assert.ok(!schema.allOf || schema.allOf.length === 0);
    const sync = await run.execute("call", { command: "printf sync", mode: "sync", timeoutMs: 3000 });
    const syncPayload = (sync as { details: { payload: { exitCode?: number } } }).details.payload;
    assert.equal(syncPayload.exitCode, 0);
    await assert.rejects(run.execute("call", { command: "true", mode: "sync", timeoutMs: 1, watch: { intervalMs: 1000, timeoutMs: 1000, success_when: [], failure_when: [] } }), /watch is only supported/);
    const delayed = await run.execute("call", { command: "printf delayed", mode: "delayed", delayMs: 30, watch: { intervalMs: 1000, timeoutMs: 3000, success_when: [{ type: "stdout_contains", value: "delayed" }], failure_when: [] } });
    const delayedPayload = (delayed as { details: { payload: { status: string } } }).details.payload;
    assert.equal(delayedPayload.status, "pending");
  } finally { await f.cleanup(); }
});

test("sync abort timeout and Esc interruption preserve the live task", async () => {
  const f = fixture();
  try {
    const result = await f.registry.runSync({ command: "sleep 0.4" }, 25, "abort");
    assert.equal(result.promoted, false);
    assert.equal(result.status, "running");
    assert.equal(result.mode, "background");
    assert.equal(f.registry.get(result.taskId)?.status, "running");
    assert.equal(f.registry.get(result.taskId)?.mode, "background");

    const controller = new AbortController();
    const waiting = f.registry.runSync({ command: "sleep 0.4" }, 2000, "promote", controller.signal);
    setTimeout(() => controller.abort(new Error("Esc")), 25);
    const interrupted = await waiting;
    assert.equal(interrupted.status, "running");
    assert.equal(f.registry.get(interrupted.taskId)?.status, "running");
  } finally { await f.cleanup(); }
});
