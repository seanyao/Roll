/**
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
import type { ArtifactRef, DeltaArtifactManifest, DeltaBlockReason, DeltaRole } from "@roll/spec";

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
