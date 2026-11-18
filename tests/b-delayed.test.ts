import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { registerTools } from "../src/tools/index.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-delayed-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return { dir, registry, cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("delayed task persists dueAt and starts when its delay expires", async () => {
  const f = fixture();
  try {
    const task = f.registry.scheduleDelayed({ command: "printf delayed" }, 80);
    assert.equal(task.status, "pending");
    assert.ok(typeof task.dueAt === "number");
    const result = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results[0]?.status, "completed");
    assert.equal(f.registry.logs(task.taskId, { tail: true }).text, "delayed");
  } finally { await f.cleanup(); }
});

test("pending delayed task can be canceled as a user kill", async () => {
  const f = fixture();
  try {
    const task = f.registry.scheduleDelayed({ command: "printf should-not-run" }, 500);
    assert.equal(f.registry.cancel(task.taskId), true);
    assert.equal(f.registry.get(task.taskId)?.status, "killed");
    assert.equal(f.registry.get(task.taskId)?.killKind, "user");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(f.registry.logs(task.taskId, { tail: true }).text, "");
  } finally { await f.cleanup(); }
});

test("reload starts a delayed task immediately when persisted dueAt is expired", async () => {
  const f = fixture();
  const restored = new TaskRegistry({ dataDir: f.dir });
  try {
    const task = f.registry.scheduleDelayed({ command: "printf overdue" }, 5000);
    const snapshot = JSON.parse(JSON.stringify(task)) as typeof task;
    assert.equal(f.registry.cancel(task.taskId), true);
    snapshot.status = "pending";
    snapshot.finishedAt = undefined;
    snapshot.killKind = undefined;
    snapshot.dueAt = Date.now() - 1000;
    writeFileSync(join(f.dir, `${task.taskId}.json`), JSON.stringify(snapshot));

    await restored.reloadFromDisk();
    const outcome = await restored.wait([task.taskId], 3000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    assert.equal(restored.logs(task.taskId, { tail: true }).text, "overdue");
  } finally {
    await restored.shutdown();
    await f.cleanup();
  }
});

test("delayed stdout watch records its success metadata", async () => {
  const f = fixture();
  try {
    const task = f.registry.scheduleDelayed({
      command: "printf ready; sleep 0.2",
      watch: { intervalMs: 1000, timeoutMs: 3000, success_when: [{ type: "stdout_contains", value: "ready" }], failure_when: [] },
    }, 100);
    const outcome = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    assert.equal(typeof f.registry.get(task.taskId)?.metadata.watchSuccess, "string");
    assert.notEqual(f.registry.get(task.taskId)?.metadata.watchSuccess, "");
  } finally { await f.cleanup(); }
});

test("reload restores remaining delayed time from persisted dueAt", async () => {
  const f = fixture();
  const restored = new TaskRegistry({ dataDir: f.dir });
  try {
    const task = f.registry.scheduleDelayed({ command: "printf restored" }, 350);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = JSON.parse(JSON.stringify(task)) as typeof task;
    const dueAt = snapshot.dueAt!;
    // Simulate process restart: retire the original registry timer then restore its durable metadata.
    assert.equal(f.registry.cancel(task.taskId), true);
    writeFileSync(join(f.dir, `${task.taskId}.json`), JSON.stringify(snapshot));
    await restored.reloadFromDisk();
    const loaded = restored.get(task.taskId)!;
    assert.equal(loaded.status, "pending");
    assert.equal(loaded.dueAt, dueAt);
    const outcome = await restored.wait([task.taskId], 3000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    assert.ok(Date.now() >= dueAt);
  } finally {
    await restored.shutdown();
    await f.cleanup();
  }
});

type Tool = { parameters: { properties: Record<string, unknown>; allOf?: unknown[] }; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };

/**
 * Migrated from the deleted `b-sync-mode.test.ts` (D3, 0.5.0): the delayed half of that test is
 * still contract — `async_run mode=delayed` dispatches through the tool, carries a watch, and the
 * schema keeps the mode-conditional rejects in `execute` rather than in opaque `allOf/then` (#45).
 */
test("async_run dispatches delayed mode with a watch through the tool surface", async () => {
  const f = fixture();
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: { name: string } & Tool) => tools.set(tool.name, tool) };
  try {
    registerTools(pi as never, f.registry);
    const run = tools.get("async_run")!;
    const schema = run.parameters;
    assert.ok(schema.properties.watch, "watch stays part of the async_run schema");
    assert.ok(!schema.allOf || schema.allOf.length === 0, "mode-conditional rules live in execute, not allOf/then");
    assert.equal(schema.properties.timeoutMs, undefined, "D3: sync is gone, so timeoutMs is not a parameter anymore");
    assert.equal(schema.properties.onTimeout, undefined, "D3: onTimeout is not a parameter anymore");
    const delayed = await run.execute("call", {
      command: "printf delayed",
      mode: "delayed",
      delayMs: 30,
      watch: { intervalMs: 1000, timeoutMs: 3000, success_when: [{ type: "stdout_contains", value: "delayed" }], failure_when: [] },
    });
    const delayedPayload = (delayed as { details: { payload: { status: string; mode: string } } }).details.payload;
    assert.equal(delayedPayload.status, "pending");
    assert.equal(delayedPayload.mode, "delayed");
    await assert.rejects(run.execute("call", { command: "true", delayMs: 5 }), /delayMs is only valid for delayed mode/);
  } finally { await f.cleanup(); }
});
