import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isTaskStatus, isTerminal, type TaskSnapshot, type TaskStatus } from "./task.ts";

/**
 * Storage lifecycle (#102 / #81 8.1 + 8.2): cross-dataDir reclamation and a global byte quota.
 *
 * Everything here is I/O-lite and **pure with respect to the registry**: the caller owns the
 * decision to run a pass, the process-liveness probe, and the actual unlink (so the registry can
 * drop its in-memory snapshots through the same `removeArtifacts()` choke point the retention
 * prune already uses). This module only surveys directories and orders the work.
 *
 * Safety posture (CONTRACT §10, REV-32): a sibling data dir is a candidate for removal only when
 * **all three** gates hold, and any doubt skips the directory. Nothing here deletes anything.
 */

/** Artifact families a data dir owns (metadata + merged output + stream sidecars). */
export const STORAGE_ARTIFACT_SUFFIXES = [".json", ".output", ".stdout", ".stderr"] as const;

/** Bound on how many sibling dirs one pass surveys. Names are sorted first, so the cut is deterministic. */
export const MAX_SCAN_DIRS = 256;
/** Bound on how many snapshots one data dir contributes to a plan. Sorted by file name first. */
export const MAX_SNAPSHOTS_PER_DIR = 512;

export function isArtifactFileName(name: string): boolean {
  return STORAGE_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * `migrateDataDir()` copies through `<target>.<pid>.tmp` and can leave residue behind. Residue is
 * **allowed content** (it must not make a dir look foreign) but it is never counted, planned or
 * deleted by this module: it is not a task artifact and its presence says nothing about whether the
 * directory is safe to drop — only the age gate may decide that.
 */
export function isTempFileName(name: string): boolean {
  return name.endsWith(".tmp");
}

/**
 * Owner marker (REV-32): a data dir belongs to a session only while that session's process is
 * alive. Snapshots alone cannot tell "abandoned" from "alive but idle with only terminal tasks",
 * and one sweep root is shared by every session in a directory, so a live-but-idle sibling would
 * otherwise lose its whole data dir. Deliberately **not** an artifact suffix: it is never counted,
 * parsed as a snapshot, or migrated.
 */
export const OWNER_MARKER_NAME = ".pi-async-owner";

export function isOwnerMarkerName(name: string): boolean {
  return name === OWNER_MARKER_NAME;
}

/**
 * Directory identity, not string identity. A `dataDir` can reach the same directory through a
 * symlink, a `..` segment or a case-insensitive filesystem; comparing `resolve()`d strings would
 * then miss gate 1 and let a pass delete the live data dir. `dev`/`ino` is the authoritative answer
 * when both sides exist, `realpath` is the fallback, and `false` (different) is the last resort.
 */
export function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
  } catch { /* at least one side is absent: fall through to realpath */ }
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** `<taskId>.output` → `taskId`. Returns undefined for names that carry no task id. */
export function taskIdOfArtifact(name: string): string | undefined {
  for (const suffix of STORAGE_ARTIFACT_SUFFIXES) {
    if (name.endsWith(suffix)) return name.length > suffix.length ? name.slice(0, -suffix.length) : undefined;
  }
  return undefined;
}

export interface SurveyFile { name: string; path: string; size: number }

export interface SurveySnapshot {
  taskId: string;
  status: TaskStatus;
  pid?: number;
  /** `finishedAt ?? createdAt` — the same age anchor the retention prune uses. */
  ageAnchor: number;
}

export interface DirSurvey {
  path: string;
  name: string;
  /**
   * Newest activity in the directory: `max(dir mtime, newest artifact mtime)`. A live session that
   * rewrites its snapshot through temp+rename bumps the dir mtime, so this is a strictly safer
   * "somebody is still using this" probe than the dir mtime alone.
   */
  lastActivityMs: number;
  files: SurveyFile[];
  snapshots: SurveySnapshot[];
  /** Something a pi-async data dir never writes (subdirectory, symlink, unrelated file). */
  foreign: boolean;
  /** A `.json` in the dir did not parse as a task snapshot: its terminality cannot be proved. */
  unreadable: boolean;
  /** pid recorded by the owner marker; absent when there is no marker (or it carries no pid). */
  ownerPid?: number;
  /** The owner marker exists but cannot be read/parsed: ownership can neither be proved nor denied. */
  ownerUnreadable: boolean;
  bytes: number;
}

