import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface SpawnHandle { pid: number; exit: Promise<{ code: number }>; }

/** Start a shell command in its own POSIX process group and capture merged output. */
export function spawnDetached(command: string, opts: { outputFile: string; env?: Record<string, string> }): SpawnHandle {
  mkdirSync(dirname(opts.outputFile), { recursive: true });
  const capBytes = Number(opts.env?.PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES ?? process.env.PI_ASYNC_MAX_OUTPUT_BYTES ?? 20 * 1024 * 1024);
  const env = { ...process.env, ...opts.env };
  delete env.PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES;
  const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
  if (!child.pid) throw new Error("Failed to start detached task process");
  const output = createWriteStream(opts.outputFile, { flags: "w", mode: 0o600 });
  let totalBytes = 0;
  let capReached = false;
  const copy = (chunk: Buffer): void => {
    if (capReached) return;
    const remaining = Math.max(0, capBytes - totalBytes);
    const accepted = chunk.subarray(0, remaining);
    if (accepted.length) {
      output.write(accepted);
      totalBytes += accepted.length;
    }
    if (accepted.length < chunk.length) {
      capReached = true;
      writeFileSync(`${opts.outputFile}.capped`, "output cap exceeded", { mode: 0o600 });
      void killTree(child.pid ?? 0, { graceMs: 3000 });
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => copy(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => copy(Buffer.from(chunk)));
  const exit = new Promise<{ code: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      output.end(() => resolve({ code: code ?? 1 }));
    });
  });
  return { pid: child.pid, exit };
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid) && Date.now() < deadline) await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  return !groupExists(pid);
}

/** Terminate the detached process group, escalating from TERM to KILL. */
export async function killTree(pid: number, opts?: { graceMs?: number }): Promise<{ confirmed: boolean }> {
  const graceMs = opts?.graceMs ?? 3000;
  if (!Number.isInteger(pid) || pid <= 1) throw new RangeError("pid must identify a child process");
  if (!groupExists(pid)) return { confirmed: true };
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (await waitForGroupExit(pid, graceMs)) return { confirmed: true };
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  // Bounded probe: do not hang shutdown forever if the kernel cannot prove death.
  return { confirmed: await waitForGroupExit(pid, 1500) };
}
