import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { killTree } from "../src/core/spawn.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * 0.4.2 defect: `suspend()` retires a generation with no way back ("ghost running task").
 *
 * The host retires the extension generation on `session_shutdown(reason=reload|resume)`; when it
 * never builds the next one, nothing adopts the work. Every later child exit hit the
 * `if (this.suspended) return` fence — no finalize, no persist, no notification — so the snapshot
 * stayed `running` forever, its reminder timer was gone, and admission stayed closed for the rest
 * of the session (`Async task admission is closed (registry suspended: ...)`).
 *
 * REV-28a: `configure()` on a suspended instance revives it and re-adopts from disk (disk wins).
 * REV-28c: a two-strike liveness sweep settles a `running` task whose exit was never observed.
 * REV-28d: `spawnDetached` settles on 'exit' after a grace window when a grandchild holds fd 1/2.
 */

const LINUX_PROC = process.platform === "linux" && existsSync("/proc");
const HAS_SETSID = spawnSync("/bin/sh", ["-c", "command -v setsid"], { stdio: "ignore" }).status === 0;

/** Process-group probing needs /proc here; don't let a non-Linux dev box go red. */
function requireLinuxProc(t: TestContext): boolean {
  if (LINUX_PROC) return true;
  t.skip("needs /proc process-group probing (CI is ubuntu)");
  return false;
}

