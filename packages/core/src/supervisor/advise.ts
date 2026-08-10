/**
 * @responsibility Turns supervisor facts into structured advisory decisions.
 * US-V4-008 — Supervisor v0: ADVISE.
 *
 * Turns {@link SupervisorFacts} into structured {@link SupervisorDecision}
 * records and answers system-level questions ("what should Roll do next?", "why
 * is the project stuck?"). Pure. Advisory ONLY: every decision that would change
 * persistent policy carries `requiresOwner: true` — Supervisor never silently
 * rewrites routing/policy or marks a Story Done (the metrics-don't-mutate-policy
 * invariant).
 */
import {
  classifyStatus,
  type AgentHealthIssue,
  type SupervisorDecision,
  type SupervisorFacts,
  type SupervisorInput,
  type StoryStatus,
} from "@roll/spec";

export type SupervisorBacklogFamily = "FIX" | "US" | "REFACTOR";

export interface SupervisorBlockedCard {
  readonly storyId: string;
  readonly reason:
    | "outside_scope"
    | "hold"
    | "done"
    | "cut"
    | "in_progress"
    | "open_pr"
    | "delivered"
    | "unmet_dependency"
    | "repeated_failure"
    | "structural_failure"
    | "pending_publish"
    | "unknown_status";
  readonly detail: string;
}

export interface SupervisorRunbookState {
  readonly scope: {
    readonly label: "live non-Hold FIX/US/REFACTOR";
    readonly families: readonly SupervisorBacklogFamily[];
    readonly remainingByFamily: Readonly<Record<SupervisorBacklogFamily, number>>;
    readonly todoByFamily: Readonly<Record<SupervisorBacklogFamily, number>>;
    readonly excluded: readonly string[];
  };
  readonly truth: {
    readonly coverage: "complete" | "partial";
    readonly drift: readonly string[];
    readonly openPrCount: number;
    readonly manualMergeGates: readonly NonNullable<SupervisorInput["manualMergeGates"]>[number][];
    readonly structuralFailures: readonly NonNullable<SupervisorInput["structuralFailures"]>[number][];
  };
  readonly next: {
    readonly kind: "run_card" | "manual_merge_gate" | "diagnose_failure" | "no_work";
    readonly storyId: string | null;
    readonly reason: string;
    readonly ownerAction: string;
    readonly schedulerAction: string;
  };
  readonly blockedCards: readonly SupervisorBlockedCard[];
  readonly agentHealth: {
    readonly issues: readonly AgentHealthIssue[];
    readonly summary: string;
  };
}

const SUPERVISOR_FAMILIES: readonly SupervisorBacklogFamily[] = ["FIX", "US", "REFACTOR"];

function familyOf(id: string): SupervisorBacklogFamily | null {
  if (id.startsWith("FIX-")) return "FIX";
  if (id.startsWith("US-")) return "US";
  if (id.startsWith("REFACTOR-")) return "REFACTOR";
  return null;
}

function emptyFamilyCounts(): Record<SupervisorBacklogFamily, number> {
  return { FIX: 0, US: 0, REFACTOR: 0 };
}

function statusOf(status: string): StoryStatus | null {
  return classifyStatus(status);
}

function isLiveStatus(status: StoryStatus | null): boolean {
  return status === "todo" || status === "in_progress" || status === null;
}

function readyTodoStatus(status: StoryStatus | null): boolean {
  return status === "todo";
}

function buildDoneSet(input: SupervisorInput): Set<string> {
  const done = new Set(input.delivered);
  for (const row of input.backlog) {
    if (statusOf(row.status) === "done") done.add(row.id);
  }
  return done;
}

function blocker(storyId: string, reason: SupervisorBlockedCard["reason"], detail: string): SupervisorBlockedCard {
  return { storyId, reason, detail };
}

function blockingDetails(input: SupervisorInput): {
  readonly deliveredSet: Set<string>;
  readonly openPrSet: Set<string>;
  readonly stuckSet: Set<string>;
  readonly pendingPublishSet: Set<string>;
} {
  return {
    deliveredSet: buildDoneSet(input),
    openPrSet: new Set(input.openPrStories),
    stuckSet: new Set(input.recentFailures.filter((f) => f.consecutiveFailures >= 2).map((f) => f.storyId)),
    pendingPublishSet: new Set(input.pendingPublish ?? []),
  };
}

