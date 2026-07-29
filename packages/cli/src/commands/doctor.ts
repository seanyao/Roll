/**
 * `roll doctor` — TS port of bin/roll cmd_doctor (1700-1705) and its four
 * sections, IN ORDER:
 *   1. _doctor_agent_section          (1727-1757)
 *   2. _doctor_pr_section             (1792-1827) + hints (1530-1550, 1860-1873)
 *   3. _doctor_skills_catalog_section (1710-1722)
 *   4. _doctor_launchd_stale_section  (1765-1790)  (Darwin only)
 *
 * Every probe honors the same env overrides bash uses (HOME, ROLL_HOME via
 * ROLL_CONFIG, ROLL_PKG_DIR, _LAUNCHD_DIR, PATH, gh/git availability) so
 * difftests can fabricate both healthy and broken fixtures. Bilingual section
 * headers come from `ROLL_LANG_RESOLVED=en msg` / `=zh msg` in bash — i.e. the
 * EN line then the ZH line of the same key, regardless of locale.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { agentInstalledByName as coreAgentInstalledByName, agentIsKnown, canonicalAgentName, type AgentEnv } from "@roll/core";
import { resolveLang, t, v2Catalog, v3Catalog, type Lang } from "@roll/spec";
import { repoRoot } from "../bridge.js";
import { generateCatalog } from "./skills.js";
import { isRollAuxiliarySkillTarget } from "./setup-shared.js";
import { collectExternalTools, renderExternalToolDoctorSection, type ExternalToolState } from "../lib/external-tools.js";
import { collectToolReadinessDoctorRows, renderToolReadinessDoctorSection } from "../lib/tool-readiness-doctor.js";
import { collectBrowserEnvironmentReadiness, renderBrowserReadinessDoctorRow } from "../lib/browser-readiness-doctor.js";
import { collectCapturePolicyReadiness, renderCapturePolicyReadinessDoctorSection, type CapturePolicyReadiness } from "../lib/capture-policy-readiness.js";
import { collectBrowserTruth } from "../lib/browser-truth-collect.js";
import { renderBrowserTruthDoctorRow } from "../lib/browser-truth-surface.js";
import { detectDesignHandoff, renderDesignNudge } from "../lib/onboard-nudge.js";
import { collectLanguageDoctorFindings, renderLanguageDoctorSection } from "../lib/language-doctor.js";
import { rebuildSkipStateFromEvidence, readRows, readEvents, runtimeDir as pardonRuntimeDir } from "../lib/pardon-skip-list.js";
import { readSkipState, writeSkipState } from "../runner/skip-cards.js";
import { resolveBinaryStalenessReadout } from "../runner/binary-staleness.js";
import { detectMainCheckoutWriteProtectionResidue, recoverMainCheckoutWriteProtectionResidue } from "../runner/main-checkout-guard.js";
import { rollVersion } from "./version.js";

interface Palette {
  GREEN: string;
  YELLOW: string;
  CYAN: string;
  RED: string;
  NC: string;
}
function palette(): Palette {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { GREEN: "", YELLOW: "", CYAN: "", RED: "", NC: "" }
    : { GREEN: "\x1b[0;32m", YELLOW: "\x1b[0;33m", CYAN: "\x1b[0;36m", RED: "\x1b[0;31m", NC: "\x1b[0m" };
}

function rollConfigPath(): string {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  return join(rollHome, "config.yaml");
}
function pkgDir(): string {
  return process.env["ROLL_PKG_DIR"] ?? repoRoot();
}

function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

/** EN line + ZH line of `key` (bash `ROLL_LANG_RESOLVED=en/zh msg`). */
function bilingual(key: string): string[] {
  return [t(v2Catalog, "en", key), t(v2Catalog, "zh", key)];
}

const out: { lines: string[] } = { lines: [] };
function emit(line: string): void {
  out.lines.push(line);
}

interface DoctorDeps {
  externalTools?: () => readonly ExternalToolState[];
  browserReadiness?: () => ReturnType<typeof collectBrowserEnvironmentReadiness>;
  capturePolicyReadiness?: () => CapturePolicyReadiness;
}

