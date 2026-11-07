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
