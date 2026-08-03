/**
 * Unit tests: CycleOrchestrator pure state machine (loop/orchestrator.ts).
 *
 * Pins the v2 inner-runner phase walk (bin/roll:8391-9380) as a pure stepper:
 *   - full happy path pick→…→done asserting the COMMAND SEQUENCE;
 *   - every failure branch (no story→idle; worktree fail→failed; agent fail after
 *     retries→failed+alert; timeout breach→clean teardown ORDER; publish tier-2
 *     gh-missing→merge_back; publish PR-fail→orphan/failed);
 *   - retry/backoff exhaustion → failed (NOT agent-swap, I6);
 *   - SIGKILL mid-phase → state machine resumable from persisted events (I2/I8);
 *   - event-sourcing round-trip: replay simulated events through spec
 *     parseEventLine + foldCycle and assert the rebuilt terminal state (I8).
 */
import { AGENT_CAPACITY_LEASE_SCHEMA, parseEventLine, type AgentCapacityLease, type RollEvent } from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  type CycleCommand,
  type CycleContext,
  type CycleEvent,
  type CycleState,
  backoffSchedule,
  classifyCaptured,
  classifyPublish,
  cycleEndEvent,
  cycleStep,
  foldCycle,
  initialCycleState,
  mapV2Status,
  retryPlan,
  timeoutTeardownCommands,
  watchdogVerdict,
  cycleTimeoutVerdict,
  stallVerdict,
  planRepositoryCommands,
  repositoryEventIdentity,
  finalizeBuilder,
  handoffKindFor,
  type BuilderFinalizationFacts,
  MAX_AGENT_ATTEMPTS,
  RETRY_BASE_BACKOFF_SEC,
  CYCLE_TIMEOUT_SEC,
  CYCLE_WALL_TIMEOUT_SEC,
  CYCLE_NO_PROGRESS_SEC,
  CYCLE_NO_STATE_CHANGE_SEC,
  CYCLE_STALL_THRESHOLD_SEC,
  STALL_STARTUP_GRACE_SEC,
} from "../src/index.js";
import type { RepositoryExecutionContext, RepositoryExecutionMap } from "@roll/spec";

const CTX: CycleContext = {
  cycleId: "20260605-013000-12345",
  branch: "loop/cycle-20260605-013000-12345",
  loop: "main",
};

function acquiredLease(state: CycleState): AgentCapacityLease {
  const pending = state.pendingSpawn;
  if (pending === undefined) throw new Error("test expected pending capacity spawn");
  return {
    schema: AGENT_CAPACITY_LEASE_SCHEMA,
    key: pending.key,
    owner: {
      leaseId: `lease:${pending.spawnId}`,
      ownerToken: `token:${pending.spawnId}`,
      workspaceId: state.ctx.repositoryExecution?.workspaceId ?? "test-workspace",
      storyId: state.ctx.storyId ?? "",
      cycleId: state.ctx.cycleId,
      spawnId: pending.spawnId,
      host: "test-host",
      pid: 123,
      processStartedAtMs: 1,
    },
    acquiredAtMs: 1,
    heartbeatAtMs: 1,
  };
}

/** Existing orchestrator scenarios model a ready machine slot. Capacity-specific
 * tests below call cycleStep directly to inspect the acquire/wait boundary. */
function stepWithCapacity(state: CycleState, event: CycleEvent): { state: CycleState; commands: CycleCommand[] } {
  const first = cycleStep(state, event);
  if (!first.commands.some((command) => command.kind === "acquire_capacity")) return first;
  const pending = first.state.pendingSpawn;
  if (pending === undefined) throw new Error("acquire command missing pending spawn state");
  const acquired = cycleStep(first.state, {
    type: "capacity_acquired",
    spawnId: pending.spawnId,
    lease: acquiredLease(first.state),
  });
  return { state: acquired.state, commands: [...first.commands, ...acquired.commands] };
}

function repository(
  repoId: string,
  alias: string,
  access: "read" | "write",
): RepositoryExecutionContext {
  return {
    repoId,
    alias,
    access,
    requiredDelivery: access === "write",
    worktreePath: `/workspace/issues/US-WS-010/${alias}`,
    baseSha: `${alias}-base`,
    headSha: `${alias}-head`,
    commands: {
      test: [`pnpm --dir ${alias} test`],
      integration: [`pnpm --dir ${alias} test:integration`],
    },
  };
}

function workspaceContext(repositories: RepositoryExecutionMap): CycleContext {
  return {
    ...CTX,
    storyId: "US-WS-010",
    repositoryExecution: {
      workspaceId: "ws-20260717001",
      issueRoot: "/workspace/issues/US-WS-010",
      repositories,
    },
  };
}

/** Drive a list of events through the stepper from a fresh start, collecting the
 *  command kinds in order (the SEQUENCE assertions read these). */
function walk(events: CycleEvent[]): { state: CycleState; kinds: string[]; commands: CycleCommand[] } {
  let state = initialCycleState(CTX);
  const kinds: string[] = [];
  const commands: CycleCommand[] = [];
  for (const ev of events) {
    const r = stepWithCapacity(state, ev);
    state = r.state;
    for (const c of r.commands) {
      kinds.push(c.kind);
      commands.push(c);
    }
  }
  return { state, kinds, commands };
}

// ── six-state classification ─────────────────────────────────────────────────

describe("classifyCaptured — pre-publish six-state (bin/roll:9127-9157)", () => {
  it("timed out → blocked (watchdog path)", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: true, commitsAhead: 3 })).toBe("blocked");
  });
  it("worktree-setup failed → failed (bin/roll:9000)", () => {
    expect(classifyCaptured({ usedWorktree: false, agentExit: 0, timedOut: false, commitsAhead: 0 })).toBe("failed");
  });
  it("agent exit ≠ 0 + 0 commits → failed (bin/roll:9133)", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 0 })).toBe("failed");
  });
  it("agent exit ≠ 0 + commits → built (non-zero exit with real work)", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 3 })).toBe("built");
  });
  it("exit 0 + 0 commits + no agent executed → idle (genuine no-op, bin/roll:9180)", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExecuted: false, agentExit: 0, timedOut: false, commitsAhead: 0 })).toBe("idle");
  });
  it("FIX-252: exit 0 + 0 branch commits but local main ahead origin → failed drift, not idle", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0, mainAhead: 1 })).toBe("failed");
  });
  it("exit 0 + commits → built (bin/roll:9142)", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 2 })).toBe("built");
  });
});

describe("US-WS-010 — one Story Cycle carries a repository execution map", () => {
  const writable = repository("repo-111111111111", "sot1", "write");
  const secondWritable = repository("repo-222222222222", "sot2", "write");
  const readonly = repository("repo-333333333333", "reference", "read");

  it("projects cardinality one through the same repository command contract", () => {
    const ctx = workspaceContext({ [writable.repoId]: writable });

    expect(planRepositoryCommands(ctx, "test")).toEqual({
      ok: true,
      commands: [
        {
          operation: "test",
          workspaceId: "ws-20260717001",
          storyId: "US-WS-010",
          cycleId: CTX.cycleId,
          repoId: writable.repoId,
        },
      ],
    });

    const terminalEvents: CycleEvent[] = [
      { type: "start", ctx },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-WS-010" },
      { type: "route_resolved", agent: "codex", model: "" },
      { type: "agent_exited", exit: 0, timedOut: false },
      {
        type: "facts_captured",
        facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 },
      },
      { type: "published", result: { status: 0 } },
      { type: "cleaned" },
    ];
    const workspaceResult = walk(terminalEvents);
    const legacyResult = walk([
      ...terminalEvents.slice(0, 1).map(() => ({ type: "start", ctx: CTX }) as const),
      ...terminalEvents.slice(1),
    ]);
    expect(workspaceResult.state.terminal).toBe(legacyResult.state.terminal);
    expect(workspaceResult.kinds).toEqual(legacyResult.kinds);
  });

  it("plans deterministic per-repository commands while retaining one Cycle lifecycle", () => {
    const repositories = {
      [secondWritable.repoId]: secondWritable,
      [writable.repoId]: writable,
    } satisfies RepositoryExecutionMap;
    const ctx = workspaceContext(repositories);

    expect(planRepositoryCommands(ctx, "tcr")).toEqual({
      ok: true,
      commands: [
        {
          operation: "tcr",
          workspaceId: "ws-20260717001",
          storyId: "US-WS-010",
          cycleId: CTX.cycleId,
          repoId: writable.repoId,
        },
        {
          operation: "tcr",
          workspaceId: "ws-20260717001",
          storyId: "US-WS-010",
          cycleId: CTX.cycleId,
          repoId: secondWritable.repoId,
        },
      ],
    });

    const { commands } = walk([
      { type: "start", ctx },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-WS-010" },
      { type: "route_resolved", agent: "codex", model: "" },
    ]);
    expect(commands.filter((command) => command.kind === "spawn_agent")).toHaveLength(1);
    expect(
      commands.filter(
        (command) => command.kind === "emit_event" && command.event.type === "cycle:start",
      ),
    ).toHaveLength(1);
  });

  it("allows read-only repositories as context but rejects edit, TCR and publish selection", () => {
    const ctx = workspaceContext({
      [writable.repoId]: writable,
      [readonly.repoId]: readonly,
    });

    expect(planRepositoryCommands(ctx, "context")).toMatchObject({
      ok: true,
      commands: [
        { operation: "context", repoId: writable.repoId },
        { operation: "context", repoId: readonly.repoId },
      ],
    });
    for (const operation of ["edit", "tcr", "publish"] as const) {
      expect(planRepositoryCommands(ctx, operation, [readonly.repoId])).toEqual({
        ok: false,
        code: "read_only_repository",
        repoId: readonly.repoId,
        operation,
      });
    }
  });

  it("binds repository events to Workspace, Story, Cycle and repository identity", () => {
    const ctx = workspaceContext({ [writable.repoId]: writable });

    expect(repositoryEventIdentity(ctx, writable.repoId)).toEqual({
      ok: true,
      identity: {
        workspaceId: "ws-20260717001",
        storyId: "US-WS-010",
        cycleId: CTX.cycleId,
        repoId: writable.repoId,
      },
    });
    expect(repositoryEventIdentity(ctx, "repo-ffffffffffff")).toEqual({
      ok: false,
      code: "unknown_repository",
      repoId: "repo-ffffffffffff",
    });
  });

  it("rejects a map key that disagrees with the repository identity", () => {
    const ctx = workspaceContext({ "repo-ffffffffffff": writable });

    expect(planRepositoryCommands(ctx, "context")).toEqual({
      ok: false,
      code: "invalid_repository_map",
    });
  });

  it("blocks committed Workspace work while repository verification is pending", () => {
    expect(classifyCaptured({
      usedWorktree: true,
      agentExecuted: true,
      agentExit: 0,
      timedOut: false,
      commitsAhead: 2,
      repositoryVerificationPending: true,
    })).toBe("blocked");
  });

  it("blocks verified Workspace work at the repository publish handoff", () => {
    expect(classifyCaptured({
      usedWorktree: true,
      agentExecuted: true,
      agentExit: 0,
      timedOut: false,
      commitsAhead: 2,
      repositoryPublishPending: true,
    })).toBe("blocked");
  });

  it.each([
    { label: "dirty with commits", commitsAhead: 2 },
    { label: "dirty only", commitsAhead: 0 },
  ])("blocks $label before legacy handoff classification", ({ commitsAhead }) => {
    expect(classifyCaptured({
      usedWorktree: true,
      agentExecuted: true,
      agentExit: 0,
      timedOut: false,
      commitsAhead,
      worktreeDirty: true,
      repositoryVerificationPending: true,
    })).toBe("blocked");
  });
});

