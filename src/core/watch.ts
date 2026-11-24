import type { Condition, WatchSpec } from "./task.ts";
import { evaluateWithBudget } from "./regex-worker.ts";

/** Captured streams for watch evaluation: stdout/stderr are distinct; output is merged. */
export interface WatchOutput {
  output: string;
  stdout: string;
  stderr: string;
}

/**
 * Cap the regex subject (REV-25 / #24).
 *
 * This is a **memory / trade-off bound**, not a ReDoS defence: it keeps the subject a single
 * evaluation has to copy and `slice` bounded. Backtracking work is NOT bounded by it — 19 code
 * units already blow a 25 ms budget and 26 code units froze the loop for 5 s
 * (`docs/reports/redos-benchmark.md` §4.2). The defence against catastrophic shapes is the
 * preemptible per-eval budget (REV-34), never the window size.
 *
 * The value is a count of **UTF-16 code units** (`String.length` / `String.prototype.slice`), not
 * bytes — the old name `MAX_OUTPUT_MATCH_BYTES` claimed otherwise and was misleading.
 */
export const MAX_MATCH_CHARS = 64 * 1024;

/**
 * Classic exponential-backtracking shape: a group that itself ends with a
 * quantifier, then another quantifier — e.g. (a+)+ / (a*)* / (a|b+)+.
 *
 * Depth defence only (REV-34 ruling 4): shape matching can never be complete — `(a|a)*$` and
 * `(.*a){20}$` pass this check and still hang — so the real defence is the runtime budget.
 * Conservative; does not catch every polynomial case.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*]\)\s*[+*]/;

/**
 * Global inline flags — `(?i)` / `(?m)` / `(?s)` / `(?x)`. JavaScript has no such syntax for a
 * whole pattern (only ES2025 modifier groups, `(?i:...)`), so these always throw `Invalid group`
 * while the fix is mechanical: a character class. Matched here so the error can name the fix
 * instead of echoing V8's opaque "Invalid group". See the `(?i)` incident in #48 follow-up.
 */
const INLINE_FLAGS = /\(\?[imsx]+\)/;

function rejectDangerousRegex(regex: string): string | undefined {
  if (NESTED_QUANTIFIER.test(regex)) {
    return "regex has nested quantifiers (ReDoS risk); simplify or use stdout_contains";
  }
  return undefined;
}

/** Compile-explanation shared by both invalid-regex errors: flags are fixed, never caller-chosen. */
const REGEX_COMPILE_NOTE = 'compiled as new RegExp(regex, "m")';

function matchSubject(output: string): string {
  if (output.length <= MAX_MATCH_CHARS) return output;
  return output.slice(-MAX_MATCH_CHARS);
}

export function validateWatchSpec(spec: WatchSpec): { ok: true } | { ok: false; error: string } {
  const invalid = (error: string) => ({ ok: false as const, error });
  if (!spec || typeof spec !== "object") return invalid("watch must be an object");
  if (!Number.isFinite(spec.intervalMs) || !Number.isInteger(spec.intervalMs) || spec.intervalMs < 1_000) {
    return invalid("intervalMs must be an integer greater than or equal to 1000");
  }
  if (!Number.isFinite(spec.timeoutMs) || !Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    return invalid("timeoutMs must be a positive finite integer");
  }
  if (spec.blind_checks !== undefined &&
      (!Number.isFinite(spec.blind_checks) || !Number.isInteger(spec.blind_checks) || spec.blind_checks < 1)) {
    return invalid("blind_checks must be a positive integer");
  }
  if (!Array.isArray(spec.success_when) || !Array.isArray(spec.failure_when)) {
    return invalid("success_when and failure_when must be arrays");
  }

  for (const [group, conditions] of [
    ["success_when", spec.success_when],
    ["failure_when", spec.failure_when],
  ] as const) {
    for (const [index, condition] of conditions.entries()) {
      const location = `${group}[${index}]`;
      if (!condition || typeof condition !== "object" || !("type" in condition)) {
        return invalid(`${location} is invalid`);
      }
      switch (condition.type) {
        case "exit_code":
          if (!Number.isFinite(condition.equals)) return invalid(`${location}: equals must be finite`);
          break;
        case "stdout_contains":
        case "stderr_contains":
          if (typeof condition.value !== "string") return invalid(`${location}: value must be a string`);
          break;
        case "json_path_exists":
          if (typeof condition.path !== "string" || parseJsonPath(condition.path) === undefined) {
            const shown = typeof condition.path === "string" ? JSON.stringify(condition.path) : String(condition.path);
            return invalid(`${location}: invalid JSON path ${shown}: paths must start with "$" (e.g. $.ready or $.items[0].state)`);
          }
          break;
        case "output_matches":
          if (typeof condition.regex !== "string") return invalid(`${location}: regex must be a string`);
          {
            const danger = rejectDangerousRegex(condition.regex);
            if (danger) return invalid(`${location}: ${danger}`);
          }
          try {
            // Compile here only to fail fast at attach time; the evaluation itself runs in the
            // budgeted worker, which owns the per-pattern cache (REV-34).
            new RegExp(condition.regex, "m");
          } catch (error) {
            // Never collapse the reason: V8 distinguishes "Unterminated character class" from
            // "Invalid group" (inline flags), and the caller can only fix what it is told.
            const shown = JSON.stringify(condition.regex);
            const reason = error instanceof Error ? (error.message.split(": ").pop() ?? error.message) : String(error);
            return invalid(
              INLINE_FLAGS.test(condition.regex)
                ? `${location}: invalid regex ${shown}: ${reason}; ${REGEX_COMPILE_NOTE} and JavaScript takes no inline flags — drop the flag and use a character class (e.g. [Ff][Aa][Tt][Aa][Ll]) or stdout_contains`
                : `${location}: invalid regex ${shown}: ${reason} (${REGEX_COMPILE_NOTE})`,
            );
          }
          break;
        default:
          return invalid(`${location}: unknown condition type`);
      }
    }
  }
  return { ok: true };
}

