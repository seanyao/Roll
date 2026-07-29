/**
 * Agent spawn port — the EXECUTION glue between the orchestrator's
 * `{ kind: "spawn_agent" }` command and a real agent process (US-LOOP runner
 * adapter, prerequisite for US-LOOP-006).
 *
 * ── Why this lives in @roll/cli, not @roll/infra ─────────────────────────────
 * The runner adapter dispatches @roll/core's {@link CycleCommand} vocabulary
 * using @roll/infra's executors. The package arrow is one-directional
 * (core→spec, infra→spec, cli→{core,infra,spec}); infra must NOT import core, so
 * the only package that can see BOTH the command language and the executors is
 * the cli. The agent-spawn argv construction is part of that adapter and lives
 * here alongside it. (See runner/executor.ts for the full justification.)
 *
 * ── v2 oracle: how the loop builds the claude argv ───────────────────────────
 * The frozen bash builds the per-cycle agent command at RUNTIME, routing-aware:
 *   - `_agent_argv claude plain "$prompt"`           (bin/roll:4525-4530)
 *       claude plain mode → `claude -p "<prompt>"`.
 *   - `_agent_skill_cmd` / `_loop_cycle_agent_cmd`   (bin/roll:9762-9810)
 *       splices the claude-only loop enhancements onto that base:
 *         `claude -p` → `claude -p --verbose --dangerously-skip-permissions
 *                        --output-format stream-json --add-dir "<wt>"`
 *       and prepends the FIX-152 autonomous-execution directive ahead of the
 *       stripped SKILL.md body as the single positional prompt arg.
 *   - the agent runs WITH CWD = the worktree (`WT`), where it makes its TCR
 *     commits; stdout is piped through loop-fmt.py (display-only, bin/roll:8359)
 *     — the runner does not depend on loop-fmt, it captures raw stdout for the
 *     cost/usage parse (cost/tracker.ts).
 *
 * {@link buildClaudeArgv} reproduces that argv construction for the `claude`
 * agent (harness — roll runs inside Claude Code; claude is not a pool agent but
 * powers the harness reviewer/cost path). Other agents have their own
 * `_agent_argv` shapes and loop enhancements
 * that DIFFER (only claude gets the stream-json / --add-dir splice); porting each
 * is deferred
 * — see {@link AGENT_ARGV_TODO}. The integration tests use a SHIM `claude` on
 * PATH (a fake binary that makes a `tcr:` commit in the worktree), so no real
 * agent ever runs in tests.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Rig, WorkspaceExecutionContextV1 } from "@roll/spec";
import {
  prepareRegisteredWorkspaceSkillHandoff,
  workspaceSkillHandoffEnvironment,
} from "./workspace-skill-handoff.js";
import { getAgentSpec } from "@roll/core";
import { worktreeGitDiscoveryEnv } from "./main-checkout-guard.js";
import { workspaceSelectorArgs } from "../lib/workspace-selector.js";

/**
 * FIX-204D — live-children registry. The signal teardown must kill an
 * in-flight agent BEFORE the runner dies: a TERM'd run-once whose claude
 * child survives keeps editing the worktree headless (and the next cycle's
 * preflight would meet a haunted checkout).
 */
const liveAgents = new Set<ChildProcess>();

/** Kill every registered in-flight agent. Returns how many were signalled. */
export function killLiveAgents(signal: NodeJS.Signals = "SIGKILL"): number {
  let n = 0;
  for (const c of liveAgents) {
    try {
      if (killHard(c, signal)) n += 1;
    } catch {
      /* already gone */
    }
  }
  liveAgents.clear();
  return n;
}

/**
 * FIX-224: kill the child's whole process GROUP when it leads one (the
 * PTY-wrapped `script` child is spawned detached, so SIGKILLing only `script`
 * would orphan the agent underneath — the exact haunted-worktree scenario
 * FIX-204D exists to prevent). Non-detached children share the runner's group
 * (pgid ≠ pid), so the group signal throws and we fall back to the plain kill.
 */
function killHard(c: ChildProcess, signal: NodeJS.Signals): boolean {
  if (c.pid !== undefined) {
    try {
      process.kill(-c.pid, signal);
      return true;
    } catch {
      /* not a group leader — plain child kill below */
    }
  }
  return c.kill(signal);
}

/** The FIX-152 autonomous-execution directive prepended to the skill body
 *  (bin/roll:9791). Kept byte-identical so the shim/real argv match the oracle. */
export const AUTORUN_DIRECTIVE =
  "[roll 自主模式] 你正在无人值守的自动化循环中运行,这不是对话。请立即、完整地执行下面这份技能文档描述的工作流,直到完成交付或写出 ALERT 为止;严禁反问、严禁等待确认、严禁只复述或总结而不动手。技能文档如下: ";

/**
 * Agents whose loop argv construction is NOT yet ported by the runner adapter.
 * The orchestrator can route to any of these (router.ts is agent-agnostic), but
 * only `claude` has its full loop-enhanced argv reproduced here today. Each entry
 * documents the v2 `_agent_argv` base shape (bin/roll:4531-4581) so the next
 * agent is a one-function add. Routing to a stubbed agent throws a loud error
 * (NEVER a silent no-op) so the parallel-verification protocol surfaces the gap.
 */
export const AGENT_ARGV_TODO: Record<string, string> = {};

export interface SpawnCommand {
  bin: string;
  args: string[];
}

