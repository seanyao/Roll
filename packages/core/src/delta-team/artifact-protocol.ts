/**
 * @responsibility Validates Delta artifact manifests: digests, containment and role write-access.
 * US-DELTA-004 — enforce artifact-only Delta role handoffs.
 *
 * Pure validators for the v2 `DeltaArtifactManifest` protocol: digest
 * cross-checks, path containment, role write-access, host-attestation structure,
 * cross-role identity distinctness, and role evidence format. Roll validates the
 * PROTOCOL (named, checksummed, path-contained artifacts against role contracts)
 * — never that a host truly ran a fresh session or a given model. All I/O is
 * injected so this is fully unit-testable.
 */
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { ArtifactRef, DeltaArtifactManifest, DeltaBlockReason, DeltaRole, ManagedWorkspaceSet } from "@roll/spec";

export interface ProtocolResult {
  ok: boolean;
  reason?: DeltaBlockReason;
  detail?: string;
}
const OK: ProtocolResult = { ok: true };
function block(reason: DeltaBlockReason, detail: string): ProtocolResult {
  return { ok: false, reason, detail };
}

/**
 * The ONE digest primitive for the v2 artifact protocol: sha256 of an artifact's
 * bytes as lowercase hex. {@link validateDigests} cross-checks a manifest's
 * declared `sha256` against this, and any producer that records an artifact digest
 * (e.g. the repair briefing, US-CYCLE-007) MUST use this same function so there is
 * exactly one digest scheme, never a parallel one.
 */
export function computeArtifactSha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Worktree access each role's manifest MUST declare (only the Builder writes). */
export function expectedWorktreeAccess(role: DeltaRole): "read-only" | "builder-write" {
  return role === "builder" ? "builder-write" : "read-only";
}

/** `log` artifacts are raw conversation/transcript — never a valid handoff input. */
function isRawChat(ref: ArtifactRef): boolean {
  return ref.kind === "log";
}

/**
 * AC: worktreeAccess must match the role; raw chat/log artifacts are rejected as
 * handoff inputs. A non-Builder manifest claiming `builder-write` is a
 * role_write_violation.
 */
export function validateRoleAccess(m: DeltaArtifactManifest): ProtocolResult {
  const expected = expectedWorktreeAccess(m.role);
  if (m.worktreeAccess !== expected) {
    return block(
      "role_write_violation",
      `role '${m.role}' declares worktreeAccess '${m.worktreeAccess}', expected '${expected}'`,
    );
  }
  const badInput = m.inputs.find(isRawChat);
  if (badInput !== undefined) {
    return block("artifact_invalid", `raw chat/log artifact is not a valid handoff input: ${badInput.path}`);
  }
  return OK;
}

/**
 * AC: every artifact path must resolve WITHIN the delegation evidence directory
 * (no traversal / absolute escape). `contains(evidenceDir, path)` is injected so
 * the check is platform-deterministic and testable.
 */
export function validatePaths(
  m: DeltaArtifactManifest,
  contains: (path: string) => boolean,
): ProtocolResult {
  for (const ref of [...m.inputs, ...m.outputs]) {
    if (!contains(ref.path)) {
      return block("artifact_invalid", `artifact path escapes the delegation evidence directory: ${ref.path}`);
    }
  }
  return OK;
}

/**
 * AC: every output ArtifactRef.sha256 must match the actual file content; a
 * mismatch (or a missing digest / unreadable file) blocks before the next stage.
 * `readBytes(path)` returns the file bytes or null when absent.
 */
export function validateDigests(
  m: DeltaArtifactManifest,
  readBytes: (path: string) => Buffer | string | null,
): ProtocolResult {
  for (const ref of m.outputs) {
    if (ref.sha256 === undefined || ref.sha256 === "") {
      return block("artifact_invalid", `output artifact has no sha256 digest: ${ref.path}`);
    }
    const bytes = readBytes(ref.path);
    if (bytes === null) {
      return block("artifact_invalid", `output artifact missing on disk: ${ref.path}`);
    }
    const actual = computeArtifactSha256(bytes);
    if (actual !== ref.sha256) {
      return block("artifact_invalid", `digest mismatch for ${ref.path}: manifest ${ref.sha256} ≠ actual ${actual}`);
    }
  }
  return OK;
}

/**
 * AC: a `host-native` manifest requires a matching hostAttestation with
 * non-empty hostId/role/roleInstanceId/modelId/sessionId, and its role must
 * correspond to the manifest role. Structural validation only — never treated as
 * proof the host ran the session. `roll-adapter` manifests need no attestation.
 */