describe("Hook 1 — productivity floor: gave_up vs idle", () => {
  it("agent EXECUTED + exit 0 + 0 commits → gave_up (failed-class), not idle", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExecuted: true, agentExit: 0, timedOut: false, commitsAhead: 0 }),
    ).toBe("gave_up");
  });
  it("no agent executed (genuine no-op) → still idle, never gave_up", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExecuted: false, agentExit: 0, timedOut: false, commitsAhead: 0 }),
    ).toBe("idle");
  });
  it("agentExecuted undefined defaults to executed (capture only follows a spawn) → gave_up", () => {
    expect(classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0 })).toBe("gave_up");
  });
  it("gave_up maps to its own terminal outcome (failed-class, not idle_no_work)", () => {
    expect(mapV2Status("gave_up")).toBe("gave_up");
  });
  it("a gave_up cycle cleans the worktree and ALERTs on the FIRST occurrence (no streak)", () => {
    const { state, kinds, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-284" },
      { type: "route_resolved", agent: "codex", model: "" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExecuted: true, agentExit: 0, timedOut: false, commitsAhead: 0 } },
    ]);
    expect(state.terminal).toBe("gave_up");
    expect(kinds).toContain("cleanup_worktree");
    // ALERT is written on the FIRST gave_up — no 2-hit streak required.
    const alert = commands.find((c) => c.kind === "append_alert");
    expect(alert).toMatchObject({ message: expect.stringContaining("gave_up") });
    // The terminal runs row carries the gave_up status (failed-class).
    const run = commands.find((c) => c.kind === "append_run");
    expect(run).toMatchObject({ status: "gave_up", outcome: "gave_up" });
  });
});

describe("FIX-1039 — handoff_without_tcr: dirty worktree but zero TCR commits", () => {
  it("committed prefix + dirty worktree → handoff_without_tcr before publish", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1, worktreeDirty: true }),
    ).toBe("handoff_without_tcr");
  });
  it("exit 0 + 0 commits + dirty worktree → handoff_without_tcr (recoverable, not gave_up)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0, worktreeDirty: true }),
    ).toBe("handoff_without_tcr");
  });
  it("exit 0 + 0 commits + agent executed + dirty worktree → handoff_without_tcr takes priority over gave_up", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExecuted: true, agentExit: 0, timedOut: false, commitsAhead: 0, worktreeDirty: true }),
    ).toBe("handoff_without_tcr");
  });
  it("exit 0 + 0 commits + clean worktree → gave_up (no dirt to preserve)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExecuted: true, agentExit: 0, timedOut: false, commitsAhead: 0 }),
    ).toBe("gave_up");
  });
  it("handoff_without_tcr maps to its own terminal outcome (failed-class, not gave_up)", () => {
    expect(mapV2Status("handoff_without_tcr")).toBe("handoff_without_tcr");
  });
  it("a handoff_without_tcr cycle PRESERVES the worktree (no cleanup_worktree) and ALERTs", () => {
    const { state, kinds, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-284" },
      { type: "route_resolved", agent: "codex", model: "" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0, worktreeDirty: true } },
    ]);
    expect(state.terminal).toBe("handoff_without_tcr");
    // NO cleanup_worktree — the worktree is PRESERVED for recovery
    expect(kinds).not.toContain("cleanup_worktree");
    // ALERT explains the situation and names the preserved branch
    const alert = commands.find((c) => c.kind === "append_alert");
    expect(alert).toMatchObject({ message: expect.stringContaining("handoff_without_tcr") });
    expect(alert).toMatchObject({ message: expect.stringContaining("worktree preserved") });
    // The terminal runs row carries the handoff_without_tcr status
    const run = commands.find((c) => c.kind === "append_run");
    expect(run).toMatchObject({ status: "handoff_without_tcr", outcome: "handoff_without_tcr" });
  });
});

describe("FIX-1051/REFACTOR-071 — agent_internal: agy internal tool errors surface via attribution", () => {
  const AIF = { class: "agy_grep_timeout", summary: "GREP_SEARCH timed out", nativeLogPath: "/tmp/cli.log" };

  it("classifyCaptured returns agent_internal when agentInternalFailure is present", () => {
    expect(
      classifyCaptured({
        usedWorktree: true,
        agentExecuted: true,
        agentExit: 0,
        timedOut: false,
        commitsAhead: 0,
        agentInternalFailure: AIF,
      }),
    ).toBe("agent_internal");
  });
  it("agent_internal overrides gave_up but not handoff_without_tcr", () => {
    expect(
      classifyCaptured({
        usedWorktree: true,
        agentExit: 0,
        timedOut: false,
        commitsAhead: 0,
        worktreeDirty: true,
        agentInternalFailure: AIF,
      }),
    ).toBe("handoff_without_tcr");
  });
  it("mapV2Status(agent_internal) → gave_up", () => {
    expect(mapV2Status("agent_internal")).toBe("gave_up");
  });
  it("agent_internal terminal cleans worktree and ALERTs with failure class/summary/log", () => {
    const { state, kinds, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-284" },
      { type: "route_resolved", agent: "agy", model: "gemini-2.5-pro" },
      { type: "agent_exited", exit: 0, timedOut: false },
      {
        type: "facts_captured",
        facts: {
          usedWorktree: true,
          agentExecuted: true,
          agentExit: 0,
          timedOut: false,
          commitsAhead: 0,
          agentInternalFailure: AIF,
        },
      },
    ]);
    expect(state.terminal).toBe("agent_internal");
    expect(kinds).toContain("cleanup_worktree");
    const alert = commands.find((c) => c.kind === "append_alert");
    expect(alert).toMatchObject({ message: expect.stringContaining("agent_internal") });
    expect(alert).toMatchObject({ message: expect.stringContaining(AIF.class) });
    expect(alert).toMatchObject({ message: expect.stringContaining(AIF.summary) });
    expect(alert).toMatchObject({ message: expect.stringContaining(AIF.nativeLogPath) });
    const run = commands.find((c) => c.kind === "append_run");
    expect(run).toMatchObject({
      status: "agent_internal",
      outcome: "gave_up",
      failure_class: "harness",
      root_cause_key: "harness:agent_internal",
    });
  });
});

describe("FIX-244 — phantom-failure classification (published terminal)", () => {
  it("non-zero exit + commits + OPEN PR for the cycle branch → published, not failed", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 3, prState: "OPEN" }),
    ).toBe("published");
  });
  it("FIX-1037: mainDirty blocks non-zero + commits + OPEN PR before phantom-publish credit", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 3, prState: "OPEN", mainDirty: true }),
    ).toBe("failed");
  });
  it("FIX-1037: mainDirty blocks gateBlocked + commits + existing PR before publish credit", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 3, prState: "MERGED", mainDirty: true }),
    ).toBe("failed");
  });
  it("FIX-1037: mainDirty blocks successful commit work before the publish ladder", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 3, mainDirty: true }),
    ).toBe("failed");
  });
  it("non-zero exit + commits + already-MERGED PR → published (backfill credits it)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 3, prState: "MERGED" }),
    ).toBe("published");
  });
  it("non-zero exit + commits + no PR → built (agent did real work; publish ladder opens PR)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 3 }),
    ).toBe("built");
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 3, prState: "UNKNOWN" }),
    ).toBe("built");
  });
  it("non-zero exit + 0 commits → failed (agent crashed without producing work)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 0 }),
    ).toBe("failed");
  });
  it("gateBlocked + commits → failed (policy rejection, not code defect)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 3 }),
    ).toBe("failed");
  });
  it("gateBlocked + commits + existing PR → published (FIX-244 re-run)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 3, prState: "OPEN" }),
    ).toBe("published");
  });
  // FIX-908: a gate-blocked cycle that did real work but is only missing a
  // required acceptance artifact is `needs_review` (work preserved), NOT `failed`.
  it("FIX-908: gateBlocked + commits + needsReview → needs_review (work preserved, not orphaned)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 3, needsReview: true }),
    ).toBe("needs_review");
  });
  it("FIX-908: gateBlocked + ZERO commits + needsReview → failed (no real work to preserve)", () => {
    // needs_review is gated on real work; a 0-commit block can never escape failed.
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 0, needsReview: true }),
    ).toBe("failed");
  });
  it("FIX-908: gateBlocked + commits WITHOUT needsReview → failed (normal failed path unchanged)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 3 }),
    ).toBe("failed");
  });
  it("FIX-908: existing PR pre-empts needs_review → published (FIX-244 takes precedence)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, gateBlocked: true, timedOut: false, commitsAhead: 3, needsReview: true, prState: "MERGED" }),
    ).toBe("published");
  });
  it("FIX-908: needsReview never escapes a non-gateBlocked clean built cycle", () => {
    // A passing-gate built cycle ignores needsReview entirely (it is only set on a
    // gate block) — defends against any future caller leaking the flag onto a pass.
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 3, needsReview: true }),
    ).toBe("built");
  });
  it("FIX-908: mapV2Status(needs_review) → needs_review (distinct terminal outcome)", () => {
    expect(mapV2Status("needs_review")).toBe("needs_review");
  });
  it("OPEN PR but zero commits ahead → not published (nothing of this cycle is in it)", () => {
    expect(
      classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 0, prState: "OPEN" }),
    ).toBe("failed");
  });
  it("mapV2Status(published) → published_pending_merge (PR open, merge pending)", () => {
    expect(mapV2Status("published")).toBe("published_pending_merge");
  });
});