export interface AgentProfile {
  name: string;
  buildSpawnCommand(opts: AgentSpawnOptions): SpawnCommand;
  usesWorkspaceSandbox: boolean;
  ptyWhenPiped: boolean;
  acceptance: {
    canReviewHeadless: boolean;
  };
  secretEnv?: readonly string[];
  childEnv?(home?: string): Record<string, string>;
  /** FIX-1482: when true, this adapter TRULY enforces a `readOnly` spawn at the OS
   *  level — codex via `--sandbox read-only`, reasonix via its generated Seatbelt
   *  reasonix.toml. Only enforcing adapters may run a `readOnly:true` spawn; the
   *  spawn boundary ({@link assertReadOnlyEnforceable}) fails LOUD for any other
   *  adapter rather than silently running an advisory-only (prompt + no product
   *  write roots) pseudo-read-only. Deliberately distinct from
   *  {@link usesWorkspaceSandbox} — reasonix enforces readOnly but does NOT use a
   *  workspace-write sandbox (it writes a per-cycle Seatbelt config instead). */
  enforcesReadOnly?: boolean;
  /** FIX-1231: when true, the child gets NO git env vars (GIT_DIR/GIT_WORK_TREE
   *  etc.) and GIT_CEILING_DIRECTORIES is set to block git repo discovery from
   *  the CWD. Use for agents (codex) whose internal git mechanisms write refs and
   *  config to the host repo, poisoning the shared checkout. */
  isolateGit?: boolean;
}

/**
 * FIX-204B — the story-pin directive. The executor picks + claims the story
 * (pick_story marks 🔨 in the MAIN repo's backlog) BEFORE the agent spawns;
 * without this segment the agent re-picks from whatever backlog it can find
 * (2026-06-06 first live run: skill body was empty AND the agent free-styled —
 * a second, unsanctioned pick). One cycle = one scheduler-locked story.
 */
export function storyPinDirective(storyId: string): string {
  return (
    `[本周期指定故事] 调度器已锁定 ${storyId} 并在 backlog 标记 🔨 In Progress——` +
    `只执行这一个故事,严禁重新挑选或顺手做别的;若它确实不可执行,写 ALERT 说明原因后干净退出。\n\n`
  );
}

/** Inputs for {@link buildClaudeArgv}: the worktree dir + the prompt body. */
export interface ClaudeArgvInput {
  /** The agent's cwd / `--add-dir` target — the cycle worktree (`WT`). */
  worktree: string;
  /** The skill-document body (already stripped of frontmatter by the caller).
   *  The autorun directive is prepended here, mirroring _agent_skill_cmd. */
  skillBody: string;
  /** FIX-204B: the executor-picked story — pinned into the prompt so the agent
   *  executes exactly this story (absent ⇒ legacy prompt, byte-identical to
   *  the v2 oracle shape). */
  storyId?: string;
  /** The claude binary (resolved path or "claude"); tests inject the shim name. */
  bin?: string;
  /** FIX-220: when the user manually triggers `roll loop now`, the terminal is
   *  interactive — drop --verbose and --output-format stream-json so the
   *  output is human-readable instead of a JSON flood. */
  interactive?: boolean;
  /** FIX-319: a BARE spawn sends `skillBody` verbatim — NO autorun directive, NO
   *  story pin. Used for the heterogeneous PEER REVIEWER: a reviewer must NOT get
   *  the worker directive ("complete the delivery, don't just summarize, do the
   *  work") — that mis-frames it as a builder so it tries to deliver instead of
   *  returning a terse VERDICT (and may mutate the worktree). The review prompt
   *  itself carries the reviewer framing. */
  bare?: boolean;
}

/**
 * Build the claude loop-cycle argv, mirroring `_loop_cycle_agent_cmd` +
 * `_agent_skill_cmd` + `_agent_argv claude plain` (bin/roll:4525-4530 /
 * 9768-9809). Returns argv WITHOUT the binary at [0] folded into args — the
 * caller spawns `bin` with these args.
 *
 *   claude -p "<autorun + skill body>" --verbose --dangerously-skip-permissions
 *          --output-format stream-json --add-dir <wt>
 *
 * The prompt binds directly to `-p` (NOT trailing after `--add-dir <wt>`):
 * `--add-dir` is variadic in claude CLI ≥2.1.x and swallows a trailing prompt
 * ("Input must be provided either through stdin or as a prompt argument"), so a
 * prompt-last argv is a live bug against current claude.
 */
export function buildClaudeArgv(input: ClaudeArgvInput): { bin: string; args: string[] } {
  const bin = input.bin ?? "claude";
  // FIX-204B: the pin rides BETWEEN the autorun directive and the skill body —
  // AUTORUN_DIRECTIVE itself stays byte-identical to the oracle; a cycle with
  // no picked story (undefined) produces the exact pre-204 prompt.
  const pin = input.storyId !== undefined && input.storyId !== "" ? storyPinDirective(input.storyId) : "";
  // FIX-319: a bare (peer-reviewer) spawn sends the body verbatim — no worker
  // autorun directive, no story pin — so the reviewer is framed only by its own
  // review prompt, not told to "complete the delivery".
  const prompt = input.bare === true ? input.skillBody : `${AUTORUN_DIRECTIVE}${pin}${input.skillBody}`;
  // FIX-220: manual `roll loop now` runs in an interactive terminal — strip
  // --verbose and --output-format stream-json so the user sees plain text
  // instead of a JSON flood. Cost tracking is best-effort on this path.
  const args = input.interactive
    ? ["-p", prompt, "--dangerously-skip-permissions", "--add-dir", input.worktree]
    : [
        "-p",
        prompt,
        "--verbose",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--add-dir",
        input.worktree,
      ];
  return { bin, args };
}

function agentPrompt(opts: AgentSpawnOptions): string {
  return opts.bare === true
    ? opts.skillBody
    : `${AUTORUN_DIRECTIVE}${opts.storyId !== undefined && opts.storyId !== "" ? storyPinDirective(opts.storyId) : ""}${opts.skillBody}`;
}

