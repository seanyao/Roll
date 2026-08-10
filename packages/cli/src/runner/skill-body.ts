/**
 * @responsibility Resolves and reads a skill's SKILL.md body with frontmatter stripped.
 */
/**
 * Resolve + read a skill's SKILL.md body, frontmatter stripped — the prompt the
 * loop / dream agent runs. Shared by `loop run-once` (roll-loop) and `dream
 * run-once` (roll-.dream) so the resolution order has a single source of truth.
 *
 * FIX-204A lineage: the v2-era path (`.roll/skills/<name>/SKILL.md`) became a
 * fossil when skills moved to the `skills/` submodule — every live cycle got an
 * EMPTY body and the agent drove blind. Resolution order, highest to lowest:
 *   1. Explicit env override (ROLL_LOOP_SKILL / ROLL_DREAM_SKILL)
 *   2. `.roll/skills/<name>/SKILL.md` — project vendored private copy
 *   3. `skills/<name>/SKILL.md` — git submodule (shipped truth)
 *   4. `~/.roll/skills/<name>/SKILL.md` — roll update/setup global sync target
 * Returns null when nothing resolves to a non-empty body — the caller MUST fail
 * loud, never spawn a blind agent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillBodyOptions {
  /** The skill directory name, e.g. "roll-loop" / "roll-.dream". */
  skillName: string;
  /** Explicit override path (an env var the caller already read); highest precedence. */
  envOverride?: string | undefined;
}

/** Resolve the SKILL.md body for `skillName`; null when none resolves non-empty. */
export function readSkillBody(projectPath: string, opts: SkillBodyOptions): string | null {
  const candidates = [
    opts.envOverride ?? "",
    join(projectPath, ".roll", "skills", opts.skillName, "SKILL.md"),
    join(projectPath, "skills", opts.skillName, "SKILL.md"),
    join(homedir(), ".roll", "skills", opts.skillName, "SKILL.md"),
  ].filter((p) => p !== "");
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let raw = "";
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    // Strip YAML frontmatter — the v2 oracle hands the agent the body only
    // (`_agent_skill_cmd` splices the "stripped SKILL.md body").
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (body !== "") return body;
  }
  return null;
}
