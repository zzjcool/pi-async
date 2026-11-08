import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerSkillDiscovery, SKILLS_DIR, skillPathsFor } from "../src/context/resources.ts";

/**
 * PLAN-CONTEXT §D-C7: procedural detail lives in a skill, not in the always-on system prompt.
 * These tests pin the routing contract (frontmatter) and the facts the skill must not lose.
 */

const SKILL_FILE = join(SKILLS_DIR, "async-tasks", "SKILL.md");

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = pair[2]!.trim();
  }
  return fields;
}

test("the bundled skill has a valid name and a routing description", () => {
  const text = readFileSync(SKILL_FILE, "utf8");
  const fields = frontmatter(text);
  assert.equal(fields.name, "async-tasks");
  assert.ok(fields.description && fields.description.length > 0, "description is what the host shows the model");
  assert.match(fields.description!, /^Run long shell commands/);
  assert.match(fields.description!, /Use when/, "the description must say WHEN it applies, not only what it does");
  assert.match(fields.description!, /async tasks/);
});

test("the skill keeps the facts the tool descriptions no longer carry", () => {
  const text = readFileSync(SKILL_FILE, "utf8");
  for (const needed of ["64K characters", "OR-ed", "|| true", "jq -e", "taskTimeoutMs", "blind_checks", "promote", "async_wait"]) {
    assert.ok(text.includes(needed), `SKILL.md must explain ${needed}`);
  }
  assert.doesNotMatch(text, /\bTODO\b/, "no unfinished placeholders in a shipped playbook");
});

/**
 * D-35 (0.4.1, revised by R2): the two new SKILL.md sections are frozen prose, so the whole block is
 * pinned line by line. A partial anchor list let the other 20 lines drift while the test stayed green
 * (R2-5); anything that changes here is a contract change, not a refactor.
 */
const D35_BLOCK: readonly string[] = [
  "## When not to use async",
  "",
  "- Anything that finishes in seconds — a read, a grep, `ls`, `git status` — belongs in `bash`: one call,",
  "  output on screen. `async_run` costs a receipt plus an `async_logs` round-trip for the same text.",
  "- The next step needs what the command prints and it will finish within a minute — `bash` returns it",
  "  inline; `async_run` then `async_wait` is strictly slower.",
  "- Nothing else to do while it runs and it is short. Async pays only when the wait overlaps real work,",
  "  or when the command outlives the turn.",
  "- Never as an escape hatch for a command that keeps failing: a detached task hides its exit code",
  "  behind a receipt.",
  "",
  "## Plan the batch first",
  "",
  "Before the first edit, scan the request for commands that are (a) likely to outlive ~60s and",
  "(b) independent of each other: build, test suite, lint, install, `docker pull`, a watcher.",
  "Start them **together in one message** (several `async_run` calls in a single tool batch), then do the",
  "file work while they run, and collect the whole set with one `async_wait` (or let the completion",
  "notifications wake you; a legion child must always collect before reporting a verdict).",
  "",
  "- Two independent five-minute builds started together take five minutes, not ten.",
  "- Do not serialize: start the second build/test while the first still runs when nothing depends on it.",
  "- Do not pre-launch commands you may never need — a task you never collect still costs a notification and a rail entry.",
  "",
  "`mode=sync` also registers a real task: it shows up in the rail and counts as running until it ends.",
  "Use it only for a command you must finish before the next step **and** that may exceed the bash window.",
];

/** The D-35 region of SKILL.md, trimmed of the blank separator line before `## Collect, do not poll`. */
function d35Region(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(D35_BLOCK[0]!);
  const end = lines.indexOf("## Collect, do not poll");
  assert.ok(start >= 0, `SKILL.md must carry the "${D35_BLOCK[0]}" section`);
  assert.ok(end > start, `"${D35_BLOCK[0]}" must sit before "## Collect, do not poll"`);
  const region = lines.slice(start, end);
  while (region.length > 0 && region[region.length - 1] === "") region.pop();
  return region;
}

test("the skill says when NOT to use async and plans the batch first, frozen line by line (0.4.1 D-35 / R2-5)", () => {
  const text = readFileSync(SKILL_FILE, "utf8");
  const region = d35Region(text);

  // Whole-block comparison: every one of the 25 frozen lines is pinned, blanks included.
  assert.equal(region.length, D35_BLOCK.length, "the D-35 block must keep its 25 frozen lines");
  assert.deepEqual(region, D35_BLOCK, "the D-35 block must equal the contract verbatim, line for line");

  // Placement: after `## Choose the mode`, before `## Collect, do not poll`.
  const lines = text.split("\n");
  assert.ok(lines.indexOf("## Choose the mode") >= 0 && lines.indexOf("## Choose the mode") < lines.indexOf(D35_BLOCK[0]!));
  assert.ok(lines.indexOf("## Plan the batch first") > lines.indexOf(D35_BLOCK[0]!), "the negative guidance comes before the batch planning");

  // The always-on guideline (D-34) points at this phrase, so the skill must still say it.
  assert.ok(region.some((line) => line.includes("one message")), "the batch-planning section must say 'one message' (D-34 anchor)");
});

test("skillPathsFor advertises the shipped directory and degrades when it is missing", () => {
  assert.deepEqual(skillPathsFor(), { skillPaths: [SKILLS_DIR] });
  const empty = mkdtempSync(join(tmpdir(), "pi-async-skill-empty-"));
  try {
    assert.equal(skillPathsFor(empty), undefined, "a stripped package must not advertise a missing skill");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("registerSkillDiscovery answers resources_discover and tolerates a degraded host", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); return () => handlers.delete(event); } };
  registerSkillDiscovery(pi as never);
  const handler = handlers.get("resources_discover");
  assert.ok(handler, "the extension must answer resources_discover");
  assert.deepEqual(handler!(), { skillPaths: [SKILLS_DIR] });

  assert.doesNotThrow(() => registerSkillDiscovery({} as never), "a host without on() gets no skill, not a crash");
});

test("package.json ships the skills directory", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files?: string[] };
  assert.ok(manifest.files?.includes("skills/"), "skills/ must be published next to extensions/ and src/");
});
