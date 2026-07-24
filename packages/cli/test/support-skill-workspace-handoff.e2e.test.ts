import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWorkspaceExecutionAuthorities } from "@roll/core";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  repositoryIdFromRemote,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { prepareRegisteredWorkspaceSkillHandoff } from "../src/runner/workspace-skill-handoff.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const manifest = {
  workspaceContextPolicies: [
    {
      surface: "skill",
      id: "roll-peer",
      operation: "review",
      scope: "issue_required",
      contextConsumer: "issue",
      access: "read",
      repositorySelector: "required",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    },
    {
      surface: "skill",
      id: "roll-doc-audit",
      operation: "audit",
      scope: "workspace_required_read",
      contextConsumer: "workspace",
      access: "read",
      repositorySelector: "required",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    },
    {
      surface: "skill",
      id: "roll-review-pr",
      operation: "review",
      scope: "repository_required",
      contextConsumer: "repository",
      access: "read",
      repositorySelector: "required",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    },
    {
      surface: "skill",
      id: "roll-.changelog",
      operation: "generate",
      scope: "issue_required",
      contextConsumer: "issue",
      access: "mutation",
      repositorySelector: "required",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    },
    {
      surface: "skill",
      id: "roll-.dream",
      operation: "scan",
      scope: "workspace_required_read",
      contextConsumer: "workspace",
      access: "read",
      repositorySelector: "required",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    },
    {
      surface: "skill",
      id: "roll-notes",
      operation: "record",
      scope: "workspace_required_mutation",
      contextConsumer: "workspace",
      access: "mutation",
      repositorySelector: "not_applicable",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    },
  ],
};

