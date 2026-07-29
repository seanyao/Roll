import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  buildDoneIndex,
  buildPickRankingCacheKey,
  isEligible,
  parsePickRankingJson,
  parsePolicy,
  rankingEntryForPicked,
  type BacklogItem,
  type CycleContext,
  type PickOptions,
  type PickRankingEntry,
} from "@roll/core";
import { agentSpawnSupportsPurpose, type AgentSpawn } from "./agent-spawn.js";
import { spawnWatched } from "./spawn-watchdog.js";
import type { Ports } from "./ports.js";
import { eventTs } from "./runner-time.js";

const PICK_RANKING_TIMEOUT_MS = 60_000;
const PICK_RANKING_CACHE_FILE = "pick-ranking.json";

interface PickRankingCacheFile {
  schema: "pick-ranking.v1";
  backlogHash: string;
  candidateSetHash: string;
  ranking: PickRankingEntry[];
  createdAt: number;
}

function semanticRankingPolicy(projectCwd: string): "on" | "off" {
  try {
    const p = join(projectCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return "on";
    return parsePolicy(readFileSync(p, "utf8")).pick.semanticRanking;
  } catch {
    return "on";
  }
}

function pickRankingCachePath(ports: Ports): string {
  return join(dirname(ports.paths.eventsPath), PICK_RANKING_CACHE_FILE);
}

function pickRankingCwd(ports: Ports): string {
  const key = createHash("sha256").update(dirname(ports.paths.eventsPath)).digest("hex").slice(0, 16);
  let dir = join(tmpdir(), "roll-pick-ranking-cwd", key);
  const repoPrefix = ports.repoCwd.endsWith(sep) ? ports.repoCwd : `${ports.repoCwd}${sep}`;
  if (dir === ports.repoCwd || dir.startsWith(repoPrefix)) {
    dir = join(dirname(ports.repoCwd), `.roll-pick-ranking-cwd-${key}`);
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* spawn will fail open if the runtime cwd cannot be prepared */
  }
  return dir;
}

function backlogContentForRanking(projectCwd: string, items: readonly BacklogItem[]): string {
  try {
    const p = join(projectCwd, ".roll", "backlog.md");
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch {
    /* synthetic fallback below */
  }
  return items.map((row) => `| [${row.id}] | ${row.desc} | ${row.status} |`).join("\n");
}

function specPathFromBacklogLine(projectCwd: string, backlogContent: string, id: string): string | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[${escaped}\\]\\(([^)]+)\\)`);
  const line = backlogContent.split("\n").find((raw) => pattern.test(raw));
  const link = line !== undefined ? pattern.exec(line)?.[1]?.trim() : undefined;
  if (link === undefined || link === "") return undefined;
  return link.startsWith("/") ? link : join(projectCwd, link);
}

function readSpecFirstScreen(projectCwd: string, backlogContent: string, id: string): string {
  const specPath = specPathFromBacklogLine(projectCwd, backlogContent, id);
  if (specPath === undefined) return "";
  try {
    return readFileSync(specPath, "utf8").split("\n").slice(0, 80).join("\n").slice(0, 6_000);
  } catch {
    return "";
  }
}

function pickRankingPrompt(projectCwd: string, backlogContent: string, candidates: readonly BacklogItem[]): string {
  const sections = candidates.map((row, index) => {
    const spec = readSpecFirstScreen(projectCwd, backlogContent, row.id);
    const header = `${index + 1}. ${row.id} | ${row.desc} | ${row.status}`;
    return spec === "" ? header : `${header}\nSPEC FIRST SCREEN:\n${spec}`;
  });
  return [
    "Rank these Roll backlog candidates for the next automatic pick.",
    "This is advisory only: owner controls and picker eligibility gates remain authoritative.",
    "Score each card 0-100 using unblock effect, urgency, value density, and risk.",
    'Return JSON only: [{"id":"US-1","score":80,"reason":"one short sentence"}].',
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}

function candidateRowsForRanking(items: readonly BacklogItem[], opts: PickOptions = {}): BacklogItem[] {
  const isDone = buildDoneIndex([...items]);
  return items.filter((row) => /^(FIX|US|REFACTOR)-/.test(row.id) && isEligible(row, isDone, opts));
}

function readPickRankingCache(path: string, key: { backlogHash: string; candidateSetHash: string }): PickRankingEntry[] | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PickRankingCacheFile>;
    if (raw.schema !== "pick-ranking.v1") return undefined;
    if (raw.backlogHash !== key.backlogHash || raw.candidateSetHash !== key.candidateSetHash) return undefined;
    if (!Array.isArray(raw.ranking)) return undefined;
    const parsed = parsePickRankingJson(JSON.stringify(raw.ranking));
    return parsed.ok ? parsed.entries : undefined;
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      /* cache cleanup is advisory */
    }
    return undefined;
  }
}

function writePickRankingCache(path: string, key: { backlogHash: string; candidateSetHash: string }, ranking: readonly PickRankingEntry[], ts: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body: PickRankingCacheFile = {
      schema: "pick-ranking.v1",
      backlogHash: key.backlogHash,
      candidateSetHash: key.candidateSetHash,
      ranking: [...ranking],
      createdAt: ts,
    };
    // No lock: duplicate same-cycle cache misses may race and spawn twice, but
    // the accepted upper bound is two ranking calls; tmp+rename keeps readers
    // from observing a torn JSON file without adding scheduler-wide locking.
    const tmp = join(dirname(path), `.${PICK_RANKING_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    /* cache is advisory */
  }
}

