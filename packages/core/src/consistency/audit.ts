/**
 * US-TRUTH-002 — Shadow Consistency Audit (pure rules over snapshots).
 *
 * Quantifies real drift between the fact sources declared in US-TRUTH-000's
 * anchor registry (spec types/truth.ts) BEFORE anyone fixes by vibes:
 * backlog rows vs PR merge evidence, runs terminals vs cycle-branch PRs,
 * Done rows vs attest artifacts, delivered rows vs usage/cost, index vs live
 * cards, section counters vs each other, and the US-TRUTH-001 terminal twin.
 *
 * SHADOW contract: pure decisions only — no I/O, no ALERT, no status writes,
 * and the caller's exit code must not depend on drift. Severities:
 *
 *   fail          — an anchor violation past its grace window
 *   warn          — a derived view lagging or a softer obligation missed
 *   unknown       — evidence unavailable (gh down) or within convergence grace
 *   grandfathered — predates the schema epoch / pre-card era; listed, not red
 *
 * The cli gatherer (`roll consistency audit`) assembles the snapshot; rules
 * here never read the filesystem, git, or GitHub (US-TRUTH-002 AC5, and the
 * same purity bar US-TRUTH-003's selectors inherit).
 */
import { DEFAULT_GRACE_WINDOW_SEC } from "@roll/spec";
import type { DeliveryRecord } from "@roll/spec";
import { queryStoryDelivery, deriveBacklogStatus, type StoryDeliveryTruth } from "../truth/query.js";

export interface WorkspaceContextAuditGateSnapshot {
  readonly violations: number;
  readonly scannedSurfaces: number;
  readonly allowlisted: number;
}

/** Pure release-gate projection for the US-WS-039 static authority audit. */
export function workspaceContextAuditReleaseGap(snapshot: WorkspaceContextAuditGateSnapshot): string | null {
  if (snapshot.violations === 0) return null;
  return `Workspace context audit reports ${snapshot.violations} violation(s) across ${snapshot.scannedSurfaces} registered surface file(s) (${snapshot.allowlisted} governed exception(s))`;
}

/** PR/merge evidence as the gatherer resolved it; absence in the map = probe
 *  did not resolve (→ unknown, never fail). */
export interface AuditPrEvidence {
  state: string;
  mergedAtSec?: number;
}

export interface AuditBacklogRow {
  id: string;
  /** The raw status cell (marker + annotations, e.g. "✅ Done · PR#10"). */
  status: string;
}

/** Attest artifact existence per story, as probed by the gatherer. A story
 *  absent from the map was NOT probed (pre-card era → grandfather lane). */
export interface AuditAttestProbe {
  report: boolean;
  acMap: boolean;
  visualEvidence?: boolean;
  machineSkip?: boolean;
  /** FIX-933: true when the story's ACs carry no visual-evidence item at all
   *  (pure back-end card). When true, the done-attest-no-visual rule is
   *  skipped — a card with no visual surface legitimately has no screenshots. */
  noVisualSurface?: boolean;
}

export interface AuditSnapshot {
  /** Audit wall-clock (epoch seconds) — injected, never Date.now() here. */
  nowSec: number;
  /** US-TRUTH-001 schema epoch: rows/cycles before it are grandfathered. */
  schemaEpochSec: number;
  /** Convergence grace (seconds); default from the anchor registry. */
  graceSec: number;
  backlog: AuditBacklogRow[];
  /** .roll/index.json story→epic map. */
  index: Record<string, string>;
  /** runs.jsonl rows, parsed leniently (opaque records). */
  runs: Array<Record<string, unknown>>;
  /** cycle ids that have a cycle:terminal event (US-TRUTH-001 twin). */
  terminalCycleIds: string[];
  /** story id → delivery-PR evidence (parsed from the Done row's PR#N). */
  prEvidence: Record<string, AuditPrEvidence>;
  /** cycle id → cycle-branch PR evidence (loop/cycle-<id>). */
  cycleBranchEvidence: Record<string, AuditPrEvidence>;
  /** story id → attest artifact probe. */
  attest: Record<string, AuditAttestProbe>;
  /** failure counts computed over the SAME window by the two bookkeepers. */
  runsFailedCount?: number;
  eventFailedCount?: number;
  /** Local publish-line drift: commits on main that have not reached origin/main. */
  localMainAhead?: number;
  /** US-TRUTH-018 — structured delivery records from deliveries.jsonl.
   *  When absent, the claim-drift rule is silently skipped. */
  deliveries?: readonly DeliveryRecord[];
}

