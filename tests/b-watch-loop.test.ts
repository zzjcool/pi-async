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

function waitForCallback(start: (resolve: () => void) => void, timeoutMs = 3_500): Promise<void> {
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

test("non-JSON output remains pending until valid JSON can be evaluated", async () => {
  let output = "not json";
  let reads = 0;
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "pending-json",
      spec: spec({
        intervalMs: 1_000,
        timeoutMs: 8_000,
        blind_checks: 2,
        success_when: [{ type: "json_path_exists", path: "$.status" }],
        failure_when: [],
      }),
      readOutput: () => { reads++; return output; },
      getExitCode: () => undefined,
      onSuccess: () => { assert.ok(reads >= 2); done(); },
      onFailure: () => assert.fail("no failure conditions"),
      onBlindExhausted: () => assert.fail("pending JSON must not exhaust blind checks"),
      onWatchTimeout: () => assert.fail("valid JSON should arrive before timeout"),
    }).start();
    setTimeout(() => { output = '{"status":"ready"}'; }, 2_200);
  }, 5_000);
});

test("an unavailable exit code remains pending until the process exits", async () => {
  let exitCode: number | undefined;
  let polls = 0;
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "pending-exit-code",
      spec: spec({
        intervalMs: 1_000,
        timeoutMs: 8_000,
        blind_checks: 2,
        success_when: [{ type: "exit_code", equals: 0 }],
        failure_when: [],
      }),
      readOutput: () => "working",
      getExitCode: () => { polls++; return exitCode; },
      onSuccess: () => { assert.ok(polls >= 2); done(); },
      onFailure: () => assert.fail("no failure conditions"),
      onBlindExhausted: () => assert.fail("an unavailable exit code is pending"),
      onWatchTimeout: () => assert.fail("process should exit before timeout"),
    }).start();
    setTimeout(() => { exitCode = 0; }, 2_200);
  }, 5_000);
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

test("repeated start is idempotent and success fires only once", async () => {
  let successes = 0;
  await waitForCallback((done) => {
    const loop = new WatchLoop({
      taskId: "repeat-start",
      spec: spec(),
      readOutput: () => "ready",
      getExitCode: () => undefined,
      onSuccess: () => { successes++; done(); },
      onFailure: () => assert.fail("success must win"),
      onBlindExhausted: () => assert.fail("successful conditions are evaluable"),
      onWatchTimeout: () => assert.fail("watch should finish immediately"),
    });
    loop.start();
    loop.start();
  });
  assert.equal(successes, 1);
});

test("stop prevents all callbacks for at least two intervals", async () => {
  const intervalMs = 1_000;
  let callbacks = 0;
  const loop = new WatchLoop({
    taskId: "stopped",
    spec: spec({ intervalMs, timeoutMs: 5_000 }),
    readOutput: () => "working",
    getExitCode: () => undefined,
    onSuccess: () => { callbacks++; },
    onFailure: () => { callbacks++; },
    onBlindExhausted: () => { callbacks++; },
    onWatchTimeout: () => { callbacks++; },
  });
  loop.start();
  loop.stop();
  await new Promise((resolve) => setTimeout(resolve, 2 * intervalMs));
  assert.equal(callbacks, 0);
});

test("failure wins when success and failure conditions both match", async () => {
  let failures = 0;
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "failure-priority",
      spec: spec({
        success_when: [{ type: "stdout_contains", value: "ready" }],
        failure_when: [{ type: "stderr_contains", value: "ready" }],
      }),
      readOutput: () => "ready",
      getExitCode: () => undefined,
      onSuccess: () => assert.fail("failure must take priority"),
      onFailure: () => { failures++; done(); },
      onBlindExhausted: () => assert.fail("matching conditions are evaluable"),
      onWatchTimeout: () => assert.fail("matching conditions finish immediately"),
    }).start();
  });
  assert.equal(failures, 1);
});

test("blind count resets after conditions become evaluable", async () => {
  let reads = 0;
  await waitForCallback((done) => {
    new WatchLoop({
      taskId: "blind-reset",
      spec: spec({
        intervalMs: 1_000,
        timeoutMs: 8_000,
        blind_checks: 2,
        success_when: [{ type: "stdout_contains", value: "ready" }],
        failure_when: [],
      }),
      readOutput: () => {
        reads++;
        if (reads === 1 || reads === 3) throw new Error("temporarily unavailable");
        return reads >= 4 ? "ready" : "working";
      },
      getExitCode: () => undefined,
      onSuccess: () => done(),
      onFailure: () => assert.fail("no failure conditions"),
      onBlindExhausted: () => assert.fail("evaluable check must reset blind count"),
      onWatchTimeout: () => assert.fail("success should arrive before timeout"),
    }).start();
  }, 7_000);
  assert.ok(reads >= 4);
});
