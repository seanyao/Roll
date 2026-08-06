/**
 * @responsibility Restores resume truth for interrupted cycles.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resumeCandidateBranches } from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";
import { findStatusMarker, STATUS_MARKER, type TerminalOutcome } from "@roll/spec";
import { cardArchiveDir, reportFileName } from "../lib/archive.js";
import type { Ports } from "./ports.js";
import { readRunsRows } from "./run-records.js";

/** RESUME-PRIOR-WORK kill switch — set `ROLL_LOOP_NO_RESUME=1` to force the I12
 *  fresh-context default (always base the worktree on origin/main). */
export const RESUME_DISABLED_ENV = "ROLL_LOOP_NO_RESUME";

/** True when resume-prior-work is disabled via {@link RESUME_DISABLED_ENV}. The
 *  feature is default-ON (serves the no-waste intent); set the env to 1 to disable. */
function resumeDisabled(): boolean {
  return (process.env[RESUME_DISABLED_ENV] ?? "").trim() === "1";
}

/**
 * RESUME-PRIOR-WORK — resolve the git base ref the cycle worktree should branch
 * off. Default-ON; the result is `origin/main` (fresh-context, byte-identical to
 * the pre-resume behaviour) UNLESS the picked card has a prior un-merged cycle
 * branch that cleanly rebases onto origin/main, in which case it returns that
 * branch (`origin/loop/cycle-<id>`) so the new cycle RESUMES the prior work.
 *
 * Selection (keys purely on the runs ledger + git — uniform for every agent):
 *   1. disabled (ROLL_LOOP_NO_RESUME=1) or no storyId → origin/main.
 *   2. {@link resumeCandidateBranches} maps the card → its branch-pushing cycle
 *      branches, MOST-RECENT-FIRST (runs ledger story_id↔cycle_id link).
 *   3. for each candidate, fetch it, then keep the first that is (a) NOT merged
 *      into origin/main AND (b) cleanly rebases onto origin/main → resume on it.
 *   4. when a resumable branch EXISTED but none cleanly rebased, emit an ALERT so
 *      the operator knows resume was skipped, then fall back to origin/main.
 *
 * Best-effort by contract: a probe that throws degrades to origin/main — the
 * resume optimization must NEVER topple a cycle that fresh-context would run.
 */
export async function resolveResumeBase(
  ports: Ports,
  storyId: string | undefined,
): Promise<string> {
  // E1: the fresh-context base is the project's configured integration branch
  // (default origin/main → byte-identical to the pre-config behaviour). Resolved
  // once and used as the fallback AND the ancestor/rebase target for the probes.
  const FRESH = resolveIntegrationBranch(ports.repoCwd);
  if (resumeDisabled()) return FRESH;
  if (storyId === undefined || storyId.trim() === "") return FRESH;
  try {
    const rows = readRunsRows(ports.paths.runsPath);
    const candidates = resumeCandidateBranches(rows, storyId);
    if (candidates.length === 0) return FRESH;
    let sawUnmergedConflict = false;
    for (const branch of candidates) {
      const { fetched } = await ports.git.fetchRemoteBranch(ports.repoCwd, branch);
      if (!fetched) continue; // branch gone from origin → nothing to resume here.
      const prState = await ports.github.prState(ports.repoCwd, branch).catch(() => "UNKNOWN");
      if (prState === "CLOSED") {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `resume-prior-work: ${storyId} skips prior branch ${branch} because its PR is CLOSED — starting from ${FRESH} unless explicitly rescued`,
        );
        continue;
      }
      // Condition (a): a branch already merged into the integration branch has
      // nothing to resume — its work is on main; the next candidate (older) may
      // still hold un-merged work, so keep scanning.
      if (await ports.git.branchMergedIntoMain(ports.repoCwd, branch, FRESH)) continue;
      // Condition (b): only a clean rebase is safe to spawn into. A conflicting
      // un-merged branch is the "resumable existed but skipped" case → ALERT.
      if (await ports.git.branchCleanlyRebasesOntoMain(ports.repoCwd, branch, FRESH)) {
        ports.events.appendAlert(
          ports.paths.alertsPath,
          `resume-prior-work: cycle for ${storyId} resumes un-merged branch ${branch} (rebased onto origin/main) instead of redoing from scratch`,
        );
        return `origin/${branch}`;
      }
      sawUnmergedConflict = true;
    }
    if (sawUnmergedConflict) {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `resume-prior-work: ${storyId} has un-merged prior cycle work but it does NOT cleanly rebase onto origin/main — resume SKIPPED; starting fresh from origin/main (manual rescue needed)`,
      );
    }
    return FRESH;
  } catch {
    /* resume is an optimization — never topple the cycle on a probe blip */
    return FRESH;
  }
}

