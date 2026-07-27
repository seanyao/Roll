import type { CycleContext, CycleEvent, IssueInitOutcome, ObservedCommit, OpenPrReferenceInput, PendingCapacitySpawn, RouteDeps, RunKey } from "@roll/core";
import type {
  AgentCapacityAcquireResult,
  AgentCapacityOwnershipResult,
  CycleRepositoryExecutionContext,
  RepositoryExecutionContext,
  RepositoryExecutionEvent,
  RepositoryExecutionEventPayload,
  IssueExecutionEvent,
  IssueExecutionEventPayload,
  RollEvent,
  WorkspaceIssueInitFailureCode,
} from "@roll/spec";
import type { ContextStageHostPort } from "./context-stage-host.js";
import type { CaptureMarker, Clock, ScreenshotResult } from "@roll/infra";
import type { AgentSpawn } from "./agent-spawn.js";
import type { ReachResult } from "./agent-liveness.js";

/** The injectable wall clock (epoch seconds) — infra's {@link Clock}. */
export type ProcessClock = Clock;

/**
 * Git operations the executor needs — a thin facet of @roll/infra's git module
 * so tests can fake worktree create/cleanup, push, and the rev-list count behind
 * an in-memory double without spawning git.
 */
export interface GitPort {
  /** FIX-209: `_worktree_fetch_origin` — refresh `origin/<branch>` before the
   *  cycle branches its worktree off it, so a just-merged PR is visible locally.
   *  LENIENT: never throws; `fetched:false` on a network blip / missing remote
   *  so the cycle proceeds on the (stale) baseline rather than toppling. */
  fetchOrigin(repoCwd: string, branch: string): Promise<{ fetched: boolean }>;
  /** `_worktree_create` — STRICT add (exit code propagated). */
  worktreeAdd(repoCwd: string, path: string, branch: string, base: string): Promise<{ code: number }>;
  /** E2: create the cycle worktree ON a git SUBMODULE of the superproject
   *  (`git -C <super>/<sub> worktree add --detach <cycleWorktreePath>/<sub> <base>`)
   *  so it shares the submodule's object store/refs. Validates the submodule is
   *  declared in `.gitmodules` and initialized; STRICT — a non-zero `code` (with
   *  a diagnostic `stderr`) fails the worktree setup honestly rather than falling
   *  back to the superproject. Used only when the picked story has a
   *  target_submodule; non-submodule stories never call it. */
  worktreeAddInSubmodule(
    superprojectCwd: string,
    submoduleName: string,
    cycleWorktreePath: string,
    base: string,
  ): Promise<{ code: number; stderr: string }>;
  /** E5: tolerant teardown of the SIBLING submodule cycle worktree created by
   *  worktreeAddInSubmodule. Runs `git -C <super>/<sub> worktree remove --force
   *  <submoduleWorktreePath>` + `worktree prune` + rm the dir. Best-effort —
   *  always code 0, so a cleanup blip never topples the cycle's terminal path.
   *  Called only when the cycle has a target_submodule; superproject-only cycles
   *  never invoke it. */
  worktreeRemoveInSubmodule(
    superprojectCwd: string,
    submoduleName: string,
    submoduleWorktreePath: string,
  ): Promise<{ code: number }>;
  /** FIX-302: `_worktree_submodule_init` — `git submodule update --init
   *  --recursive` in the worktree. A fresh git worktree carries NO submodule
   *  contents (notably `skills/` is empty), so the full test can never run.
   *  STRICT: exit code propagated so the runner can fail the setup honestly. */
  worktreeSubmoduleInit(worktreePath: string): Promise<{ code: number }>;
  /** `_worktree_cleanup` — tolerant remove (always code 0). */
  worktreeRemove(repoCwd: string, path: string, branch: string, bundleUnpushed?: boolean): Promise<{ code: number }>;
  /** `git push origin <branch>` (orphan push safety net). */
  push(repoCwd: string, branch: string): Promise<{ code: number }>;
  /** `git rev-list --count <baseRef>..HEAD` in the worktree → commits ahead.
   *  E8: `baseRef` defaults to `origin/main` (byte-identical to the historical
   *  hardcode). A submodule cycle passes the SUBMODULE's integration branch
   *  ({@link resolveIntegrationBranch}(execRepoCwd)) — a submodule has no
   *  `origin/main`, so the hardcode fataled → false zero. */
  commitsAhead(worktreeCwd: string, baseRef?: string): Promise<number>;
  /** FIX-1477: `git status --porcelain` output in the worktree — the dirty-state
   *  fingerprint the spawn timeout watchdog diffs tick-over-tick (a CHANGE is
   *  git-state progress, agent-agnostic). Raw output, no hashing; THROWS on a
   *  git error so the watchdog treats the blip as neither progress nor a kill.
   *  Optional: ports without it run the state fuse on commits only. */
  worktreeStatusSignature?(worktreeCwd: string): Promise<string>;
  /** FIX-252: `git rev-list --count origin/main..main` in the main checkout. */
  mainAhead(repoCwd: string): Promise<number>;
  /** FIX-903: save the current main HEAD to a quarantine bundle
   *  (`rescue/leaked-<cycleId>.bundle`) for audit. FIX-1475: NEVER resets the
   *  shared main ref — the commits stay in place and recovery is manual.
   *  Returns the rescued SHA and exit code. */
  rescueLeaked(repoCwd: string, refName: string): Promise<{ code: number; rescuedSha: string }>;
  /** FIX-208: count `tcr:` commits ahead of the integration branch (v2口径:
   *  `git log --oneline <baseRef>..HEAD | grep -c ' tcr:'`) in the worktree.
   *  E8: `baseRef` defaults to `origin/main` (byte-identical to the historical
   *  hardcode); a submodule cycle passes the submodule's integration branch.
   *  FIX-1244: `undefined` = could NOT determine (git error / missing ref) —
   *  callers must not collapse unknown into 0 (a false zero orphans real work). */
  tcrCount(worktreeCwd: string, baseRef?: string): Promise<number | undefined>;
  /** US-LOOP-076: the runner's OWN observation of commits on the cycle branch —
   *  `git log --format=%H%x09%ct%x09%s <baseRef>..HEAD` (oldest-first) in the
   *  worktree. Feeds the agent-agnostic cycle observer so the build/TCR phase
   *  emits standard signals for EVERY agent, never by parsing agent stdout.
   *  E8: `baseRef` defaults to `origin/main`; a submodule cycle passes the
   *  submodule's integration branch (else the observer sees zero commits and
   *  emits no cycle:tcr events).
   *  LENIENT: returns [] on any git error (observation must never fail a cycle). */
  recentCommits(worktreeCwd: string, baseRef?: string): Promise<ObservedCommit[]>;
  /** RESUME-PRIOR-WORK: fetch a candidate prior-cycle branch from origin so its
   *  ref resolves locally. LENIENT — `fetched:false` on a missing branch. */
  fetchRemoteBranch(repoCwd: string, branch: string): Promise<{ fetched: boolean }>;
  /** RESUME-PRIOR-WORK condition (a): is `origin/<branch>` already merged into
   *  the integration branch? A merged branch has nothing to resume.
   *  `integrationBranch` defaults to origin/main (E1). */
  branchMergedIntoMain(repoCwd: string, branch: string, integrationBranch?: string): Promise<boolean>;
  /** RESUME-PRIOR-WORK condition (b): does `origin/<branch>` cleanly merge with
   *  the integration branch (no conflicts)? Non-mutating `merge-tree` dry-run.
   *  `integrationBranch` defaults to origin/main (E1). */
  branchCleanlyRebasesOntoMain(repoCwd: string, branch: string, integrationBranch?: string): Promise<boolean>;
  /** RESUME-PRIOR-WORK re-point: fetch `<branch>` into the worktree and
   *  `git reset --hard <ref>` so the worktree's tracked tree moves onto the
   *  resume branch (called AFTER the story is picked — see `resume_worktree`).
   *  `code !== 0` ⇒ the re-point failed; the caller leaves the worktree on
   *  origin/main rather than topple the cycle. */
  resetWorktreeHard(worktreeCwd: string, ref: string, branch?: string): Promise<{ code: number }>;
  /** E3: land the cycle worktree HEAD onto the LOCAL integration branch (no
   *  push / PR / CI) — the `publish_mode: local` primitive. `integrationBranch`
   *  defaults to origin/main; its `origin/` prefix is stripped to a local branch.
   *  Returns the landing SHA, the branch landed on, how the ref moved, and a
   *  non-zero `code` on failure (ref left unmoved). */
  landLocalDelivery(
    repoCwd: string,
    worktreeCwd: string,
    integrationBranch?: string,
  ): Promise<{ code: number; sha: string; landedBranch: string; method: "created" | "fast_forward" | "merge"; stderr: string }>;
}

