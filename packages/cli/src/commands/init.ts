/**
 * `roll init` — TS port of bin/roll cmd_init (2147-2210) and its scaffolding
 * helpers, plus the v2 UI renderer lib/roll-init.py (rendered natively here via
 * the shared render primitives). Mirrors the DETERMINISTIC happy path:
 *
 *   - fresh project (no AGENTS.md, not an existing codebase) → scaffold AGENTS.md
 *     (project-type-filtered), .claude/CLAUDE.md (template), .roll/backlog.md,
 *     .roll/features/, .roll/features.md, .roll/agents.yaml, .roll/.version
 *   - re-init (AGENTS.md present) → section-merge global conventions + CLAUDE.md
 *
 * Ported helpers: _merge_global_to_project (2022-2093), _merge_claude_to_project
 * (2095-2139), _write_backlog (3432-3451), _ensure_features_dir (3478-3487),
 * _write_features_md (3572-3591), _init_seed_project_agents,
 * _write_version_stamp (3497-3515), scan_project_type_from_files (3387-3429),
 * _sync_conventions (1300-1303 → _sync_one_tool → _sync_convention_for_tool),
 * and _emit_init_v2_ui (2215-2276) re-implementing lib/roll-init.py.
 *
 * Existing-codebase diagnosis points users to `$roll-onboard`; the `--apply`
 * path remains owned here and applies `.roll/onboard-plan.yaml` without entering
 * the frozen bash engine.
 *
 * Whitelisted divergence: cmd_init calls `_install_launchd_plists` with all
 * output redirected to /dev/null (`>/dev/null 2>&1 || true`). It contributes
 * NOTHING to init's stdout and is a darwin-only filesystem side effect, so the
 * TS port does not reproduce it — the user-visible contract (stdout + the
 * scaffolded .roll tree + AGENTS.md/CLAUDE.md) is byte-identical.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentSpec } from "@roll/core";
import { resolveLang, STATUS_MARKER, t, v2Catalog, v3Catalog, type Lang } from "@roll/spec";
import { c, renderState, row, COLS } from "../render.js";
import { onPath, rollPkgDir, syncConventions as sharedSyncConventions, writeMachineAgentScope } from "./setup-shared.js";
import { rollVersion } from "./version.js";
import { resolveProjectName, shouldSelfRegister, writeProjectRow } from "../lib/projects-registry.js";
import { projectSlug } from "./dashboard.js";
import { guideExternalToolSetup, silentPreinstallChromium } from "../lib/external-tools.js";
import { detectDesignHandoff, renderDesignNudge } from "../lib/onboard-nudge.js";
import { classifyInitState, collectInitFacts, renderStateMatrixFixture, type InitDiagnosis, type InitFacts } from "../lib/init-diagnosis.js";
import { renderInitRecommendation } from "../lib/init-diagnosis-render.js";
import { buildInitRepairPlan, requiredRollMissingPieces, type InitRepairOperation } from "../lib/init-repair.js";
import { writeInitBrief, type InitBriefResult } from "../lib/init-brief.js";
import {
  buildOnboardApplyReviewOperations,
  renderOnboardApplyReview,
  validateOnboardApplyPreflight,
  type OnboardApplyReviewLabels,
  type OnboardApplyReviewOperation,
} from "../lib/onboard-apply.js";
import { computeInitFactsHash } from "../lib/onboard-plan.js";
import { discoverInteractiveAgents } from "../lib/interactive-agent.js";
import { confirmYesNo, readConfirmLine } from "../lib/tty-confirm.js";
import { designCommand } from "./design.js";

/**
 * FIX-283 (AC4): adopting roll registers the project into `~/.roll/projects.json`
 * immediately, so it appears in the web switcher without waiting for the first
 * `roll index`. Reuses the SAME `writeProjectRow` + the SAME tmp/non-existent
 * skip rule (`shouldSelfRegister`) as `roll index`'s self-register — never a
 * second dialect, never a tmp fixture leaking into the real registry. `roll
 * index` keeps refreshing verdict/releaseTag; init seeds the row (name/slug/path
 * + lastIndexedAt) and never throws into init's main path.
 */
function registerProject(projectDir: string): void {
  try {
    if (!shouldSelfRegister(projectDir)) return;
    writeProjectRow({
      name: resolveProjectName(projectDir),
      slug: projectSlug(projectDir),
      path: projectDir,
      lastIndexedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  } catch {
    /* best-effort — the registry is additive; init still succeeds */
  }
}

const ROLL_OWNED_GIT_PATHS = [
  "AGENTS.md",
  ".claude/CLAUDE.md",
  ".roll/.version",
  ".roll/agents.yaml",
  ".roll/backlog.md",
  ".roll/brief.md",
  ".roll/briefs",
  ".roll/domain",
  ".roll/domain/context-map.md",
  ".roll/features",
  ".roll/features.md",
  ".roll/init-diagnosis.yaml",
  ".roll/onboard-changeset.yaml",
  ".roll/onboard-plan.yaml",
  ".roll/tech-analysis.md",
  ".roll/test-assessment.md",
  ".gitignore",
] as const;

function runGit(projectDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function existingRollOwnedPaths(projectDir: string): string[] {
  return ROLL_OWNED_GIT_PATHS.filter((rel) => existsSync(join(projectDir, rel.replace(/\/$/, ""))));
}

function printGitFinalizeManual(reason: string, command: string): void {
  warn(`Roll meta git finalize needs manual follow-up: ${reason}`);
  process.stderr.write(`  ${command}\n`);
}

function finalizeRollOwnedGit(projectDir: string): void {
  if (!runGit(projectDir, ["rev-parse", "--is-inside-work-tree"]).ok) return;
  const topLevel = runGit(projectDir, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return;
  if (realpathSync(projectDir) !== realpathSync(topLevel.stdout.trim())) return;

  const paths = existingRollOwnedPaths(projectDir);
  if (paths.length === 0) return;

  if (!runGit(projectDir, ["diff", "--cached", "--quiet"]).ok) {
    printGitFinalizeManual("existing staged changes; auto commit skipped", `git add -A -f -- ${paths.join(" ")} && git commit -m 'roll init: commit Roll-owned meta files'`);
    return;
  }

  const add = runGit(projectDir, ["add", "-A", "-f", "--", ...paths]);
  if (!add.ok) {
    printGitFinalizeManual("git add failed", `git add -A -f -- ${paths.join(" ")}`);
    return;
  }

  if (runGit(projectDir, ["diff", "--cached", "--quiet", "--", ...paths]).ok) return;

  const commit = runGit(projectDir, ["commit", "-m", "roll init: commit Roll-owned meta files"]);
  if (!commit.ok) {
    printGitFinalizeManual("git commit failed", "git commit -m 'roll init: commit Roll-owned meta files' -- AGENTS.md .roll .claude .gitignore");
    return;
  }

  const sha = runGit(projectDir, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  // FIX-1076 (AC8): plain language, not internal "Roll meta" jargon.
  ok(`Saved Roll setup files to git${sha !== "" ? `: ${sha}` : ""}`);

  const branch = runGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch === "" || branch === "HEAD") {
    printGitFinalizeManual("detached HEAD; push skipped", "git push origin HEAD");
    return;
  }
  const remotes = runGit(projectDir, ["remote"]).stdout.split("\n").filter((line) => line.trim() !== "");
  if (!remotes.includes("origin")) {
    printGitFinalizeManual("origin remote is not configured; push skipped", `git push -u origin ${branch}`);
    return;
  }
  const push = runGit(projectDir, ["push", "-u", "origin", branch]);
  if (!push.ok) {
    printGitFinalizeManual("git push failed", `git push -u origin ${branch}`);
    return;
  }
  ok(`Pushed Roll setup to origin/${branch}`);
}

// ─── bash UI helpers (bin/roll:41-56) — used only for err() here ─────────────
function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}
function info(line: string): void {
  const { CYAN, NC } = pal();
  process.stdout.write(`${CYAN}[roll]${NC} ${line}\n`);
}
function ok(line: string): void {
  const { GREEN, NC } = pal();
  process.stdout.write(`${GREEN}[roll]${NC} ${line}\n`);
}
function warn(line: string): void {
  const { YELLOW, NC } = pal();
  process.stderr.write(`${YELLOW}[roll]${NC} ${line}\n`);
}
function pal(): {
  RED: string;
  GREEN: string;
  YELLOW: string;
  CYAN: string;
  BOLD: string;
  NC: string;
} {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { RED: "", GREEN: "", YELLOW: "", CYAN: "", BOLD: "", NC: "" }
    : {
        RED: "\x1b[0;31m",
        GREEN: "\x1b[0;32m",
        YELLOW: "\x1b[0;33m",
        CYAN: "\x1b[0;36m",
        BOLD: "\x1b[1m",
        NC: "\x1b[0m",
      };
}
function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function m(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, msgLang(), key, ...args);
}
function m3(key: string, ...args: Array<string | number>): string {
  return t(v3Catalog, msgLang(), key, ...args);
}

function initMergeSummaryTitle(): string {
  return msgLang() === "zh" ? "Roll 约定同步摘要" : "Roll convention sync summary";
}

// ─── env (bin/roll:7-11) ──────────────────────────────────────────────────────
function rollHome(): string {
  return process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
}
function rollGlobal(): string {
  return join(rollHome(), "conventions", "global");
}
function rollTemplates(): string {
  return join(rollHome(), "conventions", "templates");
}
// merge-summary accumulator (mirrors _ROLL_MERGE_SUMMARY entries "action|file").
type Summary = string[];
type NextItem = [string, string];

// ─── scan_project_type_from_files (3387-3429) ─────────────────────────────────
function scanProjectType(dir: string): string {
  let hasFrontend = false;
  let hasBackend = false;
  let hasCli = false;
  const pkg = join(dir, "package.json");
  const readPkg = (): string => {
    try {
      return readFileSync(pkg, "utf8");
    } catch {
      return "";
    }
  };
  if (existsSync(pkg)) {
    if (/"react"|"vue"|"next"|"nuxt"|"vite"|"svelte"/i.test(readPkg())) hasFrontend = true;
  }
  if (["src", "app", "pages", "components"].some((d) => existsSync(join(dir, d)))) hasFrontend = true;

  if (["server", "api", "backend"].some((d) => existsSync(join(dir, d)))) hasBackend = true;
  if (
    ["go.mod", "main.go", "main.py", "app.py", "Cargo.toml", "requirements.txt", "pyproject.toml"].some(
      (f) => existsSync(join(dir, f)),
    )
  )
    hasBackend = true;
  if (existsSync(pkg)) {
    if (
      /"prisma"|"@prisma\/client"|"typeorm"|"sequelize"|"mongoose"|"drizzle-orm"|"@neondatabase\/serverless"|"pg"|"mysql2"|"mongodb"|"redis"|"ioredis"|"express"|"fastify"|"koa"|"hapi"|"@hapi\/hapi"|"apollo-server"|"graphql-yoga"|"trpc"/i.test(
        readPkg(),
      )
    )
      hasBackend = true;
  }
  if (existsSync(join(dir, "prisma", "schema.prisma"))) hasBackend = true;

  if (existsSync(join(dir, "bin")) || existsSync(join(dir, "cmd"))) hasCli = true;

  if (hasFrontend && hasBackend) return "fullstack";
  if (hasFrontend && !hasBackend) return "frontend-only";
  if (hasCli && !hasFrontend) return "cli";
  if (hasBackend && !hasFrontend) return "backend-service";
  return "unknown";
}

// ─── _init_is_legacy_project (2286-2323) ──────────────────────────────────────
function countNonEmptyFiles(dir: string): number {
  // find <dir> -type f -not -empty | wc -l
  const r = spawnSync("find", [dir, "-type", "f", "-not", "-empty"], { encoding: "utf8" });
  if (r.status !== 0 || (r.stdout ?? "") === "") return 0;
  return r.stdout.split("\n").filter((l) => l !== "").length;
}

interface ProjectDocContext {
  path: string;
  excerpt: string;
}

const PROJECT_DOC_ROOTS = new Set([
  "README.md",
  "README",
  "readme.md",
  "prd.md",
  "PRD.md",
  "spec.md",
  "SPEC.md",
  "requirements.md",
  "REQUIREMENTS.md",
]);
const PROJECT_DOC_DIRS = new Set(["docs", "doc", "spec", "specs", "prd", "requirements"]);

function normalizeDocExcerpt(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("<!--"))
    .slice(0, 12)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 700);
}

function hasProjectIntent(text: string): boolean {
  const normalized = normalizeDocExcerpt(text);
  if (normalized.length < 40) return false;
  return /project|product|app|service|cli|library|tool|platform|domain|feature|requirement|spec|prd|用户|产品|项目|需求|功能|服务|工具|平台/i.test(
    normalized,
  );
}

function collectProjectDocs(projectDir: string): ProjectDocContext[] {
  const out: ProjectDocContext[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    if (out.length >= 8) return;
    const path = join(projectDir, rel);
    if (!existsSync(path)) return;
    try {
      const real = realpathSync(path);
      if (seen.has(real)) return;
      const st = statSync(path);
      if (!st.isFile() || st.size <= 0 || st.size > 256_000) return;
      const text = readFileSync(path, "utf8");
      if (!hasProjectIntent(text)) return;
      const excerpt = normalizeDocExcerpt(text);
      if (excerpt !== "") {
        seen.add(real);
        out.push({ path: rel, excerpt });
      }
    } catch {
      /* ignore unreadable docs */
    }
  };

  for (const rel of PROJECT_DOC_ROOTS) add(rel);
  for (const dir of PROJECT_DOC_DIRS) {
    const root = join(projectDir, dir);
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root).sort()) {
        if (!/\.(md|mdx|txt)$/i.test(name)) continue;
        add(join(dir, name));
      }
    } catch {
      /* ignore unreadable doc dirs */
    }
  }
  return out;
}

