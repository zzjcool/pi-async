import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsedMs } from "../src/core/duration.ts";
import { createRailFactory, registerRail } from "../src/tui/rail.ts";
import { clearDoneStatus, formatSummary, summarySegments } from "../src/tui/status.ts";
import { makeSnapshot } from "./helpers/index.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";

const NOW = 1_000_000;

test("formatElapsedMs formats seconds, minutes, and hours", () => {
  assert.equal(formatElapsedMs(59_999), "59s");
  assert.equal(formatElapsedMs(65_000), "1m 5s");
  assert.equal(formatElapsedMs(3_661_000), "1h 1m");
});

test("formatSummary includes pending and uses the frozen strings", () => {
  assert.equal(formatSummary({ running: 2, pending: 1, completed: 3, failed: 1, longestRunningStartedAt: NOW - 65_000 }, NOW), "▶ 2 running · 1 pending · 1m 5s · ✓3 ✗1");
  assert.equal(formatSummary({ running: 0, pending: 0, completed: 3, failed: 0 }, NOW), "▶ 0 running · — · ✓3");
  assert.equal(formatSummary({ running: 0, pending: 2, completed: 0, failed: 0 }, NOW), "▶ 0 running · 2 pending · — · ✓0");
  assert.equal(formatSummary({ running: 0, pending: 0, completed: 0, failed: 0 }, NOW), "▶ 0 running · — · ✓0");
});

test("summarySegments returns the frozen token sequence", () => {
  assert.deepEqual(summarySegments({ running: 2, pending: 1, completed: 3, failed: 1, longestRunningStartedAt: NOW - 65_000 }, NOW), [
    { text: "▶", token: "accent" },
    { text: " 2 running", token: "accent" },
    { text: " · 1 pending", token: "dim" },
    { text: " · 1m 5s", token: "dim" },
    { text: " · ✓3", token: "success" },
    { text: " ✗1", token: "error" },
  ]);
  assert.equal(summarySegments({ running: 0, pending: 0, completed: 0, failed: 0 }, NOW)[0]?.token, "dim");
});

test("rail summary drops optional segments from right to left within its width", () => {
  const theme = { fg: (_token: string, text: string) => text };
  const tasks = [
    makeSnapshot({ taskId: "run", status: "running", startedAt: NOW - 65_000 }),
    makeSnapshot({ taskId: "wait", status: "pending" }),
    makeSnapshot({ taskId: "done", status: "completed", finishedAt: NOW }),
    makeSnapshot({ taskId: "bad", status: "failed", finishedAt: NOW }),
  ];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender() {} } as never, theme as never);
  const row = widget.render(32)[0]!;
  assert.match(row, /▶ 1 running · 1 pending/);
  assert.doesNotMatch(row, /1m 5s|✓|✗/);
  assert.ok(Array.from(row).length <= 32);
  const narrower = widget.render(20)[0]!;
  assert.doesNotMatch(narrower, /pending/);
  widget.dispose?.();
});

test("rail summary counts only terminal tasks surviving the clear watermark", () => {
  clearDoneStatus();
  const cutoff = Date.now();
  const tasks = [
    makeSnapshot({ taskId: "old-done", status: "completed", finishedAt: cutoff - 1 }),
    makeSnapshot({ taskId: "old-failed", status: "failed", finishedAt: cutoff - 1 }),
    makeSnapshot({ taskId: "new-done", status: "completed", finishedAt: cutoff + 1 }),
    makeSnapshot({ taskId: "new-failed", status: "killed", finishedAt: cutoff + 1 }),
  ];
  const widget = createRailFactory({} as never, { list: () => tasks } as never)({ requestRender() {} } as never, { fg: (_token: string, text: string) => text } as never);
  assert.match(widget.render(80)[0]!, /✓1 ✗1$/);
  widget.dispose?.();
});

test("two rail registrations keep one ticker and dispose clears it", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const active = new Set<unknown>();
  let nextId = 0;
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = (() => {
    const timer = { id: ++nextId, unref() {} } as unknown as ReturnType<typeof setInterval>;
    active.add(timer);
    return timer;
  }) as unknown as typeof setInterval;
  (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((timer: unknown) => { active.delete(timer); }) as typeof clearInterval;
  resetTuiHostForTests();
  try {
    let firstFactory: ((tui: unknown, theme: unknown) => { render(width?: number): string[]; dispose?(): void }) | undefined;
    let secondFactory: typeof firstFactory;
    const ui = {
      setWidget: (_key: string, factory: typeof firstFactory) => {
        if (!firstFactory) firstFactory = factory;
        else secondFactory = factory;
      },
    };
    bindTuiHost({ mode: "tui", ui });
    const registry = { list: () => [makeSnapshot({ taskId: "run", status: "running" })] };
    registerRail({} as never, registry as never);
    registerRail({} as never, registry as never);
    const tui = { requestRender() {} };
    const theme = { fg: (_token: string, text: string) => text };
    firstFactory!(tui, theme);
    const secondWidget = secondFactory!(tui, theme);
    assert.equal(active.size, 1);
    secondWidget.dispose?.();
    assert.equal(active.size, 0);
  } finally {
    for (const timer of active) originalClearInterval(timer as ReturnType<typeof setInterval>);
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
