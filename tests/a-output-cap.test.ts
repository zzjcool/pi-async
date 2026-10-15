import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import { killTree } from "../src/core/spawn.ts";

function fixture(maxOutputBytes = 32) {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-output-cap-"));
  return { dir, registry: new TaskRegistry({ dataDir: dir, maxOutputBytes }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("output cap fails the task, persists metadata, and kills its process group", async () => {
  const f = fixture();
  try {
    const cappedTask = f.registry.submit({ command: "yes output" });
    const outcome = await f.registry.wait([cappedTask.taskId], 5000);
    assert.ok("results" in outcome);
    assert.equal(outcome.results[0]?.status, "failed");
    assert.equal(f.registry.get(cappedTask.taskId)?.killKind, "output_cap");
    assert.equal(f.registry.get(cappedTask.taskId)?.metadata.capped, true);
    assert.deepEqual(await killTree(cappedTask.pid!, { graceMs: 0 }), { confirmed: true });
  } finally {
    await f.registry.shutdown();
    f.cleanup();
  }
});
