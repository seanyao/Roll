/**
 * US-WS-034 public CLI regressions for Workspace-owned project data.
 *
 * Every command starts outside the selected Workspace so ambient cwd can never
 * accidentally satisfy the assertion. The public router must resolve the
 * registry selection before a command reads or mutates project data.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "@roll/infra";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) execFileSync("rm", ["-rf", dir]);
});

function fixture(prefix: string, options: { readonly features?: boolean } = {}) {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), `roll-ws-authority-${prefix}-`)));
  const outsideCwd = realpathSync(mkdtempSync(join(tmpdir(), `roll-ws-authority-${prefix}-cwd-`)));
  const rollHome = realpathSync(mkdtempSync(join(tmpdir(), `roll-ws-authority-${prefix}-home-`)));
  dirs.push(workspaceRoot, outsideCwd, rollHome);
  const workspaceId = `ws-${prefix}`;
  const remote = `https://example.test/workspaces/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  writeFileSync(join(workspaceRoot, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId.value,
      alias: "product",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`);
  mkdirSync(join(workspaceRoot, "backlog"), { recursive: true });
  if (options.features !== false) mkdirSync(join(workspaceRoot, "features"), { recursive: true });
  mkdirSync(join(workspaceRoot, "runtime"), { recursive: true });
  writeFileSync(join(workspaceRoot, "backlog", "index.md"), "| ID | Description | Status |\n|----|----|----|\n");
  const registry = new WorkspaceRegistry({ rollHome });
  registry.register({ workspaceId, root: workspaceRoot });
  registry.activate(workspaceId);
  return {
    workspaceId,
    workspaceRoot,
    outsideCwd,
    env: { ROLL_HOME: rollHome, ROLL_WORKSPACE: workspaceId },
  };
}

function runRoll(cwd: string, args: string[], env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ROLL_LANG: "en", ...env };
  delete childEnv["ROLL_PROJECT_RUNTIME_DIR"];
  delete childEnv["_LOOP_RUNS"];
  const result = spawnSync(process.execPath, [rollBin, ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? 1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

describe("US-WS-034 public Workspace project-data authority", () => {
  it("fails closed when canonical mutation authority is incomplete and never creates .roll", () => {
    const f = fixture("index-missing", { features: false });
    const index = runRoll(f.outsideCwd, ["index", "--rebuild", "--workspace", f.workspaceId], f.env);
    const story = runRoll(f.outsideCwd, ["story", "new", "US-MISSING-1", "--title", "must fail", "--workspace", f.workspaceId], f.env);
    const idea = runRoll(f.outsideCwd, ["idea", "must fail without features", "--workspace", f.workspaceId], f.env);

    expect(index.code).toBe(1);
    expect(story.code).toBe(1);
    expect(idea.code).toBe(1);
    expect(index.err).toContain("authority_missing");
    expect(story.err).toContain("authority_missing");
    expect(idea.err).toContain("authority_missing");
    expect(existsSync(join(f.workspaceRoot, ".roll"))).toBe(false);
    expect(existsSync(join(f.workspaceRoot, "index.json"))).toBe(false);
    expect(existsSync(join(f.workspaceRoot, "features"))).toBe(false);
  });

  it("does not recreate a missing canonical policy during capture migration", () => {
    const f = fixture("capture-missing-policy");
    const result = runRoll(f.outsideCwd, ["capture", "migrate", "--workspace", f.workspaceId, "--revert"], f.env);

    expect(result.code).toBe(1);
    expect(result.err).toContain("authority_missing");
    expect(existsSync(join(f.workspaceRoot, "policy.yaml"))).toBe(false);
    expect(existsSync(join(f.workspaceRoot, ".roll"))).toBe(false);
  });

  it("rejects capture repair health paths outside the selected Workspace evidence authority", () => {
    const f = fixture("capture-outside-health");
    const outsideHealth = join(f.outsideCwd, "health.json");
    writeFileSync(outsideHealth, "{}\n");
    const result = runRoll(f.outsideCwd, [
      "capture", "repair", "US-OUTSIDE-1", "--health", outsideHealth, "--workspace", f.workspaceId,
    ], f.env);

    expect(result.code).toBe(1);
    expect(result.err).toContain("authority_outside");
    expect(readFileSync(outsideHealth, "utf8")).toBe("{}\n");
  });

  it("routes capture and truth through the selected Workspace from an arbitrary cwd", () => {
    const f = fixture("capture-truth");
    writeFileSync(join(f.workspaceRoot, "policy.yaml"), "acceptance:\n  capture:\n    mode: best_effort\n");
    writeFileSync(join(f.workspaceRoot, "runtime", "runs.jsonl"), "");
    writeFileSync(join(f.workspaceRoot, "runtime", "deliveries.jsonl"), `${JSON.stringify({
      storyId: "US-TRUTH-1",
      cycleId: "cycle-1",
      lifecycleState: "done",
      prNumber: { present: false, reason: "no_publish_attempted" },
      prUrl: { present: false, reason: "not_recorded" },
      mergedAt: { present: true, value: 1_800_000_000_000 },
      mergeCommit: { present: true, value: "0123456789abcdef0123456789abcdef01234567" },
      recordedAt: 1_800_000_000_000,
    })}\n`);

    const capture = runRoll(f.outsideCwd, ["capture", "status", "--workspace", f.workspaceId, "--json"], f.env);
    const truth = runRoll(f.outsideCwd, ["truth", "query", "US-TRUTH-1", "--workspace", f.workspaceId, "--json"], f.env);

    expect(capture.code).toBe(0);
    expect(JSON.parse(capture.out)).toMatchObject({ policy: { mode: "best_effort", source: "recorded" } });
    expect(truth.code).toBe(0);
    expect(JSON.parse(truth.out)).toMatchObject({ storyId: "US-TRUTH-1", lifecycleState: "done", delivered: true });
    expect(existsSync(join(f.outsideCwd, ".roll"))).toBe(false);
  });

  it("mints roll idea as a canonical linked Story that backlog show can open", () => {
    const f = fixture("idea-show");
    const idea = runRoll(f.outsideCwd, ["idea", "improve workspace backlog", "--workspace", f.workspaceId, "--no-color"], f.env);
    const show = runRoll(f.outsideCwd, ["backlog", "show", "IDEA-001", "--workspace", f.workspaceId, "--no-color"], f.env);

    expect(idea.code).toBe(0);
    expect(show.code).toBe(0);
    expect(show.out).toContain("IDEA-001");
    expect(show.out).toContain("improve workspace backlog");
    expect(readFileSync(join(f.workspaceRoot, "backlog", "index.md"), "utf8")).toContain(
      "[IDEA-001](../features/backlog-lifecycle/IDEA-001/spec.md)",
    );
    expect(existsSync(join(f.outsideCwd, ".roll"))).toBe(false);
  });

  it("rejects an internal features symlink before roll idea can write outside the Workspace", () => {
    const f = fixture("idea-feature-symlink");
    const outsideEpic = join(f.outsideCwd, "outside-backlog-lifecycle");
    mkdirSync(outsideEpic, { recursive: true });
    symlinkSync(outsideEpic, join(f.workspaceRoot, "features", "backlog-lifecycle"), "dir");
    const before = readFileSync(join(f.workspaceRoot, "backlog", "index.md"), "utf8");

    const result = runRoll(f.outsideCwd, [
      "idea", "improve workspace backlog", "--workspace", f.workspaceId, "--no-color",
    ], f.env);

    expect(result.code).toBe(1);
    expect(result.err).toContain("authority_symlink");
    expect(readFileSync(join(f.workspaceRoot, "backlog", "index.md"), "utf8")).toBe(before);
    expect(existsSync(join(outsideEpic, "IDEA-001", "spec.md"))).toBe(false);
  });

  it("rejects capture repair when the canonical evidence authority is an external symlink", () => {
    const f = fixture("capture-evidence-symlink");
    const outsideEvidence = join(f.outsideCwd, "outside-evidence");
    const healthDir = join(outsideEvidence, "_health");
    const healthPath = join(healthDir, "US-EVIDENCE-LINK.json");
    mkdirSync(healthDir, { recursive: true });
    const health = `${JSON.stringify({
      surfaceId: "http://localhost:3000/team",
      delivery: "passed",
      visual: "degraded-infrastructure",
      acceptedReceiptIds: [],
      attempts: ["r1"],
      category: "evidence-degradation",
      blocksGate: false,
      reschedulesBuild: false,
      markedDegraded: true,
      evidenceOnlyRepair: true,
      reason: "degraded",
    })}\n`;
    writeFileSync(healthPath, health);
    symlinkSync(outsideEvidence, join(f.workspaceRoot, "evidence"), "dir");

    const result = runRoll(f.outsideCwd, [
      "capture", "repair", "US-EVIDENCE-LINK", "--workspace", f.workspaceId,
    ], f.env);

    expect(result.code).toBe(1);
    expect(result.err).toContain("authority_symlink");
    expect(readFileSync(healthPath, "utf8")).toBe(health);
    expect(existsSync(join(outsideEvidence, "repairs"))).toBe(false);
  });

  it("reads imported .roll/features links against canonical features without rewriting backlog", () => {
    const f = fixture("legacy-link");
    const specPath = join(f.workspaceRoot, "features", "imported", "US-LEGACY-1", "spec.md");
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, "# US-LEGACY-1 — imported card\n");
    const backlog = [
      "| ID | Description | Status |",
      "|----|----|----|",
      "| [US-LEGACY-1](.roll/features/imported/US-LEGACY-1/spec.md) | imported card | 📋 Todo |",
      "",
    ].join("\n");
    writeFileSync(join(f.workspaceRoot, "backlog", "index.md"), backlog);

    const show = runRoll(f.outsideCwd, ["backlog", "show", "US-LEGACY-1", "--workspace", f.workspaceId], f.env);

    expect(show.code).toBe(0);
    expect(show.out).toContain("imported card");
    expect(readFileSync(join(f.workspaceRoot, "backlog", "index.md"), "utf8")).toBe(backlog);
  });
});
