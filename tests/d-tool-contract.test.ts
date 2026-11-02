import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerTools, type ToolContext } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { TaskSnapshot } from "../src/core/task.ts";

/**
 * 0.3.0 tool contract (PLAN §2.7 / D-08 / D-17 / D-18):
 * tools must not lie about failures — unknown ids are errors, names resolve,
 * sync failures are isError, status/logs support filtering and stream splits,
 * and reads never mutate the registry's live snapshots.
 */

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { payload?: unknown }; isError: boolean };
type Tool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: ToolContext) => Promise<ToolResult>;
};

function makeHost() {
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: Tool) => { tools.set(tool.name, tool); } };
  return { pi, tools };
}

function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-tool-"));
  const registry = new TaskRegistry({ dataDir: dir });
  const host = makeHost();
  registerTools(host.pi as never, registry);
  return {
    dir,
    registry,
    tools: host.tools,
    cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function tool(tools: Map<string, Tool>, name: string): Tool {
  const found = tools.get(name);
  assert.ok(found, `tool ${name} must be registered`);
  return found;
}

function call(target: Tool, params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  return target.execute("call-1", params, undefined, undefined, ctx);
}

/** Assert a tool failure in either shape the host accepts: a thrown error or `isError: true` with a payload. */
async function expectToolError(promise: Promise<ToolResult>, pattern: RegExp): Promise<string> {
  try {
    const result = await promise;
    assert.equal(result.isError, true, "tool failure must set isError");
    const text = JSON.stringify(result.details?.payload ?? result);
    assert.match(text, pattern);
    return text;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert.match(text, pattern);
    return text;
  }
}

const payload = <T>(result: ToolResult): T => result.details.payload as T;

test("async_run exposes promptSnippet/promptGuidelines on async_run only (D-17)", async () => {
  const { tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    assert.equal(run.promptSnippet, "Run a shell command in the background, with optional watch conditions and completion notification.");
    assert.ok(Array.isArray(run.promptGuidelines));
    assert.ok((run.promptGuidelines ?? []).length >= 2 && (run.promptGuidelines ?? []).length <= 3, "D-17 asks for 2–3 guidelines");
    for (const other of ["async_wait", "async_logs", "async_status", "async_kill"]) {
      assert.equal(tool(tools, other).promptSnippet, undefined, `${other} must not carry a promptSnippet`);
    }
  } finally { await cleanup(); }
});

test("async_run schema caps sync timeout at PI_ASYNC_MAX_SYNC_TIMEOUT_MS and rejects at runtime", async () => {
  const previous = process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS;
  process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS = "1500";
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-sync-max-"));
  const registry = new TaskRegistry({ dataDir: dir });
  const host = makeHost();
  try {
    registerTools(host.pi as never, registry);
    const run = tool(host.tools, "async_run");
    const timeoutSchema = (run.parameters?.properties?.timeoutMs ?? {}) as { maximum?: number };
    assert.equal(timeoutSchema.maximum, 1500, "schema maximum follows PI_ASYNC_MAX_SYNC_TIMEOUT_MS");
    await expectToolError(call(run, { command: "true", mode: "sync", timeoutMs: 2000 }), /at most 1500 ms/);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS;
    else process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS = previous;
  }
});

test("async_run defaults the schema maximum to 600000 ms (10 minutes)", async () => {
  const previous = process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS;
  delete process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS;
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-sync-default-"));
  const registry = new TaskRegistry({ dataDir: dir });
  const host = makeHost();
  try {
    registerTools(host.pi as never, registry);
    const timeoutSchema = (tool(host.tools, "async_run").parameters?.properties?.timeoutMs ?? {}) as { maximum?: number };
    assert.equal(timeoutSchema.maximum, 600_000);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS;
    else process.env.PI_ASYNC_MAX_SYNC_TIMEOUT_MS = previous;
  }
});

test("async_run rejects onTimeout outside sync mode; sync isError follows D-19 (non-zero exit only)", async () => {
  const { registry, tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    await expectToolError(call(run, { command: "true", mode: "background", onTimeout: "promote" }), /onTimeout is only valid for sync mode/);
    await expectToolError(call(run, { command: "true", mode: "delayed", delayMs: 1000, onTimeout: "abort" }), /onTimeout is only valid for sync mode/);

    // D-19: a promote timeout leaves the task running — that is not a non-zero exit, so not an error.
    const promoted = await call(run, { command: "sleep 2", mode: "sync", timeoutMs: 100 });
    assert.equal(promoted.isError, false, "promote timeout must not be a tool error (D-19 / PLAN §2.7)");
    const promotedPayload = payload<{ taskId: string; status: string; promoted: boolean }>(promoted);
    assert.equal(promotedPayload.status, "running");
    assert.equal(promotedPayload.promoted, true);
    await registry.kill(promotedPayload.taskId, "user");

    // D-19: abort stops waiting only; the task still runs and the result is not an error either.
    const aborted = await call(run, { command: "sleep 2", mode: "sync", timeoutMs: 100, onTimeout: "abort" });
    assert.equal(aborted.isError, false, "abort timeout must not be a tool error (D-19 / PLAN §2.7)");
    const abortedPayload = payload<{ taskId: string; status: string; promoted: boolean }>(aborted);
    assert.equal(abortedPayload.status, "running");
    assert.equal(abortedPayload.promoted, false);
    await registry.kill(abortedPayload.taskId, "user");

    const failed = await call(run, { command: "echo boom-marker; exit 7", mode: "sync", timeoutMs: 5000 });
    assert.equal(failed.isError, true, "non-zero sync exit must be a tool error");
    const failedPayload = payload<{ status: string; exitCode?: number; outputTail: string }>(failed);
    assert.notEqual(failedPayload.status, "completed");
    assert.equal(failedPayload.exitCode, 7, "payload keeps the full SyncResult");
    assert.match(failedPayload.outputTail, /boom-marker/);

    const ok = await call(run, { command: "echo fine", mode: "sync", timeoutMs: 5000 });
    assert.equal(ok.isError, false, "clean sync exit is not an error");
    assert.equal(payload<{ status: string; exitCode?: number }>(ok).status, "completed");
  } finally { await cleanup(); }
});

test("async_run executes in ctx.cwd instead of the host process cwd", async () => {
  const { tools, cleanup } = makeRegistry();
  const cwd = mkdtempSync(join(tmpdir(), "pi-async-d-cwd-"));
  try {
    const run = tool(tools, "async_run");
    const wait = tool(tools, "async_wait");
    const logs = tool(tools, "async_logs");
    const started = payload<{ taskId: string }>(await call(run, { command: "pwd", mode: "background" }, { cwd }));
    await call(wait, { taskIds: [started.taskId], timeoutMs: 5000 });
    const text = payload<{ text: string }>(await call(logs, { taskId: started.taskId })).text.trim();
    assert.equal(realpathSync(text), realpathSync(cwd), "pwd must run in ctx.cwd");
    assert.notEqual(realpathSync(text), realpathSync(process.cwd()), "the host process cwd must not be used");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await cleanup();
  }
});

test("taskId resolves by name for async_wait/async_logs/async_kill", async () => {
  const { tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    const started = payload<{ taskId: string }>(await call(run, { command: "sleep 0.2; echo named-marker", name: "named-task", mode: "background" }));
    const waited = payload<{ results?: Array<{ taskId: string; status: string }> }>(await call(tool(tools, "async_wait"), { taskIds: ["named-task"], timeoutMs: 5000 }));
    assert.equal(waited.results?.[0]?.taskId, started.taskId);
    assert.equal(waited.results?.[0]?.status, "completed");
    const logs = payload<{ text: string }>(await call(tool(tools, "async_logs"), { taskId: "named-task" }));
    assert.match(logs.text, /named-marker/);

    const longRunning = payload<{ taskId: string }>(await call(run, { command: "sleep 30", name: "kill-by-name", mode: "background", notifyOnCompletion: false }));
    const killed = payload<{ taskId: string; status?: string; killKind?: string; processAlive?: boolean }>(await call(tool(tools, "async_kill"), { taskId: "kill-by-name" }));
    assert.equal(killed.taskId, longRunning.taskId, "kill by name targets the resolved task");
    assert.equal(killed.status, "killed");
    assert.equal(killed.killKind, "user");
    assert.equal(killed.processAlive, false, "async_kill exposes processAlive (D-07)");
  } finally { await cleanup(); }
});

test("async_kill on an unknown id/name is a tool error", async () => {
  const { tools, cleanup } = makeRegistry();
  try {
    const kill = tool(tools, "async_kill");
    await expectToolError(call(kill, { taskId: "does-not-exist" }), /Unknown task or name/);
  } finally { await cleanup(); }
});

test("async_wait on a duplicated name reports both candidate taskIds", async () => {
  const { registry, tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    const first = payload<{ taskId: string }>(await call(run, { command: "sleep 30", name: "dup-name", mode: "background", notifyOnCompletion: false }));
    const second = payload<{ taskId: string }>(await call(run, { command: "sleep 30", name: "dup-name", mode: "background", notifyOnCompletion: false }));
    assert.notEqual(first.taskId, second.taskId);
    const text = await expectToolError(call(tool(tools, "async_wait"), { taskIds: ["dup-name"], timeoutMs: 1000 }), /dup-name/);
    assert.ok(text.includes(first.taskId), `ambiguity error must list ${first.taskId}: ${text}`);
    assert.ok(text.includes(second.taskId), `ambiguity error must list ${second.taskId}: ${text}`);
    assert.ok(registry.get(first.taskId) && registry.get(second.taskId));
  } finally { await cleanup(); }
});

test("async_status filters by default-active/status/name and clamps limit (D-08)", async () => {
  const { registry, tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    const wait = tool(tools, "async_wait");
    const status = tool(tools, "async_status");

    const completed = payload<{ taskId: string }>(await call(run, { command: "true", name: "Alpha Done", mode: "background" }));
    await call(wait, { taskIds: [completed.taskId], timeoutMs: 5000 });
    const failed = payload<{ taskId: string }>(await call(run, { command: "exit 3", name: "Beta Fail", mode: "background" }));
    await call(wait, { taskIds: [failed.taskId], timeoutMs: 5000 });
    const running = payload<{ taskId: string }>(await call(run, { command: "sleep 30", name: "Gamma Live", mode: "background", notifyOnCompletion: false }));
    const pending = payload<{ taskId: string }>(await call(run, { command: "sleep 1", name: "Delta Pending", mode: "delayed", delayMs: 60_000, notifyOnCompletion: false }));

    const activeOnly = payload<TaskSnapshot[]>(await call(status, {}));
    assert.deepEqual(new Set(activeOnly.map((t) => t.taskId)), new Set([running.taskId, pending.taskId]), "default view is active (running+pending) only");

    const onlyCompleted = payload<TaskSnapshot[]>(await call(status, { status: "completed" }));
    assert.deepEqual(onlyCompleted.map((t) => t.taskId), [completed.taskId]);
    assert.ok(onlyCompleted.every((t) => t.status === "completed"));

    const activeExplicit = payload<TaskSnapshot[]>(await call(status, { status: "active" }));
    assert.deepEqual(new Set(activeExplicit.map((t) => t.taskId)), new Set([running.taskId, pending.taskId]));

    const byName = payload<TaskSnapshot[]>(await call(status, { includeHistory: true, name: "GAMMA" }));
    assert.deepEqual(byName.map((t) => t.taskId), [running.taskId], "name matching is a case-insensitive substring");

    const history = payload<TaskSnapshot[]>(await call(status, { includeHistory: true }));
    assert.ok(history.length >= 4);
    const keys = history.map((t) => t.finishedAt ?? t.createdAt);
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1]! >= keys[i]!, "history is sorted by (finishedAt ?? createdAt) desc");

    const limited = payload<TaskSnapshot[]>(await call(status, { includeHistory: true, limit: 1 }));
    assert.equal(limited.length, 1, "limit is honoured");
    assert.equal(limited[0]?.taskId, history[0]?.taskId, "limit keeps the newest task after sorting");
    const clampedLow = payload<TaskSnapshot[]>(await call(status, { includeHistory: true, limit: 0 }));
    assert.equal(clampedLow.length, 1, "limit below 1 clamps to 1");
    const clampedHigh = payload<TaskSnapshot[]>(await call(status, { includeHistory: true, limit: 999 }));
    assert.ok(clampedHigh.length <= 50, "limit above 50 clamps to 50");

    const combined = payload<TaskSnapshot[]>(await call(status, { status: "completed", name: "alpha" }));
    assert.deepEqual(combined.map((t) => t.taskId), [completed.taskId], "status and name intersect");

    for (const task of history) {
      const live = registry.get(task.taskId);
      if (!live) continue;
      assert.notEqual(task, live, "async_status must return copies, not the live snapshot objects");
      assert.notEqual(task.metadata, live.metadata, "metadata must be shallow-copied");
    }
  } finally { await cleanup(); }
});

