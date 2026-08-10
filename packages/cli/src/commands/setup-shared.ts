/**
 * @responsibility Provides the shared install and sync primitives used by setup, init, and update.
 */
/**
 * Shared install/sync primitives — TS port of the bin/roll helpers that both
 * `roll setup` and `roll init` (and `roll update`, via setup) lean on:
 *
 *   - env accessors (ROLL_HOME / ROLL_CONFIG / ROLL_GLOBAL / ROLL_TEMPLATES /
 *     ROLL_PKG_DIR / ROLL_PKG_CONVENTIONS)            bin/roll:7-24
 *   - _get_ai_tools / _for_each_ai_tool field split  bin/roll:823-896
 *   - _agent_installed_by_name / _is_ai_installed     bin/roll:137-654
 *   - _sync_convention_for_tool / _sync_conventions   bin/roll:1256-1303
 *   - _pull_conventions / _pull_skills / _prune_dir   bin/roll:949-1040,968-1001
 *   - _link_skills / _sync_skills                      bin/roll:1145-1313
 *   - _install_local / _ensure_config_entries          bin/roll:843-1116
 *   - safe_copy (non-interactive branch)               bin/roll:898-946
 *
 * The frozen bash is the byte-for-byte oracle; these helpers reproduce its
 * filesystem side effects (the only thing setup's snapshot-diff observes) so
 * the ported `_run_setup_step` change/unchanged verdicts match per step.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  AGENT_REGISTRY_NAMES,
  agentInstalledByName as coreAgentInstalledByName,
  isRemovedAgentName,
  planAgentScopeMigration,
  type AgentEnv,
} from "@roll/core";
import type { AgentName } from "@roll/spec";
import { repoRoot } from "../bridge.js";

// ─── env (bin/roll:7-24) ──────────────────────────────────────────────────────
export function rollHome(): string {
  return process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
}
export function rollConfig(): string {
  return join(rollHome(), "config.yaml");
}
export function rollGlobal(): string {
  return join(rollHome(), "conventions", "global");
}
export function rollTemplates(): string {
  return join(rollHome(), "conventions", "templates");
}
/** ROLL_PKG_DIR override (tests isolate the swap tree); else the repo root. */
export function rollPkgDir(): string {
  const o = process.env["ROLL_PKG_DIR"];
  if (o !== undefined && o !== "") return o;
  return repoRoot();
}
export function rollPkgConventions(): string {
  return join(rollPkgDir(), "conventions");
}

// ─── auxiliary skill-tree directories (FIX-1042) ─────────────────────────────
/**
 * The Roll skills package ships a few directories that are NOT routable skills:
 * shared docs, generated reports, helper scripts, route-case fixtures, and
 * tests. They are mirrored into `~/.roll/skills` alongside the real `roll-*`
 * skills, but they must never be symlinked into an agent's `skills/` root —
 * agents such as Reasonix scan every entry there as a skill and warn that the
 * Markdown files have no `description:` frontmatter (FIX-1042).
 *
 * This is the single source of truth for the auxiliary-directory policy; setup
 * (skip + prune) and doctor (pollution report) both consult it so the policy
 * cannot drift between the two.
 */
export const AUXILIARY_SKILL_TREE_DIRS: readonly string[] = [
  "docs",
  "reports",
  "scripts",
  "route-cases",
  "tests",
];

/** Is `name` an auxiliary (non-skill) Roll skill-tree directory? */
export function isAuxiliarySkillTreeDir(name: string): boolean {
  return AUXILIARY_SKILL_TREE_DIRS.includes(name);
}

/**
 * Does `target` (a symlink target) point at a Roll-owned auxiliary skill-tree
 * directory directly under `homeSkillsDir` (i.e. `~/.roll/skills`)? Uses
 * path-boundary-safe component matching — the final path segment must equal an
 * auxiliary name AND its parent must be exactly `homeSkillsDir` — so loose
 * names like `docs-internal` or unrelated roots are never misclassified.
 */
export function isRollAuxiliarySkillTarget(target: string, homeSkillsDir: string): boolean {
  if (target === "") return false;
  const normalized = target.endsWith("/") ? target.slice(0, -1) : target;
  return dirname(normalized) === homeSkillsDir && isAuxiliarySkillTreeDir(basename(normalized));
}

