/**
 * US-TRUTH-006 — the change-point guardrail: persistent fact FIELDS register
 * their authority/source/cache semantics, and CI fails loud when a new field
 * lands unregistered.
 *
 * Drift recurs because a feature "just adds" a runs column, an event field, or
 * a dashboard counter without declaring whether it is authoritative fact or a
 * derived view — the next consumer then guesses, and the guess diverges
 * (the whole FIX-243/244/248/249 family). The rule:
 *
 *   any field that is PERSISTED and read by a second place must appear here,
 *   bound to its US-TRUTH-000 anchor; a derived-cache field must say how it
 *   rebuilds. Local variables and single-reader temp files don't register.
 *
 * The guard is mechanical: tests construct REAL rows/events via the production
 * builders and assert every key is registered (or explicitly grandfathered).
 * Adding a field without registering it turns CI red with a pointer here —
 * never a silent skip (AC3). Registration is cheap and deliberate; that's the
 * point.
 */
import { TRUTH_ANCHORS } from "./truth.js";

/** Which persisted surface a field lives on. */
export type TruthSurface = "runs" | "event:cycle:terminal" | "event:release:gate" | "event:release:waiver" | "goal" | "delivery" | "browser" | "event:delta" | "artifact:delta";

export interface RegisteredField {
  /** The literal key as persisted (e.g. "cost_usd"). */
  field: string;
  surface: TruthSurface;
  /** The US-TRUTH-000 anchor that owns this field's semantics. */
  anchor: string;
  /** Who writes it (one writer per fact). */
  writer: string;
  /** Authoritative value vs a view derived from the anchor's source. */
  kind: "authoritative" | "derived-cache";
  /** Required for derived-cache: the rebuild command or source selector (AC4). */
  rebuild?: string;
}

const RUNNER = "cycle runner append_run (buildRunRow)";
const BACKFILL = "merge-evidence backfill (runs-backfill, FIX-243)";
const REBUILD_BACKFILL = "roll loop run-once post-cycle backfill / backfillMergedRuns";

/** The field registry. Surfaces covered: runs rows, the US-TRUTH-001 terminal
 *  twin, and the US-TRUTH-005 release records. */
