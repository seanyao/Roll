import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vitest may retain the workspace root as process.cwd(); derive the active
// product checkout from this test file so the contract follows its gitlink.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const activeContracts = [
  "skills/roll-build/references/full-contract.md",
  "skills/roll-fix/references/full-contract.md",
  "skills/roll-delta-team/SKILL.md",
];

describe("US-LOOP-127 — active Skill dispatch contracts", () => {
  it("requires the parent-owned allocate, scoped integrate, paired release, and safe stop workflow", () => {
    const text = activeContracts.map((path) => readFileSync(resolve(repoRoot, path), "utf8")).join("\n");

    expect(text).not.toMatch(/git worktree add (?:\.worktrees|\.\.\/wt-)/);
    expect(text).toContain("allocator-backed");
    expect(text).toContain("skill_dispatch");
    expect(text).toContain("Story reservation");
    expect(text).toContain("roll worktree dispatch allocate");
    expect(text).toContain("roll worktree dispatch integrate");
    expect(text).toContain("roll worktree dispatch release");
    expect(text).toContain("roll worktree dispatch stop");
    expect(text).toMatch(/incomplete declared\s+file scope/);
    expect(text).toContain("new run ID");
    expect(text).toMatch(/never raw `git\s+cherry-pick`|Raw `git\s+cherry-pick`.*forbidden/);
  });
});
