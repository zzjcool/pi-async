import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "./registry.ts";
import type { TaskStatus } from "./task.ts";

export type PiCtx = ExtensionAPI;

export interface NotifyPayload {
  taskId: string;
  name: string;
  status: TaskStatus;
  exitCode?: number;
  outputFile: string;
  summary?: string;
  guidance?: string;
}

export function buildNotificationXml(_p: NotifyPayload): string { throw new Error("pi-async: not implemented (src/core/notify.ts)"); }
export async function sendCompletionNotification(_pi: PiCtx, _registry: TaskRegistry, _p: NotifyPayload): Promise<boolean> { throw new Error("pi-async: not implemented (src/core/notify.ts)"); }
