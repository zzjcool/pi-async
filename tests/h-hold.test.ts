import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../extensions/index.ts";
import { registerHold } from "../src/guard/hold.ts";
import { isTerminal, type TaskSnapshot } from "../src/core/task.ts";
import { makeSnapshot } from "./helpers/index.ts";

type Handler = (...args: unknown[]) => unknown;

/** Fake pi host: `on` returns an unsubscribe function and records handlers in registration order. */
function makePi(extra: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const unsubscribed: string[] = [];
  let onCalls = 0;
  const pi: Record<string, unknown> = {
    on(event: string, handler: Handler): () => void {
      onCalls++;
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        unsubscribed.push(event);
        const current = handlers.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) handlers.delete(event);
      };
    },
  };
  // Descriptors (not spread) so a host accessor such as `get ui()` stays lazy and can go stale.
  Object.defineProperties(pi, Object.getOwnPropertyDescriptors(extra));
  const fire = (event: string, ...args: unknown[]): unknown[] => (handlers.get(event) ?? []).map((handler) => handler(...args));
  const fireOne = (event: string, ...args: unknown[]): unknown => fire(event, ...args)[0];
  return { pi, handlers, unsubscribed, fire, fireOne, onCalls: () => onCalls };
}

/** ~9 KiB of text a hold must never inline into the results entry (D-6). */
const OUTPUT_TAIL_MARKER = "<8KiB-output-tail-marker>";

/**
 * Fake registry: `list()` returns whatever the callback says and counts the reads.
 *
 * `includeHistory: false` drops terminal rows exactly like the real registry
 * (`src/core/registry.ts:619`) — the hold relies on that to see "all terminal" as an empty list.
 *
 * The delivery/consumption API is spied on purpose: the hold must never call
 * `wait` / `consume` / `claimNotification` (D-7), and `logs` hands back a marker that must never
 * show up in the results entry (D-6 forbids inlining output tails).
 */
function makeRegistry(next: () => TaskSnapshot[]) {
  let calls = 0;
  const spyCalls = { wait: 0, consume: 0, claimNotification: 0, logs: 0 };
  return {
    list: (opts: { includeHistory?: boolean } = {}) => {
      calls++;
      const rows = next();
      return opts.includeHistory === false ? rows.filter((task) => !isTerminal(task.status)) : rows;
    },
    calls: () => calls,
    spyCalls,
    wait: () => {
      spyCalls.wait++;
      return Promise.resolve({ results: [] });
    },
    consume: () => {
      spyCalls.consume++;
    },
    claimNotification: () => {
      spyCalls.claimNotification++;
      return true;
    },
    logs: () => {
      spyCalls.logs++;
      return { text: OUTPUT_TAIL_MARKER.repeat(400), truncated: false };
    },
  };
}

/** Registry whose `list()` walks `sequence` (the last entry repeats) — one poll step per call. */
function sequenceRegistry(sequence: TaskSnapshot[][]) {
  let index = 0;
  return makeRegistry(() => sequence[Math.min(index++, sequence.length - 1)]);
}

const running = (taskId: string, metadata: Record<string, unknown> = {}) =>
  makeSnapshot({ taskId, status: "running", metadata });
const completed = (taskId: string) => makeSnapshot({ taskId, status: "completed" });

type EnvName = "PI_ASYNC_HOLD" | "PI_ASYNC_HOLD_MS" | "PI_ASYNC_HOLD_POLL_MS" | "PI_LEGION_NODE_ID";

/** Hold knobs off by default, so an ambient value in the developer shell cannot change a test. */
const CLEAN: Partial<Record<EnvName, string | undefined>> = {
  PI_ASYNC_HOLD: undefined,
  PI_ASYNC_HOLD_MS: undefined,
  PI_ASYNC_HOLD_POLL_MS: undefined,
  PI_LEGION_NODE_ID: undefined,
};

/**
 * Runs `fn` with the hold env knobs applied (undefined deletes the variable) and restores every
 * one of them afterwards. Async-aware because the hold reads `PI_LEGION_NODE_ID` at handler time.
 */
