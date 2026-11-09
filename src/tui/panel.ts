import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";
import { stripAnsi, visibleText } from "../core/output.ts";
import { formatDuration } from "../core/duration.ts";
import { displayWidth, fitWidth, truncateToWidth } from "./width.ts";
import { clearDoneStatus, survivesClearCutoff } from "./status.ts";
import { tuiHost } from "./host.ts";

type Theme = { fg?(color: string, text: string): string };

/** Paint with host theme; missing/throwing fg falls back to plain text (#41 / #75). */
export function paint(theme: Theme | null | undefined, token: string, text: string): string {
  try {
    const fg = theme?.fg;
    if (typeof fg !== "function") return text;
    return fg.call(theme, token, text) ?? text;
  } catch {
    return text;
  }
}

function statusToken(status: string): string {
  if (status === "completed") return "success";
  if (status === "failed" || status === "killed") return "error";
  return "accent";
}

function stringifyMetaValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function sectionDivider(theme: Theme | null | undefined, budget: number): string {
  const bar = "─".repeat(Math.max(0, Math.min(budget, 64)));
  return paint(theme, "dim", bar);
}

const isTui = (pi: unknown): boolean => {
  // Event/command contexts carry mode; the factory API does not. Both paths must resolve.
  const asCtx = pi as { mode?: string } | undefined;
  return asCtx?.mode === "tui" || tuiHost()?.mode === "tui";
};

const UI_TAIL_BYTES = 128 * 1024;
/** The list shows one live output line per task — a small tail window is enough (§2.9). */
const LIST_TAIL_BYTES = 16 * 1024;
const PANEL_ROWS = 12;
/**
 * D-30: PageUp/PageDown move one whole output window. The detail body sets this to the
 * live `outputRows` on every render; PANEL_ROWS is only the initial value.
 */
let pageStep = PANEL_ROWS;
/** R2-3: floor for the output window — a taller chrome must not leave less than this many rows. */
const MIN_OUTPUT_ROWS = 8;
/** D-31: the panel repaints itself while a task runs (same 1Hz pattern as rail.ts). */
const PANEL_REFRESH_MS = 1000;
/** Identity lines kept above the `… (+K lines)` marker when the detail body overflows. */
const DETAIL_HEADER_LINES = 2;
/** 0.3.0 §2.9: kill moved off `k` (which now scrolls up) onto `x`/`X`/`K`. */
const KILL_KEYS = new Set(["x", "X", "K"]);
const visible = visibleText;
/** Per-line sanitizer for multiline command display — keeps LF, strips controls/tabs. */
const visibleLine = (value: unknown): string => stripAnsi(String(value ?? "")).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[\t]+/g, " ");

/**
 * Mask a delayed task's env values but keep the keys: they are credentials-in-waiting,
 * exactly like the async_status redaction (D-08). Kept local so the panel never imports src/tools.
 */
function maskDelayedEnv(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "***";
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 0 ? "***" : `{ ${keys.map((key) => `${key}: "***"`).join(", ")} }`;
}

function metadataText(key: string, value: unknown): string {
  return key === "delayedEnv" ? maskDelayedEnv(value) : stringifyMetaValue(value);
}

/** Known keys first (outputFile), then remaining keys sorted; each line truncated to budget. */
export function formatMetadataLines(metadata: Record<string, unknown>, budget: number): string[] {
  const keys = Object.keys(metadata);
  const ordered = [
    ...(["outputFile"] as const).filter((key) => Object.prototype.hasOwnProperty.call(metadata, key)),
    ...keys.filter((key) => key !== "outputFile").sort(),
  ];
  return ordered.map((key) => truncateToWidth(`${key}: ${metadataText(key, metadata[key])}`, Math.max(0, budget)));
}

export function detailTitleLines(task: { name: string; taskId: string }, theme: Theme | null | undefined): string[] {
  const name = visibleText(task.name);
  const id = `[${task.taskId}]`;
  return [`${paint(theme, "accent", name)} ${paint(theme, "dim", id)}`];
}

export function detailStatusLines(task: TaskSnapshot, theme: Theme | null | undefined, now: number): string[] {
  const status = paint(theme, statusToken(task.status), task.status);
  const elapsed = paint(theme, "dim", formatDuration(task, now));
  return [`${paint(theme, "dim", "status:")} ${status} · ${paint(theme, "dim", "elapsed:")} ${elapsed}`];
}

