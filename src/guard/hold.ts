import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { isTerminal, type TaskSnapshot } from "../core/task.ts";
import { formatElapsedMs } from "../core/duration.ts";
import { envNumber } from "../core/env.ts";

/** Default upper bound for one hold (D-5 / D-9): ten minutes. */
const DEFAULT_HOLD_MS = 600_000;

/** Default poll interval (D-5 / D-9). */
const DEFAULT_POLL_MS = 1_000;

/** Default footer refresh cadence while holding (D-8); `opts.footerRefreshMs` overrides it (F5). */
const DEFAULT_FOOTER_REFRESH_MS = 15_000;

/** Footer key owned by this module; cleared as soon as the hold ends (D-8). */
const FOOTER_KEY = "pi-async-hold";

/**
 * The slice of pi's event ctx this module reads.
 *
 * `ctx` may be missing entirely (old hosts, mocks), so every field is optional and read behind
 * a guard: D-3 says a missing ctx must NOT block the hold, while every non-`tui` mode must.
 */
type HoldContext = {
  mode?: unknown;
  ui?: { setStatus?: (key: string, text: string | undefined) => void };
};

/** The slice of pi's `AgentBeforeSettleEvent` this module reads; `entries` may be absent. */
interface BeforeSettleEvent {
  entries?: unknown[];
}

/** `custom_message` draft pi accepts from `agent_before_settle` (D-6). */
interface CustomMessageDraft {
  type: "custom_message";
  customType: string;
  content: string;
  display: false;
}

/** `agent_before_settle` result: the results draft plus a forced next provider request (D-6). */
interface BeforeSettleResult {
  entries: unknown[];
  continue: true;
}

type HostHooks = {
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  off?: (event: string, handler: (...args: unknown[]) => unknown) => void;
};

/**
 * Whether a task is worth holding the turn for (D-4, 修订 1 / F1).
 *
 * Keep in sync with src/context/nudges.ts `wakesYou` — that module's surface is frozen by its own
 * tests, so this is deliberately a copy of the same three conditions instead of an export. Holding
 * only on wakeable tasks is what makes the wait self-consistent: exactly those tasks queue a
 * completion notification while we wait.
 *
 * The first condition is `status === "running"`, NOT "not terminal": a `mode: "delayed"` task sits
 * in `pending` with `notifyOnCompletion: true` by default and cannot possibly finish inside the
 * hold budget (`dueAt` is arbitrarily far away), so counting it would burn `PI_ASYNC_HOLD_MS` on
 * every single turn end.
 */
function isHoldable(task: TaskSnapshot): boolean {
  return task.status === "running"
    && task.metadata?.notifyOnCompletion !== false
    && task.metadata?.triggerOnCompletion !== false;
}

/**
 * D-6 (修订 1 / F2a, 修订 2): the results line for the transcript — id/name/status/exitCode only.
 *
 * Output tails are 8 KiB each and would blow up the context, so the reader is pointed at
 * `async_logs` instead. The fallback wording never claims a status it does not have: when the
 * registry can no longer produce history rows, the entry says the tasks finished without naming
 * them, instead of echoing the opening snapshot's `status: "running"` (修订 2).
 */
function resultsSummary(count: number, done: TaskSnapshot[]): string {
  const head = `Held the turn for ${count} async task(s);`;
  const tail = " Read the output with async_logs before answering.";
  if (done.length === 0) return `${head} they finished (records pruned).${tail}`;
  const items = done
    .map((task) => `${task.name ?? task.taskId} (${task.status}${task.exitCode === undefined ? "" : `, exit ${task.exitCode}`})`)
    .join(" · ");
  const missing = count > done.length ? " (records pruned for the rest)" : "";
  return `${head} all finished: ${items}${missing}.${tail}`;
}

/**
 * Resolve after `ms`.
 *
 * The timer stays **ref'd** on purpose: this sleep is what the held boundary is currently awaiting,
 * so it is the thing keeping the run (and the handler's continuation) alive. An `unref()` here let
 * the event loop drain in a process with nothing else pending, and node:test then cancelled the
 * whole suite with "Promise resolution is still pending but the event loop has already resolved"
 * (CI node 22, 0.4.0). The footer refresh below is cosmetic and stays unref'd.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Keep a run unsettled while wakeable async tasks are still in flight (PLAN-HOLD, D-1 … D-9).
 *
 * Settling is what flips the terminal OSC 7501 state from `working` to `done`, so a main-session
 * turn that ends with a background task in flight briefly shows `done` and then a wake-up. pi
 * awaits `agent_before_settle` handlers serially with **no timeout** (H1), so that boundary is the
 * one place where we can legitimately spend wall time: while `_isAgentRunActive === true` the run
 * reports streaming (H2) and the OSC state stays `working` for the whole wait (H3).
 *
 * The hold only drags time; it never consumes output and never touches `notified` (D-7). When the
 * snapshot is fully terminal it hands back a results draft plus `continue: true` (D-6), because a
 * wake-up queued during the hold can be dropped when the user presses Esc (`clearAllQueues()` while
 * `notified` is already latched) — the turn then still has a next provider request that carries the
 * outcome into the transcript.
 *
 * Guards against the ways this could hurt a user: a hard `holdMs` bound on a monotonic clock (D-5)
 * and a whole-body try/catch — a hold must never fail a turn or hang one (D-6).
 */