async function withEnv<T>(env: Partial<Record<EnvName, string | undefined>>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<EnvName, string | undefined>();
  for (const name of Object.keys(env) as EnvName[]) {
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

/** D-6: the hold returns nothing at all — never `entries`, never `continue`. */
function assertBareResult(result: unknown): void {
  assert.equal(result, undefined, "the hold resolves to undefined (no entries, no continue)");
}

/**
 * D-6 normal path (修订 1 / F2a): one `async-task-settle-results` draft plus `continue: true`.
 * Returns the draft so the caller can assert the frozen content shape.
 */
function assertResultsResult(result: unknown): { type?: string; customType?: string; content?: string; display?: boolean } {
  assert.ok(result !== null && typeof result === "object", "the normal path returns a result object");
  const shape = result as { entries?: unknown[]; continue?: unknown };
  assert.equal(shape.continue, true, "the normal path forces one more provider request");
  const entries = Array.isArray(shape.entries) ? shape.entries : [];
  const draft = (entries.at(-1) ?? undefined) as { type?: string; customType?: string; content?: string; display?: boolean } | undefined;
  assert.equal(draft?.type, "custom_message");
  assert.equal(draft?.customType, "async-task-settle-results");
  assert.equal(draft?.display, false);
  return draft!;
}

/** Collects `ui.setStatus` calls from a TUI-ish ctx. */
function makeCtx(statuses: Array<[string, string | undefined]> = []) {
  return {
    ctx: { mode: "tui", ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) } },
    statuses,
  };
}

const holdTexts = (statuses: Array<[string, string | undefined]>): Array<string | undefined> =>
  statuses.filter(([key]) => key === "pi-async-hold").map(([, value]) => value);

test("PI_ASYNC_HOLD=0 registers nothing and the disposer stays idempotent", async () => {
  await withEnv({ ...CLEAN, PI_ASYNC_HOLD: "0" }, () => {
    const { pi, onCalls } = makePi();
    const registry = makeRegistry(() => [running("A")]);
    const dispose = registerHold(pi as never, registry as never, { holdMs: 80, pollMs: 10 });
    assert.equal(onCalls(), 0, "D-2: no handler at all when the switch is 0");
    assert.equal(registry.calls(), 0);
    assert.doesNotThrow(() => {
      dispose();
      dispose();
    });
  });
});

test("PI_ASYNC_HOLD_MS <= 0 disarms the hold (a negative value is not the default)", async () => {
  for (const budget of ["0", "-1"]) {
    await withEnv({ ...CLEAN, PI_ASYNC_HOLD_MS: budget }, () => {
      const { pi, onCalls } = makePi();
      const dispose = registerHold(pi as never, makeRegistry(() => [running("A")]) as never);
      assert.equal(onCalls(), 0, `D-5 (修订 2): PI_ASYNC_HOLD_MS=${budget} registers nothing`);
      assert.doesNotThrow(() => dispose());
    });
  }
});

test("a legion child never holds (its own bounded reminder channel owns that run)", async () => {
  await withEnv({ ...CLEAN, PI_LEGION_NODE_ID: "legion-child" }, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry(() => [running("A")]);
    registerHold(pi as never, registry as never, { holdMs: 500, pollMs: 50 });
    const startedAt = performance.now();
    const result = await fireOne("agent_before_settle", { entries: [] }, { mode: "tui" });
    assertBareResult(result);
    assert.equal(registry.calls(), 0, "the gate returns before any liveness read");
    assert.ok(performance.now() - startedAt < 100, "returned immediately, no sleep");
  });
});

