import assert from "node:assert/strict";
import test from "node:test";
import { validateWatchSpec } from "../src/core/watch.ts";
import type { WatchSpec } from "../src/core/task.ts";

const validSpec = (overrides: Partial<WatchSpec> = {}): WatchSpec => ({
  intervalMs: 1_000,
  timeoutMs: 5_000,
  success_when: [{ type: "stdout_contains", value: "ready" }],
  failure_when: [],
  ...overrides,
});

test("accepts a valid spec and the minimum interval", () => {
  assert.deepEqual(validateWatchSpec(validSpec()), { ok: true });
});

test("rejects malformed or unsupported JSON paths before scheduling", () => {
  for (const path of ["a.b", "$.a.", "$.a..b", "$.a[-1]", "$.a[*]", "$.a[0"]) {
    assert.deepEqual(validateWatchSpec(validSpec({ success_when: [{ type: "json_path_exists", path }] })).ok, false);
  }
  assert.equal(validateWatchSpec(validSpec({ success_when: [{ type: "json_path_exists", path: "$.a.b[0]" }] })).ok, true);
});

test("rejects invalid regular expressions before scheduling", () => {
  const result = validateWatchSpec(validSpec({ success_when: [{ type: "output_matches", regex: "[" }] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /regex/);
});

test("enforces interval and watch timeout boundaries", () => {
  for (const intervalMs of [0, 999, 1_000.5, Number.POSITIVE_INFINITY]) {
    assert.equal(validateWatchSpec(validSpec({ intervalMs })).ok, false);
  }
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(validateWatchSpec(validSpec({ timeoutMs })).ok, false);
  }
  for (const timeoutMs of [1, 60_000]) assert.equal(validateWatchSpec(validSpec({ timeoutMs })).ok, true);
});

test("rejects an invalid blind check count", () => {
  assert.equal(validateWatchSpec(validSpec({ blind_checks: 0 })).ok, false);
  assert.equal(validateWatchSpec(validSpec({ blind_checks: 2 })).ok, true);
});
