/**
 * @responsibility Consolidates the dossier collectors into one truth snapshot.
 * US-OBS-016 — collectDossierState: the ONE read-side selector that consolidates
 * the ~18 collectors into a single TruthSnapshot. All data routing goes through
 * truth-adapter selectors; no new bespoke parsers.
 *
 * Architecture: the selector is PURE composition. I/O is injected via the
 * optional CollectorDeps parameter. When deps are omitted, a default
 * best-effort implementation (using node:fs directly) is used — suitable for
 * static archive rendering and tests. The CLI wires the full reconciled collectors for
 * byte-identical output.
 */
import type { StoryEvidenceFlags, TruthSnapshot, TruthSnapshotLoop, TruthSnapshotOnDeck, TruthSnapshotPanelSlot, TruthSnapshotPanels, TruthSnapshotProject, TruthSnapshotStoryEntry } from "@roll/spec";
import { classifyStatus } from "@roll/spec";
import { buildTruthSnapshot } from "./selectors.js";
import { collectDossier } from "./dossier-collect.js";
import { parseBacklog } from "../backlog/store.js";
import { isRealProjectPath, reachableProjects } from "../projects/reachability.js";
import {
  deriveDeliveryLadder,
  countLegacyStories,
  storySpectrumState,
  NO_EVIDENCE,
  type TruthBoardInput,
} from "./dossier-ladder.js";

// ── Collector dependency signatures ─────────────────────────────────────────

/** Build the dossier run cache (git facts snapshot) — returns opaque token. */
export type BuildDossierRunCache = (cwd: string) => unknown;

/** Check merge evidence via git. */
export type MergeEvidenceFn = (runCache: unknown, id: string) => boolean;

/** Collect the truth board (audit + cycle + release). */
export type CollectTruthBoardFn = (cwd: string, nowSec: number) => TruthBoardInput;

/** Collect the loop heartbeat. */
export type CollectLoopHeartbeatFn = (cwd: string, nowSec: number) => TruthSnapshotLoop;

/** Probe on-disk evidence flags for one story. */
export type CollectEvidenceFlagsFn = (cwd: string, story: { id: string; epic: string }) => StoryEvidenceFlags;

/** Collect reachable project switcher rows from the shared registry. */
export type CollectProjectsFn = (cwd: string) => readonly TruthSnapshotProject[];

/** Collect one dossier panel into a TruthSnapshot envelope. */
export type CollectPanelFn = (cwd: string, nowSec: number) => TruthSnapshotPanelSlot;

/** All injectable collectors. Omit to use the default best-effort implementation. */
export interface CollectorDeps {
  buildRunCache?: BuildDossierRunCache;
  mergeEvidence?: MergeEvidenceFn;
  collectTruthBoard?: CollectTruthBoardFn;
  collectLoopHeartbeat?: CollectLoopHeartbeatFn;
  collectEvidenceFlags?: CollectEvidenceFlagsFn;
  collectProjects?: CollectProjectsFn;
  collectCastingPanel?: CollectPanelFn;
  collectCharterPanel?: CollectPanelFn;
  collectSkillsPanel?: CollectPanelFn;
  collectGitHooksPanel?: CollectPanelFn;
  collectLiveFeedPanel?: CollectPanelFn;
}

// ── Default best-effort collectors (node:fs only, no git/launchd) ────────────

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEventLine } from "@roll/spec";

