/**
 * US-META-001 — `roll index`: (re)generate `.roll/index.json`, the authoritative
 * ID→epic map the archive layout uses to place a card's deliverables under
 * `features/<epic>/<ID>/`. Also regenerates `features/index.html`, redesigned
 * as the Delivery Dossier front page (US-DOSSIER-001a; supersedes the
 * US-META-003 flat table). Deterministic + idempotent.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { CHROME_CONTROLS, CHROME_CSS, CHROME_SCRIPT, bi } from "@roll/core";
import { parseEventLine } from "@roll/spec";
import { buildTruthSnapshot } from "@roll/core";
import { collectDossierState, type CollectorDeps } from "@roll/core";
import { serializeTruthSnapshot, type TruthSnapshotPanelSlot } from "@roll/spec";
import { collectDossier, generateIndex, projectDataPath, projectRuntimePath, type ProjectDataAuthorityMode } from "../lib/archive.js";
import { SPINE_STAGES, countLegacyStories, deriveDeliveryLadder, storySpectrumState, type TruthBoardInput, type TruthBoardVerdict } from "../lib/dossier-index.js";
import type { TruthSnapshotStoryEntry } from "@roll/spec";
import { renderTruthConsole, renderMachineStubPage, type BacklogEpicVM, type BacklogVM, type LoopLiveFeedVM } from "../lib/truth-console.js";
import { renderAgentsMachinePage } from "../lib/page-agents.js";
import { collectCharter, defaultCharterDeps } from "../lib/page-charter.js";
import { collectAbout, defaultAboutDeps, renderAboutPage } from "../lib/page-about.js";
import { collectConventions, defaultConventionsDeps, renderConventionsPage } from "../lib/page-conventions.js";
import { collectProjectsRegistry, resolveProjectName, shouldSelfRegister, writeProjectRow } from "../lib/projects-registry.js";
import type { CycleLedgerRow } from "../lib/cycle-ledger.js";
import { reconciledLedger, cyclesCycleBoard } from "./cycles.js";
import { collectAgentPanel } from "../lib/agent-panel.js";
import { collectExternalTools } from "../lib/external-tools.js";
import { collectReleasePanel } from "../lib/release-panel.js";
import { collectReleaseScope } from "../lib/release-scope.js";
import { reconcileReleaseForProject } from "../lib/release-truth.js";
import { collectSkillsPanel, type SkillsPanelVM } from "../lib/skills-panel.js";
import { renderSkillsPage } from "../lib/page-skills.js"; // US-DOSSIER-032
import { renderToolsPage } from "../lib/page-tools.js"; // US-TOOL-017
import { collectToolPanel } from "../lib/tool-panel.js"; // US-TOOL-016
import { collectLoopHeartbeat, defaultHeartbeatDeps } from "../lib/loop-heartbeat.js";
import { collectCasting, defaultCastingDeps, type CastingVM } from "../lib/casting.js";
import { collectGitHooks, defaultGitHooksDeps, type GitHooksVM } from "../lib/git-hooks.js";
import { launchAgentsDir } from "./loop-sched.js";
import { projectSlug } from "./dashboard.js";
import { formatStream } from "./loop-fmt.js";
import { loopDigestHref } from "../lib/morning-report.js";
import { renderEpicPage } from "../lib/epic-page.js";
import { buildDossierRunCache, collectStoryDossierInput, renderStoryDossier, stationsDone, storyEvidenceFlags, storyHasMergeEvidence, storyHasSpecPrMergeEvidence, type StoryDossierInput } from "../lib/story-dossier.js";
import { renderMarkdown } from "../lib/markdown.js";
import { renderState, stripAnsi } from "../render.js";
import type { CharterVM } from "../lib/page-charter.js";
import { requireWorkspaceAuthorities } from "../lib/workspace-project-authority.js";

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeCycleSignalFiles(cwd: string, rows: readonly CycleLedgerRow[]): void {
  const loopDir = projectRuntimePath(cwd);
  if (!existsSync(loopDir)) return;
  for (const row of rows) {
    const signals = row.signals ?? [];
    if (signals.length === 0) continue;
    writeFileSync(
      join(loopDir, `cycle-${row.cycleId}.signals.jsonl`),
      signals.map((sig) => JSON.stringify(sig)).join("\n") + "\n",
      "utf8",
    );
  }
}

function renderNowSec(): number {
  const v = process.env["ROLL_RENDER_NOW"] ?? "";
  if (v.trim() !== "") {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function latestConsistencyAudit(projectPath: string): TruthBoardInput["audit"] | undefined {
  const dir = projectDataPath(projectPath, "reports", "consistency");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  const latest = files.at(-1);
  if (latest === undefined) return undefined;
  try {
    const obj = JSON.parse(readFileSync(join(dir, latest), "utf8")) as Record<string, unknown>;
    const summary = obj["summary"];
    if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return undefined;
    const rec = summary as Record<string, unknown>;
    const generatedAt = str(obj["generatedAt"]);
    return {
      fail: num(rec["fail"]) ?? 0,
      warn: num(rec["warn"]) ?? 0,
      unknown: num(rec["unknown"]) ?? 0,
      ...(generatedAt !== undefined ? { collectedAt: generatedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * FIX-337 (AC1) — the truth.json `cycle` aggregate is now derived from the SAME
 * canonical reconciled ledger `roll cycles` renders (collectCycleLedger →
 * pending-merge reconcile → superseded reconcile), NOT a second independent pass
 * over raw runs rows. `cyclesCycleBoard` windows to 3d and folds the failed
 * cluster identically to the CLI, so `roll status` (which reads truth.json) and
 * `roll cycles --since 3d` always print the same cycles/failed/cost. The caller
 * passes the rows it already built once (so git facts are collected a single
 * time).
 *
 * US-TRUTH-011 boundary preserved: when there is NO cycle source at all (no
 * `.roll/loop/runs.jsonl`) the aggregate stays UNDEFINED → the board renders
 * "unknown", never a misleading `0`. A runs file that simply has no rows in the
 * 3d window still yields a concrete `cycles3d: 0` (an answered "zero this week",
 * not "unknown").
 */
