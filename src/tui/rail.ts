import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";
import { visibleText } from "../core/output.ts";
import { formatDuration } from "../core/duration.ts";
import { summarySegments, survivesClearCutoff, type SummaryCounts } from "./status.ts";
import { envNumber } from "../core/env.ts";
import { displayWidth, truncateToWidth } from "./width.ts";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { openPanel } from "./panel.ts";
import { tuiHost } from "./host.ts";

type Theme = { fg(color: string, text: string): string; getFgAnsi?(color: string): string };
export interface RailWidget {
  render(width?: number): string[];
  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined;
  handleInput?(data: string): { handled?: boolean } | void;
  dispose?(): void;
}

/** Palette color selection adapted from legion-viz/palette.ts (MIT License). */
const TYPE_TOKENS = ["syntaxVariable", "syntaxKeyword", "syntaxNumber", "syntaxFunction", "syntaxString", "syntaxType"];
type Swatch = { kind: "rgb"; l: number; a: number; b: number } | { kind: "key"; key: string };
function ansiFor(theme: Theme, token: string): string {
  // SAFETY: The peer theme exposes fg(); getFgAnsi is feature-detected for newer TUI versions.
  const color = theme as Theme;
  try { return color.getFgAnsi?.(token) ?? color.fg(token, "\0").split("\0")[0] ?? token; } catch { return token; }
}
function oklab(r: number, g: number, b: number): Swatch {
  const linear = (n: number): number => { const v = n / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = linear(r), G = linear(g), B = linear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034708 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.281718565 * G + 0.6299787005 * B);
  return { kind: "rgb", l: 0.2104542553*l + 0.793617785*m - 0.0040720468*s, a: 1.9779984951*l - 2.428592205*m + 0.4505937099*s, b: 0.0259040371*l + 0.7827717662*m - 0.808675766*s };
}
function swatch(theme: Theme, token: string): Swatch {
  const ansi = ansiFor(theme, token);
  const rgb = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
  if (rgb) return oklab(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const index = /38;5;(\d+)/.exec(ansi);
  if (index) {
    const n = Number(index[1]);
    if (n >= 232) { const v = 8 + 10 * (n - 232); return oklab(v, v, v); }
    if (n >= 16) { const i = n - 16, step = [0, 95, 135, 175, 215, 255]; return oklab(step[Math.floor(i / 36)]!, step[Math.floor(i / 6) % 6]!, step[i % 6]!); }
    return { kind: "key", key: `p${n}` };
  }
  const basic = /(?:^|\[|;)(3[0-7]|9[0-7])m/.exec(ansi);
  return { kind: "key", key: basic?.[1] ?? ansi };
}
function clashes(a: Swatch, b: Swatch): boolean {
  if (a.kind === "key" && b.kind === "key") return a.key === b.key;
  if (a.kind === "key" || b.kind === "key") return false;
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b) < 0.025;
}
function typeColor(theme: Theme, mode: string, used: Swatch[]): string {
  const modeIndex = ["background", "sync", "delayed"].indexOf(mode);
  const preferred = TYPE_TOKENS[modeIndex < 0 ? 0 : modeIndex]!;
  for (const token of [preferred, ...TYPE_TOKENS]) {
    const color = swatch(theme, token);
    if (!used.some((previous) => clashes(color, previous))) { used.push(color); return token; }
  }
  return preferred;
}

const statePriority: Record<TaskSnapshot["status"], number> = { running: 0, pending: 1, completed: 2, failed: 3, killed: 4 };
/** Alias for tests / callers still importing elapsed; single source is core/duration. */
export { formatDuration as elapsed };
/** Fit a row to at most `width` code points; never exceed the budget (empty when width<=0). */
/** Truncate a rail row by terminal cell width (CJK/emoji-aware via #7). */
export function fitRailRow(row: string, width: number): string {
  return truncateToWidth(row, Math.max(0, Math.floor(width)));
}

export const RAIL_MAX_LINES = 4;
export const RAIL_TASK_SLOTS = 3;
export const RAIL_TASK_SLOTS_OVERFLOW = 2;

/** Pure, unstyled rail rows; active tasks first and a hard three-row limit. */
export function renderRailRows(snapshots: TaskSnapshot[], width: number, now = Date.now()): string[] {
  const rows = snapshots
    .slice().sort((a, b) => statePriority[a.status] - statePriority[b.status] || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))
    .slice(0, RAIL_TASK_SLOTS)
    .map((task) => `▶ ${visibleText(task.name)} · ${task.status} · ${formatDuration(task, now)}`);
  const limit = Math.max(0, Math.floor(width));
  return rows.map((row) => truncateToWidth(row, limit));
}

