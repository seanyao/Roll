/**
 * @responsibility Owns browser lease approval, binding and exactly-once release semantics.
 * US-BROW-008a — BrowserLease aggregate.
 *
 * Owns owner approval, lease binding, and exactly-once release semantics for
 * interactive browser operations. All persistence goes through BrowserLeaseLock
 * so filesystem atomicity is the single source of mutual exclusion.
 */

import { createHash, randomUUID } from "node:crypto";
import type { BrowserDenialReason, BrowserLease, BrowserOperationEvent } from "@roll/spec";
import { BrowserLeaseLock, nodeProcessAlive, nodeProcessIdentity, type BrowserLeaseLockRecord, leaseLockPath } from "./lease-lock.js";
import { normalizeOrigin } from "./origin.js";

const DEFAULT_MAX_LEASE_MS = 15 * 60 * 1000;

export interface BrowserLeaseGrantInput {
  approval: {
    storyId: string;
    origin: string;
    actionSummary: string;
    requestedMs: number;
    credentialExportDenied: boolean;
  };
  holderPid: number;
  holderToken: string;
  operator: string;
  callerTty: boolean;
  callerIsScheduler: boolean;
}

export type BrowserLeaseGrantResult =
  | { kind: "granted"; lease: BrowserLease }
  | { kind: "denied"; reason: BrowserDenialReason };

export interface BrowserLeaseReleaseResult {
  kind: "released" | "not_found" | "not_holder";
}

export interface BrowserLeaseRecoveryResult {
  kind: "released" | "current";
}

export class BrowserLeaseService {
  constructor(
    private readonly directory: string,
    private readonly lock: BrowserLeaseLock = new BrowserLeaseLock(),
    private readonly emit: (event: BrowserOperationEvent) => void = () => {},
    private readonly isProcessAlive: (pid: number) => boolean = nodeProcessAlive,
    private readonly processIdentity: (pid: number) => string | undefined = nodeProcessIdentity,
    private readonly nowMs: () => number = Date.now,
    private readonly clockIso: () => string = () => new Date().toISOString(),
    private readonly maxLeaseMs: number = DEFAULT_MAX_LEASE_MS,
  ) {}

  /**
   * Attempt to grant a localhost-only, single-holder lease.
   *
   * Denies when:
   * - the approval payload is incomplete
   * - the caller is not a TTY
   * - the caller identity is the scheduler
   * - the origin is not a loopback address
   * - another holder already owns the endpoint lock
   */
  grant(input: BrowserLeaseGrantInput): BrowserLeaseGrantResult {
    const validation = validateGrantInput(input);
    if (validation.kind === "denied") {
      this.emit({
        type: "browser:lease-rejected",
        ts: this.clockIso(),
        storyId: input.approval.storyId ?? "",
        reason: validation.reason,
      });
      return validation;
    }

    const { normalized } = validation;
    const leaseMs = Math.min(input.approval.requestedMs, this.maxLeaseMs);
    const expiresAt = new Date(this.nowMs() + leaseMs).toISOString();
    const epHash = computeEndpointHash(normalized.normalized);
    const leaseId = randomUUID();
    const acquired = this.lock.acquire({
      directory: this.directory,
      endpointHash: epHash,
      leaseId,
      holderPid: input.holderPid,
      holderToken: input.holderToken,
      expiresAt,
      storyId: input.approval.storyId,
      origin: normalized.normalized,
      actionSummary: input.approval.actionSummary,
      credentialExportDenied: input.approval.credentialExportDenied,
    });

    if (acquired.kind !== "acquired") {
      const reason: BrowserDenialReason = {
        code: "interactive_lease_held",
        message: "A lease is already held for this endpoint",
        detail: { holderPid: acquired.holderPid, expiresAt: acquired.expiresAt },
      };
      this.emit({
        type: "browser:lease-rejected",
        ts: this.clockIso(),
        storyId: input.approval.storyId,
        reason,
      });
      return { kind: "denied", reason };
    }

    const record = acquired.record;
    const lease: BrowserLease = {
      leaseId,
      browser: "owner-chrome",
      storyId: input.approval.storyId,
      origin: normalized.normalized,
      scope: "interactive-read-write",
      ownerApproval: {
        approvedAt: this.clockIso(),
        operator: input.operator,
        reason: input.approval.actionSummary,
      },
      acquiredAt: this.clockIso(),
      expiresAt,
      holderPid: input.holderPid,
      holderProcessIdentity: record.holderProcessIdentity,
      holderTokenHash: record.holderTokenHash,
      endpointHash: epHash,
    };

    this.emit({
      type: "browser:lease-granted",
      leaseId,
      ts: this.clockIso(),
      storyId: input.approval.storyId,
      origin: normalized.normalized,
      actionSummary: input.approval.actionSummary,
      expiresAt,
      credentialExportDenied: input.approval.credentialExportDenied,
    });
    return { kind: "granted", lease };
  }