test("print and json modes never hold, while a missing ctx may hold", async () => {
  await withEnv(CLEAN, async () => {
    for (const mode of ["print", "json"]) {
      const { pi, fireOne } = makePi();
      const registry = makeRegistry(() => [running("A")]);
      registerHold(pi as never, registry as never, { holdMs: 500, pollMs: 50 });
      const startedAt = performance.now();
      const result = await fireOne("agent_before_settle", { entries: [] }, { mode });
      assertBareResult(result);
      assert.equal(registry.calls(), 0, `${mode}: no liveness read`);
      assert.ok(performance.now() - startedAt < 100, `${mode}: must not delay the process exit`);
    }

    // D-3 #3: an old host / mock without a ctx is NOT a reason to skip the hold. A task that never
    // finishes keeps this on the timeout path, so the assertion is about waiting, not about results.
    const { pi, fireOne } = makePi();
    const registry = makeRegistry(() => [running("A")]);
    registerHold(pi as never, registry as never, { holdMs: 50, pollMs: 10 });
    const startedAt = performance.now();
    const result = await fireOne("agent_before_settle");
    assertBareResult(result);
    assert.ok(registry.calls() >= 2, "an absent ctx still polls the registry");
    assert.ok(performance.now() - startedAt >= 40, "an absent ctx still holds");
  });
});

test("fire-and-forget tasks (no notify / no trigger) never hold", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry(() => [
      running("dev-server", { notifyOnCompletion: false }),
      running("quiet-worker", { triggerOnCompletion: false }),
    ]);
    registerHold(pi as never, registry as never, { holdMs: 500, pollMs: 50 });
    const startedAt = performance.now();
    const result = await fireOne("agent_before_settle", { entries: [] }, { mode: "tui" });
    assertBareResult(result);
    assert.equal(registry.calls(), 1, "only the opening snapshot is read");
    assert.ok(performance.now() - startedAt < 100, "D-4: nothing wakeable to wait for");
  });
});

test("the hold ends when the snapshot is terminal and hands the results back to the transcript", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = sequenceRegistry([
      [running("A"), makeSnapshot({ taskId: "B", status: "pending" })],
      [completed("A"), completed("B")],
    ]);
    const { ctx, statuses } = makeCtx();
    registerHold(pi as never, registry as never, { holdMs: 500, pollMs: 10 });

    const startedAt = performance.now();
    const result = await fireOne("agent_before_settle", { entries: [] }, ctx);
    const elapsed = performance.now() - startedAt;

    // D-6 (修订 1 / F2a): a terminal snapshot now carries the outcome plus `continue: true`.
    const draft = assertResultsResult(result);
    assert.match(String(draft.content), /^Held the turn for 1 async task\(s\); all finished: /);
    assert.equal(registry.calls(), 3, "opening snapshot + one poll + one history read for the results");
    assert.ok(elapsed < 300, `resolved as soon as the tasks were terminal (${elapsed}ms)`);
    const texts = holdTexts(statuses);
    assert.match(String(texts[0]), /^waiting for 1 task \d+s$/, "footer counts the running snapshot");
    assert.equal(texts.at(-1), undefined, "the footer is cleared when the hold ends");
  });
});

test("the wait is bounded by holdMs when a task never finishes", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = makeRegistry(() => [running("A")]);
    const { ctx, statuses } = makeCtx();
    registerHold(pi as never, registry as never, { holdMs: 80, pollMs: 10 });

    const startedAt = performance.now();
    const result = await fireOne("agent_before_settle", { entries: [] }, ctx);
    const elapsed = performance.now() - startedAt;

    assertBareResult(result);
    assert.ok(elapsed >= 75, `held for the budget (${elapsed}ms)`);
    assert.ok(elapsed < 80 + 10 + 300, `never much past holdMs + one poll (${elapsed}ms)`);
    assert.equal(holdTexts(statuses).at(-1), undefined);
  });
});

test("one hold per run, re-armed by agent_start", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fire, fireOne } = makePi();
    const registry = makeRegistry(() => [running("A")]);
    const { ctx } = makeCtx();
    registerHold(pi as never, registry as never, { holdMs: 60, pollMs: 10 });

    await fireOne("agent_before_settle", { entries: [] }, ctx);

    const secondStart = performance.now();
    assertBareResult(await fireOne("agent_before_settle", { entries: [] }, ctx));
    assert.ok(performance.now() - secondStart < 30, "the second boundary in the same run does not wait");

    fire("agent_start");
    const thirdStart = performance.now();
    assertBareResult(await fireOne("agent_before_settle", { entries: [] }, ctx));
    assert.ok(performance.now() - thirdStart >= 50, "agent_start re-arms the hold");
  });
});