/** Terminal-task linger window on the rail, overridable for tests. */
function lingerMsFromEnv(): number {
  return envNumber("PI_ASYNC_RAIL_LINGER_MS", 30_000, { integer: true, min: 0 });
}

const RAIL_PAGE = 2;
let railTicker: ReturnType<typeof setInterval> | undefined;

function summaryCounts(registry: TaskRegistry): SummaryCounts {
  const all = registry.list({ includeHistory: true });
  const running = all.filter((task) => task.status === "running");
  const pending = all.filter((task) => task.status === "pending").length;
  const visibleTerminal = all.filter((task) => TERMINAL.has(task.status) && survivesClearCutoff(task));
  return {
    running: running.length,
    pending,
    completed: visibleTerminal.filter((task) => task.status === "completed").length,
    failed: visibleTerminal.filter((task) => task.status === "failed" || task.status === "killed").length,
    ...(running.length ? { longestRunningStartedAt: Math.min(...running.map((task) => task.startedAt ?? task.createdAt)) } : {}),
  };
}

const TERMINAL = new Set(["completed", "failed", "killed"]);

function coloredSummary(counts: SummaryCounts, now: number, width: number, theme: Theme): string {
  const plainSegments = summarySegments(counts, now);
  let kept = plainSegments.map((segment) => ({ ...segment }));
  const plain = () => kept.map((segment) => segment.text).join("");
  const removableSegments = [
    (segment: SummarySegmentLike) => segment.token === "error",
    (segment: SummarySegmentLike) => segment.token === "success",
    (segment: SummarySegmentLike) => segment.text.startsWith(" · ") && segment.token === "dim" && !segment.text.includes("pending"),
    (segment: SummarySegmentLike) => segment.text.includes(" pending"),
  ];
  while (displayWidth(plain()) > Math.max(0, Math.floor(width))) {
    const predicate = removableSegments.find((remove) => kept.some(remove));
    if (!predicate) break;
    kept = kept.filter((segment) => !predicate(segment));
  }
  const truncated = truncateToWidth(plain(), Math.max(0, Math.floor(width)));
  let offset = 0;
  return kept.map((segment) => {
    const text = truncated.slice(offset, offset + segment.text.length);
    offset += segment.text.length;
    if (!text) return "";
    try { return theme.fg(segment.token, text) ?? text; } catch { return text; }
  }).join("");
}

type SummarySegmentLike = { text: string; token: string };

