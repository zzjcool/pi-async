import assert from "node:assert/strict";
import test from "node:test";
import { createRailFactory, renderRailRows } from "../src/tui/rail.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("rail rows are empty when there are no visible tasks", () => {
  assert.deepEqual(renderRailRows([], 80), []);
  assert.deepEqual(renderRailRows([makeSnapshot({ status: "pending" })], 80), []);
});

test("rail render rows strip ANSI and use the injected clock", () => {
  const rows = renderRailRows([makeSnapshot({ name: "\u001b]0;pwned\u0007job", startedAt: 10_000 })], 80, 12_000);
  assert.equal(rows[0], "▶ job · running · 2s");
});

test("rail renders task identity, status and elapsed and caps rows at ten", () => {
  const startedAt = Date.now() - 2_000;
  const snapshots = Array.from({ length: 14 }, (_, i) => makeSnapshot({ taskId: `task-${i}`, name: `job-${i}`, startedAt }));
  const rows = renderRailRows(snapshots, 100);
  assert.equal(rows.length, 10);
  assert.match(rows[0]!, /▶ job-0 · running · 2s/);
  assert.ok(rows.every((row) => row.length <= 100));
});

test("rail row state labels cover settled, failed and killed colors' underlying statuses", () => {
  const rows = renderRailRows([
    makeSnapshot({ status: "completed", taskId: "done" }),
    makeSnapshot({ status: "failed", taskId: "bad" }),
    makeSnapshot({ status: "killed", taskId: "dead" }),
  ], 100);
  assert.ok(rows.some((row) => row.includes("completed")));
  assert.ok(rows.some((row) => row.includes("failed")));
  assert.ok(rows.some((row) => row.includes("killed")));
});

test("rail assigns state-specific colors to each status", () => {
  const colors: string[] = [];
  const theme = {
    getFgAnsi: (color: string) => `\u001b[38;5;${16 + ["error", "dim", "syntaxVariable", "syntaxKeyword", "syntaxNumber", "syntaxFunction", "syntaxString", "syntaxType", "success"].indexOf(color)}m`,
    fg: (color: string, text: string) => { if (text !== "\0") colors.push(color); return text; },
  };
  const now = Date.now();
  const tasks = [
    makeSnapshot({ status: "running", taskId: "run" }),
    makeSnapshot({ status: "completed", taskId: "done", finishedAt: now - 1000, startedAt: now - 2000 }),
    makeSnapshot({ status: "failed", taskId: "bad", finishedAt: now - 1000, startedAt: now - 2000 }),
    makeSnapshot({ status: "killed", taskId: "dead", finishedAt: now - 1000, startedAt: now - 2000 }),
  ];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender() {} } as never, theme as never);
  widget.render(100);
  assert.deepEqual(colors, ["syntaxVariable", "success", "error", "dim"]);
});

test("terminal tasks linger briefly on the rail, then disappear", () => {
  const theme = { getFgAnsi: () => "\u001b[38;5;70m", fg: (_c: string, t: string) => t };
  const now = Date.now();
  const tasks = [
    makeSnapshot({ status: "completed", taskId: "recent", name: "recent-job", finishedAt: now - 1000, startedAt: now - 2000 }),
    makeSnapshot({ status: "completed", taskId: "stale", name: "stale-job", finishedAt: now - 120_000, startedAt: now - 130_000 }),
    makeSnapshot({ status: "running", taskId: "live", name: "live-job", startedAt: now }),
  ];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender() {} } as never, theme as never);
  const rows = widget.render(100).map((row) => row.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.equal(rows.length, 2, "recent terminal + live task remain; stale terminal drops");
  assert.ok(rows.some((row) => row.includes("recent-job")), "recently-finished task still visible");
  assert.ok(rows.some((row) => row.includes("live-job")), "running task always visible");
  assert.ok(!rows.some((row) => row.includes("stale-job")), "long-finished task disappears from the rail");
});

test("rail renders nothing when all tasks are stale terminal states", () => {
  const theme = { getFgAnsi: () => "\u001b[38;5;70m", fg: (_c: string, t: string) => t };
  const now = Date.now();
  const tasks = [makeSnapshot({ status: "completed", taskId: "old", finishedAt: now - 120_000, startedAt: now - 130_000 })];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender() {} } as never, theme as never);
  assert.deepEqual(widget.render(100), [], "idle session renders nothing (CONTRACT §8)");
});
