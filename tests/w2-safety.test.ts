import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execSync } from "node:child_process";
import { stripAnsi, stripLogControls, truncateUtf8Bytes } from "../src/core/output.ts";
import { buildNotificationXml } from "../src/core/notify.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { capName, deriveName, isTaskStatus, TASK_STATUSES } from "../src/core/task.ts";
import { evalConditions, validateWatchSpec, MAX_MATCH_CHARS } from "../src/core/watch.ts";
import { registerTools } from "../src/tools/index.ts";
import { init } from "../extensions/index.ts";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function pidAlive(pid: number): boolean {
  try {
    execSync(`ps -p ${pid} -o pid=`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- #32 stripAnsi unterminated ---
test("stripAnsi drops unterminated OSC/CSI whole and keeps 2-char escapes (#32)", () => {
  assert.equal(stripAnsi("a\x1b]8;;https://x"), "a");
  assert.equal(stripAnsi("a\x1b[31"), "a");
  assert.equal(stripAnsi("ok\x1b7saved\x1b8"), "oksaved");
  assert.equal(stripAnsi("a\x1b]0;t\x07b"), "ab");
  assert.equal(stripAnsi("a\x1b[31mb"), "ab");
});

// --- #18 stripLogControls (logs path; stripControl remains TUI fold from #3/#57) ---
test("stripLogControls removes bare C0 while preserving tab/LF/CR (#18)", () => {
  const raw = "A\x00B\x07C\x08D\tE\nF\rG";
  assert.equal(stripAnsi(raw), raw);
  assert.equal(stripLogControls(raw), "ABCD\tE\nF\rG");
});

// --- #17 UTF-8 truncate ---
test("truncateUtf8Bytes does not inject U+FFFD on CJK tails (#17)", () => {
  const text = "中".repeat(5000);
  const bytes = Buffer.from(text, "utf8");
  assert.ok(bytes.byteLength > 8192);
  const out = truncateUtf8Bytes(bytes, 8192, true);
  assert.equal([...out].filter((c) => c === "\uFFFD").length, 0);
  assert.ok(Buffer.byteLength(out, "utf8") <= 8192);
  assert.ok(out.endsWith("中"));
});

// --- D3 carried-over bound: the tail the removed syncResult used to keep ≤8 KiB is still bounded on
// the live path that carries it now (`registry.wait` → `async_wait`). Without this, the only remaining
// pin on `waitResult`'s 8192 window was the sync test that D3 deleted.
test("wait results keep a UTF-8-clean, ≤8 KiB outputTail (#17, carried over from the removed syncResult)", async () => {
  const dir = tmpDir("pi-async-w2-waittail-");
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    // 400 lines × 60 CJK characters: far past 8 KiB, and every cut lands mid-sequence if unbounded.
    const task = registry.submit({
      command: `node -e 'for (let i = 0; i < 400; i++) process.stdout.write("中".repeat(60) + "\\n")'`,
      cwd: dir,
    });
    const outcome = await registry.wait([task.taskId], 30_000);
    assert.ok("results" in outcome, "the task must finish inside the wait window");
    const row = outcome.results[0]!;
    assert.equal(row.status, "completed");
    assert.ok(Buffer.byteLength(row.outputTail, "utf8") <= 8192, "outputTail respects the 8 KiB read window");
    assert.equal([...row.outputTail].filter((character) => character === "\uFFFD").length, 0, "no split UTF-8 sequences");
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #19 escapeXml ---
test("notification XML strips illegal C0 characters (#19)", () => {
  const xml = buildNotificationXml({
    taskId: "t1",
    name: "bin",
    status: "completed",
    outputFile: "/tmp/x.output",
    summary: "A\x00B\x07C\x08D",
  });
  assert.equal(xml.includes("\x00"), false);
  assert.equal(xml.includes("\x07"), false);
  assert.equal(xml.includes("\x08"), false);
  assert.match(xml, /<summary>ABCD<\/summary>/);
});

// --- #24 ReDoS ---
test("validateWatchSpec rejects nested-quantifier regexes (#24)", () => {
  const result = validateWatchSpec({
    intervalMs: 1000,
    timeoutMs: 5000,
    success_when: [{ type: "output_matches", regex: "(a+)+$" }],
    failure_when: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /nested quantifiers|ReDoS/i);
});

test("output_matches evaluates only the last MAX_MATCH_CHARS (#24)", () => {
  assert.ok(MAX_MATCH_CHARS > 0);
  const needle = "UNIQUE_TAIL_MARKER_XYZ";
  const output = "a".repeat(MAX_MATCH_CHARS + 100) + needle;
  assert.equal(
    evalConditions([{ type: "output_matches", regex: needle }], { output, stdout: output, stderr: "" }),
    true,
  );
  // Marker only in the dropped prefix must not match.
  const buried = needle + "b".repeat(MAX_MATCH_CHARS + 10);
  assert.equal(
    evalConditions([{ type: "output_matches", regex: needle }], { output: buried, stdout: buried, stderr: "" }),
    false,
  );
});

test("output_matches uses multiline flag so ^/$ bind per line (#48 align with Loom #64)", () => {
  assert.equal(
    evalConditions([{ type: "output_matches", regex: "^ready$" }], { output: "noise\nready\nmore", stdout: "noise\nready\nmore", stderr: "" }),
    true,
  );
  // Without m this would fail; with m it matches the middle line.
  assert.equal(
    evalConditions([{ type: "output_matches", regex: "^ready$" }], { output: "ready", stdout: "ready", stderr: "" }),
    true,
  );
});


// --- #34 unknown status ---
test("reloadFromDisk skips snapshots with unknown status (#34)", async () => {
  const dir = tmpDir("pi-async-w2-reload-");
  writeFileSync(join(dir, "valid.json"), JSON.stringify({
    taskId: "valid-1", name: "ok", command: "echo x", mode: "background",
    status: "completed", createdAt: Date.now(), notified: false, outputConsumed: false,
    metadata: { outputFile: join(dir, "valid.output") },
  }));
  writeFileSync(join(dir, "bad-status.json"), JSON.stringify({
    taskId: "bogus", name: "bogus-task", command: "echo x", mode: "background",
    status: "NOT_A_STATUS", createdAt: Date.now(), notified: false, outputConsumed: false,
    metadata: { outputFile: join(dir, "bogus.output") },
  }));
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    await registry.reloadFromDisk();
    assert.ok(registry.get("valid-1"));
    assert.equal(registry.get("bogus"), undefined);
    assert.equal(isTaskStatus("NOT_A_STATUS"), false);
    assert.deepEqual([...TASK_STATUSES], ["pending", "running", "completed", "failed", "killed"]);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #44 reload orphans ---
test("re-init suspends the previous generation and the next configure adopts its task (#44)", async () => {
  const base = tmpDir("pi-async-w2-rrl-");
  const sessionId = "w2-reload";
  const dataDir = join(base, "pi-async", sessionId);
  const pids: number[] = [];
  type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ details: { payload?: unknown }; isError?: boolean }> };
  type Hook = (...args: unknown[]) => unknown;
  const makeGen = () => {
    const tools = new Map<string, Tool>();
    const hooks = new Map<string, Hook[]>();
    const sessionManager = { getSessionDir: () => base, getSessionId: () => sessionId };
    const ctx = { mode: "rpc", hasUI: false, cwd: base, sessionManager };
    // CONTRACT §15: the factory-time API carries no session cwd/pid — only event ctxs do.
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
    const dispatch = async (event: string, payload?: unknown) => { for (const handler of hooks.get(event) ?? []) await handler(payload, ctx); };
    const call = async <T,>(name: string, params: Record<string, unknown>): Promise<T> => {
      const tool = tools.get(name);
      assert.ok(tool, `${name} must be registered`);
      const result = await tool.execute("call", params, undefined, undefined, ctx);
      return result.details.payload as T;
    };
    return { pi, dispatch, call };
  };

  try {
    const gen1 = makeGen();
    await init(gen1.pi as never);
    await gen1.dispatch("session_start", { type: "session_start", reason: "startup" });
    const started = await gen1.call<{ taskId: string }>("async_run", { command: "sleep 300", name: "live", mode: "background", notifyOnCompletion: false });

    // D-16: the session-scoped data dir, not the real homedir or the host cwd.
    let snap: { pid?: number; status?: string } | undefined;
    for (let i = 0; i < 80 && !(snap?.pid && snap.status === "running"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const file = join(dataDir, `${started.taskId}.json`);
      if (existsSync(file)) snap = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; status?: string };
    }
    assert.ok(snap?.pid, "the task snapshot must persist under <sessionDir>/pi-async/<sessionId>");
    pids.push(snap.pid!);
    assert.equal(pidAlive(snap.pid!), true);

    // Second init: the previous generation is SUSPENDED (not killed) so /reload can adopt.
    const gen2 = makeGen();
    await init(gen2.pi as never);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(pidAlive(snap.pid!), true, "re-init must suspend, never kill, the previous generation's tasks");

    // The next generation's configure adopts the running task from disk.
    await gen2.dispatch("session_start", { type: "session_start", reason: "reload" });
    const adopted = await gen2.call<Array<{ taskId: string; status: string }>>("async_status", { includeHistory: true });
    const row = adopted.find((task) => task.taskId === started.taskId);
    assert.ok(row, "the adopted task is visible to the next generation");
    assert.equal(row.status, "running");

    // ...and quit finally kills it with shutdown semantics.
    await gen2.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });
    for (let i = 0; i < 80 && pidAlive(snap.pid!); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pidAlive(snap.pid!), false, "quit kills the adopted task");
  } finally {
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(base, { recursive: true, force: true });
  }
});

// --- #23 / #28 names ---
test("deriveName uses first non-blank line (#23)", () => {
  assert.equal(deriveName("\necho hello"), "echo hello");
  assert.equal(deriveName("  npm   test\n echo ignored"), "npm test");
});

test("capName never splits surrogate pairs (#28)", () => {
  const name = "A".repeat(47) + "🚀";
  const capped = capName(name);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped), false);
  assert.ok(Array.from(capped).length <= 48);
});

test("submit stores code-point-capped names without lone surrogates (#28)", () => {
  const dir = tmpDir("pi-async-w2-name-");
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const t = registry.submit({ command: "sleep 60", name: "A".repeat(47) + "🚀", mode: "background" });
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t.name), false);
  } finally {
    void registry.shutdown().then(() => rmSync(dir, { recursive: true, force: true }));
  }
});

