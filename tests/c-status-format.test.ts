import assert from "node:assert/strict";
import test from "node:test";
import { disposeStatus, formatStatus, initStatus } from "../src/tui/status.ts";
import { bindTuiHost, resetTuiHostForTests } from "../src/tui/host.ts";

test("footer displays running plus pending count and completed count", () => {
  assert.equal(formatStatus({ running: 3, pending: 2 }, 7), " 5 running · 7 done ");
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