test("async_status redacts metadata.delayedEnv to *** without mutating the registry (PLAN §2.7)", async () => {
  const { registry, tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    const started = payload<{ taskId: string }>(await call(run, {
      command: "echo hi",
      name: "delayed-env",
      mode: "delayed",
      delayMs: 60_000,
      notifyOnCompletion: false,
      env: { SECRET_TOKEN: "hunter2", PATH_EXTRA: "/custom/bin" },
    }));
    const listed = payload<TaskSnapshot[]>(await call(tool(tools, "async_status"), { includeHistory: true, name: "delayed-env" }));
    const row = listed.find((task) => task.taskId === started.taskId);
    assert.ok(row, "delayed task must be listed");
    assert.deepEqual(row.metadata.delayedEnv, { SECRET_TOKEN: "***", PATH_EXTRA: "***" }, "values are masked, keys survive");
    assert.deepEqual((registry.get(started.taskId)?.metadata.delayedEnv as Record<string, string>), { SECRET_TOKEN: "hunter2", PATH_EXTRA: "/custom/bin" },
      "the live metadata must keep the real env for the delayed start");
  } finally { await cleanup(); }
});

test("async_logs enforces the 50 KiB runtime cap and accepts the exact boundary", async () => {
  const MAX_LOG_BYTES = 50 * 1024;
  const { tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    const wait = tool(tools, "async_wait");
    const logs = tool(tools, "async_logs");
    const started = payload<{ taskId: string }>(await call(run, { command: "printf hi", mode: "background" }));
    await call(wait, { taskIds: [started.taskId], timeoutMs: 5000 });

    // Our harness calls `tool.execute` directly, so the runtime guard surfaces as a thrown error.
    // The pi host wraps a thrown execute into a `{ isError: true }` tool result; either shape is an
    // error for the model, and `expectToolError` above accepts both.
    await assert.rejects(
      logs.execute("call-maxbytes", { taskId: started.taskId, maxBytes: MAX_LOG_BYTES + 1 }),
      /maxBytes must be at most 50 KiB/,
    );

    // The exact boundary must not throw and must still return a real log slice.
    const boundary = await call(logs, { taskId: started.taskId, maxBytes: MAX_LOG_BYTES });
    assert.equal(boundary.isError, false, "maxBytes === 50 KiB is valid");
    const boundaryPayload = payload<{ text: string; fullPath: string; truncated: boolean }>(boundary);
    assert.equal(typeof boundaryPayload.fullPath, "string");
    assert.ok(boundaryPayload.fullPath.length > 0, "payload carries fullPath");
    assert.match(boundaryPayload.text, /hi/, "payload carries the task output");
    assert.equal(typeof boundaryPayload.truncated, "boolean");
  } finally { await cleanup(); }
});

