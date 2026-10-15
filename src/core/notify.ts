import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "./registry.ts";
import type { TaskStatus } from "./task.ts";

export type PiCtx = ExtensionAPI;
export interface NotifyPayload { taskId: string; name: string; status: TaskStatus; exitCode?: number; outputFile: string; summary?: string; guidance?: string; }
const escapeXml = (value: unknown): string => String(value).replace(/[<&>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[char]!);

export function buildNotificationXml(p: NotifyPayload): string {
  const fields: Array<[string, unknown]> = [["task-id", p.taskId], ["name", p.name], ["status", p.status]];
  if (p.exitCode !== undefined) fields.push(["exit-code", p.exitCode]);
  fields.push(["output-file", p.outputFile]);
  if (p.summary) fields.push(["summary", p.summary]);
  if (p.status === "failed" && p.guidance) fields.push(["guidance", p.guidance]);
  return `<async-task-notification>${fields.map(([tag, value]) => `<${tag}>${escapeXml(value)}</${tag}>`).join("")}</async-task-notification>`;
}

export async function sendCompletionNotification(
  pi: PiCtx,
  registry: TaskRegistry,
  p: NotifyPayload,
  options: { triggerTurn?: boolean } = {},
): Promise<boolean> {
  if (registry.get(p.taskId)?.outputConsumed || !registry.claimNotification(p.taskId)) return false;
  // SAFETY: The pi extension API provides sendMessage in supported hosts; detect it at runtime for other contexts.
  const target = pi as unknown as { sendMessage?: (message: unknown, options: unknown) => unknown };
  if (!target.sendMessage) { registry.rollbackNotification(p.taskId); return false; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await target.sendMessage(
        { customType: "async-task-notification", content: buildNotificationXml(p) },
        { deliverAs: "followUp", ...(options.triggerTurn === false ? {} : { triggerTurn: true }) },
      );
      return true;
    } catch {
      if (attempt < 2) await Promise.resolve();
    }
  }
  registry.rollbackNotification(p.taskId);
  return false;
}
