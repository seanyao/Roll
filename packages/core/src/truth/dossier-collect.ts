/**
 * @responsibility Walks feature card folders into the dossier model.
 * US-OBS-016 — dossier data-collection moved to @roll/core (read-side home).
 *
 * Walk `.roll/features/` into the dossier model: every `<epic>/<ID>/` card
 * folder becomes a story (spec.md enriches it; a `latest/` pointer marks
 * truth). Pure read — no writes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "../backlog/store.js";
import type { AuditPrEvidence } from "../consistency/audit.js";
import { storyTruthFromBacklog } from "./adapter.js";
import { classifyStatus, type StoryEvidenceFlags, type StoryStatus } from "@roll/spec";
import type { TruthReason, TruthState } from "./selectors.js";
import { readDeliveries, nodeDeliveryStore } from "../delivery/store.js";
import { queryStoryDelivery } from "../truth/query.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** One story as the dossier sees it. */
export interface DossierStory {
  id: string;
  epic: string;
  /** ID family: US | FIX | REFACTOR | IDEA | … (prefix before the first dash). */
  type: string;
  /** Human title — spec.md frontmatter `title:`, else the H1 remainder. */
  title?: string;
  /** spec.md frontmatter `created:` when present. */
  created?: string;
  /** truth: a `latest/` attest pointer exists, OR the spec heading marks it ✅
   *  done (IDEA-003 — v2-migrated cards that predate the attest chain). When the
   *  card is in the backlog, that authoritative status decides (status==="done"). */
  delivered: boolean;
  /** The backlog status when this card is in .roll/backlog.md — the live source
   *  of truth the dossier aligns to (done | in_progress | hold | todo). Undefined
   *  for cards absent from the backlog (archived history). */
  status?: StoryStatus;
  /** Raw backlog status cell: the owner's claim, including PR annotations. */
  claim?: string;
  /** Truth selector verdict for backlog-present cards. Undefined for archive-only history. */
  truthState?: TruthState;
  truthReason?: TruthReason;
  /** Completed lifecycle stations (definition/design/execution/delivery/
   *  retrospective) for the index spine — computed from real evidence by the
   *  index command (stationsDone) and attached here; undefined until enriched. */
  stages?: readonly string[];
  /** US-DOSSIER-008: a *legacy* (pre-v3) delivery — done by the backlog's
   *  authority but with NO v3 evidence chain (no `latest/` attest pointer, no
   *  `ac-map.json`). Honoured as done, but marked apart so the board does not
   *  read it as half-finished just because the evidence-based spine is bare. */
  legacy: boolean;
  /** US-DOSSIER-025: the on-disk attest evidence flags (report / ac-map / a
   *  real-pixel screenshot) that back the `attested` rung. Attached by the index
   *  command during enrichment (the SAME `storyEvidenceFlags` probe the per-story
   *  registry reads). */
  evidence?: StoryEvidenceFlags;
}

export type DossierEpicDocKind = "overview" | "plan" | "doc";

export interface DossierEpicDoc {
  file: string;
  href: string;
  kind: DossierEpicDocKind;
  title: string;
}

/** One epic group with its wish→truth tally. */
export interface DossierEpic {
  name: string;
  stories: DossierStory[];
  delivered: number;
  docs?: DossierEpicDoc[];
}

export interface CollectDossierOptions {
  /** story id → delivery PR evidence snapshot. Absence means unavailable, not false. */
  prEvidence?: Record<string, AuditPrEvidence>;
  nowSec?: number;
  /** FIX-278: durable, offline merge-truth probe — true when git history carries
   *  a merge commit referencing this story id. */
  mergeEvidence?: (storyId: string) => boolean;
  /** FIX-388: pre-loaded deliveries for structured truth lookup.
   *  When absent, read from `.roll/loop/deliveries.jsonl` on disk. */
  deliveries?: readonly import("@roll/spec").DeliveryRecord[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A story heading whose text carries a ✅ status marker (IDEA-003 / owner ruling).
 */
function specMarkedDone(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!/^#{1,4}\s/.test(line)) continue;
    if (!/\b(?:US|FIX|REFACTOR|BUG|IDEA)-[A-Z0-9]/.test(line)) continue;
    return /✅/u.test(line);
  }
  return false;
}

/** Read a story's title/created/done-marker from its spec.md (frontmatter first, H1 fallback). */
function specMeta(specPath: string): { title?: string; created?: string; markedDone: boolean } {
  let text: string;
  try {
    text = readFileSync(specPath, "utf8");
  } catch {
    return { markedDone: false };
  }
  const out: { title?: string; created?: string; markedDone: boolean } = { markedDone: specMarkedDone(text) };
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm !== null) {
    const t = /^title:\s*(.+)$/m.exec(fm[1] ?? "");
    const c = /^created:\s*(.+)$/m.exec(fm[1] ?? "");
    if (t !== null) out.title = (t[1] ?? "").trim();
    if (c !== null) out.created = (c[1] ?? "").trim();
  }
  if (out.title === undefined) {
    // H1 fallback: `# <ID> — title` / `# <ID> · title` (hand-written specs).
    const h1 = /^#\s+\S+\s*(?:[—·:-]\s*)?(.*)$/m.exec(text);
    if (h1 !== null && (h1[1] ?? "").trim() !== "") out.title = (h1[1] ?? "").trim().replace(/\s*[✅🚫🔨].*$/u, "");
  }
  return out;
}

