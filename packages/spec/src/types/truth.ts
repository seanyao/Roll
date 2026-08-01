/**
 * US-TRUTH-000 — Truth Source Declaration (the field-level authority matrix).
 *
 * Roll's drift epidemic (FIX-243/244/248/249; the 2026-06-10 day where every
 * delivered cycle died on the books while its PRs merged) is a WRITE-side
 * problem: several sources write and interpret the same fact. This module is
 * the single declaration of, per persistent fact field:
 *
 *   - which source is AUTHORITATIVE (everything else is a derived view),
 *   - who the one legitimate WRITER is,
 *   - how a CONFLICT between views arbitrates,
 *   - when a missing/late value is legally `unknown` (never silently 0/fail),
 *   - whether the field can be REBUILT from its source.
 *
 * Selectors (US-TRUTH-003), the shadow audit (US-TRUTH-002) and the release
 * gate (US-TRUTH-005) consume THIS table — they must not invent a new one.
 * The prose twin lives at
 * `.roll/features/feedback-truth-alignment/truth-anchors.md`; the registry in
 * code is canonical (tests enforce coverage; prose explains).
 *
 * Core principles (epic ruling, peer-reviewed 2026-06-11):
 *   1. main is the delivery truth — but not the home of every evidence field.
 *   2. one authoritative writer per fact; everything else is a rebuildable view.
 *   3. `unknown` is a legal state (API down / window not yet converged).
 */

/** A real, dated drift incident attached to the anchor it violated —
 *  US-TRUTH-002 (audit rules) and -003 (selector freezes) consume these. */
export interface DriftFixture {
  /** Short slug, stable across stories (e.g. "failed-cycle-merged-pr"). */
  id: string;
  /** What actually happened, with the dated incident anchor. */
  observed: string;
  /** The verdict a correct selector/audit must produce for this case. */
  expectedVerdict: "fail" | "warn" | "unknown" | "grandfathered";
  /** How the truth chain should resolve it (arbitration walk-through). */
  resolution: string;
}

/** One field-level truth declaration (AC2's six attributes + grace + fixtures). */
export type TruthAggregate = "story" | "cycle" | "release" | "view-meta" | "goal" | "delegation" | "execution";

export interface TruthAnchor {
  /** Registry key — stable snake_case fact name. */
  field: string;
  /** Domain aggregate that owns this truth anchor (US-TRUTH-007). */
  aggregate: TruthAggregate;
  /** What the field asserts, in one line. */
  description: string;
  /** The ONE source whose value wins (AC2 authoritative_source). */
  authoritativeSource: string;
  /** The one legitimate writer of that source. */
  writer: string;
  /** Views/caches derived from the source — all must be rebuildable from it. */
  derivedViews: string[];
  /** How a disagreement between source and views arbitrates. */
  conflictPolicy: string;
  /** When absence/lateness is `unknown` rather than fail/zero. */
  unknownPolicy: string;
  /** Can the field be reconstructed from its authoritative source? */
  rebuildability: "rebuildable" | "append-only" | "external";
  /** Convergence window (seconds) before a mismatch may be judged at all. */
  graceWindowSec?: number;
  /** Real dated incidents that violated this anchor (US-TRUTH-000 AC5). */
  driftFixtures?: DriftFixture[];
}

/**
 * AC3 — cross-repo arbitration. When the product repo's main, the nested
 * `.roll`/roll-meta views, and GitHub disagree about a delivery:
 * GitHub's merge evidence (the PR record) outranks the local main clone
 * (which may be stale/un-fetched), which outranks every roll-meta view
 * (backlog rows, dossier pages, index — all derived, all rebuildable).
 */
export const CROSS_REPO_ARBITRATION_ORDER = ["github_pr_merge", "product_main", "roll_meta"] as const;

/** Default convergence window for async chains (PR merge → backfill → views):
 *  two loop scheduler ticks (1800s each) — within it, mismatches are `unknown`. */
export const DEFAULT_GRACE_WINDOW_SEC = 3600;

