import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init } from "../extensions/index.ts";
import { buildReminderXml, REMINDER_GUIDANCE, reminderGuidance, sendReminder } from "../src/core/notify.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { killTree, spawnDetached } from "../src/core/spawn.ts";
import type { TaskSnapshot } from "../src/core/task.ts";
import { registerTools } from "../src/tools/index.ts";
import { makeSnapshot } from "./helpers/index.ts";

/**
 * REV-23 runtime reminders + renewal (CONTRACT §18). Each test maps to one line of §18.11;
 * timing is exercised with tiny intervals (20–40 ms) instead of the 20 minute default, and the
 * schedule is asserted from the persisted absolute deadlines rather than from wall-clock gaps.
 */

const DEFAULT_REMIND_MS = 20 * 60 * 1000;
/** Absolute-time assertions tolerate the couple of Date.now() calls inside one start path. */
const SLACK_MS = 25;

type Tool = {
  name: string;
  promptSnippet?: string;
  parameters?: { properties?: Record<string, Record<string, unknown>> };
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
};
type Hook = (...args: unknown[]) => unknown;
type ReminderEvent = { taskId: string; count: number; at: number; remindAt?: number; status: string };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-reminder-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return {
    dir,
    registry,
    cleanup: async () => {
      await registry.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Unwrap the toolResult envelope (content text + details.payload). */
function payload<T>(result: unknown): T {
  return ((result as { details?: { payload?: unknown } }).details?.payload ?? result) as T;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Record what the extension would deliver, without a host: the registry-level half of §18.3. */
function recordReminders(registry: TaskRegistry): ReminderEvent[] {
  const events: ReminderEvent[] = [];
  registry.setEvents({
    onFinalize: () => undefined,
    onStateChange: () => undefined,
    onReminder: (snapshot) => {
      events.push({ taskId: snapshot.taskId, count: snapshot.remindCount ?? 0, at: Date.now(), remindAt: snapshot.remindAt, status: snapshot.status });
    },
  });
  return events;
}

test("§18.2 default: background + no watch arms start + 20 minutes; 0 disables; watch and a sooner hard deadline beat it", async () => {
  const f = fixture();
  try {
    const plain = f.registry.submit({ command: "sleep 20", name: "plain" });
    assert.ok(plain.remindAt !== undefined, "a plain background task must arm a reminder");
    assert.ok(Math.abs(plain.remindAt! - (plain.startedAt ?? plain.createdAt) - DEFAULT_REMIND_MS) <= SLACK_MS, "default is 1_200_000 ms from start");
    assert.equal(plain.metadata.remindIntervalMs, DEFAULT_REMIND_MS);

    // §18.2 rule 1: an explicit value wins; §18.11: 0 → no remindAt and no timer.
    const explicit = f.registry.submit({ command: "sleep 20", name: "explicit", remindAfterMs: 60_000 });
    assert.ok(Math.abs(explicit.remindAt! - (explicit.startedAt ?? explicit.createdAt) - 60_000) <= SLACK_MS);
    const disabled = f.registry.submit({ command: "sleep 20", name: "disabled", remindAfterMs: 0 });
    assert.equal(disabled.remindAt, undefined);
    assert.equal(disabled.metadata.remindIntervalMs, undefined);

    // §18.2 rule 2 + §18.10: a watch already owns the deadline, so the default is off…
    const watched = f.registry.submit({
      command: "sleep 20", name: "watched",
      watch: { intervalMs: 1000, timeoutMs: 60_000, success_when: [{ type: "stdout_contains", value: "never" }], failure_when: [] },
    });
    assert.equal(watched.remindAt, undefined, "watch disables the default reminder");
    // …but an explicit knob still opens it.
    const watchedExplicit = f.registry.submit({
      command: "sleep 20", name: "watched-explicit", remindAfterMs: 30_000,
      watch: { intervalMs: 1000, timeoutMs: 60_000, success_when: [{ type: "stdout_contains", value: "never" }], failure_when: [] },
    });
    assert.ok(Math.abs(watchedExplicit.remindAt! - (watchedExplicit.startedAt ?? watchedExplicit.createdAt) - 30_000) <= SLACK_MS);

    // §18.2 rule 4: the hard deadline lands first → no reminder that could only be late.
    const beaten = f.registry.submit({ command: "sleep 20", name: "beaten", remindAfterMs: 60_000, taskTimeoutMs: 30_000 });
    assert.equal(beaten.remindAt, undefined);
    assert.equal(beaten.metadata.remindIntervalMs, undefined);
    // …and a reminder that lands first stays armed.
    const beatsDeadline = f.registry.submit({ command: "sleep 20", name: "not-beaten", remindAfterMs: 5_000, taskTimeoutMs: 60_000 });
    assert.ok(beatsDeadline.remindAt !== undefined);
  } finally {
    await f.cleanup();
  }
});

test("§18.2 at start, not at createdAt: a delayed task arms when it actually starts", async () => {
  const f = fixture();
  try {
    const task = f.registry.scheduleDelayed({ command: "sleep 20", name: "later", remindAfterMs: 25 }, 120);
    assert.equal(task.status, "pending");
    assert.equal(task.remindAt, undefined, "a pending task has no reminder yet");
    await waitFor(() => f.registry.get(task.taskId)?.status === "running", "the delayed start");
    const started = f.registry.get(task.taskId)!;
    assert.ok(started.startedAt !== undefined);
    assert.ok(Math.abs(started.remindAt! - started.startedAt! - 25) <= SLACK_MS, "the interval counts from the real start");
  } finally {
    await f.cleanup();
  }
});

test("§18.3 delivery: async-task-reminder over followUp with elapsed-ms/remind-count, and the task keeps running (§18.5)", async () => {
  const f = fixture();
  const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const pi = { sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => { messages.push({ message, options }); } };
  try {
    f.registry.setEvents({
      onFinalize: () => undefined,
      onStateChange: () => undefined,
      // Mirrors extensions/index.ts: policy in the registry, delivery in the extension.
      onReminder: (snapshot) => { void sendReminder(pi as never, f.registry, snapshot); },
    });
    const task = f.registry.submit({ command: "printf 'compiling step one\\n'; sleep 20", name: "long <&> build", remindAfterMs: 25 });
    await waitFor(() => messages.length >= 1, "the first reminder");

    const [first] = messages;
    assert.equal(first!.message.customType, "async-task-reminder");
    assert.equal(first!.options.deliverAs, "followUp");
    assert.equal(first!.options.triggerTurn, true, "a reminder wakes the session like a completion does");
    const xml = String(first!.message.content);
    assert.match(xml, /^<async-task-reminder>/);
    assert.match(xml, /<\/async-task-reminder>$/);
    assert.match(xml, new RegExp(`<task-id>${task.taskId}</task-id>`));
    assert.match(xml, /<name>long &lt;&amp;&gt; build<\/name>/, "the name is XML-escaped");
    assert.match(xml, /<status>running<\/status>/);
    assert.match(xml, /<elapsed-ms>\d+<\/elapsed-ms>/);
    assert.match(xml, /<remind-count>1<\/remind-count>/);
    assert.match(xml, /<output-file>/);
    assert.match(xml, /compiling step one/, "the tail slice is attached");
    assert.match(xml, /<guidance>.*async_extend.*async_kill/, "guidance names both actions");
    assert.doesNotMatch(xml, /exit-code|kill-kind|failure-kind/, "a reminder is not a completion");

    // §18.5: the reminder path must not kill, not change `status`, not write `failureKind`.
    const live = f.registry.get(task.taskId)!;
    assert.equal(live.status, "running");
    assert.equal(live.exitCode, undefined);
    assert.equal(live.killKind, undefined);
    assert.equal(live.failureKind, undefined);
    assert.equal(live.remindCount, 1);
    assert.equal(f.registry.isProcessAlive(task.taskId), true, "the process is still alive after a reminder");
  } finally {
    await f.cleanup();
  }
});

test("§18.4 backoff: 1x → 2x → 4x, then stop at three reminders without killing or timing out", async () => {
  const f = fixture();
  const base = 30;
  try {
    const events = recordReminders(f.registry);
    const task = f.registry.submit({ command: "sleep 20", name: "backoff", remindAfterMs: base });
    assert.ok(Math.abs(task.remindAt! - (task.startedAt ?? task.createdAt) - base) <= SLACK_MS, "first reminder at 1x");

    await waitFor(() => events.length >= 3, "three reminders");
    // Each event reports the schedule it just armed: 2x after the first, 4x after the second.
    assert.equal(events[0]!.count, 1);
    assert.ok(Math.abs(events[0]!.remindAt! - events[0]!.at - 2 * base) <= SLACK_MS, `second reminder must be 2x, got ${events[0]!.remindAt! - events[0]!.at}ms`);
    assert.equal(events[1]!.count, 2);
    assert.ok(Math.abs(events[1]!.remindAt! - events[1]!.at - 4 * base) <= SLACK_MS, `third reminder must be 4x, got ${events[1]!.remindAt! - events[1]!.at}ms`);
    assert.equal(events[2]!.count, 3);
    assert.equal(events[2]!.remindAt, undefined, "the third reminder arms nothing");

    // 4x base would have fired again by now; a fourth reminder must never arrive.
    await sleep(4 * base + 150);
    assert.equal(events.length, 3, "the budget is three reminders, then silence");
    const live = f.registry.get(task.taskId)!;
    assert.equal(live.status, "running", "an exhausted budget never settles the task");
    assert.equal(live.remindAt, undefined);
    assert.equal(f.registry.isProcessAlive(task.taskId), true);
  } finally {
    await f.cleanup();
  }
});

test("§18.6 suppression skips delivery and does not re-arm: outputConsumed, notifyOnCompletion:false, terminal", async () => {
  const f = fixture();
  try {
    const events = recordReminders(f.registry);
    const consumed = f.registry.submit({ command: "sleep 20", name: "consumed", remindAfterMs: 40 });
    f.registry.consume(consumed.taskId);
    const silent = f.registry.submit({ command: "sleep 20", name: "silent", remindAfterMs: 40, notifyOnCompletion: false });
    const finished = f.registry.submit({ command: "true", name: "finished", remindAfterMs: 40 });
    const outcome = await f.registry.wait([finished.taskId], 5000);
    assert.ok("results" in outcome);
    assert.equal(f.registry.get(finished.taskId)?.status, "completed");

    await sleep(250);
    assert.deepEqual(events, [], "no reminder may be delivered for a suppressed task");

    for (const taskId of [consumed.taskId, silent.taskId]) {
      const task = f.registry.get(taskId)!;
      assert.equal(task.status, "running", "suppression is not a kill");
      assert.equal(task.remindCount ?? 0, 0, "a skipped reminder is not counted");
      assert.equal(task.remindAt, undefined, "a skipped reminder must not be re-armed");
      assert.equal(f.registry.isProcessAlive(taskId), true);
    }
    const terminal = f.registry.get(finished.taskId)!;
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.remindCount ?? 0, 0);
    assert.equal(terminal.remindAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("§18.7 async_extend moves remindAt, resets the count, renews taskTimeoutMs, and reports terminal/no-op shapes", async () => {
  const f = fixture();
  const tools = new Map<string, Tool>();
  registerTools({ registerTool: (tool: Tool) => { tools.set(tool.name, tool); } } as never, f.registry);
  const extend = tools.get("async_extend");
  assert.ok(extend, "async_extend must be registered");
  try {
    const task = f.registry.submit({ command: "sleep 20", name: "renewable", remindAfterMs: 60_000, taskTimeoutMs: 60_000 });
    const events = recordReminders(f.registry);

    const firstCallAt = Date.now();
    const renewed = payload<{ taskId: string; name: string; status: string; elapsedMs: number; remindAt?: number; remindCount: number; timeoutAt?: number; alreadyTerminal?: boolean }>(
      await extend!.execute("call-1", { taskId: "renewable", remindAfterMs: 30, taskTimeoutMs: 40 }),
    );
    assert.equal(renewed.taskId, task.taskId);
    assert.equal(renewed.name, "renewable", "a name resolves like a taskId (REV-15)");
    assert.equal(renewed.status, "running");
    assert.equal(renewed.alreadyTerminal, undefined, "the live shape carries no alreadyTerminal field");
    assert.ok(renewed.elapsedMs >= 0);
    assert.equal(renewed.remindCount, 0, "a renewal resets the count");
    assert.ok(Math.abs(renewed.remindAt! - firstCallAt - 30) <= SLACK_MS, "remindAt moves to now + remindAfterMs");
    assert.ok(Math.abs(renewed.timeoutAt! - firstCallAt - 40) <= SLACK_MS, "timeoutAt moves to now + taskTimeoutMs");

    await waitFor(() => events.length >= 1, "the renewed reminder");
    assert.equal(events[0]!.count, 1);

    // renewing again resets count and interval
    const secondCallAt = Date.now();
    const again = payload<{ remindAt?: number; remindCount: number }>(await extend!.execute("call-2", { taskId: task.taskId, remindAfterMs: 60_000 }));
    assert.equal(again.remindCount, 0);
    assert.ok(Math.abs(again.remindAt! - secondCallAt - 60_000) <= SLACK_MS);

    // taskTimeoutMs: 0 clears the hard deadline; a renewed short one still kills.
    const cleared = payload<{ timeoutAt?: number; remindAt?: number }>(await extend!.execute("call-3", { taskId: task.taskId, taskTimeoutMs: 0 }));
    assert.equal(cleared.timeoutAt, undefined, "0 removes the hard deadline");
    assert.equal(f.registry.get(task.taskId)?.status, "running", "clearing a deadline is not a kill");
    const killed = await extend!.execute("call-4", { taskId: task.taskId, taskTimeoutMs: 40 });
    assert.equal(payload<{ status: string }>(killed).status, "running");
    await waitFor(() => f.registry.get(task.taskId)?.status === "killed", "the renewed hard deadline");
    assert.equal(f.registry.get(task.taskId)?.killKind, "timeout");

    // §18.7: a terminal task returns alreadyTerminal instead of an error.
    const terminal = payload<{ status: string; alreadyTerminal?: boolean; elapsedMs: number; remindCount?: number }>(
      await extend!.execute("call-5", { taskId: "renewable", remindAfterMs: 1000 }),
    );
    assert.equal(terminal.status, "killed");
    assert.equal(terminal.alreadyTerminal, true);
    assert.ok(terminal.elapsedMs >= 0);

    // §18.7: both knobs missing is an error; unknown ids/names keep the REV-15 message.
    await assert.rejects(extend!.execute("call-6", { taskId: task.taskId }), /async_extend needs remindAfterMs or taskTimeoutMs/);
    await assert.rejects(extend!.execute("call-7", { taskId: "no-such-task", remindAfterMs: 1000 }), /Unknown task or name: no-such-task/);
  } finally {
    await f.cleanup();
  }
});

test("§18.8 reload re-arms on the remaining budget; an expired remindAt fires at once and keeps backing off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-reminder-reload-"));
  const remainingOutput = join(dir, "remaining.output");
  const overdueOutput = join(dir, "overdue.output");
  writeFileSync(remainingOutput, "remaining output\n");
  writeFileSync(overdueOutput, "overdue output\n");
  const remainingHandle = spawnDetached("sleep 30", { outputFile: remainingOutput });
  const overdueHandle = spawnDetached("sleep 30", { outputFile: overdueOutput });
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const now = Date.now();
    const remaining = makeSnapshot({
      taskId: "remaining", pid: remainingHandle.pid, startedAt: now - 850, createdAt: now - 850,
      remindAt: now + 150, remindCount: 1, metadata: { outputFile: remainingOutput, remindIntervalMs: 1000 },
    });
    const overdue = makeSnapshot({
      taskId: "overdue", pid: overdueHandle.pid, startedAt: now - 5000, createdAt: now - 5000,
      remindAt: now - 500, remindCount: 1, metadata: { outputFile: overdueOutput, remindIntervalMs: 1000 },
    });
    writeFileSync(join(dir, "remaining.json"), JSON.stringify(remaining));
    writeFileSync(join(dir, "overdue.json"), JSON.stringify(overdue));

    const events = recordReminders(registry);
    const reloadedAt = Date.now();
    await registry.reloadFromDisk();
    assert.equal(registry.get("remaining")?.status, "running");
    assert.equal(registry.get("overdue")?.status, "running");

    await waitFor(() => events.some((event) => event.taskId === "remaining") && events.some((event) => event.taskId === "overdue"), "both adopted reminders", 4000);
    const remainingAt = events.find((event) => event.taskId === "remaining")!.at - reloadedAt;
    assert.ok(remainingAt < 900, `re-armed on the remaining ~150ms, not a fresh 1000ms window (got ${remainingAt}ms)`);
    assert.equal(registry.get("remaining")?.remindCount, 2);
    const overdueAt = events.find((event) => event.taskId === "overdue")!.at - reloadedAt;
    assert.ok(overdueAt < 400, `an expired remindAt fires immediately (got ${overdueAt}ms)`);
    const overdueTask = registry.get("overdue")!;
    assert.equal(overdueTask.remindCount, 2, "the expired reminder counts as delivered");
    assert.ok((overdueTask.remindAt ?? 0) - events.find((event) => event.taskId === "overdue")!.at >= 3_800, "and the backoff continues at 4x the 1000ms base");
    // §18.5 again: adoption + reminders never settle the adopted task.
    assert.equal(overdueTask.status, "running");
    assert.equal(registry.get("remaining")?.status, "running");
  } finally {
    await registry.shutdown();
    await killTree(remainingHandle.pid, { graceMs: 0 });
    await killTree(overdueHandle.pid, { graceMs: 0 });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§18.3 XML shape: allowed fields only, escaping, and no guidance tag when none is passed", () => {
  const xml = buildReminderXml({
    taskId: "t1", name: "build <&> \u0000test", status: "running", elapsedMs: 1234, remindCount: 2,
    outputFile: "/tmp/out", summary: "tail", guidance: REMINDER_GUIDANCE, summaryTruncated: true,
  });
  assert.match(xml, /^<async-task-reminder>/);
  assert.match(xml, /<\/async-task-reminder>$/);
  assert.match(xml, /<elapsed-ms>1234<\/elapsed-ms>/);
  assert.match(xml, /<remind-count>2<\/remind-count>/);
  assert.match(xml, /<name>build &lt;&amp;&gt; test<\/name>/, "escaping plus C0 stripping");
  assert.match(xml, /<summary-truncated>true<\/summary-truncated>/);
  assert.doesNotMatch(xml, /exit-code|kill-kind|failure-kind/);

  const bare = buildReminderXml({ taskId: "t2", name: "n", status: "running", elapsedMs: 5, remindCount: 1, outputFile: "/tmp/out" });
  assert.doesNotMatch(bare, /<guidance>|<summary>/);
});

test("§18.11 tool surface: six tools, each with a snippet; async_run exposes remindAfterMs with minimum 0", async () => {
  const f = fixture();
  const tools = new Map<string, Tool>();
  registerTools({ registerTool: (tool: Tool) => { tools.set(tool.name, tool); } } as never, f.registry);
  await f.cleanup();
  assert.deepEqual([...tools.keys()].sort(), ["async_extend", "async_kill", "async_logs", "async_run", "async_status", "async_wait"]);
  for (const [name, tool] of tools) {
    const snippet = tool.promptSnippet ?? "";
    assert.ok(snippet.length > 0, `${name} must carry a promptSnippet (REV-20)`);
    assert.doesNotMatch(snippet, /[\r\n]/, `${name} snippet must be single-line`);
    assert.ok(snippet.length <= 140, `${name} snippet must be <= 140 chars, got ${snippet.length}`);
  }
  const runFields = tools.get("async_run")!.parameters?.properties ?? {};
  const remindAfterMs = runFields.remindAfterMs!;
  assert.equal(remindAfterMs.type, "number");
  assert.equal(remindAfterMs.minimum, 0, "0 disables, so the schema floors at 0");
  assert.match(String(remindAfterMs.description), /never kills/, "the field description says a reminder is not a kill");
  const extendFields = tools.get("async_extend")!.parameters?.properties ?? {};
  assert.equal(extendFields.remindAfterMs?.minimum, 0);
  assert.equal(extendFields.taskTimeoutMs?.minimum, 0);
});

test("§18.11 docs: CONTRACT §17 counts six tools, matching the tool list", () => {
  const contract = readFileSync(new URL("../docs/CONTRACT.md", import.meta.url), "utf8");
  const start = contract.indexOf("## 17.");
  const end = contract.indexOf("## 18.");
  assert.ok(start > 0 && end > start, "CONTRACT must keep §17 and §18");
  const section = contract.slice(start, end);
  assert.doesNotMatch(section, /5 个工具/, "§17 must not still claim five tools");
  assert.match(section, /6 个工具/, "§17 must state six tools");
});

test("§18.3 end-to-end through init(): the extension delivers the reminder via sendMessage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-reminder-init-"));
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook>();
  const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const sessionManager = { getSessionDir: () => cwd, getSessionId: () => "reminder-session" };
  const pi = {
    cwd,
    pid: process.pid,
    mode: "rpc",
    sessionManager,
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); return undefined; },
    on: (event: string, handler: Hook) => { hooks.set(event, handler); return () => hooks.delete(event); },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => { messages.push({ message, options }); },
  };
  const ctx = { cwd, sessionManager };
  try {
    await init(pi as never);
    const run = tools.get("async_run")!;
    const receipt = payload<{ taskId: string; status: string }>(
      await run.execute("e2e-reminder", { command: "printf 'build step\\n'; sleep 20", name: "init-reminder", mode: "background", remindAfterMs: 25 }, undefined, undefined, ctx),
    );
    assert.equal(receipt.status, "running");
    await waitFor(() => messages.some((entry) => entry.message.customType === "async-task-reminder"), "the reminder through init()");
    const reminder = messages.find((entry) => entry.message.customType === "async-task-reminder")!;
    assert.equal(reminder.options.deliverAs, "followUp");
    assert.equal(reminder.options.triggerTurn, true);
    const xml = String(reminder.message.content);
    assert.match(xml, new RegExp(`<task-id>${receipt.taskId}</task-id>`));
    assert.match(xml, /<remind-count>1<\/remind-count>/);
    assert.match(xml, /build step/);
    // A reminder is not a completion: no completion notification may be sent for a running task.
    assert.equal(messages.some((entry) => entry.message.customType === "async-task-notification"), false);
  } finally {
    await hooks.get("session_shutdown")?.();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("§18.12 guidance tells the truth about a hard deadline", () => {
  // Without a deadline the frozen sentence holds: nothing kills the process.
  assert.match(REMINDER_GUIDANCE, /no hard deadline/);
  assert.doesNotMatch(REMINDER_GUIDANCE, /kills it in/, "the no-deadline variant must not claim a kill");

  // With a deadline the same sentence would be a lie, so the variant names the remaining time.
  const soon = reminderGuidance(Date.now() + 45_000);
  assert.match(soon, /kills it in 4[45]s/, "must state the remaining budget");
  assert.match(soon, /taskTimeoutMs/, "must name the knob that kills it");
  assert.doesNotMatch(soon, /no hard deadline/, "must not claim there is no deadline");
  assert.match(reminderGuidance(), /no hard deadline/, "absent deadline falls back to the frozen sentence");
});

test("§18.12 a delayed-only renewal does not launder the reminder budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-extend-budget-"));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const receipt = registry.submit({
      command: "sleep 30", mode: "background", remindAfterMs: 60_000,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterRemind = registry.extend(receipt.taskId, { remindAfterMs: 60_000 });
    const count = afterRemind.remindCount ?? 0;
    assert.equal(count, 0, "an explicit remindAfterMs resets the count");

    // Only moving the hard deadline is a postponement: the reminder budget must survive it.
    const task = registry.get(receipt.taskId)!;
    task.remindCount = 2;
    const afterTimeout = registry.extend(receipt.taskId, { taskTimeoutMs: 120_000 });
    assert.equal(afterTimeout.remindCount, 2, "taskTimeoutMs alone must not reset the reminder count");
    assert.ok(afterTimeout.timeoutAt, "the new hard deadline is reported back");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
