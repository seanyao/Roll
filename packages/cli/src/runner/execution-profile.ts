import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  applyExecutionPolicy,
  advanceContextCycleStageState,
  canonicalAgentName,
  classifyStoryRisk,
  explainExecutionProfile,
  normalizeAgentConfig,
  selectExecutionProfile,
  validateAuthoredEvalReport,
  validateDesignArtifact,
  validateRoleAccess,
  type ContextCycleStageStateV1,
  type CycleContext,
} from "@roll/core";
import type { AdversarialPlan } from "@roll/core";
import type { AgentName, ArtifactManifest, DeltaArtifactManifest, ExecutionProfile, ResolutionSource, Rig } from "@roll/spec";
import { resolveScopedCastRole } from "./scoped-route.js";
import { storySpecPath } from "./attest-gate.js";
import { resolveExecutionCwd } from "./submodule-worktree.js";
import { spawnWatched } from "./spawn-watchdog.js";
import type { Ports } from "./ports.js";
import { eventTs } from "./runner-time.js";

/** Parse an `est_min:<n>` tag from a backlog desc (router input). */
export function parseEstMin(desc: string): number | undefined {
  const m = /est[_-]?min:\s*(\d+)/i.exec(desc);
  return m === null ? undefined : Number(m[1]);
}

/**
 * FIX-1026 — parse `est_min:<n>` from a STORY SPEC's YAML frontmatter.
 *
 * The agents.yaml tier→rig contract (easy ≤8, default 8–20, hard >20) is driven
 * by `est_min`, and the documented escalation lever is "bump est_min to send a
 * stuck card to a harder tier". That lever lives in the spec frontmatter, which
 * was never read by the router — only the backlog row's `est_min:` tag was. A
 * spec declaring `est_min: 24` therefore still ran on the `default` tier.
 *
 * This reads ONLY the leading `--- … ---` frontmatter block (so a stray
 * `est_min:` mention in the prose body cannot hijack routing) and returns the
 * first `est_min:` integer there, or undefined when absent/unparseable. The
 * resolve_route handler prefers this over the backlog row so the spec is the
 * single source of truth for sizing.
 */
export function parseEstMinFromSpec(specText: string): number | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(specText);
  if (fm === null) return undefined;
  const m = /^\s*est[_-]?min:\s*(\d+)/im.exec(fm[1] ?? "");
  return m === null ? undefined : Number(m[1]);
}

/** US-V4-004/003 — the project's `execution_policy.mode` from `.roll/agents.yaml`
 *  (default "standard" when absent/unparseable). Gates whether verified/designed
 *  stages execute; standard keeps the cycle Builder-only (no regression). */
function executionPolicyMode(repoCwd: string): "standard" | "verified" | "designed" | "auto" {
  try {
    const p = join(repoCwd, ".roll", "agents.yaml");
    if (!existsSync(p)) return "standard";
    return normalizeAgentConfig(readFileSync(p, "utf8")).config.executionPolicy.mode;
  } catch {
    return "standard";
  }
}

/**
 * US-V4-004 — select the Story execution profile from the spec's risk signals and
 * RECORD it in a durable `execution:profile` event. Pure-decision + one append;
 * never throws (a spec read blip falls back to `standard`, the current
 * builder-only path). Returns the profile so the executor can fold it into the
 * cycle context. In v4.0 only `standard` actually executes — recording the chosen
 * profile is the foundation verified/designed execution builds on (US-V4-005/006).
 */
export function recordExecutionProfile(
  ports: Ports,
  cycleId: string,
  storyId: string,
  estMin: number | undefined,
): ExecutionProfile {
  let profile: ExecutionProfile = "standard";
  let reason = "standard: spec unavailable";
  try {
    const specPath = storySpecPath(ports.repoCwd, storyId);
    if (specPath !== null && existsSync(specPath)) {
      const input = classifyStoryRisk(storyId, readFileSync(specPath, "utf8"), {
        ...(estMin !== undefined ? { estimatedMinutes: estMin } : {}),
      });
      const classified = selectExecutionProfile(input);
      // Apply execution_policy.mode (default "standard" — incl. no agents.yaml) so
      // a project that has not opted into verified/designed stays Builder-only (the
      // v4.0 no-regression guarantee). The classification still informs the reason.
      const mode = executionPolicyMode(ports.repoCwd);
      profile = applyExecutionPolicy(classified, mode);
      reason = `${explainExecutionProfile(input)} [policy:${mode} → ${profile}]`;
    }
  } catch {
    profile = "standard";
    reason = "standard: profile selection failed (fell back)";
  }
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "execution:profile",
      cycleId,
      storyId,
      profile,
      reason,
      ts: eventTs(ports),
    });
  } catch {
    /* recording is best-effort; never topple routing on an event-append blip */
  }
  return profile;
}

