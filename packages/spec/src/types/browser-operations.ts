/**
 * @responsibility Declares the browser operation contracts and policy boundary.
 */
/**
 * US-BROW-001 — Browser operation contracts and policy boundary.
 *
 * Closed request/result contract, lane enum, and permitted action vocabulary.
 * Arbitrary script evaluation is not representable — the action vocabulary
 * is exhaustive and policy-enforced before any transport is selected.
 *
 * Domain model: Browser Operations bounded context.
 * See .roll/features/browser-automation/managed-devtools-plan.md §§3, 5.2, 6.1.
 */

// ── Lane ────────────────────────────────────────────────────────────────────

/** Managed: Roll-launched isolated Chrome (no owner cookies).
 *  Interactive: owner-approved connection to their running Chrome. */
export type BrowserLane = "managed" | "interactive";

// ── Action vocabulary (closed set) ──────────────────────────────────────────

/** Every action a browser operation can perform. Closed set — arbitrary
 *  script evaluation is NOT representable. */
export type BrowserActionKind =
  | "navigate"
  | "click"
  | "fill"
  | "press_key"
  | "snapshot"
  | "console"
  | "network"
  | "screenshot";

// ── Device profiles (US-BROW-014) ───────────────────────────────────────────

/** The finite, policy-controlled set of device emulation profile names. */
export type DeviceProfileName = "Pixel 7" | "iPhone 14" | "iPad Pro";

/** All known device profile names. */
export const DEVICE_PROFILE_NAMES: readonly DeviceProfileName[] = [
  "Pixel 7",
  "iPhone 14",
  "iPad Pro",
];

/** Parameters for a single device emulation profile. */
export interface DeviceProfile {
  /** The allowlisted profile name. */
  name: DeviceProfileName;
  /** Viewport width in CSS pixels. */
  width: number;
  /** Viewport height in CSS pixels. */
  height: number;
  /** Device pixel ratio (DPR). */
  deviceScaleFactor: number;
  /** Whether to emulate a mobile device (touch events, mobile UA). */
  mobile: boolean;
  /** Optional Chrome user-agent override. When absent Chrome uses its default UA. */
  userAgent?: string;
}

// ── Performance diagnostic profile (US-BROW-012) ────────────────────────────

/**
 * The finite, policy-controlled set of performance diagnostic profile names.
 *
 * There is exactly ONE profile. This is a narrow, local DevTools performance
 * signal — NOT a generic analytics or evidence channel. Adding a profile here
 * is a reviewed contract change, not a caller-supplied parameter.
 */
export type PerformanceProfileName = "web-vitals-lite";

/** All known performance diagnostic profile names. */
export const PERFORMANCE_PROFILE_NAMES: readonly PerformanceProfileName[] = [
  "web-vitals-lite",
];

/**
 * A single performance diagnostic profile. It declares a closed allowlist of
 * numeric CDP `Performance.getMetrics` metric names and a hard cap on how many
 * entries the redacted summary may retain. Nothing outside `metrics` is ever
 * kept — the allowlist is the data-minimization boundary.
 */
export interface PerformanceProfile {
  /** The allowlisted profile name. */
  name: PerformanceProfileName;
  /** Allowlisted numeric metric names collected from the local page. */
  metrics: readonly string[];
  /** Hard upper bound on the number of metric entries in the summary. */
  maxEntries: number;
}

/**
 * The bounded, redacted local performance summary.
 *
 * Contains only numeric metrics drawn from the profile allowlist. It never
 * carries a URL, a resource name, a trace, or any string that could leave the
 * machine. `degraded` is true when collection failed and the profile produced
 * no signal — a graceful, non-fatal outcome that never changes the underlying
 * navigation or Capture verdict.
 */
export interface PerformanceDiagnosticSummary {
  profile: PerformanceProfileName;
  /** Bounded, redacted numeric metrics — no URL, no resource name, no trace. */
  metrics: { name: string; value: number }[];
  /** True when collection degraded; `metrics` may be empty. */
  degraded: boolean;
}

/** The closed set of all permitted browser actions. */
export const BROWSER_ACTION_KINDS: readonly BrowserActionKind[] = [
  "navigate",
  "click",
  "fill",
  "press_key",
  "snapshot",
  "console",
  "network",
  "screenshot",
];

