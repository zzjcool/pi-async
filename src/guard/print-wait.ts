import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { exitSuffix, isTerminal, type TaskSnapshot } from "../core/task.ts";
import { envNumber } from "../core/env.ts";
import type { HoldNotificationRelay } from "./hold-notify.ts";

/**
 * Headless backstop for `pi -p` (0.5.0, D5).
 *
 * A print run is one prompt in, one assistant answer out, then `process.exit`. Nothing keeps the
 * process alive while a background task is still running, so the current behaviour is:
 *
 * - the task needs 3 s, `pi -p` settles the turn in ~565 ms, `session_shutdown` kills the task, and
 *   `print-mode.js` prints nothing (the last message is not an assistant answer);
 * - exit code 0, empty stdout — a silent failure with no way for the caller to notice.
 *
 * The host facts this module is built on (verified against pi 1.5.2):
 *
 * - `pi -p` binds extensions with `mode: "print"` (`bindExtensions({mode:"print"})`), so every
 *   event ctx carries `mode === "print"`.
 * - `agent_before_settle` handlers are `await`ed with **no timeout** (`runner.js:782`), exactly like
 *   the TUI boundary the settle hold uses — so this is the one place where a headless process may
 *   legitimately spend wall time.
 * - Returning `{entries:[...], continue: true}` makes the session send one more provider request
 *   unconditionally (`agent-session.js:1521-1525`, not gated by mode): any `custom_message` entry
 *   makes `canContinue` true (`agent-session.js:670-689`). That extra request is what lets the model
 *   finally *answer* after the wait, instead of the run ending on a custom message (which
 *   `print-mode.js:117-138` would print as nothing at all).
 * - There is **no** host-side cap on continuations (`docs/extensions.md:748` documents the endless
 *   loop), so the cap has to live here.
 * - `process.exitCode = 1` set from an extension survives `main.js:877` (which only overwrites it
 *   when `runPrintMode()` itself returns non-zero), and in print mode `console.log` /
 *   `process.stdout.write` are redirected to **stderr** (`output-guard.js:38-59`) — so the throttle
 *   notice uses `console.error`, which is stderr in every mode.
 *
 * What this module is *not*: a second hold. It never renders anything (there is no TUI), never
 * consumes output, and never latches a task as consumed. It reuses the 0.4.3 ownership relay
 * (`hold-notify.ts`) so a completion that lands during the wait is announced exactly once — the
 * results entry — instead of also arriving as a `followUp` nobody will ever read.
 */

/** Default overall budget for one headless process: ten minutes, the same order as the hold. */
const DEFAULT_WAIT_MS = 600_000;

/** Default poll interval: short enough that a finished task does not keep the process alive. */
const DEFAULT_POLL_MS = 500;

/** Default number of forced continuation requests before the run is allowed to end loudly. */
const DEFAULT_MAX_CONTINUATIONS = 5;

/**
 * Rows listed in the results entry before `+N more` takes over.
 *
 * A print run has few tasks by construction, but the entry ends up in a provider request, so the
 * bound is there to keep a pathological session from shipping dozens of labels into the prompt.
 */
const MAX_LISTED_TASKS = 8;

/** Task names longer than this are cut in the throttle notice (it is one stderr line). */
const MAX_NOTICE_NAME = 48;

export interface PrintWaitOptions {
  /** Overall budget in ms; default `PI_ASYNC_PRINT_WAIT_MS`. */
  waitMs?: number;
  /** Poll interval in ms; default `PI_ASYNC_PRINT_POLL_MS`. */
  pollMs?: number;
  /** Continuation requests allowed before the loud exit; default `PI_ASYNC_PRINT_MAX_CONTINUATIONS`. */
  maxContinuations?: number;
  /** Shared 0.4.3 ownership relay (`hold-notify.ts`); never a new dedupe mechanism. */
  notify?: HoldNotificationRelay;
}

/** The slice of pi's `AgentBeforeSettleEvent` this guard reads; `entries` may be absent. */
interface BeforeSettleEvent {
  entries?: unknown[];
}

/** `custom_message` draft pi accepts from `agent_before_settle`. */
interface CustomMessageDraft {
  type: "custom_message";
  customType: string;
  content: string;
  display: false;
}

/** `agent_before_settle` result: the results draft plus one forced provider request. */
interface BeforeSettleResult {
  entries: unknown[];
  continue: true;
}

type HostHooks = {
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  off?: (event: string, handler: (...args: unknown[]) => unknown) => void;
};

