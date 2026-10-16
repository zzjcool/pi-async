import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { makeSnapshot } from "./helpers/index.ts";

function fixture(opts: { retentionMs?: number; retentionCount?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-prune-"));
  const registry = new TaskRegistry({
    dataDir: dir,
    retentionMs: opts.retentionMs ?? 7 * 24 * 60 * 60 * 1000,
    retentionCount: opts.retentionCount ?? 100,
  });
  return {
    dir,
    registry,
    cleanup: async () => {
      await registry.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedTerminal(
  dir: string,
  opts: {
    taskId: string;
    finishedAt: number;
    status?: "completed" | "failed" | "killed";
    withOutput?: boolean;
  },
): void {
  const outputFile = join(dir, `${opts.taskId}.output`);
  if (opts.withOutput !== false) writeFileSync(outputFile, `output-${opts.taskId}\n`);
  writeFileSync(join(dir, `${opts.taskId}.json`), JSON.stringify(makeSnapshot({
    taskId: opts.taskId,
    status: opts.status ?? "completed",
    createdAt: opts.finishedAt - 1000,
    finishedAt: opts.finishedAt,
    metadata: { outputFile },
  })));
}

test("prune drops aged terminal tasks beyond newest retentionCount (union with age window)", async () => {
  const now = Date.now();
  const f = fixture({ retentionMs: 60_000, retentionCount: 2 });
  try {
    // newest → oldest: young (in window), keep-a/keep-b (aged, fill count after young…),
    // Sort: young, keep-a, keep-b, drop-c, drop-d
    // count=2 → keep young + keep-a by count; keep-b is aged and index>=2 → drop; drops follow.
    seedTerminal(f.dir, { taskId: "young", finishedAt: now - 10_000 });
    seedTerminal(f.dir, { taskId: "keep-a", finishedAt: now - 120_000 });
    seedTerminal(f.dir, { taskId: "keep-b", finishedAt: now - 130_000 });
    seedTerminal(f.dir, { taskId: "drop-c", finishedAt: now - 140_000 });
    seedTerminal(f.dir, { taskId: "drop-d", finishedAt: now - 150_000 });
    await f.registry.reloadFromDisk();

    assert.ok(f.registry.get("young"));
    assert.ok(f.registry.get("keep-a"));
    assert.equal(f.registry.get("keep-b"), undefined);
    assert.equal(f.registry.get("drop-c"), undefined);
    assert.equal(f.registry.get("drop-d"), undefined);
    assert.equal(existsSync(join(f.dir, "young.json")), true);
    assert.equal(existsSync(join(f.dir, "keep-a.output")), true);
    assert.equal(existsSync(join(f.dir, "keep-b.json")), false);
    assert.equal(existsSync(join(f.dir, "drop-c.output")), false);
  } finally {
    await f.cleanup();
  }
});

test("prune keeps newest retentionCount when every terminal task is aged", async () => {
  const now = Date.now();
  const f = fixture({ retentionMs: 1, retentionCount: 3 });
  try {
    for (let i = 0; i < 5; i++) {
      seedTerminal(f.dir, { taskId: `t${i}`, finishedAt: now - 10_000 - i * 1000 });
    }
    await f.registry.reloadFromDisk();
    assert.ok(f.registry.get("t0"));
    assert.ok(f.registry.get("t1"));
    assert.ok(f.registry.get("t2"));
    assert.equal(f.registry.get("t3"), undefined);
    assert.equal(f.registry.get("t4"), undefined);
  } finally {
    await f.cleanup();
  }
});

test("prune never deletes non-terminal (pending delayed) tasks", async () => {
  const now = Date.now();
  const f = fixture({ retentionMs: 1, retentionCount: 0 });
  try {
    const pending = makeSnapshot({
      taskId: "pending-delay",
      status: "pending",
      mode: "delayed",
      createdAt: now - 999_999,
      dueAt: now + 60_000,
      metadata: { outputFile: join(f.dir, "pending-delay.output") },
    });
    writeFileSync(join(f.dir, "pending-delay.json"), JSON.stringify(pending));
    writeFileSync(join(f.dir, "pending-delay.output"), "");
    seedTerminal(f.dir, { taskId: "old-done", finishedAt: now - 999_999 });
    await f.registry.reloadFromDisk();

    assert.equal(f.registry.get("pending-delay")?.status, "pending");
    assert.equal(existsSync(join(f.dir, "pending-delay.json")), true);
    assert.equal(f.registry.get("old-done"), undefined);
    assert.equal(existsSync(join(f.dir, "old-done.json")), false);
  } finally {
    await f.cleanup();
  }
});

test("prune tolerates missing output files without throwing", async () => {
  const now = Date.now();
  const f = fixture({ retentionMs: 1, retentionCount: 0 });
  try {
    seedTerminal(f.dir, { taskId: "no-out", finishedAt: now - 999_999, withOutput: false });
    await f.registry.reloadFromDisk();
    assert.equal(f.registry.get("no-out"), undefined);
    assert.equal(existsSync(join(f.dir, "no-out.json")), false);
    assert.equal(f.registry.prune(now).pruned, 0);
  } finally {
    await f.cleanup();
  }
});

test("within-age tasks are kept even when beyond retentionCount", async () => {
  const now = Date.now();
  // count=1 but three young tasks → all kept by age window
  const f = fixture({ retentionMs: 60_000, retentionCount: 1 });
  try {
    seedTerminal(f.dir, { taskId: "y0", finishedAt: now - 1_000 });
    seedTerminal(f.dir, { taskId: "y1", finishedAt: now - 2_000 });
    seedTerminal(f.dir, { taskId: "y2", finishedAt: now - 3_000 });
    seedTerminal(f.dir, { taskId: "aged", finishedAt: now - 120_000 });
    await f.registry.reloadFromDisk();
    assert.ok(f.registry.get("y0"));
    assert.ok(f.registry.get("y1"));
    assert.ok(f.registry.get("y2"));
    // aged is index 3 (>= count) and outside window → dropped
    assert.equal(f.registry.get("aged"), undefined);
    assert.equal(readdirSync(f.dir).filter((n) => n.endsWith(".json")).length, 3);
  } finally {
    await f.cleanup();
  }
});

test("default env retention keeps 100 newest of many aged tasks", async () => {
  const prevMs = process.env.PI_ASYNC_RETENTION_MS;
  const prevCount = process.env.PI_ASYNC_RETENTION_COUNT;
  delete process.env.PI_ASYNC_RETENTION_MS;
  delete process.env.PI_ASYNC_RETENTION_COUNT;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-prune-defaults-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const now = Date.now();
    for (let i = 0; i < 102; i++) {
      seedTerminal(dir, { taskId: `d${i}`, finishedAt: now - 8 * 24 * 60 * 60 * 1000 - i });
    }
    await registry.reloadFromDisk();
    assert.equal(registry.list({ includeHistory: true }).length, 100);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
    if (prevMs === undefined) delete process.env.PI_ASYNC_RETENTION_MS;
    else process.env.PI_ASYNC_RETENTION_MS = prevMs;
    if (prevCount === undefined) delete process.env.PI_ASYNC_RETENTION_COUNT;
    else process.env.PI_ASYNC_RETENTION_COUNT = prevCount;
  }
});