describe("US-DELIV-013 — published cycles await reconciliation", () => {
  it("ignores the retired PR-loop health shape and emits no failure attribution", () => {
    const ctx = {
      ...CTX,
      prLoopHealthy: false,
      prUrl: "https://github.com/o/r/pull/759",
    };
    let state = initialCycleState(ctx);
    const commands: CycleCommand[] = [];
    for (const ev of [
      { type: "start", ctx },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-308" },
      { type: "route_resolved", agent: "reasonix", model: "deepseek-v4-pro" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 0 } },
    ] satisfies CycleEvent[]) {
      const r = stepWithCapacity(state, ev);
      state = r.state;
      commands.push(...r.commands);
    }

    expect(state.terminal).toBe("published");
    const run = commands.find((c) => c.kind === "append_run");
    expect(run).toMatchObject({ status: "published", outcome: "published_pending_merge" });
    expect(run).not.toHaveProperty("failure_class");
    expect(run).not.toHaveProperty("root_cause_key");
    const end = commands.find((c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
      c.kind === "emit_event" && c.event.type === "cycle:end",
    );
    expect(end?.event).toMatchObject({ type: "cycle:end", outcome: "published_pending_merge" });
    expect(end?.event).not.toHaveProperty("failure_class");
    expect(end?.event).not.toHaveProperty("root_cause_key");
    const alert = commands.find((c) => c.kind === "append_alert");
    expect(alert).toBeUndefined();
  });
});

describe("US-DELIV-001 — AWAITING_MERGE suspension: publish releases the loop (no merge-wait)", () => {
  /** Walk a full happy-path cycle and collect every command. */
  function walkPublishedCycle(): { state: ReturnType<typeof initialCycleState>; commands: CycleCommand[] } {
    const ctx: CycleContext = { ...CTX, prUrl: "https://github.com/o/r/pull/42" };
    let state = initialCycleState(ctx);
    const commands: CycleCommand[] = [];
    for (const ev of [
      { type: "start", ctx },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-DELIV-001" },
      { type: "route_resolved", agent: "kimi", model: "m" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 0 } },
    ] satisfies CycleEvent[]) {
      const r = stepWithCapacity(state, ev);
      state = r.state;
      commands.push(...r.commands);
    }
    return { state, commands };
  }

  it("sequence assertion: `published` terminates the cycle IMMEDIATELY — no wait_merge, no merge-wait phase", () => {
    const { state, commands } = walkPublishedCycle();
    // The cycle is terminal the moment the PR is open: cleanup + append_run +
    // cycle:end, and the runner is free to pick the next card.
    expect(state.terminal).toBe("published");
    expect(state.phase).toBe("cleanup");
    expect(commands.some((c) => c.kind === "wait_merge")).toBe(false);
    expect(commands.some((c) => c.kind === "append_run" && c.status === "published")).toBe(true);
    expect(commands.some((c) => c.kind === "emit_event" && c.event.type === "cycle:end")).toBe(true);
  });

  it("a merge_polled event after terminal is a no-op (the merge-wait path is never entered from publish)", () => {
    const { state } = walkPublishedCycle();
    const r = cycleStep(state, { type: "merge_polled", state: "OPEN", elapsedSec: 30 });
    expect(r.state.terminal).toBe("published");
    expect(r.commands).toEqual([]);
  });
});

describe("classifyPublish — publish ladder refines built (bin/roll:9239-9356)", () => {
  it("FIX-244: status 0 → published (PR open, merge pending — done ≡ merged, I4)", () => {
    expect(classifyPublish({ status: 0 })).toBe("published");
  });
  it("FIX-1214: degraded status 0 (transient gh API fault) still → published so the PR loop retries", () => {
    expect(classifyPublish({ status: 0, degraded: true, rootCauseKey: "env:gh_api" })).toBe("published");
  });
  it("FIX-909: status 0 + draft manual review stays needs_review", () => {
    expect(classifyPublish({ status: 0, manualMerge: true, draft: true })).toBe("needs_review");
  });
  it("status 2 + mergedBack → done (gh missing, ff)", () => {
    expect(classifyPublish({ status: 2, mergedBack: true })).toBe("done");
  });
  it("manual merge + gh missing never counts merge_back as done", () => {
    // gh missing + manualMerge + a ff merge_back: not `done` (manual merge owes a
    // human). FIX-351: the WORK passed its gates and is committed locally, so this
    // is `local` (unpublished), NOT `failed` — only a GATE failure is `failed`.
    expect(classifyPublish({ status: 2, manualMerge: true, mergedBack: true })).toBe("local");
  });
  it("status 2 + orphanPushed → orphan", () => {
    expect(classifyPublish({ status: 2, orphanPushed: true })).toBe("orphan");
  });
  it("FIX-351: status 2 + neither (no merge-back, no orphan) → local (gates passed, unpublished)", () => {
    expect(classifyPublish({ status: 2 })).toBe("local");
  });
  it("PR-fail + orphanPushed → orphan", () => {
    expect(classifyPublish({ status: 1, orphanPushed: true })).toBe("orphan");
  });
  it("FIX-351: PR-fail + not pushed → local, NOT failed (work passed gates, only publish couldn't complete)", () => {
    expect(classifyPublish({ status: 1 })).toBe("local");
  });
  it("FIX-1256 / FIX-908: gateBlocked PR-fail → needs_review (preserve branch for review)", () => {
    expect(classifyPublish({ status: 1, gateBlocked: true })).toBe("needs_review");
  });
});

describe("FIX-351 — gates-passed-but-unpublished is a neutral terminal, not a failure", () => {
  it("a `built` capture (gates passed: exit 0, commits>0) is the ONLY entry to the publish ladder", () => {
    // The publish ladder (classifyPublish) is only ever reached from a `built`
    // capture — i.e. a cycle whose gates already PASSED. So a publish that can't
    // complete is a sound cycle that didn't publish, not a gate failure.
    expect(classifyCaptured({ usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 2 })).toBe("built");
  });
  it("agent exit ≠ 0 with commits now reaches the publish ladder (built, not failed)", () => {
    // Non-zero exit from an agent that produced commits (e.g. pi exiting ≠0 after
    // a successful build) is now "built", giving the publish ladder a chance to
    // open a PR. CI + peer review catch real quality issues.
    expect(classifyCaptured({ usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 1 })).toBe("built");
  });
  it("`local` v2 status maps to the neutral `unpublished` TerminalOutcome (never `failed`)", () => {
    expect(mapV2Status("local")).toBe("unpublished");
    expect(mapV2Status("local")).not.toBe("failed");
  });
});

describe("mapV2Status — v2 rows → TerminalOutcome bridge", () => {
  it("idle/built/orphan use closed terminal vocabulary", () => {
    expect(mapV2Status("idle")).toBe("idle_no_work");
    expect(mapV2Status("built")).toBe("published_pending_merge");
    expect(mapV2Status("orphan")).toBe("aborted_with_delivery");
  });
  it("done → delivered, blocked/failed passthrough, aborted is reasoned", () => {
    expect(mapV2Status("done")).toBe("delivered");
    expect(mapV2Status("blocked")).toBe("blocked");
    expect(mapV2Status("failed")).toBe("failed");
    expect(mapV2Status("aborted")).toBe("aborted_no_delivery");
  });
  it("US-LOOP-079d: dormant → dormant_entered (连续 N idle 后自卸)", () => {
    expect(mapV2Status("dormant")).toBe("dormant_entered");
  });
});

describe("US-TOOL-011 — tool costs in cycle:end", () => {
  it("threads ToolRegistry snapshot costs into the CycleCost payload", () => {
    const event = cycleEndEvent(
      {
        cycleId: "cycle-tools",
        branch: "loop/cycle-tools",
        agent: "codex",
        model: "gpt-5",
        toolCosts: [
          {
            toolId: "bash.exec" as never,
            invocations: 2,
            durationMs: 46,
            failures: 1,
            estimatedCost: 0,
            currency: "USD",
            inputBytes: 12,
            outputBytes: 34,
          },
        ],
      },
      "done",
      123,
    );

    expect(event).toMatchObject({
      type: "cycle:end",
      cycleId: "cycle-tools",
      outcome: "delivered",
      cost: {
        cycleId: "cycle-tools",
        toolCosts: [
          expect.objectContaining({
            toolId: "bash.exec",
            invocations: 2,
            durationMs: 46,
            failures: 1,
            inputBytes: 12,
            outputBytes: 34,
          }),
        ],
      },
    });
  });
});

// ── happy path: pick → … → done ──────────────────────────────────────────────