test("async_logs splits stdout/stderr streams and reports a missing stream file", async () => {
  const { dir, registry, tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");
    const wait = tool(tools, "async_wait");
    const logs = tool(tools, "async_logs");
    const started = payload<{ taskId: string }>(await call(run, { command: "printf out-marker; printf err-marker >&2", mode: "background" }));
    await call(wait, { taskIds: [started.taskId], timeoutMs: 5000 });

    const merged = payload<{ text: string; missing?: boolean }>(await call(logs, { taskId: started.taskId }));
    assert.match(merged.text, /out-marker/);
    assert.match(merged.text, /err-marker/);
    assert.notEqual(merged.missing, true);

    const stdout = payload<{ text: string }>(await call(logs, { taskId: started.taskId, stream: "stdout" }));
    assert.match(stdout.text, /out-marker/);
    assert.doesNotMatch(stdout.text, /err-marker/, "stream=stdout excludes stderr");
    const stderr = payload<{ text: string }>(await call(logs, { taskId: started.taskId, stream: "stderr" }));
    assert.match(stderr.text, /err-marker/);
    assert.doesNotMatch(stderr.text, /out-marker/, "stream=stderr excludes stdout");

    unlinkSync(join(dir, `${started.taskId}.stdout`));
    const missing = payload<{ text: string; truncated: boolean; fullPath: string; missing?: boolean }>(await call(logs, { taskId: started.taskId, stream: "stdout" }));
    assert.equal(missing.missing, true);
    assert.equal(missing.text, "");
    assert.equal(missing.truncated, false);
    assert.ok(missing.fullPath.endsWith(`${started.taskId}.stdout`));
    assert.ok(registry.get(started.taskId));
  } finally { await cleanup(); }
});

test("registerTools forwards the tool ctx to ensureConfigured (the extension owns once-only configure)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-d-configure-"));
  const registry = new TaskRegistry({ dataDir: dir });
  const host = makeHost();
  const seen: Array<ToolContext | undefined> = [];
  try {
    registerTools(host.pi as never, registry, (ctx) => seen.push(ctx));
    const ctx: ToolContext = { cwd: dir };
    await call(tool(host.tools, "async_status"), {}, ctx);
    await call(tool(host.tools, "async_status"), {}, ctx);
    assert.equal(seen.length, 2, "the hook is invoked per tool call; the extension keeps configure idempotent");
    assert.equal(seen[0], ctx);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
