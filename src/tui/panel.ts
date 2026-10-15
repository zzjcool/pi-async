import { readFileSync } from "node:fs";
import type { PiCtx } from "../core/notify.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { TaskSnapshot } from "../core/task.ts";
import { stripAnsi } from "../core/output.ts";
import { clearDoneStatus } from "./status.ts";

const isTui = (pi: PiCtx): boolean => {
  // SAFETY: `mode` is a runtime extension-context field omitted from ExtensionAPI's older peer declaration.
  return (pi as unknown as { mode?: string }).mode === "tui";
};

const UI_TAIL_BYTES = 128 * 1024;
const PANEL_ROWS = 12;
let historyClearedAt = 0;
const visible = (value: unknown): string => stripAnsi(String(value ?? "")).replace(/[\r\n\t]+/g, " ");
function readUiOutput(task: TaskSnapshot, registry: TaskRegistry): { text: string; truncated: boolean } {
  const outputPath = task.metadata.outputFile;
  if (typeof outputPath !== "string") return { text: registry.logs(task.taskId, { maxBytes: UI_TAIL_BYTES, tail: true }).text, truncated: false };
  try {
    const data = readFileSync(outputPath);
    const start = Math.max(0, data.byteLength - UI_TAIL_BYTES);
    return { text: stripAnsi(data.subarray(start).toString("utf8")), truncated: start > 0 };
  } catch {
    return { text: registry.logs(task.taskId, { maxBytes: UI_TAIL_BYTES, tail: true }).text, truncated: false };
  }
}

