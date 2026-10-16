const ANSI_ESCAPE =
  /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\|\x9C)|\][\s\S]*$|\[[0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*$|[PX^_][\s\S]*?\x1B\\|[ -/]*[0-~])|\x9B[0-?]*[ -/]*[@-~]|\x9D[\s\S]*?(?:\x07|\x1B\\|\x9C)/g;

/** Keep tab/LF/CR; drop other C0 controls that must not reach model/TUI/XML. */
const C0_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** Remove ANSI escape, CSI, OSC, and string-control sequences from text.
 *  Unterminated OSC/CSI are dropped through end-of-string so truncation mid-sequence
 *  does not leave the payload as visible garbage (#32). */
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
    .replace(C0_CONTROLS, "")
    .replace(/[\r\n\t]+/g, " ");
}

/** ANSI + C0 sanitizer for TUI labels (task names, panel rows). */
export function visibleText(value: unknown): string {
  return stripControl(stripAnsi(String(value ?? "")));
}

/** Model/logs path: strip ANSI then bare C0, preserve TAB/LF/CR (#18). */
export function stripLogControls(text: string): string {
  return stripAnsi(text).replace(C0_CONTROLS, "");
}

/**
 * Truncate a UTF-8 buffer to at most `maxBytes`, cutting on a leading-byte boundary
 * so multi-byte characters are never split into U+FFFD (#17).
 * When `tail` is true, keep the end of the buffer (advance past continuation bytes).
 */
export function truncateUtf8Bytes(bytes: Buffer, maxBytes: number, tail = true): string {
  if (maxBytes <= 0) return "";
  if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");
  if (!tail) {
    let end = maxBytes;
    // Walk back while on a UTF-8 continuation byte so we don't cut mid-sequence.
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  }
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
