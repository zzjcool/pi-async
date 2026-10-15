import { closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";

const ANSI_ESCAPE = /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\|\x9C)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1B\\|[ -/]*[0-~])|\x9B[0-?]*[ -/]*[@-~]|\x9D[\s\S]*?(?:\x07|\x1B\\|\x9C)/g;

/** Remove ANSI escape, CSI, OSC, and string-control sequences from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** A synchronous, byte-bounded append-only output file. */
export class OutputCapture {
  private readonly fd: number;
  private totalBytes = 0;
  private readonly file: string;
  private readonly capBytes: number;

  constructor(file: string, capBytes: number) {
    if (!Number.isSafeInteger(capBytes) || capBytes < 0) throw new RangeError("capBytes must be a non-negative safe integer");
    this.file = file;
    this.capBytes = capBytes;
    this.fd = openSync(file, "w", 0o600);
  }

  write(chunk: string | Buffer): { capped: boolean; totalBytes: number } {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, this.capBytes - this.totalBytes);
    let bytes = input.subarray(0, Math.min(remaining, input.byteLength));
    if (typeof chunk === "string" && bytes.byteLength < input.byteLength) {
      let text = bytes.toString("utf8");
      while (text.length > 0 && Buffer.byteLength(text) > bytes.byteLength) text = text.slice(0, -1);
      bytes = Buffer.from(text);
    }
    if (bytes.byteLength > 0) writeSync(this.fd, bytes);
    this.totalBytes += bytes.byteLength;
    return { capped: bytes.byteLength < input.byteLength, totalBytes: this.totalBytes };
  }

  readTail(maxBytes: number): { text: string; truncated: boolean; totalBytes: number } {
    const totalBytes = fstatSync(this.fd).size;
    const start = Math.max(0, totalBytes - Math.max(0, Math.floor(maxBytes)));
    const content = readFileSync(this.file);
    return { text: content.subarray(start).toString("utf8"), truncated: start > 0, totalBytes };
  }

  readLatestLines(maxLines: number): string[] {
    if (maxLines <= 0) return [];
    return readFileSync(this.file, "utf8").split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1).slice(-Math.floor(maxLines));
  }

  close(): void { closeSync(this.fd); }
}
