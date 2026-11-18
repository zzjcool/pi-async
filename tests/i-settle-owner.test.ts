import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init } from "../extensions/index.ts";
import { HOLD_FALLBACK_WIDGET_KEY } from "../src/guard/hold.ts";

/**
 * 0.4.2 regression (report 2026-11-17): one terminal event, two announcements.
 *
 * A task that finishes *while the settle hold is waiting* was announced twice:
 *
 *   1. `async-task-settle-results` — the hold's `agent_before_settle` draft. pi commits boundary
 *      drafts immediately (`agent-session.js:560-574`), so it lands in the transcript in-run.
 *   2. `async-task-notification` — sent by `onFinalize` as `{deliverAs:"followUp"}` *while the run
 *      is streaming*. pi only enqueues that (`agent-session.js:1959-1962`); it becomes a user
 *      message at the next "agent would stop" point (`agent-loop.js:196-203`), i.e. after the
 *      model has already answered the results entry. The user sees a "late receipt" 38–50 s later
 *      (session 01a1e5b5, JSONL ln393→ln404 49.586 s, ln432→ln441 38.226 s).
 *
 * So this is not a race: the ordering is fixed by the host, and both messages are guaranteed.
 * The hold owns the terminal event (its entry cannot be dropped), so the notification must not be
 * sent for the tasks the entry already reports — while every other exit (timeout, dispose, a
 * legion child) still keeps the normal notification.
 *
 * This file models the host faithfully: followUps are queued while the run is live and only
 * become transcript records when the run ends (or, for `triggerTurn:false`, at `turn_end`).
 */

type Hook = (...args: unknown[]) => unknown;
type Tool = {
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
};

type Announcement = { customType: string; content: string; deliveredIn: "boundary" | "turn-boundary" | "later-turn" };

type BeforeSettleResult = { entries?: Array<{ customType?: string; content?: string }>; continue?: boolean } | undefined;

