import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi, stripControl, visibleText } from "../src/core/output.ts";
import { renderRailRows } from "../src/tui/rail.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("stripControl removes bare C0 bytes and folds whitespace", () => {
  assert.equal(stripControl("a\x07b\x08c\x0cd"), "abcd");
  assert.equal(stripControl("a\r\nb\tc"), "a b c");
  assert.equal(stripControl("keep\x1fme"), "keepme");
});

test("visibleText strips ANSI then C0 for TUI labels", () => {
  assert.equal(visibleText("x\x1b[31mRED\x1b[0m\x07y"), "xREDy");
  assert.equal(visibleText("evil\x07\x08\x0cBACK"), "evilBACK");
  assert.equal(visibleText(null), "");
});

test("stripAnsi alone still leaves bare C0 (logs path)", () => {
  assert.equal(stripAnsi("x\x07y"), "x\x07y");
});

test("rail rows strip C0 from task names (#3)", () => {
  const now = 12_000;
  const row = renderRailRows([
    makeSnapshot({ name: "evil\x07\x08\x0cBACKSPACE_TEST", startedAt: 10_000 }),
  ], 200, now)[0]!;
  assert.equal(row, "▶ evilBACKSPACE_TEST · running · 2s");
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(row));
});