function renderProjectDocContext(projectDir: string): string {
  const docs = collectProjectDocs(projectDir);
  if (docs.length === 0) return "";
  const lines = [
    "Project context detected by roll init:",
    `- structural type: ${scanProjectType(projectDir)}`,
  ];
  for (const doc of docs) lines.push(`- ${doc.path}: ${doc.excerpt}`);
  return lines.join("\n");
}

function legacyFileSummary(projectDir: string): string {
  const parts: string[] = [];
  for (const dir of ["src", "app", "lib", "pkg", "cmd"]) {
    const p = join(projectDir, dir);
    if (existsSync(p) && statSync(p).isDirectory()) {
      const count = countNonEmptyFiles(p);
      if (count >= 10) parts.push(`${count} files in ${dir}/`);
    }
  }
  const manifests = [
    "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile",
    "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts",
    "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    "app.json", "project.config.json", "mix.exs", "composer.json", "deno.json", "deno.jsonc",
  ];
  for (const man of manifests) {
    if (existsSync(join(projectDir, man))) {
      parts.push(`manifest: ${man}`);
      break;
    }
  }
  try {
    if (readdirSync(projectDir).some((name) => name.endsWith(".tf"))) parts.push("Terraform .tf files");
  } catch {
    /* ignore */
  }
  if (
    parts.length === 0 &&
    existsSync(join(projectDir, ".git")) &&
    spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectDir, stdio: "ignore" }).status === 0
  ) {
    parts.push("git history present");
  }
  const docs = collectProjectDocs(projectDir).map((doc) => doc.path);
  if (docs.length > 0) parts.push(`project docs: ${docs.join(", ")}`);
  return `no AGENTS.md, ${parts.join(" ")}`;
}

function discoverOnboardAgents(): { installed: string[]; missing: string[] } {
  return discoverInteractiveAgents();
}

function readLineFromStdin(): string | null {
  const chunks: number[] = [];
  const buf = Buffer.alloc(1);
  while (true) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch {
      return null;
    }
    if (n === 0) return chunks.length === 0 ? null : Buffer.from(chunks).toString("utf8");
    const b = buf[0] ?? 0;
    if (b === 10) break;
    if (b !== 13) chunks.push(b);
  }
  return Buffer.from(chunks).toString("utf8");
}

function selectOnboardAgent(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const forced = process.env["ROLL_ONBOARD_AGENT"] ?? "";
  if (forced !== "") {
    if (candidates.includes(forced)) return forced;
    err(`ROLL_ONBOARD_AGENT='${forced}' is not in installed agents.`);
    return null;
  }
  if (candidates.length === 1) return candidates[0] ?? null;

  process.stderr.write(`${m("init.pick_an_agent")}\n`);
  candidates.forEach((candidate, index) => {
    process.stderr.write(`    ${index + 1}) ${candidate}\n`);
  });
  process.stderr.write(`  Enter number [1-${candidates.length}]: `);
  const choice = readLineFromStdin();
  if (choice === null) {
    err(m("init.no_input_received_aborting_onboard"));
    return null;
  }
  const n = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
    err(m("init.invalid_choice", choice));
    return null;
  }
  return candidates[n - 1] ?? null;
}

function readOnboardPrompt(projectDir: string): string | null {
  const skillFile = join(rollPkgDir(), "skills", "roll-onboard", "SKILL.md");
  if (!existsSync(skillFile)) {
    err(`Skill file missing: ${skillFile}`);
    return null;
  }
  const body = readFileSync(skillFile, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const context = renderProjectDocContext(projectDir);
  return [
    "Run the $roll-onboard skill below for this project. Follow it end-to-end and write .roll/init-diagnosis.yaml plus .roll/onboard-plan.yaml when done.",
    context,
    body,
  ].filter((part) => part !== "").join("\n\n");
}

function kimiBin(): string {
  if (onPath("kimi-code")) return "kimi-code";
  if (onPath("kimi-cli")) return "kimi-cli";
  return "kimi";
}

function interactiveAgentCommand(agent: string, prompt: string): { bin: string; args: string[] } | null {
  const canonical = getAgentSpec(agent.trim().toLowerCase())?.name ?? agent;
  switch (canonical) {
    case "claude":
      return { bin: "claude", args: [prompt] };
    case "kimi":
      return { bin: kimiBin(), args: [prompt] };
    case "codex":
      return { bin: "codex", args: ["exec", prompt] };
    case "pi":
      return { bin: "pi", args: [prompt] };
    case "agy":
      return { bin: "agy", args: [prompt] };
    case "reasonix":
      return { bin: "reasonix", args: [prompt] };
    default:
      return null;
  }
}

function onboardFailureHint(agent: string, code: number): void {
  process.stderr.write("\n");
  if (code === 130) err(m("init.onboard_cancelled"));
  else err(m("init.onboard_agent_exited", agent, code));
  process.stderr.write("\n");
  process.stderr.write(`  ${m("init.onboard_next_step")}\n`);
  process.stderr.write(`    - ${m("init.onboard_retry")}\n`);
  process.stderr.write(`    - ${m("init.onboard_retry_en")}\n`);
  process.stderr.write(`    - ${m("init.onboard_switch")}\n`);
  process.stderr.write(`    - ${m("init.onboard_switch_en")}\n`);
  process.stderr.write("\n");
}

function runOnboardAgent(agent: string, projectDir: string): number {
  const prompt = readOnboardPrompt(projectDir);
  if (prompt === null) return 1;
  const cmd = interactiveAgentCommand(agent, prompt);
  if (cmd === null) {
    err(m("init.agent_has_no_interactive_mode_wired", agent));
    return 1;
  }
  const result = spawnSync(cmd.bin, cmd.args, {
    cwd: projectDir,
    stdio: "inherit",
    env: process.env,
  });
  const rc = result.status ?? (result.signal === null ? 1 : 130);
  if (rc !== 0) {
    onboardFailureHint(agent, rc);
    return rc;
  }
  if (!existsSync(join(projectDir, ".roll", "onboard-plan.yaml"))) {
    process.stderr.write("\n");
    err("Agent exited cleanly but did not write .roll/onboard-plan.yaml.");
    err(m("init.agent"));
    process.stderr.write("  Re-run `roll init` once you've completed the conversation.\n");
    process.stderr.write(`${m("init.en_roll_init")}\n`);
    return 1;
  }
  process.stderr.write("\n");
  info(m("init.plan_written_running_apply"));
  return initApply(projectDir, { autoMode: true });
}

function legacyOnboardGuide(projectDir: string): number {
  const { GREEN, RED, NC } = pal();
  info(m("init.detected_legacy_project", legacyFileSummary(projectDir)));
  process.stdout.write("\n");
  const { installed, missing } = discoverOnboardAgents();
  process.stdout.write(`${m("init.onboarding")}\n`);
  process.stdout.write("  Onboarding requires an AI agent to read your code. Detected:\n\n");
  for (const name of installed) process.stdout.write(`    ${GREEN}✓${NC} ${name}   (installed)\n`);
  for (const name of missing) process.stdout.write(`    ${RED}✗${NC} ${name}   (not found)\n`);
  if (installed.length === 0) {
    process.stdout.write("\n");
    err("No AI agent detected. Install one (e.g., 'claude', 'kimi', 'pi') and try again.");
    err(m("init.no_ai_agent_detected_install_one"));
    return 1;
  }
  process.stdout.write("\n");
  process.stdout.write(`${m("init.the_process_will_use_your_agent")}\n`);
  process.stdout.write("  Onboarding uses your agent to call models — tokens are billed to your account.\n\n");
  process.stdout.write(`${m("init.code_and_conversations_stay_in_your")}\n`);
  process.stdout.write("  Your code and conversation stay in your agent — Roll never uploads anything.\n\n");

  const chosen = selectOnboardAgent(installed);
  if (chosen === null) return 1;

  // Persist the user's choice as the Machine Scope supervise role.
  writeMachineAgentScope(chosen);

  process.stdout.write("\n");
  info(m("init.launching", chosen));
  process.stdout.write("  Conversation ends with /exit (or Ctrl-C). On exit Roll will run apply for you.\n");
  process.stdout.write(`${m("init.use_exit_to_end_or_ctrl")}\n\n`);
  return runOnboardAgent(chosen, projectDir);
}

// ─── _merge_global_to_project (2022-2093) ─────────────────────────────────────
function mergeGlobalToProject(projectDir: string, summary: Summary): void {
  const src = join(rollGlobal(), "AGENTS.md");
  const dst = join(projectDir, "AGENTS.md");
  if (!existsSync(src)) {
    // warn() output is captured-then-discarded inside the `{ … } >/dev/null`
    // block in cmd_init, so it never reaches init's stdout. Skip silently.
    return;
  }
  const projectType = scanProjectType(projectDir);
  const skipFrontend = ["cli", "backend-service", "unknown"].includes(projectType);
  const FRONTEND_HEAD = "## 7. Frontend Default Stack";

  const srcText = readFileSync(src, "utf8");
  const srcLines = srcText.split("\n");
  // bash `read -r` drops a trailing newline-less final line only if empty; the
  // file is read line-by-line. We mirror by iterating split lines but must not
  // emit a phantom trailing empty element.
  const lines = srcText.endsWith("\n") ? srcLines.slice(0, -1) : srcLines;

  if (!existsSync(dst)) {
    // Fresh create: write sections filtered by project type.
    let out = "";
    let fcH = "";
    let fcB = "";
    let fcPre = true;
    let fcWant = true;
    const flush = (): void => {
      if (fcH !== "" && fcWant) out += `${fcH}\n${fcB}`;
    };
    for (const line of lines) {
      if (/^## /.test(line)) {
        flush();
        fcH = line;
        fcB = "";
        fcPre = false;
        fcWant = true;
        if (skipFrontend && fcH === FRONTEND_HEAD) fcWant = false;
      } else if (fcPre) {
        out += `${line}\n`;
      } else {
        fcB += `${line}\n`;
      }
    }
    flush();
    writeFileAtomic(dst, out);
    summary.push("created|AGENTS.md");
    return;
  }

  // Section-merge: append any ## sections from global missing in project.
  const dstText = readFileSync(dst, "utf8");
  let added = 0;
  let curH = "";
  let curB = "";
  const tryAppend = (): void => {
    if (curH !== "" && !dstText.includes(curH)) {
      let skipSec = false;
      if (skipFrontend && curH === FRONTEND_HEAD) skipSec = true;
      if (!skipSec) {
        // NOTE: reads the ORIGINAL dst snapshot for the grep -qF check, matching
        // bash (which greps the file but only appends after the loop) — appends
        // accumulate; the grep target is the on-disk file which we update below.
        appendBuffer += `\n${curH}\n${curB}`;
        added += 1;
      }
    }
  };
  let appendBuffer = "";
  for (const line of lines) {
    if (/^## /.test(line)) {
      tryAppend();
      curH = line;
      curB = "";
    } else if (curH !== "") {
      curB += `${line}\n`;
    }
  }
  tryAppend();
  if (appendBuffer !== "") {
    const prefix = dstText.endsWith("\n") ? "\n" : "\n\n";
    writeFileAtomic(dst, dstText + prefix + rollMergeBlock(appendBuffer));
  }

  if (added > 0) summary.push("merged|AGENTS.md");
  else summary.push("unchanged|AGENTS.md");
}

// ─── _merge_claude_to_project (2095-2139) ─────────────────────────────────────
function mergeClaudeToProject(projectDir: string, summary: Summary): void {
  const projectType = scanProjectType(projectDir);
  const tplFile = join(rollTemplates(), projectType, "CLAUDE.md");
  if (!existsSync(tplFile)) return; // No template for this project type.
  const claudeDir = join(projectDir, ".claude");
  const outFile = join(claudeDir, "CLAUDE.md");
  mkdirSync(claudeDir, { recursive: true });

  if (!existsSync(outFile)) {
    writeFileAtomic(outFile, readFileSync(tplFile, "utf8"));
    summary.push("created|.claude/CLAUDE.md");
    return;
  }

  const tplText = readFileSync(tplFile, "utf8");
  const lines = tplText.endsWith("\n") ? tplText.split("\n").slice(0, -1) : tplText.split("\n");
  const outText = readFileSync(outFile, "utf8");
  let added = 0;
  let curH = "";
  let curB = "";
  let appendBuffer = "";
  const tryAppend = (): void => {
    if (curH !== "" && !outText.includes(curH)) {
      appendBuffer += `\n${curH}\n${curB}`;
      added += 1;
    }
  };
  for (const line of lines) {
    if (/^## /.test(line)) {
      tryAppend();
      curH = line;
      curB = "";
    } else if (curH !== "") {
      curB += `${line}\n`;
    }
  }
  tryAppend();
  if (appendBuffer !== "") {
    const prefix = outText.endsWith("\n") ? "\n" : "\n\n";
    writeFileAtomic(outFile, outText + prefix + rollMergeBlock(appendBuffer));
  }

  if (added > 0) summary.push("merged|.claude/CLAUDE.md");
  else summary.push("unchanged|.claude/CLAUDE.md");
}

// ─── _write_backlog (3432-3451) ───────────────────────────────────────────────
const BACKLOG_TEMPLATE = `# Project Backlog

## Epic: Initial Setup
| Story | Description | Status |
|-------|-------------|--------|

## Bug Fixes
| ID | Problem | Status |
|----|---------|--------|
`;
function writeBacklog(path: string, summary: Summary): void {
  if (existsSync(path)) {
    summary.push("unchanged|.roll/backlog.md");
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, BACKLOG_TEMPLATE);
  summary.push("created|.roll/backlog.md");
}

// ─── _ensure_features_dir (3478-3487) ─────────────────────────────────────────
function ensureFeaturesDir(path: string, summary: Summary): void {
  if (existsSync(path) && statSync(path).isDirectory()) {
    summary.push("unchanged|.roll/features/");
    return;
  }
  mkdirSync(path, { recursive: true });
  summary.push("created|.roll/features/");
}

// ─── _write_features_md (3572-3591) ───────────────────────────────────────────
const FEATURES_TEMPLATE = `# Features

> 产品视角的功能索引。每次发版时更新，使之与 BACKLOG 保持一致。

---

## Features by Epic

<!-- Add feature entries here as epics are completed -->
`;
function writeFeaturesMd(path: string, summary: Summary): void {
  if (existsSync(path)) {
    summary.push("unchanged|.roll/features.md");
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, FEATURES_TEMPLATE);
  summary.push("created|.roll/features.md");
}

const PROJECT_AGENTS_TEMPLATE = `schema: roll-agents/v1
scope: project
inherits: machine

roles:
  supervise:
    kind: inherit

defaults:
  story:
    roles:
      execute:
        kind: select
        from: [claude, agy, kimi, pi, reasonix, codex]
        require: [execute]
        strategy: health-aware
      evaluate:
        kind: select
        from: [claude, agy, kimi, pi, reasonix, codex]
        require: [evaluate]
        strategy: health-aware
`;

function initSeedProjectAgents(projectDir: string, summary: Summary): number {
  const dest = join(projectDir, ".roll", "agents.yaml");
  if (existsSync(dest)) {
    summary.push("unchanged|.roll/agents.yaml");
    return 0;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileAtomic(dest, PROJECT_AGENTS_TEMPLATE);
  summary.push("created|.roll/agents.yaml");
  return 0;
}

// ─── _write_version_stamp (3497-3515) ─────────────────────────────────────────
function writeVersionStamp(projectDir: string, summary: Summary): void {
  const stampPath = join(projectDir, ".roll", ".version");
  if (existsSync(stampPath)) {
    summary.push("unchanged|.roll/.version");
    return;
  }
  mkdirSync(join(projectDir, ".roll"), { recursive: true });
  const installedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileAtomic(
    stampPath,
    `# Roll project version stamp — written by \`roll init\` (US-ONBOARD-019).
# Used by \`_check_structure\` to recognise a previously-onboarded Roll project
# without depending on directory-name heuristics.
roll_version: "${rollVersion() || "unknown"}"
installed_at: "${installedAt}"
`,
  );
  summary.push("created|.roll/.version");
}

// ─── _sync_conventions (1300-1303) — shared with setup.ts ────────────────────
/**
 * Returns "ok" unless a sync op throws (mirrors `_sync_conventions || fail`).
 * Delegates to the shared port (setup-shared.ts) so init + setup run the exact
 * same per-tool copy logic the oracle does (`_sync_one_tool`). init never
 * forces.
 */
function syncConventions(): "ok" | "fail" {
  try {
    sharedSyncConventions(false);
    return "ok";
  } catch {
    return "fail";
  }
}

const ROLL_MERGE_START = "<!-- roll:onboard:start -->";
const ROLL_MERGE_END = "<!-- roll:onboard:end -->";

function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function rollMergeBlock(text: string): string {
  return `${ROLL_MERGE_START}\n${text.replace(/^\n+/, "")}${ROLL_MERGE_END}\n`;
}

type ChangesetSection =
  | "scope_approved"
  | "files_merged"
  | "files_created"
  | "dirs_created"
  | "gitignore_entries_added"
  | "launchd_plists_installed";

interface OnboardChangeset {
  onboardedAt: string;
  rollVersion: string;
  scopeApproved: string[];
  filesMerged: string[];
  filesCreated: string[];
  dirsCreated: string[];
  gitignoreEntriesAdded: string[];
  launchdPlistsInstalled: string[];
}

function changesetPath(projectDir: string): string {
  return join(projectDir, ".roll", "onboard-changeset.yaml");
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function renderYamlList(name: string, values: string[]): string {
  if (values.length === 0) return `${name}: []\n`;
  return `${name}:\n${values.map((v) => `  - "${v.replace(/"/g, '\\"')}"`).join("\n")}\n`;
}

function renderChangeset(changeset: OnboardChangeset): string {
  return (
    "# Generated by `roll init --apply`. Used by `roll offboard` to reverse\n" +
    "# the changes onboard made. Do not edit by hand.\n" +
    `onboarded_at: "${changeset.onboardedAt}"\n` +
    `roll_version: "${changeset.rollVersion}"\n` +
    renderYamlList("scope_approved", changeset.scopeApproved) +
    renderYamlList("files_merged", changeset.filesMerged) +
    renderYamlList("files_created", changeset.filesCreated) +
    renderYamlList("dirs_created", changeset.dirsCreated) +
    renderYamlList("gitignore_entries_added", changeset.gitignoreEntriesAdded) +
    renderYamlList("launchd_plists_installed", changeset.launchdPlistsInstalled)
  );
}

function writeChangeset(projectDir: string, changeset: OnboardChangeset): void {
  const path = changesetPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, renderChangeset(changeset));
}

