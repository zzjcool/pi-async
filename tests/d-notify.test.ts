import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildNotificationXml, sendCompletionNotification, type NotifyPayload } from "../src/core/notify.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-notify-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return {
    dir,
    registry,
    cleanup: async () => {
      await registry.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Spawn a long-running task so its snapshot stays stable while we poke the notifier. */
function startTask(registry: TaskRegistry, extra: { command?: string; notifyOnCompletion?: boolean } = {}) {
  const task = registry.submit({ command: extra.command ?? "sleep 5", ...(extra.notifyOnCompletion === false ? { notifyOnCompletion: false } : {}) });
  return { taskId: task.taskId, name: task.name, outputFile: String(task.metadata.outputFile) };
}

function recorder() {
  const calls: Array<{ message: Record<string, unknown>; options: unknown }> = [];
  const sendMessage = (message: unknown, options: unknown): void => {
    calls.push({ message: message as Record<string, unknown>, options });
  };
  return { calls, sendMessage, pi: { sendMessage } };
}

function payloadFor(task: { taskId: string; name: string; outputFile: string }, overrides: Partial<NotifyPayload> = {}): NotifyPayload {
  return { taskId: task.taskId, name: task.name, status: "completed", outputFile: task.outputFile, ...overrides };
}

test("queued: a successful send latches notified, records one attempt, and calls sendMessage once", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    const rec = recorder();
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payloadFor(task)), "queued");
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0]!.options, { deliverAs: "followUp", triggerTurn: true });
    const snapshot = f.registry.get(task.taskId)!;
    assert.equal(snapshot.notified, true);
    assert.equal(snapshot.notifyAttempts, 1);
  } finally {
    await f.cleanup();
  }
});

test("failed: a throwing sendMessage is not retried, does not latch notified, and records one attempt", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    let calls = 0;
    const pi = {
      sendMessage: (): void => {
        calls++;
        throw new Error("offline");
      },
    };
    assert.equal(await sendCompletionNotification(pi as never, f.registry, payloadFor(task)), "failed");
    // The 0.2.0 loop retried three times; 0.3.0 sends once and reports honestly.
    assert.equal(calls, 1);
    const snapshot = f.registry.get(task.taskId)!;
    assert.equal(snapshot.notified, false);
    assert.equal(snapshot.notifyAttempts, 1);
  } finally {
    await f.cleanup();
  }
});

test("failed: a host without sendMessage reports failed and still records the attempt", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    assert.equal(await sendCompletionNotification({} as never, f.registry, payloadFor(task)), "failed");
    const snapshot = f.registry.get(task.taskId)!;
    assert.equal(snapshot.notified, false);
    assert.equal(snapshot.notifyAttempts, 1);
  } finally {
    await f.cleanup();
  }
});

test("skipped: a second call for an already-notified task sends nothing", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    const rec = recorder();
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payloadFor(task)), "queued");
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payloadFor(task)), "skipped");
    assert.equal(rec.calls.length, 1);
    assert.equal(f.registry.get(task.taskId)?.notifyAttempts, 1);
  } finally {
    await f.cleanup();
  }
});

test("skipped: consumed output suppresses delivery and does not count an attempt", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    f.registry.consume(task.taskId);
    const rec = recorder();
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payloadFor(task)), "skipped");
    assert.equal(rec.calls.length, 0);
    assert.equal(f.registry.get(task.taskId)?.notifyAttempts ?? 0, 0);
  } finally {
    await f.cleanup();
  }
});

test("skipped: notifyOnCompletion=false suppresses delivery and does not count an attempt", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry, { notifyOnCompletion: false });
    const rec = recorder();
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payloadFor(task)), "skipped");
    assert.equal(rec.calls.length, 0);
    assert.equal(f.registry.get(task.taskId)?.notified, false);
    assert.equal(f.registry.get(task.taskId)?.notifyAttempts ?? 0, 0);
  } finally {
    await f.cleanup();
  }
});

test("failed: a rejected sendMessage promise is caught, latches nothing, and stays handled", async () => {
  const f = fixture();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.once("unhandledRejection", onUnhandled);
  try {
    const task = startTask(f.registry);
    let calls = 0;
    // pi 1.5+ declares `sendMessage(): Promise<void>`: a rejection must be awaited, not leaked.
    const pi = {
      sendMessage: (): Promise<void> => {
        calls++;
        return Promise.reject(new Error("offline"));
      },
    };
    assert.equal(await sendCompletionNotification(pi as never, f.registry, payloadFor(task)), "failed");
    // Macrotask wait: give an unhandled rejection every chance to surface before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
    assert.equal(calls, 1);
    const snapshot = f.registry.get(task.taskId)!;
    assert.equal(snapshot.notified, false);
    assert.equal(snapshot.notifyAttempts, 1);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await f.cleanup();
  }
});