// ── Caller roles ────────────────────────────────────────────────────────────

/** Who is requesting the browser operation. */
export type BrowserCaller = "builder" | "evaluator" | "supervisor" | "attest";

// ── Run state machine ───────────────────────────────────────────────────────

export type BrowserRunState =
  | "requested"
  | "authorized"
  | "running"
  | "passed"
  | "failed"
  | "denied"
  | "expired";

// ── Diagnostic artifacts ────────────────────────────────────────────────────

export type DiagnosticArtifactKind =
  | "dom-snapshot"
  | "console-summary"
  | "network-summary"
  | "devtools-screenshot"
  | "performance-summary";

export interface DiagnosticArtifactRef {
  artifactId: string;
  kind: DiagnosticArtifactKind;
  digest: string;
  bytes: number;
  /** Always true — diagnostic artifacts are never visual AC evidence. */
  untrusted: true;
  /** Always true — diagnostic artifacts are never visual AC evidence. */
  diagnosticOnly: true;
}

// ── Operation run (aggregate root) ──────────────────────────────────────────

/** The idempotent run identifier. Every distinct operation gets one run. */
export interface BrowserOperationRun {
  runId: string;
  /** Same idempotencyKey → same run, replayed terminal result. */
  idempotencyKey: string;
  storyId?: string;
  cycleId?: string;
  caller: BrowserCaller;
  lane: BrowserLane;
  /** Optional device emulation profile applied (managed lane only, diagnostic-only). */
  deviceProfile?: DeviceProfileName;
  /** Optional performance diagnostic profile applied (managed lane only, opt-in, diagnostic-only). */
  performanceProfile?: PerformanceProfileName;
  /** The origin as requested (pre-normalization). */
  requestedOrigin: string;
  /** SHA-256 of the normalized policy JSON at authorization time. */
  policyFingerprint: string;
  /** Hash of the holder token — run recovery requires this. */
  holderTokenHash: string;
  state: BrowserRunState;
  leaseId?: string;
  startedAt?: string;
  endedAt?: string;
  diagnostics: DiagnosticArtifactRef[];
  result: "pass" | "fail" | "skipped" | "denied";
}

// ── Lease (interactive lane only) ───────────────────────────────────────────

export interface BrowserLease {
  leaseId: string;
  browser: "owner-chrome";
  storyId: string;
  origin: string;
  scope: "interactive-read-write";
  ownerApproval: {
    approvedAt: string;
    operator: string;
    reason: string;
  };
  acquiredAt: string;
  expiresAt: string;
  holderPid: number;
  /** Start-time identity used to distinguish PID reuse during recovery. */
  holderProcessIdentity: string;
  /** Hash only — raw holder tokens are never persisted. */
  holderTokenHash: string;
  endpointHash: string;
  releasedAt?: string;
}

// ── Policy (project-level, committed) ───────────────────────────────────────

export interface BrowserOperationsPolicy {
  enabled: boolean;
  devtoolsServer: string;
  managed: BrowserLanePolicy;
  interactive: BrowserLanePolicy;
}

export interface BrowserLanePolicy {
  enabled: boolean;
  allowedOrigins: string[];
  allowedActions: BrowserActionKind[];
  /** Managed only: max runs per cycle. */
  maxRunsPerCycle?: number;
  /** Managed only: opt-in performance diagnostic profile. Off (undefined/false) by default. */
  performanceDiagnostics?: boolean;
  /** Managed only: per-run timeout. */
  timeoutMs?: number;
  /** Interactive only: max lease duration. */
  maxLeaseMs?: number;
  /** Interactive only: require owner approval. */
  requireOwnerApproval?: boolean;
  /** Interactive only: require physical capture for visual AC. */
  requirePhysicalCaptureForVisualAc?: boolean;
}

// ── Origin normalization result ─────────────────────────────────────────────

export interface NormalizedOrigin {
  /** The normalized origin string: scheme + "://" + hostname + ":" + port. */
  normalized: string;
  /** The raw URL that was normalized. */
  raw: string;
  /** The parsed scheme (always "https" or "http" after normalization). */
  scheme: string;
  /** The normalized hostname (lowercase, punycode-decoded for display). */
  hostname: string;
  /** The effective port. */
  port: number;
  /** Whether this is a loopback address. */
  isLoopback: boolean;
}

