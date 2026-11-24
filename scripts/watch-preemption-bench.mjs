#!/usr/bin/env node
/**
 * #113 / REV-34 evidence harness: pre/post event-loop freeze + benign parity.
 *
 * Two questions, both mechanical:
 *
 *  1. **Does the host keep running while a catastrophic `output_matches` regex is evaluated?**
 *     Arm a 10 ms timer, then evaluate a 26/30-code-unit subject. Before #113 the timer was dragged
 *     out to seconds (the evaluation ran on this very thread); after #113 it fires at ~10 ms and the
 *     evaluation is cut at its 25 ms budget.
 *  2. **Do benign conditions keep their exact verdicts?** A matrix of (regex, subject) pairs, run
 *     against any checkout, so `--tree` on `main` and on the branch can be diffed line by line.
 *
 * Usage:
 *   node --experimental-strip-types scripts/watch-preemption-bench.mjs                 # both tables
 *   node --experimental-strip-types scripts/watch-preemption-bench.mjs --demo          # freeze only
 *   node --experimental-strip-types scripts/watch-preemption-bench.mjs --parity        # verdicts only
 *   node --experimental-strip-types scripts/watch-preemption-bench.mjs --tree /path    # another checkout
 *   node --experimental-strip-types scripts/watch-preemption-bench.mjs --json          # machine output
 *
 * The subject cap is read from the checkout under test (`MAX_MATCH_CHARS`), so the "64K window"
 * rows are the real window of that tree, not a copy of a number.
 */
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const tree = resolve(option("--tree", join(import.meta.dirname, "..")));
const only = flag("--demo") ? "demo" : flag("--parity") ? "parity" : "both";
const asJson = flag("--json");

const watchModule = await import(pathToFileURL(join(tree, "src", "core", "watch.ts")).href);
const { evalConditions, MAX_MATCH_CHARS } = watchModule;
const detailed = watchModule.evaluateConditionsDetailed;

/** The shape the blacklist lets through (`docs/reports/redos-benchmark.md` §3). */
const HANGING_REGEX = "(a|a)*$";
/** `n` UTF-16 code units ending in a non-matching tail: the cheapest known way to hang this regex. */
const pathological = (codeUnits) => "a".repeat(codeUnits - 1) + "!";
const streams = (text) => ({ output: text, stdout: text, stderr: "" });
const ms = (value) => `${value.toFixed(2)} ms`;
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/* ───────────────────────── 1. event-loop freeze (acceptance 1) ───────────────────────── */

async function freezeDemo() {
  const rows = [];
  for (const codeUnits of [26, 30]) {
    const subject = pathological(codeUnits);
    let firedAt;
    const armedAt = now();
    const timerFired = new Promise((resolveTimer) => {
      setTimeout(() => { firedAt = now() - armedAt; resolveTimer(); }, 10);
    });
    const startedAt = now();
    const result = await evalConditions([{ type: "output_matches", regex: HANGING_REGEX }], streams(subject));
    const elapsed = now() - startedAt;
    await timerFired;
    rows.push({ codeUnits, matched: result, evalMs: elapsed, timerMs: firedAt });
  }
  return rows;
}

function renderFreeze(rows) {
  const lines = [
    `event-loop freeze demo: regex ${JSON.stringify(HANGING_REGEX)}, 10 ms timer armed before the evaluation`,
    "code units  eval returned after            the 10 ms timer fired at         verdict",
  ];
  for (const row of rows) {
    const stalled = row.timerMs > 200;
    lines.push(
      `${String(row.codeUnits).padEnd(11)} ${`${ms(row.evalMs)} (matched=${row.matched})`.padEnd(29)} ` +
        `${`${ms(row.timerMs)} after the arm`.padEnd(32)} ${stalled ? "STALLED (> 200 ms)" : "event loop stayed responsive"}`,
    );
  }
  return lines;
}

/* ───────────────────────── 2. benign parity matrix ───────────────────────── */

const sized = (size, fill = "x") => fill.repeat(size);

