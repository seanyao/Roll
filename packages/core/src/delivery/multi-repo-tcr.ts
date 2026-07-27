/**
 * US-WS-012 — per-repository TCR/test verification and cross-repo local
 * acceptance for one Story Cycle.
 *
 * Every writable Repo Execution Leg must stand on its OWN evidence: its own
 * green repo-scoped tests, its own attributable `tcr:` commits, or an explicit
 * designed/owner-confirmed no-change rule. A verdict always carries the repoId
 * it judged, so no aggregate boolean can erase which repository lacked
 * evidence. Cross-repo acceptance is pinned to the exact per-repository head
 * SHAs it ran against; a run without a complete writable-leg input map proves
 * nothing.
 *
 * Purity: no git, no filesystem, no clock. The caller (the runner's capture
 * step) observes facts per leg and injects them; identical facts always yield
 * identical verdicts. Publish planning here is a PLAN (branch names + declared
 * dependency order) — provider side effects belong to later stories.
 */

import { isSafeGitRef, type RepositoryAccess } from "@roll/spec";

/** Observed facts for one repository leg of a Story Cycle (all injected). */
export interface RepositoryLegFacts {
  readonly repoId: string;
  readonly alias: string;
  readonly access: RepositoryAccess;
  readonly requiredDelivery: boolean;
  /** Final diff vs the pinned base SHA (committed work exists). */
  readonly changed: boolean;
  /** Uncommitted/untracked files remain in the leg worktree. */
  readonly dirty: boolean;
  /** `tcr:` commits attributable to THIS repository's governed branch. */
  readonly tcrCount: number;
  /** Repo-scoped test-gate outcome; "not_run" is never green. */
  readonly testResult: "pass" | "fail" | "not_run";
  /** Story contract declared `no_change_allowed` for this leg. */
  readonly noChangeAllowed: boolean;
  /** Explicit owner exemption recorded in Issue evidence. */
  readonly ownerExemption: boolean;
}

export type LegFailureCode =
  | "missing_tcr"
  | "tests_failed"
  | "tests_not_run"
  | "undeclared_no_change"
  | "dirty_worktree";

export type LegVerdict =
  | { readonly ok: true; readonly repoId: string; readonly reason: "verified" | "no_change_allowed" | "owner_exemption" | "read_only" }
  | { readonly ok: false; readonly repoId: string; readonly code: LegFailureCode };

/**
 * Judge one repository leg on its own evidence. Read-only legs provide context
 * and are never verified. An unchanged writable leg passes only through an
 * explicit rule; silence is a failure, never an implicit success (AC4).
 */
export function legVerdict(facts: RepositoryLegFacts): LegVerdict {
  const { repoId } = facts;
  if (facts.access === "read") return { ok: true, repoId, reason: "read_only" };
  if (facts.dirty) return { ok: false, repoId, code: "dirty_worktree" };
  if (!facts.changed) {
    if (facts.noChangeAllowed) return { ok: true, repoId, reason: "no_change_allowed" };
    if (facts.ownerExemption) return { ok: true, repoId, reason: "owner_exemption" };
    return { ok: false, repoId, code: "undeclared_no_change" };
  }
  if (facts.tcrCount <= 0) return { ok: false, repoId, code: "missing_tcr" };
  if (facts.testResult === "fail") return { ok: false, repoId, code: "tests_failed" };
  if (facts.testResult === "not_run") return { ok: false, repoId, code: "tests_not_run" };
  return { ok: true, repoId, reason: "verified" };
}

/** Cross-repo local integration observation (injected by the runner). */
export type IntegrationFacts =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly exitCode: number;
      /** Exact per-repository head SHAs the command ran against (repoId → sha). */
      readonly inputHeads: Readonly<Record<string, string>>;
    };

export type StoryVerificationVerdict =
  | {
      readonly ok: true;
      readonly legs: readonly LegVerdict[];
      /** The exact input map integration acceptance was pinned to (AC5). */
      readonly integrationInputs: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly code: "leg_failed" | "integration_not_run" | "integration_failed" | "integration_inputs_incomplete";
      readonly legs: readonly LegVerdict[];
      readonly failedLegs: readonly { readonly repoId: string; readonly code: LegFailureCode }[];
    };

export interface StoryVerificationOptions {
  /** Whether the Story contract declares a cross-repo integration command.
   *  Default true (conservative). A single-writable-leg story without one is
   *  covered by its own repo-scoped gate; a multi-leg story can never skip it —
   *  cross-repo acceptance is exactly what per-leg tests cannot prove. */
  readonly integrationDeclared?: boolean;
}

/**
 * Fold per-leg verdicts and the integration observation into one Story
 * verification verdict. Leg failures win (fix-forward needs the per-leg
 * diagnosis); integration acceptance requires a pinned head for EVERY writable
 * leg — a partial input map cannot mint a green (scorer_focus 2).
 */