test("a registry that throws (suspended/shut down) never throws out of the handler", async () => {
  await withEnv(CLEAN, async () => {
    // Throws on the opening snapshot.
    const { pi, fireOne } = makePi();
    registerHold(pi as never, { list: () => { throw new Error("registry suspended"); } } as never, { holdMs: 80, pollMs: 10 });
    assertBareResult(await fireOne("agent_before_settle", { entries: [] }, { mode: "tui" }));

    // Throws while polling: the hold stops immediately instead of waiting out the budget.
    const second = makePi();
    const { ctx, statuses } = makeCtx();
    let calls = 0;
    const registry = {
      list: () => {
        calls++;
        if (calls === 1) return [running("A")];
        throw new Error("registry shut down");
      },
    };
    registerHold(second.pi as never, registry as never, { holdMs: 500, pollMs: 10 });
    const startedAt = performance.now();
    const result = await second.fireOne("agent_before_settle", { entries: [] }, ctx);
    assertBareResult(result);
    assert.ok(performance.now() - startedAt < 300, "a throwing poll ends the hold instead of retrying");
    assert.equal(holdTexts(statuses).at(-1), undefined, "the footer is still cleared");
  });
});

test("a throwing setStatus or stale ui getter never breaks register, the handler or dispose", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = sequenceRegistry([[running("A")], [completed("A")]]);
    registerHold(pi as never, registry as never, { holdMs: 200, pollMs: 10 });
    const result = await fireOne("agent_before_settle", { entries: [] }, {
      mode: "tui",
      ui: { setStatus: () => { throw new Error("host rejected setStatus"); } },
    });
    assertResultsResult(result);
  });

  await withEnv(CLEAN, () => {
    // Regression style of tests/a-settle-guard.test.ts:112-130: after /reload the captured ctx is
    // stale and `ctx.ui` throws on access — that must never surface from our hooks.
    const { pi, fireOne } = makePi();
    const registry = sequenceRegistry([[running("A")], [completed("A")]]);
    let dispose: (() => void) | undefined;
    assert.doesNotThrow(() => {
      dispose = registerHold(pi as never, registry as never, { holdMs: 80, pollMs: 10 });
    });
    const staleCtx = {
      mode: "tui",
      get ui(): never {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    };
    let pending: Promise<unknown> | undefined;
    assert.doesNotThrow(() => {
      pending = fireOne("agent_before_settle", { entries: [] }, staleCtx) as Promise<unknown>;
    });
    return pending!.then((result) => {
      assertResultsResult(result);
      assert.doesNotThrow(() => dispose!());
    });
  });
});

