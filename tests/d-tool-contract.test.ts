import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerTools, type ToolContext } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { TaskSnapshot } from "../src/core/task.ts";
import { withExposedWaitAsync } from "./helpers/index.ts";

/**
 * 0.3.0 tool contract (PLAN §2.7 / D-08 / D-17 / D-18):
 * tools must not lie about failures — unknown ids are errors, names resolve,
 * status/logs support filtering and stream splits, and reads never mutate the
 * registry's live snapshots.
 */

/**
 * D4 (0.5.0): `async_wait` is opt-in and the gate is read per call (registration **and** execute),
 * so a test that registers or calls it holds `PI_ASYNC_EXPOSE_WAIT=1` for its whole body via this
 * wrapper. The default five-tool surface is pinned in `tests/k-toolsurface.test.ts`.
 */
const exposedTest = (name: string, fn: () => Promise<void>): void => {
  test(name, () => withExposedWaitAsync(fn));
};

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

/**
 * D-C9: prompt copy is contract. These literals are the frozen text from docs/PLAN-CONTEXT.md
 * (D-C1 snippets, D-C2 description + field descriptions, D-C3 guidelines) — assert them verbatim
 * so a refactor cannot silently drift the discoverability surface.
 */
const D_C1_SNIPPETS: Record<string, string> = {
  async_run: "Run a long or gating shell command detached (build/test over a minute, server, watcher); returns a taskId, not output.",
  async_wait: "Block until async tasks finish or the budget expires; results land in context. Never kills.",
  async_logs: "Read the bounded, ANSI-stripped output of an async task, including while it is still running.",
  async_status: "List active async tasks with elapsed time; includeHistory for recent finished ones.",
  async_kill: "Stop an async task and its whole process group.",
};

const D_C2_DESCRIPTION = "Run a shell command as a managed async task. mode=background (default) returns a taskId immediately; mode=delayed starts after delayMs.";

/**
 * D-34 (0.4.1): the batch-planning guideline joined the three D-C3 ones, so the always-on prompt
 * now pushes "plan the batch / launch together in one message" instead of only "~60s means async".
 * D4 (0.5.0): these four are byte-frozen; the fifth line is appended only while `async_wait` is
 * not exposed, so the prompt never sells a tool this session lacks.
 */
const D_C3_GUIDELINES = [
  "Reach for async_run before bash when a command may outlive ~60s or never exit (builds, test suites, dev servers, watchers, network waits); quick file operations stay in bash.",
  "Do not sit in async_wait only to end a turn: if you do not need the result yet, end the turn and the completion notification wakes you. In a legion child, collect with async_wait before returning a verdict.",
  "Pass name so later calls address the task by name, and read output with async_logs (works while running) instead of re-running the command.",
  "Plan the batch first: launch independent long commands together (several async_run calls in one message) and collect them with a single async_wait later.",
];

const WAIT_UNAVAILABLE_GUIDELINE = "async_wait is not available in this session (set PI_ASYNC_EXPOSE_WAIT=1 to expose it); end the turn and the completion notification wakes you, and read output with async_logs.";

const MAX_SNIPPET_CHARS = 140;

test("all six exposed tools carry a single-line promptSnippet verbatim from D-C1", async () => {
  await withExposedWaitAsync(async () => {
    const { tools, cleanup } = makeRegistry();
    try {
      for (const [name, expected] of Object.entries(D_C1_SNIPPETS)) {
        const snippet = tool(tools, name).promptSnippet;
        assert.equal(typeof snippet, "string", `${name} must carry a promptSnippet (D-C1)`);
        assert.ok((snippet ?? "").length > 0, `${name} snippet must be non-empty`);
        assert.equal(snippet, expected, `${name} snippet must equal D-C1 verbatim`);
        assert.doesNotMatch(snippet ?? "", /[\r\n]/, `${name} snippet must be a single line`);
        assert.ok((snippet ?? "").length <= MAX_SNIPPET_CHARS, `${name} snippet must be <= ${MAX_SNIPPET_CHARS} chars, got ${(snippet ?? "").length}`);
      }
    } finally { await cleanup(); }
  });
});

test("async_run promptGuidelines are the four frozen D-C3 + D-34 lines, plus the no-wait note by default", async () => {
  const { tools, cleanup } = makeRegistry();
  try {
    // Default surface (D4): async_wait is not registered, so the fifth line tells the model so.
    const guidelines = tool(tools, "async_run").promptGuidelines;
    assert.deepEqual(guidelines, [...D_C3_GUIDELINES, WAIT_UNAVAILABLE_GUIDELINE]);
    for (const guideline of guidelines ?? []) {
      assert.doesNotMatch(guideline, /[\r\n]/, `guideline must stay one line: ${guideline}`);
    }
    assert.equal(guidelines?.length, 5, "four frozen guidelines plus the no-wait note");
  } finally { await cleanup(); }

  await withExposedWaitAsync(async () => {
    const exposed = makeRegistry();
    try {
      const guidelines = tool(exposed.tools, "async_run").promptGuidelines;
      assert.deepEqual(guidelines, D_C3_GUIDELINES, "an exposed async_wait needs no apology line");
      assert.equal(guidelines?.length, 4, "the base four stay byte-identical and last");
    } finally { await exposed.cleanup(); }
  });
});

