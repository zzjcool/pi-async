import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { isTerminal, type TaskSnapshot } from "../core/task.ts";
import { formatDuration, formatElapsedMs } from "../core/duration.ts";
import { envNumber } from "../core/env.ts";
// SAFETY: `tui/width.ts` is a pure text utility (no TUI/host imports), so the guard layer may share
// it instead of duplicating the CJK cell-width rules — the deps still point one way (tui → core).
import { displayWidth, truncateToWidth } from "../tui/width.ts";
import { ensureRailSurface, railRepaint, railShowsTasks, setHoldSurface, waitingRow } from "../tui/surfaces.ts";
import type { HoldNotificationRelay } from "./hold-notify.ts";

/** Default upper bound for one hold (D-5 / D-9): ten minutes. */
const DEFAULT_HOLD_MS = 600_000;

/** Default poll interval (D-5 / D-9). */
const DEFAULT_POLL_MS = 1_000;

/** Default footer refresh cadence while holding (D-8); `opts.footerRefreshMs` overrides it (F5). */
const DEFAULT_FOOTER_REFRESH_MS = 15_000;

/** Footer key owned by this module; cleared as soon as the hold ends (D-8). */
const FOOTER_KEY = "pi-async-hold";

/**
 * Widget key for the hold's **fallback** line (§7.1 修订 8).
 *
 * 0.4.3–0.4.7 painted the wait into an always-present widget above the editor; 0.4.8 puts that row
 * into the rail's first line instead, so this key exists **only** while the rail cannot carry it (no
 * `setWidget` host, a widget the host dropped and cannot take back, a rail window that does not cover
 * the waited tasks). Exported for the tests that assert exactly that; not part of the user docs.
 */
export const HOLD_FALLBACK_WIDGET_KEY = "pi-async-hold-fallback";
const PROGRESS_FRAME_MS = 250;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Columns assumed when the host exposes no `process.stdout.columns` (a piped stdout, a test): the
 * same 120-cell default the panel falls back to (`src/tui/panel.ts:424`).
 */
const DEFAULT_COLUMNS = 120;

/** Characters of `taskId` used when a task has no name (an unnamed row is still identifiable). */
const FALLBACK_ID_CHARS = 8;

/**
 * One task inside the progress row: `name (status, elapsed)` — the exact shape the model-facing
 * `<async-state>` line uses (`src/context/nudges.ts:75`), so the user reads the same thing the
 * model reads. An unnamed (or blank-named) task falls back to the first 8 characters of its id:
 * `""` would otherwise render as a bare ` (running, 4s)` with nothing to identify it.
 */
function taskLabel(task: TaskSnapshot, now: number): string {
  const name = typeof task.name === "string" ? task.name.trim() : "";
  const shown = name.length > 0 ? name : task.taskId.slice(0, FALLBACK_ID_CHARS);
  return `${shown} (${task.status}, ${formatDuration(task, now)})`;
}

/**
 * Usable terminal width for a `setWidget(content: string[])` row.
 *
 * That form gets no width callback (only the factory form does), so the row sizes itself from
 * `process.stdout.columns` — the same convention `src/tui/panel.ts:424` uses. One column is left
 * free on purpose: a line that exactly fills the terminal is what makes some hosts wrap it, and a
 * wrapping row is the jitter this budget exists to prevent.
 */
function terminalColumns(): number {
  const columns = process.stdout?.columns;
  const usable = typeof columns === "number" && columns > 0 ? columns : DEFAULT_COLUMNS;
  return Math.max(20, usable - 1);
}

/**
 * `a (running, 1m 4s) · b (running, 32s)`, cut to a cell budget with a `+N more` marker for the
 * tasks that do not fit. Widths are measured in terminal cells (a CJK name is two cells per
 * character), never in `String#length`.
 *
 * Returns `""` when the budget is exhausted, so the caller can fall back to the count-only row —
 * the count in the head always tells the truth even when not one name fits.
 */
