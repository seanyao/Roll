/**
 * `roll status` — TS port of lib/roll-status.py (US-CLI-001).
 *
 * One-screen sync health: global conventions, AI clients table (with setup
 * fix hints), project templates, and this-project metrics. Byte-aligned with
 * the python oracle (fixture + live diff-tests).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveLang, type Lang } from "@roll/spec";
import type { TruthSnapshot } from "@roll/spec";
import { c, COLS, hr, pad, renderState, row, sectionHead } from "../render.js";
import { attestCoverage, isSnapshotStale, loadTruthSnapshot, renderNowMs, snapshotVerdict } from "../lib/truth-read.js";
import type { TruthSnapshotCycle } from "@roll/spec";
import { detectDesignHandoff, renderDesignNudge } from "../lib/onboard-nudge.js";
import { loadNorthStarReport, renderNorthStatusSummary } from "./north.js";

/** FIX-361: format a cycle snapshot's cost with correct currency symbols,
 *  separating by currency so ¥ and $ are never blindly summed. */
function cycleSnapshotCostStr(cyc: TruthSnapshotCycle): string {
  const byCur = cyc.costByCurrency3d;
  if (byCur !== undefined && Object.keys(byCur).length > 0) {
    return Object.entries(byCur)
      .map(([cur, val]) => {
        const sym = cur === "CNY" ? "\u00A5" : "$";
        return `${sym}${val.toFixed(2)}`;
      })
      .join(" + ");
  }
  // Old snapshot without per-currency breakdown: use the legacy field.
  return `$${cyc.costUsd3d.toFixed(2)}`;
}

// ── Paths ────────────────────────────────────────────────────────────────────
function rollHome(): string {
  return process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
}
const globalDir = (): string => join(rollHome(), "conventions", "global");
const templatesDir = (): string => join(rollHome(), "conventions", "templates");
const configPath = (): string => join(rollHome(), "config.yaml");

/** Python-side project root (git-common-dir aware — used for slug + fallback lease). */
function projectRootPy(): string {
  let path = realpathSync(process.cwd());
  try {
    const common = execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common.endsWith("/.git")) path = common.slice(0, -5);
  } catch {
    /* not a git repo */
  }
  return path;
}

/** Python-side slug (path-based only — used for launchd label lookup). */
function projectSlugPy(): string {
  const path = projectRootPy();
  const base = basename(path)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const h = createHash("md5").update(path).digest("hex").slice(0, 6);
  return `${base}-${h}`;
}

// ── Data loaders (mirror the python loaders 1:1) ─────────────────────────────
const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursor-rules", "project_rules.md"];
const TEMPLATES = ["fullstack", "frontend-only", "backend-service", "cli"];

type Conventions = Array<[string, boolean]>;

interface AiClient {
  name: string;
  cfg_file: string;
  path: string;
  sync: "sync" | "out-of-sync" | "missing";
  skills: number;
}

interface StatusData {
  conventions: Conventions;
  ai_clients: AiClient[];
  templates: Array<[string, number]>;
  skills_installed: number;
  project_has_agents: boolean;
  project_has_backlog: boolean;
  project_features_count: number;
  loop_state: string;
  dream_state: string;
  /**
   * US-LOOP-116: how delivery is driven. There is no scheduler backend to choose
   * between any more — a session drives, or the owner has paused it.
   */
  driver: "session" | "paused";
  /** One-line note (e.g. a leftover launchd lane worth disarming), or "". */
  driver_note: string;
}

function globalConventions(): Conventions {
  return CONVENTION_FILES.map((f) => [f, existsSync(join(globalDir(), f))]);
}

export interface AiEntry {
  name: string;
  ai_dir: string;
  cfg_file: string;
  src_file: string;
}

