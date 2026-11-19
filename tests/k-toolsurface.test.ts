import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerTools, WAIT_TOOL, WAIT_UNAVAILABLE, waitToolExposed } from "../src/tools/index.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { withExposedWait } from "./helpers/index.ts";

/**
 * 0.5.0 D3 + D4 (CONTRACT §22 / REV-29), one place:
 *
 *  - the default tool surface is five tools; `async_wait` is opt-in (`PI_ASYNC_EXPOSE_WAIT=1`);
 *  - a stale `async_wait` registration degrades with a readable reason instead of throwing;
 *  - `mode=sync` left no residue in the source of the files that carried it;
 *  - `async_run` no longer declares the two sync-only knobs.
 */

type Tool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  parameters: { properties: Record<string, unknown>; enum?: unknown };
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
};

function host() {
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: Tool) => { tools.set(tool.name, tool); } };
  return { pi, tools };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-k-surface-"));
  const registry = new TaskRegistry({ dataDir: dir });
  return { registry, cleanup: async () => { await registry.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Run `fn` with PI_ASYNC_EXPOSE_WAIT pinned to `value` (undefined = unset), restoring afterwards. */
function withWaitEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.PI_ASYNC_EXPOSE_WAIT;
  if (value === undefined) delete process.env.PI_ASYNC_EXPOSE_WAIT;
  else process.env.PI_ASYNC_EXPOSE_WAIT = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_ASYNC_EXPOSE_WAIT;
    else process.env.PI_ASYNC_EXPOSE_WAIT = previous;
  }
}

test("the default tool surface is five tools; PI_ASYNC_EXPOSE_WAIT=1 adds async_wait as the sixth", async () => {
  const f = fixture();
  try {
    const defaults = withWaitEnv(undefined, () => {
      assert.equal(waitToolExposed(), false, "the switch is off unless the host sets it");
      const h = host();
      registerTools(h.pi as never, f.registry);
      return [...h.tools.keys()].sort();
    });
    assert.deepEqual(defaults, ["async_extend", "async_kill", "async_logs", "async_run", "async_status"]);
    assert.equal(defaults.includes(WAIT_TOOL), false, "async_wait is not registered by default");

    const exposed = withWaitEnv("1", () => {
      assert.equal(waitToolExposed(), true);
      const h = host();
      registerTools(h.pi as never, f.registry);
      return [...h.tools.keys()].sort();
    });
    assert.deepEqual(exposed, ["async_extend", "async_kill", "async_logs", "async_run", "async_status", "async_wait"]);
    assert.equal(exposed.includes(WAIT_TOOL), true, "the opt-in names the wait tool exactly once");
  } finally { await f.cleanup(); }
});

/**
 * D4's copy rule, applied to the surface itself: nothing the default registration shows the model —
 * a description, a prompt snippet, or a schema field description — may name a tool this session does
 * not have. (`promptGuidelines` is excluded on purpose: the base four are frozen CONTRACT §17 text and
 * the fifth exists precisely to say `async_wait` is unavailable.) This is the assertion that catches a
 * tool description advertising the retired default.
 */
test("nothing on the default tool surface advertises async_wait", async () => {
  const f = fixture();
  try {
    assert.equal(waitToolExposed(), false);
    const h = host();
    registerTools(h.pi as never, f.registry);
    for (const tool of h.tools.values()) {
      const visible = JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet, parameters: tool.parameters });
      assert.doesNotMatch(visible, /async_wait/, `${tool.name} must not point at a tool this session does not expose`);
    }
  } finally { await f.cleanup(); }
});