// ─── _get_ai_tools (823) — ai_* entries with ~ expanded ──────────────────────
export function getAiTools(): string[] {
  const cfg = rollConfig();
  if (!existsSync(cfg)) return [];
  const out: string[] = [];
  for (const line of readFileSync(cfg, "utf8").split("\n")) {
    if (/^ai_[a-z_]+:/.test(line)) {
      let entry = line.replace(/^[^:]*:[ \t]*/, "");
      entry = entry.replace(/^~/, homedir());
      out.push(entry);
    }
  }
  return out;
}
/** Field of a "<dir>|<config>|<src>" entry. */
export function aiField(entry: string, idx: number): string {
  return entry.split("|")[idx] ?? "";
}

// ─── canonical_dir (61) / ai_tool_name (69) ──────────────────────────────────
export function canonicalDir(path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** `command -v <bin>` equivalent: is an executable named bin on PATH? */
export function onPath(bin: string): boolean {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const p = join(dir, bin);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

// ─── _agent_installed_by_name (137) ───────────────────────────────────────────
function agentInstalledByName(agent: string, dir = ""): boolean {
  const env: AgentEnv = {
    home: homedir(),
    commandOnPath: onPath,
    dirExists: existsSync,
    fileExecutable: (p) => {
      try {
        const st = statSync(p);
        return st.isFile() && (st.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
  };
  return coreAgentInstalledByName(env, agent, dir);
}

/** _is_ai_installed (639): map a config dir → canonical agent, then probe. */
export function isAiInstalled(aiDir: string): boolean {
  let bn = basename(aiDir).replace(/^\./, "");
  if (bn === "agent" || bn === "workspace") {
    bn = basename(dirname(aiDir)).replace(/^\./, "");
  }
  if (bn === "kimi-code") bn = "kimi";
  if (bn === "antigravity" || bn === "gemini") bn = "agy";
  return agentInstalledByName(bn, aiDir);
}

// ─── _prune_dir (949) ─────────────────────────────────────────────────────────
function listDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function pruneDir(installedDir: string, sourceDir: string): void {
  if (!existsSync(installedDir)) return;
  for (const name of listDirEntries(installedDir)) {
    if (name === "." || name === "..") continue;
    const installedF = join(installedDir, name);
    let isFile = false;
    try {
      isFile = statSync(installedF).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    if (!existsSync(join(sourceDir, name))) rmSync(installedF, { force: true });
  }
}

// ─── safe_copy (898) — non-interactive branch only ───────────────────────────
/**
 * setup runs under `_run_setup_step` which redirects stdin to /dev/null, so
 * `[[ ! -t 0 ]]` is always true: a differing existing dst is silently
 * overwritten. force=true overwrites unconditionally; identical content skips.
 */
function safeCopy(src: string, dst: string, force: boolean): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && !force) {
    if (sameFile(src, dst)) return;
  }
  copyFileSync(src, dst);
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// ─── _pull_conventions (1004) ─────────────────────────────────────────────────
function listFiles(dir: string, includeDot: boolean): string[] {
  const out: string[] = [];
  for (const name of listDirEntries(dir)) {
    if (name === "." || name === "..") continue;
    if (!includeDot && name.startsWith(".")) continue;
    if (includeDot && !name.startsWith(".")) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) out.push(name);
    } catch {
      /* skip */
    }
  }
  return out;
}

function pullConventions(force: boolean): void {
  const pkgConv = rollPkgConventions();
  if (!existsSync(pkgConv)) return; // err+return 1 in bash; FS unchanged
  mkdirSync(rollGlobal(), { recursive: true });
  for (const t of ["fullstack", "frontend-only", "backend-service", "cli"]) {
    mkdirSync(join(rollTemplates(), t), { recursive: true });
  }
  const globalSrc = join(pkgConv, "global");
  for (const name of listFiles(globalSrc, false)) {
    safeCopy(join(globalSrc, name), join(rollGlobal(), name), force);
  }
  for (const name of listFiles(globalSrc, true)) {
    safeCopy(join(globalSrc, name), join(rollGlobal(), name), force);
  }
  pruneDir(rollGlobal(), globalSrc);

  const tplSrcRoot = join(pkgConv, "templates");
  for (const tplName of listDirEntries(tplSrcRoot)) {
    const tplDir = join(tplSrcRoot, tplName);
    try {
      if (!statSync(tplDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const dstDir = join(rollTemplates(), tplName);
    for (const name of listFiles(tplDir, false)) {
      safeCopy(join(tplDir, name), join(dstDir, name), force);
    }
    for (const name of listFiles(tplDir, true)) {
      safeCopy(join(tplDir, name), join(dstDir, name), force);
    }
    pruneDir(dstDir, tplDir);
  }
}

// ─── _pull_skills (968) ───────────────────────────────────────────────────────
function syncSkillTree(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const sourceNames = new Set(listDirEntries(sourceDir));

  for (const name of listDirEntries(destDir)) {
    if (!sourceNames.has(name)) rmSync(join(destDir, name), { recursive: true, force: true });
  }

  for (const name of sourceNames) {
    const src = join(sourceDir, name);
    const dst = join(destDir, name);
    let st;
    try {
      st = statSync(src);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (lstatType(dst) !== "dir" && lstatType(dst) !== "none") rmSync(dst, { recursive: true, force: true });
      syncSkillTree(src, dst);
    } else if (st.isFile()) {
      if (lstatType(dst) === "dir") rmSync(dst, { recursive: true, force: true });
      if (!sameFile(src, dst)) copyFileSync(src, dst);
    }
  }
}

function pullSkills(): void {
  const pkgSkills = join(rollPkgDir(), "skills");
  if (!existsSync(pkgSkills)) return; // err+return 1; FS unchanged
  const homeSkills = join(rollHome(), "skills");
  mkdirSync(homeSkills, { recursive: true });
  for (const skillName of listDirEntries(pkgSkills)) {
    const skillDir = join(pkgSkills, skillName);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const destDir = join(homeSkills, skillName);
    syncSkillTree(skillDir, destDir);
  }
  // Prune whole skills removed from the repo.
  for (const installedName of listDirEntries(homeSkills)) {
    const installedDir = join(homeSkills, installedName);
    try {
      if (!statSync(installedDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(pkgSkills, installedName))) {
      rmSync(installedDir, { recursive: true, force: true });
    }
  }
}

// ─── _ensure_config_entries (843) ─────────────────────────────────────────────
const DEFAULT_AI_KEYS: Array<[string, string]> = [
  ["ai_claude", "~/.claude|CLAUDE.md|CLAUDE.md"],
  ["ai_kimi", "~/.kimi|AGENTS.md|AGENTS.md"],
  ["ai_kimi_code", "~/.kimi-code|AGENTS.md|AGENTS.md"],
  ["ai_codex", "~/.codex|AGENTS.md|AGENTS.md"],
  ["ai_pi", "~/.pi/agent|AGENTS.md|AGENTS.md"],
  ["ai_agy", "~/.agentrules|AGENTS.md|AGENTS.md"],
  ["ai_reasonix", "~/.reasonix|AGENTS.md|AGENTS.md"],
  ["ai_cursor", "~/.cursor|AGENTS.md|AGENTS.md"],
];

function ensureConfigEntries(): void {
  const cfg = rollConfig();
  if (!existsSync(cfg)) return;
  const original = readFileSync(cfg, "utf8");
  let lines = original.split("\n");

  // US-AGENT-045 AC5: prune ai_* entries for removed agents so doctor / agent
  // use no longer surface them.
  let pruned = 0;
  const keepers: string[] = [];
  for (const line of lines) {
    const m = /^ai_([a-z_]+):/.exec(line);
    if (m !== null && isRemovedAgentName((m[1] ?? "").replace(/_code$/, ""))) {
      pruned += 1;
      continue;
    }
    keepers.push(line);
  }
  if (pruned > 0) lines = keepers;

  let added = 0;
  for (const [key, val] of DEFAULT_AI_KEYS) {
    const has = new RegExp(`^${key}:`, "m").test(lines.join("\n"));
    if (has) continue;
    const idx = lines.indexOf("# User preferences");
    if (idx >= 0) {
      lines = [...lines.slice(0, idx), `${key}: ${val}`, ...lines.slice(idx)];
    } else {
      // bash `echo >>` appends a line; if the file ends with a trailing newline
      // the split produced a final "" element — replace it to keep one newline.
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines[lines.length - 1] = `${key}: ${val}`;
        lines.push("");
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    added += 1;
  }
  if (added > 0 || pruned > 0) writeFileSync(cfg, lines.join("\n"));
}

// ─── _install_local (1043) ────────────────────────────────────────────────────
const DEFAULT_CONFIG = `# Roll Configuration
# Edit this file, then run \`roll setup\` to apply.

# AI tools — each entry controls both convention sync and skill linking
# Format: <name>: <dir>|<config_file>|<convention_src>
ai_claude: ~/.claude|CLAUDE.md|CLAUDE.md
ai_kimi: ~/.kimi|AGENTS.md|AGENTS.md
ai_kimi_code: ~/.kimi-code|AGENTS.md|AGENTS.md
ai_codex: ~/.codex|AGENTS.md|AGENTS.md
ai_pi: ~/.pi/agent|AGENTS.md|AGENTS.md
ai_agy: ~/.agentrules|AGENTS.md|AGENTS.md
ai_reasonix: ~/.reasonix|AGENTS.md|AGENTS.md
ai_cursor: ~/.cursor|AGENTS.md|AGENTS.md

# User preferences
default_language: zh
default_project_type: fullstack
editor: \${EDITOR:-vim}

# Delivery is driven by \`roll loop go\` in an agent session you open; Roll installs
# no timers. These schedule keys are kept for compatibility but NOTHING READS THEM —
# \`roll config --list\` marks them [inactive]. A fresh config no longer seeds one.
`;

function firstInstalledAgent(): string | null {
  for (const agent of AGENT_REGISTRY_NAMES) {
    if (agentInstalledByName(agent)) return agent;
  }
  return null;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function writeMachineAgentScope(superviseAgent?: string): void {
  const cfg = rollConfig();
  const target = join(rollHome(), "agents.yaml");
  const globalConfigText = existsSync(cfg) ? readFileSync(cfg, "utf8") : DEFAULT_CONFIG;
  const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  const machineSuperviseAgent =
    superviseAgent !== undefined && (AGENT_REGISTRY_NAMES as readonly string[]).includes(superviseAgent)
      ? (superviseAgent as AgentName)
      : undefined;
  const plan = planAgentScopeMigration({
    globalConfigText,
    machineAgentsText: existing,
    machineTargetPath: target,
    projectTargetPath: ".roll/agents.yaml",
    machineSuperviseAgent,
  });
  if (!plan.machine.changed) return;
  mkdirSync(dirname(target), { recursive: true });
  atomicWrite(target, plan.machine.text);
}

/** Port of _install_local. Returns false on a hard source-missing failure. */
export function installLocal(force: boolean): boolean {
  if (!existsSync(rollPkgConventions())) return false;
  pullConventions(force);
  pullSkills();

  const cfg = rollConfig();
  // Recreate config if it has no ai_* entries.
  if (existsSync(cfg) && !/^ai_[a-z_]+:/m.test(readFileSync(cfg, "utf8"))) {
    copyFileSync(cfg, `${cfg}.bak`);
    rmSync(cfg, { force: true });
  }
  if (!existsSync(cfg)) {
    writeFileSync(cfg, DEFAULT_CONFIG);
    const detected = firstInstalledAgent();
    writeMachineAgentScope(detected ?? undefined);
  }
  ensureConfigEntries();
  if (!existsSync(join(rollHome(), "agents.yaml"))) writeMachineAgentScope(firstInstalledAgent() ?? undefined);
  return true;
}

// ─── _sync_convention_for_tool (1256) / _sync_conventions (1300) ──────────────
function syncConventionForTool(src: string, mainDst: string, force: boolean): void {
  if (!existsSync(src)) return;
  const dstDir = dirname(mainDst);
  if (dstDir !== join(homedir(), ".claude") && !isAiInstalled(dstDir) && !existsSync(dstDir)) {
    return;
  }
  mkdirSync(dstDir, { recursive: true });
  const wkFile = join(dstDir, "roll.md");
  if (force || !sameFile(src, wkFile)) copyFileSync(src, wkFile);
  if (!existsSync(mainDst)) {
    writeFileSync(mainDst, "@roll.md\n");
  } else if (!readFileSync(mainDst, "utf8").includes("@roll.md")) {
    writeFileSync(mainDst, readFileSync(mainDst, "utf8") + "\n@roll.md\n");
  }
}

/** Port of _sync_conventions — iterate ai_* tools. */
export function syncConventions(force: boolean): void {
  for (const entry of getAiTools()) {
    const aiDir = aiField(entry, 0);
    const cfgName = aiField(entry, 1);
    const src = aiField(entry, 2);
    syncConventionForTool(join(rollGlobal(), src), join(aiDir, cfgName), force);
  }
}

// ─── _link_skills (1145) / _sync_skills (1306) ────────────────────────────────
function lstatType(p: string): "link" | "file" | "dir" | "none" {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return "link";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "file";
  } catch {
    return "none";
  }
}

function linkSkills(): void {
  const rollSkillsReal = canonicalDir(join(rollHome(), "skills"));
  const pkgSkillsReal = canonicalDir(join(rollPkgDir(), "skills"));
  for (const entry of getAiTools()) {
    const aiDir = aiField(entry, 0);
    if (aiDir !== join(homedir(), ".claude") && !isAiInstalled(aiDir) && !existsSync(aiDir)) {
      continue;
    }
    mkdirSync(aiDir, { recursive: true });
    const skillsDir = join(aiDir, "skills");
    const aiDirReal = canonicalDir(aiDir);
    if (
      aiDirReal !== null &&
      (aiDirReal === rollPkgDir() || aiDirReal.startsWith(`${rollPkgDir()}/`))
    ) {
      continue;
    }
    let skillsReal = canonicalDir(skillsDir);
    if (
      skillsReal !== null &&
      pkgSkillsReal !== null &&
      (skillsReal === pkgSkillsReal || skillsReal.startsWith(`${pkgSkillsReal}/`))
    ) {
      continue;
    }
    // Whole-dir symlink handling.
    if (lstatType(skillsDir) === "link") {
      const target = (() => {
        try {
          return readlinkSync(skillsDir);
        } catch {
          return "";
        }
      })();
      if (skillsReal !== null && skillsReal === rollSkillsReal) continue;
      if (skillsReal === null) {
        rmSync(skillsDir, { force: true });
      } else {
        void target;
        continue;
      }
    }
    mkdirSync(skillsDir, { recursive: true });
    skillsReal = canonicalDir(skillsDir);
    if (
      skillsReal !== null &&
      pkgSkillsReal !== null &&
      (skillsReal === pkgSkillsReal || skillsReal.startsWith(`${pkgSkillsReal}/`))
    ) {
      continue;
    }
    // Prune stale roll-* symlinks pointing into ~/.roll/skills no longer
    // present, and remove auxiliary-directory pollution mounted by older setup
    // (FIX-1042) — symlinks like `skills/docs → ~/.roll/skills/docs/` that
    // agents misread as undescribed skills.
    const homeSkills = join(rollHome(), "skills");
    const homeSkillsPrefix = `${homeSkills}/`;
    for (const name of listDirEntries(skillsDir)) {
      const link = join(skillsDir, name);
      if (lstatType(link) !== "link") continue;
      let target = "";
      try {
        target = readlinkSync(link);
      } catch {
        target = "";
      }
      if (name.startsWith("roll-")) {
        if (target.startsWith(homeSkillsPrefix) && !existsSync(link)) {
          rmSync(link, { force: true });
        }
        continue;
      }
      // Non-skill entry: remove it when it is a Roll-owned auxiliary mount.
      if (isRollAuxiliarySkillTarget(target, homeSkills)) {
        rmSync(link, { force: true });
      }
    }
    // Create/repair per-skill symlinks — auxiliary skill-tree directories are
    // never mounted into an agent skills root (FIX-1042).
    for (const skillName of listDirEntries(homeSkills)) {
      if (isAuxiliarySkillTreeDir(skillName)) continue;
      const skillDir = `${join(homeSkills, skillName)}/`;
      try {
        if (!statSync(join(homeSkills, skillName)).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillLink = join(skillsDir, skillName);
      const t = lstatType(skillLink);
      if (t === "link") {
        let current = "";
        try {
          current = readlinkSync(skillLink);
        } catch {
          current = "";
        }
        if (current !== skillDir) {
          rmSync(skillLink, { force: true });
          symlinkSync(skillDir, skillLink);
        }
      } else if (t === "none") {
        symlinkSync(skillDir, skillLink);
      }
    }
  }
}

/** Port of _sync_skills. */
export function syncSkills(force: boolean): void {
  void force;
  pullSkills();
  linkSkills();
}
