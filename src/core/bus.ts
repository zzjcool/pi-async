import type { PiCtx } from "./notify.ts";

export function reportActivity(_pi: PiCtx, _active: { running: number; pending: number }): void { throw new Error("pi-async: not implemented (src/core/bus.ts)"); }