/**
 * Display name of a task: its own (trimmed) name, or the taskId when it has none — the id is a
 * 36-character uuid, so `MAX_NOTICE_NAME` only matters for a synthetic/mock id.
 */
function nameOf(task: TaskSnapshot): string {
  const name = typeof task.name === "string" ? task.name.trim() : "";
  if (name.length > 0) return name;
  const taskId = typeof task.taskId === "string" ? task.taskId : "";
  return taskId.length > MAX_NOTICE_NAME ? `${taskId.slice(0, MAX_NOTICE_NAME - 1)}…` : taskId;
}

/**
 * `a (completed, exit 0) · b (failed, exit 7)` — name/status/exitCode only; a row whose exit was never
 * observed reads `exit unknown` (D-07 #116), never `exit 0`.
 *
 * Output tails are up to 8 KiB each and this line is part of a provider request, so the reader is
 * pointed at `async_logs` instead of being handed the bytes (same D-6 rule the hold's results entry
 * follows). The list is bounded with a `+N more` marker rather than growing a prompt without limit;
 * `missing` covers the other bound — rows the registry can no longer produce (pruned history), so
 * the entry never claims fewer tasks than it waited for.
 */
function summaryItems(done: TaskSnapshot[], missing: number): string {
  const listed = done.slice(0, MAX_LISTED_TASKS).map((task) =>
    // D-07 (#116 / §27 REV-35): an unobserved exit status reads `exit unknown`, never `exit 0`.
    `${nameOf(task)} (${task.status}${exitSuffix(task.exitCode)})`);
  const hidden = done.length - listed.length + Math.max(0, missing);
  if (hidden > 0) listed.push(`+${hidden} more`);
  return listed.join(" · ");
}

/**
 * Resolve after `ms`, on a **ref'd** timer.
 *
 * Deliberately not `unref()`d: this sleep is what keeps a `pi -p` process alive while a task runs —
 * an unref'd timer would let the event loop drain and the host exit exactly as before the fix
 * (the same trap the hold hit in 0.4.0, see `hold.ts`).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Keep a headless (`pi -p`) run unsettled while async tasks are running, then hand the outcome back
 * to the model (D5).
 *
 * Exit inventory (every one of them is `undefined` unless stated):
 *
 * 1. `PI_ASYNC_PRINT_WAIT=0` → nothing is registered at all;
 * 2. `ctx.mode !== "print"` (tui / rpc / json / a missing ctx) → not ours, return immediately;
 * 3. no running task (or a degraded registry without `list`) → return immediately;
 * 4. one wait already in flight for this generation → return immediately (re-entrancy guard);
 * 5. continuation cap or overall budget already spent → **throttle exit**: notifications released,
 *    one stderr line naming every taskId, `process.exitCode = 1`, `undefined`;
 * 6. every task in the snapshot finished → results draft + `continue: true` (notifications
 *    committed, ids latched with `markNotified`);
 * 7. the budget runs out **inside** the loop (a task outlived `waitMs`) → the same throttle exit as 5;
 * 8. dispose during the wait, or a throwing registry → notifications released, `undefined`, and
 *    **no** exit code (a teardown or a broken registry is not a task failure);
 * 9. a boundary that arrives after `dispose()` → `undefined`.
 *
 * Nothing here throws and nothing calls `process.exit()`: a courtesy wait must never turn a working
 * run into a crash.
 */
