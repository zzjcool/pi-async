import assert from "node:assert/strict";
import test from "node:test";
import { deriveName, isTerminal, TERMINAL_STATUSES } from "../src/core/task.ts";

test("TERMINAL_STATUSES contains exactly the three terminal states", () => {
  assert.deepEqual(TERMINAL_STATUSES, ["completed", "failed", "killed"]);
});

test("isTerminal distinguishes active and terminal task states", () => {
  assert.equal(isTerminal("pending"), false);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("killed"), true);
});

test("deriveName normalizes command whitespace and uses the first line", () => {
  assert.equal(deriveName("  npm   test\n echo ignored"), "npm test");
  assert.equal(deriveName("  "), "async task");
});

test("deriveName caps the display name at 48 Unicode characters", () => {
  const name = deriveName("😀".repeat(60));
  assert.equal(Array.from(name).length, 48);
  assert.ok(name.endsWith("…"));
});
