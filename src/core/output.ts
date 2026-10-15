const ANSI_ESCAPE = /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\|\x9C)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1B\\|[ -/]*[0-~])|\x9B[0-?]*[ -/]*[@-~]|\x9D[\s\S]*?(?:\x07|\x1B\\|\x9C)/g;

/** Remove ANSI escape, CSI, OSC, and string-control sequences from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export class OutputCapture {
  constructor(_file: string, _capBytes: number) {
    throw new Error("pi-async: not implemented (src/core/output.ts)");
  }

  write(_chunk: string | Buffer): { capped: boolean; totalBytes: number } {
    throw new Error("pi-async: not implemented (src/core/output.ts)");
  }

  readTail(_maxBytes: number): { text: string; truncated: boolean; totalBytes: number } {
    throw new Error("pi-async: not implemented (src/core/output.ts)");
  }

  readLatestLines(_maxLines: number): string[] {
    throw new Error("pi-async: not implemented (src/core/output.ts)");
  }
}