/** The authority matrix — one entry per drift-prone persistent fact field. */
export const TRUTH_ANCHORS: readonly TruthAnchor[] = [
  {
    field: "goal_state",
    aggregate: "goal",
    description: "The persisted goal scope, review mode, budget, status, usage counters, and adjudication reason.",
    authoritativeSource: ".roll/loop/goal.yaml (schema goal.v1)",
    writer: "goal control plane; complete may only be written by adjudication",
    derivedViews: ["roll loop goal", "goal-mode dossier/status surfaces"],
    conflictPolicy: "goal.yaml wins; derived views are regenerated/read-only and may never mark complete themselves.",
    unknownPolicy: "missing goal.yaml means no active goal, not failure.",
    rebuildability: "append-only",
  },
  {
    field: "story_delivery",
    aggregate: "story",
    description: "A story is Done — its work is merged into the product repo's main.",
    authoritativeSource: "GitHub PR merge evidence for the story's delivery PR (state=MERGED + mergeCommit reachable from main)",
    writer: "GitHub (merge button / Delivery Reconciler self-merge) — never a local actor",
    derivedViews: [
      ".roll/backlog.md status cell (✅ Done)",
      "runs.jsonl row status merged/delivered",
      "dossier story page delivery phase",
      ".roll/index.json story listing",
    ],
    conflictPolicy:
      "merge evidence wins both ways: Done row without MERGED PR → drift(fail, premature Done); MERGED PR with non-Done row past grace → drift(warn, flip the row). A backlog row never proves delivery (I4: backlog 是愿望, main 是真相).",
    unknownPolicy:
      "GitHub unreachable or within the post-merge grace window → unknown, never fail; offline cycles legally defer the flip (IDEA-001 local-only degrade).",
    rebuildability: "rebuildable",
    graceWindowSec: DEFAULT_GRACE_WINDOW_SEC,
    driftFixtures: [
      {
        id: "done-no-merge-history",
        observed:
          "2026-05-23 FIX-097/098/099: backlog rows flipped Done while merge state未核 (and conversely rows lagged after merges) — the recurring premature/lagging Done family (also FIX-211, FIX-235 2026-06-10).",
        expectedVerdict: "fail",
        resolution:
          "story_delivery reads ONLY PR merge evidence; the backlog cell is a derived view that follows it — a Done cell with an OPEN PR is the writer violating authority.",
      },
    ],
  },
  {
    field: "cycle_outcome",
    aggregate: "cycle",
    description: "What one loop cycle terminally produced (delivered/published/failed/idle/...).",
    authoritativeSource: "runs.jsonl terminal row for the cycle (after merge-evidence backfill corrections)",
    writer: "the cycle runner's append_run executor (+ the FIX-243 backfill as the one sanctioned corrector)",
    derivedViews: ["cycle:end event outcome (coarser, immutable)", "dashboard ROLLUP/RECENT cells", "morning report delivered set"],
    conflictPolicy:
      "the runs row (with backfill stamps) outranks the immutable cycle:end event; a 'failed' row whose cycle branch has a MERGED PR is a phantom failure — backfill flips it to merged/delivered (FIX-243/244).",
    unknownPolicy:
      "a cycle with no terminal row AND no cycle:end (killed process) is unknown until the signal-teardown or reconcile writes an aborted terminal — dashboards must not guess.",
    rebuildability: "append-only",
    graceWindowSec: DEFAULT_GRACE_WINDOW_SEC,
    driftFixtures: [
      {
        id: "failed-cycle-merged-pr",
        observed:
          "cycle 20260610-212711-40684 ended failed (attest gate) while its PR #577 (REFACTOR-049) merged at 21:49; runs.jsonl kept failed/failed with no merge field for hours.",
        expectedVerdict: "fail",
        resolution:
          "PR merge evidence outranks the terminal row → backfill rewrites status=merged outcome=delivered + stamps (verified live 2026-06-11, see FIX-243 evidence).",
      },
      {
        id: "phantom-failure-pause",
        observed:
          "cycle 20260610-222703-13871 delivered REFACTOR-050 + PR #578 (merged 22:46) yet was judged failed at 22:44; three such phantoms tripped the consecutive-failure auto-PAUSE — the loop halted because it was succeeding.",
        expectedVerdict: "fail",
        resolution:
          "a non-zero capture with commits + an OPEN/MERGED cycle-branch PR classifies 'published', excluded from the failure streak (FIX-244); the backfill later credits merged.",
      },
    ],
  },
  {
    field: "pr_merge",
    aggregate: "cycle",
    description: "Whether a PR merged, when, and as which commit.",
    authoritativeSource: "GitHub PR record (state, mergedAt, mergeCommit.oid)",
    writer: "GitHub",
    derivedViews: ["runs.jsonl merged_at/merge_commit stamps", "backlog Done annotations (PR#N links)", "dossier execution section"],
    conflictPolicy: "GitHub is external truth — local stamps that disagree are stale caches to rewrite, never the other way.",
    unknownPolicy: "gh failure / no network → unknown (the 2026-06-10 launchctl proxy poison made gh lie for 4 days — a dead probe is not a CLOSED PR).",
    rebuildability: "external",
    graceWindowSec: 600,
  },
  {
    field: "tcr_evidence",
    aggregate: "cycle",
    description: "How many test-guaranteed micro-commits a cycle produced.",
    authoritativeSource: "git log of the cycle branch (tcr: -prefixed commits) — commits are the proof",
    writer: "the agent's commit gate (roll test proof + commit hook)",
    derivedViews: ["runs.jsonl tcr_count", "cycle:tcr events", "dossier TCR section"],
    conflictPolicy: "recount from the branch when views disagree; a tcr_count no branch can substantiate is drift(warn).",
    unknownPolicy: "branch deleted after squash-merge → count is grandfathered from the runs row (the branch was the proof; the squash erased it legally).",
    rebuildability: "rebuildable",
  },
  {
    field: "attest_evidence",
    aggregate: "story",
    description: "A delivered story's acceptance report + intent map (ac-map) + Review Score (fresh-session peer Reviewer).",
    authoritativeSource: ".roll/features/<epic>/<ID>/ (card archive: latest/<ID>-report.html + ac-map.json + notes Review Score)",
    writer: "roll attest render layer (the only component allowed to mint verdict markup — evidence red line US-ATTEST-010)",
    derivedViews: ["dossier evidence phase", "consistency check cards lane", "release gate attest requirement"],
    conflictPolicy:
      "the rendered report is the arbiter of what evidence EXISTS; an ac-map referencing missing files downgrades to claimed at render (red line) — no other writer may upgrade a verdict.",
    unknownPolicy:
      "a delivery inside its cycle (report not yet rendered) is unknown; a Done story with no report past grace is drift(fail) — the v3.611.1 release gate hit exactly this for FIX-243/244/246/248/249 until evidence was produced.",
    rebuildability: "append-only",
    driftFixtures: [
      {
        id: "acmap-omission-epidemic",
        observed:
          "2026-06-10 cycles 212711/222703/233535: real deliveries with rendered reports but NO ac-map.json — the content floor judged every report an empty shell; the correction breaker paused the loop.",
        expectedVerdict: "fail",
        resolution:
          "attest_evidence's writer obligation (skill step 10.6) is enforced by the FIX-246 remediation pass: one surgical same-agent second write of the ac-map, honest statuses only; the gate itself stays hard.",
      },
    ],
  },
  {
    field: "usage_cost",
    aggregate: "cycle",
    description: "Tokens (in/out/cache r+w), model and USD cost one cycle consumed.",
    authoritativeSource: "the agent's own usage records: claude stream-json totals / footer-printing agents' stdout / pi session store (~/.pi/agent/sessions/<encoded-cwd>)",
    writer: "the agent runtime; the executor's cost fold is the one sanctioned transcriber into runs.jsonl",
    derivedViews: ["runs.jsonl tokens_*/cost_* fields", "dashboard token/cost columns", "budget ledger windows"],
    conflictPolicy: "re-derive from the agent-side record; a runs row claiming cost no session/stream substantiates is drift(warn).",
    unknownPolicy:
      "no parseable usage on any adapter lane → fields ABSENT (n/a), never zero — a fake $0 starves the budget guardrail exactly as on 2026-06-10 (FIX-249).",
    rebuildability: "rebuildable",
    graceWindowSec: 900,
    driftFixtures: [
      {
        id: "cost-blind-guardrail",
        observed:
          "all v3 pi cycles through 2026-06-10 wrote runs rows with no tokens/cost/model (pi prints no usage; session recovery unwired); dashboards read — / $0 and budgetPort was a stub returning ok.",
        expectedVerdict: "fail",
        resolution:
          "usage_cost recovers from the authoritative pi session store scoped to the cycle worktree+window; budget gate rebuilds its ledger from the transcribed rows (FIX-249, verified live: 123.9k/30.9k/14.3M tokens for cycle 233535).",
      },
    ],
  },
  {
    field: "dossier_freshness",
    aggregate: "view-meta",
    description: "Whether generated dossier/story pages reflect the current card facts.",
    authoritativeSource: "the card folders + backlog they are generated FROM",
    writer: "index-gen/dossier generators (story new / attest / set-status hooks, FIX-231)",
    derivedViews: [".roll/features/index.html", "per-story index.html pages"],
    conflictPolicy: "pages are pure caches — stale page vs live card is always resolved by regeneration, never by editing the page.",
    unknownPolicy: "a page older than its sources within one generation hook cycle is unknown; beyond grace it is drift(warn) + rebuild.",
    rebuildability: "rebuildable",
    graceWindowSec: DEFAULT_GRACE_WINDOW_SEC,
  },
  {
    field: "index_freshness",
    aggregate: "view-meta",
    description: "Whether .roll/index.json maps every live card id to its epic.",
    authoritativeSource: ".roll/backlog.md rows + the features/ tree they link",
    writer: "generateIndex (backlog-driven, deterministic)",
    derivedViews: [".roll/index.json", "cardArchiveDir epic resolution"],
    conflictPolicy: "regenerate on mismatch; resolution never blocks a write (missing entry falls back to uncategorized — D1).",
    unknownPolicy: "an id absent from both index and live walk is unknown (pre-card-era rows are grandfathered with the listed exemption).",
    rebuildability: "rebuildable",
  },
  {
    field: "release_verdict",
    aggregate: "release",
    description: "Whether a version was cleared to ship (consistency + tests + changelog).",
    authoritativeSource: "the release gate run record for the tag (consistency check outcome at ship time)",
    writer: "roll release (the ONE flow; the only path allowed to push v* tags — v* tag IS a release)",
    derivedViews: ["GitHub Release entry", "CHANGELOG.md section", "npm dist-tags (owner's 2FA action)"],
    conflictPolicy: "a v* tag without a gate record is drift(fail) — tags pushed around the gate are the violation, not an alternative truth.",
    unknownPolicy: "gate ran but GitHub Release/release.yml still in flight → unknown within grace.",
    rebuildability: "append-only",
    graceWindowSec: 1800,
  },
  {
    field: "release_waiver",
    aggregate: "release",
    description: "An owner's recorded decision to ship past a known drift.",
    authoritativeSource: "the waiver record (reason, scope, expiry, operator, timestamp) in the release fact stream",
    writer: "the owner via the explicit waiver command — never an env var or shell flag",
    derivedViews: ["release report waiver section", "subsequent audit runs (which must SEE the waiver)"],
    conflictPolicy: "an un-recorded bypass is itself drift(fail); an expired waiver no longer waives.",
    unknownPolicy: "no waiver record simply means no waiver — this field has no unknown window.",
    rebuildability: "append-only",
  },
  {
    field: "browser_run",
    aggregate: "story",
    description: "A browser operation run — its authorization, lane, origin, actions, diagnostics, and terminal result.",
    authoritativeSource: "OperationLedger (append-only event stream for browser operations)",
    writer: "BrowserOperationService (the only component allowed to create or update a run)",
    derivedViews: ["dossier browser section", "supervisor next summary", "attest browser evidence lane"],
    conflictPolicy: "the ledger is authoritative; a dossier view that disagrees is stale and must be regenerated.",
    unknownPolicy: "a run with no terminal event within its timeout window is unknown (crashed adapter).",
    rebuildability: "append-only",
  },
  {
    field: "browser_lease",
    aggregate: "story",
    description: "An interactive browser lease — exclusive, time-bounded owner approval to connect to owner Chrome.",
    authoritativeSource: "OperationLedger (lease-granted/lease-released/lease-expired events)",
    writer: "BrowserOperationService (the only component allowed to grant or release a lease)",
    derivedViews: ["dossier lease summary", "supervisor interactive status"],
    conflictPolicy: "the ledger is authoritative; a missing lease record means no active lease — never assume.",
    unknownPolicy: "no lease record for a story means no lease was granted — not unknown.",
    rebuildability: "append-only",
  },
  {
    field: "browser_diagnostic",
    aggregate: "story",
    description: "A browser diagnostic artifact (DOM snapshot, console/network summary, devtools screenshot) — untrusted, never visual AC evidence.",
    authoritativeSource: "DiagnosticStore (artifact written by the DevTools adapter, redacted before storage)",
    writer: "BrowserOperationService via the DevToolsAdapter",
    derivedViews: ["dossier diagnostic lane", "supervisor next browser details"],
    conflictPolicy: "the stored artifact (with digest) is authoritative; a dossier reference without a matching file is drift(warn).",
    unknownPolicy: "a missing artifact for a recorded diagnostic ref is drift(fail) — the ref exists but the file was lost.",
    rebuildability: "append-only",
  },
  {
    field: "browser_capture_link",
    aggregate: "story",
    description: "A link from a browser operation run to a Roll Capture physical screenshot (visual AC evidence).",
    authoritativeSource: "CaptureBridge (the only component that can request a physical capture after a browser operation passes)",
    writer: "CaptureBridge via the Attestation context",
    derivedViews: ["attest report visual evidence lane", "dossier capture section"],
    conflictPolicy: "the CaptureBridge record is authoritative; a dossier that shows capture but no bridge record is drift(fail).",
    unknownPolicy: "a passed browser run with no capture link is legitimate (not every operation needs visual AC).",
    rebuildability: "append-only",
  },
  // ── US-DELTA-001 — Delegation aggregate anchors ───────────────────────────
  {
    field: "delegation_lifecycle",
    aggregate: "delegation",
    description: "The Delegation protocol lifecycle: prepared → role/artifact transitions → delta:terminal / blocked.",
    authoritativeSource: "events.ndjson — the append-only delegation event stream",
    writer: "roll delta prepare / roll delta validate / roll delta conclude commands",
    derivedViews: ["roll delta status projection", "Supervisor Live Delta view"],
    conflictPolicy: "the event stream is authoritative; an artifact or manifest that disagrees with event facts is drift(fail).",
    unknownPolicy: "a delegation with no matching events is unknown — not assumed terminal.",
    rebuildability: "rebuildable",
  },
  {
    field: "delegation_provenance",
    aggregate: "delegation",
    description: "Resolution + identity-attestation correspondence: which host/model/role claims were recorded and whether they are structurally valid. Never asserts external host execution as a fact.",
    authoritativeSource: "delegation resolution evidence + events.ndjson (delta:role_resolved, delta:role_started, delta:artifact_published)",
    writer: "roll delta prepare (resolution) + host skill (attestation) + roll delta validate (structural cross-check)",
    derivedViews: ["roll delta status provenance display", "Supervisor Live role trace"],
    conflictPolicy: "the events are authoritative for accepted protocol facts; host-attested and adapter-observed are provenance labels, NOT verdicts about session freshness or model execution. A mismatch between event, manifest, and attestation → drift(fail).",
    unknownPolicy: "host-attested provenance is structurally unverifiable beyond non-empty/unique opaque tokens; claims may be structurally valid but unproven — cost is always ? (host_unobservable).",
    rebuildability: "rebuildable",
  },
  {
    field: "managed_workspace_lifecycle",
    aggregate: "execution",
    description: "A DeliveryRun's allocated managed workspace set and lifecycle transitions; delivery and evidence truth remain external inputs.",
    authoritativeSource: "events.ndjson worktree:* lifecycle events",
    writer: "managed workspace allocator / release recovery commands",
    derivedViews: ["managed workspace projection", "audit/canary/cleanup candidates"],
    conflictPolicy: "append-only lifecycle facts win; missing or conflicting Git inspection remains unknown/recovery-required and is never repaired by a mutable registry.",
    unknownPolicy: "historical cycles and Delta delegations without lifecycle events remain legacy/unknown without synthetic workspace facts.",
    rebuildability: "rebuildable",
  },
];

/** Resolve one anchor by field name; throws on an undeclared field so a typo
 *  can never silently invent a new fact source. */
export function truthAnchor(field: string): TruthAnchor {
  const a = TRUTH_ANCHORS.find((x) => x.field === field);
  if (a === undefined) throw new Error(`undeclared truth field "${field}" — declare it in packages/spec/src/types/truth.ts (US-TRUTH-000) before reading or writing it`);
  return a;
}
