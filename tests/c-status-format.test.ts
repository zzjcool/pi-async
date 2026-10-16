import assert from "node:assert/strict";
import test from "node:test";
import { clearedAtMs, clearDoneStatus, disposeStatus, formatStatus, initStatus, survivesClearCutoff } from "../src/tui/status.ts";
import { openPanel } from "../src/tui/panel.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("footer separates running from pending and counts all terminal as done", () => {
  assert.equal(formatStatus({ running: 3, pending: 2 }, 7), " 3 running · 2 pending · 7 done ");
  assert.equal(formatStatus({ running: 3, pending: 0 }, 7), " 3 running · 7 done ");
  assert.equal(formatStatus({ running: 0, pending: 1 }, 0), " 0 running · 1 pending · 0 done ");
});

test("status refresh counts failed and killed toward done", () => {
  const statuses: string[] = [];
  const ui = { setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); } };
  bindTuiHost({ mode: "tui", ui });
  const originalSetInterval = globalThis.setInterval;
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = (() => {
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  try {
    const now = Date.now();
    const registry = {
      activeCount: () => ({ running: 0, pending: 0 }),
      list: () => [
        makeSnapshot({ status: "completed", taskId: "ok", finishedAt: now }),
        makeSnapshot({ status: "failed", taskId: "bad", finishedAt: now }),
        makeSnapshot({ status: "killed", taskId: "dead", finishedAt: now }),
      ],
    } as never;
    initStatus({} as never, registry);
    assert.equal(statuses.at(-1), " 0 running · 3 done ");
  } finally {
    disposeStatus();
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
  }
});

test("status init replaces its interval and dispose clears it", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const cleared: unknown[] = [];
  let nextId = 0;
  (globalThis as unknown as { setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval> }).setInterval = () => ({ id: ++nextId, unref() {} } as unknown as ReturnType<typeof setInterval>);
  (globalThis as unknown as { clearInterval: (id: ReturnType<typeof setInterval>) => void }).clearInterval = (id) => { cleared.push(id); };
  try {
    const ui = { setStatus() {} };
    bindTuiHost({ mode: "tui", ui });
    const pi = {} as never;
    const registry = { activeCount: () => ({ running: 0, pending: 0 }), list: () => [] } as never;
    initStatus(pi, registry);
    initStatus(pi, registry);
    assert.equal(cleared.length, 1);
    disposeStatus();
    assert.equal(cleared.length, 2);
  } finally {
    disposeStatus();
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("survivesClearCutoff uses finishedAt ?? createdAt (footer semantics) (#31)", () => {
  const clearTime = 1_000_000;
  const before = makeSnapshot({
    taskId: "before",
    status: "completed",
    createdAt: clearTime - 1000,
    finishedAt: clearTime - 500,
  });
  const midFlight = makeSnapshot({
    taskId: "mid",
    status: "completed",
    createdAt: clearTime - 300,
    finishedAt: clearTime + 200,
  });
  const after = makeSnapshot({
    taskId: "after",
    status: "completed",
    createdAt: clearTime + 100,
    finishedAt: clearTime + 400,
  });
  const running = makeSnapshot({
    taskId: "run",
    status: "running",
    createdAt: clearTime - 9999,
  });
  const pending = makeSnapshot({
    taskId: "pend",
    status: "pending",
    createdAt: clearTime - 9999,
  });

  assert.equal(survivesClearCutoff(before, clearTime), false);
  assert.equal(survivesClearCutoff(midFlight, clearTime), true, "created before / finished after clear must survive");
  assert.equal(survivesClearCutoff(after, clearTime), true);
  assert.equal(survivesClearCutoff(running, clearTime), true);
  assert.equal(survivesClearCutoff(pending, clearTime), true);
});

test("/async-clear: panel list and footer done agree on mid-flight completion (#31)", () => {
  const statuses: string[] = [];
  const ui = {
    setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); },
    custom: () => Promise.resolve(),
  };
  bindTuiHost({ mode: "tui", ui });
  const originalSetInterval = globalThis.setInterval;
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = (() => {
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  try {
    // Three shapes relative to a clear watermark we set next.
    const clearTime = Date.now();
    // Force watermark slightly in the past so we can plant finishedAt after it.
    // clearDoneStatus uses Date.now(); sleep 1ms then finish mid-flight after.
    clearDoneStatus();
    const watermark = clearedAtMs();
    assert.ok(watermark >= clearTime);

    const before = makeSnapshot({
      taskId: "before",
      name: "before-clear",
      status: "completed",
      createdAt: watermark - 1000,
      finishedAt: watermark - 500,
    });
    const midFlight = makeSnapshot({
      taskId: "mid",
      name: "mid-flight",
      status: "completed",
      createdAt: watermark - 300,
      finishedAt: watermark + 200,
    });
    const after = makeSnapshot({
      taskId: "after",
      name: "after-clear",
      status: "completed",
      createdAt: watermark + 100,
      finishedAt: watermark + 400,
    });
    const tasks = [before, midFlight, after];
    const registry = {
      activeCount: () => ({ running: 0, pending: 0 }),
      list: () => tasks,
      get: (id: string) => tasks.find((t) => t.taskId === id),
      logs: () => ({ text: "", truncated: false, fullPath: "" }),
      kill: async () => undefined,
      submit: () => midFlight,
    } as never;

    initStatus({} as never, registry);
    // Footer: mid + after = 2 done (before cleared away); failed/killed still TERMINAL.
    assert.equal(statuses.at(-1), " 0 running · 2 done ");

    // Panel uses the same survivesClearCutoff / clearedAtMs — mid-flight must list.
    let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => {
      render: (width: number) => string[];
    }) | undefined;
    const panelUi = {
      custom: (f: typeof factory) => { factory = f; return Promise.resolve(); },
    };
    openPanel({ mode: "tui", ui: panelUi } as never, registry);
    const rendered = factory!({ requestRender() {} }, {}, {}, () => {}).render(120).join("\n");
    assert.match(rendered, /mid-flight/, "panel must list task created before clear that finished after");
    assert.match(rendered, /after-clear/);
    assert.doesNotMatch(rendered, /before-clear/);
  } finally {
    disposeStatus();
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
  }
});