function terminalScreenRecordingPreflight(state: ExternalToolState | undefined): {
  status: "ok" | "skip" | "permission-missing" | "missing-tool";
  detail: string;
  repairCommand?: string;
} {
  if (state === undefined) {
    return { status: "skip", detail: "macOS screencapture requirement state is unavailable." };
  }
  if (state.status === "ok") {
    return { status: "ok", detail: state.detail };
  }
  if (state.status === "permission-missing") {
    return { status: "permission-missing", detail: state.detail, ...(state.repairCommand !== undefined ? { repairCommand: state.repairCommand } : {}) };
  }
  if (state.status === "missing") {
    return { status: "missing-tool", detail: state.detail, ...(state.repairCommand !== undefined ? { repairCommand: state.repairCommand } : {}) };
  }
  return { status: "skip", detail: state.detail };
}

function commandOnPath(bin: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    try {
      const st = statSync(join(dir, bin));
      if (!st.isFile()) continue;
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}
/** Faithful port of bin/roll _agent_installed_by_name(name, dir) (137-169). */
function agentInstalledByName(agent: string, dir: string): boolean {
  const env: AgentEnv = {
    home: homedir(),
    commandOnPath,
    dirExists: safeIsDir,
    fileExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
  return coreAgentInstalledByName(env, agent, dir);
}
function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// bash printf `%-Ns` left-justifies to N BYTES (not chars) — a CJK string
// consumes its UTF-8 byte width, so it gets fewer trailing spaces. Mirror that.
const padEnd = (s: string, w: number): string => {
  const bytes = Buffer.byteLength(s, "utf8");
  return bytes >= w ? s : s + " ".repeat(w - bytes);
};

// ── 1. agent section ─────────────────────────────────────────────────────────
function agentSection(p: Palette): void {
  const cfg = rollConfigPath();
  if (!existsSync(cfg)) return; // [[ -f "$ROLL_CONFIG" ]] || return 0
  emit("");
  for (const l of bilingual("doctor.agent_detection")) emit(l);
  emit("");
  const text = readFileSync(cfg, "utf8");
  let primary = "";
  for (const line of text.split("\n")) {
    const m = /^primary_agent:\s*(.*)$/.exec(line);
    if (m !== null) primary = (m[1] ?? "").trim();
  }
  const primaryCanonical = canonicalAgentName(primary);
  const home = homedir();
  for (const line of text.split("\n")) {
    // IFS=: read -r _key _value → split on FIRST colon, value = remainder.
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (!/^ai_/.test(key)) continue;
    const rawName = key.slice("ai_".length);
    if (rawName === "kimi_code") continue; // dedupe
    if (!agentIsKnown(rawName)) continue; // skip removed/unknown agents (US-AGENT-045)
    const name = canonicalAgentName(rawName);
    let dir = value.split("|")[0] ?? ""; // ${_value%%|*}
    dir = dir.replace(/^ /, ""); // ${_dir# } strip ONE leading space
    if (dir.startsWith("~")) dir = home + dir.slice(1); // ${_dir/#\~/$HOME}
    const installed = agentInstalledByName(name, dir)
      ? t(v2Catalog, msgLang(), "doctor.agent_installed")
      : t(v2Catalog, msgLang(), "doctor.agent_missing");
    const dirExists = safeIsDir(dir)
      ? t(v2Catalog, msgLang(), "doctor.agent_dir_exists")
      : t(v2Catalog, msgLang(), "doctor.agent_dir_missing");
    const tag = name === primaryCanonical ? `  (${t(v2Catalog, msgLang(), "doctor.agent_primary_label")})` : "";
    // printf "  %-10s  %-14s  %s%s\n"
    emit(`  ${padEnd(name, 10)}  ${padEnd(installed, 14)}  ${dirExists}${tag}`);
  }
}

// ── 2. pr section ─────────────────────────────────────────────────────────────
function ghAvailable(): boolean {
  return commandOnPath("gh");
}
/** _doctor_branch_protection_state → enabled | disabled | unknown (1830-1849). */
function branchProtectionState(): "enabled" | "disabled" | "unknown" {
  if (!ghAvailable()) return "unknown";
  let slug = "";
  try {
    slug = execFileSync("gh", ["repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name'], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    slug = "";
  }
  if (slug === "") return "unknown";
  let required = "";
  try {
    required = execFileSync(
      "gh",
      ["api", `repos/${slug}/branches/main/protection`, "--jq", ".required_pull_request_reviews.required_approving_review_count // 0"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    required = "";
  }
  if (required === "") return "unknown";
  return Number(required) >= 1 ? "enabled" : "disabled";
}
function eventWorkflowState(): "present" | "absent" {
  return existsSync(join(".github", "workflows", "pr-review-event.yml")) ? "present" : "absent";
}
function insideGitWorkTree(): boolean {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ===
      "true"
    );
  } catch {
    return false;
  }
}
/** _print_pr_pipeline_hint heredoc (1531-1549) — verbatim literal text. */
function prPipelineHint(): string[] {
  return [
    "",
    "  Optional — enable AI review as a hard merge gate (path C).",
    "  可选 —— 启用 AI 评审作为合并双门（路径 C）。",
    "",
    "  Run once per repo (requires admin token), then claude-code-review.yml",
    "  approvals become a required merge gate alongside CI:",
    "  每个仓库执行一次（需要管理员 token），之后 claude-code-review.yml 的",
    "  approve 将与 CI 一起成为合并必经的双门：",
    "",
    "      gh api -X PATCH repos/<owner>/<repo>/branches/main/protection \\",
    "        -f required_pull_request_reviews.required_approving_review_count=1",
    "",
    "  Escape hatch: add [skip-ai-review] to a PR body, or include",
    "  SKIP_AI_REVIEW in any commit message, to bypass AI review for that PR.",
    "  紧急通道：在 PR body 加 [skip-ai-review]，或在任一 commit message",
    "  里包含 SKIP_AI_REVIEW，可对该 PR 绕过 AI 评审。",
    "",
  ];
}
/** _print_pr_event_hint (1860-1873) — note _zh keys are absent → key echoed. */
function prEventHint(lang: Lang): string[] {
  return [
    "",
    `  ${t(v2Catalog, lang, "doctor.pr_event_optional")}`,
    `  ${t(v2Catalog, lang, "doctor.pr_event_optional_zh")}`,
    "",
    `  ${t(v2Catalog, lang, "doctor.pr_event_without")}`,
    `  ${t(v2Catalog, lang, "doctor.pr_event_without_zh")}`,
    "",
    "      cp templates/workflows/pr-review-event.yml .github/workflows/",
    "",
    `  ${t(v2Catalog, lang, "doctor.pr_event_secret")}`,
    `  ${t(v2Catalog, lang, "doctor.pr_event_secret_zh")}`,
    "",
  ];
}
function prSection(lang: Lang): void {
  if (!insideGitWorkTree()) return; // git rev-parse --is-inside-work-tree || return 0
  emit("");
  for (const l of bilingual("doctor.pr_review_extras")) emit(l);
  emit("");
  const protection = branchProtectionState();
  if (protection === "enabled") {
    emit(`  ${t(v2Catalog, lang, "doctor.pr_double_gate_enabled")}`);
  } else if (protection === "disabled") {
    emit(`  ${t(v2Catalog, lang, "doctor.pr_double_gate_disabled")}`);
    for (const l of prPipelineHint()) emit(l);
  } else {
    emit(`  ${t(v2Catalog, lang, "doctor.pr_double_gate_unknown")}`);
    for (const l of prPipelineHint()) emit(l);
  }
  if (eventWorkflowState() === "present") {
    emit(`  ${t(v2Catalog, lang, "doctor.pr_event_enabled")}`);
  } else {
    emit(`  ${t(v2Catalog, lang, "doctor.pr_event_disabled")}`);
    for (const l of prEventHint(lang)) emit(l);
  }
}

// ── 3. skills catalog section ────────────────────────────────────────────────
function skillsCatalogSection(lang: Lang): void {
  const skillsDir = join(pkgDir(), "skills");
  if (!safeIsDir(skillsDir)) return; // [[ -d "$ROLL_PKG_DIR/skills" ]] || return 0
  const target = join(pkgDir(), "guide", "skills.md");
  emit("");
  for (const l of bilingual("skills.doctor_heading")) emit(l);
  let drift: boolean;
  if (!existsSync(target)) {
    drift = true;
  } else {
    // diff -u target <(generate) → identical ⇒ no drift.
    const fresh = join(mkdtempSync(join(tmpdir(), "roll-doctor-")), "skills.md");
    writeFileSync(fresh, generateCatalog());
    drift = readFileSync(target, "utf8") !== readFileSync(fresh, "utf8");
  }
  emit(`  ${t(v2Catalog, lang, drift ? "skills.doctor_drift" : "skills.doctor_ok")}`);
}

const AGENT_SESSION_GITIGNORE_ENTRIES = [".roll/loop/", ".pi/", ".kimi/", ".kimi-code/", ".reasonix/"] as const;

function gitignoreOwnershipSection(lang: Lang): void {
  const gitignore = join(process.cwd(), ".gitignore");
  if (!existsSync(gitignore)) return;
  const current = readFileSync(gitignore, "utf8").split("\n");
  const missing = AGENT_SESSION_GITIGNORE_ENTRIES.filter((entry) => !current.includes(entry));
  if (missing.length === 0) return;
  emit("");
  emit(lang === "zh" ? "Roll 自产文件 ignore 清单" : "Roll generated-file ignore list");
  emit("");
  emit(`  ${lang === "zh" ? "建议补齐 .gitignore：" : "Recommended .gitignore additions:"} ${missing.join(" ")}`);
}

// ── FIX-1042: agent skill-root pollution (auxiliary dirs mounted as skills) ──
function rollHomeDir(): string {
  return process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
}

export interface SkillRootPollution {
  agent: string;
  /** The polluting symlink path inside the agent's skills/ root. */
  link: string;
  /** Its target — a Roll-owned auxiliary skill-tree directory. */
  target: string;
}

/**
 * Scan each configured agent's `skills/` root for auxiliary-directory pollution
 * — symlinks that point at Roll-owned auxiliary skill-tree directories under
 * `~/.roll/skills` (e.g. `docs`, `reports`). These are NOT auth/network
 * failures: the agent is installed and reachable; its skill root just carries
 * non-skill mounts an older `roll setup` created. Reuses the shared
 * setup-shared predicate so the auxiliary-dir policy never drifts.
 */
export function detectSkillRootPollution(configText: string, home: string): SkillRootPollution[] {
  const homeSkills = join(rollHomeDir(), "skills");
  const found: SkillRootPollution[] = [];
  for (const line of configText.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    if (!/^ai_/.test(key)) continue;
    const rawName = key.slice("ai_".length);
    if (rawName === "kimi_code") continue; // dedupe (matches agentSection)
    if (!agentIsKnown(rawName)) continue;
    const name = canonicalAgentName(rawName);
    let dir = (line.slice(idx + 1).split("|")[0] ?? "").replace(/^ /, "");
    if (dir.startsWith("~")) dir = home + dir.slice(1);
    const skillsDir = join(dir, "skills");
    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const link = join(skillsDir, entry);
      let target = "";
      try {
        if (!lstatSync(link).isSymbolicLink()) continue;
        target = readlinkSync(link);
      } catch {
        continue;
      }
      if (isRollAuxiliarySkillTarget(target, homeSkills)) {
        found.push({ agent: name, link, target });
      }
    }
  }
  return found;
}

function skillRootPollutionSection(lang: Lang): void {
  const cfg = rollConfigPath();
  if (!existsSync(cfg)) return;
  const polluted = detectSkillRootPollution(readFileSync(cfg, "utf8"), homedir());
  if (polluted.length === 0) return;
  emit("");
  emit(t(v3Catalog, "en", "doctor.skill_root_pollution"));
  emit(t(v3Catalog, "zh", "doctor.skill_root_pollution"));
  emit("");
  for (const { agent, link, target } of polluted) {
    emit(`  ⚠ ${agent}: ${link} → ${target}`);
  }
  emit("");
  emit(`  ${t(v3Catalog, lang, "doctor.skill_root_pollution_hint")}`);
}

// ── FIX-234 AC3: all com.roll.* lanes — target path + load state, stale red ──
export interface LaneProbe {
  /** `launchctl list <label>` last-exit, or null when the job is not loaded. */
  lastExit: (label: string) => number | null;
}

export function lanesSection(lang: Lang, probe?: LaneProbe): string[] {
  const lines: string[] = [];
  if (process.platform !== "darwin") return lines;
  const dir = process.env["_LAUNCHD_DIR"] ?? join(homedir(), "Library", "LaunchAgents");
  if (!safeIsDir(dir)) return lines;
  let plists: string[] = [];
  try {
    plists = readdirSync(dir)
      .filter((n) => n.startsWith("com.roll.") && n.endsWith(".plist"))
      .sort();
  } catch {
    return lines;
  }
  if (plists.length === 0) return lines;
  lines.push("");
  lines.push(lang === "zh" ? "launchd lanes(全部 com.roll.* 任务)" : "launchd lanes (all com.roll.* jobs)");
  lines.push("");
  // US-LOOP-113 (codex review r2): resident scheduling is retired, so any lane
  // listed here is a LEFTOVER from an older install. `roll loop off` no longer
  // exists to disarm it, so name the manual disarm explicitly — a machine that
  // still has an armed timer contradicts "nothing runs on its own".
  lines.push(
    lang === "zh"
      ? "  这些是旧版安装留下的残留 lane —— Roll 不再使用定时调度。逐个卸载："
      : "  These are leftovers from an older install — Roll no longer uses timers. Disarm each:",
  );
  // `;` not `&&` (codex review r3): a lane listed as "not loaded" has nothing to
  // boot out, so bootout exits non-zero and `&&` would leave the plist on disk —
  // exactly the leftover this block is telling the user to remove.
  lines.push("    launchctl bootout gui/$(id -u)/<label>; rm -f ~/Library/LaunchAgents/<label>.plist");
  lines.push("");
  for (const name of plists) {
    const label = name.replace(/\.plist$/, "");
    const wd = readWorkingDirectory(join(dir, name));
    const stale = wd !== "" && !safeIsDir(wd);
    const exit = probe?.lastExit(label);
    const state =
      exit === undefined ? "" : exit === null ? (lang === "zh" ? " · 未加载" : " · not loaded") : ` · last exit ${exit}`;
    lines.push(`  ${stale ? "✗" : "•"} ${label}${state}`);
    lines.push(`    → ${wd === "" ? "(no WorkingDirectory)" : wd}${stale ? (lang === "zh" ? "  [目录已不存在——陈旧 lane]" : "  [missing — STALE lane]") : ""}`);
  }
  for (const l of lines) emit(l);
  return lines;
}

// ── 4. launchd stale section (Darwin only) ───────────────────────────────────
function launchdStaleSection(lang: Lang): void {
  if (process.platform !== "darwin") return; // [[ "$(uname)" == "Darwin" ]] || return 0
  const dir = process.env["_LAUNCHD_DIR"] ?? join(homedir(), "Library", "LaunchAgents");
  if (!safeIsDir(dir)) return;
  let found = false;
  let plists: string[] = [];
  try {
    plists = readdirSync(dir)
      .filter((n) => n.startsWith("com.roll.") && n.endsWith(".plist"))
      .sort();
  } catch {
    plists = [];
  }
  for (const name of plists) {
    const plist = join(dir, name);
    const wd = readWorkingDirectory(plist);
    if (wd === "") continue; // [[ -n "$wd" ]] || continue
    if (safeIsDir(wd)) continue; // [[ -d "$wd" ]] && continue
    if (!found) {
      emit("");
      emit(t(v2Catalog, lang, "doctor.stale_plists"));
      emit("");
      found = true;
    }
    const label = name.replace(/\.plist$/, "");
    emit(`  ⚠ ${label}`);
    emit(`    WorkingDirectory missing: ${wd}`);
    emit(`    ${t(v2Catalog, lang, "doctor.stale_plists_cleanup")}: launchctl bootout gui/${process.getuid?.() ?? 0}/${label}; rm '${plist}'`);
  }
}

// ── US-LOOP-108: effective scheduler backend (this project) ──────────────────
function sameRealPath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try {
      return realpathSync(p).replace(/\/+$/, "");
    } catch {
      return p.replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

/**
 * US-LOOP-116: there is no scheduler backend to report — Roll installs no timers
 * and the process fallback is deleted. What still matters is whether a LEFTOVER
 * launchd lane points at this project, because such a lane can still invoke
 * `roll loop run-once` unattended. Silent when the project has none.
 */
function leftoverLaneSection(lang: Lang, probe: LaneProbe): void {
  const root = process.cwd();
  if (process.platform !== "darwin") return;
  const dir = process.env["_LAUNCHD_DIR"] ?? join(homedir(), "Library", "LaunchAgents");
  const hits: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/^com\.roll\.loop\..+\.plist$/.test(name)) continue;
      const wd = readWorkingDirectory(join(dir, name));
      if (wd === "" || !sameRealPath(wd, root)) continue;
      hits.push(name.replace(/\.plist$/, ""));
    }
  } catch {
    return; // no launchd dir
  }
  if (hits.length === 0) return;

  emit("");
  emit(lang === "zh" ? "旧版残留的 launchd lane(本项目)" : "Leftover launchd lane (this project)");
  emit("");
  for (const label of hits) {
    const loaded = probe.lastExit(label) !== null;
    emit(`  ⚠ ${label}${loaded ? " · loaded" : " · not loaded"}`);
  }
  emit(lang === "zh" ? "    Roll 不再安装定时器。逐个卸载:" : "    Roll no longer installs timers. Disarm each:");
  emit("    launchctl bootout gui/$(id -u)/<label>; rm -f ~/Library/LaunchAgents/<label>.plist");
}

function mainCheckoutProtectionRuntimeDir(root: string): string {
  return join(root, ".roll", "loop");
}

function mainCheckoutWriteProtectionSection(lang: Lang): void {
  const root = process.cwd();
  const residue = detectMainCheckoutWriteProtectionResidue(root, mainCheckoutProtectionRuntimeDir(root));
  if (!residue.markerPresent && !residue.reclaimableConfigLock) return;
  emit("");
  emit(lang === "zh" ? "主 checkout 写保护残留" : "Main checkout write-protection residue");
  emit("");
  if (residue.markerPresent) emit(`  ⚠ marker: ${residue.markerPath}`);
  if (residue.reclaimableConfigLock) emit(`  ⚠ config lock sentinel: ${residue.configLockPath}`);
  if (residue.foreignConfigLock) emit(`  ! foreign config.lock present; repair will leave it untouched: ${residue.configLockPath}`);
  emit(`    fix: roll doctor repair-protection`);
}

function doctorRepairProtectionCommand(): number {
  const root = process.cwd();
  const result = recoverMainCheckoutWriteProtectionResidue(root, mainCheckoutProtectionRuntimeDir(root));
  process.stdout.write(
    [
      "Main checkout write-protection repair",
      "主 checkout 写保护修复",
      "",
      `  restored paths: ${result.restoredPaths}`,
      `  marker: ${result.markerRemoved ? "removed" : result.markerPresent ? "still present" : "not present"}`,
      result.configLockRemoved
        ? `  config lock: removed`
        : result.foreignConfigLock
          ? `  config lock: foreign lock left untouched (${result.configLockPath})`
          : `  config lock: not present`,
      "",
    ].join("\n"),
  );
  return result.markerPresent || result.foreignConfigLock ? 1 : 0;
}
/** Real lane probe — `launchctl list <label>` parses "LastExitStatus" (Darwin). */
function realLaneProbe(): LaneProbe {
  return {
    lastExit: (label) => {
      try {
        const out = execFileSync("launchctl", ["list", label], {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"], // swallow launchctl's stderr noise
        });
        const m2 = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(out);
        return m2 ? Number.parseInt(m2[1] ?? "0", 10) : 0;
      } catch {
        return null; // not loaded
      }
    },
  };
}


// ── 5. launchd proxy env section (Darwin only, FIX-232 AC1) ──────────────────

/** Proxy-related environment variable names that launchctl setenv may poison. */
const PROXY_ENV_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY",
];

