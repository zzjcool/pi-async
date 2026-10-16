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
  const bare = validateWatchSpec(validSpec({ success_when: [{ type: "json_path_exists", path: "ready" }] }));
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.match(bare.error, /must start with "\$"/);
  assert.equal(validateWatchSpec(validSpec({ success_when: [{ type: "json_path_exists", path: "$.a.b[0]" }] })).ok, true);
});

test("rejects invalid regular expressions before scheduling with grouped condition indexes", () => {
  const result = validateWatchSpec(validSpec({
    success_when: [{ type: "output_matches", regex: "^ready$" }, { type: "output_matches", regex: "[" }],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /success_when\[1\].*regex/);

  const failureResult = validateWatchSpec(validSpec({
    success_when: [],
    failure_when: [{ type: "stdout_contains", value: "fatal" }, { type: "output_matches", regex: "[" }],
  }));
  assert.equal(failureResult.ok, false);
  if (!failureResult.ok) assert.match(failureResult.error, /failure_when\[1\].*regex/);
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