test("async_run description is the two D-C2 sentences and no longer carries check discipline", async () => {
  const { tools, cleanup } = makeRegistry();
  try {
    const description = tool(tools, "async_run").description ?? "";
    assert.equal(description, D_C2_DESCRIPTION);
    assert.doesNotMatch(description, /\|\| true/, "check discipline moved to the skill (D-C2/D-C7)");
    assert.doesNotMatch(description, /jq -e/, "check discipline moved to the skill (D-C2/D-C7)");
  } finally { await cleanup(); }
});

test("async_run field descriptions follow D-C2 verbatim (command and watch pinned)", async () => {
  const { tools, cleanup } = makeRegistry();
  try {
    const expected: Record<string, string> = {
      command: "Shell command to execute (/bin/sh -c) in the session cwd.",
      name: "Short handle for later async_wait/async_logs/async_kill calls (max 48 chars).",
      mode: "background (default) returns a taskId now; delayed starts after delayMs.",
      delayMs: "delayed only: milliseconds to wait before starting.",
      taskTimeoutMs: "Kill the task after this many ms, in any mode.",
      notifyOnCompletion: "Send a completion notification (default true).",
      triggerOnCompletion: "Start a new turn when the task finishes (default true).",
      env: "Extra environment variables for the child process (safe policy applied).",
    };
    const properties = (tool(tools, "async_run").parameters?.properties ?? {}) as Record<string, { description?: unknown }>;
    for (const [field, text] of Object.entries(expected)) {
      const description = properties[field]?.description;
      assert.equal(typeof description, "string", `${field} must carry a description`);
      assert.ok((description as string).length > 0, `${field} description must be non-empty`);
      assert.equal(description, text, `${field} description must equal D-C2 verbatim`);
    }
    // D3 (0.5.0): the sync knobs are gone with the mode, not merely undocumented.
    assert.equal(properties.timeoutMs, undefined, "timeoutMs is not an async_run field anymore");
    assert.equal(properties.onTimeout, undefined, "onTimeout is not an async_run field anymore");
    // Pinned by name per the L0 ticket: command and watch are spelled out; the rest only checked above.
    assert.equal(properties.watch?.description, "Poll output (>=1s) for success_when/failure_when; conditions are OR-ed, first match wins, and checks must not swallow errors (no `|| true`).");
  } finally {
    await cleanup();
  }
});

test("async_run receipt states a notification exception only when one exists (D-C5 revised)", async () => {
  const { registry, tools, cleanup } = makeRegistry();
  try {
    const run = tool(tools, "async_run");

    const normal = payload<{ outputHint: string; willNotify?: boolean; willWake?: boolean }>(
      await call(run, { command: "sleep 0.1", name: "normal", mode: "background" }),
    );
    assert.equal("willNotify" in normal, false, "the default receipt does not repeat the general rule");
    assert.equal("willWake" in normal, false);
    assert.match(normal.outputHint, /Use async_logs with taskId/);

    const quiet = payload<{ outputHint: string; willNotify?: boolean; willWake?: boolean }>(
      await call(run, { command: "sleep 0.1", name: "quiet", mode: "background", notifyOnCompletion: false }),
    );
    assert.equal(quiet.willNotify, false, "notifications-off is a per-call fact worth stating");
    assert.equal("willWake" in quiet, false);
    assert.match(quiet.outputHint, /Notifications are off for this task/);

    const noTurn = payload<{ outputHint: string; willNotify?: boolean; willWake?: boolean }>(
      await call(run, { command: "sleep 0.1", name: "no-turn", mode: "background", triggerOnCompletion: false }),
    );
    assert.equal(noTurn.willWake, false);
    assert.equal("willNotify" in noTurn, false);
    assert.match(noTurn.outputHint, /will not start a new turn/);
  } finally { await cleanup(); }
});

exposedTest("async_run executes in ctx.cwd instead of the host process cwd", async () => {
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

exposedTest("taskId resolves by name for async_wait/async_logs/async_kill", async () => {
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

exposedTest("async_wait on a duplicated name reports both candidate taskIds", async () => {
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

exposedTest("async_status filters by default-active/status/name and clamps limit (D-08)", async () => {
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

exposedTest("async_logs enforces the 50 KiB runtime cap and accepts the exact boundary", async () => {
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

exposedTest("async_logs splits stdout/stderr streams and reports a missing stream file", async () => {
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