function tomlBasicString(value: string): string {
  return JSON.stringify(value);
}

function normalizeWritableRoots(roots: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const root of roots ?? []) {
    const trimmed = root.trim();
    if (trimmed === "") continue;
    const normalized = existsSync(trimmed) ? realpathSafe(trimmed) : trimmed;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function writableRootsForSpawn(opts: AgentSpawnOptions): string[] {
  if (opts.purpose === "pick_ranking") return [];
  return normalizeWritableRoots(opts.writableRoots);
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function stripSandboxTable(toml: string): string {
  const lines = toml.split("\n");
  const kept: string[] = [];
  let droppingSandbox = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (table !== null) {
      const name = table[1]?.trim() ?? "";
      droppingSandbox = name === "sandbox" || name.startsWith("sandbox.");
    }
    if (!droppingSandbox) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

function reasonixSandboxBlock(roots: readonly string[]): string {
  const list = roots.map(tomlBasicString).join(", ");
  return ["[sandbox]", 'bash = "enforce"', "network = true", `allow_write = [${list}]`, ""].join("\n");
}

function chainCleanup(existing: (() => void) | undefined, next: () => void): () => void {
  return () => {
    try {
      next();
    } finally {
      existing?.();
    }
  };
}

function writeReasonixSandboxConfig(cwd: string, roots: readonly string[]): () => void {
  const configPath = join(cwd, "reasonix.toml");
  const hadConfig = existsSync(configPath);
  const previous = hadConfig ? readFileSync(configPath, "utf8") : "";
  const base = hadConfig ? stripSandboxTable(previous) : "";
  const next = `${base !== "" ? `${base}\n\n` : ""}${reasonixSandboxBlock(roots)}`;
  writeFileSync(configPath, next, "utf8");
  return () => {
    if (hadConfig) {
      writeFileSync(configPath, previous, "utf8");
      return;
    }
    try {
      unlinkSync(configPath);
    } catch {
      /* already gone */
    }
  };
}

function canonicalProfileName(name: string): string {
  const raw = name.trim().toLowerCase();
  const spec = getAgentSpec(raw);
  if (spec !== undefined) return spec.name;
  return raw;
}

/**
 * Build a simple-prompt profile (pi/kimi shapes). `modelFlag`, when the
 * agent's CLI accepts an explicit model, is PREPENDED to the prompt argv as the
 * native flag pair (pi: `--model <m>`, kimi: `-m <m>`) ONLY when a non-empty
 * routed model is present — absent ⇒ no flag, the agent uses its own default.
 * The model string is the agent's NATIVE `--model` value, including any
 * `:thinking` effort suffix (e.g. `deepseek/deepseek-v4-pro:high`); it is passed
 * through verbatim as ONE argv token.
 */
function simplePromptProfile(
  name: string,
  bin: string,
  args: (prompt: string) => string[],
  modelFlag?: string,
): AgentProfile {
  return {
    name,
    usesWorkspaceSandbox: false,
    ptyWhenPiped: true,
    acceptance: { canReviewHeadless: getAgentSpec(name)?.canReviewHeadless === true },
    buildSpawnCommand: (opts) => {
      const model = opts.model?.trim();
      const modelArgs = modelFlag !== undefined && model !== undefined && model !== "" ? [modelFlag, model] : [];
      return { bin: opts.bin ?? bin, args: [...modelArgs, ...args(agentPrompt(opts))] };
    },
  };
}

const AGENT_PROFILES: Readonly<Record<string, AgentProfile>> = {
  claude: {
    name: "claude",
    usesWorkspaceSandbox: false,
    ptyWhenPiped: false,
    acceptance: { canReviewHeadless: getAgentSpec("claude")?.canReviewHeadless === true },
    buildSpawnCommand: (opts) =>
      buildClaudeArgv({
        worktree: opts.cwd,
        skillBody: opts.skillBody,
        ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
        bin: opts.bin,
        interactive: opts.interactive,
        ...(opts.bare === true ? { bare: true } : {}),
      }),
  },
  // pi `--model "provider/id:thinking"` (the `:thinking` suffix folds the
  // thinking-effort into the model string — no separate effort field).
  pi: simplePromptProfile("pi", "pi", (prompt) => ["-p", prompt], "--model"),
  // kimi `-m <model>` / `--model <model>` (use the short form). Stream events
  // keep the runner's activity monitor informed while Kimi performs tool work.
  kimi: simplePromptProfile("kimi", "kimi", (prompt) => ["-p", prompt, "--output-format", "stream-json"], "-m"),
  codex: {
    name: "codex",
    usesWorkspaceSandbox: true,
    // FIX-1482: codex OS-enforces readOnly via `--sandbox read-only` (below).
    enforcesReadOnly: true,
    ptyWhenPiped: false,
    acceptance: { canReviewHeadless: getAgentSpec("codex")?.canReviewHeadless === true },
    /** FIX-1231: codex's internal curated-sync / turn-diffs mechanism writes
     *  refs (refs/codex/*) and git config (core.worktree) to the CWD's git
     *  repo, poisoning the host checkout. Isolate its git access. */
    isolateGit: true,
    buildSpawnCommand: (opts) => {
      // US-DELTA-006: a read-only spawn (e.g. the Full Delta Designer) runs under
      // codex's `read-only` sandbox so it CANNOT write product code; the explicit
      // `--add-dir` roots below (its own artifact dir) stay writable. A normal
      // Builder keeps `workspace-write`.
      const sandboxMode = opts.readOnly === true ? "read-only" : "workspace-write";
      const args = ["exec", "--skip-git-repo-check", "--sandbox", sandboxMode];
      // FIX-1065: sandboxed PR-heal agents need write access to the linked
      // worktree gitdir (and any other explicitly-granted roots) even though it
      // lives outside the workspace. Pass each root as --add-dir. For a read-only
      // spawn these are the ONLY writable paths (e.g. the Designer's artifact dir).
      for (const root of writableRootsForSpawn(opts)) {
        args.push("--add-dir", root);
      }
      const prompt = agentPrompt(opts);
      return { bin: opts.bin ?? "codex", args: [...args, prompt] };
    },
  },
  // FIX-1056: agy needs an EXPLICIT runtime adapter, not the generic
  // simplePromptProfile — the generic profile drops the authenticated runtime
  // context, so agy's headless (launchd) child could not see the owner's
  // once-authenticated auth-context home and emitted `agent:blocked cause=auth`
  // even after an interactive login. The argv shape (`agy -p <prompt>`) and PTY
  // behaviour are unchanged; the only addition is `childEnv: agyEnv`, which
  // resolves the SAME auth-context dir the interactive CLI uses (from the owner's
  // real home, not launchd's sanitized $HOME) and forwards it via AGY_CONFIG_DIR.
  agy: {
    name: "agy",
    usesWorkspaceSandbox: false,
    ptyWhenPiped: true,
    acceptance: { canReviewHeadless: getAgentSpec("agy")?.canReviewHeadless === true },
    buildSpawnCommand: (opts) => ({ bin: opts.bin ?? "agy", args: ["-p", agentPrompt(opts)] }),
    childEnv: agyEnv,
  },
  reasonix: {
    name: "reasonix",
    usesWorkspaceSandbox: false,
    // FIX-1482: reasonix OS-enforces readOnly via its own Seatbelt sandbox — the
    // per-cycle reasonix.toml (writeReasonixSandboxConfig) limits writes to the
    // explicit writableRoots. usesWorkspaceSandbox stays false (it is NOT a
    // codex-style workspace-write sandbox), so enforcesReadOnly is tracked
    // separately.
    enforcesReadOnly: true,
    ptyWhenPiped: true,
    acceptance: { canReviewHeadless: getAgentSpec("reasonix")?.canReviewHeadless === true },
    secretEnv: ["DEEPSEEK_API_KEY"],
    buildSpawnCommand: (opts) => {
      // FIX-1249: reasonix's model is CONFIG-DRIVEN — the source no longer holds
      // a runtime default (the old `routedModel ?? getAgentSpec(...).defaultModel
      // ?? "deepseek-flash"` silently masked a missing config). The router
      // resolves the model from agents.yaml (rigs/routing) and the config-rig
      // backstop covers pool picks, so a configured model reaches `--model`.
      // When NO model is configured we OMIT `--model` and let reasonix use its
      // own CLI default — exactly like pi/kimi — never a source-baked value. The
      // missing config is surfaced (fail-loud + guidance) at the readiness/
      // doctor layer ({@link modelConfigGuidance}), not by crashing the spawn.
      const routedModel = opts.model?.trim();
      const modelArgs = routedModel !== undefined && routedModel !== "" ? ["--model", routedModel] : [];
      const maxSteps = opts.maxSteps ?? 1000;
      // FIX-1036: write a per-cycle reasonix.toml so the Seatbelt sandbox
      // allows writes to the git common dir (outside the worktree root).
      // The file is cleaned up via opts.cleanup after the child exit.
      // FIX-1482: a `readOnly` spawn MUST always write the restrictive
      // `[sandbox]` block (bash=enforce, allow_write limited to the explicit
      // roots — EMPTY ⇒ nothing writable = fully read-only), even when no extra
      // roots were granted. Otherwise a readOnly reasonix spawn with empty
      // writableRoots would skip the config and fall back to reasonix's default
      // (possibly unsandboxed), silently defeating the enforcesReadOnly claim.
      const roots = writableRootsForSpawn(opts);
      if (roots.length > 0 || opts.readOnly === true) {
        opts.cleanup = chainCleanup(opts.cleanup, writeReasonixSandboxConfig(opts.cwd, roots));
      }
      return {
        bin: opts.bin ?? "reasonix",
        args: ["run", "--max-steps", String(maxSteps), ...modelArgs, "--dir", opts.cwd, agentPrompt(opts)],
      };
    },
    childEnv: reasonixEnv,
  },
  // US-AGENT-048: Cursor headless Builder adapter. Uses `--workspace` (not
  // Cursor's own `--worktree`) so Roll retains cycle-worktree ownership.
  // Day-one stdout carries no parseable token/cost footer, so usage records
  // "?" via the explicit null extractor in cost/tracker.ts.
  cursor: {
    name: "cursor",
    usesWorkspaceSandbox: false,
    ptyWhenPiped: true,
    acceptance: { canReviewHeadless: getAgentSpec("cursor")?.canReviewHeadless === true },
    buildSpawnCommand: (opts) => ({
      bin: opts.bin ?? "cursor-agent",
      args: [
        "--print",
        "--trust",
        "--force",
        ...workspaceSelectorArgs(opts.cwd),
        "--output-format",
        "text",
        agentPrompt(opts),
      ],
    }),
  },
};

export function agentProfileNames(): string[] {
  return Object.keys(AGENT_PROFILES);
}

export function agentSecretEnvNames(agents: readonly string[] = agentProfileNames()): string[] {
  const names = new Set<string>();
  for (const agent of agents) {
    const profile = AGENT_PROFILES[canonicalProfileName(agent)];
    for (const name of profile?.secretEnv ?? []) names.add(name);
  }
  return [...names].sort();
}

export interface AgentCredentialReadiness {
  agent: string;
  requiredEnv: string[];
  missingEnv: string[];
  ok: boolean;
}

export function agentProfile(name: string): AgentProfile {
  const canonical = canonicalProfileName(name);
  const profile = AGENT_PROFILES[canonical];
  if (profile !== undefined) return profile;
  const hint = AGENT_ARGV_TODO[canonical] ?? "unknown agent";
  throw new Error(`runner: agent '${name}' argv not yet ported. v2 shape: ${hint}`);
}

export function agentSpawnEnvironment(agent: string, home?: string): Record<string, string> {
  const profile = AGENT_PROFILES[canonicalProfileName(agent)];
  return profile?.childEnv?.(home) ?? {};
}

export function agentCredentialReadiness(
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): AgentCredentialReadiness {
  const canonical = canonicalProfileName(agent);
  const profile = AGENT_PROFILES[canonical];
  const requiredEnv = [...(profile?.secretEnv ?? [])];
  const profileEnv = profile?.childEnv?.(home) ?? {};
  const missingEnv = requiredEnv.filter((name) => {
    const ambient = (env[name] ?? "").trim();
    const profileValue = (profileEnv[name] ?? "").trim();
    return ambient === "" && profileValue === "";
  });
  return { agent: canonical, requiredEnv, missingEnv, ok: missingEnv.length === 0 };
}

export function missingAgentSecretEnv(
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string[] {
  return agentCredentialReadiness(agent, env, home).missingEnv;
}

export type AgentSpawnPurpose = "builder" | "pick_ranking" | "test_author" | "implementer" | "attacker";

export interface WorkspaceSkillInvocation {
  readonly skillName: string;
  readonly operation: string;
  readonly expectedWorkspaceId?: string;
  readonly expectedStoryId?: string;
  readonly repositorySelector?: string;
  readonly machineCwd?: string;
  readonly legacyProjectRoot?: string;
}

const REGISTERED_WORKSPACE_SKILL_ENV: unique symbol = Symbol("registeredWorkspaceSkillEnv");
type RegisteredWorkspaceSkillSpawnOptions = AgentSpawnOptions & {
  readonly [REGISTERED_WORKSPACE_SKILL_ENV]?: NodeJS.ProcessEnv;
};

export function adversarialRolePrompt(role: "test_author" | "implementer" | "attacker"): string {
  switch (role) {
    case "test_author":
      return "You are the test author. Write failing red tests from the AC acceptance contract; do not write production code and do not read the implementation.";
    case "implementer":
      return "You are the implementer. Write only production code to make the failing tests pass; do not modify, edit, touch, or change any test files.";
    case "attacker":
      return "You are the attacker. Add only new breaking tests, each targeting one untested failure mode; do not edit or modify existing tests or production code.";
    default: {
      const exhaustive: never = role;
      throw new Error(`adversarialRolePrompt: unknown role ${String(exhaustive)}`);
    }
  }
}

/** Options for an {@link AgentSpawn} call. */
export interface AgentSpawnOptions {
  /** Explicit call-site intent so harness-only spawns are distinguishable from builder work. */
  purpose?: AgentSpawnPurpose;
  /** US-PORT-011: live sink — called with every raw stdout/stderr chunk as it
   *  arrives (the observation window tails the file this feeds). */
  onChunk?: (chunk: Buffer) => void;
  /** The agent's working directory — the cycle worktree. */
  cwd: string;
  /** The skill-document body to drive the agent with. */
  skillBody: string;
  /** FIX-204B: the executor-picked story id, pinned into the prompt. */
  storyId?: string;
  /** US-WS-033: the frozen invocation authority. The child receives this exact
   * serializable snapshot; it must not rediscover Workspace/Issue from cwd. */
  workspaceExecution?: WorkspaceExecutionContextV1;
  /** US-WS-038: operation identity for a supporting-skill spawn. The real
   * spawn resolves its authority policy from the shipped registry; callers
   * cannot self-report scope/access/effect target. */
  workspaceSkillInvocation?: WorkspaceSkillInvocation;
  /** Hard wall-clock kill after this many ms (the watchdog also enforces this at
   *  the orchestrator layer; this is the spawn-local belt-and-braces). */
  timeoutMs?: number;
  /** Override the claude binary (tests inject the shim). */
  bin?: string;
  /** Extra env for the child (tests inject PATH with the shim dir prepended). */
  env?: NodeJS.ProcessEnv;
  /** Test seam for agent-profile env readers; production uses the OS home dir. */
  agentEnvHome?: string;
  /** US-EVID-001: explicit evidence frame for this child; overrides ambient env. */
  runDir?: string;
  /** Extra writable roots for agents with an explicit workspace sandbox. (No
   *  current pool agent declares one; retained for a future sandboxed engine.) */
  writableRoots?: string[];
  /** US-DELTA-006: run the spawn READ-ONLY on its cwd. Sandbox-capable adapters
   *  (codex → `--sandbox read-only`; reasonix/Seatbelt → writes limited to
   *  `writableRoots`) then cannot write product code — only the explicitly
   *  granted `writableRoots` (e.g. the Designer's own artifact dir) stay
   *  writable. Used for the Full Delta Designer/Evaluator so only the Builder
   *  gets product worktree write access. */
  readOnly?: boolean;
  /** Routed model, consumed by agent profiles whose CLI accepts an explicit model. */
  model?: string;
  /** The resolved agent×model assignment; kept alongside legacy fields while call sites migrate. */
  rig?: Rig;
  /** Agent-local autonomous step budget for CLIs that expose one. */
  maxSteps?: number;
  /** FIX-220: when the user manually triggers `roll loop now`, drop --verbose
   *  and --output-format stream-json for a human-readable terminal. */
  interactive?: boolean;
  /** FIX-319: bare spawn — send `skillBody` verbatim (no autorun directive / no
   *  story pin). Used for the heterogeneous peer reviewer (review-only framing). */
  bare?: boolean;
  /** Optional cleanup callback invoked once after the child exits. Used to
   *  remove per-spawn artifacts (e.g. reasonix sandbox config in the worktree). */
  cleanup?: () => void;
  /** FIX-1474: observer seam — invoked once, synchronously, right after the
   *  child process is spawned, so the runner's liveness probe can watch the
   *  real pid. Best-effort: a throwing callback never fails the spawn. Fake
   *  spawns in tests may simply not call it (the probe stays inert). */
  onSpawn?: (child: ChildProcess) => void;
}

/** Result of an agent spawn — the orchestrator feeds `exitCode` back as
 *  `agent_exited`; `usage` (raw stdout) feeds cost/tracker.ts. */
export interface AgentSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True iff the spawn-local timeout killed the child (maps to `timedOut`). */
  timedOut: boolean;
}

/** The injectable agent-spawn port. Real impl below; tests pass a fake that
 *  fabricates a tcr commit in the worktree fixture without any real agent. */
export type AgentSpawn = ((
  agent: string,
  opts: AgentSpawnOptions,
) => Promise<AgentSpawnResult>) & {
  /** Optional capability declaration. Missing means only legacy builder semantics are known. */
  supportedPurposes?: readonly AgentSpawnPurpose[];
};

export function agentSpawnSupportsPurpose(spawn: AgentSpawn, purpose: AgentSpawnPurpose): boolean {
  return spawn.supportedPurposes?.includes(purpose) === true;
}

/**
 * Real agent spawn: build the argv for the resolved agent and run it via
 * `child_process.spawn`, capturing stdout/stderr and the exit code. Only
 * `claude` has its loop argv ported ({@link buildClaudeArgv}); any other agent
 * throws with the documented {@link AGENT_ARGV_TODO} hint (fail-loud, never a
 * silent skip — the parallel-verification protocol must see the gap).
 *
 * The child runs with CWD = the worktree, where the agent makes its TCR commits
 * (exactly as v2: the loop hands the agent the worktree and it commits inside).
 */
/**
 * FIX-1482 — the read-only ENFORCEMENT gate, evaluated at the single spawn
 * boundary every adapter passes through ({@link buildSpawnCommand}).
 *
 * US-DELTA-006 (#1500) introduced `readOnly` spawns for the Full Delta
 * Designer/Evaluator. Only SANDBOX-ENFORCING adapters actually jail product
 * writes at the OS level: codex (`--sandbox read-only`) and reasonix (its
 * generated Seatbelt reasonix.toml). For every other adapter (pi/kimi/agy/
 * cursor/claude) `readOnly` was merely ADVISORY — prompt framing + no granted
 * product write roots — with NO kernel block. Silently running that pseudo-
 * read-only would let a misconfigured read-only role write product code.
 *
 * So: a `readOnly:true` spawn whose resolved adapter does not enforce read-only
 * FAILS LOUD here (throws, naming the agent + the supported adapters) rather
 * than degrading to advisory. This satisfies FIX-1482 AC4 and reframes AC1/AC3
 * as "enforced OR refused" — never silently advisory.
 */
export function assertReadOnlyEnforceable(agent: string, opts: AgentSpawnOptions): void {
  if (opts.readOnly !== true) return;
  const profile = agentProfile(agent);
  if (profile.enforcesReadOnly === true) return;
  throw new Error(
    `readOnly isolation is not enforceable for agent '${profile.name}' — assign a sandbox-enforcing adapter (codex or reasonix) to read-only roles (Designer/Evaluator)`,
  );
}

/** Build the spawn argv for a resolved agent — exported for unit tests.
 *  FIX-1482: refuses (fail-loud) a `readOnly` spawn on a non-enforcing adapter. */
export function buildSpawnCommand(agent: string, opts: AgentSpawnOptions): { bin: string; args: string[] } {
  assertReadOnlyEnforceable(agent, opts);
  return agentProfile(agent).buildSpawnCommand(opts);
}

/**
 * FIX-224 (v2 `_AGENT_PTY_PREFIX`, FIX-136 lineage): non-claude agents
 * (pi/kimi/…) buffer their stdout when piped, blacking out the live
 * observation window (tmux watch / `roll loop now`) for the whole phase —
 * wrap them in `script -q /dev/null` so they see a PTY and stream line by
 * line. claude is never wrapped: its stream-json protocol runs on plain
 * pipes. Only darwin gets the wrap (BSD `script` takes the command as argv;
 * util-linux needs a single `-c` string — quote-splicing a multi-KB prompt
 * is a worse failure mode than buffered output).
 */
export function withPtyWrap(
  cmd: { bin: string; args: string[] },
  agent: string,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[]; pty: boolean } {
  if (!agentProfile(agent).ptyWhenPiped || platform !== "darwin") return { ...cmd, pty: false };
  return { bin: "script", args: ["-q", "/dev/null", cmd.bin, ...cmd.args], pty: true };
}

/**
 * FIX-359 — best-effort DeepSeek key injection for the `reasonix` worker.
 * reasonix reads its API key from the env var `DEEPSEEK_API_KEY` but does NOT
 * auto-load any dotfile; the owner keeps the key at `~/.reasonix/.env` (a
 * `KEY=VALUE` file, chmod 600). This helper reads that file at RUNTIME and
 * returns `{ DEEPSEEK_API_KEY }` ONLY if present (else `{}`), so the real spawn
 * layer can merge it into every reasonix child process.
 *
 * SECURITY: the value flows ONLY into the returned env object. It is NEVER
 * logged, echoed, printed, or written anywhere — do not add diagnostics that
 * surface this value. Any read/parse error degrades silently to `{}` (a
 * missing file is the common case and must never throw).
 */
export function reasonixEnv(home: string = homedir()): Record<string, string> {
  try {
    const raw = readFileSync(join(home, ".reasonix", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== "DEEPSEEK_API_KEY") continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value !== "") return { DEEPSEEK_API_KEY: value };
    }
  } catch {
    /* missing / unreadable ~/.reasonix/.env → no injection (best-effort) */
  }
  return {};
}

// ── FIX-1056: agy headless auth-context propagation ──────────────────────────

/** The env var agy's CLI reads to locate its auth-context (OAuth/session) home.
 *  Setting it makes the headless child resolve the SAME dir as the interactive
 *  CLI even when launchd's `$HOME` differs from the owner's real home. */
export const AGY_AUTH_CONTEXT_ENV = "AGY_CONFIG_DIR";

/** Ambient env vars that carry an agy/gemini auth credential (name-level only —
 *  the VALUES are NEVER read, stored, printed, or written; they ride the child's
 *  inherited env untouched). Used by {@link agyAuthContext} to decide whether a
 *  headless auth context exists, reporting NAMES with values redacted. */
const AGY_AUTH_ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"] as const;

/** The auth-context directory the interactive agy CLI resolves from the owner's
 *  home. Derived from the REAL passwd home (homedir() reads getpwuid, not $HOME)
 *  so it is stable under launchd, where $HOME may be sanitized. */
export function agyAuthContextDir(home: string = homedir()): string {
  return join(home, ".config", "agy");
}

/**
 * FIX-1056 — the agy child-env hook. Forwards the owner-resolved auth-context
 * dir to the headless child via {@link AGY_AUTH_CONTEXT_ENV} so a
 * once-authenticated agy participates in unattended cycles without an
 * interactive verify.
 *
 * SECURITY: this only FORWARDS a filesystem PATH (never a credential value). It
 * respects an explicit owner override — if the ambient env already sets
 * AGY_CONFIG_DIR, we never clobber it — and it sets the var ONLY when the
 * resolved dir actually exists (an absent context is surfaced by
 * {@link agyAuthContext}, never masked). No secret is read, stored, printed, or
 * written to `.roll`, events, reports, or fixtures.
 */
export function agyEnv(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if ((env[AGY_AUTH_CONTEXT_ENV] ?? "").trim() !== "") return {};
  const dir = agyAuthContextDir(home);
  return existsSync(dir) ? { [AGY_AUTH_CONTEXT_ENV]: dir } : {};
}

/** agy's headless auth-context readiness — a REDACTED diagnostic (names/paths
 *  only, never credential values) shared by the readiness command and the loop
 *  spawn envelope. `ok` when a config dir OR an auth env var is present. */
export interface AgyAuthContextReadiness {
  agent: "agy";
  /** The auth-context env var + resolved dir the headless child will use. */
  authContextEnv: string;
  configDir: string;
  configDirExists: boolean;
  /** NAMES of auth env vars present (values redacted — never surfaced). */
  authEnvPresent: string[];
  /** Human-actionable missing boundary, or null when a context is available. */
  missingBoundary: string | null;
  ok: boolean;
}

/**
 * FIX-1056 — resolve agy's headless auth-context readiness through the SAME
 * envelope the loop spawn uses ({@link agyEnv}/{@link agyAuthContextDir}). A
 * headless agy is ready iff its interactive auth-context dir exists OR an auth
 * env var is set. When neither is present we return an actionable
 * `missingBoundary` (which dir / which env vars) instead of silently excluding
 * agy. Credential VALUES are never read or surfaced — only the presence of a
 * name/path.
 */
export function agyAuthContext(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): AgyAuthContextReadiness {
  const configDir = agyAuthContextDir(home);
  const configDirExists = existsSync(configDir);
  const authEnvPresent = AGY_AUTH_ENV_KEYS.filter((k) => (env[k] ?? "").trim() !== "");
  const ok = configDirExists || authEnvPresent.length > 0;
  const missingBoundary = ok
    ? null
    : `no headless auth context: ${configDir} not found and none of ${AGY_AUTH_ENV_KEYS.join("/")} set — run agy login interactively, then retry`;
  return { agent: "agy", authContextEnv: AGY_AUTH_CONTEXT_ENV, configDir, configDirExists, authEnvPresent, missingBoundary, ok };
}

function evidenceFrameEnv(runDir: string): NodeJS.ProcessEnv {
  return {
    ROLL_RUN_DIR: runDir,
    ROLL_EVIDENCE_DIR: join(runDir, "evidence"),
    ROLL_SCREENSHOTS_DIR: join(runDir, "screenshots"),
  };
}

/** Stable child-process envelope for a frozen Workspace cycle. */
export function workspaceExecutionEnvironment(
  context: WorkspaceExecutionContextV1 | undefined,
): NodeJS.ProcessEnv {
  return workspaceSkillHandoffEnvironment(context);
}

function childEnv(opts: AgentSpawnOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  // FIX-1473: strip ALL inherited GIT_* variables for EVERY spawned agent.
  // Repository binding must come from each command's cwd, never a scheduler-
  // injected GIT_DIR/GIT_WORK_TREE pair: fixed bindings make nested/temp/clone
  // repositories write config, index, hooks and refs into the cycle repo.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  for (const key of [
    "ROLL_WORKSPACE_EXECUTION_CONTEXT",
    "ROLL_WORKSPACE",
    "ROLL_STORY_ID",
    "ROLL_REPOSITORY_ID",
    "ROLL_REPOSITORY_ALIAS",
  ]) {
    delete env[key];
  }
  // The cycle worktree itself remains discoverable from cwd. The ceiling only
  // prevents an invalid/missing worktree from walking upward into the product
  // checkout that physically contains `.roll/loop/worktrees`.
  Object.assign(env, worktreeGitDiscoveryEnv(opts.cwd));
  env.PWD = opts.cwd;
  delete env.OLDPWD;
  Object.assign(env, workspaceExecutionEnvironment(opts.workspaceExecution));
  Object.assign(env, (opts as RegisteredWorkspaceSkillSpawnOptions)[REGISTERED_WORKSPACE_SKILL_ENV] ?? {});
  return opts.runDir !== undefined && opts.runDir !== "" ? { ...env, ...evidenceFrameEnv(opts.runDir) } : env;
}

