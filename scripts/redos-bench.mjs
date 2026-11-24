#!/usr/bin/env node
/**
 * ReDoS benchmark for `output_matches` (pi-async #81 item 1.1).
 *
 * Question it answers with numbers: can a hostile `output_matches` regex actually pin the event
 * loop on a subject at the `MAX_MATCH_CHARS` (64K UTF-16 code units) cap?
 *
 * It deliberately uses the *same* evaluation path the watch loop uses — `evalConditions()` from
 * `src/core/watch.ts`, which goes through `evaluateConditionsDetailed` → `evaluateCondition` →
 * `matchSubject()` (the 64K tail cap) → `regex.test()` with the module's own `"m"` flag — rather
 * than a home-made `new RegExp`. Each case is additionally passed through `validateWatchSpec()` so
 * the report can say honestly which shapes the existing `NESTED_QUANTIFIER` blacklist already
 * rejects.
 *
 * Every measurement runs in a CHILD process with a hard wall-clock kill (SIGKILL), because a
 * catastrophic case would otherwise hang the harness itself. A kill is only accepted as evidence
 * when the child really was killed *by the timeout* (`error.code === "ETIMEDOUT"` AND wall clock
 * >= the budget); any other child failure is reported as `ERROR` with its stderr, counted as an
 * error, and makes the process exit non-zero. A harness that silently renders "child died at
 * startup" as "no match" would report the opposite verdict (that is reviewer finding M3).
 *
 * Read-only: nothing in `src/` is touched, no network, writes nothing.
 *
 * Usage (from the repo root):
 *   node --experimental-strip-types scripts/redos-bench.mjs                 # full run (~2 min)
 *   node --experimental-strip-types scripts/redos-bench.mjs --json
 *   node --experimental-strip-types scripts/redos-bench.mjs --sizes 1024,65536
 *   node --experimental-strip-types scripts/redos-bench.mjs --no-ladder --no-cold --no-clock-demo
 *   node --experimental-strip-types scripts/redos-bench.mjs --hard-timeout 5000 --cold-hard-timeout 15000
 *   # one datapoint by hand: --child <regex> <size> <tail|no-tail> [cold] [series:N]
 *   #   cold    = measure the FIRST execution of a freshly compiled regexp (no warm-up call)
 *   #   series:N = print N consecutive call times on one RegExp object
 *   node --experimental-strip-types scripts/redos-bench.mjs --child '(a|a)*$' 26 tail cold
 *   node --experimental-strip-types scripts/redos-bench.mjs --child '(a|a)*$' 18 tail cold series:6
 *
 * Reports: docs/reports/redos-benchmark.md
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, platform, release, arch } from "node:os";
import { fileURLToPath } from "node:url";

import { MAX_MATCH_CHARS, evalConditions, validateWatchSpec } from "../src/core/watch.ts";

const SELF = fileURLToPath(import.meta.url);
const STRIP = "--experimental-strip-types";

/** A case the watch loop could plausibly be asked to run. `tail` = the non-matching last char. */
const CASES = [
  { name: "(a|a)*$", regex: "(a|a)*$", note: "classic exponential; alternation of two identical branches" },
  { name: "(a+)+$", regex: "(a+)+$", note: "classic exponential; nested quantifier" },
  { name: "(a|aa)+$", regex: "(a|aa)+$", note: "classic exponential; ambiguous alternation" },
  { name: "(.*a){20}$", regex: "(.*a){20}$", note: "bounded repetition over `.*`" },
  { name: "^(a|a)*$", regex: "^(a|a)*$", note: "exploratory: anchored variant of case 1" },
  { name: "(a|a)*$ no-tail", regex: "(a|a)*$", note: "control: same regex, subject ends in `a` (matches on the greed first path)", tail: null },
  { name: "ready|done control", regex: "ready|done", note: "control: benign alternation, baseline cost" },
];

/**
 * Size ladders for the "smallest hangable input" question: how small can the subject be and still
 * blow the budget? Runs only shapes that survive `validateWatchSpec`.
 */
