import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, truncateToWidth, fitWidth } from "../src/tui/width.ts";
import { renderRailRows } from "../src/tui/rail.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("displayWidth counts CJK/emoji as two cells", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("A中"), 3);
  assert.equal(displayWidth("😀"), 2);
});

test("truncateToWidth never overflows the cell budget", () => {
  assert.equal(truncateToWidth("hello", 10), "hello");
  assert.equal(displayWidth(truncateToWidth("中文任务名", 5)), 5);
  assert.ok(truncateToWidth("中文任务名", 5).endsWith("…"));
  assert.equal(truncateToWidth("abc", 0), "");
  assert.equal(truncateToWidth("abc", 1), "…");
});

test("fitWidth pads to exact cell width without ellipsis", () => {
  assert.equal(fitWidth("hi", 5), "hi   ");
  assert.equal(displayWidth(fitWidth("中文", 6)), 6);
  assert.equal(displayWidth(fitWidth("中文任务", 3)), 3);
  assert.ok(!fitWidth("中文任务", 3).includes("…"));
});

test("rail CJK rows stay within requested display width (#7)", () => {
  const now = Date.now();
  const mk = (name: string) =>
    makeSnapshot({ taskId: "t", name, mode: "background", status: "running", createdAt: now, startedAt: now });
  for (const width of [20, 15, 12]) {
    for (const name of ["中文任务", "中文任务名", "AB中文任务", "中abc文"]) {
      const row = renderRailRows([mk(name)], width, now)[0]!;
      assert.ok(displayWidth(row) <= width, `width=${width} dispW=${displayWidth(row)} row=${JSON.stringify(row)}`);
    }
  }
});