/** US-LOOP-102 — default adversarial-pairing parameters (design §3.1). A later
 *  story can source these from the profile's `adversarial:` config block; these
 *  are the owner-signed defaults until then. */
export const DEFAULT_ADVERSARIAL_CFG = {
  maxRounds: 4,
  dryRoundsToStop: 2,
  totalTimeoutSec: 2700,
} as const;

/**
 * US-LOOP-102 — resolve the adversarial plan for a verified/designed cycle, or
 * `undefined` to run the standard single-builder path (zero behaviour change).
 *
 * The routed builder is the IMPLEMENTER; the test_author/attacker is the FIRST
 * active agent that differs from it — a minimal heterogeneity gate (agent-entry
 * difference). No heterogeneous partner available ⇒ `undefined` (degrade to
 * standard). Session-level fail-closed independence
 * (`assertAdversarialIndependence`) and the full §7 degrade taxonomy + alerts are
 * US-LOOP-103; this only opens the routing seam.
 */
export function planAdversarial(
  profile: ExecutionProfile,
  implementer: string,
  activeAgents: readonly string[],
): AdversarialPlan | undefined {
  if (profile !== "verified" && profile !== "designed") return undefined;
  const testAuthor = activeAgents.find((a) => a !== "" && a !== implementer);
  if (testAuthor === undefined) return undefined;
  return { testAuthor, implementer, ...DEFAULT_ADVERSARIAL_CFG };
}

function buildDesignerPrompt(storyId: string, contractAbsPath: string): string {
  return [
    `You are the DESIGNER for story ${storyId} in a designed execution profile.`,
    `Read the story spec under .roll/features/**/${storyId}/spec.md and produce a design contract.`,
    `Write the contract to: ${contractAbsPath}`,
    "It MUST be markdown with these sections (use '- ' bullets):",
    "## Scope boundary",
    "## Acceptance contract",
    "## Expected evidence",
    "## Risks",
    "## Out of scope",
    "## Resize / split guidance   (optional prose)",
    "Do NOT write product code — you only design. The Builder consumes this contract next.",
  ].join("\n");
}

/**
 * US-DELTA-006 — the Designer role resolved for a Full Delta cycle. `ok:false`
 * means no valid `design` binding could be cast — the caller MUST fail closed
 * (the Builder never starts). `null` (from {@link DesignerStageDeps.resolveDesigner})
 * means the project has no scoped agents.yaml at all; that is ALSO fail-closed
 * for the designed profile (no quiet fallback to reusing the Builder agent).
 */
export interface DesignerResolution {
  readonly ok: boolean;
  readonly agent?: string;
  readonly model?: string;
  readonly source: ResolutionSource;
  readonly reasons: readonly string[];
  readonly error?: string;
}

/** Test/injection seam for the designer stage. */
export interface DesignerStageDeps {
  /** Resolve the Designer INDEPENDENTLY (scope role `design`), never the Builder
   *  agent. Default: the scoped `designer` cast-role resolution. `null` ⇒ no
   *  scoped agents.yaml (fail closed for a designed cycle). */
  readonly resolveDesigner?: (repoCwd: string) => DesignerResolution | null;
  /** Host id stamped into the delta role facts (default `os.hostname()`). */
  readonly hostId?: string;
}

/**
 * US-DELTA-006 — the default independent Designer resolver: the scoped
 * `designer` cast role maps to the `design` scope role. A missing scoped config
 * (`null`), a non-`design` scope role, or an unresolved `design` binding all
 * surface as fail-closed (no fallback to the Builder's `execute` agent).
 */
