/**
 * @responsibility Renders the bare-roll front door.
 */
/**
 * US-DOSSIER-035 — the bare-`roll` front door (design frame 0).
 *
 * `roll` with no args is a *front door*, not a usage dump: one identity line,
 * one verdict line read from the ONE TruthSnapshot the web reads, and a compact
 * three-row command map (daily · cards · machine). 0 args = 0 destruction:
 * read-only, exits 0. `roll help`/`--help`/`-h` keep the usage contract.
 *
 * Pure emitter: (version, slogan, snapshot, stale, lang) → text. The verdict
 * word + reason come from the snapshot via @roll/lib/truth-read selectors, so
 * the front door and `roll status` print the SAME word for the same truth.json.
 */
import type { Lang } from "@roll/spec";
import type { TruthSnapshot, TruthSnapshotVerdict } from "@roll/spec";
import { c, pad } from "../render.js";
import { snapshotVerdict } from "./truth-read.js";

/** Verdict → display word + reason, the SAME vocabulary the web Now tab uses. */
const VERDICT_WORD: Record<TruthSnapshotVerdict, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  unknown: "UNKNOWN",
};
const VERDICT_COLOR: Record<TruthSnapshotVerdict, string> = {
  pass: "green",
  warn: "amber",
  fail: "red",
  unknown: "muted",
};
const VERDICT_REASON: Record<TruthSnapshotVerdict, { en: string; zh: string }> = {
  pass: { en: "all dimensions clear", zh: "全维度通过" },
  warn: { en: "main reconciled vs backlog", zh: "主干对账待处理" },
  fail: { en: "a dimension is failing", zh: "有维度不通过" },
  unknown: { en: "no consistency audit yet", zh: "尚无一致性审计" },
};

/** The verdict line shown on the front door: `WORD  reason → roll status`. */
function verdictLine(snapshot: TruthSnapshot | undefined, stale: boolean, lang: Lang): string {
  const pointer = c("blue", "→ roll status");
  if (snapshot === undefined) {
    const word = c("muted", pad("UNKNOWN", 6)); // honest fallback — never a fabricated verdict
    const reason = lang === "zh" ? "无真相快照（运行 roll index）" : "no truth snapshot (run roll index)";
    return `${word}  ${reason}  ${pointer}`;
  }
  const v = snapshotVerdict(snapshot);
  const word = c(VERDICT_COLOR[v], pad(VERDICT_WORD[v], 6), { bold: true });
  const r = VERDICT_REASON[v];
  let reason = lang === "zh" ? r.zh : r.en;
  if (stale) reason += lang === "zh" ? "（快照已过期）" : " (snapshot stale)";
  return `${word}  ${reason}  ${pointer}`;
}

/** The three-row command map — same verbs the design frame 0 lists. */
function commandMap(lang: Lang): string {
  const rows: Array<[string, string]> = [
    ["daily", "status · cycles · backlog · release"],
    ["cards", 'idea "<one sentence>" · story new <ID> --title <t>'],
    ["machine", "loop · agent · doctor · skills · config · setup · update"],
  ];
  return rows.map(([label, verbs]) => `${c("muted", pad(label, 10))}${verbs}`).join("\n");
}

export interface FrontDoorInput {
  version: string;
  slogan: string;
  snapshot: TruthSnapshot | undefined;
  stale: boolean;
  lang: Lang;
}

/** Render the full three-band front door (identity · verdict · command map). */
export function renderFrontDoor(input: FrontDoorInput): string {
  const { version, slogan, snapshot, stale, lang } = input;
  const identity = `${c("fg", "roll", { bold: true })} v${version}${c("muted", ` — ${slogan}`)}`;
  const footer =
    `${c("muted", lang === "zh" ? "首次使用？" : "first time?")} ${c("blue", "→ roll init")}` +
    `        ${c("muted", lang === "zh" ? "文档" : "docs")} ${c("blue", "→ guide/getting-started")}`;
  return [identity, "", verdictLine(snapshot, stale, lang), "", commandMap(lang), "", footer, ""].join("\n");
}
