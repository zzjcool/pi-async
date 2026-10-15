import assert from "node:assert/strict";
import test from "node:test";
import { createRailFactory, renderRailRows } from "../src/tui/rail.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("rail rows are empty when there are no visible tasks", () => {
  assert.deepEqual(renderRailRows([], 80), []);
  assert.deepEqual(renderRailRows([makeSnapshot({ status: "pending" })], 80), []);
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
  const tasks = [
    makeSnapshot({ status: "running", taskId: "run" }),
    makeSnapshot({ status: "completed", taskId: "done" }),
    makeSnapshot({ status: "failed", taskId: "bad" }),
    makeSnapshot({ status: "killed", taskId: "dead" }),
  ];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender() {} } as never, theme as never);
  widget.render(100);
  assert.deepEqual(colors, ["syntaxVariable", "success", "error", "dim"]);
});
