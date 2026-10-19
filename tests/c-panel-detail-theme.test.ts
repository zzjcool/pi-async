import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../src/core/output.ts";
import { displayWidth } from "../src/tui/width.ts";
import {
  paint,
  formatMetadataLines,
  detailTitleLines,
  detailStatusLines,
  commandSection,
  metadataSection,
  outputSection,
  openPanel,
} from "../src/tui/panel.ts";
import { makeSnapshot } from "./helpers/index.ts";

test("paint falls back when theme.fg is missing, undefined, or throws (#75)", () => {
  assert.equal(paint(undefined, "accent", "hi"), "hi");
  assert.equal(paint({}, "accent", "hi"), "hi");
  assert.equal(paint({ fg: () => undefined as unknown as string }, "accent", "hi"), "hi");
  assert.equal(paint({ fg: () => { throw new Error("boom"); } }, "accent", "hi"), "hi");
  assert.equal(paint({ fg: (token, text) => `<${token}>${text}</>` }, "dim", "x"), "<dim>x</>");
});

test("formatMetadataLines prefers outputFile and truncates to budget", () => {
  const rows = formatMetadataLines({
    zed: 1,
    outputFile: "/tmp/very-long-path/" + "a".repeat(80),
    alpha: "yes",
  }, 40);
  assert.equal(rows[0]!.startsWith("outputFile:"), true);
  assert.ok(rows.every((row) => displayWidth(row) <= 40));
  assert.deepEqual(rows.map((row) => row.split(":")[0]), ["outputFile", "alpha", "zed"]);
});

test("detail sections paint tokens and insert hierarchy (#75)", () => {
  const theme = { fg: (token: string, text: string) => `[${token}]${text}` };
  const task = makeSnapshot({
    name: "build",
    taskId: "t-1",
    status: "failed",
    command: "echo one\necho two",
    metadata: { outputFile: "/tmp/out.log", extra: true },
    finishedAt: 1_000_010,
    startedAt: 1_000_000,
  });
  assert.deepEqual(detailTitleLines(task, theme), ["[accent]build [dim][t-1]"]);
  assert.match(detailStatusLines(task, theme, 1_000_010)[0]!, /\[error\]failed/);
  const cmd = commandSection(task.command, theme, 80);
  assert.equal(cmd[0], "[dim]command:");
  assert.ok(cmd.some((line) => line.includes("[text]") && line.includes("echo one")));
  const meta = metadataSection(task.metadata as Record<string, unknown>, theme, 80);
  assert.equal(meta[0], "[dim]metadata:");
  assert.ok(meta.some((line) => line.includes("outputFile:")));
  assert.equal(meta.some((line) => line.includes("{") && line.includes("outputFile")), false);
  const out = outputSection(["line-a", "line-b"], true, theme, 80);
  assert.equal(out[0], "[dim]output (tail truncated):");
  assert.ok(out[1]!.startsWith("[dim]"));
});

test("colored detail keeps frame borders aligned on narrow terminals (#75)", () => {
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  const task = makeSnapshot({
    taskId: "color-task",
    name: "job",
    command: "printf 'x\\n'",
    metadata: { outputFile: "/tmp/color-task.log", note: "n".repeat(120) },
  });
  const ui = {
    custom: (f: typeof factory) => { factory = f; return Promise.resolve(); },
  };
  openPanel({ mode: "tui", ui } as never, {
    list: () => [task],
    logs: () => ({ text: "out\n", truncated: false, fullPath: "/tmp/color-task.log" }),
  } as never, "color-task");
  const theme = {
    fg: (token: string, text: string) => `\u001b[38;5;${token === "error" ? 1 : 4}m${text}\u001b[0m`,
  };
  const component = factory!({ requestRender() {} }, theme, {}, () => undefined);
  for (const w of [60, 80, 100]) {
    const lines = component.render(w) as string[];
    for (const line of lines) {
      assert.equal(displayWidth(stripAnsi(line)), w, `w=${w} visible=${displayWidth(stripAnsi(line))} raw=${line.length}`);
    }
    assert.ok(lines.some((line) => stripAnsi(line).includes("command:")));
    assert.ok(lines.some((line) => stripAnsi(line).includes("metadata:")));
    assert.ok(lines.some((line) => stripAnsi(line).includes("output")));
    assert.ok(lines.some((line) => stripAnsi(line).includes("─")));
  }
});

test("detail still renders with empty theme mock (#75)", () => {
  let factory: ((tui: unknown, theme: unknown, keybindings: unknown, done: (value?: unknown) => void) => any) | undefined;
  const task = makeSnapshot({ taskId: "plain", metadata: { outputFile: "/tmp/plain.log" } });
  openPanel({ mode: "tui", ui: { custom: (f: typeof factory) => { factory = f; return Promise.resolve(); } } } as never, {
    list: () => [task],
    logs: () => ({ text: "ok\n", truncated: false, fullPath: "/tmp/plain.log" }),
  } as never, "plain");
  const component = factory!({ requestRender() {} }, {}, {}, () => undefined);
  const joined = (component.render(80) as string[]).map(stripAnsi).join("\n");
  assert.ok(joined.includes("command:"));
  assert.ok(joined.includes("metadata:"));
  assert.ok(!joined.includes("undefined"));
});