/**
 * FIX-304 — enforce done ≡ merged at the cycle terminal: undo a PREMATURE
 * ✅ Done the agent wrote into the backlog when this cycle did NOT merge.
 *
 * The roll-build / roll-fix skills instruct the agent to mark its card Done in
 * `.roll/backlog.md`, which FIX-204C SYMLINKS into the cycle worktree — so the
 * agent's edit lands in the REAL `.roll`. If the cycle never merges (it failed,
 * was blocked, or the PR is still open), that premature Done persists, showing a
 * card Done with no commit on main (the observed FIX-284 / FIX-285 false-Done).
 *
 * The undo is SCOPED to THIS cycle's own story id — it is the row this cycle
 * just claimed and (in a non-merged terminal) the agent just falsely flipped, so
 * it is distinct from a genuine pre-card-era Done (which is never this cycle's
 * picked story). We revert ONLY when the row is currently ✅ Done; a delivered
 * row that already rests at 🔨 In Progress (pending merge) is left untouched.
 * The target is the pre-cycle status captured at pick time (typically 📋 Todo);
 * when it was unread or itself Done (a re-run of an already-Done card), fall back
 * to 📋 Todo so a non-merged story is left re-pickable, never falsely Done.
 */
/**
 * US-AGENT-042 — is the story CURRENTLY parked at 🚫 Hold in the main backlog?
 * A self-downgrade cycle flips the picked card to Hold (and appends its
 * sub-stories) mid-cycle, then exits with no commits → an idle terminal. The
 * idle-terminal reconcile must NOT flip that authoritative Hold back to Todo, or
 * the too-big card is re-picked forever. Best-effort read (mirrors
 * {@link revertPrematureDone}); a read blip returns false so the normal release
 * still runs.
 */
export function isParkedAtHold(ports: Ports, storyId: string): boolean {
  try {
    const rows = ports.backlog.read(ports.repoCwd) as Array<{ id: string; status?: string }>;
    const row = rows.find((r) => r.id === storyId);
    if (row === undefined) return false;
    return findStatusMarker(row.status ?? "") === STATUS_MARKER.hold;
  } catch {
    return false;
  }
}

export function revertPrematureDone(ports: Ports, storyId: string, preCycleStatus: string | undefined): void {
  try {
    const rows = ports.backlog.read(ports.repoCwd) as Array<{ id: string; status?: string }>;
    const row = rows.find((r) => r.id === storyId);
    if (row === undefined) return;
    const current = findStatusMarker(row.status ?? "");
    // Only a ✅ Done row is a premature flip to undo; anything else is correct.
    if (current !== STATUS_MARKER.done) return;
    const captured = findStatusMarker(preCycleStatus ?? "");
    const target = captured !== undefined && captured !== STATUS_MARKER.done ? captured : STATUS_MARKER.todo;
    ports.backlog.markStatus?.(ports.repoCwd, storyId, target);
  } catch {
    /* best-effort: the terminal must never fail on a backlog read/write blip */
  }
}

/**
 * Hook 3 — the PURE spec-truth reset transform. Given a card's `spec.md` text,
 * undo a STALE "done" claim so a re-run reads an honest, workable spec:
 *   - the H1 title's trailing "✅" tick (e.g. `# FIX-167 ✅`) is dropped;
 *   - a `**Status**: ✅ Done` / `✅ Fixed` line is reset to `📋 Todo`;
 *   - every checked AC checkbox `- [x]` / `- [X]` is reset to `- [ ]`;
 *   - unambiguous delivery-stamp sections (`**Fixed**`, `**Delivery notes**`,
 *     `**Delivery:**`, `## Delivery notes`) — which a planner never authors — are
 *     always stripped so a failed/unpublished cycle cannot leave a spec that
 *     looks completed.
 *
 * FIX-1043 — narrative sections (`**Problem**`, `**Root Cause**`, `**Solution**`)
 * are ALSO standard planner-authored fix-spec content, so they are NOT stripped
 * by label. They are removed ONLY when a pre-cycle `baseline` proves the failed
 * cycle ADDED them (the same header label is absent from the baseline). Without a
 * baseline they are PRESERVED: erasing legitimate Problem/Root Cause/Solution
 * spec content is strictly worse than leaving an agent-added narrative, which
 * satisfies no Done/release/delivery-truth gate (those key off the ✅ tick, the
 * Status line, the `[x]` checkboxes, and the evidence artifacts — all handled
 * here and by {@link cleanStaleEvidence}).
 *
 * Idempotent: a spec with no ticks/checks/delivery sections is returned
 * unchanged (so the caller can skip a no-op commit). Pure string→string —
 * unit-tested directly.
 */
