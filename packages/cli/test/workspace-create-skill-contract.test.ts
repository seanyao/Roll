import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const skillPath = join(repoRoot, "skills", "roll-ws-create", "SKILL.md");
const agentPath = join(repoRoot, "skills", "roll-ws-create", "agents", "openai.yaml");
const routeCasesPath = join(repoRoot, "skills", "route-cases", "skills.json");

function shellBlocks(text: string): readonly string[] {
  return [...text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/gu)].map((match) => match[1]?.trim() ?? "");
}

describe("US-WS-023 roll-ws-create static mutation contract", () => {
  it("delegates preview and apply to the CLI without executable filesystem or Git fallbacks", () => {
    const skill = readFileSync(skillPath, "utf8");
    const commands = shellBlocks(skill);

    expect(commands).toContain("roll workspace create ws-demo --config /absolute/path/workspace-create.yaml --check --json");
    expect(commands).toContain("roll workspace create ws-demo --config /absolute/path/workspace-create.yaml --authorization /absolute/path/workspace-create-authorization.json --json");
    expect(commands).not.toContain("roll workspace create ws-demo --config /absolute/path/workspace-create.yaml --json");
    expect(commands.join("\n")).not.toMatch(/(?:^|\n)\s*(?:mkdir|touch|cp|git\s+(?:clone|init|worktree))\b/u);

    expect(skill).toContain("`workspaceId` + `configSha256` + `planSha256`");
    expect(skill).toContain('"schema": "roll.workspace-create-apply-authorization/v1"');
    expect(skill).toContain('"source": "owner_after_preview"');
    expect(skill).toMatch(/action `create_new` is\s+preview only: it never authorizes apply/u);

    expect(skill).toMatch(/Never create Workspace directories or files with `mkdir`, `touch`, `cp`,/u);
    expect(skill).toMatch(/Never run `git clone`, `git init`, `git worktree`, or edit cache paths/u);
    expect(skill).toMatch(/Never edit `\$ROLL_HOME\/workspaces\.json`, lifecycle events, cache identity\s+files, locks, or repair journals directly\./u);
    expect(skill).toMatch(/Never fall back to hand-written layout creation when the CLI rejects or fails\./u);
  });

  it("keeps lifecycle, Issue worktrees and historical migration outside the create skill", () => {
    const skill = readFileSync(skillPath, "utf8");
    const commands = shellBlocks(skill);

    expect(skill).toContain("Creation establishes Workspace authorities and repository bindings; it does not activate the Workspace.");
    expect(skill).toContain("Use `roll workspace issue init` after creation for Story repository worktrees.");
    expect(skill).toContain("Use `roll workspace migrate` for a historical repository-local Roll project.");
    expect(commands.join("\n")).not.toMatch(/roll workspace (?:activate|issue|migrate)/u);
  });

  it("routes multi-repository create to roll-ws-create and rejects neighboring responsibilities", () => {
    const routes = JSON.parse(readFileSync(routeCasesPath, "utf8")) as {
      readonly skills: Record<string, { readonly positive: readonly string[]; readonly negative: readonly string[] }>;
    };
    const cases = routes.skills["roll-ws-create"];

    expect(existsSync(join(repoRoot, "skills", "roll-ws-init"))).toBe(false);
    expect(routes.skills).not.toHaveProperty("roll-ws-init");
    expect(cases?.positive).toContain("preview and create a multi-repository Roll Workspace from versioned bindings");
    expect(cases?.negative).toContain("migrate a historical repository-local Roll project into Workspace scope");
    expect(cases?.negative).toContain("activate pause or archive an already registered Workspace");
  });

  it("publishes only the create skill name in the default prompt", () => {
    const agent = readFileSync(agentPath, "utf8");
    expect(agent).toContain("$roll-ws-create");
    expect(agent).not.toContain("$roll-ws-init");
    expect(agent).not.toContain("roll workspace init");
  });
});
