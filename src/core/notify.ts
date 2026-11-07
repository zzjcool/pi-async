import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "./registry.ts";
import type { FailureKind, KillKind, TaskSnapshot, TaskStatus } from "./task.ts";

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
  // D-C8: `completed` stays pure information, but a timeout-killed task is the one `killed`
  // shape where the next step matters, so it carries guidance too (status itself is unchanged).
  if ((p.status === "failed" || p.killKind === "timeout") && p.guidance) fields.push(["guidance", p.guidance]);
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
 * Runtime reminder payload (REV-23 / CONTRACT §18.3). Deliberately separate from `NotifyPayload`:
 * a reminder is not a completion, carries no exit code / kill kind, and adds the two facts the
 * model needs to act on it — how long the task has run and which reminder this is.
 */
export interface ReminderPayload {
  taskId: string; name: string; status: TaskStatus; elapsedMs: number; remindCount: number;
  outputFile: string; summary?: string; guidance?: string; summaryTruncated?: boolean;
}

/**
 * Fixed guidance for every reminder (CONTRACT §18.3): still running, no hard deadline, not killed
 * automatically, renew with `async_extend` or stop with `async_kill`. It states the two actions so a
 * waking turn never has to guess — the reminder itself changes nothing about the process (§18.5).
 */
export const REMINDER_GUIDANCE =
  "Still running with no hard deadline, so it will not be killed automatically. Renew it with async_extend (remindAfterMs or taskTimeoutMs), or stop it with async_kill.";

/**
 * Guidance for a task that *does* carry a hard deadline (CONTRACT §18.12).
 *
 * The plain sentence above would be a lie here — the process is killed at `taskTimeoutMs` — and a
 * reminder that misstates the deadline is worse than no reminder: it invites the agent to ignore a
 * real kill. Honesty wins over a stable string.
 */
export function reminderGuidance(timeoutAt?: number, now = Date.now()): string {
  if (timeoutAt === undefined) return REMINDER_GUIDANCE;
  const remainingSec = Math.max(0, Math.round((timeoutAt - now) / 1000));
  return `Still running. A hard deadline (taskTimeoutMs) kills it in ${remainingSec}s. Remind me sooner with async_extend (remindAfterMs), move the deadline (taskTimeoutMs), or stop it with async_kill.`;
}

export function buildReminderXml(p: ReminderPayload): string {
  const fields: Array<[string, unknown]> = [
    ["task-id", p.taskId], ["name", p.name], ["status", p.status],
    ["elapsed-ms", p.elapsedMs], ["remind-count", p.remindCount],
    ["output-file", p.outputFile],
  ];
  if (p.summary) fields.push(["summary", p.summary]);
  if (p.summaryTruncated) fields.push(["summary-truncated", "true"]);
  if (p.guidance) fields.push(["guidance", p.guidance]);
  return `<async-task-reminder>${fields.map(([tag, value]) => `<${tag}>${escapeXml(value)}</${tag}>`).join("")}</async-task-reminder>`;
}

/** Structured twin of the reminder XML, consumed by the TUI message renderer. */
function buildReminderDetails(p: ReminderPayload): Record<string, unknown> {
  return {
    taskId: p.taskId,
    name: p.name,
    status: p.status,
    elapsedMs: p.elapsedMs,
    remindCount: p.remindCount,
    outputFile: p.outputFile,
    ...(p.summary === undefined ? {} : { summary: p.summary }),
    ...(p.summaryTruncated === undefined ? {} : { summaryTruncated: p.summaryTruncated }),
    ...(p.guidance === undefined ? {} : { guidance: p.guidance }),
  };
}

/**
 * Send one runtime reminder (CONTRACT §18.3): same channel as a completion (`followUp`, and a turn
 * by default), tail-only output, no claim and no `notified` latch — a reminder is repeatable and
 * must never consume the single completion slot the registry guards.
 *
 * Output reads are best-effort: a reminder that cannot read its own log still wakes the agent with
 * the task identity and the elapsed time, which is the point of the message.
 */
export async function sendReminder(
  pi: PiCtx,
  registry: TaskRegistry,
  snapshot: TaskSnapshot,
  options: { triggerTurn?: boolean } = {},
): Promise<NotifyOutcome> {
  if (snapshot.metadata.notifyOnCompletion === false) return "skipped";
  let outputTail = "";
  let truncated = false;
  try {
    const slice = registry.logs(snapshot.taskId, { maxBytes: 8192, tail: true });
    outputTail = slice.text;
    truncated = slice.truncated;
  } catch (error) {
    // D-11 (output outside the data dir) must not turn a reminder into an exception.
    console.error(`pi-async: could not read output for reminder ${snapshot.taskId}`, error);
  }
  const payload: ReminderPayload = {
    taskId: snapshot.taskId,
    name: snapshot.name,
    status: snapshot.status,
    elapsedMs: Math.max(0, Date.now() - (snapshot.startedAt ?? snapshot.createdAt)),
    remindCount: snapshot.remindCount ?? 1,
    outputFile: String(snapshot.metadata.outputFile ?? ""),
    ...(outputTail ? { summary: outputTail } : {}),
    ...(truncated || snapshot.metadata.capped === true ? { summaryTruncated: true } : {}),
    guidance: reminderGuidance(snapshot.timeoutAt),
  };
  // SAFETY: same runtime feature-detection as the completion path (sendMessage is optional/void in older hosts).
  const target = pi as unknown as { sendMessage?: (message: unknown, options: unknown) => unknown };
  if (!target.sendMessage) return "failed";
  try {
    const result = target.sendMessage(
      { customType: "async-task-reminder", content: buildReminderXml(payload), details: buildReminderDetails(payload) },
      { deliverAs: "followUp", ...(options.triggerTurn === false ? {} : { triggerTurn: true }) },
    );
    if (isThenable(result)) await result;
  } catch {
    return "failed";
  }
  return "queued";
}

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
