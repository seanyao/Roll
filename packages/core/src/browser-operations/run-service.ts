/**
 * @responsibility Owns the managed browser run aggregate state machine and idempotency.
 * US-BROW-004a — Managed run service core.
 *
 * BrowserOperationRun aggregate: owns lane, idempotency key, temporary-profile
 * lifecycle state, and terminal diagnostic result. This is the pure domain
 * state machine — no Chrome/DevTools adapter (004b) or CLI surface (004c).
 *
 * Design invariants (managed-devtools-plan.md §3):
 * - Temporary profile lifecycle: created → active → removed (both success
 *   and failure must terminate at "removed").
 * - Categorized diagnostic failures (timeout / crash / DevTools error) are a
 *   discriminated union — they cannot type as a passing assertion (AC2).
 * - Same idempotency key → one run; retry replays terminal result (AC3).
 */
import type { BrowserCaller, BrowserDenialReason, BrowserLane, BrowserOperationRun, DiagnosticArtifactRef } from "@roll/spec";

// ── Diagnostic failure (AC2) ────────────────────────────────────────────────

/** Categories of diagnostic failure that are NOT passing assertions. */
export type DiagnosticFailureCategory = "timeout" | "crash" | "devtools-error";

/**
 * A categorized diagnostic failure.
 *
 * The discriminated `RunTerminalResult` union ensures a failure CANNOT be
 * expressed as `{ kind: "pass" }` — the type system rejects confusion.
 */
export interface DiagnosticFailure {
  category: DiagnosticFailureCategory;
  message: string;
  /** ISO-8601 timestamp when the failure was recorded. */
  at: string;
}

// ── Terminal result (discriminated — AC2 type-safety gate) ──────────────────

/**
 * The terminal outcome of a run.
 *
 * Discriminated union: a failure is never `{ kind: "pass" }`, and callers
 * must narrow before accessing variant-specific fields. This is the AC2
 * type-safety gate.
 */
export type RunTerminalResult =
  | { readonly kind: "pass"; readonly diagnostics: readonly DiagnosticArtifactRef[] }
  | { readonly kind: "fail"; readonly failures: readonly DiagnosticFailure[]; readonly diagnostics: readonly DiagnosticArtifactRef[] }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: BrowserDenialReason };

// ── Temporary profile lifecycle ─────────────────────────────────────────────

/**
 * Lifecycle of a managed-lane temporary Chrome profile.
 *
 *   created → active → removed   (normal)
 *   created → removed            (creation failure — must still clean up)
 *
 * Both success and failure paths MUST reach "removed" (invariant).
 */
export type TempProfileState = "created" | "active" | "removed";

/** All states; used for transition validation. */
const PROFILE_STATES: ReadonlySet<TempProfileState> = new Set<TempProfileState>(["created", "active", "removed"]);

/** The terminal profile state. Every run must end here. */
const PROFILE_TERMINAL: TempProfileState = "removed";

// ── Run aggregate ───────────────────────────────────────────────────────────

/**
 * Domain aggregate for a single browser operation run.
 *
 * Owns: lane, idempotency key, temporary profile lifecycle state, accumulated
 * diagnostics, and the terminal diagnostic result. All mutations return a new
 * aggregate (immutable update pattern).
 */
export class BrowserOperationRunService {
  private constructor(
    readonly run: BrowserOperationRun,
    readonly profileState: TempProfileState,
    readonly diagnosticFailures: readonly DiagnosticFailure[],
    private readonly now: () => string,
  ) {}

  // ── Factory ─────────────────────────────────────────────────────────────

