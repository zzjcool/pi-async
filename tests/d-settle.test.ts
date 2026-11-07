import assert from "node:assert/strict";
import test from "node:test";
import { SettleGuard } from "../src/guard/settle-guard.ts";
import { makeSnapshot } from "./helpers/index.ts";

type Handler = (...args: unknown[]) => unknown;
type Draft = { type?: string; customType?: string; content?: string; display?: boolean };
type BeforeSettleResult = { entries?: Draft[]; continue?: boolean };

/** Fake pi host: `on` returns an unsubscribe function and records every handler it registered. */
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

function makeRegistry(overrides: { tasks?: () => ReturnType<typeof makeSnapshot>[]; hasActiveWork?: () => boolean } = {}) {
  const tasks = overrides.tasks ?? (() => [makeSnapshot({ taskId: "pending-1" })]);
  return {
    list: () => tasks(),
    activeCount: () => {
      const all = tasks();
      return { running: all.filter((task) => task.status === "running").length, pending: all.filter((task) => task.status === "pending").length };
    },
    hasActiveWork: overrides.hasActiveWork ?? (() => tasks().length > 0),
  };
}

/** Runs `fn` with PI_LEGION_NODE_ID set (or deleted when `value` is undefined), then restores it. */
function withNodeId<T>(value: string | undefined, fn: () => T): T {
  const previousNode = process.env.PI_LEGION_NODE_ID;
  const previousSwitch = process.env.PI_ASYNC_SETTLE_GUARD;
  if (value === undefined) delete process.env.PI_LEGION_NODE_ID;
  else process.env.PI_LEGION_NODE_ID = value;
  try {
    return fn();
  } finally {
    if (previousNode === undefined) delete process.env.PI_LEGION_NODE_ID;
    else process.env.PI_LEGION_NODE_ID = previousNode;
    if (previousSwitch === undefined) delete process.env.PI_ASYNC_SETTLE_GUARD;
    else process.env.PI_ASYNC_SETTLE_GUARD = previousSwitch;
  }
}

const legion = <T>(fn: () => T): T => withNodeId("test-node", fn);

test("settle guard stays silent when idle and resets the reminder budget afterwards", () => {
  legion(() => {
    let tasks: ReturnType<typeof makeSnapshot>[] = [];
    const { pi, fireOne } = makePi();
    new SettleGuard(pi as never, makeRegistry({ tasks: () => tasks }) as never).register();
    const beforeSettle = () => fireOne("agent_before_settle", { entries: [] }) as BeforeSettleResult | undefined;

    assert.deepEqual(beforeSettle(), undefined, "no active work → no drafts at all");
    tasks = [makeSnapshot({ taskId: "pending-1" })];
    for (let i = 0; i < 3; i++) beforeSettle();
    assert.equal(beforeSettle()?.entries?.at(-1)?.customType, "async-task-unresolved", "the budget was spent");

    tasks = [];
    assert.deepEqual(beforeSettle(), undefined, "going idle returns undefined instead of a draft");
    tasks = [makeSnapshot({ taskId: "pending-1" })];
    const refreshed = beforeSettle();
    assert.equal(refreshed?.continue, true, "the idle pass reset the budget, so reminders resume");
    assert.equal(refreshed?.entries?.length, 1);
  });
});

test("settle guard appends custom_message reminders, then one unresolved entry without continue", () => {
  legion(() => {
    const tasks = [makeSnapshot({ taskId: "pending-1" })];
    const { pi, fireOne } = makePi();
    new SettleGuard(pi as never, makeRegistry({ tasks: () => tasks }) as never).register();
    const beforeSettle = () => fireOne("agent_before_settle", { entries: [] }) as BeforeSettleResult | undefined;

    for (let i = 1; i <= 3; i++) {
      const result = beforeSettle();
      assert.equal(result?.continue, true, `reminder ${i} asks for another provider request`);
      const draft = result?.entries?.at(-1);
      assert.equal(draft?.type, "custom_message");
      assert.equal(draft?.customType, "async-task-settle-reminder");
      assert.equal(draft?.display, false, "reminders never render in the transcript");
      assert.match(String(draft?.content), /pending-1/, "the reminder names the task ids");
      assert.match(String(draft?.content), /async_wait/);
    }

    const fourth = beforeSettle();
    assert.ok(fourth, "the budget-exhausted call still returns entries");
    assert.equal("continue" in fourth, false, "no `continue` once the budget is spent");
    const unresolved = fourth.entries?.at(-1);
    assert.equal(unresolved?.type, "custom_message");
    assert.equal(unresolved?.customType, "async-task-unresolved");
    assert.equal(unresolved?.display, false);
    assert.match(String(unresolved?.content), /pending-1/, "the unresolved entry names the task ids");
    assert.deepEqual(Object.keys(fourth).sort(), ["entries"], "the result carries entries and nothing else");
  });
});

