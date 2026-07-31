/**
 * @responsibility Plans and dispatches independent eligible acceptance-evidence capture lanes.
 * US-EVID-030 — CapturePlanner + CaptureSet execution (slice 3).
 *
 * For a declared web surface, PLAN every policy-eligible capture lane (Roll
 * Capture window capture AND Playwright rendered capture by default) and then
 * ACTUALLY DISPATCH each lane through an injected executor, recording every
 * attempt into ONE CaptureSet via the durable v2 receipt store.
 *
 * Design (best-effort-capture-plan.md → "Orchestration and data flow"):
 *   - Lanes are dispatched INDEPENDENTLY: a skipped / failed / timed-out lane
 *     never suppresses another eligible lane or deletes a taken image. We use
 *     `Promise.allSettled` and never delete artifacts.
 *   - Declared AND final URLs are canonicalized; an accepted artifact maps ONLY
 *     to its declared surface and named ACs; login / foreign redirects are
 *     rejected (reusing `validateCaptureReceiptV2`, never reimplemented).
 *   - Every attempt gets a durable `requested` fact (emitted before dispatch)
 *     and a terminal fact (source, state, reason, timing, digest where taken).
 *   - Idempotency + no-overwrite of an accepted artifact come for free from the
 *     append-only `RollCaptureReceiptStore` (AC5), injected here as a port.
 *
 * Dependency discipline: `@roll/core` depends only on `@roll/spec`, so the
 * durable store (which lives in `@roll/infra`) is injected as a structural
 * `CaptureReceiptStorePort`. The CLI wires the real `RollCaptureReceiptStore`.
 *
 * Harness-owned binding (builder_notes): the planner DERIVES every artifact
 * path and request id from `runDir + surface + source`. Builders never type a
 * capture artifact path.
 */

import {
  type CaptureClass,
  type CaptureIntentV2,
  type CaptureOperationV2,
  type CaptureReceiptState,
  type CaptureReceiptV2,
  type CaptureSource,
  ROLL_CAPTURE_PROTOCOL_V2,
  canonicalizeSurfaceUrl,
  validateCaptureIntentV2,
  validateCaptureReceiptV2,
} from "@roll/spec";

// ── Policy ───────────────────────────────────────────────────────────────────

/** Capture policy for a story (best-effort-capture-plan.md → "Capture policy"). */
export interface CapturePolicy {
  /** Default `best_effort`; other modes fall through to the same lane planning. */
  mode: string;
  /** Eligible capture sources, in preference order. */
  sources: readonly CaptureSource[];
  /** Per-lane dispatch deadline. */
  timeoutMs: number;
  /** Never delete a taken artifact to make room for a retry. */
  preserveAllTaken: boolean;
}

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  mode: "best_effort",
  sources: ["roll-capture-window", "playwright-rendered"],
  timeoutMs: 60_000,
  preserveAllTaken: true,
};

// ── Declared surface + planning context ──────────────────────────────────────

/** A declared visual surface plus its optional physical window selector. */
export interface DeclaredSurface {
  /** The story's `deliverable_url`. */
  declaredUrl: string;
  /** ACs this surface backs — an accepted artifact maps ONLY to these. */
  expectedAcIds: readonly string[];
  /** `capture_window_app`: enables the physical Roll Capture window lane. */
  windowApp?: string;
  /** `capture_window_title`: optional physical window title selector. */
  windowTitle?: string;
}

/** Everything the harness knows to derive intents (paths are NOT builder-typed). */
export interface CapturePlanContext {
  storyId: string;
  runId: string;
  /** Absolute run dir; artifact paths are derived beneath `runDir/screenshots`. */
  runDir: string;
  /** Project root, for v2 intent path-safety validation (must be inside `.roll`). */
  projectRoot: string;
  policy?: CapturePolicy;
}

// ── Planned lanes ────────────────────────────────────────────────────────────

/** A single lane the planner selected, with its fully-derived v2 intent. */
export interface PlannedLane {
  source: CaptureSource;
  operation: CaptureOperationV2;
  captureClass: CaptureClass;
  intent: CaptureIntentV2;
}