describe("happy-path phase walk → done", () => {
  it("emits the full command sequence and ends delivered", () => {
    const { state, kinds } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-1" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 2 } },
      { type: "published", result: { status: 0 } },
    ]);
    // The budget gate is REMOVED — route_resolved now emits spawn_agent directly
    // (no intermediate budget_check step).
    // FIX-382: cycle:start moved from worktree_created to route_resolved.
    expect(kinds).toEqual([
      "preflight",
      "create_worktree",
      "pick_story",
      "resume_worktree", // RESUME-PRIOR-WORK re-point (post-pick, before route/spawn)
      "resolve_route",
      "emit_event", // cycle:start (FIX-382: now emitted at route_resolved with real storyId+agent)
      "acquire_capacity",
      "emit_event", // workspace:capacity_acquired
      "spawn_agent",
      "release_capacity",
      "emit_event", // workspace:capacity_released
      "capture_facts",
      "emit_event", // FIX-1068: builder finalization gate verdict before peer/attest/PR/cleanup
      "publish_pr",
      "emit_event", // cycle:end (published — merge pending, FIX-244)
      "append_run",
      "release_lock",
      "cleanup_environment", // US-LOOP-088: best-effort after terminal record + lock release
      "cleanup_worktree",
    ]);
    expect(state.done).toBe(true);
    expect(state.terminal).toBe("published");
    expect(state.phase).toBe("cleanup");
  });

  it("RESUME wiring (FIX-284): story_picked emits resume_worktree with the picked id BEFORE resolve_route/spawn_agent", () => {
    // The resume decision MUST carry the freshly-picked story id (the pick runs
    // INSIDE the worktree, so storyId is undefined until story_picked), and must
    // happen before the agent spawns so the worktree can be re-pointed in time.
    const r = cycleStep(
      { ...initialCycleState(CTX), phase: "pick", worktreeReady: true },
      { type: "story_picked", storyId: "FIX-284" },
    );
    const resumeIdx = r.commands.findIndex((c) => c.kind === "resume_worktree");
    const routeIdx = r.commands.findIndex((c) => c.kind === "resolve_route");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(routeIdx).toBeGreaterThan(resumeIdx); // resume re-point precedes route → spawn
    expect(r.commands[resumeIdx]).toEqual({ kind: "resume_worktree", storyId: "FIX-284" });
    // The story id threaded into ctx is the picked one (feeds resolveResumeBase).
    expect(r.state.ctx.storyId).toBe("FIX-284");
  });

  it("FIX-909: needs_review publishes a draft/manual PR instead of silently ending", () => {
    const r = cycleStep(
      { ...initialCycleState(CTX), phase: "reconcile", ctx: { ...CTX, branch: "loop/cycle-x", storyId: "FIX-909" } },
      {
        type: "facts_captured",
        facts: { usedWorktree: true, agentExit: 0, gateBlocked: true, needsReview: true, timedOut: false, commitsAhead: 2 },
      },
    );
    expect(r.state.phase).toBe("publish");
    expect(r.commands).toEqual([
      {
        kind: "emit_event",
        event: {
          type: "builder:finalized",
          cycleId: "20260605-013000-12345",
          storyId: "FIX-909",
          agent: "",
          verdict: "ready_for_peer_and_attest",
          facts: {
            storyId: "FIX-909",
            cycleId: "20260605-013000-12345",
            agent: "",
            worktreePath: ".roll/loop/worktrees/cycle-20260605-013000-12345",
            expectedProjectPath: "",
            processExited: true,
            exitCode: 0,
            commitsAhead: 2,
            tcrCount: 0,
            worktreeDirty: false,
            mainCheckoutDirty: false,
            prUrl: null,
            attestReportPath: null,
            recentActivity: false,
          },
          ts: 0,
        },
      },
      { kind: "publish_pr", branch: "loop/cycle-x", docOnly: false, manualMerge: true, draft: true },
    ]);
  });
});

describe("US-WS-017b — capacity is the sole spawn transition", () => {
  function routedState(): { state: CycleState; commands: CycleCommand[] } {
    let state = initialCycleState(CTX);
    for (const event of [
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-CAPACITY" },
    ] satisfies CycleEvent[]) {
      state = cycleStep(state, event).state;
    }
    return cycleStep(state, { type: "route_resolved", agent: "codex", model: "gpt-capacity" });
  }

  it("records one pending spawn and emits no process before acquisition", () => {
    const routed = routedState();
    expect(routed.commands.map((command) => command.kind)).toEqual(["emit_event", "acquire_capacity"]);
    expect(routed.commands.some((command) => command.kind === "spawn_agent")).toBe(false);
    expect(routed.state.pendingSpawn).toMatchObject({
      spawnId: `${CTX.cycleId}:agent:1`,
      key: { agent: "codex", model: "gpt-capacity" },
      process: { kind: "agent", agent: "codex", attempt: 1 },
    });
  });

  it("starts only the matching pending process after exact acquisition", () => {
    const routed = routedState();
    const pending = routed.state.pendingSpawn!;
    const acquired = cycleStep(routed.state, {
      type: "capacity_acquired",
      spawnId: pending.spawnId,
      lease: acquiredLease(routed.state),
    });
    expect(acquired.commands.map((command) => command.kind)).toEqual(["emit_event", "spawn_agent"]);
    expect(acquired.state.pendingSpawn).toBeUndefined();
    expect(acquired.state.activeCapacity?.owner.spawnId).toBe(pending.spawnId);
  });

  it("rejects mismatched acquisition and never spawns unleased work", () => {
    const routed = routedState();
    const rejected = cycleStep(routed.state, {
      type: "capacity_acquired",
      spawnId: "other-spawn",
      lease: acquiredLease(routed.state),
    });
    expect(rejected.state.terminal).toBe("failed");
    expect(rejected.commands.some((command) => command.kind === "spawn_agent")).toBe(false);
    expect(rejected.commands.some((command) => command.kind === "append_alert")).toBe(true);
  });

  it("capacity exhaustion is a redacted zero-spawn neutral terminal", () => {
    const routed = routedState();
    const pending = routed.state.pendingSpawn!;
    const waiting = cycleStep(routed.state, {
      type: "waiting_capacity",
      spawnId: pending.spawnId,
      retryAtMs: 9_000,
      contenders: [
        { agent: "codex", cycleId: "private-cycle-one" },
        { agent: "codex", cycleId: "private-cycle-two" },
      ],
      suspect: false,
    });
    expect(waiting.state.terminal).toBe("waiting_capacity");
    expect(waiting.commands.some((command) => command.kind === "spawn_agent")).toBe(false);
    const event = waiting.commands.find(
      (command): command is Extract<CycleCommand, { kind: "emit_event" }> =>
        command.kind === "emit_event" && command.event.type === "workspace:waiting_capacity",
    );
    expect(event?.event).toMatchObject({
      type: "workspace:waiting_capacity",
      agent: "codex",
      model: "gpt-capacity",
      retryAt: 9_000,
      contenders: ["codex"],
      suspect: false,
    });
    expect(JSON.stringify(event)).not.toContain("private-cycle");
    expect(waiting.commands.find((command) => command.kind === "append_run")).toMatchObject({
      status: "waiting_capacity",
      outcome: "waiting_capacity",
    });
  });

  it("releases the active lease before retry acquisition", () => {
    const routed = routedState();
    const pending = routed.state.pendingSpawn!;
    const acquired = cycleStep(routed.state, {
      type: "capacity_acquired",
      spawnId: pending.spawnId,
      lease: acquiredLease(routed.state),
    });
    const retry = cycleStep(acquired.state, { type: "agent_exited", exit: 1, timedOut: false });
    expect(retry.commands.map((command) => command.kind)).toEqual([
      "release_capacity",
      "emit_event",
      "sleep_backoff",
      "acquire_capacity",
    ]);
    expect(retry.state.activeCapacity).toBeUndefined();
    expect(retry.state.pendingSpawn?.process).toMatchObject({ kind: "agent", attempt: 2 });
  });
});

// ── failure branches ─────────────────────────────────────────────────────────

