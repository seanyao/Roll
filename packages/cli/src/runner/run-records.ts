import { existsSync, readFileSync } from "node:fs";
import type { CycleCommand, CycleContext, ReconcileRunRow } from "@roll/core";
import {
  absent,
  buildTerminalEvent,
  present,
  type CycleCost,
  type FactOr,
  type RollEvent,
  type TerminalAttestFact,
  type TerminalEvent,
  type TerminalOutcome,
  type TerminalUsageFact,
} from "@roll/spec";
import { prNumberFromUrl } from "@roll/infra";
import { acMapPath } from "./attest-remediation.js";
import { verificationReportPath } from "./attest-gate.js";
import type { MetadataCommitResult, Ports } from "./ports.js";
import { epochMs } from "./runner-time.js";

/**
 * FIX-306: the runner-side `.roll` metadata commit, invoked at cycle finalize.
 * Delegates to {@link MetadataPort.commit}; a clean tree (`nothingToCommit`) is a
 * silent no-op, while any unfinished commit/push (no `pushed`) raises an auditable
 * ALERT — the cycle never reports a silent false-success on metadata it failed to
 * land. Best-effort: a thrown port (e.g. git missing) is alerted, never fatal.
 */
export async function commitRollMetadata(ports: Ports, ctx: CycleContext): Promise<void> {
  const message = `chore: loop cycle ${ctx.cycleId}${ctx.storyId !== undefined && ctx.storyId !== "" ? ` ${ctx.storyId}` : ""} metadata`;
  let res: MetadataCommitResult;
  try {
    res = await ports.metadata.commit(ports.repoCwd, message);
  } catch (e) {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `.roll metadata commit threw for cycle ${ctx.cycleId} — ${String(e)}`,
    );
    return;
  }
  if (res.nothingToCommit) return; // clean tree → quiet no-op
  if (!res.pushed) {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `.roll metadata push FAILED for cycle ${ctx.cycleId}${res.committed ? " (committed locally, not pushed)" : ""} — ${res.error ?? "unknown error"}`,
    );
  }
}

/** Stamp `ts` onto an event the orchestrator built with ts=0 (it owns no clock). */
export function stampTs(event: RollEvent, ts: number): RollEvent {
  return { ...event, ts } as RollEvent;
}

/** FIX-208: replace a cycle:end event's zero-cost placeholder with the real cost
 *  folded into liveCtx after spawn_agent. Non-cycle:end events pass through; a
 *  cycle with no parsed usage (`ctx.cost` absent) keeps the placeholder. */
export function withRealCost(event: RollEvent, ctx: CycleContext): RollEvent {
  if (event.type !== "cycle:end") return event;
  return {
    ...event,
    ...(ctx.cost !== undefined ? { cost: ctx.cost as CycleCost } : {}),
    ...(ctx.failureClass !== undefined ? { failure_class: ctx.failureClass } : {}),
    ...(ctx.rootCauseKey !== undefined ? { root_cause_key: ctx.rootCauseKey } : {}),
  };
}

/** Build the v2-shaped runs.jsonl row (keys verified against the dashboard
 *  difftest fixture: project/run_id/ts/tcr_count/built[]/status/agent/duration_sec).
 *  The bus upsert adds story_id + cycle_id for the dedupe key. FIX-208: tcr_count
 *  is the real captured count (was hardcoded 0); cost fields are added from the
 *  same liveCtx cost the cycle:end event carries, so the two records agree. */