export type WatchEvalContext = WatchOutput & { exitCode?: number };

/**
 * REV-34: `output_matches` is evaluated in the budgeted worker thread, so this entry point is
 * async. There is deliberately **no** synchronous variant left — a sync path is exactly the shape
 * that froze the host for seconds on a 26-code-unit input (#113).
 */
export async function evalConditions(conds: Condition[], ctx: WatchEvalContext): Promise<boolean> {
  const result = await evaluateConditionsDetailed(conds, ctx);
  return result.status === "matched" && result.matched;
}

export interface WatchLoopDeps {
  taskId: string;
  spec: WatchSpec;
  readOutput: () => WatchOutput;
  getExitCode: () => number | undefined;
  onSuccess: (detail: string) => void;
  onFailure: () => void;
  onBlindExhausted: () => void;
  onWatchTimeout: () => void;
  /**
   * REV-34 ruling 2: `count` evaluations burned their budget this round (each was treated as "not
   * matched"). The loop never turns this into a failure — the registry owns the counter and the
   * one-time notice.
   */
  onMatchBudgetExceeded?: (count: number) => void;
}

export class WatchLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private finished = false;
  /** REV-34: a tick awaits the worker, so two ticks must never overlap. */
  private checking = false;
  private deadline = 0;
  private blindCount = 0;
  private readonly deps: WatchLoopDeps;

  constructor(deps: WatchLoopDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped || this.finished) return;
    this.stopped = false;
    this.blindCount = 0;
    this.deadline = Date.now() + this.deps.spec.timeoutMs;
    void this.check();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped || this.finished || this.checking) return;
    this.checking = true;
    try {
      await this.round();
    } catch (error) {
      // A throwing dep must not become an unhandled rejection now that the tick is async.
      console.error(`pi-async: watch tick failed for task ${this.deps.taskId}`, error);
    } finally {
      this.checking = false;
    }
  }

  private async round(): Promise<void> {
    if (Date.now() >= this.deadline) {
      this.finish(this.deps.onWatchTimeout);
      return;
    }

    const conditions = [...this.deps.spec.failure_when, ...this.deps.spec.success_when];
    const needsOutput = conditions.some((condition) => condition.type !== "exit_code");
    const needsExitCode = conditions.some((condition) => condition.type === "exit_code");
    let streams: WatchOutput = { output: "", stdout: "", stderr: "" };
    let exitCode: number | undefined;
    try {
      if (needsOutput) streams = this.deps.readOutput();
      if (needsExitCode) exitCode = this.deps.getExitCode();
    } catch {
      this.countBlindCheck();
      return;
    }

    const ctx: WatchEvalContext = { ...streams, exitCode };
    const failure = await evaluateConditionsDetailed(this.deps.spec.failure_when, ctx);
    // REV-34 / REV-R5: the await is a suspension point. The task may have been settled while the
    // regex ran in the worker (watch timeout, `async_kill`, generation retire → `stop()`); a
    // terminal snapshot is the record, so a stale loop must not act, re-schedule or overwrite it.
    if (this.stopped || this.finished) return;
    this.noteBudget(failure.budgetExceeded);
    if (failure.status === "matched" && failure.matched) {
      this.finish(this.deps.onFailure);
      return;
    }
    const success = await evaluateConditionsDetailed(this.deps.spec.success_when, ctx);
    if (this.stopped || this.finished) return;
    this.noteBudget(success.budgetExceeded);
    if (success.status === "matched" && success.matched) {
      const matched = success.condition;
      this.finish(() => this.deps.onSuccess(`success_when matched: ${JSON.stringify(matched)}`));
      return;
    }

    // Pending observations (e.g. a process still running or incomplete JSON output)
    // are not infrastructure failures and must not consume the blind-check budget.
    if (failure.status === "error" || success.status === "error") {
      this.countBlindCheck();
    } else {
      // REV-34 ruling 2: an over-budget round lands here — a plain "not matched" round. Blind
      // checks are not consumed, `timeoutMs` is untouched, nothing is killed.
      this.blindCount = 0;
      this.scheduleNext();
    }
  }

  /** REV-34 ruling 2: report burned budgets; never a failure, never a kill. */
  private noteBudget(count: number): void {
    if (count <= 0) return;
    try {
      this.deps.onMatchBudgetExceeded?.(count);
    } catch (error) {
      console.error(`pi-async: match-budget listener failed for task ${this.deps.taskId}`, error);
    }
  }

  private countBlindCheck(): void {
    this.blindCount++;
    if (this.blindCount >= (this.deps.spec.blind_checks ?? 3)) {
      this.finish(this.deps.onBlindExhausted);
      return;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      this.finish(this.deps.onWatchTimeout);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, Math.min(this.deps.spec.intervalMs, remaining));
  }

  private finish(callback: () => void): void {
    this.finished = true;
    this.stop();
    callback();
  }
}

