import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../src/core/output.ts";

test("stripAnsi removes ESC, CSI, OSC, and other ANSI string controls", () => {
  const sample = "plain\x1B7saved\x1B8 \x1B[31mred\x1B[0m \x1B]0;window title\x07\x1B]8;;https://example.test\x1B\\link\x1B]8;;\x1B\\ \x1BPpayload\x1B\\ end";
  assert.equal(stripAnsi(sample), "plainsaved red link  end");
});

test("stripAnsi removes C1 CSI and OSC controls", () => {
  assert.equal(stripAnsi("a\x9B32mb\x9B0m c\x9Dtitle\x9C d"), "ab c d");
});
