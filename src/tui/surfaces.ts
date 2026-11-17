/**
 * Which TUI surface carries per-task detail (0.4.6, §7.1 修订 6).
 *
 * The rail is the single detail surface: `▶ name · state · elapsed` per task, plus the summary row.
 * The hold row briefly repeated that detail (0.4.5) and one terminal then said the same thing twice;
 * so the hold asks *here* whether a rail is really on screen before deciding what its row may say.
 *
 * This is a recorded fact, never a guess about the host: `registerRail` sets it only after the
 * `setWidget("pi-async-rail", …)` call actually went through. A host without `setWidget` leaves it
 * unset, and the hold row keeps naming the tasks — with no rail there is nowhere else to look.
 */
let railRegistered = false;

/** Record that the rail widget was really registered with the host (idempotent). */
export function markRailRegistered(): void {
  railRegistered = true;
}

/** True once a rail widget has been registered in this process. Read per frame, so late binding is fine. */
export function isRailRegistered(): boolean {
  return railRegistered;
}

/** Test-only: forget the registration so isolated unit tests can exercise both branches. */
export function resetSurfaceRegistrationForTests(): void {
  railRegistered = false;
}