/** A lane that was NOT planned, with a concrete reason. */
export interface SkippedLane {
  /** `surface` when the whole surface is unusable; otherwise the source. */
  source: CaptureSource | "surface";
  reason: string;
}

/** The plan: eligible lanes to dispatch + the reasons other lanes were dropped. */
export interface CapturePlan {
  storyId: string;
  runId: string;
  /** Canonical surface id, or null when `declaredUrl` is not a URL. */
  surfaceId: string | null;
  expectedAcIds: readonly string[];
  lanes: PlannedLane[];
  skipped: SkippedLane[];
}

// ── Facts (durable requested + terminal) ─────────────────────────────────────

/** Durable pre-dispatch fact: this lane WILL be attempted. */
export interface CaptureRequestedFact {
  event: "requested";
  requestId: string;
  storyId: string;
  runId: string;
  surfaceId: string;
  source: CaptureSource;
  operation: CaptureOperationV2;
  captureClass: CaptureClass;
  expectedAcIds: readonly string[];
  requestedAt: string;
}

/**
 * How a non-taken lane failed (US-EVID-031). This is the DETERMINISTIC signal the
 * EvidenceHealth resolver reads to tell a poisoned lane apart from a broken machine:
 *   - `infrastructure` — a host/provider/tooling failure, timeout, or skip. No
 *     valid image, but nothing was poisoned. Contributes to `degraded-infrastructure`.
 *   - `invalid-target` — the executor produced a receipt that FAILED validation:
 *     a login page, unapproved redirect, wrong target, corrupt image, or forged
 *     receipt. This BLOCKS as an evidence failure and can never become verified.
 * Absent on a `taken` (accepted) attempt.
 */
export type CaptureFailureKind = "infrastructure" | "invalid-target";

/** Durable terminal fact for one dispatched lane. */
export interface CaptureAttemptFact {
  event: "finished";
  requestId: string;
  storyId: string;
  runId: string;
  surfaceId: string;
  source: CaptureSource;
  captureClass: CaptureClass;
  state: CaptureReceiptState;
  /** Present only for a non-taken attempt (US-EVID-031). */
  failureKind?: CaptureFailureKind;
  reason?: string;
  /** Digest of the taken artifact (only present when `state === "taken"`). */
  sha256?: string;
  screenshotPath?: string;
  finalUrl?: string;
  expectedAcIds: readonly string[];
  accepted: boolean;
  /** Outcome of persisting this attempt into the CaptureSet. */
  persist: "persisted" | "duplicate" | "rejected";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

// ── Injected ports ───────────────────────────────────────────────────────────

/** An injected capture executor for one source (a real Capture.app / browser). */
export interface CaptureLanePort {
  readonly source: CaptureSource;
  /** Attempt the capture. May resolve a terminal receipt, or reject / hang. */
  run(intent: CaptureIntentV2): Promise<CaptureReceiptV2>;
}

/** Mirror of `@roll/infra`'s persist result — structurally compatible. */
export type CaptureReceiptPersistOutcome =
  | { status: "persisted"; receipt: CaptureReceiptV2; captureSetId: string; accepted: boolean }
  | { status: "duplicate"; receipt: CaptureReceiptV2; captureSetId: string; accepted: boolean }
  | { status: "rejected"; reason: string; captureSetId: string; existing?: CaptureReceiptV2 };

/**
 * The durable append-only receipt store, injected as a port. `RollCaptureReceiptStore`
 * from `@roll/infra` satisfies this structurally. Its guards give the planner
 * idempotency and no-overwrite-of-accepted for free (AC5).
 */
export interface CaptureReceiptStorePort {
  persistReceipt(intent: CaptureIntentV2, receipt: CaptureReceiptV2): Promise<CaptureReceiptPersistOutcome>;
  captureSetId(keys: Pick<CaptureReceiptV2, "storyId" | "runId" | "surfaceId">): string;
}

/** Optional durable sink for requested / terminal facts (e.g. a run-dir JSONL). */
export interface CaptureLedgerSink {
  requested(fact: CaptureRequestedFact): void | Promise<void>;
  finished(fact: CaptureAttemptFact): void | Promise<void>;
}

/** Race a promise against a deadline. Injected so timeout tests are deterministic. */
export type WithTimeout = <T>(
  promise: Promise<T>,
  ms: number,
) => Promise<{ timedOut: false; value: T } | { timedOut: true }>;

export interface CapturePlannerDeps {
  now?: () => Date;
  ledger?: CaptureLedgerSink;
  withTimeout?: WithTimeout;
}

// ── Run result ───────────────────────────────────────────────────────────────

/** A receipt that was durably persisted into the CaptureSet (taken or terminal). */
export interface PersistedAttempt {
  intent: CaptureIntentV2;
  receipt: CaptureReceiptV2;
  /**
   * The store's single canonical frozen receipt for this CaptureSet. Only the
   * FIRST taken receipt is frozen; a later taken receipt (e.g. the second lane,
   * or a retry) is retained but never overwrites it (AC5). This is NOT the same
   * as "is a retained image" — for that, check `receipt.state === "taken"`.
   */
  frozenAccepted: boolean;
  captureSetId: string;
  persistStatus: "persisted" | "duplicate";
}

export interface CaptureRunResult {
  surfaceId: string | null;
  captureSetId: string | null;
  requested: CaptureRequestedFact[];
  attempts: CaptureAttemptFact[];
  /** Every non-rejected persisted receipt (for manifest folding: taken + terminal). */
  persisted: PersistedAttempt[];
  /**
   * Every retained taken image (both physical AND rendered), for report
   * attachment. The design keeps ALL taken artifacts; both attach to one
   * CaptureSet (AC6).
   */
  taken: PersistedAttempt[];
}

// ── CapturePlanner ───────────────────────────────────────────────────────────

/** The outcome of one lane's concurrent capture, awaiting serialized persist. */
interface LaneAttempt {
  lane: PlannedLane;
  receiptToPersist: CaptureReceiptV2;
  /** Set when the receipt to persist is non-taken (US-EVID-031). */
  failureKind?: CaptureFailureKind;
  startedAt: string;
  finishedAt: string;
}

export class CapturePlanner {
  private readonly now: () => Date;
  private readonly ledger?: CaptureLedgerSink;
  private readonly withTimeout: WithTimeout;

