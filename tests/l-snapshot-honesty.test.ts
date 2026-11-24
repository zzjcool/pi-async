import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildNotificationXml, notifyLivenessFields, sendCompletionNotification } from "../src/core/notify.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { formatExitStatus, isTerminal, snapshotLiveness, type TaskSnapshot } from "../src/core/task.ts";
import { detailStatusLines } from "../src/tui/panel.ts";
import { makeSnapshot } from "./helpers/index.ts";

/**
 * #116 / D-07 裁决 B — CONTRACT §27 (REV-35): **a terminal snapshot must not claim the process is
 * gone when nobody watched it leave.**
 *
 * 0.5.3 wrote `processAlive: false` unconditionally in `finalize()`, so the D4 case (a `success_when`
 * hit settles the task while its process keeps running) produced a snapshot that contradicted
 * reality, and the notification carried no liveness field at all. The fix is a tri-state:
 * `processAlive: false` only when an exit was **observed**, `null` when it was not, plus
 * `processAliveKnown` / `exitCodeKnown` so a default can never be mistaken for evidence.
 */

const CLOSE_ENOUGH = { livenessIntervalMs: 60_000 } as const;

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-async-${label}-`));
}

function readSnapshot(dir: string, taskId: string): TaskSnapshot {
  return JSON.parse(readFileSync(join(dir, `${taskId}.json`), "utf8")) as TaskSnapshot;
}

function seedSnapshot(dir: string, snapshot: TaskSnapshot): void {
  writeFileSync(join(dir, `${snapshot.taskId}.json`), JSON.stringify(snapshot));
}

async function until(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function recorder(): { calls: Array<{ message: { content?: unknown; details?: Record<string, unknown> } }>; pi: { sendMessage: (message: unknown) => void } } {
  const calls: Array<{ message: { content?: unknown; details?: Record<string, unknown> } }> = [];
  return { calls, pi: { sendMessage: (message: unknown) => { calls.push({ message: message as { content?: unknown; details?: Record<string, unknown> } }); } } };
}

// ---------------------------------------------------------------------------
// Acceptance 1 — D4: the watch settles the task, the process keeps running
// ---------------------------------------------------------------------------

test("#116 acceptance 1: a watch hit that leaves the process running says `processAlive: null` (was false)", async () => {
  const dir = tempDir("honesty-d4");
  const registry = new TaskRegistry({ dataDir: dir, ...CLOSE_ENOUGH });
  try {
    const task = registry.submit({
      command: "printf 'READY\\n'; sleep 30",
      notifyOnCompletion: false,
      watch: {
        intervalMs: 1_000,
        timeoutMs: 20_000,
        success_when: [{ type: "stdout_contains", value: "READY" }],
        failure_when: [],
        blind_checks: 3,
      },
    });
    await until(() => registry.get(task.taskId)?.status === "completed", "the watch to settle the task");
    const snapshot = registry.get(task.taskId)!;

    // The premise of the defect: the task is settled, the process is *not*.
    assert.equal(registry.isProcessAlive(task.taskId), true, "D4: the process outlives the watch settlement");

    assert.equal(snapshot.processAlive, null, "no exit was observed → null, never false");
    assert.equal(snapshot.processAliveKnown, false, "no observation → not known");
    assert.equal(snapshot.exitCode, null, "no exit status was observed");
    assert.equal(snapshot.exitCodeKnown, false);

    // `null` is written into the JSON, not dropped: a missing field must keep meaning "old snapshot".
    const persisted = readSnapshot(dir, task.taskId);
    assert.equal(Object.prototype.hasOwnProperty.call(persisted, "processAlive"), true, "processAlive is present");
    assert.equal(persisted.processAlive, null);
    assert.equal(persisted.processAliveKnown, false);

    // …and the notification says the same thing instead of implying a death.
    const xml = buildNotificationXml({ taskId: snapshot.taskId, name: snapshot.name, status: snapshot.status, outputFile: "/tmp/out", ...notifyLivenessFields(snapshot) });
    assert.match(xml, /<process-alive>unknown<\/process-alive>/);
    assert.match(xml, /<process-alive-known>false<\/process-alive-known>/);
    assert.match(xml, /<exit-code-known>false<\/exit-code-known>/);
    assert.doesNotMatch(xml, /<exit-code>/);

    await registry.kill(task.taskId, "user");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Acceptance 2 — control group: a真 exit keeps its certainty
// ---------------------------------------------------------------------------

test("#116 acceptance 2 (control): an observed exit is still `false` + known, with the real code", async () => {
  const dir = tempDir("honesty-exit");
  const registry = new TaskRegistry({ dataDir: dir, ...CLOSE_ENOUGH });
  try {
    // notifyOnCompletion stays on: the notification path is the second channel that must agree.
    const task = registry.submit({ command: "exit 3", notifyOnCompletion: true });
    await until(() => isTerminal(registry.get(task.taskId)?.status ?? "running"), "the task to exit");
    const snapshot = registry.get(task.taskId)!;

    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.processAlive, false, "the exit was observed — certainty must not degrade to null");
    assert.equal(snapshot.processAliveKnown, true);
    assert.equal(snapshot.exitCode, 3, "the child's code is the child's");
    assert.equal(snapshot.exitCodeKnown, true);

    const xml = buildNotificationXml({ taskId: snapshot.taskId, name: snapshot.name, status: snapshot.status, exitCode: 3, outputFile: "/tmp/out", ...notifyLivenessFields(snapshot) });
    assert.match(xml, /<process-alive>exited<\/process-alive>/);
    assert.match(xml, /<process-alive-known>true<\/process-alive-known>/);
    assert.match(xml, /<exit-code>3<\/exit-code>/);
    assert.match(xml, /<exit-code-known>true<\/exit-code-known>/);

    // The structured twin the TUI renderer reads carries them too (one definition, both channels).
    const rec = recorder();
    assert.equal(await sendCompletionNotification(rec.pi as never, registry, {
      taskId: snapshot.taskId, name: snapshot.name, status: snapshot.status, exitCode: 3, outputFile: "/tmp/out", ...notifyLivenessFields(snapshot),
    }), "queued");
    const details = rec.calls[0]!.message.details!;
    assert.equal(details.processAlive, "exited");
    assert.equal(details.processAliveKnown, true);
    assert.equal(details.exitCode, 3);
    assert.equal(details.exitCodeKnown, true);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Acceptance 3 — adoption, both halves (3.3: the code is no longer thrown away)
// ---------------------------------------------------------------------------

test("#116 acceptance 3a: a same-process retired handle lands the exit status only it could see", async () => {
  const dir = tempDir("honesty-adopt-code");
  const registry = new TaskRegistry({ dataDir: dir, ...CLOSE_ENOUGH });
  try {
    const task = registry.submit({ command: "sleep 0.3; exit 7", notifyOnCompletion: false });
    await registry.suspend();
    // The retired generation must not settle the task (REV-28a) — but it does still own the handle,
    // so the exit *value* is there for the taking: it is merged into the persisted snapshot.
    await until(() => readSnapshot(dir, task.taskId).exitCodeKnown === true, "the retired handle to land the exit status");
    const landed = readSnapshot(dir, task.taskId);
    assert.equal(landed.exitCode, 7);
    assert.equal(landed.exitCodeKnown, true);
    assert.equal(landed.status, "running", "the retired generation never settles the task (REV-28a)");

    registry.configure({ dataDir: dir, cwd: dir });
    const adopted = registry.get(task.taskId)!;
    assert.equal(adopted.status, "failed");
    assert.equal(adopted.failureKind, "lost");
    assert.equal(adopted.processAlive, false, "the pid probe proved the group is gone");
    assert.equal(adopted.processAliveKnown, true);
    assert.equal(adopted.exitCode, 7, "the adopted owner reads the code the retired handle observed");
    assert.equal(adopted.exitCodeKnown, true);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#116 acceptance 3b: an adoption with no observation stays `null` + unknown (no pretending)", async () => {
  const dir = tempDir("honesty-adopt-unknown");
  const registry = new TaskRegistry({ dataDir: dir, ...CLOSE_ENOUGH });
  try {
    // Exactly what a previous *process* leaves behind: a running snapshot whose pid is long gone.
    // Nothing in this process ever saw the exit, so nothing may claim the exit status.
    seedSnapshot(dir, makeSnapshot({
      taskId: "adopted-unknown",
      status: "running",
      pid: 2_000_000_000,
      metadata: { outputFile: join(dir, "adopted-unknown.output") },
    }));
    await registry.reloadFromDisk();
    const adopted = registry.get("adopted-unknown")!;

    assert.equal(adopted.status, "failed");
    assert.equal(adopted.failureKind, "lost");
    assert.equal(adopted.processAlive, false, "the dead-pid probe is an observation");
    assert.equal(adopted.processAliveKnown, true);
    assert.equal(adopted.exitCode, null, "cross-process adoption cannot know the code");
    assert.equal(adopted.exitCodeKnown, false);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Acceptance 4 — old snapshots: unknown, no migration, no inference
// ---------------------------------------------------------------------------

test("#116 acceptance 4: a pre-0.5.4 snapshot reads as unknown — `processAlive: false` is not evidence", () => {
  // 0.5.3 wrote this `false` unconditionally, so it cannot be read as "watched it die".
  const legacy = makeSnapshot({ taskId: "legacy", name: "legacy", status: "failed", finishedAt: 10, processAlive: false, exitCode: 7 });
  assert.equal(snapshotLiveness(legacy), "unknown");
  // A *number* is different in kind: the old code only wrote it from an observed exit.
  assert.equal(formatExitStatus(legacy.exitCode), "exit 7");

  const detail = detailStatusLines(legacy, null, 20).join("\n");
  assert.match(detail, /process: unknown/);
  assert.doesNotMatch(detail, /process: exited/, "the display must never infer a death it cannot see");
  assert.match(detail, /exit 7/);

  // 0.5.2 and earlier have neither field at all — same answer, and nothing throws.
  const absent = makeSnapshot({ taskId: "absent", name: "absent", status: "completed", finishedAt: 10 });
  assert.equal(snapshotLiveness(absent), "unknown");
  assert.equal(formatExitStatus(absent.exitCode), "exit unknown");
  const absentDetail = detailStatusLines(absent, null, 20).join("\n");
  assert.match(absentDetail, /process: unknown · exit unknown/);

  // A running snapshot makes no claim yet, so the detail does not invent one.
  const running = makeSnapshot({ taskId: "running", status: "running" });
  assert.equal(snapshotLiveness(running), "unknown");
  assert.doesNotMatch(detailStatusLines(running, null, 20).join("\n"), /process:/);
});

// ---------------------------------------------------------------------------
// Acceptance 5 — the notification field table and the implementation agree
// ---------------------------------------------------------------------------

test("#116 acceptance 5: `unknown` is a value in the notification table, and `exit-code` needs a number", () => {
  const unknown = buildNotificationXml({
    taskId: "t-unknown", name: "n", status: "killed", exitCode: null, outputFile: "/tmp/out",
    ...notifyLivenessFields({ processAlive: null, processAliveKnown: false, exitCode: null, exitCodeKnown: false }),
  });
  assert.match(unknown, /<process-alive>unknown<\/process-alive>/);
  assert.match(unknown, /<process-alive-known>false<\/process-alive-known>/);
  assert.match(unknown, /<exit-code-known>false<\/exit-code-known>/);
  assert.doesNotMatch(unknown, /<exit-code>/, "an unobserved code is never rendered as one");

  const exited = buildNotificationXml({
    taskId: "t-exited", name: "n", status: "completed", exitCode: 0, outputFile: "/tmp/out",
    ...notifyLivenessFields({ processAlive: false, processAliveKnown: true, exitCode: 0, exitCodeKnown: true }),
  });
  assert.match(exited, /<process-alive>exited<\/process-alive>/);
  assert.match(exited, /<process-alive-known>true<\/process-alive-known>/);
  assert.match(exited, /<exit-code>0<\/exit-code>/, "exit 0 is still a real code");
  assert.match(exited, /<exit-code-known>true<\/exit-code-known>/);
});
