/**
 * @responsibility Runs the release consistency shadow drift scanner.
 */
/**
 * US-TRUTH-002 — `roll release consistency audit`: the shadow drift scanner.
 *
 * Read-only gatherer over the fact sources declared in US-TRUTH-000 (backlog,
 * index, runs, events, attest artifacts, GitHub PR evidence), folded through
 * core's pure `runConsistencyAudit` rules, written as a dated report under
 * `.roll/reports/consistency/`. SHADOW contract (AC5): no ALERT, no status
 * writes, no release impact — the exit code is 0 even when drift is found
 * (only a broken invocation returns non-zero).
 *
 * Bounded probes: at most {@link PROBE_CAP} GitHub lookups per lane (Done-row
 * delivery PRs; claim-shaped cycle branches). The report records what was
 * skipped — a silent cap would read as "no drift" (no-silent-caps rule).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  emptyAuditSnapshot,
  parseBacklog,
  reconcileBranchName,
  runConsistencyAudit,
  readDeliveries,
  nodeDeliveryStore,
  type AuditReport,
  type AuditSnapshot,
} from "@roll/core";
import { type PrMergeInfo, ghRepoSlug, prViewMergeInfo, remoteUrl } from "@roll/infra";
import { eventTsMs, parseEventLine } from "@roll/spec";
import { cardArchiveDir, readIndex, reportFileName } from "./archive.js";
import { hasVisualEvidenceAc } from "./design-visual-evidence.js";

/** Max GitHub probes per lane — the fan-out must never stall the audit. */
export const PROBE_CAP = 20;

export { TERMINAL_SCHEMA_EPOCH_SEC } from "@roll/spec";
import { TERMINAL_SCHEMA_EPOCH_SEC } from "@roll/spec";

/** Counting window for the failure-count cross-check (72h, the panel window). */
const COUNT_WINDOW_SEC = 72 * 3600;
const execFileAsync = promisify(execFile);

export interface AuditGatherDeps {
  /** PR merge-info fetcher (tests inject; default `gh pr view`). */
  fetchInfo?: (slug: string, ref: string) => Promise<PrMergeInfo | undefined>;
  /** Repo slug override (tests). */
  slug?: string;
  /** Local main ahead count override (tests). */
  localMainAhead?: () => Promise<number>;
  nowSec?: number;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* junk line — the audit is lenient */
    }
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasScreenshotArtifact(reportPath: string): boolean {
  const runDir = dirname(reportPath);
  const manifest = readJson(join(runDir, "evidence.json"));
  if (manifest !== null) {
    const screenshots = manifest["screenshots"];
    if (Array.isArray(screenshots) && screenshots.some((x) => typeof x === "string" && x !== "")) return true;
    const captures = manifest["captures"];
    if (Array.isArray(captures)) {
      if (
        captures.some((raw) => {
          if (typeof raw !== "object" || raw === null) return false;
          return (raw as Record<string, unknown>)["taken"] === true;
        })
      ) {
        return true;
      }
    }
  }
  const dir = join(runDir, "screenshots");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => /\.png$/i.test(name));
  } catch {
    return false;
  }
}

function hasMachineCaptureSkip(reportPath: string): boolean {
  const manifest = readJson(join(dirname(reportPath), "evidence.json"));
  const captures = manifest?.["captures"];
  if (!Array.isArray(captures)) return false;
  return captures.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const row = raw as Record<string, unknown>;
    return row["taken"] === false && typeof row["skipped"] === "string" && row["skipped"] !== "";
  });
}

async function gitLocalMainAhead(projectPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--count", "origin/main..main"], {
      cwd: projectPath,
      encoding: "utf8",
    });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

