import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry, type RegistryConfig } from "../src/core/registry.ts";
import type { TaskStatus } from "../src/core/task.ts";
import {
  OWNER_MARKER_NAME,
  expiredTaskIds,
  orderEvictions,
  orderSiblings,
  planEvictions,
  surveyDataDir,
  type DirSurvey,
  type EvictionCandidate,
} from "../src/core/storage.ts";
import { makeSnapshot } from "./helpers/index.ts";

/**
 * #102 — storage lifecycle: cross-dataDir reclamation + global byte quota (CONTRACT §10 / REV-32).
 *
 * Every fixture is a fake session tree under the OS tmp dir, `<tmp>/pi-async-sweep-XXXX/<sessionId>`.
 * Nothing here ever touches the real `~/.pi` tree, and no assertion depends on the wall clock
 * beyond "30 days ago is older than a 7-day retention window".
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OLD = (): number => Date.now() - 30 * DAY;

interface Tree {
  root: string;
  current: string;
  open: (opts?: Partial<RegistryConfig>) => TaskRegistry;
  cleanup: () => Promise<void>;
}

/** Fake `pi-async/` root with one live session dir; registries are opened on demand (the quota is
 *  usually computed *before* the registry exists, so the fixture cannot build it up front). */
function tree(): Tree {
  const root = mkdtempSync(join(tmpdir(), "pi-async-sweep-"));
  // Enforced, not just intended: every fixture must live under the OS tmp dir and outside the real
  // home directory, so no test can ever be pointed at a live `~/.pi` tree by accident.
  assert.ok(root.startsWith(tmpdir()), "fixtures must live under the OS tmp dir");
  assert.ok(!root.startsWith(homedir()), "fixtures must never live under $HOME");
  const current = join(root, "session-current");
  mkdirSync(current, { recursive: true });
  const opened: TaskRegistry[] = [];
  return {
    root,
    current,
    open(opts: Partial<RegistryConfig> = {}) {
      const registry = new TaskRegistry({ dataDir: current, retentionMs: 7 * DAY, retentionCount: 100, ...opts });
      opened.push(registry);
      return registry;
    },
    async cleanup() {
      for (const registry of opened) await registry.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seed(
  dir: string,
  opts: {
    taskId: string;
    status?: TaskStatus;
    finishedAt?: number;
    createdAt?: number;
    pid?: number;
    outputBytes?: number;
  },
): void {
  const status = opts.status ?? "completed";
  const finishedAt = opts.finishedAt ?? Date.now() - 1000;
  const snapshot = makeSnapshot({
    taskId: opts.taskId,
    status,
    createdAt: opts.createdAt ?? finishedAt - 1000,
    ...(status === "pending" || status === "running" ? {} : { finishedAt }),
    ...(opts.pid === undefined ? {} : { pid: opts.pid }),
    metadata: { outputFile: join(dir, `${opts.taskId}.output`) },
  });
  writeFileSync(join(dir, `${opts.taskId}.json`), JSON.stringify(snapshot));
  writeFileSync(join(dir, `${opts.taskId}.output`), "x".repeat(opts.outputBytes ?? 200));
}

/** Push every mtime in the dir (and the dir itself) into the past — the age gate's only input.
 *  Entries that cannot be timestamped (a dangling symlink) are skipped: they are never artifact
 *  files, so the age gate does not read them. */
function age(dir: string, atMs: number): void {
  for (const name of readdirSync(dir)) {
    try { utimesSync(join(dir, name), new Date(atMs), new Date(atMs)); } catch { /* unlinkable target */ }
  }
  utimesSync(dir, new Date(atMs), new Date(atMs));
}

/** Independent byte accounting: the suffix list is written out here on purpose (a shared constant
 *  would make the cross-check blind to a wrong list in the module under test). */
const ARTIFACT_SUFFIXES = [".json", ".output", ".stdout", ".stderr"];
function bytesOf(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (!ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    total += statSync(join(dir, name)).size;
  }
  return total;
}

/** Claim a data dir for a process, exactly like `ensureDataDir()` does. */
function seedOwner(dir: string, pid: number): void {
  writeFileSync(join(dir, OWNER_MARKER_NAME), JSON.stringify({ pid, at: Date.now(), marker: "pi-async-owner" }));
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) { previous[key] = process.env[key]; process.env[key] = value; }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// S1 — cross-dataDir reclamation (three gates)
// ---------------------------------------------------------------------------------------------

test("#102 cross-dataDir: an idle sibling data dir passes all three gates and is removed", async () => {
  const t = tree();
  const sibling = join(t.root, "session-old");
  mkdirSync(sibling);
  seed(sibling, { taskId: "old-task", finishedAt: OLD() });
  age(sibling, OLD());
  try {
    const registry = t.open({ sweepSiblings: true });
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, [sibling]);
    assert.equal(existsSync(sibling), false);
    // The pass is observable: one line per removal, before the unlink.
    assert.equal(report.lines.length >= 1, true);
    assert.ok(report.lines.some((line) => line.includes("removing sibling data dir") && line.includes(sibling)));
    assert.ok(report.freedBytes > 0, "freed bytes are reported, not guessed by the caller");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: the live data dir is never a reclamation target", async () => {
  const t = tree();
  seed(t.current, { taskId: "done", finishedAt: Date.now() - 1000 });
  age(t.current, OLD());
  try {
    const registry = t.open({ sweepSiblings: true });
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(t.current), true);
    assert.equal(existsSync(join(t.current, "done.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === t.current)?.reason, "current");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: a sibling whose running task still owns a live pid is skipped", async () => {
  const t = tree();
  const sibling = join(t.root, "session-live");
  mkdirSync(sibling);
  try {
    const registry = t.open({ sweepSiblings: true });
    // A detached task's pid is its process group id, so the real liveness probe sees it as alive.
    const live = registry.submit({ command: "sleep 30" });
    assert.ok(live.pid, "the probe needs a real pid");
    seed(sibling, { taskId: "live-task", status: "running", pid: live.pid });
    age(sibling, OLD());
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(sibling), true);
    assert.equal(existsSync(join(sibling, "live-task.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "live_task");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: a sibling that has not passed the age gate is kept", async () => {
  const t = tree();
  const sibling = join(t.root, "session-fresh");
  mkdirSync(sibling);
  seed(sibling, { taskId: "done", finishedAt: Date.now() - 1000 });
  try {
    // Age gate defaults to twice the retention window; the dir was written a moment ago.
    const report = t.open({ sweepSiblings: true }).sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(join(sibling, "done.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "recently_active");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: the age gate can never fall below the retention window", async () => {
  const t = tree();
  const sibling = join(t.root, "session-hour-old");
  mkdirSync(sibling);
  seed(sibling, { taskId: "recent", finishedAt: Date.now() - HOUR });
  age(sibling, Date.now() - HOUR);
  try {
    // A caller asking for a 1-second gate still gets `retention + 1` (7 days here).
    const report = t.open({ sweepSiblings: true, sweepSiblingAgeMs: 1000 }).sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(sibling), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "recently_active");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: the parent pi-async directory itself is never a target", async () => {
  const t = tree();
  const first = join(t.root, "session-a");
  const second = join(t.root, "session-b");
  for (const dir of [first, second]) {
    mkdirSync(dir);
    seed(dir, { taskId: "done", finishedAt: OLD() });
    age(dir, OLD());
  }
  try {
    const report = t.open({ sweepSiblings: true }).sweepStorage();
    assert.deepEqual([...report.removedDirs].sort(), [first, second].sort());
    assert.equal(existsSync(t.root), true, "the parent survives even when every child goes");
    assert.equal(report.removedDirs.includes(t.root), false);
    assert.deepEqual(readdirSync(t.root), ["session-current"]);
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: *.tmp residue neither condemns a fresh dir nor saves an idle one", async () => {
  const t = tree();
  const fresh = join(t.root, "session-tmp-fresh");
  const idle = join(t.root, "session-tmp-idle");
  mkdirSync(fresh);
  mkdirSync(idle);
  // What `migrateDataDir()` leaves behind when it is interrupted between copy and rename.
  writeFileSync(join(fresh, "abc.output.4242.tmp"), "residue");
  writeFileSync(join(idle, "def.output.4242.tmp"), "residue");
  age(idle, OLD());
  try {
    // "No artifact files" is never the deletable signal: the age gate alone decides.
    const report = t.open({ sweepSiblings: true }).sweepStorage();
    assert.equal(existsSync(fresh), true);
    assert.equal(report.skipped.find((entry) => entry.path === fresh)?.reason, "recently_active");
    assert.equal(existsSync(idle), false);
    assert.ok(report.removedDirs.includes(idle));
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: a directory holding what a data dir never writes is never removed", async () => {
  const t = tree();
  const nested = join(t.root, "some-project");
  mkdirSync(join(nested, "src"), { recursive: true });
  writeFileSync(join(nested, "notes.md"), "# not an artifact\n");
  age(nested, OLD());
  try {
    // `dirname(dataDir)` is only a *convention*; a wrong guess must never eat a project tree.
    const report = t.open({ sweepSiblings: true }).sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(join(nested, "notes.md")), true);
    assert.equal(existsSync(join(nested, "src")), true);
    assert.equal(report.skipped.find((entry) => entry.path === nested)?.reason, "foreign_content");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: an unparsable snapshot makes the directory unsafe", async () => {
  const t = tree();
  const sibling = join(t.root, "session-corrupt");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "broken.json"), "{ this is not a snapshot");
  age(sibling, OLD());
  try {
    const report = t.open({ sweepSiblings: true }).sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(join(sibling, "broken.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "unreadable_snapshot");
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: with every switch at its default, configure() deletes nothing", async () => {
  const t = tree();
  const sibling = join(t.root, "session-idle");
  mkdirSync(sibling);
  seed(sibling, { taskId: "old", finishedAt: OLD() });
  age(sibling, OLD());
  try {
    const registry = t.open();
    registry.configure({ dataDir: t.current });
    registry.configure({ dataDir: t.current });
    assert.equal(existsSync(sibling), true, "the shipped default must not reclaim anything");
    assert.equal(registry.lastStorageCleanup(), undefined);
    // And a direct pass is a zero-I/O no-op, not an empty deletion pass.
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(report.quotaBytes, 0);
    assert.equal(report.usedBytesBefore, 0);
  } finally { await t.cleanup(); }
});

test("#102 cross-dataDir: configure() runs one throttled pass", async () => {
  const t = tree();
  const first = join(t.root, "session-idle-1");
  mkdirSync(first);
  seed(first, { taskId: "a", finishedAt: OLD() });
  age(first, OLD());
  try {
    const registry = t.open({ sweepSiblings: true, sweepIntervalMs: 60_000 });
    registry.configure({ dataDir: t.current });
    assert.equal(existsSync(first), false);
    assert.deepEqual(registry.lastStorageCleanup()?.removedDirs, [first]);
    // A second idle sibling appears in the same throttle window: still only one pass.
    const second = join(t.root, "session-idle-2");
    mkdirSync(second);
    seed(second, { taskId: "b", finishedAt: OLD() });
    age(second, OLD());
    registry.configure({ dataDir: t.current });
    assert.equal(existsSync(second), true);
    assert.deepEqual(registry.lastStorageCleanup()?.removedDirs, [first]);
  } finally { await t.cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// S2 — global byte quota
// ---------------------------------------------------------------------------------------------

test("#102 quota: the limit is inclusive — exactly at the quota deletes nothing", async () => {
  const t = tree();
  seed(t.current, { taskId: "older", finishedAt: Date.now() - 2000 });
  seed(t.current, { taskId: "newer", finishedAt: Date.now() - 1000 });
  writeFileSync(join(t.current, "newer.stderr"), "e".repeat(64)); // sidecars are part of the accounting
  const used = bytesOf(t.current);
  try {
    const registry = t.open({ totalBytes: used });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.equal(report.usedBytesBefore, used, "accounting matches an independent byte count");
    assert.equal(report.quotaBytes, used);
    assert.deepEqual(report.evicted, []);
    assert.equal(report.overQuota, false, "used === quota is within budget");
    assert.equal(existsSync(join(t.current, "older.output")), true);
    assert.equal(existsSync(join(t.current, "newer.stderr")), true);
  } finally { await t.cleanup(); }
});

test("#102 quota: one byte over the limit evicts, and the bookkeeping reflects it", async () => {
  const t = tree();
  seed(t.current, { taskId: "older", finishedAt: Date.now() - 2000 });
  seed(t.current, { taskId: "newer", finishedAt: Date.now() - 1000 });
  const used = bytesOf(t.current);
  try {
    const registry = t.open({ totalBytes: used - 1, quotaHard: true });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.equal(report.evicted.length, 1);
    assert.equal(report.evicted[0]?.taskId, "older");
    assert.equal(report.overQuota, false);
    assert.ok(report.usedBytesAfter <= used - 1, "the pass must end inside the budget");
    assert.equal(existsSync(join(t.current, "older.json")), false, "the evicted task's snapshot must be gone");
    assert.equal(existsSync(join(t.current, "newer.json")), true, "the newest task must survive");
  } finally { await t.cleanup(); }
});

test("#102 quota: a soft pass evicts policy-expired tasks oldest-first, across data dirs", async () => {
  const t = tree();
  const sibling = join(t.root, "session-expired");
  mkdirSync(sibling);
  const base = Date.now() - 20 * DAY;
  seed(sibling, { taskId: "c-oldest", finishedAt: base });
  seed(sibling, { taskId: "a-middle", finishedAt: base + 1000 });
  seed(sibling, { taskId: "b-newest", finishedAt: base + 2000 });
  age(sibling, OLD());
  const used = bytesOf(sibling);
  try {
    // retention 1 day / count 0: every one of them is expired, so a soft pass may drop them.
    // Sibling reclamation is off — this is the quota reaching into another data dir on its own.
    const registry = t.open({ retentionMs: DAY, retentionCount: 0, totalBytes: used - 1 });
    const report = registry.sweepStorage();
    assert.deepEqual(report.evicted.map((entry) => entry.taskId), ["c-oldest"]);
    assert.equal(report.evicted[0]?.reason, "expired");
    assert.equal(existsSync(join(sibling, "c-oldest.output")), false);
    assert.equal(existsSync(join(sibling, "c-oldest.json")), false);
    assert.equal(existsSync(join(sibling, "a-middle.output")), true);
    assert.equal(existsSync(join(sibling, "b-newest.output")), true);
    assert.equal(existsSync(sibling), true, "evicting artifacts never removes the directory");
  } finally { await t.cleanup(); }
});

test("#102 quota: a soft pass keeps what retention still promises and reports the shortfall", async () => {
  const t = tree();
  seed(t.current, { taskId: "a", finishedAt: Date.now() - 3000 });
  seed(t.current, { taskId: "b", finishedAt: Date.now() - 1000 });
  try {
    const registry = t.open({ totalBytes: 1 });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.deepEqual(report.evicted, [], "soft quota never drops a result the window still keeps");
    assert.equal(report.overQuota, true);
    assert.equal(existsSync(join(t.current, "a.output")), true);
    assert.equal(registry.get("a")?.status, "completed");
    assert.ok(report.lines.some((line) => line.includes("quota still exceeded")));
    assert.ok(report.lines.some((line) => line.includes("PI_ASYNC_QUOTA_HARD=1")));
  } finally { await t.cleanup(); }
});

test("#102 quota: a hard pass drops still-retained results oldest-first and says so", async () => {
  const t = tree();
  seed(t.current, { taskId: "a", finishedAt: Date.now() - 3000 });
  seed(t.current, { taskId: "b", finishedAt: Date.now() - 1000 });
  const used = bytesOf(t.current);
  try {
    const registry = t.open({ totalBytes: used - 1, quotaHard: true });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.deepEqual(report.evicted.map((entry) => [entry.taskId, entry.reason]), [["a", "unexpired"]]);
    assert.equal(existsSync(join(t.current, "a.output")), false);
    assert.equal(existsSync(join(t.current, "a.json")), false);
    assert.equal(existsSync(join(t.current, "b.output")), true);
    // A current-dir eviction drops the in-memory snapshot with the files: no ghost tasks.
    assert.equal(registry.get("a"), undefined);
    assert.equal(registry.get("b")?.status, "completed");
    assert.ok(report.lines.some((line) => line.includes("evicting task a")));
  } finally { await t.cleanup(); }
});

test("#102 quota: a live running task is never a candidate, even under a hard quota", async () => {
  const t = tree();
  try {
    const registry = t.open({ totalBytes: 1, quotaHard: true });
    const live = registry.submit({ command: "sleep 30" });
    assert.ok(live.pid, "the probe needs a real pid");
    // `sleep` writes nothing, so give the task an output file of its own: it is exactly the artifact
    // an over-eager quota pass would eat.
    writeFileSync(join(t.current, `${live.taskId}.output`), "live work in flight\n");
    const report = registry.sweepStorage();
    assert.equal(report.overQuota, true, "an unsatisfiable quota is reported, not satisfied by eating live work");
    assert.equal(existsSync(join(t.current, `${live.taskId}.json`)), true);
    assert.equal(existsSync(join(t.current, `${live.taskId}.output`)), true);
    assert.equal(report.evicted.some((entry) => entry.taskId === live.taskId), false);
    // The whole directory is exempt while it owns live work, and the report says so (that is how a
    // "quota full but nothing was evicted" state is explained instead of looking solved).
    assert.deepEqual(report.protectedDirs, [t.current]);
    assert.equal(registry.get(live.taskId)?.status, "running");
  } finally { await t.cleanup(); }
});

test("#102 quota: a pending delayed task is in flight too — its artifacts survive a hard pass", async () => {
  const t = tree();
  seed(t.current, { taskId: "scheduled", status: "pending", createdAt: Date.now() - 1000, outputBytes: 400 });
  seed(t.current, { taskId: "done", finishedAt: Date.now() - 1000 });
  const used = bytesOf(t.current);
  try {
    // A pending snapshot carries no pid, so gate 2 does not protect the directory — only the
    // "terminal snapshots are candidates" rule stands between a scheduled task and the pass.
    // The quota is unsatisfiable without it: once the terminal set is gone the pass must stop and
    // report, never reach for the scheduled task.
    const registry = t.open({ totalBytes: 1, quotaHard: true });
    const report = registry.sweepStorage();
    assert.equal(existsSync(join(t.current, "scheduled.json")), true);
    assert.equal(existsSync(join(t.current, "scheduled.output")), true);
    assert.equal(report.evicted.some((entry) => entry.taskId === "scheduled"), false);
    // The terminal one is still evictable, so the pass is not simply a no-op.
    assert.deepEqual(report.evicted.map((entry) => entry.taskId), ["done"]);
    assert.equal(report.overQuota, true);
  } finally { await t.cleanup(); }
});

test("#102 quota: an unreferenced artifact goes before any retained result", async () => {
  const t = tree();
  writeFileSync(join(t.current, "ghost.output"), "g".repeat(500)); // no snapshot: nothing can observe it
  seed(t.current, { taskId: "kept", finishedAt: Date.now() - 1000 });
  const used = bytesOf(t.current);
  try {
    const registry = t.open({ totalBytes: used - 1, quotaHard: true });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.deepEqual(report.evicted.map((entry) => [entry.taskId, entry.reason]), [[undefined, "orphan"]]);
    assert.equal(existsSync(join(t.current, "ghost.output")), false);
    assert.equal(existsSync(join(t.current, "kept.output")), true);
  } finally { await t.cleanup(); }
});

test("#102 quota: the count window still protects a task from the soft tier", async () => {
  const t = tree();
  const now = Date.now();
  seed(t.current, { taskId: "ancient", finishedAt: now - 40 * DAY });
  seed(t.current, { taskId: "recent", finishedAt: now - 30 * DAY });
  try {
    const survey = surveyDataDir(t.current);
    assert.ok(survey);
    // retention 1 day: both are past the age window, but the newest `retentionCount` is exempt.
    const expired = expiredTaskIds(survey, { now, retentionMs: DAY, retentionCount: 1 });
    assert.equal(expired.has("ancient"), true);
    assert.equal(expired.has("recent"), false, "matches prune(): age and count are a union, not an AND");
    // And the planner honours it: the retained one is not a soft candidate.
    const plan = planEvictions([survey], {
      now, usedBytes: survey.bytes, quotaBytes: 1, retentionMs: DAY, retentionCount: 1,
      hard: false, currentDataDir: t.current, pidAlive: () => false,
    });
    assert.deepEqual(plan.ordered.map((candidate) => candidate.taskId), ["ancient"]);
  } finally { await t.cleanup(); }
});

test("#102 quota: a foreign directory's bytes are not part of the artifact budget", async () => {
  const t = tree();
  const foreign = join(t.root, "some-project");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "notes.md"), "# not a data dir\n");
  // Artifact-shaped and huge, but it is not ours: counting it would let a mis-pointed data dir
  // fake a full quota and evict real results.
  writeFileSync(join(foreign, "big.output"), "z".repeat(200_000));
  seed(t.current, { taskId: "kept", finishedAt: Date.now() - 1000 });
  const used = bytesOf(t.current);
  try {
    const registry = t.open({ totalBytes: used, quotaHard: true });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.equal(report.usedBytesBefore, used);
    assert.deepEqual(report.evicted, []);
    assert.equal(report.overQuota, false);
    assert.equal(existsSync(join(foreign, "big.output")), true);
  } finally { await t.cleanup(); }
});

test("#102 safety: the filesystem root is never accepted as a sweep root", async () => {
  // A data dir of `/` would make `dirname` the whole filesystem; the pass must refuse before any I/O.
  const registry = new TaskRegistry({ dataDir: "/", sweepSiblings: true });
  try {
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(report.root, "/");
    assert.ok(report.lines.some((line) => line.includes("refusing to sweep the filesystem root")));
  } finally { await registry.shutdown(); }
});

// ---------------------------------------------------------------------------------------------
// Review follow-ups (data-loss classes found by an adversarial pass)
// ---------------------------------------------------------------------------------------------

test("#102 quota: an unreadable snapshot is never treated as an unreferenced artifact", async () => {
  const t = tree();
  seed(t.current, { taskId: "good", finishedAt: Date.now() - 1000, outputBytes: 100 });
  // A torn write (or a status this build does not know) leaves a `.json` its stem cannot be matched to.
  writeFileSync(join(t.current, "torn.json"), '{"taskId":"torn","status":"compl');
  writeFileSync(join(t.current, "torn.output"), "t".repeat(5000));
  try {
    const registry = t.open({ totalBytes: 600 }); // soft: only policy-expired work may go
    const report = registry.sweepStorage();
    assert.deepEqual(report.evicted, [], "an artifact whose snapshot did not parse is not 'unreferenced'");
    assert.equal(existsSync(join(t.current, "torn.json")), true);
    assert.equal(existsSync(join(t.current, "torn.output")), true);
    assert.equal(existsSync(join(t.current, "good.output")), true);
    assert.equal(report.overQuota, true, "no verdict means the quota is honestly unmet, not satisfied");
    assert.deepEqual(report.unreadableDirs, [t.current]);
  } finally { await t.cleanup(); }
});

test("#102 quota: the snapshot scan cap means \"no verdict\", never \"orphan\"", async () => {
  const t = tree();
  // 512 snapshots are read; the 513th trips the cap and must not turn its siblings into orphans.
  for (let i = 0; i < 512; i++) {
    seed(t.current, { taskId: `t-${String(i).padStart(4, "0")}`, finishedAt: Date.now() - 1000, outputBytes: 4 });
  }
  try {
    const atCap = surveyDataDir(t.current);
    assert.ok(atCap);
    assert.equal(atCap.unreadable, false, "exactly at the cap every snapshot is still read");
    // The 513th file must be a *running* task: with the cap misread as "unreferenced" its files (and
    // only its files) would be the ones an over-quota pass eats.
    seed(t.current, { taskId: "zz-running", status: "running", pid: 2_000_000_000, outputBytes: 400 });
    const registry = t.open({ totalBytes: 1 }); // unsatisfiable on purpose
    const report = registry.sweepStorage();
    assert.deepEqual(report.evicted, []);
    assert.equal(existsSync(join(t.current, "zz-running.json")), true);
    assert.equal(existsSync(join(t.current, "zz-running.output")), true);
    assert.deepEqual(report.unreadableDirs, [t.current]);
  } finally { await t.cleanup(); }
});

test("#102 quota: a junk file in the live data dir does not disable the quota", async () => {
  const t = tree();
  seed(t.current, { taskId: "a", finishedAt: Date.now() - 2000 });
  // Finder browsed the data dir: `.DS_Store` makes the directory "foreign", but it is still ours.
  writeFileSync(join(t.current, ".DS_Store"), "junk");
  const used = bytesOf(t.current);
  try {
    const soft = t.open({ totalBytes: 1 });
    const softReport = soft.sweepStorage();
    assert.equal(softReport.usedBytesBefore, used, "the live data dir always counts");
    assert.equal(softReport.overQuota, true, "a satisfied quota must not be faked by a stray file");
    assert.equal(existsSync(join(t.current, "a.output")), true);

    const hard = t.open({ totalBytes: used - 1, quotaHard: true });
    const hardReport = hard.sweepStorage();
    assert.deepEqual(hardReport.evicted.map((entry) => entry.taskId), ["a"]);
    assert.equal(hardReport.overQuota, false);
  } finally { await t.cleanup(); }
});

test("#102 safety: the live data dir is recognised through a symlink alias", async () => {
  const t = tree();
  const real = join(t.root, "sess-real");
  mkdirSync(real);
  seed(real, { taskId: "old", finishedAt: OLD() });
  age(real, OLD());
  const alias = join(t.root, "session-alias");
  symlinkSync(real, alias, "dir");
  try {
    // `resolve()` alone would see two different paths and delete the directory this registry lives in.
    const registry = t.open({ dataDir: alias, sweepSiblings: true });
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(join(real, "old.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === real)?.reason, "current");
  } finally { await t.cleanup(); }
});

test("#102 safety: an idle data dir of a live session is protected by its owner marker", async () => {
  const t = tree();
  const sibling = join(t.root, "session-live-idle");
  mkdirSync(sibling);
  // Only terminal work, idle past the age gate: without a marker this is indistinguishable from an
  // abandoned directory, and a second `pi` in the same repo would lose its whole data dir.
  seed(sibling, { taskId: "done", finishedAt: OLD() });
  age(sibling, OLD());
  try {
    const registry = t.open({ sweepSiblings: true });
    const owner = registry.submit({ command: "sleep 30" });
    assert.ok(owner.pid);
    seedOwner(sibling, owner.pid);
    age(sibling, OLD()); // the marker write bumped the mtime: idle past the age gate again
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(join(sibling, "done.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "owner_alive");

    // The same directory with a dead owner is reclaimable again.
    seedOwner(sibling, 2_000_000_000);
    age(sibling, OLD());
    const after = registry.sweepStorage();
    assert.deepEqual(after.removedDirs, [sibling]);
    assert.equal(existsSync(sibling), false);
  } finally { await t.cleanup(); }
});

test("#102 REV-33: a marker pid that is live but NOT a process-group leader protects the dir", async () => {
  const t = tree();
  const sibling = join(t.root, "session-live-idle");
  mkdirSync(sibling);
  // Only terminal work, idle past the age gate: the marker is the *only* thing that can prove the
  // session is still there, so this test fails exactly when that proof is broken.
  seed(sibling, { taskId: "done", finishedAt: OLD() });
  age(sibling, OLD());
  // What `writeOwnerMarker()` records is `process.pid` of a pi session — an ordinary process that
  // shares its shell's process group. `pidAlive()` answers a *group* question (`kill(-pid, 0)` /
  // `/proc` `pgrp === pid`), so for this shape it answers "dead" about a live process.
  const session = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => session.once("spawn", resolve));
    const pid = session.pid!;
    // Fixture guard: these two assertions are what makes this the hard case. If a future platform
    // made the child a group leader, the test must fail loudly instead of passing for free.
    assert.doesNotThrow(() => process.kill(pid, 0), "fixture pid must be alive");
    assert.throws(() => process.kill(-pid, 0), /ESRCH/, "fixture pid must NOT be a process-group leader");

    const registry = t.open({ sweepSiblings: true });
    seedOwner(sibling, pid);
    age(sibling, OLD()); // the marker write bumped the mtime: idle past the age gate again
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, [], "a live session's data dir must never be reclaimed");
    assert.equal(existsSync(join(sibling, "done.json")), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "owner_alive");
  } finally {
    session.kill("SIGKILL");
    await t.cleanup();
  }
});

test("#102 REV-33: an unprobeable marker pid is unknown, never proof of death", async () => {
  // `0` would be signalled as "my own process group", a negative value as "process group N" and a
  // fraction as no process at all: none of them is evidence that the owner is gone, so all three
  // must land on `unreadable_owner` (keep the dir) instead of being trusted.
  for (const pid of [0, -5, 1.5]) {
    const t = tree();
    const sibling = join(t.root, "session-bad-marker");
    mkdirSync(sibling);
    seed(sibling, { taskId: "done", finishedAt: OLD() });
    age(sibling, OLD());
    try {
      const registry = t.open({ sweepSiblings: true });
      seedOwner(sibling, pid);
      age(sibling, OLD());
      const report = registry.sweepStorage();
      assert.deepEqual(report.removedDirs, [], `marker pid ${pid} must not be read as a dead owner`);
      assert.equal(existsSync(sibling), true);
      assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "unreadable_owner", `marker pid ${pid}`);
    } finally { await t.cleanup(); }
  }
});

test("#102 REV-33: a marker pid outside the pid_t range is unknown, not 'dead'", async () => {
  // `Number.isInteger(1e21)` is true, but `process.kill(1e21, 0)` throws ERR_INVALID_ARG_TYPE — which
  // a naive probe reads as "dead" and then reclaims the directory. A pid no process can have is not
  // evidence of anything.
  const t = tree();
  const sibling = join(t.root, "session-huge-pid");
  mkdirSync(sibling);
  seed(sibling, { taskId: "done", finishedAt: OLD() });
  age(sibling, OLD());
  try {
    const registry = t.open({ sweepSiblings: true });
    seedOwner(sibling, 1e21);
    age(sibling, OLD());
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, [], "an impossible pid must not be read as a dead owner");
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "unreadable_owner");
  } finally { await t.cleanup(); }
});

test("#102 REV-33: a terminal snapshot's pid is never probed, so an odd one must not pin the quota", async () => {
  // The pid of a finished task is never used (it is only an eviction candidate). Turning such a
  // directory "unreadable" would make its artifacts un-evictable and report the quota as exceeded
  // forever — a leak that the first version of this fix actually introduced (found in review).
  const t = tree();
  seed(t.current, { taskId: "healthy", finishedAt: Date.now() - 3000 });
  seed(t.current, { taskId: "odd", finishedAt: Date.now() - 1000, pid: 0 });
  const used = bytesOf(t.current);
  try {
    const registry = t.open({ totalBytes: used - 1, quotaHard: true });
    await registry.reloadFromDisk();
    const report = registry.sweepStorage();
    assert.deepEqual(report.unreadableDirs, [], "a finished task's pid must not mark the dir unreadable");
    assert.equal(report.overQuota, false, "the odd pid must not disable eviction");
    assert.ok(report.evicted.length >= 1, "the over-quota bytes still have to come off");
  } finally { await t.cleanup(); }
});

test("#102 REV-33: a pending snapshot has no pid, so the owner marker decides — not the snapshot", async () => {
  // `pending` (delayed) tasks are persisted before they spawn, so they carry no pid; `shutdown()`
  // deliberately leaves them on disk. That is NOT evidence of a live run (it must not block
  // reclamation forever — a session that quits after scheduling a delayed task would pin its
  // directory for good), and it is NOT evidence of death either. The marker answers the question.
  const t = tree();
  const liveOwner = join(t.root, "session-pending-live");
  const goneOwner = join(t.root, "session-pending-gone");
  for (const dir of [liveOwner, goneOwner]) {
    mkdirSync(dir);
    seed(dir, { taskId: "later", status: "pending" });
    age(dir, OLD());
  }
  try {
    const registry = t.open({ sweepSiblings: true });
    seedOwner(liveOwner, process.pid); // this test process: live, and normally not a group leader
    age(liveOwner, OLD());
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, [goneOwner], "the directory nobody claims is still reclaimable");
    assert.equal(existsSync(join(liveOwner, "later.json")), true, "a live owner keeps its pending work");
    assert.equal(report.skipped.find((entry) => entry.path === liveOwner)?.reason, "owner_alive");
  } finally { await t.cleanup(); }
});

test("#102 REV-33: a marker that cannot be read is unknown, never 'no owner'", async () => {
  // Presence is evidence. A marker that became a directory or a dangling symlink (restored backup,
  // rsync, a hostile entry) cannot be read as a claim — and an unreadable claim is not an absent one.
  const cases: Array<[string, (path: string) => void]> = [
    ["a directory", (path) => mkdirSync(path)],
    ["a dangling symlink", (path) => symlinkSync(join(tmpdir(), "pi-async-nonexistent-marker"), path)],
  ];
  for (const [label, make] of cases) {
    const t = tree();
    const sibling = join(t.root, "session-broken-marker");
    mkdirSync(sibling);
    seed(sibling, { taskId: "done", finishedAt: OLD() });
    make(join(sibling, OWNER_MARKER_NAME));
    age(sibling, OLD());
    try {
      const registry = t.open({ sweepSiblings: true });
      const report = registry.sweepStorage();
      assert.deepEqual(report.removedDirs, [], `marker as ${label} must not be read as 'no owner'`);
      assert.equal(existsSync(join(sibling, "done.json")), true, label);
      assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "unreadable_owner", label);
    } finally { await t.cleanup(); }
  }
});

test("#102 REV-33: a snapshot pid that cannot be probed makes the directory unknown", async () => {
  // `pid: 0` would be signalled as "my own process group" (macOS) and match nothing on Linux: the
  // answer would be platform-dependent, so it must not count as evidence either way.
  const t = tree();
  const sibling = join(t.root, "session-bad-pid");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "odd.json"), JSON.stringify({ taskId: "odd", status: "running", pid: 0, createdAt: OLD(), metadata: {} }));
  age(sibling, OLD());
  try {
    const registry = t.open({ sweepSiblings: true });
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "unreadable_snapshot");
  } finally { await t.cleanup(); }
});

test("#102 safety: a snapshot with an unknown status is unreadable, not a finished task", async () => {
  const t = tree();
  const sibling = join(t.root, "session-future");
  mkdirSync(sibling);
  // A newer build could write a status this one does not know: it must count as "cannot judge",
  // never as "terminal, so its artifacts are garbage".
  writeFileSync(join(sibling, "future.json"), JSON.stringify({ taskId: "future", status: "cancelled", createdAt: OLD(), finishedAt: OLD() }));
  writeFileSync(join(sibling, "future.output"), "x".repeat(100));
  age(sibling, OLD());
  try {
    const registry = t.open({ sweepSiblings: true });
    const report = registry.sweepStorage();
    assert.deepEqual(report.removedDirs, []);
    assert.equal(existsSync(join(sibling, "future.output")), true);
    assert.equal(report.skipped.find((entry) => entry.path === sibling)?.reason, "unreadable_snapshot");
  } finally { await t.cleanup(); }
});

test("#102 determinism: the order is total across data dirs too", async () => {
  const candidate = (dataDir: string, taskId: string): EvictionCandidate => ({
    kind: "task", dataDir, taskId, files: [`${dataDir}/${taskId}.output`], bytes: 10, tier: 1, ageAnchor: 100,
  });
  // Same tier, same age, same id — only the directory separates them (migration can leave exactly
  // this pair behind), so the comparator needs a final key or the order is the input's.
  const one = candidate("/a", "same");
  const two = candidate("/b", "same");
  assert.deepEqual(orderEvictions([two, one]).map((entry) => entry.dataDir), ["/a", "/b"]);
  assert.deepEqual(orderEvictions([one, two]).map((entry) => entry.dataDir), ["/a", "/b"]);
});

// ---------------------------------------------------------------------------------------------
// Determinism (pure ordering)
// ---------------------------------------------------------------------------------------------

test("#102 determinism: eviction order is total — tier, then age, then task id", () => {
  const candidates: EvictionCandidate[] = [];
  // 20 candidates with the *same* tier and age: only the id tie-break can order them.
  for (let i = 0; i < 20; i++) {
    const id = `task-${String(19 - i).padStart(2, "0")}`;
    candidates.push({ kind: "task", dataDir: "/d", taskId: id, files: [`/d/${id}.output`], bytes: 10, tier: 1, ageAnchor: 5000 });
  }
  // A tier 0 orphan and a tier 2 result bracket them, plus one clearly older tier 1.
  candidates.push({ kind: "orphan", dataDir: "/d", files: ["/d/ghost.output"], bytes: 1, tier: 0, ageAnchor: 9000 });
  candidates.push({ kind: "task", dataDir: "/d", taskId: "zzz-retained", files: ["/d/zzz.output"], bytes: 10, tier: 2, ageAnchor: 1 });
  candidates.push({ kind: "task", dataDir: "/d", taskId: "aaa-oldest", files: ["/d/aaa.output"], bytes: 10, tier: 1, ageAnchor: 1 });
  // Input order is deliberately not the answer (a stable sort on insertion order would fail here).
  const shuffled = [candidates[7]!, candidates[0]!, candidates[21]!, ...candidates.slice(1, 7), ...candidates.slice(8, 21), candidates[22]!];
  const ordered = orderEvictions(shuffled);
  const expected = [
    "/d/ghost.output", "/d/aaa.output",
    ...Array.from({ length: 20 }, (_, i) => `/d/task-${String(i).padStart(2, "0")}.output`),
    "/d/zzz.output",
  ];
  // The orphan leads, then the oldest tier 1, then the 20 equal-age tier 1 tasks by id, then tier 2.
  assert.deepEqual(ordered.map((candidate) => candidate.files[0]), expected);
  // Ordering must be pure: the same input in a different order yields the same output.
  assert.deepEqual(orderEvictions([...shuffled].reverse()), ordered);
});

test("#102 determinism: sibling order is least-recently-active first with a name tie-break", () => {
  const survey = (name: string, lastActivityMs: number): DirSurvey => ({
    path: `/root/${name}`, name, lastActivityMs, files: [], snapshots: [], foreign: false,
    unreadable: false, ownerUnreadable: false, bytes: 0,
  });
  const ordered = orderSiblings([survey("b", 200), survey("a", 100), survey("c", 100), survey("d", 300)]);
  assert.deepEqual(ordered.map((entry) => entry.name), ["a", "c", "b", "d"]);
});

// ---------------------------------------------------------------------------------------------
// Environment wiring
// ---------------------------------------------------------------------------------------------

test("#102 env: PI_ASYNC_TOTAL_BYTES and PI_ASYNC_SWEEP_SIBLINGS configure the pass", async () => {
  const t = tree();
  const sibling = join(t.root, "session-idle");
  mkdirSync(sibling);
  seed(sibling, { taskId: "old", finishedAt: OLD() });
  age(sibling, OLD());
  try {
    const registry = withEnv({ PI_ASYNC_TOTAL_BYTES: "4096", PI_ASYNC_SWEEP_SIBLINGS: "1" }, () => t.open());
    assert.equal(registry.sweepStorage().quotaBytes, 4096);
    assert.equal(existsSync(sibling), false);
  } finally { await t.cleanup(); }
});

test("#102 env: a malformed knob falls back to the disabled default", async () => {
  const t = tree();
  try {
    const registry = withEnv({ PI_ASYNC_TOTAL_BYTES: "not-a-number", PI_ASYNC_SWEEP_SIBLINGS: "" }, () => t.open());
    const report = registry.sweepStorage();
    assert.equal(report.quotaBytes, 0);
    assert.deepEqual(report.removedDirs, []);
  } finally { await t.cleanup(); }
});