/** GitHub facet — the publish-plan executor + slug resolution. */
export interface GithubPort {
  /** Resolve `owner/repo` from the repo's origin remote (undefined ⇒ no gh). */
  repoSlug(repoCwd: string): Promise<string | undefined>;
  /** Execute a publish PLAN (core planPublishPr/DocPr) → publish status. */
  runPublishPlan(
    plan: ReadonlyArray<{ kind: string; tool: "git" | "gh"; argv: string[] }>,
  ): Promise<{ status: 0 | 1 | 2; prUrl: string; ok: boolean; degraded?: boolean; rootCauseKey?: string }>;
  /** Poll a PR's merge state (sync merge-wait). Returns the gh state string. */
  prState(repoCwd: string, branch: string): Promise<string>;
  /** Poll a PR's full merge info (state, mergedAt, mergeCommit). Returns undefined on gh failure. */
  prMergeInfo(repoCwd: string, branch: string): Promise<{ state: string; mergedAt?: string; mergeCommit?: string } | undefined>;
  /** Fetch open PR references for picker de-duplication. Returns [] on gh failure / no open PRs. */
  openPrTitles(repoCwd: string): Promise<OpenPrReferenceInput[]>;
}

/** Low-level Node adapters receive the resolved repository context. Public
 * runner ports below accept only repoId, so cwd/path strings can never become a
 * competing repository identity. */
