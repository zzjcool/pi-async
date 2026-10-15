import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { sendCompletionNotification } from "../src/core/notify.ts";

function fixture(maxTasks = 32) {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-registry-"));
  return { dir, registry: new TaskRegistry({ dataDir: dir, maxTasks, maxOutputBytes: 4096 }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("background submit returns immediately and event-driven wait resolves all finalized tasks", async () => {
  const f = fixture();
  try {
    let finalized = 0;
    f.registry.setEvents({ onFinalize: () => { finalized++; }, onStateChange: () => undefined });
    const a = f.registry.submit({ command: "sleep 0.05; printf a" });
    const b = f.registry.submit({ command: "printf b" });
    const result = await f.registry.wait([a.taskId, b.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results.length, 2);
    assert.equal(finalized, 2);
    assert.ok(f.registry.get(a.taskId)?.outputConsumed);
  } finally { await f.registry.shutdown(); f.cleanup(); }
});

test("wait timeout returns notReady and AbortSignal rejects without killing work", async () => {
  const f = fixture();
  try {
    const task = f.registry.submit({ command: "sleep 0.5" });
    const notReady = await f.registry.wait([task.taskId], 5);
    assert.ok("notReady" in notReady);
    assert.equal(f.registry.get(task.taskId)?.status, "running");
    const controller = new AbortController();
    const waiting = f.registry.wait([task.taskId], 2000, controller.signal);
    controller.abort(new Error("Esc"));
    await assert.rejects(waiting, /Esc/);
    assert.equal(f.registry.get(task.taskId)?.status, "running");
  } finally { await f.registry.shutdown(); f.cleanup(); }
});

test("MAX_TASKS rejects over-admission and notification retry rolls back the latch", async () => {
  const f = fixture(1);
  try {
    const task = f.registry.submit({ command: "sleep 5" });
    assert.throws(() => f.registry.submit({ command: "true" }), /Maximum active/);
    let calls = 0;
    const pi = { sendMessage: async () => { calls++; throw new Error("offline"); } };
    const payload = { taskId: task.taskId, name: task.name, status: "failed" as const, outputFile: join(f.dir, `${task.taskId}.output`) };
    assert.equal(await sendCompletionNotification(pi as never, f.registry, payload), false);
    assert.equal(calls, 3);
    assert.equal(f.registry.get(task.taskId)?.notified, false);
    await f.registry.kill(task.taskId, "user");
  } finally { await f.registry.shutdown(); f.cleanup(); }
});
