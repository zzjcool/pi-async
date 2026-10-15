import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutputCapture } from "../src/core/output.ts";

test("OutputCapture caps writes by bytes and reports truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-output-"));
  const file = join(dir, "out");
  const capture = new OutputCapture(file, 7);
  try {
    assert.deepEqual(capture.write("hello"), { capped: false, totalBytes: 5 });
    assert.deepEqual(capture.write("world"), { capped: true, totalBytes: 7 });
    assert.deepEqual(capture.readTail(4), { text: "lowo", truncated: true, totalBytes: 7 });
    assert.deepEqual(capture.readLatestLines(2), ["hellowo"]);
  } finally { capture.close(); rmSync(dir, { recursive: true, force: true }); }
});