const LADDERS = [
  { regex: "(a|a)*$", sizes: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30] },
  { regex: "(a|aa)+$", sizes: [20, 24, 28, 32, 40, 48, 64] },
  { regex: "(.*a){20}$", sizes: [16, 20, 22, 24, 26, 28, 32] },
];

/**
 * First-call vs subsequent-call series: is the cold/warm gap a one-off first-call cost, or does the
 * evaluation keep getting cheaper? Six consecutive calls on one RegExp object answer it (the report
 * quotes the shape of this curve; the mechanism is V8's, and this script does not claim to name it).
 */
const SERIES = { regex: "(a|a)*$", size: 18, calls: 6 };

/**
 * Cold vs warm. A watch's FIRST poll executes a regexp object that has never run, and that first
 * call is ~6x more expensive than every later one (see SERIES: the cost is one-off, not a curve).
 * Measuring only the warm steady state would understate the first poll by ~6x on this machine, so
 * both are reported side by side. Cold rows get their own (larger) budget: the point of the table
 * is the *unhit* wall time, so a 5 s cold value must not be truncated by a 5 s kill line.
 */

const COLD_CASES = [
  { regex: "(a|a)*$", size: 18, hasTail: true },
  { regex: "(a|a)*$", size: 19, hasTail: true },
  { regex: "(a|a)*$", size: 20, hasTail: true },
  { regex: "(a|a)*$", size: 21, hasTail: true },
  { regex: "(a|a)*$", size: 22, hasTail: true },
  { regex: "(a|a)*$", size: 24, hasTail: true },
  { regex: "(a|a)*$", size: 26, hasTail: true },
  { regex: "(.*a){20}$", size: 20, hasTail: true },
  { regex: "(a|aa)+$", size: 28, hasTail: true },
  { regex: "ready|done", size: MAX_MATCH_CHARS, hasTail: true },
  { regex: "(a|a)*$", size: MAX_MATCH_CHARS, hasTail: false },
];

/**
 * Engine floor for `--experimental-strip-types`, read from `package.json` so an engines bump cannot
 * silently drift away from what this script checks. Falls back to the 0.5.0 value.
 */
const MIN_NODE = readEngineFloor();

function readEngineFloor() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const match = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)/.exec(String(pkg?.engines?.node ?? ""));
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    /* fall through to the pinned floor */
  }
  return [22, 19, 0];
}

function parseArgs(argv) {
  const options = {
    json: false,
    verbose: false,
    ladder: true,
    cold: true,
    clockDemo: true,
    hardTimeoutMs: 5_000,
    coldHardTimeoutMs: 15_000,
    sizes: [1_024, 8_192, MAX_MATCH_CHARS],
    child: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--no-ladder") options.ladder = false;
    else if (arg === "--no-cold") options.cold = false;
    else if (arg === "--no-clock-demo") options.clockDemo = false;
    else if (arg === "--hard-timeout") options.hardTimeoutMs = Number(argv[++index]);
    else if (arg === "--cold-hard-timeout") options.coldHardTimeoutMs = Number(argv[++index]);
    else if (arg === "--sizes") options.sizes = String(argv[++index]).split(",").map(Number);
    else if (arg === "--clock-demo-child") options.child = { clockDemo: true };
    else if (arg === "--child") {
      const regex = argv[++index];
      const rawSize = argv[++index];
      const size = Number(rawSize);
      const hasTail = argv[++index] !== "no-tail";
      const cold = argv[index + 1] === "cold";
      if (cold) index++;
      const seriesArg = argv[index + 1] ?? "";
      const series = seriesArg.startsWith("series:") ? Number(seriesArg.slice("series:".length)) : undefined;
      if (series !== undefined) {
        if (!Number.isInteger(series) || series < 1) throw new Error("--child series:N needs an integer N >= 1");
        index++;
      }
      // A hand-run `--child` with a missing/garbled argument would otherwise silently measure
      // `new RegExp(undefined)` on a 1-code-unit subject (review finding N1) — validate instead.
      if (typeof regex !== "string" || regex.length === 0) throw new Error("--child needs a regex string");
      if (rawSize === undefined || !Number.isInteger(size) || size < 2) throw new Error("--child needs an integer size >= 2");
      options.child = { regex, size, hasTail, cold, series };
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.hardTimeoutMs) || options.hardTimeoutMs <= 0) throw new Error("--hard-timeout must be > 0");
  if (!Number.isFinite(options.coldHardTimeoutMs) || options.coldHardTimeoutMs <= 0) throw new Error("--cold-hard-timeout must be > 0");
  if (options.sizes.some((size) => !Number.isFinite(size) || size < 2)) throw new Error("--sizes must be integers >= 2");
  return options;
}

