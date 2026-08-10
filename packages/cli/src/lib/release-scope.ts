/**
 * @responsibility Builds the release tab pending-delivery and shipped-changelog sections.
 */
/**
 * US-DOSSIER-016 / FIX-372 — the release tab's pending-delivery and
 * shipped-changelog sections, plus the collapsible version history.
 *
 * FIX-372 redefines "pending" on the Release page. It used to mean "every
 * story not yet Done" — the WHOLE backlog tree (~241, incl. archived/legacy/
 * idea/parked), which is meaningless on a Release page. It now means the
 * NEXT RELEASE'S CONTENT: the stories delivered to `main` SINCE the latest
 * release tag. Source of truth, in order:
 *   - merge time: the `pr:merge` event's `ts` for the story (RollEvent
 *     `pr:merge = {prNumber, storyId, ts}`);
 *   - the latest release tag's commit time (a git probe — see
 *     {@link latestTagCommitTime}, reusing the FIX-368 reconciler for the tag).
 * A Done story whose merge `ts` is AFTER the latest tag's time is "pending
 * release"; a Done story already inside a tag (merge `ts` ≤ the tag time, or
 * no recorded merge time at all) is shipped/released. Archived/historical
 * cards never reach this function — the caller feeds only live backlog epics.
 *
 * The changelog half is generated from MERGE TRUTH, never from backlog claims:
 * `pr:merge` events when present, else the PR# annotation a Done row carries
 * (the same evidence the done-no-merge audit validates).
 *
 * Purity: {@link selectReleaseDelta} is a PURE function over (stories, merge-ts
 * map, latest-tag time) — no I/O, no clock — so it unit-tests deterministically.
 * {@link collectReleaseScope} is the impure seam; both the merge-ts map and the
 * latest-tag time are injectable so the whole thing stays testable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEventLine } from "@roll/spec";
import { reconcileReleaseForProject, type ReleaseFactsReader } from "./release-truth.js";

export interface ScopeStory {
  id: string;
  epic: string;
  title: string;
  state: string;
  prNumber?: number;
}

export interface ScopeEpicGroup {
  epic: string;
  items: ScopeStory[];
}

export interface ReleaseHistoryEntry {
  tag: string;
  date: string;
  waived: boolean;
  /** Raw changelog bullet lines for the version (already markdown-stripped). */
  items: string[];
}

export interface ReleaseScopeVM {
  /** Stories merged to `main` since the latest release tag — the next cut. */
  pending: ScopeEpicGroup[];
  /** Done stories already inside a tagged release. */
  shipped: ScopeEpicGroup[];
  pendingCount: number;
  shippedCount: number;
  history: ReleaseHistoryEntry[];
  /** The latest release tag the delta is measured against (when knowable). */
  latestTag?: string;
}

export interface ScopeStoryInput {
  id: string;
  epic: string;
  title: string;
  /** Spectrum state from the ONE classifier (US-DOSSIER-010). */
  state: string;
  /** Raw backlog status cell (carries the PR# merge annotation). */
  claim?: string;
}

/** Merge truth per story: the merge `ts` (epoch seconds) and, when known, the
 *  PR number. `prNumber` is optional — a git-derived merge whose commit subject
 *  carries no `(#N)` still has a valid `ts` (consumers fall back to the Done
 *  row's `PR#` claim). */
interface MergeRecord {
  prNumber?: number;
  ts: number;
}

/** Injectable facts for the pure delta selection (FIX-372 testability seam). */
export interface ReleaseDeltaFacts {
  /** storyId → its `pr:merge` record (PR number + merge ts in epoch seconds). */
  merges: Map<string, MergeRecord>;
  /** The latest release tag's commit time (epoch seconds), when knowable. */
  latestTagTime?: number;
  /** The latest release tag name, when knowable (for the header line). */
  latestTag?: string;
}

function groupByEpic(items: ScopeStory[]): ScopeEpicGroup[] {
  const map = new Map<string, ScopeStory[]>();
  for (const it of items) {
    const list = map.get(it.epic) ?? [];
    list.push(it);
    map.set(it.epic, list);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([epic, list]) => ({ epic, items: list }));
}

/**
 * Merge truth per story from `pr:merge` events: the PR number AND the merge
 * `ts`. The newest `pr:merge` for a story wins (a re-merge / re-open keeps the
 * latest landing as the delta anchor).
 */