export type AuditSeverity = "fail" | "warn" | "unknown" | "grandfathered";

export interface AuditFinding {
  rule: string;
  severity: AuditSeverity;
  /** The drifting subject — a story id, cycle id, or counter name. */
  subject: string;
  detail: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  summary: Record<AuditSeverity, number>;
}

/** A blank snapshot — tests and gatherers start here. */
export function emptyAuditSnapshot(nowSec: number, schemaEpochSec: number): AuditSnapshot {
  return {
    nowSec,
    schemaEpochSec,
    graceSec: DEFAULT_GRACE_WINDOW_SEC,
    backlog: [],
    index: {},
    runs: [],
    terminalCycleIds: [],
    prEvidence: {},
    cycleBranchEvidence: {},
    attest: {},
  };
}

const DONE_MARK = "✅";
/** Claim-shaped run statuses the backfill is responsible for (FIX-243/244). */
const CLAIM_STATUSES = new Set(["built", "published", "failed"]);
const DELIVERED_OUTCOMES = new Set(["delivered"]);

function rowStr(row: Record<string, unknown>, k: string): string {
  const v = row[k];
  return typeof v === "string" ? v : "";
}

function rowTsSec(row: Record<string, unknown>): number | null {
  const ts = rowStr(row, "ts");
  if (ts === "") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Run every audit rule over the snapshot. Never throws; malformed rows skip. */
export function runConsistencyAudit(s: AuditSnapshot): AuditReport {
  const findings: AuditFinding[] = [];
  const add = (rule: string, severity: AuditSeverity, subject: string, detail: string): void => {
    findings.push({ rule, severity, subject, detail });
  };

  // ── local-main-ahead: local main must never be a publish endpoint ─────────
  if ((s.localMainAhead ?? 0) > 0) {
    add(
      "local-main-ahead",
      "fail",
      "main",
      `local main is ahead of origin/main by ${s.localMainAhead} commit(s) with no PR-backed publish evidence — local main is not a delivery endpoint (FIX-252)`,
    );
  }

  // ── done-no-merge: a ✅ Done backlog row must have MERGED PR evidence ──────
  for (const row of s.backlog) {
    if (!row.status.includes(DONE_MARK)) continue;
    const hasPrAnnotation = /PR#\d+/.test(row.status);
    const ev = s.prEvidence[row.id];
    if (ev === undefined) {
      if (hasPrAnnotation) {
        add("done-no-merge", "unknown", row.id, `Done row carries ${/PR#\d+/.exec(row.status)?.[0] ?? "a PR"} but merge evidence could not be probed`);
      } else {
        add("done-no-merge", "grandfathered", row.id, "Done row predates PR-annotated delivery (pre-card era) — listed, not judged");
      }
      continue;
    }
    if (ev.state !== "MERGED") {
      add("done-no-merge", "fail", row.id, `backlog says Done but the delivery PR is ${ev.state} — backlog 是愿望, main 是真相 (story_delivery anchor)`);
    }
  }

  // ── merge-not-backfilled: claim-shaped run rows with MERGED branch PRs ─────
  for (const row of s.runs) {
    const cycleId = rowStr(row, "cycle_id");
    const status = rowStr(row, "status");
    if (cycleId === "" || !CLAIM_STATUSES.has(status)) continue;
    if (typeof row["merge_commit"] === "string" && row["merge_commit"] !== "") continue; // already credited
    const ev = s.cycleBranchEvidence[cycleId];
    if (ev === undefined || ev.state !== "MERGED") continue;
    const mergedAt = ev.mergedAtSec ?? 0;
    const withinGrace = s.nowSec - mergedAt < s.graceSec;
    add(
      "merge-not-backfilled",
      withinGrace ? "unknown" : "fail",
      cycleId,
      withinGrace
        ? `branch PR merged ${Math.round(s.nowSec - mergedAt)}s ago — within the ${s.graceSec}s convergence window`
        : `runs row still '${status}' although the cycle-branch PR merged — the 212711 incident shape (cycle_outcome anchor)`,
    );
  }

  // ── done-missing-attest: Done story owes acceptance evidence ───────────────
  for (const row of s.backlog) {
    if (!row.status.includes(DONE_MARK)) continue;
    const probe = s.attest[row.id];
    if (probe === undefined) {
      if (/PR#\d+/.test(row.status)) continue; // probed set is the gatherer's choice; un-probed annotated rows stay silent
      add("done-missing-attest", "grandfathered", row.id, "pre-card-era Done row — no card folder to probe");
      continue;
    }
    if (!probe.report) {
      add("done-missing-attest", "fail", row.id, `Done without an acceptance report${probe.acMap ? "" : " (no ac-map either)"} — attest_evidence anchor`);
    } else if (probe.acMap && !(probe.visualEvidence ?? false) && !(probe.machineSkip ?? false) && !(probe.noVisualSurface ?? false)) {
      // FIX-270: owner-decreed iron rule — screenshot evidence (or an honestly
      // recorded machine capture skip) is a RELEASE BLOCKER, not advice. The
      // only bypass is a recorded owner waiver.
      // FIX-933: a pure back-end card with no visual-evidence AC has no surface
      // to capture — it legitimately carries no screenshots. The gate is skipped
      // for these cards (noVisualSurface=true).
      add(
        "done-attest-no-visual",
        "fail",
        row.id,
        "Done acceptance evidence has a report/ac-map but no screenshot and no machine-generated capture skip — screenshot iron rule (FIX-270)",
      );
    }
  }

  // ── usage-missing: delivered work must carry cost or an absent reason ─────
  for (const row of s.runs) {
    const cycleId = rowStr(row, "cycle_id");
    if (cycleId === "") continue;
    const outcome = rowStr(row, "outcome");
    if (!DELIVERED_OUTCOMES.has(outcome)) continue;
    if (typeof row["cost_usd"] === "number") continue;
    const ts = rowTsSec(row);
    const pre = ts !== null && ts < s.schemaEpochSec;
    add(
      "usage-missing",
      pre ? "grandfathered" : "warn",
      cycleId,
      pre
        ? "delivered before the cost-capture epoch (FIX-249) — listed, not judged"
        : "delivered with no cost/usage fields — the cost-blind-guardrail shape (usage_cost anchor)",
    );
  }

  // ── index-missing-live-card ────────────────────────────────────────────────
  for (const row of s.backlog) {
    if (s.index[row.id] === undefined) {
      add("index-missing-live-card", "warn", row.id, "live backlog row missing from .roll/index.json — regenerate (index_freshness anchor)");
    }
  }

  // ── failure-count-mismatch: two bookkeepers, one window ──────────────────
  if (s.runsFailedCount !== undefined && s.eventFailedCount !== undefined && s.runsFailedCount !== s.eventFailedCount) {
    add(
      "failure-count-mismatch",
      "warn",
      "failed-count",
      `runs.jsonl counts ${s.runsFailedCount} failed; events count ${s.eventFailedCount} over the same window — the 0-vs-14 panel shape (FIX-248)`,
    );
  }

  // ── terminal-twin-missing: US-TRUTH-001 write obligation ──────────────────
  const twins = new Set(s.terminalCycleIds);
  for (const row of s.runs) {
    const cycleId = rowStr(row, "cycle_id");
    if (cycleId === "" || twins.has(cycleId)) continue;
    const ts = rowTsSec(row);
    const pre = ts !== null && ts < s.schemaEpochSec;
    add(
      "terminal-twin-missing",
      pre ? "grandfathered" : "warn",
      cycleId,
      pre ? "cycle predates the terminal-event schema — grandfathered" : "post-epoch cycle wrote no cycle:terminal twin (US-TRUTH-001 AC5)",
    );
  }

  // ── claim-drift: backlog status ↔ structured delivery truth (bidirectional) ─
  // FIX-390: runs bidirectionally — backlog→truth AND truth→backlog.
  // Only runs when structured delivery records are available; silently skipped
  // otherwise (backlog status is the fallback truth when deliveries don't exist).
  if (s.deliveries && s.deliveries.length > 0) {
    const backlogById = new Map<string, typeof s.backlog[number]>();
    for (const row of s.backlog) backlogById.set(row.id, row);

    // Stories already covered by a forward finding — reverse lane skips them.
    const driftReported = new Set<string>();

    // ── Forward: every backlog row vs structured truth ─────────────────────
    for (const row of s.backlog) {
      const truth = queryStoryDelivery(row.id, s.deliveries);
      // If no records exist for this story, the backlog status is the only
      // known truth — nothing to drift from.
      if (truth.lifecycleState === "todo" && truth.lastRecordedAt === 0) continue;

      const derivedStatus = deriveBacklogStatus(truth);
      // Normalize: strip annotation suffixes from the backlog status when
      // comparing (e.g. "✅ Done · evidence(link)" should still match "✅ Done").
      const normalizedClaim = row.status.replace(/\s*·.*$/, "").trim();
      const normalizedDerived = derivedStatus.replace(/\s*·.*$/, "").trim();

      if (normalizedClaim === normalizedDerived) continue;

      driftReported.add(row.id);

      // Severity: Done claim without merge truth → fail (premature Done).
      // Other mismatches → warn (lagging derived view).
      const claimedDone = normalizedClaim.includes("✅");
      const truthDelivered = truth.delivered;

      if (claimedDone && !truthDelivered) {
        add(
          "claim-drift",
          "fail",
          row.id,
          `backlog claims \`${row.status}\` but structured truth says lifecycle=${truth.lifecycleState} delivered=${truth.delivered} — derived status should be \`${derivedStatus}\``,
        );
      } else {
        add(
          "claim-drift",
          "warn",
          row.id,
          `backlog shows \`${row.status}\` but structured truth derives \`${derivedStatus}\` (lifecycle=${truth.lifecycleState} delivered=${truth.delivered})`,
        );
      }
    }

    // ── Reverse (FIX-390 AC2): deliveries done → backlog not Done ─────────
    const seenDelivered = new Set<string>();
    for (const d of s.deliveries) {
      if (d.lifecycleState !== "done") continue;
      if (seenDelivered.has(d.storyId)) continue;
      seenDelivered.add(d.storyId);
      if (driftReported.has(d.storyId)) continue; // already in forward findings

      const row = backlogById.get(d.storyId);
      if (row === undefined) {
        // Story is done in projection but missing from backlog entirely.
        add(
          "claim-drift",
          "warn",
          d.storyId,
          `structured truth says done (cycle=${d.cycleId}) but the story is absent from backlog.md — backlog is missing a delivered row`,
        );
      } else if (!row.status.includes(DONE_MARK)) {
        // Story is done in projection but backlog row says otherwise.
        add(
          "claim-drift",
          "warn",
          d.storyId,
          `structured truth says done (cycle=${d.cycleId}) but backlog shows \`${row.status}\` — backlog row lags the merge truth`,
        );
      }
    }
  }

  const summary: Record<AuditSeverity, number> = { fail: 0, warn: 0, unknown: 0, grandfathered: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return { findings, summary };
}

// ── claim-drift correction (US-TRUTH-018 AC2) ──────────────────────────────

/**
 * Given a backlog row's current status and the structured delivery truth,
 * return the derived (correct) status cell string.
 *
 * US-TRUTH-018 AC2: "修派生视图:把 backlog 状态格刷新成与结构化真相一致的派生显示;
 * 人写的 intent 字段(标题/优先级)不动。"
 *
 * This is a pure derivation — it does NOT modify the markdown file. The caller
 * is responsible for writing the corrected row back via {@link BacklogStore}.
 *
 * @param storyId - The story identifier.
 * @param currentStatus - The current backlog status cell (e.g. "📋 Todo").
 * @param deliveries - All structured delivery records.
 * @returns `null` when the current status already matches the derived truth
 *   (no drift), or the corrected status string when drift is detected.
 */
export function correctBacklogStatus(
  storyId: string,
  currentStatus: string,
  deliveries: readonly DeliveryRecord[],
): string | null {
  const truth = queryStoryDelivery(storyId, deliveries);
  // If no records exist for this story, the backlog is the only truth — nothing to correct.
  if (truth.lifecycleState === "todo" && truth.lastRecordedAt === 0) return null;

  const derivedStatus = deriveBacklogStatus(truth);
  // Normalize: strip annotation suffixes (· evidence, · PR#N, etc.) when comparing.
  const normalizedClaim = currentStatus.replace(/\s*·.*$/, "").trim();
  const normalizedDerived = derivedStatus.replace(/\s*·.*$/, "").trim();

  if (normalizedClaim === normalizedDerived) return null;
  return derivedStatus;
}

// ── US-DOSSIER-015: the six-dimension split of the gate audit ────────────────

/** The reconciled release-gate dimensions. */
export type ConsistencyDimension = "code-backlog" | "cards" | "docs" | "tests" | "bilingual" | "site" | "truth-live";
export const CONSISTENCY_DIMENSIONS: readonly ConsistencyDimension[] = [
  "code-backlog",
  "cards",
  "docs",
  "tests",
  "bilingual",
  "site",
  "truth-live",
];

/**
 * US-DOSSIER-022 — the ONE labeled dimension table both surfaces read.
 *
 * The web six-dimension panel (truth-console DIM_META) and the `roll release`
 * gate report (release-consistency) must show the SAME six names in the SAME
 * order so the same f/w/? reconcile across faces (Delivery Dossier ruling #3:
 * 各面同口径). `no` is the panel's ①…⑦ glyph; `en`/`zh` are the bilingual
 * label (rendered side-by-side in HTML via bi(), on separate lines in the CLI
 * plaintext report — never inline-mixed). `whatEn`/`whatZh` is the one-line
 * "what this dimension reconciles" caption the web panel shows.
 *
 * FIX-372: the panel must EXPLAIN ITSELF — so each dimension also carries
 * `failMeansEn`/`failMeansZh` ("what a failure here means") and `actionEn`/
 * `actionZh` ("the single command/step to clear it"). The web Release widget
 * surfaces these on a failing dimension; an all-pass panel collapses to one
 * calm line. The gate ENFORCEMENT is unchanged — this is display copy only.
 */
export interface ConsistencyDimensionLabel {
  no: string;
  en: string;
  zh: string;
  whatEn: string;
  whatZh: string;
  /** What a failure in this dimension means, in plain language. */
  failMeansEn: string;
  failMeansZh: string;
  /** The single action to clear a failure in this dimension. */
  actionEn: string;
  actionZh: string;
}
export const CONSISTENCY_DIMENSION_LABELS: Record<ConsistencyDimension, ConsistencyDimensionLabel> = {
  "code-backlog": {
    no: "①",
    en: "code ↔ backlog",
    zh: "代码↔待办",
    whatEn: "Done claims vs merge & cycle facts",
    whatZh: "Done 声明对合并与周期事实",
    failMeansEn: "a card says Done but git/cycle facts don't back it (premature Done)",
    failMeansZh: "卡片声明 Done，但 git/周期事实不支持（提前翻牌）",
    actionEn: "open the named card; either land the merge or revert its Done status",
    actionZh: "打开标注的卡片；要么合并交付，要么撤回 Done 状态",
  },
  cards: {
    no: "②",
    en: "cards / evidence",
    zh: "卡片/证据",
    whatEn: "every row owns its card; evidence never dangles",
    whatZh: "每行有卡，证据链接不悬空",
    failMeansEn: "a Done row is missing its card, attest, or screenshot evidence",
    failMeansZh: "Done 行缺卡片、attest 或截图证据",
    actionEn: "run `roll attest backfill` to attach the missing evidence, then re-audit",
    actionZh: "运行 `roll attest backfill` 补齐证据，再重审",
  },
  docs: {
    no: "③",
    en: "docs",
    zh: "文档",
    whatEn: "changelog / guide / README / --help",
    whatZh: "changelog/guide/README/--help",
    failMeansEn: "shipped behavior isn't reflected in changelog / guide / README / --help",
    failMeansZh: "已交付行为没体现在 changelog/指南/README/--help",
    actionEn: "update the doc the finding names (a closing doc-update card), then re-audit",
    actionZh: "更新所标注的文档（收尾的文档更新卡），再重审",
  },
  tests: {
    no: "④",
    en: "tests",
    zh: "测试",
    whatEn: "suites green, coverage honest",
    whatZh: "套件全绿，覆盖诚实",
    failMeansEn: "a suite is red or new behavior shipped without a test",
    failMeansZh: "有套件未通过，或新行为没有测试",
    actionEn: "run `roll test` locally; fix the red suite or add the missing test",
    actionZh: "本地跑 `roll test`；修复红套件或补上缺失测试",
  },
  bilingual: {
    no: "⑤",
    en: "bilingual",
    zh: "双语",
    whatEn: "guide en↔zh + i18n keys in parity",
    whatZh: "指南中英与 i18n key 对齐",
    failMeansEn: "the English and Chinese guide / i18n keys have drifted out of parity",
    failMeansZh: "英文与中文指南 / i18n key 不对齐",
    actionEn: "add the missing en or zh counterpart so both languages match",
    actionZh: "补上缺失的中英对照，使两种语言对齐",
  },
  site: {
    no: "⑥",
    en: "site",
    zh: "站点",
    whatEn: "published site matches the repo",
    whatZh: "站点与仓库一致",
    failMeansEn: "the published site is stale — it doesn't match the repo",
    failMeansZh: "已发布站点过期——与仓库不一致",
    actionEn: "regenerate and republish the site so it matches the repo",
    actionZh: "重新生成并发布站点，使其与仓库一致",
  },
  "truth-live": {
    no: "⑦",
    en: "truth live",
    zh: "真相活体",
    whatEn: "release-delta stories resolve through structured delivery truth",
    whatZh: "发布增量故事经结构化交付真相裁定",
    failMeansEn: "a merged release-delta story is not backed by queryStoryDelivery()",
    failMeansZh: "发布增量里的已合故事没有被 queryStoryDelivery() 支撑",
    actionEn: "run `roll truth query <id>`; fix the Done row or merge/story-id evidence",
    actionZh: "运行 `roll truth query <id>`；修正 Done 行或合并/story-id 证据",
  },
};

/**
 * Map an audit rule to its dimension. TOTAL by construction: an unknown rule
 * lands in ① code-backlog (the claims dimension) rather than vanishing — the
 * panel's per-dimension sum must STRICTLY equal the status line's f/w/?
 * (US-DOSSIER-015 AC2), so no finding may be unmapped.
 */
export function dimensionOfRule(rule: string): ConsistencyDimension {
  switch (rule) {
    case "claim-drift":
    case "done-no-merge":
    case "terminal-twin-missing":
    case "usage-missing":
    case "failure-count-mismatch":
      return "code-backlog";
    case "done-missing-attest":
    case "done-missing-screenshot":
    case "index-missing-live-card":
      return "cards";
    case "doc-gap":
    case "registry-drift":
      return "docs";
    case "test-gap":
      return "tests";
    case "bilingual-parity":
      return "bilingual";
    case "site-drift":
      return "site";
    case "truth-live":
      return "truth-live";
    default:
      return "code-backlog";
  }
}

export interface DimensionTally {
  fail: number;
  warn: number;
  unknown: number;
  /** Up to three finding subjects (drift-card handles) for drill-down chips. */
  subjects: string[];
}

/**
 * Fold findings into per-dimension tallies. Grandfathered findings are listed
 * elsewhere, never judged — they stay OUT of f/w/? (same contract as the
 * summary line), so the six rows sum exactly to the status line.
 */
export function tallyByDimension(findings: readonly AuditFinding[]): Record<ConsistencyDimension, DimensionTally> {
  const out = Object.fromEntries(
    CONSISTENCY_DIMENSIONS.map((d) => [d, { fail: 0, warn: 0, unknown: 0, subjects: [] as string[] }]),
  ) as Record<ConsistencyDimension, DimensionTally>;
  for (const f of findings) {
    if (f.severity === "grandfathered") continue;
    const dim = out[dimensionOfRule(f.rule)];
    if (f.severity === "fail") dim.fail += 1;
    else if (f.severity === "warn") dim.warn += 1;
    else dim.unknown += 1;
    if (dim.subjects.length < 3 && !dim.subjects.includes(f.subject)) dim.subjects.push(f.subject);
  }
  return out;
}