/** Build the adversarial subject: `size` code units, last one the tail unless `hasTail` is false. */
function buildSubject(size, hasTail) {
  return hasTail ? "a".repeat(size - 1) + "!" : "a".repeat(size);
}

/**
 * Child: measure ONE case on ONE subject and print a single JSON line.
 * Runs out-of-process so a catastrophic case can be SIGKILLed by the parent.
 *
 * `cold` skips the warm-up so the interval covers the FIRST execution of a freshly compiled
 * regexp. (In production `validateWatchSpec` compiles it before the loop starts, so a cold child
 * also pays for `new RegExp`; that is ~0.1 ms of upward bias, invisible next to 300 ms.)
 */
function runChild({ regex, size, hasTail, cold, series }) {
  const output = buildSubject(size, hasTail);
  const conditions = [{ type: "output_matches", regex }];
  const ctx = { output, stdout: output, stderr: "" };
  // `evalConditions` returns a boolean, so a regex that fails to compile would read as "no match".
  // Compile first and report the failure as data instead (review finding N2).
  try {
    new RegExp(regex, "m");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: `regex does not compile: ${reason}` })}\n`);
    process.exitCode = 2;
    return;
  }
  if (!cold) evalConditions(conditions, { output: "a", stdout: "a", stderr: "" });
  if (series) {
    // The 6-call series answers "is the cold/warm gap a one-off first-call cost or a curve?".
    const calls = [];
    for (let call = 0; call < series; call++) {
      const start = process.hrtime.bigint();
      evalConditions(conditions, ctx);
      calls.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    process.stdout.write(`${JSON.stringify({ calls, subjectLength: output.length })}\n`);
    return;
  }
  const start = process.hrtime.bigint();
  const matched = evalConditions(conditions, ctx);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  process.stdout.write(`${JSON.stringify({ elapsedMs, matched, subjectLength: output.length })}\n`);
}

/**
 * Child: prove the hang is an event-loop stall, not just a slow return. A 100 ms timer is armed
 * before the evaluation; if it only fires after the evaluation returns, nothing else in the same
 * process could run during it — including the watch loop's own `timeoutMs` deadline and pi's TUI.
 */
function runClockDemoChild() {
  const output = buildSubject(28, true);
  const conditions = [{ type: "output_matches", regex: "(a|a)*$" }];
  evalConditions(conditions, { output: "a", stdout: "a", stderr: "" });
  const start = performance.now();
  let timerDelayMs;
  setTimeout(() => { timerDelayMs = performance.now() - start; }, 100);
  const matched = evalConditions(conditions, { output, stdout: output, stderr: "" });
  const evalMs = performance.now() - start;
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ evalMs, timerDelayMs, matched, subjectLength: output.length })}\n`);
  }, 50);
}

/**
 * Run one child and classify it. `killed` requires BOTH the spawnSync timeout to have fired and
 * the wall clock to reach the budget — a stray SIGKILL (OOM, `pkill`) is an `error`, never a result.
 */
function spawnChild(args, budgetMs, okField = "elapsedMs") {
  const start = performance.now();
  const result = spawnSync(process.execPath, [STRIP, SELF, ...args], {
    encoding: "utf8",
    timeout: budgetMs,
    killSignal: "SIGKILL",
    maxBuffer: 1 << 20,
  });
  const wallMs = performance.now() - start;
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout).trim().split("\n").pop() ?? "");
  } catch {
    parsed = undefined;
  }
  const stderr = String(result.stderr ?? "").trim();
  const killed = timedOut && wallMs >= budgetMs;
  let outcome;
  if (killed) outcome = "killed";
  else if (parsed && (typeof parsed[okField] === "number" || Array.isArray(parsed.calls))) outcome = "ok";
  else outcome = "error";
  return {
    outcome,
    killed,
    budgetMs,
    ...(parsed ?? {}),
    elapsedMs: parsed?.elapsedMs,
    matched: parsed?.matched,
    subjectLength: parsed?.subjectLength,
    wallMs,
    exitCode: result.status,
    signal: result.signal ?? null,
    stderr,
    stderrLine: stderr.split("\n")[0] ?? "",
  };
}