export interface RepositoryPortAdapters {
  readonly git: {
    commitsAhead(repository: RepositoryExecutionContext): Promise<number>;
    tcrCount(repository: RepositoryExecutionContext): Promise<number>;
    recentCommits(repository: RepositoryExecutionContext): Promise<ObservedCommit[]>;
    dirty(repository: RepositoryExecutionContext): Promise<boolean>;
    headSha?(repository: RepositoryExecutionContext): Promise<string>;
    push(repository: RepositoryExecutionContext, branch: string): Promise<{ code: number }>;
  };
  readonly verification?: {
    runRepository(
      repository: RepositoryExecutionContext,
      command: readonly string[],
      env: Readonly<Record<string, string>>,
    ): Promise<RepositoryCommandResult>;
    runIntegration(
      execution: CycleRepositoryExecutionContext,
      cwdRepoId: string,
      command: readonly string[],
      env: Readonly<Record<string, string>>,
    ): Promise<RepositoryCommandResult>;
  };
  readonly provider: {
    repoSlug(repository: RepositoryExecutionContext): Promise<string | undefined>;
    prState(repository: RepositoryExecutionContext, branch: string): Promise<string>;
    prMergeInfo(
      repository: RepositoryExecutionContext,
      branch: string,
    ): Promise<{ state: string; mergedAt?: string; mergeCommit?: string } | undefined>;
  };
}