// ── Origin validation ───────────────────────────────────────────────────────

export interface OriginValidationResult {
  /** Whether the origin is valid and allowed. */
  valid: boolean;
  /** If invalid, the structured reason. */
  reason?: BrowserDenialReason;
  /** If valid, the normalized origin. */
  normalized?: NormalizedOrigin;
}

// ── Denial reasons (structured, every denial returns one) ───────────────────

export type BrowserDenialCode =
  | "origin_not_https"
  | "origin_userinfo"
  | "origin_trailing_dot"
  | "origin_suffix_attack"
  | "origin_not_allowed"
  | "origin_wildcard_bypass"
  | "origin_invalid"
  | "lane_disabled"
  | "action_not_allowed"
  | "caller_not_allowed"
  | "interactive_no_lease"
  | "interactive_lease_expired"
  | "interactive_lease_origin_mismatch"
  | "interactive_lease_no_tty"
  | "interactive_lease_held"
  | "interactive_lease_invalid_request"
  | "policy_disabled"
  | "policy_fingerprint_tamper"
  | "transport_binding_missing"
  | "devtools_unavailable"
  | "generic_mcp_bypass_denied"
  | "unknown_device_profile"
  | "unknown_performance_profile"
  | "performance_profile_denied";

export interface BrowserDenialReason {
  code: BrowserDenialCode;
  message: string;
  /** Additional structured detail (origin, action, lane, etc.). */
  detail?: Record<string, unknown>;
}

// ── Request / result contracts ──────────────────────────────────────────────

export interface BrowserOperationRequest {
  idempotencyKey: string;
  storyId: string;
  cycleId?: string;
  caller: BrowserCaller;
  lane: BrowserLane;
  targetUrl: string;
  purpose: "test" | "diagnose" | "verify";
}

export interface BrowserActionInput {
  runId: string;
  idempotencyKey: string;
  holderToken: string;
  action: BrowserActionKind;
  payload: Record<string, string | number | boolean>;
}

export interface BrowserActionResult {
  runId: string;
  actionId: string;
  finalUrl?: string;
  status: "ok" | "denied" | "failed" | "skipped";
  diagnosticRefs: DiagnosticArtifactRef[];
  redactedSummary: string;
}

// ── Policy resolution result ────────────────────────────────────────────────

export interface BrowserPolicyDecision {
  /** Whether the operation is authorized. */
  authorized: boolean;
  /** If denied, the structured reason. Never undefined when authorized=false. */
  denial?: BrowserDenialReason;
  /** If authorized, the resolved lane policy for the operation. */
  lanePolicy?: BrowserLanePolicy;
  /** The fingerprint of the policy used for this decision. */
  policyFingerprint: string;
  /** The normalized origin (always present when authorized). */
  normalizedOrigin?: NormalizedOrigin;
}

// ── Interactive lease request ───────────────────────────────────────────────

export interface InteractiveLeaseRequest {
  storyId: string;
  origin: string;
  reason: string;
  requestedMs: number;
}

// ── Event types (for event stream) ──────────────────────────────────────────

