/**
 * @responsibility Projects the read-only supervisor live board from the event stream.
 * US-V4-013 — Supervisor Live Board view model.
 *
 * Pure projection from RollEvent stream to a read-only team board. It does not
 * parse generated HTML and does not introduce a second truth source.
 */
import type { ExecutionProfile, RoleName, RollEvent } from "@roll/spec";

export type SupervisorLiveRoleState =
  | "pending"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "not_required"
  | "not_available";

export interface SupervisorLiveRolePane {
  readonly role: RoleName;
  readonly state: SupervisorLiveRoleState;
  readonly agent: string | null;
  readonly reason: string;
}

export interface SupervisorLiveHandoff {
  readonly from: RoleName;
  readonly to: RoleName;
  readonly state: "pending" | "ready" | "blocked" | "not_required";
  readonly detail: string;
}

export interface SupervisorLiveCycleRow {
  readonly cycleId: string;
  readonly storyId: string;
  readonly profile: ExecutionProfile;
  readonly profileReason: string;
  readonly agent: string;
  readonly model: string;
  readonly status: "active" | "done" | "failed" | "not_available";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly roles: readonly SupervisorLiveRolePane[];
  readonly handoffs: readonly SupervisorLiveHandoff[];
}

export interface SupervisorLiveBoard {
  readonly supervisor: {
    readonly state: "observing";
    readonly summary: string;
    readonly failureDistribution: Record<"env" | "harness" | "card" | "unknown", number>;
  };
  readonly rows: readonly SupervisorLiveCycleRow[];
}

interface UnavailableRole {
  readonly role: RoleName;
  readonly reason: string;
}

interface MutableCycle {
  cycleId: string;
  storyId: string;
  profile: ExecutionProfile;
  profileReason: string;
  agent: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  phases: string[];
  ended: boolean;
  failed: boolean;
  builderDone: boolean;
  evaluatorDone: boolean;
  evaluatorFailed: boolean;
  unavailable: UnavailableRole[];
  failureClass?: "env" | "harness" | "card" | "unknown";
}

const SUCCESS_OUTCOMES = new Set(["delivered", "built", "published", "success", "merged"]);

function requiredRoles(profile: ExecutionProfile): Set<RoleName> {
  if (profile === "standard") return new Set<RoleName>(["builder"]);
  if (profile === "verified") return new Set<RoleName>(["builder", "evaluator"]);
  return new Set<RoleName>(["designer", "builder", "evaluator"]);
}

function terminalFailed(outcome: string): boolean {
  return !SUCCESS_OUTCOMES.has(outcome);
}

function latestUnavailable(c: MutableCycle, role: RoleName): UnavailableRole | undefined {
  for (let i = c.unavailable.length - 1; i >= 0; i -= 1) {
    const item = c.unavailable[i]!;
    if (item.role === role) return item;
  }
  return undefined;
}

function phaseAtOrAfter(c: MutableCycle, phase: string): boolean {
  const order = ["pick", "route", "worktree", "execute", "publish", "merge-wait", "reconcile", "cleanup", "stalled"];
  const want = order.indexOf(phase);
  return c.phases.some((p) => order.indexOf(p) >= want);
}

function designerPane(c: MutableCycle, required: boolean): SupervisorLiveRolePane {
  if (!required) return { role: "designer", state: "not_required", agent: null, reason: "profile does not require design" };
  const unavailable = latestUnavailable(c, "designer");
  if (unavailable !== undefined) return { role: "designer", state: "not_available", agent: null, reason: unavailable.reason };
  if (phaseAtOrAfter(c, "execute")) return { role: "designer", state: "done", agent: null, reason: "design contract handed to builder" };
  if (c.ended && c.failed) return { role: "designer", state: "failed", agent: null, reason: "cycle failed before builder handoff" };
  return { role: "designer", state: "working", agent: null, reason: "building design contract" };
}