function renderNowSec(): number {
  const v = process.env["ROLL_RENDER_NOW"] ?? "";
  if (v.trim() !== "") {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function maxCollectedAt(parts: Array<string | undefined>): string | undefined {
  let best = "";
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const p of parts) {
    if (p === undefined || p === "") continue;
    const ms = Date.parse(p);
    if (Number.isFinite(ms) && ms > bestMs) { best = p; bestMs = ms; }
    else if (!Number.isFinite(ms) && best === "") { best = p; }
  }
  return best === "" ? undefined : best;
}

function defaultCollectTruthBoard(cwd: string, nowSec: number): TruthBoardInput {
  // Audit
  let audit: TruthBoardInput["audit"];
  try {
    const dir = join(cwd, ".roll", "reports", "consistency");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    const latest = files.at(-1);
    if (latest !== undefined) {
      const obj = JSON.parse(readFileSync(join(dir, latest), "utf8")) as Record<string, unknown>;
      const summary = obj["summary"];
      if (typeof summary === "object" && summary !== null && !Array.isArray(summary)) {
        const rec = summary as Record<string, unknown>;
        audit = {
          fail: num(rec["fail"]) ?? 0,
          warn: num(rec["warn"]) ?? 0,
          unknown: num(rec["unknown"]) ?? 0,
          ...(str(obj["generatedAt"]) !== undefined ? { collectedAt: str(obj["generatedAt"])! } : {}),
        };
      }
    }
  } catch { /* no audit */ }

  // Cycle (best-effort from runs, no reconciled ledger)
  let cycle: TruthBoardInput["cycle"];
  try {
    const runsPath = join(cwd, ".roll", "loop", "runs.jsonl");
    if (existsSync(runsPath)) {
      let cycles3d = 0, failed3d = 0, latestTsSec = 0;
      let costUsd3d = 0;
      const costByCurrency: Record<string, number> = {};
      // US-TRUTH-019: read all rows, then last-wins by (story_id, cycle_id)
      // before counting — append-only can produce duplicate keys.
      const allRows: Record<string, unknown>[] = [];
      for (const line of readFileSync(runsPath, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try { allRows.push(JSON.parse(line) as Record<string, unknown>); }
        catch { /* skip */ }
      }
      const lastWins = new Map<string, Record<string, unknown>>();
      for (const row of allRows) {
        const sid = str(row["story_id"]);
        const cid = str(row["cycle_id"] ?? row["cycleId"]);
        if (sid !== "" && cid !== "") lastWins.set(`${sid}\t${cid}`, row);
        // unkeyed rows are silently dropped from the 3d count (they lack
        // the fields needed to dedupe them anyway).
      }
      for (const row of lastWins.values()) {
        const ts = str(row["ts"]);
        if (ts === undefined) continue;
        const sec = Date.parse(ts) / 1000;
        if (!Number.isFinite(sec) || nowSec - sec > 3 * 24 * 3600) continue;
        cycles3d++;
        if (sec > latestTsSec) latestTsSec = sec;
        const stat = str(row["status"]) ?? "";
        const out = str(row["outcome"]) ?? "";
        if (stat === "failed" || stat === "reverted" || out === "failed" || out === "blocked" || out === "aborted_no_delivery") failed3d++;
        const usd = num(row["cost_usd"]);
        if (usd !== undefined && usd > 0) costUsd3d += usd;
        const cur = str(row["cost_currency"]), amt = num(row["cost_amount"]);
        if (cur !== undefined && amt !== undefined && amt > 0) costByCurrency[cur] = (costByCurrency[cur] ?? 0) + amt;
      }
      cycle = {
        cycles3d, failed3d,
        costUsd3d: Math.round(costUsd3d * 100) / 100,
        ...(Object.keys(costByCurrency).length > 0 ? { costByCurrency3d: costByCurrency } : {}),
        ...(latestTsSec > 0 ? { collectedAt: iso(latestTsSec) } : {}),
      };
    }
  } catch { /* no cycle data */ }

  // Release (best-effort from events + git tags)
  let release: TruthBoardInput["release"];
  try {
    const evPath = join(cwd, ".roll", "loop", "events.ndjson");
    let content = "";
    try { content = readFileSync(evPath, "utf8"); } catch { /* no events */ }
    let latestGate: { tag?: string; verdict?: string; waivedRules: string[]; ts: number } | undefined;
    const activeWaivers: string[] = [];
    for (const line of content.split("\n")) {
      const ev = parseEventLine(line);
      if (ev === null) continue;
      if (ev.type === "release:gate") latestGate = { tag: ev.tag, verdict: ev.verdict, waivedRules: ev.waivedRules, ts: ev.ts };
      else if (ev.type === "release:waiver" && ev.expiresSec > nowSec) activeWaivers.push(ev.scope);
    }
    let latestTag: string | undefined;
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
      const tags = execFileSync("git", ["tag", "--sort=-version:refname"], { cwd, stdio: ["pipe", "ignore", "pipe"], timeout: 10_000 })
        .toString("utf8").trim().split("\n").filter((t: string) => /^v\d/.test(t));
      latestTag = tags[0] || undefined;
    } catch { /* no git */ }
    if (latestTag !== undefined || latestGate !== undefined) {
      const matchingGate = latestGate !== undefined && latestGate.tag === latestTag ? latestGate : undefined;
      const waiver = (matchingGate !== undefined ? [...matchingGate.waivedRules, ...activeWaivers] : activeWaivers).filter((x) => x.trim() !== "").join(", ");
      const vMap = (v: string | undefined) => v === "pass" ? "pass" as const : v === "blocked" ? "fail" as const : v === "waived" ? "warn" as const : "unknown" as const;
      release = {
        ...(latestTag !== undefined ? { latestTag } : {}),
        verdict: matchingGate !== undefined ? vMap(matchingGate.verdict) : "unknown",
        ...(waiver !== "" ? { waiver } : {}),
        ...(matchingGate !== undefined ? { collectedAt: iso(matchingGate.ts) } : {}),
      };
    }
  } catch { /* no release data */ }

  const collectedAt = maxCollectedAt([audit?.collectedAt, cycle?.collectedAt, release?.collectedAt]);
  return {
    generatedAt: iso(nowSec),
    ...(collectedAt !== undefined ? { collectedAt } : {}),
    ...(audit !== undefined ? { audit } : {}),
    ...(cycle !== undefined ? { cycle } : {}),
    ...(release !== undefined ? { release } : {}),
  };
}

/**
 * The default loop lane for a freshly collected snapshot.
 *
 * US-LOOP-118 (codex r8): this lane was labelled `source: "launchd"`, so a fresh
 * snapshot presented it as a resident lane — readers then counted it, and a stale
 * `lastAt` painted it red as a "zombie". Nothing here reads a plist: `running`
 * comes from `live.log` existing and `lastAt` from runs.jsonl, both of which
 * describe a SESSION. Labelling it `goal` puts it under the semantics it actually
 * has, and leaves `launchd` to mean only "leftover plist on disk".
 */
function defaultCollectLoopHeartbeat(cwd: string, nowSec: number): TruthSnapshotLoop {
  const loopDir = join(cwd, ".roll", "loop");
  let lastAt: string | undefined;
  try {
    const runsPath = join(loopDir, "runs.jsonl");
    if (existsSync(runsPath)) {
      for (const line of readFileSync(runsPath, "utf8").trim().split("\n").reverse()) {
        if (line.trim() === "") continue;
        try {
          const row = JSON.parse(line) as { ts?: string };
          if (typeof row.ts === "string" && row.ts !== "") {
            lastAt = new Date(row.ts).toISOString().replace(/\.\d{3}Z$/, "Z");
            break;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* no runs */ }
  // codex r9: `live.log` is never deleted, so its EXISTENCE only proves a cycle
  // once ran — mere existence made a long-finished cycle read as "go session open".
  // Use freshness, the same rule and window collectLoopLiveFeed already applies:
  // a log untouched for longer than the window is not streaming.
  const LIVE_FRESH_SEC = 300;
  let running = false;
  let liveAt: string | undefined;
  try {
    const st = statSync(join(loopDir, "live.log"));
    running = nowSec - Math.floor(st.mtimeMs / 1000) <= LIVE_FRESH_SEC;
    if (running) liveAt = new Date(st.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    running = false; // no live.log at all
  }
  // codex r10: `running` and `lastAt` must describe the SAME activity. Taking
  // `running` from a fresh live.log while `lastAt` still pointed at the PREVIOUS
  // completed run meant a genuinely active stream was painted a zombie as soon as
  // that earlier run aged past the staleness window. While streaming, the last
  // activity IS the stream's own write time.
  const activityAt = running ? liveAt : lastAt;
  // codex r12: no signal at all ⇒ NO lane. The CLI collector already worked this
  // way (US-LOOP-118: a clean project reports zero lanes rather than an idle one);
  // emitting an unconditional "go session" here contradicted that same contract on
  // the fallback path, so a project that had never run still showed a session lane.
  if (!running && activityAt === undefined) return { lanes: [] };
  return {
    lanes: [{
      name: "go session",
      source: "goal" as const,
      running,
      mode: "go" as const,
      ...(activityAt !== undefined ? { lastAt: activityAt } : {}),
    }],
  };
}

function defaultCollectEvidenceFlags(cwd: string, story: { id: string; epic: string }): StoryEvidenceFlags {
  const dir = join(cwd, ".roll", "features", story.epic, story.id);
  return {
    report: existsSync(join(dir, "latest")),
    acMap: existsSync(join(dir, "ac-map.json")),
    visualEvidence: existsSync(join(dir, "screenshots")),
  };
}

function defaultBuildRunCache(_cwd: string): unknown { return null; }
function defaultMergeEvidence(_cache: unknown, _id: string): boolean { return false; }
function defaultCollectProjects(cwd: string): readonly TruthSnapshotProject[] {
  if (!isRealProjectPath(cwd)) return [];
  const home = process.env["ROLL_HOME"] ?? homedir();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, ".roll", "projects.json"), "utf8"));
  } catch {
    return [];
  }
  const rows = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { projects?: unknown }).projects)
      ? (raw as { projects: unknown[] }).projects
      : [];
  const out: TruthSnapshotProject[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["slug"] !== "string" || typeof r["path"] !== "string") continue;
    const project: TruthSnapshotProject = {
      name: r["name"],
      slug: r["slug"],
      path: r["path"],
    };
    if (typeof r["releaseTag"] === "string") project.releaseTag = r["releaseTag"];
    if (typeof r["verdict"] === "string") project.verdict = r["verdict"];
    if (typeof r["lastIndexedAt"] === "string") project.lastIndexedAt = r["lastIndexedAt"];
    out.push(project);
  }
  out.sort((a, b) => (a.name === b.name ? a.slug.localeCompare(b.slug) : a.name.localeCompare(b.name)));
  return out;
}

