import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init } from "../extensions/index.ts";

type Tool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
};
type Hook = (...args: unknown[]) => unknown;
type Receipt = { taskId: string; status: string; outputTail?: string; exitCode?: number; mode?: string };

/** Unwrap the toolResult envelope (contract: content text + details.payload). */
function payload(result: unknown): Receipt {
  const wrapped = result as { details?: { payload?: Receipt } };
  return (wrapped.details?.payload ?? result) as Receipt;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for completion notification");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Step I wiring integrates real tasks, notifications, watch, sync, and shutdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-i-e2e-"));
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook>();
  const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const pi = {
    cwd,
    pid: process.pid,
    mode: "rpc",
    sessionManager: { getSessionId: () => "i-e2e-session" },
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (event: string, handler: Hook) => { hooks.set(event, handler); return () => hooks.delete(event); },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => { messages.push({ message, options }); },
  };

  try {
    await init(pi as never);
    assert.deepEqual([...tools.keys()].sort(), ["async_kill", "async_logs", "async_run", "async_status", "async_wait"]);

    const run = tools.get("async_run")!.execute;
    const wait = tools.get("async_wait")!.execute;

    // Background: real shell child, event-driven wait, and captured stdout/exit status.
    const background = payload(await run("e2e-background", { command: "echo hi", mode: "background" }));
    assert.equal(background.status, "running");
    const backgroundResult = payload(await wait("e2e-wait-background", { taskIds: [background.taskId], timeoutMs: 5000 })) as unknown as { results: Receipt[] };
    assert.equal(backgroundResult.results[0]?.status, "completed");
    assert.equal(backgroundResult.results[0]?.exitCode, 0);
    assert.match(backgroundResult.results[0]?.outputTail ?? "", /hi/);

    // onFinalize must invoke the actual notification chain wired by the extension.
    const notified = payload(await run("e2e-notification", {
      command: "echo notify-marker",
      name: "notify <&> task",
      mode: "background",
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    }));
    await waitFor(() => messages.some(({ message }) => message.customType === "async-task-notification" && String(message.content).includes("notify &lt;&amp;&gt; task")));
    const notification = messages.find(({ message }) => message.customType === "async-task-notification" && String(message.content).includes("notify &lt;&amp;&gt; task"))!;
    assert.equal(notification.options.deliverAs, "followUp");
    assert.equal(notification.options.triggerTurn, true);
    assert.match(String(notification.message.content), /<async-task-notification>/);
    assert.match(String(notification.message.content), /notify &lt;&amp;&gt; task/);
    assert.match(String(notification.message.content), /<status>completed<\/status>/);
    await wait("e2e-wait-notification", { taskIds: [notified.taskId], timeoutMs: 5000 });

    const noTrigger = payload(await run("e2e-no-trigger", {
      command: "echo no-trigger-marker",
      mode: "background",
      triggerOnCompletion: false,
    }));
    await waitFor(() => messages.some(({ message }) => message.customType === "async-task-notification" && String(message.content).includes("no-trigger-marker")));
    const noTriggerMessage = messages.find(({ message }) => message.customType === "async-task-notification" && String(message.content).includes("no-trigger-marker"))!;
    assert.equal(noTriggerMessage.options.deliverAs, "followUp");
    assert.equal("triggerTurn" in noTriggerMessage.options, false);
    await wait("e2e-wait-no-trigger", { taskIds: [noTrigger.taskId], timeoutMs: 5000 });

    const failed = payload(await run("e2e-failed-notification", { command: "echo failure-marker; exit 1", mode: "background" }));
    await waitFor(() => messages.some(({ message }) => message.customType === "async-task-notification" && String(message.content).includes("failure-marker")));
    const failedMessage = messages.find(({ message }) => message.customType === "async-task-notification" && String(message.content).includes("failure-marker"))!;
    assert.match(String(failedMessage.message.content), /<guidance>Inspect task output with async_logs/);
    await wait("e2e-wait-failed", { taskIds: [failed.taskId], timeoutMs: 5000 });

    // Delayed admission plus a real stdout_contains watch condition.
    const pending = await run("e2e-delayed-watch", {
      command: "printf watch-marker; sleep 0.15",
      mode: "delayed",
      delayMs: 50,
      watch: {
        intervalMs: 1000,
        timeoutMs: 5000,
        success_when: [{ type: "stdout_contains", value: "watch-marker" }],
        failure_when: [],
      },
      notifyOnCompletion: false,
    });
    const delayed = payload(pending);
    assert.equal(delayed.status, "pending");
    const delayedResult = payload(await wait("e2e-wait-delayed", { taskIds: [delayed.taskId], timeoutMs: 5000 })) as unknown as { results: Receipt[] };
    assert.equal(delayedResult.results[0]?.status, "completed");
    const delayedSnapshot = payload(await tools.get("async_status")!.execute("e2e-status", { includeHistory: true })) as unknown as Array<{ taskId: string; metadata: Record<string, unknown> }>;
    const delayedTask = delayedSnapshot.find((task) => task.taskId === delayed.taskId);
    assert.equal(typeof delayedTask?.metadata.watchSuccess, "string");
    assert.match(String(delayedTask?.metadata.watchSuccess), /watch-marker/);

    // Sync mode returns exit code and captured output directly.
    const synchronous = payload(await run("e2e-sync", { command: "printf sync-marker", mode: "sync", timeoutMs: 5000 }));
    assert.equal(synchronous.status, "completed");
    assert.equal(synchronous.exitCode, 0);
    assert.match(synchronous.outputTail ?? "", /sync-marker/);

    // session_shutdown is repeatable and kills every active process with shutdown semantics.
    const active = payload(await run("e2e-shutdown", { command: "sleep 30", mode: "background", notifyOnCompletion: false }));
    const activeStatus = payload(await tools.get("async_status")!.execute("e2e-pre-shutdown", { includeHistory: true })) as unknown as Array<{ taskId: string; pid?: number }>;
    const activePid = activeStatus.find((task) => task.taskId === active.taskId)?.pid;
    assert.ok(activePid);
    const shutdown = hooks.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
    await shutdown();
    const afterShutdown = payload(await tools.get("async_status")!.execute("e2e-post-shutdown", { includeHistory: true })) as unknown as Array<{ taskId: string; status: string; killKind?: string }>;
    const killed = afterShutdown.find((task) => task.taskId === active.taskId);
    assert.equal(killed?.status, "killed");
    assert.equal(killed?.killKind, "shutdown");
    assert.throws(() => process.kill(-activePid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally {
    const shutdown = hooks.get("session_shutdown");
    if (shutdown) await shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("TUI init registers status, rail widget, and panel commands", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-i-tui-"));
  const hooks = new Map<string, Hook>();
  const commands: string[] = [];
  const widgets: string[] = [];
  const statuses: string[] = [];
  const pi = {
    cwd,
    pid: process.pid,
    mode: "tui",
    sessionManager: { getSessionId: () => "i-tui-session" },
    registerTool: () => undefined,
    registerCommand: (name: string) => { commands.push(name); },
    on: (event: string, handler: Hook) => { hooks.set(event, handler); return () => hooks.delete(event); },
    ui: {
      setStatus: (key: string) => { statuses.push(key); },
      setWidget: (key: string) => { widgets.push(key); },
    },
  };
  try {
    await init(pi as never);
    // Factory API has no mode; TUI binds from the first event context.
    hooks.get("session_start")?.({ type: "session_start" }, { mode: "tui", hasUI: true, ui: pi.ui });
    assert.ok(!statuses.includes("pi-async"));
    assert.ok(widgets.includes("pi-async-rail"));
    assert.deepEqual(commands, ["async", "async-clear"]);
  } finally {
    const shutdown = hooks.get("session_shutdown");
    if (shutdown) await shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});
