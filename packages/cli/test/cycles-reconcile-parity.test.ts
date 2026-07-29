/**
 * US-DELIV-008 — parity: the `roll loop cycles` read path and the
 * `roll loop reconcile` command judge the SAME cycle through the SAME single
 * reconcile engine (patch-id `reconcileDelivery`), never through two
 * divergent probes.
 *
 * The load-bearing case: a branch squash-merged onto main under a subject
 * that names NEITHER the story NOR the PR number. The retired subject-match
 * probe (cycleMergeTruth) was blind to such a merge; the patch-id engine
 * sees it. Both surfaces must agree.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "@roll/core";
import { reconciledLedger } from "../src/commands/cycles.js";
import { loopReconcileCommand, type LoopReconcileDeps } from "../src/commands/loop-reconcile.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function withoutGitEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const vars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
  for (const k of vars) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of vars) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const git = (cwd: string, cmd: string): void => {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
};

const CYCLE = "cycle-20260713-010000-00002";
const STORY = "US-DELIV-008";
const TS = "2026-07-13T01:00:00Z";
const TS_MS = Date.parse(TS);

/**
 * A loop project whose cycle published `loop/<CYCLE>` with PR #42, where
 * `merged` controls whether the branch's exact diff has landed on main under
 * an opaque subject (no story-id, no (#42)) — the squash-merge shape the
 * retired subject-match probe could not see.
 */
