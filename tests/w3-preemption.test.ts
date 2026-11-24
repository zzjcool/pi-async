import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../src/core/registry.ts";
import type { TaskSnapshot, WatchSpec } from "../src/core/task.ts";
import { registerTools, type ToolContext } from "../src/tools/index.ts";
import { MATCH_BUDGET_MS } from "../src/core/regex-worker.ts";
import { MAX_MATCH_CHARS, WatchLoop, evalConditions, evaluateConditionsDetailed } from "../src/core/watch.ts";
import { detailStatusLines } from "../src/tui/panel.ts";

/**
 * #113 / CONTRACT §26 (REV-34): `output_matches` evaluation is preemptible.
 *
 * The property under test is not "the regex got faster" — it is that the host keeps running while a
 * catastrophic pattern is being evaluated, and that running out of budget degrades to "not matched"
 * instead of a failure. Measured baseline (`docs/reports/redos-benchmark.md` §5): a 100 ms timer
 * armed before a 28-code-unit `(a|a)*$` evaluation fired 3.12 s late.
 */

/** A shape that survives `validateWatchSpec` (the blacklist only catches `(a+)+`) and backtracks. */
const HANGING_REGEX = "(a|a)*$";

/** `n` UTF-16 code units ending in a non-matching tail: the cheapest shape known to hang. */
const pathological = (codeUnits: number): string => "a".repeat(codeUnits - 1) + "!";

const empty = { output: "", stdout: "", stderr: "" };

test("#113 acceptance 1: a 10 ms timer fires within 200 ms while a 26/30-code-unit regex is evaluated", async () => {
  for (const codeUnits of [26, 30]) {
    const subject = pathological(codeUnits);
    let firedAt: number | undefined;
    const armedAt = Date.now();
    const timerFired = new Promise<void>((resolve) => {
      setTimeout(() => { firedAt = Date.now() - armedAt; resolve(); }, 10);
    });
    const startedAt = Date.now();
    const matched = await evalConditions([{ type: "output_matches", regex: HANGING_REGEX }], { output: subject, stdout: subject, stderr: "" });
    const elapsed = Date.now() - (armedAt ?? startedAt);
    await timerFired;

    assert.equal(matched, false, `${codeUnits} code units must degrade to "not matched", not to a verdict`);
    assert.ok(
      firedAt !== undefined && firedAt <= 200,
      `the 10 ms timer was starved: it fired after ${String(firedAt)} ms while a ${codeUnits}-code-unit subject was evaluated`,
    );
    assert.ok(elapsed <= 1_000, `evaluation must be cut at its ${MATCH_BUDGET_MS} ms budget, took ${elapsed} ms`);
  }
});

test("#113: an over-budget round is 'not matched' — not pending, not an infrastructure error", async () => {
  const subject = pathological(26);
  const result = await evaluateConditionsDetailed([{ type: "output_matches", regex: HANGING_REGEX }], { output: subject, stdout: subject, stderr: "" });
  assert.equal(result.status, "matched", "pending/error would either re-arm blindly or consume blind_checks");
  assert.equal(result.matched, false);
  assert.equal(result.budgetExceeded, 1);
});

test("#113: a benign pattern still evaluates correctly after a budget kill (worker is rebuilt)", async () => {
  const burned = await evaluateConditionsDetailed([{ type: "output_matches", regex: HANGING_REGEX }], { output: pathological(30), stdout: "", stderr: "" });
  assert.equal(burned.budgetExceeded, 1);
  // The over-budget worker was terminated; this call needs a replacement and must still answer.
  assert.equal(await evalConditions([{ type: "output_matches", regex: "ready|done" }], { output: "…ready\n", stdout: "", stderr: "" }), true);
  assert.equal(await evalConditions([{ type: "output_matches", regex: "ready|done" }], { output: "waiting\n", stdout: "", stderr: "" }), false);
});

test("#113: benign shapes keep their verdicts on a full 64K window (parity rows)", async () => {
  const wide = "x".repeat(MAX_MATCH_CHARS);
  assert.equal(await evalConditions([{ type: "output_matches", regex: "(a|a)*$" }], { output: "a".repeat(MAX_MATCH_CHARS), stdout: "", stderr: "" }), true);
  assert.equal(await evalConditions([{ type: "output_matches", regex: "ready|done" }], { output: wide, stdout: "", stderr: "" }), false);
  assert.equal(await evalConditions([{ type: "output_matches", regex: "ready|done" }], { output: `${wide}done\n`, stdout: "", stderr: "" }), true);
  assert.equal(await evalConditions([{ type: "output_matches", regex: "^READY$" }], { output: "noise\nREADY\nmore", stdout: "", stderr: "" }), true);
});

/* ───────────────────────── registry-level semantics (REV-34 ruling 2) ───────────────────────── */

