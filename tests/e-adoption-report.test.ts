import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * PLAN-CONTEXT §6: adoption must be measurable, not asserted. The report reads real session
 * JSONL (`toolResult.durationMs`) and reuses the extension's own nudge predicate, so the number
 * it prints is the number of calls the shipped hint would have fired on.
 */

const SCRIPT = new URL("../scripts/adoption-report.mjs", import.meta.url).pathname;
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

test("adoption report measures durations and nudge coverage from session JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-adoption-"));
  const project = join(dir, "--demo--");
  mkdirSync(project);
  writeFileSync(join(project, "2026-01-01T00-00-00-000Z_demo.jsonl"), [
    line({ type: "session", version: 3, id: "demo" }),
    line({ type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 90; tail -5 out.log" } },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls -la" } },
      { type: "toolCall", id: "c3", name: "async_run", arguments: { command: "npm run build" } },
    ] } }),
    line({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", durationMs: 90_000 } }),
    line({ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", durationMs: 120 } }),
    line({ type: "message", message: { role: "toolResult", toolCallId: "c3", toolName: "async_run", durationMs: 5 } }),
  ].join(""));

  try {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--dir", dir, "--json"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout) as {
      sessions: number;
      toolCalls: Record<string, number>;
      bash: { measured: number; buckets: Array<{ thresholdMs: number; calls: number }>; sleepPoll: { calls: number } };
      asyncRun: { calls: number };
      nudge: { covered: number };
    };
    assert.equal(report.sessions, 1);
    assert.equal(report.toolCalls.bash, 2);
    assert.equal(report.toolCalls.async_run, 1);
    assert.equal(report.bash.measured, 2, "only bash results carry durations into the distribution");
    assert.equal(report.bash.buckets[0]?.calls, 1, "the 90s call is the only one >=10s");
    assert.equal(report.bash.buckets.at(-1)?.calls, 0, "nothing reached 120s");
    assert.equal(report.bash.sleepPoll.calls, 1, "sleep-polling is counted separately");
    assert.equal(report.nudge.covered, 1, "the shipped nudge predicate covers the sleep-poll call");
    assert.equal(report.asyncRun.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoption report fails loudly on an unknown flag instead of printing a wrong number", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--limit"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unknown argument|non-negative/);
});