function fitTaskList(tasks: TaskSnapshot[], budget: number): string {
  if (budget <= 0 || tasks.length === 0) return "";
  // Epoch clock, like every other task-duration surface: the hold's own budget runs on
  // `performance.now()`, but a task's `startedAt` is `Date.now()` — mixing the two is meaningless.
  const now = Date.now();
  const items = tasks.map((task) => taskLabel(task, now));
  let shown = 0;
  let text = "";
  while (shown < items.length) {
    const candidate = shown === 0 ? items[0]! : `${text} · ${items[shown]!}`;
    // Reserve the marker for *this* stopping point: its width depends on how many stay hidden.
    const hidden = items.length - shown - 1;
    const marker = hidden > 0 ? ` +${hidden} more` : "";
    if (displayWidth(candidate) + displayWidth(marker) > budget) break;
    text = candidate;
    shown++;
  }
  const hidden = items.length - shown;
  if (hidden === 0) return text;
  if (shown === 0) {
    // Not even one label fits with its marker: ellipsize the first instead of hiding the only
    // identifiable task behind `+N more`. The caller clamps the final line as a last resort.
    const marker = items.length > 1 ? ` +${items.length - 1} more` : "";
    return `${truncateToWidth(items[0]!, Math.max(1, budget - displayWidth(marker)))}${marker}`;
  }
  return `${text} +${hidden} more`;
}

/**
 * The 0.4.5 detail tail: every waiting task's `name (status, elapsed)`. Since 修订 8 it is only used
 * where the rail cannot carry the task rows — the fallback line and the name-less footer.
 */
function namedFooter(head: string, tasks: TaskSnapshot[]): string {
  const separator = " — ";
  const width = terminalColumns();
  const detail = fitTaskList(tasks, width - displayWidth(head) - displayWidth(separator));
  if (detail.length === 0) return head;
  const line = `${head}${separator}${detail}`;
  return displayWidth(line) > width ? truncateToWidth(line, width) : line;
}

/**
 * Why the hold may leave early (0.4.3, D-5 修订 3): the user always wins over the wait.
 *
 * 0.4.2 had exactly two exits (all terminal / budget) and deliberately no early-release heuristic.
 * The two channels that may end a hold early are:
 *
 * - `ctx.hasPendingMessages()` **is** true for user text queued while the run streams (TUI Enter →
 *   `_queueSteer`, `interactive-mode.js:2824-2831` → `agent-session.js:1880`); the host's own
 *   notification path never touches those mirrors (`agent-session.js:1959-1965`). It counts
 *   steering+followUp only (`agent-session.js:2056-2058`), and Esc's `clearAllQueues()` runs before
 *   `abort()`, so this is a "the user submitted text" probe — never an "Esc was pressed" probe.
 * - A lone Esc, through `ui.onTerminalInput` — a real, documented extension API
 *   (`types.d.ts:92-93` "Listen to raw terminal input (interactive mode only)" →
 *   `interactive-mode.js:2177` → `:2135-2141` → pi-tui `tui.js:605-610`). The listener runs before
 *   the focused component's `handleInput` (`tui.js:719-731`), so it sees the keystroke even while
 *   the hold is what the run is blocked on.
 *
 * There is deliberately **no** `ctx.signal` channel: at this boundary it is always `undefined`.
 * `agent-session.js:1514` awaits `agent.prompt()`, whose `runWithLifecycle` `finally` calls
 * `finishRun()` (`pi-agent-core/dist/agent.js:380-386`) → `activeRun = undefined`; only afterwards,
 * at `agent-session.js:1521`, does `_runBeforeSettleBoundary()` run. So `agent.js:217 get signal()`
 * yields `undefined` (`types.d.ts:258-259` types it `AbortSignal | undefined`) and `agent.abort()`
 * (`agent.js:221-223`) is a no-op here. Esc's only host-side effect at this boundary is
 * `_abortDuringBeforeSettle = true` (`agent-session.js:2080-2081`), which suppresses the
 * continuation and is not observable by the handler. Do not re-add a signal listener: it would
 * never fire and would only mislead the next reader.
 */

/**
 * The slice of pi's event ctx this module reads.
 *
 * `ctx` may be missing entirely (old hosts, mocks), so every field is optional and read behind
 * a guard: D-3 says a missing ctx must NOT block the hold, while every non-`tui` mode must.
 */
