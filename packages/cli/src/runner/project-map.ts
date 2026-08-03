import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CycleRepositoryExecutionContext } from "@roll/spec";
import { readLatestStoryReviewScore, REVIEW_SCORE_LOW_THRESHOLD, type ReviewScoreEntry } from "../lib/review-score.js";

/** Hard char cap on the injected project map — the FIX-338 prompt is already lean
 *  (~2.3KB hub); the map must stay a CONCISE orientation aid, never context bloat.
 *  Anything over this is truncated with an explicit elision marker. */
export const PROJECT_MAP_MAX_CHARS = 1800;
export const REPOSITORY_CONTEXT_MAX_CHARS = 4096;

/** How many top-level entries to list (shallow), and how deep into a key container
 *  dir (`packages/`) to descend — one level, so it stays a map not a file dump. */
const PROJECT_MAP_MAX_TOPLEVEL = 24;
const PROJECT_MAP_MAX_RELEVANT = 12;

/** Top-level names never worth mapping (noise: deps, VCS, build caches). */
const PROJECT_MAP_SKIP = new Set([
  ".git",
  "node_modules",
  ".vite",
  "dist",
  "coverage",
  ".turbo",
  ".cache",
  ".DS_Store",
]);

/** Container dirs we descend ONE level into (the workspace's real structure). */
const PROJECT_MAP_CONTAINERS = new Set(["packages", "apps", "skills"]);

/** Read a dir's immediate Dirent children (string-named overload, never throws
 *  the Buffer variant). A thin wrapper so callers get a precise element type. */
function shallowDirents(dir: string): import("node:fs").Dirent<string>[] {
  return readdirSync(dir, { withFileTypes: true });
}

/** Read a dir's immediate child names (dirs suffixed `/`), sorted, bounded; `[]`
 *  on any error. Pure-ish: read-only inspection of the worktree. */