describe("failure branches", () => {
  it("no story → idle terminal + worktree reclaimed (bin/roll:9180-class)", () => {
    const { state, kinds } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "no_story" },
    ]);
    expect(state.terminal).toBe("idle");
    expect(mapV2Status(state.terminal!)).toBe("idle_no_work");
    expect(kinds.slice(-5)).toEqual(["emit_event", "append_run", "release_lock", "cleanup_environment", "cleanup_worktree"]);
  });

  it("FIX-252: local-main drift fails loud, saves rescue ref, leaves worktree, and writes an alert", () => {
    const { state, kinds, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-252" },
      { type: "route_resolved", agent: "pi", model: "" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0, mainAhead: 1 } },
    ]);
    expect(state.terminal).toBe("failed");
    expect(kinds).not.toContain("cleanup_worktree");
    // FIX-903: rescue_leaked saves commits before alert + terminal
    expect(kinds.slice(-5)).toEqual(["rescue_leaked", "append_alert", "emit_event", "append_run", "release_lock"]);
    expect(commands.find((c) => c.kind === "rescue_leaked")).toMatchObject({
      kind: "rescue_leaked",
      cycleId: CTX.cycleId,
    });
    expect(commands.find((c) => c.kind === "append_alert")).toMatchObject({
      message: expect.stringContaining("local main is ahead of origin/main"),
    });
    const violation = commands.find((c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
      c.kind === "emit_event" && c.event.type === "builder:boundary_violation"
    );
    expect(violation?.event).toMatchObject({
      type: "builder:boundary_violation",
      storyId: "FIX-252",
      agent: "pi",
      kind: "main_checkout_dirty",
      attemptedCwd: "",
      expectedWorktreeCwd: `.roll/loop/worktrees/cycle-${CTX.cycleId}`,
      leakedCommits: 1,
    });
  });

  it("worktree setup fail → failed + tolerant worktree cleanup", () => {
    const { state, kinds } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_failed" },
    ]);
    expect(state.terminal).toBe("failed");
    expect(kinds.slice(-5)).toEqual(["emit_event", "append_run", "release_lock", "cleanup_environment", "cleanup_worktree"]);
  });

  it("repository setup fail → failed before routing and releases cycle-owned resources", () => {
    const { state, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "repository_setup_failed", storyId: "US-WS-011" },
    ]);

    expect(state.terminal).toBe("failed");
    expect(state.ctx.storyId).toBe("US-WS-011");
    expect(commands.map((command) => command.kind).slice(-5)).toEqual([
      "emit_event",
      "append_run",
      "release_lock",
      "cleanup_environment",
      "cleanup_worktree",
    ]);
    expect(commands.some((command) => command.kind === "resolve_route" || command.kind === "spawn_agent")).toBe(false);
  });

  it("agent fail after retry budget → failed + ALERT (I6, no agent-swap)", () => {
    let state = initialCycleState(CTX);
    const drive = (ev: CycleEvent): CycleCommand[] => {
      const r = stepWithCapacity(state, ev);
      state = r.state;
      return r.commands;
    };
    drive({ type: "start", ctx: CTX });
    drive({ type: "preflight_done" });
    drive({ type: "worktree_created" });
    drive({ type: "story_picked", storyId: "US-1" });
    drive({ type: "route_resolved", agent: "pi", model: "k2" });
    // attempt 1 fails → retry to 2
    let cmds = drive({ type: "agent_exited", exit: 1, timedOut: false });
    expect(cmds.map((c) => c.kind)).toEqual([
      "release_capacity",
      "emit_event",
      "sleep_backoff",
      "acquire_capacity",
      "emit_event",
      "spawn_agent",
    ]);
    expect(state.attempt).toBe(2);
    // attempt 2 fails → retry to 3
    cmds = drive({ type: "agent_exited", exit: 1, timedOut: false });
    expect(state.attempt).toBe(3);
    // attempt 3 fails → exhausted → failed terminal + alert
    cmds = drive({ type: "agent_exited", exit: 1, timedOut: false });
    expect(state.terminal).toBe("failed");
    expect(cmds.map((c) => c.kind)).toEqual([
      "release_capacity",
      "emit_event",
      "append_alert",
      "emit_event",
      "append_run",
      "release_lock",
    ]);
    // I6: no spawn_agent / no route-swap among the terminal commands.
    expect(cmds.some((c) => c.kind === "spawn_agent")).toBe(false);
  });

  it("publish tier-2 (gh missing) merge_back classifies done", () => {
    expect(classifyPublish({ status: 2, mergedBack: true })).toBe("done");
    const { state } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-1" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 2, mergedBack: true } },
    ]);
    expect(state.terminal).toBe("done");
  });

  it("publish PR-fail + orphan pushed → orphan; not pushed → local (FIX-351, worktree preserved)", () => {
    const orphan = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-1" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 1, orphanPushed: true } },
    ]);
    expect(orphan.state.terminal).toBe("orphan");
    expect(orphan.kinds).toContain("cleanup_worktree");

    // FIX-351: a gates-passed (`built`) cycle whose publish couldn't complete and
    // whose orphan branch wasn't pushed is `local` (unpublished), NOT `failed` —
    // the work is sound and committed; only the publish step didn't land. This is
    // FIX-313's exact shape (3 TCR commits, attest produced, peer consulted, then
    // a publish that couldn't complete) — it must no longer paint the cycle red.
    const local = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-1" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 1 } },
    ]);
    expect(local.state.terminal).toBe("local");
    expect(local.state.terminal).not.toBe("failed");
    // worktree PRESERVED on publish-fail (bin/roll:9337) — no cleanup command,
    // so the local commits stay recoverable on the branch.
    expect(local.kinds).not.toContain("cleanup_worktree");
  });

  it("agent exit ≠ 0 with commits → built → enters publish ladder (not failed)", () => {
    // Non-zero exit + commits = agent did real work. It now classifies as "built"
    // and enters the publish ladder to open a PR. CI + peer review catch issues.
    const built = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-1" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 1, timedOut: false, commitsAhead: 1 } },
    ]);
    // built → enters publish phase
    expect(built.state.phase).toBe("publish");
    expect(built.kinds).toContain("publish_pr");
  });

  it("route_resolved acquires machine capacity before spawning", () => {
    let state = initialCycleState(CTX);
    const drive = (ev: CycleEvent): CycleCommand[] => {
      const r = stepWithCapacity(state, ev);
      state = r.state;
      return r.commands;
    };
    drive({ type: "start", ctx: CTX });
    drive({ type: "preflight_done" });
    drive({ type: "worktree_created" });
    drive({ type: "story_picked", storyId: "US-1" });
    const cmds = drive({ type: "route_resolved", agent: "claude", model: "opus" });
    // FIX-382: route_resolved now emits cycle:start (with resolved storyId+agent) before spawn.
    expect(cmds.map((c) => c.kind)).toEqual([
      "emit_event",
      "acquire_capacity",
      "emit_event",
      "spawn_agent",
    ]);
    expect(state.phase).toBe("execute");
    expect(state.attempt).toBe(1);
  });
});

// ── hard timeout: watchdog + clean teardown ORDER ────────────────────────────

describe("watchdogVerdict — hard timeout (bin/roll:8473)", () => {
  it("default limit is 2700s", () => {
    expect(CYCLE_TIMEOUT_SEC).toBe(2700);
  });
  it("not breached below the limit, reports remaining", () => {
    expect(watchdogVerdict(100, 2700)).toEqual({ breached: false, remainingSec: 2600 });
  });
  it("breaches at the boundary (>=) and reports overshoot", () => {
    expect(watchdogVerdict(2700, 2700)).toEqual({ breached: true, overshootSec: 0 });
    expect(watchdogVerdict(2750, 2700)).toEqual({ breached: true, overshootSec: 50 });
  });
});

describe("FIX-907 — cycleTimeoutVerdict (per-cycle hard timeout: wall + no-progress)", () => {
  it("defaults are 45min wall / 15min no-progress", () => {
    expect(CYCLE_WALL_TIMEOUT_SEC).toBe(2700);
    expect(CYCLE_NO_PROGRESS_SEC).toBe(900);
  });

  it("not timed out below both limits — reports the tighter remaining budget", () => {
    const v = cycleTimeoutVerdict({ elapsedSec: 100, idleSec: 60, wallLimitSec: 2700, noProgressLimitSec: 900 });
    // wall remaining 2600, idle remaining 840 → tighter is 840.
    expect(v).toEqual({ timedOut: false, remainingSec: 840 });
  });

  it("WALL breach at the boundary (>=) is attributed to wall", () => {
    const v = cycleTimeoutVerdict({ elapsedSec: 2700, idleSec: 10, wallLimitSec: 2700, noProgressLimitSec: 900 });
    expect(v).toEqual({ timedOut: true, reason: "wall", elapsedSec: 2700, idleSec: 10 });
  });

  it("NO-PROGRESS breach (silent hang) when idle exceeds the window but wall is fine", () => {
    const v = cycleTimeoutVerdict({ elapsedSec: 1000, idleSec: 900, wallLimitSec: 2700, noProgressLimitSec: 900 });
    expect(v).toEqual({ timedOut: true, reason: "no-progress", elapsedSec: 1000, idleSec: 900 });
  });

  it("误杀-prevention: a slow-but-progressing call (high elapsed, LOW idle) does NOT trip", () => {
    // 40min into the cycle but progress 30s ago (e.g. a slow deepseek call still
    // emitting stdout) — neither criterion fires.
    const v = cycleTimeoutVerdict({ elapsedSec: 2400, idleSec: 30, wallLimitSec: 2700, noProgressLimitSec: 900 });
    expect(v.timedOut).toBe(false);
  });

  it("WALL wins when BOTH would trip (attribution is wall-first)", () => {
    const v = cycleTimeoutVerdict({ elapsedSec: 3000, idleSec: 1000, wallLimitSec: 2700, noProgressLimitSec: 900 });
    expect(v).toEqual({ timedOut: true, reason: "wall", elapsedSec: 3000, idleSec: 1000 });
  });

  it("a 0 / negative limit DISABLES that criterion (operator escape hatch)", () => {
    // wall disabled → a huge elapsed never trips on wall; idle still guards.
    expect(cycleTimeoutVerdict({ elapsedSec: 1e9, idleSec: 10, wallLimitSec: 0, noProgressLimitSec: 900 }).timedOut).toBe(false);
    // both disabled → never times out.
    expect(cycleTimeoutVerdict({ elapsedSec: 1e9, idleSec: 1e9, wallLimitSec: 0, noProgressLimitSec: 0 }).timedOut).toBe(false);
    // no-progress disabled, idle huge, wall fine → still alive.
    expect(cycleTimeoutVerdict({ elapsedSec: 100, idleSec: 1e9, wallLimitSec: 2700, noProgressLimitSec: -1 }).timedOut).toBe(false);
  });

  it("uses the core defaults when limits are omitted", () => {
    expect(cycleTimeoutVerdict({ elapsedSec: 2700, idleSec: 0 })).toMatchObject({ timedOut: true, reason: "wall" });
    expect(cycleTimeoutVerdict({ elapsedSec: 1000, idleSec: 900 })).toMatchObject({ timedOut: true, reason: "no-progress" });
    expect(cycleTimeoutVerdict({ elapsedSec: 10, idleSec: 10 }).timedOut).toBe(false);
  });
});

