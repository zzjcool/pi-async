import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { spawnDetached, killTree } from "../src/core/spawn.ts";
import { makeSnapshot } from "./helpers/index.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-review-"));
  return { dir, registry: new TaskRegistry({ dataDir: dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSnapshot(dir: string, snapshot: ReturnType<typeof makeSnapshot>): void {
  writeFileSync(join(dir, `${snapshot.taskId}.json`), JSON.stringify(snapshot));
}

test("reload marks a persisted running task with a dead pid as lost", async () => {
  const f = fixture();
  try {
    const snapshot = makeSnapshot({ taskId: "dead-task", pid: 2_000_000_000, metadata: { outputFile: join(f.dir, "dead-task.output") } });
    writeSnapshot(f.dir, snapshot);
    let finalized = 0;
    f.registry.setEvents({ onFinalize: () => { finalized++; }, onStateChange: () => undefined });
    await f.registry.reloadFromDisk();
    assert.equal(f.registry.get(snapshot.taskId)?.status, "failed");
    assert.equal(f.registry.get(snapshot.taskId)?.failureKind, "lost");
    assert.equal(finalized, 1);
  } finally { await f.registry.shutdown(); f.cleanup(); }
});

test("reload restores a live pid with wait and kill support", async () => {
  const f = fixture();
  const outputFile = join(f.dir, "live-task.output");
  const handle = spawnDetached("sleep 30", { outputFile });
  try {
    writeSnapshot(f.dir, makeSnapshot({ taskId: "live-task", pid: handle.pid, metadata: { outputFile } }));
    await f.registry.reloadFromDisk();
    const waiting = f.registry.wait(["live-task"], 5000);
    await f.registry.kill("live-task", "user");
    const outcome = await waiting;
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "killed");
    assert.equal(f.registry.get("live-task")?.killKind, "user");
  } finally {
    await f.registry.shutdown();
    await killTree(handle.pid, { graceMs: 0 });
    f.cleanup();
  }
});

test("kill reports the confirmed=false leak error instead of silently finalizing", async () => {
  const f = fixture();
  const task = f.registry.submit({ command: "sleep 30" });
  const originalKill = process.kill;
  const originalNow = Date.now;
  let clock = originalNow();
  try {
    // SAFETY: this scoped test double forces group probes to stay alive and makes bounded deadlines elapse immediately.
    process.kill = (() => true) as typeof process.kill;
    Date.now = () => (clock += 10_000);
    await assert.rejects(f.registry.kill(task.taskId, "user"), /Descendant processes may have leaked/);
  } finally {
    process.kill = originalKill;
    Date.now = originalNow;
    await f.registry.shutdown();
    f.cleanup();
  }
});

test("environment numeric settings fall back when values are not finite", async () => {
  const previousTasks = process.env.PI_ASYNC_MAX_TASKS;
  const previousOutput = process.env.PI_ASYNC_MAX_OUTPUT_BYTES;
  process.env.PI_ASYNC_MAX_TASKS = "NaN";
  process.env.PI_ASYNC_MAX_OUTPUT_BYTES = "Infinity";
  const f = fixture();
  try {
    const task = f.registry.submit({ command: "true" });
    const outcome = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in outcome);
  } finally {
    if (previousTasks === undefined) delete process.env.PI_ASYNC_MAX_TASKS; else process.env.PI_ASYNC_MAX_TASKS = previousTasks;
    if (previousOutput === undefined) delete process.env.PI_ASYNC_MAX_OUTPUT_BYTES; else process.env.PI_ASYNC_MAX_OUTPUT_BYTES = previousOutput;
    await f.registry.shutdown();
    f.cleanup();
  }
});

test("unknown ids, terminal kill, and empty commands have defined negative behavior", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.registry.wait(["missing"], 0), /Unknown task id/);
    await f.registry.kill("missing", "user");
    const terminal = makeSnapshot({ taskId: "terminal", status: "completed" });
    writeSnapshot(f.dir, terminal);
    await f.registry.reloadFromDisk();
    await f.registry.kill("terminal", "user");
    assert.equal(f.registry.get("terminal")?.status, "completed");
    assert.throws(() => f.registry.submit({ command: "  " }), /command must not be empty/);
  } finally { await f.registry.shutdown(); f.cleanup(); }
});