test("settle guard keeps the drafts pi already queued in front of its own entry", () => {
  legion(() => {
    const existing = { type: "custom_message", customType: "host-draft", content: "keep me", display: true };
    const { pi, fireOne } = makePi();
    new SettleGuard(pi as never, makeRegistry() as never).register();
    const result = fireOne("agent_before_settle", { entries: [existing] }) as BeforeSettleResult;

    assert.equal(result.entries?.length, 2, "1 appended draft on top of the 1 queued entry");
    assert.deepEqual(result.entries?.[0], existing, "the host entry is preserved verbatim and first");
    assert.equal(result.entries?.[1]?.customType, "async-task-settle-reminder");

    const missing = fireOne("agent_before_settle", undefined) as BeforeSettleResult;
    assert.equal(missing.entries?.length, 1, "a missing event/entries field is tolerated");
  });
});

test("a new agent run re-arms the reminder budget", () => {
  legion(() => {
    const { pi, fireOne } = makePi();
    new SettleGuard(pi as never, makeRegistry() as never).register();
    const beforeSettle = () => fireOne("agent_before_settle", { entries: [] }) as BeforeSettleResult | undefined;

    beforeSettle(); beforeSettle(); beforeSettle();
    assert.equal("continue" in (beforeSettle() ?? {}), false, "the budget is spent for this generation");
    fireOne("agent_start");
    const refreshed = beforeSettle();
    assert.equal(refreshed?.continue, true, "agent_start resets the budget");
    assert.equal(refreshed?.entries?.at(-1)?.customType, "async-task-settle-reminder");
  });
});

test("agent_settled sends exactly one followUp unresolved message per generation", () => {
  legion(() => {
    const calls: Array<{ message: Record<string, unknown>; options: unknown }> = [];
    const { pi, fireOne } = makePi({
      sendMessage: (message: Record<string, unknown>, options: unknown) => { calls.push({ message, options }); },
    });
    new SettleGuard(pi as never, makeRegistry() as never).register();
    const settled = () => fireOne("agent_settled", { aborted: true });

    settled();
    assert.equal(calls.length, 1, "an aborted run with live async work nudges the model once");
    assert.equal(calls[0]?.message.customType, "async-task-unresolved");
    assert.match(String(calls[0]?.message.content), /async_wait/);
    assert.deepEqual(calls[0]?.options, { deliverAs: "followUp" }, "options carry deliverAs only — no triggerTurn");

    settled();
    settled();
    assert.equal(calls.length, 1, "the latch keeps a burst of settle events to one message");

    fireOne("agent_start");
    settled();
    assert.equal(calls.length, 2, "the next generation may nudge once again");
  });
});

test("agent_settled stays quiet for non-aborted runs and when no async work remains", () => {
  legion(() => {
    const calls: unknown[] = [];
    let active = true;
    const { pi, fireOne } = makePi({ sendMessage: (...args: unknown[]) => { calls.push(args); } });
    new SettleGuard(pi as never, makeRegistry({ hasActiveWork: () => active }) as never).register();

    fireOne("agent_settled", { aborted: false });
    assert.equal(calls.length, 0, "a completed run is not an abort");
    fireOne("agent_settled", {});
    assert.equal(calls.length, 0, "a missing aborted flag is not an abort");
    active = false;
    fireOne("agent_settled", { aborted: true });
    assert.equal(calls.length, 0, "an aborted run with nothing in flight needs no nudge");
  });
});

test("a missing or throwing sendMessage never escapes agent_settled", () => {
  legion(() => {
    const silent = makePi();
    const silentGuard = new SettleGuard(silent.pi as never, makeRegistry() as never);
    silentGuard.register();
    assert.doesNotThrow(() => silent.fire("agent_settled", { aborted: true }), "hosts without sendMessage are tolerated");

    let attempts = 0;
    const hostile = makePi({ sendMessage: () => { attempts++; throw new Error("This extension ctx is stale after session replacement or reload."); } });
    new SettleGuard(hostile.pi as never, makeRegistry() as never).register();
    assert.doesNotThrow(() => hostile.fire("agent_settled", { aborted: true }));
    assert.doesNotThrow(() => hostile.fire("agent_settled", { aborted: true }));
    assert.equal(attempts, 1, "a throwing sendMessage is swallowed, never retried");
  });
});