export function validateHostAttestation(m: DeltaArtifactManifest): ProtocolResult {
  if (m.executionIdentity.kind !== "host-native") return OK;
  const att = m.hostAttestation;
  if (att === undefined) {
    return block("host_attestation_invalid", `host-native manifest for role '${m.role}' has no hostAttestation`);
  }
  const empty = (["hostId", "role", "roleInstanceId", "modelId", "sessionId"] as const).find(
    (k) => typeof att[k] !== "string" || (att[k] as string).trim() === "",
  );
  if (empty !== undefined) {
    return block("host_attestation_invalid", `hostAttestation.${empty} is missing or empty`);
  }
  if (att.role !== m.role) {
    return block("host_attestation_invalid", `hostAttestation.role '${att.role}' ≠ manifest role '${m.role}'`);
  }
  return OK;
}

/**
 * AC: the Evaluator's opaque `sessionId` and `roleInstanceId` must both differ
 * from the Builder's — structural token inequality only. Equal token → collision.
 */
export function validateIdentityDistinct(
  evaluator: DeltaArtifactManifest,
  builder: DeltaArtifactManifest,
): ProtocolResult {
  if (evaluator.sessionId === builder.sessionId) {
    return block("identity_collision", `evaluator sessionId equals builder sessionId ('${evaluator.sessionId}')`);
  }
  if (evaluator.executionIdentity.roleInstanceId === builder.executionIdentity.roleInstanceId) {
    return block(
      "identity_collision",
      `evaluator roleInstanceId equals builder roleInstanceId ('${evaluator.executionIdentity.roleInstanceId}')`,
    );
  }
  return OK;
}

/**
 * AC: role evidence format.
 *  - Builder `execute-evidence.md`: must reference commit/diff, commands/tests,
 *    produced evidence, and known limitations; must NOT contain a merge
 *    recommendation (that is the Evaluator's verdict, not the Builder's).
 *  - Evaluator `eval-report.md`: must include `## Inputs checked` and
 *    `## Rationale` sections.
 */
export function validateEvidenceFormat(role: DeltaRole, content: string): ProtocolResult {
  const lc = content.toLowerCase();
  if (role === "builder") {
    const needs: Array<[RegExp, string]> = [
      [/\b(commit|diff)\b/, "a commit/diff reference"],
      [/\b(command|test)s?\b/, "commands/tests run"],
      [/\bevidence\b/, "produced evidence"],
      [/\b(limitation|known limit|caveat)/, "known limitations"],
    ];
    const missing = needs.find(([re]) => !re.test(lc));
    if (missing !== undefined) {
      return block("artifact_invalid", `builder evidence missing ${missing[1]}`);
    }
    if (/\bmerge\b/.test(lc) && /\b(recommend|approve|ship|should merge)\b/.test(lc)) {
      return block("artifact_invalid", "builder evidence must not contain a merge recommendation (that is the evaluator's verdict)");
    }
    return OK;
  }
  if (role === "evaluator") {
    if (!/^##\s+inputs checked/im.test(content)) {
      return block("artifact_invalid", "eval report missing '## Inputs checked' section");
    }
    if (!/^##\s+rationale/im.test(content)) {
      return block("artifact_invalid", "eval report missing '## Rationale' section");
    }
    return OK;
  }
  return OK;
}

export interface DeltaArtifactChecks {
  /** Resolve whether an artifact path is contained within the evidence dir. */
  contains: (path: string) => boolean;
  /** Read an artifact's bytes for the digest check (null when absent). */
  readBytes: (path: string) => Buffer | string | null;
  /** The Builder manifest, for evaluator identity-distinctness (when validating an evaluator). */
  builderManifest?: DeltaArtifactManifest;
  /** Role evidence content, for format validation (when available). */
  evidenceContent?: string;
}

/**
 * Compose every applicable protocol check for one role manifest, in a fixed
 * order (role access → paths → digests → attestation → identity → format). The
 * FIRST failing check wins so the block reason is deterministic.
 */
export function validateDeltaManifest(m: DeltaArtifactManifest, checks: DeltaArtifactChecks): ProtocolResult {
  const ordered: ProtocolResult[] = [
    validateRoleAccess(m),
    validatePaths(m, checks.contains),
    validateDigests(m, checks.readBytes),
    validateHostAttestation(m),
  ];
  if (m.role === "evaluator" && checks.builderManifest !== undefined) {
    ordered.push(validateIdentityDistinct(m, checks.builderManifest));
  }
  if (checks.evidenceContent !== undefined) {
    ordered.push(validateEvidenceFormat(m.role, checks.evidenceContent));
  }
  return ordered.find((r) => !r.ok) ?? OK;
}

// ── US-DELTA-015 — shared read-only Builder submission check ─────────────────
//
// `roll delta preflight --stage builder` and the formal managed Builder
// validation share ONE read-only operation. Observation captures a complete
// in-memory snapshot (managed member detached heads, manifest digest, output
// digests); validation is pure over the supplied immutable context and that
// snapshot. Neither accepts a persisted `preflight passed` fact, and neither
// appends an event or changes a lease/frame/workspace/checkpoint. Formal
// validation alone re-observes from fresh state and, only on an unchanged
// success, writes the single matching `builder_validation` checkpoint.