describe("FIX-1477 — cycleTimeoutVerdict no-state-change criterion (git-state progress)", () => {
  it("default no-state-change window is 25min (1500s)", () => {
    expect(CYCLE_NO_STATE_CHANGE_SEC).toBe(1500);
  });

  it("NO-STATE-CHANGE breach: stdout keeps the silence fuse reset but git state is frozen past the window (thrash)", () => {
    // The kimi-thrash shape: stdout flowed 5s ago (silence fuse happy), but no
    // commit AND no dirty-state change for the full 1500s window.
    const v = cycleTimeoutVerdict({
      elapsedSec: 1600,
      idleSec: 5,
      stateIdleSec: 1500,
      wallLimitSec: 2700,
      noProgressLimitSec: 900,
      noStateChangeLimitSec: 1500,
    });
    expect(v).toEqual({ timedOut: true, reason: "no-state-change", elapsedSec: 1600, idleSec: 5 });
  });

  it("does NOT trip while git state keeps changing (the pi冤杀 shape frozen as a contract)", () => {
    // Dirty-state signature changed 10s ago; stdout silent for 20min — the
    // watchdog bumps BOTH clocks on a state change, so idleSec stays low too.
    const v = cycleTimeoutVerdict({
      elapsedSec: 1300,
      idleSec: 10,
      stateIdleSec: 10,
      wallLimitSec: 2700,
      noProgressLimitSec: 900,
      noStateChangeLimitSec: 1500,
    });
    expect(v.timedOut).toBe(false);
  });

  it("no-progress still wins when a fully silent hang breaches BOTH idle fuses (attribution unchanged)", () => {
    const v = cycleTimeoutVerdict({
      elapsedSec: 1600,
      idleSec: 1000,
      stateIdleSec: 1600,
      wallLimitSec: 2700,
      noProgressLimitSec: 900,
      noStateChangeLimitSec: 1500,
    });
    expect(v).toMatchObject({ timedOut: true, reason: "no-progress" });
  });

  it("the criterion is skipped when stateIdleSec is not supplied (legacy callers byte-identical)", () => {
    const v = cycleTimeoutVerdict({ elapsedSec: 100, idleSec: 10, wallLimitSec: 2700, noProgressLimitSec: 900 });
    expect(v).toEqual({ timedOut: false, remainingSec: 890 });
  });

  it("a 0 / negative no-state-change limit DISABLES the criterion (operator escape hatch)", () => {
    expect(
      cycleTimeoutVerdict({
        elapsedSec: 100,
        idleSec: 10,
        stateIdleSec: 1e9,
        wallLimitSec: 2700,
        noProgressLimitSec: 900,
        noStateChangeLimitSec: 0,
      }).timedOut,
    ).toBe(false);
  });

  it("the remaining budget folds in the state window when it is the tightest", () => {
    const v = cycleTimeoutVerdict({
      elapsedSec: 100,
      idleSec: 10,
      stateIdleSec: 1400,
      wallLimitSec: 2700,
      noProgressLimitSec: 900,
      noStateChangeLimitSec: 1500,
    });
    // state remaining 100 < idle remaining 890 < wall remaining 2600.
    expect(v).toEqual({ timedOut: false, remainingSec: 100 });
  });
});

describe("FIX-929 — stallVerdict (agent stall detection: soft signal, no kill)", () => {
  it("defaults are 10min threshold / 2min startup grace", () => {
    expect(CYCLE_STALL_THRESHOLD_SEC).toBe(600);
    expect(STALL_STARTUP_GRACE_SEC).toBe(120);
  });

  it("not stalled when idle is below threshold and grace has passed", () => {
    const v = stallVerdict({ elapsedSec: 200, idleSec: 100, stallThresholdSec: 600, startupGraceSec: 120 });
    expect(v).toEqual({ stalled: false });
  });

  it("not stalled when idle exceeds threshold but still in startup grace", () => {
    const v = stallVerdict({ elapsedSec: 100, idleSec: 700, stallThresholdSec: 600, startupGraceSec: 120 });
    expect(v).toEqual({ stalled: false });
  });

  it("stalled: idle exceeds threshold AND grace has elapsed", () => {
    const v = stallVerdict({ elapsedSec: 800, idleSec: 600, stallThresholdSec: 600, startupGraceSec: 120 });
    expect(v).toEqual({ stalled: true, idleSec: 600, thresholdSec: 600 });
  });

  it("agent produces tokens normally → no false positive", () => {
    // Agent is active: elapsed=800, but idle=10 (just emitted output).
    const v = stallVerdict({ elapsedSec: 800, idleSec: 10, stallThresholdSec: 600, startupGraceSec: 120 });
    expect(v).toEqual({ stalled: false });
  });

  it("stall once-fired does not re-trigger (alreadyFired gate)", () => {
    const v = stallVerdict({ elapsedSec: 800, idleSec: 700, stallThresholdSec: 600, startupGraceSec: 120, alreadyFired: true });
    expect(v).toEqual({ stalled: false });
  });

  it("stalled uses defaults when limits omitted", () => {
    const v = stallVerdict({ elapsedSec: 800, idleSec: 600 });
    // 600 >= default 600 threshold; 800 >= default 120 grace → stalled.
    expect(v).toEqual({ stalled: true, idleSec: 600, thresholdSec: 600 });
    // Below default threshold → not stalled.
    const v2 = stallVerdict({ elapsedSec: 800, idleSec: 599 });
    expect(v2).toEqual({ stalled: false });
  });

  it("zero / negative threshold DISABLES stall detection", () => {
    expect(stallVerdict({ elapsedSec: 1e9, idleSec: 1e9, stallThresholdSec: 0, startupGraceSec: 0 }).stalled).toBe(false);
    expect(stallVerdict({ elapsedSec: 1e9, idleSec: 1e9, stallThresholdSec: -1, startupGraceSec: 0 }).stalled).toBe(false);
  });

  it("stall boundary: idle >= threshold at exactly the boundary", () => {
    // Grace elapsed (300 ≥ 120), idle hits threshold exactly (600).
    const v = stallVerdict({ elapsedSec: 300, idleSec: 600, stallThresholdSec: 600, startupGraceSec: 120 });
    expect(v).toEqual({ stalled: true, idleSec: 600, thresholdSec: 600 });
  });

  it("stall with a custom threshold (env override scenario)", () => {
    // Shorter threshold: 5 min (300s).
    const v = stallVerdict({ elapsedSec: 400, idleSec: 300, stallThresholdSec: 300, startupGraceSec: 120 });
    expect(v).toEqual({ stalled: true, idleSec: 300, thresholdSec: 300 });
    // Under custom threshold → not stalled.
    const v2 = stallVerdict({ elapsedSec: 400, idleSec: 299, stallThresholdSec: 300, startupGraceSec: 120 });
    expect(v2).toEqual({ stalled: false });
  });
});

describe("timeout breach mid-execute → clean teardown ORDER", () => {
  it("teardownCommands order: kill → MEASURE worktree → terminal event → run → alert → release lock", () => {
    const cmds = timeoutTeardownCommands({ cycleId: "c1", branch: "loop/cycle-c1", agent: "claude", model: "sonnet" });
    expect(cmds.map((c) => c.kind)).toEqual([
      "kill_agent",
      "measure_worktree",
      "emit_event",
      "append_run",
      "append_alert",
      "release_lock",
    ]);
    // lock release is LAST — terminal record durable before slot frees.
    expect(cmds[cmds.length - 1]?.kind).toBe("release_lock");
    // worktree is PRESERVED (no cleanup command, bin/roll:9122).
    expect(cmds.some((c) => c.kind === "cleanup_worktree")).toBe(false);
  });

  it("agent_exited with timedOut short-circuits to teardown (no retry, bin/roll:9066)", () => {
    let state = initialCycleState(CTX);
    const drive = (ev: CycleEvent): CycleCommand[] => {
      const r = stepWithCapacity(state, ev);
      state = r.state;
      return r.commands;
    };
    drive({ type: "start", ctx: CTX });
    drive({ type: "preflight_done" });
    drive({ type: "worktree_created" });
    drive({ type: "story_picked", storyId: "US-1" });
    drive({ type: "route_resolved", agent: "claude", model: "sonnet" });
    const cmds = drive({ type: "agent_exited", exit: 0, timedOut: true });
    expect(state.terminal).toBe("blocked");
    expect(state.done).toBe(true);
    expect(cmds.map((c) => c.kind)).toEqual([
      "release_capacity",
      "emit_event",
      "kill_agent",
      "measure_worktree",
      "emit_event",
      "append_run",
      "append_alert",
      "release_lock",
    ]);
  });

  // FIX-1474 — the builder child died OUT-OF-BAND (external SIGKILL / PTY
  // leader death / lost exit delivery): NOT a timeout (blocked) and NOT a code
  // failure (retry/failed) — the cycle converges to the explicit `aborted`
  // terminal with a durable cycle:end + runs row, and the lock is released.
  it("FIX-1474 agent_exited with lost:true → aborted terminal teardown (no retry, no blocked)", () => {
    let state = initialCycleState(CTX);
    const drive = (ev: CycleEvent): CycleCommand[] => {
      const r = stepWithCapacity(state, ev);
      state = r.state;
      return r.commands;
    };
    drive({ type: "start", ctx: CTX });
    drive({ type: "preflight_done" });
    drive({ type: "worktree_created" });
    drive({ type: "story_picked", storyId: "US-1" });
    drive({ type: "route_resolved", agent: "claude", model: "sonnet" });
    const cmds = drive({ type: "agent_exited", exit: 137, timedOut: false, lost: true });
    expect(state.terminal).toBe("aborted");
    expect(state.done).toBe(true);
    expect(cmds.map((c) => c.kind)).toEqual([
      "release_capacity",
      "emit_event",
      "kill_agent",
      "measure_worktree",
      "emit_event",
      "append_run",
      "append_alert",
      "release_lock",
    ]);
    // Lock release LAST; the worktree is PRESERVED (no cleanup command).
    expect(cmds[cmds.length - 1]?.kind).toBe("release_lock");
    expect(cmds.some((c) => c.kind === "cleanup_worktree")).toBe(false);
    // The terminal records the aborted outcome — never the timeout's blocked.
    const emit = cmds.find((c) => c.kind === "emit_event" && c.event.type === "cycle:end");
    expect(emit).toMatchObject({ event: { type: "cycle:end", outcome: "aborted_no_delivery" } });
    const run = cmds.find((c) => c.kind === "append_run");
    expect(run).toMatchObject({ status: "aborted", outcome: "aborted_no_delivery" });
  });
});

// ── retry / backoff ──────────────────────────────────────────────────────────

describe("retryPlan — bounded transient retry + backoff (I6, bin/roll:9032-9072)", () => {
  it("exit 0 → accept (break)", () => {
    expect(retryPlan({ attempt: 1, exit: 0, timedOut: false })).toEqual({ action: "accept" });
  });
  it("timed out → abort_timeout (break, no retry)", () => {
    expect(retryPlan({ attempt: 1, exit: 0, timedOut: true })).toEqual({ action: "abort_timeout" });
  });
  it("fail before budget → retry with exponential backoff (NEW v3; base 30s)", () => {
    expect(retryPlan({ attempt: 1, exit: 1, timedOut: false })).toEqual({ action: "retry", nextAttempt: 2, backoffSec: 30 });
    expect(retryPlan({ attempt: 2, exit: 1, timedOut: false })).toEqual({ action: "retry", nextAttempt: 3, backoffSec: 60 });
  });
  it("fail at the retry budget → exhausted (NOT agent-swap, I6)", () => {
    expect(retryPlan({ attempt: MAX_AGENT_ATTEMPTS, exit: 1, timedOut: false })).toEqual({ action: "exhausted" });
  });
  it("backoffSchedule has maxAttempts-1 entries, doubling from base", () => {
    expect(backoffSchedule()).toEqual([RETRY_BASE_BACKOFF_SEC, RETRY_BASE_BACKOFF_SEC * 2]);
    expect(backoffSchedule(4, 10)).toEqual([10, 20, 40]);
  });
});