test("PI_ASYNC_SETTLE_GUARD=0 registers nothing at all", () => {
  legion(() => {
    process.env.PI_ASYNC_SETTLE_GUARD = "0";
    const { pi, onCalls, handlers } = makePi();
    new SettleGuard(pi as never, makeRegistry() as never).register();
    assert.equal(onCalls(), 0, "the switched-off guard hooks no events");
    assert.equal(handlers.size, 0);
  });
});

test("main sessions get one advisory draft without continue, re-armed per run (D-C6)", () => {
  withNodeId(undefined, () => {
    const tasks = [makeSnapshot({ taskId: "live-1" })];
    const { pi, fireOne, handlers } = makePi();
    new SettleGuard(pi as never, makeRegistry({ tasks: () => tasks }) as never).register();

    assert.equal(handlers.has("agent_before_settle"), true, "main sessions hear the settle boundary");
    assert.equal(handlers.has("agent_settled"), true, "aborted-run nudges still apply to every session");
    assert.equal(handlers.has("agent_start"), true, "the advisory latch is re-armed for every session");

    const first = fireOne("agent_before_settle", { entries: [] }) as BeforeSettleResult | undefined;
    const advisory = first?.entries?.at(-1);
    assert.equal(advisory?.type, "custom_message");
    assert.equal(advisory?.customType, "async-task-settle-advisory");
    assert.equal(advisory?.display, false);
    assert.match(String(advisory?.content), /live-1/, "the advisory names the task ids");
    assert.match(String(advisory?.content), /async_wait/);
    assert.equal("continue" in (first ?? {}), false, "an advisory must never force another provider request");

    assert.equal(fireOne("agent_before_settle", { entries: [] }), undefined, "at most one advisory per generation");

    fireOne("agent_start");
    const refreshed = fireOne("agent_before_settle", { entries: [] }) as BeforeSettleResult | undefined;
    assert.equal(refreshed?.entries?.at(-1)?.customType, "async-task-settle-advisory", "a new run re-arms the advisory");

    tasks.push(makeSnapshot({ taskId: "live-2" }));
    assert.equal(fireOne("agent_before_settle", { entries: [] }), undefined, "still one per generation");
  });
});

test("a main session with nothing in flight gets no advisory", () => {
  withNodeId(undefined, () => {
    const { pi, fireOne } = makePi();
    new SettleGuard(pi as never, makeRegistry({ tasks: () => [] }) as never).register();
    assert.deepEqual(fireOne("agent_before_settle", { entries: [] }), undefined);
  });
});

test("dispose unsubscribes every hook and is idempotent", () => {
  legion(() => {
    const { pi, handlers, unsubscribed } = makePi();
    const guard = new SettleGuard(pi as never, makeRegistry() as never);
    guard.register();
    const hookCount = handlers.size;
    assert.equal(hookCount, 4, "agent_before_settle + agent_start + agent_settled + session_shutdown");

    assert.doesNotThrow(() => guard.dispose());
    assert.equal(unsubscribed.length, hookCount, "every registration is released");
    assert.equal(handlers.size, 0);

    assert.doesNotThrow(() => guard.dispose(), "a second dispose is a no-op");
    assert.equal(unsubscribed.length, hookCount, "a second dispose releases nothing twice");
  });
});

test("a stale ui getter never throws out of register, a handler or dispose", () => {
  legion(() => {
    let live = true;
    const { pi, fireOne, unsubscribed } = makePi({
      get ui(): { setActivity: () => void } {
        if (!live) throw new Error("This extension ctx is stale after session replacement or reload.");
        return { setActivity: () => undefined };
      },
    });
    const guard = new SettleGuard(pi as never, makeRegistry() as never);
    assert.doesNotThrow(() => guard.register(), "register reports activity through a live ui");
    live = false;
    assert.doesNotThrow(() => fireOne("agent_before_settle", { entries: [] }), "a stale activity read is swallowed");
    assert.ok(unsubscribed.length > 0, "the stale generation detaches its hooks");
    assert.doesNotThrow(() => guard.dispose());
    assert.doesNotThrow(() => fireOne("agent_settled", { aborted: true }));
  });
});