function parityMatrix() {
  const cap = MAX_MATCH_CHARS;
  const wide = sized(cap);
  const tailMarker = "UNIQUE_TAIL_MARKER_XYZ";
  return [
    { id: "control-64k-nomatch", regex: "ready|done", subject: wide },
    { id: "control-64k-match", regex: "ready|done", subject: `${wide}done\n` },
    { id: "control-8k-nomatch", regex: "ready|done", subject: sized(8 * 1024) },
    { id: "control-1k-match", regex: "ready|done", subject: `${sized(1024)}ready\n` },
    { id: "multiline-anchor", regex: "^(ready|done)$", subject: "noise\nready\nmore" },
    { id: "max-window-gapless", regex: HANGING_REGEX, subject: sized(cap, "a") },
    { id: "max-window-gapless-1k", regex: HANGING_REGEX, subject: sized(1024, "a") },
    { id: "word-boundary-64k", regex: "ERROR\\b", subject: `${wide}ERROR` },
    { id: "line-anchor-64k", regex: "^\\[[0-9]+\\] task", subject: `${wide}\n[12] task done\n` },
    { id: "tail-inside-window", regex: tailMarker, subject: `${wide}${tailMarker}` },
    { id: "tail-outside-window", regex: tailMarker, subject: `${tailMarker}${sized(cap + 10)}` },
    { id: "empty-subject", regex: "^$", subject: "" },
    { id: "empty-subject-nomatch", regex: ".", subject: "" },
    { id: "bounded-repeat-benign-1k", regex: "(.*a){20}$", subject: sized(1024, "b") },
    // Not benign at the full window: on this machine it sits right on the 25 ms line, which is
    // itself the point — the verdicts still agree (false), only the branch records a burned budget.
    { id: "bounded-repeat-64k-boundary", regex: "(.*a){20}$", subject: sized(64 * 1024, "b") },
  ];
}

async function runParity() {
  // One warm-up on a small subject so a cold start (worker thread on the branch, first RegExp on
  // main) is not charged to whichever row happens to be first.
  await evalConditions([{ type: "output_matches", regex: "ready|done" }], streams("ready\n"));
  const rows = [];
  for (const row of parityMatrix()) {
    const startedAt = now();
    // Exactly one evaluation per row, on both trees: `evaluateConditionsDetailed` exists only after
    // #113, and `evalConditions` is the shared entry point, so prefer the detailed one when present.
    let matched;
    let budgetExceeded = 0;
    if (typeof detailed === "function") {
      const check = await detailed([{ type: "output_matches", regex: row.regex }], streams(row.subject));
      matched = check.status === "matched" && check.matched;
      budgetExceeded = check.budgetExceeded ?? 0;
    } else {
      matched = await evalConditions([{ type: "output_matches", regex: row.regex }], streams(row.subject));
    }
    const elapsed = now() - startedAt;
    rows.push({ ...row, subjectChars: row.subject.length, matched, evalMs: elapsed, budgetExceeded });
  }
  return rows;
}

function renderParity(rows) {
  const lines = [
    `benign parity matrix: ${rows.length} rows, MAX_MATCH_CHARS = ${MAX_MATCH_CHARS} (subject cap of the tree under test)`,
    "case                        subject chars  matched  eval time     budget-exceeded",
  ];
  for (const row of rows) {
    lines.push(
      `${row.id.padEnd(27)} ${String(row.subjectChars).padStart(13)}  ${String(row.matched).padEnd(7)}  ` +
        `${ms(row.evalMs).padEnd(13)}  ${row.budgetExceeded}`,
    );
  }
  return lines;
}

/* ───────────────────────── run ───────────────────────── */

const out = { tree, node: process.version, maxMatchChars: MAX_MATCH_CHARS };
if (only !== "parity") {
  out.freeze = await freezeDemo();
  if (!asJson) { console.log(renderFreeze(out.freeze).join("\n")); console.log(""); }
}
if (only !== "demo") {
  out.parity = await runParity();
  if (!asJson) { console.log(renderParity(out.parity).join("\n")); console.log(""); }
}
if (asJson) console.log(JSON.stringify(out, null, 2));