export function resetSpecTruthText(text: string, baseline?: string): { text: string; changed: boolean } {
  let changed = false;
  const lines = text.split("\n");
  // Unambiguous delivery stamps a planner never writes — always removable.
  const deliveryStampRe =
    /^(?:\s*>\s*)?(?:\*\*(?:Fixed|Delivery(?:\s+notes)?)\b[^*]*\*\*|##\s+Delivery\s+notes\b)/i;
  // Narrative sections that double as legitimate planner spec content. Only
  // removable when proven agent-added against the pre-cycle baseline.
  const narrativeLabelRe = /^(?:\s*>\s*)?(?:\*\*|##\s+)(Problem|Root Cause|Solution)\b/i;
  const baselineNarrativeLabels = collectNarrativeLabels(baseline, narrativeLabelRe);
  // A removable section ends at the next markdown heading or bold-label line.
  // Bold labels are recognized whether the colon sits inside (`**Files:**`) or
  // outside (`**Fixed**:`) the markers so legitimate spec sections are preserved.
  const boundaryRe = /^(?:\s*>\s*)?(?:\*\*[^*]+(?:\*\*\s*[:：]|:\*\*)|#{1,2}\s)/;
  let inRemovableSection = false;
  const out: string[] = [];

  for (const line of lines) {
    if (inRemovableSection) {
      if (boundaryRe.test(line)) {
        inRemovableSection = false;
        // fall through to process the boundary line normally
      } else {
        changed = true;
        continue;
      }
    }

    if (deliveryStampRe.test(line)) {
      inRemovableSection = true;
      changed = true;
      continue;
    }

    // Narrative section: strip ONLY when the baseline proves the failed cycle
    // added it (its label is not present in the pre-cycle baseline). With no
    // baseline, or when the planner already authored this section, preserve it.
    const narrativeMatch = narrativeLabelRe.exec(line);
    if (narrativeMatch !== null && narrativeMatch[1] !== undefined) {
      const label = narrativeMatch[1].toLowerCase();
      if (baseline !== undefined && !baselineNarrativeLabels.has(label)) {
        inRemovableSection = true;
        changed = true;
        continue;
      }
    }

    // H1 title trailing tick: `# <ID> ✅` → `# <ID>`.
    if (/^#\s/.test(line) && /[✅✔]\s*$/.test(line)) {
      changed = true;
      out.push(line.replace(/\s*[✅✔]\s*$/, ""));
      continue;
    }
    // Status line claiming done/fixed → reset to Todo (preserve any trailer text
    // after the marker, e.g. parenthetical PR notes, by dropping the false claim).
    if (/^\*\*Status\*\*\s*:/.test(line) && /[✅✔]\s*(Done|Fixed|Fix)\b/i.test(line)) {
      changed = true;
      out.push("**Status**: 📋 Todo");
      continue;
    }
    // Checked AC checkbox → unchecked.
    if (/^(\s*[-*]\s+)\[[xX]\]/.test(line)) {
      changed = true;
      out.push(line.replace(/^(\s*[-*]\s+)\[[xX]\]/, "$1[ ]"));
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), changed };
}

/**
 * FIX-1043 — collect the set of lowercased narrative-section labels
 * (`problem`, `root cause`, `solution`) present in a pre-cycle spec baseline, so
 * {@link resetSpecTruthText} can tell planner-authored sections (preserve) from
 * failed-cycle-added ones (strip). Returns an empty set when no baseline.
 */
function collectNarrativeLabels(baseline: string | undefined, labelRe: RegExp): Set<string> {
  const labels = new Set<string>();
  if (baseline === undefined) return labels;
  for (const line of baseline.split("\n")) {
    const m = labelRe.exec(line);
    if (m !== null && m[1] !== undefined) labels.add(m[1].toLowerCase());
  }
  return labels;
}

/**
 * FIX-1043 — read the pre-cycle committed baseline of a card's spec.md from the
 * roll-meta repo (`git show HEAD:<relpath>`). Used to distinguish planner-authored
 * narrative sections from failed-cycle-added ones. Best-effort: returns undefined
 * when the path is untracked / git is unavailable, in which case
 * {@link resetSpecTruthText} preserves narrative sections rather than risk
 * destroying legitimate spec content.
 */
function readSpecBaseline(specPath: string): string | undefined {
  try {
    const dir = dirname(specPath);
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top === "") return undefined;
    let rel = specPath.startsWith(top) ? specPath.slice(top.length) : specPath;
    rel = rel.replace(/^[/\\]+/, "");
    const out = execFileSync("git", ["-C", top, "show", `HEAD:${rel}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Hook 3 — apply {@link resetSpecTruthText} to the card's spec.md on disk (read
 * via the symlinked .roll inside the worktree → the REAL .roll). Best-effort: a
 * missing/unreadable spec or a no-op (no stale claim) leaves the tree untouched;
 * the actual roll-meta commit is the caller's {@link commitRollMetadata}.
 */
export function resetStaleSpecTruth(ports: Ports, storyId: string): void {
  try {
    const specPath = join(cardArchiveDir(ports.repoCwd, storyId), "spec.md");
    if (!existsSync(specPath)) return;
    const before = readFileSync(specPath, "utf8");
    const baseline = readSpecBaseline(specPath);
    const { text, changed } = resetSpecTruthText(before, baseline);
    if (!changed) return;
    writeFileSync(specPath, text);
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `spec truth reset for ${storyId}: a non-merged terminal cleared a stale ✅/[x] spec claim so a re-run can deliver`,
    );
  } catch {
    /* best-effort: a spec read/write blip must never fail the cycle terminal */
  }
}

/**
 * FIX-1043 — on a non-merged terminal, move any authoritative-looking delivery
 * evidence out of the paths the attest / consistency / release gates inspect,
 * so a failed/skipped-attest/unpublished cycle cannot poison roll-meta as if it
 * had delivered. Diagnostic artifacts are preserved under
 * `<cardArchiveDir>/failed-diagnostics/` with a clear label; they do NOT satisfy
 * Done, release, or delivery-truth gates.
 *
 * FIX-1063 — a `published_pending_merge` terminal is a gate-passing pending-merge
 * state, not a failure. Its evidence must remain visible in the standard
 * `latest/<ID>-report.html` + `ac-map.json` paths so supervisors can distinguish
 * "waiting for PR merge" from "delivery evidence failed".
 *
 * Targets:
 *   - `ac-map.json` at the card root (the attest gate reads this as acceptance
 *     intent).
 *   - `<ID>-report.html` reachable via the `latest/` symlink (the consistency
 *     audit and announceReport treat this as delivered evidence).
 *
 * The `latest/` symlink itself is removed so the gate's primary candidate path
 * no longer resolves.
 */
export function cleanStaleEvidence(
  projectCwd: string,
  storyId: string,
  cycleId: string,
  outcome?: TerminalOutcome,
): void {
  try {
    // FIX-1063: pending-merge terminals keep their gate-passing evidence in the
    // standard paths; do not archive it as failed diagnostics.
    if (outcome === "published_pending_merge") return;

    const cardDir = cardArchiveDir(projectCwd, storyId);
    if (!existsSync(cardDir)) return;

    const diagDir = join(cardDir, "failed-diagnostics");
    mkdirSync(diagDir, { recursive: true });

    const reportName = reportFileName(storyId);
    const latestReport = join(cardDir, "latest", reportName);
    if (existsSync(latestReport)) {
      renameSync(latestReport, join(diagDir, reportName));
    }

    const acMap = join(cardDir, "ac-map.json");
    if (existsSync(acMap)) {
      renameSync(acMap, join(diagDir, "ac-map.json"));
    }

    const latestLink = join(cardDir, "latest");
    if (existsSync(latestLink)) {
      const st = lstatSync(latestLink);
      if (st.isSymbolicLink() || st.isDirectory()) {
        rmSync(latestLink, { recursive: true, force: true });
      }
    }

    const readme = join(diagDir, "README.md");
    if (!existsSync(readme)) {
      writeFileSync(
        readme,
        `# Failed-cycle diagnostics\n\n` +
          `Artifacts in this directory were produced by a cycle that did NOT merge to main. ` +
          `They are retained for debugging only and MUST NOT be treated as delivery evidence.\n\n` +
          `- cycle: ${cycleId}\n` +
          `- story: ${storyId}\n`,
        "utf8",
      );
    }
  } catch {
    /* best-effort: evidence cleanup must never fail the cycle terminal */
  }
}