function collectorErrorNote(err: unknown): string {
  return err instanceof Error && err.message.trim() !== "" ? err.message : "collector failed";
}

function collectPanel(
  fn: CollectPanelFn | undefined,
  cwd: string,
  nowSec: number,
): TruthSnapshotPanelSlot | undefined {
  if (fn === undefined) return undefined;
  try {
    return fn(cwd, nowSec);
  } catch (err) {
    return { status: "paused", data: null, note: collectorErrorNote(err) };
  }
}

function collectPanels(cwd: string, nowSec: number, deps: CollectorDeps): TruthSnapshotPanels | undefined {
  const panels: TruthSnapshotPanels = {};
  const casting = collectPanel(deps.collectCastingPanel, cwd, nowSec);
  const charter = collectPanel(deps.collectCharterPanel, cwd, nowSec);
  const skills = collectPanel(deps.collectSkillsPanel, cwd, nowSec);
  const gitHooks = collectPanel(deps.collectGitHooksPanel, cwd, nowSec);
  const liveFeed = collectPanel(deps.collectLiveFeedPanel, cwd, nowSec);
  if (casting !== undefined) panels.casting = casting;
  if (charter !== undefined) panels.charter = charter;
  if (skills !== undefined) panels.skills = skills;
  if (gitHooks !== undefined) panels.gitHooks = gitHooks;
  if (liveFeed !== undefined) panels.liveFeed = liveFeed;
  return Object.keys(panels).length > 0 ? panels : undefined;
}