type HoldContext = {
  mode?: unknown;
  ui?: {
    setStatus?: (key: string, text: string | undefined) => void;
    setWidget?: (key: string, content: string[] | undefined, options?: unknown) => void;
    onTerminalInput?: (handler: (data: string) => undefined) => unknown;
  };
  /** True while the user has text queued for this run (steer/follow-up). Not a notification probe. */
  hasPendingMessages?: () => unknown;
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
  opts?: { holdMs?: number; pollMs?: number; footerRefreshMs?: number; notify?: HoldNotificationRelay },
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
  // CONTRACT §7.1 修订 3: while a hold really waits, it owns the terminal events in its snapshot —
  // the results entry is committed in-run, the notification would arrive as a later-turn followUp
  // and announce the same completion twice. Absent relay (library use, tests) keeps 0.4.2 wiring.
  const notify = opts?.notify;

  let disposed = false;
  /** D-3 #5: at most one hold per run; `agent_start` re-arms it. */
  let heldThisGeneration = false;
  const unsubscribers: Array<() => void> = [];

  const setFooter = (ctx: HoldContext | undefined, tasks: TaskSnapshot[], elapsedMs: number): void => {
    try {
      // SAFETY: `ui`/`setStatus` exist only on handler ctxs (never at factory time), and a stale
      // ctx getter throws on read — so the read sits inside the guard together with the call.
      const ui = ctx?.ui;
      const setStatus = ui?.setStatus;
      if (typeof setStatus !== "function") return;
      const count = tasks.length;
      const head = `waiting for ${count} task${count === 1 ? "" : "s"} ${formatElapsedMs(elapsedMs)}`;
      // 修订 8, §8's last resort: a host with no widget surface can paint no waiting row anywhere,
      // so the footer — the one surface left — names the tasks instead of only counting them.
      const text = typeof ui?.setWidget === "function" ? head : namedFooter(head, tasks);
      setStatus.call(ui, FOOTER_KEY, text);
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
   * True while the visible wait is on the rail (or was on the rail an instant ago). Prevents widget
   * churn: a fallback line is cleared once and only when the rail takes over (§7.1 修订 8).
   */
  let fallbackShown = false;

  /**
   * §7.1 修订 8: the wait is **one** row and it lives in the rail's first line.
   *
   * `setWaiting` publishes the hold's frame/elapsed through `setHoldSurface` and asks the mounted rail
   * to repaint (its own ticker is 1 Hz — too slow for a 250 ms braille frame). It only paints a line of
   * its own when the rail provably cannot: no `setWidget` at all, a widget the host dropped and cannot
   * take back, or a rail window that does not cover every waited task. That fallback carries the task
   * names (修订 5) because the rail is not naming them either — §8's "the names are somewhere" rule.
   *
   * Exactly one `async_wait` may be on screen at any time, so the two branches are mutually exclusive
   * within a frame, and a stale claim is withdrawn before the fallback line is written.
   *
   * Purely cosmetic: every failure is swallowed like the footer (D-8).
   */
  const setWaiting = (ctx: HoldContext | undefined, tasks: TaskSnapshot[], elapsedMs: number, tick: number): void => {
    try {
      const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!;
      const elapsed = formatElapsedMs(elapsedMs);
      const ids = tasks.map((task) => task.taskId);
      let onRail = railShowsTasks(ids);
      if (!onRail) {
        // Withdraw our claim first: a rail that repaints before the self-heal below must not paint a
        // stale waiting row next to the one this frame is about to write.
        setHoldSurface(undefined);
        // Self-heal the other surface, then re-check immediately — a rail that comes back in this same
        // frame carries the row, so there is no fallback window at all (修订 7's healing, kept).
        if (ensureRailSurface()) onRail = railShowsTasks(ids);
      }
      if (onRail) {
        setHoldSurface({ frame, elapsed });
        railRepaint();
        if (fallbackShown) {
          const ui = ctx?.ui;
          const setWidget = ui?.setWidget;
          if (typeof setWidget === "function") setWidget.call(ui, HOLD_FALLBACK_WIDGET_KEY, undefined);
          fallbackShown = false;
        }
        return;
      }
      setHoldSurface(undefined);
      const ui = ctx?.ui;
      const setWidget = ui?.setWidget;
      if (typeof setWidget !== "function") return;
      const width = terminalColumns();
      const tail = " — Esc stops waiting";
      const plain = waitingRow(frame, elapsed);
      const head = plain.endsWith(tail) ? plain.slice(0, -tail.length) : plain;
      // The separator `waitingRow` puts between head and detail is part of the budget too: without it the
      // final clamp would eat the Esc hint instead of the task list (see docs/reports/hold-in-rail.md).
      const detailBudget = width - displayWidth(`${head} — `) - displayWidth(tail);
      const row = waitingRow(frame, elapsed, fitTaskList(tasks, detailBudget));
      // Belt and braces: the budget above already fits, and an ellipsis here is still better than a
      // row the host wraps (the pathological case is a terminal narrower than the fixed wording).
      const clamped = displayWidth(row) > width ? truncateToWidth(row, width) : row;
      // SAFETY: `setWidget` was feature-detected above; the call is inside the guard.
      setWidget.call(ui, HOLD_FALLBACK_WIDGET_KEY, [clamped], { placement: "aboveEditor" });
      fallbackShown = true;
    } catch {
      // Cosmetic only: an old host without setWidget must not end the hold.
    }
  };

  /**
   * End the visible wait (§7.1 修订 8). Runs in `holdUntilSettled`'s `finally`, so it covers **every**
   * exit — all-terminal, budget, Esc, queued message, dispose, a throwing registry. Withdrawing the
   * claim is what makes the rail paint its summary row again.
   */
  const clearWaiting = (ctx: HoldContext | undefined): void => {
    setHoldSurface(undefined);
    railRepaint();
    fallbackShown = false;
    try {
      const ui = ctx?.ui;
      const setWidget = ui?.setWidget;
      if (typeof setWidget !== "function") return;
      setWidget.call(ui, HOLD_FALLBACK_WIDGET_KEY, undefined);
    } catch {
      // Best-effort cleanup: never fatal.
    }
  };

  /** True only while the user has text queued for this run; never true for a notification. */
  const userIsWaiting = (ctx: HoldContext | undefined): boolean => {
    try {
      const probe = ctx?.hasPendingMessages;
      return typeof probe === "function" && probe.call(ctx) === true;
    } catch {
      return false; // a stale ctx getter must not end (or fail) the hold
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
   * Exits (0.4.2 had two; 修订 3 adds the interactive ones — the block comment “Why the hold may
   * leave early” above documents why the old "no early-release heuristic" rule does not apply):
   *
   * 1. every task terminal → the results entry owns the completion;
   * 2. the budget ran out → bare settle, exactly as without the hold;
   * 3. the user pressed Esc → bare settle **now**, observed through `ui.onTerminalInput` (never wait
   *    for the budget: the host cannot preempt this handler, and the run cannot become idle until it
   *    returns). The keystroke is never consumed, so pi still runs its own abort;
   * 4. the user queued a message → bare settle, so the host delivers it on the next turn;
   * 5. dispose / a throwing registry → bare settle.
   *
   * Every non-1 exit releases the intercepted notifications, so the completion is never lost.
   *
   * `snapshot` is the set of tasks observed when the boundary opened — a task started while we
   * wait is not ours to wait for, and `ids` is derived from it. Nothing here changes task state or
   * consumes output (D-7); only `registry.list` is read, and a throw from it (registry
   * suspended/shut down under us) ends the hold.
   *
   * The budget runs on `performance.now()` (monotonic, 修订 1 / F4) so a wall-clock jump can never
   * stretch a hold past `holdMs`.
   */
  const holdUntilSettled = async (ctx: HoldContext | undefined, snapshot: TaskSnapshot[]): Promise<boolean> => {
    const ids = snapshot.map((task) => task.taskId);
    const startedAt = performance.now();
    // 修订 5: the row names these, so the snapshot has to survive outside the poll's `try` block.
    // Names refresh once per poll (1 s by default); the elapsed per task ticks every frame.
    let live = snapshot;

    let interrupted = false;
    let wake = (): void => undefined;
    const interruptedPromise = new Promise<void>((resolve) => { wake = resolve; });
    const interrupt = (): void => {
      if (interrupted) return;
      interrupted = true;
      wake();
    };

    // 修订 3: the one host channel that can carry "the user pressed Esc" out of this boundary. It is
    // optional and guarded — a host without it keeps the 0.4.2 behaviour (budget only).
    const detach: Array<() => void> = [];
    try {
      const ui = ctx?.ui;
      const onTerminalInput = ui?.onTerminalInput;
      if (typeof onTerminalInput === "function") {
        // A lone ESC (0x1b). Arrow/Alt keys arrive as `\x1b[A` / `\x1b a`, so they stay untouched;
        // nothing is ever consumed, the host keeps its own Esc meaning (`abort()` → run aborted).
        const off = onTerminalInput.call(ui, (data: string) => {
          if (data === "\x1b") interrupt();
          return undefined;
        });
        if (typeof off === "function") detach.push(off as () => void);
      }
    } catch { /* non-interactive host: no raw input */ }

    setFooter(ctx, live, 0);
    setWaiting(ctx, live, 0, 0);
    let tick = 0;
    const refresh = setInterval(() => setFooter(ctx, live, performance.now() - startedAt), footerRefreshMs);
    refresh.unref?.();
    const progress = setInterval(() => setWaiting(ctx, live, performance.now() - startedAt, ++tick), PROGRESS_FRAME_MS);
    progress.unref?.();
    try {
      // A message queued before the hold opened is the same signal as one queued during it.
      if (interrupted || userIsWaiting(ctx)) return false;
      while (performance.now() - startedAt < holdMs) {
        // Never sleep past the deadline: the total cost stays holdMs + one poll (D-6). Race the
        // sleep against the interrupt so Esc is honoured in milliseconds, not a poll interval.
        await Promise.race([
          sleep(Math.min(pollMs, holdMs - (performance.now() - startedAt))),
          interruptedPromise,
        ]);
        if (disposed) return false;
        if (interrupted) return false; // Esc (lone \x1b on the raw-input channel): settle now
        if (userIsWaiting(ctx)) return false; // the user is waiting for this turn to end
        let stillLive: TaskSnapshot[];
        try {
          stillLive = registry.list({ includeHistory: false }).filter((task) => ids.includes(task.taskId));
        } catch {
          // D-5: the registry can be suspended/shut down while we wait — stop, never throw.
          return false;
        }
        if (stillLive.length === 0) return true; // D-6 normal path: the whole snapshot finished.
        live = stillLive; // 修订 5: the ticker reads this array, so the names follow the poll.
      }
      return false; // timeout: the run settles exactly as it would have without the hold (D-6).
    } finally {
      clearInterval(refresh);
      clearInterval(progress);
      clearWaiting(ctx);
      clearFooter(ctx);
      for (const off of detach.splice(0)) {
        try { off(); } catch { /* the host ctx may already be stale */ }
      }
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
      // Arm ownership before the first poll: `onFinalize` for these ids runs in the same tick the
      // process exits, always before the poll that observes the terminal state can look.
      notify?.open(ids);
      if (!(await holdUntilSettled(context, candidates))) {
        // Timeout, disposal or a throwing registry: settle as before, with no entries and no
        // `continue` (D-6) — and hand any intercepted completion back to its normal sender.
        notify?.release();
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
      // CONTRACT §7.1 修订 3: the entry below is the one announcement of these terminal states, so
      // the deferred notifications are dropped — and latched, or `resendUnnotified` would announce
      // them again on the next `session_start`. The latch is guarded because library/mock registries
      // need not implement it (the real one does: `registry.ts:867`).
      for (const taskId of notify?.commit(ids) ?? []) {
        try {
          if (typeof registry.markNotified === "function") registry.markNotified(taskId);
        } catch { /* the entry already reached the transcript; a failed latch only risks a resend */ }
      }
      // Any drafts pi already queued for this boundary stay in front of ours.
      const queued = (event as BeforeSettleEvent | undefined)?.entries;
      return { entries: [...(Array.isArray(queued) ? queued : []), results], continue: true };
    } catch {
      // D-6: the hold is a courtesy — any failure lets the turn settle exactly as it would have,
      // and a notification it intercepted goes back to its normal sender instead of being lost.
      try { notify?.release(); } catch { /* the release path is itself best-effort */ }
      return undefined;
    }
  };

  const dispose = (): void => {
    // Idempotent: a second call (and a late `session_shutdown`) is a no-op.
    if (disposed) return;
    disposed = true;
    // A hold still in flight resolves through `holdUntilSettled` and releases its own deferrals;
    // a hold that was never armed leaves nothing here. Belt and braces: never lose a notification.
    notify?.release();
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