function builderPane(c: MutableCycle, designer: SupervisorLiveRolePane): SupervisorLiveRolePane {
  const unavailable = latestUnavailable(c, "builder");
  if (unavailable !== undefined) return { role: "builder", state: "not_available", agent: c.agent, reason: unavailable.reason };
  if (c.ended) {
    return {
      role: "builder",
      state: c.failed && !c.builderDone ? "failed" : "done",
      agent: c.agent,
      reason: c.failed && !c.builderDone ? "cycle ended before builder completed" : "builder result available",
    };
  }
  if (phaseAtOrAfter(c, "publish")) return { role: "builder", state: "done", agent: c.agent, reason: "builder result handed to evaluator/publish" };
  if (phaseAtOrAfter(c, "execute")) return { role: "builder", state: "working", agent: c.agent, reason: "executing story" };
  return {
    role: "builder",
    state: designer.state === "working" ? "waiting" : "pending",
    agent: c.agent,
    reason: designer.state === "working" ? "waiting for designer handoff" : "waiting to execute",
  };
}

function evaluatorPane(c: MutableCycle, required: boolean, builder: SupervisorLiveRolePane): SupervisorLiveRolePane {
  if (!required) return { role: "evaluator", state: "not_required", agent: null, reason: "profile does not require independent evaluation" };
  const unavailable = latestUnavailable(c, "evaluator");
  if (unavailable !== undefined) return { role: "evaluator", state: "not_available", agent: null, reason: unavailable.reason };
  if (c.evaluatorFailed) return { role: "evaluator", state: "failed", agent: null, reason: "evaluator returned blocking findings" };
  if (c.evaluatorDone || (c.ended && !c.failed)) return { role: "evaluator", state: "done", agent: null, reason: "independent evaluation evidence available" };
  if (c.ended && c.failed) return { role: "evaluator", state: "failed", agent: null, reason: "cycle failed before evaluation completed" };
  if (builder.state === "done") return { role: "evaluator", state: "waiting", agent: null, reason: "waiting for evaluator verdict" };
  return { role: "evaluator", state: "pending", agent: null, reason: "waiting for builder result" };
}

function rolePanes(c: MutableCycle): SupervisorLiveRolePane[] {
  const req = requiredRoles(c.profile);
  const designer = designerPane(c, req.has("designer"));
  const builder = builderPane(c, designer);
  const evaluator = evaluatorPane(c, req.has("evaluator"), builder);
  return [designer, builder, evaluator];
}

function handoffs(c: MutableCycle, roles: readonly SupervisorLiveRolePane[]): SupervisorLiveHandoff[] {
  const byRole = new Map(roles.map((r) => [r.role, r]));
  const designer = byRole.get("designer")!;
  const builder = byRole.get("builder")!;
  const evaluator = byRole.get("evaluator")!;
  return [
    {
      from: "designer",
      to: "builder",
      state: designer.state === "not_required" ? "not_required" : designer.state === "done" ? "ready" : designer.state === "failed" || designer.state === "not_available" ? "blocked" : "pending",
      detail: designer.state === "not_required" ? "designer not required" : "design contract -> builder",
    },
    {
      from: "builder",
      to: "evaluator",
      state: evaluator.state === "not_required" ? "not_required" : builder.state === "done" ? "ready" : builder.state === "failed" || builder.state === "not_available" ? "blocked" : "pending",
      detail: evaluator.state === "not_required" ? "evaluator not required" : "builder result -> evaluator",
    },
    {
      from: "evaluator",
      to: "builder",
      state: evaluator.state === "failed" ? "blocked" : evaluator.state === "done" ? "ready" : evaluator.state === "not_required" ? "not_required" : "pending",
      detail: evaluator.state === "failed" ? "evaluator feedback -> bounded repair" : "evaluator verdict -> supervisor",
    },
  ];
}

function rowStatus(c: MutableCycle, roles: readonly SupervisorLiveRolePane[]): SupervisorLiveCycleRow["status"] {
  if (roles.some((r) => r.state === "not_available")) return "not_available";
  if (!c.ended) return "active";
  return c.failed ? "failed" : "done";
}