/** Immutable, host-observed context a Builder submission must match. */
export interface BuilderSubmissionContext {
  readonly delegationId: string;
  readonly storyId: string;
  readonly trigger: string;
  readonly topology: string;
  readonly qualityProfile: string;
  readonly runId: string;
  readonly workspace: ManagedWorkspaceSet;
  /** Frame directory — the only base for artifact path containment. */
  readonly frameDir: string;
  /** Fixed path to the Builder stage manifest. */
  readonly manifestPath: string;
}

export interface ObservedBuilderHead {
  readonly relativeLocator: string;
  readonly head: string;
}

export interface ObservedBuilderHeads {
  readonly workspaceRunId: string;
  readonly members: readonly ObservedBuilderHead[];
  readonly observedAt: number;
}

/**
 * The complete read-only observation of one Builder submission. `observedAt`
 * is metadata for diagnostics only — it never participates in equality, so a
 * re-observation of the same bytes is byte-identical for TOCTOU purposes.
 */
export interface BuilderSubmissionSnapshot {
  readonly heads: ObservedBuilderHeads;
  readonly manifestSha256: string;
  readonly outputSha256: readonly { readonly path: string; readonly sha256: string }[];
}

/** Injected read-only I/O boundary — observation never persists anything. */
export interface BuilderSubmissionObserver {
  /** Resolve whether an artifact path is contained within the frame evidence dir. */
  contains: (path: string) => boolean;
  /** Read an artifact's bytes within the frame (null when absent). */
  readBytes: (path: string) => Buffer | string | null;
  /**
   * Observe every managed member's current detached head (null when any member
   * is unobservable — never an empty/zero-member success).
   */
  readMemberHeads: (
    members: readonly { readonly relativeLocator: string }[],
  ) => readonly ObservedBuilderHead[] | null;
  /**
   * Verify the manifest member binding against the observed heads: registered
   * managed worktree, detached HEAD, repository identity, and asserted
   * canonical execution cwd. Read-only; accepts only the observed snapshot
   * head, the allocation base, or a previously release-requested head.
   */
  verifyMemberBinding: (
    binding: NonNullable<DeltaArtifactManifest["workspaceMember"]>,
    observedHeads: readonly ObservedBuilderHead[],
  ) => boolean;
}

export type BuilderObservationResult =
  | {
      readonly ok: true;
      readonly manifest: DeltaArtifactManifest;
      readonly snapshot: BuilderSubmissionSnapshot;
      readonly evidenceContent: string;
    }
  | { readonly ok: false; readonly reason: DeltaBlockReason; readonly detail: string };

/**
 * Read-only observation of the current Builder submission. Covers the checks
 * that are structural READS: manifest presence/schema/role, managed member
 * binding + detached heads, and readable evidence/output artifacts. Never
 * writes an event, lease, frame, workspace, or checkpoint.
 */
export function observeBuilderSubmission(
  context: BuilderSubmissionContext,
  observer: BuilderSubmissionObserver,
): BuilderObservationResult {
  const manifestBytes = observer.readBytes(context.manifestPath);
  if (manifestBytes === null) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: `Stage artifact not found for role 'builder' at ${context.manifestPath}`,
    };
  }
  let manifest: DeltaArtifactManifest;
  try {
    const parsed = JSON.parse(String(manifestBytes)) as { schemaVersion?: unknown; role?: unknown };
    if (parsed.schemaVersion !== 2) {
      return {
        ok: false,
        reason: "artifact_invalid",
        detail: `manifest at ${context.manifestPath} is not schemaVersion 2 (a new Delta run requires a v2 manifest)`,
      };
    }
    manifest = parsed as unknown as DeltaArtifactManifest;
  } catch (e) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: `manifest unreadable/invalid JSON at ${context.manifestPath}: ${String(e)}`,
    };
  }
  if (manifest.role !== "builder") {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: `manifest role '${manifest.role}' ≠ validated stage 'builder'`,
    };
  }
  if (manifest.runId !== context.runId) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: "manifest is not bound to a registered canonical DeliveryRun managed workspace member",
    };
  }
  const binding = manifest.workspaceMember;
  const member = binding === undefined ? undefined : context.workspace.members.find((candidate) =>
    candidate.workspaceKey === binding.workspaceKey
    && candidate.relativeLocator === binding.relativeLocator
    && candidate.checkoutRef.kind === binding.checkoutRef.kind
    && candidate.publishRef === binding.publishRef,
  );
  const heads = observer.readMemberHeads(context.workspace.members);
  if (heads === null) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: "managed workspace member heads are unobservable",
    };
  }
  if (member === undefined || binding === undefined || !observer.verifyMemberBinding(binding, heads)) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: "manifest is not bound to a registered canonical DeliveryRun managed workspace member",
    };
  }
  const evidenceRef = manifest.outputs.find((output) => output.kind === "evidence");
  if (evidenceRef === undefined) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: "builder manifest declares no 'evidence' output",
    };
  }
  const evidenceContent = observer.readBytes(evidenceRef.path);
  if (evidenceContent === null) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: `builder evidence artifact missing on disk: ${evidenceRef.path}`,
    };
  }
  const outputSha256: { readonly path: string; readonly sha256: string }[] = [];
  for (const ref of manifest.outputs) {
    const bytes = observer.readBytes(ref.path);
    if (bytes === null) {
      return {
        ok: false,
        reason: "artifact_invalid",
        detail: `output artifact missing on disk: ${ref.path}`,
      };
    }
    outputSha256.push({ path: ref.path, sha256: computeArtifactSha256(bytes) });
  }
  return {
    ok: true,
    manifest,
    evidenceContent: String(evidenceContent),
    snapshot: {
      heads: {
        workspaceRunId: context.workspace.runId,
        members: heads,
        observedAt: Date.now(),
      },
      manifestSha256: computeArtifactSha256(manifestBytes),
      outputSha256,
    },
  };
}

