import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  BacklogStore,
  claimStoryLease,
  EventBus,
  classifyComplexity,
  configuredModelForAgent,
  ensureDeliveriesFresh,
  nodeDeliveryStore,
  nodeExecPort,
  normalizeAgentConfig,
  heteroAvailableByModel,
  parseBacklog,
  peerModelFor,
  queryStoryDelivery,
  resolveRoute,
  resolveRouteExcluding,
  type FreshnessPort,
  type ObservedCommit,
  type RouteDeps,
  type StoryDeliveryTruth,
  type Tier,
} from "@roll/core";
import { absent, present } from "@roll/spec";
import {
  acquireLock,
  branchCleanlyRebasesOntoMain,
  branchMergedIntoMain,
  captureFromMarker,
  fetchRemoteBranch,
  git,
  ghRepoSlug,
  landLocalDelivery,
  lsRemote,
  openEvidenceFrame,
  prListOpenTitles,
  prViewMergeInfo,
  prViewState,
  releaseLock,
  remoteUrl,
  runPublishPlan,
  systemClock,
  resolveIntegrationBranch,
  worktreeAdd,
  worktreeAddInSubmodule,
  worktreeFetchOrigin,
  worktreeRemove,
  managedWorktreeRelease,
  managedWorktreeAbsent,
  inspectManagedWorktree,
  worktreeRemoveInSubmodule,
  worktreeResetHard,
  worktreeSubmoduleInit,
  writeHeartbeat,
  push as gitPush,
  managedRepositoryIdentity,
} from "@roll/infra";
import { cardArchiveDir } from "../lib/archive.js";
import { attestCommand } from "../commands/attest.js";
import { deliverableCmdsForStory, rejectedDeliverableCmdsForStory, storyRequiresScreenshot, webCaptureTargetsForStory } from "./attest-gate.js";
import { realAgentSpawn, type AgentSpawn } from "./agent-spawn.js";
import { probeAgentReachable } from "./agent-liveness.js";
import { readPendingPublish } from "./pending-publish.js";
import { resolveScopedStoryExecute } from "./scoped-route.js";
import { readSelfHeal } from "./selfheal-budget.js";
import type { Ports, ProcessClock, RunnerPaths } from "./ports.js";
import {
  bootstrapWorktreeSkills,
  commitRollMetadataRepo,
  readPrebuildDistEnabled,
} from "./worktree-bootstrap.js";
import { rescueLeakedMain } from "./sandbox-boundary.js";

const execFileAsync = promisify(execFile);

/**
 * FIX-1249 — config-rig model backstop for POOL-PICKED agents. A `select` role
 * pool (or a nudge/fallback hop) resolves an AGENT but carries no per-route
 * model; the model must still come from config, not a source-baked default. Scan
 * the project's `rigs:` for a rig binding this agent WITH a model. Returns "" when
 * the agent already has a routed model or config binds no model for it (the spawn
 * then omits `--model`, or fails loud for a required-model agent).
 */
export function configuredModelBackstop(repoCwd: string, agent: string): string {
  if (agent === "") return "";
  try {
    const { config } = normalizeAgentConfig(readFileSync(join(repoCwd, ".roll", "agents.yaml"), "utf8"));
    return configuredModelForAgent(agent, config) ?? "";
  } catch {
    return ""; // agents.yaml missing/unreadable — no backstop (caller stays config-driven).
  }
}

/**
 * US-PAIR-011 — the model a peer reviewer/scorer will actually be pinned to:
 * the rig-declared model from agents.yaml, else the agent's registered default.
 * Composed here so the review and score call sites share ONE resolution path.
 */
export function configuredPeerModel(repoCwd: string, agent: string): string {
  return peerModelFor(agent, configuredModelBackstop(repoCwd, agent));
}

/**
 * US-PAIR-015 — is a genuinely heterogeneous reviewer reachable for `builder`?
 *
 * Model-aware: several agent entries that all resolve to ONE model are NOT
 * heterogeneous availability. FIX-312 turns this boolean into a hard block, so
 * over-counting here silently converted a same-model self-review into
 * "independently reviewed".
 */
export function peerHeteroAvailability(
  repoCwd: string,
  installed: readonly string[],
  builder: string,
  allowed?: Set<string> | readonly string[],
): boolean {
  return heteroAvailableByModel(installed, builder, (agent) => configuredPeerModel(repoCwd, agent), allowed);
}

