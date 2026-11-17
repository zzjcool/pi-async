/**
 * Who owns the terminal event while the settle hold is waiting (0.4.3, CONTRACT §7.1 修订 3).
 *
 * One finished task had two announcers in 0.4.2:
 *
 * - the hold's `async-task-settle-results` entry, committed by pi *inside* the run
 *   (`agent-session.js:560-574`), and
 * - the completion notification sent by `onFinalize` as `{deliverAs:"followUp"}`. pi only
 *   **enqueues** that while the run is streaming (`agent-session.js:1959-1962`) and turns it into
 *   a user message at the next "the agent would stop here" point (`agent-loop.js:196-203`).
 *
 * The ordering is therefore fixed, not racy: entry first, notification 38–50 s later in the
 * reported session (JSONL ln393→ln404, ln432→ln441), on a turn whose only content is a receipt the
 * model has already acted on. Since `onFinalize` runs before the hold's next poll (both are
 * single-tick/synchronous paths), the hold can always intercept that send.
 *
 * This object is the interception point: `claim` defers a send for a task the hold is waiting for,
 * `commit` drops the deferred sends the results entry now covers, and `release` delivers them for
 * every other exit (timeout, disposal, a throwing registry) so a notification is never swallowed.
 * It never sends anything itself and never blocks.
 */
export type DeferredNotification = () => unknown;

export class HoldNotificationRelay {
  /** Ids the active hold is waiting for; `undefined` means no hold owns anything right now. */
  private waiting: Set<string> | undefined;
  private readonly deferred = new Map<string, DeferredNotification>();

  /** Arm the relay with the hold's snapshot. Called before the first poll, never awaited. */
  open(ids: string[]): void {
    this.waiting = new Set(ids);
  }

  /**
   * Take ownership of `taskId`'s completion while the hold is waiting for it.
   * Returns `false` for every task outside the snapshot — those keep the normal notification.
   */
  claim(taskId: string, send: DeferredNotification): boolean {
    if (!this.waiting?.has(taskId)) return false;
    this.deferred.set(taskId, send);
    return true;
  }

  /**
   * The hold settled every task in `ids`: the results entry is the one announcement, so drop the
   * deferred sends. Returns the ids whose notification it folded in (the caller latches those, or
   * `resendUnnotified` would announce them again on the next `session_start`).
   */
  commit(ids: string[]): string[] {
    const owned: string[] = [];
    for (const taskId of ids) {
      if (this.deferred.delete(taskId)) owned.push(taskId);
    }
    this.waiting = undefined;
    return owned;
  }

  /** Any other exit (timeout/dispose/throw): hand the deferred notifications back to their sender. */
  release(): void {
    const pending = [...this.deferred.values()];
    this.deferred.clear();
    this.waiting = undefined;
    for (const send of pending) {
      try {
        const result = send();
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined);
        }
      } catch {
        // The payload is built by the caller; a host rejecting it must not fail a settle boundary.
      }
    }
  }
}
