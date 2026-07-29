/**
 * FIX-389a / US-TRUTH-016 AC4 — `roll truth query <storyId>`: the one CLI
 * entry point for deterministic delivery-truth queries.
 *
 * Before reading deliveries.jsonl, calls `ensureDeliveriesFresh` (from core)
 * so the projection engine rebuilds the cache from runs+git facts when stale.
 * This means deleting deliveries.jsonl and re-running produces the same
 * result — the cache is never authoritative (AC2).
 *
 * Usage:
 *   roll truth query <storyId>       — human-readable, locale-resolved
 *   roll truth query <storyId> --json — machine-readable JSON
 */
import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveLang } from "@roll/spec";
import {
  queryStoryDelivery,
  nodeDeliveryStore,
  nodeExecPort,
  ensureDeliveriesFresh,
  runConsistencyAudit,
  parseBacklog,
  emptyAuditSnapshot,
  type FreshnessPort,
  type StoryDeliveryTruth,
  type AuditFinding,
} from "@roll/core";
import { TERMINAL_SCHEMA_EPOCH_SEC } from "../lib/consistency-audit.js";

export const TRUTH_USAGE =
  "Usage: roll truth <command> [--workspace <id|path>]\n" +
  "  query <storyId>  Deterministic delivery-truth query (structured, zero markdown parse).\n" +
  "  audit            Bidirectional drift audit: backlog Done ↔ projection truth.\n" +
  "命令:\n" +
  "  query <storyId>  结构化交付真相查询（确定性，不解析 markdown）\n" +
  "  audit            双向漂移审计：backlog Done ↔ 投影真相";

