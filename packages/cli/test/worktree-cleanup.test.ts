/**
 * FIX-1273 — `roll worktree cleanup` tests.
 *
 * Covers the seven ACs: enumerated canary trip; deterministic minimal auditable
 * dry-run (no mutation); apply revalidates against a FRESH audit and removes
 * only inactive/merged/clean `disposable_candidate` worktrees before pruning;
 * unpublished/dirty/active/external/missing/changed-head/newly-dirtied worktrees
 * are preserved or fail closed (no force cleanup, no threshold-only deletion, no
 * substitution); the 9→8 worked sample clears pressure; repeat/concurrent apply
 * is idempotent + safe; CLI help documents dry-run-first + preservation + resume.
 *
 * scorer_focus: action derives from a FRESH audit; a canary count NEVER becomes
 * a blanket deletion; preservation holds under every race/failure path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RollEvent } from "@roll/spec";
import type { WorktreeAuditOutput, WorktreeAuditRecord } from "../src/commands/worktree-audit.js";
import { auditWorktrees } from "../src/commands/worktree-audit.js";
import {
  applyWorktreeCleanup,
  CLEANUP_USAGE,
  classifyBranchMerge,
  defaultRemoveBranch,
  formatCanaryTripReport,
  isBoundedLoopWorktreeDir,
  isFullGitOid,
  isReclaimableOrphan,
  isSafelyDisposable,
  parseMergedPrMergeCommit,
  planWorktreeCleanup,
  resolveStandaloneMergedBranches,
  worktreeCleanupCommand,
  type BranchGitProbe,
  type CleanupBranchCandidate,
  type StandaloneBranchDeps,
} from "../src/commands/worktree-cleanup.js";

// ─── fixtures ─────────────────────────────────────────────────────────────

function rec(overrides: Partial<WorktreeAuditRecord> = {}): WorktreeAuditRecord {
  return {
    path: "/repo/.roll/loop/worktrees/cycle-1",
    owner: "loop",
    head: "sha-1",
    dirtyTracked: false,
    dirtyUntracked: false,
    ahead: 0,
    mergeEvidence: { kind: "ancestor" },
    active: false,
    disposition: "disposable_candidate",
    reason: "merged worktree with no tracked dirt; candidate for future gc",
    ...overrides,
  };
}

function auditOf(
  records: WorktreeAuditRecord[],
  ephemeralBranches: string[] = [],
): WorktreeAuditOutput {
  return {
    schema: 1,
    generatedAt: "2026-07-18T00:00:00.000Z",
    repo: "repo",
    records,
    ephemeralBranches,
    summary: {
      total: records.length,
      loop: records.filter((r) => r.owner === "loop").length,
      manual: records.filter((r) => r.owner === "manual").length,
      external: records.filter((r) => r.owner === "external").length,
      active: records.filter((r) => r.active).length,
      disposableCandidates: records.filter((r) => r.disposition === "disposable_candidate").length,
      preserved: records.filter(
        (r) => r.disposition !== "disposable_candidate" && r.disposition !== "external_unmanaged",
      ).length,
      ephemeralBranches: ephemeralBranches.length,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── AC1: enumerated canary trip ──────────────────────────────────────────

describe("AC1: canary trip enumerates counted refs + dispositions", () => {
  it("audit enumerates the exact ephemeral branches the canary counts", () => {
    const out = auditWorktrees({
      repoRoot: "/fake/repo",
      home: "/home/user",
      integrationBranch: "origin/main",
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") return "";
        if (args[0] === "branch" && args[1] === "--format=%(refname:short)") {
          // isEphemeralBranch matches loop/* and fix|feat|refactor cycle refs;
          // main / a feature branch must NOT be counted.
          return "main\nloop/cycle-20260718-000000-1\nloop/cycle-20260718-000000-2\n";
        }
        return "";
      },
    });
    expect(out.ephemeralBranches).toEqual([
      "loop/cycle-20260718-000000-1",
      "loop/cycle-20260718-000000-2",
    ]);
    expect(out.summary.ephemeralBranches).toBe(2);
  });

  it("trip report enumerates branches + worktrees with disposition and emits a structured event", () => {
    const audit = auditOf(
      [
        rec({ path: "/repo/.roll/loop/worktrees/cycle-A", disposition: "disposable_candidate" }),
        rec({
          path: "/repo/.roll/loop/worktrees/cycle-B",
          disposition: "preserved_unpublished",
          ahead: 3,
          mergeEvidence: { kind: "none" },
        }),
      ],
      ["loop/cycle-x", "loop/cycle-y"],
    );
    const { alert, event } = formatCanaryTripReport(audit, 3, 1_700_000_000_000);

    // Enumerated, not a bare count.
    expect(alert).toContain("loop/cycle-x");
    expect(alert).toContain("loop/cycle-y");
    expect(alert).toContain("cycle-A");
    expect(alert).toContain("[disposable_candidate]");
    expect(alert).toContain("cycle-B");
    expect(alert).toContain("[preserved_unpublished]");
    // Points at the safe recovery route + explicit resume.
    expect(alert).toContain("roll worktree cleanup --dry-run");
    expect(alert).toContain("roll loop resume");

    expect(event.type).toBe("branch_canary_tripped");
    if (event.type === "branch_canary_tripped") {
      expect(event.total).toBe(4); // 2 branches + 2 worktrees
      expect(event.threshold).toBe(3);
      expect(event.ephemeralBranches).toEqual(["loop/cycle-x", "loop/cycle-y"]);
      expect(event.worktrees).toEqual([
        { path: "/repo/.roll/loop/worktrees/cycle-A", disposition: "disposable_candidate" },
        { path: "/repo/.roll/loop/worktrees/cycle-B", disposition: "preserved_unpublished" },
      ]);
    }
  });
});

// ─── AC2: deterministic minimal auditable dry-run (no mutation) ────────────

describe("AC2: deterministic minimal dry-run plan", () => {
  it("selects only the MINIMUM candidates needed to clear pressure", () => {
    // canaryTotal = 1 branch + 3 loop worktrees = 4; threshold 3 ⇒ excess 1.
    const audit = auditOf(
      [
        rec({ path: "/repo/.roll/loop/worktrees/cycle-c" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-a" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-b" }),
      ],
      ["loop/cycle-z"],
    );
    const plan = planWorktreeCleanup(audit, 3);
    expect(plan.candidates).toHaveLength(1);
    // deterministic: lowest path first.
    expect(plan.candidates[0].path).toBe("/repo/.roll/loop/worktrees/cycle-a");
    expect(plan.canaryTotal).toBe(4);
    expect(plan.projectedTotal).toBe(3);
    // The other two disposables are preserved this round (minimal set).
    expect(plan.preserved.map((p) => p.path).sort()).toEqual([
      "/repo/.roll/loop/worktrees/cycle-b",
      "/repo/.roll/loop/worktrees/cycle-c",
    ]);
  });

  it("is stable across runs (deterministic ordering)", () => {
    const audit = auditOf(
      [
        rec({ path: "/repo/.roll/loop/worktrees/cycle-9" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-1" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-5" }),
      ],
      ["b1", "b2"],
    );
    const a = planWorktreeCleanup(audit, 3);
    const b = planWorktreeCleanup(audit, 3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never proposes a threshold-only deletion: no candidates when already under threshold", () => {
    // 1 branch + 1 disposable worktree = 2 ≤ threshold 8 ⇒ nothing to do even
    // though a disposable candidate exists. A canary count is never a mandate.
    const audit = auditOf([rec()], ["loop/cycle-z"]);
    const plan = planWorktreeCleanup(audit, 8);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.preserved.map((p) => p.path)).toEqual([rec().path]);
  });

  it("CLI dry-run mutates nothing and prints the plan", async () => {
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    });
    const code = await worktreeCleanupCommand(["--dry-run", "--repo", "/fake/repo"], {
      git: gitMock({
        branches: ["loop/cycle-z"],
        worktrees: [{ path: "/fake/repo/.roll/loop/worktrees/cycle-a", disposable: true }],
      }),
      integrationBranch: "origin/main",
      removeWorktree,
    });
    expect(code).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
    const out = writes.join("");
    expect(out).toContain("dry-run");
    expect(out).toContain("counted ephemeral branches");
  });
});

// ─── AC3: apply revalidates + removes only proven candidates ───────────────

describe("AC3: apply removes only revalidated candidates", () => {
  it("re-runs a FRESH audit before EVERY removal (scorer_focus)", async () => {
    const audit = auditOf(
      [
        rec({ path: "/repo/.roll/loop/worktrees/cycle-a", head: "sha-a" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-b", head: "sha-b" }),
      ],
      ["b1", "b2", "b3", "b4", "b5", "b6", "b7"],
    );
    const plan = planWorktreeCleanup(audit, 8); // 7 + 2 = 9 > 8 ⇒ 1 candidate
    // Two candidates to force two audit re-runs; widen threshold so both selected.
    const plan2 = planWorktreeCleanup(
      auditOf(audit.records, ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]),
      8,
    );
    expect(plan.candidates).toHaveLength(1);
    expect(plan2.candidates).toHaveLength(2);

    const auditFn = vi.fn(() => audit);
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    const events: RollEvent[] = [];
    const res = await applyWorktreeCleanup(plan2, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: auditFn,
      removeWorktree,
      emit: (e) => events.push(e),
      nowMs: () => 1,
    });
    // audit() called once per candidate (fresh authority each time).
    expect(auditFn).toHaveBeenCalledTimes(2);
    expect(res.removed).toHaveLength(2);
    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "worktree_cleanup_applied")).toHaveLength(2);
  });

  it("removes exactly the candidate path, then prune runs (no other path touched)", async () => {
    const audit = auditOf([rec({ path: "/repo/.roll/loop/worktrees/cycle-a" })], ["b1"]);
    const plan = planWorktreeCleanup(audit, 0); // force selection
    const removed: string[] = [];
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: () => audit,
      removeWorktree: (_root, path) => {
        removed.push(path);
        return { ok: true, detail: "" };
      },
      emit: () => {},
    });
    expect(removed).toEqual(["/repo/.roll/loop/worktrees/cycle-a"]);
    expect(res.refused).toHaveLength(0);
  });

  it("dry-run apply revalidates but performs NO git mutation", async () => {
    const audit = auditOf([rec()], ["b1"]);
    const plan = planWorktreeCleanup(audit, 0);
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    const events: RollEvent[] = [];
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: true,
      audit: () => audit,
      removeWorktree,
      emit: (e) => events.push(e),
    });
    expect(res.removed).toHaveLength(1); // "would remove"
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "worktree_cleanup_applied")).toHaveLength(0);
  });
});

// ─── AC4: preservation + fail-closed under every race/failure path ─────────

describe("AC4: preservation and fail-closed refusals", () => {
  it("never plans unpublished / dirty / active / external worktrees", () => {
    const audit = auditOf(
      [
        rec({ path: "/w/unpub", disposition: "preserved_unpublished", ahead: 2, mergeEvidence: { kind: "none" } }),
        rec({ path: "/w/dirty", disposition: "preserved_dirty_no_tcr", dirtyTracked: true }),
        rec({ path: "/w/active", disposition: "active", active: true }),
        rec({ path: "/w/ext", owner: "external", disposition: "external_unmanaged" }),
      ],
      ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"],
    );
    const plan = planWorktreeCleanup(audit, 0);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.preserved.map((p) => p.path).sort()).toEqual(["/w/active", "/w/dirty", "/w/ext", "/w/unpub"]);
  });

  const races: Array<{ name: string; fresh: WorktreeAuditRecord; reason: string }> = [
    { name: "changed head", fresh: rec({ head: "sha-CHANGED" }), reason: "changed-head" },
    { name: "newly dirtied", fresh: rec({ dirtyTracked: true }), reason: "dirty" },
    { name: "concurrent activation", fresh: rec({ active: true }), reason: "active" },
    {
      name: "lost disposability",
      fresh: rec({ disposition: "preserved_unpublished", ahead: 1, mergeEvidence: { kind: "none" } }),
      reason: "disposition",
    },
  ];
  for (const r of races) {
    it(`fails closed on ${r.name} without removing/substituting`, async () => {
      const planAudit = auditOf([rec({ path: "/repo/.roll/loop/worktrees/cycle-a", head: "sha-1" })], ["b1"]);
      const plan = planWorktreeCleanup(planAudit, 0);
      const freshAudit = auditOf([{ ...r.fresh, path: "/repo/.roll/loop/worktrees/cycle-a" }], ["b1"]);
      const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
      const events: RollEvent[] = [];
      const res = await applyWorktreeCleanup(plan, {
        repositoryRoot: "/repo",
        dryRun: false,
        audit: () => freshAudit,
        removeWorktree,
        emit: (e) => events.push(e),
        nowMs: () => 1,
      });
      expect(removeWorktree).not.toHaveBeenCalled(); // no force cleanup
      expect(res.removed).toHaveLength(0);
      expect(res.refused).toHaveLength(1);
      expect(res.refused[0].reason).toContain(r.reason);
      expect(events.some((e) => e.type === "worktree_cleanup_refused")).toBe(true);
    });
  }

  it("missing path (already removed) fails closed — idempotent + safe", async () => {
    const planAudit = auditOf([rec({ path: "/repo/.roll/loop/worktrees/cycle-a" })], ["b1"]);
    const plan = planWorktreeCleanup(planAudit, 0);
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: () => auditOf([], []), // candidate gone
      removeWorktree,
      emit: () => {},
    });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(res.refused[0].reason).toContain("missing");
  });

  it("one candidate goes dirty after dry-run: it is refused, the clean one still removed, NO preserved substituted", async () => {
    const planAudit = auditOf(
      [
        rec({ path: "/repo/.roll/loop/worktrees/cycle-a", head: "sha-a" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-b", head: "sha-b" }),
        // A preserved worktree that must NEVER be touched as a substitute.
        rec({ path: "/repo/.roll/loop/worktrees/cycle-keep", disposition: "preserved_unpublished", ahead: 5, mergeEvidence: { kind: "none" } }),
      ],
      ["b1", "b2", "b3", "b4", "b5", "b6", "b7"],
    );
    const plan = planWorktreeCleanup(planAudit, 0); // both disposables selected
    expect(plan.candidates.map((c) => c.path)).toEqual([
      "/repo/.roll/loop/worktrees/cycle-a",
      "/repo/.roll/loop/worktrees/cycle-b",
    ]);
    // Fresh audit: cycle-b became dirty; cycle-keep is still preserved.
    const freshAudit = auditOf(
      [
        rec({ path: "/repo/.roll/loop/worktrees/cycle-a", head: "sha-a" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-b", head: "sha-b", dirtyTracked: true, disposition: "preserved_dirty_no_tcr" }),
        rec({ path: "/repo/.roll/loop/worktrees/cycle-keep", disposition: "preserved_unpublished", ahead: 5, mergeEvidence: { kind: "none" } }),
      ],
      [],
    );
    const removedPaths: string[] = [];
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: () => freshAudit,
      removeWorktree: (_r, p) => {
        removedPaths.push(p);
        return { ok: true, detail: "" };
      },
      emit: () => {},
    });
    expect(removedPaths).toEqual(["/repo/.roll/loop/worktrees/cycle-a"]); // only the clean one
    expect(res.refused.map((x) => x.path)).toEqual(["/repo/.roll/loop/worktrees/cycle-b"]);
    // The preserved worktree was never removed as a substitute.
    expect(removedPaths).not.toContain("/repo/.roll/loop/worktrees/cycle-keep");
  });

  it("isSafelyDisposable rejects every non-safe shape", () => {
    expect(isSafelyDisposable(rec())).toBe(true);
    expect(isSafelyDisposable(rec({ active: true }))).toBe(false);
    expect(isSafelyDisposable(rec({ dirtyTracked: true }))).toBe(false);
    expect(isSafelyDisposable(rec({ dirtyTracked: "unknown" }))).toBe(false);
    expect(isSafelyDisposable(rec({ owner: "external" }))).toBe(false);
    expect(isSafelyDisposable(rec({ mergeEvidence: { kind: "none" } }))).toBe(false);
    expect(isSafelyDisposable(rec({ disposition: "preserved_needs_review" }))).toBe(false);
    expect(isSafelyDisposable(rec({ head: undefined }))).toBe(false);
  });
});

// ─── AC5: 9 → 8 worked sample + idempotent/concurrent ──────────────────────

describe("AC5: 9→8 worked sample clears pressure; repeat is idempotent", () => {
  it("plans exactly the one merged clean candidate (9 → 8)", () => {
    // 5 ephemeral branches + 4 loop worktrees (3 preserved + 1 disposable).
    const audit = auditOf(
      [
        rec({ path: "/w/preserved-1", disposition: "preserved_unpublished", ahead: 2, mergeEvidence: { kind: "none" } }),
        rec({ path: "/w/preserved-2", disposition: "preserved_dirty_no_tcr", dirtyTracked: true }),
        rec({ path: "/w/preserved-3", disposition: "preserved_needs_review", mergeEvidence: { kind: "none" } }),
        rec({ path: "/w/disposable-1", disposition: "disposable_candidate" }),
      ],
      ["l1", "l2", "l3", "l4", "l5"],
    );
    const plan = planWorktreeCleanup(audit, 8);
    expect(plan.canaryTotal).toBe(9);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].path).toBe("/w/disposable-1");
    expect(plan.projectedTotal).toBe(8);
  });

  it("apply removes the candidate; a repeat apply against a fresh (now-empty) audit is a safe no-op", async () => {
    const audit = auditOf(
      [
        rec({ path: "/w/preserved-1", disposition: "preserved_unpublished", ahead: 2, mergeEvidence: { kind: "none" } }),
        rec({ path: "/w/disposable-1" }),
      ],
      ["l1", "l2", "l3", "l4", "l5", "l6", "l7"],
    );
    const plan = planWorktreeCleanup(audit, 8);
    expect(plan.candidates).toHaveLength(1);

    // First apply: candidate present → removed.
    let live = audit.records.slice();
    const auditFn = () => auditOf(live, []);
    const res1 = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: auditFn,
      removeWorktree: (_r, p) => {
        live = live.filter((x) => x.path !== p); // simulate git removing it
        return { ok: true, detail: "" };
      },
      emit: () => {},
    });
    expect(res1.removed).toHaveLength(1);

    // Repeat with the SAME (stale) plan against the now-updated audit → refused
    // missing, never a re-delete or a substitution.
    const removeAgain = vi.fn(() => ({ ok: true, detail: "" }));
    const res2 = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: auditFn,
      removeWorktree: removeAgain,
      emit: () => {},
    });
    expect(removeAgain).not.toHaveBeenCalled();
    expect(res2.removed).toHaveLength(0);
    expect(res2.refused[0].reason).toContain("missing");
  });
});

// ─── AC6: CLI help documents dry-run-first + preservation + resume ─────────

describe("AC6: CLI help + guidance", () => {
  it("usage documents dry-run-first, preservation, and explicit resume", () => {
    expect(CLEANUP_USAGE).toContain("dry-run");
    expect(CLEANUP_USAGE.toLowerCase()).toContain("preserved");
    expect(CLEANUP_USAGE).toContain("roll loop resume");
    expect(CLEANUP_USAGE).toContain("--apply");
    expect(CLEANUP_USAGE).toContain("SOLE authority");
    expect(CLEANUP_USAGE).toContain("Workspace Issue worktrees");
    expect(CLEANUP_USAGE).toContain("machine repository lock");
    expect(CLEANUP_USAGE).toContain("legacy --repo mode only");
    expect(CLEANUP_USAGE).toContain("path-specific proof");
    expect(CLEANUP_USAGE).toContain("fingerprint");
    expect(CLEANUP_USAGE).not.toContain("delivery not auto-provable");
    expect(CLEANUP_USAGE).not.toContain("after you\n  review it");
  });

  it("--help prints usage and exits 0 without side effects", async () => {
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await worktreeCleanupCommand(["--help"], { removeWorktree });
    expect(code).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("--apply and --dry-run together are rejected", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await worktreeCleanupCommand(["--apply", "--dry-run"]);
    expect(code).toBe(2);
  });
});

// ─── CLI apply integration (end-to-end via injected git) ───────────────────

describe("CLI apply integration", () => {
  it("under threshold: apply removes nothing (no blanket delete)", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    });
    const removeWorktree = vi.fn(() => ({ ok: true, detail: "" }));
    const code = await worktreeCleanupCommand(["--apply", "--repo", "/fake/repo"], {
      git: gitMock({
        branches: ["loop/cycle-z"],
        worktrees: [
          { path: "/fake/repo/.roll/loop/worktrees/cycle-a", disposable: true },
          { path: "/fake/repo/.roll/loop/worktrees/cycle-b", disposable: false, ahead: 3 },
        ],
      }),
      integrationBranch: "origin/main",
      removeWorktree,
    });
    // canaryTotal = 1 + 2 = 3 ≤ 8 default ⇒ nothing to remove.
    expect(code).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("apply");
  });

  it("over threshold: apply removes the disposable candidate and emits an applied event", async () => {
    vi.stubEnv("ROLL_BRANCH_CANARY_MAX", "2");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const removed: string[] = [];
    const events: RollEvent[] = [];
    const code = await worktreeCleanupCommand(["--apply", "--repo", "/fake/repo"], {
      git: gitMock({
        branches: ["loop/cycle-z"],
        worktrees: [
          { path: "/fake/repo/.roll/loop/worktrees/cycle-a", disposable: true },
          { path: "/fake/repo/.roll/loop/worktrees/cycle-b", disposable: false, ahead: 3 },
        ],
      }),
      integrationBranch: "origin/main",
      removeWorktree: (_r, p) => {
        removed.push(p);
        return { ok: true, detail: "" };
      },
      emit: (e) => events.push(e),
    });
    // canaryTotal = 1 + 2 = 3 > 2 ⇒ remove exactly one disposable (cycle-a).
    expect(code).toBe(0);
    expect(removed).toEqual(["/fake/repo/.roll/loop/worktrees/cycle-a"]);
    expect(events.filter((e) => e.type === "worktree_cleanup_applied")).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});

// ─── git mock helper (integration) ─────────────────────────────────────────

interface WtFixture {
  path: string;
  disposable: boolean;
  head?: string;
  ahead?: number;
}

function gitMock(state: { branches: string[]; worktrees: WtFixture[] }): (args: string[], cwd: string) => string {
  const headOf = (p: string) => `head-${p.split("/").pop()}`;
  return (args: string[], cwd: string): string => {
    if (args[0] === "worktree" && args[1] === "list") {
      return (
        state.worktrees
          .map((w) => `worktree ${w.path}\nHEAD ${w.head ?? headOf(w.path)}\nbranch refs/heads/loop/${w.path.split("/").pop()}`)
          .join("\n\n") + "\n"
      );
    }
    if (args[0] === "branch" && args[1] === "--format=%(refname:short)") {
      return state.branches.join("\n") + "\n";
    }
    // Per-worktree probes keyed by cwd.
    const wt = state.worktrees.find((w) => w.path === cwd);
    if (!wt) return "";
    if (args[0] === "status") return ""; // clean
    if (args[0] === "rev-parse") return wt.head ?? headOf(wt.path);
    if (args[0] === "merge-base" && args[1] !== "--is-ancestor") {
      // ancestor iff disposable (headSha === mergeBase).
      return wt.disposable ? (wt.head ?? headOf(wt.path)) : "different-base";
    }
    if (args[0] === "rev-list") return String(wt.ahead ?? (wt.disposable ? 0 : 1));
    if (args[0] === "branch" && args[1] === "--merged") return "";
    return "";
  };
}

// ─── FIX-1454: standalone merged-branch recovery ────────────────────────────

describe("FIX-1454 resolveStandaloneMergedBranches", () => {
  const baseDeps = (over: Partial<StandaloneBranchDeps> = {}): StandaloneBranchDeps => ({
    attachedBranches: new Set<string>(),
    currentBranch: null,
    refSha: (b) => `sha-${b}`,
    branchMerge: () => "patch_equivalent",
    ...over,
  });

  it("returns merged standalone branches as candidates with sha + evidence", () => {
    const audit = auditOf([], ["loop/cycle-a", "loop/cycle-b"]);
    const out = resolveStandaloneMergedBranches(audit, baseDeps());
    expect(out).toEqual<CleanupBranchCandidate[]>([
      { branch: "loop/cycle-a", expectedSha: "sha-loop/cycle-a", mergeKind: "patch_equivalent" },
      { branch: "loop/cycle-b", expectedSha: "sha-loop/cycle-b", mergeKind: "patch_equivalent" },
    ]);
  });

  it("excludes attached, current, protected, unmerged, and missing-ref branches (fail closed)", () => {
    const audit = auditOf([], ["loop/cycle-attached", "loop/cycle-current", "main", "loop/cycle-unmerged", "loop/cycle-missing", "loop/cycle-ok"]);
    const out = resolveStandaloneMergedBranches(audit, baseDeps({
      attachedBranches: new Set(["loop/cycle-attached"]),
      currentBranch: "loop/cycle-current",
      refSha: (b) => (b === "loop/cycle-missing" ? null : `sha-${b}`),
      branchMerge: (b) => (b === "loop/cycle-unmerged" ? null : "ancestor"),
    }));
    expect(out.map((c) => c.branch)).toEqual(["loop/cycle-ok"]);
  });
});

describe("FIX-1458 (#1465) classifyBranchMerge — patch-equivalence, not merged-PR", () => {
  // A scripted git probe: ancestor iff `merge-base --is-ancestor` is registered ok;
  // `git cherry <int> <branch>` returns the provided lines.
  const probe = (opts: { ancestor?: boolean; cherry?: string; cherryFails?: boolean }): BranchGitProbe => (args) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") return { ok: opts.ancestor === true, stdout: "" };
    if (args[0] === "cherry") return { ok: !opts.cherryFails, stdout: opts.cherry ?? "" };
    return { ok: false, stdout: "" };
  };
  // No associated merged PR — these cases prove the ancestor / patch-equivalence
  // paths in isolation and must never fall through to a final-tree acceptance.
  const noPr = (): string | null => null;

  it("refuses a squash-merged branch whose tips carry unique undelivered patches (the regression)", () => {
    // Historical PR squash-merged, but `git cherry` marks every branch commit '+'
    // (no equivalent upstream) — US-ORG-003/007/004 would be lost. Must preserve.
    const kind = classifyBranchMerge(
      "loop/cycle-org",
      "main",
      probe({ ancestor: false, cherry: "+ aaaaaaa US-ORG-003\n+ bbbbbbb US-ORG-007\n+ ccccccc US-ORG-004" }),
      noPr,
    );
    expect(kind).toBeNull();
  });

  it("refuses when even ONE commit is unique among otherwise-delivered ones", () => {
    const kind = classifyBranchMerge("loop/cycle-mixed", "main", probe({ ancestor: false, cherry: "- 111 done\n+ 222 unique\n- 333 done" }), noPr);
    expect(kind).toBeNull();
  });

  it("allows a branch whose every commit is patch-equivalent upstream (git cherry all '-')", () => {
    const kind = classifyBranchMerge("loop/cycle-eq", "main", probe({ ancestor: false, cherry: "- 111 a\n- 222 b" }), noPr);
    expect(kind).toBe("patch_equivalent");
  });

  it("allows a literal ancestor branch without consulting cherry", () => {
    const kind = classifyBranchMerge("loop/cycle-anc", "main", probe({ ancestor: true }), noPr);
    expect(kind).toBe("ancestor");
  });

  it("a merged PR ALONE never authorizes deletion — no ancestry + no cherry proof ⇒ preserve", () => {
    // Empty cherry (no commits it can prove) with no ancestry must fail closed,
    // even though a merged PR may exist (which this classifier deliberately ignores).
    expect(classifyBranchMerge("loop/cycle-x", "main", probe({ ancestor: false, cherry: "" }), noPr)).toBeNull();
  });

  it("fails closed when git cherry cannot run", () => {
    expect(classifyBranchMerge("loop/cycle-x", "main", probe({ ancestor: false, cherryFails: true }), noPr)).toBeNull();
  });
});

describe("FIX-1471 classifyBranchMerge — squash-merge final-tree delivery proof (PR-anchored)", () => {
  const BRANCH = "loop/cycle-20260716-191815-7797";
  // Full 40-hex git OIDs — the merge anchor must validate as a real OID before it
  // is ever passed to git (supervisor review). `MERGE` is the branch's own PR
  // merge commit; `OTHER` is an unrelated integration commit sharing the tree.
  const MERGE = "1111111111111111111111111111111111111111";
  const OTHER = "2222222222222222222222222222222222222222";
  const WRONG = "3333333333333333333333333333333333333333";
  // A scripted git world for the final-tree proof. The tree oid of any object is
  // resolved from `trees` (keyed by ref — the branch name or a merge oid); a merge
  // oid is an ancestor of integration iff it is listed in `onMain`.
  const probe = (opts: {
    ancestor?: boolean; // branch is-ancestor of integration (false for squash)
    cherry?: string;
    trees?: Record<string, string>; // ref/oid → tree oid (via `rev-parse <ref>^{tree}`)
    onMain?: string[]; // merge oids that ARE ancestors of integration
    treeFails?: boolean; // every rev-parse fails
  }): BranchGitProbe => (args) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const ref = args[2];
      if (ref === BRANCH) return { ok: opts.ancestor === true, stdout: "" }; // branch→integration
      return { ok: (opts.onMain ?? []).includes(ref ?? ""), stdout: "" }; // mergeOid→integration
    }
    if (args[0] === "cherry") return { ok: true, stdout: opts.cherry ?? "" };
    if (args[0] === "rev-parse") {
      if (opts.treeFails) return { ok: false, stdout: "" };
      const ref = (args[1] ?? "").replace(/\^\{tree\}$/, "");
      const tree = (opts.trees ?? {})[ref];
      return tree !== undefined ? { ok: true, stdout: tree } : { ok: false, stdout: "" };
    }
    return { ok: false, stdout: "" };
  };
  // Squash-merge shape: not a literal ancestor, every TCR commit is a unique `+`.
  const squash = "+ aaaaaaa tcr 1\n+ bbbbbbb tcr 2\n+ ccccccc tcr 3";

  it("accepts when the branch tip tree equals its OWN merged PR merge commit (ancestor of main)", () => {
    const kind = classifyBranchMerge(
      BRANCH,
      "main",
      probe({
        ancestor: false,
        cherry: squash,
        trees: { [BRANCH]: "tree-final", [MERGE]: "tree-final" },
        onMain: [MERGE],
      }),
      () => MERGE, // the branch's associated merged PR merge commit
    );
    expect(kind).toBe("final_tree");
  });

  it("preserves an arbitrary main commit with the SAME tree but no associated merged PR", () => {
    // The security regression: even though some commit reachable from main carries
    // `tree-final`, there is NO merged PR for this exact head ref, so delivery is
    // NOT proven — the ref (and any unique commit) must be kept.
    const kind = classifyBranchMerge(
      BRANCH,
      "main",
      probe({
        ancestor: false,
        cherry: squash,
        trees: { [BRANCH]: "tree-final", [OTHER]: "tree-final" },
        onMain: [OTHER],
      }),
      () => null, // gh finds no merged PR for this head ref
    );
    expect(kind).toBeNull();
  });

  it("preserves when the associated PR merge commit's tree differs (wrong PR / near-match)", () => {
    const kind = classifyBranchMerge(
      BRANCH,
      "main",
      probe({
        ancestor: false,
        cherry: squash,
        trees: { [BRANCH]: "tree-final", [WRONG]: "tree-other" },
        onMain: [WRONG],
      }),
      () => WRONG,
    );
    expect(kind).toBeNull();
  });

  it("preserves when there is no merge commit oid at all (absent merge commit)", () => {
    const kind = classifyBranchMerge(
      BRANCH,
      "main",
      probe({ ancestor: false, cherry: squash, trees: { [BRANCH]: "tree-final" } }),
      () => "", // PR object present but no merge commit oid → treat as absent
    );
    expect(kind).toBeNull();
  });

  it("preserves when the merge anchor is not a full git OID (HEAD/ref/short) — never passed to git", () => {
    // A probe that returns a ref name or abbreviated sha must be rejected BEFORE it
    // reaches git, where `HEAD`/`main` would resolve to an unrelated commit and
    // forge a proof. Each is fail-closed regardless of tree/ancestor scripting.
    for (const bad of ["HEAD", "main", "refs/heads/main", "1111111", "zzzz", "  "]) {
      const kind = classifyBranchMerge(
        BRANCH,
        "main",
        probe({
          ancestor: false,
          cherry: squash,
          // Script the world as if the ref DID match + land, to prove the OID guard
          // (not a tree/ancestor miss) is what rejects it.
          trees: { [BRANCH]: "tree-final", [bad.trim()]: "tree-final" },
          onMain: [bad.trim()],
        }),
        () => bad,
      );
      expect(kind).toBeNull();
    }
  });

  it("preserves when the associated PR merge commit is NOT an ancestor of integration", () => {
    // The merge commit tree matches, but it never landed on integration — fail closed.
    const kind = classifyBranchMerge(
      BRANCH,
      "main",
      probe({
        ancestor: false,
        cherry: squash,
        trees: { [BRANCH]: "tree-final", [MERGE]: "tree-final" },
        onMain: [], // MERGE is NOT reachable from integration
      }),
      () => MERGE,
    );
    expect(kind).toBeNull();
  });

  it("fails closed when the branch tree cannot be resolved", () => {
    expect(
      classifyBranchMerge(BRANCH, "main", probe({ ancestor: false, cherry: "+ a", treeFails: true, onMain: [MERGE] }), () => MERGE),
    ).toBeNull();
  });
});

describe("FIX-1471 parseMergedPrMergeCommit / isFullGitOid — gh PR probe guards", () => {
  const BRANCH = "loop/cycle-99";
  const OID = "abcabcabcabcabcabcabcabcabcabcabcabcabca"; // 40 hex
  const OID256 = "a".repeat(64);
  const json = (o: Record<string, unknown>): string => JSON.stringify(o);

  it("isFullGitOid accepts 40-hex and 64-hex, rejects everything else", () => {
    expect(isFullGitOid(OID)).toBe(true);
    expect(isFullGitOid(OID256)).toBe(true);
    for (const bad of ["HEAD", "main", "refs/heads/main", "abcabc", "1234567", "", "  ", "ABC" + "a".repeat(37), "g".repeat(40)]) {
      expect(isFullGitOid(bad)).toBe(false);
    }
  });

  it("returns the merge oid on a merged PR whose head ref is EXACTLY the branch", () => {
    const oid = parseMergedPrMergeCommit(
      json({ state: "MERGED", mergedAt: "2026-07-16T00:00:00Z", mergeCommit: { oid: OID }, headRefName: BRANCH }),
      BRANCH,
    );
    expect(oid).toBe(OID);
  });

  it("rejects a null / empty / missing / mismatched headRefName (fail closed)", () => {
    const base = { state: "MERGED", mergedAt: "2026-07-16T00:00:00Z", mergeCommit: { oid: OID } };
    expect(parseMergedPrMergeCommit(json({ ...base, headRefName: null }), BRANCH)).toBeNull();
    expect(parseMergedPrMergeCommit(json({ ...base, headRefName: "" }), BRANCH)).toBeNull();
    expect(parseMergedPrMergeCommit(json({ ...base }), BRANCH)).toBeNull(); // headRefName missing
    expect(parseMergedPrMergeCommit(json({ ...base, headRefName: "loop/other" }), BRANCH)).toBeNull();
  });

  it("rejects a non-merged PR (open / closed-unmerged / no mergedAt)", () => {
    const mc = { oid: OID };
    expect(parseMergedPrMergeCommit(json({ state: "OPEN", mergedAt: null, mergeCommit: mc, headRefName: BRANCH }), BRANCH)).toBeNull();
    expect(parseMergedPrMergeCommit(json({ state: "CLOSED", mergedAt: null, mergeCommit: mc, headRefName: BRANCH }), BRANCH)).toBeNull();
    expect(parseMergedPrMergeCommit(json({ state: "MERGED", mergedAt: "", mergeCommit: mc, headRefName: BRANCH }), BRANCH)).toBeNull();
  });

  it("rejects a merge commit that is not a full git OID (HEAD / ref / short / absent / malformed)", () => {
    const base = { state: "MERGED", mergedAt: "2026-07-16T00:00:00Z", headRefName: BRANCH };
    for (const bad of ["HEAD", "main", "refs/heads/main", "abcabc", "1234567", ""]) {
      expect(parseMergedPrMergeCommit(json({ ...base, mergeCommit: { oid: bad } }), BRANCH)).toBeNull();
    }
    expect(parseMergedPrMergeCommit(json({ ...base, mergeCommit: null }), BRANCH)).toBeNull();
    expect(parseMergedPrMergeCommit(json({ ...base }), BRANCH)).toBeNull(); // mergeCommit missing
  });

  it("rejects unparseable gh output", () => {
    expect(parseMergedPrMergeCommit("not json", BRANCH)).toBeNull();
    expect(parseMergedPrMergeCommit("", BRANCH)).toBeNull();
  });
});

describe("FIX-1471 defaultRemoveBranch — atomic compare-and-delete (TOCTOU)", () => {
  let repo: string;
  // Strip any leaked GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so the temp repo is
  // hermetic (these otherwise redirect git at the outer worktree — a known trap).
  const cleanEnv = { ...process.env };
  delete cleanEnv["GIT_DIR"];
  delete cleanEnv["GIT_WORK_TREE"];
  delete cleanEnv["GIT_INDEX_FILE"];
  const git = (...a: string[]): string =>
    execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv }).trim();

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const initRepo = (): void => {
    repo = mkdtempSync(join(tmpdir(), "roll-toctou-"));
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
  };

  it("deletes only when the ref STILL equals the expected sha (race: ref advanced ⇒ refuse, commit preserved)", () => {
    initRepo();
    // Delivered tip A on the branch.
    git("commit", "-q", "--allow-empty", "-m", "delivered");
    git("branch", "loop/cycle-race");
    const shaA = git("rev-parse", "refs/heads/loop/cycle-race");

    // RACE: after the fresh sha check observed shaA, the branch advances to a NEW,
    // unmerged commit B before the delete fires.
    git("checkout", "-q", "loop/cycle-race");
    git("commit", "-q", "--allow-empty", "-m", "new unmerged work after check");
    const shaB = git("rev-parse", "refs/heads/loop/cycle-race");
    git("checkout", "-q", "-"); // leave the branch checked out only briefly
    expect(shaB).not.toBe(shaA);

    // Compare-and-delete against the STALE expected sha A must refuse atomically…
    const stale = defaultRemoveBranch(repo, "loop/cycle-race", shaA);
    expect(stale.ok).toBe(false);
    // …and the branch (with its unmerged commit B) is preserved, not discarded.
    expect(git("rev-parse", "refs/heads/loop/cycle-race")).toBe(shaB);
    expect(git("rev-parse", "refs/heads/loop/cycle-race^{tree}")).toBeTruthy();

    // Re-observing the CURRENT sha B then deletes cleanly.
    const fresh = defaultRemoveBranch(repo, "loop/cycle-race", shaB);
    expect(fresh.ok).toBe(true);
    expect(() => git("rev-parse", "--verify", "refs/heads/loop/cycle-race")).toThrow();
  });

  it("refuses a non-full-OID expected sha without touching the ref", () => {
    initRepo();
    git("commit", "-q", "--allow-empty", "-m", "c");
    git("branch", "loop/cycle-x");
    const r = defaultRemoveBranch(repo, "loop/cycle-x", "HEAD");
    expect(r.ok).toBe(false);
    expect(git("rev-parse", "--verify", "refs/heads/loop/cycle-x")).toBeTruthy();
  });
});

describe("FIX-1454 planWorktreeCleanup with branch candidates", () => {
  it("fills the minimal set with worktrees first, then merged branches, to clear excess", () => {
    // 2 counted worktrees + 3 counted branches = canary 5, threshold 2 → excess 3.
    const wt = rec({ path: "/repo/.roll/loop/worktrees/cycle-1", head: "h1" });
    const branches: CleanupBranchCandidate[] = [
      { branch: "loop/cycle-a", expectedSha: "sa", mergeKind: "ancestor" },
      { branch: "loop/cycle-b", expectedSha: "sb", mergeKind: "patch_equivalent" },
      { branch: "loop/cycle-c", expectedSha: "sc", mergeKind: "ancestor" },
    ];
    const audit = auditOf([wt, rec({ path: "/repo/.roll/loop/worktrees/cycle-keep", disposition: "preserved_unpublished", mergeEvidence: { kind: "none" } })], ["loop/cycle-a", "loop/cycle-b", "loop/cycle-c"]);
    const plan = planWorktreeCleanup(audit, 2, branches);
    // excess 3: 1 disposable worktree + 2 branches (deterministic by name).
    expect(plan.candidates.map((c) => c.path)).toEqual(["/repo/.roll/loop/worktrees/cycle-1"]);
    expect(plan.branchCandidates.map((b) => b.branch)).toEqual(["loop/cycle-a", "loop/cycle-b"]);
    expect(plan.projectedTotal).toBe(2);
  });

  it("selects no branches when worktrees alone clear the excess", () => {
    const audit = auditOf([rec({ path: "/repo/.roll/loop/worktrees/cycle-1" })], ["loop/cycle-a"]);
    const plan = planWorktreeCleanup(audit, 1, [{ branch: "loop/cycle-a", expectedSha: "sa", mergeKind: "ancestor" }]);
    // canary 2, threshold 1 → excess 1: one worktree suffices, branch preserved.
    expect(plan.candidates).toHaveLength(1);
    expect(plan.branchCandidates).toHaveLength(0);
  });
});

describe("FIX-1454 applyWorktreeCleanup branch deletion", () => {
  const planWith = (branchCandidates: CleanupBranchCandidate[]): Parameters<typeof applyWorktreeCleanup>[0] => ({
    schema: 1, generatedAt: "t", threshold: 1, canaryTotal: 2, projectedTotal: 1,
    countedBranches: branchCandidates.map((b) => b.branch), countedWorktrees: [],
    candidates: [], branchCandidates, preserved: [],
  });

  it("deletes a branch that revalidates (sha + merged + unattached)", async () => {
    const removeBranch = vi.fn(() => ({ ok: true, detail: "" }));
    const res = await applyWorktreeCleanup(planWith([{ branch: "loop/cycle-a", expectedSha: "sa", mergeKind: "ancestor" }]), {
      repositoryRoot: "/repo", dryRun: false,
      freshBranchDeps: () => ({ attachedBranches: new Set(), currentBranch: null, refSha: () => "sa", branchMerge: () => "ancestor" }),
      removeBranch,
    });
    expect(res.branchesRemoved.map((b) => b.branch)).toEqual(["loop/cycle-a"]);
    // Compare-and-delete: the observed sha is threaded so the delete is atomic.
    expect(removeBranch).toHaveBeenCalledWith("/repo", "loop/cycle-a", "sa");
    expect(res.refused).toHaveLength(0);
  });

  it("refuses (no delete) on changed ref, re-attach, or lost merge — fail closed", async () => {
    const cases: Array<[string, StandaloneBranchDeps]> = [
      ["changed-ref", { attachedBranches: new Set(), currentBranch: null, refSha: () => "DIFFERENT", branchMerge: () => "ancestor" }],
      ["attached", { attachedBranches: new Set(["loop/cycle-a"]), currentBranch: null, refSha: () => "sa", branchMerge: () => "ancestor" }],
      ["not-merged", { attachedBranches: new Set(), currentBranch: null, refSha: () => "sa", branchMerge: () => null }],
      ["missing", { attachedBranches: new Set(), currentBranch: null, refSha: () => null, branchMerge: () => "ancestor" }],
    ];
    for (const [, deps] of cases) {
      const removeBranch = vi.fn(() => ({ ok: true, detail: "" }));
      const res = await applyWorktreeCleanup(planWith([{ branch: "loop/cycle-a", expectedSha: "sa", mergeKind: "ancestor" }]), {
        repositoryRoot: "/repo", dryRun: false, freshBranchDeps: () => deps, removeBranch,
      });
      expect(res.branchesRemoved).toHaveLength(0);
      expect(res.refused).toHaveLength(1);
      expect(removeBranch).not.toHaveBeenCalled();
    }
  });

  it("dry-run revalidates but never deletes", async () => {
    const removeBranch = vi.fn(() => ({ ok: true, detail: "" }));
    const res = await applyWorktreeCleanup(planWith([{ branch: "loop/cycle-a", expectedSha: "sa", mergeKind: "ancestor" }]), {
      repositoryRoot: "/repo", dryRun: true,
      freshBranchDeps: () => ({ attachedBranches: new Set(), currentBranch: null, refSha: () => "sa", branchMerge: () => "ancestor" }),
      removeBranch,
    });
    expect(res.branchesRemoved).toHaveLength(1);
    expect(removeBranch).not.toHaveBeenCalled();
  });
});

// ─── FIX-1460 (#1468): orphan loop worktree dir reclaim ─────────────────────

describe("FIX-1460 (#1468) orphan reclaim", () => {
  const orphanRec = (over: Partial<WorktreeAuditRecord> = {}): WorktreeAuditRecord =>
    rec({
      path: "/repo/.roll/loop/worktrees/cycle-o",
      head: undefined,
      dirtyTracked: "unknown",
      dirtyUntracked: "unknown",
      ahead: null,
      mergeEvidence: { kind: "none" },
      orphanRecoveryProof: {
        state: "trusted_generated",
        fingerprint: "proof-a",
        entries: [".next"],
        detail: "trusted generated roots: .next",
      },
      disposition: "orphan_reclaimable",
      reason: "orphan (delivered)",
      ...over,
    });

  function realOrphanFixture(): { repo: string; orphan: string } {
    const repo = mkdtempSync(join(tmpdir(), "roll-orphan-apply-"));
    const cleanEnv = { ...process.env };
    delete cleanEnv["GIT_DIR"];
    delete cleanEnv["GIT_WORK_TREE"];
    delete cleanEnv["GIT_INDEX_FILE"];
    const runGit = (args: string[]): void => {
      execFileSync("git", ["-C", repo, ...args], { env: cleanEnv, stdio: "ignore" });
    };
    runGit(["init", "-b", "main"]);
    runGit(["config", "user.name", "Roll Test"]);
    runGit(["config", "user.email", "roll-test@example.invalid"]);
    writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
    runGit(["add", "README.md"]);
    runGit(["commit", "-m", "fixture"]);

    const cycleId = "cycle-20260723-130000-1";
    const orphan = join(repo, ".roll", "loop", "worktrees", cycleId);
    mkdirSync(join(orphan, ".next", "cache"), { recursive: true });
    writeFileSync(join(orphan, ".next", "cache", "build.json"), "{}\n", "utf8");
    mkdirSync(join(repo, ".roll", "loop"), { recursive: true });
    writeFileSync(
      join(repo, ".roll", "loop", "events.ndjson"),
      JSON.stringify({ cycleId, outcome: "delivered" }) + "\n",
      "utf8",
    );
    return { repo, orphan };
  }

  function realOrphanAudit(repo: string): WorktreeAuditOutput {
    return auditWorktrees({ repoRoot: repo, home: tmpdir(), integrationBranch: "HEAD" });
  }

  it("isBoundedLoopWorktreeDir accepts only a DIRECT child of .roll/loop/worktrees", () => {
    const root = "/repo";
    expect(isBoundedLoopWorktreeDir(root, "/repo/.roll/loop/worktrees/cycle-1")).toBe(true);
    expect(isBoundedLoopWorktreeDir(root, "/repo/.roll/loop/worktrees")).toBe(false); // the root itself
    expect(isBoundedLoopWorktreeDir(root, "/repo/.roll/loop/worktrees/cycle-1/nested")).toBe(false); // nested
    expect(isBoundedLoopWorktreeDir(root, "/repo/src")).toBe(false); // outside
    expect(isBoundedLoopWorktreeDir(root, "/etc")).toBe(false);
  });

  it("isReclaimableOrphan requires loop-owned, inactive, orphan_reclaimable", () => {
    expect(isReclaimableOrphan(orphanRec())).toBe(true);
    expect(isReclaimableOrphan(orphanRec({ active: true }))).toBe(false);
    expect(isReclaimableOrphan(orphanRec({ disposition: "preserved_orphan" }))).toBe(false);
    expect(isReclaimableOrphan(orphanRec({ owner: "external" }))).toBe(false);
    expect(isReclaimableOrphan(orphanRec({ orphanRecoveryProof: undefined }))).toBe(false);
    expect(isReclaimableOrphan(orphanRec({
      orphanRecoveryProof: {
        state: "ambiguous",
        fingerprint: null,
        entries: [".next"],
        detail: "changed during audit",
      },
    }))).toBe(false);
  });

  it("plans an orphan_reclaimable record as an rm_dir candidate", () => {
    const audit = auditOf([orphanRec()], []); // canary 1, threshold 0 → excess 1
    const plan = planWorktreeCleanup(audit, 0);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].reclaim).toBe("rm_dir");
    expect(plan.candidates[0].reason).toBe("orphan_reclaimable");
    expect(plan.candidates[0].expectedHead).toBe("");
    expect(plan.candidates[0]).toMatchObject({ expectedOrphanFingerprint: "proof-a" });
  });

  it("apply reclaims a still-proven orphan via the bounded rm hook", async () => {
    const plan = planWorktreeCleanup(auditOf([orphanRec()], []), 0);
    const calls: string[] = [];
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: () => auditOf([orphanRec()], []),
      reclaimOrphanDir: (_root, p) => {
        calls.push(p);
        return { ok: true, detail: "" };
      },
      removeWorktree: () => {
        throw new Error("git worktree remove must NOT be used for an orphan dir");
      },
    });
    expect(calls).toEqual(["/repo/.roll/loop/worktrees/cycle-o"]);
    expect(res.removed).toHaveLength(1);
    expect(res.removed[0].reclaim).toBe("rm_dir");
    expect(res.refused).toHaveLength(0);
  });

  it("apply refuses (fail closed) when the fresh audit downgrades the orphan to preserved_orphan", async () => {
    const plan = planWorktreeCleanup(auditOf([orphanRec()], []), 0);
    let called = false;
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: () => auditOf([orphanRec({ disposition: "preserved_orphan" })], []),
      reclaimOrphanDir: () => {
        called = true;
        return { ok: true, detail: "" };
      },
    });
    expect(called).toBe(false);
    expect(res.removed).toHaveLength(0);
    expect(res.refused[0].reason).toMatch(/preserved_orphan|provably delivered/);
  });

  it("apply refuses when the exact orphan material proof changed after planning", async () => {
    const plan = planWorktreeCleanup(auditOf([orphanRec()], []), 0);
    let called = false;
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: false,
      audit: () => auditOf([orphanRec({
        orphanRecoveryProof: {
          state: "trusted_generated",
          fingerprint: "proof-b",
          entries: [".next"],
          detail: "trusted generated roots: .next",
        },
      })], []),
      reclaimOrphanDir: () => {
        called = true;
        return { ok: true, detail: "" };
      },
    });
    expect(called).toBe(false);
    expect(res.removed).toHaveLength(0);
    expect(res.refused[0].reason).toMatch(/changed|fingerprint|proof/i);
  });

  it("dry-run reports the orphan candidate but calls no reclaim hook", async () => {
    const plan = planWorktreeCleanup(auditOf([orphanRec()], []), 0);
    let called = false;
    const res = await applyWorktreeCleanup(plan, {
      repositoryRoot: "/repo",
      dryRun: true,
      audit: () => auditOf([orphanRec()], []),
      reclaimOrphanDir: () => {
        called = true;
        return { ok: true, detail: "" };
      },
    });
    expect(called).toBe(false);
    expect(res.removed[0].reclaim).toBe("rm_dir");
  });

  it("explicit orphan reclaim cannot override a preserved fail-closed audit", async () => {
    const reclaim = vi.fn(() => ({ ok: true, detail: "" }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await worktreeCleanupCommand(
      ["--reclaim-orphan", "/fake/repo/.roll/loop/worktrees/cycle-20260718-000000-2", "--repo", "/fake/repo"],
      {
        git: (args) => args[0] === "worktree" && args[1] === "list"
          ? "worktree /fake/repo\nHEAD abc\nbranch refs/heads/main\n"
          : "",
        readDir: () => ["cycle-20260718-000000-2"],
        readFile: () => null,
        reclaimOrphanDir: reclaim,
      },
    );
    expect(code).toBe(2);
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("reclaims an exact generated-residue orphan in a real repository fixture", async () => {
    const { repo, orphan } = realOrphanFixture();
    try {
      const plan = planWorktreeCleanup(realOrphanAudit(repo), 0);
      expect(plan.candidates).toHaveLength(1);
      const result = await applyWorktreeCleanup(plan, {
        repositoryRoot: repo,
        dryRun: false,
        audit: () => realOrphanAudit(repo),
      });
      expect(result.refused).toHaveLength(0);
      expect(result.removed).toHaveLength(1);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("final bounded reclaim refuses material added after the fresh audit", async () => {
    const { repo, orphan } = realOrphanFixture();
    try {
      const plan = planWorktreeCleanup(realOrphanAudit(repo), 0);
      const result = await applyWorktreeCleanup(plan, {
        repositoryRoot: repo,
        dryRun: false,
        audit: () => {
          const fresh = realOrphanAudit(repo);
          writeFileSync(join(orphan, "package.json"), "{\"private\":true}\n", "utf8");
          return fresh;
        },
      });
      expect(result.removed).toHaveLength(0);
      expect(result.refused[0].reason).toMatch(/changed-proof|reclaim-failed/i);
      expect(existsSync(orphan)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("final bounded reclaim refuses a cycle that activates after the fresh audit", async () => {
    const { repo, orphan } = realOrphanFixture();
    try {
      const plan = planWorktreeCleanup(realOrphanAudit(repo), 0);
      const result = await applyWorktreeCleanup(plan, {
        repositoryRoot: repo,
        dryRun: false,
        audit: () => {
          const fresh = realOrphanAudit(repo);
          writeFileSync(
            join(repo, ".roll", "loop", "inner.lock"),
            "cycle-20260723-130000-1 12345\n",
            "utf8",
          );
          return fresh;
        },
      });
      expect(result.removed).toHaveLength(0);
      expect(result.refused[0].reason).toMatch(/active|proof|reclaim-failed/i);
      expect(existsSync(orphan)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
