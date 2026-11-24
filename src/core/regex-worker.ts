import { Worker, isMainThread, parentPort } from "node:worker_threads";

/**
 * Preemptible `output_matches` evaluation (CONTRACT §26 / REV-34 / #113).
 *
 * Why a worker at all: the regex used to be evaluated on the main thread, so a catastrophic shape
 * froze the whole host for seconds — a 100 ms timer armed before the evaluation fired 3.12 s late
 * (`docs/reports/redos-benchmark.md` §5). "Evaluate, then measure how long it took" cannot fix
 * that: during a synchronous evaluation *nothing else in the process runs*, so there is no point
 * at which anyone could preempt it. The evaluation therefore has to leave the thread.
 *
 * The budget is a hard, per-evaluation wall clock (one condition, one round). It starts when the
 * request is posted to a worker that has already finished loading — worker start-up is NOT part of
 * the budget, otherwise the first evaluation of a benign pattern would be a false positive. On
 * overrun the worker is `terminate()`d and rebuilt, because the thread is stuck in a C++ regex
 * call and will never come back; the next round gets a fresh worker (a one-off cold start, not a
 * per-round cost).
 *
 * This file is both halves: loaded as a module it owns the pool (main thread), loaded as a worker
 * entry (`new URL(import.meta.url)`) it only runs the child block below.
 */

/** CONTRACT §26: hard per-evaluation budget for one `output_matches` regex. */
export const MATCH_BUDGET_MS = 25;

export type BudgetedMatch =
  /** The regex ran inside its budget and produced a verdict. */
  | { status: "matched"; matched: boolean }
  /**
   * The evaluation ran out of budget. REV-34 ruling 2: this round counts as **not matched** — it is
   * not a failure, not an infrastructure error and never a kill.
   */
  | { status: "budget" }
  /** The worker could not run the pattern (compile error, dead/unspawnable worker). */
  | { status: "error"; reason: string };

/* ────────────────────────────── worker side (child thread) ────────────────────────────── */

interface Request {
  id: number;
  pattern: string;
  source: string;
}

type Reply = { ready: true } | { id: number; matched: boolean } | { id: number; error: string };

if (!isMainThread && parentPort) {
  const port = parentPort;
  /**
   * Patterns compiled in this worker, keyed by pattern text.
   *
   * The synchronous implementation cached one `RegExp` per condition object, which made the first
   * evaluation of a shape "cold" (~6× the warm cost, `docs/reports/redos-benchmark.md` §4.3) and
   * every later round warm. Caching by pattern text reproduces exactly that shape of cost: one
   * cold evaluation per pattern per worker, warm after that.
   */
  const compiled = new Map<string, RegExp>();
  port.on("message", (request: Request) => {
    const { id, pattern, source } = request;
    try {
      let regex = compiled.get(pattern);
      if (!regex) {
        regex = new RegExp(pattern, "m");
        compiled.set(pattern, regex);
      }
      // Global/sticky expressions otherwise retain lastIndex between rounds.
      regex.lastIndex = 0;
      port.postMessage({ id, matched: regex.test(source) } satisfies Reply);
    } catch (error) {
      // A pattern that compiled during validation can still fail here (engine limits, memory);
      // report it as an error rather than silently answering "no match".
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies Reply);
    }
  });
  // Tell the pool the module graph is loaded: everything before the first request is start-up
  // cost and must stay outside the budget.
  port.postMessage({ ready: true } satisfies Reply);
}

/* ────────────────────────────── pool side (main thread) ────────────────────────────── */