export function buildSupervisorRunbookState(input: SupervisorInput): SupervisorRunbookState {
  const remainingByFamily = emptyFamilyCounts();
  const todoByFamily = emptyFamilyCounts();
  const excluded: string[] = [];
  const blockedCards: SupervisorBlockedCard[] = [];
  const manualMergeGates = input.manualMergeGates ?? [];
  const structuralFailures = input.structuralFailures ?? [];
  const { deliveredSet, openPrSet, stuckSet } = blockingDetails(input);
  const confirmedDelivered = new Set(input.delivered);
  const truthDrift = input.backlog
    .filter((row) => statusOf(row.status) === "done" && !confirmedDelivered.has(row.id))
    .map((row) => row.id);
  const healthIssues = input.agentHealthIssues ?? [];
  const healthSummary = healthIssues.length === 0 ? "clean" : `${healthIssues.length} active issue(s)`;
  const agentHealth = { issues: healthIssues, summary: healthSummary };
  const liveScopeIds = new Set<string>();

  for (const row of input.backlog) {
    const family = familyOf(row.id);
    const status = statusOf(row.status);
    if (family === null) {
      excluded.push(`${row.id}: outside supervisor backlog-clearing scope`);
      continue;
    }
    if (status === "hold") {
      excluded.push(`${row.id}: hold`);
      continue;
    }
    if (status === "cut") {
      excluded.push(`${row.id}: cut`);
      continue;
    }
    if (status === "done") {
      excluded.push(`${row.id}: done`);
      continue;
    }
    if (isLiveStatus(status)) {
      remainingByFamily[family] += 1;
      liveScopeIds.add(row.id);
    }
    if (status === "todo") todoByFamily[family] += 1;
  }

  // FIX-1058 — distinguish blocking manual merge gates from evidence-repaired
  // merge_ready PRs. A merge_ready PR has evidence repaired and is safe to
  // merge; it does not block the supervisor from proceeding.
  const blockingMerge = manualMergeGates.find(
    (gate) => (liveScopeIds.has(gate.storyId) || openPrSet.has(gate.storyId)) && gate.action !== "merge_ready",
  );
  if (blockingMerge !== undefined) {
    blockedCards.push(blocker(blockingMerge.storyId, "open_pr", `PR #${blockingMerge.prNumber} requires manual merge reconciliation`));
    return {
      scope: { label: "live non-Hold FIX/US/REFACTOR", families: SUPERVISOR_FAMILIES, remainingByFamily, todoByFamily, excluded },
      truth: {
        coverage: truthDrift.length > 0 ? "partial" : "complete",
        drift: truthDrift,
        openPrCount: input.openPrStories.length,
        manualMergeGates,
        structuralFailures,
      },
      next: {
        kind: "manual_merge_gate",
        storyId: blockingMerge.storyId,
        reason: `manual merge gate on PR #${blockingMerge.prNumber} for ${blockingMerge.storyId}: ${blockingMerge.detail}`,
        ownerAction: `review PR #${blockingMerge.prNumber}; merge only after CI=${blockingMerge.ciState}, evaluator=${blockingMerge.reviewState}, merge=${blockingMerge.mergeable} are acceptable`,
        schedulerAction: "do not start another card until the manual-merge PR is merged, closed, or explicitly deferred",
      },
      blockedCards,
      agentHealth,
    };
  }

  const structural = structuralFailures.find(
    (failure) => liveScopeIds.has(failure.storyId) && !deliveredSet.has(failure.storyId) && !openPrSet.has(failure.storyId),
  );
  if (structural !== undefined) {
    blockedCards.push(blocker(structural.storyId, "structural_failure", structural.detail));
    return {
      scope: { label: "live non-Hold FIX/US/REFACTOR", families: SUPERVISOR_FAMILIES, remainingByFamily, todoByFamily, excluded },
      truth: {
        coverage: truthDrift.length > 0 ? "partial" : "complete",
        drift: truthDrift,
        openPrCount: input.openPrStories.length,
        manualMergeGates,
        structuralFailures,
      },
      next: {
        kind: "diagnose_failure",
        storyId: structural.storyId,
        reason: `diagnose structural failure on ${structural.storyId}: ${structural.detail}`,
        ownerAction: `pause execution and inspect or rescue ${structural.storyId}; source: ${structural.source}`,
        schedulerAction: "do not retry this card until the structural failure is resolved or recorded as a root-cause card",
      },
      blockedCards,
      agentHealth,
    };
  }

  const stuck = input.recentFailures.find((f) => f.consecutiveFailures >= 2 && liveScopeIds.has(f.storyId));
  if (stuck !== undefined) {
    blockedCards.push(blocker(stuck.storyId, "repeated_failure", `${stuck.consecutiveFailures} consecutive failures; diagnose before retry`));
    return {
      scope: { label: "live non-Hold FIX/US/REFACTOR", families: SUPERVISOR_FAMILIES, remainingByFamily, todoByFamily, excluded },
      truth: {
        coverage: truthDrift.length > 0 ? "partial" : "complete",
        drift: truthDrift,
        openPrCount: input.openPrStories.length,
        manualMergeGates,
        structuralFailures,
      },
      next: {
        kind: "diagnose_failure",
        storyId: stuck.storyId,
        reason: `diagnose repeated failure on ${stuck.storyId}; do not retry blindly`,
        ownerAction: `pause execution and create a root-cause card or salvage plan for ${stuck.storyId}`,
        schedulerAction: "do not run another cycle for this card until the diagnosis is recorded",
      },
      blockedCards,
      agentHealth,
    };
  }

  const doneSet = deliveredSet;
  for (const family of SUPERVISOR_FAMILIES) {
    for (const row of input.backlog) {
      if (familyOf(row.id) !== family) continue;
      const status = statusOf(row.status);
      if (status === "hold") {
        blockedCards.push(blocker(row.id, "hold", "row is Hold/Blocked/Deferred"));
        continue;
      }
      if (status === "cut") {
        blockedCards.push(blocker(row.id, "cut", "row is Cut"));
        continue;
      }
      if (status === "done") continue;
      if (status === "in_progress") {
        blockedCards.push(blocker(row.id, "in_progress", "row is already in progress"));
        continue;
      }
      if (!readyTodoStatus(status)) {
        blockedCards.push(blocker(row.id, "unknown_status", `unrecognized status: ${row.status}`));
        continue;
      }
      if (doneSet.has(row.id)) {
        blockedCards.push(blocker(row.id, "delivered", "delivery truth already marks this card delivered"));
        continue;
      }
      if (openPrSet.has(row.id)) {
        blockedCards.push(blocker(row.id, "open_pr", "open PR already exists"));
        continue;
      }
      const unmet = (row.dependsOn ?? []).filter((dep) => !doneSet.has(dep));
      if (unmet.length > 0) {
        blockedCards.push(blocker(row.id, "unmet_dependency", `waiting on ${unmet.join(", ")}`));
        continue;
      }
      if (stuckSet.has(row.id)) {
        blockedCards.push(blocker(row.id, "repeated_failure", "repeated failure must be diagnosed before retry"));
        continue;
      }
      // FIX-1212: pending-publish WITHOUT an open PR is a stale marker — the card
      // is NOT blocked. With an open PR the open PR gate (above) already catches
      // re-dispatch protection. The supervisor no longer independently blocks on
      // pending-publish; stale markers must not prevent re-picking.
      return {
        scope: { label: "live non-Hold FIX/US/REFACTOR", families: SUPERVISOR_FAMILIES, remainingByFamily, todoByFamily, excluded },
        truth: {
        coverage: truthDrift.length > 0 ? "partial" : "complete",
        drift: truthDrift,
        openPrCount: input.openPrStories.length,
        manualMergeGates,
        structuralFailures,
      },
        next: {
          kind: "run_card",
          storyId: row.id,
          reason: `selected from live non-Hold US/FIX/REFACTOR scope (${family} lane; dependencies satisfied)`,
          ownerAction: `run scoped execution for ${row.id}`,
          schedulerAction: "run exactly one card, then reconcile PR/CI/main and .roll meta",
        },
        blockedCards,
        agentHealth,
      };
    }
  }

  return {
    scope: { label: "live non-Hold FIX/US/REFACTOR", families: SUPERVISOR_FAMILIES, remainingByFamily, todoByFamily, excluded },
    truth: {
      coverage: truthDrift.length > 0 ? "partial" : "complete",
      drift: truthDrift,
      openPrCount: input.openPrStories.length,
      manualMergeGates,
      structuralFailures,
    },
    next: {
      kind: "no_work",
      storyId: null,
      reason: "no ready live non-Hold FIX/US/REFACTOR card",
      ownerAction: "inspect blocked cards or confirm the goal is complete",
      schedulerAction: "do not resume autonomous execution without a ready card",
    },
    blockedCards,
    agentHealth,
  };
}

