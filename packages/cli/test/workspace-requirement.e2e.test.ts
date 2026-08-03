import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const roots: string[] = [];

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-007 Workspace Requirement E2E", () => {
  it("serves the deliverable help and captures one Jira-shaped fixture through the built CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-requirement-e2e-"));
    roots.push(home);
    const workspace = join(home, "workspace");
    const body = join(home, "SOT-15499.md");
    const contextRoot = join(home, "context");
    mkdirSync(workspace);
    write(join(workspace, "workspace.yaml"), `${JSON.stringify({
      schema: "roll.workspace/v1",
      workspaceId: "ws-e2e",
      displayName: "Requirement E2E",
      requirements: [{ provider: "jira", ref: "SOT-15499" }],
      repositories: [{
        schema: "roll.repository-binding/v1",
        repoId: "repo-ff7a87ddbb2b",
        alias: "product",
        remote: "https://example.test/owner/product",
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    }, null, 2)}\n`);
    write(join(workspace, "backlog", "epic", "US-WS-007", "spec.md"), "# US-WS-007\n");
    write(body, "# SOT-15499\n\nCapture this local Jira-shaped requirement.\n");
    write(join(contextRoot, "acceptance.md"), "No provider network is required.\n");
    const env = { ...process.env, HOME: home, ROLL_HOME: join(home, ".roll"), ROLL_LANG: "en", NO_COLOR: "1" };
    const run = (args: readonly string[], language = "en") => spawnSync(process.execPath, [rollBin, ...args], {
      cwd: repoRoot,
      env: { ...env, ROLL_LANG: language },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const helpEn = run(["workspace", "requirement", "--help"]);
    expect(helpEn).toMatchObject({ status: 0, stderr: "" });
    expect(helpEn.stdout).toContain("Usage: roll workspace requirement add");
    const helpZh = run(["workspace", "requirement", "--help"], "zh");
    expect(helpZh).toMatchObject({ status: 0, stderr: "" });
    expect(helpZh.stdout).toContain("用法：roll workspace requirement add");

    expect(run(["workspace", "register", "ws-e2e", workspace]).status).toBe(0);
    expect(run(["workspace", "activate", "ws-e2e"]).status).toBe(0);
    const args = [
      "workspace", "requirement", "add",
      "--workspace", "ws-e2e",
      "--provider", "jira",
      "--ref", "SOT-15499",
      "--revision", "42",
      "--body-file", body,
      "--context-root", contextRoot,
      "--context", "acceptance.md",
      "--story", "US-WS-007",
      "--json",
    ] as const;
    const first = run(args);
    expect(first).toMatchObject({ status: 0, stderr: "" });
    const firstResult = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstResult).toMatchObject({
      schema: "roll.workspace-requirement-result/v1",
      outcome: "created",
      workspaceId: "ws-e2e",
      source: { provider: "jira", ref: "SOT-15499" },
      revision: "42",
      contextCount: 1,
      storyCount: 1,
    });
    const second = run(args);
    expect(second).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(second.stdout)).toMatchObject({ outcome: "reused" });

    function snapshotTree(root: string): ReadonlyMap<string, string> {
      const entries = new Map<string, string>();
      const walk = (dir: string, relativeDir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
          const stat = lstatSync(path);
          const digest = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
          entries.set(relativePath, JSON.stringify({
            type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file",
            ino: stat.ino,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            digest,
          }));
          if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relativePath);
        }
      };
      walk(root, "");
      return entries;
    }

    const requirementsRoot = join(workspace, "requirements");
    const beforeThird = snapshotTree(requirementsRoot);
    const third = run(args);
    expect(third).toMatchObject({ status: 0, stderr: "" });
    const afterThird = snapshotTree(requirementsRoot);
    expect(Array.from(afterThird.keys()).sort()).toEqual(Array.from(beforeThird.keys()).sort());
    for (const [path, entry] of beforeThird) expect(afterThird.get(path), `changed at ${path}`).toBe(entry);

    const secondResult = JSON.parse(second.stdout) as Record<string, unknown>;
    const thirdResult = JSON.parse(third.stdout) as Record<string, unknown>;
    expect(thirdResult).toEqual(secondResult);
    expect(thirdResult).toMatchObject({ outcome: "reused" });
    const requirementPath = firstResult["path"];
    expect(typeof requirementPath).toBe("string");
    if (typeof requirementPath !== "string") return;
    expect(readFileSync(join(requirementPath, "requirement.md"), "utf8")).toContain("Jira-shaped requirement");
    expect(readFileSync(join(requirementPath, "context", "acceptance.md"), "utf8")).toContain("No provider network");
    const attest = readFileSync(join(requirementPath, "attest.md"), "utf8");
    expect(attest).toContain("Generated pending projection");
    expect(attest).toContain("US-WS-007: no evidence captured yet");
    expect(attest).not.toContain("issues/US-WS-007/evidence");

    process.stdout.write(`US-WS-007 built CLI transcript\n${JSON.stringify({
      first: { ...firstResult, path: "<HOME>/workspace/requirements/jira/req-c78ccf14ea21" },
      second: { ...secondResult, path: "<HOME>/workspace/requirements/jira/req-c78ccf14ea21" },
      third: { ...thirdResult, path: "<HOME>/workspace/requirements/jira/req-c78ccf14ea21" },
    }, null, 2)}\n`);
  });
});