function cycleTruthBoard(projectPath: string, cycleRows: readonly CycleLedgerRow[], nowSec: number): TruthBoardInput["cycle"] | undefined {
  if (!existsSync(projectRuntimePath(projectPath, "runs.jsonl"))) return undefined;
  const board = cyclesCycleBoard([...cycleRows], nowSec);
  return {
    cycles3d: board.cycles3d,
    failed3d: board.failed3d,
    costUsd3d: board.costUsd3d,
    ...(board.costByCurrency3d !== undefined ? { costByCurrency3d: board.costByCurrency3d } : {}),
    ...(board.latestTsSec > 0 ? { collectedAt: iso(board.latestTsSec) } : {}),
  };
}

function releaseVerdict(v: string | undefined): TruthBoardVerdict {
  if (v === "pass") return "pass";
  if (v === "blocked") return "fail";
  if (v === "waived") return "warn";
  return "unknown";
}

function releaseTruthBoard(projectPath: string, nowSec: number): TruthBoardInput["release"] | undefined {
  // FIX-368: the headline "latest released version" is RECONCILED from reality
  // (newest v* git tag / package version / CHANGELOG top), NOT read from the
  // `release:gate` event cache that the current release flow no longer refreshes.
  const reconciled = reconcileReleaseForProject(projectPath);

  const path = projectRuntimePath(projectPath, "events.ndjson");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    /* no event stream — the gate verdict is unknown, but a tag may still exist */
  }
  let latestGate: { tag?: string; verdict?: string; waivedRules: string[]; ts: number } | undefined;
  const activeWaivers: string[] = [];
  for (const line of content.split("\n")) {
    const ev = parseEventLine(line);
    if (ev === null) continue;
    if (ev.type === "release:gate") {
      latestGate = {
        tag: ev.tag,
        verdict: ev.verdict,
        waivedRules: ev.waivedRules,
        ts: ev.ts,
      };
    } else if (ev.type === "release:waiver" && ev.expiresSec > nowSec) {
      activeWaivers.push(ev.scope);
    }
  }

  // The latest tag is the reconciled truth; fall back to the gate tag only when
  // reconciliation found nothing (e.g. a project with no tags/changelog/version).
  const latestTag = reconciled.latestTag ?? latestGate?.tag;
  if (latestTag === undefined && latestGate === undefined) return undefined;

  // The verdict/waiver apply to the gate event ONLY when it gated the tag we are
  // showing. If the newest tag moved past the last gated tag, the verdict is
  // unknown (we have a fresh release with no recorded gate fact), never stale.
  const matchingGate = latestGate !== undefined && latestGate.tag === latestTag ? latestGate : undefined;
  const waiver = (matchingGate !== undefined ? [...matchingGate.waivedRules, ...activeWaivers] : activeWaivers)
    .filter((x) => x.trim() !== "")
    .join(", ");
  return {
    ...(latestTag !== undefined ? { latestTag } : {}),
    verdict: matchingGate !== undefined ? releaseVerdict(matchingGate.verdict) : "unknown",
    ...(waiver !== "" ? { waiver } : {}),
    ...(matchingGate !== undefined ? { collectedAt: iso(matchingGate.ts) } : {}),
  };
}

