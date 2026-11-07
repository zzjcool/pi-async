import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import type { WatchSpec } from "../src/core/task.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-watch-integration-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return { dir, registry, cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Deterministic barrier: wait until an artifact reaches `size` bytes (watch windows are size-based). */
async function waitForSize(path: string, size: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (statSync(path).size >= size) return;
    } catch { /* not created yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${path} never reached ${size} bytes`);
}
function assertProcessGroupDead(pid: number): void {
  // Zombies still answer kill(-pgid, 0); only non-zombie members count as alive (#6).
  let live = false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(") ");
        if (closeParen < 0) continue;
        const rest = stat.slice(closeParen + 2).split(" ");
        if (Number(rest[2]) === pid && rest[0] !== "Z") { live = true; break; }
      } catch { /* raced */ }
    }
  } catch {
    try { process.kill(-pid, 0); live = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  assert.equal(live, false, `process group ${pid} still has a live member`);
}
function forceKillProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
}
const watch = (condition: WatchSpec["success_when"][number], overrides: Partial<WatchSpec> = {}): WatchSpec => ({
  intervalMs: 1000, timeoutMs: 5000, success_when: [condition], failure_when: [], ...overrides,
});

test("stdout_contains success marks completed without killing the process", async () => {
  const f = fixture();
  try {
    const task = f.registry.submit({ command: "sleep 0.1; printf ready; sleep 2" });
    f.registry.attachWatch(task.taskId, watch({ type: "stdout_contains", value: "ready" }));
    const result = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results[0]?.status, "completed");
    assert.equal(f.registry.get(task.taskId)?.metadata.watchSuccess !== undefined, true);
    // D4: the process remains alive after the observation settles the task.
    assert.ok(task.pid);
    assert.doesNotThrow(() => process.kill(-task.pid!, 0));
    assert.equal(f.registry.get(task.taskId)?.status, "completed");
  } finally { await f.cleanup(); }
});

test("failure_when kills task with watch_failure kind", async () => {
  const f = fixture();
  try {
    const task = f.registry.submit({ command: "printf fatal; sleep 5" });
    f.registry.attachWatch(task.taskId, watch({ type: "stdout_contains", value: "never" }, {
      success_when: [], failure_when: [{ type: "stdout_contains", value: "fatal" }],
    }));
    const result = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results[0]?.status, "killed");
    assert.equal(f.registry.get(task.taskId)?.killKind, "watch_failure");
  } finally { await f.cleanup(); }
});

test("watch timeout fails the task and kills its process group", async () => {
  const f = fixture();
  let pid: number | undefined;
  try {
    const task = f.registry.submit({ command: "sleep 8" });
    pid = task.pid;
    f.registry.attachWatch(task.taskId, watch({ type: "stdout_contains", value: "never" }, { timeoutMs: 1200 }));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(f.registry.get(task.taskId)?.status, "failed");
    assert.ok(pid);
    assertProcessGroupDead(pid);
  } finally {
    forceKillProcessGroup(pid);
    await f.cleanup();
  }
});

test("async_kill still kills a process after watch timeout finalized it", async () => {
  const f = fixture();
  let pid: number | undefined;
  try {
    const task = f.registry.submit({ command: "sleep 8" });
    pid = task.pid;
    f.registry.attachWatch(task.taskId, watch({ type: "stdout_contains", value: "never" }, { timeoutMs: 1200 }));
    const result = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results[0]?.status, "failed");
    await f.registry.kill(task.taskId, "user");
    assert.ok(pid);
    assertProcessGroupDead(pid);
  } finally {
    forceKillProcessGroup(pid);
    await f.cleanup();
  }
});

test("async_kill stops a process after D4 watch success completed the task", async () => {
  const f = fixture();
  let pid: number | undefined;
  try {
    const task = f.registry.submit({ command: "printf ready; sleep 3" });
    pid = task.pid;
    f.registry.attachWatch(task.taskId, watch({ type: "stdout_contains", value: "ready" }));
    const result = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results[0]?.status, "completed");
    const killStartedAt = Date.now();
    await f.registry.kill(task.taskId, "user");
    assert.ok(Date.now() - killStartedAt < 3500);
    assert.ok(pid);
    assertProcessGroupDead(pid);
  } finally {
    forceKillProcessGroup(pid);
    await f.cleanup();
  }
});

test("terminal task stops watch loop and invalid specs are rejected before admission", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.registry.scheduleDelayed({ command: "true", watch: watch({ type: "output_matches", regex: "[" }) }, 100), /Invalid watch spec/);
    assert.equal(f.registry.activeCount().pending, 0);

    const task = f.registry.submit({ command: "printf done" });
    f.registry.attachWatch(task.taskId, watch({ type: "stdout_contains", value: "absent" }, { timeoutMs: 20_000 }));
    const result = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in result);
    assert.equal(result.results[0]?.status, "completed");
    const loops = (f.registry as unknown as { watchLoops: Map<string, { stopped: boolean }> }).watchLoops;
    assert.equal(loops.has(task.taskId), false);
    assert.equal(f.registry.hasActiveWork(), false);
  } finally { await f.cleanup(); }
});

test("a watch reads a bounded tail, so output that scrolled out is invisible (REV-25)", async () => {
  const f = fixture();
  try {
    // ~9 MiB, which is deliberately larger than the 8 MiB read window: HEAD sits outside it.
    const command = "printf 'HEAD-MARKER\\n'; head -c 9000000 /dev/zero | tr '\\0' 'x'; printf '\\nTAIL-MARKER\\n'; sleep 20";
    const late = f.registry.submit({ command });
    const early = f.registry.submit({ command });

    // Inside the tail window → the check still matches.
    f.registry.attachWatch(late.taskId, watch({ type: "stdout_contains", value: "TAIL-MARKER" }, { timeoutMs: 15_000 }));
    const lateResult = await f.registry.wait([late.taskId], 15_000);
    assert.ok("results" in lateResult, "the tail marker must be reachable");
    assert.equal(lateResult.results[0]?.status, "completed");
    assert.equal(f.registry.get(late.taskId)?.metadata.watchSuccess !== undefined, true);

    // Outside the window → the check must NOT match, and the watch timeout ends it instead.
    // Before REV-25 the whole file was re-read every tick, so this line matched.
    // Wait for `early` to pass the window first: its stream is written independently of `late`, and a
    // watch attached while the file is still small would legitimately see HEAD-MARKER.
    await waitForSize(join(f.dir, `${early.taskId}.stdout`), 9_000_000);
    f.registry.attachWatch(early.taskId, watch({ type: "stdout_contains", value: "HEAD-MARKER" }, { timeoutMs: 1_500 }));
    const earlyResult = await f.registry.wait([early.taskId], 6_000);
    assert.ok("results" in earlyResult);
    assert.equal(earlyResult.results[0]?.status, "failed");
    assert.equal(f.registry.get(early.taskId)?.failureKind, "watch_timeout");
    assert.equal(f.registry.get(early.taskId)?.metadata.watchSuccess, undefined);
  } finally { await f.cleanup(); }
});