export function parseAiEntries(): AiEntry[] {
  const cfg = configPath();
  if (!existsSync(cfg)) return [];
  const entries: AiEntry[] = [];
  for (const line of readFileSync(cfg, "utf8").split("\n")) {
    const m = /^ai_[a-z]+:\s*(.+)/.exec(line);
    if (m === null) continue;
    const val = (m[1] ?? "").trim().replaceAll("~", homedir());
    const parts = val.split("|");
    if (parts.length < 3) continue;
    const aiDir = (parts[0] ?? "").trim();
    const cfgFile = (parts[1] ?? "").trim();
    const srcFile = (parts[2] ?? "").trim();
    let name = basename(aiDir).replace(/^\.+/, "");
    if (name === "workspace" || name === "agent") {
      name = basename(dirname(aiDir)).replace(/^\.+/, "");
    }
    entries.push({ name, ai_dir: aiDir, cfg_file: cfgFile, src_file: srcFile });
  }
  return entries;
}

export function aiSyncStatus(e: AiEntry): AiClient["sync"] {
  const cfgFile = join(e.ai_dir, e.cfg_file);
  const rollMd = join(e.ai_dir, "roll.md");
  const src = join(globalDir(), e.src_file);
  if (!existsSync(cfgFile)) return "missing";
  if (!existsSync(rollMd)) return "out-of-sync";
  try {
    if (existsSync(src) && !readFileSync(rollMd).equals(readFileSync(src))) return "out-of-sync";
  } catch {
    return "out-of-sync";
  }
  try {
    if (!readFileSync(cfgFile, "utf8").includes("@roll.md")) return "out-of-sync";
  } catch {
    return "out-of-sync";
  }
  return "sync";
}

