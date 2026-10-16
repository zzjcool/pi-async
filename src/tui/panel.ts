import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";
import { stripAnsi, visibleText } from "../core/output.ts";
import { formatDuration } from "../core/duration.ts";
import { fitWidth } from "./width.ts";
import { clearDoneStatus, survivesClearCutoff } from "./status.ts";
import { tuiHost } from "./host.ts";

const isTui = (pi: unknown): boolean => {
  // Event/command contexts carry mode; the factory API does not. Both paths must resolve.
  const asCtx = pi as { mode?: string } | undefined;
  return asCtx?.mode === "tui" || tuiHost()?.mode === "tui";
};

const UI_TAIL_BYTES = 128 * 1024;
const PANEL_ROWS = 12;
const visible = visibleText;
/** Per-line sanitizer for multiline command display — keeps LF, strips controls/tabs. */
const visibleLine = (value: unknown): string => stripAnsi(String(value ?? "")).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[\t]+/g, " ");
function readUiOutput(task: TaskSnapshot, registry: TaskRegistry): { text: string; truncated: boolean } {
  const outputPath = task.metadata.outputFile;
  if (typeof outputPath !== "string") return { text: registry.logs(task.taskId, { maxBytes: UI_TAIL_BYTES, tail: true }).text, truncated: false };
  try {
    const fd = openSync(outputPath, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - UI_TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, UI_TAIL_BYTES));
      readSync(fd, buffer, 0, buffer.length, start);
      return { text: stripAnsi(buffer.toString("utf8")), truncated: start > 0 };
    } finally { closeSync(fd); }
  } catch {
    return { text: registry.logs(task.taskId, { maxBytes: UI_TAIL_BYTES, tail: true }).text, truncated: false };
  }
}