  constructor(deps: CapturePlannerDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    if (deps.ledger !== undefined) this.ledger = deps.ledger;
    this.withTimeout = deps.withTimeout ?? defaultWithTimeout;
  }

  /**
   * Plan every policy-eligible lane for a declared surface (AC1). Paths and
   * request ids are DERIVED here from `runDir + surface + source` — never typed
   * by a builder (builder_notes). Ineligible lanes get a concrete skip reason.
   */
  plan(surface: DeclaredSurface, ctx: CapturePlanContext): CapturePlan {
    const policy = ctx.policy ?? DEFAULT_CAPTURE_POLICY;
    const surfaceId = canonicalizeSurfaceUrl(surface.declaredUrl);
    const expectedAcIds = [...surface.expectedAcIds];

    const base: CapturePlan = {
      storyId: ctx.storyId,
      runId: ctx.runId,
      surfaceId,
      expectedAcIds,
      lanes: [],
      skipped: [],
    };

    if (surfaceId === null) {
      base.skipped.push({ source: "surface", reason: `declaredUrl "${surface.declaredUrl}" is not a valid URL` });
      return base;
    }
    if (expectedAcIds.length === 0) {
      base.skipped.push({ source: "surface", reason: "surface declares no expectedAcIds; nothing to bind evidence to" });
      return base;
    }

    const slug = slugifySurface(surfaceId);
    const createdAt = this.now().toISOString();

    // Rendered (Playwright) lane — eligible for any valid web surface.
    if (policy.sources.includes("playwright-rendered")) {
      const requestId = deriveRequestId(ctx, slug, "playwright-rendered");
      const intent: CaptureIntentV2 = {
        protocol: ROLL_CAPTURE_PROTOCOL_V2,
        requestId,
        storyId: ctx.storyId,
        runId: ctx.runId,
        surface: { id: surfaceId, declaredUrl: surface.declaredUrl, expectedAcIds },
        operation: "register-rendered",
        source: "playwright-rendered",
        inputPath: deriveArtifactPath(ctx.runDir, slug, "rendered.staged"),
        out: deriveArtifactPath(ctx.runDir, slug, "rendered"),
        timeoutMs: policy.timeoutMs,
        createdAt,
      };
      this.addLane(base, { source: "playwright-rendered", operation: "register-rendered", captureClass: "rendered", intent }, ctx);
    } else {
      base.skipped.push({ source: "playwright-rendered", reason: "playwright-rendered not enabled by capture policy" });
    }

    // Physical (Roll Capture window) lane — eligible only with a window selector.
    if (policy.sources.includes("roll-capture-window")) {
      const app = surface.windowApp?.trim() ?? "";
      if (app === "") {
        base.skipped.push({ source: "roll-capture-window", reason: "no capture_window_app declared; physical window lane not eligible" });
      } else {
        const requestId = deriveRequestId(ctx, slug, "roll-capture-window");
        const intent: CaptureIntentV2 = {
          protocol: ROLL_CAPTURE_PROTOCOL_V2,
          requestId,
          storyId: ctx.storyId,
          runId: ctx.runId,
          surface: { id: surfaceId, declaredUrl: surface.declaredUrl, expectedAcIds },
          operation: "capture-window",
          source: "roll-capture-window",
          target: {
            appName: app,
            ...(surface.windowTitle !== undefined && surface.windowTitle.trim() !== "" ? { windowTitle: surface.windowTitle } : {}),
          },
          out: deriveArtifactPath(ctx.runDir, slug, "physical"),
          timeoutMs: policy.timeoutMs,
          createdAt,
        };
        this.addLane(base, { source: "roll-capture-window", operation: "capture-window", captureClass: "physical", intent }, ctx);
      }
    } else {
      base.skipped.push({ source: "roll-capture-window", reason: "roll-capture-window not enabled by capture policy" });
    }

    return base;
  }

