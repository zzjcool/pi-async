import assert from "node:assert/strict";
import test from "node:test";
import { asyncStateLine, bashNudge, registerNudges } from "../src/context/nudges.ts";
import type { TaskRegistry } from "../src/core/registry.ts";
import { makeSnapshot } from "./helpers/index.ts";

/**
 * PLAN-CONTEXT §D-C4/§D-C5: the discoverability layer must be precise (no nudge on quick
 * calls, no state line when idle) and quiet (one state line per live-set change).
 */

type Handler = (...args: unknown[]) => unknown;
type ToolResultEvent = {
  toolName: string;
  input?: Record<string, unknown>;
  content?: unknown[];
  structuredContent?: unknown;
};

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const pi: Record<string, unknown> = {
    on(event: string, handler: Handler): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) handlers.delete(event);
      };
    },
  };
  const fireOne = (event: string, ...args: unknown[]): unknown => (handlers.get(event) ?? [])[0]?.(...args);
  return { pi, handlers, fireOne };
}

function makeRegistry(tasks: () => ReturnType<typeof makeSnapshot>[]) {
  return {
    list: () => tasks(),
  } as unknown as TaskRegistry;
}

/** Run `fn` with PI_ASYNC_NUDGE set, restoring the environment afterwards. */
function withSwitch<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.PI_ASYNC_NUDGE;
  if (value === undefined) delete process.env.PI_ASYNC_NUDGE;
  else process.env.PI_ASYNC_NUDGE = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_ASYNC_NUDGE;
    else process.env.PI_ASYNC_NUDGE = previous;
  }
}

test("bashNudge fires on wall time >= 60s and states the duration", () => {
  const nudge = bashNudge({ command: "npm test", wallTimeSeconds: 92.4 });
  assert.ok(nudge, "a 92s foreground call must be nudged");
  assert.match(nudge, /^\(took 92s in the foreground; /);
  assert.match(nudge, /async_run could have run it in the background/);
  assert.match(nudge, /mode=background with watch/);
  assert.match(nudge, /mode=sync with timeoutMs/);
});

test("bashNudge stays quiet for a quick, ordinary command", () => {
  assert.equal(bashNudge({ command: "ls -la", wallTimeSeconds: 3 }), undefined);
  assert.equal(bashNudge({ command: "git status", wallTimeSeconds: 59.9 }), undefined);
  assert.equal(bashNudge({ command: "rg TODO src/" }), undefined);
});

test("bashNudge fires on structurally long-lived commands without a wall time", () => {
  for (const command of ["tail -f app.log", "tail -F app.log", "until curl -sf localhost:3000; do sleep 1; done", "watch -n1 kubectl get pods"]) {
    const nudge = bashNudge({ command });
    assert.ok(nudge, `${command} must be nudged`);
    assert.doesNotMatch(nudge, /took /, "no duration claim without a wall time");
    assert.match(nudge, /async_run/);
  }
});

test("bashNudge covers sleep-polling, the shape that burned 21% of foreground time", () => {
  // Measured over 15 real sessions: `sleep N; tail …` cost 47 of 226 foreground minutes.
  assert.ok(bashNudge({ command: "sleep 270; tail -25 /tmp/e2e.log" }), "a 270s sleep-poll must be nudged");
  assert.ok(bashNudge({ command: "echo start && sleep 30 && cat out.json" }), "a 30s sleep-poll must be nudged");
  assert.equal(bashNudge({ command: "sleep 5 && retry-once" }), undefined, "short backoff stays quiet");
  assert.equal(bashNudge({ command: "sleep 1" }), undefined);
});

test("asyncStateLine renders name, status and elapsed and is undefined when idle", () => {
  assert.equal(asyncStateLine([], 10_000), undefined, "idle sessions pay zero tokens");

  const line = asyncStateLine([makeSnapshot({ taskId: "t1", name: "build", status: "running", startedAt: 0 })], 65_000);
  assert.ok(line);
  assert.match(line, /^<async-state>1 async task\(s\) active: /);
  assert.match(line, /build \(running, 1m 5s\)/);
  assert.match(line, /completion notification wakes you/);
  assert.match(line, /async_wait/);
});

test("asyncStateLine collapses overflow into +K more", () => {
  const tasks = Array.from({ length: 7 }, (_, index) => makeSnapshot({ taskId: `t${index}`, name: `job${index}`, status: "running", startedAt: 0 }));
  const line = asyncStateLine(tasks, 5_000, 5);
  assert.ok(line);
  assert.match(line, /^<async-state>7 async task\(s\) active: /);
  assert.match(line, /job4 \(running, 5s\)/);
  assert.doesNotMatch(line, /job5/, "only max rows are listed");
  assert.match(line, /\+2 more/);
});

test("asyncStateLine only claims a wake-up for tasks that will actually notify", () => {
  const wakes = makeSnapshot({ taskId: "a", name: "build", status: "running", startedAt: 0 });
  const quiet = makeSnapshot({ taskId: "b", name: "ci", status: "running", startedAt: 0, metadata: { notifyOnCompletion: false } });
  const noTurn = makeSnapshot({ taskId: "c", name: "lint", status: "running", startedAt: 0, metadata: { triggerOnCompletion: false } });

  const allWake = asyncStateLine([wakes], 1_000);
  assert.match(allWake ?? "", /end the turn and the completion notification wakes you/);
  assert.doesNotMatch(allWake ?? "", /no-notify/);

  const mixed = asyncStateLine([wakes, quiet, noTurn], 1_000);
  assert.match(mixed ?? "", /ci \(running, 1s, no-notify\)/, "the quiet task is marked, not silently trusted");
  assert.match(mixed ?? "", /lint \(running, 1s, no-notify\)/);
  assert.match(mixed ?? "", /wake you where enabled, or call async_wait for the rest/);

  const none = asyncStateLine([quiet], 1_000);
  assert.match(none ?? "", /none of these will notify you; collect them with async_wait/);
  assert.doesNotMatch(none ?? "", /wakes you/, "never promise a wake-up that cannot happen");
});

test("registerNudges appends the bash nudge and preserves structuredContent", () => {
  withSwitch(undefined, () => {
    const { pi, fireOne } = makePi();
    const dispose = registerNudges(pi as never, makeRegistry(() => []));
    try {
      const event: ToolResultEvent = {
        toolName: "bash",
        input: { command: "npm run build" },
        content: [{ type: "text", text: "build ok" }],
        structuredContent: { exit_code: 0, wall_time_seconds: 185 },
      };
      const result = fireOne("tool_result", event) as { content: Array<{ text: string }>; structuredContent?: unknown } | undefined;
      assert.ok(result, "a long bash call returns a replacement result");
      assert.equal(result.content.length, 2);
      assert.equal(result.content[0]?.text, "build ok", "the original content is preserved");
      assert.match(result.content[1]?.text ?? "", /took 185s in the foreground/);
      assert.deepEqual(result.structuredContent, event.structuredContent, "structuredContent survives the content rewrite");
    } finally {
      dispose();
    }
  });
});

test("registerNudges measures the call when the host drops structuredContent", () => {
  withSwitch(undefined, () => {
    const { pi, fireOne } = makePi();
    const dispose = registerNudges(pi as never, makeRegistry(() => []));
    const realNow = Date.now;
    try {
      // tool_result fires before tool_execution_end, so the fallback clock is the start event.
      fireOne("tool_execution_start", { toolCallId: "call-1", toolName: "bash" });
      Date.now = () => realNow() + 61_000;
      const result = fireOne("tool_result", {
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "npm run build" },
        content: [{ type: "text", text: "ok" }],
      }) as { content: Array<{ text: string }> } | undefined;
      Date.now = realNow;
      assert.ok(result, "a slow call with no structuredContent still gets the nudge");
      assert.match(result.content.at(-1)?.text ?? "", /took 61s in the foreground/);
    } finally {
      Date.now = realNow;
      dispose();
    }
  });
});

