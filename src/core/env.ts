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