function emptyChangesetLists(): Omit<OnboardChangeset, "onboardedAt" | "rollVersion"> {
  return {
    scopeApproved: [],
    filesMerged: [],
    filesCreated: [],
    dirsCreated: [],
    gitignoreEntriesAdded: [],
    launchdPlistsInstalled: [],
  };
}

function readExistingChangeset(projectDir: string): Omit<OnboardChangeset, "onboardedAt" | "rollVersion"> {
  const path = changesetPath(projectDir);
  const parsed = emptyChangesetLists();
  if (!existsSync(path)) return parsed;
  let current: ChangesetSection | null = null;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const itemMatch = /^\s+-\s+(.*)$/.exec(rawLine);
    if (itemMatch && current !== null) {
      let value = (itemMatch[1] ?? "").trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      recordParsedChangesetValue(parsed, current, value);
      continue;
    }
    const keyMatch = /^([a-z_]+):/.exec(rawLine);
    const key = keyMatch?.[1] ?? "";
    current = isChangesetSection(key) ? key : null;
  }
  return parsed;
}

function isChangesetSection(value: string): value is ChangesetSection {
  return (
    value === "scope_approved" ||
    value === "files_merged" ||
    value === "files_created" ||
    value === "dirs_created" ||
    value === "gitignore_entries_added" ||
    value === "launchd_plists_installed"
  );
}

function recordParsedChangesetValue(
  changeset: Omit<OnboardChangeset, "onboardedAt" | "rollVersion">,
  section: ChangesetSection,
  value: string,
): void {
  const target =
    section === "scope_approved"
      ? changeset.scopeApproved
      : section === "files_merged"
        ? changeset.filesMerged
        : section === "files_created"
          ? changeset.filesCreated
          : section === "dirs_created"
            ? changeset.dirsCreated
            : section === "gitignore_entries_added"
              ? changeset.gitignoreEntriesAdded
              : changeset.launchdPlistsInstalled;
  if (!target.includes(value)) target.push(value);
}

function beginChangeset(projectDir: string): OnboardChangeset {
  const existing = readExistingChangeset(projectDir);
  const changeset: OnboardChangeset = {
    onboardedAt: isoNow(),
    rollVersion: rollVersion() || "unknown",
    scopeApproved: existing.scopeApproved,
    filesMerged: existing.filesMerged,
    filesCreated: existing.filesCreated,
    dirsCreated: existing.dirsCreated,
    gitignoreEntriesAdded: existing.gitignoreEntriesAdded,
    launchdPlistsInstalled: existing.launchdPlistsInstalled,
  };
  writeChangeset(projectDir, changeset);
  return changeset;
}

function recordChangeset(projectDir: string, changeset: OnboardChangeset, section: ChangesetSection, value: string): void {
  const target =
    section === "scope_approved"
      ? changeset.scopeApproved
      : section === "files_merged"
        ? changeset.filesMerged
        : section === "files_created"
          ? changeset.filesCreated
          : section === "dirs_created"
            ? changeset.dirsCreated
            : section === "gitignore_entries_added"
              ? changeset.gitignoreEntriesAdded
              : changeset.launchdPlistsInstalled;
  if (target.includes(value)) return;
  target.push(value);
  writeChangeset(projectDir, changeset);
}

function recordFreshInitChangeset(projectDir: string, summary: Summary): void {
  const created = summary
    .map((entry): { action: string; file: string } | null => {
      const idx = entry.indexOf("|");
      if (idx < 0) return null;
      return { action: entry.slice(0, idx), file: entry.slice(idx + 1) };
    })
    .filter((entry): entry is { action: string; file: string } => entry !== null && entry.action === "created");
  if (created.length === 0) return;
  const changeset = beginChangeset(projectDir);
  recordChangeset(projectDir, changeset, "scope_approved", "fresh-init");
  for (const entry of created) {
    if (entry.file.endsWith("/")) recordChangeset(projectDir, changeset, "dirs_created", entry.file.replace(/\/$/, ""));
    else recordChangeset(projectDir, changeset, "files_created", entry.file);
  }
}

interface PlanFields {
  approved: string[];
  gitignoreDotRoll: boolean;
  agentRoutesTemplate: string;
  renderPhase2Artifacts: boolean;
}

function readPlanFields(plan: string): PlanFields {
  const script = `
import json, sys, yaml
p = yaml.safe_load(open(sys.argv[1])) or {}
print(json.dumps({
  "approved": p.get("scope", {}).get("approved", []) or [],
  "gitignoreDotRoll": bool(p.get("privacy", {}).get("gitignore_dot_roll", False)),
  "agentRoutesTemplate": p.get("agent_routes_template", "") or "",
  "renderPhase2Artifacts": any(isinstance(p.get(k), dict) for k in ("domain_model", "tech_analysis", "test_assessment")),
}))
`;
  const r = spawnSync("python3", ["-c", script, plan], { encoding: "utf8" });
  if (r.status !== 0) return { approved: [], gitignoreDotRoll: false, agentRoutesTemplate: "", renderPhase2Artifacts: false };
  try {
    const parsed = JSON.parse(r.stdout) as Partial<PlanFields>;
    return {
      approved: Array.isArray(parsed.approved) ? parsed.approved.filter((v): v is string => typeof v === "string") : [],
      gitignoreDotRoll: parsed.gitignoreDotRoll === true,
      agentRoutesTemplate: typeof parsed.agentRoutesTemplate === "string" ? parsed.agentRoutesTemplate : "",
      renderPhase2Artifacts: parsed.renderPhase2Artifacts === true,
    };
  } catch {
    return { approved: [], gitignoreDotRoll: false, agentRoutesTemplate: "", renderPhase2Artifacts: false };
  }
}

function runPythonScript(scriptPath: string, args: string[]): number {
  const r = spawnSync("python3", [scriptPath, ...args], { encoding: "utf8" });
  if (r.stdout !== undefined && r.stdout !== "") process.stdout.write(r.stdout);
  if (r.stderr !== undefined && r.stderr !== "") process.stderr.write(r.stderr);
  return r.status ?? 1;
}

function renderApplyPreflightErrors(preflight: ReturnType<typeof validateOnboardApplyPreflight>): string[] {
  if (preflight.planFactsHash === undefined) return [m3("init.onboard_plan_facts_hash_unreadable")];
  if (preflight.currentFactsHash !== undefined && preflight.planFactsHash !== preflight.currentFactsHash) {
    return [m3("init.onboard_plan_facts_hash_stale", preflight.currentFactsHash, preflight.planFactsHash)];
  }
  return preflight.errors;
}

function printMergeSummary(summary: Summary): void {
  if (summary.length === 0) return;
  const { GREEN, YELLOW, CYAN, NC } = pal();
  process.stdout.write("\n");
  process.stdout.write(`${initMergeSummaryTitle()}\n`);
  for (const entry of summary) {
    const idx = entry.indexOf("|");
    const action = idx >= 0 ? entry.slice(0, idx) : entry;
    const file = idx >= 0 ? entry.slice(idx + 1) : "";
    if (action === "merged") process.stdout.write(`  │  ${GREEN}✦ merged${NC}      ${file.padEnd(30)}│\n`);
    else if (action === "created") process.stdout.write(`  │  ${GREEN}+ created${NC}     ${file.padEnd(30)}│\n`);
    else if (action === "overwritten") process.stdout.write(`  │  ${YELLOW}↺ overwritten${NC} ${file.padEnd(30)}│\n`);
    else if (action === "kept") process.stdout.write(`  │  ${CYAN}· kept${NC}        ${file.padEnd(30)}│\n`);
    else if (action === "unchanged") process.stdout.write(`  │    unchanged    ${file.padEnd(30)}│\n`);
  }
  process.stdout.write("  └─────────────────────────────────────────────────────┘\n");
}

