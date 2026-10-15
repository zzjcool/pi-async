import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import type { WatchSpec } from "../src/core/task.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-watch-integration-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return { registry, cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
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
