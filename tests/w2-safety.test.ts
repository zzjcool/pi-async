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
import { evalConditions, validateWatchSpec, MAX_OUTPUT_MATCH_BYTES } from "../src/core/watch.ts";
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

test("syncResult outputTail stays UTF-8 clean and ≤8 KiB (#17)", async () => {
  const dir = tmpDir("pi-async-w2-sync-");
  const registry = new TaskRegistry({ dataDir: dir });
  try {
    const result = await registry.runSync(
      { command: "python3 -c \"print('中'*3000, end='')\"", mode: "sync", name: "cjk" },
      10_000,
      "abort",
    );
    assert.equal([...result.outputTail].filter((c) => c === "\uFFFD").length, 0);
    assert.ok(Buffer.byteLength(result.outputTail, "utf8") <= 8192);
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

test("output_matches evaluates only the last MAX_OUTPUT_MATCH_BYTES (#24)", () => {
  assert.ok(MAX_OUTPUT_MATCH_BYTES > 0);
  const needle = "UNIQUE_TAIL_MARKER_XYZ";
  const output = "a".repeat(MAX_OUTPUT_MATCH_BYTES + 100) + needle;
  assert.equal(
    evalConditions([{ type: "output_matches", regex: needle }], { output, stdout: output, stderr: "" }),
    true,
  );
  // Marker only in the dropped prefix must not match.
  const buried = needle + "b".repeat(MAX_OUTPUT_MATCH_BYTES + 10);
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
test("re-init shuts down the previous registry generation (#44)", async () => {
  const base = tmpDir("pi-async-w2-rrl-");
  const pids: number[] = [];
  const makePi = (dataCwd: string) => {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    return {
      cwd: dataCwd,
      pid: process.pid,
      sessionId: "reload-test",
      registerTool: () => {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      _handlers: handlers,
    };
  };
  // Isolate data dirs per generation so reloadFromDisk does not re-attach live work;
  // we only assert that the previous generation's process is killed by re-init.
  const dirs: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const dir = join(base, `gen${i}`);
      // registryDataDir uses cwd/.pi/async/<session>-<pid> — point cwd uniquely... 
      // Actually both gens share sessionId-pid so same dataDir. That's intentional for #44.
      // Use distinct session ids so we don't confuse snapshots; we track pids from submit via registry.
      dirs.push(dir);
    }
    // Drive TaskRegistry directly to mirror the leak reproduction, then verify
    // the module-level dispose path via init twice with shared data dir key.
    const sharedCwd = join(base, "shared");
    const pi1 = makePi(sharedCwd) as never;
    await init(pi1);
    // Access is internal; submit through tools.
    const tools1 = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    // Re-init will create new registry; first we need a live process on the active one.
    // Simpler path: two TaskRegistry instances no shutdown — then call init twice.
    const dataDir = join(sharedCwd, ".pi", "async", `reload-test-${process.pid}`);
    // Direct registry leak baseline (documents the bug the fix addresses):
    const orphanDir = join(base, "orphan");
    const r1 = new TaskRegistry({ dataDir: join(orphanDir, "r1") });
    const t1 = r1.submit({ command: "sleep 300", name: "orphan", mode: "background" });
    assert.ok(t1.pid);
    pids.push(t1.pid!);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(pidAlive(t1.pid!), true);
    await r1.shutdown();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(pidAlive(t1.pid!), false, "shutdown must kill the process");

    // Module-level re-init: start a task via first init's tools, then re-init.
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const host = {
      cwd: sharedCwd,
      pid: process.pid,
      sessionId: "w2-reload",
      registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => {
        tools.set(tool.name, tool);
      },
      on: () => {},
    };
    await init(host as never);
    const run = tools.get("async_run")!;
    const submitted = await run.execute("c1", { command: "sleep 300", name: "live", mode: "background" }) as {
      details: { payload: { taskId: string } };
    };
    // Recover pid from snapshot file
    const snapPath = join(sharedCwd, ".pi", "async", `w2-reload-${process.pid}`, `${submitted.details.payload.taskId}.json`);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(existsSync(snapPath));
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { pid?: number };
    assert.ok(snap.pid);
    assert.equal(pidAlive(snap.pid!), true);

    // Second init must shut down the first generation.
    const tools2 = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const host2 = {
      cwd: sharedCwd,
      pid: process.pid,
      sessionId: "w2-reload",
      registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => {
        tools2.set(tool.name, tool);
      },
      on: () => {},
    };
    await init(host2 as never);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(pidAlive(snap.pid!), false, "re-init must kill previous generation process");
  } finally {
    // Final init shutdown via a third empty init then session path — call init and
    // shut down whatever is active by creating a registry and shutting via re-init with immediate empty.
    const hostFinal = {
      cwd: join(base, "final"),
      pid: process.pid,
      sessionId: "final",
      registerTool: () => {},
      on: () => {},
    };
    await init(hostFinal as never);
    // One more init to dispose final
    await init({ ...hostFinal, sessionId: "final2" } as never);
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
test("async_run rejects timeoutMs on background and delayMs on sync (#42)", async () => {
  const dir = tmpDir("pi-async-w2-mode-");
  const registry = new TaskRegistry({ dataDir: dir });
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  registerTools({ registerTool: (t: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => tools.set(t.name, t) } as never, registry);
  try {
    const run = tools.get("async_run")!;
    await assert.rejects(run.execute("c", { command: "true", mode: "background", timeoutMs: 1000 }), /timeoutMs is only valid/);
    await assert.rejects(run.execute("c", { command: "true", mode: "sync", timeoutMs: 1000, delayMs: 5 }), /delayMs is only valid/);
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
  const guard = new SettleGuard(fakePi as never, fakeReg as never, { heartbeatMs: 0 });
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