function payload(result: unknown): { taskId: string; status: string } {
  const wrapped = result as { details?: { payload?: { taskId: string; status: string } } };
  return (wrapped.details?.payload ?? result) as { taskId: string; status: string };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the host condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A fake pi host whose message ordering matches 1.5.2 (`agent-session.js` / `agent-loop.js`). */
function makeHost(cwd: string) {
  const hooks = new Map<string, Hook[]>();
  const tools = new Map<string, Tool>();
  /** What the model has actually seen, in order. */
  const transcript: Announcement[] = [];
  /** `sendMessage(..., {deliverAs:"followUp"})` while streaming: queued, invisible to the model. */
  const followUps: Array<{ customType: string; content: string }> = [];
  /** `deliverAs:"steer"` while streaming: queued too, but drained at the *next* turn boundary. */
  const steerQueue: Array<{ customType: string; content: string }> = [];
  let runLive = false;
  const sessionManager = { getSessionDir: () => cwd, getSessionId: () => "i-settle-owner" };

  const pi = {
    cwd,
    pid: process.pid,
    mode: "tui",
    sessionManager,
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    on: (event: string, handler: Hook) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
      return () => {
        const current = hooks.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    sendMessage: (message: { customType: string; content: string }, options?: { deliverAs?: string }) => {
      // agent-session.js:1959-1965 — streaming + steer/followUp is enqueue-only, nothing is written now.
      if (runLive && options?.deliverAs === "steer") {
        steerQueue.push({ customType: message.customType, content: String(message.content) });
        return;
      }
      if (runLive && options?.deliverAs === "followUp") {
        followUps.push({ customType: message.customType, content: String(message.content) });
        return;
      }
      transcript.push({ customType: message.customType, content: String(message.content), deliveredIn: "later-turn" });
    },
  };

  /** Raw terminal-input subscription, exactly like `ui.onTerminalInput` (tui.js:719-735). */
  let press: ((data: string) => undefined) | undefined;
  /** Every row the hold paints itself (`setWidget(HOLD_FALLBACK_WIDGET_KEY, …)`, §7.1 修订 8). */
  const progressRows: Array<string[] | undefined> = [];
  const ui = {
    setStatus: () => undefined,
    setWidget: (key: string, content: string[] | undefined) => {
      if (key === HOLD_FALLBACK_WIDGET_KEY) progressRows.push(content);
    },
    onTerminalInput: (handler: (data: string) => undefined) => {
      press = handler;
      return () => { press = undefined; };
    },
  };

  const fire = async (event: string, ...args: unknown[]): Promise<unknown[]> => {
    // The settle boundary is only reachable from inside a live run: `isStreaming` is true there, so
    // `sendMessage({deliverAs:"followUp"})` enqueues instead of writing (agent-session.js:1959).
    if (event !== "session_start" && event !== "session_shutdown") runLive = true;
    const results: unknown[] = [];
    for (const handler of hooks.get(event) ?? []) results.push(await handler(...args));
    return results;
  };

  return {
    pi,
    transcript,
    followUps,
    steerQueue,
    /** Everything the host still holds, whichever queue it is in. */
    queued: (): number => steerQueue.length + followUps.length,
    tools,
    ui,
    progressRows,
    pressEscape: () => press?.("\x1b"),
    hasEscapeListener: () => press !== undefined,
    fire,
    /**
     * The settle boundary: pi commits the drafts the handler returned (in-run), then runs the extra
     * provider request `continue: true` asks for. The followUp queue is NOT drained here — that is
     * exactly what put the notification 38–50 s behind the entry in the reported session.
     */
    settle: async (result: BeforeSettleResult): Promise<void> => {
      for (const entry of result?.entries ?? []) {
        transcript.push({ customType: String(entry.customType), content: String(entry.content), deliveredIn: "boundary" });
      }
    },
    /** The run ends: only now does pi turn queued followUps into transcript records. */
    endRun: (): void => {
      runLive = false;
      for (const message of steerQueue.splice(0)) transcript.push({ ...message, deliveredIn: "turn-boundary" });
      for (const message of followUps.splice(0)) transcript.push({ ...message, deliveredIn: "later-turn" });
    },
    /** The `turn_end` boundary: pi drains the steering queue right after it (agent-loop.js:188-199). */
    turnEnd: async (): Promise<void> => {
      await fire("turn_end", {});
      for (const message of steerQueue.splice(0)) transcript.push({ ...message, deliveredIn: "turn-boundary" });
    },
    /** A later genuinely-idle `session_start` (what `resendUnnotified` runs on). */
    idle: (): void => { runLive = false; },
    mentions: (text: string): Announcement[] => transcript.filter((entry) => entry.content.includes(text)),
  };
}

type Env = "PI_ASYNC_HOLD_MS" | "PI_ASYNC_HOLD_POLL_MS" | "PI_LEGION_NODE_ID" | "PI_ASYNC_SETTLE_GUARD";

async function withEnv<T>(env: Partial<Record<Env, string | undefined>>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<Env, string | undefined>();
  for (const name of Object.keys(env) as Env[]) {
    saved.set(name, process.env[name]);
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const CLEAN: Partial<Record<Env, string | undefined>> = {
  PI_ASYNC_HOLD_MS: "5000",
  PI_ASYNC_HOLD_POLL_MS: "20",
  PI_LEGION_NODE_ID: undefined,
  PI_ASYNC_SETTLE_GUARD: undefined,
};

test("a task that finishes inside the hold is announced exactly once — by the settle-results entry", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-owner-"));
  await withEnv(CLEAN, async () => {
    const host = makeHost(cwd);
    const ctx = { cwd, sessionManager: (host.pi as { sessionManager: unknown }).sessionManager };
    try {
      await init(host.pi as never);
      await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager: ctx.sessionManager });

      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.15; echo AGENT_DONE",
        name: "watch-finish",
        mode: "background",
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      }, undefined, undefined, ctx));
      assert.equal(task.status, "running");

      // The turn ends while the task runs: the hold waits, the task finishes during the wait.
      const [result] = (await host.fire("agent_before_settle", { entries: [] }, { mode: "tui", ui: { setStatus: () => undefined } })) as BeforeSettleResult[];
      await host.settle(result);
      // The model answers the entry; then the run has nothing left to do.
      host.endRun();

      const announcements = host.mentions("watch-finish");
      assert.equal(
        announcements.length,
        1,
        `one terminal event must be announced once, got ${announcements.length}: ${announcements.map((a) => a.customType).join(" → ")}`,
      );
      assert.equal(announcements[0]?.customType, "async-task-settle-results", "the in-run entry is the owner (it cannot be dropped by Esc)");
      assert.equal(announcements[0]?.deliveredIn, "boundary", "the announcement must not be a later-turn followUp");
      assert.deepEqual(host.followUps, [], "no completion notification is queued for a task the results entry already reports");
      assert.match(announcements[0]!.content, /all finished: watch-finish \(completed, exit 0\)/);
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("the folded notification is latched, so a later session_start never re-announces it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-owner-latch-"));
  await withEnv(CLEAN, async () => {
    const host = makeHost(cwd);
    const ctx = { cwd, sessionManager: (host.pi as { sessionManager: unknown }).sessionManager };
    try {
      await init(host.pi as never);
      await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager: ctx.sessionManager });
      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo latch-marker",
        name: "latch-task",
        mode: "background",
      }, undefined, undefined, ctx));
      assert.equal(task.status, "running");

      const [result] = (await host.fire("agent_before_settle", { entries: [] }, { mode: "tui", ui: { setStatus: () => undefined } })) as BeforeSettleResult[];
      await host.settle(result);
      host.endRun();
      assert.equal(host.mentions("latch-task").length, 1, "the hold announced it once");

      // A reload/restart runs `resendUnnotified()`; the absorbed task must not come back.
      host.idle();
      await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager: ctx.sessionManager });
      host.endRun();
      const status = (await host.tools.get("async_status")!.execute("status", { includeHistory: true }, undefined, undefined, ctx)) as unknown as { details?: { payload?: Array<{ taskId: string; notified: boolean }> } };
      const row = (status.details?.payload ?? []).find((item) => item.taskId === task.taskId);
      assert.equal(row?.notified, true, "the notification slot is latched even though no notification was sent");
      assert.equal(host.mentions("latch-task").length, 1, "no second announcement after the resend sweep");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a hold that times out still delivers the notification for the task that finished", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-owner-timeout-"));
  await withEnv({ ...CLEAN, PI_ASYNC_HOLD_MS: "300" }, async () => {
    const host = makeHost(cwd);
    const ctx = { cwd, sessionManager: (host.pi as { sessionManager: unknown }).sessionManager };
    try {
      await init(host.pi as never);
      await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager: ctx.sessionManager });
      const quick = payload(await host.tools.get("async_run")!.execute("quick", {
        command: "sleep 0.1; echo quick-marker",
        name: "quick-task",
        mode: "background",
      }, undefined, undefined, ctx));
      const slow = payload(await host.tools.get("async_run")!.execute("slow", {
        command: "sleep 30; echo slow-marker",
        name: "slow-task",
        mode: "background",
      }, undefined, undefined, ctx));
      assert.equal(quick.status, "running");
      assert.equal(slow.status, "running");

      // Budget runs out on the slow task: the hold releases without a results entry.
      const [result] = (await host.fire("agent_before_settle", { entries: [] }, { mode: "tui", ui: { setStatus: () => undefined } })) as BeforeSettleResult[];
      assert.equal(result, undefined, "a timeout settles exactly as before");
      await host.settle(result);
      host.endRun();

      const quickAnnouncements = host.mentions("quick-task");
      assert.equal(quickAnnouncements.length, 1, "the deferred completion is released, never swallowed");
      assert.equal(quickAnnouncements[0]?.customType, "async-task-notification");
      assert.equal(host.mentions("slow-task").length, 0, "the slow task is still running");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a legion child keeps its own channel: no hold, the completion notification still wakes it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-owner-legion-"));
  await withEnv({ ...CLEAN, PI_LEGION_NODE_ID: "legion-child" }, async () => {
    const host = makeHost(cwd);
    const ctx = { cwd, sessionManager: (host.pi as { sessionManager: unknown }).sessionManager };
    try {
      await init(host.pi as never);
      await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager: ctx.sessionManager });
      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo child-marker",
        name: "child-task",
        mode: "background",
      }, undefined, undefined, ctx));
      assert.equal(task.status, "running");

      const [result] = (await host.fire("agent_before_settle", { entries: [] }, { mode: "tui", ui: { setStatus: () => undefined } })) as BeforeSettleResult[];
      // CONTRACT §7: a legion child never holds — and the guard's reminder path is untouched here.
      assert.equal(result, undefined, "no hold in a legion child");
      await host.settle(result);
      await waitFor(() => host.queued() === 1);
      host.endRun();

      const announcements = host.mentions("child-task");
      assert.equal(announcements.length, 1, "the completion notification is the single owner");
      assert.equal(announcements[0]?.customType, "async-task-notification");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("Esc during a hold settles it at once — and the notification is still the single owner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-owner-esc-"));
  // A 60 s budget with a 1 s poll: only raw Esc can end this hold in time. `ctx.signal` is undefined
  // at this boundary on pi 1.5.2, so the raw terminal listener is the channel under test.
  await withEnv({ ...CLEAN, PI_ASYNC_HOLD_MS: "60000", PI_ASYNC_HOLD_POLL_MS: "1000" }, async () => {
    const host = makeHost(cwd);
    const sessionManager = (host.pi as { sessionManager: unknown }).sessionManager;
    const ctx = { cwd, sessionManager };
    const settleCtx = { mode: "tui", cwd, sessionManager, ui: host.ui };
    try {
      await init(host.pi as never);
      await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager });

      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 2; echo esc-marker",
        name: "esc-task",
        mode: "background",
      }, undefined, undefined, ctx));
      assert.equal(task.status, "running");

      const started = performance.now();
      const pending = host.fire("agent_before_settle", { entries: [] }, settleCtx);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(host.hasEscapeListener(), true, "the hold listens for a raw Esc");
      host.pressEscape();
      const [result] = (await pending) as BeforeSettleResult[];
      const elapsed = performance.now() - started;

      assert.equal(result, undefined, "an interrupted hold emits no results entry");
      assert.ok(elapsed < 2000, `Esc released the hold without waiting for the 1 s poll or the 60 s budget (${Math.round(elapsed)}ms)`);
      await host.settle(result);

      // The task finishes after the hold: its notification is the one announcement (the relay was
      // released, so nothing was swallowed and nothing was folded twice).
      await waitFor(() => host.queued() === 1, 6000);
      host.endRun();

      const announcements = host.mentions("esc-task");
      assert.equal(announcements.length, 1, `one terminal event, one announcement (got ${announcements.map((a) => a.customType).join(" → ")})`);
      assert.equal(announcements[0]?.customType, "async-task-notification");
      assert.ok(host.progressRows.some((row) => row !== undefined), "the hold showed a progress row while it waited");
      assert.equal(host.progressRows.at(-1), undefined, "and removed it when it ended");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * CONTRACT §7.2 (0.4.3): one terminal event, told once, to exactly one consumer.
 *
 * 0.4.2 queued the completion notification at `finalize()` even while the model was mid-run, and pi
 * delivered that followUp only after the model stopped. When the model had already collected the
 * result with `async_wait` (or read it with `async_status` / `async_logs`), the notification arrived
 * 85–138 s later and repeated it (session 2026-11-17T02-35-00-296Z_01a1e75b). The pending send is
 * now decided at the run's settle boundary, where the consumer latch is already visible.
 */

