import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "./registry.ts";
import type { FailureKind, KillKind, TaskStatus } from "./task.ts";

export type PiCtx = ExtensionAPI;
export interface NotifyPayload {
  taskId: string; name: string; status: TaskStatus; exitCode?: number;
  outputFile: string; summary?: string; guidance?: string;
  killKind?: KillKind;
  failureKind?: FailureKind;
  summaryTruncated?: boolean;
}

/**
 * Honest notification outcome (PLAN §2.3): `queued` only means the host accepted the message,
 * not that the model read it. There is no ack, so there is no "delivered" state and no retry loop.
 */
export type NotifyOutcome = "queued" | "skipped" | "failed";

/** XML 1.0 Char excludes C0 (except TAB/LF/CR), lone surrogates, and U+FFFE/FFFF (#19). */
const ILLEGAL_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/g;

const escapeXml = (value: unknown): string =>
  String(value)
    .replace(ILLEGAL_XML, "")
    .replace(/[<&>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[char]!);

export function buildNotificationXml(p: NotifyPayload): string {
  const fields: Array<[string, unknown]> = [["task-id", p.taskId], ["name", p.name], ["status", p.status]];
  if (p.exitCode !== undefined) fields.push(["exit-code", p.exitCode]);
  if (p.killKind) fields.push(["kill-kind", p.killKind]);
  if (p.failureKind) fields.push(["failure-kind", p.failureKind]);
  fields.push(["output-file", p.outputFile]);
  if (p.summary) fields.push(["summary", p.summary]);
  if (p.summaryTruncated) fields.push(["summary-truncated", "true"]);
  if (p.status === "failed" && p.guidance) fields.push(["guidance", p.guidance]);
  return `<async-task-notification>${fields.map(([tag, value]) => `<${tag}>${escapeXml(value)}</${tag}>`).join("")}</async-task-notification>`;
}

/** Structured twin of the XML body, consumed by the TUI message renderer (PLAN §2.3). */
function buildNotificationDetails(p: NotifyPayload): Record<string, unknown> {
  return {
    taskId: p.taskId,
    name: p.name,
    status: p.status,
    ...(p.exitCode === undefined ? {} : { exitCode: p.exitCode }),
    ...(p.killKind === undefined ? {} : { killKind: p.killKind }),
    ...(p.failureKind === undefined ? {} : { failureKind: p.failureKind }),
    ...(p.summary === undefined ? {} : { summary: p.summary }),
    ...(p.summaryTruncated === undefined ? {} : { summaryTruncated: p.summaryTruncated }),
    outputFile: p.outputFile,
    ...(p.guidance === undefined ? {} : { guidance: p.guidance }),
  };
}

/** `sendMessage` is `void` in older pi hosts and `Promise<void>` in newer ones (both shapes ship). */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" ? value !== null : typeof value === "function") &&
  typeof (value as PromiseLike<unknown>).then === "function";

/**
 * Send a completion notification exactly once per undelivered task.
 *
 * Order (PLAN §2.3 / D-01): skip checks → in-memory claim (concurrency dedupe only) →
 * persist the attempt → send `sendMessage` (awaited only when the host returns a promise) →
 * latch `notified` on success or drop the claim on failure (`notified` stays false so
 * `resendUnnotified` can retry later).
 */
export async function sendCompletionNotification(
  pi: PiCtx,
  registry: TaskRegistry,
  p: NotifyPayload,
  options: { triggerTurn?: boolean } = {},
): Promise<NotifyOutcome> {
  const task = registry.get(p.taskId);
  // skipped: nothing to notify about (unknown/consumed task) or the caller opted out.
  if (!task || task.outputConsumed || task.metadata.notifyOnCompletion === false) return "skipped";
  // The claim is memory-only (D-01): losing it to a concurrent sender means skipped, not failed.
  if (!registry.claimNotification(p.taskId)) return "skipped";
  // Persist the attempt before the send so a failed host call stays visible after reload/restart.
  registry.noteNotifyAttempt(p.taskId);
  // SAFETY: The pi extension API provides sendMessage in supported hosts; detect it at runtime for other contexts.
  // The result is typed `unknown` on purpose: pi 1.2/1.3 declare `sendMessage(...): void` while 1.5+ declares
  // `Promise<void>`. A `void` return means "handed to the host"; a promise still has to settle before we
  // can honestly call it queued — and awaiting it keeps a rejection from escaping as unhandledRejection.
  const target = pi as unknown as { sendMessage?: (message: unknown, options: unknown) => unknown };
  if (!target.sendMessage) {
    registry.releaseNotification(p.taskId);
    return "failed";
  }
  try {
    // No retry loop and no rollback — the host offers no ack, so retrying only duplicates messages.
    const result = target.sendMessage(
      { customType: "async-task-notification", content: buildNotificationXml(p), details: buildNotificationDetails(p) },
      { deliverAs: "followUp", ...(options.triggerTurn === false ? {} : { triggerTurn: true }) },
    );
    if (isThenable(result)) await result;
  } catch {
    // Sync throw or rejected promise: same honest outcome, `notified` stays false.
    registry.releaseNotification(p.taskId);
    return "failed";
  }
  registry.markNotified(p.taskId);
  return "queued";
}
