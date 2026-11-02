export interface EnvNumberOpts {
  min?: number;
  max?: number;
  /** When true, non-integers fall back (avoids Number("")===0 and 2.7→3 surprises). */
  integer?: boolean;
}

/**
 * Parse a numeric env var with empty-string → fallback (not Number("")===0).
 * Non-finite / out-of-range / non-integer (when requested) also fall back.
 */
export function envNumber(name: string, fallback: number, opts?: EnvNumberOpts): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  if (opts?.integer && !Number.isInteger(parsed)) return fallback;
  if (opts?.min !== undefined && parsed < opts.min) return fallback;
  if (opts?.max !== undefined && parsed > opts.max) return fallback;
  return parsed;
}

/** Child environment inheritance policy (REV-16). `safe` is the default. */
export type EnvPolicy = "safe" | "all" | "none";

/** Keys whose inheritance would silently change how the child resolves code (REV-16). */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PYTHONPATH",
  "GIT_SSH_COMMAND",
]);

/** Suffix families treated as credentials under `safe` inheritance. */
const SENSITIVE_SUFFIX = /_(API_KEY|TOKEN|SECRET|PASSWORD)$/i;
const SENSITIVE_SUBSTRING = /CREDENTIAL/i;
const SENSITIVE_EXPLICIT: ReadonlySet<string> = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
]);

/** `none` keeps only what a POSIX shell needs to start at all. */
const NONE_ALLOWED: ReadonlySet<string> = new Set(["PATH", "HOME", "SHELL", "TERM", "LANG", "TMPDIR", "USER"]);

/** Host-only tuning knob: never leaks into a child, under any policy. */
export const INTERNAL_MAX_OUTPUT_ENV = "PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES";

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_EXPLICIT.has(key) || SENSITIVE_SUFFIX.test(key) || SENSITIVE_SUBSTRING.test(key)) return true;
  // npm reads credentials from lower-case `npm_config_*` keys (e.g. npm_config__authToken).
  return key.toLowerCase().startsWith("npm_config_") && /(auth|token|password)/i.test(key);
}

function noneAllows(key: string): boolean {
  return NONE_ALLOWED.has(key) || key.startsWith("LC_");
}

function assignDefined(target: Record<string, string>, source: NodeJS.ProcessEnv | Record<string, string>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    target[key] = String(value);
  }
}

/**
 * Reject explicit overrides of process-resolution keys (`PATH`, `NODE_OPTIONS`, …).
 *
 * Exported so task-submission paths (e.g. delayed tasks, which spawn later) can fail fast
 * instead of surfacing the error only when the process is finally started. Applied by every
 * inheritance policy.
 */
export function assertSafeEnvKeys(extra: Record<string, string> | undefined, policyName?: EnvPolicy): void {
  if (!extra) return;
  const policyContext = policyName ? ` under env policy "${policyName}"` : "";
  for (const key of Object.keys(extra)) {
    if (!DANGEROUS_KEYS.has(key)) continue;
    throw new Error(
      `Refusing to set dangerous environment variable ${key} for an async task: ` +
        `explicit overrides of process-resolution keys are rejected${policyContext}. ` +
        `The inherited ${key} is used instead.`,
    );
  }
}

/**
 * Build the child environment for a task (pure: never mutates `base` or `extra`).
 *
 * - `safe`  (default): inherit `base` minus credential-ish keys; extra ordinary keys override.
 * - `all`   : legacy `{...base, ...extra}`.
 * - `none`  : only PATH/HOME/SHELL/TERM/LANG/LC_-prefixed/TMPDIR/USER from `base`, plus extra ordinary keys.
 *
 * In every policy an explicit dangerous key (`PATH`, `NODE_OPTIONS`, …) in `extra` throws,
 * and the internal output-cap knob is always stripped.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> | undefined,
  policy: EnvPolicy,
): Record<string, string> {
  assertSafeEnvKeys(extra, policy);
  const env: Record<string, string> = {};
  switch (policy) {
    case "all":
      assignDefined(env, base);
      break;
    case "none":
      for (const [key, value] of Object.entries(base)) {
        if (value === undefined || !noneAllows(key)) continue;
        env[key] = String(value);
      }
      break;
    case "safe":
    default:
      for (const [key, value] of Object.entries(base)) {
        if (value === undefined || isSensitiveKey(key)) continue;
        env[key] = String(value);
      }
      break;
  }
  assignDefined(env, extra ?? {});
  delete env[INTERNAL_MAX_OUTPUT_ENV];
  return env;
}