function maxCollectedAt(parts: Array<string | undefined>): string | undefined {
  let best = "";
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const p of parts) {
    if (p === undefined || p === "") continue;
    const ms = Date.parse(p);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = p;
      bestMs = ms;
    } else if (!Number.isFinite(ms) && best === "") {
      best = p;
    }
  }
  return best === "" ? undefined : best;
}

function runtimeDir(projectPath: string): string {
  const env = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return env !== "" ? env : projectRuntimePath(projectPath);
}

function tailNonEmptyLines(text: string, limit: number): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return limit > 0 ? lines.slice(-limit) : lines;
}

/** A live.log not written within this many seconds is "idle", not "live" — the
 *  loop is not currently streaming a cycle (FIX-373). A running cycle writes the
 *  log continuously, so 5 minutes of silence means it is not live. */
const LIVE_FEED_FRESH_SEC = 300;

/**
 * FIX-1262 — parse the working agent from a live.log cycle banner
 * (`── cycle <id> · <story> · agent <name> · build-session … ──`). The runner
 * writes this banner at builder spawn, so it is the ONLY honest source of the
 * agent during dossier generation. The old `ROLL_LOOP_AGENT ?? 'claude'` knob
 * is never set on the index-gen path — it fabricated 'claude' on every
 * observation panel regardless of the agent that actually ran. Returns
 * undefined when no banner is present (caller falls back to honest empty).
 */
export function parseLiveFeedAgent(raw: string): string | undefined {
  const m = /^──\s*cycle\s+\S+\s+·\s+\S+\s+·\s+agent\s+(\S+)/m.exec(raw);
  return m?.[1];
}

export function collectLoopLiveFeed(projectPath: string, nowSec = renderNowSec()): LoopLiveFeedVM {
  const livePath = join(runtimeDir(projectPath), "live.log");
  const relativeHref = "../loop/live.log";
  const generatedAt = iso(nowSec);
  if (!existsSync(livePath)) {
    return {
      sourcePath: livePath,
      relativeHref,
      agent: "",
      generatedAt,
      status: "idle",
      rawLineCount: 0,
      renderedLines: [],
      note: "no live.log yet — loop has not emitted a live feed for this project",
    };
  }
  let raw = "";
  let updatedAt = generatedAt;
  let mtimeMs = nowSec * 1000;
  try {
    raw = readFileSync(livePath, "utf8");
    const st = statSync(livePath);
    updatedAt = st.mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
    mtimeMs = st.mtimeMs;
  } catch {
    return {
      sourcePath: livePath,
      relativeHref,
      agent: "",
      generatedAt,
      status: "paused",
      rawLineCount: 0,
      renderedLines: [],
      note: "live.log exists but could not be read",
    };
  }
  // FIX-1262: honest agent from the banner the runner wrote — never the dead
  // ROLL_LOOP_AGENT knob. Absent banner ⇒ empty (formatStream uses the generic
  // normalizer for an unknown agent).
  const agent = parseLiveFeedAgent(raw) ?? "";
  const base = {
    sourcePath: livePath,
    relativeHref,
    agent,
    generatedAt,
  };
  const rawLines = tailNonEmptyLines(raw, 200);
  const prevColor = renderState.useColor;
  renderState.useColor = false;
  try {
    const renderedLines = formatStream(rawLines, agent, { verbose: false, nowMs: nowSec * 1000 })
      .map(stripAnsi)
      .filter((line) => line.trim() !== "")
      .slice(-80);
    // FIX-373: "live" requires the log to be ACTIVELY streaming — written within
    // the freshness window. A log full of old lines from a cycle that ended hours
    // ago is NOT live (that left the Now panel badging a long-finished cycle as
    // "running"); it reads idle, and the last cycle shows under "last run".
    const ageSec = nowSec - Math.floor(mtimeMs / 1000);
    // A future/just-written mtime (ageSec ≤ 0, incl. clock skew) is fresh; only a
    // log untouched for longer than the window is stale.
    const fresh = ageSec <= LIVE_FEED_FRESH_SEC;
    return {
      ...base,
      status: renderedLines.length > 0 && fresh ? "live" : "idle",
      rawLineCount: rawLines.length,
      renderedLines,
      updatedAt,
      ...(renderedLines.length === 0
        ? { note: "live.log has no concise activity signals yet" }
        : !fresh
          ? { note: `last activity ${Math.floor(ageSec / 60)}m ago — loop not currently streaming` }
          : {}),
    };
  } finally {
    renderState.useColor = prevColor;
  }
}