export const TRUTH_FIELD_REGISTRY: readonly RegisteredField[] = [
  // ── goal.yaml (US-GOAL-001) ────────────────────────────────────────────────
  { field: "schema", surface: "goal", anchor: "goal_state", writer: "goal control plane", kind: "authoritative" },
  { field: "scope", surface: "goal", anchor: "goal_state", writer: "goal control plane", kind: "authoritative" },
  { field: "review", surface: "goal", anchor: "goal_state", writer: "goal control plane", kind: "authoritative" },
  { field: "limits", surface: "goal", anchor: "goal_state", writer: "goal control plane", kind: "authoritative" },
  { field: "status", surface: "goal", anchor: "goal_state", writer: "goal control plane; complete only by adjudication", kind: "authoritative" },
  { field: "usage", surface: "goal", anchor: "goal_state", writer: "goal control plane from runs ledger", kind: "derived-cache", rebuild: "sum cycles/cost from scoped runs rows" },
  { field: "createdAt", surface: "goal", anchor: "goal_state", writer: "goal control plane", kind: "authoritative" },
  { field: "updatedAt", surface: "goal", anchor: "goal_state", writer: "goal control plane", kind: "authoritative" },
  { field: "lastDecisionReason", surface: "goal", anchor: "goal_state", writer: "goal control plane / adjudicator", kind: "authoritative" },

  // ── runs.jsonl row (cycle_outcome anchor's primary view) ───────────────────
  { field: "run_id", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "cycle_id", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "story_id", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "status", surface: "runs", anchor: "cycle_outcome", writer: `${RUNNER}; corrected only by ${BACKFILL}`, kind: "authoritative" },
  { field: "outcome", surface: "runs", anchor: "cycle_outcome", writer: `${RUNNER}; corrected only by ${BACKFILL}`, kind: "authoritative" },
  { field: "failure_class", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "root_cause_key", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "agent", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "built", surface: "runs", anchor: "story_delivery", writer: RUNNER, kind: "derived-cache", rebuild: "re-derive from story_id + delivery truth (deriveStoryTruth)" },
  { field: "tcr_count", surface: "runs", anchor: "tcr_evidence", writer: RUNNER, kind: "derived-cache", rebuild: "recount tcr: commits on the cycle branch" },
  { field: "ts", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "authoritative" },
  { field: "duration_sec", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "derived-cache", rebuild: "ended_at - started_at from the cycle:terminal twin" },
  { field: "model", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "re-extract from agent usage records (usage-recovery / stream parse)" },
  { field: "tokens_in", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "re-extract from agent usage records" },
  { field: "tokens_out", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "re-extract from agent usage records" },
  { field: "tokens_cache_read", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "re-extract from agent usage records" },
  { field: "tokens_cache_write", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "re-extract from agent usage records" },
  { field: "cost_usd", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "recompute from tokens via the price table (toCycleCost)" },
  { field: "cost_effective_usd", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "estimated × (reverts + 1) — toCycleCost" },
  { field: "cost_currency", surface: "runs", anchor: "usage_cost", writer: RUNNER, kind: "derived-cache", rebuild: "resolve from model's price-table currency (currencyFor / cycleCurrency)" },
  { field: "pr_number", surface: "runs", anchor: "pr_merge", writer: `${RUNNER}; corrected by ${BACKFILL}`, kind: "authoritative" },
  { field: "pr_url", surface: "runs", anchor: "pr_merge", writer: `${RUNNER}; corrected by ${BACKFILL}`, kind: "authoritative" },
  { field: "merged_at", surface: "runs", anchor: "pr_merge", writer: BACKFILL, kind: "derived-cache", rebuild: REBUILD_BACKFILL },
  { field: "merge_commit", surface: "runs", anchor: "pr_merge", writer: BACKFILL, kind: "derived-cache", rebuild: REBUILD_BACKFILL },
  // US-LOOP-104: the adversarial-pairing outcome ({rounds,holesFound,terminationReason,degraded}|null).
  { field: "adversarial", surface: "runs", anchor: "cycle_outcome", writer: RUNNER, kind: "derived-cache", rebuild: "foldCycleAdversarial over the cycle's adversarial:* events (US-LOOP-104)" },

  // ── cycle:terminal event (US-TRUTH-001) ────────────────────────────────────
  { field: "type", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "schema", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "cycleId", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "storyId", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "agent", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  // FIX-294: routed model is a dispatch-time fact (like agent) — authoritative,
  // ALWAYS present even when usage couldn't be parsed; the `usage` fact below
  // still owns the present-or-reasoned token/cost truth.
  { field: "model", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "startedAt", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "endedAt", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "outcome", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "failure_class", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "root_cause_key", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "pr", surface: "event:cycle:terminal", anchor: "pr_merge", writer: "buildTerminalEvent", kind: "derived-cache", rebuild: "gh pr view on the cycle branch" },
  { field: "branch", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },
  { field: "commit", surface: "event:cycle:terminal", anchor: "tcr_evidence", writer: "buildTerminalEvent", kind: "derived-cache", rebuild: "git rev-parse on the cycle branch" },
  { field: "tcr", surface: "event:cycle:terminal", anchor: "tcr_evidence", writer: "buildTerminalEvent", kind: "derived-cache", rebuild: "recount tcr: commits on the cycle branch" },
  { field: "attest", surface: "event:cycle:terminal", anchor: "attest_evidence", writer: "buildTerminalEvent", kind: "derived-cache", rebuild: "probe the card archive (report + ac-map existence)" },
  { field: "usage", surface: "event:cycle:terminal", anchor: "usage_cost", writer: "buildTerminalEvent", kind: "derived-cache", rebuild: "re-extract from agent usage records" },
  { field: "cost", surface: "event:cycle:terminal", anchor: "usage_cost", writer: "buildTerminalEvent", kind: "derived-cache", rebuild: "recompute from tokens via the price table" },
  { field: "ts", surface: "event:cycle:terminal", anchor: "cycle_outcome", writer: "buildTerminalEvent", kind: "authoritative" },

  // ── delivery record (US-TRUTH-013) ───────────────────────────────────────
  { field: "storyId", surface: "delivery", anchor: "story_delivery", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "cycleId", surface: "delivery", anchor: "cycle_outcome", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "lifecycleState", surface: "delivery", anchor: "story_delivery", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "prNumber", surface: "delivery", anchor: "pr_merge", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "prUrl", surface: "delivery", anchor: "pr_merge", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "mergedAt", surface: "delivery", anchor: "pr_merge", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "mergeCommit", surface: "delivery", anchor: "pr_merge", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },
  { field: "recordedAt", surface: "delivery", anchor: "story_delivery", writer: "cycle runner buildDeliveryRecord", kind: "authoritative" },

  // ── release records (US-TRUTH-005) ────────────────────────────────────────
  { field: "type", surface: "event:release:gate", anchor: "release_verdict", writer: "release ship recordGate", kind: "authoritative" },
  { field: "tag", surface: "event:release:gate", anchor: "release_verdict", writer: "release ship recordGate", kind: "authoritative" },
  { field: "verdict", surface: "event:release:gate", anchor: "release_verdict", writer: "release ship recordGate", kind: "authoritative" },
  { field: "failCount", surface: "event:release:gate", anchor: "release_verdict", writer: "release ship recordGate", kind: "authoritative" },
  { field: "waivedRules", surface: "event:release:gate", anchor: "release_waiver", writer: "release ship recordGate", kind: "derived-cache", rebuild: "re-join gate findings with live waivers (decideReleaseGate)" },
  { field: "ts", surface: "event:release:gate", anchor: "release_verdict", writer: "release ship recordGate", kind: "authoritative" },
  { field: "type", surface: "event:release:waiver", anchor: "release_waiver", writer: "(retired US-REL-007 — historical release:waiver events only; no writer remains)", kind: "authoritative" },
  { field: "reason", surface: "event:release:waiver", anchor: "release_waiver", writer: "(retired US-REL-007 — historical release:waiver events only; no writer remains)", kind: "authoritative" },
  { field: "scope", surface: "event:release:waiver", anchor: "release_waiver", writer: "(retired US-REL-007 — historical release:waiver events only; no writer remains)", kind: "authoritative" },
  { field: "expiresSec", surface: "event:release:waiver", anchor: "release_waiver", writer: "(retired US-REL-007 — historical release:waiver events only; no writer remains)", kind: "authoritative" },
  { field: "operator", surface: "event:release:waiver", anchor: "release_waiver", writer: "(retired US-REL-007 — historical release:waiver events only; no writer remains)", kind: "authoritative" },
  { field: "ts", surface: "event:release:waiver", anchor: "release_waiver", writer: "(retired US-REL-007 — historical release:waiver events only; no writer remains)", kind: "authoritative" },

  // ── Browser Operations (US-BROW-001) ───────────────────────────────────
  { field: "runId", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "idempotencyKey", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "storyId", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "cycleId", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "caller", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "lane", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "requestedOrigin", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "policyFingerprint", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "holderTokenHash", surface: "browser", anchor: "browser_run", writer: "BrowserOperationLedger / BrowserLeaseLock", kind: "authoritative" },
  { field: "state", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "result", surface: "browser", anchor: "browser_run", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "leaseId", surface: "browser", anchor: "browser_lease", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "origin", surface: "browser", anchor: "browser_lease", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "expiresAt", surface: "browser", anchor: "browser_lease", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "ownerApproval", surface: "browser", anchor: "browser_lease", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "holderPid", surface: "browser", anchor: "browser_lease", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "holderProcessIdentity", surface: "browser", anchor: "browser_lease", writer: "BrowserLeaseLock", kind: "authoritative" },
  { field: "heartbeatAt", surface: "browser", anchor: "browser_lease", writer: "BrowserLeaseLock", kind: "authoritative" },
  { field: "endpointHash", surface: "browser", anchor: "browser_lease", writer: "BrowserOperationService", kind: "authoritative" },
  { field: "artifactId", surface: "browser", anchor: "browser_diagnostic", writer: "BrowserOperationService via DevToolsAdapter", kind: "authoritative" },
  { field: "digest", surface: "browser", anchor: "browser_diagnostic", writer: "BrowserOperationService via DevToolsAdapter", kind: "authoritative" },
  { field: "bytes", surface: "browser", anchor: "browser_diagnostic", writer: "BrowserOperationLedger", kind: "authoritative" },
  { field: "untrusted", surface: "browser", anchor: "browser_diagnostic", writer: "BrowserOperationLedger", kind: "authoritative" },
  { field: "diagnosticOnly", surface: "browser", anchor: "browser_diagnostic", writer: "BrowserOperationLedger", kind: "authoritative" },
  { field: "failure", surface: "browser", anchor: "browser_diagnostic", writer: "BrowserOperationLedger", kind: "authoritative" },
  { field: "captureRequestId", surface: "browser", anchor: "browser_capture_link", writer: "CaptureBridge", kind: "authoritative" },

  // ── US-DELTA-001 — Delegation event fields (event:delta surface) ──────────
  { field: "type", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta commands", kind: "authoritative" },
  { field: "ts", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta commands", kind: "authoritative" },
  { field: "delegationId", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  { field: "storyId", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  // delta:prepared fields
  { field: "runId", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  { field: "cycleId", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  { field: "trigger", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  { field: "topology", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  { field: "qualityProfile", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta prepare", kind: "authoritative" },
  { field: "presetId", surface: "event:delta", anchor: "delegation_provenance", writer: "roll delta prepare", kind: "authoritative" },
  { field: "presetSha256", surface: "event:delta", anchor: "delegation_provenance", writer: "roll delta prepare", kind: "authoritative" },
  // delta:role_resolved fields — host's resolved-assignment CLAIM, not proof
  { field: "role", surface: "event:delta", anchor: "delegation_provenance", writer: "roll delta prepare (role_resolved)", kind: "authoritative" },
  { field: "roleInstanceId", surface: "event:delta", anchor: "delegation_provenance", writer: "host skill (opaque token)", kind: "authoritative" },
  { field: "hostId", surface: "event:delta", anchor: "delegation_provenance", writer: "host skill (opaque claim)", kind: "authoritative" },
  { field: "modelId", surface: "event:delta", anchor: "delegation_provenance", writer: "host skill (opaque claim, not execution proof)", kind: "authoritative" },
  { field: "source", surface: "event:delta", anchor: "delegation_provenance", writer: "host resolution algorithm", kind: "authoritative" },
  { field: "reasons", surface: "event:delta", anchor: "delegation_provenance", writer: "host resolution algorithm", kind: "authoritative" },
  { field: "inventorySha256", surface: "event:delta", anchor: "delegation_provenance", writer: "host resolution algorithm", kind: "authoritative" },
  { field: "inventoryObservedAt", surface: "event:delta", anchor: "delegation_provenance", writer: "host resolution algorithm", kind: "authoritative" },
  // delta:role_started fields — accepted structural protocol fact
  { field: "sessionId", surface: "event:delta", anchor: "delegation_provenance", writer: "host skill (opaque claim)", kind: "authoritative" },
  { field: "identityProvenance", surface: "event:delta", anchor: "delegation_provenance", writer: "roll delta validate", kind: "authoritative" },
  { field: "worktreeAccess", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta validate", kind: "authoritative" },
  // delta:artifact_published fields
  { field: "path", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta validate", kind: "authoritative" },
  { field: "sha256", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta validate", kind: "authoritative" },
  { field: "manifestPath", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta validate", kind: "authoritative" },
  // delta:terminal fields
  { field: "outcome", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta conclude", kind: "authoritative" },
  { field: "terminalBinding", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta conclude", kind: "authoritative" },
  { field: "deliveryDisposition", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta conclude", kind: "authoritative" },
  // delta:blocked fields
  { field: "reason", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta validate / conclude", kind: "authoritative" },
  { field: "detail", surface: "event:delta", anchor: "delegation_lifecycle", writer: "roll delta validate / conclude", kind: "authoritative" },

  // ── US-DELTA-001 — Delta v2 manifest/attestation fields (artifact:delta surface) ──
  // These are derived-cache evidence/provenance claims, rebuilt from events.
  { field: "schemaVersion", surface: "artifact:delta", anchor: "delegation_lifecycle", writer: "role artifact author (host/adapter)", kind: "derived-cache", rebuild: "cross-check against event authority" },
  { field: "executionIdentity", surface: "artifact:delta", anchor: "delegation_provenance", writer: "role artifact author (host/adapter)", kind: "derived-cache", rebuild: "cross-check identity tokens against delta:role_resolved + delta:role_started events" },
  { field: "hostAttestation", surface: "artifact:delta", anchor: "delegation_provenance", writer: "host skill (self-attestation)", kind: "derived-cache", rebuild: "structural validation only (non-empty/unique tokens) — never proof of host behavior" },
  { field: "createdAt", surface: "artifact:delta", anchor: "delegation_lifecycle", writer: "role artifact author", kind: "derived-cache", rebuild: "cross-check artifact timestamp against event ts window" },
];

/** Pre-guardrail history, listed not judged (AC: grandfather with a clear list):
 *  v2-era runs columns nothing new writes.
 *  FIX-343: `self_score` is FROZEN here — it is a historical runs column / policy
 *  key (`self_score.low_threshold`), NOT the renamed quality-score concept. The
 *  live term is "Review Score" (lib/review-score.ts); this literal stays to keep
 *  the grandfathered allowlist matching legacy on-disk data. */
export const GRANDFATHERED_FIELDS: readonly string[] = ["project", "result_eval", "self_score", "merged"];

/**
 * The guard: which of `keys` on `surface` are neither registered nor
 * grandfathered? Empty result = compliant. CI asserts emptiness with a
 * pointer-to-registration error message (AC3).
 */
export function unregisteredFields(surface: TruthSurface, keys: readonly string[]): string[] {
  const known = new Set(TRUTH_FIELD_REGISTRY.filter((f) => f.surface === surface).map((f) => f.field));
  const old = new Set(GRANDFATHERED_FIELDS);
  return keys.filter((k) => !known.has(k) && !old.has(k));
}

/** Registry hygiene used by the guard tests: every entry binds to a declared
 *  anchor, and every derived-cache declares its rebuild (AC4). */
export function registryProblems(): string[] {
  const anchors = new Set(TRUTH_ANCHORS.map((a) => a.field));
  const problems: string[] = [];
  for (const f of TRUTH_FIELD_REGISTRY) {
    if (!anchors.has(f.anchor)) problems.push(`${f.surface}.${f.field}: unknown anchor "${f.anchor}"`);
    if (f.kind === "derived-cache" && (f.rebuild === undefined || f.rebuild.trim() === "")) {
      problems.push(`${f.surface}.${f.field}: derived-cache without a rebuild declaration`);
    }
  }
  return problems;
}

/** The fail-loud message a red guard prints (AC3 — points at HOW to register). */
export function registrationHint(surface: TruthSurface, fields: string[]): string {
  return (
    `unregistered persistent fact field(s) on ${surface}: ${fields.join(", ")}\n` +
    `→ register each in packages/spec/src/types/truth-registry.ts (TRUTH_FIELD_REGISTRY):\n` +
    `   bind it to a US-TRUTH-000 anchor, name its one writer, and declare\n` +
    `   kind authoritative | derived-cache (derived caches must state a rebuild).\n` +
    `   Local variables / single-reader temp files do NOT register — only\n` +
    `   persisted fields a second place reads.`
  );
}
