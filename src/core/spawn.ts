import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskSnapshot } from "./task.ts";

export interface SpawnHandle { pid: number; exit: Promise<{ code: number }>; }

/** Start a shell command in its own POSIX process group and capture merged output. */
export function spawnDetached(command: string, opts: { outputFile: string; env?: Record<string, string> }): SpawnHandle {
  mkdirSync(dirname(opts.outputFile), { recursive: true });
  const capBytes = finiteNumber(opts.env?.PI_ASYNC_INTERNAL_MAX_OUTPUT_BYTES ?? process.env.PI_ASYNC_MAX_OUTPUT_BYTES, 20 * 1024 * 1024);
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
      persistOutputCap(opts.outputFile);
      void killTree(child.pid ?? 0, { graceMs: 3000 }).then(({ confirmed }) => {
        if (!confirmed) console.error(`pi-async: output cap could not confirm process group ${child.pid} exited`);
      }).catch((error: unknown) => {
        console.error(`pi-async: failed to kill process group ${child.pid} after output cap`, error);
      });
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

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Merge the cap marker into the task snapshot with the same atomic-rename strategy as the registry. */
function persistOutputCap(outputFile: string): void {
  const metadataFile = outputFile.endsWith(".output") ? `${outputFile.slice(0, -7)}.json` : `${outputFile}.json`;
  try {
    if (!existsSync(metadataFile)) throw new Error(`Task metadata is not available at ${metadataFile}`);
    const snapshot = JSON.parse(readFileSync(metadataFile, "utf8")) as TaskSnapshot;
    snapshot.metadata = { ...snapshot.metadata, capped: true };
    const temp = `${metadataFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temp, metadataFile);
  } catch (error) {
    console.error(`pi-async: failed to persist output cap metadata for ${outputFile}`, error);
  }
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