  /** Validate a derived intent before adding it as an eligible lane. */
  private addLane(plan: CapturePlan, lane: PlannedLane, ctx: CapturePlanContext): void {
    const validation = validateCaptureIntentV2(lane.intent, { projectRoot: ctx.projectRoot, expectedRequestId: lane.intent.requestId });
    if (!validation.ok) {
      plan.skipped.push({ source: lane.source, reason: `derived intent invalid: ${validation.errors.join("; ")}` });
      return;
    }
    plan.lanes.push(lane);
  }

  /**
   * Dispatch every planned lane INDEPENDENTLY (AC2) and record all attempts into
   * one CaptureSet (AC4/AC6). A durable `requested` fact is emitted before any
   * dispatch; a terminal fact is recorded for every lane. Lanes never delete
   * another lane's artifact and one failure never aborts the others.
   */
  async run(plan: CapturePlan, lanes: readonly CaptureLanePort[], store: CaptureReceiptStorePort): Promise<CaptureRunResult> {
    const surfaceId = plan.surfaceId;
    if (surfaceId === null || plan.lanes.length === 0) {
      return { surfaceId, captureSetId: null, requested: [], attempts: [], persisted: [], taken: [] };
    }
    const captureSetId = store.captureSetId({ storyId: plan.storyId, runId: plan.runId, surfaceId });

    // Emit ALL requested facts before ANY dispatch (design: record before dispatch).
    const requested: CaptureRequestedFact[] = [];
    for (const lane of plan.lanes) {
      const fact: CaptureRequestedFact = {
        event: "requested",
        requestId: lane.intent.requestId,
        storyId: plan.storyId,
        runId: plan.runId,
        surfaceId,
        source: lane.source,
        operation: lane.operation,
        captureClass: lane.captureClass,
        expectedAcIds: plan.expectedAcIds,
        requestedAt: this.now().toISOString(),
      };
      requested.push(fact);
      await this.ledger?.requested(fact);
    }

    // Independent CONCURRENT dispatch: each lane's capture runs in isolation and
    // never throws out, so one lane failing / hanging / timing out cannot abort
    // or suppress another (AC2). `attemptLane` never rejects.
    const settled = await Promise.allSettled(plan.lanes.map((lane) => this.attemptLane(lane, lanes)));

    // Durable persistence is SERIALIZED: the append-only store's CaptureSet index
    // is a read-modify-write, so concurrent writes to the same set would lose an
    // attempt. Serializing keeps every attempt on one CaptureSet (AC4/AC6) and
    // makes the frozen-accepted ordering deterministic (AC5). The captures above
    // already happened independently; only the ledger write is ordered here.
    const attempts: CaptureAttemptFact[] = [];
    const persisted: PersistedAttempt[] = [];
    const taken: PersistedAttempt[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const lane = plan.lanes[i]!;
      if (s === undefined) continue;
      const attempt =
        s.status === "fulfilled"
          ? s.value
          : {
              lane,
              receiptToPersist: this.terminalReceipt(lane, "failed", `internal dispatch error: ${errorMessage(s.reason)}`, this.now().toISOString()),
              startedAt: this.now().toISOString(),
              finishedAt: this.now().toISOString(),
            };
      const { fact, persistedAttempt } = await this.persistAttempt(attempt, surfaceId, plan.expectedAcIds, store);
      attempts.push(fact);
      await this.ledger?.finished(fact);
      if (persistedAttempt !== null) {
        persisted.push(persistedAttempt);
        if (persistedAttempt.receipt.state === "taken") taken.push(persistedAttempt);
      }
    }

    return { surfaceId, captureSetId, requested, attempts, persisted, taken };
  }