function markdownTitle(path: string, fallback: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const h1 = /^#\s+(.+)$/m.exec(text);
    const title = (h1?.[1] ?? "").trim();
    if (title !== "") return title;
  } catch {
    /* unreadable doc: use filename fallback */
  }
  return fallback;
}

function epicDocKind(epic: string, file: string): DossierEpicDocKind {
  if (file === `${epic}.md`) return "overview";
  if (file.endsWith("-plan.md")) return "plan";
  return "doc";
}

function epicDocRank(kind: DossierEpicDocKind): number {
  if (kind === "overview") return 0;
  if (kind === "plan") return 1;
  return 2;
}

function compareEpicDocFile(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function collectEpicDocs(root: string, epic: string): DossierEpicDoc[] {
  const dir = join(root, epic);
  let files: string[] = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return files
    .map((file) => {
      const kind = epicDocKind(epic, file);
      const fallback = file.replace(/\.md$/, "");
      return {
        file,
        href: encodeURIComponent(file),
        kind,
        title: markdownTitle(join(dir, file), fallback),
      };
    })
    .sort((a, b) => epicDocRank(a.kind) - epicDocRank(b.kind) || compareEpicDocFile(a.file, b.file));
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Walk `.roll/features/` into the dossier model: every `<epic>/<ID>/` card
 * folder becomes a story (spec.md enriches it; a `latest/` pointer marks
 * truth). Epics sorted by name; stories by id. Pure read — no writes.
 */
export function collectDossier(projectPath: string, opts: CollectDossierOptions = {}): DossierEpic[] {
  const root = join(projectPath, ".roll", "features");
  if (!existsSync(root)) return [];
  const backlogStatus = new Map<string, StoryStatus>();
  const backlogRawStatus = new Map<string, string>();
  try {
    const backlogText = readFileSync(join(projectPath, ".roll", "backlog.md"), "utf8");
    for (const item of parseBacklog(backlogText)) {
      const st = classifyStatus(item.status);
      if (st !== null) backlogStatus.set(item.id, st);
      backlogRawStatus.set(item.id, item.status);
    }
  } catch {
    /* no backlog → heuristic-only */
  }
  // FIX-388: load deliveries for structured truth lookup (AC5: batch-read once).
  const deliveries: readonly import("@roll/spec").DeliveryRecord[] =
    opts.deliveries ?? readDeliveries(nodeDeliveryStore, projectPath);
  const epics: DossierEpic[] = [];
  let epicDirs: string[] = [];
  try {
    epicDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  for (const epic of epicDirs) {
    const stories: DossierStory[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, epic), { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^[A-Z][A-Z0-9]*-/.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }
    for (const id of entries) {
      const dir = join(root, epic, id);
      const meta = specMeta(join(dir, "spec.md"));
      let delivered = meta.markedDone;
      let hasLatest = false;
      try {
        if (statSync(join(dir, "latest")).isDirectory()) {
          delivered = true;
          hasLatest = true;
        }
      } catch {
        /* no latest → fall back to the heading marker */
      }
      const status = backlogStatus.get(id);
      const rawStatus = backlogRawStatus.get(id);
      const merged = opts.mergeEvidence?.(id) ?? false;
      // FIX-388: pass structured delivery truth so the selector reads the
      // delivery record, NOT the markdown backlog status string.
      // AC4: only pass when the card has real delivery records; cards with
      // no records fall back to markdown parsing (backward compat).
      const rawTruth = queryStoryDelivery(id, deliveries);
      const deliveryTruth = rawTruth.lastRecordedAt > 0 ? rawTruth : undefined;
      const storyTruth = rawStatus !== undefined
        ? storyTruthFromBacklog(id, rawStatus, { prEvidence: opts.prEvidence?.[id], nowSec: opts.nowSec, ...(deliveryTruth !== undefined ? { deliveryTruth } : {}) })
        : undefined;
      if (storyTruth !== undefined) delivered = storyTruth.delivered || (status === "done" && merged);
      const legacy = delivered && !hasLatest && !existsSync(join(dir, "ac-map.json"));
      const story: DossierStory = {
        id,
        epic,
        type: (id.split("-")[0] ?? id).toUpperCase(),
        delivered,
        legacy,
      };
      if (status !== undefined) story.status = status;
      if (rawStatus !== undefined) story.claim = rawStatus;
      if (storyTruth !== undefined) {
        story.truthState = storyTruth.state;
        story.truthReason = storyTruth.reason;
      }
      if (meta.title !== undefined) story.title = meta.title;
      if (meta.created !== undefined) story.created = meta.created;
      stories.push(story);
    }
    if (stories.length > 0) {
      epics.push({
        name: epic,
        stories,
        delivered: stories.filter((s) => s.delivered).length,
        docs: collectEpicDocs(root, epic),
      });
    }
  }
  return epics;
}