function summaryAction(summary: Summary, file: string): string | null {
  for (let index = summary.length - 1; index >= 0; index -= 1) {
    const entry = summary[index] ?? "";
    const sep = entry.indexOf("|");
    if (sep < 0) continue;
    if (entry.slice(sep + 1) === file) return entry.slice(0, sep);
  }
  return null;
}

function recordSummaryOwnership(projectDir: string, changeset: OnboardChangeset, summary: Summary, file: string): void {
  const action = summaryAction(summary, file);
  if (action === "created") recordChangeset(projectDir, changeset, "files_created", file);
  else if (action === "merged") recordChangeset(projectDir, changeset, "files_merged", file);
}

function maybeFailApplyAfter(label: string): void {
  if ((process.env["ROLL_INIT_APPLY_FAIL_AFTER"] ?? "") === label) {
    throw new Error(`planned apply failure after ${label}`);
  }
}

export function seedBacklogRow(backlog: string, heading: string, row: string, id: string): boolean {
  if (!existsSync(backlog)) return false;
  const text = readFileSync(backlog, "utf8");
  // FIX-1475: existence by an EXACT id-cell match (bare or linked). The old
  // `text.includes("| ${id} |")` both false-positived (a row whose DESCRIPTION
  // cell equalled the id skipped a real seed) and false-negatived (a linked
  // `| [id](...) |` row was re-appended as a duplicate).
  const exists = text.split("\n").some((l) => {
    if (!l.startsWith("|")) return false;
    const cell = (l.split("|")[1] ?? "").trim();
    const cellId = cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
    return cellId === id;
  });
  if (exists) return false;
  const lines = text.split("\n");
  let seen = false;
  let inserted = false;
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line === heading) seen = true;
    else if (seen && !inserted && /^\|-+\|-+\|-+\|$/.test(line)) {
      out.push(row);
      inserted = true;
    }
  }
  if (!inserted) out.push(row);
  writeFileAtomic(backlog, out.join("\n"));
  return true;
}

function seedBacklogStory(backlog: string, id: string, title: string): boolean {
  return seedBacklogRow(
    backlog,
    "## Epic: Initial Setup",
    `| ${id} | ${title} | ${STATUS_MARKER.todo} |`,
    id,
  );
}

function seedBacklogFix(backlog: string, id: string, title: string): boolean {
  return seedBacklogRow(backlog, "## Bug Fixes", `| ${id} | ${title} | ${STATUS_MARKER.todo} |`, id);
}

function confirmSeed(count: number, noun: "story" | "fix", ids: string[], titles: string[]): boolean {
  process.stderr.write("\n");
  warn(noun === "fix" ? m("init.onboard_seed_preview_fix", count) : m("init.onboard_seed_preview_story", count));
  ids.forEach((id, index) => {
    process.stderr.write(`    ${id}  ${titles[index] ?? ""}\n`);
  });
  process.stderr.write("\n");
  if ((process.env["ROLL_ASSUME_TTY"] ?? "") !== "1" && process.stdin.isTTY !== true) {
    process.stderr.write(`${m("init.onboard_seed_noninteractive")}\n`);
    return false;
  }
  const { BOLD, NC } = pal();
  process.stderr.write(`  ${BOLD}${m("init.onboard_seed_prompt")}${NC} [y/N] \n`);
  const reply = readLineFromStdin() ?? "";
  return reply === "y" || reply === "Y" || reply === "yes" || reply === "YES";
}

function renderAndSeed(projectDir: string, plan: string, changeset: OnboardChangeset): void {
  const renderer = join(rollPkgDir(), "lib", "roll-onboard-render.py");
  if (!existsSync(renderer)) return;
  const knownRenderedFiles = [".roll/domain/context-map.md", ".roll/tech-analysis.md", ".roll/test-assessment.md"];
  const existedBefore = new Set(knownRenderedFiles.filter((file) => existsSync(join(projectDir, file))));
  const r = spawnSync("python3", [renderer, plan, projectDir], { encoding: "utf8" });
  if (r.status === 2) return;
  if (r.status !== 0) {
    if (r.stderr !== undefined && r.stderr !== "") process.stderr.write(r.stderr);
    warn(m("init.onboard_render_failed"));
    return;
  }
  const seedIds: string[] = [];
  const seedTitles: string[] = [];
  const fixIds: string[] = [];
  const fixTitles: string[] = [];
  for (const raw of (r.stdout ?? "").split("\n")) {
    if (raw === "") continue;
    const [kind, a = "", b = ""] = raw.split("|");
    if (kind === "FILE") {
      if (!existedBefore.has(a)) recordChangeset(projectDir, changeset, "files_created", a);
      ok(m("init.onboard_rendered", a));
    } else if (kind === "SEED") {
      seedIds.push(a);
      seedTitles.push(b);
    } else if (kind === "FIX") {
      fixIds.push(a);
      fixTitles.push(b);
    }
  }
  const backlog = join(projectDir, ".roll", "backlog.md");
  if (seedIds.length > 0) {
    if (!existsSync(backlog)) info(m("init.onboard_seed_no_backlog"));
    else if (confirmSeed(seedIds.length, "story", seedIds, seedTitles)) {
      let seeded = 0;
      seedIds.forEach((id, index) => {
        if (seedBacklogStory(backlog, id, seedTitles[index] ?? "")) seeded += 1;
      });
      ok(m("init.onboard_seeded_stories", seeded));
    } else info(m("init.onboard_seed_cancelled"));
  }
  if (fixIds.length > 0) {
    if (!existsSync(backlog)) info(m("init.onboard_seed_no_backlog"));
    else if (confirmSeed(fixIds.length, "fix", fixIds, fixTitles)) {
      let seeded = 0;
      fixIds.forEach((id, index) => {
        if (seedBacklogFix(backlog, id, fixTitles[index] ?? "")) seeded += 1;
      });
      ok(m("init.onboard_seeded_fixes", seeded));
    } else info(m("init.onboard_seed_cancelled"));
  }
}

const DEFAULT_GITIGNORE_ENTRIES = [".roll/loop/", ".pi/", ".kimi/", ".kimi-code/", ".reasonix/"] as const;

