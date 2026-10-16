import assert from "node:assert/strict";
import test from "node:test";
import { clearedAtMs, clearDoneStatus, initStatus, survivesClearCutoff } from "../src/tui/status.ts";
import { openPanel } from "../src/tui/panel.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("initStatus does not publish footer status or create a timer", () => {
  const statuses: string[] = [];
  const ui = { setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); } };
  bindTuiHost({ mode: "tui", ui });
  const originalSetInterval = globalThis.setInterval;
  let intervalCalls = 0;
  (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = (() => {
    intervalCalls++;
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
    assert.deepEqual(statuses, []);
    assert.equal(intervalCalls, 0);
  } finally {
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
  }
});

test("initStatus reports activity without status text when bound", () => {
  const originalSetInterval = globalThis.setInterval;
  const statuses: string[] = [];
  let activities = 0;
  const ui = { setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); } };
  bindTuiHost({ mode: "tui", ui });
  try {
    initStatus({ ui: { setActivity() { activities++; } } } as never, { activeCount: () => ({ running: 2, pending: 1 }) } as never);
    assert.deepEqual(statuses, []);
    assert.equal(activities, 1);
  } finally {
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
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

test("/async-clear: panel list and clear watermark agree on mid-flight completion (#31)", () => {
  const ui = {
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
    resetTuiHostForTests();
    globalThis.setInterval = originalSetInterval;
  }
});