/** Assemble the audit snapshot from the project's fact sources (read-only). */
export async function gatherAuditSnapshot(
  projectPath: string,
  runtimeDir: string,
  deps: AuditGatherDeps = {},
): Promise<{ snapshot: AuditSnapshot; skipped: string[] }> {
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const snapshot = emptyAuditSnapshot(nowSec, TERMINAL_SCHEMA_EPOCH_SEC);
  const skipped: string[] = [];

  // backlog rows (id + raw status cell)
  const backlogPath = join(projectPath, ".roll", "backlog.md");
  if (existsSync(backlogPath)) {
    snapshot.backlog = parseBacklog(readFileSync(backlogPath, "utf8")).map((r) => ({ id: r.id, status: r.status }));
  }

  // index map
  snapshot.index = readIndex(projectPath);

  // local main drift (FIX-252): read-only git probe; absence is not drift.
  snapshot.localMainAhead = deps.localMainAhead !== undefined ? await deps.localMainAhead() : await gitLocalMainAhead(projectPath);

  // runs rows
  snapshot.runs = readJsonl(join(runtimeDir, "runs.jsonl"));

  // events: terminal twins + failed cycle:end count in the window
  let eventFailed = 0;
  const terminal: string[] = [];
  const eventsPath = join(runtimeDir, "events.ndjson");
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      const e = parseEventLine(line);
      if (e === null) continue;
      if (e.type === "cycle:terminal") terminal.push(e.cycleId);
      // FIX-1490: `nowSec` is seconds but the stream carries a mixed-unit tail, so
      // compare both sides in epoch ms rather than subtracting across units.
      if (
        e.type === "cycle:end" &&
        e.outcome === "failed" &&
        eventTsMs(nowSec) - eventTsMs(e.ts) <= COUNT_WINDOW_SEC * 1000
      ) {
        eventFailed += 1;
      }
    }
  }
  snapshot.terminalCycleIds = terminal;
  snapshot.eventFailedCount = eventFailed;
  snapshot.runsFailedCount = snapshot.runs.filter((r) => {
    if (r["status"] !== "failed") return false;
    const ts = typeof r["ts"] === "string" ? Date.parse(r["ts"]) / 1000 : Number.NaN;
    return Number.isFinite(ts) && nowSec - ts <= COUNT_WINDOW_SEC;
  }).length;

  // attest artifact probes — Done rows with a live card folder
  for (const row of snapshot.backlog) {
    if (!row.status.includes("✅")) continue;
    const card = cardArchiveDir(projectPath, row.id);
    if (!existsSync(card)) continue; // pre-card era → grandfather lane in the rules
    const reportPath = join(card, "latest", reportFileName(row.id));
    // FIX-933: a pure back-end card has no visual-evidence AC and thus
    // legitimately carries no screenshots — the audit rule must not flag it.
    const specPath = join(card, "spec.md");
    let noVisualSurface = false;
    if (existsSync(specPath)) {
      try {
        noVisualSurface = !hasVisualEvidenceAc(readFileSync(specPath, "utf8"));
      } catch {
        // unreadable spec — conservative: don't skip the visual gate
      }
    }
    snapshot.attest[row.id] = {
      report: existsSync(reportPath),
      acMap: existsSync(join(card, "ac-map.json")),
      visualEvidence: existsSync(reportPath) ? hasScreenshotArtifact(reportPath) : false,
      machineSkip: existsSync(reportPath) ? hasMachineCaptureSkip(reportPath) : false,
      noVisualSurface,
    };
  }

  // GitHub evidence — bounded, lenient (no slug / gh down → unknown lane)
  const slug = deps.slug ?? ghRepoSlug(await remoteUrl(projectPath));
  const fetchInfo = deps.fetchInfo ?? prViewMergeInfo;
  if (slug === undefined) {
    skipped.push("github-probes: no repo slug — all PR evidence lanes report unknown");
  } else {
    // lane 1: Done rows annotated PR#N (most recent rows in file order)
    const annotated = snapshot.backlog.filter((r) => r.status.includes("✅") && /PR#(\d+)/.test(r.status));
    const probeRows = annotated.slice(-PROBE_CAP);
    if (annotated.length > probeRows.length) {
      skipped.push(`done-row probes capped at ${PROBE_CAP} of ${annotated.length} — older rows report unknown`);
    }
    for (const row of probeRows) {
      const num = /PR#(\d+)/.exec(row.status)?.[1] ?? "";
      try {
        const info = await fetchInfo(slug, num);
        if (info !== undefined) {
          snapshot.prEvidence[row.id] = {
            state: info.state,
            ...(info.mergedAt !== undefined ? { mergedAtSec: Date.parse(info.mergedAt) / 1000 } : {}),
          };
        }
      } catch {
        /* unresolved probe stays out of the map → unknown */
      }
    }
    // lane 2: claim-shaped run rows → cycle branch PRs
    const claims = snapshot.runs.filter(
      (r) =>
        typeof r["cycle_id"] === "string" &&
        ["built", "published", "failed"].includes(String(r["status"])) &&
        (typeof r["merge_commit"] !== "string" || r["merge_commit"] === ""),
    );
    const probeClaims = claims.slice(-PROBE_CAP);
    if (claims.length > probeClaims.length) {
      skipped.push(`cycle-branch probes capped at ${PROBE_CAP} of ${claims.length}`);
    }
    for (const r of probeClaims) {
      const cycleId = String(r["cycle_id"]);
      try {
        const info = await fetchInfo(slug, reconcileBranchName(cycleId));
        if (info !== undefined) {
          snapshot.cycleBranchEvidence[cycleId] = {
            state: info.state,
            ...(info.mergedAt !== undefined ? { mergedAtSec: Date.parse(info.mergedAt) / 1000 } : {}),
          };
        }
      } catch {
        /* unresolved probe → unknown */
      }
    }
  }

  // ── FIX-390: load structured deliveries for claim-drift rule ──────────
  snapshot.deliveries = readDeliveries(nodeDeliveryStore, projectPath);

  return { snapshot, skipped };
}

