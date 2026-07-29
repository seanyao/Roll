import { createHash } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceEditPlan,
  parseWorkspaceEditConfig,
  serializeWorkspaceManifest,
  type WorkspaceMetadataReferenceIndex,
} from "@roll/core";
import { repositoryIdFromRemote, type WorkspaceEditPlan, type WorkspaceManifest } from "@roll/spec";
import {
  captureRequirementSource,
  readWorkspace,
  RequirementSourceStoreError,
} from "../src/requirement-source-store.js";
import {
  applyWorkspaceEditPlan,
  workspaceEditJournalPath,
  WorkspaceEditTransactionError,
} from "../src/workspace-edit-transaction.js";
import { collectWorkspaceMetadataReferenceIndex } from "../src/workspace-reference-index.js";

const roots: string[] = [];

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-edit-transaction-"));
  roots.push(root);
  const rollHome = join(root, ".roll");
  const workspaceRoot = join(root, "workspace");
  const manifestPath = join(workspaceRoot, "workspace.yaml");
  const remote = "https://example.test/owner/product";
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture repository identity must normalize");
  const manifest: WorkspaceManifest = {
    schema: "roll.workspace/v1",
    workspaceId: "ws-demo",
    displayName: "Demo",
    createdAt: "2026-07-20T00:00:00.000Z",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: repoId.value,
      alias: "product",
      remote,
      integrationBranch: "main",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
    }],
  };
  write(manifestPath, manifest);
  const issuePath = join(workspaceRoot, "issues", "US-KEEP", "manifest.json");
  const requirementPath = join(workspaceRoot, "requirements", "keep.txt");
  write(issuePath, {
    schema: "roll.issue/v1",
    workspaceId: "ws-demo",
    storyId: "US-KEEP",
    requirements: [],
    repositories: [{
      repoId: repoId.value,
      alias: "product",
      access: "write",
      requiredDelivery: true,
      noChangePolicy: "changes_required",
    }],
  });
  mkdirSync(dirname(requirementPath), { recursive: true });
  writeFileSync(requirementPath, "requirement-bytes\n", "utf8");
  return { root, rollHome, workspaceRoot, manifestPath, manifest, issuePath, requirementPath, repoId: repoId.value };
}

function referenceIndex(workspaceId = "ws-demo"): WorkspaceMetadataReferenceIndex {
  return {
    schema: "roll.workspace-metadata-reference-index/v1",
    workspaceId,
    issues: [],
    requirementArchives: [],
    additionalFacts: [],
  };
}

function plan(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}): WorkspaceEditPlan {
  const parsed = parseWorkspaceEditConfig(JSON.stringify({
    schema: "roll.workspace-edit/v1",
    workspace_id: "ws-demo",
    expected_manifest_sha256: digest(serializeWorkspaceManifest(f.manifest)),
    display_name: "Renamed Demo",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      alias: "product",
      remote: "https://example.test/owner/product",
      provider: "github",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: ["test"],
    }],
    ...overrides,
  }), { workspaceId: "ws-demo" });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return buildWorkspaceEditPlan({
    config: parsed.value,
    current: f.manifest,
    references: referenceIndex(),
    manifestPath: f.manifestPath,
  });
}

function transactionInput(f: ReturnType<typeof fixture>, preview: WorkspaceEditPlan) {
  return {
    rollHome: f.rollHome,
    plan: preview,
    reloadCurrent: () => ({
      manifest: readWorkspace(f.workspaceRoot),
      references: collectWorkspaceMetadataReferenceIndex({ workspaceRoot: f.workspaceRoot }),
    }),
    rebuildPlan: ({ manifest, references }: { readonly manifest: WorkspaceManifest; readonly references: WorkspaceMetadataReferenceIndex }) =>
      buildWorkspaceEditPlan({
        config: {
          schema: "roll.workspace-edit/v1",
          workspaceId: "ws-demo",
          expectedManifestSha256: preview.beforeSha256,
          displayName: preview.afterManifest.displayName,
          requirements: preview.afterManifest.requirements,
          repositories: preview.afterManifest.repositories.map((repository) => ({
            alias: repository.alias,
            remote: repository.remote,
            provider: repository.provider,
            integrationBranch: repository.integrationBranch,
            branchPattern: repository.workflow.branchPattern,
            requiredChecks: repository.workflow.requiredChecks,
          })),
        },
        current: manifest,
        references,
        manifestPath: f.manifestPath,
      }),
  };
}