function summarizeIds(ids: readonly string[], limit = 5): string {
  if (ids.length === 0) return "none";
  const shown = ids.slice(0, limit).join(", ");
  const remaining = ids.length - limit;
  return remaining > 0 ? `${shown}, … +${remaining} more` : shown;
}

/** Produce Supervisor's ordered advice from the project facts. Pure. */
export function adviseProject(facts: SupervisorFacts): SupervisorDecision[] {
  const decisions: SupervisorDecision[] = [];
  if (facts.truthDrift.length > 0) {
    decisions.push({
      kind: "escalate",
      reason:
        `truth coverage partial: ${facts.truthDrift.length} Done row(s) lack structured delivery truth ` +
        `(${summarizeIds(facts.truthDrift)}). This is a backfill/audit task, not a release blocker unless release consistency fails.`,
      evidence: [],
      requiresOwner: true,
    });
  }
  if (facts.stuckStories.length > 0) {
    decisions.push({
      kind: "escalate",
      reason: `stuck stories (repeated failures): ${summarizeIds(facts.stuckStories)}`,
      evidence: [],
      requiresOwner: true,
    });
  }
  if (facts.routeConfigErrors.length > 0) {
    decisions.push({
      kind: "recommend-route-change",
      reason: `route profile errors: ${facts.routeConfigErrors.join("; ")}`,
      evidence: [],
      requiresOwner: true,
    });
  }
  if (!facts.budgetHealth.ok) {
    decisions.push({ kind: "pause", reason: facts.budgetHealth.note, evidence: [], requiresOwner: true });
  }
  if (!facts.releaseReadiness.ready) {
    decisions.push({
      kind: "release-readiness",
      reason: `release blocked: ${summarizeIds(facts.releaseReadiness.blockers)}`,
      evidence: [],
      requiresOwner: true,
    });
  }
  return decisions;
}

