import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requirementRevisionKey } from "@roll/core";
import { applyIssueInit, captureRequirementSource, ensureRepositoryCache, repairRequirementProjection, WorkspaceRegistry } from "@roll/infra";
import { AGENT_CAPACITY_LEASE_SCHEMA, repositoryIdFromRemote, type RepositoryBinding } from "@roll/spec";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR"] as const;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function materializeRemote(source: string, remote: string): void {
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  mkdirSync(dirname(remote), { recursive: true });
  git(dirname(remote), ["clone", "-q", "--bare", source, remote]);
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-doctor-cli-"));
  roots.push(home);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  const remotePath = join(home, "product.git");
  materializeRemote(join(home, "source"), remotePath);
  const remote = `file://${remotePath}`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  const binding: RepositoryBinding = {
    schema: "roll.repository-binding/v1",
    repoId: repoId.value,
    alias: "product",
    remote,
    integrationBranch: "main",
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-demo",
    displayName: "Demo",
    requirements: [],
    repositories: [binding],
  }, null, 2)}\n`, "utf8");
  const registry = new WorkspaceRegistry({ rollHome, now: () => 1 });
  registry.register({ workspaceId: "ws-demo", root: workspace });
  registry.activate("ws-demo");
  const cache = await ensureRepositoryCache({
    rollHome,
    binding,
    integrationRefspec: "+refs/heads/main:refs/remotes/origin/main",
  });
  return { home, rollHome, workspace, binding, cache };
}

function captureRequirementFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const manifest = JSON.parse(readFileSync(join(f.workspace, "workspace.yaml"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(f.workspace, "workspace.yaml"), `${JSON.stringify({
    ...manifest,
    requirements: [{ provider: "jira", ref: "SOT-1800" }],
  }, null, 2)}\n`, "utf8");
  const storyRoot = join(f.workspace, "backlog", "epic", "US-DOCTOR-REQ-1");
  mkdirSync(storyRoot, { recursive: true });
  writeFileSync(join(storyRoot, "spec.md"), "# US-DOCTOR-REQ-1\n", "utf8");
  const body = join(f.home, "requirement.md");
  writeFileSync(body, "trusted requirement\n", "utf8");
  return captureRequirementSource({
    rollHome: f.rollHome,
    workspaceRoot: f.workspace,
    provider: "jira",
    ref: "SOT-1800",
    revision: "7",
    capturedAt: "2026-07-23T00:00:00.000Z",
    bodyFile: body,
    contextPaths: [],
    storyIds: ["US-DOCTOR-REQ-1"],
  });
}

function writeIssueStory(f: Awaited<ReturnType<typeof fixture>>, storyId: string): void {
  const storyRoot = join(f.workspace, "backlog", "epic", storyId);
  mkdirSync(storyRoot, { recursive: true });
  writeFileSync(join(storyRoot, "spec.md"), `---\nid: ${storyId}\nrepositories:\n  - alias: product\n    access: write\n    required_delivery: true\n---\n\n# ${storyId}\n`, "utf8");
}

async function initializeIssueFixture(f: Awaited<ReturnType<typeof fixture>>, storyId = "US-DOCTOR-1") {
  writeIssueStory(f, storyId);
  const initialized = await run(["workspace", "issue", "init", storyId, "--workspace", "ws-demo", "--json"], f);
  expect(initialized.status, initialized.stderr).toBe(0);
  return { storyId, issueRoot: join(f.workspace, "issues", storyId) };
}

async function run(args: string[], f: Awaited<ReturnType<typeof fixture>>, lang: "en" | "zh" = "en"): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) saved[key] = process.env[key];
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = lang;
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