function scopedStoryExecuteRoute(
  repoCwd: string,
): { agent: string; model: string; excluded?: readonly string[]; rotationBlocked?: { previous: string } } | null {
  const scoped = resolveScopedStoryExecute(repoCwd);
  if (scoped === null) return null;
  const { resolution, previousBuilder } = scoped;
  // FIX-1267 — the no-consecutive-repeat rotation excludes the previous builder.
  const excluded = previousBuilder !== null ? [previousBuilder] : [];
  if (resolution.ok) {
    const agent = resolution.resolved.agent;
    // A `select` pool binding carries no per-agent model; backfill from config
    // rigs so a pool-picked agent still runs its CONFIGURED model (FIX-1249).
    const model = resolution.resolved.model ?? "";
    return {
      agent,
      model: model !== "" ? model : configuredModelBackstop(repoCwd, agent),
      ...(excluded.length > 0 ? { excluded } : {}),
    };
  }
  // FIX-1267 — a pool emptied SOLELY by the rotation exclusion (only the previous
  // builder was available) is a graceful fail-loud, not a crash: signal it so the
  // handler emits pending + ALERT rather than aborting the cycle.
  const skipped = resolution.failure.skipped;
  const rotationOnly =
    previousBuilder !== null && skipped.length > 0 && skipped.every((s) => s.reason === "no-consecutive-repeat");
  if (rotationOnly) {
    return { agent: "", model: "", rotationBlocked: { previous: previousBuilder } };
  }
  const hasScopedBindingFailure = resolution.failure.source !== undefined || resolution.failure.candidates.length > 0;
  if (hasScopedBindingFailure) {
    const reason = resolution.failure.errors[0] ?? "story.execute unresolved";
    throw new Error(`scoped story.execute resolution failed: ${reason}`);
  }
  return null;
}

/**
 * Build the real Node-backed {@link Ports} bundle. The agent spawn defaults to
 * {@link realAgentSpawn} (claude argv); tests override `agentSpawn` (+ the github
 * facet) with fakes so no real agent / PR side effects occur.
 */