export function commandSection(command: unknown, theme: Theme | null | undefined, budget: number): string[] {
  const label = paint(theme, "dim", "command:");
  const lines = String(command ?? "").split(/\r?\n/);
  const body = lines.map((line) => {
    const plain = `  ${visibleLine(line)}`;
    return paint(theme, "text", truncateToWidth(plain, Math.max(0, budget)));
  });
  return [label, ...body];
}

export function metadataSection(metadata: Record<string, unknown>, theme: Theme | null | undefined, budget: number): string[] {
  const label = paint(theme, "dim", "metadata:");
  const rows = formatMetadataLines(metadata, Math.max(0, budget - 2)).map((row) => paint(theme, "dim", `  ${row}`));
  return [label, ...rows];
}

export function outputSection(
  tail: string[],
  truncated: boolean,
  theme: Theme | null | undefined,
  budget: number,
  live = false,
): string[] {
  // D-33: live = the task is still producing output. The 5th argument is optional, so the
  // original 4-argument call sites keep their exact label.
  const marks = [live ? "live" : undefined, truncated ? "tail truncated" : undefined].filter(Boolean);
  const label = paint(theme, "dim", `output${marks.length > 0 ? ` (${marks.join(", ")})` : ""}:`);
  const rows = tail.map((line) => paint(theme, "dim", truncateToWidth(visible(line), Math.max(0, budget))));
  return [label, ...rows];
}

/**
 * Bounded output tail, always asked of the registry: it enforces the dataDir boundary
 * (D-11) and the task may already be pruned, so a throw means "show nothing".
 */
function logsTail(registry: TaskRegistry, taskId: string, maxBytes: number): { text: string; truncated: boolean } {
  try {
    const slice = registry.logs(taskId, { maxBytes, tail: true });
    return { text: stripAnsi(slice.text), truncated: slice.truncated };
  } catch {
    // Unknown/pruned task or an outputFile outside the data dir — never read it, never throw.
    return { text: "", truncated: false };
  }
}

function readUiOutput(task: TaskSnapshot, registry: TaskRegistry): { text: string; truncated: boolean } {
  return logsTail(registry, task.taskId, UI_TAIL_BYTES);
}

/** Newest non-empty output line for the list row (bounded tail, never a whole-file read). */
function latestOutputLine(task: TaskSnapshot, registry: TaskRegistry): string | undefined {
  const text = logsTail(registry, task.taskId, LIST_TAIL_BYTES).text;
  return text.split(/\r?\n/).filter(Boolean).at(-1);
}

/** Fit a possibly-ANSI line to a cell budget without counting escape bytes (#75). */
function fitAnsiLine(text: string, budget: number): string {
  const plain = stripAnsi(text);
  if (plain === text) return fitWidth(text, budget);
  const used = displayWidth(plain);
  if (used > budget) return fitWidth(plain, budget);
  return text + " ".repeat(budget - used);
}

const frame = (title: string, body: string[], width: number, height: number): string[] => {
  const w = Math.max(8, Math.floor(width));
  const h = Math.max(4, Math.floor(height));
  // Title prefix is "╭─ " (3) + "─╮" (2) => budget w-5; body "│ "/" │" (2+2) => w-4.
  // #55 keeps fitTitle(w-5); #7/#62 routes both through fitWidth (cell-aware).
  // #75: body lines may carry theme ANSI — fit by visible cells, not raw code points.
  const fitTitle = (text: string): string => fitWidth(text, w - 5);
  const fit = (text: string): string => fitAnsiLine(text, w - 4);
  const content = [`╭─ ${fitTitle(title)}─╮`, ...body.slice(0, h - 2).map((line) => `│ ${fit(line)} │`), `╰${"─".repeat(w - 2)}╯`];
  while (content.length < height) content.splice(content.length - 1, 0, `│${" ".repeat(w - 2)}│`);
  // The solid background masks chat rows beneath the overlay, as in legion-viz's live overlay.
  return content;
};