export function storyVerification(
  legFacts: readonly RepositoryLegFacts[],
  integration: IntegrationFacts,
  options: StoryVerificationOptions = {},
): StoryVerificationVerdict {
  const legs = legFacts.map(legVerdict);
  const failedLegs = legs.flatMap((verdict) => (verdict.ok ? [] : [{ repoId: verdict.repoId, code: verdict.code }]));
  if (failedLegs.length > 0) return { ok: false, code: "leg_failed", legs, failedLegs };

  const writableCount = legFacts.filter((leg) => leg.access === "write").length;
  const integrationRequired = (options.integrationDeclared ?? true) || writableCount > 1;
  if (!integration.ran) {
    if (!integrationRequired) return { ok: true, legs, integrationInputs: {} };
    return { ok: false, code: "integration_not_run", legs, failedLegs: [] };
  }
  const writableIds = legFacts.filter((leg) => leg.access === "write").map((leg) => leg.repoId);
  const missing = writableIds.filter((repoId) => {
    const sha = integration.inputHeads[repoId];
    return sha === undefined || sha === "";
  });
  if (missing.length > 0) return { ok: false, code: "integration_inputs_incomplete", legs, failedLegs: [] };
  if (integration.exitCode !== 0) return { ok: false, code: "integration_failed", legs, failedLegs: [] };

  const integrationInputs = Object.fromEntries(writableIds.map((repoId) => [repoId, integration.inputHeads[repoId] ?? ""]));
  return { ok: true, legs, integrationInputs };
}

// ── Publish planning (AC6) — a plan, not a provider side effect ──────────────

/** Minimal leg facts publish planning needs (declared dependency is optional). */
export interface PublishLegInput {
  readonly repoId: string;
  readonly alias: string;
  readonly changed: boolean;
  /** Immutable branch carried from the Issue manifest. */
  readonly workBranch: string;
  readonly dependsOnRepo?: string;
}

export interface RepositoryPublishEntry {
  readonly repoId: string;
  readonly alias: string;
  /** Governed branch — same identity the Issue worktree transaction pinned. */
  readonly branch: string;
  /** Changed repos this publish must wait for (declared order, AC6). */
  readonly dependsOn: readonly string[];
}

export type RepositoryPublishPlan =
  | { readonly ok: true; readonly entries: readonly RepositoryPublishEntry[] }
  | { readonly ok: false; readonly code: "dependency_cycle" | "unknown_dependency" | "invalid_work_branch"; readonly detail: string };

/**
 * Plan one branch/PR publish per CHANGED writable repository, topologically
 * ordered by declared repo dependency. Dependencies pointing at unchanged or
 * unknown repos fail loud — merge order is a designed contract, not a guess.
 * Still one Story/Cycle result: the plan is recorded as Issue evidence and the
 * publish executor consumes it; nothing here talks to a provider.
 */
export function planRepositoryPublish(
  legs: readonly PublishLegInput[],
): RepositoryPublishPlan {
  const changed = legs.filter((leg) => leg.changed);
  const changedIds = new Set(changed.map((leg) => leg.repoId));
  const known = new Set(legs.map((leg) => leg.repoId));

  const invalidBranch = changed.find((leg) => !isSafeGitRef(leg.workBranch));
  if (invalidBranch !== undefined) {
    return { ok: false, code: "invalid_work_branch", detail: `${invalidBranch.repoId} has no safe Issue work branch` };
  }

  for (const leg of changed) {
    if (leg.dependsOnRepo === undefined) continue;
    if (!known.has(leg.dependsOnRepo)) {
      return { ok: false, code: "unknown_dependency", detail: `${leg.repoId} depends on unknown ${leg.dependsOnRepo}` };
    }
  }

  // Kahn topological order over changed legs; unchanged dependencies are
  // already-satisfied (nothing to publish there) and impose no edge.
  const pending = new Map(changed.map((leg) => [leg.repoId, leg] as const));
  const ordered: RepositoryPublishEntry[] = [];
  const done = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((leg) => leg.dependsOnRepo === undefined || !changedIds.has(leg.dependsOnRepo) || done.has(leg.dependsOnRepo))
      .sort((left, right) => left.repoId.localeCompare(right.repoId));
    if (ready.length === 0) {
      return { ok: false, code: "dependency_cycle", detail: `unresolvable order among ${[...pending.keys()].sort().join(", ")}` };
    }
    for (const leg of ready) {
      pending.delete(leg.repoId);
      done.add(leg.repoId);
      ordered.push({
        repoId: leg.repoId,
        alias: leg.alias,
        branch: leg.workBranch,
        dependsOn: leg.dependsOnRepo !== undefined && changedIds.has(leg.dependsOnRepo) ? [leg.dependsOnRepo] : [],
      });
    }
  }
  return { ok: true, entries: ordered };
}