/**
 * Read one candidate data dir. Returns `undefined` when the path is not a plain directory
 * (symlinks are never followed, so a `dataDir`-shaped symlink can never point the sweep elsewhere).
 *
 * A read error yields a survey flagged `unreadable` — the caller then skips the directory rather
 * than guessing.
 */
export function surveyDataDir(path: string): DirSurvey | undefined {
  let info;
  try { info = lstatSync(path); } catch { return undefined; }
  if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
  const survey: DirSurvey = {
    path, name: basename(path), lastActivityMs: info.mtimeMs,
    files: [], snapshots: [], foreign: false, unreadable: false, ownerUnreadable: false, bytes: 0,
  };
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch { survey.unreadable = true; return survey; }
  // Sorted so the snapshot cap below (and every plan built from this survey) is deterministic.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Marker presence is evidence in itself: "there is a marker we cannot read" must never collapse
  // into "there is no marker". Anything that is not a plain file (symlink, directory, socket) is
  // unreadable by policy — this module never follows a symlink.
  let markerState: "absent" | "plain" | "unreadable" = "absent";
  for (const entry of entries) {
    if (isOwnerMarkerName(entry.name)) {
      markerState = entry.isFile() ? "plain" : "unreadable";
      continue; // allowed content: never counted, never foreign
    }
    if (entry.isSymbolicLink() || entry.isDirectory()) { survey.foreign = true; continue; }
    if (isTempFileName(entry.name)) continue;
    if (!isArtifactFileName(entry.name)) { survey.foreign = true; continue; }
    let size = 0;
    let mtimeMs = 0;
    try { const stat = lstatSync(join(path, entry.name)); size = stat.size; mtimeMs = stat.mtimeMs; }
    catch { continue; /* raced with a delete: it is simply not there any more */ }
    survey.files.push({ name: entry.name, path: join(path, entry.name), size });
    survey.bytes += size;
    if (mtimeMs > survey.lastActivityMs) survey.lastActivityMs = mtimeMs;
  }
  if (markerState === "unreadable") survey.ownerUnreadable = true;
  else if (markerState === "plain") {
    try {
      const marker = JSON.parse(readFileSync(join(path, OWNER_MARKER_NAME), "utf8")) as { pid?: unknown };
      // Only a real pid can be probed honestly. `0`, a negative number or a fraction would make the
      // liveness answer depend on signal semantics instead of on the recorded process (a group
      // signal or "every process I may signal"), so an unprobeable pid is treated as *unknown* —
      // the directory is then kept rather than judged.
      if (isPid(marker.pid)) survey.ownerPid = marker.pid;
      else survey.ownerUnreadable = true;
    } catch { survey.ownerUnreadable = true; }
  }
  let parsed = 0;
  for (const file of survey.files) {
    if (!file.name.endsWith(".json")) continue;
    if (parsed >= MAX_SNAPSHOTS_PER_DIR) { survey.unreadable = true; break; }
    parsed++;
    let raw: Partial<TaskSnapshot>;
    try { raw = JSON.parse(readFileSync(file.path, "utf8")) as Partial<TaskSnapshot>; }
    catch { survey.unreadable = true; continue; }
    if (typeof raw.taskId !== "string" || raw.taskId.length === 0 || !isTaskStatus(raw.status)) {
      survey.unreadable = true;
      continue;
    }
    // Same rule as the marker: a pid that cannot be probed honestly (`0` = "my own process group",
    // negative = "process group N", fraction = nothing at all) must not be read as evidence of
    // death. Its liveness answer would be platform-dependent, so the snapshot is *unknown*.
    if (raw.pid !== undefined && !isPid(raw.pid)) {
      survey.unreadable = true;
      continue;
    }
    survey.snapshots.push({
      taskId: raw.taskId,
      status: raw.status,
      ...(raw.pid === undefined ? {} : { pid: raw.pid }),
      ageAnchor: raw.finishedAt ?? raw.createdAt ?? 0,
    });
  }
  return survey;
}