/** Bare Esc, Kitty CSI-u Escape (key 27), and a lone CSI introducer. */
export function isEscapeKey(data: string): boolean {
  if (data === "\u001b") return true;
  if (data === "\u001b[") return true;
  return /^\u001b\[27(?:;\d+)*u$/.test(data);
}

export function registerPanelCommands(pi: PiCtx, registry: TaskRegistry): void {
  // Commands/shortcuts are factory-time APIs (they exist on the factory pi); TUI
  // gating comes from the bound event context. Handlers receive a rich ctx with ui.
  const bound = tuiHost();
  // SAFETY: the factory host may omit registration methods; optional chaining is intentional.
  const host = pi as unknown as {
    registerCommand?: (name: string, spec: { description: string; handler: (args: unknown, ctx: PiCtx) => void }) => void;
  };
  if (!bound) return;
  host.registerCommand?.("async", { description: "Open async task panel", handler: (_args, ctx) => openPanel(ctx, registry) });
  host.registerCommand?.("async-clear", {
    description: "Clear async task history",
    handler: (_args, ctx) => {
      if (!isTui(ctx)) return;
      clearDoneStatus(); // shared watermark in status.ts (#31)
    },
  });
}

/**
 * D-14: the overlay is a module-level singleton. A second `/async` (or a rail click
 * while the panel is open) must not stack another overlay.
 */
let panelOpen: symbol | undefined;

/** @internal Test-only: forget an open panel so isolated unit tests can re-open one. */
export function resetPanelForTests(): void {
  panelOpen = undefined;
}

export function openPanel(pi: PiCtx, registry: TaskRegistry, initialTaskId?: string): void {
  // Event/command contexts carry a working ui; rail-click paths pass the factory
  // pi, whose ui is undefined — fall back to the bound TUI host in that case.
  const ctxUi = (pi as { ui?: Record<string, unknown> }).ui ?? tuiHost()?.ui;
  const host = {
    ui: ctxUi as {
      custom?: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => unknown, options: unknown) => Promise<unknown>;
      notify?: (message: string, level?: string) => void;
      setStatus?: (key: string, text: string | undefined) => void;
    } | undefined,
  };
  if (!isTui(pi) || typeof host.ui?.custom !== "function") return;
  if (panelOpen !== undefined) {
    host.ui.notify?.("Async panel is already open", "info");
    return;
  }
  // Set before custom(): the host may render synchronously, and a reject must not leak the flag.
  const token = Symbol("pi-async-panel");
  panelOpen = token;
  const release = (): void => {
    if (panelOpen === token) panelOpen = undefined;
  };
  // R2-2: a rejecting/throwing custom() cannot reach the factory closure, so the factory
  // publishes its own teardown here as soon as it exists. The host may also reject before
  // the factory ever ran — then this stays undefined and release() alone is enough.
  let killWidget: (() => void) | undefined;
  const snapshots = (): TaskSnapshot[] => registry.list({ includeHistory: true }).filter((task) => survivesClearCutoff(task));
  const custom = host.ui.custom;
  const kind = initialTaskId ? "detail" : "list";
  const ratio = kind === "detail" ? { w: 0.85, h: 0.8 } : { w: 0.8, h: 0.7 };
  const factory = (tui: unknown, themeArg: unknown, _keybindings: unknown, done: (value?: unknown) => void) => {
    const theme = (themeArg ?? {}) as Theme;
    let selected = initialTaskId ?? snapshots()[0]?.taskId;
    let detail = Boolean(initialTaskId);
    const origin: "rail" | "list" = initialTaskId ? "rail" : "list";
    let history = true;
    let confirmKill = false;
    let scroll = 0;
    let listScroll = 0;
    let follow = true;
    /** D-32: output-line count of the last detail render, used to keep a scrolled-up view still. */
    let lastOutputCount = 0;
    /** R2-1: window height of the last detail render — 0 while nothing was scrolled out of view. */
    let lastOutputRows = 0;
    let lastTaskId: string | undefined;
    let width = 100;
    let height = process.stdout.rows ?? 24;
    let lastLines: string[] = [];
    let actionError: string | undefined;
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const requestRender = (): void => {
      // A stale subscription (registry still holding our listener) must not render.
      if (closed) return;
      try {
        (tui as { requestRender?: () => void } | undefined)?.requestRender?.();
      } catch {
        // A dead overlay host must not break the render loop.
      }
    };
    // D-31: while a task runs the registry publishes no state events, so the panel repaints
    // itself at 1Hz — the output window then keeps up with the growing log. `requestRender()`
    // keeps its `closed` guard, and teardown() is the single owner of the timer.
    const ticker = setInterval(() => requestRender(), PANEL_REFRESH_MS);
    (ticker as { unref?: () => void }).unref?.();
    /** Single teardown path for done / dispose / custom() failure — keeps the subscription leak-free. */
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ticker);
      release();
      const off = unsubscribe;
      unsubscribe = undefined;
      if (!off) return;
      try {
        off();
      } catch {
        // Registry may already be torn down (reload/quit); unsubscribing is best-effort.
      }
    };
    // R2-2: exposed to openPanel so a rejecting custom() kills the ticker too.
    killWidget = teardown;
    const close = (value?: unknown): void => {
      teardown();
      done(value);
    };
    // W1a adds `subscribe`; older/mock registries (0.2.x hosts) do not have it.
    const subscribe = (registry as unknown as { subscribe?: (listener: () => void) => () => void }).subscribe;
    if (typeof subscribe === "function") {
      try {
        const off = subscribe.call(registry, () => requestRender());
        if (typeof off === "function") unsubscribe = off;
      } catch {
        // A registry that cannot publish events simply never refreshes us.
      }
    }
    const filtered = (): TaskSnapshot[] => snapshots().filter((task) => history || task.status === "running" || task.status === "pending");
    const choose = (): TaskSnapshot | undefined => snapshots().find((task) => task.taskId === selected);
    const listBudget = (): number => Math.max(1, height - 3); // frame borders + hint row
    const ensureListWindow = (tasks: TaskSnapshot[]): number => {
      const budget = listBudget();
      const selIndex = tasks.findIndex((task) => task.taskId === selected);
      const index = selIndex < 0 ? 0 : selIndex;
      if (index < listScroll) listScroll = index;
      if (index >= listScroll + budget) listScroll = index - budget + 1;
      listScroll = Math.max(0, Math.min(listScroll, Math.max(0, tasks.length - budget)));
      return listScroll;
    };
    const footerLine = (): string => paint(
      theme,
      "dim",
      `${origin === "rail" ? "Esc close" : "Esc return"} · x kill/cancel · R rerun · c show output path · ↑/↓ scroll`,
    );
    /**
     * Keep the header and the footer visible; collapse the middle into `… (+K lines)`.
     * The footer is always the last emitted line, so `frame` can never silently cut it.
     */
    const withBodyBudget = (lines: string[], budget: number): string[] => {
      const limit = Math.max(1, Math.floor(budget));
      if (lines.length <= limit) return lines;
      const headerCount = Math.min(DETAIL_HEADER_LINES, Math.max(0, limit - 1));
      const tailCount = limit - headerCount - 1;
      const last = lines[lines.length - 1]!;
      // Degenerate viewport: the key hints outrank every other line.
      if (tailCount <= 0) return [last];
      const hidden = lines.length - headerCount - tailCount;
      return [
        ...lines.slice(0, headerCount),
        paint(theme, "dim", `… (+${hidden} lines)`),
        ...lines.slice(lines.length - tailCount),
      ];
    };
    const renderBody = (budget: number): string[] => {
      const tasks = filtered();
      if (!detail) {
        const start = ensureListWindow(tasks);
        const rows = tasks.slice(start, start + Math.max(1, budget - 1)).map((task) => {
          const output = task.status === "running" ? latestOutputLine(task, registry) : undefined;
          return `${task.taskId === selected ? "▶" : " "} ${visible(task.name)} · ${task.status} · ${formatDuration(task, Date.now())}${output ? ` · ${visible(output)}` : ""}`;
        });
        return ["↑/↓ select · Enter details · h history · q close", ...rows];
      }
      const task = choose();
      if (!task) return ["Task not found", `${origin === "rail" ? "Esc close" : "Esc return"} · q close`];
      const output = readUiOutput(task, registry);
      const outputLines = output.text.split(/\r?\n/).filter((line) => line.length > 0);
      // D-32: output that arrives while the user is scrolled up must not push the lines they
      // are reading out of the window — shift the offset by the delta instead. `follow` still
      // pins the window to the tail; a task switch restarts the anchor (another task's count
      // says nothing about this window).
      if (lastTaskId !== task.taskId) {
        lastTaskId = task.taskId;
        lastOutputCount = 0;
        lastOutputRows = 0;
      } else if (lastOutputCount <= lastOutputRows) {
        // R2-1: the previous window hid nothing, so the view *was* the tail. A key that cannot
        // scroll anything (→/k/PageUp on a log shorter than the window) must not leave a phantom
        // offset behind: D-32 would then anchor the view to the lines visible at keypress time
        // and the newest output would never appear again.
        scroll = 0;
        follow = true;
      } else if (!follow && outputLines.length > lastOutputCount) {
        scroll += outputLines.length - lastOutputCount;
      }
      lastOutputCount = outputLines.length;
      const lineBudget = Math.max(1, Math.floor(width) - 4);
      const killHint = task.status === "pending"
        ? "Cancel this pending task? press x again to confirm; any other key cancels"
        : "Kill this task? press x again to confirm; any other key cancels";
      const divider = sectionDivider(theme, lineBudget);
      const commandLines = commandSection(task.command, theme, lineBudget);
      const metadataLines = metadataSection(task.metadata as Record<string, unknown>, theme, lineBudget);
      // D-30: the output window is whatever the fixed chrome leaves, not a fixed 12 rows.
      const chrome = 1 // title
        + 1 // status
        + 1 // divider
        + commandLines.length
        + 1 // divider
        + metadataLines.length
        + 1 // divider
        + 1 // output label
        + (actionError ? 1 : 0)
        + (confirmKill ? 1 : 0)
        + 1; // footer
      const outputRows = Math.max(MIN_OUTPUT_ROWS, budget - chrome);
      lastOutputRows = outputRows;
      pageStep = outputRows;
      const live = task.status === "running" || task.status === "pending";
      scroll = Math.min(scroll, Math.max(0, outputLines.length - outputRows));
      // R2-1: clamping back to the tail means we follow again (same invariant as move()/wheel/page).
      if (scroll === 0) follow = true;
      const tail = outputLines.slice(Math.max(0, outputLines.length - outputRows - scroll), outputLines.length - scroll);
      return withBodyBudget([
        ...detailTitleLines(task, theme),
        ...detailStatusLines(task, theme, Date.now()),
        divider,
        ...commandLines,
        divider,
        ...metadataLines,
        divider,
        ...outputSection(tail, output.truncated, theme, lineBudget, live),
        ...(actionError ? [paint(theme, "error", `error: ${visible(actionError)}`)] : []),
        ...(confirmKill ? [paint(theme, "warning", killHint)] : []),
        footerLine(),
      ], budget);
    };
    const render = (nextWidth?: number): string[] => {
      width = nextWidth ?? Math.max(20, Math.floor((process.stdout.columns ?? 120) * ratio.w));
      // Cap by the overlay's own percentage budget too: on very short terminals a fixed floor of 6
      // exceeds what the host will render and the bottom border gets sliced off.
      const rows = process.stdout.rows ?? 24;
      height = Math.min(Math.max(6, Math.floor(rows * ratio.h)), Math.max(4, rows - 2));
      lastLines = renderBody(Math.max(1, height - 2));
      // The body is already budgeted, so its length no longer measures the scroll range;
      // renderBody clamps `scroll` against the real output-line count instead.
      if (follow) scroll = 0;
      return frame(detail ? "Async task detail" : "Async tasks", lastLines, width, height);
    };
    const move = (delta: number): void => {
      const tasks = filtered();
      const index = tasks.findIndex((task) => task.taskId === selected);
      // Harden dangling selection (filtered away): start from edge rather than relying on -1+delta===0 alone.
      const base = index < 0 ? (delta > 0 ? -1 : 0) : index;
      const next = tasks[Math.max(0, Math.min(tasks.length - 1, base + delta))];
      if (next) selected = next.taskId;
      if (detail && delta < 0) { scroll += -delta; follow = false; }
      else if (detail && delta > 0) { scroll = Math.max(0, scroll - delta); follow = scroll === 0; }
      requestRender();
    };
    const killSelected = (): void => {
      const task = choose();
      if (!task || (task.status !== "running" && task.status !== "pending")) return;
      const fail = (error: unknown): void => {
        actionError = String(error);
        host.ui?.notify?.(actionError, "error");
        requestRender();
      };
      // §2.9: a rejected kill must surface in the panel instead of an unhandled rejection.
      try {
        void Promise.resolve(registry.kill(task.taskId, "user")).catch(fail);
      } catch (error) {
        // Some hosts throw synchronously instead of rejecting; treat both the same.
        fail(error);
      }
    };
    let latchedId: string | undefined;
    return {
      render,
      handleInput(data: string): void {
        const key = data.toLowerCase();
        if (confirmKill && !KILL_KEYS.has(data)) { confirmKill = false; requestRender(); return; }
        if (key === "q") { close(undefined); return; }
        if (isEscapeKey(data)) {
          if (detail && origin === "list") { detail = false; confirmKill = false; actionError = undefined; requestRender(); }
          else close(undefined);
          return;
        }
        if (key === "h" && !detail) {
          history = !history;
          const tasks = filtered();
          if (!tasks.some((task) => task.taskId === selected)) selected = tasks[0]?.taskId;
          listScroll = 0;
          requestRender();
          return;
        }
        if (data === "\r" || data === "\n") { detail = true; scroll = 0; follow = true; actionError = undefined; requestRender(); return; }
        // PLAN §2.9: PageUp/PageDown page the detail body (PageUp = older lines).
        // D-30: one page = one output window (`pageStep`, set by the last render).
        // renderBody clamps the actual offset against the output length.
        if (detail && (data === "\u001b[5~" || data === "\u001b[6~")) {
          scroll = Math.max(0, scroll + (data === "\u001b[5~" ? pageStep : -pageStep));
          follow = scroll === 0;
          requestRender();
          return;
        }
        // Kill lives above the movement keys: `K` is a kill key, `k` alone scrolls up.
        if (detail && KILL_KEYS.has(data)) {
          if (!confirmKill) { confirmKill = true; requestRender(); return; }
          confirmKill = false;
          killSelected();
          requestRender();
          return;
        }
        if (data === "\u001b[A" || key === "k") { move(-1); return; }
        if (data === "\u001b[B" || key === "j") { move(1); return; }
        if (data === "R" && detail) {
          const task = choose();
          if (task) {
            try {
              // Rerun keeps the original task's cwd (REV-13) instead of the host process cwd.
              const created = registry.submit({
                command: task.command,
                name: task.name,
                mode: "background",
                ...(task.cwd ? { cwd: task.cwd } : {}),
              });
              selected = created.taskId;
              scroll = 0;
              follow = true;
              actionError = undefined;
            } catch (error) {
              actionError = String(error);
              host.ui?.notify?.(actionError, "error");
            }
          }
          requestRender(); return;
        }
        if (data === "c" && detail) {
          const path = choose()?.metadata.outputFile;
          // §2.9: pi has no copyToClipboard API — show the path so the user can copy it.
          if (typeof path === "string") {
            host.ui?.notify?.(path, "info");
            requestRender();
          }
        }
      },
      handleMouse(event: { type: string; y?: number; button?: string; wheelDelta?: number }): { handled: boolean } | undefined {
        if (event.type === "wheel") {
          const delta = Math.trunc(event.wheelDelta ?? 0);
          if (detail) { scroll = Math.max(0, scroll + delta); follow = scroll === 0; }
          else move(delta);
          requestRender();
          return { handled: true };
        }
        if (event.type === "press") {
          latchedId = undefined;
          if (detail) return undefined;
          if (event.button !== "left") return undefined;
          const tasks = filtered();
          const start = ensureListWindow(tasks);
          const index = (event.y ?? -1) - 2 + start;
          const task = tasks[index];
          if (!task) return undefined;
          latchedId = task.taskId;
          return { handled: true };
        }
        if (event.type !== "click" || event.button !== "left" || detail) return undefined;
        const tasks = filtered();
        const start = ensureListWindow(tasks);
        const index = (event.y ?? -1) - 2 + start;
        const task = tasks[index];
        if (!latchedId || !task || task.taskId !== latchedId) { latchedId = undefined; return undefined; }
        selected = latchedId;
        detail = true;
        scroll = 0;
        follow = true;
        actionError = undefined;
        latchedId = undefined;
        requestRender();
        return { handled: true };
      },
      dispose(): void { teardown(); },
    };
  };
  // custom() resolves undefined outside supported TUI contexts. The RPC peer's
  // custom() returns a Promise even though mode guards prevent invocation there.
  try {
    void Promise.resolve(custom.call(host.ui, factory, {
      overlay: true,
      overlayOptions: {
        width: kind === "detail" ? "85%" : "80%",
        maxHeight: kind === "detail" ? "80%" : "70%",
        anchor: "center",
      },
    })).catch(() => {
      // R2-2: the factory may already have started its ticker/subscription before the reject.
      killWidget?.();
      release();
    });
  } catch {
    // A synchronously throwing custom() must not leave the singleton latched open.
    killWidget?.();
    release();
  }
}
