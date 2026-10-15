/**
 * Bound TUI host context.
 *
 * pi's factory-time ExtensionAPI exposes neither `mode` nor `ui` — those live
 * on event-handler contexts (`pi.on(event, (event, ctx) => ...)`), and `ctx.ui`
 * is the only object whose setWidget/setStatus/custom actually work. All TUI
 * surfaces therefore bind lazily from the first event context whose
 * `mode === "tui"`, and read `tuiHost()` afterwards.
 */
export type TuiHost = { mode: string; ui: Record<string, unknown> };

let bound: TuiHost | undefined;

/** Bind the first TUI-capable event context. Idempotent; only the first wins. */
export function bindTuiHost(ctx: unknown): boolean {
  const c = ctx as { mode?: string; ui?: Record<string, unknown> } | undefined;
  if (bound || c?.mode !== "tui" || !c.ui) return false;
  bound = { mode: c.mode, ui: c.ui };
  return true;
}

/** The bound TUI host, or undefined when no TUI context has been seen. */
export function tuiHost(): TuiHost | undefined {
  return bound;
}

/** Test-only: forget the bound host so isolated unit tests can re-bind. */
export function resetTuiHostForTests(): void {
  bound = undefined;
}