test("registerNudges leaves quick commands and non-bash tools untouched", () => {
  withSwitch(undefined, () => {
    const { pi, fireOne } = makePi();
    const dispose = registerNudges(pi as never, makeRegistry(() => []));
    try {
      assert.equal(fireOne("tool_result", { toolName: "bash", input: { command: "ls" }, content: [], structuredContent: { wall_time_seconds: 2 } }), undefined);
      assert.equal(fireOne("tool_result", { toolName: "read", input: { path: "x" }, content: [] }), undefined);
      // A hostile event shape must never escape as a thrown error.
      assert.equal(fireOne("tool_result", undefined), undefined);
    } finally {
      dispose();
    }
  });
});

test("registerNudges injects the state line once per live-set change and re-arms on agent_start", () => {
  withSwitch(undefined, () => {
    let tasks = [makeSnapshot({ taskId: "t1", name: "server", status: "running", startedAt: Date.now() - 12_000 })];
    const { pi, fireOne } = makePi();
    const dispose = registerNudges(pi as never, makeRegistry(() => tasks));
    try {
      const first = fireOne("context_with_system", { messages: [{ role: "user", content: "hi" }] }) as { messages: Array<{ role: string; content: string; timestamp?: number }> } | undefined;
      assert.ok(first, "an active task injects a state line");
      assert.equal(first.messages.length, 2, "the host messages are preserved in front");
      assert.match(first.messages[1]?.content ?? "", /^<async-state>1 async task\(s\) active: server/);
      assert.equal(first.messages[1]?.role, "user");
      assert.equal(typeof first.messages[1]?.timestamp, "number", "a UserMessage without a timestamp is malformed (pi-ai type)");

      assert.equal(fireOne("context_with_system", { messages: [] }), undefined, "unchanged state is not repeated");

      tasks = [...tasks, makeSnapshot({ taskId: "t2", name: "build", status: "pending", createdAt: Date.now() })];
      const changed = fireOne("context_with_system", { messages: [] }) as { messages: Array<{ content: string }> } | undefined;
      assert.match(changed?.messages[0]?.content ?? "", /2 async task\(s\) active/, "a new task re-injects");

      fireOne("agent_start");
      assert.ok(fireOne("context_with_system", { messages: [] }), "a new run re-arms the line even when state is unchanged");

      tasks = [];
      assert.equal(fireOne("context_with_system", { messages: [] }), undefined, "idle → nothing injected");
    } finally {
      dispose();
    }
  });
});

test("PI_ASYNC_NUDGE=0 registers nothing, and dispose releases every hook", () => {
  withSwitch("0", () => {
    const { pi, handlers } = makePi();
    const dispose = registerNudges(pi as never, makeRegistry(() => [makeSnapshot()]));
    assert.equal(handlers.size, 0, "the switch disarms every nudge");
    dispose();
    assert.equal(handlers.size, 0);
  });

  withSwitch(undefined, () => {
    const { pi, handlers } = makePi();
    const dispose = registerNudges(pi as never, makeRegistry(() => []));
    assert.equal(handlers.size, 6, "tool_execution_start + tool_execution_end + tool_result + context_with_system + context + agent_start");
    dispose();
    assert.equal(handlers.size, 0, "dispose unsubscribes every hook");
    assert.doesNotThrow(() => dispose(), "dispose is idempotent");
  });
});