function withAgentProfileEnv(agent: string, opts: AgentSpawnOptions): AgentSpawnOptions {
  return {
    ...opts,
    env: {
      ...process.env,
      ...agentSpawnEnvironment(agent, opts.agentEnvHome),
      ...(opts.env ?? {}),
    },
  };
}

function spawnAndWait(bin: string, args: string[], opts: AgentSpawnOptions, pty = false): Promise<AgentSpawnResult> {
  // Operational trace (v2 logs its agent cmd too): goes to the runner's stderr,
  // which leg/cycle logs capture — argv mismatches become diagnosable.
  process.stderr.write(`[runner] spawn ${bin} argv=${JSON.stringify(args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)))}\n`);
  // FIX-1235: do NOT create an empty CODEX_HOME for isolateGit agents — the
  // git-level isolation (GIT_* stripping + GIT_CEILING_DIRECTORIES in childEnv)
  // prevents host-repo poisoning, and an empty CODEX_HOME strips the agent's
  // auth credentials (login stored in real CODEX_HOME), causing every spawn to
  // fail with env:auth. The isolateGit flag is kept; only the CODEX_HOME
  // override is removed (FIX-1231 regression covered by existing isolateGit
  // profile tests).
  return new Promise<AgentSpawnResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: childEnv(opts),
      stdio: ["ignore", "pipe", "pipe"],
      // FIX-224: the PTY-wrapped `script` leads its own process group so the
      // timeout/teardown can reap script AND the agent under it (killHard).
      detached: pty,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killHard(child, "SIGKILL");
      }, opts.timeoutMs);
    }
    // FIX-204E: live.log (fed via onChunk by the executor) is the single live
    // channel — observers tail it from the tmux watch window / `loop now`.
    child.stdout?.on("data", (d: Buffer) => {
      opts.onChunk?.(d);
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      opts.onChunk?.(d);
      stderr += d.toString("utf8");
    });
    liveAgents.add(child); // FIX-204D
    // FIX-1474: hand the live child to the liveness probe BEFORE any await can
    // interleave, so a death that predates the first probe tick is still seen.
    try {
      opts.onSpawn?.(child);
    } catch {
      /* the observer seam must never fail the spawn */
    }
    let settled = false;
    let exitDrainFallback: NodeJS.Timeout | undefined;
    const settle = (result: AgentSpawnResult): void => {
      if (settled) return;
      settled = true;
      liveAgents.delete(child); // FIX-204D
      if (timer !== undefined) clearTimeout(timer);
      if (exitDrainFallback !== undefined) clearTimeout(exitDrainFallback);
      try {
        opts.cleanup?.();
      } catch {
        /* cleanup is best-effort; the child result is the authoritative outcome */
      }
      resolve(result);
    };
    child.on("error", (e) => {
      // Mirror shell semantics: a missing/unspawnable binary is exit 127 —
      // the v2 oracle classifies that as agent FAILURE (feeds the retry
      // ladder → failed), never an abort. Parallel-verify caught this live.
      settle({ stdout, stderr: `${stderr}${String(e)}\n`, exitCode: 127, timedOut });
    });
    // `close` is the authoritative successful-drain event for stdio. `exit` is
    // still needed as a fallback: a SIGKILLed agent can leave grandchildren
    // holding the pipes forever, so do not wait unboundedly after process death.
    child.on("exit", (code, signal) => {
      exitDrainFallback = setTimeout(() =>
        settle({ stdout, stderr, exitCode: code ?? (signal !== null ? 137 : 1), timedOut }),
        100,
      );
    });
    child.on("close", (code) => {
      settle({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
  });
}

function prepareRegisteredSkillSpawnOptions(opts: AgentSpawnOptions): AgentSpawnOptions {
  const invocation = opts.workspaceSkillInvocation;
  if (invocation === undefined) return opts;
  const prepared = prepareRegisteredWorkspaceSkillHandoff({
    ...invocation,
    context: opts.workspaceExecution,
    skillBody: opts.skillBody,
  });
  if (!prepared.ok) {
    throw new Error(`workspace_skill_handoff:${prepared.code}`);
  }
  return {
    ...opts,
    cwd: prepared.cwd,
    skillBody: prepared.skillBody,
    [REGISTERED_WORKSPACE_SKILL_ENV]: prepared.env,
    ...(prepared.context === undefined ? { workspaceExecution: undefined } : { workspaceExecution: prepared.context }),
  } as RegisteredWorkspaceSkillSpawnOptions;
}

export const realAgentSpawn: AgentSpawn = (agent, rawOpts) => {
  const opts = prepareRegisteredSkillSpawnOptions(rawOpts);
  // FIX-1482: route through the exported buildSpawnCommand so the readOnly
  // enforcement gate (assertReadOnlyEnforceable) fires before any child spawns.
  const { bin, args, pty } = withPtyWrap(buildSpawnCommand(agent, opts), agent);
  return spawnAndWait(bin, args, withAgentProfileEnv(agent, opts), pty);
};
realAgentSpawn.supportedPurposes = ["pick_ranking"];