// --- #33 D4 kill ---
test("async_kill on D4 task returns alreadyTerminal + killKind without flipping status (#33)", async () => {
  const dir = tmpDir("pi-async-w2-d4-");
  const registry = new TaskRegistry({ dataDir: dir });
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  registerTools({ registerTool: (t: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => tools.set(t.name, t) } as never, registry);
  try {
    const t = registry.submit({
      command: "sleep 1 && echo READY && sleep 300",
      name: "d4",
      mode: "background",
      watch: {
        intervalMs: 1000,
        timeoutMs: 20_000,
        success_when: [{ type: "stdout_contains", value: "READY" }],
        failure_when: [],
        blind_checks: 3,
      },
    });
    // Wait for watch hit
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (registry.get(t.taskId)?.status === "completed") break;
    }
    assert.equal(registry.get(t.taskId)?.status, "completed");
    assert.ok(t.pid && pidAlive(t.pid), "D4 process should still be alive after watch hit");
    const kill = tools.get("async_kill")!;
    const result = await kill.execute("k1", { taskId: t.taskId }) as { details: { payload: Record<string, unknown> } };
    assert.equal(result.details.payload.status, "completed");
    assert.equal(result.details.payload.alreadyTerminal, true);
    assert.equal(result.details.payload.killKind, "user");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(pidAlive(t.pid!), false);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #42 mode-irrelevant params ---
test("async_run no longer takes the sync knobs and still rejects delayMs outside delayed (#42 / D3)", async () => {
  const dir = tmpDir("pi-async-w2-mode-");
  const registry = new TaskRegistry({ dataDir: dir });
  type Tool = { parameters: { properties: Record<string, unknown> }; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
  const tools = new Map<string, Tool>();
  registerTools({ registerTool: (t: { name: string } & Tool) => tools.set(t.name, t) } as never, registry);
  try {
    const run = tools.get("async_run")!;
    // D3 (0.5.0): timeoutMs/onTimeout left the schema, so `additionalProperties: false` makes the host
    // reject them before execute runs — nothing is silently ignored at the tool layer anymore.
    assert.equal(run.parameters.properties.timeoutMs, undefined, "timeoutMs is not an async_run parameter");
    assert.equal(run.parameters.properties.onTimeout, undefined, "onTimeout is not an async_run parameter");
    await assert.rejects(run.execute("c", { command: "true", mode: "background", delayMs: 5 }), /delayMs is only valid for delayed mode \(pass mode: "delayed"/);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #22 status default ---
test("async_status defaults to active tasks only (#22)", async () => {
  const dir = tmpDir("pi-async-w2-status-");
  const registry = new TaskRegistry({ dataDir: dir });
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  registerTools({ registerTool: (t: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => tools.set(t.name, t) } as never, registry);
  try {
    const done = registry.submit({ command: "true", name: "done", mode: "background" });
    await registry.wait([done.taskId], 5000);
    const live = registry.submit({ command: "sleep 60", name: "live", mode: "background" });
    const status = tools.get("async_status")!;
    const def = await status.execute("s", {}) as { details: { payload: Array<{ taskId: string }> } };
    assert.equal(def.details.payload.length, 1);
    assert.equal(def.details.payload[0]?.taskId, live.taskId);
    const hist = await status.execute("s2", { includeHistory: true }) as { details: { payload: unknown[] } };
    assert.ok(hist.details.payload.length >= 2);
  } finally {
    await registry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #16 grammar ---
test("settle-guard activity message singularizes for one task (#16)", async () => {
  const { SettleGuard } = await import("../src/guard/settle-guard.ts");
  const calls: Array<{ id: string; v: unknown }> = [];
  const fakePi = { on: () => {}, off: () => {}, ui: { setActivity: (id: string, v: unknown) => calls.push({ id, v }) } };
  let tasks: Array<{ taskId: string; status: string }> = [];
  const fakeReg = {
    list: () => tasks,
    activeCount: () => ({ running: tasks.filter((t) => t.status === "running").length, pending: 0 }),
    hasActiveWork: () => tasks.some((t) => t.status === "running"),
  };
  const guard = new SettleGuard(fakePi as never, fakeReg as never);
  guard.register();
  tasks = [{ taskId: "A", status: "running" }];
  // reportActivity is private; trigger via register's initial call then re-call through activeCount change —
  // SettleGuard.reportActivity is private. Use setActivity by constructing and calling register which calls reportActivity.
  // Force another report by re-registering after mutating tasks.
  guard.register();
  const last = calls.at(-1);
  assert.deepEqual(last?.v, { message: "1 async task" });
  tasks = [{ taskId: "A", status: "running" }, { taskId: "B", status: "running" }];
  guard.register();
  assert.deepEqual(calls.at(-1)?.v, { message: "2 async tasks" });
});
