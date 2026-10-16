const ANSI_ESCAPE = /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\|\x9C)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1B\\|[ -/]*[0-~])|\x9B[0-?]*[ -/]*[@-~]|\x9D[\s\S]*?(?:\x07|\x1B\\|\x9C)/g;

/** Remove ANSI escape, CSI, OSC, and string-control sequences from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * Strip bare C0 control bytes (except TAB/LF/CR which are folded to spaces)
 * and collapse runs of whitespace. Use after stripAnsi for TUI-visible text.
 * Keeps panel and rail sanitization aligned (CONTRACT §9 / issue #3).
 */
export function stripControl(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/[\r\n\t]+/g, " ");
}

/** ANSI + C0 sanitizer for TUI labels (task names, panel rows). */
export function visibleText(value: unknown): string {
  return stripControl(stripAnsi(String(value ?? "")));
}
