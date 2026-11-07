import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiCtx } from "../core/notify.ts";

/**
 * Skill discovery (PLAN-CONTEXT §D-C7).
 *
 * The tool snippets answer "when do I use this"; the procedural detail (check-writing
 * discipline, watch semantics, promote/abort, legion collection) is too long to keep in the
 * system prompt. It ships as an Agent Skill instead: one line in the prompt, full text read
 * only when the task matches.
 */

/** Structural view of the host hooks (same feature-detected style as the other modules). */
type HostHooks = {
  on?: (event: string, handler: (...args: unknown[]) => unknown) => unknown;
};

/** `<package root>/skills` — `src/context/resources.ts` sits two levels below it. */
export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

/**
 * Paths to contribute for `resources_discover`, or undefined when the shipped skill is absent
 * (a stripped package must degrade to "no skill", never to an error).
 */
export function skillPathsFor(dir: string = SKILLS_DIR): { skillPaths: string[] } | undefined {
  return existsSync(join(dir, "async-tasks", "SKILL.md")) ? { skillPaths: [dir] } : undefined;
}

/** Advertise the bundled skill directory to the host's resource loader. */
export function registerSkillDiscovery(pi: PiCtx, dir: string = SKILLS_DIR): void {
  // SAFETY: PiCtx hooks vary by runtime; a degraded host simply gets no skill.
  const hooks = pi as unknown as HostHooks;
  if (typeof hooks.on !== "function") return;
  hooks.on("resources_discover", () => skillPathsFor(dir));
}