function workspaceContext(root: string, workspaceId: string, ambiguousSelector = false): {
  readonly context: WorkspaceExecutionContextV1;
  readonly repoIds: readonly [string, string];
  readonly worktreePaths: readonly [string, string];
  readonly specCanary: string;
  readonly evidenceCanary: string;
} {
  const storyId = "US-WS-038";
  const issueRoot = join(root, "issues", storyId);
  const identities = (["product", "docs"] as const).map((alias) => {
    const remote = `git@github.com:acme/${workspaceId}-${alias}.git`;
    const identity = repositoryIdFromRemote(remote);
    if (!identity.ok) throw new Error("fixture remote must be canonical");
    return { alias, remote, identity: identity.value };
  });
  const repositories = identities.map(({ alias: defaultAlias, remote, identity }, index) => {
    const alias = ambiguousSelector && index === 1 ? identities[0]!.identity : defaultAlias;
    const worktreePath = join(issueRoot, alias);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "REPO_CANARY.txt"), `${workspaceId}:${defaultAlias}\n`, "utf8");
    return {
      binding: {
        schema: REPOSITORY_BINDING_V1,
        repoId: identity,
        alias,
        remote,
        integrationBranch: "main",
        provider: "github" as const,
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      },
      execution: {
        repoId: identity,
        alias,
        access: index === 0 ? "write" as const : "read" as const,
        requiredDelivery: index === 0,
        ...(index === 0 ? { noChangePolicy: "changes_required" as const } : {}),
        worktreePath,
        baseSha: `${index + 1}`.repeat(40),
        headSha: `${index + 3}`.repeat(40),
        commands: { test: [], integration: [] },
      },
    };
  });
  const authorities = deriveWorkspaceExecutionAuthorities(root);
  const specCanary = `${workspaceId}:spec`;
  const evidenceCanary = `${workspaceId}:evidence`;
  const specPath = join(authorities.features, "workspace-orchestration", storyId, "spec.md");
  mkdirSync(join(specPath, ".."), { recursive: true });
  mkdirSync(authorities.evidence, { recursive: true });
  writeFileSync(specPath, `${specCanary}\n`, "utf8");
  writeFileSync(join(authorities.evidence, `${storyId}.txt`), `${evidenceCanary}\n`, "utf8");
  return {
    context: {
      schema: WORKSPACE_EXECUTION_CONTEXT_V1,
      workspace: { workspaceId, root, canonicalRoot: root, lifecycle: "active" },
      resolution: { source: "explicit", evidence: [] },
      bindings: repositories.map(({ binding }) => binding),
      issue: {
        storyId,
        manifestPath: join(issueRoot, "manifest.json"),
        execution: {
          workspaceId,
          issueRoot,
          repositories: Object.fromEntries(repositories.map(({ execution }) => [execution.repoId, execution])),
        },
      },
      authorities,
    },
    repoIds: [repositories[0]!.execution.repoId, repositories[1]!.execution.repoId],
    worktreePaths: [repositories[0]!.execution.worktreePath, repositories[1]!.execution.worktreePath],
    specCanary,
    evidenceCanary,
  };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-038-product-")));
  roots.push(root);
  const arbitraryCwd = join(root, "arbitrary-cwd");
  const alphaRoot = join(root, "workspace-alpha");
  const betaRoot = join(root, "workspace-beta");
  mkdirSync(arbitraryCwd);
  mkdirSync(alphaRoot);
  mkdirSync(betaRoot);
  const shimPath = join(root, "support-skill-shim.cjs");
  writeFileSync(shimPath, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.ROLL_TEST_SPAWN_LOG, JSON.stringify({",
    "  cwd: process.cwd(),",
    "  prompt: process.argv[2],",
    "  workspace: process.env.ROLL_WORKSPACE,",
    "  story: process.env.ROLL_STORY_ID,",
    "  repositoryId: process.env.ROLL_REPOSITORY_ID,",
    "  repositoryAlias: process.env.ROLL_REPOSITORY_ALIAS,",
    "  context: process.env.ROLL_WORKSPACE_EXECUTION_CONTEXT,",
    "  repoCanary: fs.readFileSync('REPO_CANARY.txt', 'utf8').trim(),",
    "  specCanary: fs.readFileSync(require('node:path').join(JSON.parse(process.env.ROLL_WORKSPACE_EXECUTION_CONTEXT).authorities.features, 'workspace-orchestration', 'US-WS-038', 'spec.md'), 'utf8').trim(),",
    "  evidenceCanary: fs.readFileSync(require('node:path').join(JSON.parse(process.env.ROLL_WORKSPACE_EXECUTION_CONTEXT).authorities.evidence, 'US-WS-038.txt'), 'utf8').trim(),",
    "}));",
    "if (process.env.ROLL_TEST_MUTATE === '1') fs.writeFileSync('CHANGELOG.canary', process.env.ROLL_WORKSPACE);",
  ].join("\n"), "utf8");
  chmodSync(shimPath, 0o755);
  return {
    arbitraryCwd,
    alpha: workspaceContext(alphaRoot, "alpha"),
    beta: workspaceContext(betaRoot, "beta"),
    shimPath,
  };
}

