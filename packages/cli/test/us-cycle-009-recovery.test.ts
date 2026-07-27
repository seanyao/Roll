/**
 * US-CYCLE-009 (codex r3) — migration recovery for r1-window leftovers.
 *
 * The r1 build (live on main ~3 days) emitted `delivery:reconciled` for
 * gh-merged-but-not-git-plane-confirmed cards WITHOUT the git-plane gate. Those
 * cycles project `delivered`, so the tick filter used to EXCLUDE them → stuck
 * delivered-but-unflipped. The recovery re-includes such a card IFF it has NO
 * `delivery:merge_confirmed` AND its story is NOT ✅ Done — scoped to ONLY the
 * r1-window leftovers (no delivery-history re-processing).
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PrCloudState, PrStatusProvider } from "@roll/core";
import { runReconcileTick } from "../src/commands/loop-reconcile.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
function withoutGitEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of GIT_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    return fn();
  } finally {
    for (const k of GIT_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
async function withoutGitEnvAsync<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of GIT_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    return await fn();
  } finally {
    for (const k of GIT_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const git = (cwd: string, cmd: string): void => execSync(`git ${cmd}`, { cwd, stdio: "ignore" });

const CYCLE = "20260724-000000-1";
const STORY = "US-CYCLE-009";
const PR = 42;
const TS = 1_779_000_000_000;

function fakeProvider(state: PrCloudState): PrStatusProvider {
  return { name: "fake", async pollPrStatus(): Promise<PrCloudState> { return state; } };
}

const MERGED: PrCloudState = { kind: "merged", mergeCommit: "abc1234def", mergedAt: "2026-07-24T00:00:00Z", checkedAt: "2026-07-24T00:00:00Z" };

/** A project whose PR #42 is genuinely merged on main (`(#42)` squash commit)
 *  and whose event stream carries the r1-leftover shape:
 *  delivery:published + delivery:reconciled, but NO delivery:merge_confirmed.
 *  `extraEvents` / `backlogStatus` let each test shape the control conditions. */
function r1LeftoverProject(opts: { backlogStatus: string; withMergeConfirmed?: boolean; landMergeCommit?: boolean }): string {
  return withoutGitEnv(() => {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-uscycle009-recov-")));
    dirs.push(p);
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    git(p, "init -q");
    git(p, "config user.email test@roll.local");
    git(p, "config user.name Test");
    git(p, "checkout -q -b main");
    git(p, "commit -q --allow-empty -m init");
    git(p, "remote add origin https://github.com/owner/repo.git");
    if (opts.landMergeCommit !== false) {
      // The PR's squash commit is on main (the git plane can confirm it).
      git(p, `commit -q --allow-empty -m 'squash: ${STORY} recovery (#${PR})'`);
    }
    // backlog row (NOT Done for the recovery case; Done for the control).
    writeFileSync(
      join(p, ".roll", "backlog.md"),
      `## Epic: Test\n\n| ID | Description | Status |\n|----|----|----|\n| ${STORY} | async merge | ${opts.backlogStatus} |\n`,
    );
    // acceptance evidence so the flip lands as plain Done.
    const cardDir = join(p, ".roll", "features", "test", STORY);
    mkdirSync(join(cardDir, "latest"), { recursive: true });
    mkdirSync(join(cardDir, "screenshots"), { recursive: true });
    writeFileSync(join(cardDir, "screenshots", "proof.png"), "png\n");
    writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([{ ac: `${STORY}:AC1`, status: "pass", evidence: [{ kind: "screenshot", href: "screenshots/proof.png" }] }]) + "\n");
    writeFileSync(join(cardDir, "latest", `${STORY}-report.html`), "<html>report</html>\n");

    const events: Record<string, unknown>[] = [
      { type: "cycle:start", cycleId: CYCLE, storyId: STORY, ts: TS },
      { type: "delivery:published", cycleId: CYCLE, storyId: STORY, branch: `loop/${CYCLE}`, prNumber: PR, prUrl: "u", ts: TS + 1 },
      // r1 credited WITHOUT the git-plane gate → terminal marker but no merge_confirmed.
      { type: "delivery:reconciled", cycleId: CYCLE, storyId: STORY, state: "delivered_external", mergedBy: "external", mergeCommit: "abc1234def", signal: "pr_state", ts: TS + 2 },
    ];
    if (opts.withMergeConfirmed === true) {
      events.push({ type: "delivery:merge_confirmed", cycleId: CYCLE, storyId: STORY, branch: `loop/${CYCLE}`, prNumber: PR, signal: "merge_commit", ts: TS + 3 });
    }
    writeFileSync(join(p, ".roll", "loop", "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return p;
  });
}

const backlog = (p: string): string => readFileSync(join(p, ".roll", "backlog.md"), "utf8");
function events(p: string): Record<string, unknown>[] {
  return readFileSync(join(p, ".roll", "loop", "events.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("US-CYCLE-009 (codex r3) — migration recovery of r1-window leftovers", () => {
  it("stuck r1 leftover (delivered, no merge_confirmed, story NOT Done) → RE-INCLUDED → flips + merge_confirmed", async () => {
    const p = r1LeftoverProject({ backlogStatus: "🔨 In Progress" });
    const r = await withoutGitEnvAsync(() => runReconcileTick(p, { silent: true, provider: fakeProvider(MERGED) }));
    // The stuck cycle was re-included and processed.
    expect(r.cyclesProcessed).toBeGreaterThanOrEqual(1);
    // Git plane confirmed via the (#42) commit → missing marker emitted + flip.
    expect(events(p).find((e) => e.type === "delivery:merge_confirmed" && e["signal"] === "merge_commit" && e["cycleId"] === CYCLE)).toBeDefined();
    expect(backlog(p)).toContain("✅ Done");
    // Idempotent: a second tick now finds Done + merge_confirmed → NOT re-included.
    const r2 = await withoutGitEnvAsync(() => runReconcileTick(p, { silent: true, provider: fakeProvider(MERGED) }));
    expect(r2.cyclesProcessed).toBe(0);
    // No duplicate credit.
    expect(events(p).filter((e) => e.type === "delivery:reconciled" && e["state"] === "delivered_external")).toHaveLength(1);
  });

  it("control: a delivered card already ✅ Done is NOT re-included (no history re-processing)", async () => {
    const p = r1LeftoverProject({ backlogStatus: "✅ Done" });
    const r = await withoutGitEnvAsync(() => runReconcileTick(p, { silent: true, provider: fakeProvider(MERGED) }));
    expect(r.cyclesProcessed).toBe(0);
    expect(events(p).find((e) => e.type === "delivery:merge_confirmed")).toBeUndefined();
  });

  it("control: a delivered card that already has delivery:merge_confirmed is NOT re-included", async () => {
    const p = r1LeftoverProject({ backlogStatus: "🔨 In Progress", withMergeConfirmed: true });
    const r = await withoutGitEnvAsync(() => runReconcileTick(p, { silent: true, provider: fakeProvider(MERGED) }));
    expect(r.cyclesProcessed).toBe(0);
    // exactly the one seeded merge_confirmed remains.
    expect(events(p).filter((e) => e.type === "delivery:merge_confirmed")).toHaveLength(1);
    // backlog untouched (stays In Progress — the properly-settled marker excludes it).
    expect(backlog(p)).toContain("🔨 In Progress");
  });
});
