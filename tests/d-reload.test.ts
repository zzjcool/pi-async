import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init } from "../extensions/index.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * 0.3.0 reload semantics (PLAN §2.8 + D-16):
 *   reload/resume → suspend (tasks keep running, next generation adopts them)
 *   quit/new/fork/undefined → shutdown (kill with killKind "shutdown")
 *   init() retires the previous generation by suspending it, never by killing it
 *   adopted tasks restore taskTimeoutMs (timeoutAt) and watch deadlines
 */

type ToolResult = { details?: { payload?: unknown }; isError?: boolean };
type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<ToolResult>;
};
type Hook = (...args: unknown[]) => unknown;

type MessageRenderer = (message: unknown) => { render: (width: number) => string[]; invalidate: () => void };

type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };

type Generation = {
  pi: Record<string, unknown>;
  tools: Map<string, Tool>;
  hooks: Map<string, Hook[]>;
  renderers: Map<string, MessageRenderer>;
  messages: SentMessage[];
  ctx: Record<string, unknown>;
  call: <T = Record<string, unknown>>(name: string, params: Record<string, unknown>) => Promise<T>;
  dispatch: (event: string, eventPayload?: unknown) => Promise<void>;
};

function makeGeneration(sessionDir: string, sessionId: string): Generation {
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook[]>();
  const renderers = new Map<string, MessageRenderer>();
  const messages: SentMessage[] = [];
  const sessionManager = { getSessionDir: () => sessionDir, getSessionId: () => sessionId };
  // CONTRACT §15: the factory-time API carries no session cwd/pid — only event ctxs do.
  const pi: Record<string, unknown> = {
    sessionManager,
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
    registerMessageRenderer: (customType: string, renderer: MessageRenderer) => { renderers.set(customType, renderer); },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => { messages.push({ message, options }); },
    on: (event: string, handler: Hook) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
      return () => { const current = hooks.get(event); if (current) current.splice(current.indexOf(handler), 1); };
    },
  };
  // Non-TUI ctx: reload behaviour must not depend on TUI registration.
  const ctx = { mode: "rpc", hasUI: false, cwd: sessionDir, sessionManager };
  return {
    pi,
    tools,
    hooks,
    renderers,
    messages,
    ctx,
    call: async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} must be registered`);
      const result = await tool.execute("reload-call", params, undefined, undefined, ctx);
      if (result.isError) throw new Error(`tool ${name} returned isError: ${JSON.stringify(result.details?.payload)}`);
      return result.details?.payload as T;
    },
    dispatch: async (event: string, eventPayload?: unknown) => {
      // Snapshot: a handler may unsubscribe itself (SettleGuard.dispose on session_shutdown).
      for (const handler of [...(hooks.get(event) ?? [])]) await handler(eventPayload, ctx);
    },
  };
}

const dataDirFor = (sessionDir: string, sessionId: string): string => join(sessionDir, "pi-async", sessionId);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hardKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readSnapshot(dataDir: string, taskId: string): TaskSnapshot | undefined {
  const file = join(dataDir, `${taskId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TaskSnapshot;
  } catch {
    return undefined;
  }
}

async function waitForSnapshot(dataDir: string, taskId: string, predicate: (snapshot: TaskSnapshot) => boolean, label: string, timeoutMs = 6000): Promise<TaskSnapshot> {
  let found: TaskSnapshot | undefined;
  await waitFor(() => {
    found = readSnapshot(dataDir, taskId);
    return found !== undefined && predicate(found);
  }, label, timeoutMs);
  return found!;
}

let sequence = 0;
function freshSession(prefix: string): { sessionDir: string; sessionId: string; dataDir: string } {
  const sessionDir = mkdtempSync(join(tmpdir(), prefix));
  const sessionId = `session-${process.pid}-${++sequence}`;
  return { sessionDir, sessionId, dataDir: dataDirFor(sessionDir, sessionId) };
}

