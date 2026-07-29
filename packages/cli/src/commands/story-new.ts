/**
 * `roll story new` — the SINGLE channel for minting a card folder
 * (US-META-009). Reverse-derivation audit, 2026-06-08: card creation had no
 * code-enforced shape — `roll idea` generated proper cards, but design-time
 * splits hand-wrote (or skipped) spec.md, producing frontmatter-less specs
 * and backlog rows with no card at all (US-DOSSIER-001a~d, SoloGo). Skills
 * now call this command instead of hand-writing files.
 *
 *   roll story new <ID> --title <text> [--epic <epic>] [--note <text>]
 *
 * Creates `features/<epic>/<ID>/spec.md` (frontmatter via renderSpecMd) and
 * the story page skeleton, then refreshes `.roll/index.json`. Refuses to
 * overwrite an existing spec — cards are born once, evolved by hand after.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNCATEGORIZED, generateIndex } from "../lib/archive.js";
import { BacklogStore, appendBacklogRow } from "@roll/core";
import { STORY_ID_RE, renderSpecMd, renderStoryPage } from "../lib/story-page.js";
import { GRANULARITY_LIMITS } from "../lib/card-granularity.js";

function todayYmd(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse `--flag value` pairs; returns null on malformed input. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

export function storyNewCommand(args: string[]): number {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === undefined) {
    process.stdout.write(
      "Usage: roll story new <ID> --title <text> [--epic <epic>] [--note <text>]\n" +
        "                      [--est-min <n>] [--risk-tier low|high] [--no-index]\n" +
        "  The ONE card-minting entry: card folder (spec.md + index.html) + backlog row\n" +
        "  + .roll/index.json cache refresh. --no-index defers the cache for batch minting;\n" +
        "  the cache is best-effort — the live locator resolves cards without it.\n" +
        `  --est-min (≤${GRANULARITY_LIMITS.maxEstMin}) + --risk-tier seed the granularity contract (US-CYCLE-005);\n` +
        "  an oversized --est-min is rejected at mint. 违规即拒,拆小再建。\n" +
        "  单一建卡入口:卡夹 + backlog 行 + index.json 缓存刷新一步完成。\n" +
        "  批量建卡用 --no-index 延后缓存;缓存是尽力而为,定位器无需它即可解析卡片。\n",
    );
    return args[0] === undefined ? 1 : 0;
  }
  const id = args[0];
  if (!STORY_ID_RE.test(id)) {
    process.stderr.write(`story new: '${id}' is not a story id (US-/FIX-/REFACTOR-/IDEA-…)\nstory new: '${id}' 不是合法故事 ID\n`);
    return 2;
  }
  const title = flagValue(args, "--title");
  if (title === undefined || title === "") {
    process.stderr.write("story new: --title is required\nstory new: 必须提供 --title\n");
    return 2;
  }
  const epic = flagValue(args, "--epic") ?? UNCATEGORIZED;
  const note = flagValue(args, "--note");

  // US-CYCLE-005 — granularity contract at the mint boundary. Both flags are
  // optional (existing skeleton-first callers are unaffected), but when given
  // they are VALIDATED and minted into frontmatter — a new card cannot be born
  // oversized. est_min > limit or a bad risk_tier is fail-loud.
  const estMinRaw = flagValue(args, "--est-min");
  const riskTierRaw = flagValue(args, "--risk-tier");
  let estMin: number | undefined;
  if (estMinRaw !== undefined) {
    estMin = Number(estMinRaw);
    if (!Number.isFinite(estMin) || estMin <= 0) {
      process.stderr.write(`story new: --est-min must be a positive number of minutes\nstory new: --est-min 必须是正整数分钟\n`);
      return 2;
    }
    if (estMin > GRANULARITY_LIMITS.maxEstMin) {
      process.stderr.write(
        `story new: --est-min ${estMin} exceeds the ${GRANULARITY_LIMITS.maxEstMin}-min limit — split the card so one builder session fits\n` +
          `story new: --est-min ${estMin} 超过 ${GRANULARITY_LIMITS.maxEstMin} 分钟上限 — 请拆小到单个 builder session\n`,
      );
      return 2;
    }
  }
  let riskTier: "low" | "high" | undefined;
  if (riskTierRaw !== undefined) {
    if (riskTierRaw !== "low" && riskTierRaw !== "high") {
      process.stderr.write(`story new: --risk-tier must be 'low' or 'high'\nstory new: --risk-tier 必须是 low 或 high\n`);
      return 2;
    }
    riskTier = riskTierRaw;
  }

  const cwd = process.cwd();
  const dir = join(cwd, ".roll", "features", epic, id);
  if (existsSync(join(dir, "spec.md"))) {
    process.stderr.write(`story new: ${epic}/${id}/spec.md already exists — cards are born once\nstory new: 卡已存在，不可覆盖\n`);
    return 1;
  }
  const meta = {
    id,
    title,
    created: todayYmd(),
    ...(epic !== UNCATEGORIZED ? { epic } : {}),
    ...(note !== undefined && note !== "" ? { note } : {}),
    ...(estMin !== undefined ? { estMin } : {}),
    ...(riskTier !== undefined ? { riskTier } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), renderSpecMd(meta), "utf8");
  writeFileSync(join(dir, "index.html"), renderStoryPage(meta), "utf8");
  // FIX-250: a card is BORN with its backlog row — "单一建卡入口" was only half
  // the chain while agents still hand-appended rows. Optimistically-locked
  // write (I9); an existing row is a no-op so re-runs stay idempotent.
  let rowNote = "";
  try {
    const backlogPath = join(cwd, ".roll", "backlog.md");
    if (existsSync(backlogPath)) {
      const store = new BacklogStore();
      const before = store.readBacklog(backlogPath);
      let appended = false;
      store.writeBacklog(backlogPath, before.hash, (content) => {
        const r = appendBacklogRow(content, { id, title, epic });
        appended = r.appended;
        return r.content;
      });
      rowNote = appended ? `  backlog row appended (📋 Todo)\n` : `  backlog row already present — untouched\n`;
    } else {
      rowNote = "  no .roll/backlog.md — row skipped\n";
    }
  } catch (e) {
    rowNote = `  backlog row append failed (${e instanceof Error ? e.message : "?"}) — append it manually\n`;
  }
  // US-V4-001: maintain the lightweight `.roll/index.json` ID→epic CACHE at card
  // creation (best-effort; the live-first locator works without it). --no-index
  // defers even that for batch minting. The global dossier/epic page refresh is
  // NO LONGER a delivery side effect — run `roll index` to render pages on demand.
  if (!args.includes("--no-index")) {
    try {
      generateIndex(cwd);
    } catch {
      /* index cache is best-effort; the locator re-derives via live walk */
    }
  }
  // US-CYCLE-005 — surface the granularity contract at birth so the designer
  // fills a card that will PASS `roll story validate` (≤3 evidence, ≤6 AC,
  // est_min ≤25, risk_tier low|high). Advisory here; validate is the hard gate.
  const checklist =
    estMin === undefined || riskTier === undefined
      ? "  granularity contract (US-CYCLE-005) — a minted card must satisfy before backlog:\n" +
        `    • Evaluation contract section · expected_evidence ≤${GRANULARITY_LIMITS.maxEvidence} · AC ≤${GRANULARITY_LIMITS.maxAc} · est_min ≤${GRANULARITY_LIMITS.maxEstMin} · risk_tier low|high\n` +
        "    ↳ pass --est-min <n> --risk-tier low|high to seed them now; run `roll story validate " +
        `${id}` +
        "` to gate.\n"
      : `  granularity: seeded est_min=${estMin} risk_tier=${riskTier}; fill ≤${GRANULARITY_LIMITS.maxEvidence} evidence + ≤${GRANULARITY_LIMITS.maxAc} AC, then \`roll story validate ${id}\`.\n`;
  process.stdout.write(`card minted\n卡已建档\n  .roll/features/${epic}/${id}/spec.md\n${rowNote}${checklist}`);
  return 0;
}
