import { describe, expect, it } from "vitest";
import {
  parseHistoricalMigrationFacts,
  type HistoricalMigrationFacts,
} from "@roll/spec";
import { planHistoricalWorkspaceMigration } from "../src/workspace/migration.js";

const DIGESTS = {
  backlog: "b".repeat(64),
  contract: "f".repeat(64),
  evidence: "e".repeat(64),
  design: "d".repeat(64),
  requirement: "a".repeat(64),
  runtime: "1".repeat(64),
  projection: "2".repeat(64),
  unknown: "3".repeat(64),
  rebuildable: "c".repeat(64),
} as const;

function rawFacts(): Record<string, unknown> {
  return {
    schema: "roll.workspace-migration-facts/v1",
    sourceRoot: "/tmp/repo",
    repoId: "repo-ab12cd34ef56",
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
    rollInventory: [
      { kind: "file", path: "custom.txt", digest: DIGESTS.unknown, bytes: 80, sourceClass: "unknown" },
      { kind: "file", path: "features/US-1/evidence.json", digest: DIGESTS.evidence, bytes: 30, sourceClass: "story_evidence", storyId: "US-1" },
      { kind: "file", path: "backlog.md", digest: DIGESTS.backlog, bytes: 10, sourceClass: "backlog" },
      { kind: "file", path: "tmp/cache.bin", digest: DIGESTS.rebuildable, bytes: 90, sourceClass: "rebuildable" },
      { kind: "file", path: "domain/context-map.md", digest: DIGESTS.design, bytes: 40, sourceClass: "design" },
      { kind: "file", path: "features/US-1/spec.md", digest: DIGESTS.contract, bytes: 20, sourceClass: "story_contract", storyId: "US-1" },
      { kind: "file", path: "context/jira.md", digest: DIGESTS.requirement, bytes: 50, sourceClass: "requirement" },
      { kind: "file", path: "dossier/index.html", digest: DIGESTS.projection, bytes: 70, sourceClass: "projection" },
      { kind: "file", path: "loop/runs.jsonl", digest: DIGESTS.runtime, bytes: 60, sourceClass: "runtime" },
    ],
    cache: { status: "absent", repoId: "repo-ab12cd34ef56", cachePath: "repos/repo-ab12cd34ef56.git" },
    registry: { status: "available", workspaceId: "ws-ab12cd34ef56" },
  };
}