export function buildRunRow(
  cmd: Extract<CycleCommand, { kind: "append_run" }>,
  ctx: CycleContext,
  nowSec?: number,
): Record<string, unknown> {
  const built =
    cmd.status === "done" || cmd.status === "published" || cmd.status === "built"
      ? [ctx.storyId ?? ""].filter(Boolean)
      : [];
  const row: Record<string, unknown> = {
    run_id: cmd.cycleId,
    status: cmd.status,
    agent: ctx.agent ?? "",
    built,
    tcr_count: ctx.tcrCount ?? 0,
    outcome: cmd.outcome,
  };
  const workspaceId = ctx.workspaceExecution?.workspace.workspaceId ?? ctx.repositoryExecution?.workspaceId;
  if (workspaceId !== undefined && workspaceId !== "") row["workspace_id"] = workspaceId;
  // FIX-213: stamp the cycle's terminal time (same clock the cycle:end event
  // uses) as a canonical ISO-8601 UTC string + the cycle duration. Without
  // these the dashboard could not bucket the row by day — the runs row was the
  // only record of a real delivery yet read as "0 cycles / 72h". `nowSec` is
  // epoch seconds (the runner's `ports.clock()`); millis are dropped to match
  // the v2 `…Z` schema.
  if (nowSec !== undefined) {
    row["ts"] = new Date(nowSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (ctx.startSec !== undefined) {
      const dur = nowSec - ctx.startSec;
      if (dur >= 0) row["duration_sec"] = dur;
    }
  }
  // FIX-290 AC2: `model` is fixed by the ROUTING decision (ctx.model), known the
  // moment the agent is dispatched — it is NEVER blank, even on a failed/idle
  // cycle whose usage could not be parsed. Record it unconditionally (fall back
  // to the agent id when the router left model empty, e.g. claude default).
  const routedModel = (ctx.model ?? "").trim() !== "" ? (ctx.model as string) : (ctx.agent ?? "");
  if (routedModel !== "") row["model"] = routedModel;
  // Additive cost fields (v2 runs rows omit cost — the dashboard reads it from
  // the cycle:end event; surfacing it here keeps the human-facing 可回溯链 row
  // truthful too, sourced from the SAME ctx.cost as cycle:end → consistent).
  if (ctx.cost !== undefined) {
    row["cost_usd"] = ctx.cost.estimatedCost;
    // FIX-249: budget guardrails gate on EFFECTIVE cost (I11) — persist it so
    // the ledger can be rebuilt from rows; plus model + the cache split for
    // dashboard truth (tokens were "—", cost $0, guardrail blind).
    row["cost_effective_usd"] = ctx.cost.effectiveCost;
    // FIX-361: native currency so display/reports show ¥ vs $ correctly.
    row["cost_currency"] = ctx.cost.currency;
    // The parsed usage carries the authoritative model — prefer it over the
    // routed fallback when present.
    if (ctx.cost.model !== "") row["model"] = ctx.cost.model;
    row["tokens_in"] = ctx.cost.tokensIn;
    row["tokens_out"] = ctx.cost.tokensOut;
    if (ctx.cost.cacheRead !== undefined) row["tokens_cache_read"] = ctx.cost.cacheRead;
    if (ctx.cost.cacheWrite !== undefined) row["tokens_cache_write"] = ctx.cost.cacheWrite;
  } else {
    // FIX-290 AC3: usage could not be read (e.g. usage_credentials_missing). The
    // tokens/cost are UNKNOWN, not zero — mark it so the ledger renders "?" with
    // an unknown marker instead of a misleading "$0.00 · 0/0". model + duration
    // above are still present (failure ≠ empty record).
    row["usage_unknown"] = true;
    // FIX-1050: preserve the agent-specific diagnostic reason (e.g. agy_stdout_no_usage)
    // on the runs row so `roll cycles --json` / ledger detail can distinguish
    // parser failure from genuinely missing agent usage output.
    if (ctx.usageUnknownReason !== undefined && ctx.usageUnknownReason !== "") {
      row["usage_unknown_reason"] = ctx.usageUnknownReason;
    }
  }
  // FIX-389b: write pr_number + pr_url onto the runs row from the publish
  // context so the projection engine (FIX-389a) can rebuild deliveries from
  // runs alone, without depending on appendDelivery correctness.
  if (ctx.prUrl !== undefined && ctx.prUrl !== "") {
    row["pr_url"] = ctx.prUrl;
    const parsed = prNumberFromUrl(ctx.prUrl);
    if (parsed !== undefined) row["pr_number"] = Number(parsed);
  }
  // FIX-1051: persist agent-internal failure diagnostics on the runs row so the
  // ledger / `roll cycles --detail` can surface the native failure class, summary,
  // and log path without manual spelunking.
  if (ctx.agentInternalFailure !== undefined) {
    row["agent_internal_failure"] = true;
    row["agent_internal_class"] = ctx.agentInternalFailure.class;
    row["agent_internal_summary"] = ctx.agentInternalFailure.summary;
    row["agent_internal_log_path"] = ctx.agentInternalFailure.nativeLogPath;
    if (ctx.agentInternalFailure.conversationId !== undefined) {
      row["agent_internal_conversation_id"] = ctx.agentInternalFailure.conversationId;
    }
  }
  row["failure_class"] = ctx.failureClass ?? null;
  row["root_cause_key"] = ctx.rootCauseKey ?? null;
  // US-LOOP-104: stamp the adversarial-pairing outcome (rounds/holes/reason/
  // degraded) so the shadow-run aggregate reads it from runs.jsonl. Absent ⇒ a
  // standard cycle → the field is omitted (null), keeping standard rows unchanged.
  row["adversarial"] = ctx.adversarialRun ?? null;
  return row;
}

/**
 * US-TRUTH-001 — fold the terminal command + cycle context into the versioned
 * complete-or-reasoned TerminalEvent. Every fact is present with a value or
 * carries an enumerated absent reason; a missing usage can never read as $0.
 */
export function buildTerminalRecord(
  cmd: Extract<CycleCommand, { kind: "append_run" }>,
  ctx: CycleContext,
  // FIX-343 (step ③): the PERSISTENT-.roll root (repoCwd) the report/ac-map are
  // resolved from — NOT the worktree, which may already be torn down at the
  // terminal (otherwise `acmap_missing`/`not_rendered` false-negatives).
  attestCwd: string,
  nowSec: number,
): TerminalEvent {
  const storyId = ctx.storyId ?? "";
  // v2 six-state → closed terminal vocabulary. `orphan` (publish failed,
  // branch+tag pushed for audit) is an abort WITH delivery by definition.
  const OUTCOME: Record<string, TerminalOutcome> = {
    done: "delivered",
    published: "published_pending_merge",
    built: "published_pending_merge",
    idle: "idle_no_work",
    gave_up: "gave_up",
    failed: "failed",
    blocked: "blocked",
    aborted: "aborted_no_delivery",
    orphan: "aborted_with_delivery",
    // FIX-351: gates passed but publish could not complete (work committed
    // locally, never published) — a neutral terminal, NOT a failure.
    local: "unpublished",
    // FIX-908: real work committed + code-stage peer agreed, but a required
    // acceptance artifact is missing (no independent peer Review Score /
    // empty-shell report). Branch preserved, awaits review — NOT a failure.
    needs_review: "needs_review",
    // REFACTOR-071: agent-internal failures write the gave_up terminal outcome;
    // failure_class/root_cause_key carry harness:agent_internal.
    agent_internal: "gave_up",
    // US-LOOP-079d — dormant_entered: 连续 N idle 后自卸;终态,此后无 idle 行.
    dormant: "dormant_entered",
  };
  let attest: FactOr<TerminalAttestFact>;
  if (storyId === "") {
    attest = absent("not_applicable");
  } else {
    const report = verificationReportPath(attestCwd, storyId);
    const hasReport = existsSync(report);
    const hasMap = existsSync(acMapPath(attestCwd, storyId));
    if (hasReport) attest = present({ reportPath: report, acMap: hasMap });
    else attest = absent(hasMap ? "not_rendered" : "acmap_missing");
  }
  let usage: FactOr<TerminalUsageFact>;
  if (ctx.cost !== undefined) {
    usage = present({
      model: ctx.cost.model,
      tokensIn: ctx.cost.tokensIn,
      tokensOut: ctx.cost.tokensOut,
      ...(ctx.cost.cacheRead !== undefined ? { cacheRead: ctx.cost.cacheRead } : {}),
      ...(ctx.cost.cacheWrite !== undefined ? { cacheWrite: ctx.cost.cacheWrite } : {}),
    });
  } else {
    usage = absent("no_parseable_usage");
  }
  // FIX-294 (FIX-290 follow-up): the terminal-event twin must ALSO always carry
  // the routed model — same rule as buildRunRow above. Model is fixed by the
  // ROUTING decision (ctx.model), known the moment the agent is dispatched, so
  // it is present even on a failed/idle cycle whose usage could not be parsed.
  // Prefer the authoritative model from parsed usage when present, else the
  // routed model, else fall back to the agent id (claude default leaves model
  // empty). The `usage` fact stays present-or-reasoned so a true-0 is still
  // distinguishable from unknown — but WHICH model ran is never lost.
  const routedModel = (ctx.model ?? "").trim() !== "" ? (ctx.model as string) : (ctx.agent ?? "");
  const model =
    ctx.cost !== undefined && ctx.cost.model !== "" ? ctx.cost.model : routedModel;
  return buildTerminalEvent({
    cycleId: cmd.cycleId,
    storyId,
    agent: ctx.agent ?? "",
    model,
    startedAt: epochMs(ctx.startSec ?? nowSec),
    endedAt: epochMs(nowSec),
    outcome: OUTCOME[cmd.status] ?? "unknown",
    pr:
      ctx.prUrl !== undefined && ctx.prUrl !== ""
        ? present({ url: ctx.prUrl, state: "OPEN" })
        : absent("no_publish_attempted"),
    branch: present(ctx.branch),
    // the runner does not track the head sha at this layer — reasoned, not faked.
    commit: absent("not_recorded"),
    tcr: ctx.tcrCount !== undefined ? present(ctx.tcrCount) : absent("not_recorded"),
    attest,
    usage,
    cost:
      ctx.cost !== undefined
        ? present({ estimatedUsd: ctx.cost.estimatedCost, effectiveUsd: ctx.cost.effectiveCost })
        : absent("no_parseable_usage"),
    failure_class: ctx.failureClass,
    root_cause_key: ctx.rootCauseKey,
  });
}

/** Read runs.jsonl as {@link ReconcileRunRow}[] for the preflight claim
 *  reconcile (FIX-211). US-TRUTH-019: last-wins by (story_id, cycle_id) —
 *  append-only can produce duplicate keys; the last row wins. Rows without
 *  a valid (story_id, cycle_id) token pass through unmerged.
 *  Tolerant: missing file / malformed lines → skipped, so a corrupt row
 *  never topples the cycle's orphan-recovery pass. */
export function readRunsRows(runsPath: string): ReconcileRunRow[] {
  try {
    if (!existsSync(runsPath)) return [];
    const all = readFileSync(runsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as ReconcileRunRow;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is ReconcileRunRow => r !== undefined);
    // last-wins: dedupe by (story_id, cycle_id)
    const lastWins = new Map<string, ReconcileRunRow>();
    const unkeyed: ReconcileRunRow[] = [];
    for (const row of all) {
      const sid = typeof row["story_id"] === "string" ? row["story_id"] : "";
      const cid = typeof row["cycle_id"] === "string" ? row["cycle_id"] : "";
      if (sid !== "" && cid !== "") {
        lastWins.set(`${sid}\t${cid}`, row);
      } else {
        unkeyed.push(row);
      }
    }
    return [...unkeyed, ...lastWins.values()];
  } catch {
    return [];
  }
}