function formatTruth(t: StoryDeliveryTruth, lang: "en" | "zh"): string {
  const lines: string[] = [];
  lines.push(`${t.storyId}`);
  lines.push(`  lifecycleState: ${t.lifecycleState}`);
  lines.push(`  delivered: ${t.delivered}`);
  if (t.prNumber !== undefined) lines.push(`  prNumber: ${t.prNumber}`);
  if (t.prUrl !== undefined) lines.push(`  prUrl: ${t.prUrl}`);
  if (t.mergeCommit !== undefined) lines.push(`  mergeCommit: ${t.mergeCommit}`);
  lines.push(`  lastRecordedAt: ${t.lastRecordedAt}`);
  lines.push(`  deliveringCycles: [${t.deliveringCycles.join(", ")}]`);
  if (t.missingReason !== undefined) {
    const label = lang === "zh" ? "缺失原因" : "missing reason";
    lines.push(`  ${label}: ${t.missingReason}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface TruthCommandDeps {
  readonly projectPath?: string;
  readonly backlogPath?: string;
  readonly runtimeRoot?: string;
}

// ── Node-backed FreshnessPort ────────────────────────────────────────────────

/** Node `fs`-backed {@link FreshnessPort} for production use. */
const nodeFreshnessPort: FreshnessPort = {
  mtimeMs(absPath: string): number | undefined {
    try {
      return statSync(absPath).mtimeMs;
    } catch {
      return undefined;
    }
  },
  readText(absPath: string): string {
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      return "";
    }
  },
  writeText(absPath: string, text: string): void {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, text, "utf8");
  },
};

// ── `roll truth audit` — bidirectional drift audit (FIX-390) ─────────────

function truthAuditCommand(args: string[], lang: "en" | "zh", deps: TruthCommandDeps): number {
  const json = args.includes("--json");
  const cwd = deps.projectPath ?? process.cwd();
  const nowSec = Math.floor(Date.now() / 1000);

  // Read backlog
  const backlogPath = deps.backlogPath ?? join(cwd, ".roll", "backlog.md");
  const backlogRows: Array<{ id: string; status: string }> = existsSync(backlogPath)
    ? parseBacklog(readFileSync(backlogPath, "utf8")).map((r) => ({ id: r.id, status: r.status }))
    : [];

  // Load deliveries (ensure fresh projection)
  const deliveries = ensureDeliveriesFresh(cwd, nodeFreshnessPort, nodeExecPort, undefined, deps.runtimeRoot);

  // Build snapshot — only feedback sources needed for claim-drift (FIX-390)
  const snapshot = emptyAuditSnapshot(nowSec, TERMINAL_SCHEMA_EPOCH_SEC);
  snapshot.backlog = backlogRows;
  snapshot.deliveries = deliveries;

  // Single verdict function (FIX-390 AC3): same as roll release consistency audit
  const report = runConsistencyAudit(snapshot);

  // Isolate claim-drift findings (the only rule this light snapshot exercises)
  const driftFindings = report.findings.filter((f) => f.rule === "claim-drift");

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          drift: driftFindings.length,
          findings: driftFindings,
          summary: report.summary,
        },
        null,
        2,
      ) + "\n",
    );
    return driftFindings.length > 0 ? 1 : 0;
  }

  // No drift → clean
  if (driftFindings.length === 0) {
    process.stdout.write(
      lang === "zh"
        ? "✅ 一致 — backlog 与投影一致。\n"
        : "✅ Consistent — backlog matches projection.\n",
    );
    process.stdout.write(
      lang === "zh"
        ? `审计: 失败 ${report.summary.fail} · 警告 ${report.summary.warn} · 未知 ${report.summary.unknown} · 历史豁免 ${report.summary.grandfathered}\n`
        : `Audit: fail ${report.summary.fail} · warn ${report.summary.warn} · unknown ${report.summary.unknown} · grandfathered ${report.summary.grandfathered}\n`,
    );
    return 0;
  }

  // Drift found → report each card
  const failCount = driftFindings.filter((f) => f.severity === "fail").length;
  const warnCount = driftFindings.filter((f) => f.severity === "warn").length;

  process.stdout.write(
    lang === "zh"
      ? `⚠ 漂移发现 — ${driftFindings.length} 卡不一致（失败 ${failCount} · 警告 ${warnCount}）\n\n`
      : `⚠ Drift detected — ${driftFindings.length} card(s) inconsistent (fail ${failCount} · warn ${warnCount})\n\n`,
  );

  for (const f of driftFindings) {
    const label =
      f.severity === "fail"
        ? lang === "zh" ? "✗ 失败" : "✗ FAIL"
        : lang === "zh" ? "⚠ 警告" : "⚠ WARN";
    process.stdout.write(`  ${label}  ${f.subject}\n`);
    // Indent the already bilingual detail from the rule
    process.stdout.write(`    ${f.detail}\n\n`);
  }

  process.stdout.write(
    lang === "zh"
      ? `审计: 失败 ${report.summary.fail} · 警告 ${report.summary.warn} · 未知 ${report.summary.unknown} · 历史豁免 ${report.summary.grandfathered}\n`
      : `Audit: fail ${report.summary.fail} · warn ${report.summary.warn} · unknown ${report.summary.unknown} · grandfathered ${report.summary.grandfathered}\n`,
  );

  // FIX-390 AC5: non-zero exit on drift
  return 1;
}

export function truthCommand(args: string[], deps: TruthCommandDeps = {}): number {
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });

  // Subcommand routing
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(`${TRUTH_USAGE}\n`);
    return sub === undefined ? 1 : 0;
  }

  if (sub === "audit") {
    return truthAuditCommand(args.slice(1), lang, deps);
  }

  if (sub !== "query") {
    process.stderr.write(
      lang === "zh"
        ? `[roll] 未知 truth 子命令: ${sub}（试试 roll truth query <storyId> 或 roll truth audit）\n`
        : `[roll] unknown truth subcommand: ${sub} (try roll truth query <storyId> or roll truth audit)\n`,
    );
    return 1;
  }

  const rest = args.slice(1);
  const json = rest.includes("--json");
  const storyId = rest.find((a) => a !== "--json");

  if (storyId === undefined) {
    process.stderr.write(
      lang === "zh"
        ? `[roll] 需要 storyId（试试 roll truth query <storyId>）\n`
        : `[roll] storyId required (try roll truth query <storyId>)\n`,
    );
    return 1;
  }

  // FIX-389a AC2: ensure the deliveries cache is fresh (project from runs+git)
  // before querying. Delete deliveries.jsonl + re-run → same result.
  const cwd = deps.projectPath ?? process.cwd();
  const deliveries = ensureDeliveriesFresh(cwd, nodeFreshnessPort, nodeExecPort, undefined, deps.runtimeRoot);
  const truth = queryStoryDelivery(storyId, deliveries);

  if (json) {
    process.stdout.write(JSON.stringify(truth, null, 2) + "\n");
  } else {
    process.stdout.write(formatTruth(truth, lang));
  }

  return 0;
}
