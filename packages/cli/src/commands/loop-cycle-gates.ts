/**
 * `roll loop` CYCLE-GATE subcommands — the last bin/roll fallbacks (US-PORT-021
 * prerequisite). These are invoked by the loop AGENT during a cycle per the
 * roll-loop skill, not by the runner script:
 *   - notify                : desktop notification (mute-aware).
 *   - enforce-tcr           : zero-`tcr:`-commit gate → revert Done→Todo + ALERT.
 *   - precheck-ci           : pre-run HEAD-CI gate (heal-armed) — pure verdict
 *                             from @roll/core precheckCiVerdict; this adapts I/O.
 *   - hotfix-head-context   : capture the CI failure log + recent diff for heal.
 *   - agent-routes          : DEPRECATED alias of `roll agent` (kept forwarding).
 *   - test-quality-check    : retired (the bats quality gate; bats is gone).
 *
 * Pure decisions live in core; git/gh/fs/notify are injectable seams so tests
 * never touch the real toolchain.
 */
import { type CiRunRow, precheckCiVerdict, resolveHealMax } from "@roll/core";
import { ghRepoSlug } from "@roll/infra";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveLang, STATUS_MARKER, t, v2Catalog, type Lang } from "@roll/spec";
import { agentCommand } from "./agent.js";

function lang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function msg(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, lang(), key, ...args);
}
function err(line: string): void {
  process.stderr.write(`[roll] ${line}\n`);
}

// ─── shared per-project paths (mirror _LOOP_RT_DIR = <cwd>/.roll/loop) ─────────
function runtimeDir(): string {
  const override = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return override !== "" ? override : join(process.cwd(), ".roll", "loop");
}
function projSlug(): string {
  const override = (process.env["ROLL_MAIN_SLUG"] ?? "").trim();
  return override !== "" ? override : (process.cwd().split("/").filter(Boolean).pop() ?? "default");
}
function alertFile(): string {
  return join(runtimeDir(), `ALERT-${projSlug()}.md`);
}
function stateFilePath(): string {
  return join(runtimeDir(), `state-${projSlug()}.yaml`);
}
function muteFilePath(): string {
  return join(runtimeDir(), `mute-${projSlug()}`);
}

/** Flat `key: value` read from a loop-state YAML body (0/"" when absent). */
export function stateGet(body: string, key: string): string {
  for (const raw of body.split("\n")) {
    const m = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*)$`).exec(raw.trim());
    if (m) return (m[1] ?? "").trim();
  }
  return "";
}
/** Pure upsert of a flat `key: value` (replace in place or append). */
export function stateUpsert(body: string, key: string, value: string | number): string {
  const lines = body.split("\n").filter((l) => l !== "");
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s`);
  const kept = lines.filter((l) => !re.test(l.trim()));
  kept.push(`${key}: ${value}`);
  return kept.join("\n") + "\n";
}

// ─── notify ───────────────────────────────────────────────────────────────────