  /** Plan + run in one call. */
  async capture(surface: DeclaredSurface, ctx: CapturePlanContext, lanes: readonly CaptureLanePort[], store: CaptureReceiptStorePort): Promise<CaptureRunResult> {
    return this.run(this.plan(surface, ctx), lanes, store);
  }

  /**
   * Attempt ONE lane's capture. NEVER rejects: a throw / timeout / invalid
   * receipt is turned into a terminal receipt to persist. Runs concurrently with
   * sibling lanes; does not touch the store (persistence is serialized later).
   */
  private async attemptLane(lane: PlannedLane, lanes: readonly CaptureLanePort[]): Promise<LaneAttempt> {
    const startedAt = this.now().toISOString();
    const executor = lanes.find((l) => l.source === lane.source);

    let receiptToPersist: CaptureReceiptV2;
    // US-EVID-031 — classify WHY a lane did not yield a valid image. Every path
    // except a validated `taken` is either an infrastructure failure or a poisoned
    // (invalid-target) receipt; the resolver reads this to keep a broken machine
    // (degraded) apart from a poisoned target (blocking).
    let failureKind: CaptureFailureKind | undefined;
    if (executor === undefined) {
      receiptToPersist = this.terminalReceipt(lane, "skipped", `no capture lane executor injected for source "${lane.source}"`, startedAt);
      failureKind = "infrastructure";
    } else {
      // A never-rejecting settle wrapper so a timeout win cannot leave a floating
      // rejection, and so a hung executor cannot block the sibling lane (AC2).
      const settled = executor
        .run(lane.intent)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error }));
      const raced = await this.withTimeout(settled, lane.intent.timeoutMs);