describe("US-WS-018 roll workspace doctor", () => {
  it("reports a healthy Workspace from real registry, manifest and cache facts", async () => {
    const f = await fixture();
    const result = await run(["workspace", "doctor", "ws-demo", "--json"], f);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "roll.workspace-doctor/v1",
      workspaceId: "ws-demo",
      status: "healthy",
      findings: [],
      nextAction: { kind: "none" },
    });
    const terminal = await run(["workspace", "doctor", "ws-demo"], f);
    expect(terminal.stdout).toMatchSnapshot("healthy-terminal-en");
  });

  it("reports a missing recorded cache as repairable with one typed action", async () => {
    const f = await fixture();
    rmSync(f.cache.cachePath, { recursive: true, force: true });
    const result = await run(["workspace", "doctor", "ws-demo"], f);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Workspace ws-demo doctor: repairable");
    expect(result.stdout).toContain("cache_repairable");
    expect(result.stdout).toContain(`rebuild_cache:${f.binding.repoId}`);
    expect(result.stdout).not.toContain(f.home);
    expect(result.stdout.replaceAll(f.binding.repoId, "<REPO_ID>")).toMatchSnapshot("repairable-terminal-en");
  });

  it("rebuilds only the explicitly selected safe cache and converges on repeat", async () => {
    const f = await fixture();
    rmSync(f.cache.cachePath, { recursive: true, force: true });
    const action = `rebuild_cache:${f.binding.repoId}`;

    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(repaired.stdout)).toMatchObject({
      schema: "roll.workspace-doctor-repair/v1",
      outcome: "repaired",
      report: { status: "healthy", findings: [] },
    });
    expect(git(f.cache.cachePath, ["remote", "get-url", "origin"])).toBe(f.binding.remote.replace(/\.git$/u, ""));

    const repeated = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ outcome: "reused", report: { status: "healthy" } });
  });

  it("updates only an explicit exact registry path and is idempotent", async () => {
    const f = await fixture();
    const moved = join(f.home, "workspace-moved");
    renameSync(f.workspace, moved);
    const action = "update_registry_path:ws-demo";

    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--path", moved, "--json"], f);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    const entry = new WorkspaceRegistry({ rollHome: f.rollHome }).inspect().find((candidate) => candidate.workspaceId === "ws-demo");
    expect(entry?.root).toBe(moved);

    const repeated = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--path", moved, "--json"], f);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ outcome: "reused", report: { status: "healthy" } });
  });

  it("repairs a Requirement projection only from its unchanged healthy immutable revision", async () => {
    const f = await fixture();
    const captured = captureRequirementFixture(f);
    const immutableBody = join(captured.requirementPath, "revisions", requirementRevisionKey("7"), "requirement.md");
    const immutableBefore = readFileSync(immutableBody, "utf8");
    writeFileSync(join(captured.requirementPath, "requirement.md"), "projection drift\n", "utf8");
    const action = `repair_requirement_projection:${captured.manifest.requirementId}`;
    const diagnosis = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: "repairable",
      findings: [{ repairAction: { kind: "repair_requirement_projection", targetId: captured.manifest.requirementId } }],
    });

    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    expect(readFileSync(join(captured.requirementPath, "requirement.md"), "utf8")).toBe("trusted requirement\n");
    expect(readFileSync(immutableBody, "utf8")).toBe(immutableBefore);

    const repeated = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ outcome: "reused", report: { status: "healthy" } });
  });

  it("resumes an interrupted Requirement projection journal and removes it only after success", async () => {
    const f = await fixture();
    const captured = captureRequirementFixture(f);
    writeFileSync(join(captured.requirementPath, "requirement.md"), "projection drift\n", "utf8");
    expect(() => repairRequirementProjection({
      rollHome: f.rollHome,
      workspaceRoot: f.workspace,
      provider: "jira",
      requirementId: captured.manifest.requirementId,
    }, {
      beforeProjection: () => { throw new Error("simulated interruption"); },
    })).toThrowError(expect.objectContaining({ code: "projection_repair_required" }));
    const journal = join(captured.requirementPath, "projection.pending.json");
    expect(existsSync(journal)).toBe(true);

    const action = `repair_requirement_projection:${captured.manifest.requirementId}`;
    const diagnosis = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: "repairable",
      findings: [{ code: "requirement_projection_pending_journal" }],
    });
    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    expect(existsSync(journal)).toBe(false);
  });

  it("blocks projection repair when immutable archive evidence is corrupt and performs zero projection writes", async () => {
    const f = await fixture();
    const captured = captureRequirementFixture(f);
    const projectionPath = join(captured.requirementPath, "requirement.md");
    const immutablePath = join(captured.requirementPath, "revisions", requirementRevisionKey("7"), "requirement.md");
    writeFileSync(projectionPath, "projection must stay unchanged\n", "utf8");
    writeFileSync(immutablePath, "corrupt immutable evidence\n", "utf8");
    const projectionBefore = readFileSync(projectionPath, "utf8");
    const action = `repair_requirement_projection:${captured.manifest.requirementId}`;

    const diagnosis = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({ status: "data_loss_risk" });
    const blocked = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: { code: "repair_blocked" } });
    expect(readFileSync(projectionPath, "utf8")).toBe(projectionBefore);
    expect(existsSync(join(captured.requirementPath, "projection.pending.json"))).toBe(false);
  });

  it("recreates a clean missing Issue worktree without changing Issue evidence", async () => {
    const f = await fixture();
    const { storyId, issueRoot } = await initializeIssueFixture(f);
    const evidenceBefore = readFileSync(join(issueRoot, "events.jsonl"), "utf8");
    const worktree = join(issueRoot, "product");
    git(f.cache.cachePath, ["worktree", "remove", worktree]);

    const action = `recreate_clean_worktree:${storyId}`;
    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(join(issueRoot, "events.jsonl"), "utf8")).toBe(evidenceBefore);

    const repeated = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ outcome: "reused", report: { status: "healthy" } });
  });

  it("resumes a valid partial Issue journal with no manifest", async () => {
    const f = await fixture();
    const storyId = "US-DOCTOR-PARTIAL-1";
    writeIssueStory(f, storyId);
    const issueRoot = join(f.workspace, "issues", storyId);
    await expect(applyIssueInit({
      workspaceId: "ws-demo",
      rollHome: f.rollHome,
      workspaceRoot: f.workspace,
      issueRoot,
      contract: {
        storyId,
        repositories: [{ alias: "product", access: "write", requiredDelivery: true }],
      },
      bindings: [f.binding],
      requirementManifests: [],
    }, {
      beforeMutateTarget: () => { throw new Error("simulated interruption"); },
    })).rejects.toMatchObject({ code: "apply_failed" });
    expect(existsSync(join(issueRoot, "issue-init.pending.json"))).toBe(true);
    expect(existsSync(join(issueRoot, "manifest.json"))).toBe(false);

    const action = `recreate_clean_worktree:${storyId}`;
    const diagnosis = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: "repairable",
      findings: [{ code: "issue_partial_journal", repairAction: { targetId: storyId } }],
    });
    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    expect(existsSync(join(issueRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(issueRoot, "issue-init.pending.json"))).toBe(false);
  });

  it("refuses worktree repair over dirty or unpushed work and preserves Issue evidence", async () => {
    const f = await fixture();
    const { storyId, issueRoot } = await initializeIssueFixture(f);
    const worktree = join(issueRoot, "product");
    writeFileSync(join(worktree, "untracked-secret.txt"), "preserve me\n", "utf8");
    const evidenceBefore = readFileSync(join(issueRoot, "events.jsonl"), "utf8");
    const action = `recreate_clean_worktree:${storyId}`;

    const diagnosis = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: "data_loss_risk",
      findings: [{ code: "issue_worktree_dirty_or_unpushed" }],
    });
    const blocked = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: { code: "repair_blocked" } });
    expect(readFileSync(join(worktree, "untracked-secret.txt"), "utf8")).toBe("preserve me\n");
    expect(readFileSync(join(issueRoot, "events.jsonl"), "utf8")).toBe(evidenceBefore);
  });

  it("cleans only a stale same-host dead machine lease and converges on repeat", async () => {
    const f = await fixture();
    const leaseId = "lease-owned-dead";
    const leaseRoot = join(f.rollHome, "locks", "capacity", "leases");
    mkdirSync(leaseRoot, { recursive: true });
    const leasePath = join(leaseRoot, `${createHash("sha256").update(leaseId).digest("hex")}.json`);
    writeFileSync(leasePath, `${JSON.stringify({
      schema: AGENT_CAPACITY_LEASE_SCHEMA,
      key: { agent: "codex", model: "gpt-test", contextKey: "ctx" },
      owner: {
        leaseId,
        ownerToken: "token-not-rendered",
        workspaceId: "ws-demo",
        storyId: "US-DOCTOR-1",
        cycleId: "cycle-1",
        spawnId: "spawn-1",
        host: hostname(),
        pid: 999999,
        processStartedAtMs: 1,
      },
      acquiredAtMs: 1,
      heartbeatAtMs: 1,
    })}\n`, "utf8");
    const action = `cleanup_stale_owned_lease:${leaseId}`;

    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    expect(existsSync(leasePath)).toBe(false);

    const repeated = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ outcome: "reused", report: { status: "healthy" } });
  });

  it("diagnoses and cleans a stale same-host dead capacity broker lock", async () => {
    const f = await fixture();
    const lockPath = join(f.rollHome, "locks", "capacity", "broker.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      schema: "roll-agent-capacity-broker-lock/v1",
      ownerToken: "dead-broker-owner",
      host: hostname(),
      pid: 999999,
      processStartedAtMs: 1,
      acquiredAtMs: 1,
    })}\n`, "utf8");
    const action = "cleanup_stale_capacity_broker_lock:broker-lock";

    const diagnosis = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      status: "repairable",
      findings: [{
        code: "capacity_broker_lock_stale_owned",
        repairAction: { kind: "cleanup_stale_capacity_broker_lock", targetId: "broker-lock" },
      }],
    });

    const repaired = await run(["workspace", "doctor", "ws-demo", "--repair", action, "--json"], f);
    expect(repaired).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(repaired.stdout)).toMatchObject({ outcome: "repaired", report: { status: "healthy" } });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("blocks a stale foreign machine lease without leaking owner identity or credentials", async () => {
    const f = await fixture();
    const leaseRoot = join(f.rollHome, "locks", "capacity", "leases");
    mkdirSync(leaseRoot, { recursive: true });
    const leaseId = "lease-foreign";
    const leasePath = join(leaseRoot, `${createHash("sha256").update(leaseId).digest("hex")}.json`);
    writeFileSync(leasePath, `${JSON.stringify({
      schema: AGENT_CAPACITY_LEASE_SCHEMA,
      key: { agent: "codex", model: "gpt-secret", contextKey: "credential-sentinel-context" },
      owner: {
        leaseId,
        ownerToken: "credential-sentinel-token",
        workspaceId: "ws-demo",
        storyId: "US-SECRET",
        cycleId: "cycle-secret",
        spawnId: "spawn-secret",
        host: "private-hostname",
        pid: 999999,
        processStartedAtMs: 1,
      },
      acquiredAtMs: 1,
      heartbeatAtMs: 1,
    })}\n`, "utf8");

    const result = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      findings: [{ code: "lease_stale_live_or_foreign", status: "blocked" }],
    });
    for (const secret of ["credential-sentinel", "private-hostname", "US-SECRET", "cycle-secret", "spawn-secret", "gpt-secret"]) {
      expect(output).not.toContain(secret);
    }
    const blocked = await run(["workspace", "doctor", "ws-demo", "--repair", `cleanup_stale_owned_lease:${leaseId}`, "--json"], f);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: { code: "repair_blocked" } });
    expect(existsSync(leasePath)).toBe(true);
  });

  it("reports unsupported Issue and machine-policy schemas without echoing their contents", async () => {
    const f = await fixture();
    const issueRoot = join(f.workspace, "issues", "US-BAD-SCHEMA");
    mkdirSync(issueRoot, { recursive: true });
    writeFileSync(join(issueRoot, "manifest.json"), "{\"schema\":\"credential-sentinel-schema\"}\n", "utf8");
    const leaseRoot = join(f.rollHome, "locks", "capacity", "leases");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(join(f.rollHome, "agents.yaml"), "schema: credential-sentinel-policy\n", "utf8");

    const result = await run(["workspace", "doctor", "ws-demo", "--json"], f);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked" });
    expect(result.stdout).not.toContain("credential-sentinel");
    const terminal = await run(["workspace", "doctor", "ws-demo"], f, "zh");
    expect(terminal.stdout).not.toContain("credential-sentinel");
    expect(terminal.stdout).toMatchSnapshot("blocked-terminal-zh");
  });

  it("shows localized help and rejects unknown or duplicated selectors", async () => {
    const f = await fixture();
    const help = await run(["workspace", "doctor", "--help"], f, "zh");
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("roll workspace doctor <ID>");

    for (const args of [
      ["workspace", "doctor", "ws-demo", "other", "--json"],
      ["workspace", "doctor", "ws-demo", "--unknown", "--json"],
    ]) {
      const rejected = await run(args, f);
      expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stderr)).toMatchObject({ error: { code: "invalid_arguments" } });
    }
  });
});
