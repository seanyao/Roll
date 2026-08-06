/**
 * @responsibility Renders the init diagnosis report in the resolved language.
 */
import { type Lang } from "@roll/spec";
import { type InitDiagnosis } from "./init-diagnosis.js";

function label(en: string, zh: string, lang: Lang): string {
  return lang === "zh" ? zh : en;
}

export function renderInitRecommendation(diagnosis: InitDiagnosis, lang: Lang): string {
  const lines: string[] = [];
  if (diagnosis.kind === "roll-ready") {
    lines.push(label("Already initialized.", "已完成初始化。", lang));
    lines.push(`Next: ${diagnosis.nextCommand}`);
    return lines.join("\n");
  }

  lines.push(`${label("Detected", "检测结果", lang)}: ${diagnosis.kind}`);
  lines.push(`Recommended path: ${diagnosis.recommendedPath}`);
  if (diagnosis.reasons.length > 0) {
    lines.push(label("Reasons:", "原因：", lang));
    for (const reason of diagnosis.reasons) lines.push(`  - ${reason}`);
  }
  lines.push(`Next: ${diagnosis.nextCommand}`);
  if (diagnosis.recommendedPath === "repair-roll" || diagnosis.recommendedPath === "migrate-roll-layout") {
    lines.push("No files changed.");
  }
  return lines.join("\n");
}