/**
 * A pid is a positive integer. Anything else (`0`, a negative number, a fraction, a string) cannot
 * be probed honestly — in a marker *and* in a snapshot — so it must never be read as evidence that
 * the process is alive *or* dead.
 */
export function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export type SweepSkipReason =
  | "current"
  | "not_a_directory"
  | "foreign_content"
  | "unreadable_snapshot"
  | "live_task"
  | "owner_alive"
  | "unreadable_owner"
  | "recently_active"
  | "scan_limit"
  | "not_a_data_dir"
  | "delete_failed";

export interface SiblingVerdict { deletable: boolean; reason?: SweepSkipReason; detail?: string }

/**
 * The three gates of CONTRACT §10 / §25 (REV-32, corrected by REV-33). Gate 1 is the current data
 * dir, gate 2 is "nobody is using this" (no non-terminal snapshot pointing at a live pid **and** no
 * live owner marker), gate 3 is the age gate (`minAgeMs` is clamped by the caller to stay strictly
 * above `PI_ASYNC_RETENTION_MS`).
 *
 * **Two liveness probes, and they are not interchangeable.** `pidAlive` answers "does process
 * *group* `pid` still have a live member": every task child is spawned `detached`, so its pid *is*
 * its group id, and a group whose leader already exited still counts as alive. `processAlive`
 * answers "does *process* `pid` exist", which is the only correct question for the owner marker —
 * the marker records `process.pid` of a pi session, and a session process is usually **not** a
 * group leader. Probing the marker with group semantics reports a live session as dead and lets the
 * sweep delete its data dir (fail-open; REV-33, regression test `owner marker … not a process-group
 * leader`).
 */
export function siblingVerdict(
  survey: DirSurvey,
  opts: {
    currentDataDir: string;
    now: number;
    minAgeMs: number;
    /** Group semantics: correct for task pids (`spawnDetached`), wrong for session pids. */
    pidAlive: (pid: number) => boolean;
    /** Direct process semantics: correct for the owner marker's `process.pid`. */
    processAlive: (pid: number) => boolean;
  },
): SiblingVerdict {
  // Identity, not spelling: an alias (symlink, `..`, case-insensitive FS) is still this data dir.
  if (sameDir(survey.path, opts.currentDataDir)) {
    return { deletable: false, reason: "current", detail: "the live data dir of this registry" };
  }
  // Doubt is never resolved in favour of deleting.
  if (survey.foreign) return { deletable: false, reason: "foreign_content", detail: "holds content a pi-async data dir never writes" };
  if (survey.unreadable) return { deletable: false, reason: "unreadable_snapshot", detail: "a snapshot could not be read as evidence" };
  if (survey.ownerUnreadable) return { deletable: false, reason: "unreadable_owner", detail: "the owner marker could not be read" };
  if (survey.ownerPid !== undefined && opts.processAlive(survey.ownerPid)) {
    return { deletable: false, reason: "owner_alive", detail: `session pid ${survey.ownerPid} is alive` };
  }
  const live = survey.snapshots.find((snapshot) => !isTerminal(snapshot.status) && snapshot.pid !== undefined && opts.pidAlive(snapshot.pid));
  if (live) {
    return { deletable: false, reason: "live_task", detail: `${live.taskId} is ${live.status} (pid ${live.pid} alive)` };
  }
  // A non-terminal snapshot with no pid (a delayed `pending` task, which is the normal leftover of
  // `shutdown()`) carries **no** liveness evidence in either direction: it must not be read as "the
  // run is alive", and it must not block reclamation forever either (that would pin every directory
  // a session ever quit in — REV-33 review). It falls through to the marker and the age gate, which
  // are the gates that can actually answer "will anybody come back for this".
  const idleMs = opts.now - survey.lastActivityMs;
  if (idleMs < opts.minAgeMs) {
    return { deletable: false, reason: "recently_active", detail: `idle ${formatDuration(idleMs)} < ${formatDuration(opts.minAgeMs)}` };
  }
  return { deletable: true };
}

/**
 * Deterministic removal order for sibling dirs: least recently active first, ties broken by name.
 * The order is total (names are unique within a directory), so two runs over the same tree delete
 * the same prefixes in the same sequence.
 */