test("session_shutdown({reason:'reload'}) suspends the registry instead of killing running tasks", async () => {
  const session = freshSession("pi-async-d-reload-suspend-");
  const pids: number[] = [];
  try {
    const gen = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen.pi as never);
    await gen.dispatch("session_start", { type: "session_start", reason: "startup" });
    const started = await gen.call<{ taskId: string; status: string }>("async_run", { command: "sleep 30", name: "reload-survivor", mode: "background", notifyOnCompletion: false });
    const snapshot = await waitForSnapshot(session.dataDir, started.taskId, (task) => task.status === "running" && task.pid !== undefined, "running snapshot in the session data dir");
    pids.push(snapshot.pid!);

    // D-16: data dir is <sessionDir>/pi-async/<sessionId>, never the real homedir.
    assert.ok(existsSync(join(session.dataDir, `${started.taskId}.json`)), "snapshot lives under the session data dir");

    await gen.dispatch("session_shutdown", { type: "session_shutdown", reason: "reload" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pidAlive(snapshot.pid!), true, "reload must leave running tasks alive for the next generation");
    assert.equal(readSnapshot(session.dataDir, started.taskId)?.status, "running", "suspend keeps the persisted status running");
  } finally {
    pids.forEach(hardKill);
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
});

test("session_shutdown({reason:'resume'}) also suspends instead of killing", async () => {
  const session = freshSession("pi-async-d-reload-resume-");
  const pids: number[] = [];
  try {
    const gen = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen.pi as never);
    await gen.dispatch("session_start", { type: "session_start", reason: "startup" });
    const started = await gen.call<{ taskId: string }>("async_run", { command: "sleep 30", name: "resume-survivor", mode: "background", notifyOnCompletion: false });
    const snapshot = await waitForSnapshot(session.dataDir, started.taskId, (task) => task.status === "running" && task.pid !== undefined, "running snapshot");
    pids.push(snapshot.pid!);

    await gen.dispatch("session_shutdown", { type: "session_shutdown", reason: "resume" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pidAlive(snapshot.pid!), true, "resume keeps tasks alive for the resumed session");
    assert.equal(readSnapshot(session.dataDir, started.taskId)?.status, "running");
  } finally {
    pids.forEach(hardKill);
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
});

for (const reason of ["quit", "new", "fork", undefined] as const) {
  test(`session_shutdown(${reason === undefined ? "no event" : `{reason:'${reason}'}`}) shuts down and kills tasks with killKind 'shutdown'`, async () => {
    const session = freshSession(`pi-async-d-reload-${reason ?? "none"}-`);
    const pids: number[] = [];
    try {
      const gen = makeGeneration(session.sessionDir, session.sessionId);
      await init(gen.pi as never);
      await gen.dispatch("session_start", { type: "session_start", reason: "startup" });
      const started = await gen.call<{ taskId: string }>("async_run", { command: "sleep 30", name: "shutdown-victim", mode: "background", notifyOnCompletion: false });
      const snapshot = await waitForSnapshot(session.dataDir, started.taskId, (task) => task.status === "running" && task.pid !== undefined, "running snapshot");
      pids.push(snapshot.pid!);

      await gen.dispatch("session_shutdown", reason === undefined ? undefined : { type: "session_shutdown", reason });
      await waitFor(() => !pidAlive(snapshot.pid!), "the process to be killed");
      const final = await waitForSnapshot(session.dataDir, started.taskId, (task) => task.status !== "running" && task.status !== "pending", "terminal snapshot");
      assert.equal(final.status, "killed");
      assert.equal(final.killKind, "shutdown");
    } finally {
      pids.forEach(hardKill);
      rmSync(session.sessionDir, { recursive: true, force: true });
    }
  });
}

test("a new generation adopts suspended tasks and restores taskTimeoutMs + watchDeadline", async () => {
  const session = freshSession("pi-async-d-reload-adopt-");
  const pids: number[] = [];
  try {
    const gen1 = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen1.pi as never);
    await gen1.dispatch("session_start", { type: "session_start", reason: "startup" });

    const timed = await gen1.call<{ taskId: string }>("async_run", {
      command: "sleep 30", name: "reload-timeout", mode: "background", taskTimeoutMs: 1500, notifyOnCompletion: false,
    });
    const watched = await gen1.call<{ taskId: string }>("async_run", {
      command: "sleep 30", name: "reload-watch", mode: "background", notifyOnCompletion: false,
      watch: { intervalMs: 1000, timeoutMs: 1500, success_when: [{ type: "stdout_contains", value: "NEVER_MATCH_MARKER" }], failure_when: [] },
    });
    const timedSnapshot = await waitForSnapshot(session.dataDir, timed.taskId, (task) => task.status === "running" && task.pid !== undefined, "timed task running");
    const watchedSnapshot = await waitForSnapshot(session.dataDir, watched.taskId, (task) => task.status === "running" && task.pid !== undefined, "watched task running");
    pids.push(timedSnapshot.pid!, watchedSnapshot.pid!);
    assert.ok(timedSnapshot.timeoutAt, "snapshot persisting timeoutAt (D-03)");
    assert.ok(watchedSnapshot.watchDeadline, "snapshot persisting watchDeadline (D-03)");

    // /reload: suspend, then a fresh generation configures the same session dir and adopts.
    await gen1.dispatch("session_shutdown", { type: "session_shutdown", reason: "reload" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(pidAlive(timedSnapshot.pid!), true);

    const gen2 = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen2.pi as never);
    await gen2.dispatch("session_start", { type: "session_start", reason: "reload" });
    const adopted = await gen2.call<TaskSnapshot[]>("async_status", { includeHistory: true });
    const adoptedTimed = adopted.find((task) => task.taskId === timed.taskId);
    const adoptedWatched = adopted.find((task) => task.taskId === watched.taskId);
    assert.ok(adoptedTimed, "the next generation must adopt the timed task from disk");
    assert.ok(adoptedWatched, "the next generation must adopt the watched task from disk");
    assert.equal(adoptedTimed.status, "running");

    // The restored deadlines must fire: the tasks end killed/timeout instead of running forever.
    // Observed through the adopting generation: the (suspended) previous generation can still
    // write a late child-exit snapshot to the same file, which is not this lane's contract.
    const deadline = Date.now() + 10_000;
    let timedFinal: TaskSnapshot | undefined;
    let watchedFinal: TaskSnapshot | undefined;
    while (Date.now() < deadline) {
      const listed = await gen2.call<TaskSnapshot[]>("async_status", { includeHistory: true });
      timedFinal = listed.find((task) => task.taskId === timed.taskId);
      watchedFinal = listed.find((task) => task.taskId === watched.taskId);
      const done = (task?: TaskSnapshot) => task !== undefined && task.status !== "running" && task.status !== "pending";
      if (done(timedFinal) && done(watchedFinal)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(timedFinal?.status, "killed", `adopted taskTimeoutMs must kill the task, got ${timedFinal?.status}`);
    assert.equal(timedFinal?.killKind, "timeout");
    assert.ok(["killed", "failed"].includes(watchedFinal?.status ?? ""), `watched task must end terminal, got ${watchedFinal?.status}`);
    assert.ok(watchedFinal?.killKind === "watch_failure" || watchedFinal?.failureKind === "watch_timeout", "watch deadline surfaces as watch_failure/watch_timeout");

    // The retired generation must not write a late "failed" snapshot after the adopted task settles
    // (regression: a suspended registry's child-exit handler used to clobber the persisted status).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const timedPersisted = readSnapshot(session.dataDir, timed.taskId);
    assert.equal(timedPersisted?.status, "killed", "persisted status must stay killed after the adopted task settles");
    assert.equal(timedPersisted?.killKind, "timeout");

    await gen2.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    pids.forEach(hardKill);
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
});

test("a second init() retires the previous generation without killing its tasks", async () => {
  const session = freshSession("pi-async-d-reload-reinit-");
  const pids: number[] = [];
  try {
    const gen1 = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen1.pi as never);
    await gen1.dispatch("session_start", { type: "session_start", reason: "startup" });
    const started = await gen1.call<{ taskId: string }>("async_run", { command: "sleep 30", name: "reinit-survivor", mode: "background", notifyOnCompletion: false });
    const snapshot = await waitForSnapshot(session.dataDir, started.taskId, (task) => task.status === "running" && task.pid !== undefined, "running snapshot");
    pids.push(snapshot.pid!);

    await init(makeGeneration(session.sessionDir, session.sessionId).pi as never);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(pidAlive(snapshot.pid!), true, "the first re-init must suspend, not kill");

    await init(makeGeneration(session.sessionDir, session.sessionId).pi as never);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(pidAlive(snapshot.pid!), true, "a second re-init must not kill the original task either");
    assert.equal(readSnapshot(session.dataDir, started.taskId)?.status, "running");
  } finally {
    pids.forEach(hardKill);
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
});

test("registerMessageRenderer renders a one-line completion card and falls back to the content", async () => {
  const session = freshSession("pi-async-d-renderer-");
  const pids: number[] = [];
  try {
    const gen = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen.pi as never);
    await gen.dispatch("session_start", { type: "session_start", reason: "startup" });
    const renderer = gen.renderers.get("async-task-notification");
    assert.ok(renderer, "the extension registers the async-task-notification renderer");

    const completed = await gen.call<{ taskId: string }>("async_run", { command: "true", name: "card-ok", mode: "background", notifyOnCompletion: false });
    await gen.call("async_wait", { taskIds: [completed.taskId], timeoutMs: 5000 });
    const okCard = renderer({ details: { taskId: completed.taskId, name: "card-ok", status: "completed", exitCode: 0 } }).render(80)[0];
    assert.match(okCard ?? "", /^✓ card-ok \(completed, \d+\.\d+s\) · exit 0$/, `completed card: ${okCard}`);

    const failed = await gen.call<{ taskId: string }>("async_run", { command: "exit 7", name: "card-bad", mode: "background", notifyOnCompletion: false });
    await gen.call("async_wait", { taskIds: [failed.taskId], timeoutMs: 5000 });
    const badCard = renderer({ details: { taskId: failed.taskId, name: "card-bad", status: "failed", exitCode: 7 } }).render(80)[0];
    assert.match(badCard ?? "", /^✗ card-bad \(failed, \d+\.\d+s\) · exit 7$/, `failed card: ${badCard}`);

    const timed = await gen.call<{ taskId: string }>("async_run", { command: "sleep 30", name: "card-timed", mode: "background", taskTimeoutMs: 80, notifyOnCompletion: false });
    const timedRow = await gen.call<{ results?: Array<{ taskId: string; pid?: number }> }>("async_wait", { taskIds: [timed.taskId], timeoutMs: 5000 });
    const timedSnapshot = await gen.call<TaskSnapshot[]>("async_status", { includeHistory: true });
    const timedTask = timedSnapshot.find((task) => task.taskId === timed.taskId);
    if (timedTask?.pid) pids.push(timedTask.pid);
    assert.ok(timedRow.results?.length, "the timed task must settle");
    const killedCard = renderer({ details: { taskId: timed.taskId, name: "card-timed", status: timedTask?.status ?? "killed", killKind: "timeout" } }).render(80)[0];
    assert.match(killedCard ?? "", /^✗ card-timed \(killed, \d+\.\d+s\) · kill timeout$/, `killed card: ${killedCard}`);

    const fallbackCard = renderer({ content: "first line of the notification\nsecond line" }).render(80)[0];
    assert.equal(fallbackCard, "first line of the notification", "no details → fall back to the content's first line");

    await gen.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    pids.forEach(hardKill);
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
});

test("session_start resends an unnotified terminal task exactly once (D-02 wiring)", async () => {
  const session = freshSession("pi-async-d-resend-");
  const taskId = "resend-task-1";
  const outputFile = join(session.dataDir, `${taskId}.output`);
  try {
    // Pre-seed disk state as a previous generation would leave it: terminal, never notified,
    // one failed attempt already recorded (so the registry's max-attempts gate stays open).
    mkdirSync(session.dataDir, { recursive: true });
    writeFileSync(outputFile, "resend output tail\n");
    const seeded: TaskSnapshot = {
      taskId,
      name: "resend-me",
      command: "echo resend-me",
      mode: "background",
      status: "failed",
      exitCode: 1,
      failureKind: "lost",
      createdAt: Date.now() - 2_000,
      finishedAt: Date.now() - 1_000,
      notified: false,
      outputConsumed: false,
      notifyAttempts: 1,
      metadata: {
        outputFile,
        notifyOnCompletion: true,
        triggerOnCompletion: false,
        startError: "spawn ENOENT: /bin/sh",
      },
    };
    writeFileSync(join(session.dataDir, `${taskId}.json`), JSON.stringify(seeded));

    const gen = makeGeneration(session.sessionDir, session.sessionId);
    await init(gen.pi as never);
    await gen.dispatch("session_start", { type: "session_start", reason: "reload" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(gen.messages.length, 1, "session_start must resend exactly one notification");
    const sent = gen.messages[0]!;
    assert.equal(sent.message.customType, "async-task-notification");
    assert.equal(sent.options.deliverAs, "followUp");
    assert.equal("triggerTurn" in sent.options, false, "triggerOnCompletion:false keeps the notification passive");
    const content = String(sent.message.content);
    assert.match(content, /<task-id>resend-task-1<\/task-id>/);
    // failureKind "lost" must not read as a plain failure; startError must be visible.
    assert.match(content, /Exit status unknown after session reload; output may be incomplete\./);
    assert.match(content, /Start error: spawn ENOENT: \/bin\/sh/);

    const onDisk = readSnapshot(session.dataDir, taskId);
    assert.equal(onDisk?.notified, true, "a successful resend latches notified on disk");
    assert.equal(onDisk?.notifyAttempts, 2, "the resend records one more attempt");

    // Idempotent: repeated session_start events must not configure/resend again.
    await gen.dispatch("session_start", { type: "session_start", reason: "reload" });
    await gen.dispatch("message_start", { type: "message_start" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(gen.messages.length, 1, "a second lifecycle event must not resend");
    assert.equal(readSnapshot(session.dataDir, taskId)?.notifyAttempts, 2);

    await gen.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
});