/** Read the persisted registry snapshot for a task (proves the latch really reached disk). */
function readSnapshot(cwd: string, taskId: string): Record<string, unknown> {
  const file = join(cwd, "pi-async", "i-settle-owner", `${taskId}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

type Host = ReturnType<typeof makeHost>;

/** A host wired through `init`, with one live run and a settle context. */
async function bootHost(cwd: string) {
  const host = makeHost(cwd);
  const sessionManager = (host.pi as { sessionManager: unknown }).sessionManager;
  const toolCtx = { cwd, sessionManager };
  const settleCtx = { mode: "tui", cwd, sessionManager, ui: host.ui };
  await init(host.pi as never);
  await host.fire("session_start", { type: "session_start" }, { mode: "tui", cwd, sessionManager });
  return { host, toolCtx, settleCtx };
}

test("a task already collected with async_wait is never announced again", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-consumed-wait-"));
  await withEnv(CLEAN, async () => {
    const { host, toolCtx, settleCtx }: { host: Host; toolCtx: Record<string, unknown>; settleCtx: Record<string, unknown> } = await bootHost(cwd);
    try {
      await host.fire("agent_start"); // a run is live: the notification must wait for the boundary
      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo consumed-marker",
        name: "consumed-task",
        mode: "background",
      }, undefined, undefined, toolCtx));
      await new Promise((resolve) => setTimeout(resolve, 250)); // finalize happens mid-run

      // The model collects the result *after* finalize — exactly the reported 6 s window.
      const waited = (await host.tools.get("async_wait")!.execute("wait", { taskIds: [task.taskId], timeoutMs: 5000 }, undefined, undefined, toolCtx)) as unknown as { details?: { payload?: unknown } };
      assert.ok(JSON.stringify(waited).includes('"completed"'), "wait handed the terminal state to the model");

      const [result] = (await host.fire("agent_before_settle", { entries: [] }, settleCtx)) as BeforeSettleResult[];
      await host.settle(result);
      host.endRun();

      assert.equal(host.mentions("consumed-task").length, 0, "the one announcement already happened through async_wait");
      assert.deepEqual(host.followUps, [], "nothing is left in the host's followUp queue to arrive late");
      assert.deepEqual(host.steerQueue, [], "and nothing was steered for a task the model already collected");
      const snapshot = readSnapshot(cwd, task.taskId);
      assert.equal(typeof snapshot.consumedAt, "number", "the consumer latch is persisted");
      assert.equal(snapshot.notified, false, "no notification slot was consumed");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a terminal row read through async_status or async_logs also counts as told", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-consumed-tools-"));
  await withEnv(CLEAN, async () => {
    const { host, toolCtx, settleCtx }: { host: Host; toolCtx: Record<string, unknown>; settleCtx: Record<string, unknown> } = await bootHost(cwd);
    try {
      await host.fire("agent_start");
      const viaStatus = payload(await host.tools.get("async_run")!.execute("a", { command: "sleep 0.1; echo status-marker", name: "status-taken", mode: "background" }, undefined, undefined, toolCtx));
      const viaLogs = payload(await host.tools.get("async_run")!.execute("b", { command: "sleep 0.1; echo logs-marker", name: "logs-taken", mode: "background" }, undefined, undefined, toolCtx));
      await new Promise((resolve) => setTimeout(resolve, 250));

      await host.tools.get("async_status")!.execute("status", { includeHistory: true }, undefined, undefined, toolCtx);
      await host.tools.get("async_logs")!.execute("logs", { taskId: viaLogs.taskId }, undefined, undefined, toolCtx);

      const [result] = (await host.fire("agent_before_settle", { entries: [] }, settleCtx)) as BeforeSettleResult[];
      await host.settle(result);
      host.endRun();

      assert.equal(host.mentions("status-taken").length, 0, "async_status showed the terminal row");
      assert.equal(host.mentions("logs-taken").length, 0, "async_logs showed the finished output");
      assert.equal(typeof readSnapshot(cwd, viaStatus.taskId).consumedAt, "number");
      assert.equal(typeof readSnapshot(cwd, viaLogs.taskId).consumedAt, "number");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("a task nobody collected is still announced once — at the settle boundary, not twice", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-uncollected-"));
  await withEnv(CLEAN, async () => {
    const { host, toolCtx, settleCtx }: { host: Host; toolCtx: Record<string, unknown>; settleCtx: Record<string, unknown> } = await bootHost(cwd);
    try {
      await host.fire("agent_start");
      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo unconsumed-marker",
        name: "unconsumed-task",
        mode: "background",
      }, undefined, undefined, toolCtx));
      await new Promise((resolve) => setTimeout(resolve, 250));

      const [first] = (await host.fire("agent_before_settle", { entries: [] }, settleCtx)) as BeforeSettleResult[];
      assert.equal(host.queued(), 1, "the boundary decides: exactly one notification is queued");
      assert.equal(host.steerQueue.length, 1, "the settle boundary is inside a live run, so the host gets a steer");
      await host.settle(first);

      // A second boundary in the same run must not announce it again.
      const [second] = (await host.fire("agent_before_settle", { entries: [] }, settleCtx)) as BeforeSettleResult[];
      await host.settle(second);
      host.endRun();

      const announcements = host.mentions("unconsumed-task");
      assert.equal(announcements.length, 1, `announced once (got ${announcements.map((a) => a.customType).join(" → ")})`);
      assert.equal(announcements[0]?.customType, "async-task-notification");
      assert.equal(readSnapshot(cwd, task.taskId).notified, true, "the notification slot is latched");
      assert.equal(readSnapshot(cwd, task.taskId).consumedAt, undefined, "no consumer claimed it");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * CONTRACT §7.2 修订 2 (0.4.4): the delivery channel is chosen by run state.
 *
 * pi drains `followUp` only when the model stops asking for tool calls
 * (`pi-agent-core/dist/agent-loop.js:197`) but drains `steer` at every turn boundary (`:191`), so a
 * completion decided mid-run must steer — `followUp` put the notification 178.6 s behind the task's
 * `finishedAt` in the reported session, because the parent kept calling tools the whole time.
 */

test("a completion decided mid-run steers at the next turn boundary instead of waiting for run end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-steer-boundary-"));
  await withEnv(CLEAN, async () => {
    const { host, toolCtx }: { host: Host; toolCtx: Record<string, unknown>; settleCtx: Record<string, unknown> } = await bootHost(cwd);
    try {
      await host.fire("agent_start");
      payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo steer-marker",
        name: "steer-task",
        mode: "background",
      }, undefined, undefined, toolCtx));
      await new Promise((resolve) => setTimeout(resolve, 250)); // finalize happens mid-run

      assert.equal(host.queued(), 0, "nothing is enqueued at finalize: the boundary decides");
      await host.turnEnd(); // the very next turn boundary of the same run
      const delivered = host.transcript.filter((entry) => entry.customType === "async-task-notification");
      assert.equal(delivered.length, 1, "the completion is visible one turn boundary later");
      assert.equal(delivered[0]?.deliveredIn, "turn-boundary", "steer, not followUp — no new turn is wasted");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("an idle session keeps followUp + triggerTurn, so the notification starts a wake-up run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-idle-followup-"));
  await withEnv(CLEAN, async () => {
    const { host, toolCtx }: { host: Host; toolCtx: Record<string, unknown>; settleCtx: Record<string, unknown> } = await bootHost(cwd);
    try {
      host.idle(); // no run is live
      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo idle-marker",
        name: "idle-task",
        mode: "background",
      }, undefined, undefined, toolCtx));
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(host.steerQueue.length, 0, "no steer while the session is idle (steering needs a live run)");
      assert.equal(host.followUps.length, 0, "a wake-up is written immediately, not queued as a streaming followUp");
      const delivered = host.transcript.filter((entry) => entry.customType === "async-task-notification");
      assert.equal(delivered.length, 1, "the idle send starts the wake-up run");
      const snapshot = readSnapshot(cwd, task.taskId);
      assert.equal(snapshot.notified, true);
      assert.equal(snapshot.notifyAttempts, 1);
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("one terminal event never produces two notifications across turn_end, settle and replay", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-notify-once-"));
  await withEnv(CLEAN, async () => {
    const { host, toolCtx, settleCtx }: { host: Host; toolCtx: Record<string, unknown>; settleCtx: Record<string, unknown> } = await bootHost(cwd);
    try {
      await host.fire("agent_start");
      const task = payload(await host.tools.get("async_run")!.execute("run", {
        command: "sleep 0.1; echo once-marker",
        name: "once-task",
        mode: "background",
      }, undefined, undefined, toolCtx));
      await new Promise((resolve) => setTimeout(resolve, 250));

      await host.turnEnd();                       // first boundary: the one legitimate send
      await host.turnEnd();                       // the run keeps working: nothing left to decide
      const [result] = (await host.fire("agent_before_settle", { entries: [] }, settleCtx)) as BeforeSettleResult[];
      await host.settle(result);
      await host.fire("session_start", { type: "session_start" }, settleCtx); // resendUnnotified replay
      host.endRun();

      const notifications = host.mentions("once-task");
      assert.equal(notifications.length, 1, `exactly one notification (got ${notifications.length})`);
      assert.equal(notifications[0]?.customType, "async-task-notification");
      const snapshot = readSnapshot(cwd, task.taskId);
      assert.equal(snapshot.notified, true, "the completion slot is closed");
      assert.equal(snapshot.notifyAttempts, 1, "the host was called once, not once per boundary");
    } finally {
      await host.fire("session_shutdown", { reason: "quit" });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