function renderMarkdown(report: AuditReport, skipped: string[], dateTag: string): string {
  const lines: string[] = [
    `# Consistency Audit — ${dateTag}`,
    "",
    `> shadow mode (US-TRUTH-002): 只读、不报警、不拦截。`,
    "",
    `| severity | count |`,
    `|---|---:|`,
    `| fail | ${report.summary.fail} |`,
    `| warn | ${report.summary.warn} |`,
    `| unknown | ${report.summary.unknown} |`,
    `| grandfathered | ${report.summary.grandfathered} |`,
    "",
  ];
  if (report.findings.length > 0) {
    lines.push("| rule | severity | subject | detail |", "|---|---|---|---|");
    for (const f of report.findings) {
      lines.push(`| ${f.rule} | ${f.severity} | ${f.subject} | ${f.detail.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  } else {
    lines.push("No findings. 无漂移发现。", "");
  }
  if (skipped.length > 0) {
    lines.push("## Skipped / 探测上限", "");
    for (const s of skipped) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** `roll release consistency audit [--json]` — always exits 0 on a completed scan. */
export async function consistencyAuditCommand(args: string[], deps: AuditGatherDeps = {}): Promise<number> {
  const json = args.includes("--json");
  const projectPath = process.cwd();
  const rtEnv = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  const runtimeDir = rtEnv !== "" ? rtEnv : join(projectPath, ".roll", "loop");

  const { snapshot, skipped } = await gatherAuditSnapshot(projectPath, runtimeDir, deps);
  const report = runConsistencyAudit(snapshot);

  const nowMs = (deps.nowSec ?? Math.floor(Date.now() / 1000)) * 1000;
  const dateTag = new Date(nowMs).toISOString().slice(0, 10);
  const outDir = join(projectPath, ".roll", "reports", "consistency");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${dateTag}.json`), JSON.stringify({ generatedAt: dateTag, ...report, skipped }, null, 1));
    writeFileSync(join(outDir, `${dateTag}.md`), renderMarkdown(report, skipped, dateTag));
  } catch {
    process.stderr.write("consistency audit: report write failed (scan still completed)\n");
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...report, skipped }, null, 1) + "\n");
  } else {
    process.stdout.write(
      `consistency audit (shadow): fail ${report.summary.fail} · warn ${report.summary.warn} · unknown ${report.summary.unknown} · grandfathered ${report.summary.grandfathered}\n` +
        `一致性审计(影子模式): 报告已写入 ${join(".roll", "reports", "consistency", `${dateTag}.md`)}\n`,
    );
    for (const f of report.findings.filter((x) => x.severity === "fail").slice(0, 10)) {
      process.stdout.write(`  ✗ ${f.rule} ${f.subject} — ${f.detail}\n`);
    }
  }
  return 0; // shadow: drift never flips the exit code (AC5)
}