export type BrowserOperationEvent =
  | { type: "browser:operation-requested"; runId: string; ts: string; request: BrowserOperationRequest; holderTokenHash: string }
  | { type: "browser:operation-authorized"; runId: string; ts: string; policyFingerprint: string }
  | { type: "browser:operation-denied"; runId: string; ts: string; reason: BrowserDenialReason }
  | { type: "browser:lease-granted"; leaseId: string; ts: string; storyId: string; origin: string; actionSummary: string; expiresAt: string; credentialExportDenied: boolean }
  | { type: "browser:lease-orphaned"; leaseId: string; ts: string; endpointHash: string; holderPid: number }
  | { type: "browser:lease-rejected"; ts: string; storyId: string; reason: BrowserDenialReason }
  | { type: "browser:lease-expired"; leaseId: string; ts: string }
  | { type: "browser:lease-released"; leaseId: string; ts: string }
  | { type: "browser:operation-started"; runId: string; ts: string }
  | { type: "browser:operation-step-finished"; runId: string; actionId: string; ts: string }
  | { type: "browser:diagnostic-recorded"; runId: string; ts: string; ref: DiagnosticArtifactRef }
  | { type: "browser:diagnostic-profile-finished"; runId: string; ts: string; profile: PerformanceProfileName; summary: PerformanceDiagnosticSummary }
  | { type: "browser:diagnostic-dropped"; runId: string; ts: string; failure: "redaction_failed" }
  | { type: "browser:capture-linked"; runId: string; ts: string; link: import("./evidence-classification.js").CaptureBridgeLink }
  | { type: "browser:operation-finished"; runId: string; ts: string; result: BrowserActionResult }
  | { type: "browser:mcp-bypass-denied"; ts: string; reason: BrowserDenialReason }
  | { type: "browser:mcp-started"; runId: string; ts: string }
  | { type: "browser:mcp-initialized"; runId: string; ts: string; version: string; tools: readonly string[] }
  | { type: "browser:mcp-closed"; runId: string; ts: string }
  | { type: "browser:mcp-failed"; runId: string; ts: string; category: BrowserMcpFailureCategory; message: string }
  | {
      type: "browser:environment-checked";
      ts: string;
      managed: BrowserLaneVerdict;
      interactive: BrowserLaneVerdict;
      capture: BrowserLaneVerdict;
    };

export type BrowserMcpFailureCategory = "timeout" | "crash" | "devtools-error";

// ── US-BROW-010 — transport version check and atomic update ──────────────────

/** Result of a deterministic, non-mutating version check. */
export interface BrowserTransportVersionCheck {
  /** The currently pinned package version. */
  pinned: string;
  /** Available candidate version, or null when no update is available. */
  candidate: string | null;
  /** True when candidate differs from pinned and is non-null. */
  updateAvailable: boolean;
}

/** Outcome of an atomic version update attempt. */
export type BrowserTransportVersionApplyResult =
  | { kind: "applied"; from: string; to: string }
  | { kind: "no_update"; pinned: string }
  | { kind: "verification_failed"; from: string; candidate: string; reason: string }
  | { kind: "refused"; reason: string };

// ── US-BROW-003 — environment readiness ──────────────────────────────────────

/**
 * Per-lane readiness verdict. `blocked` is a hard, honest unavailable state that
 * MUST NOT be interpreted as a passing browser check; `degraded` means the lane
 * cannot run but existing Playwright / Roll Capture paths stay usable;
 * `configured` means static configuration is present but no live probe has
 * confirmed real MCP readiness; `ready` means a live MCP probe passed
 * (initialize + tool-manifest + profile cleanup).
 */
export type BrowserLaneVerdict = "ready" | "configured" | "degraded" | "blocked";

/** The three independently-reported readiness lanes. */
export type BrowserReadinessLane = "managed" | "interactive" | "capture";

/**
 * One dependency observation. Every field is non-sensitive: probes never open
 * remote debugging, never install packages, and never write configuration.
 */
export interface BrowserDependencyObservation {
  id:
    | "node"
    | "npx"
    | "chrome"
    | "devtools_mcp"
    | "loopback_remote_debug"
    | "transport_binding"
    | "capture";
  present: boolean;
  detail: string;
  /** Optional non-sensitive value (version string, path, endpoint). */
  value?: string;
}

/** Capture readiness projected into the browser-operations vocabulary. */
export type BrowserCaptureStatus = "available" | "degraded" | "skip";

/** Raw, pre-verdict observations fed to the readiness aggregate. */
export interface BrowserEnvironmentObservations {
  node: BrowserDependencyState;
  npx: BrowserDependencyState;
  chrome: BrowserDependencyState;
  devtoolsPackage: BrowserDependencyState;
  loopbackRemoteDebug: BrowserDependencyState;
  /** Whether the project policy devtools_server matches the registry logical key. */
  transportBinding: BrowserDependencyState;
  capture: { status: BrowserCaptureStatus; detail: string };
}

export interface BrowserDependencyState {
  present: boolean;
  detail: string;
  value?: string;
  /**
   * When true the TCP port was open but the /json/version check failed (not a
   * DevTools endpoint).  Only set by loopback probes; absent means "not checked"
   * and is treated the same as false.
   */
  portReachable?: boolean;
}