const measure = (regex, size, hasTail, budgetMs, cold = false) =>
  spawnChild(["--child", regex, String(size), hasTail ? "tail" : "no-tail", ...(cold ? ["cold"] : [])], budgetMs);

/** Fail loudly if this Node cannot run the child at all — otherwise every row is a fake "no match". */
function probeChild(expectedNode) {
  const probe = spawnChild(["--child", "ready", "4", "tail"], 30_000);
  if (probe.outcome === "ok") return undefined;
  const actual = process.versions.node;
  const floorOk = compareVersions(actual, expectedNode) >= 0;
  return [
    `child probe failed: node ${actual} could not run \`node ${STRIP} ${SELF} --child\` (outcome=${probe.outcome}, exit=${probe.exitCode}, signal=${probe.signal})`,
    floorOk ? "" : `node ${actual} is below the engines floor ${expectedNode.join(".")} from package.json`,
    probe.stderr.split("\n")[0] ?? "",
  ].filter(Boolean).join("; ");
}

function compareVersions(actual, floor) {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < floor.length; index++) {
    if ((parts[index] ?? 0) !== floor[index]) return (parts[index] ?? 0) - floor[index];
  }
  return 0;
}

function formatMs(value) {
  if (value === undefined) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

/** One table cell for a measurement: the number, the kill evidence, or the error. */
function describe(measurement, budgetMs) {
  if (measurement.outcome === "killed") {
    return `KILLED >${budgetMs} ms (wall ${Math.round(measurement.wallMs)} ms, ${measurement.signal}/exit ${measurement.exitCode})`;
  }
  if (measurement.outcome === "error") {
    return `ERROR (exit ${measurement.exitCode}, signal ${measurement.signal})`;
  }
  return `${formatMs(measurement.elapsedMs)} ${measurement.matched ? "match" : "no match"}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("see the header of scripts/redos-bench.mjs for usage");
    return;
  }
  if (options.child) {
    if (options.child.clockDemo) runClockDemoChild();
    else runChild(options.child);
    return;
  }

  const env = {
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    maxMatchChars: MAX_MATCH_CHARS,
    hardTimeoutMs: options.hardTimeoutMs,
    coldHardTimeoutMs: options.coldHardTimeoutMs,
    nodeFloor: MIN_NODE.join("."),
  };

  const probeError = probeChild(MIN_NODE);
  if (probeError) {
    if (options.json) console.log(JSON.stringify({ env, probeError, rows: [], ladderRows: [], coldRows: [], clockDemo: null, errors: 1 }, null, 2));
    else console.error(`redos-bench: ${probeError}`);
    process.exitCode = 2;
    return;
  }

  const rows = [];
  for (const testCase of CASES) {
    const hasTail = testCase.tail !== null;
    // Honest blacklist check: ask the real validator, do not eyeball the regex.
    const validation = validateWatchSpec({
      intervalMs: 1_000,
      timeoutMs: 60_000,
      success_when: [{ type: "output_matches", regex: testCase.regex }],
      failure_when: [],
    });
    const blocked = validation.ok === false;
    for (const size of options.sizes) {
      const measurement = blocked
        ? { outcome: "blocked", blocked: true, wallMs: 0 }
        : { ...measure(testCase.regex, size, hasTail, options.hardTimeoutMs), blocked: false };
      rows.push({ case: testCase.name, regex: testCase.regex, note: testCase.note, size, hasTail, blocked, validationError: blocked ? validation.error : undefined, ...measurement });
    }
  }

  const ladderRows = [];
  if (options.ladder) {
    for (const ladder of LADDERS) {
      for (const size of ladder.sizes) {
        ladderRows.push({ regex: ladder.regex, size, ...measure(ladder.regex, size, true, options.hardTimeoutMs) });
      }
    }
  }

  const coldRows = [];
  if (options.cold) {
    for (const entry of COLD_CASES) {
      const warm = measure(entry.regex, entry.size, entry.hasTail, options.hardTimeoutMs, false);
      const cold = measure(entry.regex, entry.size, entry.hasTail, options.coldHardTimeoutMs, true);
      coldRows.push({ regex: entry.regex, size: entry.size, hasTail: entry.hasTail, warm, cold });
    }
  }

  const seriesRun = options.ladder
    ? spawnChild(["--child", SERIES.regex, String(SERIES.size), "tail", "cold", `series:${SERIES.calls}`], options.coldHardTimeoutMs, "calls")
    : undefined;

  const clockDemo = options.clockDemo
    ? spawnChild(["--clock-demo-child"], Math.max(options.coldHardTimeoutMs, 20_000), "evalMs")
    : undefined;

  const all = [
    ...rows,
    ...ladderRows,
    ...coldRows.flatMap((row) => [row.warm, row.cold]),
    ...(seriesRun ? [seriesRun] : []),
    ...(clockDemo ? [clockDemo] : []),
  ];
  const errors = all.filter((measurement) => measurement.outcome === "error");
  const spawned = all.filter((measurement) => measurement.outcome !== "blocked").length;
  const measured = rows.filter((row) => !row.blocked).length;

  if (options.json) {
    console.log(JSON.stringify({ env, probeError, rows, ladderRows, coldRows, seriesRun, clockDemo, errors: errors.length }, null, 2));
    if (errors.length > 0) process.exitCode = 1;
    return;
  }

  console.log(`node ${env.node} (V8 ${env.v8}) on ${env.platform}/${env.arch} (${env.release})`);
  console.log(`cpu: ${env.cpu} x${env.cores}; engines floor node ${env.nodeFloor}; hard kill: ${env.hardTimeoutMs} ms (main/ladder), ${env.coldHardTimeoutMs} ms (cold), SIGKILL`);
  console.log(`subject cap (MAX_MATCH_CHARS): ${env.maxMatchChars} UTF-16 code units; adversarial tail: "!"`);
  console.log("");

  const regexWidth = Math.max(...[...CASES, ...COLD_CASES].map((entry) => entry.regex.length), 5);
  const printRow = (cells, widths) => console.log(cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  "));
  const caseWidth = Math.max(...rows.map((row) => row.case.length), 4);
  const descWidth = 62;

  printRow(["case", "regex", "size", "blacklist", "elapsed"], [caseWidth, regexWidth, 6, 9, descWidth]);
  printRow(["-".repeat(caseWidth), "-".repeat(regexWidth), "-".repeat(6), "-".repeat(9), "-".repeat(descWidth)], [caseWidth, regexWidth, 6, 9, descWidth]);
  for (const row of rows) {
    const elapsed = row.blocked ? "not evaluated (validation rejects it)" : describe(row, env.hardTimeoutMs);
    printRow([row.case, row.regex, String(row.size), row.blocked ? "BLOCKED" : "passes", elapsed], [caseWidth, regexWidth, 6, 9, descWidth]);
  }

  if (ladderRows.length > 0) {
    console.log("");
    console.log('smallest hangable input per shape: subject = "a" * (n-1) + "!"');
    printRow(["regex", "n", "elapsed"], [regexWidth, 6, descWidth]);
    for (const row of ladderRows) printRow([row.regex, String(row.size), describe(row, env.hardTimeoutMs)], [regexWidth, 6, descWidth]);
  }

  if (coldRows.length > 0) {
    console.log("");
    console.log(`cold vs warm: FIRST call on a freshly compiled regexp vs a warmed call; cold budget ${env.coldHardTimeoutMs} ms`);
    printRow(["regex", "n", "cold", "warm", "ratio"], [regexWidth, 6, descWidth, 14, 6]);
    for (const row of coldRows) {
      const ratio = row.cold.outcome === "ok" && row.warm.outcome === "ok" ? `${(row.cold.elapsedMs / row.warm.elapsedMs).toFixed(1)}x` : "—";
      printRow([
        row.regex,
        String(row.size),
        describe(row.cold, env.coldHardTimeoutMs),
        row.warm.outcome === "ok" ? formatMs(row.warm.elapsedMs) : describe(row.warm, env.hardTimeoutMs),
        ratio,
      ], [regexWidth, 6, descWidth, 14, 6]);
    }
  }

  if (seriesRun) {
    console.log("");
    console.log(`first-call vs subsequent calls: regex ${JSON.stringify(SERIES.regex)}, ${SERIES.size} code units, ${SERIES.calls} consecutive calls on ONE RegExp object`);
    if (seriesRun.outcome === "ok") {
      console.log(`  ${seriesRun.calls.map((ms, index) => `#${index + 1} ${formatMs(ms)}`).join("  ")}`);
    } else {
      console.log(`  ERROR (exit ${seriesRun.exitCode}, signal ${seriesRun.signal})${seriesRun.stderrLine ? `: ${seriesRun.stderrLine}` : ""}`);
    }
  }

  if (clockDemo) {
    console.log("");
    console.log('event-loop stall demo: regex "(a|a)*$", subject "a"*27 + "!" (28 code units), 100 ms timer armed first');
    if (clockDemo.outcome === "ok") {
      const firedBeforeReturn = clockDemo.timerDelayMs !== undefined && clockDemo.timerDelayMs < clockDemo.evalMs;
      console.log(`  eval returned after      : ${formatMs(clockDemo.evalMs)} (matched=${clockDemo.matched})`);
      console.log(`  the 100 ms timer fired at: ${formatMs(clockDemo.timerDelayMs)} after the arm`);
      console.log(`  verdict                  : ${firedBeforeReturn
        ? "timer fired DURING the evaluation — no stall on this input"
        : clockDemo.evalMs < 100
          ? "INCONCLUSIVE — the evaluation was shorter than the 100 ms timer interval"
          : "STALLED — nothing else in the process ran during the evaluation"}`);
    } else if (clockDemo.outcome === "killed") {
      console.log(`  KILLED at the ${Math.round(clockDemo.wallMs)} ms budget (${clockDemo.signal}) — inconclusive on the stall question`);
    } else {
      console.log(`  ERROR (exit ${clockDemo.exitCode}, signal ${clockDemo.signal})${clockDemo.stderrLine ? `: ${clockDemo.stderrLine}` : ""}`);
    }
  }

  const countOutcome = (list, outcome) => list.filter((entry) => entry.outcome === outcome).length;
  const warmest = all
    .filter((entry) => entry.outcome === "ok" && entry.elapsedMs !== undefined)
    .sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  console.log("");
  console.log(`measurement slots: ${all.length}; children spawned: ${spawned}; ok: ${countOutcome(all, "ok")}; killed by timeout: ${countOutcome(all, "killed")}; errors: ${errors.length}; validation-blocked slots (never spawned): ${all.length - spawned}`);
  console.log(`slowest measured evaluation: ${warmest ? `${formatMs(warmest.elapsedMs)} (${warmest.subjectLength ?? "?"} code units, matched=${warmest.matched})` : "none"}`);
  // A kill that lands long after its budget still has valid evidence, but it is worth naming:
  // spawnSync's timer can only fire between event-loop turns.
  const lateKills = all.filter((entry) => entry.outcome === "killed" && entry.wallMs - entry.budgetMs > 2_000);
  if (lateKills.length > 0) console.log(`note: ${lateKills.length} kill(s) landed >2 s past their budget (still ETIMEDOUT-evidenced)`);
  for (const entry of errors) {
    console.log(`ERROR detail: ${entry.stderrLine || entry.error || "(no stderr)"}`);
  }
  if (options.verbose) {
    for (const entry of all) if (entry.stderr && entry.outcome !== "error") console.log(`stderr: ${entry.stderrLine}`);
  }
  // A run that measured nothing (everything blocked or broken) must never end green (finding N6).
  if (measured === 0) {
    console.log("FAIL: no main-table cell was actually evaluated — nothing was measured");
    process.exitCode = 1;
  } else if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main();
