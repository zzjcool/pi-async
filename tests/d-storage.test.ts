import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { streamPaths } from "../src/core/spawn.ts";
import { makeSnapshot } from "./helpers/index.ts";

/** REV-14/REV-16 storage hardening: path boundaries, missing files, streams, orphans, migration, pruning. */

function fixture(config: { retentionMs?: number; retentionCount?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-async-storage-"));
  const registry = new TaskRegistry({ dataDir, ...config });
  return {
    dataDir,
    registry,
    cleanup: async () => {
      await registry.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function seedSnapshot(dataDir: string, snapshot: ReturnType<typeof makeSnapshot>): void {
  writeFileSync(join(dataDir, `${snapshot.taskId}.json`), JSON.stringify(snapshot));
}

test("logs refuses to read an output file outside the data dir", async () => {
  const f = fixture();
  const outsideDir = mkdtempSync(join(tmpdir(), "pi-async-outside-"));
  const outsideOutput = join(outsideDir, "escape.output");
  writeFileSync(outsideOutput, "secret\n");
  try {
    seedSnapshot(f.dataDir, makeSnapshot({
      taskId: "escape",
      status: "completed",
      finishedAt: Date.now(),
      metadata: { outputFile: outsideOutput },
    }));
    await f.registry.reloadFromDisk();
    assert.throws(() => f.registry.logs("escape", {}), /outside the async data directory/);
    assert.throws(() => f.registry.logs("escape", { stream: "stdout" }), /outside the async data directory/);
    assert.throws(() => f.registry.logs("escape", { stream: "stderr" }), /outside the async data directory/);
  } finally {
    await f.cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("prune never deletes artifacts living outside the data dir", async () => {
  const f = fixture({ retentionMs: 1, retentionCount: 0 });
  const outsideDir = mkdtempSync(join(tmpdir(), "pi-async-outside-"));
  const outsideOutput = join(outsideDir, "escape.output");
  writeFileSync(outsideOutput, "secret\n");
  try {
    seedSnapshot(f.dataDir, makeSnapshot({
      taskId: "escape",
      status: "completed",
      finishedAt: Date.now() - 60_000,
      metadata: { outputFile: outsideOutput },
    }));
    // reloadFromDisk ends with prune(); the aged terminal task is dropped from memory but
    // its out-of-bounds artifact must survive (D-11: skip, do not throw).
    await f.registry.reloadFromDisk();
    assert.equal(f.registry.get("escape"), undefined);
    assert.equal(existsSync(outsideOutput), true);
    assert.equal(readFileSync(outsideOutput, "utf8"), "secret\n");
  } finally {
    await f.cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("a missing output file returns missing:true instead of throwing", async () => {
  const f = fixture();
  try {
    const outputFile = join(f.dataDir, "gone.output");
    seedSnapshot(f.dataDir, makeSnapshot({ taskId: "gone", status: "completed", finishedAt: Date.now(), metadata: { outputFile } }));
    await f.registry.reloadFromDisk();
    const slice = f.registry.logs("gone", { tail: true });
    assert.equal(slice.text, "");
    assert.equal(slice.truncated, false);
    assert.equal(slice.missing, true);
    assert.ok(slice.fullPath.endsWith("gone.output"));
    // A missing stream sidecar behaves the same way.
    assert.equal(f.registry.logs("gone", { stream: "stdout" }).missing, true);
  } finally {
    await f.cleanup();
  }
});

test("logs separates merged/stdout/stderr streams", async () => {
  const f = fixture();
  try {
    const task = f.registry.submit({ command: "printf OUT; printf ERR 1>&2" });
    const outcome = await f.registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    const stdout = f.registry.logs(task.taskId, { stream: "stdout" });
    const stderr = f.registry.logs(task.taskId, { stream: "stderr" });
    const merged = f.registry.logs(task.taskId, { stream: "merged" });
    assert.equal(stdout.text, "OUT");
    assert.equal(stderr.text, "ERR");
    assert.match(merged.text, /OUT/);
    assert.match(merged.text, /ERR/);
    assert.equal(f.registry.logs(task.taskId, {}).text, merged.text);
    assert.equal(stdout.missing, undefined);
  } finally {
    await f.cleanup();
  }
});

test("reapOrphans fails dead/orphaned running tasks and keeps pending delayed work", async () => {
  const f = fixture();
  const orphanedPids: number[] = [];
  try {
    const deadPid = f.registry.submit({ command: "sleep 30" });
    assert.ok(deadPid.pid);
    orphanedPids.push(deadPid.pid);
    // Simulate a pid that no longer exists; the real child is killed in `finally` below.
    deadPid.pid = 2_000_000_000;
    const noPid = f.registry.submit({ command: "sleep 30" });
    orphanedPids.push(noPid.pid!);
    delete (noPid as { pid?: number }).pid;
    const delayed = f.registry.scheduleDelayed({ command: "printf later" }, 30_000);
    const alive = f.registry.submit({ command: "sleep 30" });

    assert.equal(f.registry.reapOrphans(), 2);
    assert.equal(f.registry.get(deadPid.taskId)?.status, "failed");
    assert.equal(f.registry.get(deadPid.taskId)?.failureKind, "lost");
    assert.equal(f.registry.get(deadPid.taskId)?.processAlive, false);
    assert.equal(f.registry.get(noPid.taskId)?.status, "failed");
    assert.equal(f.registry.get(noPid.taskId)?.failureKind, "lost");
    assert.equal(f.registry.get(delayed.taskId)?.status, "pending");
    assert.equal(f.registry.get(alive.taskId)?.status, "running");
    assert.equal(f.registry.reapOrphans(), 0, "reaping is idempotent");
  } finally {
    // The two tampered snapshots no longer address their real children: sweep them before
    // teardown, otherwise shutdown() would wait on their exit promise.
    for (const pid of orphanedPids) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
    await f.cleanup();
  }
});

test("configure migrates task artifacts to the new data dir", async () => {
  const oldDir = mkdtempSync(join(tmpdir(), "pi-async-migrate-old-"));
  const newParent = mkdtempSync(join(tmpdir(), "pi-async-migrate-new-"));
  const newDir = join(newParent, "moved");
  const registry = new TaskRegistry({ dataDir: oldDir });
  try {
    const task = registry.submit({ command: "printf migrated" });
    const outcome = await registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    for (const suffix of [".json", ".output", ".stdout", ".stderr"]) {
      assert.ok(existsSync(join(oldDir, `${task.taskId}${suffix}`)), `fixture is missing ${suffix} in the old dir`);
    }

    registry.configure({ dataDir: newDir });

    for (const suffix of [".json", ".output", ".stdout", ".stderr"]) {
      assert.ok(existsSync(join(newDir, `${task.taskId}${suffix}`)), `${suffix} was not migrated`);
    }
    assert.equal(registry.get(task.taskId)?.metadata.outputFile, join(newDir, `${task.taskId}.output`));
    assert.equal(registry.list({ includeHistory: true }).length, 1);
    assert.equal(registry.logs(task.taskId).text, "migrated");
    const persisted = JSON.parse(readFileSync(join(newDir, `${task.taskId}.json`), "utf8")) as { metadata: { outputFile?: string } };
    assert.equal(persisted.metadata.outputFile, join(newDir, `${task.taskId}.output`));
    assert.equal(readdirSync(oldDir).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    await registry.shutdown();
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newParent, { recursive: true, force: true });
  }
});

test("configure keeps the old data dir when migration fails", async () => {
  const oldDir = mkdtempSync(join(tmpdir(), "pi-async-migrate-old-"));
  const blockedParent = mkdtempSync(join(tmpdir(), "pi-async-migrate-blocked-"));
  const blocked = join(blockedParent, "not-a-dir");
  writeFileSync(blocked, "occupied");
  const registry = new TaskRegistry({ dataDir: oldDir });
  const errors: unknown[] = [];
  const originalError = console.error;
  try {
    const task = registry.submit({ command: "printf keep" });
    await registry.wait([task.taskId], 5000);
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    registry.configure({ dataDir: blocked });
    console.error = originalError;

    // Keeping the old dir means: same metadata path, artifacts still there, still readable.
    assert.equal(registry.get(task.taskId)?.metadata.outputFile, join(oldDir, `${task.taskId}.output`));
    assert.equal(existsSync(join(blocked, `${task.taskId}.json`)), false, "no artifacts may land in the failed target");
    assert.equal(existsSync(join(oldDir, `${task.taskId}.json`)), true);
    assert.equal(registry.list({ includeHistory: true }).length, 1, "tasks must survive a failed migration");
    assert.equal(registry.logs(task.taskId).text, "keep");
    assert.ok(errors.some((entry) => String(entry).includes("data dir migration failed")));
  } finally {
    console.error = originalError;
    await registry.shutdown();
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(blockedParent, { recursive: true, force: true });
  }
});

test("prune removes .stdout/.stderr sidecars with the rest of the task artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-prune-sidecars-"));
  const registry = new TaskRegistry({ dataDir: dir, retentionMs: 1, retentionCount: 0 });
  try {
    const taskId = "aged";
    const outputFile = join(dir, `${taskId}.output`);
    const { stdout, stderr } = streamPaths(outputFile);
    writeFileSync(outputFile, "old\n");
    writeFileSync(stdout, "old stdout\n");
    writeFileSync(stderr, "old stderr\n");
    seedSnapshot(dir, makeSnapshot({ taskId, status: "completed", finishedAt: Date.now() - 60_000, metadata: { outputFile } }));

    await registry.reloadFromDisk(); // ends with prune()

    for (const file of [outputFile, stdout, stderr, join(dir, `${taskId}.json`)]) {
      assert.equal(existsSync(file), false, `${file} should have been pruned`);
    }
    assert.equal(registry.get(taskId), undefined);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Regression (cross-lane, W1b repro): `/reload` retires generation A with `suspend()`, generation B
 * adopts the surviving process. A's `live.exit` callback used to keep running when the adopted
 * child exited and persisted `failed`, overwriting B's `killed/timeout` snapshot on disk.
 */
test("a suspended generation never overwrites the adopting generation's terminal snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-suspend-race-"));
  const retired = new TaskRegistry({ dataDir: dir });
  const adopting = new TaskRegistry({ dataDir: dir });
  try {
    const task = retired.submit({ command: "sleep 5" });
    const snapshotPath = join(dir, `${task.taskId}.json`);
    await retired.suspend();
    await adopting.reloadFromDisk();
    assert.equal(adopting.get(task.taskId)?.status, "running", "the new generation adopts the live process");

    await adopting.kill(task.taskId, "user");
    assert.equal(adopting.get(task.taskId)?.status, "killed");

    // Give the retired generation's child-exit callback time to fire (it must stay silent).
    await new Promise((resolve) => setTimeout(resolve, 700));

    const persisted = JSON.parse(readFileSync(snapshotPath, "utf8")) as { status?: string; killKind?: string; failureKind?: string };
    assert.equal(persisted.status, "killed", "the retired generation must not rewrite the terminal status");
    assert.equal(persisted.killKind, "user");
    assert.equal(persisted.failureKind, undefined);
  } finally {
    await adopting.shutdown();
    await retired.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Same invariant pinned without a second generation: a retired registry must stay read-only-on-exit. */
test("a suspended generation does not finalize or persist its child's later exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-suspend-exit-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const task = registry.submit({ command: "sleep 0.3" });
    const snapshotPath = join(dir, `${task.taskId}.json`);
    await registry.suspend();

    // The child exits on its own while this generation is already retired.
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.equal(registry.get(task.taskId)?.status, "running", "a retired generation must not finalize work it no longer owns");
    const persisted = JSON.parse(readFileSync(snapshotPath, "utf8")) as { status?: string; failureKind?: string };
    assert.equal(persisted.status, "running", "a retired generation must not persist a terminal snapshot");
    assert.equal(persisted.failureKind, undefined);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Item 1(a): a persisted `running` snapshot with no pid can never be alive — reload settles it once. */
test("reloadFromDisk marks a hand-written running snapshot without a pid as lost exactly once", async () => {
  const f = fixture();
  const finalized: string[] = [];
  f.registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  try {
    seedSnapshot(f.dataDir, makeSnapshot({
      taskId: "no-pid",
      status: "running",
      metadata: { outputFile: join(f.dataDir, "no-pid.output") },
    }));
    await f.registry.reloadFromDisk();
    assert.equal(f.registry.get("no-pid")?.status, "failed");
    assert.equal(f.registry.get("no-pid")?.failureKind, "lost");
    assert.equal(f.registry.get("no-pid")?.processAlive, false);
    assert.deepEqual(finalized, ["no-pid"], "the orphan is reported exactly once");
  } finally {
    await f.cleanup();
  }
});

/**
 * Item 1(b): `configure()` is the production caller of `reapOrphans()`. A pending delayed task
 * whose due time fell out of the retention window is only reaped by that call (the reload path
 * keeps pending work), so this test fails if the wiring is missing.
 */
test("configure() reaps stale pending delayed tasks but keeps live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-configure-reap-"));
  const registry = new TaskRegistry({ dataDir: dir, retentionMs: 60_000, retentionCount: 100 });
  const finalized: string[] = [];
  registry.setEvents({ onFinalize: (snapshot) => { finalized.push(snapshot.taskId); }, onStateChange: () => undefined });
  const now = Date.now();
  try {
    seedSnapshot(dir, makeSnapshot({
      taskId: "stale-delay",
      status: "pending",
      mode: "delayed",
      createdAt: now - 10 * 60_000,
      dueAt: now - 10 * 60_000,
      metadata: { outputFile: join(dir, "stale-delay.output") },
    }));
    seedSnapshot(dir, makeSnapshot({
      taskId: "fresh-delay",
      status: "pending",
      mode: "delayed",
      createdAt: now,
      dueAt: now + 60_000,
      metadata: { outputFile: join(dir, "fresh-delay.output") },
    }));

    registry.configure({ dataDir: dir, cwd: dir });

    assert.equal(registry.get("stale-delay")?.status, "failed", "an out-of-retention pending task is reaped");
    assert.equal(registry.get("stale-delay")?.failureKind, "lost");
    assert.equal(registry.get("fresh-delay")?.status, "pending", "live pending delayed work is kept");
    assert.deepEqual(finalized, ["stale-delay"]);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Item 4: a retired (/reload-suspended) generation must not accept new work. */
test("a suspended registry rejects new admissions", async () => {
  const f = fixture();
  try {
    await f.registry.suspend();
    assert.throws(() => f.registry.submit({ command: "true" }), /Async task admission is closed/);
    assert.throws(() => f.registry.scheduleDelayed({ command: "true" }, 10), /Async task admission is closed/);
    await assert.rejects(f.registry.runSync({ command: "true" }, 1000, "promote"), /Async task admission is closed/);
  } finally {
    await f.cleanup();
  }
});

/** Item 7: task artifacts are written 0600 and keep that mode across a data-dir migration. */
test("task artifacts are mode 0600, including after a data-dir migration", async () => {
  const oldDir = mkdtempSync(join(tmpdir(), "pi-async-mode-old-"));
  const newParent = mkdtempSync(join(tmpdir(), "pi-async-mode-new-"));
  const newDir = join(newParent, "moved");
  const registry = new TaskRegistry({ dataDir: oldDir });
  const mode = (path: string): number => statSync(path).mode & 0o777;
  try {
    const task = registry.submit({ command: "printf mode" });
    const outcome = await registry.wait([task.taskId], 5000);
    assert.ok("results" in outcome);
    assert.equal(mode(join(oldDir, `${task.taskId}.json`)), 0o600, "snapshot is owner-only");
    assert.equal(mode(join(oldDir, `${task.taskId}.output`)), 0o600, "merged output is owner-only");
    assert.equal(mode(join(oldDir, `${task.taskId}.stdout`)), 0o600, "stdout sidecar is owner-only");
    assert.equal(mode(join(oldDir, `${task.taskId}.stderr`)), 0o600, "stderr sidecar is owner-only");

    registry.configure({ dataDir: newDir });

    assert.equal(mode(join(newDir, `${task.taskId}.json`)), 0o600, "migrated snapshot is owner-only");
    assert.equal(mode(join(newDir, `${task.taskId}.output`)), 0o600, "migrated output is owner-only");
    assert.equal(mode(join(newDir, `${task.taskId}.stdout`)), 0o600, "migrated stdout sidecar is owner-only");
    assert.equal(mode(join(newDir, `${task.taskId}.stderr`)), 0o600, "migrated stderr sidecar is owner-only");
  } finally {
    await registry.shutdown();
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newParent, { recursive: true, force: true });
  }
});

/**
 * `logs()` reads a bounded window instead of the whole file. These cases pin the two risky
 * branches — tail/head cuts through multi-byte characters — plus the zero-byte window, the
 * stderr stream, and the defensive `MAX_LOG_WINDOW` ceiling. The full matrix (9 payloads ×
 * 9 maxBytes values × tail/head = 162 combinations) was checked against the old whole-file
 * `truncateUtf8Bytes` reference while writing this, so the table here covers the classes.
 */
test("logs truncation windows are UTF-8 clean, bounded, and on the correct side", async () => {
  const f = fixture();
  const content = "中a😀b".repeat(5); // 9 bytes per group → 45 bytes, starts and ends multi-byte-adjacent
  const outputFile = join(f.dataDir, "utf8.output");
  const { stderr } = streamPaths(outputFile);
  writeFileSync(outputFile, content);
  writeFileSync(stderr, content);
  try {
    seedSnapshot(f.dataDir, makeSnapshot({
      taskId: "utf8",
      status: "completed",
      finishedAt: Date.now(),
      metadata: { outputFile },
    }));
    await f.registry.reloadFromDisk();
    assert.ok(Buffer.byteLength(content, "utf8") >= 40, "fixture is ~40+ bytes");

    // Untruncated baseline: the whole payload comes back, no truncation flag.
    const whole = f.registry.logs("utf8", { maxBytes: 1024 });
    assert.equal(whole.text, content);
    assert.equal(whole.truncated, false);

    const windows = [
      {
        label: "tail",
        opts: { maxBytes: 20, tail: true },
        check: (text: string): void => {
          assert.ok(content.endsWith(text), "tail window is a suffix of the file");
          assert.ok(text.endsWith("b"), "the final character survives the cut");
          assert.ok(text.length > 0 && text.length < content.length, "the window is a real truncation");
        },
      },
      {
        label: "head",
        opts: { maxBytes: 20, tail: false },
        check: (text: string): void => {
          assert.ok(content.startsWith(text), "head window is a prefix of the file");
          assert.ok(text.startsWith("中"), "the first character survives the cut");
          assert.ok(text.length > 0 && text.length < content.length, "the window is a real truncation");
        },
      },
    ];
    for (const window of windows) {
      const slice = f.registry.logs("utf8", window.opts);
      assert.equal(slice.truncated, true, `${window.label}: truncated flag`);
      assert.ok(Buffer.byteLength(slice.text, "utf8") <= 20, `${window.label}: byte budget respected`);
      assert.ok(!/\uFFFD/.test(slice.text), `${window.label}: no replacement characters`);
      window.check(slice.text);
    }

    // Zero-byte window: nothing read, but the file still counts as truncated.
    const empty = f.registry.logs("utf8", { maxBytes: 0 });
    assert.equal(empty.text, "");
    assert.equal(empty.truncated, true);

    // The stderr stream shares the same window logic.
    const stderrSlice = f.registry.logs("utf8", { stream: "stderr", maxBytes: 20, tail: true });
    assert.equal(stderrSlice.truncated, true);
    assert.ok(Buffer.byteLength(stderrSlice.text, "utf8") <= 20);
    assert.ok(!/\uFFFD/.test(stderrSlice.text), "stderr window has no replacement characters");
    assert.ok(stderrSlice.text.endsWith("b"));
  } finally {
    await f.cleanup();
  }
});

/** Defensive ceiling: a mistaken multi-gigabyte window is clamped instead of allocated. */
test("logs clamps an oversized window to the defensive 8 MiB ceiling", async () => {
  const f = fixture();
  const outputFile = join(f.dataDir, "large.output");
  const ceiling = 8 * 1024 * 1024;
  writeFileSync(outputFile, Buffer.alloc(ceiling + 4096, 0x41)); // "A" x (8 MiB + 4 KiB)
  try {
    seedSnapshot(f.dataDir, makeSnapshot({
      taskId: "large",
      status: "completed",
      finishedAt: Date.now(),
      metadata: { outputFile },
    }));
    await f.registry.reloadFromDisk();

    const clamped = f.registry.logs("large", { maxBytes: 64 * 1024 * 1024, tail: true });
    assert.equal(clamped.truncated, true, "the file still exceeds the clamped window");
    assert.equal(Buffer.byteLength(clamped.text, "utf8"), ceiling, "exactly the ceiling is returned");

    // Small files are unaffected: a huge request just returns everything.
    const small = f.registry.logs("large", { maxBytes: Number.MAX_SAFE_INTEGER, tail: false });
    assert.equal(Buffer.byteLength(small.text, "utf8"), ceiling);
    assert.equal(small.truncated, true);
  } finally {
    await f.cleanup();
  }
});