  /**
   * Create a new run aggregate in "requested" state. Profile starts at "created".
   */
  static create(params: {
    runId: string;
    idempotencyKey: string;
    storyId?: string;
    cycleId?: string;
    caller: BrowserCaller;
    lane: BrowserLane;
    requestedOrigin: string;
    holderTokenHash: string;
    now?: () => string;
  }): BrowserOperationRunService {
    const clock = params.now ?? (() => new Date().toISOString());
    const run: BrowserOperationRun = {
      runId: params.runId,
      idempotencyKey: params.idempotencyKey,
      storyId: params.storyId,
      cycleId: params.cycleId,
      caller: params.caller,
      lane: params.lane,
      requestedOrigin: params.requestedOrigin,
      policyFingerprint: "",
      holderTokenHash: params.holderTokenHash,
      state: "requested",
      diagnostics: [],
      result: "skipped",
    };
    return new BrowserOperationRunService(run, "created", [], clock);
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Whether the run has reached a terminal state and will not change further. */
  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.run.state);
  }

  /** The terminal result, or undefined if not yet terminal. */
  terminalResult(): RunTerminalResult | undefined {
    switch (this.run.state) {
      case "passed":
        return { kind: "pass", diagnostics: this.run.diagnostics };
      case "failed":
        return { kind: "fail", failures: this.diagnosticFailures, diagnostics: this.run.diagnostics };
      case "denied":
        return { kind: "denied", reason: DENIED_REASON };
      case "expired":
        return { kind: "skipped", reason: "run expired" };
      default:
        return undefined;
    }
  }

  /** Whether the profile lifecycle has reached its terminal state. */
  isProfileRemoved(): boolean {
    return this.profileState === "removed";
  }

  // ── State transitions ──────────────────────────────────────────────────

  /**
   * Authorize the run with a policy fingerprint.
   * `requested → authorized`
   */
  authorize(policyFingerprint: string): BrowserOperationRunService {
    this.assertState("requested");
    return this.update({ state: "authorized", policyFingerprint });
  }

  /**
   * Start execution.
   * `authorized → running`
   */
  start(): BrowserOperationRunService {
    this.assertState("authorized");
    return this.update({ state: "running", startedAt: this.now() });
  }

  /**
   * Mark the run as passed (terminal).
   * `running → passed`
   */
  pass(): BrowserOperationRunService {
    this.assertState("running");
    return this.update({ state: "passed", endedAt: this.now(), result: "pass" });
  }

  /**
   * Mark the run as failed with categorized diagnostic failures (terminal).
   * `running → failed`
   *
   * At least one DiagnosticFailure is required — this cannot be used to
   * express a passing assertion (AC2 type-safety gate).
   */
  fail(failures: DiagnosticFailure[]): BrowserOperationRunService {
    this.assertState("running");
    if (failures.length === 0) {
      throw new Error("fail() requires at least one DiagnosticFailure");
    }
    return this.update({
      state: "failed",
      endedAt: this.now(),
      result: "fail",
      diagnosticFailures: failures,
    });
  }

  /**
   * Deny the run — policy rejected the operation (terminal).
   * Any non-terminal state → denied
   */
  deny(): BrowserOperationRunService {
    if (this.isTerminal()) {
      throw new Error(`Cannot deny run in terminal state "${this.run.state}"`);
    }
    return this.update({ state: "denied", endedAt: this.now(), result: "denied" });
  }

  /**
   * Expire the run — timeout or TTL exceeded (terminal).
   * `running → expired`
   */
  expire(): BrowserOperationRunService {
    this.assertState("running");
    return this.update({
      state: "expired",
      endedAt: this.now(),
      result: "skipped",
      diagnosticFailures: [{ category: "timeout", message: "Run exceeded its TTL", at: this.now() }],
    });
  }

  // ── Profile lifecycle transitions ──────────────────────────────────────

  /**
   * Mark the temporary profile as active (ready for browser use).
   * `created → active`
   */
  activateProfile(): BrowserOperationRunService {
    this.assertProfileState("created");
    return this.withProfile("active");
  }

  /**
   * Mark the temporary profile as removed (cleaned up).
   * `created → removed` or `active → removed`
   *
   * Both success and failure paths must reach "removed" (invariant).
   */
  removeProfile(): BrowserOperationRunService {
    if (this.profileState === "removed") {
      return this; // idempotent
    }
    if (!PROFILE_STATES.has(this.profileState)) {
      throw new Error(`Unknown profile state: ${this.profileState}`);
    }
    return this.withProfile("removed");
  }

  // ── Diagnostics ────────────────────────────────────────────────────────

  /** Accumulate a diagnostic artifact on the run. */
  addDiagnostic(ref: DiagnosticArtifactRef): BrowserOperationRunService {
    return this.update({ diagnostics: [...this.run.diagnostics, ref] });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private assertState(expected: string): void {
    if (this.run.state !== expected) {
      throw new Error(`Expected run state "${expected}" but was "${this.run.state}"`);
    }
  }

  private assertProfileState(expected: TempProfileState): void {
    if (this.profileState !== expected) {
      throw new Error(`Expected profile state "${expected}" but was "${this.profileState}"`);
    }
  }

  private update(patch: Partial<{
    state: BrowserOperationRun["state"];
    policyFingerprint: string;
    startedAt: string;
    endedAt: string;
    result: BrowserOperationRun["result"];
    diagnostics: DiagnosticArtifactRef[];
    diagnosticFailures: DiagnosticFailure[];
  }>): BrowserOperationRunService {
    const run: BrowserOperationRun = {
      ...this.run,
      state: patch.state ?? this.run.state,
      policyFingerprint: patch.policyFingerprint ?? this.run.policyFingerprint,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : this.run.startedAt,
      endedAt: patch.endedAt !== undefined ? patch.endedAt : this.run.endedAt,
      result: patch.result ?? this.run.result,
      diagnostics: patch.diagnostics ?? this.run.diagnostics,
    };
    const failures = patch.diagnosticFailures ?? this.diagnosticFailures;
    return new BrowserOperationRunService(run, this.profileState, failures, this.now);
  }

  private withProfile(profileState: TempProfileState): BrowserOperationRunService {
    return new BrowserOperationRunService(this.run, profileState, this.diagnosticFailures, this.now);
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const TERMINAL_STATES: ReadonlySet<BrowserOperationRun["state"]> = new Set([
  "passed",
  "failed",
  "denied",
  "expired",
]);

/** Denial reason used for policy-denied runs. */
const DENIED_REASON: BrowserDenialReason = {
  code: "policy_disabled",
  message: "Operation was denied by policy",
};

// ── Idempotency helpers ─────────────────────────────────────────────────────

/**
 * Check whether a run state represents an active (non-terminal, in-flight) run.
 * Used for idempotency: a new run with the same key MUST NOT create a second
 * active run (AC3).
 */
export function isActiveRunState(state: string): boolean {
  return !TERMINAL_STATES.has(state as BrowserOperationRun["state"]);
}
