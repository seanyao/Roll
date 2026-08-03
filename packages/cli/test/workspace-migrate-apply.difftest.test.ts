import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planHistoricalWorkspaceMigration } from "@roll/core";
import { parseHistoricalMigrationFacts, type HistoricalMigrationFacts } from "@roll/spec";
import { workspaceMigrateCommand, type WorkspaceMigrateDeps } from "../src/commands/workspace-migrate.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function facts(): HistoricalMigrationFacts {
  const parsed = parseHistoricalMigrationFacts({
    schema: "roll.workspace-migration-facts/v1",
    sourceRoot: "/fixture/repo",
    repoId: "repo-ab12cd34ef56",
    requestedWorkspaceId: "ws-demo",
    git: {
      head: "1".repeat(40),
      state: "clean",
      dirtyPaths: [],
      operation: "none",
      remote: {
        kind: "verified",
        normalizedRemote: "ssh://git.example.test/team/product",
        defaultBranch: "main",
        defaultTip: "1".repeat(40),
        headReachable: true,
        defaultTipPresentLocally: true,
      },
    },
    linkedWorktrees: [],
    submodules: [],
    runtime: { activeCycleIds: [], activeStoryLeases: [] },
    rollOwnership: { kind: "ordinary" },
    rollInventory: [{ kind: "file", path: "backlog.md", digest: "b".repeat(64), bytes: 10, sourceClass: "backlog" }],
    cache: { status: "absent", repoId: "repo-ab12cd34ef56", cachePath: "repos/repo-ab12cd34ef56.git" },
    registry: { status: "available", workspaceId: "ws-demo" },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

function planFile(): { readonly path: string; readonly plan: ReturnType<typeof planHistoricalWorkspaceMigration> } {
  const root = mkdtempSync(join(tmpdir(), "roll-migrate-cli-"));
  roots.push(root);
  const plan = planHistoricalWorkspaceMigration(facts());
  const path = join(root, "plan.json");
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { path, plan };
}

async function run(args: string[], deps: Partial<WorkspaceMigrateDeps>, language: "en" | "zh" = "en") {
  const saved = { ROLL_HOME: process.env["ROLL_HOME"], ROLL_LANG: process.env["ROLL_LANG"] };
  process.env["ROLL_HOME"] = "/fixture/roll-home";
  process.env["ROLL_LANG"] = language;
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error test capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  try {
    const status = await workspaceMigrateCommand(args, {
      collectFacts: async () => facts(),
      plan: planHistoricalWorkspaceMigration,
      apply: deps.apply ?? (async () => { throw new Error("unexpected apply"); }),
      rollback: deps.rollback ?? (() => { throw new Error("unexpected rollback"); }),
    });
    return { status, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    if (saved.ROLL_HOME === undefined) delete process.env["ROLL_HOME"]; else process.env["ROLL_HOME"] = saved.ROLL_HOME;
    if (saved.ROLL_LANG === undefined) delete process.env["ROLL_LANG"]; else process.env["ROLL_LANG"] = saved.ROLL_LANG;
  }
}

describe("US-WS-019a migration apply CLI contract", () => {
  it("freezes English and Chinese progress plus final topology", async () => {
    const saved = planFile();
    const apply = vi.fn(async (_input, deps) => {
      for (const phase of ["prepared", "cache_ready", "content_ready", "workspace_ready", "registered", "activated", "cleanup_complete"] as const) deps?.afterPhase?.(phase);
      return {
        outcome: "migrated" as const,
        workspaceId: "ws-demo",
        workspaceRoot: "/fixture/roll-home/workspaces/ws-demo",
        cachePath: "/fixture/roll-home/repos/repo-ab12cd34ef56.git",
        planId: saved.plan.planId,
      };
    });
    const args = ["--from", "/fixture/repo", "--workspace", "ws-demo", "--plan", saved.path];
    const en = await run(args, { apply }, "en");
    const zh = await run(args, { apply }, "zh");

    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en, zh }).toMatchSnapshot();
  });

  it("emits one stable JSON result without progress chatter", async () => {
    const saved = planFile();
    const result = {
      outcome: "reused" as const,
      workspaceId: "ws-demo",
      workspaceRoot: "/fixture/roll-home/workspaces/ws-demo",
      cachePath: "/fixture/roll-home/repos/repo-ab12cd34ef56.git",
      planId: saved.plan.planId,
    };
    const output = await run(["--from", "/fixture/repo", "--workspace", "ws-demo", "--plan", saved.path, "--json"], {
      apply: async () => result,
    });

    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ schema: "roll.workspace-migration-result/v1", operation: "apply", ...result });
    expect(output.stderr).toBe("");
    expect(output).toMatchSnapshot();
  });

  it("renders explicit rollback and independent metadata handoff", async () => {
    const saved = planFile();
    const rolledBack = await run(["--from", "/fixture/repo", "--workspace", "ws-demo", "--plan", saved.path, "--rollback"], {
      rollback: () => ({ outcome: "rolled_back", workspaceId: "ws-demo" }),
    });
    const handoff = await run(["--from", "/fixture/repo", "--workspace", "ws-demo", "--plan", saved.path], {
      apply: async () => ({
        outcome: "migrated",
        workspaceId: "ws-demo",
        workspaceRoot: "/fixture/roll-home/workspaces/ws-demo",
        cachePath: "/fixture/roll-home/repos/repo-ab12cd34ef56.git",
        planId: saved.plan.planId,
        manualHandoff: {
          required: true,
          gitMutationPerformed: false,
          instructions: ["Review roll-meta manually.", "Commit and push only with owner approval."],
        },
      }),
    }, "zh");

    expect(rolledBack.status).toBe(0);
    expect(handoff.stdout).toContain("未对独立 roll-meta 执行 Git 修改");
    expect({ rolledBack, handoff }).toMatchSnapshot();
  });

  it("rejects malformed plans and Workspace identity mismatches before apply", async () => {
    const saved = planFile();
    writeFileSync(saved.path, "{}\n", "utf8");
    const apply = vi.fn();
    const malformed = await run(["--from", "/fixture/repo", "--workspace", "ws-demo", "--plan", saved.path], { apply });
    const valid = planFile();
    const mismatch = await run(["--from", "/fixture/repo", "--workspace", "ws-other", "--plan", valid.path], { apply });

    expect([malformed.status, mismatch.status]).toEqual([1, 1]);
    expect(apply).not.toHaveBeenCalled();
    expect({ malformed, mismatch }).toMatchSnapshot();
  });
});
