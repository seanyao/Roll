import { createHash } from "node:crypto";
import {
  contextReadResultV1Schema,
  type ContextDiagnosticV1,
  type ContextReadResultV1,
} from "@roll/spec";
import { validateJsonSchemaValue } from "../tools/schema.js";

export interface ContextSnapshotReferenceV1 {
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly artifactPath: string;
}

export type ContextSnapshotVerificationV1 =
  | { readonly valid: true; readonly snapshot: ContextReadResultV1; readonly reference: ContextSnapshotReferenceV1 }
  | { readonly valid: false; readonly diagnostic: ContextDiagnosticV1 };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Context Snapshot payload must be JSON-compatible");
}

export function contextSnapshotPayload(snapshot: ContextReadResultV1): Omit<ContextReadResultV1, "snapshotId" | "snapshotDigest" | "artifactPath"> {
  return {
    schema: snapshot.schema,
    createdAt: snapshot.createdAt,
    outcome: snapshot.outcome,
    requestScope: snapshot.requestScope,
    providers: snapshot.providers,
    gaps: snapshot.gaps,
  };
}

export function computeContextSnapshotDigest(snapshot: ContextReadResultV1): string {
  return createHash("sha256").update(canonicalJson(contextSnapshotPayload(snapshot)), "utf8").digest("hex");
}

export function contextSnapshotId(createdAt: string, snapshotDigest: string): string | undefined {
  const epoch = Date.parse(createdAt);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== createdAt || !/^[0-9a-f]{64}$/u.test(snapshotDigest)) {
    return undefined;
  }
  const timestamp = createdAt.replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return `ctx_${timestamp}_${snapshotDigest.slice(0, 12)}`;
}

export function contextSnapshotReference(snapshot: ContextReadResultV1): ContextSnapshotReferenceV1 {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.snapshotDigest,
    artifactPath: snapshot.artifactPath,
  };
}

export function verifyContextSnapshot(value: unknown): ContextSnapshotVerificationV1 {
  const validation = validateJsonSchemaValue(contextReadResultV1Schema, value);
  if (!validation.ok) return invalidSnapshot();
  const snapshot = value as ContextReadResultV1;
  const computedDigest = computeContextSnapshotDigest(snapshot);
  if (
    snapshot.outcome === "disabled" ||
    computedDigest !== snapshot.snapshotDigest ||
    contextSnapshotId(snapshot.createdAt, computedDigest) !== snapshot.snapshotId
  ) return invalidSnapshot();
  return { valid: true, snapshot, reference: contextSnapshotReference(snapshot) };
}

function invalidSnapshot(): ContextSnapshotVerificationV1 {
  return {
    valid: false,
    diagnostic: {
      code: "invalid_context_snapshot",
      severity: "blocking",
      message: "Context Snapshot is invalid",
    },
  };
}
