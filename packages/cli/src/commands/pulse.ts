/**
 * @responsibility Runs the `pulse` subcommand, rendering today's delivery pulse one-screen.
 */
/**
 * US-DEMO-001 — `roll pulse`: today's delivery pulse CLI one-screen.
 *
 * Reads the ONE TruthSnapshot (truth.json, same source as the web Now tab)
 * and prints today's delivery pulse: cycles in window, merged count, attested
 * count, plus an ASCII sparkline from the story spectrum. Bilingual EN/中.
 * `--json` emits the same numbers as machine-readable JSON.
 *
 * Pure new command — no existing behaviour changed.
 */
import { resolveLang, type Lang } from "@roll/spec";
import type { TruthSnapshot, TruthSnapshotStoryEntry, TruthSpectrumState } from "@roll/spec";
import { c, renderState } from "../render.js";
import { loadTruthSnapshot } from "../lib/truth-read.js";

// ── Sparkline ────────────────────────────────────────────────────────────────
const SPARK_CHARS = " ▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  const max = Math.max(...values, 1);
  return values.map((v) => SPARK_CHARS[Math.min(Math.round((v / max) * 8), 8)] ?? SPARK_CHARS[8]).join("");
}

const SPECTRUM_LABEL_EN: Record<TruthSpectrumState, string> = {
  done: "done",
  wip: "wip",
  hold: "hold",
  todo: "todo",
  fail: "fail",
  unknown: "unk",
};
const SPECTRUM_LABEL_ZH: Record<TruthSpectrumState, string> = {
  done: "已交付",
  wip: "进行中",
  hold: "挂起",
  todo: "待办",
  fail: "漂移",
  unknown: "未知",
};

// ── Pulse output ─────────────────────────────────────────────────────────────

export function pulseCommand(args: string[]): number {
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

  const snapshot = loadTruthSnapshot(process.cwd());
  if (snapshot === undefined) {
    if (json) {
      process.stdout.write(JSON.stringify({ error: "no truth.json found — run `roll index` first" }) + "\n");
    } else {
      process.stderr.write(
        lang === "zh"
          ? "未找到 truth.json —— 请先运行 `roll index`。\n"
          : "No truth.json found — run `roll index` first.\n",
      );
    }
    return 1;
  }

  const cyc = snapshot.cycle;
  const stories: TruthSnapshotStoryEntry[] = snapshot.stories ?? [];
  const merged = stories.filter((s) => s.ladder === "merged" || s.ladder === "attested").length;
  const attested = stories.filter((s) => s.ladder === "attested").length;
  const cycles = cyc?.cycles3d ?? 0;

  // Sparkline from the story spectrum distribution
  const spectrum = snapshot.story.spectrum;
  const spectrumOrder: TruthSpectrumState[] = ["done", "fail", "unknown", "wip", "todo", "hold"];
  const spectrumValues = spectrumOrder.map((k) => spectrum[k]);
  const bars = sparkline(spectrumValues);

  // Build sparkline legend
  const legendPairs = spectrumOrder
    .filter((k) => spectrum[k] > 0)
    .map((k) => `${SPARK_CHARS[8]} ${lang === "zh" ? SPECTRUM_LABEL_ZH[k] : SPECTRUM_LABEL_EN[k]} ${spectrum[k]}`);
  const legendLine = legendPairs.join("  ");

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          cycles,
          merged,
          attested,
          sparkline: bars,
          spectrum,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const zh = lang === "zh";

  // Build the one-screen pulse display
  const out: string[] = [];
  out.push("");
  out.push(`  ${c("blue", "⚡ roll pulse", { bold: true })}  ${c("dim", zh ? "今日交付脉搏" : "Today's Delivery Pulse")}`);
  out.push("");

  // Key metrics
  out.push(`  ${c("dim", zh ? "近 3d 周期" : "Cycles 3d")}  ${c("green", String(cycles), { bold: true })}`);
  out.push(`  ${c("dim", zh ? "已合 merged" : "Merged")}     ${c("green", String(merged), { bold: true })}`);
  out.push(`  ${c("dim", zh ? "已验收 attested" : "Attested")}  ${c("green", String(attested), { bold: true })}`);
  out.push("");

  // Sparkline
  out.push(`  ${c("dim", zh ? "状态分布" : "Spectrum")}  ${bars}`);
  out.push(`  ${c("dim", legendLine)}`);
  out.push("");

  process.stdout.write(out.join("\n"));
  return 0;
}
