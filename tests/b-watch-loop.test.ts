import assert from "node:assert/strict";
import test from "node:test";
import { WatchLoop } from "../src/core/watch.ts";
import type { WatchSpec } from "../src/core/task.ts";

const spec = (overrides: Partial<WatchSpec> = {}): WatchSpec => ({
  intervalMs: 1_000,
  timeoutMs: 10_000,
  success_when: [{ type: "stdout_contains", value: "ready" }],
  failure_when: [{ type: "stderr_contains", value: "fatal" }],
  blind_checks: 3,
  ...overrides,
});

function waitForCallback(start: (resolve: () => void) => void, timeoutMs = 1_500): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watch callback timed out")), timeoutMs);
    start(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("success calls onSuccess and does not call failure or kill callbacks", async () => {
  let output = "working";
  let successes = 0;
  let failures = 0;
  await waitForCallback((done) => {
    const loop = new WatchLoop({
      taskId: "success",
      spec: spec(),
      readOutput: () => output,
      getExitCode: () => undefined,
      onSuccess: (detail) => { assert.match(detail, /success_when/); successes++; done(); },
      onFailure: () => { failures++; done(); },
      onBlindExhausted: done,
      onWatchTimeout: done,
    });
    loop.start();
    setTimeout(() => { output = "ready"; }, 20);
  });
  assert.equal(successes, 1);
});

test("failure_when calls onFailure", async () => {
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "failure",
      spec: spec(),
      readOutput: () => "fatal error",
      getExitCode: () => undefined,
      onSuccess: () => assert.fail("failure path must not succeed"),
      onFailure: done,
      onBlindExhausted: () => assert.fail("failure path must not exhaust blind checks"),
      onWatchTimeout: () => assert.fail("failure path must not timeout"),
    }).start();
  });
});

test("consecutive un-evaluable conditions exhaust blind checks", async () => {
  let reads = 0;
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "blind",
      spec: spec({
        intervalMs: 1_000,
        blind_checks: 3,
        success_when: [{ type: "json_path_exists", path: "$.status" }],
        failure_when: [],
      }),
      readOutput: () => { reads++; return "not json"; },
      getExitCode: () => undefined,
      onSuccess: () => assert.fail("invalid JSON cannot match"),
      onFailure: () => assert.fail("no failure conditions"),
      onBlindExhausted: done,
      onWatchTimeout: () => assert.fail("blind checks should finish first"),
    }).start();
  }, 4_000);
  assert.equal(reads, 3);
});

test("watch timeout calls onWatchTimeout", async () => {
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "timeout",
      spec: spec({ timeoutMs: 40, intervalMs: 1_000, success_when: [], failure_when: [] }),
      readOutput: () => "",
      getExitCode: () => undefined,
      onSuccess: () => assert.fail("empty conditions cannot succeed"),
      onFailure: () => assert.fail("empty conditions cannot fail"),
      onBlindExhausted: () => assert.fail("empty conditions do not exhaust"),
      onWatchTimeout: done,
    }).start();
  });
});

test("read errors count as blind checks and stop after configured limit", async () => {
  let reads = 0;
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "read-error",
      spec: spec({ intervalMs: 1_000, blind_checks: 2 }),
      readOutput: () => { reads++; throw new Error("unavailable"); },
      getExitCode: () => undefined,
      onSuccess: () => assert.fail("read failed"),
      onFailure: () => assert.fail("read failed"),
      onBlindExhausted: done,
      onWatchTimeout: () => assert.fail("blind exhaustion comes first"),
    }).start();
  }, 2_500);
  assert.equal(reads, 2);
});