function facts(raw: Record<string, unknown> = rawFacts()): HistoricalMigrationFacts {
  const parsed = parseHistoricalMigrationFacts(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

function replace(raw: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  return { ...raw, [key]: value };
}

describe("US-WS-019 deterministic historical Workspace migration planner", () => {
  it("freezes every ordinary inventory mapping and portable repository default", () => {
    const input = facts();
    const plan = planHistoricalWorkspaceMigration(input);

    expect({ facts: input, plan }).toMatchSnapshot("complete-facts-plan");
    expect(plan).toMatchObject({
      verdict: "ready",
      workspaceId: "ws-ab12cd34ef56",
      workspaceRoot: "workspaces/ws-ab12cd34ef56",
      repository: {
        alias: "primary",
        repoId: "repo-ab12cd34ef56",
        integrationBranch: "main",
        cachePath: "repos/repo-ab12cd34ef56.git",
      },
    });
    expect(plan.mappings).toHaveLength(9);
  });

  it("rejects unknown schemas, keys and enum values before planning", () => {
    const unknownTop = parseHistoricalMigrationFacts({ ...rawFacts(), surprise: true });
    const unknownNested = parseHistoricalMigrationFacts({
      ...rawFacts(),
      runtime: { activeCycleIds: [], activeStoryLeases: [], pid: 12 },
    });
    const unknownEnum = parseHistoricalMigrationFacts({
      ...rawFacts(),
      cache: { status: "stale", repoId: "repo-ab12cd34ef56", cachePath: "repos/repo-ab12cd34ef56.git" },
    });
    const unknownVersion = parseHistoricalMigrationFacts({ ...rawFacts(), schema: "roll.workspace-migration-facts/v2" });

    expect(unknownTop).toMatchObject({ ok: false, errors: [{ code: "unknown_field", path: "surprise" }] });
    expect(unknownNested).toMatchObject({ ok: false, errors: [{ code: "unknown_field", path: "runtime.pid" }] });
    expect(unknownEnum).toMatchObject({ ok: false, errors: [{ code: "invalid_value", path: "cache.status" }] });
    expect(unknownVersion).toMatchObject({ ok: false, errors: [{ code: "unknown_version", path: "schema" }] });
  });

  it("rejects credential-bearing or non-normalized remote identities", () => {
    const raw = rawFacts();
    const parsed = parseHistoricalMigrationFacts({
      ...raw,
      git: {
        ...(raw["git"] as Record<string, unknown>),
        remote: {
          kind: "verified",
          normalizedRemote: "https://token@git.example.test/team/product?secret=1",
          defaultBranch: "main",
          defaultTip: "1".repeat(40),
          headReachable: true,
          defaultTipPresentLocally: true,
        },
      },
    });

    expect(parsed).toMatchObject({ ok: false, errors: [{ code: "unsafe_remote", path: "git.remote.normalizedRemote" }] });
  });

  it.each([
    ["dirty", "none", { kind: "verified", normalizedRemote: "ssh://git.example.test/team/product", defaultBranch: "main", defaultTip: "1".repeat(40), headReachable: true, defaultTipPresentLocally: true }, "product_dirty"],
    ["in_flight", "rebase", { kind: "verified", normalizedRemote: "ssh://git.example.test/team/product", defaultBranch: "main", defaultTip: "1".repeat(40), headReachable: true, defaultTipPresentLocally: true }, "product_operation_in_flight"],
    ["clean", "none", { kind: "blocked", code: "head_unpushed", normalizedRemote: "ssh://git.example.test/team/product", defaultBranch: "main" }, "head_unpushed"],
    ["clean", "none", { kind: "blocked", code: "remote_missing" }, "remote_missing"],
    ["clean", "none", { kind: "blocked", code: "remote_default_ambiguous", normalizedRemote: "ssh://git.example.test/team/product" }, "remote_default_ambiguous"],
    ["clean", "none", { kind: "blocked", code: "remote_truth_unverifiable", normalizedRemote: "ssh://git.example.test/team/product", defaultBranch: "main" }, "remote_truth_unverifiable"],
  ] as const)("maps product safety state %s to %s", (state, operation, remote, code) => {
    const raw = rawFacts();
    const plan = planHistoricalWorkspaceMigration(facts({
      ...raw,
      git: { ...(raw["git"] as Record<string, unknown>), state, operation, dirtyPaths: state === "dirty" ? ["z.txt", "a.txt"] : [], remote },
    }));

    expect(plan.verdict).toBe("migration_blocked");
    expect(plan.findings).toContainEqual(expect.objectContaining({ severity: "error", code }));
  });

  it("blocks unsafe linked worktrees, submodules, active runtime, cache and registry facts", () => {
    const raw = rawFacts();
    const plan = planHistoricalWorkspaceMigration(facts({
      ...raw,
      linkedWorktrees: [{ pathToken: "wt-b", head: "2".repeat(40), state: "prunable" }],
      submodules: [{ path: "vendor/a", head: null, state: "uninitialized", remote: null }],
      runtime: { activeCycleIds: ["cycle-b"], activeStoryLeases: ["US-9"] },
      cache: { status: "conflict", repoId: "repo-deadbeef0000", cachePath: "repos/repo-deadbeef0000.git" },
      registry: { status: "repo_conflict", workspaceId: "ws-ab12cd34ef56" },
    }));

    expect(plan.verdict).toBe("migration_blocked");
    expect(plan.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code)).toEqual([
      "linked_worktree_unsafe",
      "submodule_unsafe",
      "active_runtime",
      "active_runtime",
      "cache_conflict",
      "workspace_conflict",
    ]);
  });

  it("blocks every symlink without following, copying or omitting it", () => {
    const raw = rawFacts();
    const inventory = raw["rollInventory"] as unknown[];
    const plan = planHistoricalWorkspaceMigration(facts({
      ...raw,
      rollInventory: [...inventory, { kind: "symlink", path: "features/current", target: "/private/secret" }],
    }));

    expect(plan.verdict).toBe("migration_blocked");
    expect(plan.findings).toContainEqual({ severity: "error", code: "roll_symlink_unsupported", path: "features/current" });
    expect(plan.mappings.some((mapping) => mapping.source === "features/current")).toBe(false);
  });

  it("does not bind a blocked symlink plan ID to its host-specific target", () => {
    const raw = rawFacts();
    const inventory = raw["rollInventory"] as unknown[];
    const withTarget = (target: string) => facts({
      ...raw,
      rollInventory: [...inventory, { kind: "symlink", path: "features/current", target }],
    });

    expect(planHistoricalWorkspaceMigration(withTarget("/private/host-a/source")).planId)
      .toBe(planHistoricalWorkspaceMigration(withTarget("/mnt/host-b/source")).planId);
  });

  it("emits a sorted repository-only ownership cutover contract", () => {
    const raw = rawFacts();
    const plan = planHistoricalWorkspaceMigration(facts({
      ...raw,
      rollOwnership: { kind: "product_tracked", trackedPaths: ["features/US-1/spec.md", "backlog.md"] },
    }));

    expect(plan).toMatchObject({
      verdict: "repository_cutover_required",
      repositoryCutover: {
        sourceHead: "1".repeat(40),
        requiredAction: "remove_product_tracking_through_existing_tcr_pr_push_flow",
        trackedEntries: [
          { path: "backlog.md", digest: DIGESTS.backlog },
          { path: "features/US-1/spec.md", digest: DIGESTS.contract },
        ],
      },
    });
  });

  it("never mixes unrelated dirty product work into the ownership cutover", () => {
    const raw = rawFacts();
    const plan = planHistoricalWorkspaceMigration(facts({
      ...raw,
      git: { ...(raw["git"] as Record<string, unknown>), state: "dirty", dirtyPaths: ["src/wip.ts"] },
      rollOwnership: { kind: "product_tracked", trackedPaths: ["backlog.md"] },
    }));

    expect(plan.verdict).toBe("migration_blocked");
    expect("repositoryCutover" in plan).toBe(false);
    expect(plan.findings).toContainEqual({ severity: "error", code: "product_dirty", path: "src/wip.ts" });
  });

  it("reports independent roll-meta identity as manual handoff and copies surface mappings", () => {
    const raw = rawFacts();
    const plan = planHistoricalWorkspaceMigration(facts({
      ...raw,
      rollOwnership: {
        kind: "independent_git",
        gitdirToken: "gitdir-a",
        topLevelToken: "top-a",
        state: "dirty",
        head: "4".repeat(40),
        branch: "main",
        upstream: "origin/main",
        normalizedRemote: "ssh://git.example.test/team/roll-meta",
      },
    }));

    expect(plan).toMatchObject({
      verdict: "manual_metadata_handoff",
      manualHandoff: {
        gitdirToken: "gitdir-a",
        topLevelToken: "top-a",
        state: "dirty",
        head: "4".repeat(40),
        branch: "main",
        upstream: "origin/main",
        normalizedRemote: "ssh://git.example.test/team/roll-meta",
      },
    });
    expect(plan.mappings.filter((mapping) => mapping.action !== "discard_rebuildable").every((mapping) => mapping.action === "copy_preserve" || mapping.action === "import_inactive" || mapping.action === "archive_regenerate" || mapping.action === "quarantine_unclassified")).toBe(true);
  });

  it("normalizes order and excludes source roots from plan identity", () => {
    const first = rawFacts();
    const second = rawFacts();
    second["sourceRoot"] = "/another/host/private/repo";
    second["rollInventory"] = [...(second["rollInventory"] as unknown[])].reverse();
    second["linkedWorktrees"] = [
      { pathToken: "b", head: "2".repeat(40), state: "clean" },
      { pathToken: "a", head: "3".repeat(40), state: "clean" },
    ];
    first["linkedWorktrees"] = [...(second["linkedWorktrees"] as unknown[])].reverse();

    const planA = planHistoricalWorkspaceMigration(facts(first));
    const planB = planHistoricalWorkspaceMigration(facts(second));

    expect(planA.planId).toBe(planB.planId);
    expect(planA).toEqual(planB);
  });

  it("does not bind plan identity to caller object key insertion order", () => {
    const original = facts();
    if (original.git.remote.kind !== "verified") throw new Error("fixture remote must be verified");
    const reordered: HistoricalMigrationFacts = {
      ...original,
      git: {
        remote: {
          defaultTipPresentLocally: true,
          headReachable: true,
          defaultTip: original.git.remote.defaultTip,
          defaultBranch: original.git.remote.defaultBranch,
          normalizedRemote: original.git.remote.normalizedRemote,
          kind: "verified",
        },
        operation: original.git.operation,
        dirtyPaths: original.git.dirtyPaths,
        state: original.git.state,
        head: original.git.head,
      },
      cache: {
        cachePath: original.cache.cachePath,
        repoId: original.cache.repoId,
        status: original.cache.status,
      },
    };

    expect(planHistoricalWorkspaceMigration(reordered).planId)
      .toBe(planHistoricalWorkspaceMigration(original).planId);
  });

  it("rejects tracked ownership paths that are not digest-backed inventory files", () => {
    const raw = rawFacts();
    const parsed = parseHistoricalMigrationFacts(replace(raw, "rollOwnership", {
      kind: "product_tracked",
      trackedPaths: ["missing.md"],
    }));

    expect(parsed).toMatchObject({ ok: false, errors: [{ code: "invalid_value", path: "rollOwnership.trackedPaths[0]" }] });
  });

  it("rejects independent roll-meta object database entries from the surface inventory", () => {
    const raw = rawFacts();
    const parsed = parseHistoricalMigrationFacts({
      ...raw,
      rollOwnership: {
        kind: "independent_git",
        gitdirToken: "gitdir-a",
        topLevelToken: "top-a",
        state: "clean",
        head: "4".repeat(40),
        branch: "main",
        upstream: "origin/main",
        normalizedRemote: "ssh://git.example.test/team/roll-meta",
      },
      rollInventory: [
        ...(raw["rollInventory"] as unknown[]),
        { kind: "file", path: ".git/objects/aa/object", digest: "9".repeat(64), bytes: 12, sourceClass: "unknown" },
      ],
    });

    expect(parsed).toMatchObject({ ok: false, errors: [{ code: "invalid_value", path: "rollInventory[9].path" }] });
  });
});