function extractJsonArray(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      /* scan balanced candidates below */
    }
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== "[") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < trimmed.length; j += 1) {
      const ch = trimmed[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
      } else if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(i, j + 1);
          try {
            if (Array.isArray(JSON.parse(candidate))) return candidate;
          } catch {
            /* try the next balanced candidate */
          }
          break;
        }
      }
    }
  }
  return trimmed;
}

function appendPickRankingFailure(ports: Ports, reason: string): void {
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "harness_failure",
      channel: "US-LOOP-090",
      operation: "pick.semantic_ranking",
      reason,
      detail: "semantic ranking failed open",
      ts: eventTs(ports),
    });
  } catch {
    /* fail-open */
  }
}

export async function resolvePickRanking(
  ports: Ports,
  ctx: CycleContext,
  items: readonly BacklogItem[],
  eligibility: PickOptions,
): Promise<{ ranking: PickRankingEntry[]; source: "agent" | "cache" } | undefined> {
  if (semanticRankingPolicy(ports.repoCwd) === "off") return undefined;
  const candidates = candidateRowsForRanking(items, eligibility);
  if (candidates.length < 2) return undefined;

  const backlogContent = backlogContentForRanking(ports.repoCwd, items);
  const key = buildPickRankingCacheKey(backlogContent, candidates);
  const cachePath = pickRankingCachePath(ports);
  const cached = readPickRankingCache(cachePath, key);
  if (cached !== undefined) return { ranking: cached, source: "cache" };

  const route = ports.route.resolve("PICK-RANKING", undefined);
  if (!agentSpawnSupportsPurpose(ports.agentSpawn, "pick_ranking")) {
    appendPickRankingFailure(ports, "unsupported_purpose");
    return undefined;
  }
  const prompt = pickRankingPrompt(ports.repoCwd, backlogContent, candidates);
  let result: Awaited<ReturnType<AgentSpawn>>;
  const rankingCwd = pickRankingCwd(ports);
  try {
    // US-CYCLE-002: even the pre-cycle pick-ranking spawn is watchdog-wrapped
    // (evaluator role) so NO spawn path bypasses the watchdog; its own short
    // PICK_RANKING_TIMEOUT_MS stays the primary cap for this quick harness call.
    result = (
      await spawnWatched({
        ports,
        ctx,
        purpose: "pick_ranking",
        agent: route.agent,
        ...(route.model !== undefined ? { model: route.model } : {}),
        observeCwd: rankingCwd,
        run: () =>
          ports.agentSpawn(route.agent, {
            purpose: "pick_ranking",
            cwd: rankingCwd,
            skillBody: prompt,
            timeoutMs: PICK_RANKING_TIMEOUT_MS,
            bare: true,
            model: route.model,
          }),
      })
    ).result;
  } catch {
    appendPickRankingFailure(ports, "spawn_failed");
    return undefined;
  }
  if (result.timedOut) {
    appendPickRankingFailure(ports, "timeout");
    return undefined;
  }
  if (result.exitCode !== 0) {
    appendPickRankingFailure(ports, "exit_nonzero");
    return undefined;
  }
  const parsed = parsePickRankingJson(extractJsonArray(result.stdout), candidates);
  if (!parsed.ok) {
    appendPickRankingFailure(ports, parsed.reason);
    return undefined;
  }
  writePickRankingCache(cachePath, key, parsed.entries, eventTs(ports));
  return { ranking: parsed.entries, source: "agent" };
}

export function appendPickRankedEvent(
  ports: Ports,
  ctx: CycleContext,
  storyId: string,
  resolved: { ranking: PickRankingEntry[]; source: "agent" | "cache" } | undefined,
): void {
  if (resolved === undefined) return;
  const picked = rankingEntryForPicked(storyId, resolved.ranking);
  if (picked === undefined) return;
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "pick:ranked",
      cycleId: ctx.cycleId,
      picked: storyId,
      rank: picked.rank,
      total: picked.total,
      reason: picked.entry.reason,
      ranking: resolved.ranking.map((entry) => ({ id: entry.id, score: entry.score, reason: entry.reason })),
      source: resolved.source,
      ts: eventTs(ports),
    });
  } catch {
    /* advisory event only */
  }
}