const frame = (title: string, body: string[], width: number, height: number): string[] => {
  const w = Math.max(8, Math.floor(width));
  const h = Math.max(4, Math.floor(height));
  // Title prefix is "╭─ " (3) + "─╮" (2) => budget w-5; body "│ "/" │" (2+2) => w-4.
  // #55 keeps fitTitle(w-5); #7/#62 routes both through fitWidth (cell-aware).
  const fitTitle = (text: string): string => fitWidth(text, w - 5);
  const fit = (text: string): string => fitWidth(text, w - 4);
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
  const host = pi as unknown as {
    registerCommand?: (name: string, spec: { description: string; handler: (args: unknown, ctx: PiCtx) => void }) => void;
    registerShortcut?: (key: string, spec: { description: string; handler: (ctx: PiCtx) => void }) => void;
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
  // CONTRACT: PI_ASYNC_DOCK_SHORTCUT is disableable ("可 off"). Treat
  // off/none/false/empty (case-insensitive, trimmed) as skip registration —
  // otherwise "off" would be registered as a literal key name (#30).
  // Unset stays the default; only an explicitly set disable value skips.
  const rawShortcut = process.env.PI_ASYNC_DOCK_SHORTCUT;
  const normalized = rawShortcut === undefined ? undefined : rawShortcut.trim().toLowerCase();
  const disabled = normalized !== undefined && ["off", "none", "false", ""].includes(normalized);
  if (!disabled) {
    const key = rawShortcut && rawShortcut.trim() ? rawShortcut.trim() : "ctrl+alt+a";
    try {
      host.registerShortcut?.(key, { description: "Open async task panel", handler: (ctx) => openPanel(ctx, registry) });
    } catch {
      // The /async command remains the fallback when Pi reserves this shortcut.
    }
  }
}

export function openPanel(pi: PiCtx, registry: TaskRegistry, initialTaskId?: string): void {
  // Event/command contexts carry a working ui; rail-click paths pass the factory
  // pi, whose ui is undefined — fall back to the bound TUI host in that case.
  const ctxUi = (pi as { ui?: Record<string, unknown> }).ui ?? tuiHost()?.ui;
  const host = {
    ui: ctxUi as {
      copyToClipboard?: (text: string) => void;
      custom?: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => unknown, options: unknown) => Promise<unknown>;
      notify?: (message: string, level?: string) => void;
      setStatus?: (key: string, text: string | undefined) => void;
    } | undefined,
  };
  if (!isTui(pi) || typeof host.ui?.custom !== "function") return;
  const snapshots = (): TaskSnapshot[] => registry.list({ includeHistory: true }).filter((task) => survivesClearCutoff(task));
  const custom = host.ui.custom;
  const factory = (tui: unknown, _theme: unknown, _keybindings: unknown, done: (value?: unknown) => void) => {
    let selected = initialTaskId ?? snapshots()[0]?.taskId;
    let detail = Boolean(initialTaskId);
    let history = true;
    let confirmKill = false;
    let scroll = 0;
    let listScroll = 0;
    let follow = true;
    let width = 100;
    let height = process.stdout.rows ?? 24;
    let lastLines: string[] = [];
    let actionError: string | undefined;
    const requestRender = (): void => {
      (tui as { requestRender?: () => void } | undefined)?.requestRender?.();
    };
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
    const renderBody = (): string[] => {
      const tasks = filtered();
      if (!detail) {
        const start = ensureListWindow(tasks);
        const budget = listBudget();
        const rows = tasks.slice(start, start + budget).map((task) => {
          const output = task.status === "running" ? registry.logs(task.taskId, { maxBytes: UI_TAIL_BYTES, tail: true }).text.split(/\r?\n/).filter(Boolean).at(-1) : undefined;
          return `${task.taskId === selected ? "▶" : " "} ${visible(task.name)} · ${task.status} · ${formatDuration(task, Date.now())}${output ? ` · ${visible(output)}` : ""}`;
        });
        return ["↑/↓ select · Enter details · h history · q close", ...rows];
      }
      const task = choose();
      if (!task) return ["Task not found", "Esc return · q close"];
      const output = readUiOutput(task, registry);
      const outputLines = output.text.split(/\r?\n/).filter((line) => line.length > 0);
      scroll = Math.min(scroll, Math.max(0, outputLines.length - PANEL_ROWS));
      const tail = outputLines.slice(Math.max(0, outputLines.length - PANEL_ROWS - scroll), outputLines.length - scroll);
      const meta = JSON.stringify(task.metadata);
      const commandLines = String(task.command ?? "").split(/\r?\n/);
      const killHint = task.status === "pending"
        ? "Cancel this pending task? press k again to confirm; any other key cancels"
        : "Kill this task? press k again to confirm; any other key cancels";
      return [
        `${visible(task.name)} [${task.taskId}]`, `status: ${task.status} · elapsed: ${formatDuration(task, Date.now())}`,
        "command:",
        ...commandLines.map((line) => `  ${visibleLine(line)}`),
        `metadata: ${meta}`, `output${output.truncated ? " (tail truncated)" : ""}:`,
        // registry.logs caps its own data at 50 KiB; the TUI intentionally reads a larger 128 KiB tail directly from the output file.
        ...tail.map(visible),
        ...(actionError ? [`error: ${visible(actionError)}`] : []),
        ...(confirmKill ? [killHint] : []),
        "Esc return · k kill/cancel · R rerun · c copy output path · ↑/↓ scroll",
      ];
    };
    const render = (nextWidth?: number): string[] => {
      width = nextWidth ?? width;
      height = process.stdout.rows ?? height;
      lastLines = renderBody();
      const maxScroll = Math.max(0, lastLines.length - PANEL_ROWS);
      if (follow) scroll = 0;
      else scroll = Math.min(scroll, maxScroll);
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
    let latchedId: string | undefined;
    return {
      render,
      handleInput(data: string): void {
        const key = data.toLowerCase();
        if (confirmKill && key !== "k") { confirmKill = false; requestRender(); return; }
        if (key === "q") { done(undefined); return; }
        if (isEscapeKey(data)) { if (detail) { detail = false; confirmKill = false; actionError = undefined; requestRender(); } else done(undefined); return; }
        if (key === "h" && !detail) {
          history = !history;
          const tasks = filtered();
          if (!tasks.some((task) => task.taskId === selected)) selected = tasks[0]?.taskId;
          listScroll = 0;
          requestRender();
          return;
        }
        if (data === "\r" || data === "\n") { detail = true; scroll = 0; follow = true; actionError = undefined; requestRender(); return; }
        if (data === "\u001b[A" || data === "k") { if (detail && key === "k") {
          if (!confirmKill) { confirmKill = true; requestRender(); return; }
          confirmKill = false;
          const task = choose();
          if (task?.status === "running" || task?.status === "pending") void registry.kill(task.taskId, "user");
          requestRender(); return;
        } move(-1); return; }
        if (data === "\u001b[B" || key === "j") { move(1); return; }
        if (data === "R" && detail) {
          const task = choose();
          if (task) {
            try {
              const created = registry.submit({ command: task.command, name: task.name, mode: "background" });
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
          if (typeof path === "string") {
            if (host.ui?.copyToClipboard) host.ui.copyToClipboard(path);
            else host.ui?.notify?.(path, "info");
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
      dispose(): void { void width; },
    };
  };
  // Required full-screen overlay geometry. custom() resolves undefined outside supported TUI contexts.
  // The RPC peer's custom() returns a Promise even though the overlay is unavailable there; mode guards above prevent invocation.
  void custom(factory, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 } }).catch(() => undefined);
}
