import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { killTree, spawnDetached, streamPaths } from "../src/core/spawn.ts";
import { sendCompletionNotification } from "../src/core/notify.ts";
import { registerTools } from "../src/tools/index.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-wave1-"));
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

test("#4 spawn writes distinct stdout/stderr sidecars; watches do not cross-match", async () => {
  const f = fixture();
  try {
    const stdoutOnly = f.registry.submit({
      command: "printf THIS_IS_ON_STDOUT; sleep 2",
      watch: {
        intervalMs: 1000,
        timeoutMs: 1500,
        blind_checks: 3,
        success_when: [{ type: "stderr_contains", value: "THIS_IS_ON_STDOUT" }],
        failure_when: [],
      },
    });
    const outFile = String(f.registry.get(stdoutOnly.taskId)!.metadata.outputFile);
    const { stdoutFile, stderrFile } = streamPaths(outFile);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(existsSync(stdoutFile));
    assert.match(readFileSync(stdoutFile, "utf8"), /THIS_IS_ON_STDOUT/);
    assert.equal(readFileSync(stderrFile, "utf8"), "");

    await new Promise((r) => setTimeout(r, 1600));
    assert.notEqual(f.registry.get(stdoutOnly.taskId)?.status, "completed");

    const stderrOnly = f.registry.submit({
      command: "printf THIS_IS_ON_STDERR 1>&2; sleep 2",
      watch: {
        intervalMs: 1000,
        timeoutMs: 4000,
        blind_checks: 3,
        success_when: [{ type: "stderr_contains", value: "THIS_IS_ON_STDERR" }],
        failure_when: [],
      },
    });
    const ok = await f.registry.wait([stderrOnly.taskId], 5000);
    assert.ok("results" in ok);
    assert.equal(ok.results[0]?.status, "completed");
  } finally {
    await f.cleanup();
  }
});

test("#6 killTree treats zombie-only groups as confirmed dead", async () => {
  const out = join(tmpdir(), `pi-async-zombie-${process.pid}-${Date.now()}.output`);
  const handle = spawnDetached("sleep 30", { outputFile: out });
  await new Promise((r) => setTimeout(r, 50));
  const result = await killTree(handle.pid, { graceMs: 500 });
  assert.equal(result.confirmed, true);
  await handle.exit.catch(() => undefined);
});

test("#15 async_wait suppresses completion notification via outputConsumed latch", async () => {
  const f = fixture();
  const messages: unknown[] = [];
  try {
    f.registry.setEvents({
      onFinalize: (snapshot) => {
        void sendCompletionNotification(
          { sendMessage: async (...args: unknown[]) => { messages.push(args); } } as never,
          f.registry,
          {
            taskId: snapshot.taskId,
            name: snapshot.name,
            status: snapshot.status,
            outputFile: String(snapshot.metadata.outputFile ?? ""),
          },
        );
      },
      onStateChange: () => undefined,
    });
    const task = f.registry.submit({ command: "printf WAITED_DONE" });
    const outcome = await f.registry.wait([task.taskId], 3000);
    assert.ok("results" in outcome);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(messages.length, 0);
    assert.equal(f.registry.get(task.taskId)?.outputConsumed, true);
    assert.equal(f.registry.get(task.taskId)?.notified, false);
  } finally {
    await f.cleanup();
  }
});

test("#20 shutdown preserves pending delayed tasks for reloadFromDisk", async () => {
  const f = fixture();
  const restored = new TaskRegistry({ dataDir: f.dir });
  try {
    const task = f.registry.scheduleDelayed({ command: "printf LATER" }, 30_000);
    assert.equal(f.registry.get(task.taskId)?.status, "pending");
    await f.registry.shutdown();
    assert.equal(f.registry.get(task.taskId)?.status, "pending");
    await restored.reloadFromDisk();
    assert.equal(restored.get(task.taskId)?.status, "pending");
    assert.equal(restored.get(task.taskId)?.mode, "delayed");
  } finally {
    await restored.shutdown();
    await f.cleanup();
  }
});

test("#40 wait() treats a single string id as one id", async () => {
  const f = fixture();
  try {
    const task = f.registry.submit({ command: "printf ok" });
    const outcome = await f.registry.wait(task.taskId as unknown as string[], 3000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "completed");
    await assert.rejects(f.registry.wait(123 as never, 0), /taskIds must be an array of strings/);
  } finally {
    await f.cleanup();
  }
});

test("#43 mixed timeout preserves already-finished results", async () => {
  const f = fixture();
  try {
    const done = f.registry.submit({ command: "printf x", name: "done" });
    const running = f.registry.submit({ command: "sleep 30", name: "run" });
    await f.registry.wait([done.taskId], 3000);
    const mixed = await f.registry.wait([done.taskId, running.taskId], 50);
    assert.ok("notReady" in mixed);
    const partial = mixed as { results?: Array<{ taskId: string }>; notReady: Array<{ taskId: string }> };
    assert.ok(partial.results && partial.results.length === 1);
    assert.equal(partial.results[0]?.taskId, done.taskId);
    assert.equal(partial.notReady.length, 1);
    assert.equal(partial.notReady[0]?.taskId, running.taskId);
    assert.equal(f.registry.get(done.taskId)?.outputConsumed, true);
  } finally {
    await f.cleanup();
  }
});

test("#45 execute reports missing sync/delayed params by name", async () => {
  const f = fixture();
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown>; parameters: Record<string, unknown> }>();
  const pi = { registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown>; parameters: Record<string, unknown> }) => tools.set(tool.name, tool) };
  try {
    registerTools(pi as never, f.registry);
    const run = tools.get("async_run")!;
    assert.ok(!("allOf" in run.parameters) || !(run.parameters as { allOf?: unknown[] }).allOf?.length);
    await assert.rejects(run.execute("c", { command: "echo x", mode: "sync" }), /timeoutMs is required for sync mode/);
    await assert.rejects(run.execute("c", { command: "echo x", mode: "delayed" }), /delayMs is required for delayed mode/);
  } finally {
    await f.cleanup();
  }
});

test("#6 async_kill returns {taskId,status} even when kill confirmation warns", async () => {
  const f = fixture();
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  const pi = { registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => tools.set(tool.name, tool) };
  try {
    registerTools(pi as never, f.registry);
    const task = f.registry.submit({ command: "sleep 30" });
    const originalKill = process.kill;
    const originalNow = Date.now;
    let clock = originalNow();
    try {
      process.kill = (() => true) as typeof process.kill;
      Date.now = () => (clock += 10_000);
      const result = await tools.get("async_kill")!.execute("c", { taskId: task.taskId });
      const payload = (result as { details: { payload: { taskId: string; status?: string; warning?: string } } }).details.payload;
      assert.equal(payload.taskId, task.taskId);
      assert.equal(payload.status, "killed");
      assert.match(String(payload.warning), /leaked/);
    } finally {
      process.kill = originalKill;
      Date.now = originalNow;
    }
  } finally {
    await f.cleanup();
  }
});