export function registerPrintWait(pi: PiCtx, registry: TaskRegistry, opts?: PrintWaitOptions): () => void {
  // D5-1: the switch disarms the feature entirely — not one handler is registered.
  if (process.env.PI_ASYNC_PRINT_WAIT === "0") return () => undefined;

  // Every knob is injectable so a test never has to wait on the real clock for more than a poll.
  const waitMs = opts?.waitMs ?? envNumber("PI_ASYNC_PRINT_WAIT_MS", DEFAULT_WAIT_MS, { integer: true });
  const pollMs = Math.max(1, opts?.pollMs ?? envNumber("PI_ASYNC_PRINT_POLL_MS", DEFAULT_POLL_MS, { integer: true, min: 50 }));
  const maxContinuations = Math.max(
    0,
    opts?.maxContinuations ?? envNumber("PI_ASYNC_PRINT_MAX_CONTINUATIONS", DEFAULT_MAX_CONTINUATIONS, { integer: true, min: 0 }),
  );
  // CONTRACT §7.1 修订 3: one relay per generation, shared with the hold — the same object decides
  // "who announces this terminal event", so print mode needs no dedupe mechanism of its own.
  const notify = opts?.notify;

  let disposed = false;
  /**
   * Per-generation granularity mark (the hold's `heldThisGeneration`): true while this generation
   * already spent a boundary on a wait. `agent_start` re-arms it — a *later* turn may wait again,
   * bounded by the continuation counter below, and it also keeps a host that fires the boundary
   * twice in a row from growing two concurrent waits.
   */
  let waitInFlight = false;
  /**
   * Continuation requests this generation has already burned. Never reset on `agent_start`: the cap
   * is a budget for the whole process, not per turn — otherwise a chain of turns that each finish a
   * task would continue forever, which is the endless loop `docs/extensions.md:748` warns about.
   */
  let continuations = 0;
  /**
   * When the overall budget started, on the monotonic clock.
   *
   * Set on the first *real* wait and never reset (so the budget accumulates across turns and across
   * continuation requests, which is what bounds the whole process). It is scoped to this
   * registration rather than to the module on purpose: a `/reload` builds a new generation, and a
   * fresh generation must start with a fresh budget instead of inheriting the previous one's.
   */
  let budgetStartedAt: number | undefined;

  const unsubscribers: Array<() => void> = [];

  /**
   * Rows that are still running among `ids`.
   *
   * `includeHistory: false` already drops terminal rows in the real registry; the status filter is
   * kept explicit because this module's contract is "only `running` blocks the exit" — a mock or an
   * older registry that ignores the option must not make a pending row look live.
   */
  const runningAmong = (ids: string[]): TaskSnapshot[] =>
    registry.list({ includeHistory: false })
      .filter((task) => task.status === "running" && ids.includes(task.taskId));

  /**
   * Terminal rows for the snapshot, read from history when the registry can still provide it.
   *
   * Only rows that are really terminal are returned, so the entry can never claim `A (running)` as
   * finished (the same 修订-2 rule the hold's results line follows).
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
   * The loud exit (cap or overall budget): the run is allowed to end, but it must not end silently.
   *
   * The notification relay is **released**, never dropped — a task whose completion was intercepted
   * while we waited still gets its normal sender. stderr names every remaining taskId (the caller
   * cannot act on "something is still running"), and `process.exitCode = 1` is what makes a scripted
   * `pi -p` invocation fail instead of returning empty stdout with status 0.
   */
  const throttle = (remaining: TaskSnapshot[], elapsedMs: number): undefined => {
    try { notify?.release(); } catch { /* the release path is itself best-effort */ }
    const listed = remaining
      .map((task) => `${task.taskId}${nameOf(task) === task.taskId ? "" : ` (${nameOf(task).slice(0, MAX_NOTICE_NAME)})`}`)
      .join(", ");
    const seconds = (Math.max(0, elapsedMs) / 1000).toFixed(1);
    try {
      console.error(
        `pi-async: still running ${remaining.length} async task(s) after ${continuations} continuation(s) and ${seconds}s: ${listed}.`,
      );
    } catch { /* a host with a broken stderr must still get the exit code below */ }
    process.exitCode = 1;
    return undefined;
  };

  /**
   * The boundary handler.
   *
   * `ctx` may be missing entirely (old hosts, mocks). Unlike the hold — where a missing ctx may
   * still hold — a missing ctx here must **not** wait: `print` is the only mode this module serves
   * and it has to be named explicitly, or a host that omits ctx would silently gain a ten-minute
   * wait in every mode.
   */
  const beforeSettle = async (event?: unknown, ctx?: unknown): Promise<BeforeSettleResult | undefined> => {
    try {
      if (disposed) return undefined;
      if (waitInFlight) return undefined;
      const mode = (ctx as { mode?: unknown } | undefined | null)?.mode;
      if (mode !== "print") return undefined; // tui/rpc/json/absent: not this module's boundary
      if (typeof registry.list !== "function") return undefined; // degraded registry

      // Only tasks that are actually running may keep the process alive. A `pending` row cannot
      // finish inside this budget by definition — a `mode: "delayed"` task sits in `pending`
      // (`dueAt` arbitrarily far away; notifyOnCompletion defaults to true), so counting it would
      // burn the whole `waitMs` on every headless run that ever scheduled a delayed task. Unlike the
      // hold's `isHoldable`, `notifyOnCompletion` is not part of the filter here: print mode has no
      // other announcement channel, so a silent task still must not take the output with it.
      const active = registry.list({ includeHistory: false }).filter((task) => task.status === "running");
      if (active.length === 0) return undefined;

      const ids = active.map((task) => task.taskId);
      const now = performance.now();
      const spent = budgetStartedAt === undefined ? 0 : now - budgetStartedAt;
      if (continuations >= maxContinuations || spent >= waitMs) return throttle(active, spent);

      // A real wait starts here; the budget clock starts once and then never resets.
      if (budgetStartedAt === undefined) budgetStartedAt = now;
      waitInFlight = true;
      // Arm ownership before the first poll: `onFinalize` for these ids runs in the same tick a task
      // finishes, always before the poll that observes the terminal state can look (hold D-6b).
      notify?.open(ids);
      let remaining = active;
      try {
        for (;;) {
          const left = waitMs - (performance.now() - (budgetStartedAt as number));
          if (!(left > 0)) return throttle(remaining, performance.now() - (budgetStartedAt as number));
          await sleep(Math.min(pollMs, left));
          if (disposed) {
            // Teardown mid-wait: not a task failure, so no exit code — just hand the completion back.
            notify?.release();
            return undefined;
          }
          remaining = runningAmong(ids);
          if (remaining.length === 0) break;
        }
        // Normal path: every task in the snapshot is terminal, so hand the outcome back and let the
        // host run one more provider request — that request is what produces the printed answer.
        const done = terminalSnapshots(ids);
        // Rows the registry can no longer produce are counted, never silently dropped.
        const items = summaryItems(done, ids.length - done.length);
        const draft: CustomMessageDraft = {
          type: "custom_message",
          customType: "async-task-print-results",
          display: false,
          content: done.length > 0
            ? `Waited for ${ids.length} async task(s); all finished: ${items}. Read the output with async_logs before answering.`
            // 修订 2 shape: never invent a status for a row the registry can no longer produce.
            : `Waited for ${ids.length} async task(s); they finished (records pruned). Read the output with async_logs before answering.`,
        };
        // CONTRACT §7.1 修订 3: this entry is the one announcement of these terminal states, so the
        // deferred notifications are dropped — and latched, or `resendUnnotified` would announce
        // them again on the next `session_start`. Guarded because library/mock registries need not
        // implement `markNotified`.
        for (const taskId of notify?.commit(ids) ?? []) {
          try {
            if (typeof registry.markNotified === "function") registry.markNotified(taskId);
          } catch { /* the entry already reached the transcript; a failed latch only risks a resend */ }
        }
        continuations++;
        // Any drafts pi already queued for this boundary stay in front of ours.
        const queued = (event as BeforeSettleEvent | undefined)?.entries;
        return { entries: [...(Array.isArray(queued) ? queued : []), draft], continue: true };
      } finally {
        waitInFlight = false;
      }
    } catch {
      // A courtesy wait must never fail a headless run: a notification intercepted while we waited
      // goes back to its normal sender, and no exit code is imposed on the caller.
      try { notify?.release(); } catch { /* best effort */ }
      waitInFlight = false;
      return undefined;
    }
  };

  const dispose = (): void => {
    // Idempotent: a second call (and a late `session_shutdown`) is a no-op.
    if (disposed) return;
    disposed = true;
    // A wait still in flight resolves through its own `disposed` branch; a wait that was never
    // armed leaves nothing here. Belt and braces: never lose a notification.
    try { notify?.release(); } catch { /* the release path is itself best-effort */ }
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* best effort: the host ctx may already be stale */ }
    }
  };

  // SAFETY: PiCtx hooks vary by runtime; `on` returns the unsubscribe function (the real host has no
  // `pi.off`), so both shapes are feature-detected before use — same as the hold / SettleGuard.
  const hooks = pi as unknown as HostHooks;
  const listen = (event: string, handler: (...args: unknown[]) => unknown): void => {
    const result = hooks.on?.(event, handler);
    // SAFETY: pi.on() returns an unsubscribe function; older/mocked hosts may return void, in which
    // case there is nothing to release and we rely on `off`/`disposed` alone.
    if (typeof result === "function") unsubscribers.push(result as () => void);
    else unsubscribers.push(() => hooks.off?.(event, handler));
  };

  // D5-2: exactly three hooks — the wait body, the per-turn re-arm, and the teardown.
  listen("agent_before_settle", beforeSettle);
  listen("agent_start", () => {
    waitInFlight = false;
  });
  listen("session_shutdown", () => {
    dispose();
  });

  return dispose;
}