      if (raced.timedOut) {
        receiptToPersist = this.terminalReceipt(lane, "timeout", `capture lane "${lane.source}" timed out after ${lane.intent.timeoutMs}ms`, startedAt);
        failureKind = "infrastructure";
      } else if (!raced.value.ok) {
        receiptToPersist = this.terminalReceipt(lane, "failed", `capture lane "${lane.source}" threw: ${errorMessage(raced.value.error)}`, startedAt);
        failureKind = "infrastructure";
      } else {
        const produced = raced.value.value;
        // Reuse the shared validator (AC3: login/foreign redirect + forgery rejection).
        const validation = validateCaptureReceiptV2(produced, lane.intent);
        if (validation.ok) {
          receiptToPersist = produced;
          // A produced-and-valid receipt may still be a host-reported non-taken
          // terminal (failed/skipped/timeout): that is an infrastructure gap, not
          // a poisoned target.
          failureKind = produced.state === "taken" ? undefined : "infrastructure";
        } else {
          // An invalid executor receipt (bad target / redirect / forged digest /
          // corrupt image) is NOT accepted; we durably record a failed attempt with
          // the reason, never delete or reuse any artifact the lane may have written,
          // and mark it invalid-target so it BLOCKS and can never read as verified.
          receiptToPersist = this.terminalReceipt(lane, "failed", validation.errors.join("; "), startedAt);
          failureKind = "invalid-target";
        }
      }
    }

    return { lane, receiptToPersist, ...(failureKind !== undefined ? { failureKind } : {}), startedAt, finishedAt: this.now().toISOString() };
  }

  /** Persist one attempted lane (serialized) and build its terminal fact. */
  private async persistAttempt(
    attempt: LaneAttempt,
    surfaceId: string,
    expectedAcIds: readonly string[],
    store: CaptureReceiptStorePort,
  ): Promise<{ fact: CaptureAttemptFact; persistedAttempt: PersistedAttempt | null }> {
    const { lane, receiptToPersist, failureKind, startedAt, finishedAt } = attempt;
    const persistResult = await store.persistReceipt(lane.intent, receiptToPersist);

    let persist: CaptureAttemptFact["persist"];
    let effectiveReceipt = receiptToPersist;
    let persistedAttempt: PersistedAttempt | null = null;
    if (persistResult.status === "rejected") {
      persist = "rejected";
    } else {
      persist = persistResult.status;
      effectiveReceipt = persistResult.receipt;
      persistedAttempt = {
        intent: lane.intent,
        receipt: persistResult.receipt,
        frozenAccepted: persistResult.accepted,
        captureSetId: persistResult.captureSetId,
        persistStatus: persistResult.status,
      };
    }
    // A lane is "accepted" for the report/manifest when it durably produced a
    // retained taken image — both physical AND rendered count (design: retain
    // every taken artifact). The store's single frozen id is a separate concern.
    const accepted = persist !== "rejected" && effectiveReceipt.state === "taken";

    const fact: CaptureAttemptFact = {
      event: "finished",
      requestId: lane.intent.requestId,
      storyId: lane.intent.storyId,
      runId: lane.intent.runId,
      surfaceId,
      source: lane.source,
      captureClass: lane.captureClass,
      state: effectiveReceipt.state,
      ...(effectiveReceipt.state !== "taken" && failureKind !== undefined ? { failureKind } : {}),
      ...(effectiveReceipt.reason !== undefined ? { reason: effectiveReceipt.reason } : persistResult.status === "rejected" ? { reason: persistResult.reason } : {}),
      ...(effectiveReceipt.sha256 !== undefined ? { sha256: effectiveReceipt.sha256 } : {}),
      ...(effectiveReceipt.screenshotPath !== undefined ? { screenshotPath: effectiveReceipt.screenshotPath } : {}),
      ...(effectiveReceipt.finalUrl !== undefined ? { finalUrl: effectiveReceipt.finalUrl } : {}),
      expectedAcIds,
      accepted,
      persist,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    };

    return { fact, persistedAttempt };
  }

  /** Build a well-formed non-taken terminal receipt (durable attempt record). */
  private terminalReceipt(lane: PlannedLane, state: Exclude<CaptureReceiptState, "taken">, reason: string, startedAt: string): CaptureReceiptV2 {
    return {
      protocol: ROLL_CAPTURE_PROTOCOL_V2,
      requestId: lane.intent.requestId,
      storyId: lane.intent.storyId,
      runId: lane.intent.runId,
      surfaceId: lane.intent.surface.id,
      source: lane.source,
      captureClass: lane.captureClass,
      state,
      reason,
      responsePath: `${lane.intent.out}.response.json`,
      startedAt,
      finishedAt: this.now().toISOString(),
    };
  }
}

// ── Derivation helpers (harness-owned) ───────────────────────────────────────

/** Deterministic filesystem-safe slug for a canonical surface id. */
export function slugifySurface(surfaceId: string): string {
  const slug = surfaceId
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return slug === "" ? "surface" : slug;
}

/** Harness-derived request id — builders never type it. */
function deriveRequestId(ctx: CapturePlanContext, slug: string, source: CaptureSource): string {
  return `${ctx.storyId}-${ctx.runId}-${slug}-${source}`.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/-+/gu, "-");
}

/** Harness-derived artifact path under `runDir/screenshots` — never builder-typed. */
function deriveArtifactPath(runDir: string, slug: string, suffix: string): string {
  const dir = runDir.replace(/[/\\]+$/u, "");
  return `${dir}/screenshots/${slug}-${suffix}.png`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultWithTimeout: WithTimeout = async <T>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