export interface RepositoryCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BoundRepositoryPorts {
  readonly context: (repoId: string) => RepositoryExecutionContext;
  readonly git: {
    commitsAhead(repoId: string): Promise<number>;
    tcrCount(repoId: string): Promise<number>;
    recentCommits(repoId: string): Promise<ObservedCommit[]>;
    dirty(repoId: string): Promise<boolean>;
    headSha(repoId: string): Promise<string>;
    push(repoId: string, branch: string): Promise<{ code: number }>;
  };
  readonly verification: {
    runRepository(
      repoId: string,
      command: readonly string[],
      env?: Readonly<Record<string, string>>,
    ): Promise<RepositoryCommandResult>;
    runIntegration(
      cwdRepoId: string,
      command: readonly string[],
      env?: Readonly<Record<string, string>>,
    ): Promise<RepositoryCommandResult>;
  };
  readonly provider: {
    repoSlug(repoId: string): Promise<string | undefined>;
    prState(repoId: string, branch: string): Promise<string>;
    prMergeInfo(
      repoId: string,
      branch: string,
    ): Promise<{ state: string; mergedAt?: string; mergeCommit?: string } | undefined>;
  };
  readonly events: {
    append(repoId: string, payload: RepositoryExecutionEventPayload): RepositoryExecutionEvent;
    appendIssue(payload: IssueExecutionEventPayload): IssueExecutionEvent;
  };
}

export interface RepositoryPorts {
  prepare(request: {
    readonly storyId: string;
    readonly cycleId: string;
  }): Promise<
    | { readonly kind: "prepared"; readonly outcome: IssueInitOutcome }
    | {
        readonly kind: "failed";
        readonly code: WorkspaceIssueInitFailureCode;
        readonly repairJournal: string | null;
      }
  >;
  resolve(storyId: string): Promise<CycleRepositoryExecutionContext | undefined>;
  bind(ctx: CycleContext): BoundRepositoryPorts;
}

/** Process facet — lock + heartbeat (infra/process.ts). */
export interface ProcessPort {
  acquireLock(
    lockPath: string,
    opts?: { staleSec?: number; cycleId?: string },
  ): { acquired: boolean; heldByPid: number | undefined };
  releaseLock(lockPath: string): void;
  writeHeartbeat(path: string): void;
}

/** Events facet — append + upsert (events/bus.ts). */
export interface EventsPort {
  ensureEventFiles(eventsPath: string, runsPath: string): void;
  appendEvent(eventsPath: string, event: RollEvent): void;
  upsertRun(runsPath: string, key: RunKey, row: Record<string, unknown>): void;
  appendAlert(alertsPath: string, message: string): void;
}

/** Backlog facet — read the project backlog and pick a story (picker.ts). */
export interface BacklogPort {
  /** Read backlog rows from the worktree's `.roll/backlog.md`. */
  read(worktreeCwd: string): { id: string; desc: string; status: string }[];
  /** Mark a story id to a status (e.g. 🔨 In Progress) in the worktree backlog. */
  /**
   * Flip a story row's status in the MAIN project's backlog (`<projectCwd>/
   * .roll/backlog.md`). FIX-198: state lives in the main checkout — ordinary
   * projects gitignore `.roll/` so a cycle worktree carries NO copy at all;
   * any worktree-anchored write lands in the void (the owner-observed "stuck
   * red" / "never Done" pair). For roll itself the main checkout's `.roll` IS
   * the nested meta repo — same path, both layouts correct.
   */
  markStatus?(projectCwd: string, id: string, status: string): void;
}

/** Outcome of a runner-side `.roll` metadata commit. */
export interface MetadataCommitResult {
  /** A commit was created (there were staged changes). */
  committed: boolean;
  /** The commit (if any) was pushed to the metadata remote. */
  pushed: boolean;
  /** The `.roll` working tree was clean — nothing to commit (clean no-op). */
  nothingToCommit: boolean;
  /** A human-readable failure reason when a commit or push did not succeed. */
  error?: string;
}