interface Waiter {
  resolve: (result: BudgetedMatch) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Pool {
  worker: Worker;
  ready: Promise<Worker>;
}

let pool: Pool | undefined;
let nextId = 1;
const waiting = new Map<number, Waiter>();
/** Set once if a worker could not be spawned, so the failure is logged once and not per round. */
let spawnFailureLogged = false;

function logOnce(message: string, error: unknown): void {
  if (spawnFailureLogged) return;
  spawnFailureLogged = true;
  console.error(`pi-async: ${message}`, error);
}

/** Answer every in-flight request with `error`; the worker that owned them is gone. */
function failAll(reason: string): void {
  for (const [id, waiter] of [...waiting]) {
    waiting.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve({ status: "error", reason });
  }
}

function teardown(reason: string): void {
  const current = pool;
  pool = undefined;
  failAll(reason);
  if (!current) return;
  // `terminate()` is async and the thread may be stuck in a regex call: do not await it, the
  // replacement worker is created on demand by the next evaluation.
  void current.worker.terminate().catch(() => undefined);
}

/**
 * Ref/unref the worker around in-flight work.
 *
 * An idle regex worker must never pin the host (it would keep `pi` — and a finished test process —
 * alive forever), but an unref'd worker with a request in flight is not enough either: a pending
 * promise does not keep the event loop alive, so node would exit mid-evaluation
 * (`ERR_TEST_FAILURE: Promise resolution is still pending but the event loop has already
 * resolved`). So: ref while a request is outstanding, unref the moment the last one settles.
 */
function noteIdle(worker: Worker): void {
  if (waiting.size === 0) worker.unref();
}

function spawn(): Pool {
  const worker = new Worker(new URL(import.meta.url), { name: "pi-async-regex" });
  let resolveReady!: (worker: Worker) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<Worker>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const created: Pool = { worker, ready };
  worker.on("message", (message: Reply) => {
    if ("ready" in message) {
      resolveReady(worker);
      return;
    }
    const waiter = waiting.get(message.id);
    if (!waiter) return; // late answer after a budget kill — already settled
    waiting.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve("error" in message ? { status: "error", reason: message.error } : { status: "matched", matched: message.matched });
    noteIdle(worker);
  });
  const die = (error: unknown) => {
    if (pool === created) teardown(`regex worker unavailable: ${String(error)}`);
    rejectReady(error);
    logOnce("regex worker failed; output_matches cannot be evaluated", error);
  };
  worker.on("error", die);
  worker.on("exit", (code) => { if (pool === created) die(`regex worker exited with code ${code}`); });
  // Adding a `message` listener refs the port again, so an `unref()` before the listeners are
  // attached is silently undone (measured on node 22.22: the process then hangs with a live worker
  // and no other work). The worker is created for a request that is about to be posted, so it stays
  // ref'd here and is dropped by `noteIdle()` once the last request settles.
  return created;
}

function ensurePool(): Promise<Worker> {
  if (!pool) pool = spawn();
  return pool.ready;
}

/**
 * Evaluate `pattern` against `source` with a hard budget. Never throws.
 *
 * The caller gets `budget` for "no verdict this round" (REV-34 ruling 2) and `error` for "the
 * checker itself is broken" (REV-25 blind-check accounting).
 */
export function evaluateWithBudget(pattern: string, source: string, budgetMs: number = MATCH_BUDGET_MS): Promise<BudgetedMatch> {
  return ensurePool().then(
    (worker) => new Promise<BudgetedMatch>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        // The thread is stuck inside the regex engine: it will never answer. Kill it and let the
        // next evaluation build a fresh one, so one pathological pattern cannot poison later rounds.
        teardown(`match budget of ${budgetMs} ms exceeded`);
        resolve({ status: "budget" });
      }, budgetMs);
      waiting.set(id, { resolve, timer });
      worker.ref();
      try {
        worker.postMessage({ id, pattern, source } satisfies Request);
      } catch (error) {
        waiting.delete(id);
        clearTimeout(timer);
        noteIdle(worker);
        resolve({ status: "error", reason: error instanceof Error ? error.message : String(error) });
      }
    }),
    (error: unknown) => ({ status: "error", reason: error instanceof Error ? error.message : String(error) }),
  );
}

/**
 * Drop the worker (registry shutdown / tests). Idempotent and safe to call with nothing running:
 * a leftover ref'd thread would keep a test process alive after its assertions passed.
 */
export function disposeRegexWorker(): void {
  if (!pool) {
    failAll("regex worker disposed");
    return;
  }
  teardown("regex worker disposed");
}

/** Test hook: true when a worker is currently alive (used to assert reuse instead of re-spawn). */
export function regexWorkerAlive(): boolean {
  return pool !== undefined;
}