const PATHOLOGICAL_OUTPUT = pathological(26);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-preemption-"));
  const registry = new TaskRegistry({ dataDir: dir, maxOutputBytes: 4 * 1024 * 1024 });
  const notices: TaskSnapshot[] = [];
  registry.setEvents({
    onFinalize: () => undefined,
    onStateChange: () => undefined,
    onMatchBudgetNotice: (snapshot) => { notices.push(snapshot); },
  });
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: ToolContext) => Promise<{ details: { payload?: unknown }; isError: boolean }> }>();
  registerTools({ registerTool: (tool: never) => { tools.set((tool as unknown as { name: string }).name, tool as never); } } as never, registry);
  return {
    dir,
    registry,
    notices,
    tools,
    cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Poll `predicate` until it holds (watches run on wall-clock intervals). */
async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * Wait until the task has actually produced the pathological subject.
 *
 * The first watch tick may run before the child has created its output file, and a *missing*
 * artifact is an infrastructure failure (REV-25) — attaching too early would make `blind_checks: 1`
 * settle the task before any regex is ever evaluated.
 */
async function waitForSubject(registry: TaskRegistry, taskId: string): Promise<void> {
  await until(() => {
    try { return registry.logs(taskId, { maxBytes: 4_096, tail: true }).text.includes("!"); } catch { return false; }
  }, 10_000, "the task output to carry the pathological subject");
}

const hangingWatch = (overrides: Partial<WatchSpec> = {}): WatchSpec => ({
  intervalMs: 1_000,
  timeoutMs: 20_000,
  // `blind_checks: 1` makes the test strict: if an over-budget round were ever treated as an
  // infrastructure error, the very first strike would settle the task as blind_exhausted.
  blind_checks: 1,
  success_when: [{ type: "output_matches", regex: HANGING_REGEX }],
  failure_when: [],
  ...overrides,
});

test("#113 acceptance 2: the task survives over-budget rounds — counter rises, status is not failed", async () => {
  const f = fixture();
  try {
    const task = f.registry.submit({ command: `printf '%s' '${PATHOLOGICAL_OUTPUT}'; sleep 30`, notifyOnCompletion: false });
    await waitForSubject(f.registry, task.taskId);
    f.registry.attachWatch(task.taskId, hangingWatch());
    const deadlineBefore = f.registry.get(task.taskId)?.watchDeadline;

    await until(() => (f.registry.get(task.taskId)?.matchBudgetExceeded ?? 0) >= 2, 12_000, "two over-budget rounds");

    const live = f.registry.get(task.taskId)!;
    assert.equal(live.status, "running", "an over-budget round must never settle the task");
    assert.equal(live.failureKind, undefined, "an over-budget round is not a failure");
    // `attachWatch` feeds the loop a relative remaining budget; what must not move is the deadline
    // that produces it (acceptance 4 asserts the deadline itself still fires).
    assert.equal(live.watchDeadline, deadlineBefore, "the watch deadline is untouched by the budget");
    assert.equal(live.exitCode, undefined, "the process keeps running");

    // One notice per task, however many rounds burned their budget.
    assert.equal(f.notices.length, 1, `expected exactly one notice, got ${f.notices.length}`);
    assert.equal(f.notices[0]?.taskId, task.taskId);

    // `async_status` carries the counter (the tool serializes the snapshot).
    const status = f.tools.get("async_status");
    assert.ok(status, "async_status must be registered");
    const listed = await status.execute("call-1", { includeHistory: true }, undefined, undefined, undefined);
    const rows = listed.details.payload as TaskSnapshot[];
    const row = rows.find((entry) => entry.taskId === task.taskId);
    assert.ok(row, "the task must appear in async_status");
    assert.ok((row.matchBudgetExceeded ?? 0) >= 2, `async_status must expose the counter, got ${String(row.matchBudgetExceeded)}`);

    // …and the TUI detail renders it with the "not a failure" wording.
    const detail = detailStatusLines(live, null, Date.now()).join("\n");
    assert.match(detail, /output_matches:/);
    assert.match(detail, /over the 25 ms budget/);
    assert.match(detail, /no-match, not a failure/);
  } finally { await f.cleanup(); }
});

test("#113 acceptance 4: timeoutMs still fires while the condition keeps burning its budget", async () => {
  const f = fixture();
  try {
    const startedAt = Date.now();
    const task = f.registry.submit({ command: `printf '%s' '${PATHOLOGICAL_OUTPUT}'; sleep 30`, notifyOnCompletion: false });
    await waitForSubject(f.registry, task.taskId);
    const armedAt = Date.now();
    f.registry.attachWatch(task.taskId, hangingWatch({ timeoutMs: 2_000 }));
    await until(() => {
      const status = f.registry.get(task.taskId)?.status;
      return status !== undefined && ["completed", "failed", "killed"].includes(status);
    }, 12_000, "the watch timeout to settle the task");
    const elapsed = Date.now() - startedAt;
    const settled = f.registry.get(task.taskId)!;
    assert.equal(settled.status, "failed");
    assert.equal(settled.failureKind, "watch_timeout");
    assert.ok(elapsed < 4_500, `the 2 s watch timeout must not be starved by the evaluation, took ${elapsed} ms`);
  } finally { await f.cleanup(); }
});

test("#113: the loop reports every burned budget to its deps and never stops scheduling", async () => {
  const burned: number[] = [];
  const loop = new WatchLoop({
    taskId: "budget-loop",
    spec: hangingWatch({ timeoutMs: 3_000 }),
    readOutput: () => ({ output: PATHOLOGICAL_OUTPUT, stdout: PATHOLOGICAL_OUTPUT, stderr: "" }),
    getExitCode: () => undefined,
    onSuccess: () => assert.fail("an over-budget condition must never succeed"),
    onFailure: () => assert.fail("an over-budget condition must never fail the watch"),
    onBlindExhausted: () => assert.fail("an over-budget round must not consume the blind budget"),
    onWatchTimeout: () => undefined,
    onMatchBudgetExceeded: (count) => { burned.push(count); },
  });
  loop.start();
  await until(() => burned.length >= 2, 12_000, "two over-budget rounds on the loop");
  loop.stop();
  assert.deepEqual(burned.slice(0, 2), [1, 1], "each round reports one burned evaluation");
});
