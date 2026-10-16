import assert from "node:assert/strict";
import test from "node:test";
import { evalConditions } from "../src/core/watch.ts";
import type { Condition } from "../src/core/task.ts";

test("exit_code matches only an available equal code", () => {
  const conditions: Condition[] = [{ type: "exit_code", equals: 0 }];
  assert.equal(evalConditions(conditions, { output: "", exitCode: 0 }), true);
  assert.equal(evalConditions(conditions, { output: "", exitCode: 1 }), false);
  assert.equal(evalConditions(conditions, { output: "" }), false);
});

test("stdout_contains and stderr_contains match and reject absent text", () => {
  assert.equal(evalConditions([{ type: "stdout_contains", value: "ready" }], { output: "ready\n" }), true);
  assert.equal(evalConditions([{ type: "stdout_contains", value: "ready" }], { output: "waiting" }), false);
  assert.equal(evalConditions([{ type: "stderr_contains", value: "denied" }], { output: "error: denied" }), true);
  assert.equal(evalConditions([{ type: "stderr_contains", value: "denied" }], { output: "success" }), false);
});

test("json_path_exists resolves nested properties and array indexes", () => {
  const condition: Condition = { type: "json_path_exists", path: "$.a.b[0]" };
  assert.equal(evalConditions([condition], { output: '{"a":{"b":[null]}}' }), true);
  assert.equal(evalConditions([condition], { output: '{"a":{"b":[]}}' }), false);
  assert.equal(evalConditions([condition], { output: "not json" }), false);
});

test("output_matches applies a regular expression to the output stream", () => {
  const condition: Condition = { type: "output_matches", regex: "^device-code=[A-Z0-9]+$" };
  assert.equal(evalConditions([condition], { output: "device-code=AB12" }), true);
  assert.equal(evalConditions([condition], { output: "prefix device-code=AB12" }), false);
});

test("output_matches compiles with m so ^/$ anchor per line (CONTRACT #48)", () => {
  const condition: Condition = { type: "output_matches", regex: "^READY$" };
  // Marker on a middle line — without m, ^READY$ would require the whole stream to be READY.
  assert.equal(evalConditions([condition], { output: "NOT_READY_YET\nREADY\n" }), true);
  assert.equal(evalConditions([condition], { output: "NOT_READY_YET\nSTILL_WAITING\n" }), false);
});

test("conditions are ORed", () => {
  assert.equal(evalConditions([
    { type: "stdout_contains", value: "not here" },
    { type: "exit_code", equals: 7 },
  ], { output: "output", exitCode: 7 }), true);
});
