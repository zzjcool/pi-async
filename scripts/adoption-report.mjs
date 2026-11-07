#!/usr/bin/env node
/**
 * Adoption report for pi-async (PLAN-CONTEXT §6 measurement).
 *
 * Answers one question with real numbers instead of anecdotes: of all the shell calls a coding
 * agent made, how many ran in the foreground for longer than the async threshold, how much wall
 * clock that cost, and how many of them the extension's own nudge would have flagged.
 *
 * It reads pi session JSONL only (`role: "toolResult"` carries `durationMs`), so it works on any
 * machine that has run pi. Nothing is written and no network is used.
 *
 * Usage:
 *   npm run adoption                 # last 15 sessions under ~/.pi/agent/sessions
 *   npm run adoption -- --limit 50
 *   npm run adoption -- --dir /path/to/sessions --json
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bashNudge } from "../src/context/nudges.ts";

/** Thresholds reported in the table (milliseconds). */
const BUCKETS = [10_000, 30_000, 60_000, 120_000];

function parseArgs(argv) {
  const options = { dir: join(homedir(), ".pi", "agent", "sessions"), limit: 15, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--dir") options.dir = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error("--limit must be a non-negative number");
  return options;
}

/** Newest-first list of session files under `<dir>/<project>/<session>.jsonl`. */
function sessionFiles(dir, limit) {
  const projects = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const files = [];
  for (const project of projects) {
    const projectDir = join(dir, project.name);
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(projectDir, entry.name);
      files.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return (limit === 0 ? files : files.slice(0, limit)).map((file) => file.path);
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("usage: npm run adoption -- [--dir <sessions dir>] [--limit <n>] [--json]\n  --limit 0 scans every session");
  process.exit(0);
}

const durations = [];
const toolCalls = new Map();
let nudged = 0;
let sleepPoll = 0;
let sleepPollMs = 0;
let foregroundMs = 0;
const sessions = [];

for (const file of sessionFiles(options.dir, options.limit)) {
  const calls = new Map();
  const results = [];
  let sawMessage = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const message = record?.message;
    if (!message) continue;
    sawMessage = true;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && typeof block.name === "string") {
          toolCalls.set(block.name, (toolCalls.get(block.name) ?? 0) + 1);
          if (block.name === "bash") calls.set(block.id, String(block.arguments?.command ?? ""));
        }
      }
    }
    if (message.role === "toolResult" && typeof message.durationMs === "number") {
      results.push([message.toolCallId, message.toolName, message.durationMs]);
    }
  }
  if (sawMessage) sessions.push(file);
  for (const [id, toolName, ms] of results) {
    if (toolName !== "bash") continue;
    durations.push(ms);
    foregroundMs += ms;
    const command = calls.get(id) ?? "";
    if (bashNudge({ command, wallTimeSeconds: ms / 1000 }) !== undefined) nudged++;
    if (/(^|[;&|]\s*)sleep\s+\d{2,}/.test(command)) { sleepPoll++; sleepPollMs += ms; }
  }
}

const sorted = [...durations].sort((a, b) => a - b);
const bashTotal = toolCalls.get("bash") ?? 0;
const asyncRun = toolCalls.get("async_run") ?? 0;
const seconds = (ms) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;
const share = (part, whole) => (whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`);

const report = {
  sessions: sessions.length,
  toolCalls: Object.fromEntries([...toolCalls].sort((a, b) => b[1] - a[1])),
  bash: {
    total: bashTotal,
    measured: sorted.length,
    p50: seconds(percentile(sorted, 0.5)),
    p90: seconds(percentile(sorted, 0.9)),
    p99: seconds(percentile(sorted, 0.99)),
    max: seconds(sorted.at(-1)),
    foregroundMs,
    buckets: BUCKETS.map((threshold) => {
      const hits = sorted.filter((ms) => ms >= threshold);
      return { thresholdMs: threshold, calls: hits.length, share: share(hits.length, Math.max(1, sorted.length)), blockedMs: hits.reduce((sum, ms) => sum + ms, 0) };
    }),
    sleepPoll: { calls: sleepPoll, blockedMs: sleepPollMs },
  },
  asyncRun: { calls: asyncRun, share: share(asyncRun, Math.max(1, bashTotal + asyncRun)) },
  nudge: { covered: nudged, share: share(nudged, Math.max(1, sorted.length)) },
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`pi-async adoption report — ${report.sessions} session(s) from ${options.dir}`);
  console.log(`tool calls: ${Object.entries(report.toolCalls).map(([name, count]) => `${name} ${count}`).join(" · ")}`);
  console.log(`\nbash durations (measured ${sorted.length}/${bashTotal}): p50 ${report.bash.p50} · p90 ${report.bash.p90} · p99 ${report.bash.p99} · max ${report.bash.max}`);
  console.log(`foreground time: ${minutes(foregroundMs)}`);
  for (const bucket of report.bash.buckets) {
    console.log(`  >=${bucket.thresholdMs / 1000}s  ${String(bucket.calls).padStart(4)} (${bucket.share}) — ${minutes(bucket.blockedMs)}`);
  }
  console.log(`sleep-poll (>=10s): ${report.bash.sleepPoll.calls} calls — ${minutes(report.bash.sleepPoll.blockedMs)}`);
  console.log(`\nasync_run: ${report.asyncRun.calls} calls (${report.asyncRun.share} of shell calls)`);
  console.log(`nudge coverage: ${report.nudge.covered} calls (${report.nudge.share}) would receive the async_run hint`);
}
