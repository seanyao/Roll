import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryIdFromRemote } from "@roll/spec";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
interface CreateStep { readonly kind: "journal" | "directory" | "file" | "cache" | "registry"; readonly target: string; readonly action: "created" | "reused" | "repaired" | "rejected" }
interface CreateResult {
  readonly schema: string;
  readonly mode: "check" | "apply";
  readonly outcome: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly configSha256: string;
  readonly planSha256: string;
  readonly authorizationSource?: "direct_cli_apply" | "owner_after_preview";
  readonly steps: readonly CreateStep[];
}
const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR"] as const;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function materializeRemote(source: string, remote: string): void {
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  git(dirname(remote), ["clone", "-q", "--bare", source, remote]);
}

function fixture(options: { readonly createRemote?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-cli-"));
  roots.push(home);
  const source = join(home, "source");
  const remote = join(home, "product.git");
  if (options.createRemote !== false) materializeRemote(source, remote);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  const config = join(home, "workspace-create.yaml");
  const remoteUrl = `file://${remote}`;
  const repoId = repositoryIdFromRemote(remoteUrl);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  writeFileSync(config, `
schema: roll.workspace-create/v1
id: ws-demo
root: ${workspace}
display_name: Demo Workspace
repositories:
  - alias: product
    source: ${remoteUrl}
    integration_branch: main
`, "utf8");
  return { home, rollHome, workspace, config, source, remote, remoteUrl, repoId: repoId.value };
}

function expectedSteps(f: ReturnType<typeof fixture>, action: "created" | "reused"): readonly CreateStep[] {
  return [
    { kind: "journal", target: join(f.rollHome, "workspace-create", "ws-demo.pending.json"), action: "created" },
    { kind: "directory", target: f.workspace, action },
    ...["workspace.yaml", "charter.md", "agents.yaml", "policy.yaml"].map((name) => ({ kind: "file" as const, target: join(f.workspace, name), action })),
    { kind: "directory", target: join(f.workspace, "requirements"), action },
    { kind: "directory", target: join(f.workspace, "design"), action },
    { kind: "directory", target: join(f.workspace, "backlog"), action },
    { kind: "file", target: join(f.workspace, "backlog", "index.md"), action },
    ...["issues", "runtime", join("runtime", "locks"), join("runtime", "heartbeats"), join("runtime", "alerts")]
      .map((name) => ({ kind: "directory" as const, target: join(f.workspace, name), action })),
    { kind: "cache", target: f.repoId, action },
    { kind: "registry", target: "ws-demo", action },
  ];
}

function tree(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const rows: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === ".git") continue;
      const target = join(path, entry.name);
      const rel = relative(root, target);
      if (entry.isDirectory()) {
        rows.push(`d:${rel}`);
        visit(target);
      } else {
        rows.push(`f:${rel}:${statSync(target).mode}:${createHash("sha256").update(readFileSync(target)).digest("hex")}`);
      }
    }
  };
  visit(root);
  return rows;
}