test("init registers the hold before the settle guard on agent_before_settle", async () => {
  await withEnv(CLEAN, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-async-hold-order-"));
    const handlers = new Map<string, Handler[]>();
    const pi: Record<string, unknown> = {
      on: (event: string, handler: Handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {
          const current = handlers.get(event) ?? [];
          const index = current.indexOf(handler);
          if (index >= 0) current.splice(index, 1);
        };
      },
      sessionManager: { getSessionDir: () => dir, getSessionId: () => "hold-order" },
    };
    try {
      await init(pi as never);
      const beforeSettle = handlers.get("agent_before_settle") ?? [];
      assert.equal(beforeSettle.length, 2, "hold + guard both listen on the boundary");
      // The hold handler is async (it may sleep); the guard's is sync. Order = registration order.
      const first = beforeSettle[0]({ entries: [] }, { mode: "tui" });
      assert.ok(first instanceof Promise, "the hold is registered before the settle guard");
      assert.equal(beforeSettle[1]({ entries: [] }), undefined, "the guard runs after the hold, unchanged");
      assertBareResult(await first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("delayed/pending tasks never hold, and a mixed snapshot only waits for the running one", async () => {
  await withEnv(CLEAN, async () => {
    const delayed = () => makeSnapshot({ taskId: "D", status: "pending" });

    // D-4 (修订 1 / F1): `pending` is not holdable — its `dueAt` may be arbitrarily far away, so
    // counting it would burn the whole budget on every turn end.
    const { pi, fireOne } = makePi();
    const onlyPending = makeRegistry(() => [delayed()]);
    registerHold(pi as never, onlyPending as never, { holdMs: 300, pollMs: 10 });
    const startedAt = performance.now();
    assertBareResult(await fireOne("agent_before_settle", { entries: [] }, { mode: "tui" }));
    assert.equal(onlyPending.calls(), 1, "one snapshot read, no polling");
    assert.ok(performance.now() - startedAt < 100, "a pending-only turn never holds");

    // Mixed: only the running task joins the snapshot, so the hold ends the moment it finishes.
    const second = makePi();
    const mixed = sequenceRegistry([
      [running("A"), delayed()],
      [delayed()],
      [{ ...makeSnapshot({ taskId: "A", name: "build", status: "completed", exitCode: 0 }) }],
    ]);
    const { ctx } = makeCtx();
    registerHold(second.pi as never, mixed as never, { holdMs: 500, pollMs: 10 });
    const mixedStart = performance.now();
    const draft = assertResultsResult(await second.fireOne("agent_before_settle", { entries: [] }, ctx));
    assert.equal(mixed.calls(), 3, "snapshot + poll + history");
    assert.ok(performance.now() - mixedStart < 300, "the pending task does not stretch the hold");
    assert.match(String(draft.content), /^Held the turn for 1 async task\(s\); all finished: build \(completed, exit 0\)\./);
    assert.ok(!String(draft.content).includes("pending"), "the delayed task never appears as a result");
  });
});

test("the results entry carries status and exit code but never an output tail", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    const registry = sequenceRegistry([
      [running("A"), { ...running("B"), name: "lint" }],
      [
        { ...makeSnapshot({ taskId: "A", name: "build", status: "completed", exitCode: 0 }) },
        { ...makeSnapshot({ taskId: "B", name: "lint", status: "failed", exitCode: 1 }) },
      ],
    ]);
    const { ctx } = makeCtx();
    registerHold(pi as never, registry as never, { holdMs: 500, pollMs: 10 });

    const incoming = [{ type: "custom_message", customType: "pre-existing", content: "keep me" }];
    const result = (await fireOne("agent_before_settle", { entries: incoming }, ctx)) as { entries: unknown[] };
    const draft = assertResultsResult(result);
    assert.deepEqual(result.entries.slice(0, 1), incoming, "drafts pi already queued stay in front");

    const content = String(draft.content);
    // 修订 2 / D-10 #13: the real `list({includeHistory:true})` orders rows by finishedAt desc, so
    // the test asserts the set of lines plus the fixed frame — never a fixed insertion order.
    assert.match(content, /^Held the turn for 2 async task\(s\); all finished: /);
    assert.match(content, / Read the output with async_logs before answering\.$/);
    const items = content
      .replace(/^Held the turn for 2 async task\(s\); all finished: /, "")
      .replace(/\. Read the output with async_logs before answering\.$/, "")
      .split(" · ")
      .sort();
    assert.deepEqual(items, ["build (completed, exit 0)", "lint (failed, exit 1)"].sort(), "both terminal lines, order-free");
    assert.ok(content.length < 400, "no output tail is inlined");
    assert.ok(!content.includes(OUTPUT_TAIL_MARKER), "the 8 KiB tail never reaches the entry");
    assert.equal(registry.spyCalls.logs, 0, "D-6: the hold never reads task output");
  });
});

test("only a tui ctx holds — rpc behaves like print/json", async () => {
  await withEnv(CLEAN, async () => {
    // D-3 #3 (修订 1 / F3): an rpc abort has a client-side timeout, so never hold there.
    const rpc = makePi();
    const rpcRegistry = makeRegistry(() => [running("A")]);
    registerHold(rpc.pi as never, rpcRegistry as never, { holdMs: 500, pollMs: 50 });
    const rpcStart = performance.now();
    assertBareResult(await rpc.fireOne("agent_before_settle", { entries: [] }, { mode: "rpc" }));
    assert.equal(rpcRegistry.calls(), 0, "rpc: no liveness read");
    assert.ok(performance.now() - rpcStart < 100, "rpc: no delay");

    // A tui ctx still holds, and the terminal snapshot hands the results back.
    const tui = makePi();
    const tuiRegistry = sequenceRegistry([[running("A")], [completed("A")]]);
    registerHold(tui.pi as never, tuiRegistry as never, { holdMs: 500, pollMs: 10 });
    const tuiStart = performance.now();
    assertResultsResult(await tui.fireOne("agent_before_settle", { entries: [] }, { mode: "tui" }));
    assert.ok(tuiRegistry.calls() >= 2, "tui: the hold polls");
    assert.ok(performance.now() - tuiStart >= 5, "tui: it really waited for a poll");
  });
});

test("footerRefreshMs pins the refresh cadence and singularizes one task", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, fireOne } = makePi();
    // Never finishing, so the footer keeps ticking for the whole (short) budget. `formatElapsedMs`
    // floors to whole seconds, so observing a non-zero elapsed in the text needs a >1s hold.
    const registry = makeRegistry(() => [running("solo")]);
    const { ctx, statuses } = makeCtx();
    registerHold(pi as never, registry as never, { holdMs: 1250, pollMs: 25, footerRefreshMs: 10 });

    assertBareResult(await fireOne("agent_before_settle", { entries: [] }, ctx));

    const texts = holdTexts(statuses);
    assert.equal(texts[0], "waiting for 1 task 0s", "entering the hold prints the singular form");
    const ticked = texts.filter((text) => /^waiting for 1 task [1-9]\d*s$/.test(String(text)));
    assert.ok(ticked.length >= 2, `at least two refreshes show a non-zero elapsed (got ${ticked.length})`);
    assert.equal(texts.at(-1), undefined, "the footer is cleared when the hold ends");
  });
});