function defaultResolveDesigner(repoCwd: string, installed?: ReadonlySet<AgentName>): DesignerResolution | null {
  const route = resolveScopedCastRole(
    repoCwd,
    "designer",
    {
      ...(existsSync(join(repoCwd, "workspace.yaml")) ? { workspaceRoot: repoCwd } : {}),
      ...(installed !== undefined ? { installed } : {}),
    },
  );
  if (route === null) return null;
  if (route.scopeRole !== "design") {
    return {
      ok: false,
      source: "availability-fallback",
      reasons: [],
      error: `resolved scope role '${route.scopeRole}', expected 'design'`,
    };
  }
  if (!route.resolution.ok) {
    const errors = route.resolution.failure.errors;
    return {
      ok: false,
      source: "availability-fallback",
      reasons: errors as string[],
      error: errors[0] ?? "design role unresolved",
    };
  }
  const r = route.resolution.resolved;
  return {
    ok: true,
    agent: r.agent,
    ...(r.model !== undefined && r.model !== "" ? { model: r.model } : {}),
    // A `fixed` owner binding is an explicit user pin; a `select` pool is an
    // availability-driven cast.
    source: r.selectedStrategy === "fixed" ? "user-pin" : "availability-fallback",
    reasons: [`scoped design role via ${r.source}`, `strategy:${r.selectedStrategy}`],
  };
}

/**
 * US-DELTA-006 — the Full Delta / `designed` DESIGN STAGE. The Designer is cast
 * INDEPENDENTLY of the Builder (its own agent identity + session), records
 * separate `delta:role_resolved` and `delta:role_started` facts, runs READ-ONLY
 * (no product worktree write roots), and FAILS CLOSED — returning `ok:false` so
 * the Builder never starts — when no valid `design` binding resolves or the
 * Designer publishes no valid contract.
 */