function shallowList(dir: string, limit: number): string[] {
  try {
    const out: string[] = [];
    for (const ent of shallowDirents(dir)) {
      if (PROJECT_MAP_SKIP.has(ent.name)) continue;
      out.push(ent.isDirectory() ? `${ent.name}/` : ent.name);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

/** Recursively collect (bounded) file paths whose relative PATH contains `token`
 *  (case-insensitive) — so both a card-named file AND any file under the card's
 *  `<epic>/<id>/` dir count as relevant. Skips noise dirs. Read-only; stops at
 *  `limit` hits or `maxScan` entries so a huge tree can never stall the spawn. */
function findRelevantFiles(root: string, token: string, limit: number): string[] {
  const needle = token.toLowerCase();
  const hits: string[] = [];
  let scanned = 0;
  const maxScan = 4000;
  const walk = (dir: string, rel: string): void => {
    if (hits.length >= limit || scanned >= maxScan) return;
    let ents: ReturnType<typeof shallowDirents>;
    try {
      ents = shallowDirents(dir);
    } catch {
      return;
    }
    for (const ent of ents) {
      if (hits.length >= limit || scanned >= maxScan) return;
      if (PROJECT_MAP_SKIP.has(ent.name)) continue;
      scanned += 1;
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(join(dir, ent.name), childRel);
      } else if (childRel.toLowerCase().includes(needle)) {
        hits.push(childRel);
      }
    }
  };
  walk(root, "");
  hits.sort((a, b) => a.localeCompare(b));
  return hits.slice(0, limit);
}

/**
 * FIX-338 (Phase B 杠杆2) — build a CONCISE, BOUNDED project map for the working
 * agent's initial context: (a) the repo's shallow top-level structure (key dirs
 * one level deep) so the agent grasps the layout without `ls`/`rg` round-trips,
 * and (b) the card's relevant files (a heuristic: files whose basename matches the
 * story-id token, plus its epic), so it lands near the work instead of grepping.
 *
 * Agent-AGNOSTIC: pure text, no per-agent shape — the caller prepends it into the
 * SAME prompt body every agent consumes ({@link buildSpawnCommand}). BOUNDED: the
 * whole map is hard-capped at {@link PROJECT_MAP_MAX_CHARS} (truncated with an
 * explicit marker) so it can never bloat the already-lean prompt. Read-only
 * inspection of the cycle worktree ⇒ does NOT break isolation.
 *
 * Returns "" when the worktree is unreadable (a missing map is harmless — the
 * agent simply explores the old way), so the spawn never fails on this aid.
 */
export function buildProjectMap(worktreePath: string, storyId?: string): string {
  const top = shallowList(worktreePath, PROJECT_MAP_MAX_TOPLEVEL);
  if (top.length === 0) return ""; // unreadable worktree → no map (harmless).
  const lines: string[] = ["[项目地图 / project map]", "结构 / structure:"];
  for (const name of top) {
    lines.push(`  ${name}`);
    const bare = name.replace(/\/$/, "");
    if (name.endsWith("/") && PROJECT_MAP_CONTAINERS.has(bare)) {
      for (const child of shallowList(join(worktreePath, bare), PROJECT_MAP_MAX_TOPLEVEL)) {
        lines.push(`    ${child}`);
      }
    }
  }
  // (b) Card-relevant files — heuristic on the story-id token (e.g. FIX-338),
  // bounded. A blank/short token is skipped (too noisy to be useful).
  const token = (storyId ?? "").trim();
  if (token.length >= 3) {
    const relevant = findRelevantFiles(worktreePath, token, PROJECT_MAP_MAX_RELEVANT);
    if (relevant.length > 0) {
      lines.push(`本卡相关文件 / files matching ${token}:`);
      for (const f of relevant) lines.push(`  ${f}`);
    }
  }
  let map = lines.join("\n");
  if (map.length > PROJECT_MAP_MAX_CHARS) {
    map = `${map.slice(0, PROJECT_MAP_MAX_CHARS - 3)}...`;
  }
  return map;
}

/**
 * FIX-338 (Phase B 杠杆2) — when ON, PREPEND the bounded project map ahead of the
 * skill body so it rides into the agent's initial context (the prompt is built as
 * autorun-directive + story-pin + skillBody, so a prefix here orients the agent
 * before it reads the workflow). DEFAULT-OFF: `enabled === false` ⇒ returns the
 * body unchanged (deploy no-op). Best-effort: an empty/unreadable map also returns
 * the body unchanged, so the aid can never fail the spawn.
 */
export function maybeInjectProjectMap(
  skillBody: string,
  worktreePath: string,
  enabled: boolean,
  storyId?: string,
): string {
  if (!enabled) return skillBody; // DEFAULT-OFF: deploy no-op until flipped on.
  const map = buildProjectMap(worktreePath, storyId);
  if (map === "") return skillBody;
  return `${map}\n\n${skillBody}`;
}

/** Render the complete Workspace repository contract for one Builder prompt.
 * The map is deterministic, contains no filesystem inspection, and fails loud
 * rather than truncating away a repository identity or access boundary. */
export function buildRepositoryContextMap(
  execution: CycleRepositoryExecutionContext,
): string {
  const entries = Object.entries(execution.repositories)
    .sort(([, left], [, right]) => left.repoId.localeCompare(right.repoId));
  if (entries.length === 0) throw new Error("invalid_repository_map: at least one repository is required");
  const aliases = new Set<string>();
  for (const [key, repository] of entries) {
    if (key !== repository.repoId || aliases.has(repository.alias)) {
      throw new Error("invalid_repository_map: keys must match unique repoId/alias identities");
    }
    aliases.add(repository.alias);
  }
  const payload = {
    workspaceId: execution.workspaceId,
    builderCwd: execution.issueRoot,
    repositories: entries.map(([, repository]) => repository),
  };
  const rendered = [
    "[Workspace repository execution context]",
    "Builder cwd is the Issue root. The repository map is authoritative; do not infer identity from paths.",
    "read-only repositories are context-only and MUST NOT be edited, used for TCR commits, or published.",
    JSON.stringify(payload, null, 2),
  ].join("\n");
  if (rendered.length > REPOSITORY_CONTEXT_MAX_CHARS) {
    throw new Error(
      `repository_context_too_large: ${rendered.length} > ${REPOSITORY_CONTEXT_MAX_CHARS}`,
    );
  }
  return rendered;
}

/** Prepend the authoritative repository map to a Builder prompt. */
export function injectRepositoryContext(
  skillBody: string,
  execution: CycleRepositoryExecutionContext,
): string {
  return `${buildRepositoryContextMap(execution)}\n\n${skillBody}`;
}

// ── FIX-386: low peer review score fix-forward context injection ────────────

/** Max chars of reviewer rationale to inject into the agent context. A short
 *  fix-forward task keeps the prompt bounded; the full note is still on disk. */
const LOW_SCORE_FEEDBACK_MAX_CHARS = 1200;

/**
 * FIX-386 — build a fix-forward task prompt from the reviewer's low-score
 * findings. Returns an empty string when there is no low score to forward, or
 * when the latest score is above the low threshold. The prompt tells the builder
 * to fix the specific reviewer findings in the runner-provided worktree, then
 * re-submit for peer review — no branch surgery or context loss.
 *
 * Reads the LATEST review score note for the story from the PERSISTENT .roll
 * (repoCwd). Best-effort: a read blip returns "" so the agent runs cold without
 * the fix-forward hint — suboptimal but never cycle-toppling.
 */
export function buildLowScoreFixForwardPrompt(
  projectPath: string,
  storyId: string,
): string {
  if (storyId === "") return "";
  let entry: ReviewScoreEntry | undefined;
  try {
    entry = readLatestStoryReviewScore(projectPath, storyId);
  } catch {
    return "";
  }
  if (entry === undefined) return "";
  if (entry.score > REVIEW_SCORE_LOW_THRESHOLD) return "";
  const verdict = entry.verdict.toLowerCase();
  if (verdict !== "ok" && verdict !== "regression") return "";

  const headline =
    verdict === "regression"
      ? `⚠️  Prior peer review REGRESSION (${entry.score}/10) — fix these findings in the runner-provided worktree and re-submit for review.`
      : `⚠️  Prior peer review LOW SCORE (${entry.score}/10) — address reviewer findings in the runner-provided worktree, then re-submit for peer review.`;

  const rationale =
    (entry.note ?? "").trim() === ""
      ? `(no detailed rationale recorded — check ${entry.sourcePath})`
      : entry.note.trim().slice(0, LOW_SCORE_FEEDBACK_MAX_CHARS);

  const who = entry.scoredBy !== undefined && entry.scoredBy !== ""
    ? ` (reviewed by ${entry.scoredBy})`
    : "";

  return [
    "## 🔧 Fix-Forward: Low Peer Review Score",
    "",
    `${headline}${who}`,
    "",
    "**Reviewer findings:**",
    rationale,
    "",
    "**Instructions:**",
    `- Work only from the current worktree and current base for ${storyId}; inspect it before assuming earlier changes are present.`,
    "- Do not create, checkout, rename, or switch branches. The runner owns branch lifecycle and recovery base selection.",
    "- Fix each finding above with minimal, targeted changes.",
    "- Write/update regression tests for each fix.",
    `- When done, the cycle's peer review stage will RE-SCORE this delivery.`,
    "- If the score is still low, the loop will escalate to the owner.",
    "",
  ].join("\n");
}