function aiSkillCount(e: AiEntry): number {
  const skillsDir = join(e.ai_dir, "skills");
  if (!existsSync(skillsDir)) return 0;
  try {
    let n = 0;
    for (const name of readdirSync(skillsDir)) {
      if (!name.startsWith("roll-")) continue;
      const p = join(skillsDir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || st.isDirectory()) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

function countFilesRecursive(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) n += countFilesRecursive(p);
    else if (st.isFile()) n++;
  }
  return n;
}

function templateCount(tpl: string): number {
  const d = join(templatesDir(), tpl);
  if (!existsSync(d)) return 0;
  try {
    return countFilesRecursive(d);
  } catch {
    return 0;
  }
}

function skillsInstalled(): number {
  const sd = join(rollHome(), "skills");
  if (!existsSync(sd)) return 0;
  try {
    return readdirSync(sd).filter((n) => statSync(join(sd, n)).isDirectory()).length;
  } catch {
    return 0;
  }
}

function launchdState(service: string, slug: string): string {
  const label = `com.roll.${service}.${slug}`;
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (!existsSync(plist)) return "not-installed";
  try {
    const out = execFileSync("launchctl", ["list", label], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() !== "" ? "enabled" : "installed-off";
  } catch {
    return "installed-off";
  }
}

// ── Fixture data (test-only; opt in via ROLL_RENDER_FIXTURE=1) ──────────────
function fixtureData(): StatusData {
  return {
    conventions: [
      ["AGENTS.md", true],
      ["CLAUDE.md", true],
      [".cursor-rules", true],
      ["project_rules.md", false],
    ],
    ai_clients: [
      { name: "claude", cfg_file: "CLAUDE.md", path: "~/.claude/CLAUDE.md", sync: "sync", skills: 12 },
      { name: "kimi", cfg_file: "AGENTS.md", path: "~/.kimi/AGENTS.md", sync: "out-of-sync", skills: 12 },
      { name: "pi", cfg_file: "AGENTS.md", path: "~/.pi/agent/AGENTS.md", sync: "missing", skills: 0 },
    ],
    templates: [
      ["fullstack", 14],
      ["frontend-only", 9],
      ["backend-service", 11],
      ["cli", 7],
    ],
    skills_installed: 12,
    project_has_agents: true,
    project_has_backlog: true,
    project_features_count: 23,
    loop_state: "enabled",
    dream_state: "not-installed",
    driver: "session",
    driver_note: "",
  };
}

// ── Render (mirrors the python renderers; collects lines, prints once) ──────
function renderHealth(out: string[], d: StatusData): void {
  const clients = d.ai_clients;
  const synced = clients.filter((x) => x.sync === "sync").length;
  const total = clients.length;
  const skills = d.skills_installed;
  const tpls = d.templates.filter((t) => t[1] > 0).length;

  let dot: string, word: string, detail: string;
  if (synced < total) {
    dot = c("amber", "!");
    word = c("amber", "drift", { bold: true });
    detail =
      c("dim", `  ${synced}/${total} AI clients in sync`) + c("muted", " · ") +
      c("dim", `${skills} skills`) + c("muted", " · ") +
      c("dim", `${tpls} templates`);
  } else {
    dot = c("green", "●");
    word = c("green", "healthy", { bold: true });
    detail =
      c("dim", `  ${synced}/${total} AI clients in sync`) + c("muted", " · ") +
      c("dim", `${skills} skills mounted`) + c("muted", " · ") +
      c("dim", `${tpls} templates present`);
  }
  out.push("", "  " + dot + " " + word + detail, "", hr(), "");
}

function renderGlobalConventions(out: string[], conventions: Conventions): void {
  out.push(sectionHead("GLOBAL CONVENTIONS", "全局约定", "~/.roll/conventions/global/"), "");
  for (const [fname, exists] of conventions) {
    if (exists) out.push("  " + c("green", "+") + " " + c("fg", fname));
    else out.push("  " + c("red", "−") + " " + c("dim", fname) + "  " + c("red", "missing"));
  }
  out.push("", hr(), "");
}

function renderAiClients(out: string[], clients: AiClient[]): void {
  out.push(sectionHead("AI CLIENTS", "AI 客户端同步", "convention · path · sync · skills"), "");
  out.push(
    "  " + pad(c("dim", "name"), 14) + pad(c("dim", "convention"), 14) +
      pad(c("dim", "sync"), 14) + c("dim", "skills"),
  );
  out.push("  " + c("faint", "─".repeat(COLS - 4)));

  for (const cl of clients) {
    let syncCol: string, nameCol: string;
    if (cl.sync === "sync") {
      syncCol = c("green", "✓ in sync");
      nameCol = c("fg", cl.name);
    } else if (cl.sync === "out-of-sync") {
      syncCol = c("amber", "~ out of sync");
      nameCol = c("amber", cl.name);
    } else {
      syncCol = c("red", "− missing");
      nameCol = c("red", cl.name);
    }
    out.push(
      "  " + pad(nameCol, 14) + pad(c("dim", cl.cfg_file), 14) + pad(syncCol, 14) +
        c("dim", String(cl.skills)),
    );
    if (cl.sync === "out-of-sync" || cl.sync === "missing") {
      out.push("       " + c("dim", "fix: ") + c("blue", "roll setup -f"));
    }
  }
  out.push("", hr(), "");
}

function renderTemplates(out: string[], templates: Array<[string, number]>): void {
  out.push(sectionHead("PROJECT TEMPLATES", "项目模板", "~/.roll/conventions/templates/"), "");
  const parts = templates.map(([tpl, count]) =>
    count > 0
      ? c("fg", tpl) + c("dim", ` ${count}f`)
      : c("red", "−") + " " + c("dim", tpl + " missing"),
  );
  out.push("  " + parts.join(c("muted", "  ·  ")));
  out.push("", hr(), "");
}

function renderThisProject(out: string[], d: StatusData): void {
  out.push(sectionHead("THIS PROJECT", "本项目", basename(process.cwd())), "");

  const fileRow = (label: string, exists: boolean, detail = ""): void => {
    let line: string;
    if (exists) {
      line = "  " + c("green", "+") + " " + c("fg", label);
      if (detail !== "") line += c("dim", `  ${detail}`);
    } else {
      line = "  " + c("red", "−") + " " + c("dim", label) + "  " + c("red", "missing");
    }
    out.push(line);
  };

  fileRow("AGENTS.md", d.project_has_agents);
  fileRow(".roll/backlog.md", d.project_has_backlog);
  fileRow(".roll/features/", d.project_features_count > 0, `${d.project_features_count} feature docs`);

  for (const [svc, state] of [
    ["loop", d.loop_state],
    ["dream", d.dream_state],
  ] as const) {
    let dot: string, word: string;
    if (state === "enabled") {
      dot = c("green", "●");
      word = c("green", `${svc} · launchd enabled`);
    } else if (state === "installed-off") {
      dot = c("amber", "⚠");
      word = c("amber", `${svc} · launchd off`);
    } else {
      dot = c("red", "○");
      word = c("dim", `${svc} · launchd not installed`);
    }
    out.push("  " + dot + " " + word);
  }

  // US-LOOP-116: who drives — a session, or nobody because it is paused.
  {
    let dot: string, word: string;
    if (d.driver === "session") {
      dot = c("green", "◆");
      word = c("green", "driver · session");
    } else {
      dot = c("amber", "⏸");
      word = c("amber", "driver · paused");
    }
    let line = "  " + dot + " " + word;
    if (d.driver_note !== "") line += c("dim", `  ${d.driver_note}`);
    out.push(line);
  }
  out.push("");
}

// ── Live data collection ─────────────────────────────────────────────────────
function liveData(): StatusData {
  const slug = projectSlugPy();
  const root = projectRootPy();
  const home = homedir();
  const aiClients: AiClient[] = parseAiEntries().map((e) => ({
    name: e.name,
    cfg_file: e.cfg_file,
    path: join(e.ai_dir, e.cfg_file).replaceAll(home, "~"),
    sync: aiSyncStatus(e),
    skills: aiSkillCount(e),
  }));
  const featDir = ".roll/features";
  let featCount = 0;
  if (existsSync(featDir)) {
    featCount = readdirSync(featDir).filter((n) => n.endsWith(".md")).length;
  }
  const loopState = launchdState("loop", slug);
  // US-LOOP-116: no backend to derive. Delivery is session-driven; the only real
  // state is whether autonomous progress is paused. A launchd lane still on disk is
  // a leftover from an older install and is worth naming, not obeying.
  const paused = existsSync(join(root, ".roll", "loop", `PAUSE-${slug}`));
  const driver: "session" | "paused" = paused ? "paused" : "session";
  const note =
    loopState !== "not-installed"
      ? "leftover launchd lane from an older install — run roll doctor to remove it"
      : paused
        ? "autonomous progress paused — roll loop resume, or roll loop go --cards <id>"
        : "";
  return {
    conventions: globalConventions(),
    ai_clients: aiClients,
    templates: TEMPLATES.map((t) => [t, templateCount(t)]),
    skills_installed: skillsInstalled(),
    project_has_agents: existsSync("AGENTS.md"),
    project_has_backlog: existsSync(".roll/backlog.md"),
    project_features_count: featCount,
    loop_state: loopState,
    dream_state: launchdState("dream", slug),
    driver,
    driver_note: note,
  };
}

// ── US-DOSSIER-035: verdict-first truth summary (design frame 1) ─────────────
// Reads the ONE TruthSnapshot the web Now tab reads (.roll/features/truth.json)
// and leads `roll status` with a verdict line + four tab-aligned lines —
// LOOP · CYCLE · RELEASE · STORY — same names/order/口径 as the web tabs. No
// number is recomputed here: a divergence from the web Now tab is a 口径 bug.

const VERDICT_WORD: Record<string, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", unknown: "UNKNOWN" };
const VERDICT_COLOR: Record<string, string> = { pass: "green", warn: "amber", fail: "red", unknown: "muted" };
const VERDICT_REASON: Record<string, { en: string; zh: string }> = {
  pass: { en: "all dimensions clear", zh: "全维度通过" },
  warn: { en: "main reconciled vs backlog", zh: "主干对账待处理" },
  fail: { en: "a dimension is failing", zh: "有维度不通过" },
  unknown: { en: "no consistency audit yet", zh: "尚无一致性审计" },
};

/** Compact `HH:MMZ` for a lane's nextAt (UTC, byte-stable). */
function laneNext(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "—";
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] !== undefined ? `${m[1]}Z` : "—";
}

function statusLabel(label: string): string {
  return c("muted", pad(label, 10));
}

/**
 * Render the verdict line + LOOP/CYCLE/RELEASE/STORY block from the snapshot.
 * Pure: (snapshot, stale, lang, nowMs) → text. When the snapshot is absent it
 * falls back honestly (states it, points at `roll index`) — never undefined.
 */
export function renderTruthSummary(
  snapshot: TruthSnapshot | undefined,
  stale: boolean,
  lang: Lang,
  _nowMs: number,
  northSummary?: string,
): string {
  void _nowMs;
  const out: string[] = [];
  if (snapshot === undefined) {
    const word = c("muted", pad("UNKNOWN", 6));
    out.push(
      "  " + word + "  " + (lang === "zh" ? "无真相快照——运行 roll index" : "no truth snapshot — run roll index"),
    );
    if (northSummary !== undefined) out.push(northSummary);
    out.push("", hr(), "");
    return out.join("\n");
  }

  const v = snapshotVerdict(snapshot);
  const verdictWord = c(VERDICT_COLOR[v] ?? "muted", pad(VERDICT_WORD[v] ?? "UNKNOWN", 6), { bold: true });
  const reasonPair = VERDICT_REASON[v] ?? { en: "no consistency audit yet", zh: "尚无一致性审计" };
  let reason = lang === "zh" ? reasonPair.zh : reasonPair.en;
  if (stale) reason += lang === "zh" ? "（快照已过期）" : " (snapshot stale)";
  // exit-code intent (script/CI contract): pass 0, warn/unknown 1, fail 2.
  const exit = v === "fail" ? 2 : v === "pass" ? 0 : 1;
  out.push("  " + verdictWord + "  " + reason + "   " + c("muted", `exit ${exit}`));
  if (northSummary !== undefined) out.push(northSummary);
  out.push("");

  // LOOP — loop lanes + running count (the web Now tab's loop heartbeat).
  const lanes = snapshot.loop?.lanes ?? [];
  const running = lanes.filter((l) => l.running).length;
  const nextLane = lanes.find((l) => l.running && l.nextAt !== undefined);
  const loopRight =
    lang === "zh"
      ? `${lanes.length} 个循环 · ${c("green", `${running} 运行中`)}` + (nextLane !== undefined ? `   下次 ${c("fg", laneNext(nextLane.nextAt))}` : "")
      : `${lanes.length} loops · ${c("green", `${running} running`)}` + (nextLane !== undefined ? `   next ${c("fg", laneNext(nextLane.nextAt))}` : "");
  out.push("  " + statusLabel("LOOP") + loopRight);

  // CYCLE — cycles/3d + failed + cost (the web Cycle tile).
  const cyc = snapshot.cycle;
  // FIX-361: per-currency cost display so ¥ and $ never blindly summed.
  const cycCostStr = cyc !== undefined ? cycleSnapshotCostStr(cyc) : null;
  const cycleRight =
    cyc !== undefined
      ? (lang === "zh" ? `${cyc.cycles3d} / 3天   ` : `${cyc.cycles3d} / 3d   `) +
        c(cyc.failed3d > 0 ? "red" : "green", lang === "zh" ? `${cyc.failed3d} 失败` : `${cyc.failed3d} failed`) +
        (cycCostStr !== null ? ` · ${cycCostStr}` : "")
      : c("muted", lang === "zh" ? "无周期数据" : "no cycle data");
  out.push("  " + statusLabel("CYCLE") + cycleRight);

  // RELEASE — latest tag + gate verdict + f/w/? + merged/pending (web Release tile).
  const rel = snapshot.release;
  const a = snapshot.audit;
  const spectrum = snapshot.story.spectrum;
  const merged = spectrum.done;
  const pending = snapshot.story.total - spectrum.done;
  let releaseRight: string;
  if (rel !== undefined) {
    const relColor = rel.verdict === "pass" ? "green" : rel.verdict === "fail" ? "red" : rel.verdict === "warn" ? "amber" : "muted";
    const fwu = a !== undefined ? ` · f:${a.fail} w:${a.warn} ?:${a.unknown}` : "";
    releaseRight =
      `${c("fg", rel.latestTag ?? "—")} ` + (lang === "zh" ? "已就绪   " : "staged   ") +
      c(relColor, rel.verdict) + fwu +
      ` · ${c("green", lang === "zh" ? `${merged} 已合` : `${merged} merged`)}` +
      ` · ${c("amber", lang === "zh" ? `${pending} 待交付` : `${pending} pending`)}`;
  } else {
    releaseRight = c("muted", lang === "zh" ? "无发版数据" : "no release data");
  }
  out.push("  " + statusLabel("RELEASE") + releaseRight);

  // STORY — attest coverage % + fail (drift) + unknown (web Story tile / AC4).
  const cov = attestCoverage(snapshot);
  const covColor = cov.pct >= 80 ? "green" : cov.pct >= 50 ? "amber" : "red";
  const storyRight =
    c(covColor, `${cov.pct}%`) + (lang === "zh" ? " 验收覆盖      " : " attest coverage      ") +
    (lang === "zh" ? "失败 " : "fail ") + c("fg", String(spectrum.fail)) +
    " · " + (lang === "zh" ? "未知 " : "unknown ") + c("fg", String(spectrum.unknown));
  out.push("  " + statusLabel("STORY") + storyRight);
  out.push("");

  // The spectrum recap + the discoverability "next step" pointers.
  out.push(
    "  " +
      (lang === "zh"
        ? `漂移 ${c("fg", String(spectrum.fail))} · 已交付 ${c("fg", String(spectrum.done))}${c("muted", ` (含历史 ${snapshot.story.legacy})`)} · 未知 ${c("fg", String(spectrum.unknown))} · 待办 ${c("fg", String(spectrum.todo))}`
        : `drift ${c("fg", String(spectrum.fail))} · done ${c("fg", String(spectrum.done))}${c("muted", ` (incl. legacy ${snapshot.story.legacy})`)} · unknown ${c("fg", String(spectrum.unknown))} · todo ${c("fg", String(spectrum.todo))}`),
  );
  out.push("");
  out.push("  " + c("blue", "→ roll cycles --since 3d") + c("muted", "    ") + c("blue", "→ roll release") + c("muted", "    ") + c("blue", "→ roll backlog"));
  out.push("", hr(), "");
  return out.join("\n");
}

/**
 * US-DOSSIER-036 --json (AC5/AC7): the machine view of the verdict-first truth
 * summary — the SAME snapshot, the SAME `snapshotVerdict`/`attestCoverage`
 * selectors the human summary reads (LOOP · CYCLE · RELEASE · STORY). No second
 * derivation: a divergence from the human render is a 口径 bug. When the
 * snapshot is absent it reports `{verdict:"unknown", snapshot:false}` honestly.
 */
export function statusTruthJson(snapshot: TruthSnapshot | undefined, stale: boolean): unknown {
  if (snapshot === undefined) {
    return { verdict: "unknown", exit: 1, snapshot: false, stale: false };
  }
  const v = snapshotVerdict(snapshot);
  const exit = v === "fail" ? 2 : v === "pass" ? 0 : 1;
  const lanes = snapshot.loop?.lanes ?? [];
  const cov = attestCoverage(snapshot);
  const spectrum = snapshot.story.spectrum;
  const a = snapshot.audit;
  const rel = snapshot.release;
  return {
    verdict: v,
    exit,
    snapshot: true,
    stale,
    loop: { lanes: lanes.length, running: lanes.filter((l) => l.running).length },
    cycle:
      snapshot.cycle !== undefined
        ? { cycles3d: snapshot.cycle.cycles3d, failed3d: snapshot.cycle.failed3d, costUsd3d: snapshot.cycle.costUsd3d }
        : null,
    release:
      rel !== undefined
        ? {
            latestTag: rel.latestTag ?? null,
            verdict: rel.verdict,
            fail: a?.fail ?? null,
            warn: a?.warn ?? null,
            unknown: a?.unknown ?? null,
            merged: spectrum.done,
            pending: snapshot.story.total - spectrum.done,
          }
        : null,
    story: {
      attestCoveragePct: cov.pct,
      fail: spectrum.fail,
      done: spectrum.done,
      unknown: spectrum.unknown,
      todo: spectrum.todo,
      legacy: snapshot.story.legacy,
    },
  };
}

// ── Entry ────────────────────────────────────────────────────────────────────
export function statusCommand(args: string[]): number {
  const noColor = args.includes("--no-color");
  if (noColor || (process.env["NO_COLOR"] ?? "") !== "" || !process.stdout.isTTY) {
    renderState.useColor = false;
  }
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  const json = args.includes("--json");
  const d = (process.env["ROLL_RENDER_FIXTURE"] ?? "") !== "" ? fixtureData() : liveData();
  // US-DOSSIER-035: lead with the verdict-first truth summary read from the ONE
  // snapshot the web Now tab reads, then the existing sync-health body. Status
  // stays read-only and exits 0; the verdict line carries the exit-code intent
  // a script consumes, but `roll status` itself never fails the shell.
  const fixtureMode = (process.env["ROLL_RENDER_FIXTURE"] ?? "") !== "";
  const nowMs = renderNowMs();
  const snapshot = fixtureMode ? truthFixture() : loadTruthSnapshot(process.cwd());
  // Fixture mode is byte-deterministic by construction — never let the wall
  // clock flip the stale flag (the diff-test pins no clock).
  const stale = !fixtureMode && snapshot !== undefined && isSnapshotStale(snapshot, nowMs);
  if (json) {
    process.stdout.write(JSON.stringify(statusTruthJson(snapshot, stale), null, 2) + "\n");
    return 0;
  }
  let northReport: ReturnType<typeof loadNorthStarReport> | undefined;
  if (!fixtureMode) {
    try {
      northReport = loadNorthStarReport(process.cwd());
    } catch {
      northReport = undefined;
    }
  }
  const northSummary = renderNorthStatusSummary(northReport, lang, COLS);
  const out: string[] = [renderTruthSummary(snapshot, stale, lang, nowMs, northSummary)];
  renderHealth(out, d);
  renderGlobalConventions(out, d.conventions);
  renderAiClients(out, d.ai_clients);
  renderTemplates(out, d.templates);
  renderThisProject(out, d);

  // US-ONBOARD-NUDGE-003: surface design-handoff nudge when signals detected
  const nudgeSignal = detectDesignHandoff(process.cwd());
  if (nudgeSignal.shouldNudge) {
    const nudgeLines = renderDesignNudge(lang);
    for (const line of nudgeLines) out.push(line);
    out.push("");
  }

  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

/** Deterministic snapshot for the diff-test fixture path (ROLL_RENDER_FIXTURE=1). */
function truthFixture(): TruthSnapshot {
  return {
    generatedAt: "2026-06-13T00:00:00Z",
    collectedAt: "2026-06-12T03:09:03Z",
    story: {
      total: 580,
      spectrum: { done: 366, wip: 0, hold: 0, todo: 7, fail: 0, unknown: 197 },
      legacy: 366,
    },
    audit: { fail: 0, warn: 44, unknown: 78, collectedAt: "2026-06-10" },
    cycle: { cycles3d: 17, failed3d: 12, costUsd3d: 0.59, collectedAt: "2026-06-12T01:52:34Z" },
    release: { latestTag: "v3.611.2", verdict: "pass", collectedAt: "2026-06-12T03:09:03Z" },
    loop: {
      lanes: [
        { name: "loop", running: true, mode: "cron", everyMin: 30, lastAt: "2026-06-13T08:32:00Z", nextAt: "2026-06-13T08:55:00Z" },
        { name: "dream", running: false, mode: "nightly", everyMin: 1440 },
      ],
    },
    stories: [
      { id: "US-A", epic: "e", ladder: "attested", evidence: { report: true, acMap: true, visualEvidence: true }, truthState: "done", legacy: false },
      { id: "US-B", epic: "e", ladder: "attested", evidence: { report: true, acMap: true, visualEvidence: true }, truthState: "done", legacy: false },
      { id: "US-C", epic: "e", ladder: "merged", evidence: { report: false, acMap: false, visualEvidence: false }, truthState: "done", legacy: false },
    ],
  };
}