async function run(args: string[], f: ReturnType<typeof fixture>, language = "en"): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) saved[key] = process.env[key];
  }
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = language;
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  try {
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

beforeEach(() => registerAll());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-006 roll workspace create", () => {
  it("runs check, first apply and idempotent second apply against one local file remote", async () => {
    const f = fixture();
    const before = tree(f.home);
    const check = await run(["workspace", "create", "ws-demo", "--config", f.config, "--check", "--json"], f);
    expect(check.status, check.stderr).toBe(0);
    const checkResult = JSON.parse(check.stdout) as CreateResult;
    expect(checkResult).toMatchObject({
      schema: "roll.workspace-create-result/v1",
      mode: "check",
      outcome: "created",
      workspaceId: "ws-demo",
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      planSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(checkResult.steps).toEqual(expectedSteps(f, "created"));
    expect(tree(f.home)).toEqual(before);

    const first = await run(["workspace", "create", "ws-demo", "--config", f.config, "--json"], f);
    expect(first.status, first.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout) as CreateResult;
    expect(firstResult).toMatchObject({ mode: "apply", outcome: "created", authorizationSource: "direct_cli_apply" });
    expect(firstResult.steps).toEqual(expectedSteps(f, "created"));
    expect(existsSync(join(f.workspace, ".git"))).toBe(false);
    const cachePath = join(f.rollHome, "repos", `${f.repoId}.git`);
    const identityPath = join(f.rollHome, "repos", `${f.repoId}.json`);
    const firstIdentity = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    expect(firstIdentity).toMatchObject({ repoId: f.repoId, remote: f.remoteUrl.replace(/\.git$/u, ""), cachePath });
    expect(git(cachePath, ["remote", "get-url", "origin"])).toBe(f.remoteUrl.replace(/\.git$/u, ""));

    const second = await run(["workspace", "create", "ws-demo", "--config", f.config, "--json"], f);
    expect(second.status, second.stderr).toBe(0);
    const secondResult = JSON.parse(second.stdout) as CreateResult;
    expect(secondResult).toMatchObject({ mode: "apply", outcome: "reused" });
    expect(secondResult.steps).toEqual(expectedSteps(f, "reused"));
    const secondIdentity = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    expect(secondIdentity).toMatchObject({ repoId: f.repoId, remote: firstIdentity["remote"], cachePath });
    expect(readdirSync(join(f.rollHome, "repos")).filter((name) => name.endsWith(".git"))).toEqual([`${f.repoId}.git`]);
  });

  it("applies an exact owner-approved preview and rejects stale or non-owner authorization before writes", async () => {
    const approved = fixture();
    const preview = await run(["workspace", "create", "ws-demo", "--config", approved.config, "--check", "--json"], approved);
    const previewResult = JSON.parse(preview.stdout) as CreateResult;
    const authorizationPath = join(approved.home, "create-authorization.json");
    writeFileSync(authorizationPath, `${JSON.stringify({
      schema: "roll.workspace-create-apply-authorization/v1",
      workspaceId: previewResult.workspaceId,
      configSha256: previewResult.configSha256,
      planSha256: previewResult.planSha256,
      source: "owner_after_preview",
    }, null, 2)}\n`, "utf8");

    const applied = await run([
      "workspace", "create", "ws-demo", "--config", approved.config,
      "--authorization", authorizationPath, "--json",
    ], approved);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      outcome: "created",
      authorizationSource: "owner_after_preview",
      configSha256: previewResult.configSha256,
      planSha256: previewResult.planSha256,
    });

    const stale = fixture();
    const staleAuthorization = join(stale.home, "stale-authorization.json");
    writeFileSync(staleAuthorization, `${JSON.stringify({
      schema: "roll.workspace-create-apply-authorization/v1",
      workspaceId: "ws-demo",
      configSha256: "0".repeat(64),
      planSha256: "f".repeat(64),
      source: "owner_after_preview",
    })}\n`, "utf8");
    const staleBefore = tree(stale.home);
    const rejected = await run([
      "workspace", "create", "ws-demo", "--config", stale.config,
      "--authorization", staleAuthorization, "--json",
    ], stale);
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stderr)).toMatchObject({
      error: {
        code: "apply_authorization_stale",
        nextAction: "roll workspace create ws-demo --config <path> --check --json",
      },
    });
    expect(tree(stale.home)).toEqual(staleBefore);

    writeFileSync(staleAuthorization, `${JSON.stringify({
      schema: "roll.workspace-create-apply-authorization/v1",
      workspaceId: "ws-demo",
      configSha256: "0".repeat(64),
      planSha256: "f".repeat(64),
      source: "direct_cli_apply",
    })}\n`, "utf8");
    const nonOwnerBefore = tree(stale.home);
    const nonOwner = await run([
      "workspace", "create", "ws-demo", "--config", stale.config,
      "--authorization", staleAuthorization, "--json",
    ], stale);
    expect(nonOwner.status).toBe(1);
    expect(JSON.parse(nonOwner.stderr)).toMatchObject({ error: { code: "invalid_apply_authorization" } });
    expect(tree(stale.home)).toEqual(nonOwnerBefore);
  });

  it("rejects identity mismatch and invalid arguments without any initialization writes", async () => {
    const f = fixture();
    const before = tree(f.home);
    const mismatch = await run(["workspace", "create", "ws-other", "--config", f.config, "--json"], f);
    const invalid = await run(["workspace", "create", "ws-demo", "--config", f.config, "--unknown", "--json"], f);
    expect(mismatch.status).toBe(1);
    expect(JSON.parse(mismatch.stderr)).toMatchObject({ schema: "roll.workspace-create-error/v1", error: { code: "identity_mismatch" } });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(tree(f.home)).toEqual(before);
  });

  it("reports a partial cache failure, previews repair without writes, and converges through the same CLI contract", async () => {
    const f = fixture({ createRemote: false });
    const failed = await run(["workspace", "create", "ws-demo", "--config", f.config, "--json"], f);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({
      schema: "roll.workspace-create-error/v1",
      error: { code: "apply_failed" },
    });
    expect(existsSync(f.workspace)).toBe(false);
    expect(existsSync(join(f.rollHome, "workspaces.json"))).toBe(false);
    const journalPath = join(f.rollHome, "workspace-create", "ws-demo.pending.json");
    expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
      schema: "roll.workspace-create-journal/v1",
      workspaceId: "ws-demo",
      status: "repair_required",
    });

    const beforeCheck = tree(f.home);
    const check = await run(["workspace", "create", "ws-demo", "--config", f.config, "--check", "--json"], f);
    expect(check.status, check.stderr).toBe(0);
    const repairPlan = JSON.parse(check.stdout) as CreateResult;
    expect(repairPlan).toMatchObject({ mode: "check", outcome: "repaired", workspaceId: "ws-demo" });
    expect(repairPlan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "journal", action: "repaired" }),
      expect.objectContaining({ kind: "cache", target: f.repoId, action: "repaired" }),
      expect.objectContaining({ kind: "registry", target: "ws-demo", action: "created" }),
    ]));
    expect(tree(f.home)).toEqual(beforeCheck);

    materializeRemote(f.source, f.remote);
    const repaired = await run(["workspace", "create", "ws-demo", "--config", f.config, "--json"], f);
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ mode: "apply", outcome: "repaired" });
    expect(existsSync(join(f.workspace, "workspace.yaml"))).toBe(true);
    expect(existsSync(join(f.rollHome, "workspaces.json"))).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
    expect(JSON.parse(readFileSync(join(f.rollHome, "repos", `${f.repoId}.json`), "utf8"))).toMatchObject({
      repoId: f.repoId,
      cachePath: join(f.rollHome, "repos", `${f.repoId}.git`),
    });

    const reused = await run(["workspace", "create", "ws-demo", "--config", f.config, "--json"], f);
    expect(reused.status, reused.stderr).toBe(0);
    expect(JSON.parse(reused.stdout)).toMatchObject({ mode: "apply", outcome: "reused" });
  });

  it("exposes create in locale-specific Workspace help", async () => {
    const f = fixture();
    const en = await run(["workspace", "--help"], f);
    const createEn = await run(["workspace", "create", "--help"], f, "en");
    const createZh = await run(["workspace", "create", "--help"], f, "zh");
    expect(en.stdout).toContain("create <id> --config <file> [--authorization <file>] [--check] [--json]");
    expect(createEn).toMatchObject({ status: 0, stderr: "" });
    expect(createEn.stdout).toContain("Usage: roll workspace create <id> --config <file> [--authorization <file>] [--check] [--json]");
    expect(createZh).toMatchObject({ status: 0, stderr: "" });
    expect(createZh.stdout).toContain("用法：roll workspace create <ID> --config <文件> [--authorization <文件>] [--check] [--json]");
  });
});
