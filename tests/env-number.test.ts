import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envNumber } from "../src/core/env.ts";
import { TaskRegistry } from "../src/core/registry.ts";

test("envNumber: undefined and empty string use fallback", () => {
  const key = "PI_ASYNC_TEST_ENV_NUMBER";
  delete process.env[key];
  assert.equal(envNumber(key, 32), 32);
  process.env[key] = "";
  assert.equal(envNumber(key, 32), 32);
  process.env[key] = "   ";
  assert.equal(envNumber(key, 32), 32);
  delete process.env[key];
});

test("envNumber: rejects non-finite, non-integer, and below min", () => {
  const key = "PI_ASYNC_TEST_ENV_NUMBER";
  process.env[key] = "abc";
  assert.equal(envNumber(key, 7, { integer: true, min: 1 }), 7);
  process.env[key] = "Infinity";
  assert.equal(envNumber(key, 7, { integer: true, min: 1 }), 7);
  process.env[key] = "2.7";
  assert.equal(envNumber(key, 7, { integer: true, min: 1 }), 7);
  process.env[key] = "0";
  assert.equal(envNumber(key, 7, { integer: true, min: 1 }), 7);
  process.env[key] = "-3";
  assert.equal(envNumber(key, 7, { integer: true, min: 1 }), 7);
  process.env[key] = "5";
  assert.equal(envNumber(key, 7, { integer: true, min: 1 }), 5);
  process.env[key] = "0";
  assert.equal(envNumber(key, 7, { integer: true, min: 0 }), 0);
  delete process.env[key];
});

test("PI_ASYNC_MAX_TASKS empty string falls back (does not disable with 0) (#21)", async () => {
  const previous = process.env.PI_ASYNC_MAX_TASKS;
  process.env.PI_ASYNC_MAX_TASKS = "";
  const dir = mkdtempSync(join(tmpdir(), "env-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const task = registry.submit({ command: "true", name: "ok", mode: "background" });
    assert.ok(task.taskId);
    await registry.wait([task.taskId], 3000);
  } finally {
    if (previous === undefined) delete process.env.PI_ASYNC_MAX_TASKS;
    else process.env.PI_ASYNC_MAX_TASKS = previous;
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
