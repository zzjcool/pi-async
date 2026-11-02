import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { buildChildEnv, INTERNAL_MAX_OUTPUT_ENV, type EnvPolicy } from "./env.ts";
import type { TaskSnapshot } from "./task.ts";

export type { EnvPolicy };

export interface SpawnHandle { pid: number; exit: Promise<{ code: number }>; }

export interface SpawnOptions {
  outputFile: string;
  env?: Record<string, string>;
  cwd?: string;
  envPolicy?: EnvPolicy;
}

/** Derive per-stream sidecar paths next to the merged `.output` file. */
export function streamPaths(outputFile: string): { stdout: string; stderr: string } {
  if (outputFile.endsWith(".output")) {
    const base = outputFile.slice(0, -".output".length);
    return { stdout: `${base}.stdout`, stderr: `${base}.stderr` };
  }
  return { stdout: `${outputFile}.stdout`, stderr: `${outputFile}.stderr` };
}

/** Resolve the inheritance policy; an unknown `PI_ASYNC_ENV_INHERIT` falls back to `safe` (D-10). */
export function resolveEnvPolicy(explicit?: EnvPolicy): EnvPolicy {
  if (explicit) return explicit;
  const inherited = process.env.PI_ASYNC_ENV_INHERIT;
  if (inherited === "all") return "all";
  if (inherited === "none") return "none";
  return "safe";
}

/** Fail loudly before forking when the requested cwd cannot be used. */
function assertUsableCwd(cwd: string | undefined): void {
  if (cwd === undefined) return;
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!stats.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
}

/** Start a shell command in its own POSIX process group; capture merged + separate streams. */
export function spawnDetached(command: string, opts: SpawnOptions): SpawnHandle {
  assertUsableCwd(opts.cwd);
  mkdirSync(dirname(opts.outputFile), { recursive: true });
  const { stdout: stdoutFile, stderr: stderrFile } = streamPaths(opts.outputFile);
  const capBytes = finiteNumber(opts.env?.[INTERNAL_MAX_OUTPUT_ENV] ?? process.env.PI_ASYNC_MAX_OUTPUT_BYTES, 20 * 1024 * 1024);
  const env = buildChildEnv(process.env, opts.env, resolveEnvPolicy(opts.envPolicy));
  // Always pass cwd explicitly: the host process cwd is not the session cwd (REV-13).
  const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: opts.cwd });
  // Attach a no-op error listener before any throw so a failed spawn can never surface as an
  // unhandled 'error' event (which would crash the host); the exit promise re-observes it.
  child.on("error", () => undefined);
  if (!child.pid) throw new Error(`Failed to start detached task process${opts.cwd ? ` in ${opts.cwd}` : ""}`);
  const merged = createWriteStream(opts.outputFile, { flags: "w", mode: 0o600 });
  const stdoutOut = createWriteStream(stdoutFile, { flags: "w", mode: 0o600 });
  const stderrOut = createWriteStream(stderrFile, { flags: "w", mode: 0o600 });
  // Cleanup may unlink the data dir while pipes still flush; ignore late write errors.
  for (const stream of [merged, stdoutOut, stderrOut]) stream.on("error", () => undefined);
  let totalBytes = 0;
  let capReached = false;
  const copy = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
    if (capReached) return;
    const remaining = Math.max(0, capBytes - totalBytes);
    const accepted = chunk.subarray(0, remaining);
    if (accepted.length) {
      merged.write(accepted);
      (stream === "stdout" ? stdoutOut : stderrOut).write(accepted);
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
  child.stdout?.on("data", (chunk: Buffer) => copy(Buffer.from(chunk), "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => copy(Buffer.from(chunk), "stderr"));
  const exit = new Promise<{ code: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      let pending = 3;
      const done = (): void => {
        pending--;
        if (pending === 0) resolve({ code: code ?? 1 });
      };
      merged.end(done);
      stdoutOut.end(done);
      stderrOut.end(done);
    });
  });
  return { pid: child.pid, exit };
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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

/** True only if the process group has a non-zombie member (#6). */
function groupHasLiveMember(pgid: number): boolean {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(") ");
        if (closeParen < 0) continue;
        const rest = stat.slice(closeParen + 2).split(" ");
        const state = rest[0];
        const pgrp = Number(rest[2]);
        if (pgrp === pgid && state !== "Z") return true;
      } catch { /* raced */ }
    }
    return false;
  } catch {
    return groupExists(pgid);
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupHasLiveMember(pid) && Date.now() < deadline) await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  return !groupHasLiveMember(pid);
}

export async function killTree(pid: number, opts?: { graceMs?: number }): Promise<{ confirmed: boolean }> {
  const graceMs = opts?.graceMs ?? 3000;
  if (!Number.isInteger(pid) || pid <= 1) throw new RangeError("pid must identify a child process");
  if (!groupHasLiveMember(pid)) return { confirmed: true };
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (await waitForGroupExit(pid, graceMs)) return { confirmed: true };
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return { confirmed: await waitForGroupExit(pid, 1500) };
}