test("dispose after session_shutdown short-circuits the handler and never consumes output", async () => {
  await withEnv(CLEAN, async () => {
    const { pi, handlers, fire } = makePi();
    const registry = sequenceRegistry([[running("A")], [completed("A")]]);
    const { ctx } = makeCtx();
    registerHold(pi as never, registry as never, { holdMs: 500, pollMs: 10 });

    // A real hold first: it must not touch the delivery/consumption API (D-7).
    const settleHandler = (handlers.get("agent_before_settle") ?? [])[0]!;
    assertResultsResult(await settleHandler({ entries: [] }, ctx));
    assert.deepEqual(registry.spyCalls, { wait: 0, consume: 0, claimNotification: 0, logs: 0 });

    fire("session_shutdown");
    const callsBefore = registry.calls();
    const startedAt = performance.now();
    const result = await settleHandler({ entries: [] }, ctx);
    assertBareResult(result);
    assert.ok(performance.now() - startedAt < 30, "D-3 #1: no sleep after dispose");
    assert.equal(registry.calls(), callsBefore, "no liveness read after dispose");
    assert.deepEqual(registry.spyCalls, { wait: 0, consume: 0, claimNotification: 0, logs: 0 });
  });
});

test("a second running task keeps the hold alive after the first one finishes", async () => {
  await withEnv(CLEAN, async () => {
    // 修订 2 / D-10 #17: A finishes after the first poll and B keeps running for three more polls.
    // Any heuristic that ends the hold when "a task finished while the queue looks empty" (the
    // deleted F2b probe) stops on the fourth list call and throws away both the results entry and
    // `continue`; the loop must wait for B.
    const { pi, fireOne } = makePi();
    const registry = sequenceRegistry([
      [running("A"), { ...running("B"), name: "second" }],       // opening snapshot
      [running("A"), { ...running("B"), name: "second" }],       // poll 1: nothing done
      [{ ...running("B"), name: "second" }],                     // poll 2: A finished
      [{ ...running("B"), name: "second" }],                     // poll 3: B still running
      [{ ...running("B"), name: "second" }],                     // poll 4: B still running
      [],                                                         // poll 5: B finished
      [{ ...makeSnapshot({ taskId: "A", name: "first", status: "completed", exitCode: 0 }) },
       { ...makeSnapshot({ taskId: "B", name: "second", status: "completed", exitCode: 0 }) }],
    ]);
    // What the real host reports on the normal path: a completion queued during the hold lands on
    // `agent.followUpQueue`, which `hasPendingMessages` does NOT count (`agent-session.js:1877` vs
    // `:1924-1926`). Keeping the probe here (value `false`, as on the real normal path) means
    // re-adding an early-exit heuristic makes this case fail instead of passing on an absent probe.
    const ctx = { mode: "tui", hasPendingMessages: () => false, ui: { setStatus: () => undefined } };
    registerHold(pi as never, registry as never, { holdMs: 5000, pollMs: 20 });

    const startedAt = performance.now();
    const result = (await fireOne("agent_before_settle", { entries: [] }, ctx)) as { entries: unknown[] };
    const elapsed = performance.now() - startedAt;

    const draft = assertResultsResult(result);
    // The structural proof: snapshot + five polls + one history read. Stopping at "A finished with
    // an empty queue" would have produced four calls and no results draft at all.
    assert.equal(registry.calls(), 7, "snapshot + five polls + history; it waited for B");
    // Five polls of 20ms each, i.e. it did not return when A finished after the first one.
    assert.ok(elapsed >= 80, `the hold covered all five polls (${elapsed}ms)`);
    assert.ok(elapsed < 2000, `and ended on B, not on the budget (${elapsed}ms)`);
    const content = String(draft.content);
    assert.match(content, /^Held the turn for 2 async task\(s\); all finished: /);
    assert.ok(content.includes("first (completed, exit 0)"), "A is reported");
    assert.ok(content.includes("second (completed, exit 0)"), "B is reported, so it really waited");
  });
});

