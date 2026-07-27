/**
 * `roll loop reconcile [--json]` — US-DELIV-002.
 *
 * The IO adapter for the layered reconcile-from-main pure function. Gathers
 * facts from gh/git for each awaiting_merge cycle, runs the pure decision,
 * emits delivery:reconciled events, and handles retroactive heal of existing
 * unpublished/pending cycles.
 *
 * Architecture:
 *   - Pure decision: {@link reconcileDelivery} (packages/core/src/delivery/reconcile.ts).
 *   - IO adapter: this file collects gh PR state + git patch-ids, delegates to
 *     the pure function, and appends events.
 *   - Idempotent + crash-resumable: re-running reconcile is always safe.
 *   - US-DELIV-011: single-flight reconcile.lock + event-stream guards prevent
 *     duplicate merge attempts and duplicate delivered credits under overlap.
 *
 * Trigger points (design §7.3):
 *   - (a) cycle boundary in `roll loop run-once/go`
 *   - (b) `roll loop status` / `roll loop cycles` read-before-show
 *   - (c) explicit `roll loop reconcile [--json]`
 *   - (d) CI step `roll loop reconcile`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveLang, parseEventLine } from "@roll/spec";
import type { DeliveryLease, RollEvent, DeliveryState } from "@roll/spec";
import {
  EventBus,
  reconcileDelivery,
  projectDeliveryState,
  leaseStateFor,
  shouldAttemptPrMerge,
  classifyEvidenceRepair,
  resolveEvaluatorApproval,
  decideDraftAutoRepair,
  generateAcMap,
  repairedPrNumbers,
  parsePolicy,
  parseRollScoreArtifact,
  cycleIdFromBranch,
  type ReconcileCycle,
  type ReconcileFacts,
  type ReconcileResult,
  type RollEvaluatorScore,
} from "@roll/core";
import type { PrCloudState, PrStatusProvider } from "@roll/core";
import {
  acquireLock,
  GitHubPrStatusProvider,
  OUTER_LOCK_STALE_SEC,
  prMerge,
  prReady,
  prViewBotReviewState,
  releaseLock,
  resolveIntegrationBranch,
  type GhResult,
} from "@roll/infra";
// US-DELIV-008: the fact-gathering primitives moved to the shared adapter so
// the command path and the cycles read path feed the SAME reconcileDelivery
// the SAME facts (one truth engine, no parallel probes).
import { branchPatchId, mainPatchIdsSinceBranch, offlineMergeEvidence, resolveRepoSlug } from "../lib/delivery-facts.js";
import { collectGitDossierFacts, type GitDossierFacts } from "../lib/story-dossier.js";
import { settleDeliveredCycle, gitPlaneVerifier } from "./loop-reconcile-merge.js";

// ── Usage ─────────────────────────────────────────────────────────────────────

const RECONCILE_USAGE_EN = [
  "Usage: roll loop reconcile [--json] [--story <id>] [--dry-run]",
  "  Reconcile delivery truth: probe pending cycles against main (PR state + patch-id),",
  "  emit delivery:reconciled events, and heal existing unpublished/pending cycles.",
  "",
  "  --json       Machine-readable output (one JSON object per reconciled cycle).",
  "  --story <id> Reconcile only the named story (default: all awaiting cycles).",
  "  --dry-run    Report decisions without emitting events or merging.",
  "",
].join("\n");

const RECONCILE_USAGE_ZH = [
  "用法：roll loop reconcile [--json] [--story <id>] [--dry-run]",
  "  对账交付真相：以主干为锚点（PR 状态 + patch-id）反查待合并 cycle，",
  "  发出 delivery:reconciled 事件，对平存量未对账 cycle。",
  "",
  "  --json       机器可读输出（每个 cycle 一个 JSON 对象）。",
  "  --story <id> 只对账指定 story（默认：所有待合并 cycle）。",
  "  --dry-run    只报告判定，不写事件、不合入。",
  "",
].join("\n");

// ── Ports ─────────────────────────────────────────────────────────────────────

export interface LoopReconcileDeps {
  cwd: string;
  bus: EventBus;
  provider?: PrStatusProvider;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

function realDeps(): LoopReconcileDeps {
  return {
    cwd: process.cwd(),
    bus: new EventBus(),
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

// ── Fact gathering ────────────────────────────────────────────────────────────

function runtimeDir(cwd: string): string {
  const env = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return env !== "" ? env : join(cwd, ".roll", "loop");
}

/** US-DELIV-011: single-flight reconcile lock (atomic mkdir, same primitive as inner.lock). */
const RECONCILE_LOCK_NAME = "reconcile.lock";

function reconcileLockPath(cwd: string): string {
  return join(runtimeDir(cwd), RECONCILE_LOCK_NAME);
}

