/**
 * US-PAIR-016 — `roll effort`: the read-only effort view.
 *
 * Renders one row per (gate x achieved isolation tier) so the "stronger isolation
 * and more review gates cost more but catch more" trade-off can finally be looked
 * at instead of assumed.
 *
 * Strictly read-only: reads the event stream, writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_SAMPLES_FOR_RATE, effortView, type EffortView } from "@roll/core";
import { parseEventLine, type RollEvent } from "@roll/spec";

export const EFFORT_USAGE = `Usage: roll effort [--json]
  Read-only view of review effort vs outcome, grouped by review gate and the
  isolation tier actually ACHIEVED (not the one requested).
  按「关卡 × 实际达成的隔离档」只读查看评审投入与产出。

  A cell with fewer than ${MIN_SAMPLES_FOR_RATE} samples reports counts only and NO rate — a
  rate over a handful of samples reads like a trend and is not one.
  样本不足 ${MIN_SAMPLES_FOR_RATE} 的格子只报计数、不给比率。

  Observable and unobservable cost are listed separately and never averaged
  together: an unparseable usage footer is not "free".
  可观测与不可观测成本分开列出,绝不混算 —— 解析不出用量不等于免费。
`;

function readEvents(runtimeDir: string): RollEvent[] {
  const path = join(runtimeDir, "events.ndjson");
  if (!existsSync(path)) return [];
  const out: RollEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const e = parseEventLine(line);
    if (e !== null) out.push(e);
  }
  return out;
}

/** Render the view as an aligned table plus the honesty notes. Pure. */
export function renderEffortView(view: EffortView): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  Review effort vs outcome · 评审投入与产出");
  lines.push("");
  if (view.cells.length === 0) {
    lines.push("    No dispatch carries an achieved isolation tier yet.");
    lines.push("    尚无带「实际达成隔离档」的派活记录。");
    if (view.untieredSamples > 0) {
      lines.push("");
      lines.push(`    ${view.untieredSamples} verdict(s) predate tier recording and are NOT counted here.`);
      lines.push(`    有 ${view.untieredSamples} 条裁定早于隔离档记录,未计入。`);
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push("    gate    tier      samples  hits  hitRate  observed$   unobs.rows  mismatch  degraded");
  for (const c of view.cells) {
    const rate = c.hitRate === undefined ? "n/a" : `${(c.hitRate * 100).toFixed(0)}%`;
    lines.push(
      `    ${c.gate.padEnd(7)} ${c.achievedTier.padEnd(9)} ${String(c.samples).padStart(7)} ${String(c.hits).padStart(5)} ` +
        `${rate.padStart(8)} ${c.observedCostUsd.toFixed(4).padStart(10)} ${String(c.unobservableCostRows).padStart(11)} ` +
        `${String(c.modelMismatches).padStart(9)} ${String(c.degraded).padStart(9)}`,
    );
  }

  if (view.insufficientCells.length > 0) {
    lines.push("");
    lines.push(`    Insufficient sample (< ${MIN_SAMPLES_FOR_RATE}) — counts only, no rate:`);
    lines.push(`    样本不足(< ${MIN_SAMPLES_FOR_RATE}),只报计数不给比率:`);
    for (const c of view.insufficientCells) {
      lines.push(`      ${c.gate} / ${c.achievedTier} — ${c.samples} sample(s)`);
    }
  }
  if (view.untieredSamples > 0) {
    lines.push("");
    lines.push(`    ${view.untieredSamples} verdict(s) carry no achieved tier (pre-recording history) — excluded.`);
    lines.push(`    有 ${view.untieredSamples} 条裁定没有达成档记录(早于该字段),已排除。`);
  }
  lines.push("");
  lines.push("    unobs.rows = spend that could not be observed. NOT zero-cost.");
  lines.push("    unobs.rows = 无法观测到的花费,不等于零成本。");
  lines.push("");
  return lines.join("\n");
}

/** Runtime dir, honouring ROLL_PROJECT_RUNTIME_DIR (same rule as attest/cycle). */
function resolveRuntimeDir(projectPath: string): string {
  return (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(projectPath, ".roll", "loop");
}

export function effortCommand(args: readonly string[], projectPath: string = process.cwd()): number {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(EFFORT_USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== "--json");
  if (unknown.length > 0) {
    process.stderr.write(`roll effort: unknown argument '${unknown[0] ?? ""}'\n${EFFORT_USAGE}`);
    return 2;
  }
  const view = effortView(readEvents(resolveRuntimeDir(projectPath)));
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${renderEffortView(view)}\n`);
  return 0;
}
