import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init } from "../extensions/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { registerTools } from "../src/tools/index.ts";

/**
 * REV-24: a tool registration can outlive the generation that created it.
 *
 * The host keeps the first registration for a tool name (first-wins across extensions), while a
 * later `init()` suspends the registry the original closure captured. Before the fix every call
 * through such a registration landed on a retired registry: `async_run` refused admission forever
 * and `async_status` could not see the new generation's tasks, with no recovery but a restart.
 */

type Payload = { details: { payload?: unknown }; isError?: boolean };
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<Payload> };
type Hook = (...args: unknown[]) => unknown;

function makeGen(base: string, sessionId: string) {
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, Hook[]>();
  const sessionManager = { getSessionDir: () => base, getSessionId: () => sessionId };
  const ctx = { mode: "rpc", hasUI: false, cwd: base, sessionManager };
  const pi = {
    sessionManager,
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    on: (event: string, handler: Hook) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
      return () => undefined;
    },
  };
  const dispatch = async (event: string, payload?: unknown) => {
    for (const handler of hooks.get(event) ?? []) await handler(payload, ctx);
  };
  const call = async <T,>(name: string, params: Record<string, unknown>): Promise<T> => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    const result = await tool.execute("call", params, undefined, undefined, ctx);
    return result.details.payload as T;
  };
  return { pi, dispatch, call, tools };
}

/** Wait until the generation persisted a snapshot for `taskId` (submit is synchronous, persistence is not). */
async function waitForSnapshot(dataDir: string, taskId: string, timeoutMs = 3_000): Promise<void> {
  const path = join(dataDir, `${taskId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        if (JSON.parse(readFileSync(path, "utf8")).status === "running") return;
      } catch {
        // partially written; retry
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`snapshot for ${taskId} never appeared in ${dataDir}`);
}

test("registerTools accepts a resolver so a call follows a generation swap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-handoff-unit-"));
  const first = new TaskRegistry({ dataDir: join(dir, "first") });
  const second = new TaskRegistry({ dataDir: join(dir, "second") });
  const tools = new Map<string, Tool>();
  let live: TaskRegistry = first;
  try {
    registerTools({ registerTool: (tool: Tool) => { tools.set(tool.name, tool); } } as never, () => live);
    const status = async (): Promise<Array<{ taskId: string }>> => {
      const tool = tools.get("async_status");
      assert.ok(tool, "async_status must be registered");
      const result = await tool.execute("call", { includeHistory: true }, undefined, undefined, {});
      return result.details.payload as Array<{ taskId: string }>;
    };

    first.submit({ command: "sleep 5", mode: "background", notifyOnCompletion: false } as never);
    first.submit({ command: "sleep 5", mode: "background", notifyOnCompletion: false } as never);
    assert.equal((await status()).length, 2, "the resolver's current target serves the call");

    live = second;
    assert.equal((await status()).length, 0, "swapping the resolver redirects the very same tool object");

    // A plain registry keeps working: the old signature stays supported for embedders.
    const plain = new Map<string, Tool>();
    registerTools({ registerTool: (tool: Tool) => { plain.set(tool.name, tool); } } as never, first);
    const result = await plain.get("async_status")!.execute("call", { includeHistory: true }, undefined, undefined, {});
    assert.equal((result.details.payload as unknown[]).length, 2, "a direct registry behaves as before");

    // The fix lives in the tool layer, not in loosening the registry: a retired generation cited
    // directly still refuses new work.
    await first.suspend();
    const retired = new Map<string, Tool>();
    registerTools({ registerTool: (tool: Tool) => { retired.set(tool.name, tool); } } as never, first);
    await assert.rejects(
      retired.get("async_run")!.execute("call", { command: "echo hi", mode: "background" }, undefined, undefined, {}),
      /admission is closed/,
      "suspending still fences the retired generation — resolution is what moves the call, not a reset",
    );
  } finally {
    await first.shutdown();
    await second.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool registration kept from a retired generation is served by the live one", async () => {
  const base = mkdtempSync(join(tmpdir(), "pi-async-handoff-"));
  const sessionId = "handoff";
  const dataDir = join(base, "pi-async", sessionId);
  const gen1 = makeGen(base, sessionId);
  const gen2 = makeGen(base, sessionId);
  try {
    await init(gen1.pi as never);
    await gen1.dispatch("session_start", { type: "session_start", reason: "startup" });
    const started = await gen1.call<{ taskId: string }>("async_run", {
      command: "sleep 30", name: "handoff", mode: "background", notifyOnCompletion: false,
    });
    await waitForSnapshot(dataDir, started.taskId);

    // Second init retires gen1's registry (suspend, never kill) — the REV-17 reload path.
    await init(gen2.pi as never);
    await gen2.dispatch("session_start", { type: "session_start", reason: "reload" });

    // gen1's tool object is exactly what a host that kept the first registration would call.
    const rows = await gen1.call<Array<{ taskId: string; status: string }>>("async_status", { includeHistory: true });
    const row = rows.find((task) => task.taskId === started.taskId);
    assert.ok(row, "a stale registration must reach the generation that owns the work, not a retired one");
    assert.equal(row.status, "running");

    // Admission through the stale registration must start work in the live generation.
    const fresh = await gen1.call<{ taskId: string }>("async_run", {
      command: "sleep 1", name: "after-handoff", mode: "background", notifyOnCompletion: false,
    });
    assert.ok(fresh.taskId);
    const adopted = await gen2.call<Array<{ taskId: string }>>("async_status", {});
    assert.ok(adopted.some((task) => task.taskId === fresh.taskId), "the live generation owns the new task");
  } finally {
    await gen2.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }).catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
});

test("with no live generation the retired one reports an actionable admission error", async () => {
  const base = mkdtempSync(join(tmpdir(), "pi-async-handoff-dead-"));
  const sessionId = "dead";
  const gen1 = makeGen(base, sessionId);
  const gen2 = makeGen(base, sessionId);
  try {
    await init(gen1.pi as never);
    await gen1.dispatch("session_start", { type: "session_start", reason: "startup" });
    await init(gen2.pi as never);
    await gen2.dispatch("session_start", { type: "session_start", reason: "reload" });
    // quit clears the live generation; gen1's registration now has nowhere to go.
    await gen2.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });

    await assert.rejects(
      gen1.call("async_run", { command: "echo hi", mode: "background" }),
      /admission is closed \(registry suspended: .*reload the session/,
      "the error must say why and what to do, not just that admission is closed",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
