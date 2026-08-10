/**
 * US-DELTA-004 — artifact-only Delta handoff enforcement (pure validators).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DeltaArtifactManifest, DeltaRole, ManagedWorkspaceSet } from "@roll/spec";
import {
  builderSubmissionSnapshotsMatch,
  expectedWorktreeAccess,
  observeBuilderSubmission,
  validateBuilderSubmission,
  validateDeltaManifest,
  validateDigests,
  validateEvidenceFormat,
  validateHostAttestation,
  validateIdentityDistinct,
  validatePaths,
  validateRoleAccess,
  type BuilderObservationResult,
  type BuilderSubmissionContext,
  type BuilderSubmissionObserver,
  type BuilderSubmissionSnapshot,
} from "../src/index.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function manifest(role: DeltaRole, over: Partial<DeltaArtifactManifest> = {}): DeltaArtifactManifest {
  return {
    schemaVersion: 2,
    delegationId: "d1",
    storyId: "US-X-1",
    role,
    trigger: "manual",
    topology: "delta-team",
    qualityProfile: "verified",
    executionIdentity: { kind: "roll-adapter", hostId: "h1", roleInstanceId: `${role}-1`, modelId: "m1" },
    sessionId: `${role}-sess`,
    worktreeAccess: expectedWorktreeAccess(role),
    inputs: [],
    outputs: [],
    createdAt: "2026-07-24T00:00:00Z",
    ...over,
  } as DeltaArtifactManifest;
}

describe("validateRoleAccess", () => {
  it("accepts the correct worktreeAccess per role; flags a non-builder claiming write", () => {
    expect(validateRoleAccess(manifest("designer")).ok).toBe(true);
    expect(validateRoleAccess(manifest("builder")).ok).toBe(true);
    const r = validateRoleAccess(manifest("evaluator", { worktreeAccess: "builder-write" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("role_write_violation");
  });
  it("rejects a raw chat/log artifact as a handoff input", () => {
    const r = validateRoleAccess(manifest("builder", { inputs: [{ path: "role-artifacts/builder/chat.log", kind: "log" }] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("artifact_invalid");
  });
});

describe("validatePaths", () => {
  it("blocks a path that escapes the evidence directory", () => {
    const m = manifest("builder", { outputs: [{ path: "../../etc/passwd", kind: "evidence", sha256: "x" }] });
    const r = validatePaths(m, (p) => !p.includes(".."));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("artifact_invalid");
  });
  it("allows contained paths", () => {
    const m = manifest("builder", { outputs: [{ path: "role-artifacts/builder/e.md", kind: "evidence", sha256: "x" }] });
    expect(validatePaths(m, () => true).ok).toBe(true);
  });
});

describe("validateDigests", () => {
  it("passes when every output digest matches the file content", () => {
    const body = "evidence body";
    const m = manifest("builder", { outputs: [{ path: "e.md", kind: "evidence", sha256: sha(body) }] });
    expect(validateDigests(m, () => body).ok).toBe(true);
  });
  it("blocks on a digest mismatch, a missing digest, and a missing file", () => {
    const m1 = manifest("builder", { outputs: [{ path: "e.md", kind: "evidence", sha256: sha("real") }] });
    expect(validateDigests(m1, () => "tampered").reason).toBe("artifact_invalid");
    const m2 = manifest("builder", { outputs: [{ path: "e.md", kind: "evidence" }] });
    expect(validateDigests(m2, () => "x").reason).toBe("artifact_invalid");
    const m3 = manifest("builder", { outputs: [{ path: "e.md", kind: "evidence", sha256: "x" }] });
    expect(validateDigests(m3, () => null).reason).toBe("artifact_invalid");
  });
});

describe("validateHostAttestation", () => {
  it("roll-adapter needs no attestation", () => {
    expect(validateHostAttestation(manifest("designer")).ok).toBe(true);
  });
  it("host-native requires a non-empty, role-matching attestation", () => {
    const base = manifest("designer", { executionIdentity: { kind: "host-native", hostId: "h", roleInstanceId: "r", modelId: "m" } });
    expect(validateHostAttestation(base).reason).toBe("host_attestation_invalid"); // none
    const att = { schema: "roll-delta-host-attestation/v1", hostId: "h", role: "designer", roleInstanceId: "r", modelId: "m", sessionId: "s", assertedAt: "t" } as const;
    expect(validateHostAttestation({ ...base, hostAttestation: att } as DeltaArtifactManifest).ok).toBe(true);
    expect(validateHostAttestation({ ...base, hostAttestation: { ...att, sessionId: "" } } as DeltaArtifactManifest).reason).toBe("host_attestation_invalid");
    expect(validateHostAttestation({ ...base, hostAttestation: { ...att, role: "builder" } } as DeltaArtifactManifest).reason).toBe("host_attestation_invalid");
  });
});

describe("validateIdentityDistinct", () => {
  it("blocks when evaluator shares the builder's sessionId or roleInstanceId", () => {
    const builder = manifest("builder");
    expect(validateIdentityDistinct(manifest("evaluator"), builder).ok).toBe(true);
    expect(validateIdentityDistinct(manifest("evaluator", { sessionId: "builder-sess" }), builder).reason).toBe("identity_collision");
    const dup = manifest("evaluator", { executionIdentity: { kind: "roll-adapter", hostId: "h", roleInstanceId: "builder-1", modelId: "m" } });
    expect(validateIdentityDistinct(dup, builder).reason).toBe("identity_collision");
  });
});

describe("validateEvidenceFormat", () => {
  it("builder evidence needs commit/diff, commands/tests, evidence, limitations; no merge rec", () => {
    const good = "## commit abc\ncommands: tests run\nevidence: screenshot\nknown limitations: none";
    expect(validateEvidenceFormat("builder", good).ok).toBe(true);
    expect(validateEvidenceFormat("builder", "just some notes").reason).toBe("artifact_invalid");
    const withMerge = `${good}\nI recommend we merge this now`;
    expect(validateEvidenceFormat("builder", withMerge).reason).toBe("artifact_invalid");
  });
  it("eval report needs Inputs checked + Rationale", () => {
    expect(validateEvidenceFormat("evaluator", "## Inputs checked\n...\n## Rationale\n...").ok).toBe(true);
    expect(validateEvidenceFormat("evaluator", "## Rationale\n...").reason).toBe("artifact_invalid");
  });
});

describe("validateDeltaManifest (composed, deterministic first-failure)", () => {
  it("passes a clean builder manifest", () => {
    const body = "## commit abc\ncommands: tests\nevidence: x\nlimitations: none";
    const m = manifest("builder", { outputs: [{ path: "e.md", kind: "evidence", sha256: sha(body) }] });
    const r = validateDeltaManifest(m, { contains: () => true, readBytes: () => body, evidenceContent: body });
    expect(r.ok).toBe(true);
  });
  it("role access failure wins over later checks (deterministic order)", () => {
    const m = manifest("evaluator", { worktreeAccess: "builder-write", outputs: [{ path: "../x", kind: "report", sha256: "y" }] });
    const r = validateDeltaManifest(m, { contains: () => false, readBytes: () => null });
    expect(r.reason).toBe("role_write_violation");
  });
});

// ── US-DELTA-015 — shared read-only Builder submission check ────────────────

const HEAD = "a".repeat(40);
const EVIDENCE = "## commit abc\ncommands: tests run\nevidence: x\n## Known Limitations\nnone\n";

function builderContext(over: Partial<BuilderSubmissionContext> = {}): BuilderSubmissionContext {
  const workspace: ManagedWorkspaceSet = {
    schema: 1,
    runId: "delta-d1",
    storyId: "US-X-1",
    kind: "host_delta",
    topology: "delta-team",
    delegationId: "d1",
    members: [{
      repositoryId: "repo",
      workspaceKey: "delta-d1",
      relativeLocator: "delta-d1",
      checkoutRef: { kind: "detached", head: HEAD },
      publishRef: "refs/heads/roll/d1",
    }],
  };
  return {
    delegationId: "d1",
    storyId: "US-X-1",
    trigger: "host-guided",
    topology: "delta-team",
    qualityProfile: "verified",
    runId: "delta-d1",
    workspace,
    frameDir: "/frame",
    manifestPath: "/frame/role-artifacts/builder/evaluation-manifest.json",
    ...over,
  };
}

function builderManifest(over: Partial<DeltaArtifactManifest> = {}): DeltaArtifactManifest {
  return {
    schemaVersion: 2,
    delegationId: "d1",
    storyId: "US-X-1",
    role: "builder",
    trigger: "host-guided",
    topology: "delta-team",
    qualityProfile: "verified",
    runId: "delta-d1",
    workspaceMember: {
      workspaceKey: "delta-d1",
      relativeLocator: "delta-d1",
      checkoutRef: { kind: "detached", head: HEAD },
      publishRef: "refs/heads/roll/d1",
      executionCwd: "/frame",
    },
    executionIdentity: { kind: "roll-adapter", hostId: "h", roleInstanceId: "b1", modelId: "m" },
    sessionId: "b-sess",
    worktreeAccess: "builder-write",
    inputs: [],
    outputs: [{ kind: "evidence", path: "role-artifacts/builder/evidence.md", sha256: sha(EVIDENCE) }],
    createdAt: "2026-07-24T00:00:00Z",
    ...over,
  } as DeltaArtifactManifest;
}

function filesObserver(files: Record<string, string>, over: Partial<BuilderSubmissionObserver> = {}): BuilderSubmissionObserver {
  return {
    contains: () => true,
    readBytes: (p) => (p in files ? files[p] : null),
    readMemberHeads: (members) => members.map((m) => ({ relativeLocator: m.relativeLocator, head: HEAD })),
    verifyMemberBinding: () => true,
    ...over,
  };
}

describe("US-DELTA-015 — observeBuilderSubmission (read-only)", () => {
  it("captures heads, manifest digest, and output digests from a clean submission", () => {
    const manifestBytes = JSON.stringify(builderManifest());
    const files = {
      [builderContext().manifestPath]: manifestBytes,
      "role-artifacts/builder/evidence.md": EVIDENCE,
    };
    const result = observeBuilderSubmission(builderContext(), filesObserver(files));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.heads.workspaceRunId).toBe("delta-d1");
    expect(result.snapshot.heads.members).toEqual([{ relativeLocator: "delta-d1", head: HEAD }]);
    expect(result.snapshot.manifestSha256).toBe(sha(manifestBytes));
    expect(result.snapshot.outputSha256).toEqual([{ path: "role-artifacts/builder/evidence.md", sha256: sha(EVIDENCE) }]);
    expect(result.evidenceContent).toBe(EVIDENCE);
  });

  it("fails read-only on a missing manifest", () => {
    const r = observeBuilderSubmission(builderContext(), filesObserver({}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("artifact_invalid");
    expect(r.detail).toContain("Stage artifact not found for role 'builder'");
  });

  it("rejects a non-v2 manifest, a wrong role, and a runId mismatch", () => {
    const v1 = { ...builderManifest(), schemaVersion: 1 };
    expect(observeBuilderSubmission(builderContext(), filesObserver({ [builderContext().manifestPath]: JSON.stringify(v1) })).ok).toBe(false);
    const wrongRole = { ...builderManifest(), role: "designer" as const };
    const r = observeBuilderSubmission(builderContext(), filesObserver({ [builderContext().manifestPath]: JSON.stringify(wrongRole) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("manifest role 'designer'");
    const wrongRun = { ...builderManifest(), runId: "delta-other" };
    const r2 = observeBuilderSubmission(builderContext(), filesObserver({ [builderContext().manifestPath]: JSON.stringify(wrongRun) }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.detail).toContain("not bound to a registered canonical");
  });

  it("fails when the member binding is missing, unverified, or heads unobservable", () => {
    const files = { [builderContext().manifestPath]: JSON.stringify(builderManifest()), "role-artifacts/builder/evidence.md": EVIDENCE };
    expect(observeBuilderSubmission(builderContext(), filesObserver(files)).ok).toBe(true);
    const foreign = builderManifest({ workspaceMember: { ...builderManifest().workspaceMember!, relativeLocator: "delta-other" } });
    const filesForeign = { [builderContext().manifestPath]: JSON.stringify(foreign), "role-artifacts/builder/evidence.md": EVIDENCE };
    const unbound = observeBuilderSubmission(builderContext(), filesObserver(filesForeign));
    expect(unbound.ok).toBe(false); // manifest member locator not in workspace → binding missing
    const denied = observeBuilderSubmission(builderContext(), filesObserver(files, { verifyMemberBinding: () => false }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.detail).toContain("not bound to a registered canonical");
    const unobservable = observeBuilderSubmission(builderContext(), filesObserver(files, { readMemberHeads: () => null }));
    expect(unobservable.ok).toBe(false);
    if (!unobservable.ok) expect(unobservable.detail).toContain("unobservable");
  });

  it("fails read-only when evidence/output artifacts are missing on disk", () => {
    const files = { [builderContext().manifestPath]: JSON.stringify(builderManifest()) };
    const noEvidence = observeBuilderSubmission(builderContext(), filesObserver(files));
    expect(noEvidence.ok).toBe(false);
    if (!noEvidence.ok) expect(noEvidence.detail).toContain("builder evidence artifact missing on disk");
    const extraOutput = builderManifest({ outputs: [
      { kind: "evidence", path: "role-artifacts/builder/evidence.md", sha256: sha(EVIDENCE) },
      { kind: "evidence", path: "role-artifacts/builder/extra.md", sha256: sha("x") },
    ] });
    const files2 = { [builderContext().manifestPath]: JSON.stringify(extraOutput), "role-artifacts/builder/evidence.md": EVIDENCE };
    const missingOutput = observeBuilderSubmission(builderContext(), filesObserver(files2));
    expect(missingOutput.ok).toBe(false);
    if (!missingOutput.ok) expect(missingOutput.detail).toContain("output artifact missing on disk: role-artifacts/builder/extra.md");
  });

  it("fails when no evidence-kind output is declared", () => {
    const noEvidenceKind = builderManifest({ outputs: [] });
    const files = { [builderContext().manifestPath]: JSON.stringify(noEvidenceKind) };
    const r = observeBuilderSubmission(builderContext(), filesObserver(files));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("declares no 'evidence' output");
  });
});

describe("US-DELTA-015 — validateBuilderSubmission (pure)", () => {
  function observed(): { context: BuilderSubmissionContext; manifest: DeltaArtifactManifest; snapshot: BuilderSubmissionSnapshot; evidenceContent: string } {
    const context = builderContext();
    const manifest = builderManifest();
    const files = { [context.manifestPath]: JSON.stringify(manifest), "role-artifacts/builder/evidence.md": EVIDENCE };
    const result = observeBuilderSubmission(context, filesObserver(files)) as BuilderObservationResult & { ok: true };
    expect(result.ok).toBe(true);
    return { context, manifest, snapshot: result.snapshot, evidenceContent: result.evidenceContent };
  }

  it("passes a clean builder submission end-to-end", () => {
    const { context, manifest, snapshot, evidenceContent } = observed();
    expect(validateBuilderSubmission(context, manifest, snapshot, evidenceContent).ok).toBe(true);
  });

  it("rejects immutable-context mismatch with the prepared delegation", () => {
    const { context, manifest, snapshot, evidenceContent } = observed();
    const r = validateBuilderSubmission(context, { ...manifest, delegationId: "other" }, snapshot, evidenceContent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("does not match the immutable prepared delegation");
  });

  it("rejects role-access, path-escape, digest-mismatch, attestation, and format failures", () => {
    const { context, manifest, snapshot, evidenceContent } = observed();
    const writeViolation = validateBuilderSubmission(context, { ...manifest, worktreeAccess: "read-only" }, snapshot, evidenceContent);
    expect(writeViolation.reason).toBe("role_write_violation");
    const escape = validateBuilderSubmission(context, {
      ...manifest,
      outputs: [{ kind: "evidence", path: "role-artifacts/builder/evidence.md", sha256: sha(EVIDENCE) }, { kind: "evidence", path: "../escape.md", sha256: sha("x") }],
    }, snapshot, evidenceContent);
    expect(escape.reason).toBe("artifact_invalid");
    const digestMismatch = validateBuilderSubmission(context, {
      ...manifest,
      outputs: [{ kind: "evidence", path: "role-artifacts/builder/evidence.md", sha256: sha("tampered") }],
    }, snapshot, evidenceContent);
    expect(digestMismatch.reason).toBe("artifact_invalid");
    if (!digestMismatch.ok) expect(digestMismatch.detail).toContain("digest mismatch for role-artifacts/builder/evidence.md");
    const noAttestation = validateBuilderSubmission(context, {
      ...manifest,
      executionIdentity: { kind: "host-native", hostId: "h", roleInstanceId: "b1", modelId: "m" },
    }, snapshot, evidenceContent);
    expect(noAttestation.reason).toBe("host_attestation_invalid");
    const badFormat = validateBuilderSubmission(context, manifest, snapshot, "just some notes");
    expect(badFormat.reason).toBe("artifact_invalid");
  });
});

describe("US-DELTA-015 — builderSubmissionSnapshotsMatch (TOCTOU equality)", () => {
  const base: BuilderSubmissionSnapshot = {
    heads: { workspaceRunId: "delta-d1", members: [{ relativeLocator: "delta-d1", head: HEAD }], observedAt: 1 },
    manifestSha256: "m".repeat(64),
    outputSha256: [{ path: "role-artifacts/builder/evidence.md", sha256: "o".repeat(64) }],
  };

  it("ignores observedAt and accepts identical observations", () => {
    expect(builderSubmissionSnapshotsMatch(base, { ...base, heads: { ...base.heads, observedAt: 2 } })).toBe(true);
    expect(builderSubmissionSnapshotsMatch(base, base)).toBe(true);
  });

  it("detects a changed member head, manifest digest, or output digest", () => {
    expect(builderSubmissionSnapshotsMatch(base, { ...base, heads: { ...base.heads, members: [{ relativeLocator: "delta-d1", head: "b".repeat(40) }] } })).toBe(false);
    expect(builderSubmissionSnapshotsMatch(base, { ...base, manifestSha256: "n".repeat(64) })).toBe(false);
    expect(builderSubmissionSnapshotsMatch(base, { ...base, outputSha256: [{ path: "role-artifacts/builder/evidence.md", sha256: "p".repeat(64) }] })).toBe(false);
    expect(builderSubmissionSnapshotsMatch(base, { ...base, outputSha256: [] })).toBe(false);
    expect(builderSubmissionSnapshotsMatch(base, { ...base, heads: { ...base.heads, members: [] } })).toBe(false);
  });
});