  /** Holder-initiated release. Verifies the holder token before removing the lock. */
  release(lease: BrowserLease, holderToken: string): BrowserLeaseReleaseResult {
    const path = leaseLockPath(this.directory, lease.endpointHash);
    const ok = this.lock.release(path, holderToken);
    if (!ok) {
      const current = this.lock.readRecord(path);
      return current === undefined ? { kind: "not_found" } : { kind: "not_holder" };
    }
    this.emit({ type: "browser:lease-released", leaseId: lease.leaseId, ts: this.clockIso() });
    return { kind: "released" };
  }

  /**
   * Release an expired lease. Idempotent: emits audit events only when this
   * call actually removed the lock.
   */
  releaseIfExpired(origin: string, nowMs = this.nowMs()): BrowserLeaseRecoveryResult {
    const normalized = normalizeOrigin(origin);
    if ("code" in normalized) return { kind: "current" };
    const path = leaseLockPath(this.directory, computeEndpointHash(normalized.normalized));
    const record = this.lock.readRecord(path);
    if (record === undefined) return { kind: "current" };
    if (new Date(record.expiresAt).getTime() > nowMs) return { kind: "current" };
    if (!this.lock.claim(path, record)) return { kind: "current" };
    this.emit({ type: "browser:lease-expired", leaseId: record.leaseId, ts: this.clockIso() });
    this.emit({ type: "browser:lease-released", leaseId: record.leaseId, ts: this.clockIso() });
    return { kind: "released" };
  }

  /**
   * Reclaim a lease whose holder process is dead or whose PID has been reused
   * by a different process. Emits a lease-orphaned audit fact followed by the
   * lease-released fact.
   */
  reclaimDeadHolder(origin: string): BrowserLeaseRecoveryResult {
    const normalized = normalizeOrigin(origin);
    if ("code" in normalized) return { kind: "current" };
    const path = leaseLockPath(this.directory, computeEndpointHash(normalized.normalized));
    const record = this.lock.readRecord(path);
    if (record === undefined || !isStaleHolder(record, this.isProcessAlive, this.processIdentity)) {
      return { kind: "current" };
    }
    if (!this.lock.claim(path, record)) return { kind: "current" };
    this.emit({
      type: "browser:lease-orphaned",
      leaseId: record.leaseId,
      ts: this.clockIso(),
      endpointHash: record.endpointHash,
      holderPid: record.holderPid,
    });
    this.emit({ type: "browser:lease-released", leaseId: record.leaseId, ts: this.clockIso() });
    return { kind: "released" };
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────

type ValidationOk = {
  kind: "ok";
  normalized: { normalized: string; isLoopback: boolean };
};

function validateGrantInput(
  input: BrowserLeaseGrantInput,
): ValidationOk | { kind: "denied"; reason: BrowserDenialReason } {
  const a = input.approval;
  if (
    !a ||
    typeof a.storyId !== "string" || a.storyId === "" ||
    typeof a.origin !== "string" || a.origin === "" ||
    typeof a.actionSummary !== "string" || a.actionSummary === "" ||
    typeof a.requestedMs !== "number" || !Number.isFinite(a.requestedMs) || a.requestedMs <= 0 ||
    a.credentialExportDenied !== true
  ) {
    return {
      kind: "denied",
      reason: {
        code: "interactive_lease_invalid_request",
        message: "Lease approval payload is incomplete or denies credential export",
        detail: { fields: ["storyId", "origin", "actionSummary", "requestedMs", "credentialExportDenied"] },
      },
    };
  }

  if (!input.callerTty) {
    return {
      kind: "denied",
      reason: { code: "interactive_lease_no_tty", message: "Interactive lease requires a TTY caller", detail: { callerTty: input.callerTty } },
    };
  }

  if (input.callerIsScheduler) {
    return {
      kind: "denied",
      reason: { code: "caller_not_allowed", message: "Scheduler identity cannot grant an interactive lease", detail: { callerIsScheduler: true } },
    };
  }

  const normalized = normalizeOrigin(a.origin);
  if ("code" in normalized) {
    return {
      kind: "denied",
      reason: { ...normalized, detail: { origin: a.origin } },
    };
  }
  if (!normalized.isLoopback) {
    return {
      kind: "denied",
      reason: {
        code: "origin_not_allowed",
        message: "Interactive lease is restricted to loopback origins",
        detail: { origin: normalized.normalized },
      },
    };
  }

  return { kind: "ok", normalized };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function computeEndpointHash(origin: string): string {
  return createHash("sha256").update(origin, "utf8").digest("hex");
}

function isStaleHolder(
  record: BrowserLeaseLockRecord,
  alive: (pid: number) => boolean,
  identity: (pid: number) => string | undefined,
): boolean {
  if (!alive(record.holderPid)) return true;
  if (record.holderProcessIdentity === "unknown") return false;
  const current = identity(record.holderPid);
  return current !== undefined && current !== record.holderProcessIdentity;
}
