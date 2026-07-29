import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CycleContext } from "@roll/core";
import { markStatusExact } from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";
import type { Ports } from "./ports.js";

// ── FIX-1238 / FIX-1475: in-repo layout backlog durability ───────────────────

/**
 * Detect whether `.roll` is part of the main repo (in-repo layout) rather than
 * its own independent git repo (nested roll-meta layout). For in-repo layout,
 * `commitRollMetadata` is a no-op — the backlog.md flip must be made durable on
 * origin/main explicitly ({@link commitInRepoBacklog}).
 */
export function isInRepoRollLayout(worktreePath: string): boolean {
  try {
    const rollDir = join(worktreePath, ".roll");
    if (!existsSync(rollDir)) return false;
    const top = execFileSync("git", ["-C", rollDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top === "") return false;
    const topReal = realpathSync(top);
    const rollReal = realpathSync(rollDir);
    return topReal !== rollReal;
  } catch {
    return false;
  }
}

/** A git object id — SHA-1 (40 hex) or SHA-256 (64 hex). */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

// A deterministic committer identity for the metadata flip commit. `commit-tree`
// requires author + committer identity; the shared checkout / CI runner may have
// none configured, which would fail the durable push. This bot identity keeps
// the flip working regardless of ambient git config, and never depends on (or
// mutates) the owner's identity.
const FLIP_IDENTITY = {
  GIT_AUTHOR_NAME: "roll-loop",
  GIT_AUTHOR_EMAIL: "roll-loop@users.noreply.github.com",
  GIT_COMMITTER_NAME: "roll-loop",
  GIT_COMMITTER_EMAIL: "roll-loop@users.noreply.github.com",
} as const;

/**
 * FIX-1238: for in-repo layout, make the backlog.md status flip durable on the
 * remote. FIX-1475: do it WITHOUT touching the shared main checkout AT ALL.
 *
 * The pre-FIX path committed the flip onto the shared checkout's HEAD and pushed
 * `HEAD:main`, advancing the local `main` ref — clobbering any owner WIP or
 * concurrent dispatch legitimately ahead of origin/main. Reading the flipped
 * WORKING TREE instead would still leave the shared tree dirty and risk
 * publishing an owner's unpushed backlog edits. So we never read or mutate the
 * shared tree: we recompute the transition from the REMOTE backlog. We read
 * the configured integration branch's remote backlog, apply ONLY this story's
 * status transition in memory (exact id — never `<id>-` descendants), assemble
 * a tree with only `.roll/backlog.md` replaced (a throwaway index — the checkout's
 * real index is untouched), and push only that object. The shared checkout's
 * ref, HEAD, index, and
 * working tree stay byte-identical (FIX-1475) while the flip lands durably on
 * the remote (FIX-1238). A racing non-fast-forward push fails LOUD (alert) —
 * never a force-push, never a local reset; the reconciler re-derives Done from
 * the merged PR on a later tick.
 */
export async function commitInRepoBacklog(
  ports: Ports,
  ctx: CycleContext,
  storyId: string,
  doneStatus: string,
): Promise<void> {
  const msg = `chore: ${storyId} status update (cycle ${ctx.cycleId})`;
  const backlogRel = join(".roll", "backlog.md");
  try {
    // Base the flip on the CURRENT remote tip so the pushed object is a clean
    // fast-forward carrying only the backlog change on top of already-merged work.
    const configuredIntegration = resolveIntegrationBranch(ports.repoCwd);
    const integrationBranch = configuredIntegration.startsWith("origin/")
      ? configuredIntegration.slice("origin/".length)
      : configuredIntegration;
    execFileSync("git", ["fetch", "origin", integrationBranch], { cwd: ports.repoCwd, stdio: "ignore" });
    const remoteRef = `refs/remotes/origin/${integrationBranch}`;
    const base = execFileSync("git", ["rev-parse", remoteRef], {
      cwd: ports.repoCwd,
      encoding: "utf8",
    }).trim();
    if (!isObjectId(base)) {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `FIX-1238/FIX-1475: in-repo backlog flip for ${storyId} (cycle ${ctx.cycleId}) skipped — could not resolve ${remoteRef} (got "${base}") — shared checkout untouched`,
      );
      return;
    }
    // Read the REMOTE backlog (never the shared working tree) and apply ONLY this
    // story's transition in memory.
    let originContent = "";
    try {
      originContent = execFileSync("git", ["show", `${base}:${backlogRel}`], {
        cwd: ports.repoCwd,
        encoding: "utf8",
      });
    } catch {
      // The integration branch carries no backlog at this path — nothing to flip durably.
      return;
    }
    const { content: newContent, count } = markStatusExact(originContent, storyId, doneStatus);
    // No matching row on the remote, or it already carries this status → no-op.
    if (count === 0 || newContent === originContent) return;
    // Hash the new content and assemble the tree in a throwaway index so the
    // checkout's REAL index is never touched.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: ports.repoCwd,
      input: newContent,
      encoding: "utf8",
    }).trim();
    const idxPath = join(tmpdir(), `roll-backlog-idx-${ctx.cycleId ?? "nocycle"}-${process.pid}`);
    const env = { ...process.env, ...FLIP_IDENTITY, GIT_INDEX_FILE: idxPath };
    try {
      execFileSync("git", ["read-tree", base], { cwd: ports.repoCwd, env, stdio: "ignore" });
      execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${backlogRel}`], {
        cwd: ports.repoCwd,
        env,
        stdio: "ignore",
      });
      const tree = execFileSync("git", ["write-tree"], {
        cwd: ports.repoCwd,
        env,
        encoding: "utf8",
      }).trim();
      const commit = execFileSync("git", ["commit-tree", tree, "-p", base, "-m", msg], {
        cwd: ports.repoCwd,
        env,
        encoding: "utf8",
      }).trim();
      // Push the OBJECT to the remote branch — the shared checkout is never
      // checked out onto it, so refs/heads/main here stays put.
      execFileSync("git", ["push", "origin", `${commit}:refs/heads/${integrationBranch}`], {
        cwd: ports.repoCwd,
        stdio: "ignore",
      });
    } finally {
      try {
        if (existsSync(idxPath)) unlinkSync(idxPath);
      } catch {
        /* best-effort temp-index cleanup */
      }
    }
  } catch (e) {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `FIX-1238/FIX-1475: in-repo backlog flip push failed for ${storyId} (cycle ${ctx.cycleId}) — shared checkout left untouched — ${String(e)}`,
    );
  }
}