const duration = (task: TaskSnapshot, now: number): string => {
  const end = task.finishedAt ?? now;
  const seconds = Math.floor(Math.max(0, end - (task.startedAt ?? task.createdAt)) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const frame = (title: string, body: string[], width: number, height: number): string[] => {
  const w = Math.max(8, Math.floor(width));
  const h = Math.max(4, Math.floor(height));
  const fit = (text: string): string => Array.from(text).slice(0, w - 4).join("").padEnd(w - 4);
  const content = [`╭─ ${fit(title)}─╮`, ...body.slice(0, h - 2).map((line) => `│ ${fit(line)} │`), `╰${"─".repeat(w - 2)}╯`];
  while (content.length < height) content.splice(content.length - 1, 0, `│${" ".repeat(w - 2)}│`);
  // The solid background masks chat rows beneath the overlay, as in legion-viz's live overlay.
  return content;
};

export function registerPanelCommands(pi: PiCtx, registry: TaskRegistry): void {
  // SAFETY: Mode is present on runtime extension contexts though absent from ExtensionAPI types.
  const host = pi as unknown as {
    mode?: string;
    registerCommand?: (name: string, spec: { description: string; handler: (args: unknown, ctx: PiCtx) => void }) => void;
    registerShortcut?: (key: string, spec: { description: string; handler: (ctx: PiCtx) => void }) => void;
  };
  if (host.mode !== "tui") return;
  host.registerCommand?.("async", { description: "Open async task panel", handler: (_args, ctx) => openPanel(ctx, registry) });
  host.registerCommand?.("async-clear", {
    description: "Clear async task history",
    handler: (_args, ctx) => {
      if (!isTui(ctx)) return;
      historyClearedAt = Date.now();
      clearDoneStatus();
    },
  });
  try {
    host.registerShortcut?.("ctrl+alt+a", { description: "Open async task panel", handler: (ctx) => openPanel(ctx, registry) });
  } catch {
    // The /async command remains the fallback when Pi reserves this shortcut.
  }
}

export function openPanel(pi: PiCtx, registry: TaskRegistry, initialTaskId?: string): void {
  // SAFETY: ExtensionAPI omits mode in some peer typings; only the main TUI supports custom overlays.
  const host = pi as unknown as {
    mode?: string;
    ui?: {
      copyToClipboard?: (text: string) => void;
      custom?: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => unknown, options: unknown) => unknown;
      notify?: (message: string, level?: string) => void;
      setStatus?: (key: string, text: string | undefined) => void;
    };
    registerCommand?: (name: string, spec: { description: string; handler: (args: unknown, ctx: PiCtx) => void }) => void;
  };
  if (host.mode !== "tui" || typeof host.ui?.custom !== "function") return;
  const snapshots = (): TaskSnapshot[] => registry.list({ includeHistory: true }).filter((task) => task.createdAt >= historyClearedAt || task.status === "running" || task.status === "pending");
  const custom = host.ui.custom;
  const factory = (tui: unknown, _theme: unknown, _keybindings: unknown, done: (value?: unknown) => void) => {
    let selected = initialTaskId ?? snapshots()[0]?.taskId;
    let detail = Boolean(initialTaskId);
    let history = true;
    let confirmKill = false;
    let scroll = 0;
    let follow = true;
    let width = 100;
    let height = process.stdout.rows ?? 24;
    let lastLines: string[] = [];
    const requestRender = (): void => {
      (tui as { requestRender?: () => void } | undefined)?.requestRender?.();
    };
    const choose = (): TaskSnapshot | undefined => snapshots().find((task) => task.taskId === selected);
    const renderBody = (): string[] => {
      const tasks = snapshots().filter((task) => history || task.status === "running" || task.status === "pending");
      if (!detail) {
        return ["↑/↓ select · Enter details · h history · q close", ...tasks.map((task) => {
          const output = task.status === "running" ? registry.logs(task.taskId, { maxBytes: UI_TAIL_BYTES, tail: true }).text.split(/\r?\n/).filter(Boolean).at(-1) : undefined;
          return `${task.taskId === selected ? "▶" : " "} ${task.name} · ${task.status} · ${duration(task, Date.now())}${output ? ` · ${visible(output)}` : ""}`;
        })];
      }
      const task = choose();
      if (!task) return ["Task not found", "Esc return · q close"];
      const output = readUiOutput(task, registry);
      const outputLines = output.text.split(/\r?\n/).filter((line) => line.length > 0);
      scroll = Math.min(scroll, Math.max(0, outputLines.length - PANEL_ROWS));
      const tail = outputLines.slice(Math.max(0, outputLines.length - PANEL_ROWS - scroll), outputLines.length - scroll);
      const meta = JSON.stringify(task.metadata);
      return [
        `${task.name} [${task.taskId}]`, `status: ${task.status} · elapsed: ${duration(task, Date.now())}`,
        `command: ${task.command}`, `metadata: ${meta}`, `output${output.truncated ? " (tail truncated)" : ""}:`,
        ...tail.map(visible), ...(confirmKill ? ["Kill this task? press k again to confirm; any other key cancels"] : []),
        "Esc return · k kill · R rerun · c copy output path · ↑/↓ scroll",
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
      const tasks = snapshots().filter((task) => history || task.status === "running" || task.status === "pending");
      const index = tasks.findIndex((task) => task.taskId === selected);
      const next = tasks[Math.max(0, Math.min(tasks.length - 1, index + delta))];
      if (next) selected = next.taskId;
      if (detail && delta < 0) { scroll += -delta; follow = false; }
      else if (detail && delta > 0) { scroll = Math.max(0, scroll - delta); follow = scroll === 0; }
      requestRender();
    };
    return {
      render,
      handleInput(data: string): void {
        const key = data.toLowerCase();
        if (confirmKill && key !== "k") { confirmKill = false; requestRender(); return; }
        if (key === "q") { done(undefined); return; }
        if (data === "\u001b") { if (detail) { detail = false; confirmKill = false; requestRender(); } else done(undefined); return; }
        if (key === "h" && !detail) { history = !history; requestRender(); return; }
        if (data === "\r" || data === "\n") { detail = true; scroll = 0; follow = true; requestRender(); return; }
        if (data === "\u001b[A" || data === "k") { if (detail && key === "k") {
          if (!confirmKill) { confirmKill = true; requestRender(); return; }
          confirmKill = false;
          const task = choose();
          if (task?.status === "running") void registry.kill(task.taskId, "user");
          requestRender(); return;
        } move(-1); return; }
        if (data === "\u001b[B" || key === "j") { move(1); return; }
        if (key === "r" && detail) {
          const task = choose();
          if (task) {
            try { registry.submit({ command: task.command, name: task.name, mode: "background" }); }
            catch (error) { host.ui?.notify?.(String(error), "error"); }
          }
          requestRender(); return;
        }
        if (key === "c" && detail) {
          const path = choose()?.metadata.outputFile;
          if (typeof path === "string") {
            if (host.ui?.copyToClipboard) host.ui.copyToClipboard(path);
            else host.ui?.notify?.(path, "info");
          }
        }
      },
      handleMouse(event: { type: string; wheelDelta?: number }): { handled: boolean } | undefined {
        if (event.type !== "wheel") return undefined;
        const delta = Math.trunc(event.wheelDelta ?? 0);
        if (detail) { scroll = Math.max(0, scroll + delta); follow = scroll === 0; }
        else move(delta);
        requestRender();
        return { handled: true };
      },
      dispose(): void { void width; },
    };
  };
  // Required full-screen overlay geometry. custom() resolves undefined outside supported TUI contexts.
  const result = custom(factory, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 } });
  if (result === undefined) return;
}
