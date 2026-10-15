export interface SpawnHandle { pid: number; exit: Promise<{ code: number }>; }

export function spawnDetached(_command: string, _opts: { outputFile: string; env?: Record<string, string> }): SpawnHandle {
  throw new Error("pi-async: not implemented (src/core/spawn.ts)");
}

export async function killTree(_pid: number, _opts?: { graceMs?: number }): Promise<{ confirmed: boolean }> {
  throw new Error("pi-async: not implemented (src/core/spawn.ts)");
}