export function collectTruthBoardInput(projectPath: string, nowSec = renderNowSec(), cycleRows?: readonly CycleLedgerRow[]): TruthBoardInput {
  const audit = latestConsistencyAudit(projectPath);
  // FIX-337 (AC1): the cycle aggregate uses the SAME canonical reconciled ledger
  // the page panel + `roll cycles` use. The caller (generateDossierPages) passes
  // the rows it already built; standalone callers fall back to building it here.
  const cycle = cycleTruthBoard(projectPath, cycleRows ?? reconciledLedger(projectPath), nowSec);
  const release = releaseTruthBoard(projectPath, nowSec);
  const collectedAt = maxCollectedAt([audit?.collectedAt, cycle?.collectedAt, release?.collectedAt]);
  return {
    generatedAt: iso(nowSec),
    ...(collectedAt !== undefined ? { collectedAt } : {}),
    ...(audit !== undefined ? { audit } : {}),
    ...(cycle !== undefined ? { cycle } : {}),
    ...(release !== undefined ? { release } : {}),
  };
}

function readyPanel<T>(data: T, nowSec: number): TruthSnapshotPanelSlot<T> {
  return { status: "ready", data, collectedAt: iso(nowSec) };
}

function slotData<T>(slot: TruthSnapshotPanelSlot | undefined, fallback: T): T {
  return slot?.data === null || slot?.data === undefined ? fallback : slot.data as T;
}

function emptySkillsPanel(): SkillsPanelVM {
  return {
    summary: { skills: 0, violations: "unknown", hubLines: 0, auditRan: false },
    groups: [
      { key: "delivery", rows: [] },
      { key: "quality", rows: [] },
      { key: "observe", rows: [] },
      { key: "lifecycle", rows: [] },
    ],
  };
}

function emptyCastingPanel(): CastingVM {
  return { rows: [], execSlots: [], scenarioRoles: [], configured: false };
}

function emptyCharterPanel(): CharterVM {
  return { groups: [] };
}

function emptyGitHooksPanel(cwd: string): GitHooksVM {
  void cwd;
  return { hooksPath: ".git/hooks", configured: false, rows: [] };
}

function pausedLiveFeed(cwd: string, nowSec: number): LoopLiveFeedVM {
  const generatedAt = iso(nowSec);
  const livePath = join(runtimeDir(cwd), "live.log");
  // FIX-1262: even on the collector-failed placeholder, source the agent from
  // the live.log banner when it is readable — never fabricate via the dead
  // ROLL_LOOP_AGENT ?? 'claude' knob. Unreadable/absent ⇒ honest empty.
  let agent = "";
  try {
    if (existsSync(livePath)) agent = parseLiveFeedAgent(readFileSync(livePath, "utf8")) ?? "";
  } catch {
    /* unreadable → honest empty, not a fabricated agent */
  }
  return {
    sourcePath: livePath,
    relativeHref: "../loop/live.log",
    agent,
    status: "paused",
    generatedAt,
    rawLineCount: 0,
    renderedLines: [],
    note: "live feed collector failed",
  };
}

/** US-DOSSIER-004: render a card's spec.md → a self-contained spec.html (the
 *  minimal markdown renderer + dossier chrome), so the "Design doc" link opens
 *  a rendered page, not raw markdown. Returns null when spec.md is absent. */
