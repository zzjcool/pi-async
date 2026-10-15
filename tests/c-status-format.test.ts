import assert from "node:assert/strict";
import test from "node:test";
import { formatStatus } from "../src/tui/status.ts";

test("footer displays running plus pending count and completed count", () => {
  assert.equal(formatStatus({ running: 3, pending: 2 }, 7), " 5 running · 7 done ");
});
