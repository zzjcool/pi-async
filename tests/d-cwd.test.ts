import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";

/** REV-13: tasks run in the session cwd (`ctx.cwd`), never in the host process cwd. */

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-async-cwd-data-"));
  const registry = new TaskRegistry({ dataDir });
  return {
    dataDir,
    registry,
    cleanup: async () => {
      await registry.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const real = (path: string): string => realpathSync(path);

test("submit runs the command in the requested cwd, not the host process cwd", async () => {
  const sessionCwd = makeDir("pi-async-session-cwd-");
  const f = fixture();
  try {
    assert.notEqual(real(sessionCwd), real(process.cwd()), "fixture must use a cwd that differs from the process cwd");
    const task = f.registry.submit({ command: "pwd -P", cwd: sessionCwd });
    const outcome = await f.registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    const printed = outcome.results[0]!.outputTail.trim();
    assert.equal(real(printed), real(sessionCwd));
  } finally {
    await f.cleanup();
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

test("TaskSnapshot.cwd is persisted and survives reloadFromDisk", async () => {
  const sessionCwd = makeDir("pi-async-session-cwd-");
  const f = fixture();
  const restored = new TaskRegistry({ dataDir: f.dataDir });
  try {
    const task = f.registry.submit({ command: "printf cwd", cwd: sessionCwd });
    assert.equal(task.cwd, sessionCwd);
    await f.registry.wait([task.taskId], 5000);
    const persisted = JSON.parse(readFileSync(join(f.dataDir, `${task.taskId}.json`), "utf8")) as { cwd?: string };
    assert.equal(persisted.cwd, sessionCwd);
    await restored.reloadFromDisk();
    assert.equal(restored.get(task.taskId)?.cwd, sessionCwd);
  } finally {
    await restored.shutdown();
    await f.cleanup();
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

test("delayed tasks keep the cwd captured at submit time", async () => {
  const sessionCwd = makeDir("pi-async-session-cwd-");
  const f = fixture();
  try {
    const task = f.registry.scheduleDelayed({ command: "pwd -P", cwd: sessionCwd }, 50);
    assert.equal(task.cwd, sessionCwd);
    const persisted = JSON.parse(readFileSync(join(f.dataDir, `${task.taskId}.json`), "utf8")) as { cwd?: string; status?: string };
    assert.equal(persisted.cwd, sessionCwd);
    assert.equal(persisted.status, "pending");
    const outcome = await f.registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    assert.equal(real(outcome.results[0]!.outputTail.trim()), real(sessionCwd));
  } finally {
    await f.cleanup();
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

test("a missing cwd rejects a background submit and fails a delayed task", async () => {
  const f = fixture();
  const missing = join(tmpdir(), `pi-async-missing-cwd-${process.pid}-${Date.now()}`);
  try {
    assert.throws(() => f.registry.submit({ command: "true", cwd: missing }), /Working directory does not exist/);
    assert.equal(f.registry.list({ includeHistory: true }).length, 0, "a rejected submit must not leave a task behind");

    const logged: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    try {
      const delayed = f.registry.scheduleDelayed({ command: "true", cwd: missing }, 10);
      const outcome = await f.registry.wait([delayed.taskId], 5000);
      assert.ok("results" in outcome);
      assert.equal(outcome.results[0]?.status, "failed");
      const snapshot = f.registry.get(delayed.taskId);
      assert.equal(snapshot?.status, "failed");
      // A delayed start failure must be diagnosable, not swallowed by the timer callback.
      assert.match(String(snapshot?.metadata.startError), /Working directory does not exist/);
      const persisted = JSON.parse(readFileSync(join(f.dataDir, `${delayed.taskId}.json`), "utf8")) as { metadata: { startError?: string } };
      assert.match(String(persisted.metadata.startError), /Working directory does not exist/, "startError is persisted");
      assert.ok(logged.some((entry) => String(entry).includes("failed to start")), "the failure is logged");
    } finally {
      console.error = originalError;
    }
  } finally {
    await f.cleanup();
  }
});