/** The sweep cases additionally need a way to move a grandchild into its own process group. */
function requireSetsid(t: TestContext): boolean {
  if (!requireLinuxProc(t)) return false;
  if (HAS_SETSID) return true;
  t.skip("needs util-linux setsid");
  return false;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readSnapshot(dataDir: string, taskId: string): TaskSnapshot | undefined {
  const file = join(dataDir, `${taskId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TaskSnapshot;
  } catch {
    return undefined;
  }
}

/** Same probe the registry uses for liveness: a non-zombie member of the process group. */
function groupHasLiveMember(pgid: number): boolean {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(join("/proc", entry, "stat"), "utf8");
        const closeParen = stat.lastIndexOf(") ");
        if (closeParen < 0) continue;
        const rest = stat.slice(closeParen + 2).split(" ");
        if (Number(rest[2]) === pgid && rest[0] !== "Z") return true;
      } catch { /* raced with exit */ }
    }
    return false;
  } catch {
    return false;
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  // Don't signal a group we can no longer see (pid reuse would hit an unrelated process). Without
  // /proc the check cannot run, so the kill stays best-effort there.
  if (LINUX_PROC && !groupHasLiveMember(pid)) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/**
 * REV-28a: the incident path. A child dies while the generation is retired, so its exit is never
 * observed; the next `configure()` on the same instance must settle it from disk, and admission
 * must be open again.
 */
test("configure() revives a suspended registry and settles a task whose process died while retired", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const task = registry.submit({ command: "sleep 30", notifyOnCompletion: false });
    const snapshotPath = join(dir, `${task.taskId}.json`);
    assert.equal(readSnapshot(dir, task.taskId)?.status, "running", "submit persists the start snapshot");

    await registry.suspend();
    killGroup(task.pid);
    await waitFor(() => !groupHasLiveMember(task.pid!), "the child process group to die");

    // The incident's ghost: the child is gone, but a retired generation writes nothing.
    assert.equal(readSnapshot(dir, task.taskId)?.status, "running", "the retired generation must not finalize");
    assert.throws(() => registry.submit({ command: "true" }), /admission is closed \(registry suspended/, "suspend fences admission");

    registry.configure({ dataDir: dir, cwd: dir });

    const revived = registry.get(task.taskId);
    assert.ok(revived, "the revived instance re-adopts the snapshot");
    assert.equal(revived.status, "failed");
    assert.equal(revived.failureKind, "lost");
    assert.equal(typeof revived.finishedAt, "number");
    assert.equal(revived.processAlive, false);

    const persisted = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskSnapshot;
    assert.equal(persisted.status, "failed", "the adopted snapshot is really rewritten on disk");
    assert.equal(persisted.failureKind, "lost");
    assert.equal(typeof persisted.finishedAt, "number");

    // Admission is open again — the failure this defect produced was permanent.
    const next = registry.submit({ command: "true", notifyOnCompletion: false });
    const outcome = await registry.wait([next.taskId], 5000);
    assert.ok("results" in outcome && outcome.results[0]?.status === "completed");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** REV-28a: a surviving process is adopted (not reaped) and the adapter watcher settles it later. */
test("a revived registry re-adopts a still-running task and its watcher finalizes it when the process dies", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-adopt-"));
  // Keep the sweep out of the picture: the 100 ms adoption watcher must be the path that settles it.
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  try {
    const task = registry.submit({ command: "sleep 30", notifyOnCompletion: false });
    await registry.suspend();
    registry.configure({ dataDir: dir, cwd: dir });

    const revived = registry.get(task.taskId);
    assert.equal(revived?.status, "running", "a live process is adopted, never reaped");
    assert.doesNotThrow(() => registry.submit({ command: "true", notifyOnCompletion: false }), "admission is open after revival");

    killGroup(task.pid);
    await waitFor(() => registry.get(task.taskId)?.status === "failed", "the adopted watcher to settle the task");
    assert.equal(registry.get(task.taskId)?.failureKind, "lost");
    assert.equal(readSnapshot(dir, task.taskId)?.status, "failed");
    assert.equal(finalized.filter((id) => id === task.taskId).length, 1, "settled exactly once");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** REV-28a: the retired generation's late exit callback must not touch the revived snapshot. */
test("a retired exit callback cannot overwrite the snapshot the revived instance settled", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-retired-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  try {
    // Exits on its own after the revival: both the retired exit callback and the adopted watcher
    // observe the same death, and only the owner may write.
    const task = registry.submit({ command: "sleep 0.6", notifyOnCompletion: false });
    await registry.suspend();
    registry.configure({ dataDir: dir, cwd: dir });
    assert.equal(registry.get(task.taskId)?.status, "running");

    await waitFor(() => registry.get(task.taskId)?.status === "failed", "the watcher to settle the task");
    const settled = readSnapshot(dir, task.taskId);
    assert.ok(settled);
    assert.equal(settled.status, "failed");
    assert.equal(settled.failureKind, "lost");

    // Give the retired exit callback room to fire; it must stay silent.
    await delay(800);
    const after = readSnapshot(dir, task.taskId);
    assert.ok(after);
    assert.equal(after.status, settled.status, "the retired generation must not rewrite the status");
    assert.equal(after.failureKind, settled.failureKind);
    assert.equal(after.finishedAt, settled.finishedAt, "the settlement time is stable");
    assert.equal(after.exitCode, undefined, "the retired callback did not record an exit code");
    assert.equal(finalized.filter((id) => id === task.taskId).length, 1, "one finalize, never two");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * S1 (0.4.2 regression): the exit callback must finish its infrastructure work *before* bailing out
 * on a terminal snapshot. `finalize()` deliberately keeps the timeout timer of a watch-success task
 * alive while its process still runs (D4/#33), so this callback is the only place that can clear it
 * once the process is gone — a ref'd timer left behind pins the host until `taskTimeoutMs` for an
 * already settled task.
 *
 * The timer is observed without touching production code: the global timer functions are wrapped for
 * the duration of the test and only the task-timeout delay range is tracked.
 */
test("a watch-success task releases its task timeout when the process exits afterwards", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-timer-release-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  const TIMEOUT_MS = 8000;
  const armed = new Set<unknown>();
  const cleared = new Set<unknown>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const patched = globalThis as unknown as { setTimeout: typeof globalThis.setTimeout; clearTimeout: typeof globalThis.clearTimeout };
  try {
    patched.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = realSetTimeout(fn, ms, ...rest);
      if (typeof ms === "number" && ms > TIMEOUT_MS - 1000 && ms <= TIMEOUT_MS) armed.add(handle);
      return handle;
    }) as typeof globalThis.setTimeout;
    patched.clearTimeout = ((handle?: unknown) => {
      if (handle !== undefined) cleared.add(handle);
      realClearTimeout(handle as never);
    }) as typeof globalThis.clearTimeout;

    const task = registry.submit({
      command: "printf 'READY\\n'; sleep 2",
      taskTimeoutMs: TIMEOUT_MS,
      watch: { intervalMs: 1000, timeoutMs: 20_000, success_when: [{ type: "stdout_contains", value: "READY" }], failure_when: [] },
      notifyOnCompletion: false,
    });

    // The watch settles the task while the process keeps running, so `finalize()` keeps the timer.
    await waitFor(() => registry.get(task.taskId)?.status === "completed", "the watch to settle the task", 8000);
    assert.ok(armed.size >= 1, "the task timeout timer was armed");
    assert.equal(registry.isProcessAlive(task.taskId), true, "the process outlives the watch settlement");

    // The process exits on its own afterwards: the timer must be released even though the task is terminal.
    await waitFor(() => !registry.isProcessAlive(task.taskId), "the process to exit after the watch settlement", 8000);
    await delay(100);
    for (const handle of armed) assert.ok(cleared.has(handle), "the task timeout timer is cleared once the process is gone");
    // A terminal snapshot is never rewritten with the late exit code — the accepted S1 semantics.
    assert.equal(registry.get(task.taskId)?.exitCode, undefined);
  } finally {
    patched.setTimeout = realSetTimeout;
    patched.clearTimeout = realClearTimeout;
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28a (0.4.2): `kill()` awaits `killTree` for up to ~3 s when the child ignores SIGTERM. A revival
 * during that window must not let the stale caller settle the *adopted* snapshot (the old code
 * wrote `killed` to disk while memory said `running` and cleared the adopted watcher for good).
 */
test("a kill() awaiting a TERM-ignoring child cannot settle the revived snapshot", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-kill-revive-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  let pid: number | undefined;
  try {
    // `trap "" TERM` is inherited across exec, so killTree spends its full grace window waiting.
    const task = registry.submit({ command: 'trap "" TERM; sleep 30', notifyOnCompletion: false });
    pid = task.pid;
    const killing = registry.kill(task.taskId, "user");
    await waitFor(() => registry.isProcessAlive(task.taskId), "the TERM-ignoring child to be alive");
    await delay(150);

    // Retire and revive while the kill is still awaiting the process group.
    await registry.suspend();
    registry.configure({ dataDir: dir, cwd: dir });
    assert.equal(registry.get(task.taskId)?.status, "running", "the SIGTERM-ignoring child is adopted running");
    assert.equal(readSnapshot(dir, task.taskId)?.status, registry.get(task.taskId)?.status, "the revival keeps memory and disk in agreement");

    await killing;
    // The awaited kill must not have written a terminal snapshot behind the revived owner's back.
    assert.equal(readSnapshot(dir, task.taskId)?.status, registry.get(task.taskId)?.status, "memory and disk still agree after the awaited kill");

    await waitFor(() => registry.get(task.taskId)?.status === "failed", "the adopted watcher to settle the killed task");
    assert.equal(registry.get(task.taskId)?.failureKind, "lost", "the revived owner reports the death as lost");
    const settled = readSnapshot(dir, task.taskId);
    assert.ok(settled);
    assert.equal(settled.status, "failed");
    assert.equal(settled.failureKind, "lost");
    assert.equal(settled.exitCode, undefined, "no stale exit code from the retired handle");
    assert.equal(finalized.filter((id) => id === task.taskId).length, 1, "settled exactly once");

    await delay(400);
    assert.equal(readSnapshot(dir, task.taskId)?.finishedAt, settled.finishedAt, "the record is stable afterwards");
  } finally {
    killGroup(pid);
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28a (0.4.2): the revival must fence handles first, then run the data-dir decision **while the
 * non-terminal snapshots are still in memory** — dropping them first loses the migration and leaves
 * `metadata.outputFile` pointing at a directory `logs()` refuses to read.
 */
test("revival into a different data dir migrates the adopted task and keeps logs readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-async-revive-migrate-"));
  const oldDir = join(root, "old");
  const newDir = join(root, "new");
  const registry = new TaskRegistry({ dataDir: oldDir, livenessIntervalMs: 60_000 });
  let pid: number | undefined;
  try {
    // Configure the initial data dir BEFORE any submit: `first === false` is what makes this a
    // regression test. A never-configured registry takes the `first` branch and reloads+reaps in the
    // old implementation too, so the test would pass without the fix.
    registry.configure({ dataDir: oldDir, cwd: oldDir });
    const task = registry.submit({ command: "printf 'MIGRATE-MARKER\\n'; sleep 30", notifyOnCompletion: false });
    pid = task.pid;
    await waitFor(
      () => existsSync(join(oldDir, `${task.taskId}.output`)) && readFileSync(join(oldDir, `${task.taskId}.output`), "utf8").includes("MIGRATE-MARKER"),
      "the task output to land in the old data dir",
    );

    await registry.suspend();
    registry.configure({ dataDir: newDir, cwd: newDir });

    const adopted = registry.get(task.taskId);
    assert.ok(adopted, "the non-terminal snapshot is adopted from the new data dir, not abandoned");
    assert.equal(adopted.status, "running");
    assert.equal(adopted.metadata.outputFile, join(newDir, `${task.taskId}.output`), "the artifact path is rewritten to the new dir");
    // Before the fix this threw "Refusing to read task output outside the async data directory".
    assert.match(registry.logs(task.taskId).text, /MIGRATE-MARKER/);
    assert.equal(existsSync(join(newDir, `${task.taskId}.json`)), true, "the snapshot lives in the new dir");
    assert.equal(existsSync(join(oldDir, `${task.taskId}.json`)), false, "the old artifacts are moved, not duplicated");
  } finally {
    killGroup(pid);
    await registry.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/** REV-28a: the same with a terminal snapshot in memory, which takes the `migrateDataDir()` branch. */
test("revival + data-dir migration keeps a terminal snapshot and the running one usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-async-revive-migrate-terminal-"));
  const oldDir = join(root, "old");
  const newDir = join(root, "new");
  const registry = new TaskRegistry({ dataDir: oldDir, livenessIntervalMs: 60_000 });
  let runningPid: number | undefined;
  try {
    // Same as above: `first === false`, otherwise the old code would migrate on the first configure anyway.
    registry.configure({ dataDir: oldDir, cwd: oldDir });
    const done = registry.submit({ command: "printf 'TERMINAL-MARKER\\n'", notifyOnCompletion: false });
    const outcome = await registry.wait([done.taskId], 5000);
    assert.ok("results" in outcome && outcome.results[0]?.status === "completed");

    const running = registry.submit({ command: "printf 'RUNNING-MARKER\\n'; sleep 30", notifyOnCompletion: false });
    runningPid = running.pid;
    await waitFor(
      () => existsSync(join(oldDir, `${running.taskId}.output`)) && readFileSync(join(oldDir, `${running.taskId}.output`), "utf8").includes("RUNNING-MARKER"),
      "the running task output to land in the old dir",
    );

    await registry.suspend();
    registry.configure({ dataDir: newDir, cwd: newDir });

    const kept = registry.get(done.taskId);
    assert.equal(kept?.status, "completed", "the terminal snapshot stays in memory and is not re-adopted");
    assert.equal(kept?.metadata.outputFile, join(newDir, `${done.taskId}.output`), "its artifact path was migrated too");
    assert.match(registry.logs(done.taskId).text, /TERMINAL-MARKER/);

    const adopted = registry.get(running.taskId);
    assert.equal(adopted?.status, "running", "the running snapshot is re-adopted from the new dir");
    assert.equal(adopted?.metadata.outputFile, join(newDir, `${running.taskId}.output`));
    assert.match(registry.logs(running.taskId).text, /RUNNING-MARKER/);
  } finally {
    killGroup(runningPid);
    await registry.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/** S4 (0.4.2): the revival re-arms the hard deadline with its **remaining** budget, not a fresh one. */
test("a revived task keeps its remaining taskTimeout and is killed on time", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-timeout-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  let pid: number | undefined;
  try {
    const task = registry.submit({ command: "sleep 30", taskTimeoutMs: 1500, notifyOnCompletion: false });
    pid = task.pid;
    await delay(600);
    await registry.suspend();
    registry.configure({ dataDir: dir, cwd: dir });

    const adopted = registry.get(task.taskId);
    assert.equal(adopted?.status, "running", "the live process is adopted");
    assert.equal(typeof adopted?.timeoutAt, "number", "the absolute deadline survives the revival");
    assert.ok(adopted!.timeoutAt! - Date.now() < 1500, "the remaining budget is shorter than a fresh window");

    await waitFor(() => registry.get(task.taskId)?.status === "killed", "the re-armed task timeout to fire", 6000);
    assert.equal(registry.get(task.taskId)?.killKind, "timeout", "the kill came from the re-armed deadline");
  } finally {
    killGroup(pid);
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** S4: a pending delayed task survives the revival and still fires on its remaining delay. */
test("a revived pending delayed task keeps its schedule and still starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-delayed-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  try {
    const delayed = registry.scheduleDelayed({ command: "printf 'DELAYED-RAN\\n'", notifyOnCompletion: false }, 900);
    assert.equal(registry.get(delayed.taskId)?.status, "pending");
    await registry.suspend();
    registry.configure({ dataDir: dir, cwd: dir });

    assert.equal(registry.get(delayed.taskId)?.status, "pending", "an un-expired delayed task is re-adopted, not lost");
    await waitFor(() => registry.get(delayed.taskId)?.status === "completed", "the re-armed delayed start", 6000);
    assert.match(registry.logs(delayed.taskId).text, /DELAYED-RAN/);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * S4: the reminder is re-armed from its persisted absolute deadline — and the timer really fires.
 * Checking `remindAt` alone would pass on a registry that merely keeps its stale in-memory snapshot
 * (suspend() never deletes the deadline), so the discriminator is that the re-armed timer fires.
 */
test("a revived task re-arms its reminder from the persisted deadline and it fires", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-remind-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  const reminders: string[] = [];
  registry.setEvents({ onFinalize: () => undefined, onStateChange: () => undefined, onReminder: (snapshot) => { reminders.push(snapshot.taskId); } });
  let pid: number | undefined;
  try {
    // Notifications stay on: a suppressed reminder (`notifyOnCompletion:false`) is dropped on reload
    // by design (§18.6), which would hide the re-arm this test is about.
    const task = registry.submit({ command: "sleep 30", remindAfterMs: 1200 });
    pid = task.pid;
    const armedAt = registry.get(task.taskId)?.remindAt;
    assert.ok(typeof armedAt === "number", "the reminder was armed at start");

    await registry.suspend();
    registry.configure({ dataDir: dir, cwd: dir });

    const adopted = registry.get(task.taskId);
    assert.equal(adopted?.status, "running");
    assert.equal(adopted?.remindAt, armedAt, "the deadline is re-armed from the persisted value, not recomputed");
    assert.equal(adopted?.remindCount, 0);
    assert.equal(adopted?.metadata.remindIntervalMs, 1200);

    await waitFor(() => (registry.get(task.taskId)?.remindCount ?? 0) >= 1, "the re-armed reminder to fire", 5000);
    assert.deepEqual(reminders, [task.taskId], "the re-armed timer delivered exactly one reminder");
  } finally {
    killGroup(pid);
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28a (0.4.2): `dropForReAdoption()` frees the ids, so a snapshot disk cannot give back (deleted or
 * unparsable) used to vanish: no terminal status, no state event, a per-task activity spinner with
 * no end. It must be settled as `failed/lost` exactly once instead.
 */
test("a revived snapshot that disk cannot give back is settled as lost instead of vanishing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-revive-missing-"));
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 60_000 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  let pids: Array<number | undefined> = [];
  try {
    const deleted = registry.submit({ command: "sleep 30", notifyOnCompletion: false });
    const corrupt = registry.submit({ command: "sleep 30", notifyOnCompletion: false });
    pids = [deleted.pid, corrupt.pid];
    await registry.suspend();
    rmSync(join(dir, `${deleted.taskId}.json`), { force: true });
    writeFileSync(join(dir, `${corrupt.taskId}.json`), "{ this is not json");

    registry.configure({ dataDir: dir, cwd: dir });

    for (const taskId of [deleted.taskId, corrupt.taskId]) {
      const snapshot = registry.get(taskId);
      assert.ok(snapshot, "the snapshot is not silently lost");
      assert.equal(snapshot.status, "failed");
      assert.equal(snapshot.failureKind, "lost");
      assert.equal(typeof snapshot.finishedAt, "number");
      assert.equal(readSnapshot(dir, taskId)?.status, "failed", "the settlement is visible on disk again");
      assert.equal(finalized.filter((id) => id === taskId).length, 1, "exactly one finalize");
    }
  } finally {
    for (const pid of pids) killGroup(pid);
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28c: a `running` task whose exit was never observed is settled by the liveness sweep.
 *
 * The leader exits immediately while a `setsid` grandchild inherits — and keeps — the output pipe,
 * so 'close' never fires and the exit fallback sits in a (deliberately long) grace window. No exit
 * callback and no adoption watcher can settle this snapshot: only the sweep can.
 */
test("the liveness sweep settles a running task whose exit was never observed", async (t) => {
  if (!requireSetsid(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-liveness-"));
  const pidFile = join(dir, "grandchild.pid");
  // Two strikes at 40 ms, so settlement lands near 80 ms. The exit fallback is disabled on purpose:
  // an enabled fallback owns settlement as soon as the child's exit is observed, so the sweep would
  // (correctly) yield and never run here.
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 40, spawnExitGraceMs: 0 });
  let grandchild: number | undefined;
  try {
    const task = registry.submit({ command: `setsid sleep 30 & echo $! > ${pidFile}`, notifyOnCompletion: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, "the grandchild pid file");
    grandchild = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchild) && grandchild > 1);

    await waitFor(() => registry.get(task.taskId)?.status === "failed", "the liveness sweep to settle the task", 5000);
    assert.equal(registry.get(task.taskId)?.failureKind, "lost");
    assert.equal(typeof registry.get(task.taskId)?.finishedAt, "number");
    assert.equal(readSnapshot(dir, task.taskId)?.status, "failed", "the sweep persists like the load-time path");
    assert.equal(readSnapshot(dir, task.taskId)?.failureKind, "lost");
  } finally {
    if (grandchild !== undefined) { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28c (0.4.2, contract revision): one dead observation is not enough. A tick can land in the window
 * where the OS reaped the child but Node has not dispatched `exit` yet; settling on it reports a
 * healthy `exit 0` daemon as `failed/lost`.
 */
test("the liveness sweep needs two consecutive dead observations before settling", async (t) => {
  if (!requireSetsid(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-two-strikes-"));
  const pidFile = join(dir, "grandchild.pid");
  // Ticks at 500/1000/1500 ms: the checkpoint at ~750 ms sits in the middle of the 500–1000 window.
  const INTERVAL_MS = 500;
  // Fallback off: it would settle the task as soon as the exit is observed, leaving nothing to sweep.
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: INTERVAL_MS, spawnExitGraceMs: 0 });
  let grandchild: number | undefined;
  try {
    const submittedAt = Date.now();
    const task = registry.submit({ command: `setsid sleep 30 & echo $! > ${pidFile}`, notifyOnCompletion: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, "the grandchild pid file");
    grandchild = Number(readFileSync(pidFile, "utf8").trim());
    await waitFor(() => !registry.isProcessAlive(task.taskId), "the leader to exit while the grandchild holds the pipe");
    await delay(750);
    // Guard against a vacuous pass: the checkpoint must be past the first tick, or "still running"
    // would just mean the sweep never ran.
    assert.ok(Date.now() - submittedAt >= INTERVAL_MS * 1.2, "the first sweep tick has certainly run");
    assert.equal(registry.get(task.taskId)?.status, "running", "a single dead observation must not settle the task");
    await waitFor(() => registry.get(task.taskId)?.status === "failed", "the second strike to settle the task", 4000);
    assert.equal(registry.get(task.taskId)?.failureKind, "lost");
  } finally {
    if (grandchild !== undefined) { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28c (0.4.2): the flip side of the two-strike rule — the exit fallback must win a comparable race,
 * so an exit-0 daemon whose leader returned 0 is reported `completed`, never `lost`.
 *
 * The phase is deterministic: the leader exits a few ms after submit while the sweep's first tick
 * cannot land before `livenessIntervalMs`, so one strike would settle at ~I and two strikes at
 * ~2I. With I=300 and a 450 ms fallback, a single-strike sweep settles first (this test fails) and
 * a two-strike sweep settles after the fallback (this test passes).
 */
test("an exit-0 daemon is completed by the exit fallback, not swept into lost", async (t) => {
  if (!requireSetsid(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-fallback-wins-"));
  const pidFile = join(dir, "grandchild.pid");
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 300, spawnExitGraceMs: 450 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  let grandchild: number | undefined;
  try {
    const task = registry.submit({ command: `setsid sleep 30 & echo $! > ${pidFile}`, notifyOnCompletion: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, "the grandchild pid file");
    grandchild = Number(readFileSync(pidFile, "utf8").trim());

    await waitFor(() => registry.get(task.taskId)?.status !== "running", "the exit fallback to settle the task", 5000);
    assert.equal(registry.get(task.taskId)?.status, "completed", "a zero exit is a completion, not a lost process");
    assert.equal(registry.get(task.taskId)?.exitCode, 0);

    await delay(1200); // more than one sweep interval: the settled task must stay settled
    assert.equal(registry.get(task.taskId)?.status, "completed");
    assert.equal(finalized.filter((id) => id === task.taskId).length, 1);
  } finally {
    if (grandchild !== undefined) { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * S2 (0.4.2): the sweep must yield to the exit fallback **structurally** — it skips any task whose
 * spawn handle observed the child's `exit`. Before this the two settlers raced, so `grace > interval`
 * let the sweep win (`{livenessIntervalMs: 1000, spawnExitGraceMs: 5000}` reported a real `exit 0`
 * daemon as `failed/lost`).
 */
test("the sweep yields to the exit fallback even when its interval is far below the grace", async (t) => {
  if (!requireSetsid(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-fallback-structural-"));
  const pidFile = join(dir, "grandchild.pid");
  const registry = new TaskRegistry({ dataDir: dir, livenessIntervalMs: 80, spawnExitGraceMs: 600 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  let grandchild: number | undefined;
  try {
    const task = registry.submit({ command: `setsid sleep 5 & echo $! > ${pidFile}`, notifyOnCompletion: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, "the grandchild pid file");
    grandchild = Number(readFileSync(pidFile, "utf8").trim());

    // The leader's exit is observed immediately, so only the 600 ms fallback may settle this task —
    // a sweep at 80 ms would otherwise win several times over.
    await waitFor(() => registry.get(task.taskId)?.status !== "running", "the exit fallback to settle the task", 5000);
    assert.equal(registry.get(task.taskId)?.status, "completed", "an observed exit is a completion, not a lost process");
    assert.equal(registry.get(task.taskId)?.exitCode, 0);

    await delay(80 * 4); // >= 3 sweep intervals after settlement: the record must not change
    assert.equal(registry.get(task.taskId)?.status, "completed");
    assert.equal(finalized.filter((id) => id === task.taskId).length, 1, "settled exactly once");
  } finally {
    if (grandchild !== undefined) { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28d: `spawnExitGraceMs <= 0` **disables** the fallback — it must not be read as "settle
 * instantly", which would drop the output of every task whose child exits before its pipes flush.
 */
test("a non-positive exit grace disables the fallback instead of settling instantly", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-exit-fallback-off-"));
  const registry = new TaskRegistry({ dataDir: dir, spawnExitGraceMs: 0 });
  let pid: number | undefined;
  try {
    const startedAt = Date.now();
    const task = registry.submit({ command: "printf 'KEEP-ME\\n'; (sleep 1.2 &) ; exit 0", notifyOnCompletion: false });
    pid = task.pid;

    await delay(600);
    assert.equal(registry.get(task.taskId)?.status, "running", "no fallback: 'close' stays the only signal");

    await waitFor(() => registry.get(task.taskId)?.status === "completed", "the pipe holder to release 'close'", 6000);
    assert.equal(registry.get(task.taskId)?.exitCode, 0);
    assert.match(registry.logs(task.taskId).text, /KEEP-ME/, "output written before the pipes closed is kept");
    assert.ok(Date.now() - startedAt >= 1000, "it waited for the real pipe close, it did not settle at t=0");
  } finally {
    if (pid !== undefined) await killTree(pid).catch(() => ({ confirmed: false }));
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * REV-28d: the spawn exit fallback. The leader exits at once but its backgrounded grandchild keeps
 * fd 1/2, so 'close' never arrives. The exit code must still settle the task inside the injected
 * grace window instead of hanging until the grandchild dies.
 */
test("the spawn exit fallback settles a task whose grandchild keeps the output pipe open", async (t) => {
  if (!requireLinuxProc(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-exit-fallback-"));
  const registry = new TaskRegistry({ dataDir: dir, spawnExitGraceMs: 120 });
  let pid: number | undefined;
  try {
    const task = registry.submit({ command: "(sleep 30 &) ; exit 0", notifyOnCompletion: false });
    pid = task.pid;

    await waitFor(() => registry.get(task.taskId)?.status === "completed", "the exit fallback to settle the task", 5000);
    assert.equal(registry.get(task.taskId)?.exitCode, 0, "the exit code is the child's");
    assert.equal(readSnapshot(dir, task.taskId)?.status, "completed");
    assert.equal(groupHasLiveMember(pid!), true, "it settled while the pipe holder was still alive");
  } finally {
    if (pid !== undefined) await killTree(pid).catch(() => ({ confirmed: false }));
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
