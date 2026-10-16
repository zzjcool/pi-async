import type { Condition, WatchSpec } from "./task.ts";

const compiledRegexes = new WeakMap<Condition, RegExp>();

/** Captured streams for watch evaluation: stdout/stderr are distinct; output is merged. */
export interface WatchOutput {
  output: string;
  stdout: string;
  stderr: string;
}

/** Cap regex subject size so catastrophic patterns cannot grow without bound (#24). */
export const MAX_OUTPUT_MATCH_BYTES = 64 * 1024;

/**
 * Classic exponential-backtracking shape: a group that itself ends with a
 * quantifier, then another quantifier — e.g. (a+)+ / (a*)* / (a|b+)+.
 * Conservative; does not catch every polynomial case.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*]\)\s*[+*]/;

function rejectDangerousRegex(regex: string): string | undefined {
  if (NESTED_QUANTIFIER.test(regex)) {
    return "regex has nested quantifiers (ReDoS risk); simplify or use stdout_contains";
  }
  return undefined;
}

function matchSubject(output: string): string {
  if (output.length <= MAX_OUTPUT_MATCH_BYTES) return output;
  return output.slice(-MAX_OUTPUT_MATCH_BYTES);
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
            compiledRegexes.set(condition, new RegExp(condition.regex, "m"));
          } catch {
            return invalid(`${location}: invalid regex`);
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

export function evalConditions(conds: Condition[], ctx: WatchEvalContext): boolean {
  const result = evaluateConditionsDetailed(conds, ctx);
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
}

export class WatchLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private finished = false;
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
    this.check();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private check(): void {
    if (this.stopped) return;
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
    const failure = evaluateConditionsDetailed(this.deps.spec.failure_when, ctx);
    if (failure.status === "matched" && failure.matched) {
      this.finish(this.deps.onFailure);
      return;
    }
    const success = evaluateConditionsDetailed(this.deps.spec.success_when, ctx);
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
      this.blindCount = 0;
      this.scheduleNext();
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
      this.check();
    }, Math.min(this.deps.spec.intervalMs, remaining));
  }

  private finish(callback: () => void): void {
    this.finished = true;
    this.stop();
    callback();
  }
}

type ConditionEvaluation =
  | { status: "matched"; matched: boolean; condition?: Condition }
  | { status: "pending" }
  | { status: "error" };

function evaluateConditionsDetailed(conditions: Condition[], ctx: WatchEvalContext): ConditionEvaluation {
  let pending = false;
  let error = false;
  for (const condition of conditions) {
    const result = evaluateCondition(condition, ctx);
    if (result.status === "matched" && result.matched) return { status: "matched", matched: true, condition };
    if (result.status === "pending") pending = true;
    if (result.status === "error") error = true;
  }
  if (error) return { status: "error" };
  if (pending) return { status: "pending" };
  return { status: "matched", matched: false };
}

function evaluateCondition(condition: Condition, ctx: WatchEvalContext): ConditionEvaluation {
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
      let regex = compiledRegexes.get(condition);
      if (!regex) {
        try {
          regex = new RegExp(condition.regex, "m");
          compiledRegexes.set(condition, regex);
        } catch {
          return { status: "error" };
        }
      }
      // Global/sticky expressions otherwise retain lastIndex between watch polls.
      regex.lastIndex = 0;
      return { status: "matched", matched: regex.test(matchSubject(ctx.output)) };
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