function readJournal(f: ReturnType<typeof fixture>): Record<string, unknown> {
  return JSON.parse(readFileSync(workspaceEditJournalPath(f.rollHome, "ws-demo"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-026 Workspace edit transaction", () => {
  it("rebuilds the plan under lock, atomically applies only workspace.yaml, and removes the committed journal", async () => {
    const f = fixture();
    const preview = plan(f);
    const issueBefore = readFileSync(f.issuePath);
    const requirementBefore = readFileSync(f.requirementPath);
    const phases: string[] = [];
    const lockOrder: string[] = [];
    const input = transactionInput(f, preview);

    const result = await applyWorkspaceEditPlan({
      ...input,
      reloadCurrent: () => {
        lockOrder.push("reload");
        return input.reloadCurrent();
      },
      rebuildPlan: (facts) => {
        lockOrder.push("rebuild");
        return input.rebuildPlan(facts);
      },
    }, {
      onAuthorityLockAcquired: () => lockOrder.push("authority"),
      afterPhase: (phase) => phases.push(phase),
    });

    expect(result).toMatchObject({ outcome: "applied", afterSha256: preview.afterSha256 });
    expect(readWorkspace(f.workspaceRoot).displayName).toBe("Renamed Demo");
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
    expect(existsSync(workspaceEditJournalPath(f.rollHome, "ws-demo"))).toBe(false);
    expect(lockOrder).toEqual(["authority", "reload", "rebuild", "reload"]);
    expect(phases).toEqual([
      "journal_prepared",
      "manifest_temp_fsynced",
      "manifest_renamed",
      "manifest_verified",
      "journal_committed",
      "journal_removed",
    ]);
  });

  it("blocks a Requirement writer inside edit reference reload and rejects the reverse interleaving without deadlock", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);
    const body = join(f.root, "captured-body.md");
    writeFileSync(body, "captured body\n", "utf8");
    let reloadRaceObserved = false;

    await applyWorkspaceEditPlan({
      ...input,
      reloadCurrent: () => {
        if (!reloadRaceObserved) {
          reloadRaceObserved = true;
          expect(() => captureRequirementSource({
            rollHome: f.rollHome,
            workspaceRoot: f.workspaceRoot,
            provider: "jira",
            ref: "SOT-15499",
            revision: "1",
            capturedAt: "2026-07-24T00:00:00.000Z",
            bodyFile: body,
            contextPaths: [],
            storyIds: [],
          })).toThrowError(expect.objectContaining<Partial<RequirementSourceStoreError>>({ code: "concurrent_capture" }));
        }
        return input.reloadCurrent();
      },
    });
    expect(reloadRaceObserved).toBe(true);

    writeFileSync(f.manifestPath, serializeWorkspaceManifest(f.manifest), "utf8");
    const reversePreview = plan(f);
    let competingEdit: Promise<unknown> | undefined;
    const captured = captureRequirementSource({
      rollHome: f.rollHome,
      workspaceRoot: f.workspaceRoot,
      provider: "jira",
      ref: "SOT-15499",
      revision: "1",
      capturedAt: "2026-07-24T00:00:00.000Z",
      bodyFile: body,
      contextPaths: [],
      storyIds: [],
    }, {
      beforeProjection: () => {
        competingEdit ??= applyWorkspaceEditPlan(transactionInput(f, reversePreview));
      },
    });
    expect(captured.outcome).toBe("created");
    await expect(competingEdit).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "concurrent_edit" }),
    );
  });

  it("rejects a new durable reference discovered after preview without touching the manifest", async () => {
    const f = fixture();
    const preview = plan(f, { requirements: [] });
    write(join(f.workspaceRoot, "issues", "US-NEW", "manifest.json"), {
      schema: "roll.issue/v1",
      workspaceId: "ws-demo",
      storyId: "US-NEW",
      requirements: [{ provider: "jira", ref: "SOT-15499" }],
      repositories: [{
        repoId: f.repoId,
        alias: "product",
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
    });
    const before = readFileSync(f.manifestPath);

    await expect(applyWorkspaceEditPlan(transactionInput(f, preview))).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "metadata_referenced" }),
    );
    expect(readFileSync(f.manifestPath)).toEqual(before);
  });

  it("returns manifest_changed when the preview before digest is stale", async () => {
    const f = fixture();
    const preview = plan(f);
    write(f.manifestPath, { ...f.manifest, displayName: "Concurrent edit" });

    await expect(applyWorkspaceEditPlan(transactionInput(f, preview))).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "manifest_changed" }),
    );
  });

  it("recovers a crash after rename as idempotent success and cleans the journal", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);

    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === "manifest_renamed") throw new Error("crash"); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));
    expect(readWorkspace(f.workspaceRoot).displayName).toBe("Renamed Demo");
    expect(existsSync(workspaceEditJournalPath(f.rollHome, "ws-demo"))).toBe(true);

    await expect(applyWorkspaceEditPlan(input)).resolves.toMatchObject({ outcome: "reused" });
    expect(existsSync(workspaceEditJournalPath(f.rollHome, "ws-demo"))).toBe(false);
  });

  it.each([
    ["journal_prepared", "before", "prepared", "applied"],
    ["manifest_temp_fsynced", "before", "prepared", "applied"],
    ["manifest_renamed", "after", "prepared", "reused"],
    ["manifest_verified", "after", "prepared", "reused"],
    ["journal_committed", "after", "committed", "reused"],
    ["journal_removed", "after", "absent", "reused"],
  ] as const)("converges after a crash at public phase %s", async (crashPhase, manifestState, journalState, retryOutcome) => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);
    const manifestBefore = readFileSync(f.manifestPath);
    const issueBefore = readFileSync(f.issuePath);
    const requirementBefore = readFileSync(f.requirementPath);
    const journalPath = workspaceEditJournalPath(f.rollHome, "ws-demo");

    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === crashPhase) throw new Error(`crash:${phase}`); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));

    expect(readFileSync(f.manifestPath)).toEqual(
      manifestState === "before" ? manifestBefore : Buffer.from(serializeWorkspaceManifest(preview.afterManifest), "utf8"),
    );
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
    expect(existsSync(journalPath)).toBe(journalState !== "absent");
    if (journalState !== "absent") {
      const journal = readJournal(f);
      expect(journal["status"]).toBe(journalState);
      const temporary = join(f.workspaceRoot, `.workspace.yaml.${String(journal["transactionId"])}.tmp`);
      expect(existsSync(temporary)).toBe(crashPhase === "manifest_temp_fsynced");
      if (crashPhase === "manifest_temp_fsynced") {
        expect(readFileSync(temporary)).toEqual(Buffer.from(serializeWorkspaceManifest(preview.afterManifest), "utf8"));
      }
    }

    await expect(applyWorkspaceEditPlan(input)).resolves.toMatchObject({ outcome: retryOutcome });
    expect(readFileSync(f.manifestPath)).toEqual(Buffer.from(serializeWorkspaceManifest(preview.afterManifest), "utf8"));
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("fsyncs the manifest temp before the filesystem rename seam publishes it", async () => {
    const f = fixture();
    const preview = plan(f);
    const events: string[] = [];

    await applyWorkspaceEditPlan(transactionInput(f, preview), {
      fsyncFile: (descriptor, path) => {
        fsyncSync(descriptor);
        events.push(`fsync:${path}`);
      },
      renameFile: (from, to) => {
        events.push(`rename:${from}->${to}`);
        renameSync(from, to);
      },
    });

    const manifestRename = events.findIndex((event) => event.endsWith(`->${f.manifestPath}`));
    expect(manifestRename).toBeGreaterThan(0);
    const manifestTemporary = events[manifestRename]?.slice("rename:".length).split("->")[0];
    expect(manifestTemporary).toMatch(/\.workspace\.yaml\.[0-9a-f-]+\.tmp$/u);
    expect(events.indexOf(`fsync:${manifestTemporary}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`fsync:${manifestTemporary}`)).toBeLessThan(manifestRename);
  });

  it("fails closed when the renamed manifest is corrupted before transaction verification", async () => {
    const f = fixture();
    const preview = plan(f);
    const issueBefore = readFileSync(f.issuePath);
    const requirementBefore = readFileSync(f.requirementPath);
    const journalPath = workspaceEditJournalPath(f.rollHome, "ws-demo");

    await expect(applyWorkspaceEditPlan(transactionInput(f, preview), {
      afterPhase: (phase) => {
        if (phase === "manifest_renamed") writeFileSync(f.manifestPath, "{corrupt manifest\n", "utf8");
      },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({
      code: "partial_apply_recovered",
      action: "roll workspace doctor ws-demo",
    }));

    expect(readFileSync(f.manifestPath, "utf8")).toBe("{corrupt manifest\n");
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
    expect(readJournal(f)["status"]).toBe("prepared");
    expect(existsSync(journalPath)).toBe(true);
  });

  it("resumes from a durable prepared journal while the manifest still proves the before state", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);

    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === "journal_prepared") throw new Error("crash"); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));
    const journal = JSON.parse(readFileSync(workspaceEditJournalPath(f.rollHome, "ws-demo"), "utf8")) as Record<string, unknown>;
    expect(journal).toMatchObject({
      schema: "roll.workspace-edit-journal/v1",
      status: "prepared",
      beforeSha256: preview.beforeSha256,
      afterSha256: preview.afterSha256,
      referenceIndexSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      afterManifest: preview.afterManifest,
      manifestPath: f.manifestPath,
    });
    expect(readWorkspace(f.workspaceRoot).displayName).toBe("Demo");

    const transactionId = String(journal["transactionId"]);
    writeFileSync(join(f.workspaceRoot, `.workspace.yaml.${transactionId}.tmp`), serializeWorkspaceManifest(preview.afterManifest), "utf8");

    await expect(applyWorkspaceEditPlan(input)).resolves.toMatchObject({ outcome: "applied" });
    expect(readWorkspace(f.workspaceRoot).displayName).toBe("Renamed Demo");
  });

  it("rebuilds from fresh references on a prepared-journal retry and rejects a newly dangerous Issue reference", async () => {
    const f = fixture();
    const preview = plan(f, { requirements: [] });
    const input = transactionInput(f, preview);
    const manifestBefore = readFileSync(f.manifestPath);
    const issueBefore = readFileSync(f.issuePath);
    const requirementBefore = readFileSync(f.requirementPath);

    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === "journal_prepared") throw new Error("crash"); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));
    const journalPath = workspaceEditJournalPath(f.rollHome, "ws-demo");
    expect(existsSync(journalPath)).toBe(true);

    write(join(f.workspaceRoot, "issues", "US-NEW", "manifest.json"), {
      schema: "roll.issue/v1",
      workspaceId: "ws-demo",
      storyId: "US-NEW",
      requirements: [{ provider: "jira", ref: "SOT-15499" }],
      repositories: [{
        repoId: f.repoId,
        alias: "product",
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
    });

    await expect(applyWorkspaceEditPlan(input)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "metadata_referenced" }),
    );
    expect(readFileSync(f.manifestPath)).toEqual(manifestBefore);
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("fails closed when reference authority is corrupt on a prepared-journal retry", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);
    const manifestBefore = readFileSync(f.manifestPath);
    const requirementBefore = readFileSync(f.requirementPath);

    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === "journal_prepared") throw new Error("crash"); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));
    const journalPath = workspaceEditJournalPath(f.rollHome, "ws-demo");
    writeFileSync(f.issuePath, "{invalid issue authority\n", "utf8");
    const corruptedIssue = readFileSync(f.issuePath);

    await expect(applyWorkspaceEditPlan(input)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({
        code: "reference_index_invalid",
        action: "roll workspace doctor ws-demo",
      }),
    );
    expect(readFileSync(f.manifestPath)).toEqual(manifestBefore);
    expect(readFileSync(f.issuePath)).toEqual(corruptedIssue);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rejects a lock-time rebuild whose canonical after digest differs from preview", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);
    const changed = plan(f, { display_name: "Different result" });

    await expect(applyWorkspaceEditPlan({ ...input, rebuildPlan: () => changed })).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "edit_plan_changed" }),
    );
    expect(readWorkspace(f.workspaceRoot).displayName).toBe("Demo");
  });

  it("fails loud when a pending journal can prove neither before nor after", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);
    const issueBefore = readFileSync(f.issuePath);
    const requirementBefore = readFileSync(f.requirementPath);
    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === "journal_prepared") throw new Error("crash"); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));
    write(f.manifestPath, { ...f.manifest, displayName: "Unknown partial" });

    await expect(applyWorkspaceEditPlan(input)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({
        code: "partial_apply_recovered",
        action: "roll workspace doctor ws-demo",
      }),
    );
    expect(existsSync(workspaceEditJournalPath(f.rollHome, "ws-demo"))).toBe(true);
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
  });

  it("fails loud when a committed journal conflicts with an externally restored before manifest", async () => {
    const f = fixture();
    const preview = plan(f);
    const input = transactionInput(f, preview);
    const issueBefore = readFileSync(f.issuePath);
    const requirementBefore = readFileSync(f.requirementPath);
    await expect(applyWorkspaceEditPlan(input, {
      crashPoint: (phase) => { if (phase === "journal_committed") throw new Error("crash"); },
    })).rejects.toEqual(expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "io_failure" }));
    writeFileSync(f.manifestPath, serializeWorkspaceManifest(f.manifest), "utf8");

    await expect(applyWorkspaceEditPlan(input)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceEditTransactionError>>({ code: "partial_apply_recovered" }),
    );
    expect(readFileSync(f.issuePath)).toEqual(issueBefore);
    expect(readFileSync(f.requirementPath)).toEqual(requirementBefore);
  });
});
