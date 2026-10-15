import type { Condition, WatchSpec } from "./task.ts";

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

  for (const [index, condition] of [...spec.success_when, ...spec.failure_when].entries()) {
    if (!condition || typeof condition !== "object" || !("type" in condition)) {
      return invalid(`condition ${index + 1} is invalid`);
    }
    switch (condition.type) {
      case "exit_code":
        if (!Number.isFinite(condition.equals)) return invalid(`condition ${index + 1}: equals must be finite`);
        break;
      case "stdout_contains":
      case "stderr_contains":
        if (typeof condition.value !== "string") return invalid(`condition ${index + 1}: value must be a string`);
        break;
      case "json_path_exists":
        if (typeof condition.path !== "string" || parseJsonPath(condition.path) === undefined) {
          return invalid(`condition ${index + 1}: invalid JSON path`);
        }
        break;
      case "output_matches":
        if (typeof condition.regex !== "string") return invalid(`condition ${index + 1}: regex must be a string`);
        try {
          new RegExp(condition.regex);
        } catch {
          return invalid(`condition ${index + 1}: invalid regex`);
        }
        break;
      default:
        return invalid(`condition ${index + 1}: unknown condition type`);
    }
  }
  return { ok: true };
}

export function evalConditions(conds: Condition[], ctx: { output: string; exitCode?: number }): boolean {
  return conds.some((condition) => evaluateCondition(condition, ctx).matched);
}

export interface WatchLoopDeps {
  taskId: string;
  spec: WatchSpec;
  readOutput: () => string;
  getExitCode: () => number | undefined;
  onSuccess: (detail: string) => void;
  onFailure: () => void;
  onBlindExhausted: () => void;
  onWatchTimeout: () => void;
}

export class WatchLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private deadline = 0;
  private blindCount = 0;
  private readonly deps: WatchLoopDeps;

  constructor(deps: WatchLoopDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped) return;
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
    let output = "";
    let exitCode: number | undefined;
    try {
      if (needsOutput) output = this.deps.readOutput();
      if (needsExitCode) exitCode = this.deps.getExitCode();
    } catch {
      this.blindCount++;
      if (this.blindCount >= (this.deps.spec.blind_checks ?? 3)) {
        this.finish(this.deps.onBlindExhausted);
        return;
      }
      this.scheduleNext();
      return;
    }

    const ctx = { output, exitCode };
    const failure = evaluateConditionsDetailed(this.deps.spec.failure_when, ctx);
    if (failure.match) {
      this.finish(this.deps.onFailure);
      return;
    }
    const success = evaluateConditionsDetailed(this.deps.spec.success_when, ctx);
    if (success.match) {
      const matched = success.match;
      this.finish(() => this.deps.onSuccess(`success_when matched: ${JSON.stringify(matched)}`));
      return;
    }

    const configured = conditions.map((condition) => evaluateCondition(condition, ctx));
    if (configured.length > 0 && configured.every((result) => !result.evaluable)) {
      this.blindCount++;
      if (this.blindCount >= (this.deps.spec.blind_checks ?? 3)) {
        this.finish(this.deps.onBlindExhausted);
        return;
      }
    } else {
      this.blindCount = 0;
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
    this.stop();
    callback();
  }
}

type ConditionEvaluation = { evaluable: boolean; matched: boolean };
type ConditionMatch = Condition & { type: Condition["type"] };

function evaluateConditionsDetailed(conditions: Condition[], ctx: { output: string; exitCode?: number }): {
  match?: ConditionMatch;
} {
  for (const condition of conditions) {
    const result = evaluateCondition(condition, ctx);
    if (result.evaluable && result.matched) return { match: condition };
  }
  return {};
}

function evaluateCondition(condition: Condition, ctx: { output: string; exitCode?: number }): ConditionEvaluation {
  switch (condition.type) {
    case "exit_code":
      return ctx.exitCode === undefined
        ? { evaluable: false, matched: false }
        : { evaluable: true, matched: ctx.exitCode === condition.equals };
    case "stdout_contains":
    case "stderr_contains":
      // The frozen WatchLoop context exposes the captured merged output stream.
      return { evaluable: true, matched: ctx.output.includes(condition.value) };
    case "output_matches": {
      try {
        return { evaluable: true, matched: new RegExp(condition.regex).test(ctx.output) };
      } catch {
        // Validation should prevent this; treat mutated/invalid input as not matched.
        return { evaluable: false, matched: false };
      }
    }
    case "json_path_exists": {
      let root: unknown;
      try {
        root = JSON.parse(ctx.output);
      } catch {
        return { evaluable: false, matched: false };
      }
      const tokens = parseJsonPath(condition.path);
      if (tokens === undefined) return { evaluable: false, matched: false };
      let current = root;
      for (const token of tokens) {
        if (typeof token === "number") {
          if (!Array.isArray(current) || token >= current.length) return { evaluable: true, matched: false };
          current = current[token];
        } else {
          if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
            return { evaluable: true, matched: false };
          }
          current = (current as Record<string, unknown>)[token];
        }
      }
      return { evaluable: true, matched: true };
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