function collectOnDeck(cwd: string, epics: ReturnType<typeof collectDossier>): TruthSnapshotOnDeck {
  const byId = new Map<string, { epic: string; title: string }>();
  for (const epic of epics) {
    for (const story of epic.stories) {
      byId.set(story.id, { epic: story.epic, title: story.title ?? story.id });
    }
  }

  let rows: TruthSnapshotOnDeck["rows"] = [];
  try {
    const backlog = readFileSync(join(cwd, ".roll", "backlog.md"), "utf8");
    rows = parseBacklog(backlog)
      .filter((item) => classifyStatus(item.status) === "todo")
      .map((item) => {
        const folder = byId.get(item.id);
        const epic = folder?.epic ?? "backlog";
        return {
          id: item.id,
          epic,
          title: folder?.title ?? item.desc,
          href: folder !== undefined ? `${folder.epic}/${item.id}/index.html` : "#backlog/todo",
        };
      });
  } catch {
    rows = [];
  }
  return { count: rows.length, rows };
}

// ── The selector ────────────────────────────────────────────────────────────

/**
 * collectDossierState — the single read-side selector that consolidates all
 * dossier data collectors into one TruthSnapshot.
 *
 * When called as `collectDossierState(cwd)`, uses default best-effort I/O
 * collectors (suitable for archive rendering / tests). When called with `deps`, the
 * caller can wire the full reconciled collectors for byte-identical output
 * (used by generateDossierPages).
 *
 * All story/cycle/evidence truth routing goes through truth-adapter selectors
 * (buildTruthSnapshot, deriveDeliveryLadder, storySpectrumState). No new
 * bespoke runs/backlog parsers are introduced.
 */
