import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration } from "../src/core/duration.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("formatDuration: pending is an em dash", () => {
  assert.equal(formatDuration(makeSnapshot({ status: "pending", createdAt: 0 }), 60_000), "—");
});

test("formatDuration: live task ticks from startedAt", () => {
  const task = makeSnapshot({ status: "running", startedAt: 10_000, createdAt: 0 });
  assert.equal(formatDuration(task, 12_000), "2s");
  assert.equal(formatDuration(task, 10_000 + 90_000), "1m 30s");
  assert.equal(formatDuration(task, 10_000 + 3_700_000), "1h 1m");
});

test("formatDuration: terminal freezes at finishedAt (do not re-tick)", () => {
  const started = 1_000_000_000_000;
  const task = makeSnapshot({
    status: "completed",
    createdAt: started - 3_000,
    startedAt: started,
    finishedAt: started + 3_000,
  });
  for (const dt of [0, 5_000, 60_000, 3_600_000]) {
    assert.equal(formatDuration(task, started + 3_000 + dt), "3s");
  }
});

test("formatDuration: three tiers", () => {
  const t = (sec: number) =>
    formatDuration(makeSnapshot({ status: "running", startedAt: 0, createdAt: 0 }), sec * 1000);
  assert.equal(t(0), "0s");
  assert.equal(t(59), "59s");
  assert.equal(t(60), "1m 0s");
  assert.equal(t(61), "1m 1s");
  assert.equal(t(3599), "59m 59s");
  assert.equal(t(3600), "1h 0m");
  assert.equal(t(3661), "1h 1m");
});