/**
 * US-V4-008 — answer "what should Roll do next?". Deterministic ranking over the
 * backlog: the first un-blocked, not-in-flight, not-delivered Todo whose
 * dependencies are all delivered. Returns a human-readable recommendation; the
 * Supervisor advises, the owner confirms.
 */
export function recommendNext(input: SupervisorInput): { storyId: string | null; reason: string } {
  const state = buildSupervisorRunbookState(input);
  return { storyId: state.next.storyId, reason: state.next.reason };
}

/** US-V4-008 — answer "why is the project stuck?" from the facts. */
export function explainStuck(facts: SupervisorFacts): string {
  const parts: string[] = [];
  if (facts.stuckStories.length > 0) parts.push(`repeated failures on: ${summarizeIds(facts.stuckStories)}`);
  if (facts.truthDrift.length > 0) parts.push(`truth coverage partial on: ${summarizeIds(facts.truthDrift)}`);
  if (facts.routeConfigErrors.length > 0) parts.push(`route config errors: ${facts.routeConfigErrors.join("; ")}`);
  if (!facts.budgetHealth.ok) parts.push(facts.budgetHealth.note);
  if (facts.counts.todo === 0 && facts.openPrCount === 0) parts.push("no Todo work and no open PRs");
  return parts.length === 0 ? "not stuck: work is flowing (open PRs and/or ready Todos exist)" : parts.join("; ");
}