test("a results entry never claims a status it could not read", async () => {
  await withEnv(CLEAN, async () => {
    // History rows gone (pruned / registry cannot answer): the entry must not echo the opening
    // snapshot's `status: "running"` as if it were a result (修订 2 / D-6).
    const { pi, fireOne } = makePi();
    let live = [running("A")];
    const prunedRegistry = {
      list: (opts: { includeHistory?: boolean } = {}) => {
        if (opts.includeHistory === true) return [];
        const rows = live;
        live = [];
        return rows;
      },
    };
    registerHold(pi as never, prunedRegistry as never, { holdMs: 500, pollMs: 10 });
    const pruned = (await fireOne("agent_before_settle", { entries: [] }, makeCtx().ctx)) as { entries: unknown[] };
    const prunedDraft = assertResultsResult(pruned);
    assert.equal(
      String(prunedDraft.content),
      "Held the turn for 1 async task(s); they finished (records pruned). Read the output with async_logs before answering.",
    );
    assert.ok(!String(prunedDraft.content).includes("running"), "no fake terminal status");

    // Partial history: only the rows that really exist are listed, with a status-free note.
    const partial = makePi();
    let livePartial = [running("A"), running("B")];
    const partialRegistry = {
      list: (opts: { includeHistory?: boolean } = {}) => {
        if (opts.includeHistory === true) {
          return [makeSnapshot({ taskId: "A", name: "first", status: "completed", exitCode: 0 })];
        }
        const rows = livePartial;
        livePartial = [];
        return rows;
      },
    };
    registerHold(partial.pi as never, partialRegistry as never, { holdMs: 500, pollMs: 10 });
    const kept = (await partial.fireOne("agent_before_settle", { entries: [] }, makeCtx().ctx)) as { entries: unknown[] };
    const keptDraft = assertResultsResult(kept);
    assert.equal(
      String(keptDraft.content),
      "Held the turn for 2 async task(s); all finished: first (completed, exit 0) (records pruned for the rest). " +
        "Read the output with async_logs before answering.",
    );
    assert.ok(!String(keptDraft.content).includes("running"), "no fake terminal status");
  });
});