function addRollToGitignore(projectDir: string, changeset: OnboardChangeset): void {
  const gi = join(projectDir, ".gitignore");
  const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const existing = new Set(current.split("\n"));
  const missing = DEFAULT_GITIGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return;
  writeFileAtomic(gi, current + (current === "" || current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
  for (const entry of missing) recordChangeset(projectDir, changeset, "gitignore_entries_added", entry);
  ok(m("init.added_roll_to_gitignore"));
}

function applyIsInteractive(opts: { forceInteractive?: boolean }): boolean {
  return opts.forceInteractive === true || process.stdin.isTTY === true;
}

function claudeTemplateAvailable(projectDir: string): boolean {
  const projectType = scanProjectType(projectDir);
  return existsSync(join(rollTemplates(), projectType, "CLAUDE.md"));
}

function projectAgentsConfigEnabled(templateName: string): boolean {
  return templateName !== "skip";
}

function applyReviewLabels(): OnboardApplyReviewLabels {
  return {
    title: m3("init.onboard_apply_review_title"),
    action: m3("init.onboard_apply_review_action"),
    target: m3("init.onboard_apply_review_target"),
    mode: m3("init.onboard_apply_review_mode"),
    ownerContent: m3("init.onboard_apply_review_owner_content"),
    actions: {
      append: m3("init.onboard_apply_review_action_append"),
      create: m3("init.onboard_apply_review_action_create"),
      keep: m3("init.onboard_apply_review_action_keep"),
      merge: m3("init.onboard_apply_review_action_merge"),
      replace: m3("init.onboard_apply_review_action_replace"),
    },
    modes: {
      "append-line": m3("init.onboard_apply_review_mode_append_line"),
      "create-if-missing": m3("init.onboard_apply_review_mode_create_if_missing"),
      "ensure-directory": m3("init.onboard_apply_review_mode_ensure_directory"),
      replace: m3("init.onboard_apply_review_mode_replace"),
      "section-merge": m3("init.onboard_apply_review_mode_section_merge"),
    },
    ownerContentValues: {
      "not present": m3("init.onboard_apply_review_owner_not_present"),
      preserved: m3("init.onboard_apply_review_owner_preserved"),
      replaced: m3("init.onboard_apply_review_owner_replaced"),
      "roll-owned": m3("init.onboard_apply_review_owner_roll_owned"),
    },
  };
}

function printApplyReview(operations: readonly OnboardApplyReviewOperation[]): void {
  info(m3("init.onboard_plan_validated_review"));
  process.stdout.write(renderOnboardApplyReview(operations, applyReviewLabels()));
  process.stdout.write(`  ${m3("init.onboard_apply_review_sync_note")}\n`);
}

function confirmApplyReview(
  operations: readonly OnboardApplyReviewOperation[],
  opts: { autoMode?: boolean; forceInteractive?: boolean; readLine?: () => string },
): boolean {
  printApplyReview(operations);
  if (opts.autoMode === true) return true;
  if (!applyIsInteractive(opts)) {
    process.stdout.write(`  ${m3("init.onboard_apply_auto_required")}\n`);
    process.stdout.write("    roll init --apply --auto\n");
    process.stdout.write(`  ${m3("init.no_files_changed")}\n`);
    return false;
  }
  const confirmed = confirmYesNo(`${m3("init.onboard_apply_confirm_prompt")} [y/N] `, (s) => process.stderr.write(s), opts.readLine ?? readConfirmLine);
  if (opts.readLine !== undefined) process.stderr.write("\n");
  if (!confirmed) process.stderr.write(`${m3("init.no_files_changed")}\n`);
  return confirmed;
}

function repairActionLabel(action: InitRepairOperation["action"]): string {
  switch (action) {
    case "create":
      return "create";
    case "keep":
      return "keep";
    case "merge":
      return "merge";
    case "update":
      return "update";
  }
}

function renderRepairPlan(operations: readonly InitRepairOperation[]): string {
  const actionWidth = Math.max(8, ...operations.map((op) => repairActionLabel(op.action).length));
  const targetWidth = Math.max(32, ...operations.map((op) => op.target.length));
  const lines = [
    "Partial Roll repair preview",
    `  ${"action".padEnd(actionWidth)}  ${"target".padEnd(targetWidth)}  kind       owner content`,
    ...operations.map(
      (op) => `  ${repairActionLabel(op.action).padEnd(actionWidth)}  ${op.target.padEnd(targetWidth)}  ${op.kind.padEnd(9)}  ${op.ownerContent}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function confirmRepair(
  operations: readonly InitRepairOperation[],
  opts: { autoMode?: boolean; forceInteractive?: boolean; readLine?: () => string },
): boolean {
  process.stdout.write(renderRepairPlan(operations));
  if (opts.autoMode === true) return true;
  if (!applyIsInteractive(opts)) {
    process.stdout.write("  Non-interactive stdin — repair requires explicit apply:\n");
    process.stdout.write("    roll init --repair --auto\n");
    process.stdout.write(`  ${m3("init.no_files_changed")}\n`);
    return false;
  }
  const confirmed = confirmYesNo("Proceed with repair? [y/N] ", (s) => process.stderr.write(s), opts.readLine ?? readConfirmLine);
  if (opts.readLine !== undefined) process.stderr.write("\n");
  if (!confirmed) process.stderr.write(`${m3("init.no_files_changed")}\n`);
  return confirmed;
}

function recordCreatedFileIfNeeded(projectDir: string, changeset: OnboardChangeset, rel: string, existed: boolean): void {
  if (!existed && existsSync(join(projectDir, rel))) recordChangeset(projectDir, changeset, "files_created", rel);
}

function recordCreatedDirIfNeeded(projectDir: string, changeset: OnboardChangeset, rel: string, existed: boolean): void {
  if (!existed && existsSync(join(projectDir, rel))) recordChangeset(projectDir, changeset, "dirs_created", rel);
}

function repairBlocker(projectDir: string): string | null {
  const featuresDir = join(projectDir, ".roll", "features");
  if (existsSync(featuresDir) && !statSync(featuresDir).isDirectory()) {
    return ".roll/features exists but is not a directory. Move or rename it, then rerun `roll init --repair --auto`.";
  }
  return null;
}

function initRepair(
  projectDir: string,
  facts: InitFacts,
  diagnosis: InitDiagnosis,
  opts: { autoMode?: boolean; forceInteractive?: boolean; readLine?: () => string } = {},
): number {
  if (diagnosis.kind === "roll-ready") {
    process.stdout.write(`${renderInitRecommendation(diagnosis, msgLang())}\n`);
    return 0;
  }
  if (diagnosis.kind !== "roll-partial") {
    process.stdout.write(`${renderInitRecommendation(diagnosis, msgLang())}\n`);
    err("roll init --repair only applies to partial Roll projects.");
    return 1;
  }

  const repairPlan = buildInitRepairPlan(projectDir, facts);
  if (!confirmRepair(repairPlan.operations, opts)) return 1;
  const blocker = repairBlocker(projectDir);
  if (blocker !== null) {
    err(blocker);
    return 1;
  }

  if (!existsSync(rollTemplates())) {
    err(m("init.no_templates_found_run_roll_setup_2"));
    return 1;
  }

  const summary: Summary = [];
  const changeset = beginChangeset(projectDir);
  recordChangeset(projectDir, changeset, "scope_approved", "repair-roll");

  process.stdout.write("\nREPAIR  ·  Partial Roll repair\n");
  mergeGlobalToProject(projectDir, summary);
  recordSummaryOwnership(projectDir, changeset, summary, "AGENTS.md");

  const backlog = join(projectDir, ".roll", "backlog.md");
  const backlogExisted = existsSync(backlog);
  writeBacklog(backlog, summary);
  recordCreatedFileIfNeeded(projectDir, changeset, ".roll/backlog.md", backlogExisted);

  const featuresDir = join(projectDir, ".roll", "features");
  const featuresDirExisted = existsSync(featuresDir);
  ensureFeaturesDir(featuresDir, summary);
  recordCreatedDirIfNeeded(projectDir, changeset, ".roll/features", featuresDirExisted);

  const featuresMd = join(projectDir, ".roll", "features.md");
  const featuresMdExisted = existsSync(featuresMd);
  writeFeaturesMd(featuresMd, summary);
  recordCreatedFileIfNeeded(projectDir, changeset, ".roll/features.md", featuresMdExisted);

  const stamp = join(projectDir, ".roll", ".version");
  const stampExisted = existsSync(stamp);
  writeVersionStamp(projectDir, summary);
  recordCreatedFileIfNeeded(projectDir, changeset, ".roll/.version", stampExisted);

  printMergeSummary(summary);
  ok("Repair complete.");
  finalizeRollOwnedGit(projectDir);
  return 0;
}

function initApply(
  projectDir: string,
  opts: { autoMode?: boolean; forceInteractive?: boolean; readLine?: () => string } = {},
): number {
  const plan = join(projectDir, ".roll", "onboard-plan.yaml");
  const validator = join(rollPkgDir(), "lib", "roll-plan-validate.py");
  if (!existsSync(plan)) {
    err(m("init.no_onboard_plan_found_at_roll"));
    process.stderr.write("\n");
    process.stderr.write("  Run $roll-onboard in your AI agent first to generate the plan.\n");
    process.stderr.write(`${m("init.en_ai_agent_onboard_plan_ap", "$roll")}\n`);
    return 1;
  }
  if (!existsSync(validator)) {
    err(m("init.plan_validator_missing", validator));
    return 1;
  }
  if (runPythonScript(validator, [plan]) !== 0) {
    err(m("init.plan_validation_failed_see_errors_above"));
    process.stderr.write("\n");
    process.stderr.write("  If the plan is stale (>24h), regenerate by running $roll-onboard again.\n");
    return 1;
  }
  const preflight = validateOnboardApplyPreflight(projectDir, plan);
  if (!preflight.ok) {
    for (const error of renderApplyPreflightErrors(preflight)) err(error);
    process.stderr.write("\n");
    process.stderr.write(`  ${m3("init.onboard_regenerate_before_apply")}\n`);
    return 1;
  }
  const fields = readPlanFields(plan);
  let routesTemplate = fields.agentRoutesTemplate;
  if (routesTemplate === "") routesTemplate = process.env["ROLL_AGENT_ROUTES_TEMPLATE"] ?? "default";
  const reviewOperations = buildOnboardApplyReviewOperations({
    projectDir,
    approved: fields.approved,
    gitignoreDotRoll: fields.gitignoreDotRoll,
    agentRoutesTemplate: routesTemplate,
    includeClaudeConventions: claudeTemplateAvailable(projectDir),
    includeAgentRoutes: projectAgentsConfigEnabled(routesTemplate),
    includePhase2Artifacts: fields.renderPhase2Artifacts,
  });
  if (!confirmApplyReview(reviewOperations, opts)) {
    return 1;
  }
  try {
    info(m("init.applying_onboard_plan"));
    const summary: Summary = [];
    const changeset = beginChangeset(projectDir);
    for (const item of fields.approved) recordChangeset(projectDir, changeset, "scope_approved", item);

    mergeGlobalToProject(projectDir, summary);
    recordSummaryOwnership(projectDir, changeset, summary, "AGENTS.md");
    mergeClaudeToProject(projectDir, summary);
    recordSummaryOwnership(projectDir, changeset, summary, ".claude/CLAUDE.md");

    const stamp = join(projectDir, ".roll", ".version");
    const stampExisted = existsSync(stamp);
    writeVersionStamp(projectDir, summary);
    if (!stampExisted && existsSync(stamp)) recordChangeset(projectDir, changeset, "files_created", ".roll/.version");

    const approved = new Set(fields.approved);
    if (approved.has("backlog")) {
      const backlogPath = join(projectDir, ".roll", "backlog.md");
      const existed = existsSync(backlogPath);
      writeBacklog(backlogPath, summary);
      if (!existed && existsSync(backlogPath)) recordChangeset(projectDir, changeset, "files_created", ".roll/backlog.md");
      maybeFailApplyAfter("backlog");
    }
    if (routesTemplate !== "skip") {
      const routesPath = join(projectDir, ".roll", "agents.yaml");
      const existed = existsSync(routesPath);
      if (initSeedProjectAgents(projectDir, summary) === 0 && !existed && existsSync(routesPath)) {
        recordChangeset(projectDir, changeset, "files_created", ".roll/agents.yaml");
      }
    }
    if (approved.has("features")) {
      const featuresDir = join(projectDir, ".roll", "features");
      const featuresMd = join(projectDir, ".roll", "features.md");
      const dirExisted = existsSync(featuresDir);
      const mdExisted = existsSync(featuresMd);
      ensureFeaturesDir(featuresDir, summary);
      writeFeaturesMd(featuresMd, summary);
      if (!dirExisted && existsSync(featuresDir)) recordChangeset(projectDir, changeset, "dirs_created", ".roll/features");
      if (!mdExisted && existsSync(featuresMd)) recordChangeset(projectDir, changeset, "files_created", ".roll/features.md");
    }
    if (approved.has("domain")) {
      const path = join(projectDir, ".roll", "domain");
      const existed = existsSync(path);
      mkdirSync(path, { recursive: true });
      if (!existed && existsSync(path)) recordChangeset(projectDir, changeset, "dirs_created", ".roll/domain");
    }
    if (approved.has("briefs")) {
      const path = join(projectDir, ".roll", "briefs");
      const existed = existsSync(path);
      mkdirSync(path, { recursive: true });
      if (!existed && existsSync(path)) recordChangeset(projectDir, changeset, "dirs_created", ".roll/briefs");
    }

    renderAndSeed(projectDir, plan, changeset);
    printMergeSummary(summary);

    if (fields.gitignoreDotRoll) addRollToGitignore(projectDir, changeset);

    process.stdout.write("\n");
    info(m("init.syncing_conventions_to_ai_tools"));
    syncConventions();

    // FIX-283 (AC4): the legacy-onboard adoption path also registers the project.
    registerProject(projectDir);

    process.stdout.write("\n");
    ok(m("init.onboard_apply_complete_onboard"));
    finalizeRollOwnedGit(projectDir);
    return 0;
  } catch (error) {
    err(m3("init.onboard_apply_failed"));
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "") process.stderr.write(`  ${message}\n`);
    process.stderr.write(`  ${m3("init.onboard_apply_recovery")}\n`);
    return 1;
  }
}

// ─── _emit_init_v2_ui (2215-2276) — re-implements lib/roll-init.py ────────────
type StepStatus = "ok" | "skip" | "fail";
interface Step {
  num: number;
  label: string;
  status: StepStatus;
  files?: Array<[string, string]>;
  note?: string;
}
const STATUS_MAP: Record<string, StepStatus> = {
  created: "ok",
  merged: "ok",
  unchanged: "skip",
  overwritten: "ok",
  kept: "skip",
};
const OP_MAP: Record<string, string> = {
  created: "+",
  merged: "~",
  unchanged: "·",
  overwritten: "~",
  kept: "·",
};

function opMarker(op: string): string {
  if (op === "+") return c("green", "+", { bold: true });
  if (op === "~") return c("amber", "~", { bold: true });
  if (op === "·") return c("dim", "·");
  if (op === "✗") return c("red", "✗", { bold: true });
  return c("dim", op);
}
function stepIcon(status: string): string {
  if (status === "ok") return c("green", "✓");
  if (status === "skip") return c("amber", "↷");
  if (status === "fail") return c("red", "✗", { bold: true });
  return c("dim", "·");
}
function fileColor(op: string): string {
  if (op === "+") return "green";
  if (op === "~") return "amber";
  if (op === "✗") return "red";
  return "dim";
}
function divider(char = "─"): string {
  return c("dim", char.repeat(Math.min(COLS, 80)));
}

function emitInitUi(
  projectDir: string,
  hasAgents: boolean,
  syncStatus: StepStatus,
  summary: Summary,
  shouldNudge: boolean,
  mode: "init" | "reinit" | "repair" = hasAgents ? "reinit" : "init",
  nextItemsOverride?: NextItem[],
): void {
  const headerLabel = mode === "repair" ? "REPAIR" : mode === "reinit" ? "REINIT" : "INIT";
  const subtitle = mode === "repair" ? "补齐 Roll 结构" : mode === "reinit" ? "重新合并约定" : "项目初始化";
  const footerLabel = mode === "repair" ? "Repaired" : mode === "reinit" ? "Re-merged" : "Initialized";

  const byFile = new Map<string, string>();
  for (const entry of summary) {
    const idx = entry.indexOf("|");
    if (idx < 0) continue;
    const action = entry.slice(0, idx);
    const fname = entry.slice(idx + 1);
    if (fname !== "") byFile.set(fname, action);
  }
  const step = (num: number, label: string, fname: string): Step => {
    const act = byFile.get(fname);
    if (act === undefined) return { num, label, status: "skip", note: "not modified" };
    return { num, label, status: STATUS_MAP[act] ?? "ok", files: [[OP_MAP[act] ?? "·", fname]] };
  };
  let nextStep = 1;
  const steps: Step[] = [
    { num: nextStep++, label: "Detect project type", status: "ok" },
    step(nextStep++, "Create AGENTS.md", "AGENTS.md"),
    step(nextStep++, "Create .roll/backlog.md", ".roll/backlog.md"),
  ];
  if (byFile.has(".roll/brief.md")) {
    steps.push(step(nextStep++, "Create .roll/brief.md", ".roll/brief.md"));
  }
  steps.push(
    step(nextStep++, "Create .roll/features/", ".roll/features/"),
    step(nextStep++, "Merge existing CLAUDE.md", ".claude/CLAUDE.md"),
    { num: nextStep++, label: "Link skills to AI clients", status: syncStatus },
  );
  const footerStatus: StepStatus = steps.some((s) => s.status === "fail") ? "fail" : "ok";

  const lines: string[] = [];
  const left =
    "  " + c("blue", headerLabel, { bold: true }) + c("dim", "  ·  ") + c("dim", subtitle);
  const right = c("dim", projectDir) + "  ";
  lines.push(row(left, right));
  lines.push(divider());
  lines.push("");

  for (const s of steps) {
    const num = c("dim", `  ${s.num}.`);
    const icon = stepIcon(s.status);
    lines.push(`${num} ${icon}  ${s.label}`);
    for (const [op, fname] of s.files ?? []) {
      lines.push("       " + opMarker(op) + "  " + c(fileColor(op), fname));
    }
    const note = s.note;
    if (note !== undefined && note !== "") {
      const tone = s.status === "fail" ? "red" : "dim";
      lines.push("       " + c(tone, note));
    }
  }

  lines.push("");
  lines.push(divider());

  const fStatus = footerStatus;
  const fLabel = fStatus === "ok" ? footerLabel : "Init incomplete";
  const iconColor = fStatus === "ok" ? "green" : "red";
  const icon = fStatus === "ok" ? "✓" : "✗";
  lines.push("  " + c(iconColor, icon) + " " + c(iconColor, fLabel, { bold: true }));

  const nudgeMsg = shouldNudge ? (renderDesignNudge(msgLang())[0] ?? "") : "";
  const nudgePair: [string, string] | undefined =
    shouldNudge && nudgeMsg !== ""
      ? ((): [string, string] => {
          const sep = nudgeMsg.indexOf(" — ");
          if (sep < 0) return [nudgeMsg, ""];
          return [nudgeMsg.slice(0, sep), nudgeMsg.slice(sep + 3)];
        })()
      : undefined;
  const nextItems: NextItem[] =
    nextItemsOverride ??
    (hasAgents
      ? [
          ...(nudgePair ? [nudgePair] : []),
          ["Edit .roll/backlog.md", "open the backlog and add your first US"],
          ["Run roll loop now", "execute one cycle manually to test the flow"],
          ["Enable loop scheduling", "roll loop on  — let it run hourly"],
          ["Run roll pair status", "see the cross-agent pairing pool and what it cost"],
        ]
      : [
          ...(nudgePair ? [nudgePair] : []),
          [m3("init.next_create_repo"), m3("init.next_push_commands")],
          [m3("init.next_loop_on"), m3("init.next_repo_required")],
          ["Edit .roll/backlog.md", "open the backlog and add your first US"],
          ["Run roll loop now", "execute one cycle manually to test the flow"],
        ]);
  lines.push("");
  lines.push("  " + c("pink", "NEXT", { bold: true }) + c("dim", "  ·  下一步"));
  nextItems.forEach(([label, hint], i) => {
    const num = c("dim", `  ${i + 1}.`);
    lines.push(`${num} ${c("fg", label, { bold: true })}`);
    if (hint !== "") lines.push("     " + c("dim", hint));
  });
  lines.push(divider("═"));

  process.stdout.write(lines.join("\n") + "\n");
}

// ─── FIX-1021: fresh-init project summary + confirmation ─────────────────────

function isStdinInteractive(): boolean {
  return (process.env["ROLL_ASSUME_TTY"] ?? "") === "1" || process.stdin.isTTY === true;
}

interface InitCommandDeps {
  readLine?: () => string;
  forceInteractive?: boolean;
  /**
   * US-INIT-010: seam for the design continuation. Defaults to the real
   * `roll design` command; tests inject a spy so no agent is spawned.
   */
  runDesign?: (args: string[]) => number;
}

function runDesignSync(args: string[]): number {
  const result = designCommand(args);
  if (typeof result === "number") return result;
  process.stderr.write("roll design failed during init handoff: async design continuation is unsupported in init\n");
  return 1;
}

/** US-INIT-010: does the invocation ask to auto-continue into design? */
function wantsAutoContinue(args: string[]): boolean {
  if (args.includes("--yes") || args.includes("-y")) return true;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "--then=design") return true;
    if (a === "--then" && (args[i + 1] ?? "") === "design") return true;
  }
  return false;
}

/**
 * US-INIT-010 — after a fresh init that detected a PRD + empty backlog, offer to
 * continue straight into `roll design` instead of making the user copy-paste the
 * printed NEXT command. The seam:
 *
 * - `roll init` stays cheap + idempotent; `roll design` is a minutes-long agent
 *   run, so we NEVER auto-fire it silently. A consent gate (`[y/N]`) mirrors
 *   init's own `Proceed?` prompt, with a cost notice (AC6).
 * - `--yes` / `--then design` (or a non-TTY without a flag → no) gives the
 *   non-interactive path (AC4).
 * - Only fires when there is a concrete design input (a `--from-file <prd>`);
 *   a bare `roll design` handoff keeps just the printed NEXT hint.
 */
function maybeContinueIntoDesign(
  brief: InitBriefResult | null,
  args: string[],
  deps: InitCommandDeps,
): number {
  if (brief === null) return 0;
  const sourcePath = brief.sourcePath;
  if (sourcePath === undefined || sourcePath === "") return 0; // no concrete input → hint only
  if (!brief.nextCommand.startsWith("roll design")) return 0;

  const auto = wantsAutoContinue(args);
  let proceed: boolean;
  if (auto) {
    proceed = true;
  } else if (!isInitInteractive(deps.forceInteractive)) {
    return 0; // no TTY and no flag → do not run; keep the printed NEXT hint (AC4)
  } else {
    const detected = initCopy(
      `Detected ${sourcePath} and an empty backlog.`,
      `检测到 ${sourcePath}，且 backlog 为空。`,
    );
    const note = initCopy(
      "takes a few minutes · runs an AI agent",
      "需数分钟 · 会调用 AI agent",
    );
    process.stdout.write(`\n  ${c("fg", detected)}\n`);
    const prompt = initCopy(
      `  Run design now? [y/N]  (${note}; or later: ${brief.nextCommand})  `,
      `  现在就跑设计吗？[y/N]  （${note}；也可稍后：${brief.nextCommand}）  `,
    );
    proceed = confirmYesNo(prompt, (s) => process.stderr.write(s), deps.readLine ?? readConfirmLine);
    process.stdout.write("\n");
  }
  if (!proceed) return 0;

  // AC5/AC6: equivalent to the user running `roll design --from-file <prd>`.
  const run = deps.runDesign ?? runDesignSync;
  const status = run(["--from-file", sourcePath]);
  if (status !== 0) {
    const retry = `roll design --from-file ${sourcePath}`;
    process.stderr.write(`roll design failed during init handoff (exit ${status}). Retry manually: ${retry}\n`);
  }
  return status;
}

function isInitInteractive(forceInteractive = false): boolean {
  return forceInteractive || isStdinInteractive();
}

/**
 * For a fresh (non-reinit, non-legacy) project, print the auto-detected summary
 * and ask the user to confirm before scaffolding. In non-interactive contexts
 * (or with `--auto`) the notice is printed and init proceeds without blocking.
 */
function confirmInitProject(
  projectDir: string,
  autoMode: boolean,
  readConfirm?: () => string,
  forceInteractive = false,
): boolean {
  const projectType = scanProjectType(projectDir);
  const lang = msgLang();
  const header = lang === "zh" ? "项目初始化" : "Project setup";

  process.stdout.write("\n");
  process.stdout.write(`  ${c("fg", header, { bold: true })}\n`);
  process.stdout.write(`  ${c("dim", divider())}\n`);
  process.stdout.write(`  ${c("fg", m3("init.detected_project_type", projectType), { bold: true })}\n`);
  process.stdout.write(`  ${c("dim", m3("init.will_scaffold"))}\n`);

  if (autoMode || !isInitInteractive(forceInteractive)) {
    process.stdout.write(`  ${c("amber", m3("init.auto_non_interactive"))}\n`);
    process.stdout.write(`  ${c("dim", divider("═"))}\n`);
    return true;
  }

  process.stdout.write("\n");
  const { BOLD, NC } = pal();
  const reply = confirmYesNo(`  ${BOLD}${m3("init.proceed_prompt")}${NC} [y/N] `, (s) => process.stderr.write(s), readConfirm)
    ? "yes"
    : "no";
  process.stdout.write("\n");
  if (reply !== "yes") {
    info(m3("init.cancelled"));
    process.stdout.write(`  ${c("dim", divider("═"))}\n`);
    return false;
  }
  return true;
}

export function confirmInitProjectForTest(projectDir: string, autoMode: boolean, readConfirm: () => string): boolean {
  return confirmInitProject(projectDir, autoMode, readConfirm, true);
}

function shouldRenderDiagnosisOnly(diagnosis: InitDiagnosis): boolean {
  return (
    diagnosis.kind === "roll-ready" ||
    diagnosis.kind === "roll-partial" ||
    diagnosis.kind === "roll-legacy-layout" ||
    diagnosis.kind === "prd-only" ||
    diagnosis.kind === "ambiguous"
  );
}

function shouldRunFreshConcierge(diagnosis: InitDiagnosis, autoMode: boolean): boolean {
  if (diagnosis.kind === "prd-only") return true;
  return autoMode && diagnosis.kind === "empty";
}

function conciergeNextItems(brief: InitBriefResult | null, diagnosis: InitDiagnosis): NextItem[] | undefined {
  if (brief === null) return undefined;
  return [[brief.nextCommand, diagnosis.kind === "prd-only" ? "turn the product brief into Roll stories" : "turn the project brief into Roll stories"]];
}

function renderEmptyNonInteractiveGuide(diagnosis: InitDiagnosis): string {
  return `${renderInitRecommendation({ ...diagnosis, nextCommand: "roll design" }, msgLang())}\nNo files changed.`;
}

function initCopy(en: string, zh: string): string {
  return msgLang() === "zh" ? zh : en;
}

function listOrNone(values: readonly string[], lang: Lang): string {
  return values.length > 0 ? values.join(", ") : lang === "zh" ? "无" : "none";
}

function detectedRollMarkers(facts: InitFacts): string[] {
  const markers: string[] = [];
  if (facts.roll.dotRoll) markers.push(".roll/");
  if (facts.roll.backlog) markers.push(".roll/backlog.md");
  if (facts.roll.features) markers.push(".roll/features/");
  if (facts.roll.agentsDoc) markers.push("AGENTS.md");
  markers.push(...facts.roll.oldMarkers);
  return [...new Set(markers)].sort();
}

function renderExistingCodebaseDiagnosis(facts: InitFacts, diagnosis: InitDiagnosis): string {
  const lines: string[] = [];
  const lang = msgLang();
  const rollMarkers = detectedRollMarkers(facts);
  const { installed: installedAgents } = discoverOnboardAgents();

  lines.push(`${initCopy("Detected", "检测结果")}: ${initCopy("existing codebase without Roll", "已有代码库，尚未接入 Roll")}`);
  lines.push(`${initCopy("Recommended path", "推荐路径")}: ${diagnosis.recommendedPath}`);
  lines.push(`${initCopy("Facts:", "事实：")}`);
  lines.push(`  - ${initCopy("manifests", "清单文件")}: ${listOrNone(facts.codebase.manifests, lang)}`);
  lines.push(`  - ${initCopy("source dirs", "源码目录")}: ${listOrNone(facts.codebase.sourceDirs, lang)}`);
  lines.push(`  - ${initCopy("test dirs", "测试目录")}: ${listOrNone(facts.codebase.testDirs, lang)}`);
  lines.push(`  - ${initCopy("source files", "源码文件数")}: ${facts.codebase.sourceFileCount}`);
  lines.push(`  - ${initCopy("Roll markers", "Roll 标记")}: ${listOrNone(rollMarkers, lang)}`);
  lines.push(`  - ${initCopy("facts hash", "事实哈希")}: ${computeInitFactsHash(facts)}`);
  lines.push(`${initCopy("Next", "下一步")}: ${diagnosis.nextCommand}`);
  if (installedAgents.length === 0) {
    lines.push(
      `${initCopy("Agent status", "Agent 状态")}: ${initCopy("No suitable AI agent detected on PATH.", "PATH 上没有检测到可用的 AI agent。")}`,
    );
    lines.push(
      initCopy(
        "$roll-onboard requires an AI agent to inspect the codebase.",
        "$roll-onboard 需要 AI agent 读取并诊断代码库。",
      ),
    );
    lines.push(
      initCopy(
        "Install or sign in to an agent CLI (claude, kimi, or pi), then run `roll agent migrate --dry-run` or author ~/.roll/agents.yaml before rerunning `$roll-onboard`.",
        "安装或登录 agent CLI（claude、kimi 或 pi），然后运行 `roll agent migrate --dry-run` 或维护 ~/.roll/agents.yaml，再重新运行 `$roll-onboard`。",
      ),
    );
  } else {
    lines.push(`${initCopy("Agent status", "Agent 状态")}: ${initCopy("available", "可用")}: ${installedAgents.join(", ")}`);
    lines.push(
      initCopy(
        "Run `$roll-onboard` with an available agent, review the artifacts, then run `roll init --apply`.",
        "用可用 agent 运行 `$roll-onboard`，审阅产物后再运行 `roll init --apply`。",
      ),
    );
  }
  lines.push(initCopy("No files changed.", "未修改任何文件。"));
  return lines.join("\n");
}

function renderPartialRollDiagnosis(facts: InitFacts, diagnosis: InitDiagnosis): string {
  const lines: string[] = [];
  const missing = requiredRollMissingPieces(facts);
  lines.push(`${initCopy("Detected", "检测结果")}: ${diagnosis.kind}`);
  lines.push(`${initCopy("Recommended path", "推荐路径")}: ${diagnosis.recommendedPath}`);
  if (diagnosis.reasons.length > 0) {
    lines.push(`${initCopy("Reasons:", "原因：")}`);
    for (const reason of diagnosis.reasons) lines.push(`  - ${reason}`);
  }
  lines.push(`${initCopy("Missing Roll pieces", "缺失的 Roll 组件")}: ${listOrNone(missing, msgLang())}`);
  if (facts.roll.oldMarkers.length > 0) {
    lines.push(`${initCopy("Pre-v2 Roll markers still present", "仍存在的 pre-v2 Roll 标记")}: ${facts.roll.oldMarkers.join(", ")}`);
  }
  lines.push(`${initCopy("Next", "下一步")}: ${diagnosis.nextCommand}`);
  lines.push(initCopy("No files changed.", "未修改任何文件。"));
  return lines.join("\n");
}

function renderLegacyRollDiagnosis(facts: InitFacts, diagnosis: InitDiagnosis): string {
  const lines: string[] = [];
  lines.push(`${initCopy("Detected", "检测结果")}: ${diagnosis.kind}`);
  lines.push(`${initCopy("Recommended path", "推荐路径")}: ${diagnosis.recommendedPath}`);
  lines.push(`${initCopy("Old Roll markers", "旧 Roll 标记")}: ${listOrNone(facts.roll.oldMarkers, msgLang())}`);
  if (diagnosis.reasons.length > 0) {
    lines.push(`${initCopy("Reasons:", "原因：")}`);
    for (const reason of diagnosis.reasons) lines.push(`  - ${reason}`);
  }
  lines.push(`${initCopy("Migration command", "迁移命令")}: ${diagnosis.nextCommand}`);
  lines.push(initCopy("No files changed.", "未修改任何文件。"));
  return lines.join("\n");
}

function promptEmptyProjectBrief(readLine: () => string = () => readConfirmLine()): string {
  process.stdout.write("\nWhat are you building?\n> ");
  try {
    return readLine().trim();
  } catch {
    return "";
  }
}

const PRD_ONLY_SMOKE_FILES = [
  "AGENTS.md",
  ".roll/brief.md",
  ".roll/backlog.md",
  ".roll/features/",
  ".roll/features.md",
  ".roll/onboard-changeset.yaml",
  ".roll/agents.yaml",
  ".roll/.version",
] as const;

function printSmokeCreatedFiles(projectDir: string): void {
  process.stdout.write("\nCreated files:\n");
  for (const rel of PRD_ONLY_SMOKE_FILES) {
    const path = rel.endsWith("/") ? join(projectDir, rel.slice(0, -1)) : join(projectDir, rel);
    if (existsSync(path)) process.stdout.write(`  - ${rel}\n`);
  }
}

function runPrdOnlyAttestSmoke(): number {
  const originalCwd = process.cwd();
  const originalRollHome = process.env["ROLL_HOME"];
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-attest-prd-only-")));
  let status = 1;
  try {
    const smokeHome = join(workspace, ".roll-home");
    mkdirSync(smokeHome, { recursive: true });
    cpSync(join(rollPkgDir(), "conventions"), join(smokeHome, "conventions"), { recursive: true });
    writeFileSync(join(smokeHome, "config.yaml"), "# Roll config\nlang: en\n");
    process.env["ROLL_HOME"] = smokeHome;
    mkdirSync(join(workspace, "docs"), { recursive: true });
    writeFileSync(
      join(workspace, "docs", "intel-radar-PRD.md"),
      "# Intel Radar PRD\n\nBuild a radar for intelligence signals with source ranking and daily review.\n",
    );
    process.stdout.write("roll init attest smoke: prd-only\n");
    process.stdout.write(`workspace: ${workspace}\n`);
    process.chdir(workspace);
    status = initCommand([]);
    process.chdir(originalCwd);
    printSmokeCreatedFiles(workspace);
    return status;
  } finally {
    process.chdir(originalCwd);
    if (originalRollHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = originalRollHome;
    rmSync(workspace, { recursive: true, force: true });
    process.stdout.write(`cleanup: ${existsSync(workspace) ? "failed" : "removed"} ${workspace}\n`);
  }
}

const EXISTING_CODEBASE_SMOKE_FILES = ["README.md", "package.json", "src/index.ts", "tests/index.test.ts"] as const;

function writeExistingCodebaseSmokeFixture(workspace: string): void {
  writeFileSync(join(workspace, "README.md"), "# Existing App\n\nA service with real source and tests.\n");
  writeFileSync(join(workspace, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "index.ts"), "export const value = 1;\n");
  mkdirSync(join(workspace, "tests"), { recursive: true });
  writeFileSync(
    join(workspace, "tests", "index.test.ts"),
    "import { expect, it } from 'vitest';\nit('works', () => expect(1).toBe(1));\n",
  );
}

function printExistingCodebaseSmokeTree(title = "Fixture tree"): void {
  process.stdout.write(`\n${title}:\n`);
  for (const rel of EXISTING_CODEBASE_SMOKE_FILES) process.stdout.write(`  - ${rel}\n`);
}

const EXISTING_CODEBASE_ROLL_SMOKE_FILES = [
  "AGENTS.md",
  ".claude/CLAUDE.md",
  ".roll/init-diagnosis.yaml",
  ".roll/onboard-plan.yaml",
  ".roll/onboard-changeset.yaml",
  ".roll/.version",
  ".roll/backlog.md",
  ".gitignore",
] as const;

function printExistingCodebaseRollState(projectDir: string, title: string): void {
  process.stdout.write(`\n${title}:\n`);
  for (const rel of EXISTING_CODEBASE_ROLL_SMOKE_FILES) {
    process.stdout.write(`  ${rel}: ${existsSync(join(projectDir, rel)) ? "present" : "missing"}\n`);
  }
}

function countText(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function runExistingCodebaseIdempotencyChecks(workspace: string): boolean {
  const gitignore = existsSync(join(workspace, ".gitignore")) ? readFileSync(join(workspace, ".gitignore"), "utf8") : "";
  const changeset = existsSync(join(workspace, ".roll", "onboard-changeset.yaml"))
    ? readFileSync(join(workspace, ".roll", "onboard-changeset.yaml"), "utf8")
    : "";
  const gitignoreRollEntries = gitignore.split("\n").filter((line) => line === ".roll/loop/").length;
  const agentsEntries = countText(changeset, '  - "AGENTS.md"');
  const claudeEntries = countText(changeset, '  - ".claude/CLAUDE.md"');
  const backlogEntries = countText(changeset, '  - ".roll/backlog.md"');
  const ok = gitignoreRollEntries === 1 && agentsEntries === 1 && claudeEntries === 1 && backlogEntries === 1;

  process.stdout.write("\nIdempotency checks:\n");
  process.stdout.write(`  .gitignore .roll/loop/ entries: ${gitignoreRollEntries}\n`);
  process.stdout.write(`  changeset AGENTS.md entries: ${agentsEntries}\n`);
  process.stdout.write(`  changeset .claude/CLAUDE.md entries: ${claudeEntries}\n`);
  process.stdout.write(`  changeset .roll/backlog.md entries: ${backlogEntries}\n`);
  process.stdout.write(`  result: ${ok ? "pass" : "fail"}\n`);
  return ok;
}

function runExistingCodebaseDiagnoseAttestSmoke(): number {
  const originalCwd = process.cwd();
  const originalPath = process.env["PATH"];
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-attest-existing-codebase-")));
  const emptyBin = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-attest-empty-bin-")));
  let status = 1;
  try {
    writeExistingCodebaseSmokeFixture(workspace);
    process.stdout.write("roll init attest smoke: existing-codebase-diagnose\n");
    process.stdout.write(`workspace: ${workspace}\n`);
    printExistingCodebaseSmokeTree();
    process.chdir(workspace);
    process.env["PATH"] = emptyBin;
    status = initCommand([]);
    process.chdir(originalCwd);
    return status;
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
    process.stdout.write(`cleanup: ${existsSync(workspace) ? "failed" : "removed"} ${workspace}\n`);
  }
}

function onboardPlanFixture(hash: string): string {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `version: 1
generated_at: "${ts}"
factsHash: "${hash}"
file_operations:
  - path: .roll/init-diagnosis.yaml
    operation: write
    idempotent: true
  - path: .roll/onboard-plan.yaml
    operation: write
    idempotent: true
merge_intents:
  - target: roll_conventions
    owner: roll-init-apply
    strategy: merge global Roll conventions into AGENTS.md
project_understanding:
  type: cli
  description: invalid-plan smoke
  domains: []
  key_modules: []
scope:
  approved: [backlog]
  declined: []
include_existing: []
privacy:
  gitignore_dot_roll: true
sync_targets: []
enable_loop: false
agent_routes_template: skip
`;
}

function onboardDiagnosisFixture(hash: string): string {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `version: 1
createdAt: "${ts}"
factsHash: "${hash}"
diagnosis:
  kind: codebase-no-roll
  recommendedPath: agentic-onboard
  confidence: high
  reasons:
    - Existing source, tests, or manifests found without Roll markers.
agent:
  name: attest-smoke
  status: available
`;
}

function runExistingCodebaseInvalidPlanAttestSmoke(): number {
  const originalCwd = process.cwd();
  const originalRollHome = process.env["ROLL_HOME"];
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-invalid-plan-")));
  const staleHash = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  try {
    const smokeHome = join(workspace, ".roll-home");
    mkdirSync(smokeHome, { recursive: true });
    cpSync(join(rollPkgDir(), "conventions"), join(smokeHome, "conventions"), { recursive: true });
    writeFileSync(join(smokeHome, "config.yaml"), "# Roll config\nlang: en\n");
    process.env["ROLL_HOME"] = smokeHome;
    writeExistingCodebaseSmokeFixture(workspace);
    mkdirSync(join(workspace, ".roll"), { recursive: true });
    writeFileSync(join(workspace, ".roll", "init-diagnosis.yaml"), onboardDiagnosisFixture(staleHash));
    writeFileSync(join(workspace, ".roll", "onboard-plan.yaml"), onboardPlanFixture(staleHash));

    process.stdout.write("roll init attest smoke: existing-codebase-invalid-plan\n");
    process.stdout.write(`workspace: ${workspace}\n`);
    printExistingCodebaseSmokeTree();
    process.stdout.write("  - .roll/init-diagnosis.yaml\n");
    process.stdout.write("  - .roll/onboard-plan.yaml\n\n");

    process.chdir(workspace);
    const code = initCommand(["--apply", "--auto"]);
    process.chdir(originalCwd);
    process.stdout.write("\nPost-apply mutation check:\n");
    process.stdout.write(`  AGENTS.md: ${existsSync(join(workspace, "AGENTS.md")) ? "present" : "missing"}\n`);
    process.stdout.write(`  .roll/backlog.md: ${existsSync(join(workspace, ".roll", "backlog.md")) ? "present" : "missing"}\n`);
    process.stdout.write(`  .gitignore: ${existsSync(join(workspace, ".gitignore")) ? "present" : "missing"}\n`);
    return code === 0 ? 1 : 0;
  } finally {
    process.chdir(originalCwd);
    if (originalRollHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = originalRollHome;
    rmSync(workspace, { recursive: true, force: true });
    process.stdout.write(`cleanup: ${existsSync(workspace) ? "failed" : "removed"} ${workspace}\n`);
  }
}

function runExistingCodebaseReviewAttestSmoke(): number {
  const originalCwd = process.cwd();
  const originalRollHome = process.env["ROLL_HOME"];
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-review-")));
  try {
    const smokeHome = join(workspace, ".roll-home");
    mkdirSync(smokeHome, { recursive: true });
    cpSync(join(rollPkgDir(), "conventions"), join(smokeHome, "conventions"), { recursive: true });
    writeFileSync(join(smokeHome, "config.yaml"), "# Roll config\nlang: en\n");
    process.env["ROLL_HOME"] = smokeHome;
    writeExistingCodebaseSmokeFixture(workspace);
    const factsHash = computeInitFactsHash(collectInitFacts(workspace));
    mkdirSync(join(workspace, ".roll"), { recursive: true });
    writeFileSync(join(workspace, ".roll", "init-diagnosis.yaml"), onboardDiagnosisFixture(factsHash));
    writeFileSync(join(workspace, ".roll", "onboard-plan.yaml"), onboardPlanFixture(factsHash));

    process.stdout.write("roll init attest smoke: existing-codebase-review\n");
    process.stdout.write(`workspace: ${workspace}\n`);
    printExistingCodebaseSmokeTree();
    process.stdout.write("  - .roll/init-diagnosis.yaml\n");
    process.stdout.write("  - .roll/onboard-plan.yaml\n\n");

    process.chdir(workspace);
    const code = initCommand(["--apply"], { forceInteractive: true, readLine: () => "n" });
    process.chdir(originalCwd);
    process.stdout.write("\nPost-review mutation check:\n");
    process.stdout.write(`  AGENTS.md: ${existsSync(join(workspace, "AGENTS.md")) ? "present" : "missing"}\n`);
    process.stdout.write(`  .roll/backlog.md: ${existsSync(join(workspace, ".roll", "backlog.md")) ? "present" : "missing"}\n`);
    process.stdout.write(`  .gitignore: ${existsSync(join(workspace, ".gitignore")) ? "present" : "missing"}\n`);
    return code === 1 && !existsSync(join(workspace, "AGENTS.md")) && !existsSync(join(workspace, ".roll", "backlog.md")) ? 0 : 1;
  } finally {
    process.chdir(originalCwd);
    if (originalRollHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = originalRollHome;
    rmSync(workspace, { recursive: true, force: true });
    process.stdout.write(`cleanup: ${existsSync(workspace) ? "failed" : "removed"} ${workspace}\n`);
  }
}

function writeExistingCodebaseOnboardArtifacts(workspace: string): void {
  const factsHash = computeInitFactsHash(collectInitFacts(workspace));
  mkdirSync(join(workspace, ".roll"), { recursive: true });
  writeFileSync(join(workspace, ".roll", "init-diagnosis.yaml"), onboardDiagnosisFixture(factsHash));
  writeFileSync(join(workspace, ".roll", "onboard-plan.yaml"), onboardPlanFixture(factsHash));
}

function printExistingCodebaseSmokeSummary(summary: {
  diagnosis: string;
  reviewCheckpoint: boolean;
  applyCode: number | null;
  reapplyCode: number | null;
  idempotency: boolean | null;
  cleanup: string;
}): void {
  process.stdout.write("\nSmoke summary:\n");
  process.stdout.write(`  diagnosis: ${summary.diagnosis}\n`);
  process.stdout.write(`  review checkpoint: ${summary.reviewCheckpoint ? "shown" : "not shown"}\n`);
  process.stdout.write(`  apply result: ${summary.applyCode === null ? "not run" : summary.applyCode === 0 ? "pass" : "fail"}\n`);
  process.stdout.write(`  idempotent re-apply result: ${summary.reapplyCode === null ? "not run" : summary.reapplyCode === 0 ? "pass" : "fail"}\n`);
  process.stdout.write(`  idempotency checks: ${summary.idempotency === null ? "not run" : summary.idempotency ? "pass" : "fail"}\n`);
  process.stdout.write(`  cleanup: ${summary.cleanup}\n`);
}

function runExistingCodebaseAttestSmoke(): number {
  const originalCwd = process.cwd();
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-existing-codebase-")));
  const summary = {
    diagnosis: "not run",
    reviewCheckpoint: false,
    applyCode: null as number | null,
    reapplyCode: null as number | null,
    idempotency: null as boolean | null,
    cleanup: "pending",
  };
  try {
    writeExistingCodebaseSmokeFixture(workspace);
    process.stdout.write("roll init attest smoke: existing-codebase\n");
    process.stdout.write(`workspace: ${workspace}\n`);
    printExistingCodebaseSmokeTree("Before fixture tree");

    const facts = collectInitFacts(workspace);
    const diagnosis = classifyInitState(facts);
    summary.diagnosis = diagnosis.kind;
    process.stdout.write("\nProduction diagnosis:\n");
    process.stdout.write(`${renderExistingCodebaseDiagnosis(facts, diagnosis)}\n`);

    writeExistingCodebaseOnboardArtifacts(workspace);
    process.stdout.write("\nStructured plan artifacts:\n");
    process.stdout.write("  - .roll/init-diagnosis.yaml\n");
    process.stdout.write("  - .roll/onboard-plan.yaml\n");

    process.chdir(workspace);
    const applyCode = initCommand(["--apply"], { forceInteractive: true, readLine: () => "y" });
    process.chdir(originalCwd);
    summary.reviewCheckpoint = true;
    summary.applyCode = applyCode;
    process.stdout.write(`\nApply result: ${applyCode === 0 ? "pass" : "fail"} (exit ${applyCode})\n`);
    printExistingCodebaseRollState(workspace, "After apply tree");
    if (applyCode !== 0) return 1;

    process.chdir(workspace);
    const reapplyCode = initCommand(["--apply", "--auto"]);
    process.chdir(originalCwd);
    summary.reapplyCode = reapplyCode;
    process.stdout.write(`\nIdempotent re-apply result: ${reapplyCode === 0 ? "pass" : "fail"} (exit ${reapplyCode})\n`);
    printExistingCodebaseRollState(workspace, "After idempotent re-apply tree");
    const idempotency = runExistingCodebaseIdempotencyChecks(workspace);
    summary.idempotency = idempotency;
    return reapplyCode === 0 && idempotency ? 0 : 1;
  } finally {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
    summary.cleanup = existsSync(workspace) ? "failed" : "removed";
    process.stdout.write(`cleanup: ${summary.cleanup} ${workspace}\n`);
    printExistingCodebaseSmokeSummary(summary);
  }
}

function printPartialRollState(projectDir: string, title: string): void {
  process.stdout.write(`\n${title}:\n`);
  for (const rel of ["AGENTS.md", ".roll/backlog.md", ".roll/features/", ".roll/features.md", ".roll/.version", ".roll/onboard-changeset.yaml"]) {
    const path = rel.endsWith("/") ? join(projectDir, rel.slice(0, -1)) : join(projectDir, rel);
    process.stdout.write(`  ${rel}: ${existsSync(path) ? "present" : "missing"}\n`);
  }
}

function runPartialAndLegacyAttestSmoke(): number {
  const originalCwd = process.cwd();
  const originalRollHome = process.env["ROLL_HOME"];
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-init-partial-legacy-")));
  let okSmoke = true;
  try {
    const smokeHome = join(workspace, ".roll-home");
    mkdirSync(smokeHome, { recursive: true });
    cpSync(join(rollPkgDir(), "conventions"), join(smokeHome, "conventions"), { recursive: true });
    writeFileSync(join(smokeHome, "config.yaml"), "# Roll config\nlang: en\n");
    process.env["ROLL_HOME"] = smokeHome;

    const partial = join(workspace, "partial-roll");
    mkdirSync(join(partial, ".roll"), { recursive: true });
    writeFileSync(join(partial, "AGENTS.md"), "# Owner Guide\n\nKeep this owner text.\n");
    writeFileSync(join(partial, ".roll", "backlog.md"), "# Owner Backlog\n\nKeep this backlog.\n");
    writeFileSync(join(partial, "BACKLOG.md"), "# Old Roll backlog\n");

    process.stdout.write("roll init attest smoke: partial-and-roll-legacy\n");
    process.stdout.write(`workspace: ${workspace}\n`);
    process.stdout.write("\nPartial Roll diagnosis:\n");
    process.chdir(partial);
    const partialDiagnosis = initCommand([]);
    const repair = initCommand(["--repair", "--auto"]);
    const repairAgain = initCommand(["--repair", "--auto"]);
    process.chdir(originalCwd);
    process.stdout.write(`\nPartial repair result: ${repair === 0 ? "pass" : "fail"} (exit ${repair})\n`);
    process.stdout.write(`Idempotent repair result: ${repairAgain === 0 ? "pass" : "fail"} (exit ${repairAgain})\n`);
    printPartialRollState(partial, "Partial repair state");
    okSmoke = okSmoke && partialDiagnosis === 0 && repair === 0 && repairAgain === 0;

    const legacy = join(workspace, "legacy-roll");
    mkdirSync(join(legacy, "docs", "features"), { recursive: true });
    writeFileSync(join(legacy, "BACKLOG.md"), "# Old Roll backlog\n");
    writeFileSync(join(legacy, "docs", "features", "feature.md"), "# Old feature\n");
    writeExistingCodebaseSmokeFixture(legacy);

    process.stdout.write("\nLegacy Roll diagnosis:\n");
    process.chdir(legacy);
    const legacyDiagnosis = initCommand([]);
    process.chdir(originalCwd);
    process.stdout.write("\nLegacy mutation check:\n");
    process.stdout.write(`  AGENTS.md: ${existsSync(join(legacy, "AGENTS.md")) ? "present" : "missing"}\n`);
    process.stdout.write(`  .roll/: ${existsSync(join(legacy, ".roll")) ? "present" : "missing"}\n`);
    okSmoke = okSmoke && legacyDiagnosis === 0 && !existsSync(join(legacy, "AGENTS.md")) && !existsSync(join(legacy, ".roll"));
    return okSmoke ? 0 : 1;
  } finally {
    process.chdir(originalCwd);
    if (originalRollHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = originalRollHome;
    rmSync(workspace, { recursive: true, force: true });
    process.stdout.write(`cleanup: ${existsSync(workspace) ? "failed" : "removed"} ${workspace}\n`);
  }
}

function runInitAttestSmoke(args: string[]): number {
  if (args.length === 1 && args[0] === "prd-only") return runPrdOnlyAttestSmoke();
  if (args.length === 1 && args[0] === "existing-codebase") return runExistingCodebaseAttestSmoke();
  if (args.length === 1 && args[0] === "existing-codebase-diagnose") return runExistingCodebaseDiagnoseAttestSmoke();
  if (args.length === 1 && args[0] === "existing-codebase-invalid-plan") return runExistingCodebaseInvalidPlanAttestSmoke();
  if (args.length === 1 && args[0] === "existing-codebase-review") return runExistingCodebaseReviewAttestSmoke();
  if (args.length === 1 && args[0] === "partial-and-roll-legacy") return runPartialAndLegacyAttestSmoke();
  err("unknown init attest smoke fixture. Expected: roll init --attest-smoke prd-only | existing-codebase | existing-codebase-diagnose | existing-codebase-invalid-plan | existing-codebase-review | partial-and-roll-legacy");
  return 1;
}

// ─── cmd_init (2147-2210) ─────────────────────────────────────────────────────
/**
 * Returns the exit code for the fully ported init surface.
 */
export function initCommand(args: string[], deps: InitCommandDeps = {}): number {
  if (args[0] === "--diagnose" && args[1] === "--fixture" && args[2] === "state-matrix" && args.length === 3) {
    process.stdout.write(renderStateMatrixFixture(msgLang()));
    return 0;
  }
  if (args[0] === "--attest-smoke") return runInitAttestSmoke(args.slice(1));
  const repairMode = args.includes("--repair");
  const autoMode = args.includes("--auto");
  if (args[0] === "--apply") {
    const applyUnknownFlag = args.slice(1).find((a) => a.startsWith("-") && a !== "--auto");
    if (applyUnknownFlag !== undefined) {
      err(`${m("init.unknown_flag_1")}${applyUnknownFlag}`);
      return 1;
    }
    if (!existsSync(rollTemplates())) {
      err(m("init.no_templates_found_run_roll_setup"));
      return 1;
    }
    let projectDir: string;
    try {
      projectDir = realpathSync(process.cwd());
    } catch {
      projectDir = process.cwd();
    }
    return initApply(projectDir, { autoMode, forceInteractive: deps.forceInteractive, readLine: deps.readLine });
  }
  const KNOWN_INIT_FLAGS = new Set(["--auto", "--repair", "--yes", "-y", "--then", "--then=design"]);
  const unknownFlag = args.find((a) => a.startsWith("-") && !KNOWN_INIT_FLAGS.has(a));
  if (unknownFlag !== undefined) {
    // FIX-238 AC2: name the offending flag (the empty-name message was useless).
    err(`${m("init.unknown_flag_1")}${unknownFlag}`);
    return 1;
  }

  let projectDir: string;
  try {
    projectDir = realpathSync(process.cwd());
  } catch {
    projectDir = process.cwd();
  }
  const initFacts = collectInitFacts(projectDir);
  const initDiagnosis = classifyInitState(initFacts);
  const freshConcierge = shouldRunFreshConcierge(initDiagnosis, autoMode);
  const emptyInteractive = initDiagnosis.kind === "empty" && !autoMode && isInitInteractive(deps.forceInteractive);
  if (repairMode) return initRepair(projectDir, initFacts, initDiagnosis, { autoMode, forceInteractive: deps.forceInteractive, readLine: deps.readLine });
  if (initDiagnosis.kind === "empty" && !autoMode && !emptyInteractive) {
    process.stdout.write(`${renderEmptyNonInteractiveGuide(initDiagnosis)}\n`);
    return 0;
  }
  if (initDiagnosis.kind === "codebase-no-roll") {
    process.stdout.write(`${renderExistingCodebaseDiagnosis(initFacts, initDiagnosis)}\n`);
    return 0;
  }
  if (initDiagnosis.kind === "roll-partial" && !freshConcierge) {
    process.stdout.write(`${renderPartialRollDiagnosis(initFacts, initDiagnosis)}\n`);
    return 0;
  }
  if (initDiagnosis.kind === "roll-legacy-layout") {
    process.stdout.write(`${renderLegacyRollDiagnosis(initFacts, initDiagnosis)}\n`);
    return 0;
  }
  if (shouldRenderDiagnosisOnly(initDiagnosis) && !freshConcierge) {
    process.stdout.write(`${renderInitRecommendation(initDiagnosis, msgLang())}\n`);
    return 0;
  }

  if (!existsSync(rollTemplates())) {
    err(m("init.no_templates_found_run_roll_setup_2"));
    return 1;
  }

  guideExternalToolSetup("init");
  // FIX-394 AC2: best-effort silent Chromium pre-install so the first
  // cycle that needs a web screenshot doesn't download 100-200 MB on the
  // critical path. Never blocks init.
  silentPreinstallChromium();

  // Color decision mirrors _emit_init_v2_ui: NO_COLOR or non-TTY → no color.
  // Set early so the FIX-1021 confirmation prompt also honors it.
  const noColor = (process.env["NO_COLOR"] ?? "") !== "" || !process.stdout.isTTY;
  renderState.useColor = !noColor;

  let hasAgents = false;
  let emptyDescription: string | undefined;
  const summary: Summary = [];

  if (existsSync(join(projectDir, "AGENTS.md"))) {
    hasAgents = true;
  } else if (emptyInteractive) {
    emptyDescription = promptEmptyProjectBrief(deps.readLine);
  } else if (!confirmInitProject(projectDir, autoMode, deps.readLine, deps.forceInteractive)) {
    return 0;
  }

  // Suppressed step echoes (the `{ … } >/dev/null` block) — outcomes captured
  // into the summary and rendered through the UI below.
  mergeGlobalToProject(projectDir, summary);
  mergeClaudeToProject(projectDir, summary);
  writeBacklog(join(projectDir, ".roll", "backlog.md"), summary);
  ensureFeaturesDir(join(projectDir, ".roll", "features"), summary);
  writeFeaturesMd(join(projectDir, ".roll", "features.md"), summary);
  const routesTemplate = process.env["ROLL_AGENT_ROUTES_TEMPLATE"] ?? "default";
  if (routesTemplate !== "skip") initSeedProjectAgents(projectDir, summary);
  writeVersionStamp(projectDir, summary);
  const writesFreshBrief = freshConcierge || emptyInteractive;
  const brief = writesFreshBrief ? writeInitBrief(projectDir, initDiagnosis.kind, initFacts, { emptyDescription }) : null;
  if (brief !== null) summary.push(`${brief.created ? "created" : "unchanged"}|${brief.relPath}`);
  if (writesFreshBrief) recordFreshInitChangeset(projectDir, summary);

  const syncStatus = syncConventions();

  // _install_launchd_plists: output discarded; darwin side effect not reproduced
  // (see the file header's whitelisted-divergence note).

  // FIX-283 (AC4): register this project in the cross-project switcher registry.
  registerProject(projectDir);

  // US-ONBOARD-NUDGE-002: detect PRD + empty-backlog signal for NEXT nudge.
  const shouldNudge = detectDesignHandoff(projectDir).shouldNudge;

  emitInitUi(
    projectDir,
    hasAgents,
    syncStatus,
    summary,
    shouldNudge,
    repairMode ? "repair" : undefined,
    conciergeNextItems(brief, initDiagnosis),
  );

  finalizeRollOwnedGit(projectDir);

  // US-INIT-010: offer to continue straight into design (consent-gated).
  const designStatus = maybeContinueIntoDesign(brief, args, deps);
  if (designStatus !== 0) return designStatus;

  void err;
  return 0;
}