/**
 * Metadata facet (FIX-306) — commit + push the project's `.roll` metadata repo.
 *
 * Why the RUNNER owns this, never the agent: the loop's worktree agent writes
 * `.roll` FILES (acceptance reports, evidence, ac-map, backlog marks) into the
 * symlinked `.roll`, but the GIT commit of that nested repo must be the runner's
 * job. A sandboxed agent (codex runs under `--sandbox workspace-write` with the
 * `.roll` dir passed via `--add-dir`) can write those files yet CANNOT
 * `git -C .roll commit`: the `.roll` repo's git-internal dir
 * (`.git/worktrees/roll-meta-v3/index.lock`) lives OUTSIDE the sandbox writable
 * roots, so `git add -A` fails and the cycle ends `failed` (meta-commit-blocked).
 * The runner runs unsandboxed with full FS access, so it commits uniformly for
 * EVERY agent — no per-agent special-casing (roll's normalize-agents thesis).
 */
export interface MetadataPort {
  /** Stage, commit, and push `<projectCwd>/.roll`. No-op cleanly when clean;
   *  reports a failure reason (never a silent false-success) on push failure. */
  commit(projectCwd: string, message: string): Promise<MetadataCommitResult>;
}

/** Routing facet — resolve tier→agent for a story (router.ts). */
export interface RoutePort {
  resolve(
    storyId: string,
    estMin: number | undefined,
  ): {
    agent: string;
    model: string;
    /** FIX-1267 — Builders excluded by the no-consecutive-repeat rotation (the
     *  previous cycle's builder). Absent/empty when the rotation is off or there
     *  is no prior builder. The handler filters the availability fallback against
     *  these and emits the `builder:rotation` audit event. */
    excluded?: readonly string[];
    /** FIX-1267 — set when the rotation could NOT be satisfied: only the
     *  previous builder was available in the pool. `agent`/`model` are empty; the
     *  handler fails loud (ALERT + route_pending) instead of repeating it. */
    rotationBlocked?: { previous: string };
  };
}

/** Evidence frame facet — opens the canonical per-cycle evidence directory for
 * either a legacy project card or a Workspace Issue. */
export interface EvidencePort {
  openFrame(projectCwd: string, storyId: string, runId: string): string;
}

/** Screenshot marker facet — executes agent-emitted capture requests. */
export interface CapturePort {
  fromMarker(marker: CaptureMarker, runDir: string): Promise<ScreenshotResult>;
}

/** Acceptance evidence facet — renders the final report into a run frame. */
export interface AttestPort {
  render(projectCwd: string, storyId: string, runDir: string): Promise<number>;
}

export interface AgentCapacityPort {
  readonly heartbeatIntervalMs: number;
  acquire(pending: PendingCapacitySpawn, ctx: CycleContext): AgentCapacityAcquireResult;
  heartbeat(leaseId: string, ownerToken: string): AgentCapacityOwnershipResult;
  release(leaseId: string, ownerToken: string): AgentCapacityOwnershipResult;
  releaseCurrent(cycleId: string): AgentCapacityOwnershipResult;
}

export type DepsExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<unknown>;

/**
 * The full injectable Ports bundle. The runtime wiring ({@link nodePorts})
 * binds these to the real infra; tests pass fakes for every facet so NO real
 * network / agent / PR side effects occur (PATH shims + file:// remotes only).
 */
