import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const rollBin = fileURLToPath(new URL("../bin/roll.js", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("US-WS-019a critical migration apply E2E", () => {
  it("turns a real repository-local project into one active standard Workspace", () => {
    const home = mkdtempSync(join(tmpdir(), "roll-migrate-critical-"));
    roots.push(home);
    const source = join(home, "product");
    const remote = join(home, "product.git");
    const rollHome = join(home, "machine");
    const planPath = join(home, "plan.json");
    mkdirSync(join(source, ".roll", "features", "US-1"), { recursive: true });
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Roll Test");
    git(source, "config", "user.email", "roll@example.test");
    writeFileSync(join(source, "product.txt"), "product\n", "utf8");
    writeFileSync(join(source, ".roll", "backlog.md"), "# Backlog\n", "utf8");
    writeFileSync(join(source, ".roll", "features", "US-1", "spec.md"), "# US-1\n", "utf8");
    writeFileSync(join(source, ".git", "info", "exclude"), ".roll/\n", "utf8");
    git(source, "add", "product.txt");
    git(source, "commit", "-m", "fixture");
    git(home, "init", "--bare", "product.git");
    git(source, "remote", "add", "origin", `file://${remote}`);
    git(source, "push", "-u", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const env = { ...process.env, ROLL_HOME: rollHome, ROLL_LANG: "en", NO_COLOR: "1" };

    const planText = execFileSync(process.execPath, [rollBin, "workspace", "migrate", "--from", source, "--workspace", "ws-demo", "--check", "--json"], {
      cwd: source,
      env,
      encoding: "utf8",
    });
    writeFileSync(planPath, planText, "utf8");
    const plan = JSON.parse(planText) as { readonly planId: string; readonly repository: { readonly repoId: string } };

    const applied = execFileSync(process.execPath, [rollBin, "workspace", "migrate", "--from", source, "--workspace", "ws-demo", "--plan", planPath], {
      cwd: source,
      env,
      encoding: "utf8",
    });
    const workspace = join(rollHome, "workspaces", "ws-demo");
    expect(applied).toContain("Historical migration apply: migrated");
    expect(readFileSync(join(workspace, "backlog", "index.md"), "utf8")).toBe("# Backlog\n");
    expect(readFileSync(join(workspace, "backlog", "legacy", "US-1", "spec.md"), "utf8")).toBe("# US-1\n");
    expect(existsSync(join(workspace, "primary"))).toBe(false);
    expect(existsSync(join(rollHome, "repos", `${plan.repository.repoId}.git`))).toBe(true);
    expect(readFileSync(join(source, ".roll", "RELOCATED.json"), "utf8")).toContain(plan.planId);

    const listed = JSON.parse(execFileSync(process.execPath, [rollBin, "workspace", "list", "--json"], { env, encoding: "utf8" })) as {
      readonly workspaces: readonly { readonly workspaceId: string; readonly lifecycle: string }[];
    };
    expect(listed.workspaces).toContainEqual(expect.objectContaining({ workspaceId: "ws-demo", lifecycle: "active" }));

    const reused = execFileSync(process.execPath, [rollBin, "workspace", "migrate", "--from", source, "--workspace", "ws-demo", "--plan", planPath], {
      cwd: source,
      env,
      encoding: "utf8",
    });
    expect(reused).toContain("Historical migration apply: reused");

    const legacy = spawnSync(process.execPath, [rollBin, "backlog"], { cwd: source, env, encoding: "utf8" });
    expect(legacy.status).not.toBe(0);
  });
});