export async function runDesignerStage(
  ports: Ports,
  ctx: CycleContext,
  deps: DesignerStageDeps = {},
): Promise<{
  ran: boolean;
  ok: boolean;
  reasons: readonly string[];
  designerAgent?: string;
  designerSessionId?: string;
  contextStage?: ContextCycleStageStateV1;
}> {
  if (ctx.selectedProfile !== "designed") return { ran: false, ok: true, reasons: [] };
  const storyId = ctx.storyId ?? "";
  const runDir = ctx.evidenceRunDir ?? "";
  if (storyId === "" || runDir === "") return { ran: false, ok: false, reasons: ["no story id / run dir for designer stage"] };

  // AC1/AC2: resolve the Designer INDEPENDENTLY (scope role `design`). A missing
  // scoped config, a non-`design` scope role, or an unresolved `design` binding
  // all fail closed here — the Builder is NEVER reused as the Designer and there
  // is NO quiet fallback to `execute`.
  const installed = ports.installedAgents?.();
  const installedSet = installed === undefined
    ? undefined
    : new Set(installed.map((agent) => canonicalAgentName(agent) as AgentName));
  const resolveDesigner = deps.resolveDesigner ?? ((repoCwd: string) => defaultResolveDesigner(repoCwd, installedSet));
  const resolved = resolveDesigner(ports.repoCwd);
  if (resolved === null) {
    return {
      ran: false,
      ok: false,
      reasons: ["designer stage: no scoped agents.yaml design binding — Full Delta requires an independently cast Designer (no fallback to the Builder agent)"],
    };
  }
  if (!resolved.ok || resolved.agent === undefined || resolved.agent === "") {
    return { ran: false, ok: false, reasons: [`designer stage: ${resolved.error ?? "design role unresolved"}`] };
  }
  const designerAgent = resolved.agent;

  const dir = join(runDir, "role-artifacts", "designer");
  const contractPath = join(dir, "design-contract.md");
  const manifestPath = join(dir, "artifact-manifest.json");
  const designerSessionId = `${ctx.cycleId ?? "cycle"}:design:${designerAgent}:${ports.clock()}`;
  const roleInstanceId = `${ctx.cycleId ?? "cycle"}:designer:${designerAgent}`;
  const delegationId = ctx.cycleId ?? "cycle";
  const hostId = deps.hostId ?? hostname();
  // The scoped router casts an agent IDENTITY; a per-role MODEL resolution is
  // US-DELTA-002 territory, so absent an explicit model the agent name is the
  // best-available identity token (mirrors the manifest's `rig.agent`).
  const modelId = resolved.model !== undefined && resolved.model !== "" ? resolved.model : designerAgent;
  // E4: the designer reads the code it designs against; run it where the builder
  // will run (submodule cycle worktree for a submodule story). No targetSubmodule
  // ⇒ ports.paths.worktreePath, unchanged.
  const execCwd = resolveExecutionCwd(ports, ctx);
  let contextStage = ctx.contextStage;
  let contextEnvelope = "";
  if (ports.contextStage !== undefined) {
    const requested = contextStage ?? { refs: [] };
    let contextResult: Awaited<ReturnType<NonNullable<Ports["contextStage"]>["readForStage"]>>;
    try {
      contextResult = await ports.contextStage.readForStage({
        storyId,
        stage: "design",
        ...requested,
        readMode: "fresh",
      });
    } catch {
      return { ran: true, ok: false, reasons: ["invalid_context_snapshot: Context host failed closed"] };
    }
    if (contextResult.status !== "ready") {
      const reason = contextResult.status === "blocked"
        ? `${contextResult.diagnostic.code}: ${contextResult.diagnostic.message}`
        : "context revision needs reconciliation";
      return { ran: true, ok: false, reasons: [reason] };
    }
    contextStage = advanceContextCycleStageState(requested, contextResult.handoff, "design");
    contextEnvelope = contextResult.encodedEnvelope;
  }
  try {
    mkdirSync(dir, { recursive: true });
    if (contextStage !== undefined) {
      writeFileSync(join(dir, "context-stage-handoff.json"), `${JSON.stringify(contextStage, null, 2)}\n`);
    }
  } catch {
    if (contextStage !== undefined) {
      return { ran: true, ok: false, reasons: ["Context handoff artifact could not be persisted"] };
    }
  }

  // AC3: record SEPARATE role-resolution and role-start facts for the Designer
  // BEFORE the design stage runs, so the independent cast is auditable. These are
  // REQUIRED audit facts, NOT best-effort telemetry (codex r1): if they cannot be
  // written, the stage FAILS CLOSED — the Builder must never proceed on an
  // unauditable Designer cast.
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "delta:role_resolved",
      delegationId,
      storyId,
      role: "designer",
      roleInstanceId,
      hostId,
      modelId,
      source: resolved.source,
      reasons: [...resolved.reasons],
      inventorySha256: "",
      inventoryObservedAt: new Date(eventTs(ports)).toISOString(),
      ts: eventTs(ports),
    });
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "delta:role_started",
      delegationId,
      storyId,
      role: "designer",
      sessionId: designerSessionId,
      roleInstanceId,
      hostId,
      modelId,
      identityProvenance: "adapter-observed",
      // AC5: the Designer runs READ-ONLY — only the Builder gets write roots.
      worktreeAccess: "read-only",
      ts: eventTs(ports),
    });
  } catch (e) {
    return {
      ran: false,
      ok: false,
      reasons: [`designer stage: could not record required role facts (delta:role_resolved/role_started) — fail closed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (!existsSync(contractPath)) {
    try {
      mkdirSync(dir, { recursive: true });
      // US-CYCLE-002: the designer sub-spawn goes through the shared watchdog —
      // per-role cap (designer 20min) + liveness renewal in its own cwd, so a
      // productive designer survives and a silent one dies on schedule.
      await spawnWatched({
        ports,
        ctx,
        purpose: "designer",
        agent: designerAgent,
        observeCwd: execCwd,
        run: () =>
          // AC5: the Designer runs READ-ONLY on the product worktree. `readOnly`
          // makes SANDBOX-ENFORCING adapters (codex → --sandbox read-only;
          // reasonix/Seatbelt → allow_write limited to `writableRoots`) OS-refuse
          // product writes; `writableRoots` is JUST the Designer's own artifact
          // dir, so it can emit its design contract but cannot touch product code.
          // FIX-1482: read-only is ENFORCED OR REFUSED — a readOnly spawn on a
          // NON-enforcing adapter (kimi/agy/claude/pi/cursor) is now a fail-loud
          // refusal at the spawn boundary (assertReadOnlyEnforceable), never a
          // silent advisory. So a designed cycle only proceeds when the Designer
          // is cast on codex or reasonix. Only the Builder spawn
          // (spawn-agent-handler) is ever granted product worktree write roots.
          ports.agentSpawn(designerAgent, {
            cwd: execCwd,
            skillBody: contextEnvelope === ""
              ? buildDesignerPrompt(storyId, contractPath)
              : `${buildDesignerPrompt(storyId, contractPath)}\n\n${contextEnvelope}`,
            storyId,
            runDir: dir,
            readOnly: true,
            writableRoots: [dir],
          }),
      });
    } catch {
      /* a designer spawn blip -> no contract -> validation below fails closed */
    }
  }
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    storyId,
    cycleId: ctx.cycleId ?? "",
    role: "designer",
    rig: { agent: designerAgent } as Rig,
    sessionId: designerSessionId,
    worktreeCwd: execCwd,
    scoreRepoCwd: ports.repoCwd,
    inputs: [{ path: `.roll/features/**/${storyId}/spec.md`, kind: "contract" }],
    outputs: [{ path: "role-artifacts/designer/design-contract.md", kind: "contract" }],
    createdAt: new Date(eventTs(ports)).toISOString(),
  };
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch {
    /* best-effort manifest record */
  }
  const contractMd = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : null;
  const v = validateDesignArtifact({ manifest, contractMd, storyId });
  return {
    ran: true,
    ok: v.ok,
    reasons: v.reasons,
    designerAgent,
    designerSessionId,
    ...(contextStage === undefined ? {} : { contextStage }),
  };
}

function buildEvaluatorPrompt(storyId: string, reportAbsPath: string): string {
  return [
    `You are the EVALUATOR for story ${storyId} in a Full Delta execution profile.`,
    `Independently evaluate the Builder's delivery. READ (do not modify) the committed diff, the acceptance report ${storyId}-report.html, ac-map.json, and — IF PRESENT — the optional peer-review notes. Those are all INPUTS to your own judgement.`,
    `Write YOUR evaluation to: ${reportAbsPath}`,
    "It MUST be markdown containing at least these two sections (use '- ' bullets):",
    "## Inputs checked",
    "## Rationale",
    "Under '## Inputs checked' list every input you actually inspected. Under '## Rationale' give YOUR independent merge/repair/hold reasoning.",
    "A peer-review artifact is only an INPUT — your report must be your OWN authored evaluation, never a copy or restatement of the peer output.",
    "Do NOT write product code — you only evaluate, read-only. The Builder consumed the design contract; you judge the result.",
  ].join("\n");
}

/**
 * US-DELTA-007 — the Evaluator role resolved for a Full Delta cycle. `ok:false`
 * means no valid `evaluate` binding could be cast — the caller MUST fail closed
 * (delivery is blocked `artifact_invalid`, never marked Done). `null` (from
 * {@link EvaluatorStageDeps.resolveEvaluator}) means the project has no scoped
 * agents.yaml at all; that is ALSO fail-closed (no quiet fallback to the Builder).
 */
export interface EvaluatorResolution {
  readonly ok: boolean;
  readonly agent?: string;
  readonly model?: string;
  readonly source: ResolutionSource;
  readonly reasons: readonly string[];
  readonly error?: string;
}

/** Test/injection seam for the evaluator stage. */
export interface EvaluatorStageDeps {
  /** Resolve the Evaluator INDEPENDENTLY (scope role `evaluate`), never the
   *  Builder agent. Default: the scoped `evaluator` cast-role resolution. `null`
   *  ⇒ no scoped agents.yaml (fail closed for a Full Delta cycle). */
  readonly resolveEvaluator?: (repoCwd: string) => EvaluatorResolution | null;
  /** Host id stamped into the delta role facts (default `os.hostname()`). */
  readonly hostId?: string;
}

/**
 * US-DELTA-007 — the default independent Evaluator resolver: the scoped
 * `evaluator` cast role maps to the `evaluate` scope role. A missing scoped
 * config (`null`), a non-`evaluate` scope role, or an unresolved `evaluate`
 * binding all surface as fail-closed (no fallback to the Builder's agent).
 */
function defaultResolveEvaluator(repoCwd: string, installed?: ReadonlySet<AgentName>): EvaluatorResolution | null {
  const route = resolveScopedCastRole(
    repoCwd,
    "evaluator",
    {
      ...(existsSync(join(repoCwd, "workspace.yaml")) ? { workspaceRoot: repoCwd } : {}),
      ...(installed !== undefined ? { installed } : {}),
    },
  );
  if (route === null) return null;
  if (route.scopeRole !== "evaluate") {
    return {
      ok: false,
      source: "availability-fallback",
      reasons: [],
      error: `resolved scope role '${route.scopeRole}', expected 'evaluate'`,
    };
  }
  if (!route.resolution.ok) {
    const errors = route.resolution.failure.errors;
    return {
      ok: false,
      source: "availability-fallback",
      reasons: errors as string[],
      error: errors[0] ?? "evaluate role unresolved",
    };
  }
  const r = route.resolution.resolved;
  return {
    ok: true,
    agent: r.agent,
    ...(r.model !== undefined && r.model !== "" ? { model: r.model } : {}),
    source: r.selectedStrategy === "fixed" ? "user-pin" : "availability-fallback",
    reasons: [`scoped evaluate role via ${r.source}`, `strategy:${r.selectedStrategy}`],
  };
}

/**
 * US-DELTA-007 — the Full Delta (`verified`/`designed`) EVALUATION STAGE. This
 * REPLACES the retired `writeEvaluatorArtifact` assembler. The Evaluator is cast
 * INDEPENDENTLY of the Builder (own agent identity + session), records separate
 * `delta:role_resolved`/`delta:role_started` facts, runs READ-ONLY (no product
 * write roots), and must AUTHOR its own `eval-report.md` (`## Inputs checked` +
 * `## Rationale`) plus a v2 evaluator manifest. Score/attest fields alone can
 * NEVER produce the report — the runner only VALIDATES what an Evaluator wrote.
 *
 * Fail-closed (block reason `identity_collision` / `artifact_invalid`):
 *  - no independently cast Evaluator (`resolveEvaluator` null/unresolved);
 *  - the Evaluator's `sessionId` OR `roleInstanceId` equals the Builder's
 *    (a same-session evaluation is a self-grade);
 *  - the required role facts cannot be recorded;
 *  - no structurally-valid authored report is produced (a legacy ASSEMBLED
 *    report, a peer-only artifact, or a missing report all fail closed).
 */
export async function runEvaluatorStage(
  ports: Ports,
  ctx: CycleContext,
  deps: EvaluatorStageDeps = {},
): Promise<{
  ran: boolean;
  ok: boolean;
  reasons: readonly string[];
  blockReason?: "identity_collision" | "artifact_invalid";
  evaluatorAgent?: string;
  evaluatorSessionId?: string;
}> {
  if (ctx.selectedProfile !== "verified" && ctx.selectedProfile !== "designed") {
    return { ran: false, ok: true, reasons: [] };
  }
  const storyId = ctx.storyId ?? "";
  const runDir = ctx.evidenceRunDir ?? "";
  if (storyId === "" || runDir === "") {
    return { ran: false, ok: false, reasons: ["no story id / run dir for evaluator stage"], blockReason: "artifact_invalid" };
  }

  // AC3: resolve the Evaluator INDEPENDENTLY (scope role `evaluate`). A missing
  // scoped config, a non-`evaluate` scope role, or an unresolved binding all fail
  // closed here — the Builder is NEVER reused as the Evaluator.
  const installed = ports.installedAgents?.();
  const installedSet = installed === undefined
    ? undefined
    : new Set(installed.map((agent) => canonicalAgentName(agent) as AgentName));
  const resolveEvaluator = deps.resolveEvaluator ?? ((repoCwd: string) => defaultResolveEvaluator(repoCwd, installedSet));
  const resolved = resolveEvaluator(ports.repoCwd);
  if (resolved === null) {
    return {
      ran: false,
      ok: false,
      reasons: ["evaluator stage: no scoped agents.yaml evaluate binding — Full Delta requires an independently cast Evaluator (no fallback to the Builder agent)"],
      blockReason: "artifact_invalid",
    };
  }
  if (!resolved.ok || resolved.agent === undefined || resolved.agent === "") {
    return { ran: false, ok: false, reasons: [`evaluator stage: ${resolved.error ?? "evaluate role unresolved"}`], blockReason: "artifact_invalid" };
  }
  const evaluatorAgent = resolved.agent;

  const dir = join(runDir, "role-artifacts", "evaluator");
  const reportPath = join(dir, "eval-report.md");
  const manifestPath = join(dir, "artifact-manifest.json");
  const evaluatorSessionId = `${ctx.cycleId ?? "cycle"}:evaluate:${evaluatorAgent}:${ports.clock()}`;
  const roleInstanceId = `${ctx.cycleId ?? "cycle"}:evaluator:${evaluatorAgent}`;
  const delegationId = ctx.cycleId ?? "cycle";
  const hostId = deps.hostId ?? hostname();
  const modelId = resolved.model !== undefined && resolved.model !== "" ? resolved.model : evaluatorAgent;
  const execCwd = resolveExecutionCwd(ports, ctx);

  // AC4 (identity_collision): the Evaluator's opaque sessionId must differ from
  // the Builder's — a same-session evaluation is a self-grade, rejected BEFORE any
  // spawn. `ctx.builderSessionId` is the loop's ACTUAL builder identity token
  // (`<cycle>:build:<agent>:<clock>`, minted in spawn-agent-handler). The loop
  // exposes no separate builder roleInstanceId, so the sessionId inequality IS the
  // real independence signal (a builder/evaluator roleInstanceId literal compare
  // could never fire — dropped rather than kept as dead code).
  const builderSessionId = ctx.builderSessionId ?? "";
  if (builderSessionId !== "" && evaluatorSessionId === builderSessionId) {
    return {
      ran: false,
      ok: false,
      reasons: [`evaluator stage: evaluator sessionId equals builder sessionId ('${evaluatorSessionId}') — a same-session evaluation is a self-grade`],
      blockReason: "identity_collision",
      evaluatorAgent,
    };
  }

  // AC3: record SEPARATE role-resolution and role-start facts for the Evaluator
  // BEFORE the stage runs. REQUIRED audit facts (not best-effort): a failure to
  // record them FAILS CLOSED so no unauditable evaluation can gate delivery.
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "delta:role_resolved",
      delegationId,
      storyId,
      role: "evaluator",
      roleInstanceId,
      hostId,
      modelId,
      source: resolved.source,
      reasons: [...resolved.reasons],
      inventorySha256: "",
      inventoryObservedAt: new Date(eventTs(ports)).toISOString(),
      ts: eventTs(ports),
    });
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "delta:role_started",
      delegationId,
      storyId,
      role: "evaluator",
      sessionId: evaluatorSessionId,
      roleInstanceId,
      hostId,
      modelId,
      identityProvenance: "adapter-observed",
      // AC3: the Evaluator runs READ-ONLY — only the Builder gets write roots.
      worktreeAccess: "read-only",
      ts: eventTs(ports),
    });
  } catch (e) {
    return {
      ran: false,
      ok: false,
      reasons: [`evaluator stage: could not record required role facts (delta:role_resolved/role_started) — fail closed: ${e instanceof Error ? e.message : String(e)}`],
      blockReason: "artifact_invalid",
      evaluatorAgent,
    };
  }

  // The Evaluator must AUTHOR the report in THIS run. We ALWAYS spawn (no
  // existsSync skip) and DELETE any pre-existing report + manifest first, so a
  // planted/assembled artifact can never satisfy the gate by pre-existing — only
  // a file the real Evaluator wrote this cycle survives to validation.
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(reportPath, { force: true });
    rmSync(manifestPath, { force: true });
    // The evaluator sub-spawn goes through the shared watchdog (evaluator
    // role cap). READ-ONLY on the product worktree; its ONLY writable root is
    // its own artifact dir — it authors the report but cannot touch product
    // code. FIX-1482: read-only is ENFORCED OR REFUSED — a readOnly Evaluator
    // spawn on a non-enforcing adapter fails loud at the spawn boundary, so this
    // only runs when the Evaluator is cast on codex or reasonix.
    await spawnWatched({
      ports,
      ctx,
      purpose: "evaluator",
      agent: evaluatorAgent,
      observeCwd: execCwd,
      run: () =>
        ports.agentSpawn(evaluatorAgent, {
          cwd: execCwd,
          skillBody: buildEvaluatorPrompt(storyId, reportPath),
          storyId,
          runDir: dir,
          readOnly: true,
          writableRoots: [dir],
        }),
    });
  } catch {
    /* an evaluator spawn blip -> no report -> validation below fails closed */
  }

  // AC3: the Evaluator's OWN v2 manifest (role="evaluator", read-only access).
  const manifest: DeltaArtifactManifest = {
    schemaVersion: 2,
    delegationId,
    storyId,
    cycleId: ctx.cycleId ?? "",
    role: "evaluator",
    trigger: "loop-autonomous",
    topology: "full-delta-team",
    qualityProfile: ctx.selectedProfile,
    executionIdentity: {
      kind: "roll-adapter",
      hostId,
      roleInstanceId,
      modelId,
      adapter: evaluatorAgent,
    },
    sessionId: evaluatorSessionId,
    worktreeAccess: "read-only",
    // AC5: the optional peer review is an INPUT only — it never stands in for the
    // Evaluator's own authored output.
    inputs: [
      { path: `${storyId}-report.html`, kind: "report" },
      { path: "ac-map.json", kind: "evidence" },
    ],
    outputs: [{ path: "role-artifacts/evaluator/eval-report.md", kind: "report" }],
    createdAt: new Date(eventTs(ports)).toISOString(),
  };
  // VALIDATE (never assemble) the ON-DISK artifacts, not the in-memory objects.
  // A write failure, an absent/unparseable manifest, a non-evaluator manifest,
  // or a report that is not a REAL authored evaluation (## Inputs checked +
  // ## Rationale — a legacy assembled or peer-only artifact is rejected) all
  // FAIL CLOSED. The manifest is re-read from disk so a swallowed write error or
  // corrupted file cannot masquerade as a valid evaluation.
  const reasons: string[] = [];
  let wrote = true;
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (e) {
    wrote = false;
    reasons.push(`evaluator manifest could not be written: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (wrote) {
    let onDisk: unknown;
    try {
      onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      onDisk = undefined;
    }
    if (typeof onDisk !== "object" || onDisk === null) {
      reasons.push("evaluator manifest missing or unparseable on disk");
    } else {
      const m = onDisk as Partial<DeltaArtifactManifest>;
      if (m.role !== "evaluator") {
        reasons.push(`evaluator manifest role '${String(m.role)}' ≠ 'evaluator'`);
      } else if (!Array.isArray(m.inputs)) {
        reasons.push("evaluator manifest missing inputs array on disk");
      } else {
        const access = validateRoleAccess(m as DeltaArtifactManifest);
        if (!access.ok) reasons.push(access.detail ?? "evaluator manifest role-access violation");
      }
    }
  }
  const reportMd = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  const rep = validateAuthoredEvalReport(reportMd);
  reasons.push(...rep.reasons);
  const ok = reasons.length === 0;
  return {
    ran: true,
    ok,
    reasons,
    ...(ok ? {} : { blockReason: "artifact_invalid" as const }),
    evaluatorAgent,
    evaluatorSessionId,
  };
}

export function routerEstMin(worktreeCwd: string, storyId: string, backlogDesc: string): number | undefined {
  try {
    const specPath = storySpecPath(worktreeCwd, storyId);
    if (specPath !== null && existsSync(specPath)) {
      const fromSpec = parseEstMinFromSpec(readFileSync(specPath, "utf8"));
      if (fromSpec !== undefined) return fromSpec;
    }
  } catch {
    /* spec read/parse is an optimization — never topple routing on it */
  }
  return parseEstMin(backlogDesc);
}