function cycleProject(merged: boolean): string {
  return withoutGitEnv(() => {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-deliv008-parity-")));
    dirs.push(p);
    git(p, "init -q --bare remote.git");
    git(p, "init -q repo");
    const r = join(p, "repo");
    git(r, "config user.email test@roll.local");
    git(r, "config user.name Test");
    git(r, "checkout -q -b main");
    git(r, "commit -q --allow-empty -m init");
    git(r, "remote add origin ../remote.git");
    git(r, `checkout -q -b loop/${CYCLE}`);
    execSync("echo unified > engine.txt", { cwd: r, shell: "/bin/bash" });
    git(r, "add engine.txt");
    git(r, "commit -q -m 'tcr: US-DELIV-008 unify engine'");
    git(r, "checkout -q main");
    if (merged) {
      execSync("echo unified > engine.txt", { cwd: r, shell: "/bin/bash" });
      git(r, "add engine.txt");
      git(r, "commit -q -m 'chore: opaque squash subject'");
    } else {
      git(r, "commit -q --allow-empty -m 'unrelated main work'");
    }
    git(r, `push -q origin main loop/${CYCLE}`);

    // The loop project's runtime state: one published_pending_merge cycle.
    mkdirSync(join(r, ".roll", "loop"), { recursive: true });
    writeFileSync(
      join(r, ".roll", "loop", "runs.jsonl"),
      JSON.stringify({
        cycle_id: CYCLE,
        status: "published",
        outcome: "published_pending_merge",
        story_id: STORY,
        agent: "kimi",
        ts: TS,
        duration_sec: 300,
        tcr_count: 3,
      }) + "\n",
    );
    writeFileSync(
      join(r, ".roll", "loop", "events.ndjson"),
      [
        { type: "cycle:start", cycleId: CYCLE, storyId: STORY, ts: TS_MS },
        { type: "delivery:published", cycleId: CYCLE, storyId: STORY, branch: `loop/${CYCLE}`, prNumber: 42, prUrl: "u", ts: TS_MS + 1 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    return r;
  });
}

function commandDeps(p: string): LoopReconcileDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  // No provider: gh is unavailable in tests — the command path falls back to
  // the SAME offline facts the read path uses.
  return { cwd: p, bus: new EventBus(), stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, out, err };
}

function readEvents(p: string): Array<Record<string, unknown>> {
  return readFileSync(join(p, ".roll", "loop", "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("US-DELIV-008 — cycles read path judges via the single reconcile engine", () => {
  it("squash-merged branch with an OPAQUE subject (no story-id, no (#N)) → read path shows delivered (patch-id)", () => {
    const p = cycleProject(true);
    const rows = withoutGitEnv(() => reconciledLedger(p));
    const row = rows.find((r) => r.cycleId === CYCLE);
    expect(row).toBeDefined();
    expect(row!.verdict).toBe("delivered");
  });

  it("unmerged branch → read path stays pending_merge (never fabricates delivered)", () => {
    const p = cycleProject(false);
    const rows = withoutGitEnv(() => reconciledLedger(p));
    const row = rows.find((r) => r.cycleId === CYCLE);
    expect(row!.verdict).toBe("pending_merge");
  });
});

describe("US-DELIV-008 — command path offline-L1 fallback (gh silent ⇒ same facts as the read path)", () => {
  /**
   * A project whose PR #42 merged onto main as a `(#42)` commit but whose
   * branch is GONE from origin (deleted after merge). With gh silent, only
   * the offline L1 signal can see the merge — before US-DELIV-008 the command
   * said `wait` here while the read path (subject-match) said delivered: the
   * exact dual-engine divergence this story eliminates.
   */
  function mergedPrNoBranchProject(): string {
    return withoutGitEnv(() => {
      const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-deliv008-offline-l1-")));
      dirs.push(p);
      git(p, "init -q repo");
      const r = join(p, "repo");
      git(r, "config user.email test@roll.local");
      git(r, "config user.name Test");
      git(r, "checkout -q -b main");
      git(r, "commit -q --allow-empty -m init");
      git(r, "commit -q --allow-empty -m 'tcr: align machine page typography (#42)'");
      mkdirSync(join(r, ".roll", "loop"), { recursive: true });
      writeFileSync(
        join(r, ".roll", "loop", "runs.jsonl"),
        JSON.stringify({
          cycle_id: CYCLE,
          status: "published",
          outcome: "published_pending_merge",
          story_id: STORY,
          agent: "kimi",
          ts: TS,
          duration_sec: 300,
          tcr_count: 3,
        }) + "\n",
      );
      writeFileSync(
        join(r, ".roll", "loop", "events.ndjson"),
        [
          { type: "cycle:start", cycleId: CYCLE, storyId: STORY, ts: TS_MS },
          { type: "delivery:published", cycleId: CYCLE, storyId: STORY, branch: `loop/${CYCLE}`, prNumber: 42, prUrl: "u", ts: TS_MS + 1 },
          { type: "pr:open", prNumber: 42, storyId: STORY, ts: TS_MS + 2 },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
      return r;
    });
  }

  it("command delivers via offline L1 (signal pr_state) when gh is silent and the branch is gone", async () => {
    const p = mergedPrNoBranchProject();
    const d = commandDeps(p); // no provider → gh silent
    const code = await withoutGitEnv(() => loopReconcileCommand([], d));
    expect(code).toBe(0);
    const reconciled = readEvents(p).find((e) => e.type === "delivery:reconciled");
    expect(reconciled).toBeDefined();
    expect(reconciled!.signal).toBe("pr_state");
    expect(d.out.join("")).toContain("✅ delivered");
  });

  it("read path agrees: the same cycle renders delivered", () => {
    const p = mergedPrNoBranchProject();
    const rows = withoutGitEnv(() => reconciledLedger(p));
    expect(rows.find((r) => r.cycleId === CYCLE)!.verdict).toBe("delivered");
  });
});

describe("US-DELIV-008 — read path and reconcile command AGREE on the same cycle", () => {
  it("merged cycle: read path delivered AND command emits delivery:reconciled (delivered)", async () => {
    const p = cycleProject(true);
    const rows = withoutGitEnv(() => reconciledLedger(p));
    expect(rows.find((r) => r.cycleId === CYCLE)!.verdict).toBe("delivered");

    const d = commandDeps(p);
    const code = await withoutGitEnv(() => loopReconcileCommand([], d));
    expect(code).toBe(0);
    const reconciled = readEvents(p).find((e) => e.type === "delivery:reconciled");
    expect(reconciled).toBeDefined();
    expect(reconciled!.cycleId).toBe(CYCLE);
    expect(reconciled!.signal).toBe("patch_id");
  });

  it("unmerged cycle: read path pending AND command says wait — identical judgment, no events", async () => {
    const p = cycleProject(false);
    const rows = withoutGitEnv(() => reconciledLedger(p));
    expect(rows.find((r) => r.cycleId === CYCLE)!.verdict).toBe("pending_merge");

    const d = commandDeps(p);
    const code = await withoutGitEnv(() => loopReconcileCommand(["--dry-run"], d));
    expect(code).toBe(0);
    expect(d.out.join("")).toContain("⏳ wait");
    expect(readEvents(p).filter((e) => e.type === "delivery:reconciled")).toHaveLength(0);
  });

  // US-CYCLE-009 (codex #2): --dry-run mutates NOTHING even for a genuinely
  // merged cycle — no backlog flip, no delivery:reconciled, no merge_confirmed.
  it("merged cycle: --dry-run reports delivered but writes NO events and does NOT flip the backlog", async () => {
    const p = cycleProject(true);
    const backlogPath = join(p, ".roll", "backlog.md");
    writeFileSync(
      backlogPath,
      `## Epic: Test\n\n| ID | Description | Status |\n|----|----|----|\n| ${STORY} | unify engine | 🔨 In Progress |\n`,
    );
    const eventsBefore = readEvents(p).length;

    const d = commandDeps(p);
    const code = await withoutGitEnv(() => loopReconcileCommand(["--dry-run"], d));
    expect(code).toBe(0);
    expect(d.out.join("")).toContain("✅ delivered"); // reports the verdict …
    // … but mutates nothing: no new events, backlog untouched.
    expect(readEvents(p).length).toBe(eventsBefore);
    expect(readEvents(p).filter((e) => e.type === "delivery:reconciled")).toHaveLength(0);
    expect(readEvents(p).filter((e) => e.type === "delivery:merge_confirmed")).toHaveLength(0);
    expect(readFileSync(backlogPath, "utf8")).toContain("🔨 In Progress");
    expect(readFileSync(backlogPath, "utf8")).not.toContain("✅ Done");
  });
});