/** Read the value of a launchctl-managed environment variable. Returns
 *  `undefined` if the variable is NOT set (launchctl prints "<<default>>"
 *  when the key is absent or was unset; the 0 exit code is always 0). */
function launchctlGetenv(name: string): string | undefined {
  try {
    const out = execFileSync("launchctl", ["getenv", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // launchctl getenv for an unset key prints nothing (empty) or a message.
    // An actually set proxy var prints the value (e.g. "127.0.0.1:7897").
    if (out === "" || out.includes(">") || out.includes("default")) return undefined;
    return out;
  } catch {
    return undefined;
  }
}

/** Probe whether a TCP port on a given host is reachable. Uses a non-
 *  blocking connect with a 2s timeout via a sub-shell to keep the doctor
 *  snappy. Returns true if the connect succeeds, false otherwise. */
function tcpProbe(host: string, port: number, timeoutMs = 2000): boolean {
  try {
    // Use a bash + /dev/tcp probe — the simplest portable way on macOS
    // without pulling in net.createConnection asynchronous complexity.
    const result = execFileSync(
      "bash",
      [
        "-c",
        `timeout ${Math.ceil(timeoutMs / 1000)} bash -c 'echo >/dev/tcp/${host}/${port}' 2>/dev/null && echo ok || echo fail`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + 500 },
    ).trim();
    return result === "ok";
  } catch {
    return false;
  }
}

/** Parse a proxy URL into { host, port }. Supports formats:
 *   - `127.0.0.1:7897`
 *   - `http://127.0.0.1:7897`
 *   - `socks5://127.0.0.1:7890`
 *  Returns undefined on unparseable input. */
function parseProxyTarget(raw: string): { host: string; port: number } | undefined {
  if (raw === "") return undefined;
  let s = raw.trim();
  // Strip scheme
  const schemeIdx = s.indexOf("://");
  if (schemeIdx !== -1) s = s.slice(schemeIdx + 3);
  // Strip trailing slash
  if (s.endsWith("/")) s = s.slice(0, -1);
  const colonIdx = s.lastIndexOf(":");
  if (colonIdx === -1) return undefined;
  const host = s.slice(0, colonIdx);
  const port = Number(s.slice(colonIdx + 1));
  if (!Number.isFinite(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** FIX-232 AC1: check launchctl proxy env vars vs actual port liveness.
 *  Warns when a proxy is SET but the target port is unreachable — the
 *  exact signature of a poisoned launchd environment from a closed
 *  proxy app. */
function launchdProxySection(lang: Lang): void {
  const platform = process.env["_ROLL_EXTERNAL_TOOLS_PLATFORM"] ?? process.platform;
  if (platform !== "darwin") return;
  // Read all proxy-family launchctl env vars.
  const stale: { name: string; value: string; target: string }[] = [];
  for (const name of PROXY_ENV_NAMES) {
    const value = launchctlGetenv(name);
    if (value === undefined) continue;
    const target = parseProxyTarget(value);
    if (target === undefined) continue;
    if (!tcpProbe(target.host, target.port)) {
      stale.push({ name, value, target: `${target.host}:${target.port}` });
    }
  }
  if (stale.length === 0) return;
  emit("");
  // v3-native keys — emit en then zh line (same bilingual pattern).
  emit(t(v3Catalog, "en", "doctor.proxy_env_warning"));
  emit(t(v3Catalog, "zh", "doctor.proxy_env_warning"));
  emit("");
  for (const { name, target } of stale) {
    emit(`  ⚠ ${name}=${target}`);
  }
  emit("");
  emit(`  ${t(v3Catalog, lang, "doctor.proxy_env_hint")}`);
  for (const { name } of stale) {
    emit(`    launchctl unsetenv ${name}`);
  }
}
/** Mirror the awk that extracts the line after <key>WorkingDirectory</key>. */
function readWorkingDirectory(plist: string): string {
  let body: string;
  try {
    body = readFileSync(plist, "utf8");
  } catch {
    return "";
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").includes("<key>WorkingDirectory</key>")) {
      const next = lines[i + 1] ?? "";
      return next.replace(/.*<string>|<\/string>.*/g, "");
    }
  }
  return "";
}

// ── REFACTOR-072: loop binary staleness readout (observation only) ─────────────
function binaryStalenessSection(lang: Lang): void {
  const { stale, latest, current } = resolveBinaryStalenessReadout(rollHomeDir(), rollVersion());
  emit("");
  emit(t(v3Catalog, "en", "doctor.binary_staleness_title"));
  emit(t(v3Catalog, "zh", "doctor.binary_staleness_title"));
  emit("");
  if (latest === "") {
    emit(`  ? ${t(v3Catalog, lang, "doctor.binary_staleness_unknown")}`);
  } else if (stale) {
    emit(`  ✗ ${t(v3Catalog, lang, "doctor.binary_staleness_stale", current, latest)}`);
  } else {
    emit(`  ✓ ${t(v3Catalog, lang, "doctor.binary_staleness_ok", current, latest)}`);
  }
}

export interface LanguageAuditDeps {
  /** Override the project root (defaults to `process.cwd()`). */
  root?: string;
}

/** US-LANG-002 — `roll doctor language` reports mixed-language policy drift. */
export function languageAuditCommand(args: string[], deps: LanguageAuditDeps = {}): number {
  const includeGenerated = args.includes("--include-generated");
  const findings = collectLanguageDoctorFindings({ root: deps.root ?? process.cwd(), includeGenerated });
  const lines = renderLanguageDoctorSection(findings, msgLang());
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

/** REFACTOR-073 — `roll doctor pardon` — diagnostic pardon-skip-list surface. */
export function doctorPardonCommand(args: string[]): number {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(
      "Usage: roll doctor pardon [--dry-run] [--include-unknown]\n" +
      "  Rebuild skip-cards from runs/events, removing env/harness pollution while keeping real card failures.\n" +
      "  --include-unknown also pardons unknown/no-evidence failures; risky because old zero-usage gave_up rows may be real card failures.\n",
    );
    return 0;
  }
  const dryRun = args.includes("--dry-run");
  const includeUnknown = args.includes("--include-unknown");
  const rt = pardonRuntimeDir(process.cwd());
  const current = readSkipState(rt);
  const rebuilt = rebuildSkipStateFromEvidence({
    currentFails: current.fails,
    currentSkip: current.skip,
    rows: readRows(join(rt, "runs.jsonl")),
    events: readEvents(join(rt, "events.ndjson")),
    threshold: 3,
    includeUnknown,
  });
  if (!dryRun) writeSkipState(rt, { fails: rebuilt.fails, skip: rebuilt.skip });
  process.stdout.write(
    `${dryRun ? "dry-run: " : ""}pardon skip-list: pardoned=${rebuilt.pardoned.join(",") || "-"} kept=${rebuilt.kept.join(",") || "-"}\n`,
  );
  return 0;
}

export function doctorCommand(args: string[], deps: DoctorDeps = {}): number {
  if (args[0] === "repair-protection") return doctorRepairProtectionCommand();

  out.lines = [];
  const p = palette();
  const lang = msgLang();
  const toolsOnly = args.includes("--tools");
  const externalTools = deps.externalTools?.() ?? collectExternalTools();

  if (!toolsOnly) {
    agentSection(p);
    skillRootPollutionSection(lang);
    prSection(lang);
    skillsCatalogSection(lang);
    gitignoreOwnershipSection(lang);
    lanesSection(lang, realLaneProbe());
    launchdStaleSection(lang);
    leftoverLaneSection(lang, realLaneProbe());
    mainCheckoutWriteProtectionSection(lang);
    launchdProxySection(lang);
    binaryStalenessSection(lang);
  }
  for (const l of renderToolReadinessDoctorSection(collectToolReadinessDoctorRows(process.cwd()))) emit(l);
  for (const l of renderExternalToolDoctorSection(externalTools)) emit(l);

  // US-BROW-003: managed / interactive / capture browser readiness — an honest
  // ready|degraded|blocked verdict so an unavailable browser is never read as a pass.
  const browserReadiness = deps.browserReadiness?.() ?? collectBrowserEnvironmentReadiness();
  for (const l of renderBrowserReadinessDoctorRow(browserReadiness)) emit(l);

  // US-BROW-009b: truth-adapter-based browser readiness (managed / interactive / capture).
  // Same three-lane shape but projected from persisted ledger facts — no live probe.
  const browserTruth = collectBrowserTruth({ projectPath: process.cwd() });
  for (const l of renderBrowserTruthDoctorRow(browserTruth)) emit(l);

  // US-EVID-032: capture-policy readiness — v2 gateway + renderer readiness and
  // the effective capture policy, each with an actionable reason (AC4).
  const capturePolicyReadiness = deps.capturePolicyReadiness?.() ?? collectCapturePolicyReadiness({ projectRoot: process.cwd() });
  for (const l of renderCapturePolicyReadinessDoctorSection(capturePolicyReadiness)) emit(l);

  if (toolsOnly) {
    // US-INIT-003c: `roll doctor --tools` prints a focused Terminal.app Screen
    // Recording preflight status from the already-collected external tool state.
    const preflight = terminalScreenRecordingPreflight(externalTools.find((tool) => tool.id === "screencapture"));
    emit("");
    const marker = preflight.status === "ok" ? "✓" : preflight.status === "skip" ? "↷" : "✗";
    emit(`  ${marker} Terminal.app Screen Recording — ${preflight.status}`);
    emit(`    ${preflight.detail}`);
    if (preflight.repairCommand !== undefined) emit(`    fix: ${preflight.repairCommand}`);
  }

  if (!toolsOnly) {
    // US-ONBOARD-NUDGE-003: surface design-handoff nudge as informational advisory
    // Does NOT change verdict or exit code (doctor always exits 0).
    const nudgeSignal = detectDesignHandoff(process.cwd());
    if (nudgeSignal.shouldNudge) {
      emit("");
      emit(lang === "zh" ? "设计交接引导（仅供参考）" : "Design handoff nudge (informational)");
      emit("");
      const nudgeLines = renderDesignNudge(lang);
      for (const line of nudgeLines) emit(`  ${line}`);
    }
  }

  process.stdout.write(out.lines.join("\n") + "\n");
  return 0;
}
