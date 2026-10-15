import assert from "node:assert/strict";
import test from "node:test";
import { spawnDetached, killTree } from "../src/core/spawn.ts";

test("killTree terminates the detached process group including grandchildren", async () => {
  const handle = spawnDetached("sleep 5 & sleep 5", { outputFile: `/tmp/pi-async-kill-${process.pid}.log` });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await killTree(handle.pid, { graceMs: 100 });
  assert.deepEqual(result, { confirmed: true });
  const exit = await Promise.race([handle.exit, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]);
  assert.notEqual(exit, null, "detached shell should exit after its process group is killed");
});

test("killTree rejects unsafe process IDs", async () => {
  // PID 1 must never be treated as a task-owned process group.
  await assert.rejects(killTree(1), /pid must identify a child process/);
});