// ── SIGKILL mid-phase resumability (I2/I8) ───────────────────────────────────

describe("resumability — late/duplicate events are no-ops (I8)", () => {
  it("an event that doesn't apply to the current phase changes nothing", () => {
    let state = initialCycleState(CTX);
    state = cycleStep(state, { type: "start", ctx: CTX }).state;
    // A stray 'published' before the worktree even exists must be a no-op.
    const r = cycleStep(state, { type: "published", result: { status: 0 } });
    expect(r.commands).toEqual([]);
    expect(r.state.phase).toBe(state.phase);
    expect(r.state.done).toBe(false);
  });

  it("re-applying the terminal publish event is idempotent in outcome", () => {
    const evs: CycleEvent[] = [
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-1" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 0 } },
    ];
    const first = walk(evs);
    // Replay the same published event again → same terminal.
    const again = cycleStep(first.state, { type: "published", result: { status: 0 } });
    expect(again.state.terminal).toBe("published");
  });
});

// ── event-sourcing round-trip (I8): serialize → parseEventLine → foldCycle ────

describe("event-sourcing round-trip (I8)", () => {
  /** Serialize RollEvents to ndjson, parse each back via the spec, fold. */
  function roundTrip(events: RollEvent[]) {
    const ndjson = events.map((e) => JSON.stringify(e)).join("\n");
    const parsed: RollEvent[] = [];
    for (const line of ndjson.split("\n")) {
      const ev = parseEventLine(line);
      if (ev !== null) parsed.push(ev);
    }
    return foldCycle(parsed);
  }

  it("rebuilds terminal 'delivered' from a done cycle stream", () => {
    const stream: RollEvent[] = [
      { type: "cycle:start", cycleId: "c1", storyId: "US-1", agent: "claude", model: "sonnet", ts: 1 },
      { type: "cycle:phase", cycleId: "c1", phase: "execute", ts: 2 },
      { type: "cycle:phase", cycleId: "c1", phase: "publish", ts: 3 },
      { type: "cycle:end", cycleId: "c1", outcome: "delivered", cost: { cycleId: "c1", agent: "claude", model: "sonnet", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 }, ts: 4 },
    ];
    const rebuilt = roundTrip(stream);
    expect(rebuilt.ended).toBe(true);
    expect(rebuilt.outcome).toBe("delivered");
    expect(rebuilt.storyId).toBe("US-1");
    expect(rebuilt.phases).toEqual(["execute", "publish"]);
  });

  it("SIGKILL mid-phase: no cycle:end → ended=false (recovery layer heals, I2)", () => {
    const stream: RollEvent[] = [
      { type: "cycle:start", cycleId: "c2", storyId: "FIX-9", agent: "pi", model: "k2", ts: 1 },
      { type: "cycle:phase", cycleId: "c2", phase: "execute", ts: 2 },
      // process SIGKILLed here — no cycle:end ever written.
    ];
    const rebuilt = roundTrip(stream);
    expect(rebuilt.ended).toBe(false);
    expect(rebuilt.outcome).toBeUndefined();
    expect(rebuilt.cycleId).toBe("c2");
  });

  it("the LAST cycle:end wins (idempotent re-emission)", () => {
    const stream: RollEvent[] = [
      { type: "cycle:start", cycleId: "c3", storyId: "US-3", agent: "claude", model: "sonnet", ts: 1 },
      { type: "cycle:end", cycleId: "c3", outcome: "failed", cost: { cycleId: "c3", agent: "claude", model: "sonnet", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 }, ts: 2 },
      { type: "cycle:end", cycleId: "c3", outcome: "delivered", cost: { cycleId: "c3", agent: "claude", model: "sonnet", tokensIn: 0, tokensOut: 0, estimatedCost: 0, revertCount: 0, effectiveCost: 0 }, ts: 3 },
    ];
    expect(roundTrip(stream).outcome).toBe("delivered");
  });

  it("a simulated cycle walk's emitted cycle:end folds back to the same outcome", () => {
    // Run the stepper, harvest its emit_event commands, round-trip them.
    const { commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "US-7" },
      { type: "route_resolved", agent: "claude", model: "sonnet" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 1 } },
      { type: "published", result: { status: 0 } },
    ]);
    const emitted = commands.filter((c): c is Extract<CycleCommand, { kind: "emit_event" }> => c.kind === "emit_event").map((c) => c.event);
    const rebuilt = roundTrip(emitted);
    expect(rebuilt.ended).toBe(true);
    expect(rebuilt.outcome).toBe("published_pending_merge");
  });
});

// ── FIX-1068 — Builder finalization hard gate (adapter-agnostic) ───────────────

describe("FIX-1068 — finalizeBuilder verdict mapping", () => {
  const base: BuilderFinalizationFacts = {
    storyId: "FIX-1063",
    cycleId: "20260701-165024-67168",
    agent: "reasonix",
    worktreePath: ".roll/loop/worktrees/cycle-20260701-165024-67168",
    expectedProjectPath: "",
    processExited: true,
    exitCode: 0,
    commitsAhead: 0,
    tcrCount: 0,
    worktreeDirty: false,
    mainCheckoutDirty: false,
    prUrl: null,
    attestReportPath: null,
    recentActivity: false,
  };

  it("Reasonix-style: dirty worktree + zero TCR + no PR → handoff_without_tcr", () => {
    const verdict = finalizeBuilder({ ...base, worktreeDirty: true });
    expect(verdict).toBe("handoff_without_tcr");
    expect(handoffKindFor(verdict)).toBe("zero_tcr_dirty_worktree");
  });

  it("committed prefix plus dirty suffix is a recoverable handoff, not publish-ready", () => {
    expect(finalizeBuilder({ ...base, commitsAhead: 1, tcrCount: 1, worktreeDirty: true })).toBe("handoff_without_tcr");
  });

  it("Pi-style: main checkout dirty → boundary_violation", () => {
    const verdict = finalizeBuilder({ ...base, mainCheckoutDirty: true });
    expect(verdict).toBe("boundary_violation");
  });

  it("FIX-1069: main checkout ahead origin → boundary_violation even when clean", () => {
    const verdict = finalizeBuilder({ ...base, mainAhead: 1 });
    expect(verdict).toBe("boundary_violation");
  });

  it("Kimi-style: still running + recent activity → no_progress_still_running", () => {
    const verdict = finalizeBuilder({ ...base, processExited: false, recentActivity: true });
    expect(verdict).toBe("no_progress_still_running");
  });

  it("clean exit + no work → gave_up_clean", () => {
    expect(finalizeBuilder(base)).toBe("gave_up_clean");
  });

  it("TCR commit present → ready_for_peer_and_attest", () => {
    expect(finalizeBuilder({ ...base, tcrCount: 1 })).toBe("ready_for_peer_and_attest");
  });
});

describe("FIX-1068 — facts_captured emits builder finalization event", () => {
  it("handoff_without_tcr emits builder:handoff_required and preserves worktree", () => {
    const { state, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-1063" },
      { type: "route_resolved", agent: "reasonix", model: "deepseek-v4-pro" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0, worktreeDirty: true } },
    ]);
    expect(state.terminal).toBe("handoff_without_tcr");
    const handoff = commands.find((c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
      c.kind === "emit_event" && c.event.type === "builder:handoff_required"
    );
    expect(handoff).toBeDefined();
    expect(handoff?.event).toMatchObject({
      type: "builder:handoff_required",
      storyId: "FIX-1063",
      agent: "reasonix",
      kind: "zero_tcr_dirty_worktree",
      worktreePath: `.roll/loop/worktrees/cycle-${CTX.cycleId}`,
    });
  });

  it("main checkout dirty emits builder:boundary_violation and fails", () => {
    const { state, commands } = walk([
      { type: "start", ctx: CTX },
      { type: "preflight_done" },
      { type: "worktree_created" },
      { type: "story_picked", storyId: "FIX-1063" },
      { type: "route_resolved", agent: "pi", model: "k2" },
      { type: "agent_exited", exit: 0, timedOut: false },
      { type: "facts_captured", facts: { usedWorktree: true, agentExit: 0, timedOut: false, commitsAhead: 0, mainDirty: true, mainDirtyFiles: ["skills/README.md", "product.ts"] } },
    ]);
    expect(state.terminal).toBe("failed");
    const violation = commands.find((c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
      c.kind === "emit_event" && c.event.type === "builder:boundary_violation"
    );
    expect(violation).toBeDefined();
    expect(violation?.event).toMatchObject({
      type: "builder:boundary_violation",
      storyId: "FIX-1063",
      agent: "pi",
      kind: "main_checkout_dirty",
    });
    // FIX-1218: verify the actual dirty file list is carried (not hardcoded [])
    if (violation?.event.type === "builder:boundary_violation") {
      expect(violation.event.files).toEqual(["skills/README.md", "product.ts"]);
    }
  });
});