export interface NotifyDeps {
  platform: () => NodeJS.Platform;
  muted: () => boolean;
  osascript: (title: string, body: string) => void;
}
function realNotifyDeps(): NotifyDeps {
  return {
    platform: () => process.platform,
    muted: () => existsSync(muteFilePath()),
    osascript: (title, body) => {
      try {
        spawnSync("osascript", ["-e", `display notification "${body}" with title "${title}"`], { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** `roll loop notify [title] [body]` — mute-aware desktop notification (darwin). */
export function loopNotifyCommand(args: string[], deps: NotifyDeps = realNotifyDeps()): number {
  const title = args[0] ?? "roll";
  const body = args[1] ?? "";
  if (deps.platform() !== "darwin") return 0;
  if (deps.muted()) return 0;
  deps.osascript(title, body);
  return 0;
}

// ─── enforce-tcr ────────────────────────────────────────────────────────────

export interface EnforceTcrDeps {
  /** Count `tcr:` commits since `startedAt` (git log --all --since). */
  tcrCount: (startedAt: string) => number;
  notify: (title: string, body: string) => void;
  now: () => Date;
}
function realEnforceTcrDeps(): EnforceTcrDeps {
  return {
    tcrCount: (startedAt) => {
      try {
        const out = execFileSync("git", ["log", "--all", "--oneline", `--since=${startedAt}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out.split("\n").filter((l) => /^[a-f0-9]+ tcr:/.test(l)).length;
      } catch {
        return 0;
      }
    },
    notify: (title, body) => loopNotifyCommand([title, body]),
    now: () => new Date(),
  };
}

/** Revert a story's `✅ Done` cell to `📋 Todo`. Markers come from the single
 *  source (@roll/spec) so the gate can never drift (FIX-300). FIX-1475: the row
 *  is matched by an EXACT id-cell (link-stripped) — never `line.includes([id])`,
 *  which also hit any OTHER row whose description linked to `[<id>]`. */
export function revertStoryDone(content: string, storyId: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (!line.startsWith("|")) return line;
      const cell = (line.split("|")[1] ?? "").trim();
      const id = cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
      if (id !== storyId) return line;
      return line.replace(` | ${STATUS_MARKER.done} |`, ` | ${STATUS_MARKER.todo} |`);
    })
    .join("\n");
}

/**
 * `roll loop enforce-tcr <story_id> [started_at]` — if no `tcr:` commit landed
 * since `started_at`, revert the story Done→Todo, write a TCR-failed ALERT,
 * notify, and exit 1. No `started_at` → lenient pass (exit 0).
 */
export function loopEnforceTcrCommand(args: string[], deps: EnforceTcrDeps = realEnforceTcrDeps()): number {
  const storyId = args[0] ?? "";
  const startedAt = args[1] ?? "";
  if (startedAt === "") return 0;
  if (deps.tcrCount(startedAt) > 0) return 0;

  const backlog = join(".roll", "backlog.md");
  if (existsSync(backlog)) {
    writeFileSync(backlog, revertStoryDone(readFileSync(backlog, "utf8"), storyId));
  }
  const alert = alertFile();
  mkdirSync(dirname(alert), { recursive: true });
  const stamp = fmtLocal(deps.now());
  writeFileSync(
    alert,
    `# ALERT — TCR check failed\n\n` +
      `**Time**: ${stamp}\n` +
      `**Story**: ${storyId}\n` +
      `**Reason**: zero tcr: commits since story start (${startedAt})\n\n` +
      `**Action required** (choose one):\n` +
      `- Add TCR commits and re-run: \`roll loop now\`\n` +
      `- Take over manually: \`$roll-build ${storyId}\`\n` +
      `- Reset and retry: \`roll loop reset\` then \`roll loop now\`\n`,
  );
  deps.notify("roll ⚠ TCR Failed", `${storyId}: no tcr: commits found`);
  return 1;
}

/** `date '+%Y-%m-%d %H:%M'` (local time). */
function fmtLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── precheck-ci ──────────────────────────────────────────────────────────────

export interface PrecheckDeps {
  repoSlug: () => string | undefined; // _gh_resolve
  headCommit: () => string | undefined;
  /** gh run list --commit <c> --json conclusion,status → rows ([] on failure). */
  runList: (slug: string, commit: string) => CiRunRow[];
  notify: (title: string, body: string) => void;
  now: () => Date;
}
function realPrecheckDeps(): PrecheckDeps {
  const git = (a: string[]): string | undefined => {
    try {
      return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    repoSlug: () => ghRepoSlug(git(["remote", "get-url", "origin"]) ?? undefined),
    headCommit: () => git(["rev-parse", "HEAD"]),
    runList: (slug, commit) => {
      try {
        const out = execFileSync(
          "gh",
          ["-R", slug, "run", "list", "--commit", commit, "--json", "conclusion,status"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const arr = JSON.parse(out) as CiRunRow[];
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    },
    notify: (title, body) => loopNotifyCommand([title, body]),
    now: () => new Date(),
  };
}

/**
 * `roll loop precheck-ci` — the pre-run HEAD-CI gate. Resolves repo+HEAD, lists
 * the HEAD-commit CI runs, and applies the pure {@link precheckCiVerdict}:
 *   exit 0 → build allowed (no runs / green / pending).
 *   exit 2 → red but heal-armed: increment heal_count_head_<sha8>, signal the agent.
 *   exit 1 → red, budget exhausted/disabled: write ALERT + notify, abort.
 */
export function loopPrecheckCiCommand(args: string[], deps: PrecheckDeps = realPrecheckDeps()): number {
  void args;
  const slug = deps.repoSlug();
  const commit = deps.headCommit();
  if (!slug || !commit) return 0;
  const runs = deps.runList(slug, commit);
  const healMax = resolveHealMax(process.env["ROLL_LOOP_NO_HEAL"], process.env["ROLL_LOOP_HEAL_MAX"]);
  const sha8 = commit.slice(0, 8);
  const healKey = `heal_count_head_${sha8}`;
  const state = stateFilePath();
  const body = existsSync(state) ? readFileSync(state, "utf8") : "";
  const headHealCount = parseInt(stateGet(body, healKey) || "0", 10) || 0;

  const verdict = precheckCiVerdict({ ghAndCommitOk: true, runs, healMax, headHealCount });

  if (verdict.exit === 2) {
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, stateUpsert(body, healKey, verdict.nextCount));
    return 2;
  }
  if (verdict.exit === 1) {
    err(msg("loop.pre_run_ci_check_head_ci", sha8));
    const alert = alertFile();
    mkdirSync(dirname(alert), { recursive: true });
    writeFileSync(
      alert,
      `# ALERT — Pre-run CI check failed (red base)\n\n` +
        `**Time**: ${fmtLocal(deps.now())}\n` +
        `**Commit**: ${sha8}\n` +
        `**Reason**: ${msg("loop.pre_run_ci_red_base")}\n` +
        `**Failing conclusions**: ${verdict.redConclusions.join(",")}\n\n` +
        `**Action required**:\n` +
        `- Investigate and fix CI: \`gh -R ${slug} run list --commit ${commit}\`\n` +
        `- After fixing and pushing green commit: \`roll loop now\`\n`,
    );
    deps.notify("roll ⚠ CI red", `loop refused to build on broken base (${sha8})`);
    return 1;
  }
  return 0;
}

// ─── hotfix-head-context ──────────────────────────────────────────────────────

export interface HotfixDeps {
  headCommit: () => string | undefined;
  repoSlug: () => string | undefined;
  gitLines: (a: string[]) => string;
  failedRunLog: (slug: string, commit: string) => string;
  writeOut: (path: string, content: string) => void;
}
function realHotfixDeps(): HotfixDeps {
  const run = (cmd: string, a: string[]): string => {
    try {
      return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  return {
    headCommit: () => run("git", ["rev-parse", "HEAD"]).trim() || undefined,
    repoSlug: () => ghRepoSlug(run("git", ["remote", "get-url", "origin"]).trim() || undefined),
    gitLines: (a) => run("git", a),
    failedRunLog: (slug, commit) => {
      const list = run("gh", ["-R", slug, "run", "list", "--commit", commit, "--json", "databaseId,conclusion", "-L", "5"]);
      let runId = "";
      try {
        const rows = JSON.parse(list) as Array<{ databaseId?: number; conclusion?: string }>;
        runId = String(rows.find((r) => r.conclusion === "failure")?.databaseId ?? "");
      } catch {
        /* none */
      }
      if (!runId) return "";
      return run("gh", ["-R", slug, "run", "view", "--log-failed", runId]).split("\n").slice(0, 200).join("\n");
    },
    writeOut: (path, content) => writeFileSync(path, content),
  };
}

/**
 * `roll loop hotfix-head-context [commit]` — write a heal-context file (recent
 * commits + last-commit diff + the failed CI log, head 200 lines) to
 * /tmp/roll-heal-head-<sha8>.log and print its path. Best-effort, always 0/1.
 */
export function loopHotfixHeadContextCommand(args: string[], deps: HotfixDeps = realHotfixDeps()): number {
  const commit = args[0] ?? deps.headCommit();
  if (!commit) return 1;
  const short = commit.slice(0, 8);
  const slug = deps.repoSlug() ?? "unknown";
  const outfile = join(tmpdir(), `roll-heal-head-${short}.log`);
  const failLog = slug === "unknown" ? "" : deps.failedRunLog(slug, commit);
  const content =
    `=== CI Hot-fix Context: HEAD ${short} ===\n\n` +
    `--- Recent commits ---\n${deps.gitLines(["log", "--oneline", "-5"])}\n` +
    `--- Diff of last commit ---\n${deps.gitLines(["show", "--stat", "HEAD"]).split("\n").slice(0, 40).join("\n")}\n\n` +
    `--- CI failure logs (head 200 lines) ---\n${failLog || `(no failed run found for commit ${short})\n`}`;
  deps.writeOut(outfile, content);
  process.stdout.write(outfile + "\n");
  return 0;
}

// ─── agent-routes (deprecated alias) ──────────────────────────────────────────

/** `roll loop agent-routes <show|path|lint>` — DEPRECATED alias of `roll agent`. */
export function loopAgentRoutesCommand(args: string[]): number {
  const sub = args[0] ?? "show";
  if (sub === "show") {
    process.stderr.write("roll loop agent-routes: deprecated — use 'roll agent' (showing agents.yaml)\n");
    return agentCommand([]);
  }
  if (sub === "path") {
    process.stderr.write("roll loop agent-routes path: deprecated — use 'roll agent' (agents.yaml path)\n");
    process.stdout.write((process.env["ROLL_AGENTS_CONFIG"] || ".roll/agents.yaml") + "\n");
    return 0;
  }
  if (sub === "lint") {
    process.stderr.write("roll loop agent-routes lint: deprecated — schema v3 needs no lint\n");
    return 0;
  }
  process.stderr.write(
    "Usage: roll loop agent-routes <show|lint|path>   (DEPRECATED — use 'roll agent')\n",
  );
  return 1;
}

// ─── test-quality-check (retired) ─────────────────────────────────────────────

/** `roll loop test-quality-check` — retired: the bats quality gate is gone. */
export function loopTestQualityCheckRetired(): number {
  process.stdout.write(
    "roll loop test-quality-check is retired (the bats test suite it gated was removed).\n" +
      "roll loop test-quality-check 已退役（其把关的 bats 测试套件已移除）。\n",
  );
  return 0;
}

// FIX-240: live subcommands only — monitor/attach retired under the v3 runner.
const LOOP_USAGE =
  "Usage: roll loop <on|off|now|test|status|runs|log|story|events|eval|signals|fmt|mute|unmute|pause|resume|reset|gc>\n";

/** Stable unknown-route text reused by bridge-level rejected route guards. */
export function loopUnknownSubcommandText(sub: string): string {
  return `[roll] unknown loop subcommand: ${sub}\n${LOOP_USAGE}`;
}

/**
 * An unrecognised `roll loop <x>` — the final dispatch arm. With bin/roll
 * retired there is no bash fallback; print the usage and exit 1 (mirrors the
 * v2 `cmd_loop` default case, which also returned non-zero).
 */
export function loopUnknownSubcommand(sub: string | undefined): number {
  if (sub !== undefined && sub !== "" && sub !== "-h" && sub !== "--help") {
    process.stderr.write(loopUnknownSubcommandText(sub));
    return 1;
  }
  process.stderr.write(LOOP_USAGE);
  return 0;
}