function mergesFromEvents(projectPath: string): Map<string, MergeRecord> {
  const out = new Map<string, MergeRecord>();
  const path = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(path)) return out;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const e = parseEventLine(line);
      if (e !== null && e.type === "pr:merge") {
        const prev = out.get(e.storyId);
        if (prev === undefined || e.ts >= prev.ts) out.set(e.storyId, { prNumber: e.prNumber, ts: e.ts });
      }
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/**
 * PURE — parse `git log <tag>..HEAD --format=%ct%x09%s` output into merge truth
 * per card. Each post-tag commit's subject carries the card id (e.g.
 * `Story: US-AGENT-042 — … (#843)`, `Fix: FIX-356c — …`); we map id → {ts (the
 * commit's epoch seconds), prNumber (from `(#N)`)}. The newest commit for an id
 * wins (git log is reverse-chronological, so the first occurrence is newest).
 * Id forms covered: `FIX-356`, `FIX-356c`, `US-AGENT-042`, `US-TOOL-016`,
 * `REFACTOR-049`.
 */
export function parseGitMergeLog(logText: string): Map<string, MergeRecord> {
  const out = new Map<string, MergeRecord>();
  const ID_RE = /\b(?:US|FIX|REFACTOR)-(?:[A-Z]+-)?\d+[a-z]?\b/g;
  for (const line of logText.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ts = Number(line.slice(0, tab));
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const subject = line.slice(tab + 1);
    const prNum = /\(#(\d+)\)/.exec(subject)?.[1];
    for (const id of subject.match(ID_RE) ?? []) {
      const prev = out.get(id);
      if (prev === undefined || ts >= prev.ts) {
        out.set(id, { ts, ...(prNum !== undefined ? { prNumber: Number(prNum) } : {}) });
      }
    }
  }
  return out;
}

/**
 * Merge truth from GIT — cards whose squash-merge commit landed on `main` AFTER
 * the latest release tag. This is the AUTHORITATIVE "to-be-released" source
 * (FIX-372): `pr:merge` events exist only for loop-merged PRs, so a
 * manually-merged (`gh pr merge`) PR emits none — relying on events alone leaves
 * "pending" empty even when real work shipped since the tag. `git log <tag>..HEAD`
 * returns exactly the post-tag commits. Best-effort: no tag / not a repo → empty.
 */
function mergesFromGit(projectPath: string, latestTag: string | undefined): Map<string, MergeRecord> {
  if (latestTag === undefined || latestTag === "") return new Map();
  try {
    const log = execFileSync("git", ["-C", projectPath, "log", `${latestTag}..HEAD`, "--format=%ct%x09%s"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseGitMergeLog(log);
  } catch {
    return new Map();
  }
}

/**
 * The latest release tag's commit time (epoch seconds). The tag NAME is
 * reconciled from reality via the FIX-368 reconciler (newest `v*` tag of the
 * running major / CHANGELOG top / package version), then its commit time is a
 * plain `git log -1 --format=%ct <tag>` probe. Returns `{}` when the tag or its
 * time can't be resolved (a fresh repo with no tags) — the caller then treats
 * every merged story as already-shipped (an empty, honest pending set), never
 * the whole backlog.
 */
export function latestTagCommitTime(
  projectPath: string,
  reader?: ReleaseFactsReader,
): { latestTag?: string; latestTagTime?: number } {
  const reconciled = reader !== undefined ? reconcileReleaseForProject(projectPath, reader) : reconcileReleaseForProject(projectPath);
  const latestTag = reconciled.latestTag;
  if (latestTag === undefined) return {};
  try {
    const out = execFileSync("git", ["-C", projectPath, "log", "-1", "--format=%ct", latestTag], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
    const t = Number(out);
    if (Number.isFinite(t) && t > 0) return { latestTag, latestTagTime: t };
  } catch {
    /* tag not present locally → time unknown */
  }
  return { latestTag };
}

/**
 * PURE — split Done stories into pending (merged AFTER the latest tag) vs
 * shipped (already inside a tag), using injected merge facts. Non-Done stories
 * are NOT release scope and are dropped entirely (the open backlog belongs on
 * the Backlog tab, not Release — FIX-372). A Done story with no recorded merge
 * `ts`, or a merge `ts` at-or-before the tag time, is shipped. When the latest
 * tag time is unknown, no story can be "after" it → everything Done is shipped
 * (an empty pending set, never the whole backlog).
 */
export function selectReleaseDelta(
  stories: readonly ScopeStoryInput[],
  facts: ReleaseDeltaFacts,
): { pending: ScopeStory[]; shipped: ScopeStory[] } {
  const pending: ScopeStory[] = [];
  const shipped: ScopeStory[] = [];
  for (const s of stories) {
    if (s.state !== "done") continue; // not release scope — lives on Backlog tab
    const merge = facts.merges.get(s.id);
    const fromClaim = /PR#(\d+)/.exec(s.claim ?? "")?.[1];
    const prNumber = merge?.prNumber ?? (fromClaim !== undefined ? Number(fromClaim) : undefined);
    const row: ScopeStory = { id: s.id, epic: s.epic, title: s.title, state: s.state, ...(prNumber !== undefined ? { prNumber } : {}) };
    const isAfterTag =
      facts.latestTagTime !== undefined && merge !== undefined && merge.ts > facts.latestTagTime;
    if (isAfterTag) pending.push(row);
    else shipped.push(row);
  }
  return { pending, shipped };
}

export function collectReleaseScope(
  projectPath: string,
  stories: readonly ScopeStoryInput[],
  facts?: ReleaseDeltaFacts,
): ReleaseScopeVM {
  const resolved: ReleaseDeltaFacts = facts ?? (() => {
    const { latestTag, latestTagTime } = latestTagCommitTime(projectPath);
    // GIT is the authoritative post-tag delta source (covers manual `gh` merges
    // that emit no `pr:merge` event); `pr:merge` events supplement it for any
    // loop-merged story git didn't attribute.
    const merges = mergesFromGit(projectPath, latestTag);
    for (const [id, rec] of mergesFromEvents(projectPath)) {
      // event ts is epoch-ms; the tag time is epoch-seconds — normalize so the
      // `merge.ts > latestTagTime` comparison in selectReleaseDelta is unit-correct.
      if (!merges.has(id)) merges.set(id, { ...rec, ts: rec.ts >= 1_000_000_000_000 ? Math.floor(rec.ts / 1000) : rec.ts });
    }
    return {
      merges,
      ...(latestTagTime !== undefined ? { latestTagTime } : {}),
      ...(latestTag !== undefined ? { latestTag } : {}),
    };
  })();
  const { pending, shipped } = selectReleaseDelta(stories, resolved);
  return {
    pending: groupByEpic(pending),
    shipped: groupByEpic(shipped),
    pendingCount: pending.length,
    shippedCount: shipped.length,
    history: collectHistory(projectPath),
    ...(resolved.latestTag !== undefined ? { latestTag: resolved.latestTag } : {}),
  };
}

/** Version history from CHANGELOG.md sections + waiver marks from gate events. */
export function collectHistory(projectPath: string): ReleaseHistoryEntry[] {
  const path = join(projectPath, "CHANGELOG.md");
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const waivedTags = new Set<string>();
  try {
    const ev = join(projectPath, ".roll", "loop", "events.ndjson");
    if (existsSync(ev)) {
      for (const line of readFileSync(ev, "utf8").split("\n")) {
        const e = parseEventLine(line);
        if (e !== null && e.type === "release:gate" && Array.isArray(e.waivedRules) && e.waivedRules.length > 0) {
          waivedTags.add(e.tag);
        }
      }
    }
  } catch {
    /* best-effort */
  }
  const out: ReleaseHistoryEntry[] = [];
  let current: ReleaseHistoryEntry | null = null;
  for (const line of text.split("\n")) {
    const head = /^## (v\S+)\s+—\s+(\S+)/.exec(line);
    if (head !== null) {
      if (current !== null) out.push(current);
      const tag = head[1] as string;
      current = { tag, date: head[2] as string, waived: waivedTags.has(tag), items: [] };
      continue;
    }
    if (current === null) continue;
    const item = /^- (.+)$/.exec(line.trim());
    if (item !== null && current.items.length < 30) {
      current.items.push((item[1] as string).replace(/`/g, "").replace(/\*\*/g, ""));
    }
  }
  if (current !== null) out.push(current);
  return out.slice(0, 8);
}