export function registerHold(
  pi: PiCtx,
  registry: TaskRegistry,
  opts?: { holdMs?: number; pollMs?: number; footerRefreshMs?: number },
): () => void {
  // D-2: `PI_ASYNC_HOLD=0` disarms the feature entirely — it registers nothing at all.
  if (process.env.PI_ASYNC_HOLD === "0") return () => undefined;
  // D-5 (修订 2): no `min`, so a negative value is returned as-is and `!(holdMs > 0)` reads it as
  // "off" — with `{ min: 0 }` a value like -1 silently fell back to the 10-minute default.
  const holdMs = opts?.holdMs ?? envNumber("PI_ASYNC_HOLD_MS", DEFAULT_HOLD_MS, { integer: true });
  if (!(holdMs > 0)) return () => undefined;
  const pollMs = Math.max(1, opts?.pollMs ?? envNumber("PI_ASYNC_HOLD_POLL_MS", DEFAULT_POLL_MS, { integer: true, min: 50 }));
  // D-8 / F5: injectable so a test can pin the refresh cadence without waiting 15 s.
  const footerRefreshMs = Math.max(1, opts?.footerRefreshMs ?? DEFAULT_FOOTER_REFRESH_MS);

  let disposed = false;
  /** D-3 #5: at most one hold per run; `agent_start` re-arms it. */
  let heldThisGeneration = false;
  const unsubscribers: Array<() => void> = [];

  const setFooter = (ctx: HoldContext | undefined, count: number, elapsedMs: number): void => {
    try {
      // SAFETY: `ui`/`setStatus` exist only on handler ctxs (never at factory time), and a stale
      // ctx getter throws on read — so the read sits inside the guard together with the call.
      const ui = ctx?.ui;
      const setStatus = ui?.setStatus;
      if (typeof setStatus !== "function") return;
      setStatus.call(ui, FOOTER_KEY, `waiting for ${count} task${count === 1 ? "" : "s"} ${formatElapsedMs(elapsedMs)}`);
    } catch {
      // D-8: the footer is decoration; a host that rejects setStatus must not end the hold.
    }
  };

  const clearFooter = (ctx: HoldContext | undefined): void => {
    try {
      // SAFETY: same feature-detect as setFooter above.
      const ui = ctx?.ui;
      const setStatus = ui?.setStatus;
      if (typeof setStatus !== "function") return;
      setStatus.call(ui, FOOTER_KEY, undefined);
    } catch {
      // D-8: best-effort cleanup, never fatal.
    }
  };

  /**
   * D-6 (修订 1 / F2a, 修订 2): terminal rows for the snapshot ids, read from history when the
   * registry can still provide it. Only rows that are actually terminal are returned: a missing
   * record yields no row at all, so the results line can never claim `A (running)` as finished.
   */
  const terminalSnapshots = (ids: string[]): TaskSnapshot[] => {
    try {
      if (typeof registry.list === "function") {
        return registry.list({ includeHistory: true })
          .filter((task) => ids.includes(task.taskId) && isTerminal(task.status));
      }
    } catch { /* no history available: the caller falls back to a status-free sentence */ }
    return [];
  };

  /**
   * D-5 main loop. Returns `true` only when every task in the snapshot is terminal.
   *
   * Exactly two exits (修订 2): everything terminal, or the budget ran out. There is deliberately
   * no early-release heuristic — `ctx.hasPendingMessages()` counts the session-level user queues
   * (`_steeringMessages + _followUpMessages`), while a completion notification queued during the
   * hold goes through `agent.followUp()` (`agent-session.js:1924-1926` vs `:1877`) and is NOT in
   * that count. The probe reads `false` on the normal path, so a heuristic built on it ended a
   * multi-task hold right after the first task finished — dropping the results entry and the
   * `continue` that the normal path exists to deliver.
   *
   * `ids` is the snapshot taken when the boundary opened — a task started while we wait is not ours
   * to wait for. Nothing here touches task state, output, or `notified` (D-7); only `registry.list`
   * is read, and a throw from it (registry suspended/shut down under us) ends the hold.
   *
   * The budget runs on `performance.now()` (monotonic, 修订 1 / F4) so a wall-clock jump can never
   * stretch a hold past `holdMs`.
   */
  const holdUntilSettled = async (ctx: HoldContext | undefined, ids: string[]): Promise<boolean> => {
    const startedAt = performance.now();
    let waiting = ids.length;
    setFooter(ctx, waiting, 0);
    const refresh = setInterval(() => setFooter(ctx, waiting, performance.now() - startedAt), footerRefreshMs);
    refresh.unref?.();
    try {
      while (performance.now() - startedAt < holdMs) {
        // Never sleep past the deadline: the total cost stays holdMs + one poll (D-6).
        await sleep(Math.min(pollMs, holdMs - (performance.now() - startedAt)));
        if (disposed) return false;
        let stillLive: TaskSnapshot[];
        try {
          stillLive = registry.list({ includeHistory: false }).filter((task) => ids.includes(task.taskId));
        } catch {
          // D-5: the registry can be suspended/shut down while we wait — stop, never throw.
          return false;
        }
        if (stillLive.length === 0) return true; // D-6 normal path: the whole snapshot finished.
        waiting = stillLive.length;
      }
      return false; // timeout: the run settles exactly as it would have without the hold (D-6).
    } finally {
      clearInterval(refresh);
      clearFooter(ctx);
    }
  };

  const beforeSettle = async (event?: unknown, ctx?: unknown): Promise<BeforeSettleResult | undefined> => {
    // D-6: pi awaits this handler with no timeout, so nothing may escape as a throw, and every
    // non-`continue` exit returns `undefined` (no `entries` either).
    try {
      if (disposed) return undefined; // D-3 #1: a retired generation never holds.
      // D-3 #2: legion children keep their own bounded reminder channel (CONTRACT §7); never stack.
      if (process.env.PI_LEGION_NODE_ID !== undefined) return undefined;
      const context = ctx as HoldContext | undefined;
      // D-3 #3 (修订 1 / F3): whitelist — only an interactive TUI session holds. `print`/`json`
      // would delay the process exit and `rpc` aborts under a client timeout; a missing ctx (old
      // host/mock) stays holdable.
      if (context !== undefined && context !== null && context.mode !== "tui") return undefined;
      if (typeof registry.list !== "function") return undefined; // D-3 #4: degraded registry.
      if (heldThisGeneration) return undefined; // D-3 #5: one hold per run.
      const candidates = registry.list({ includeHistory: false }).filter(isHoldable); // D-4
      if (candidates.length === 0) return undefined; // D-3 #6: nothing to wait for.
      // Latched only once the hold is really going to happen: a boundary with nothing to wait for
      // must not burn the run's single hold.
      heldThisGeneration = true;
      const ids = candidates.map((task) => task.taskId);
      if (!(await holdUntilSettled(context, ids))) {
        // Timeout, disposal or a throwing registry: settle as before, with no entries and no
        // `continue` (D-6).
        return undefined;
      }
      // D-6 normal path: every task in the snapshot is terminal, so hand the outcome back and let
      // the host run one more provider request (an Esc-dropped wake-up would otherwise lose it).
      const results: CustomMessageDraft = {
        type: "custom_message",
        customType: "async-task-settle-results",
        display: false,
        // 修订 2: the count is the snapshot size; the detail list only ever contains rows that were
        // really observed as terminal (never the opening snapshot's `running`).
        content: resultsSummary(ids.length, terminalSnapshots(ids)),
      };
      // Any drafts pi already queued for this boundary stay in front of ours.
      const queued = (event as BeforeSettleEvent | undefined)?.entries;
      return { entries: [...(Array.isArray(queued) ? queued : []), results], continue: true };
    } catch {
      // D-6: the hold is a courtesy — any failure lets the turn settle exactly as it would have.
      return undefined;
    }
  };

  const dispose = (): void => {
    // Idempotent: a second call (and a late `session_shutdown`) is a no-op.
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* best effort: the host ctx may already be stale */ }
    }
  };

  // SAFETY: PiCtx hooks vary by runtime; `on` returns the unsubscribe function (the real host has
  // no `pi.off`), so both shapes are feature-detected before use — same as SettleGuard.
  const hooks = pi as unknown as HostHooks;
  const listen = (event: string, handler: (...args: unknown[]) => unknown): void => {
    const result = hooks.on?.(event, handler);
    // SAFETY: pi.on() returns an unsubscribe function; older/mocked hosts may return void, in
    // which case there is nothing to release and we rely on `off`/`disposed` alone.
    if (typeof result === "function") unsubscribers.push(result as () => void);
    else unsubscribers.push(() => hooks.off?.(event, handler));
  };

  // D-2: exactly three hooks — the hold body, the per-run re-arm, and the teardown.
  listen("agent_before_settle", beforeSettle);
  listen("agent_start", () => {
    heldThisGeneration = false;
  });
  listen("session_shutdown", () => {
    dispose();
  });

  return dispose;
}
