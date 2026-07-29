/**
 * US-CYCLE-007 — runner glue for the repair-round warm-start briefing.
 *
 * The PURE packaging/budget/manifest logic lives in `@roll/core`
 * (cycle/repair-briefing). This handler is the thin I/O layer the runner calls on
 * a REPAIR re-dispatch (a low-peer-score re-pick, spawn-agent-handler): it gathers
 * the evaluator findings, the cycle's `git diff --stat` + involved files:lines, and
 * the design-contract references, builds the checksummed briefing, writes the
 * artifact + its v2 manifest into the cycle's evidence dir, and returns the
 * prompt-ready lead text so the fresh session starts from the findings instead of
 * re-reading the repo.
 *
 * Best-effort: any gather/write blip returns null (or a briefing without a
 * persisted manifest) so the spawn NEVER fails on this aid — the caller falls back
 * to the prior low-score fix-forward prompt.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildRepairBriefing,
  buildRepairBriefingManifest,
  parseInvolvedFilesFromDiff,
  type CycleContext,
  type RepairBriefingInput,
} from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";
import { cardArchiveDir } from "../lib/archive.js";
import { readLatestStoryReviewScore, readStoryReviewScores } from "../lib/review-score.js";
import type { Ports } from "./ports.js";

const execFileAsync = promisify(execFile);

const BRIEFING_REL_DIR = join("role-artifacts", "repair-briefing");
const BRIEFING_FILE = "briefing.md";
const BRIEFING_MANIFEST = "artifact-manifest.json";

/** Strip a leading YAML frontmatter block so the findings read as prose. */
function stripFrontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(text);
  return (m?.[1] ?? text).trim();
}

/** Resolve the FULL evaluator findings text + the on-disk path to cite when the
 *  briefing truncates them. Prefers the evaluator's authored eval-report.md
 *  (US-DELTA-007), then the review-score note file, then the parsed note blurb. */
function resolveFindings(
  ports: Ports,
  ctx: CycleContext,
  storyId: string,
): { findings: string; fullFindingsPath: string } {
  const evalReport =
    ctx.evidenceRunDir !== undefined && ctx.evidenceRunDir !== ""
      ? join(ctx.evidenceRunDir, "role-artifacts", "evaluator", "eval-report.md")
      : "";
  if (evalReport !== "" && existsSync(evalReport)) {
    try {
      const text = readFileSync(evalReport, "utf8").trim();
      if (text !== "") return { findings: text, fullFindingsPath: evalReport };
    } catch {
      /* fall through to the review note */
    }
  }
  const entry = readLatestStoryReviewScore(ports.repoCwd, storyId);
  if (entry !== undefined) {
    try {
      const noteText = stripFrontmatter(readFileSync(entry.sourcePath, "utf8"));
      if (noteText !== "") return { findings: noteText, fullFindingsPath: entry.sourcePath };
    } catch {
      /* fall through to the parsed blurb */
    }
    return { findings: entry.note, fullFindingsPath: entry.sourcePath };
  }
  return { findings: "", fullFindingsPath: evalReport };
}

/** Gather `git diff --stat` and the involved files:lines for the cycle changes. */
async function gatherDiff(
  execCwd: string,
  diffBase: string,
): Promise<{ diffStat: string; involvedFiles: RepairBriefingInput["involvedFiles"] }> {
  let diffStat = "";
  let involvedFiles: RepairBriefingInput["involvedFiles"] = [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", `${diffBase}...HEAD`], {
      cwd: execCwd,
      encoding: "utf8",
      maxBuffer: 8_000_000,
    });
    diffStat = stdout.slice(0, 4_000);
  } catch {
    /* diff-stat degrades to empty */
  }
  try {
    // -U0: hunk headers only (no bodies) → line ranges without the diff bulk.
    const { stdout } = await execFileAsync("git", ["diff", "-U0", `${diffBase}...HEAD`], {
      cwd: execCwd,
      encoding: "utf8",
      maxBuffer: 16_000_000,
    });
    involvedFiles = parseInvolvedFilesFromDiff(stdout);
  } catch {
    /* file:lines degrade to empty */
  }
  return { diffStat, involvedFiles };
}

