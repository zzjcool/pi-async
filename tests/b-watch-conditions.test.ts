import assert from "node:assert/strict";
import test from "node:test";
import { evalConditions } from "../src/core/watch.ts";
import type { Condition } from "../src/core/task.ts";

const empty = { output: "", stdout: "", stderr: "" };

test("exit_code matches only an available equal code", () => {
  const conditions: Condition[] = [{ type: "exit_code", equals: 0 }];
  assert.equal(evalConditions(conditions, { ...empty, exitCode: 0 }), true);
  assert.equal(evalConditions(conditions, { ...empty, exitCode: 1 }), false);
  assert.equal(evalConditions(conditions, { ...empty }), false);
});

test("stdout_contains and stderr_contains match only their own stream", () => {
  assert.equal(evalConditions([{ type: "stdout_contains", value: "ready" }], { output: "ready\n", stdout: "ready\n", stderr: "" }), true);
  assert.equal(evalConditions([{ type: "stdout_contains", value: "ready" }], { output: "waiting", stdout: "waiting", stderr: "" }), false);
  assert.equal(evalConditions([{ type: "stderr_contains", value: "denied" }], { output: "error: denied", stdout: "", stderr: "error: denied" }), true);
  assert.equal(evalConditions([{ type: "stderr_contains", value: "denied" }], { output: "success", stdout: "success", stderr: "" }), false);
  assert.equal(evalConditions([{ type: "stderr_contains", value: "ON_STDOUT" }], { output: "ON_STDOUT", stdout: "ON_STDOUT", stderr: "" }), false);
  assert.equal(evalConditions([{ type: "stdout_contains", value: "ON_STDERR" }], { output: "ON_STDERR", stdout: "", stderr: "ON_STDERR" }), false);
});

test("json_path_exists resolves nested properties and array indexes", () => {
  const condition: Condition = { type: "json_path_exists", path: "$.a.b[0]" };
  assert.equal(evalConditions([condition], { output: '{"a":{"b":[null]}}', stdout: '{"a":{"b":[null]}}', stderr: "" }), true);
  assert.equal(evalConditions([condition], { output: '{"a":{"b":[]}}', stdout: '{"a":{"b":[]}}', stderr: "" }), false);
  assert.equal(evalConditions([condition], { output: "not json", stdout: "not json", stderr: "" }), false);
});

test("output_matches applies a regular expression to the merged output stream", () => {
  const condition: Condition = { type: "output_matches", regex: "^device-code=[A-Z0-9]+$" };
  assert.equal(evalConditions([condition], { output: "device-code=AB12", stdout: "device-code=AB12", stderr: "" }), true);
  assert.equal(evalConditions([condition], { output: "prefix device-code=AB12", stdout: "prefix device-code=AB12", stderr: "" }), false);
  assert.equal(evalConditions([condition], { output: "device-code=AB12", stdout: "", stderr: "device-code=AB12" }), true);
});

test("output_matches compiles with m so ^/$ anchor per line (CONTRACT #48)", () => {
  const condition: Condition = { type: "output_matches", regex: "^READY$" };
  // Marker on a middle line — without m, ^READY$ would require the whole stream to be READY.
  assert.equal(evalConditions([condition], { output: "NOT_READY_YET\nREADY\n", stdout: "NOT_READY_YET\nREADY\n", stderr: "" }), true);
  assert.equal(evalConditions([condition], { output: "NOT_READY_YET\nSTILL_WAITING\n", stdout: "NOT_READY_YET\nSTILL_WAITING\n", stderr: "" }), false);
});

test("conditions are ORed", () => {
  assert.equal(evalConditions([
    { type: "stdout_contains", value: "not here" },
    { type: "exit_code", equals: 7 },
  ], { output: "output", stdout: "output", stderr: "", exitCode: 7 }), true);
});
