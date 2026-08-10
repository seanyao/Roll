/**
 * @responsibility Observes cross-story coordinator facts for supervisor decisions.
 * US-V4-008 — Supervisor v0: OBSERVE.
 *
 * Supervisor is the project-level coordinator for work not owned by one
 * concrete Story (cross-Story/Epic context, routing advice, budget, release
 * readiness, truth drift, owner escalation). v0 is observe + advise only — it
 * NEVER implements a Story, writes a Story eval report, bypasses a gate, or marks
 * a Story Done.
 *
 * This module is the DETERMINISTIC selector layer (arch impl-note: "implement
 * deterministic selectors first; only call an agent after the facts are
 * structured"). It is pure: structured {@link SupervisorInput} → {@link
 * SupervisorFacts}. An agent is only needed later to phrase a recommendation; the
 * facts themselves never require one.
 */
import type { SupervisorFacts, SupervisorInput } from "@roll/spec";

/** A story is "stuck" at or above this many consecutive failures. */
export const SUPERVISOR_STUCK_THRESHOLD = 2;

function statusBucket(status: string): "todo" | "inProgress" | "blocked" | "done" | "other" {
  const s = status.trim().toLowerCase();
  if (s.startsWith("📋") || /^todo\b/.test(s)) return "todo";
  if (s.startsWith("🔨") || /^in\s+progress\b/.test(s)) return "inProgress";
  if (s.startsWith("🔒") || s.startsWith("⏸") || s.startsWith("🚫") || /^(blocked|deferred|hold|paused)\b/.test(s)) return "blocked";
  if (s.startsWith("✅") || /^done\b/.test(s)) return "done";
  return "other";
}

/** Build Supervisor's structured projection from gathered facts. Pure. */
export function observeProject(input: SupervisorInput): SupervisorFacts {
  const counts = { todo: 0, inProgress: 0, blocked: 0, done: 0 };
  const deliveredSet = new Set(input.delivered);
  const truthDrift: string[] = [];
  for (const row of input.backlog) {
    const bucket = statusBucket(row.status);
    if (bucket === "done") {
      counts.done += 1;
      // Backlog CLAIMS done but main truth does not confirm → drift.
      if (!deliveredSet.has(row.id)) truthDrift.push(row.id);
    } else if (bucket === "todo") counts.todo += 1;
    else if (bucket === "inProgress") counts.inProgress += 1;
    else if (bucket === "blocked") counts.blocked += 1;
  }
  const stuckStories = input.recentFailures
    .filter((f) => f.consecutiveFailures >= SUPERVISOR_STUCK_THRESHOLD)
    .map((f) => f.storyId.trim())
    .filter((id) => id !== "");
  const blockers = [...input.releaseBlockers];
  const budgetHealth =
    input.budget === undefined || input.budget.cap === null
      ? { ok: true, note: "no budget cap set" }
      : input.budget.spent >= input.budget.cap
        ? { ok: false, note: `budget exhausted (${input.budget.spent}/${input.budget.cap})` }
        : { ok: true, note: `budget ${input.budget.spent}/${input.budget.cap}` };
  return {
    counts,
    truthDrift,
    openPrCount: input.openPrStories.length,
    stuckStories,
    routeConfigErrors: input.routeConfigErrors,
    releaseReadiness: { ready: blockers.length === 0, blockers },
    budgetHealth,
  };
}