export interface Ports {
  git: GitPort;
  github: GithubPort;
  /** Workspace repository operations, keyed only by stable repoId. Absent for
   * pre-Workspace runner construction; never synthesized from repoCwd. */
  repositories?: RepositoryPorts;
  process: ProcessPort;
  capacity: AgentCapacityPort;
  events: EventsPort;
  backlog: BacklogPort;
  /** FIX-306: the runner-owned `.roll` metadata commit (never the sandboxed agent). */
  metadata: MetadataPort;
  route: RoutePort;
  evidence: EvidencePort;
  capture: CapturePort;
  attest: AttestPort;
  agentSpawn: AgentSpawn;
  /** Context-enabled Workspaces restore an exact Story Snapshot here before a
   * consuming agent stage starts. Absence means Context is disabled. */
  contextStage?: ContextStageHostPort;
  /** Test seam for credential readiness checks; production uses process.env. */
  agentCredentialEnv?: NodeJS.ProcessEnv;
  /** Test seam for agent profile dotfile readers; production uses the OS home dir. */
  agentEnvHome?: string;
  /** FIX-363: connectivity/auth probe for a reviewer agent. Used ONLY on the
   *  review-failure path (a silent timeout with no block signature) to tell a
   *  BLOCKED agent (not logged in / network down) from a SLOW one, so the loop
   *  acts on the real cause instead of burning the budget on a doomed call.
   *  Optional + injectable: unset (the test default) → no probe, no spawn, the
   *  pre-FIX-363 behaviour; {@link nodePorts} wires the real {@link probeAgentReachable}. */
  agentReachable?: (agent: string) => Promise<ReachResult>;
  /** Canonical installed agents — the heterogeneous-peer pool for the peer-gate
   *  retry (FIX-293) and the opt-in pairing stages. Injectable so tests can pin
   *  a deterministic peer pool; defaults to {@link agentsInstalled} over the real
   *  environment probe. */
  installedAgents?: () => string[];
  depsExec?: DepsExec;
  /**
   * FIX-906: unified delivery-truth predicate — true iff this story has a
   * MERGED delivery according to the single structured projection
   * (`ensureDeliveriesFresh` → `queryStoryDelivery(id).delivered`), which reads
   * BOTH runs.jsonl AND git merges on origin/main (FIX-904/905). This sees
   * EXTERNAL / manual merges (claude salvage, PR-lane direct merge of a
   * non-loop-cycle PR) that the runs-only {@link hasMergedDelivery} is blind to.
   *
   * The picker's done eligibility and the preflight done-flip both consult this
   * so the loop never re-picks a card that already shipped on main, regardless of
   * HOW it merged. Injectable + optional: unset (the test default) → no unified
   * probe, falling back to the runs-only signal; {@link nodePorts} wires the real
   * projection. The implementation memoizes the projection per cycle so the
   * `git log` it shells out to runs at most once.
   */
  mergedDelivery?: (storyId: string) => boolean;
  /**
   * FIX-1018: true iff this story already has locally-committed-but-unpublished
   * work from a prior cycle. The runtime pending-publish set is written when a
   * cycle exits unpublished and cleared on delivery.
   */
  pendingPublish?: (storyId: string) => boolean;
  /**
   * True-ish iff structured delivery truth says this story is already published
   * and awaiting PR merge. This is the primary durable source for same-session
   * de-duplication when the GitHub PR title/branch does not carry the story id.
   */
  pendingMergeDelivery?: (storyId: string) => { prNumber?: number } | undefined;
  clock: ProcessClock;
  /** Runtime paths the executor writes to. */
  paths: RunnerPaths;
  /** The repo (main tree) the worktree commands run against. */
  repoCwd: string;
  /** The skill body the agent runs (the loop hands the agent SKILL.md). */
  skillBody: string;
}

/** Resolved runtime file paths under `<project>/.roll/loop/`. */
export interface RunnerPaths {
  eventsPath: string;
  runsPath: string;
  alertsPath: string;
  lockPath: string;
  heartbeatPath: string;
  /** Story-claim ledger. Absent preserves the legacy events-adjacent path. */
  storyLeasePath?: string;
  /** The cycle worktree path. */
  worktreePath: string;
}

/** What {@link executeCommand} returns: an optional feedback event for the next
 *  step, plus side-effect flags the driver needs (lock released, terminal). */
export interface ExecuteResult {
  /** Event to feed back into the orchestrator (undefined ⇒ pure side effect). */
  event?: CycleEvent;
  /** True iff this command released the inner lock (driver stops re-releasing). */
  lockReleased?: boolean;
  /** FIX-208: live-context enrichment the orchestrator never owns (it is pure
   *  and clock/spawn-free) — real tcr count + parsed cost. The driver folds
   *  this into liveCtx so the later append_run / cycle:end carry truthful data. */
  ctxPatch?: Partial<CycleContext>;
  /** Exact capacity release completed; the driver can drop its residual lease. */
  capacityReleased?: boolean;
}
