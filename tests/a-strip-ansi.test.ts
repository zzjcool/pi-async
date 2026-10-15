import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../src/core/output.ts";

test("stripAnsi strips injected ESC, CSI, and OSC controls from logs", () => {
  assert.equal(stripAnsi("ok\x1B[2J\x1B]52;c;secret\x07safe\x1B[31mred\x1B[0m"), "oksafered");
});