test("a stale async_wait registration resolves with a readable degraded payload instead of throwing", async () => {
  const f = fixture();
  try {
    // Register while exposed, then drop the switch: this is the "old session / old registration" case.
    const stale = withExposedWait(() => {
      const h = host();
      registerTools(h.pi as never, f.registry);
      const registered = h.tools.get(WAIT_TOOL);
      assert.ok(registered, "the exposed registration exists");
      return registered;
    });
    assert.equal(waitToolExposed(), false, "the switch is off again for the call below");

    const result = await stale.execute("call", { taskIds: [], timeoutMs: 5 }) as {
      content: Array<{ type: string; text: string }>;
      details: { payload: { taskId: unknown; available: boolean; error: string; enableWith: string; alternatives: string[] } };
      isError: boolean;
    };

    assert.equal(result.isError, true, "the degraded answer is an error result, not a silent success");
    assert.equal(result.details.payload.available, false);
    assert.equal(result.details.payload.taskId, null);
    assert.equal(result.details.payload.error, WAIT_UNAVAILABLE);
    assert.equal(result.details.payload.enableWith, "PI_ASYNC_EXPOSE_WAIT=1");
    assert.deepEqual(result.details.payload.alternatives, ["async_status", "async_logs"]);
    const text = result.content.map((block) => block.text).join("\n");
    assert.match(text, /not available in this configuration/);
    assert.match(text, /PI_ASYNC_EXPOSE_WAIT=1/);
    // The ToolResultMessage shape itself (content blocks + isError) is pinned in
    // `tests/a-tool-result-contract.test.ts`; asserting `typeof array === "object"` here would be
    // true for anything and prove nothing.
  } finally { await f.cleanup(); }
});

/**
 * D3 residue audit. `\bsync\b` (not /sync/) on purpose: "async" contains the letters, so an
 * unbounded pattern would flag every `async_run` mention.
 *
 * Two tiers, because the files are not alike:
 *  - the four files that carried the mode enum/API lose the **API names** as well;
 *  - `context/nudges.ts` only ever carried the user-visible `mode=sync with timeoutMs` copy, so it is
 *    audited for the mode word alone (the behaviour is pinned in `e-nudges`). `settle-guard.ts` is not
 *    in either list: its 2026-10-21 crash note legitimately names `Timeout._onTimeout`, which would
 *    trip the API-name pattern for an unrelated reason.
 */
test("no residual mode=sync plumbing in task.ts / registry.ts / tools/index.ts / rail.ts / nudges.ts", () => {
  const apiFiles = ["../src/core/task.ts", "../src/core/registry.ts", "../src/tools/index.ts", "../src/tui/rail.ts"];
  for (const file of apiFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /runSync|SyncResult|onTimeout|PI_ASYNC_MAX_SYNC_TIMEOUT_MS/, `${file} must not carry the retired sync API`);
    assert.doesNotMatch(source, /\bsync\b/, `${file} must not carry the retired sync mode (word-bounded)`);
    // Word-bounded on both sides: `mode` is followed by `async_run` on plenty of healthy lines.
    assert.doesNotMatch(source, /\bmode\b.*\bsync\b/, `${file} must not reference a sync mode`);
  }
  const copy = readFileSync(new URL("../src/context/nudges.ts", import.meta.url), "utf8");
  assert.doesNotMatch(copy, /\bsync\b/, "nudges.ts must not sell a sync mode (word-bounded)");
  assert.doesNotMatch(copy, /\bmode\b.*\bsync\b/, "nudges.ts must not reference a sync mode");
});

test("async_run declares only background/delayed and no longer exposes the sync-only knobs", async () => {
  const f = fixture();
  try {
    const h = host();
    registerTools(h.pi as never, f.registry);
    const run = h.tools.get("async_run");
    assert.ok(run, "async_run is always registered");
    const properties = run.parameters.properties as Record<string, { enum?: unknown }>;
    assert.deepEqual(properties.mode?.enum, ["background", "delayed"], "the mode enum lost its third value");
    assert.equal(properties.timeoutMs, undefined, "timeoutMs left the schema (additionalProperties:false rejects it at the host)");
    assert.equal(properties.onTimeout, undefined, "onTimeout left the schema");
    // The execute whitelist still names a retired mode instead of silently treating it as background.
    await assert.rejects(
      run.execute("call", { command: "true", mode: "sync" }),
      /Unsupported async_run mode: sync/,
    );
  } finally { await f.cleanup(); }
});