export interface BrowserLaneReadiness {
  lane: BrowserReadinessLane;
  verdict: BrowserLaneVerdict;
  reason: string;
  /** Actionable, non-mutating repair guidance. Never an auto-run command. */
  actions: string[];
}

// ── US-BROW-019 — live MCP probe result ─────────────────────────────────────

/** Categorized probe failure (never conflated with a passing check). */
export type BrowserProbeFailureCategory = "mcp-spawn" | "mcp-initialize" | "manifest-mismatch" | "chrome-launch" | "profile-cleanup";

/** One categorized probe failure. */
export interface BrowserProbeFailure {
  category: BrowserProbeFailureCategory;
  message: string;
}

/**
 * Outcome of a live managed-lane MCP probe. `passed` means the exact
 * pinned MCP session initialized, tool manifest matched, and the temporary
 * Chrome/profile were cleaned up. Every failure category is distinct and
 * actionable.
 */
export type BrowserProbeResult =
  | { kind: "passed"; version: string; tools: string[] }
  | { kind: "failed"; failures: BrowserProbeFailure[] };

/**
 * BrowserEnvironmentReadiness aggregate — owns dependency observations and the
 * ready | configured | degraded | blocked verdict for each lane. When a live
 * probe result is supplied the managed lane may reach `ready`.
 */
export interface BrowserEnvironmentReadiness {
  managed: BrowserLaneReadiness;
  interactive: BrowserLaneReadiness;
  capture: BrowserLaneReadiness;
  observations: BrowserDependencyObservation[];
  /** Present only after a live `--probe` was run (US-BROW-019). */
  probeResult?: BrowserProbeResult;
}

// ── US-BROW-009a — declared browser-operation truth projections ───────────

/** A read-side verdict over declared browser-operation facts. Missing facts are
 * `unknown`, never an implicit pass. */
export type BrowserOperationTruthStatus = "ready" | "degraded" | "expired" | "unknown";

/** One browser-operation fact projection for status consumers. */
export interface BrowserOperationTruthFact {
  status: BrowserOperationTruthStatus;
  /** Reason a status is unavailable, degraded, expired, or still unknown. */
  unavailableReason?: string;
  /** Lease expiry remains visible to callers rather than being folded away. */
  expiresAt?: string;
}

/** The single adapter result consumed by browser status surfaces. */
export interface BrowserOperationsTruth {
  managed: BrowserOperationTruthFact;
  lease: BrowserOperationTruthFact;
  capture: BrowserOperationTruthFact;
  collectedAt: string;
}

// ── US-BROW-013 — optional browser-operations timeline projection ─────────

/** Timeline event kinds derived from declared ledger / capture facts only. */
export type BrowserTimelineEventKind =
  | "operation-start"
  | "operation-finish"
  | "lease-grant"
  | "lease-expiry"
  | "lease-release"
  | "physical-capture";

/** Presence of a timeline fact. Absent/unknown never invent a stamp or verdict. */
export type BrowserTimelineFactPresence = "present" | "absent" | "unknown";

/** Handle that the dossier may link when the viewer is authorized. */
export interface BrowserTimelineArtifactRef {
  kind: "diagnostic" | "physical-capture";
  /** Stable id used to resolve an authorized dossier href. */
  id: string;
  label: string;
}

/** One compact timeline row for the dossier browser-operations surface. */
export interface BrowserTimelineRow {
  kind: BrowserTimelineEventKind;
  presence: BrowserTimelineFactPresence;
  /** ISO timestamp when the fact is present — never invented for absent rows. */
  ts?: string;
  label: string;
  /** Terminal summary when present, or the honest reason when absent/unknown. */
  detail?: string;
  runId?: string;
  leaseId?: string;
  /** Artifact/evidence handle; dossier emits a link only under existing auth rules. */
  artifact?: BrowserTimelineArtifactRef;
}

/**
 * Read-only timeline projection: chronological present facts plus reason-only
 * absences. Ordering is derived from declared timestamps — never invented.
 */
export interface BrowserOperationsTimeline {
  /** Chronological present facts, ordered by declared `ts` ascending. */
  rows: BrowserTimelineRow[];
  /** Categories with no declared facts — reason-only, no invented position. */
  absences: BrowserTimelineRow[];
  /** True when at least one present chronological fact exists. */
  hasFacts: boolean;
  collectedAt: string;
}
