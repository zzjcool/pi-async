import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildNotificationXml, sendCompletionNotification } from "../src/core/notify.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { TaskSnapshot, WatchSpec } from "../src/core/task.ts";
import { makeSnapshot } from "./helpers/index.ts";

function fixture(maxOutputBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-notify-kinds-"));
  const registry = new TaskRegistry({ dataDir: dir, ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}) });
  return {
    dir,
    registry,
    cleanup: async () => {
      await registry.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const watch = (overrides: Partial<WatchSpec> = {}): WatchSpec => ({
  intervalMs: 1000,
  timeoutMs: 5000,
  success_when: [{ type: "stdout_contains", value: "never" }],
  failure_when: [],
  ...overrides,
});

/** Mirror extensions/index.ts onFinalize payload assembly (REV-11). */
function notifyPayloadFromSnapshot(registry: TaskRegistry, snapshot: TaskSnapshot) {
  const outputFile = String(snapshot.metadata.outputFile ?? "");
  const logSlice = registry.logs(snapshot.taskId, { maxBytes: 8192, tail: true });
  const outputTail = logSlice.text;
  const guidance = snapshot.status === "failed"
    ? `Inspect task output with async_logs (taskId: ${snapshot.taskId}).`
    : undefined;
  const summaryTruncated = snapshot.metadata.capped === true || logSlice.truncated;
  return {
    taskId: snapshot.taskId,
    name: snapshot.name,
    status: snapshot.status,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    outputFile,
    ...(outputTail ? { summary: outputTail } : {}),
    ...(guidance ? { guidance } : {}),
    ...(snapshot.killKind ? { killKind: snapshot.killKind } : {}),
    ...(snapshot.failureKind ? { failureKind: snapshot.failureKind } : {}),
    ...(summaryTruncated ? { summaryTruncated: true as const } : {}),
  };
}

test("buildNotificationXml emits kill-kind, failure-kind, and summary-truncated when set", () => {
  const xml = buildNotificationXml({
    taskId: "t1",
    name: "cap",
    status: "failed",
    outputFile: "/tmp/out",
    summary: "XXXX",
    guidance: "inspect",
    killKind: "output_cap",
    summaryTruncated: true,
  });
  assert.match(xml, /<kill-kind>output_cap<\/kill-kind>/);
  assert.match(xml, /<summary-truncated>true<\/summary-truncated>/);
  assert.doesNotMatch(xml, /failure-kind/);

  const lost = buildNotificationXml({
    taskId: "t2",
    name: "lost",
    status: "failed",
    outputFile: "/tmp/out",
    failureKind: "lost",
    guidance: "inspect",
  });
  assert.match(lost, /<failure-kind>lost<\/failure-kind>/);
  assert.doesNotMatch(lost, /kill-kind/);
});

test("output cap: waitResult and notify XML carry kill-kind=output_cap + summary-truncated", async () => {
  const f = fixture(64);
  const xmls: string[] = [];
  try {
    f.registry.setEvents({
      onFinalize: (snapshot) => {
        const payload = notifyPayloadFromSnapshot(f.registry, snapshot);
        xmls.push(buildNotificationXml(payload));
        void sendCompletionNotification(
          { sendMessage: async () => undefined } as never,
          f.registry,
          payload,
        );
      },
      onStateChange: () => undefined,
    });
    const task = f.registry.submit({ command: "yes X", name: "cap" });
    const outcome = await f.registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    const result = outcome.results[0]!;
    assert.equal(result.status, "failed");
    assert.equal(result.killKind, "output_cap");
    assert.equal(result.failureKind, undefined);
    assert.equal(f.registry.get(task.taskId)?.metadata.capped, true);

    assert.ok(xmls.length >= 1);
    assert.match(xmls[0]!, /<kill-kind>output_cap<\/kill-kind>/);
    assert.match(xmls[0]!, /<summary-truncated>true<\/summary-truncated>/);
    assert.doesNotMatch(xmls[0]!, /failure-kind/);
  } finally {
    await f.cleanup();
  }
});

test("reload lost: notify XML carries failure-kind=lost without kill-kind", async () => {
  const f = fixture();
  try {
    const snapshot = makeSnapshot({
      taskId: "dead-lost",
      pid: 2_000_000_000,
      metadata: { outputFile: join(f.dir, "dead-lost.output") },
    });
    writeFileSync(join(f.dir, `${snapshot.taskId}.json`), JSON.stringify(snapshot));
    writeFileSync(join(f.dir, "dead-lost.output"), "partial\n");

    let xml = "";
    f.registry.setEvents({
      onFinalize: (snap) => {
        xml = buildNotificationXml(notifyPayloadFromSnapshot(f.registry, snap));
      },
      onStateChange: () => undefined,
    });
    await f.registry.reloadFromDisk();

    const lost = f.registry.get(snapshot.taskId)!;
    assert.equal(lost.status, "failed");
    assert.equal(lost.failureKind, "lost");
    assert.equal(lost.killKind, undefined);
    assert.match(xml, /<failure-kind>lost<\/failure-kind>/);
    assert.doesNotMatch(xml, /kill-kind/);

    const outcome = await f.registry.wait([snapshot.taskId], 1000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.failureKind, "lost");
    assert.equal(outcome.results[0]?.killKind, undefined);
  } finally {
    await f.cleanup();
  }
});

test("watch timeout: failed + killKind=watch_failure + failureKind=watch_timeout", async () => {
  const f = fixture();
  let pid: number | undefined;
  try {
    const task = f.registry.submit({ command: "sleep 8", name: "timeout" });
    pid = task.pid;
    f.registry.attachWatch(task.taskId, watch({ timeoutMs: 1200 }));
    const outcome = await f.registry.wait([task.taskId], 4000);
    assert.ok("results" in outcome);
    const result = outcome.results[0]!;
    assert.equal(result.status, "failed");
    assert.equal(result.killKind, "watch_failure");
    assert.equal(result.failureKind, "watch_timeout");

    const snap = f.registry.get(task.taskId)!;
    assert.equal(snap.killKind, "watch_failure");
    assert.equal(snap.failureKind, "watch_timeout");
    const xml = buildNotificationXml(notifyPayloadFromSnapshot(f.registry, snap));
    assert.match(xml, /<kill-kind>watch_failure<\/kill-kind>/);
    assert.match(xml, /<failure-kind>watch_timeout<\/failure-kind>/);
  } finally {
    if (pid !== undefined) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
    await f.cleanup();
  }
});

test("blind exhausted: failed + killKind=watch_failure + failureKind=blind_exhausted (distinct from timeout)", async () => {
  const f = fixture();
  let pid: number | undefined;
  try {
    const task = f.registry.submit({ command: "sleep 30", name: "blind" });
    pid = task.pid;
    const outputFile = String(f.registry.get(task.taskId)?.metadata.outputFile);
    rmSync(outputFile, { force: true });
    f.registry.attachWatch(task.taskId, watch({
      timeoutMs: 30_000,
      blind_checks: 1,
      success_when: [{ type: "stdout_contains", value: "never" }],
    }));
    const outcome = await f.registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    const result = outcome.results[0]!;
    assert.equal(result.status, "failed");
    assert.equal(result.killKind, "watch_failure");
    assert.equal(result.failureKind, "blind_exhausted");
    assert.notEqual(result.failureKind, "watch_timeout");

    const snap = f.registry.get(task.taskId)!;
    const xml = buildNotificationXml(notifyPayloadFromSnapshot(f.registry, snap));
    assert.match(xml, /<kill-kind>watch_failure<\/kill-kind>/);
    assert.match(xml, /<failure-kind>blind_exhausted<\/failure-kind>/);
    assert.doesNotMatch(xml, /watch_timeout/);
  } finally {
    if (pid !== undefined) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
    await f.cleanup();
  }
});
