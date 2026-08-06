/**
 * @responsibility Runs the `ls` subcommand, printing the cross-project registry.
 */
/**
 * US-DOSSIER-028 — `roll ls`: print the cross-project registry
 * (`~/.roll/projects.json`) the web project switcher (US-DOSSIER-027) reads.
 *
 * ONE registry, two faces: `roll ls` and the web switcher consume the SAME
 * file; `roll ls --json` echoes it VERBATIM (no second aggregation). The table
 * shows name · version/tag · verdict · path; failures are first-class — a row
 * whose `path` no longer exists is flagged `missing`, a row whose
 * `lastIndexedAt` is older than the staleness threshold is flagged `stale`, and
 * BOTH are still listed, never silently dropped (the fail-loud principle).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolveLang, type Lang } from "@roll/spec";
import { collectProjectsRegistry, projectsRegistryPath } from "../lib/projects-registry.js";
import type { ProjectRegistryEntry } from "../lib/truth-console.js";
import { c, pad, renderState, strw } from "../render.js";

export const LS_USAGE =
  "Usage: roll ls [--json] [--stale-days <n>]\n" +
  "  List the cross-project registry (~/.roll/projects.json): name · tag · verdict · path.\n" +
  "  Missing paths and stale entries are flagged, never dropped. --json echoes the file verbatim.\n" +
  "列出跨项目注册表（~/.roll/projects.json）：名称 · 版本 · 判定 · 路径。\n" +
  "缺失路径与过期条目会被标注，绝不丢弃。--json 逐字输出文件本身。";

/** Default staleness horizon: a project not re-indexed in this many days is
 *  flagged `stale`. Injectable (`--stale-days`, and the render arg) so snapshot
 *  tests can pin it independent of wall-clock — the difftest TZ false-green trap. */
export const DEFAULT_STALE_DAYS = 14;

export type ProjectStatus = "ok" | "missing" | "stale";

/** Pure status classifier — `missing` (path gone) wins over `stale`; otherwise
 *  `stale` when `lastIndexedAt` is absent/unparseable/older than the horizon.
 *  `pathExists` is injected so the classifier stays pure + testable. */
export function projectStatus(
  entry: ProjectRegistryEntry,
  nowMs: number,
  staleMs: number,
  pathExists: (p: string) => boolean,
): ProjectStatus {
  if (!pathExists(entry.path)) return "missing";
  const at = entry.lastIndexedAt === undefined ? Number.NaN : Date.parse(entry.lastIndexedAt);
  if (!Number.isFinite(at) || nowMs - at > staleMs) return "stale";
  return "ok";
}

const STATUS_COLOR: Record<ProjectStatus, string> = { ok: "green", missing: "red", stale: "amber" };

function statusLabel(status: ProjectStatus, lang: Lang): string {
  if (status === "ok") return "";
  if (status === "missing") return lang === "zh" ? "缺失" : "missing";
  return lang === "zh" ? "过期" : "stale";
}

/**
 * Render the registry table from REAL rows. Deterministic: order is whatever the
 * (already name-sorted) registry yields; `nowMs`/`staleMs`/`pathExists` are all
 * injected so the same rows render byte-identically anywhere. Header + the
 * missing/stale legend are the bilingual surfaces (EN and 中 on SEPARATE lines);
 * the body follows the resolved single locale.
 */
export function renderProjectsTable(
  rows: ProjectRegistryEntry[],
  lang: Lang,
  nowMs: number,
  staleMs: number,
  pathExists: (p: string) => boolean = existsSync,
): string {
  if (rows.length === 0) {
    return lang === "zh"
      ? "注册表为空（还没有项目跑过 roll index）\n→ 在某个项目里跑 roll index 以登记它\n"
      : "registry is empty (no project has run roll index yet)\n→ run roll index in a project to register it\n";
  }
  const NAME_W = Math.max(4, ...rows.map((r) => strw(r.name)));
  const TAG_W = Math.max(7, ...rows.map((r) => strw(r.releaseTag ?? "—")));
  const VERDICT_W = Math.max(7, ...rows.map((r) => strw(r.verdict ?? "—")));
  const lines: string[] = [];
  let anyMissing = false;
  let anyStale = false;
  for (const r of rows) {
    const status = projectStatus(r, nowMs, staleMs, pathExists);
    if (status === "missing") anyMissing = true;
    if (status === "stale") anyStale = true;
    const flag = statusLabel(status, lang);
    const flagCell = flag === "" ? "" : `  ${c(STATUS_COLOR[status], `[${flag}]`)}`;
    lines.push(
      [
        pad(r.name, NAME_W),
        pad(r.releaseTag ?? "—", TAG_W),
        pad(c(STATUS_COLOR[status], r.verdict ?? "—"), VERDICT_W),
        r.path,
      ].join("  ") + flagCell,
    );
  }
  const legend: string[] = [];
  if (anyMissing) {
    legend.push(lang === "zh" ? "[缺失] 路径已不存在" : "[missing] path no longer exists");
  }
  if (anyStale) {
    legend.push(lang === "zh" ? `[过期] 超过 ${Math.round(staleMs / 86400000)} 天未重建索引` : `[stale] not re-indexed in over ${Math.round(staleMs / 86400000)} days`);
  }
  const legendBlock = legend.length > 0 ? `\n${legend.join("\n")}\n` : "";
  return `${lines.join("\n")}\n${legendBlock}`;
}

export function lsCommand(args: string[]): number {
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${LS_USAGE}\n`);
    return 0;
  }
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });

  let staleDays = DEFAULT_STALE_DAYS;
  const sd = args.indexOf("--stale-days");
  if (sd >= 0) {
    const v = args[sd + 1];
    const n = v === undefined ? Number.NaN : Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(
        lang === "zh"
          ? `[roll] 非法 --stale-days 值：${v ?? "(空)"}（需正整数）\n`
          : `[roll] illegal --stale-days value: ${v ?? "(empty)"} (need a positive number)\n`,
      );
      return 1;
    }
    staleDays = n;
  }

  const unknown = args.filter(
    (a, idx) =>
      a.startsWith("-") &&
      a !== "--json" &&
      a !== "--no-color" &&
      a !== "--stale-days" &&
      !(idx > 0 && args[idx - 1] === "--stale-days"),
  );
  if (unknown.length > 0) {
    process.stderr.write(`[roll] unknown flag: ${unknown[0]}\n${LS_USAGE}\n`);
    return 1;
  }

  const rows = collectProjectsRegistry();

  if (args.includes("--json")) {
    // AC2: `--json` is the registry VERBATIM. We re-read the file text rather
    // than re-serialize the parsed rows, so the output equals the file byte for
    // byte (one registry, never a second aggregation). Absent file → empty array.
    let text: string;
    try {
      text = readFileSync(projectsRegistryPath(), "utf8");
    } catch {
      text = "[]\n";
    }
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }

  const nowMs = Date.now();
  process.stdout.write(renderProjectsTable(rows, lang, nowMs, staleDays * 86400000));
  return 0;
}
