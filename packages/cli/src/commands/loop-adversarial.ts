/**
 * @responsibility Runs the `roll loop adversarial` subcommand, aggregating adversarial-pairing cohort metrics.
 */
/**
 * `roll loop adversarial [--json]` — US-LOOP-104.
 *
 * The read-only shadow-run aggregate (design §9): fold the adversarial-pairing
 * outcome stamped on each runs row (`adversarial`, US-LOOP-104) into cohort
 * metrics — average holes broken open, average attacker rounds, degrade rate —
 * and contrast the adversarial cohort against the standard-builder cohort so the
 * owner can judge "does adversarial pairing really catch more bugs" from data.
 * Purely reads runs.jsonl (+ rotations); never mutates anything.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { aggregateAdversarial, type AdversarialRunSummary } from "@roll/core";

function projectRoot(): string {
  const envRoot = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim();
  return envRoot === "" ? process.cwd() : envRoot;
}

function loopDir(root: string): string {
  const envDir = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return envDir === "" ? join(root, ".roll", "loop") : envDir;
}

/** runs.jsonl + any rotated runs.jsonl.<n> siblings, oldest-first. */
function runsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "runs.jsonl" || /^runs\.jsonl\.\d+$/.test(name)) out.push(join(dir, name));
  }
  return out.sort();
}

function readRunRows(dir: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const file of runsFiles(dir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) rows.push(obj as Record<string, unknown>);
      } catch {
        /* skip malformed line (I8: readers never crash) */
      }
    }
  }
  return rows;
}

/** Pull a well-formed AdversarialRunSummary off a runs row, or null. */
function rowAdversarial(row: Record<string, unknown>): AdversarialRunSummary | null {
  const a = row["adversarial"];
  if (a === null || a === undefined || typeof a !== "object" || Array.isArray(a)) return null;
  const rec = a as Record<string, unknown>;
  const reason = rec["terminationReason"];
  return {
    rounds: typeof rec["rounds"] === "number" ? rec["rounds"] : 0,
    holesFound: typeof rec["holesFound"] === "number" ? rec["holesFound"] : 0,
    terminationReason:
      reason === "dry" || reason === "max_rounds" || reason === "timeout" || reason === "degraded" ? reason : "degraded",
    degraded: rec["degraded"] === true,
  };
}

export function loopAdversarialCommand(args: string[]): number {
  const json = args.includes("--json");
  const dir = loopDir(projectRoot());
  const rows = readRunRows(dir);

  const summaries: AdversarialRunSummary[] = [];
  const durations: number[] = [];
  let standardCohort = 0;
  for (const row of rows) {
    // Only terminal delivery-ish rows carry a run; a row with an adversarial
    // object is an adversarial cycle, otherwise it is a standard cycle.
    const summary = rowAdversarial(row);
    if (summary !== null) {
      summaries.push(summary);
      const d = row["duration_sec"];
      if (typeof d === "number" && d >= 0) durations.push(d);
    } else if (row["run_id"] !== undefined || row["status"] !== undefined) {
      standardCohort += 1;
    }
  }

  const agg = aggregateAdversarial(summaries);
  const avgDurationSec =
    durations.length === 0 ? 0 : durations.reduce((s, x) => s + x, 0) / durations.length;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schema: "roll.adversarial.v1",
        adversarialCohort: agg.cards,
        standardCohort,
        avgHoles: agg.avgHoles,
        avgRounds: agg.avgRounds,
        degradeRate: agg.degradeRate,
        avgDurationSec,
      })}\n`,
    );
    return 0;
  }

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const lines = [
    "adversarial pairing · shadow-run  (read-only, from runs.jsonl)",
    "攻防结对 · 影子跑                    (只读,来自 runs.jsonl)",
    "",
    `  adversarial cycles   攻防 cycle 数    ${agg.cards}`,
    `  standard cycles      标准 cycle 数    ${standardCohort}`,
    `  avg holes / card     平均抓洞数       ${num(agg.avgHoles)}`,
    `  avg rounds / card    平均攻防回合     ${num(agg.avgRounds)}`,
    `  degrade rate         降级率           ${pct(agg.degradeRate)}`,
    `  avg duration         攻防均耗时       ${num(avgDurationSec)}s`,
  ];
  if (agg.cards === 0) {
    lines.push("", "  (no adversarial cycles recorded yet — verified/designed profile is dormant until opted in)");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