export function collectDossierState(
  cwd: string,
  opts?: { rebuild?: boolean; deps?: CollectorDeps },
): TruthSnapshot {
  void opts?.rebuild; // reserved for future archive cache rebuild
  const deps = opts?.deps ?? {};
  const buildRunCache = deps.buildRunCache ?? defaultBuildRunCache;
  const mergeEvidence = deps.mergeEvidence ?? defaultMergeEvidence;
  const collectTruthBoard = deps.collectTruthBoard ?? defaultCollectTruthBoard;
  const collectLoopHeartbeat = deps.collectLoopHeartbeat ?? defaultCollectLoopHeartbeat;
  const collectEvidenceFlags = deps.collectEvidenceFlags ?? defaultCollectEvidenceFlags;
  const collectProjects = deps.collectProjects ?? defaultCollectProjects;
  const nowSec = renderNowSec();

  // 1. Collect epics (walk .roll/features/, read backlog, classify stories)
  const runCache = buildRunCache(cwd);
  const epics = collectDossier(cwd, { mergeEvidence: (id) => mergeEvidence(runCache, id) });

  // 2. Build story registry + enrich evidence flags
  const storyRegistry: TruthSnapshotStoryEntry[] = epics.flatMap((epic) =>
    epic.stories.map((story) => {
      let evidence: StoryEvidenceFlags;
      try {
        evidence = collectEvidenceFlags(cwd, { id: story.id, epic: story.epic });
      } catch {
        evidence = NO_EVIDENCE;
      }
      story.evidence = evidence;
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

  // 3. Collect truth board (audit, cycle, release)
  const truth = collectTruthBoard(cwd, nowSec);

  // 4. Collect loop heartbeat
  const loop = collectLoopHeartbeat(cwd, nowSec);

  // 4.5. On Deck is backlog-primary: folders only provide deep links.
  const onDeck = collectOnDeck(cwd, epics);

  // 4.6. Project switcher rows are filtered at the shared read selector.
  const projects = reachableProjects(collectProjects(cwd));

  // 4.7. Off-schema dossier panels ride the same snapshot envelope.
  const panels = collectPanels(cwd, nowSec, deps);

  // 5. Assemble snapshot via truth selector
  return buildTruthSnapshot({
    generatedAt: truth.generatedAt ?? iso(nowSec),
    ...(truth.collectedAt !== undefined ? { collectedAt: truth.collectedAt } : {}),
    storyStates: epics.flatMap((e) => e.stories.map(storySpectrumState)),
    legacyCount: countLegacyStories(epics),
    ...(truth.audit !== undefined ? { audit: truth.audit } : {}),
    ...(truth.cycle !== undefined ? { cycle: truth.cycle } : {}),
    ...(truth.release !== undefined ? { release: truth.release } : {}),
    loop,
    onDeck,
    ...(projects.length > 0 ? { projects } : {}),
    stories: storyRegistry,
    ...(panels !== undefined ? { panels } : {}),
  });
}

/**
 * Create a wired collectDossierState function with the given dependencies.
 * Use this in the CLI to inject the full reconciled collectors.
 */
export function createDossierStateCollector(deps: CollectorDeps): typeof collectDossierState {
  return (cwd: string, opts?: { rebuild?: boolean }) =>
    collectDossierState(cwd, { ...opts, deps });
}