export function orderSiblings(surveys: DirSurvey[]): DirSurvey[] {
  return [...surveys].sort((a, b) => a.lastActivityMs - b.lastActivityMs || compare(a.name, b.name));
}

export interface EvictionCandidate {
  kind: "task" | "orphan";
  dataDir: string;
  /** Present for `kind === "task"`: the whole artifact set goes as one unit. */
  taskId?: string;
  files: string[];
  bytes: number;
  /** 0 = unreferenced artifact, 1 = policy-expired by the retention union, 2 = still retained. */
  tier: 0 | 1 | 2;
  ageAnchor: number;
}

/** Shared string order. Exported so `prune()` and `expiredTaskIds()` break age ties identically. */
export function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
const compare = compareIds;

/**
 * Total, deterministic tie-break: tier, then age, then id/path, then the data dir. The last key
 * matters: `migrateDataDir()`'s best-effort cleanup can leave the same task id in two dirs, and
 * without it those two candidates compare equal and the surviving order is the input's.
 */
export function orderEvictions(candidates: EvictionCandidate[]): EvictionCandidate[] {
  return [...candidates].sort((a, b) =>
    a.tier - b.tier ||
    a.ageAnchor - b.ageAnchor ||
    compare(a.taskId ?? a.files[0] ?? "", b.taskId ?? b.files[0] ?? "") ||
    compare(a.dataDir, b.dataDir));
}

/**
 * Task ids the retention union would drop anyway: outside the age window **and** outside the newest
 * `retentionCount` window. Mirrors `prune()` exactly, so a soft quota pass never deletes anything
 * the retention policy still promises to keep.
 */
export function expiredTaskIds(
  survey: DirSurvey,
  opts: { now: number; retentionMs: number; retentionCount: number },
): Set<string> {
  const terminal = survey.snapshots
    .filter((snapshot) => isTerminal(snapshot.status))
    .sort((a, b) => b.ageAnchor - a.ageAnchor || compare(a.taskId, b.taskId));
  const expired = new Set<string>();
  for (let i = 0; i < terminal.length; i++) {
    const snapshot = terminal[i]!;
    if (i < opts.retentionCount) continue;
    if (opts.now - snapshot.ageAnchor < opts.retentionMs) continue;
    expired.add(snapshot.taskId);
  }
  return expired;
}

export interface PlanOptions {
  now: number;
  usedBytes: number;
  quotaBytes: number;
  retentionMs: number;
  retentionCount: number;
  /** `true` also evicts tier 2 (artifacts the retention window still keeps). Opt-in only. */
  hard: boolean;
  currentDataDir: string;
  pidAlive: (pid: number) => boolean;
}

export interface EvictionPlan {
  /** Candidates that may be deleted at all, in deletion order. */
  ordered: EvictionCandidate[];
  /** Prefix of `ordered` that is actually needed to get under the quota. */
  selected: EvictionCandidate[];
  bytesAfter: number;
  overQuota: boolean;
  /** Dirs left alone because a non-terminal task in them is alive (they never yield candidates). */
  protectedDirs: string[];
  /**
   * Dirs left alone because a snapshot was unreadable or the snapshot cap was hit. "Unknown" must
   * never be read as "unreferenced": an artifact whose snapshot could not be parsed is exactly the
   * case where deleting it loses data nobody can see any more.
   */
  unreadableDirs: string[];
}

/**
 * Build the eviction plan for one accounting snapshot.
 *
 * Rules (CONTRACT §10 / REV-32):
 * - a task artifact set is a candidate only when its snapshot is **terminal**;
 * - a data dir holding a non-terminal snapshot whose pid is alive contributes nothing;
 * - tier 1 (policy-expired) is always eligible, tier 2 (still retained) only under `hard`;
 * - the pass stops as soon as the accounting is at or below the quota — `used === quota` is *within*
 *   budget, not over it.
 *
 * Non-terminal artifacts and protected directories stay counted in `usedBytes`, so an unsatisfiable
 * quota reports `overQuota: true` instead of silently eating live work.
 */