describe("US-LOOP-102 — adversarial-pairing subsequence (verified/designed)", () => {
  const PLAN = {
    testAuthor: "claude" as const,
    implementer: "codex" as const,
    maxRounds: 4,
    dryRoundsToStop: 2,
    totalTimeoutSec: 2700,
  };

  /** A compact label for a spawn_role command: `<role>@<round>`. */
  const roleLabel = (c: CycleCommand): string =>
    c.kind === "spawn_role" ? `${c.role}@${c.round}` : c.kind;

  /** Emitted RollEvent types in order (via emit_event commands). */
  const emittedEvents = (commands: CycleCommand[]): string[] =>
    commands
      .filter((c): c is Extract<CycleCommand, { kind: "emit_event" }> => c.kind === "emit_event")
      .map((c) => c.event.type)
      .filter((type) => !type.startsWith("workspace:capacity_"));

  /** Drive to the point where the adversarial subsequence begins (execute). */
  const upToExecute: CycleEvent[] = [
    { type: "start", ctx: CTX },
    { type: "preflight_done" },
    { type: "worktree_created" },
    { type: "story_picked", storyId: "US-EXAMPLE-001" },
    { type: "route_resolved", agent: "codex", model: "", adversarial: PLAN },
  ];

  it("reproduces the design §5 worked sample: red→green→attack(hole)→fix→attack×2→terminated(dry)", () => {
    // The full adversarial cycle from the design doc §5.
    const events: CycleEvent[] = [
      ...upToExecute,
      // t2: test_author wrote red tests.
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false, elapsedSec: 60 },
      // t3: implementer turned them green (initial impl).
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false, elapsedSec: 120 },
      // t5: attacker round 1 broke a hole open.
      { type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: true, attackTest: "test/attack-empty.test.ts", elapsedSec: 200 },
      // t7: implementer fixed it.
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false, elapsedSec: 260 },
      // t9: attacker round 2 found nothing (dry 1).
      { type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: false, elapsedSec: 320 },
      // t11: attacker round 3 found nothing (dry 2 → stop).
      { type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: false, elapsedSec: 380 },
    ];
    const { state, commands } = walk(events);

    // The spawn_role sequence matches §5 exactly (round numbers included).
    const roleSeq = commands.filter((c) => c.kind === "spawn_role").map(roleLabel);
    expect(roleSeq).toEqual([
      "test_author@0",
      "implementer@0",
      "attacker@1",
      "implementer@1", // fix (same round as the attack that found the hole)
      "attacker@2",
      "attacker@3",
    ]);

    // Standard build path was NEVER taken — no single spawn_agent.
    expect(commands.some((c) => c.kind === "spawn_agent")).toBe(false);

    // The adversarial event stream, in order.
    expect(emittedEvents(commands)).toEqual([
      "cycle:start",
      "adversarial:test-authored",
      "adversarial:implemented", // emitted ONCE (initial impl, not the fix)
      "adversarial:attack-round", // round 1, hole
      "adversarial:attack-round", // round 2, dry
      "adversarial:attack-round", // round 3, dry
      "adversarial:terminated",
    ]);

    // The subsequence stopped on a dry streak, having found exactly one hole, and
    // handed off to the normal capture/publish path.
    const terminated = commands.find(
      (c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:terminated",
    );
    expect(terminated?.event).toMatchObject({ type: "adversarial:terminated", reason: "dry", rounds: 3, holesFound: 1 });
    expect(commands.some((c) => c.kind === "capture_facts")).toBe(true);
    expect(state.phase).toBe("reconcile");
    // The attacker's breaking test was collected for the Phase 6 Agent-4 audit.
    expect(state.adversarial?.attackTests).toEqual(["test/attack-empty.test.ts"]);
    expect(state.adversarial?.holesFound).toBe(1);
  });

  it("attack-round events report the running dry streak (0 on a hole, then 1, 2)", () => {
    const { commands } = walk([
      ...upToExecute,
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false },
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false },
      { type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: true, attackTest: "a.test.ts" },
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false },
      { type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: false },
      { type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: false },
    ]);
    const rounds = commands
      .filter((c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:attack-round",
      )
      .map((c) => (c.event.type === "adversarial:attack-round" ? { round: c.event.round, newHole: c.event.newHole, dryStreak: c.event.dryStreak } : null));
    expect(rounds).toEqual([
      { round: 1, newHole: true, dryStreak: 0 },
      { round: 2, newHole: false, dryStreak: 1 },
      { round: 3, newHole: false, dryStreak: 2 },
    ]);
  });

  it("terminates on max_rounds when the attacker keeps finding holes (never hangs)", () => {
    // Every attacker round finds a hole → the dry-streak stop never fires; the
    // maxRounds cap (4) is the backstop.
    const holeRounds: CycleEvent[] = [];
    for (let i = 0; i < 6; i++) {
      holeRounds.push({ type: "role_exited", role: "attacker", exit: 0, timedOut: false, newHole: true, attackTest: `a${i}.test.ts` });
      holeRounds.push({ type: "role_exited", role: "implementer", exit: 0, timedOut: false });
    }
    const { commands, state } = walk([
      ...upToExecute,
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false },
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false },
      ...holeRounds,
    ]);
    const terminated = commands.find(
      (c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:terminated",
    );
    expect(terminated?.event).toMatchObject({ type: "adversarial:terminated", reason: "max_rounds" });
    expect(state.phase).toBe("reconcile");
    // The cap is EXACT: attackers spawn for rounds 1..maxRounds and no further,
    // and the terminated event reports exactly maxRounds rounds (no off-by-one).
    const attackerRounds = commands
      .filter((c) => c.kind === "spawn_role" && c.role === "attacker")
      .map((c) => (c.kind === "spawn_role" ? c.round : -1));
    expect(attackerRounds).toEqual([1, 2, 3, 4]);
    expect(terminated?.event).toMatchObject({ rounds: 4 });
    // Every hole round appended to attackTests (append, never overwrite): 4 rounds,
    // each found a hole, so all 4 breaking tests are collected for Agent-4.
    expect(state.adversarial?.attackTests).toEqual(["a0.test.ts", "a1.test.ts", "a2.test.ts", "a3.test.ts"]);
    expect(state.adversarial?.holesFound).toBe(4);
  });

  it("terminates on total timeout regardless of round/dry state", () => {
    const { commands } = walk([
      ...upToExecute,
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false },
      // Implementer green, but the elapsed clock already blew the total budget.
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false, elapsedSec: 3000 },
    ]);
    const terminated = commands.find(
      (c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:terminated",
    );
    expect(terminated?.event).toMatchObject({ type: "adversarial:terminated", reason: "timeout" });
    expect(commands.some((c) => c.kind === "spawn_role" && c.role === "attacker")).toBe(false);
  });

  it("US-LOOP-106: a failed role spawn degrades to a standard builder (never deadlocks, never silent)", () => {
    const { commands, state } = walk([
      ...upToExecute,
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false },
      { type: "role_exited", role: "implementer", exit: 1, timedOut: false },
    ]);
    // §7: agent_unavailable → adversarial:degraded + standard single builder.
    const degraded = commands.find(
      (c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:degraded",
    );
    // The failure kind is classified: a non-zero role exit → agent_unavailable
    // (NOT round_hang) — the cause proves the correct AdversarialFailure wiring.
    expect(degraded?.event).toMatchObject({ type: "adversarial:degraded", from: "adversarial", to: "single-builder" });
    expect(degraded?.event.type === "adversarial:degraded" && degraded.event.cause).toMatch(/agent unavailable/);
    expect(commands.some((c) => c.kind === "spawn_agent")).toBe(true);
    // Adversarial runtime cleared so role events stop; phase stays execute for the builder.
    expect(state.adversarial).toBeUndefined();
    expect(state.phase).toBe("execute");
    // No further role spawn after the failure.
    expect(commands.filter((c) => c.kind === "spawn_role").map(roleLabel)).toEqual(["test_author@0", "implementer@0"]);
  });

  it("US-LOOP-106: a timed-out round degrades (round_hang → single builder)", () => {
    const { commands, state } = walk([
      ...upToExecute,
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false },
      { type: "role_exited", role: "implementer", exit: 0, timedOut: false },
      { type: "role_exited", role: "attacker", exit: 0, timedOut: true },
    ]);
    const degraded = commands.find(
      (c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:degraded",
    );
    expect(degraded?.event).toMatchObject({ type: "adversarial:degraded", to: "single-builder" });
    // A timed-out round → round_hang (NOT agent_unavailable) — distinct classification.
    expect(degraded?.event.type === "adversarial:degraded" && degraded.event.cause).toMatch(/round .* hung/);
    expect(commands.some((c) => c.kind === "spawn_agent")).toBe(true);
    expect(state.adversarial).toBeUndefined();
  });

  it("US-LOOP-106: after degrade the standard builder completes normally (no role events, → capture)", () => {
    const { commands, state } = walk([
      ...upToExecute,
      { type: "role_exited", role: "test_author", exit: 0, timedOut: false },
      { type: "role_exited", role: "implementer", exit: 1, timedOut: false }, // degrade → spawn_agent
      { type: "agent_exited", exit: 0, timedOut: false }, // standard builder finished
    ]);
    // The degraded builder's clean exit flows into the normal capture path.
    expect(commands.some((c) => c.kind === "capture_facts")).toBe(true);
    expect(state.phase).toBe("reconcile");
  });

  it("US-LOOP-106: route_resolved with a non-hetero downgrade emits degraded + standard builder (no role spawn)", () => {
    const { commands } = walk([
      ...upToExecute.slice(0, 4),
      { type: "route_resolved", agent: "pi", model: "", adversarialDegraded: { cause: "non-hetero: only pi available" } },
    ]);
    expect(emittedEvents(commands)).toEqual(["cycle:start", "adversarial:degraded"]);
    expect(commands.some((c) => c.kind === "spawn_agent")).toBe(true);
    expect(commands.some((c) => c.kind === "spawn_role")).toBe(false);
    const degraded = commands.find(
      (c): c is Extract<CycleCommand, { kind: "emit_event" }> =>
        c.kind === "emit_event" && c.event.type === "adversarial:degraded",
    );
    expect(degraded?.event).toMatchObject({ cause: "non-hetero: only pi available", to: "single-builder" });
  });

  it("standard profile (no adversarial plan) is UNCHANGED — single spawn_agent, no role commands", () => {
    const { commands } = walk([
      ...upToExecute.slice(0, 4),
      { type: "route_resolved", agent: "pi", model: "" }, // no adversarial field
    ]);
    expect(commands.some((c) => c.kind === "spawn_agent")).toBe(true);
    expect(commands.some((c) => c.kind === "spawn_role")).toBe(false);
    expect(emittedEvents(commands)).toEqual(["cycle:start"]);
  });
});