function applyEvent(c: MutableCycle, ev: RollEvent): void {
  c.updatedAt = Math.max(c.updatedAt, ev.ts);
  if (ev.type === "execution:profile") {
    c.profile = ev.profile;
    c.profileReason = ev.reason;
  } else if (ev.type === "cycle:phase") {
    c.phases.push(ev.phase);
    if (ev.phase === "publish" || ev.phase === "merge-wait" || ev.phase === "reconcile" || ev.phase === "cleanup") c.builderDone = true;
  } else if (ev.type === "cycle:end") {
    c.ended = true;
    c.failed = terminalFailed(ev.outcome);
    c.failureClass = ev.failure_class ?? (c.failed ? "unknown" : undefined);
    if (!c.failed) {
      c.builderDone = true;
      c.evaluatorDone = c.profile !== "standard";
    }
  } else if (ev.type === "pair:none-available") {
    c.unavailable.push({ role: "evaluator", reason: ev.reason });
  } else if (ev.type === "agent:blocked") {
    c.unavailable.push({
      role: ev.stage === "build" ? "builder" : "evaluator",
      reason: `${ev.agent} blocked by ${ev.cause}`,
    });
  } else if (ev.type === "peer:gate") {
    if (ev.verdict === "consulted" || ev.verdict === "self-review-allowed") c.evaluatorDone = true;
    if (ev.verdict === "skipped") c.evaluatorFailed = true;
  } else if (ev.type === "pair:score") {
    c.evaluatorDone = true;
    if (ev.verdict === "regression") c.evaluatorFailed = true;
  } else if (ev.type === "pair:verdict") {
    c.evaluatorDone = ev.verdict === "agree";
    c.evaluatorFailed = ev.verdict !== "agree";
  } else if (ev.type === "attest:gate") {
    if (ev.verdict === "produced") c.evaluatorDone = true;
    if (ev.verdict === "skipped") c.evaluatorFailed = true;
  }
}

export function buildSupervisorLiveBoard(
  events: readonly RollEvent[],
  opts: { recentLimit?: number } = {},
): SupervisorLiveBoard {
  const cycles = new Map<string, MutableCycle>();
  for (const ev of [...events].sort((a, b) => a.ts - b.ts)) {
    if (ev.type === "cycle:start") {
      cycles.set(ev.cycleId, {
        cycleId: ev.cycleId,
        storyId: ev.storyId,
        profile: "standard",
        profileReason: "standard: no execution profile event yet",
        agent: ev.agent,
        model: ev.model,
        startedAt: ev.ts,
        updatedAt: ev.ts,
        phases: [],
        ended: false,
        failed: false,
        builderDone: false,
        evaluatorDone: false,
        evaluatorFailed: false,
        unavailable: [],
      });
      continue;
    }
    const cycleId = "cycleId" in ev && typeof ev.cycleId === "string" ? ev.cycleId : undefined;
    if (cycleId === undefined) continue;
    const c = cycles.get(cycleId);
    if (c !== undefined) applyEvent(c, ev);
  }
  const rows = [...cycles.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts.recentLimit ?? 12)
    .map((c) => {
      const roles = rolePanes(c);
      return {
        cycleId: c.cycleId,
        storyId: c.storyId,
        profile: c.profile,
        profileReason: c.profileReason,
        agent: c.agent,
        model: c.model,
        status: rowStatus(c, roles),
        startedAt: c.startedAt,
        updatedAt: c.updatedAt,
        roles,
        handoffs: handoffs(c, roles),
      };
    });
  const active = rows.filter((r) => r.status === "active" || r.status === "not_available").length;
  const failureDistribution = { env: 0, harness: 0, card: 0, unknown: 0 };
  for (const c of cycles.values()) {
    if (c.failed) failureDistribution[c.failureClass ?? "unknown"] += 1;
  }
  return {
    supervisor: {
      state: "observing",
      summary: `${active} active/recent attention row(s), ${rows.length} row(s) rendered; failures env=${failureDistribution.env} harness=${failureDistribution.harness} card=${failureDistribution.card} unknown=${failureDistribution.unknown}`,
      failureDistribution,
    },
    rows,
  };
}
