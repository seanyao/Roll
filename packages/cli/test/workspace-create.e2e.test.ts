import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const roots: string[] = [];
interface CreateStep { readonly kind: string; readonly target: string; readonly action: string }
interface CreateResult { readonly mode: string; readonly outcome: string; readonly workspaceId: string; readonly root: string; readonly steps: readonly CreateStep[] }

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-006 Workspace create E2E", () => {
  it("serves the exact deliverable help command through the real CLI entrypoint", () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-help-e2e-"));
    roots.push(home);
    const runHelp = (language: "en" | "zh") => spawnSync(
      process.execPath,
      [rollBin, "workspace", "create", "--help"],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, ROLL_HOME: join(home, ".roll"), ROLL_LANG: language, NO_COLOR: "1" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const en = runHelp("en");
    expect(en.status, en.stderr).toBe(0);
    expect(en.stderr).toBe("");
    expect(en.stdout).toBe("Usage: roll workspace create <id> --config <file> [--authorization <file>] [--check] [--json]\n");

    const zh = runHelp("zh");
    expect(zh.status, zh.stderr).toBe(0);
    expect(zh.stderr).toBe("");
    expect(zh.stdout).toBe("用法：roll workspace create <ID> --config <文件> [--authorization <文件>] [--check] [--json]\n");
  });

  it("previews, applies, and reuses one complete Workspace through the built CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-e2e-"));
    roots.push(home);
    const source = join(home, "source");
    const remote = join(home, "remote.git");
    const workspace = join(home, "workspace");
    const config = join(home, "create.yaml");
    mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    git(source, ["config", "user.email", "roll@example.test"]);
    git(source, ["config", "user.name", "Roll Test"]);
    writeFileSync(join(source, "product.txt"), "fixture\n", "utf8");
    git(source, ["add", "product.txt"]);
    git(source, ["commit", "-q", "-m", "fixture"]);
    git(home, ["clone", "-q", "--bare", source, remote]);
    writeFileSync(config, `schema: roll.workspace-create/v1\nid: ws-e2e\nroot: ${workspace}\nrepositories:\n  - alias: product\n    source: file://${remote}\n    integration_branch: main\n`, "utf8");
    const env = { ...process.env, HOME: home, ROLL_HOME: join(home, ".roll"), ROLL_LANG: "en", NO_COLOR: "1" };
    const run = (extra: readonly string[]) => spawnSync(process.execPath, [rollBin, "workspace", "create", "ws-e2e", "--config", config, "--json", ...extra], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const check = run(["--check"]);
    expect(check.status, check.stderr).toBe(0);
    const checkResult = JSON.parse(check.stdout) as CreateResult;
    expect(checkResult.outcome).toBe("created");
    expect(existsSync(workspace)).toBe(false);

    const first = run([]);
    expect(first.status, first.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout) as CreateResult;
    expect(firstResult.outcome).toBe("created");
    expect(existsSync(join(workspace, "workspace.yaml"))).toBe(true);
    expect(existsSync(join(workspace, ".git"))).toBe(false);

    const second = run([]);
    expect(second.status, second.stderr).toBe(0);
    const secondResult = JSON.parse(second.stdout) as CreateResult;
    expect(secondResult.outcome).toBe("reused");
    expect(readdirSync(join(home, ".roll", "repos")).filter((name) => name.endsWith(".git"))).toHaveLength(1);

    const signatures = (result: CreateResult) => result.steps.map((step) => {
      const target = step.kind === "cache" ? "<REPO_ID>" : step.kind === "registry" ? step.target : relative(home, step.target);
      return `${step.action}:${step.kind}:${target}`;
    });
    const createdSteps = [
      "created:journal:.roll/workspace-create/ws-e2e.pending.json",
      "created:directory:workspace",
      ...["workspace.yaml", "charter.md", "agents.yaml", "policy.yaml"].map((name) => `created:file:workspace/${name}`),
      "created:directory:workspace/requirements",
      "created:directory:workspace/design",
      "created:directory:workspace/backlog",
      "created:file:workspace/backlog/index.md",
      "created:directory:workspace/issues",
      "created:directory:workspace/runtime",
      "created:directory:workspace/runtime/locks",
      "created:directory:workspace/runtime/heartbeats",
      "created:directory:workspace/runtime/alerts",
      "created:cache:<REPO_ID>",
      "created:registry:ws-e2e",
    ];
    expect(signatures(checkResult)).toEqual(createdSteps);
    expect(signatures(firstResult)).toEqual(createdSteps);
    expect(signatures(secondResult)).toEqual(createdSteps.map((row, index) => index === 0 ? row : row.replace(/^created:/u, "reused:")));
    const transcript = [checkResult, firstResult, secondResult].map((result) => ({
      mode: result.mode,
      outcome: result.outcome,
      workspaceId: result.workspaceId,
      root: "<HOME>/workspace",
      steps: signatures(result),
    }));
    process.stdout.write(`US-WS-006 three-run transcript\n${JSON.stringify(transcript, null, 2)}\n`);
  });
});