/** Resolve design-contract references from the story spec (its path + design_plan). */
function resolveContractRefs(repoCwd: string, storyId: string): string[] {
  const refs: string[] = [];
  try {
    const specPath = join(cardArchiveDir(repoCwd, storyId), "spec.md");
    if (existsSync(specPath)) {
      refs.push(specPath);
      const plan = /^design_plan:\s*(.+)$/m.exec(readFileSync(specPath, "utf8"))?.[1]?.trim();
      if (plan !== undefined && plan !== "") refs.push(plan);
    }
  } catch {
    /* no spec → no contract refs (briefing still valid) */
  }
  return refs;
}

/**
 * Build the repair-round briefing for the current cycle, PERSIST it together with
 * its v2 manifest under the evidence dir, and return the prompt-ready lead text
 * (the SOLE context entry point for the fresh session) + the relative artifact
 * path.
 *
 * AC1 contract: a briefing is only valid TOGETHER WITH its recorded v2 manifest —
 * a lead text used as context must have its manifest on disk. So this returns null
 * (⇒ caller falls back to the plain fix-forward prompt, no inline briefing) when:
 *   - there is no story / no prior findings to warm-start from, OR
 *   - there is NO evidence dir to record the manifest in, OR
 *   - persisting the briefing or its manifest FAILS.
 * It never returns an UNRECORDED inline briefing.
 */
export async function buildRepairRoundBriefing(
  ports: Ports,
  ctx: CycleContext,
  execCwd: string,
  execRepoCwd: string,
): Promise<{ leadText: string; artifactPath: string } | null> {
  const storyId = ctx.storyId ?? "";
  if (storyId === "") return null;
  // No evidence dir ⇒ nowhere to RECORD the manifest ⇒ no valid briefing. Bail
  // BEFORE any gather so the caller falls back to the plain fix-forward prompt.
  const evidenceRunDir = ctx.evidenceRunDir ?? "";
  if (evidenceRunDir === "") return null;

  // Repair round index: one prior peer score note per repair re-dispatch.
  let round = 1;
  try {
    round = Math.max(1, readStoryReviewScores(ports.repoCwd, storyId).length);
  } catch {
    /* keep round=1 */
  }
  const { findings, fullFindingsPath } = resolveFindings(ports, ctx, storyId);
  if (findings === "") return null; // nothing to warm-start from

  const diffBase = resolveIntegrationBranch(execRepoCwd);
  const { diffStat, involvedFiles } = await gatherDiff(execCwd, diffBase);
  const contractRefs = resolveContractRefs(ports.repoCwd, storyId);

  const briefing = buildRepairBriefing({
    storyId,
    round,
    findings,
    diffStat,
    involvedFiles,
    contractRefs,
    fullFindingsPath,
  });

  const artifactPath = join(BRIEFING_REL_DIR, BRIEFING_FILE);

  // Persist the artifact + its v2 manifest. This is REQUIRED, not best-effort: a
  // write failure ⇒ the briefing has no recorded manifest ⇒ return null so the
  // caller uses the plain fix-forward prompt instead of an unrecorded briefing.
  try {
    const dir = join(evidenceRunDir, BRIEFING_REL_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, BRIEFING_FILE), briefing.content, "utf8");
    const manifest = buildRepairBriefingManifest({
      storyId,
      cycleId: ctx.cycleId,
      delegationId: ctx.cycleId ?? "cycle",
      hostId: hostname(),
      roleInstanceId: `${ctx.cycleId ?? "cycle"}:repair-briefing:${ctx.agent ?? "runner"}`,
      modelId: ctx.model !== undefined && ctx.model !== "" ? ctx.model : ctx.agent ?? "unknown",
      sessionId: `${ctx.cycleId ?? "cycle"}:repair-briefing:${ports.clock()}`,
      adapter: ctx.agent ?? "runner",
      qualityProfile: ctx.selectedProfile ?? "standard",
      artifactPath,
      briefing,
      createdAt: new Date().toISOString(),
    });
    writeFileSync(join(dir, BRIEFING_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    return null; // no recorded manifest ⇒ no valid briefing ⇒ fall back to plain prompt
  }

  return { leadText: briefing.content, artifactPath };
}