export function createRailFactory(pi: PiCtx, registry: TaskRegistry, opts: { onOpenTask?: (taskId: string) => void } = {}): (tui: TUI, theme: Theme) => RailWidget {
  // Factory signature includes the extension context for future host-specific rail integrations.
  void pi;
  return (tui, theme) => {
    if (railTicker) clearInterval(railTicker);
    const ticker = setInterval(() => tui.requestRender(), 1_000);
    railTicker = ticker;
    ticker.unref?.();
    let scroll = 0;
    let hitRows: string[] = [];
    let latchedId: string | undefined;
    // Terminal tasks linger briefly so the user sees the outcome, then drop off
    // the rail (CONTRACT §8: idle sessions render nothing). Live tasks always show.
    const lingerMs = lingerMsFromEnv();
    const ordered = (now = Date.now()): TaskSnapshot[] => registry.list({ includeHistory: true })
      .filter((task) => task.status === "running" || task.status === "pending"
        || (now - (task.finishedAt ?? task.startedAt ?? task.createdAt)) < lingerMs)
      .sort((a, b) => statePriority[a.status] - statePriority[b.status] || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
    const clampScroll = (count: number, taskSlots: number): void => {
      scroll = Math.max(0, Math.min(scroll, Math.max(0, count - taskSlots)));
    };
    const applyScroll = (delta: number): boolean => {
      const count = ordered().length;
      if (count <= RAIL_TASK_SLOTS) return false;
      const taskSlots = RAIL_TASK_SLOTS_OVERFLOW;
      const next = Math.max(0, Math.min(count - taskSlots, scroll + delta));
      if (next === scroll) return false;
      scroll = next;
      latchedId = undefined;
      tui.requestRender();
      return true;
    };
    const render = (width = 120): string[] => {
      const now = Date.now();
      const tasks = ordered(now);
      if (tasks.length === 0) { hitRows = []; return []; }
      const overflow = tasks.length > RAIL_TASK_SLOTS;
      const taskSlots = overflow ? RAIL_TASK_SLOTS_OVERFLOW : RAIL_TASK_SLOTS;
      clampScroll(tasks.length, taskSlots);
      const visible = tasks.slice(scroll, scroll + taskSlots);
      const counts = summaryCounts(registry);
      hitRows = ["", ...visible.map((task) => task.taskId)];
      const used = [swatch(theme, "error"), swatch(theme, "dim")];
      const rows = [coloredSummary(counts, now, width, theme), ...renderRailRows(visible, width).map((row, index) => {
        const task = visible[index];
        if (!task) return row;
        let token = "dim";
        if (task.status === "running") token = typeColor(theme, task.mode, used);
        else if (task.status === "completed") token = "success";
        else if (task.status === "failed") token = "error";
        try {
          return theme.fg(token, row) ?? row;
        } catch {
          return row;
        }
      })];
      if (overflow) {
        const hidden = tasks.length - visible.length;
        const above = scroll;
        const below = Math.max(0, tasks.length - scroll - visible.length);
        const label = above > 0 && below > 0
          ? `… +${hidden} more (↑${above} ↓${below})`
          : above > 0
            ? `… +${above} more ↑`
            : `… +${below} more`;
        const indicator = fitRailRow(label, width);
        try {
          rows.push(theme.fg("dim", indicator) ?? indicator);
        } catch {
          rows.push(indicator);
        }
        hitRows.push(""); // overflow row is not a task hit target
      }
      // Bind the ≤4 invariant to RAIL_MAX_LINES so retuning the slot constants cannot silently break it.
      if (rows.length > RAIL_MAX_LINES) {
        rows.length = RAIL_MAX_LINES;
        hitRows.length = RAIL_MAX_LINES;
      }
      return rows;
    };
    return {
      render,
      handleInput(data: string): { handled?: boolean } | void {
        // PageUp / PageDown, and Ctrl+↑ / Ctrl+↓ when the rail has focus.
        if (data === "\u001b[5~" || data === "\u001b[1;5A") {
          return applyScroll(-RAIL_PAGE) ? { handled: true } : undefined;
        }
        if (data === "\u001b[6~" || data === "\u001b[1;5B") {
          return applyScroll(RAIL_PAGE) ? { handled: true } : undefined;
        }
        return undefined;
      },
      handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
        const mouse = event as TuiMouseEvent & { type: string; y: number; button?: string; wheelDelta?: number };
        if (mouse.type === "wheel") {
          const count = ordered().length;
          if (count <= RAIL_TASK_SLOTS) return undefined;
          const taskSlots = RAIL_TASK_SLOTS_OVERFLOW;
          const next = Math.max(0, Math.min(count - taskSlots, scroll + Math.trunc(mouse.wheelDelta ?? 0)));
          if (next === scroll) return undefined;
          scroll = next; latchedId = undefined; tui.requestRender(); return { handled: true };
        }
        if (mouse.type === "press") {
          latchedId = undefined;
          if (mouse.button !== "left") return undefined;
          const id = hitRows[mouse.y];
          if (!id) return undefined;
          latchedId = id; return { handled: true };
        }
        if (mouse.type !== "click" || mouse.button !== "left") return undefined;
        const id = hitRows[mouse.y];
        if (!latchedId || id !== latchedId) { latchedId = undefined; return undefined; }
        const clicked = latchedId; latchedId = undefined; opts.onOpenTask?.(clicked); return { handled: true };
      },
      dispose(): void {
        latchedId = undefined;
        if (railTicker === ticker) {
          clearInterval(ticker);
          railTicker = undefined;
        }
      },
    };
  };
}

/** The sole rail widget registration point. */
export function registerRail(pi: PiCtx, registry: TaskRegistry): void {
  // TUI surfaces bind from event contexts; the factory API has no mode/ui.
  const bound = tuiHost();
  if (!bound) return;
  const setWidget = bound.ui["setWidget"] as ((key: string, factory: ReturnType<typeof createRailFactory> | undefined, options?: { placement: "aboveEditor" }) => void) | undefined;
  setWidget?.("pi-async-rail", createRailFactory(pi, registry, { onOpenTask: (id) => openPanel(pi, registry, id) }), { placement: "aboveEditor" });
}