test("concurrency: the in-memory claim turns two simultaneous sends into one queued and one skipped", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    let calls = 0;
    const pi = {
      sendMessage: (): Promise<void> => {
        calls++;
        return new Promise<void>((resolve) => setTimeout(resolve, 20));
      },
    };
    const outcomes = await Promise.all([
      sendCompletionNotification(pi as never, f.registry, payloadFor(task)),
      sendCompletionNotification(pi as never, f.registry, payloadFor(task)),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual([...outcomes].sort(), ["queued", "skipped"]);
    const snapshot = f.registry.get(task.taskId)!;
    assert.equal(snapshot.notifyAttempts, 1);
    assert.equal(snapshot.notified, true);
  } finally {
    await f.cleanup();
  }
});

test("details: structured payload mirrors the XML fields without extra keys", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    const rec = recorder();
    const payload = payloadFor(task, {
      status: "failed",
      exitCode: 7,
      killKind: "output_cap",
      failureKind: "lost",
      summary: "tail",
      summaryTruncated: true,
      guidance: "inspect logs",
    });
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payload), "queued");
    const message = rec.calls[0]!.message;
    assert.equal(message.customType, "async-task-notification");
    assert.equal(message.content, buildNotificationXml(payload));
    assert.deepEqual(message.details, {
      taskId: task.taskId,
      name: task.name,
      status: "failed",
      exitCode: 7,
      killKind: "output_cap",
      failureKind: "lost",
      summary: "tail",
      summaryTruncated: true,
      outputFile: task.outputFile,
      guidance: "inspect logs",
    });
  } finally {
    await f.cleanup();
  }
});

test("content: stays async-task-notification XML with escaped values", async () => {
  const f = fixture();
  try {
    const task = startTask(f.registry);
    const rec = recorder();
    assert.equal(await sendCompletionNotification(rec.pi as never, f.registry, payloadFor(task, { name: "<task&>" })), "queued");
    const content = String(rec.calls[0]!.message.content);
    assert.match(content, /^<async-task-notification>/);
    assert.match(content, /<\/async-task-notification>$/);
    assert.match(content, /&lt;task&amp;&gt;/);
    assert.doesNotMatch(content, /<task&>/);
  } finally {
    await f.cleanup();
  }
});

test("resendUnnotified: resends only terminal, unnotified, unconsumed, fresh, under-cap tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-notify-resend-"));
  const now = Date.now();
  const snapshotFor = (overrides: Partial<TaskSnapshot>): TaskSnapshot => ({
    taskId: "task",
    name: "task",
    command: "true",
    mode: "background",
    status: "completed",
    createdAt: now - 60_000,
    finishedAt: now - 30_000,
    notified: false,
    outputConsumed: false,
    notifyAttempts: 0,
    metadata: { notifyOnCompletion: true, outputFile: join(dir, "task.output") },
    ...overrides,
  });
  const retryable = snapshotFor({ taskId: "retryable", name: "retryable" });
  const attemptCapped = snapshotFor({ taskId: "attempt-capped", name: "attempt-capped", notifyAttempts: 2 });
  const consumed = snapshotFor({ taskId: "consumed", name: "consumed", outputConsumed: true });
  const stale = snapshotFor({ taskId: "stale", name: "stale", finishedAt: now - 25 * 60 * 60 * 1000 });
  const pending = snapshotFor({
    taskId: "pending",
    name: "pending",
    status: "pending",
    mode: "delayed",
    dueAt: now + 3_600_000,
    finishedAt: undefined,
    metadata: { notifyOnCompletion: true, outputFile: join(dir, "pending.output") },
  });
  for (const snapshot of [retryable, attemptCapped, consumed, stale, pending]) {
    writeFileSync(join(dir, `${snapshot.taskId}.json`), JSON.stringify(snapshot));
  }

  const registry = new TaskRegistry({ dataDir: dir });
  try {
    await registry.reloadFromDisk();
    const sent: string[] = [];
    const rec = recorder();
    registry.setEvents({
      onFinalize: (snapshot) => {
        sent.push(snapshot.taskId);
        void sendCompletionNotification(rec.pi as never, registry, {
          taskId: snapshot.taskId,
          name: snapshot.name,
          status: snapshot.status,
          outputFile: String(snapshot.metadata.outputFile ?? ""),
        });
      },
      onStateChange: () => undefined,
    });

    assert.equal(await registry.resendUnnotified(), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["retryable"]);
    assert.equal(rec.calls.length, 1);
    assert.equal(registry.get("retryable")?.notified, true);
    assert.equal(registry.get("retryable")?.notifyAttempts, 1);
    for (const skippedId of ["attempt-capped", "consumed", "stale", "pending"]) {
      assert.equal(registry.get(skippedId)?.notified, false, `${skippedId} must stay unnotified`);
    }
    // The just-delivered task is latched, so a second session_start sweep is a no-op.
    assert.equal(await registry.resendUnnotified(), 0);
    assert.deepEqual(sent, ["retryable"]);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