export function nodePorts(opts: {
  repoCwd: string;
  paths: RunnerPaths;
  skillBody: string;
  routeDeps: RouteDeps;
  agentSpawn?: AgentSpawn;
  clock?: ProcessClock;
}): Ports {
  const bus = new EventBus();
  const clock = opts.clock ?? systemClock;
  const spawn = opts.agentSpawn ?? realAgentSpawn;

  // FIX-906: the unified delivery-truth predicate. The structured projection
  // (`ensureDeliveriesFresh`, FIX-904/905) rebuilds deliveries.jsonl from BOTH
  // runs.jsonl AND git merges on origin/main, so `queryStoryDelivery(id).delivered`
  // recognizes external / manual merges (claude salvage, PR-lane direct merge)
  // that the runs-only `hasMergedDelivery` is blind to. Memoized per cycle: the
  // projection (which may shell out to `git log`) runs at most ONCE, then every
  // story id reads the same in-memory snapshot. Wholly best-effort — a git/IO
  // failure leaves an empty snapshot and the picker/preflight fall back to the
  // runs-only signal they OR with, never toppling the cycle.
  const deliveryFreshness: FreshnessPort = {
    mtimeMs(absPath: string): number | undefined {
      try {
        return statSync(absPath).mtimeMs;
      } catch {
        return undefined;
      }
    },
    readText(absPath: string): string {
      try {
        return readFileSync(absPath, "utf8");
      } catch {
        return "";
      }
    },
    writeText(absPath: string, text: string): void {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, text, "utf8");
    },
  };
  let deliveryTruthCache: Map<string, StoryDeliveryTruth> | undefined;
  const deliveryTruth = (): Map<string, StoryDeliveryTruth> => {
    if (deliveryTruthCache === undefined) {
      try {
        const deliveries = ensureDeliveriesFresh(opts.repoCwd, deliveryFreshness, nodeExecPort, resolveIntegrationBranch(opts.repoCwd));
        // Derive `delivered` per story via the single deterministic query so the
        // verdict matches `roll truth query` exactly (FIX-906: one truth, all
        // consumers). Group by storyId first to avoid re-querying the same id.
        const map = new Map<string, StoryDeliveryTruth>();
        const ids = new Set(deliveries.map((d) => d.storyId));
        for (const id of ids) {
          map.set(id, queryStoryDelivery(id, deliveries));
        }
        deliveryTruthCache = map;
      } catch {
        deliveryTruthCache = new Map<string, StoryDeliveryTruth>(); // best-effort: empty → fall back to runs-only
      }
    }
    return deliveryTruthCache;
  };
  const mergedDelivery = (storyId: string): boolean => {
    return deliveryTruth().get(storyId)?.delivered === true;
  };

  return {
    repoCwd: opts.repoCwd,
    paths: opts.paths,
    skillBody: opts.skillBody,
    clock,
    agentSpawn: spawn,
    reserveStory: (storyId, entry) => {
      const result = claimStoryLease(join(dirname(opts.paths.eventsPath), "leases"), storyId, entry);
      return result.status === "claimed"
        ? { claimed: true }
        : { claimed: false, existingSource: result.existingSource };
    },
    // FIX-906: unified delivery-truth predicate (structured projection over
    // runs + git merges on origin/main — recognizes external/manual merges).
    mergedDelivery,
    // FIX-1018: skip stories that already have locally-committed-but-unpublished
    // work from a prior cycle. The executor reads the runtime file at pick time.
    pendingPublish: (storyId) => readPendingPublish(dirname(opts.paths.eventsPath)).has(storyId),
    pendingMergeDelivery: (storyId) => {
      const truth = deliveryTruth().get(storyId);
      if (truth === undefined) return undefined;
      if (truth.lifecycleState !== "pending_merge" && truth.lifecycleState !== "ci_red") return undefined;
      return truth.prNumber === undefined ? {} : { prNumber: truth.prNumber };
    },
    // FIX-363: the real connectivity probe reuses the same spawn the reviews use.
    agentReachable: (agent) => probeAgentReachable(agent, spawn, { cwd: opts.repoCwd }),
    git: {
      async fetchOrigin(repoCwd, branch) {
        const r = await worktreeFetchOrigin(repoCwd, branch);
        return { fetched: r.fetched };
      },
      async worktreeAdd(repoCwd, path, branch, base) {
        return worktreeAdd(repoCwd, path, branch, base);
      },
      async managedWorktreeFacts(repoCwd, base) {
        const resolved = await git(["rev-parse", "--verify", `${base}^{commit}`], repoCwd);
        if (resolved.code !== 0 || resolved.stdout.trim() === "") return undefined;
        return { baseSha: resolved.stdout.trim(), repositoryId: (await managedRepositoryIdentity(repoCwd)).slug };
      },
      async managedWorktreeRelease(repoCwd, path, expectedHead, repositoryId, options) {
        return managedWorktreeRelease(repoCwd, path, expectedHead, repositoryId, options);
      },
      async managedWorktreeInspect(repoCwd, path) {
        return inspectManagedWorktree(repoCwd, path);
      },
      async managedWorktreeAbsent(repoCwd, path) {
        return managedWorktreeAbsent(repoCwd, path);
      },
      async worktreeAddInSubmodule(superprojectCwd, submoduleName, cycleWorktreePath, base) {
        const r = await worktreeAddInSubmodule(superprojectCwd, submoduleName, cycleWorktreePath, base);
        return { code: r.code, stderr: r.stderr };
      },
      async worktreeRemoveInSubmodule(superprojectCwd, submoduleName, submoduleWorktreePath) {
        const r = await worktreeRemoveInSubmodule(superprojectCwd, submoduleName, submoduleWorktreePath);
        return { code: r.code };
      },
      async worktreeSubmoduleInit(worktreePath) {
        return worktreeSubmoduleInit(worktreePath);
      },
      async worktreeRemove(repoCwd, path, branch, bundleUnpushed) {
        return worktreeRemove(repoCwd, path, branch, bundleUnpushed);
      },
      async push(repoCwd, branch) {
        return gitPush(repoCwd, branch);
      },
      async commitsAhead(worktreeCwd, baseRef = "origin/main") {
        // E8: count ahead of the caller's integration branch (defaults to the
        // historical origin/main). A submodule cycle has no origin/main, so the
        // observer callers pass resolveIntegrationBranch(execRepoCwd) instead.
        const r = await execFileAsync("git", ["rev-list", "--count", `${baseRef}..HEAD`], {
          cwd: worktreeCwd,
          encoding: "utf8",
        }).catch(() => ({ stdout: "0" }));
        const n = Number((r.stdout ?? "0").trim());
        return Number.isFinite(n) ? n : 0;
      },
      async worktreeStatusSignature(worktreeCwd) {
        // FIX-1477: raw porcelain output IS the fingerprint (string compare in
        // the watchdog — no hashing needed). NO catch: a git error must
        // propagate so the watchdog skips the tick as a blip instead of
        // misreading a failed probe as "worktree suddenly clean" (a false
        // state change → false progress) or as stale state.
        const r = await execFileAsync("git", ["status", "--porcelain"], {
          cwd: worktreeCwd,
          encoding: "utf8",
        });
        return r.stdout ?? "";
      },
      async mainAhead(repoCwd) {
        const r = await execFileAsync("git", ["rev-list", "--count", "origin/main..main"], {
          cwd: repoCwd,
          encoding: "utf8",
        }).catch(() => ({ stdout: "0" }));
        const n = Number((r.stdout ?? "0").trim());
        return Number.isFinite(n) ? n : 0;
      },
      async rescueLeaked(repoCwd, refName) {
        return rescueLeakedMain(repoCwd, refName);
      },
      async tcrCount(worktreeCwd, baseRef = "origin/main") {
        // v2口径 (bin/roll:8724): git log --oneline <baseRef>..HEAD | grep -c ' tcr:'.
        // E8: baseRef defaults to origin/main; a submodule cycle passes the
        // submodule's integration branch (no origin/main there).
        // FIX-1244: a git failure (missing/stale ref, gone worktree) means the
        // count is UNKNOWN — return undefined so callers never misread it as a
        // real zero (the zero-TCR self-heal gate consumes this).
        const r = await execFileAsync("git", ["log", "--oneline", `${baseRef}..HEAD`], {
          cwd: worktreeCwd,
          encoding: "utf8",
        }).catch(() => undefined);
        if (r === undefined) return undefined;
        return (r.stdout ?? "")
          .split("\n")
          .filter((l) => l.includes(" tcr:")).length;
      },
      async recentCommits(worktreeCwd, baseRef = "origin/main") {
        // The runner's OWN git observation — oldest-first so observeCommits()
        // appends events in chronological order. %ct = committer epoch seconds.
        // E8: baseRef defaults to origin/main; a submodule cycle passes the
        // submodule's integration branch so the observer sees the real commits.
        const r = await execFileAsync(
          "git",
          ["log", "--reverse", "--format=%H%x09%ct%x09%s", `${baseRef}..HEAD`],
          { cwd: worktreeCwd, encoding: "utf8" },
        ).catch(() => ({ stdout: "" }));
        const out: ObservedCommit[] = [];
        for (const line of (r.stdout ?? "").split("\n")) {
          if (line.trim() === "") continue;
          const [hash, ct, ...rest] = line.split("\t");
          if (hash === undefined || hash === "") continue;
          const tsSec = Number((ct ?? "0").trim());
          out.push({
            hash,
            message: rest.join("\t"),
            tsSec: Number.isFinite(tsSec) ? tsSec : 0,
          });
        }
        return out;
      },
      // RESUME-PRIOR-WORK probes (un-merged audit-branch reuse).
      async fetchRemoteBranch(repoCwd, branch) {
        return fetchRemoteBranch(repoCwd, branch);
      },
      async branchMergedIntoMain(repoCwd, branch, integrationBranch) {
        return branchMergedIntoMain(repoCwd, branch, integrationBranch);
      },
      async branchCleanlyRebasesOntoMain(repoCwd, branch, integrationBranch) {
        return branchCleanlyRebasesOntoMain(repoCwd, branch, integrationBranch);
      },
      async resetWorktreeHard(worktreeCwd, ref, branch) {
        const r = await worktreeResetHard(worktreeCwd, ref, branch);
        return { code: r.code };
      },
      async landLocalDelivery(repoCwd, worktreeCwd, integrationBranch) {
        return landLocalDelivery(repoCwd, worktreeCwd, integrationBranch);
      },
      // US-CYCLE-009: the real tip of origin/<branch> from the git plane, used to
      // head-sha-pin the auto-merge attach. LENIENT — undefined on any failure.
      async remoteBranchTip(repoCwd, branch) {
        try {
          const refs = await lsRemote(repoCwd, "origin", [`refs/heads/${branch}`]);
          const tip = refs.find((r) => r.ref === `refs/heads/${branch}`) ?? refs[0];
          return tip !== undefined && tip.sha !== "" ? tip.sha : undefined;
        } catch {
          return undefined;
        }
      },
    },
    github: {
      async repoSlug(repoCwd) {
        const url = await remoteUrl(repoCwd);
        return ghRepoSlug(url);
      },
      async runPublishPlan(plan) {
        const r = await runPublishPlan(plan);
        return {
          status: r.status,
          prUrl: r.prUrl,
          ok: r.ok,
          degraded: r.degraded,
          rootCauseKey: r.rootCauseKey,
          autoMergeUnavailable: r.autoMergeUnavailable,
        };
      },
      async prState(repoCwd, branch) {
        const slug = ghRepoSlug(await remoteUrl(repoCwd));
        if (slug === undefined) return "UNKNOWN";
        return prViewState(slug, branch);
      },
      async prMergeInfo(repoCwd, branch) {
        const slug = ghRepoSlug(await remoteUrl(repoCwd));
        if (slug === undefined) return undefined;
        return prViewMergeInfo(slug, branch);
      },
      async openPrTitles(repoCwd) {
        const slug = ghRepoSlug(await remoteUrl(repoCwd));
        if (slug === undefined) return [];
        return prListOpenTitles(slug);
      },
    },
    process: {
      acquireLock(lockPath, o) {
        return acquireLock(lockPath, process.pid, { staleSec: o?.staleSec, now: clock, cycleId: o?.cycleId });
      },
      releaseLock(lockPath) {
        releaseLock(lockPath);
      },
      writeHeartbeat(path) {
        writeHeartbeat(path, clock);
      },
    },
    events: {
      ensureEventFiles(eventsPath, runsPath) {
        bus.ensureEventFiles(eventsPath, runsPath);
      },
      appendEvent(eventsPath, event) {
        bus.appendEvent(eventsPath, event);
      },
      upsertRun(runsPath, key, row) {
        bus.upsertRun(runsPath, key, row);
      },
      appendAlert(alertsPath, message) {
        appendAlertLine(alertsPath, message);
      },
    },
    backlog: {
      read(projectCwd) {
        const p = join(projectCwd, ".roll", "backlog.md");
        if (!existsSync(p)) return [];
        return parseBacklog(readFileSync(p, "utf8"));
      },
      // FIX-198: the production binding was MISSING entirely (the optional
      // chain made every In-Progress claim a silent no-op). ID-anchored mark
      // under optimistic concurrency; best-effort — a conflict/IO failure must
      // never kill the cycle, the reconcile pass is the safety net.
      markStatus(projectCwd, id, status) {
        try {
          const p = join(projectCwd, ".roll", "backlog.md");
          if (!existsSync(p)) return;
          const store = new BacklogStore();
          const snap = store.readBacklog(p);
          // FIX-1475: EXACT id match. Every runner caller passes a concrete story
          // id (setup In Progress, terminal Done, resume, reconcile), so prefix
          // matching would wrongly flip `<id>-` descendant rows (completing
          // FIX-1475 must not mark FIX-1475-followup). The CLI `roll backlog`
          // pattern commands still use BacklogStore.mark directly.
          store.markExact(p, snap.hash, id, status);
        } catch {
          /* best-effort: reconcile owns the fallback */
        }
      },
    },
    // FIX-306: the runner commits + pushes the `.roll` metadata repo. See the
    // {@link MetadataPort} doc for WHY this is the runner's job, not the agent's.
    metadata: {
      async commit(projectCwd, message) {
        return commitRollMetadataRepo(projectCwd, message);
      },
    },
    route: opts.routeDeps
      ? {
          resolve(storyId, estMin) {
            const scoped = scopedStoryExecuteRoute(opts.repoCwd);
            // FIX-1267: the scoped route already carries the rotation exclusion
            // (excluded / rotationBlocked); return it verbatim so the handler can
            // enforce the no-consecutive-repeat constraint.
            if (scoped !== null) return scoped;
            const tier: Tier = classifyComplexity(estMin);
            const routeDeps = opts.routeDeps;
            // Compatibility fallback for legacy tier slots. FIX-930: a story
            // re-picked after a zero-TCR self-heal swap carries a tried-agent
            // set; route the NEXT untried agent (resolveRouteExcluding) so the
            // swap actually changes who builds. Empty set => plain resolveRoute.
            // The store lives at the MAIN runtime dir (repoCwd is the main
            // project; .roll is symlink-resolved either way).
            const rt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(opts.repoCwd, ".roll", "loop");
            const tried = storyId !== "" ? readSelfHeal(rt, storyId).triedAgents : [];
            const dec =
              tried.length > 0
                ? (resolveRouteExcluding(tier, routeDeps, tried) ?? resolveRoute(tier, routeDeps))
                : resolveRoute(tier, routeDeps);
            // Thread the routed slot's native --model through to the spawn; absent => ""
            // (the orchestrator's `ctx.model !== ""` guard then omits --model and
            // the agent uses its own default). FIX-1249: when the slot supplied no
            // model (nudge/firstInstalled hop, or an agent-only rig), backfill from
            // config rigs so the agent still runs its CONFIGURED model rather than a
            // source-baked default.
            const routedModel = dec.model ?? "";
            return {
              agent: dec.agent,
              model: routedModel !== "" ? routedModel : configuredModelBackstop(opts.repoCwd, dec.agent),
            };
          },
        }
      : { resolve: () => ({ agent: "claude", model: "" }) },
    evidence: {
      openFrame(projectCwd, storyId, runId) {
        return openEvidenceFrame({ runDir: join(cardArchiveDir(projectCwd, storyId), runId) }).runDir;
      },
    },
    capture: {
      fromMarker(marker, runDir) {
        return captureFromMarker(marker, {
          runDir,
          deps: { env: { ...process.env } },
        });
      },
    },
    attest: {
      async render(projectCwd, storyId, runDir) {
        const prev = process.cwd();
        try {
          process.chdir(projectCwd);
          // FIX-305: a UI/dossier card's acceptance is a RENDERED page, so its
          // evidence must be a real physical-window screenshot, not a headless,
          // transcript-rendered, or HTML-reproduction PNG. Auto-drive the web
          // self-capture lane against
          // the card's rendered dossier page (file://…/index.html), or an explicit
          // ROLL_ATTEST_WEB_URL deployed product page. On unattended/headless hosts
          // the capture records an honest skip instead of fabricating visual
          // evidence.
          // FIX-339 (AC1): capture EVERY declared deliverable_url (a card may ship
          // more than one user-visible web view). FIX-321: if a required story
          // declares none, record an HONEST web skip (no hollow dossier shot) so
          // the visual floor stays satisfiable without faking evidence. Exempt
          // stories owe no web capture at all.
          const webTargets = webCaptureTargetsForStory(projectCwd, storyId, process.env["ROLL_ATTEST_WEB_URL"]);
          const webArgs =
            webTargets.length > 0
              ? webTargets.flatMap((t) => ["--capture-web", t])
              : storyRequiresScreenshot(projectCwd, storyId) && deliverableCmdsForStory(projectCwd, storyId).length === 0
                ? ["--capture-web-skip", "no deliverable_url declared (set deliverable_url in the spec frontmatter or ROLL_ATTEST_WEB_URL)"]
                : [];
          // FIX-339 (AC2/AC3): run + capture EVERY declared deliverable_cmd (a CLI
          // deliverable's terminal output). deliverableCmdsForStory returns only
          // ALLOWLISTED commands (roll read-only) — run inside the worktree via
          // attest's `cd <worktree> && …` wrapper.
          const cmdArgs = deliverableCmdsForStory(projectCwd, storyId).flatMap((c) => ["--capture-command", c]);
          // FIX-339 (复核 #1): any deliverable_cmd the allowlist REJECTED (non-roll
          // command or a state-changing roll subcommand) is NEVER run. Record a
          // loud terminal skip fact so the report discloses the refusal and the
          // attest gate fails on it (rejectedDeliverableCmdsForStory).
          const cmdSkipArgs = rejectedDeliverableCmdsForStory(projectCwd, storyId).flatMap((c) => [
            "--capture-command-skip",
            `deliverable_cmd 非白名单(仅限 roll 只读子命令): ${c}`,
          ]);
          return await attestCommand([storyId, "--run-dir", runDir, ...webArgs, ...cmdArgs, ...cmdSkipArgs], {
            capture: { env: { ...process.env } },
          });
        } finally {
          process.chdir(prev);
        }
      },
    },
  };
}

function appendAlertLine(alertsPath: string, message: string): void {
  mkdirSync(dirname(alertsPath), { recursive: true });
  appendFileSync(alertsPath, `${message}\n`, "utf8");
}