/**
 * Pure validation over the immutable context and an already-observed snapshot:
 * immutable-context correspondence, role access, path containment, snapshot
 * digests vs declared digests, host attestation, and Builder evidence format.
 * Performs no I/O and persists nothing.
 */
export function validateBuilderSubmission(
  context: BuilderSubmissionContext,
  manifest: DeltaArtifactManifest,
  snapshot: BuilderSubmissionSnapshot,
  evidenceContent: string,
): ProtocolResult {
  if (
    manifest.delegationId !== context.delegationId
    || manifest.storyId !== context.storyId
    || manifest.trigger !== context.trigger
    || manifest.topology !== context.topology
    || manifest.qualityProfile !== context.qualityProfile
  ) {
    return block("artifact_invalid", "manifest delegation context does not match the immutable prepared delegation");
  }
  const contains = (path: string): boolean => {
    const abs = resolve(context.frameDir, path);
    return abs === context.frameDir || abs.startsWith(context.frameDir + sep);
  };
  const ordered: ProtocolResult[] = [
    validateRoleAccess(manifest),
    validatePaths(manifest, contains),
    validateSnapshotDigests(manifest, snapshot),
    validateHostAttestation(manifest),
    validateEvidenceFormat("builder", evidenceContent),
  ];
  return ordered.find((r) => !r.ok) ?? OK;
}

/**
 * AC: every output ArtifactRef.sha256 must equal the digest OBSERVED in the
 * snapshot (same reason/detail contract as {@link validateDigests}, minus I/O).
 */
export function validateSnapshotDigests(
  m: DeltaArtifactManifest,
  snapshot: BuilderSubmissionSnapshot,
): ProtocolResult {
  const observedByPath = new Map(snapshot.outputSha256.map((o) => [o.path, o.sha256]));
  for (const ref of m.outputs) {
    if (ref.sha256 === undefined || ref.sha256 === "") {
      return block("artifact_invalid", `output artifact has no sha256 digest: ${ref.path}`);
    }
    const observed = observedByPath.get(ref.path);
    if (observed === undefined) {
      return block("artifact_invalid", `output artifact missing on disk: ${ref.path}`);
    }
    if (observed !== ref.sha256) {
      return block("artifact_invalid", `digest mismatch for ${ref.path}: manifest ${ref.sha256} ≠ actual ${observed}`);
    }
  }
  return OK;
}

/**
 * TOCTOU equality over two observations of the same Builder submission.
 * `observedAt` is diagnostic metadata and deliberately excluded: a re-check
 * of identical heads/digests must compare as equal.
 */
export function builderSubmissionSnapshotsMatch(
  a: BuilderSubmissionSnapshot,
  b: BuilderSubmissionSnapshot,
): boolean {
  if (a.heads.workspaceRunId !== b.heads.workspaceRunId || a.manifestSha256 !== b.manifestSha256) return false;
  if (a.heads.members.length !== b.heads.members.length || a.outputSha256.length !== b.outputSha256.length) return false;
  for (let i = 0; i < a.heads.members.length; i++) {
    const x = a.heads.members[i]!;
    const y = b.heads.members[i]!;
    if (x.relativeLocator !== y.relativeLocator || x.head !== y.head) return false;
  }
  for (let i = 0; i < a.outputSha256.length; i++) {
    const x = a.outputSha256[i]!;
    const y = b.outputSha256[i]!;
    if (x.path !== y.path || x.sha256 !== y.sha256) return false;
  }
  return true;
}