/** Read the full events stream for idempotency guards (re-read before side effects). */
function readAllEvents(eventsPath: string): RollEvent[] {
  if (!existsSync(eventsPath)) return [];
  try {
    const content = readFileSync(eventsPath, "utf8");
    const out: RollEvent[] = [];
    for (const line of content.split("\n")) {
      const ev = parseEventLine(line);
      if (ev !== null) out.push(ev);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * US-DELIV-010: map one provider poll onto {@link ReconcileFacts} — BOTH the
 * command path and the tick feed the SAME pure engine the SAME facts. `open`
 * carries draft/mergeable so the engine can classify degraded PRs instead of
 * merging blind; `unreachable` carries its reason (auth → no_permission).
 */
function applyPrCloudState(facts: ReconcileFacts, st: PrCloudState): void {
  switch (st.kind) {
    case "merged":
      facts.prState = "MERGED";
      facts.prMergeCommit = st.mergeCommit;
      return;
    case "open":
      facts.prState = "OPEN";
      // FIX-1248: only a truly red CI is ci_failed. unknown/pending means
      // "keep waiting", NOT failure — collapsing them to false made the
      // reconciler condemn still-running (or unpolled) checks as failed.
      facts.ciGreen = st.ci === "green" ? true : st.ci === "red" ? false : undefined;
      facts.prDraft = st.draft;
      facts.prMergeable = st.mergeable;
      return;
    case "closed_unmerged":
      facts.prState = "CLOSED";
      return;
    case "unreachable":
      facts.prUnreachableReason = st.reason;
      return;
  }
}

/** US-DELIV-010: per-verdict icon for reconcile output. */
function resultIcon(result: ReconcileResult): string {
  switch (result.kind) {
    case "delivered":
      return "✅";
    case "merge_now":
      return "🔄";
    case "ci_failed":
      return "❌";
    case "degraded":
      return "⚠️";
    case "terminal":
      return "🛑";
    default:
      return "⏳";
  }
}

/** US-DELIV-010: reason + dwell suffix for degraded/terminal verdicts. */
function resultDetail(result: ReconcileResult): string {
  if (result.kind !== "degraded" && result.kind !== "terminal") return "";
  const dwell =
    result.dwellMs !== undefined ? ` · dwell ${Math.round(result.dwellMs / 3_600_000)}h` : "";
  return ` · ${result.reason}${dwell}`;
}

// ── Event reading ─────────────────────────────────────────────────────────────

interface CycleSnapshot {
  cycleId: string;
  storyId: string;
  branch: string;
  prNumber?: number;
  deliveryState: DeliveryState;
  /** US-DELIV-010: ts of delivery:published — the awaiting_merge dwell anchor. */
  awaitingSinceMs?: number;
}

/**
 * Read events.ndjson and extract cycle delivery snapshots.
 * Returns published cycles that are awaiting_merge (or ci_failed). A cycle
 * without a delivery:published event has no PR or branch claim to reconcile;
 * admitting it would let unrelated main history credit an aborted attempt.
 */
function readAwaitingCycles(cwd: string, includeDelivered = false): CycleSnapshot[] {
  const eventsPath = join(runtimeDir(cwd), "events.ndjson");
  if (!existsSync(eventsPath)) return [];

  let content = "";
  try {
    content = readFileSync(eventsPath, "utf8");
  } catch {
    return [];
  }

  // Collect per-cycle events for projection.
  const cycleEvents = new Map<string, RollEvent[]>();
  const cycleMeta = new Map<string, { storyId: string; branch: string; prNumber?: number; awaitingSinceMs?: number }>();

  for (const line of content.split("\n")) {
    const ev = parseEventLine(line);
    if (ev === null) continue;

    const cid = "cycleId" in ev ? (ev as RollEvent & { cycleId: string }).cycleId : undefined;
    if (cid === undefined) continue;
    if (!cycleEvents.has(cid)) cycleEvents.set(cid, []);
    cycleEvents.get(cid)!.push(ev);

    // Capture metadata.
    if (ev.type === "cycle:start") {
      cycleMeta.set(cid, { storyId: ev.storyId, branch: `loop/${cid}`, prNumber: undefined });
    }
    if (ev.type === "delivery:published" && "prNumber" in ev) {
      const meta = cycleMeta.get(cid);
      if (meta) {
        meta.prNumber = (ev as RollEvent & { prNumber: number }).prNumber;
        meta.branch = (ev as RollEvent & { branch: string }).branch;
        // US-DELIV-010: dwell anchor — when the cycle entered awaiting_merge.
        const ts = (ev as RollEvent & { ts?: number }).ts;
        if (typeof ts === "number") meta.awaitingSinceMs = ts;
      }
    }
  }

  // Project each cycle and filter to awaiting_merge.
  const snapshots: CycleSnapshot[] = [];
  for (const [cycleId, events] of cycleEvents) {
    const state = projectDeliveryState(events, cycleId);
    // Only a published PR cycle has strong delivery evidence to reconcile.
    // `ci_failed` retains its published metadata and is eligible for recovery.
    // The periodic tick skips delivered rows after writing them back; the
    // explicit command includes them so a previously reconciled merge can
    // repair an interrupted backlog status flip.
    const deliveredTerminal =
      state === "delivered" || state === "delivered_external" || state === "delivered_local";
    if (state !== "awaiting_merge" && state !== "ci_failed" && !(includeDelivered && deliveredTerminal)) {
      continue;
    }
    const meta = cycleMeta.get(cycleId) ?? { storyId: "", branch: `loop/${cycleId}` };
    if (meta.prNumber === undefined || meta.awaitingSinceMs === undefined) continue;
    snapshots.push({
      cycleId,
      storyId: meta.storyId,
      branch: meta.branch,
      prNumber: meta.prNumber,
      deliveryState: state,
      awaitingSinceMs: meta.awaitingSinceMs,
    });
  }

  return snapshots;
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ReconcileReportItem {
  cycleId: string;
  storyId: string;
  branch: string;
  prNumber?: number;
  previousState: DeliveryState;
  result: ReconcileResult;
  signal?: string;
  mergeCommit?: string;
}

/** Summary returned by a reconcile tick (used at loop boundaries). */
export interface ReconcileTickResult {
  cyclesProcessed: number;
  delivered: number;
  mergeNow: number;
  ciFailed: number;
  /** US-DELIV-010: stuck-but-alive cycles (draft / conflict / ci_stuck / no_permission). */
  degraded: number;
  /** US-DELIV-010: dead-end cycles (pr_closed_unmerged). */
  terminal: number;
  waiting: number;
  /** FIX-1260: draft PRs auto-repaired and promoted to ready in this tick. */
  autoRepaired: number;
}

/**
 * Run the core reconcile loop — idempotent, crash-safe.
 *
 * Reads awaiting_merge cycles from events, gathers facts (gh/git), runs the
 * pure reconcileDelivery decision for each, executes merges for merge_now
 * verdicts, and emits delivery:reconciled / delivery:merge_attempt events.
 *
 * This is used both by the explicit `roll loop reconcile` command and by
 * automatic reconcile ticks at loop boundaries (pre-pick + post-publish in
 * `roll loop run-once/go`).
 *
 * @param cwd - Project root
 * @param opts.silent - Suppress stdout per-cycle output (used for ticks)
 * @param opts.storyFilter - Only reconcile the named story (optional)
 * @param opts.provider - PR status provider override (default: GitHub via gh)
 * @returns A count summary of reconcile decisions
 */
export async function runReconcileTick(
  cwd: string,
  opts?: { silent?: boolean; storyFilter?: string; provider?: PrStatusProvider },
): Promise<ReconcileTickResult> {
  const slug = resolveRepoSlug(cwd);

  // Read awaiting cycles from event stream.
  let cycles = readAwaitingCycles(cwd);
  if (opts?.storyFilter !== undefined) {
    cycles = cycles.filter((c) => c.storyId === opts.storyFilter);
  }

  if (cycles.length === 0) {
    return { cyclesProcessed: 0, delivered: 0, mergeNow: 0, ciFailed: 0, degraded: 0, terminal: 0, waiting: 0, autoRepaired: 0 };
  }

  // US-DELIV-011: single-flight — overlapping reconcile sources yield; never block the loop.
  const lockPath = reconcileLockPath(cwd);
  const lock = acquireLock(lockPath, process.pid, {
    staleSec: OUTER_LOCK_STALE_SEC,
    cycleId: "reconcile",
  });
  if (!lock.acquired) {
    return { cyclesProcessed: 0, delivered: 0, mergeNow: 0, ciFailed: 0, degraded: 0, terminal: 0, waiting: 0, autoRepaired: 0 };
  }

  const provider = opts?.provider ?? (slug !== undefined ? new GitHubPrStatusProvider() : undefined);
  const rt = runtimeDir(cwd);
  const eventsPath = join(rt, "events.ndjson");
  const runsPath = join(rt, "runs.jsonl");
  const bus = new EventBus();
  bus.ensureEventFiles(eventsPath, runsPath);

  const now = Date.now();
  // US-DELIV-008: the dossier git snapshot for offline L1 — built lazily on
  // first need (only when gh is silent for some cycle), shared across cycles.
  let gitFacts: GitDossierFacts | null | undefined;
  let delivered = 0;
  let mergeNow = 0;
  let ciFailed = 0;
  let degraded = 0;
  let terminal = 0;
  let waiting = 0;
  // FIX-1260: count of auto-repaired draft PRs.
  let autoRepaired = 0;

  try {
  for (const cyc of cycles) {
    if (!opts?.silent) {
      process.stdout.write(`  ${cyc.cycleId} · ${cyc.storyId || "—"} · ${cyc.deliveryState}…`);
    }

    // Gather facts.
    const facts: ReconcileFacts = {
      mainPatchIds: new Set(),
      backlogDone: false,
      attestPresent: false,
      nowMs: now,
    };

    // L1: PR state via gh.
    if (provider !== undefined && cyc.prNumber !== undefined && slug !== undefined) {
      try {
        applyPrCloudState(facts, await provider.pollPrStatus(slug, cyc.prNumber));
      } catch {
        // gh unavailable — L1 is silent; fall through to offline L1 / L2.
      }
    }

    // US-DELIV-008: when gh is silent, fall back to offline L1.
    if (facts.prState === undefined) {
      gitFacts ??= collectGitDossierFacts(cwd);
      if (offlineMergeEvidence(gitFacts, cyc.storyId, cyc.prNumber) === "MERGED") {
        facts.prState = "MERGED";
      }
    }

    // L2: patch-id equivalence (skipped when L1 already fired).
    if (facts.prState !== "MERGED") {
      const integrationBranch = resolveIntegrationBranch(cwd);
      facts.branchNetPatchId = branchPatchId(cwd, cyc.branch, integrationBranch);
      if (facts.branchNetPatchId !== undefined) {
        facts.mainPatchIds = mainPatchIdsSinceBranch(cwd, cyc.branch, integrationBranch);
      }
    }

    // FIX-1260: auto-repair draft PRs that are CI green + evaluator approved +
    // merge clean. The three-step (repair-evidence → ready → merge) that the
    // supervisor used to run manually is now automatic in the reconcile tick.
    if (facts.prDraft === true && facts.ciGreen === true && facts.prMergeable === "MERGEABLE") {
      const policyPath = join(runtimeDir(cwd), "..", "policy.yaml");
      let autoRepairEnabled = true; // default on
      if (existsSync(policyPath)) {
        try {
          autoRepairEnabled = parsePolicy(readFileSync(policyPath, "utf8")).loopSafety.autoRepairEvidence;
        } catch {
          // Unparseable policy → keep default (on).
        }
      }

      if (autoRepairEnabled && cyc.prNumber !== undefined && slug !== undefined) {
        // Resolve evaluator approval (Roll peer score + GitHub bot review).
        const freshEvents = readAllEvents(eventsPath);
        const alreadyRepaired = repairedPrNumbers(freshEvents).has(cyc.prNumber);

        let reviewState = "";
        try {
          reviewState = await prViewBotReviewState(slug, String(cyc.prNumber));
        } catch {
          // gh unavailable → conservative. Without bot review, fall through to
          // the Roll evaluator score check.
        }

        // Resolve Roll evaluator score from peer artifact / pair:score events.
        let rollScore: RollEvaluatorScore | null = null;
        const cycleId = cyc.cycleId;
        if (cycleId !== "") {
          const peerArtifact = join(runtimeDir(cwd), "peer", `cycle-${cycleId}.score.pair.json`);
          if (existsSync(peerArtifact)) {
            try {
              const parsed = parseRollScoreArtifact(JSON.parse(readFileSync(peerArtifact, "utf8")));
              if (parsed !== null) rollScore = parsed;
            } catch {
              // Corrupt artifact → fall back to event stream.
            }
          }
          if (rollScore === null) {
            let latestScore: { score: number; verdict: string } | null = null;
            let latestTs = -1;
            for (const ev of freshEvents) {
              if (
                ev.type === "pair:score" &&
                "cycleId" in ev && ev.cycleId === cycleId &&
                "stage" in ev && (ev as { stage?: string }).stage === "score" &&
                ev.ts > latestTs
              ) {
                latestScore = { score: (ev as { score: number }).score, verdict: (ev as { verdict: string }).verdict };
                latestTs = ev.ts;
              }
            }
            if (latestScore !== null) rollScore = latestScore;
          }
        }

        // Check auto-repair eligibility using the pure core decision function.
        const decision = decideDraftAutoRepair({
          ciState: facts.ciGreen === true ? "success" : "failure",
          reviewState: reviewState || "none",
          mergeable: "CLEAN",
          isDraft: true,
          hasFreshReport: false,
          alreadyRepaired,
          rollEvaluatorScore: rollScore,
        });

        if (decision.verdict === "eligible") {
          // ── Execute auto-repair: repair-evidence → ready → merge ─────────
          try {
            // 1. Generate repair evidence artifacts (ac-map + report).
            const featuresDir = join(cwd, ".roll", "features");
            let storyDir = "";
            if (existsSync(featuresDir) && cyc.storyId !== "") {
              const entries = readdirSync(featuresDir, { withFileTypes: true });
              for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const candidate = join(featuresDir, entry.name, cyc.storyId);
                if (existsSync(join(candidate, "spec.md"))) {
                  storyDir = candidate;
                  break;
                }
              }
            }

            // Write repair summary evidence file.
            const evidenceDir = storyDir !== "" ? join(storyDir, "evidence") : "";
            const repairSummaryFile = "repair-auto-summary.txt";
            const repairSummaryRel = evidenceDir !== "" ? `evidence/${repairSummaryFile}` : repairSummaryFile;
            if (evidenceDir !== "") {
              mkdirSync(evidenceDir, { recursive: true });
              const summaryLines = [
                `Auto-repair evidence for ${cyc.storyId || `PR-${cyc.prNumber}`} — PR #${cyc.prNumber}`,
                `Generated: ${new Date().toISOString()}`,
                `CI state: ${facts.ciGreen === true ? "green" : "unknown"}`,
                `Evaluator: ${decision.evaluatorSource} — ${decision.evaluatorDetail}`,
                `Mergeable: clean`,
                `Repair verdict: auto (eligible)`,
                `Reason: ${decision.reason}`,
                "",
                "Auto-repair executed during reconcile tick. The draft PR was CI green",
                "+ evaluator approved + merge clean. Evidence was auto-generated and",
                "the PR was promoted to ready for merge.",
              ];
              writeFileSync(join(evidenceDir, repairSummaryFile), summaryLines.join("\n") + "\n", "utf8");
            }

            // Generate ac-map with readonly status.
            if (storyDir !== "") {
              const evidenceRefs: Array<{ kind: string; label: string; textFile: string }> = [
                { kind: "text", label: `auto-repair: PR #${cyc.prNumber} ${decision.evaluatorSource} approved`, textFile: repairSummaryRel },
              ];
              // Parse ACs from spec.md.
              const specPath = join(storyDir, "spec.md");
              let acItems: Array<{ id: string; text: string }> = [];
              if (existsSync(specPath)) {
                try {
                  const md = readFileSync(specPath, "utf8");
                  const re = /^- \[([ x])\] (.+)$/gm;
                  let acIdx = 1;
                  let m: RegExpExecArray | null;
                  while ((m = re.exec(md)) !== null) {
                    acItems.push({ id: `${cyc.storyId}:AC${acIdx}`, text: String(m[2] ?? "") });
                    acIdx++;
                  }
                } catch {
                  // Spec unreadable → acItems stays empty.
                }
              }
              if (acItems.length === 0 && cyc.storyId !== "") {
                acItems.push({ id: `${cyc.storyId}:AC1`, text: "Delivery accepted by independent evaluator" });
              }
              if (acItems.length > 0) {
                const acMap = generateAcMap(cyc.storyId, acItems, {
                  status: "readonly",
                  evidenceRefs,
                  fallbackTextFile: repairSummaryRel,
                });
                writeFileSync(join(storyDir, "ac-map.json"), JSON.stringify(acMap, null, 2) + "\n", "utf8");
              }

              // Write a minimal HTML acceptance report.
              const latestDir = join(storyDir, "latest");
              mkdirSync(latestDir, { recursive: true });
              const reportHtml = [
                "<!DOCTYPE html>",
                `<html><head><meta charset="utf-8"><title>${cyc.storyId} Acceptance (auto-repair)</title></head>`,
                "<body>",
                `<h1>${cyc.storyId} — Acceptance Report (auto-repair)</h1>`,
                `<p><strong>PR:</strong> #${cyc.prNumber}</p>`,
                `<p><strong>Generated:</strong> ${new Date().toISOString()}</p>`,
                `<p><strong>Method:</strong> auto-repair-evidence (reconcile tick)</p>`,
                `<p><strong>Evaluator:</strong> ${decision.evaluatorSource} — ${decision.evaluatorDetail}</p>`,
                "<p><strong>CI:</strong> green · <strong>Merge:</strong> clean</p>",
                "<p>This report was auto-generated during the reconcile tick.",
                "The draft PR satisfied all hard conditions (CI green, independent",
                "evaluator approved, merge clean) and was auto-promoted to ready.",
                `See <a href="../ac-map.json">ac-map.json</a> for detailed acceptance criteria.</p>`,
                "</body></html>",
              ].join("\n");
              writeFileSync(join(latestDir, `${cyc.storyId}-report.html`), reportHtml, "utf8");
            }

            // 2. Record repair:auto event BEFORE promoting (audit trail).
            const autoRepairEvent: RollEvent = {
              type: "repair:auto",
              prNumber: cyc.prNumber,
              storyId: cyc.storyId,
              cycleId: cyc.cycleId,
              evaluatorSource: decision.evaluatorSource,
              evaluatorDetail: decision.evaluatorDetail,
              reason: decision.reason,
              ts: now,
            };
            bus.appendEvent(eventsPath, autoRepairEvent);

            // 3. Promote draft → ready.
            const readyResult: GhResult = await prReady(slug, String(cyc.prNumber));

            // Record promote outcome.
            bus.appendEvent(eventsPath, {
              type: "repair:auto:ready",
              prNumber: cyc.prNumber,
              storyId: cyc.storyId,
              cycleId: cyc.cycleId,
              outcome: readyResult.code === 0 ? "ready" : "failed",
              ts: now,
            });

            if (readyResult.code === 0) {
              // Mark facts so reconcileDelivery sees it as a normal (non-draft) PR.
              facts.prDraft = false;
              autoRepaired++;
              if (!opts?.silent) {
                process.stdout.write(
                  ` 🔧 auto-repair → ready · ${decision.evaluatorSource}`,
                );
              }
            } else {
              if (!opts?.silent) {
                process.stdout.write(
                  ` ⚠️ auto-repair ready failed (code ${readyResult.code})`,
                );
              }
            }
          } catch (err: unknown) {
            if (!opts?.silent) {
              process.stdout.write(` ⚠️ auto-repair error: ${String(err)}`);
            }
          }
        }
      }
    }

    // Run pure decision.
    const reconcileCycle: ReconcileCycle = {
      cycleId: cyc.cycleId,
      storyId: cyc.storyId,
      branch: cyc.branch,
      prNumber: cyc.prNumber,
      deliveryState: cyc.deliveryState,
      awaitingSinceMs: cyc.awaitingSinceMs,
    };
    const result = reconcileDelivery(reconcileCycle, facts);

    // Count non-delivered verdicts here; a delivered verdict is counted AFTER
    // the git-plane-gated settle below (a deferred delivered counts as waiting).
    if (result.kind === "merge_now") mergeNow++;
    else if (result.kind === "ci_failed") ciFailed++;
    else if (result.kind === "degraded") degraded++;
    else if (result.kind === "terminal") terminal++;
    else if (result.kind !== "delivered") waiting++;

    if (result.kind === "delivered") {
      // US-CYCLE-009 (codex r2): route ALL terminal signals — delivery:reconciled,
      // sibling-cancel, backlog flip, merge_confirmed — through ONE git-plane gate.
      // A gh-state-only delivered that the git plane cannot confirm DEFERS (stays
      // non-terminal, re-included next tick); only a git-plane-confirmed merge
      // (ancestor / patch-id / (#N) on main) terminalizes + flips.
      const siblingLeases: DeliveryLease[] = [];
      for (const other of cycles) {
        if (other.cycleId === cyc.cycleId || other.storyId === "" || other.storyId !== cyc.storyId) continue;
        const state = leaseStateFor(other.deliveryState, false);
        if (state !== undefined) siblingLeases.push({ storyId: other.storyId, cycleId: other.cycleId, state });
      }
      const settle = await settleDeliveredCycle(
        {
          cwd,
          eventsPath,
          now,
          events: readAllEvents(eventsPath),
          appendEvent: (p, ev) => bus.appendEvent(p, ev),
          alert: (message) => bus.appendEvent(eventsPath, { type: "loop:error", loop: "main", error: message, ts: now }),
          verify: gitPlaneVerifier({ cwd, branch: cyc.branch, prNumber: cyc.prNumber, storyId: cyc.storyId, dossierFacts: gitFacts }),
        },
        { cycleId: cyc.cycleId, storyId: cyc.storyId, branch: cyc.branch, prNumber: cyc.prNumber, result, siblingLeases },
      );
      if (settle.credited) delivered++;
      else waiting++;
    }
    if (result.kind === "terminal") {
      bus.appendEvent(eventsPath, {
        type: "delivery:abandoned",
        cycleId: cyc.cycleId,
        storyId: cyc.storyId,
        reason: result.reason,
        ts: now,
      });
    }

    // ── merge_now: execute gh pr merge --squash ───────────────────────────
    if (result.kind === "merge_now") {
      const freshEvents = readAllEvents(eventsPath);
      if (shouldAttemptPrMerge(freshEvents, cyc.cycleId)) {
        if (slug !== undefined && cyc.prNumber !== undefined) {
          let outcome: "merged" | "blocked" | "gh_down" = "gh_down";
          try {
            const mergeResult: GhResult = await prMerge(slug, String(cyc.prNumber), "plain");
            outcome = mergeResult.code === 0 ? "merged" : "blocked";
          } catch {
            outcome = "gh_down";
          }
          bus.appendEvent(eventsPath, {
            type: "delivery:merge_attempt",
            cycleId: cyc.cycleId,
            prNumber: cyc.prNumber,
            method: "squash",
            outcome,
            ts: now,
          });
        } else {
          bus.appendEvent(eventsPath, {
            type: "delivery:merge_attempt",
            cycleId: cyc.cycleId,
            prNumber: cyc.prNumber ?? 0,
            method: "squash",
            outcome: "gh_down" as const,
            ts: now,
          });
        }
      }
    }

    if (!opts?.silent) {
      process.stdout.write(` ${resultIcon(result)} ${result.kind}${resultDetail(result)}`);
      if (result.kind === "delivered") {
        process.stdout.write(` · ${result.signal}`);
        if (result.mergeCommit) {
          process.stdout.write(` · ${result.mergeCommit.slice(0, 7)}`);
        }
      }
      process.stdout.write("\n");
    }
  }

  return { cyclesProcessed: cycles.length, delivered, mergeNow, ciFailed, degraded, terminal, waiting, autoRepaired };
  } finally {
    releaseLock(lockPath);
  }
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function loopReconcileCommand(
  args: string[],
  deps: LoopReconcileDeps = realDeps(),
): Promise<number> {
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });

  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout.write(`${lang === "zh" ? RECONCILE_USAGE_ZH : RECONCILE_USAGE_EN}\n`);
    return 0;
  }

  const jsonMode = args.includes("--json");
  const dryRun = args.includes("--dry-run");

  // Parse --story <id>
  const storyIdx = args.indexOf("--story");
  const storyFilter: string | undefined =
    storyIdx >= 0 && storyIdx + 1 < args.length ? args[storyIdx + 1] : undefined;

  const unknown = args.filter(
    (a) => !["--json", "--dry-run", "--story"].includes(a) && a !== storyFilter,
  );
  if (unknown.length > 0) {
    deps.stderr.write(
      `${lang === "zh" ? "[roll] 未知标志" : "[roll] unknown flag"}: ${unknown[0]}\n${lang === "zh" ? RECONCILE_USAGE_ZH : RECONCILE_USAGE_EN}\n`,
    );
    return 1;
  }

  const cwd = deps.cwd;
  const slug = resolveRepoSlug(cwd);

  // Read awaiting cycles from event stream.
  let cycles = readAwaitingCycles(cwd, storyFilter !== undefined);
  if (storyFilter !== undefined) {
    cycles = cycles.filter((c) => c.storyId === storyFilter);
  }

  if (cycles.length === 0) {
    deps.stdout.write(
      lang === "zh" ? "没有待对账的 cycle。\n" : "No cycles awaiting reconciliation.\n",
    );
    return 0;
  }

  // US-DELIV-011: single-flight reconcile — concurrent sources yield cleanly.
  const lockPath = reconcileLockPath(cwd);
  const lock = acquireLock(lockPath, process.pid, {
    staleSec: OUTER_LOCK_STALE_SEC,
    cycleId: "reconcile",
  });
  if (!lock.acquired) {
    deps.stdout.write(
      lang === "zh"
        ? `对账跳过：另一 reconcile 正在运行 (pid ${lock.heldByPid ?? "?"})。\n`
        : `Reconcile skipped: another reconcile is in progress (pid ${lock.heldByPid ?? "?"}).\n`,
    );
    return 0;
  }

  const provider = deps.provider ?? (slug !== undefined ? new GitHubPrStatusProvider() : undefined);
  const rt = runtimeDir(cwd);
  const eventsPath = join(rt, "events.ndjson");
  const runsPath = join(rt, "runs.jsonl");
  deps.bus.ensureEventFiles(eventsPath, runsPath);

  const now = Date.now();
  const reportItems: ReconcileReportItem[] = [];
  // US-DELIV-008: the dossier git snapshot for offline L1 — built lazily on
  // first need (only when gh is silent for some cycle), shared across cycles.
  let gitFacts: GitDossierFacts | null | undefined;

  try {
  for (const cyc of cycles) {
    deps.stdout.write(
      lang === "zh"
        ? `  ${cyc.cycleId} · ${cyc.storyId || "—"} · ${cyc.deliveryState}…`
        : `  ${cyc.cycleId} · ${cyc.storyId || "—"} · ${cyc.deliveryState}…`,
    );

    // Gather facts.
    const facts: ReconcileFacts = {
      mainPatchIds: new Set(),
      backlogDone: false,
      attestPresent: false,
      nowMs: now,
    };

    // L1: PR state via gh.
    if (provider !== undefined && cyc.prNumber !== undefined && slug !== undefined) {
      try {
        applyPrCloudState(facts, await provider.pollPrStatus(slug, cyc.prNumber));
      } catch {
        // gh unavailable — L1 is silent; fall through to offline L1 / L2.
      }
    }

    // US-DELIV-008: when gh is silent (no provider / PR unresolved / error),
    // fall back to the SAME offline L1 the cycles read path uses — a `(#N)`
    // merge commit on main (or, for PR-less cycles, a subject naming the
    // story). gh remains authoritative when it answers; this only fills the
    // silence, so the command and the read path can never diverge on a merge
    // main already records (e.g. branch deleted after a squash merge).
    if (facts.prState === undefined) {
      gitFacts ??= collectGitDossierFacts(cwd);
      if (offlineMergeEvidence(gitFacts, cyc.storyId, cyc.prNumber) === "MERGED") {
        facts.prState = "MERGED";
      }
    }

    // L2: patch-id equivalence (skipped when L1 already fired — it wins inside
    // reconcileDelivery anyway, and the per-branch spawns are wasted).
    if (facts.prState !== "MERGED") {
      const integrationBranch = resolveIntegrationBranch(cwd);
      facts.branchNetPatchId = branchPatchId(cwd, cyc.branch, integrationBranch);
      if (facts.branchNetPatchId !== undefined) {
        facts.mainPatchIds = mainPatchIdsSinceBranch(cwd, cyc.branch, integrationBranch);
      }
    }

    // Run pure decision.
    const reconcileCycle: ReconcileCycle = {
      cycleId: cyc.cycleId,
      storyId: cyc.storyId,
      branch: cyc.branch,
      prNumber: cyc.prNumber,
      deliveryState: cyc.deliveryState,
      awaitingSinceMs: cyc.awaitingSinceMs,
    };
    const result = reconcileDelivery(reconcileCycle, facts);

    const item: ReconcileReportItem = {
      cycleId: cyc.cycleId,
      storyId: cyc.storyId,
      branch: cyc.branch,
      prNumber: cyc.prNumber,
      previousState: cyc.deliveryState,
      result,
    };

    if (result.kind === "delivered") {
      item.signal = result.signal;
      item.mergeCommit = result.mergeCommit;

      // US-CYCLE-009 (codex r2): ALL terminal signals (delivery:reconciled,
      // sibling-cancel, backlog flip, merge_confirmed, branch delete) go through
      // the ONE git-plane-gated decision point. --dry-run mutates NOTHING:
      // report only. A gh-state-only delivered that the git plane cannot confirm
      // DEFERS (no delivery:reconciled → stays awaiting_merge, re-included next
      // tick); a git-plane-confirmed merge terminalizes + flips.
      if (!dryRun) {
        const siblingLeases: DeliveryLease[] = [];
        for (const other of cycles) {
          if (other.cycleId === cyc.cycleId || other.storyId === "" || other.storyId !== cyc.storyId) continue;
          const state = leaseStateFor(other.deliveryState, false);
          if (state !== undefined) siblingLeases.push({ storyId: other.storyId, cycleId: other.cycleId, state });
        }
        await settleDeliveredCycle(
          {
            cwd,
            eventsPath,
            now,
            events: readAllEvents(eventsPath),
            appendEvent: (p, ev) => deps.bus.appendEvent(p, ev),
            alert: (message) => deps.bus.appendEvent(eventsPath, { type: "loop:error", loop: "main", error: message, ts: now }),
            verify: gitPlaneVerifier({ cwd, branch: cyc.branch, prNumber: cyc.prNumber, storyId: cyc.storyId, dossierFacts: gitFacts }),
          },
          { cycleId: cyc.cycleId, storyId: cyc.storyId, branch: cyc.branch, prNumber: cyc.prNumber, result, siblingLeases },
        );
      }
    }
    if (result.kind === "terminal" && !dryRun) {
      deps.bus.appendEvent(eventsPath, {
        type: "delivery:abandoned",
        cycleId: cyc.cycleId,
        storyId: cyc.storyId,
        reason: result.reason,
        ts: now,
      });
    }

    // ── merge_now: execute gh pr merge --squash ───────────────────────────
    // US-DELIV-003: self-driven merge — does not rely on repo auto-merge
    // setting or launchd. Uses "plain" mode (no --auto, no --admin).
    if (result.kind === "merge_now" && !dryRun) {
      const freshEvents = readAllEvents(eventsPath);
      if (shouldAttemptPrMerge(freshEvents, cyc.cycleId)) {
        if (slug !== undefined && cyc.prNumber !== undefined) {
          let outcome: "merged" | "blocked" | "gh_down" = "gh_down";
          try {
            const mergeResult: GhResult = await prMerge(slug, String(cyc.prNumber), "plain");
            outcome = mergeResult.code === 0 ? "merged" : "blocked";
          } catch {
            // gh binary not found / unspawnable → gh_down
            outcome = "gh_down";
          }
          deps.bus.appendEvent(eventsPath, {
            type: "delivery:merge_attempt",
            cycleId: cyc.cycleId,
            prNumber: cyc.prNumber,
            method: "squash",
            outcome,
            ts: now,
          });
        } else {
          // slug not resolved (no GitHub remote) → gh_down, stay awaiting_merge
          deps.bus.appendEvent(eventsPath, {
            type: "delivery:merge_attempt",
            cycleId: cyc.cycleId,
            prNumber: cyc.prNumber ?? 0,
            method: "squash",
            outcome: "gh_down" as const,
            ts: now,
          });
        }
      }
    }

    reportItems.push(item);

    // Print result.
    deps.stdout.write(` ${resultIcon(result)} ${result.kind}${resultDetail(result)}`);
    if (result.kind === "delivered") {
      deps.stdout.write(` · ${result.signal}`);
      if (result.mergeCommit) {
        deps.stdout.write(` · ${result.mergeCommit.slice(0, 7)}`);
      }
    }
    deps.stdout.write("\n");
  }

  // Summary.
  const delivered = reportItems.filter((i) => i.result.kind === "delivered").length;
  const mergeNow = reportItems.filter((i) => i.result.kind === "merge_now").length;
  const ciFailed = reportItems.filter((i) => i.result.kind === "ci_failed").length;
  const degraded = reportItems.filter((i) => i.result.kind === "degraded").length;
  const terminal = reportItems.filter((i) => i.result.kind === "terminal").length;
  const waiting = reportItems.filter((i) => i.result.kind === "wait").length;

  deps.stdout.write(
    lang === "zh"
      ? `\n对账完成：${reportItems.length} 个 cycle · ${delivered} 已交付 · ${mergeNow} 待合并 · ${ciFailed} CI 失败 · ${degraded} 降级 · ${terminal} 终结 · ${waiting} 挂起${dryRun ? "（--dry-run）" : ""}\n`
      : `\nReconciled ${reportItems.length} cycles · ${delivered} delivered · ${mergeNow} merge-ready · ${ciFailed} CI failed · ${degraded} degraded · ${terminal} terminal · ${waiting} waiting${dryRun ? " (--dry-run)" : ""}\n`,
  );

  // --json output.
  if (jsonMode) {
    const jsonOutput = reportItems.map((item) => ({
      cycleId: item.cycleId,
      storyId: item.storyId,
      branch: item.branch,
      prNumber: item.prNumber,
      previousState: item.previousState,
      kind: item.result.kind,
      signal: item.signal,
      mergeCommit: item.mergeCommit,
      // US-DELIV-010: degraded/terminal verdicts are observable — reason +
      // dwell ride the JSON report for US-DELIV-012 rendering and triage.
      reason:
        item.result.kind === "degraded" || item.result.kind === "terminal"
          ? item.result.reason
          : undefined,
      dwellMs:
        item.result.kind === "degraded" || item.result.kind === "terminal"
          ? item.result.dwellMs
          : undefined,
    }));
    deps.stdout.write(JSON.stringify(jsonOutput, null, 2) + "\n");
  }

  return 0;
  } finally {
    releaseLock(lockPath);
  }
}