function renderSpecHtml(storyDir: string, id: string): string | null {
  const specPath = join(storyDir, "spec.md");
  if (!existsSync(specPath)) return null;
  let md: string;
  try {
    md = readFileSync(specPath, "utf8");
  } catch {
    return null;
  }
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${id} · spec</title>\n<style>\n${CHROME_CSS}</style>\n${CHROME_SCRIPT}\n` +
    `</head>\n<body>\n${CHROME_CONTROLS}\n` +
    `<p class="crumb"><a href="index.html">← ${bi("Story Dossier", "故事档案")}</a></p>\n` +
    `<article class="md">\n${renderMarkdown(md)}\n</article>\n` +
    `<footer>Roll · ${bi("rendered from", "渲染自")} <code>spec.md</code></footer>\n</body>\n</html>\n`
  );
}

/** `roll index` — regenerate the backlog-derived ID→epic index + static archive
 *  layers (front page → epic pages → story pages, US-DOSSIER-001d). */
export function indexCommand(
  args: string[],
  deps: { readonly projectPath?: string; readonly authorityMode?: ProjectDataAuthorityMode } = {},
): number {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: roll index [--rebuild]\n" +
        "  Regenerate the selected Workspace index.json + static archive (legacy projects use .roll/index.json).\n" +
        "  Story archive pages are living mount boards: each lifecycle node mounts its own\n" +
        "  facts onto the existing page, so by default an existing story page is left intact.\n" +
        "  --rebuild  force a full re-render of every story page from source (reconciliation:\n" +
        "             derailed/hand-merged or migrated history cards). Overwrites mounted content.\n",
    );
    return 0;
  }
  // US-DOSSIER-007 (AC3): full re-render is the explicit reconciliation tool, not
  // the hot path — by default we never overwrite an existing story page (its
  // incremental mounts would be lost when source can't reconstruct them).
  const rebuild = args.includes("--rebuild");
  const cwd = deps.projectPath ?? process.cwd();
  if (deps.authorityMode === "workspace") {
    const required = [
      { path: join(cwd, "backlog", "index.md"), kind: "file" as const },
      { path: join(cwd, "features"), kind: "directory" as const },
    ];
    if (!requireWorkspaceAuthorities("roll index", required)) return 1;
  }
  const stories = generateIndex(cwd, deps.authorityMode);
  const n = Object.keys(stories).length;
  const indexPath = relative(cwd, projectDataPath(cwd, "index.json")) || "index.json";
  process.stdout.write(`index.json regenerated\n索引已重建\n  ${n} stories mapped to epics (${indexPath})\n`);

  if (existsSync(projectDataPath(cwd, "features"))) {
    const pages = generateDossierPages(cwd, rebuild);
    process.stdout.write(`Static archive regenerated (${pages} pages)\n静态归档已重建（${pages} 页）\n`);
  }

  return 0;
}

/** US-DOSSIER-012: fold the dossier epics into the Backlog tab's view model —
 *  the SAME spectrum classifier the snapshot tally uses, so the counts match
 *  truth.json by construction. */
function backlogViewModel(epics: ReturnType<typeof collectDossier>): BacklogVM {
  const toVM = (e: (typeof epics)[number]): BacklogEpicVM => ({
    name: e.name,
    done: e.delivered,
    total: e.stories.length,
    stories: e.stories.map((s) => ({
      id: s.id,
      epic: s.epic,
      type: s.type,
      title: s.title ?? s.id,
      state: storySpectrumState(s),
      legacy: s.legacy === true,
      stages: [...(s.stages ?? [])],
    })),
  });
  const shipping: BacklogEpicVM[] = [];
  const settled: BacklogEpicVM[] = [];
  for (const e of epics) {
    if (e.stories.length > 0 && e.delivered === e.stories.length) settled.push(toVM(e));
    else shipping.push(toVM(e));
  }
  return { shipping, settled };
}

/**
 * Generate the dossier pages from the live card tree (US-DOSSIER-001a/b/c/d):
 * front page + every epic page always; story pages only when missing (mount
 * board, US-DOSSIER-007) unless `rebuild` forces a full re-render. Per-page
 * best-effort; returns the page count.
 */
export function generateDossierPages(cwd: string, rebuild: boolean): number {
  const featuresDir = projectDataPath(cwd, "features");
  if (!existsSync(featuresDir)) return 0;
  refreshDossierMergeBaseline(cwd);
  // FIX-275: ONE shared facts build for the whole run — git log snapshot,
  // project-wide review-score trend, spec refs + depends-on map (each was
  // previously recomputed per card). FIX-278: built BEFORE collectDossier so the
  // git snapshot can supply offline merge truth to the delivered derivation —
  // the rebuild path has no live PR-evidence snapshot, so a merge commit is what
  // keeps an already-merged card's delivered banner from being stripped.
  const runCache = buildDossierRunCache(cwd);
  const epics = collectDossier(cwd, { mergeEvidence: (id) => storyHasMergeEvidence(runCache.git, id) || storyHasSpecPrMergeEvidence(runCache, id) });
  // US-DOSSIER: enrich each story with its real lifecycle stations (read its
  // evidence via the same collector the per-story page uses) so the index spine
  // reflects definition→design→execution→delivery→retrospective accurately.
  // FIX-275: keep each card's collected input for the render phase below —
  // the same spec.md/ac-map/latest/notes were previously read TWICE per card.
  const inputs = new Map<string, StoryDossierInput>();
  for (const epic of epics) {
    for (const story of epic.stories) {
      try {
        const input = collectStoryDossierInput(cwd, story, runCache);
        inputs.set(`${epic.name}/${story.id}`, input);
        story.stages = [...stationsDone(input)];
      } catch {
        /* best-effort — spine just shows fewer stations */
      }
      // US-DOSSIER-025: attach the on-disk attest evidence flags onto the story
      // model itself (the SAME `storyEvidenceFlags` probe the registry reads, once
      // per card). This is what lets the epic page rows AND the front-page spectrum
      // call the shared `deriveDeliveryLadder(story, story.evidence)` and land on the
      // identical claimed→merged→attested rung the story dossier + truth.json report
      // — instead of the old `merged|cycle|backlog` / `done|wip|todo` dialects that
      // never distinguished merged-but-unattested from merged-and-attested.
      try {
        story.evidence = storyEvidenceFlags(cwd, story);
      } catch {
        /* best-effort — absent flags fall back to the honest `merged` rung */
      }
    }
  }
  // US-DOSSIER-021: the per-story delivery-ladder + evidence registry, built from
  // the SAME epic-sorted/id-sorted `collectDossier` walk so order is deterministic
  // (no Date.now()/Math.random()). The `merged` rung reuses the `delivered` signal
  // collectDossier already folds (truth selector + FIX-278 offline merge truth);
  // we never re-derive merge here. Carried onto the ONE snapshot below.
  // US-DOSSIER-025: the registry's `ladder` and the rendered surfaces now share
  // the SAME `story.evidence` flags + `deriveDeliveryLadder`, so the rung in
  // truth.json equals the rung on the epic row, the front-page spectrum, and the
  // story dossier — one ladder, every surface.
  const storyRegistry: TruthSnapshotStoryEntry[] = epics.flatMap((epic) =>
    epic.stories.map((story) => {
      const evidence = story.evidence ?? storyEvidenceFlags(cwd, story);
      return {
        id: story.id,
        epic: story.epic,
        ladder: deriveDeliveryLadder(story, evidence),
        evidence,
        truthState: storySpectrumState(story),
        ...(story.truthReason !== undefined ? { truthReason: story.truthReason } : {}),
        legacy: story.legacy === true,
      };
    }),
  );
  let pages = 0;
  try {
    // FIX-337 (AC1): build THE canonical reconciled ledger ONCE.
    const cycleRows = reconciledLedger(cwd);
    writeCycleSignalFiles(cwd, cycleRows);

    // US-OBS-016: the ONE read-side selector — wired with full cli collectors
    // for byte-identical output.
    const cliDeps: CollectorDeps = {
      buildRunCache: () => runCache,
      mergeEvidence: (cache, id) => {
        const rc = cache as typeof runCache;
        return storyHasMergeEvidence(rc.git, id) || storyHasSpecPrMergeEvidence(rc, id);
      },
      collectTruthBoard: (_cwd, nowSec) => collectTruthBoardInput(_cwd, nowSec, cycleRows),
      collectLoopHeartbeat: (_cwd) =>
        collectLoopHeartbeat(defaultHeartbeatDeps(_cwd, projectSlug(_cwd), launchAgentsDir())),
      collectEvidenceFlags: (_cwd, story) => storyEvidenceFlags(_cwd, story as Parameters<typeof storyEvidenceFlags>[1]),
      collectProjects: () => collectProjectsRegistry(),
      collectSkillsPanel: (_cwd, nowSec) => readyPanel(collectSkillsPanel(_cwd), nowSec),
      collectCharterPanel: (_cwd, nowSec) => readyPanel(collectCharter(defaultCharterDeps(_cwd, renderMarkdown)), nowSec),
      collectCastingPanel: (_cwd, nowSec) => readyPanel(collectCasting(defaultCastingDeps(_cwd)), nowSec),
      collectGitHooksPanel: (_cwd, nowSec) => readyPanel(collectGitHooks(defaultGitHooksDeps(_cwd)), nowSec),
      collectLiveFeedPanel: (_cwd, nowSec) => readyPanel(collectLoopLiveFeed(_cwd, nowSec), nowSec),
    };
    const snapshot = collectDossierState(cwd, { deps: cliDeps });
    const snapshotJson = serializeTruthSnapshot(snapshot);
    writeFileSync(join(featuresDir, "truth.json"), snapshotJson, "utf8");
    const projectName = resolveProjectName(cwd);
    // US-DOSSIER-028: lift this project's verdict + release tag into the shared
    // cross-project registry (`~/.roll/projects.json`) the web switcher reads.
    // SAME口径 by construction: verdict/releaseTag are taken verbatim from the
    // SAME `snapshot.release` just written to truth.json — never re-derived — so
    // the switcher and the project's own page can never show two values for one
    // number. UPSERT by slug (other projects' rows survive), best-effort: a
    // registry write failure never blocks the board generation.
    // FIX-281/FIX-283: resolve home via `ROLL_HOME ?? homedir()` (the registry
    // default) and skip tmp/non-existent fixture paths so a test/CI `roll index`
    // can never pollute the SHARED `~/.roll/projects.json`. The skip rule now
    // lives in the shared `shouldSelfRegister` (reused by `roll init`).
    // Best-effort throughout.
    try {
      if (shouldSelfRegister(cwd)) {
        const slug = projectSlug(cwd);
        writeProjectRow({
          name: projectName,
          slug,
          path: cwd,
          ...(snapshot.release?.latestTag !== undefined ? { releaseTag: snapshot.release.latestTag } : {}),
          ...(snapshot.release?.verdict !== undefined ? { verdict: snapshot.release.verdict } : {}),
          lastIndexedAt: snapshot.generatedAt,
        });
      }
    } catch {
      /* best-effort — the registry is additive; the board still renders */
    }
    // US-DOSSIER-033: collect the agents panel ONCE — the console reuses it, and
    // the Conventions page derives its in-sync/stale freshness from the SAME rows
    // (one口径 with the agents-on-machine panel, never a second probe).
    const agentRows = collectAgentPanel(cwd);
    // US-DOSSIER-011/043: index.html IS the Truth Console — Now-first project
    // tabs; the legacy ledger lives on under the Backlog tab.
    writeFileSync(
      join(featuresDir, "index.html"),
      renderTruthConsole({
        snapshot,
        snapshotJson,
        brand: {
          name: projectName,
          slogan: process.env["ROLL_BRAND_SLOGAN"] ?? "It just works.",
        },
        backlog: backlogViewModel(epics),
        spineKeys: SPINE_STAGES.map((s) => s.key),
        // FIX-347 → US-DELIV-008: pending_merge/unpublished cycles are reconciled
        // at render time through the SINGLE reconcile engine (cycleReconcileDecision
        // → reconcileDelivery: offline L1 `(#N)`/story evidence + patch-id L2), so a
        // merged cycle shows Done (green) even before the next gh-backfill rewrites
        // its runs row — the SAME judgment `roll loop reconcile` makes.
        // FIX-337 (AC1): the panel reads the SAME canonical reconciled ledger the
        // truth.json `cycle` aggregate + `roll cycles` use (pending-merge AND
        // superseded reconciled) — built once above, never re-derived per surface.
        cycles: cycleRows,
        agents: agentRows,
        releasePanel: collectReleasePanel(cwd),
        skills: slotData(snapshot.panels?.skills, emptySkillsPanel()),
        // US-DOSSIER-033: the Charter project tab — a markdown browser over the
        // project's own charter docs, collected from the real doc tree (docs/*.md,
        // per-epic plan .md files, guide map) and rendered via `renderMarkdown`.
        charter: slotData(snapshot.panels?.charter, emptyCharterPanel()),
        // FIX-284: Casting uses the router slot config; Hooks uses the checkout's
        // configured git hooks path, not loop heartbeat lanes.
        casting: slotData(snapshot.panels?.casting, emptyCastingPanel()),
        gitHooks: slotData(snapshot.panels?.gitHooks, emptyGitHooksPanel(cwd)),
        // US-DOSSIER-044: Now embeds the same read-only live feed source that
        // `roll loop watch` follows. The generated snapshot is folded through
        // loop-fmt's ActivitySignal renderer; browser polling reads only.
        liveFeed: slotData(snapshot.panels?.liveFeed, pausedLiveFeed(cwd, renderNowSec())),
        // FIX-1048: wire the always-on loop digest into the Truth Console.
        loopDigestHref: loopDigestHref(cwd),
        // US-OBS-019: project switcher rows now come from collectDossierState,
        // where the reachable filter runs at the shared read-side selector.
        projects: snapshot.projects,
        currentSlug: projectSlug(cwd),
        // kimi pair-review: the PR links need the repo slug — reuse the
        // FIX-275 git snapshot (one probe per run) instead of a fresh git call.
        ...(runCache.git?.slug !== undefined ? { githubSlug: runCache.git.slug } : {}),
        releaseScope: collectReleaseScope(
          cwd,
          epics.flatMap((e) =>
            e.stories.map((st) => ({
              id: st.id,
              epic: st.epic,
              title: st.title ?? st.id,
              state: storySpectrumState(st),
              ...(st.claim !== undefined ? { claim: st.claim } : {}),
            })),
          ),
        ),
      }),
      "utf8",
    );
    pages += 1;
    // US-DOSSIER-027: emit the four machine-global pages the top-bar breadcrumb
    // routes to (Agents · Skills · Conventions · About). Later stories fill them
    // with real content; today they are stub targets so the links never 404 and
    // already wear the sticky top-bar shell.
    const machineBar = {
      brand: { name: projectName, slogan: process.env["ROLL_BRAND_SLOGAN"] ?? "It just works." },
      snapshot,
      // US-OBS-019: reachable-only via the shared selector, not page-local bake code.
      projects: snapshot.projects,
      currentSlug: projectSlug(cwd),
    };
    // US-DOSSIER-031: the machine-global Agents page — the SAME collectAgentPanel
    // output behind the Loop tab, promoted to a first-class breadcrumb page
    // (machine scope: all installed agents, not just this project's ledger).
    try {
      writeFileSync(
        join(featuresDir, "agents.html"),
        renderAgentsMachinePage({ ...machineBar, agents: collectAgentPanel(cwd), externalTools: collectExternalTools() }),
        "utf8",
      );
      pages += 1;
    } catch {
      /* best-effort */
    }
    const MACHINE_PAGES = [
      ["skills", "skills.html"],
    ] as const;
    for (const [page, file] of MACHINE_PAGES) {
      try {
        // US-DOSSIER-032: the Skills breadcrumb resolves to a real machine-global
        // page (audit strip + grouped skills + SKILL.md viewer), not the stub.
        const html =
          page === "skills"
            ? renderSkillsPage({ ...machineBar, skills: collectSkillsPanel(cwd) })
            : renderMachineStubPage({ ...machineBar, page });
        writeFileSync(join(featuresDir, file), html, "utf8");
        pages += 1;
      } catch {
        /* best-effort */
      }
    }
    // US-TOOL-017: the machine-global Tools page — the built-in tool catalog
    // (collectToolPanel over builtinToolDeclarations) promoted to a first-class
    // breadcrumb page, peer to Agents/Skills. Best-effort like the Agents write.
    try {
      writeFileSync(join(featuresDir, "tools.html"), renderToolsPage({ ...machineBar, tools: collectToolPanel() }), "utf8");
      pages += 1;
    } catch {
      /* best-effort */
    }
    // US-DOSSIER-033: the About + Conventions machine pages are now REAL — About
    // from docs/manifesto.md + docs/architecture.md + guide/INDEX.md + identity;
    // Conventions from conventions/config.yaml sync targets cross-checked against
    // the SAME agents-panel freshness, plus the AGENTS.md rulebook. Both reuse the
    // SKILL.md-style `renderMarkdown` path and the shared machine shell.
    try {
      writeFileSync(
        join(featuresDir, "conventions.html"),
        renderConventionsPage({ ...machineBar, vm: collectConventions(defaultConventionsDeps(cwd, agentRows, renderMarkdown)) }),
        "utf8",
      );
      pages += 1;
    } catch {
      /* best-effort */
    }
    try {
      writeFileSync(
        join(featuresDir, "about.html"),
        renderAboutPage({ ...machineBar, vm: collectAbout(defaultAboutDeps(cwd)) }),
        "utf8",
      );
      pages += 1;
    } catch {
      /* best-effort */
    }
  } catch {
    /* best-effort */
  }
  for (const epic of epics) {
    try {
      writeFileSync(join(featuresDir, epic.name, "index.html"), renderEpicPage(epic), "utf8");
      pages += 1;
    } catch {
      /* best-effort */
    }
    for (const story of epic.stories) {
      const storyDir = join(featuresDir, epic.name, story.id);
      try {
        const storyIndex = join(storyDir, "index.html");
        // Mount board: only (re)render when forced or when the page is missing
        // (a brand-new card needs its initial skeleton).
        if (rebuild || !existsSync(storyIndex)) {
          writeFileSync(
            storyIndex,
            renderStoryDossier(inputs.get(`${epic.name}/${story.id}`) ?? collectStoryDossierInput(cwd, story, runCache)),
            "utf8",
          );
          pages += 1;
        }
        // US-DOSSIER-004: rendered spec.html the "Design doc" link points at.
        const specHtml = renderSpecHtml(storyDir, story.id);
        if (specHtml !== null) {
          writeFileSync(join(storyDir, "spec.html"), specHtml, "utf8");
          pages += 1;
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return pages;
}

function refreshDossierMergeBaseline(cwd: string): void {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
    execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
  } catch {
    return;
  }
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "+main:refs/remotes/origin/main"], { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 });
  } catch (e) {
    process.stderr.write(`[roll] WARN dossier git fetch failed; falling back to local HEAD: ${String(e)}\n`);
  }
}

/**
 * FIX-231: truth-changing nodes (story new / attest / backlog set-status) call
 * this to keep the board's AGGREGATE pages fresh — front + epic pages follow
 * every state change instead of waiting for a manual `roll index`. Story pages
 * stay mount boards (only missing ones get a skeleton; mounted content is never
 * clobbered — US-DOSSIER-007). Best-effort by contract: a refresh failure WARNs
 * and never blocks the caller's main path.
 */
export function refreshAggregates(cwd: string): void {
  try {
    generateDossierPages(cwd, false);
  } catch (e) {
    process.stderr.write(`[roll] WARN dossier refresh failed (board may lag until \`roll index\`): ${String(e)}\n`);
  }
}