describe("US-WS-038 supporting skill Workspace handoff", () => {
  it.each([
    ["roll-peer", "review"],
    ["roll-doc-audit", "audit"],
    ["roll-review-pr", "review"],
    ["roll-.changelog", "generate"],
  ] as const)("prepares and spawns capture-ready %s terminal handoff without crossing Workspace repo/spec/evidence canaries", (skillName, operation) => {
    const f = fixture();
    const previousCwd = process.cwd();
    try {
      process.chdir(f.arbitraryCwd);
      const handoff = prepareRegisteredWorkspaceSkillHandoff({
        manifest,
        skillName,
        operation,
        context: f.alpha.context,
        expectedWorkspaceId: "alpha",
        expectedStoryId: "US-WS-038",
        repositorySelector: "product",
        skillBody: `# ${skillName}`,
      });
      expect(handoff.ok).toBe(true);
      if (!handoff.ok) return;

      const logPath = join(f.arbitraryCwd, `${skillName}.json`);
      const spawned = spawnSync(process.execPath, [f.shimPath, handoff.skillBody], {
        cwd: handoff.cwd,
        env: {
          ...process.env,
          ...handoff.env,
          ROLL_TEST_SPAWN_LOG: logPath,
          ...(handoff.policy.access === "mutation" ? { ROLL_TEST_MUTATE: "1" } : {}),
        },
        encoding: "utf8",
      });
      expect(spawned.status, spawned.stderr).toBe(0);
      const observed = JSON.parse(readFileSync(logPath, "utf8")) as Record<string, string>;
      expect(observed).toMatchObject({
        cwd: f.alpha.worktreePaths[0],
        workspace: "alpha",
        story: "US-WS-038",
        repositoryId: f.alpha.repoIds[0],
        repositoryAlias: "product",
        repoCanary: "alpha:product",
        specCanary: f.alpha.specCanary,
        evidenceCanary: f.alpha.evidenceCanary,
      });
      expect(JSON.parse(observed["context"] ?? "null")).toEqual(f.alpha.context);
      expect(observed["prompt"]).toContain("skill: " + skillName);
      expect(observed["prompt"]).toContain("Workspace: alpha");
      expect(observed["prompt"]).toContain("Story: US-WS-038");
      expect(observed["prompt"]).toContain(`Selected repository: ${f.alpha.repoIds[0]} (product)`);
      expect(observed["prompt"]).toContain(f.alpha.worktreePaths[0]);
      expect(observed["prompt"]).not.toContain(f.beta.worktreePaths[0]);
      expect(existsSync(join(f.beta.worktreePaths[0], "CHANGELOG.canary"))).toBe(false);
      expect(existsSync(join(f.alpha.worktreePaths[0], "CHANGELOG.canary"))).toBe(handoff.policy.access === "mutation");
      expect(existsSync(join(f.arbitraryCwd, ".roll"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails closed before spawn on missing or conflicting explicit identity", () => {
    const f = fixture();
    let spawnCount = 0;
    const attempt = (context: WorkspaceExecutionContextV1 | undefined, expectedWorkspaceId: string) => {
      const handoff = prepareRegisteredWorkspaceSkillHandoff({
        manifest,
        skillName: "roll-peer",
        operation: "review",
        context,
        expectedWorkspaceId,
        expectedStoryId: "US-WS-038",
        repositorySelector: "product",
        skillBody: "# roll-peer",
      });
      if (handoff.ok) spawnCount += 1;
      return handoff;
    };

    expect(attempt(undefined, "alpha")).toMatchObject({ ok: false, code: "missing_execution_context" });
    expect(attempt(f.beta.context, "alpha")).toMatchObject({ ok: false, code: "workspace_context_conflict" });
    expect(spawnCount).toBe(0);
  });

  it("does not let a mutation policy write through a read-only repository binding", () => {
    const f = fixture();
    const handoff = prepareRegisteredWorkspaceSkillHandoff({
      manifest,
      skillName: "roll-.changelog",
      operation: "generate",
      context: f.alpha.context,
      expectedWorkspaceId: "alpha",
      expectedStoryId: "US-WS-038",
      repositorySelector: "docs",
      skillBody: "# roll-.changelog",
    });

    expect(handoff).toMatchObject({ ok: false, code: "repository_write_forbidden" });
  });

  it("allows a registry-declared Workspace mutation without inventing a repository selector", () => {
    const f = fixture();
    const handoff = prepareRegisteredWorkspaceSkillHandoff({
      manifest,
      skillName: "roll-notes",
      operation: "record",
      context: f.alpha.context,
      expectedWorkspaceId: "alpha",
      expectedStoryId: "US-WS-038",
      skillBody: "# roll-notes",
    });

    expect(handoff).toMatchObject({
      ok: true,
      cwd: f.alpha.context.issue?.execution.issueRoot,
      policy: { access: "mutation", repositorySelector: "not_applicable" },
    });
    if (!handoff.ok) return;
    expect(handoff.env["ROLL_REPOSITORY_ID"]).toBeUndefined();
    expect(handoff.env["ROLL_REPOSITORY_ALIAS"]).toBeUndefined();
  });

  it("requires the host to bind Story identity for issue and repository operations", () => {
    const f = fixture();
    const handoff = prepareRegisteredWorkspaceSkillHandoff({
      manifest,
      skillName: "roll-peer",
      operation: "review",
      context: f.alpha.context,
      expectedWorkspaceId: "alpha",
      repositorySelector: "product",
      skillBody: "# roll-peer",
    });

    expect(handoff).toMatchObject({ ok: false, code: "missing_expected_story_identity" });
  });

  it.each([
    ["roll-doc-audit", "audit"],
    ["roll-.dream", "scan"],
    ["roll-.changelog", "generate"],
  ] as const)("fails closed for %s on missing, unknown, or ambiguous multi-repository selector", (skillName, operation) => {
    const f = fixture();
    const prepare = (context: WorkspaceExecutionContextV1, repositorySelector?: string) =>
      prepareRegisteredWorkspaceSkillHandoff({
        manifest,
        skillName,
        operation,
        context,
        expectedWorkspaceId: "alpha",
        expectedStoryId: "US-WS-038",
        repositorySelector,
        skillBody: `# ${skillName}`,
      });

    expect(prepare(f.alpha.context)).toMatchObject({ ok: false, code: "repository_selector_required" });
    expect(prepare(f.alpha.context, "missing")).toMatchObject({ ok: false, code: "unknown_repository_selector" });
    const ambiguous = workspaceContext(join(dirname(f.arbitraryCwd), "workspace-ambiguous"), "alpha", true);
    expect(prepare(ambiguous.context, ambiguous.repoIds[0])).toMatchObject({ ok: false, code: "ambiguous_repository_selector" });
  });

  it("fails closed for unknown, duplicate, or incomplete operation registry rows", () => {
    const f = fixture();
    const prepare = (candidateManifest: unknown, operation = "review") => prepareRegisteredWorkspaceSkillHandoff({
      manifest: candidateManifest,
      skillName: "roll-peer",
      operation,
      context: f.alpha.context,
      expectedWorkspaceId: "alpha",
      expectedStoryId: "US-WS-038",
      repositorySelector: "product",
      skillBody: "# roll-peer",
    });
    expect(prepare(manifest, "unknown")).toMatchObject({ ok: false, code: "missing_skill_policy" });
    expect(prepare({ workspaceContextPolicies: [
      ...manifest.workspaceContextPolicies,
      manifest.workspaceContextPolicies[1],
    ] }))
      .toMatchObject({ ok: false, code: "duplicate_skill_policy" });
    const { access: _access, ...incomplete } = manifest.workspaceContextPolicies[0]!;
    expect(prepare({ workspaceContextPolicies: [manifest.workspaceContextPolicies[0], incomplete] }, "review"))
      .toMatchObject({ ok: false, code: "duplicate_skill_policy" });
    expect(prepare({ workspaceContextPolicies: [incomplete] }))
      .toMatchObject({ ok: false, code: "missing_skill_execution_policy" });
    const { access: _docAccess, ...incompleteDocAudit } = manifest.workspaceContextPolicies[1]!;
    expect(prepare({ workspaceContextPolicies: [manifest.workspaceContextPolicies[0], incompleteDocAudit] }))
      .toMatchObject({ ok: false, code: "missing_skill_execution_policy" });
    expect(prepare({ workspaceContextPolicies: [{
      surface: "skill",
      id: "roll-peer",
      operation: "review",
      scope: "machine_only",
      access: "none",
      repositorySelector: "required",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: false,
    }] }))
      .toMatchObject({ ok: false, code: "invalid_skill_execution_policy" });
    expect(prepare({ workspaceContextPolicies: [{
      surface: "skill",
      id: "roll-peer",
      operation: "review",
      scope: "legacy_migration_only",
      access: "none",
      repositorySelector: "forbidden",
      allowsAmbientCwd: false,
      allowsLegacyRollPath: true,
    }] }))
      .toMatchObject({ ok: false, code: "invalid_skill_execution_policy" });
  });
});
