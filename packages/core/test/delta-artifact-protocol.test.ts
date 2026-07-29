/**
 * US-DELTA-004 — artifact-only Delta handoff enforcement (pure validators).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DeltaArtifactManifest, DeltaRole } from "@roll/spec";
import {
  expectedWorktreeAccess,
  validateDeltaManifest,
  validateDigests,
  validateEvidenceFormat,
  validateHostAttestation,
  validateIdentityDistinct,
  validatePaths,
  validateRoleAccess,
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