/** One condition's verdict. `budget` is REV-34's "no verdict this round" (see below). */
type ConditionResult =
  | { status: "matched"; matched: boolean }
  | { status: "pending" }
  | { status: "error" }
  /**
   * REV-34 ruling 2: the evaluation burned its budget. Treated as **not matched** for this round —
   * not pending (pending would still be "waiting for a verdict"), not error (error consumes the
   * `blind_checks` budget for infrastructure failures).
   */
  | { status: "budget" };

/** Aggregate verdict of one condition group, plus the burned-budget count of that round. */
export interface DetailedEvaluation {
  status: "matched" | "pending" | "error";
  matched: boolean;
  condition?: Condition;
  /** REV-34: how many `output_matches` evaluations of this group ran out of budget this round. */
  budgetExceeded: number;
}

export async function evaluateConditionsDetailed(conditions: Condition[], ctx: WatchEvalContext): Promise<DetailedEvaluation> {
  let pending = false;
  let error = false;
  let budgetExceeded = 0;
  for (const condition of conditions) {
    const result = await evaluateCondition(condition, ctx);
    if (result.status === "matched" && result.matched) return { status: "matched", matched: true, condition, budgetExceeded };
    if (result.status === "budget") { budgetExceeded++; continue; }
    if (result.status === "pending") pending = true;
    if (result.status === "error") error = true;
  }
  if (error) return { status: "error", matched: false, budgetExceeded };
  if (pending) return { status: "pending", matched: false, budgetExceeded };
  return { status: "matched", matched: false, budgetExceeded };
}

async function evaluateCondition(condition: Condition, ctx: WatchEvalContext): Promise<ConditionResult> {
  switch (condition.type) {
    case "exit_code":
      return ctx.exitCode === undefined
        ? { status: "pending" }
        : { status: "matched", matched: ctx.exitCode === condition.equals };
    case "stdout_contains":
      return { status: "matched", matched: ctx.stdout.includes(condition.value) };
    case "stderr_contains":
      return { status: "matched", matched: ctx.stderr.includes(condition.value) };
    case "output_matches": {
      // REV-34: never evaluated on this thread — a catastrophic pattern would freeze the host.
      const result = await evaluateWithBudget(condition.regex, matchSubject(ctx.output));
      if (result.status === "budget") return { status: "budget" };
      if (result.status === "error") return { status: "error" };
      return { status: "matched", matched: result.matched };
    }
    case "json_path_exists": {
      let root: unknown;
      try {
        root = JSON.parse(ctx.output);
      } catch {
        return { status: "pending" };
      }
      const tokens = parseJsonPath(condition.path);
      if (tokens === undefined) return { status: "error" };
      let current = root;
      for (const token of tokens) {
        if (typeof token === "number") {
          if (!Array.isArray(current) || token >= current.length) return { status: "matched", matched: false };
          current = current[token];
        } else {
          if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
            return { status: "matched", matched: false };
          }
          current = (current as Record<string, unknown>)[token];
        }
      }
      return { status: "matched", matched: true };
    }
  }
}

function parseJsonPath(path: string): Array<string | number> | undefined {
  if (!path.startsWith("$") || path.length === 0) return undefined;
  const tokens: Array<string | number> = [];
  let index = 1;
  while (index < path.length) {
    if (path[index] === ".") {
      const start = ++index;
      if (index >= path.length || !/[A-Za-z_$]/.test(path[index]!)) return undefined;
      index++;
      while (index < path.length && /[A-Za-z0-9_$-]/.test(path[index]!)) index++;
      tokens.push(path.slice(start, index));
      continue;
    }
    if (path[index] === "[") {
      const end = path.indexOf("]", index + 1);
      if (end < 0) return undefined;
      const raw = path.slice(index + 1, end);
      if (!/^\d+$/.test(raw)) return undefined;
      const arrayIndex = Number(raw);
      if (!Number.isSafeInteger(arrayIndex)) return undefined;
      tokens.push(arrayIndex);
      index = end + 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}
