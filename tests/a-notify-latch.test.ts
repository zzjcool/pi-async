import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { buildNotificationXml, sendCompletionNotification } from "../src/core/notify.ts";

test("completion notifications escape XML and include guidance only for failure", () => {
  const common = { taskId: "a&b", name: "<task>", outputFile: "/tmp/out" };
  const done = buildNotificationXml({ ...common, status: "completed", guidance: "ignored" });
  assert.match(done, /a&amp;b/);
  assert.doesNotMatch(done, /guidance/);
  assert.match(buildNotificationXml({ ...common, status: "failed", guidance: "inspect logs" }), /<guidance>inspect logs<\/guidance>/);
});

test("notification latch sends once and outputConsumed suppresses delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-notify-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const task = registry.submit({ command: "sleep 5" });
    let calls = 0;
    const pi = { sendMessage: async (...args: unknown[]) => { calls++; assert.equal((args[1] as { triggerTurn: boolean }).triggerTurn, true); } };
    const payload = { taskId: task.taskId, name: task.name, status: "completed" as const, outputFile: join(dir, `${task.taskId}.output`) };
    assert.equal(await sendCompletionNotification(pi as never, registry, payload), true);
    assert.equal(await sendCompletionNotification(pi as never, registry, payload), false);
    assert.equal(calls, 1);
    const followUpCalls: unknown[][] = [];
    const followUpPi = { sendMessage: async (...args: unknown[]) => { followUpCalls.push(args); } };
    const followUpTask = registry.submit({ command: "sleep 5" });
    assert.equal(await sendCompletionNotification(followUpPi as never, registry, { ...payload, taskId: followUpTask.taskId }, { triggerTurn: false }), true);
    assert.deepEqual(followUpCalls[0]?.[1], { deliverAs: "followUp" });
    const other = registry.submit({ command: "sleep 5" });
    registry.consume(other.taskId);
    assert.equal(await sendCompletionNotification(pi as never, registry, { ...payload, taskId: other.taskId }), false);
    assert.equal(calls, 1);
  } finally { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