export function planEvictions(surveys: DirSurvey[], opts: PlanOptions): EvictionPlan {
  const candidates: EvictionCandidate[] = [];
  const protectedDirs: string[] = [];
  const unreadableDirs: string[] = [];
  for (const survey of surveys) {
    // No verdict on an unreadable dir: its artifacts are neither orphans nor terminal candidates.
    if (survey.unreadable) { unreadableDirs.push(survey.path); continue; }
    const live = survey.snapshots.find((snapshot) => !isTerminal(snapshot.status) && snapshot.pid !== undefined && opts.pidAlive(snapshot.pid));
    if (live) { protectedDirs.push(survey.path); continue; }
    // Every snapshot, terminal or not: "an artifact with no snapshot at all" is unreferenced, while
    // "an artifact whose snapshot is still running" is live work that no pass may touch.
    const known = new Map(survey.snapshots.map((snapshot) => [snapshot.taskId, snapshot]));
    const expired = expiredTaskIds(survey, { now: opts.now, retentionMs: opts.retentionMs, retentionCount: opts.retentionCount });
    const grouped = new Map<string, EvictionCandidate>();
    for (const file of survey.files) {
      const taskId = taskIdOfArtifact(file.name);
      const snapshot = taskId === undefined ? undefined : known.get(taskId);
      if (taskId === undefined || snapshot === undefined) {
        // Unreferenced artifact (its snapshot is already gone) — nothing can observe it any more.
        candidates.push({ kind: "orphan", dataDir: survey.path, files: [file.path], bytes: file.size, tier: 0, ageAnchor: 0 });
        continue;
      }
      // In-flight work (running/pending) is never a candidate, not even under a hard quota.
      if (!isTerminal(snapshot.status)) continue;
      const existing = grouped.get(taskId);
      if (existing) { existing.files.push(file.path); existing.bytes += file.size; continue; }
      const tier: 1 | 2 = expired.has(taskId) ? 1 : 2;
      if (tier === 2 && !opts.hard) continue;
      grouped.set(taskId, {
        kind: "task", dataDir: survey.path, taskId, files: [file.path], bytes: file.size,
        tier, ageAnchor: snapshot.ageAnchor,
      });
    }
    candidates.push(...grouped.values());
  }
  const ordered = orderEvictions(candidates);
  const selected: EvictionCandidate[] = [];
  let after = opts.usedBytes;
  for (const candidate of ordered) {
    if (after <= opts.quotaBytes) break;
    selected.push(candidate);
    after -= candidate.bytes;
  }
  return { ordered, selected, bytesAfter: after, overQuota: after > opts.quotaBytes, protectedDirs, unreadableDirs };
}

const UNITS: ReadonlyArray<[string, number]> = [["GiB", 1024 ** 3], ["MiB", 1024 ** 2], ["KiB", 1024]];
/** Byte counts are the unit of every knob; reports/logs render binary units for readability. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  for (const [unit, scale] of UNITS) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(1)} ${unit}`;
  }
  return `${Math.round(bytes)} B`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const days = ms / 86_400_000;
  if (days >= 1) return `${days.toFixed(1)}d`;
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** One storage lifecycle pass, as reported to the caller and logged (REV-32). */
export interface StorageReport {
  at: number;
  /** Sweep root: the parent of the data dir (the `pi-async/` directory in the real layout). */
  root: string;
  dataDir: string;
  /** Configured quota in **bytes**; `0` means the quota is disabled. */
  quotaBytes: number;
  /** Artifact bytes under the root when the pass started (before any deletion). */
  usedBytesBefore: number;
  /** Artifact bytes still on disk when the pass ended. */
  usedBytesAfter: number;
  /** True when the quota is still exceeded after every allowed eviction. */
  overQuota: boolean;
  removedDirs: string[];
  skipped: Array<{ path: string; reason: string; detail?: string }>;
  evicted: Array<{ dataDir: string; taskId?: string; files: number; bytes: number; reason: "orphan" | "expired" | "unexpired" }>;
  /**
   * Data dirs the quota pass left alone because a non-terminal task inside them is alive. They still
   * count towards the accounting, so an unsatisfiable quota stays visible instead of looking solved.
   */
  protectedDirs: string[];
  /** Data dirs left alone because a snapshot (or the snapshot cap) could not be read. */
  unreadableDirs: string[];
  freedBytes: number;
  /** Human-readable pass narration; the same lines were emitted to the log. */
  lines: string[];
}
