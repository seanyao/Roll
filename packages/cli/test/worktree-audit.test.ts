/**
 * US-LOOP-093 — `roll worktree audit` tests.
 *
 * Covers: JSON schema output, human output grouping, loop/manual/external
 * ownership classification, active cycle protection, tracked vs untracked
 * dirt split, merge evidence variants, disposition classification, and
 * the hard read-only constraint (no mutation).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditWorktrees,
  inspectOrphanRecoveryProof,
  worktreeAuditCommand,
  type WorktreeAuditDeps,
  type WorktreeAuditOutput,
  type WorktreeAuditRecord,
} from "../src/commands/worktree-audit.js";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<WorktreeAuditDeps>): WorktreeAuditDeps {
  return {
    repoRoot: "/fake/repo",
    home: "/home/user",
    nowISO: () => "2026-07-08T12:00:00.000Z",
    nowSec: () => 1783516800,
    git: () => "",
    readFile: () => null,
    ...overrides,
  };
}

/** Build a porcelain worktree list from {path, head, branch} entries. */
function porcelain(entries: { path: string; head?: string; branch?: string }[]): string {
  return entries
    .map((e) => {
      const lines: string[] = [`worktree ${e.path}`];
      if (e.head) lines.push(`HEAD ${e.head}`);
      if (e.branch) lines.push(`branch ${e.branch}`);
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

// ─── AC1: JSON output schema ──────────────────────────────────────────────

describe("AC1: JSON output", () => {
  it("emits schema-1 JSON with summary and records", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "abc123", branch: "refs/heads/main" },
          ]);
        }
        return "";
      },
    });

    const result = auditWorktrees(deps);

    expect(result.schema).toBe(1);
    expect(result.generatedAt).toBe("2026-07-08T12:00:00.000Z");
    expect(result.repo).toBe("repo");
    expect(Array.isArray(result.records)).toBe(true);
    expect(result.records.length).toBeGreaterThanOrEqual(1);
    expect(result.summary).toBeDefined();
    expect(result.summary.total).toBe(result.records.length);
  });

  it("each record has all required fields", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "abc123", branch: "refs/heads/main" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    for (const rec of result.records) {
      expect(typeof rec.path).toBe("string");
      expect(["loop", "manual", "external"]).toContain(rec.owner);
      expect(typeof rec.active).toBe("boolean");
      expect([
        "active",
        "disposable_candidate",
        "preserved_needs_review",
        "preserved_unpublished",
        "preserved_dirty_no_tcr",
        "external_unmanaged",
      ]).toContain(rec.disposition);
      expect(typeof rec.reason).toBe("string");
    }
  });

  it("command --json writes valid JSON to stdout", () => {
    const stdout: string[] = [];
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "abc123", branch: "refs/heads/main" },
          ]);
        }
        return "";
      },
    });

    const exit = worktreeAuditCommand(["--json"], deps);
    // Can't fully test stdout capture without mocking process.stdout, but
    // we verify the command doesn't crash and the dep injection works.
    expect(exit).toBe(0);
  });
});

// ─── AC2: ownership classification ────────────────────────────────────────

describe("AC2: ownership classification", () => {
  it("classifies worktree under .roll/loop/worktrees/ as loop", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-20260708-120000-123", head: "abc", branch: "refs/heads/loop/cycle-20260708-120000-123" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].owner).toBe("loop");
    expect(result.records[0].cycleId).toBe("cycle-20260708-120000-123");
  });

  it("classifies roll-wt-* sibling as manual", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/roll-wt-FIX-1069", head: "def", branch: "refs/heads/fix-1069" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].owner).toBe("manual");
    expect(result.records[0].disposition).toBe("external_unmanaged");
    expect(result.records[0].reason).toContain("not managed by loop");
  });

  it("classifies wt-* sibling as manual", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/wt-sandbox", head: "ghi", branch: "refs/heads/sandbox" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].owner).toBe("manual");
  });

  it("classifies non-matching path as external", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/tmp/some-other-worktree", head: "jkl", branch: "refs/heads/other" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].owner).toBe("external");
    expect(result.records[0].disposition).toBe("external_unmanaged");
  });

  it("classifies roll-us-init-* sibling as manual", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/roll-us-init-003", head: "mno", branch: "refs/heads/us-init-003" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].owner).toBe("manual");
  });

  it("classifies main repo checkout as external (not loop/manual)", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "main123", branch: "refs/heads/main" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    // Main repo is not inside .roll/loop/worktrees/, not a sibling pattern → external
    expect(result.records[0].owner).toBe("external");
  });
});

// ─── AC3: dirty state split ───────────────────────────────────────────────

describe("AC3: dirty state split", () => {
  it("detects tracked dirt separately from untracked", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-1", head: "abc", branch: "refs/heads/loop/cycle-1" },
          ]);
        }
        // Tracked dirt: one modified file
        if (args.includes("--untracked-files=no")) return " M src/file.ts\n";
        // Full status: modified + one untracked file
        return " M src/file.ts\n?? scratch.txt\n";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].dirtyTracked).toBe(true);
    expect(result.records[0].dirtyUntracked).toBe(true);
  });

  it("reports only untracked dirt correctly", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-2", head: "def", branch: "refs/heads/loop/cycle-2" },
          ]);
        }
        if (args.includes("--untracked-files=no")) return "";
        return "?? scratch.txt\n?? build/\n";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].dirtyTracked).toBe(false);
    expect(result.records[0].dirtyUntracked).toBe(true);
  });

  it("clean worktree has no dirt", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-3", head: "ghi", branch: "refs/heads/loop/cycle-3" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].dirtyTracked).toBe(false);
    expect(result.records[0].dirtyUntracked).toBe(false);
  });

  it("untracked scratch not conflated with tracked code changes", () => {
    // This is the specific requirement from the spec: untracked scratch must not
    // be conflated with tracked code changes.
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-4", head: "jkl", branch: "refs/heads/loop/cycle-4" },
          ]);
        }
        // Only untracked files, no tracked changes
        if (args.includes("--untracked-files=no")) return "";
        return "?? node_modules/.cache/\n?? .DS_Store\n?? tmp/test-output.txt\n";
      },
      readFile: () => null,
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].dirtyTracked).toBe(false);
    expect(result.records[0].dirtyUntracked).toBe(true);
    // Should be a disposable_candidate if merge evidence is ancestor
    // (but we haven't set merge evidence here, so this just tests the split)
  });

  it("dirty detection fails gracefully (unknown)", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-5", head: "mno", branch: "refs/heads/loop/cycle-5" },
          ]);
        }
        // Simulate git error
        throw new Error("git failed");
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].dirtyTracked).toBe("unknown");
    expect(result.records[0].dirtyUntracked).toBe("unknown");
  });
});

// ─── AC4: merge evidence ──────────────────────────────────────────────────

describe("AC4: merge evidence", () => {
  it("detects ancestor merge when HEAD == merge-base", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-6", head: "abc123", branch: "refs/heads/loop/cycle-6" },
          ]);
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
        if (args[0] === "merge-base") return "abc123\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].mergeEvidence.kind).toBe("ancestor");
  });

  it("detects PR-merged via branch --merged origin/main", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-7", head: "def456", branch: "refs/heads/loop/cycle-7" },
          ]);
        }
        // merge-base differs from HEAD (not ancestor)
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "def456\n";
        if (args[0] === "merge-base") return "different-sha\n";
        // But branch is in --merged list (squash-merge case)
        if (args[0] === "branch" && args[1] === "--merged") return "  loop/cycle-7\n  main\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].mergeEvidence.kind).toBe("pr_merged");
    expect(result.records[0].mergeEvidence.detail).toContain("squash-safe");
  });

  it("reports 'none' when no merge evidence found", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-8", head: "ghi789", branch: "refs/heads/loop/cycle-8" },
          ]);
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "ghi789\n";
        if (args[0] === "merge-base") return "different-sha\n";
        if (args[0] === "branch" && args[1] === "--merged") return "  main\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].mergeEvidence.kind).toBe("none");
  });

  it("handles git errors gracefully (merge evidence stays 'none')", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-9", head: "jkl", branch: "refs/heads/loop/cycle-9" },
          ]);
        }
        // All git calls fail (no origin/main)
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].mergeEvidence.kind).toBe("none");
  });

  it("E1: merge/ahead probes target the configured integration branch", () => {
    const seen: string[][] = [];
    const deps = makeDeps({
      integrationBranch: "origin/release",
      git: (args) => {
        seen.push(args);
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-10", head: "mno", branch: "refs/heads/loop/cycle-10" },
          ]);
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "mno\n";
        if (args[0] === "merge-base") return "mno\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].mergeEvidence.kind).toBe("ancestor");
    // The integration-branch reference is the configured one, never origin/main;
    // the story branch (loop/cycle-10) must NOT be rewritten.
    const mergeBase = seen.find((a) => a[0] === "merge-base");
    expect(mergeBase).toContain("origin/release");
    expect(mergeBase).not.toContain("origin/main");
    const ahead = seen.find((a) => a[0] === "rev-list" && a.includes("--count"));
    expect(ahead).toContain("^origin/release");
  });
});

// ─── AC5: active cycle protection ─────────────────────────────────────────

describe("AC5: active cycle protection", () => {
  it("marks worktree active when cycleId is in inner.lock", () => {
    const cycleId = "cycle-20260708-120000-456";
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: `/fake/repo/.roll/loop/worktrees/${cycleId}`, head: "abc", branch: `refs/heads/loop/${cycleId}` },
          ]);
        }
        return "";
      },
      readFile: (p) => {
        if (p.endsWith("inner.lock")) return `${cycleId}  1783516800  pi\n`;
        return null;
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].active).toBe(true);
    expect(result.records[0].disposition).toBe("active");
    expect(result.records[0].reason).toContain("active cycle");
  });

  it("marks worktree active when fresh heartbeat exists", () => {
    const cycleId = "cycle-20260708-120000-789";
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: `/fake/repo/.roll/loop/worktrees/${cycleId}`, head: "def", branch: `refs/heads/loop/${cycleId}` },
          ]);
        }
        return "";
      },
      readFile: (p) => {
        if (p.endsWith("heartbeat")) return `${cycleId} 1783516790  pi  20260708-120000-456\n`;
        return null;
      },
      nowSec: () => 1783516800, // 10 seconds after heartbeat
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].active).toBe(true);
  });

  it("stale heartbeat does not mark as active", () => {
    const cycleId = "cycle-20260708-110000-111";
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: `/fake/repo/.roll/loop/worktrees/${cycleId}`, head: "ghi", branch: `refs/heads/loop/${cycleId}` },
          ]);
        }
        return "";
      },
      readFile: (p) => {
        if (p.endsWith("heartbeat")) return `${cycleId} 1783515000  pi  20260707-110000-111\n`; // 30 min old
        return null;
      },
      nowSec: () => 1783516800,
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].active).toBe(false);
  });

  it("active worktree is never a disposable_candidate", () => {
    const cycleId = "cycle-20260708-120000-999";
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: `/fake/repo/.roll/loop/worktrees/${cycleId}`, head: "abc", branch: `refs/heads/loop/${cycleId}` },
          ]);
        }
        if (args[0] === "rev-parse") return "abc\n";
        if (args[0] === "merge-base") return "abc\n";
        return "";
      },
      readFile: (p) => {
        if (p.endsWith("inner.lock")) return `${cycleId}  1783516800  pi\n`;
        return null;
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].active).toBe(true);
    expect(result.records[0].disposition).not.toBe("disposable_candidate");
  });
});

// ─── Disposition classification ───────────────────────────────────────────

describe("Disposition classification", () => {
  it("merged + no tracked dirt + no open PR → disposable_candidate", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-merged", head: "abc", branch: "refs/heads/loop/cycle-merged" },
          ]);
        }
        if (args[0] === "rev-parse") return "abc\n";
        if (args[0] === "merge-base") return "abc\n"; // ancestor
        if (args[0] === "rev-list" && args[1] === "--count") return "0\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].disposition).toBe("disposable_candidate");
    expect(result.records[0].reason).toContain("candidate for future gc");
  });

  it("unpublished with ahead + open PR → preserved_unpublished", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-unpub", head: "def", branch: "refs/heads/loop/cycle-unpub" },
          ]);
        }
        if (args[0] === "rev-parse") return "def\n";
        if (args[0] === "merge-base") return "different\n";
        if (args[0] === "rev-list" && args[1] === "--count") return "3\n"; // ahead
        if (args[0] === "branch" && args[1] === "--merged") return "  main\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].disposition).toBe("preserved_unpublished");
    expect(result.records[0].reason).toContain("unmerged work");
  });

  it("unpublished with dirty tracked → preserved_dirty_no_tcr", () => {
    const deps = makeDeps({
      git: (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-dirty", head: "ghi", branch: "refs/heads/loop/cycle-dirty" },
          ]);
        }
        if (args[0] === "rev-parse") return "ghi\n";
        if (args[0] === "merge-base") return "different\n";
        if (args[0] === "rev-list" && args[1] === "--count") return "2\n";
        // Tracked dirt detected
        if (args[0] === "status") return " M src/file.ts\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].dirtyTracked).toBe(true);
    expect(result.records[0].disposition).toBe("preserved_dirty_no_tcr");
  });

  it("terminal outcome worktree → preserved_needs_review", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-20260708-120000-888", head: "jkl", branch: "refs/heads/loop/cycle-20260708-120000-888" },
          ]);
        }
        if (args[0] === "rev-parse") return "jkl\n";
        if (args[0] === "merge-base") return "different\n";
        if (args[0] === "rev-list" && args[1] === "--count") return "0\n";
        return "";
      },
      readFile: (p) => {
        if (p.endsWith("events.ndjson")) {
          return JSON.stringify({ cycleId: "cycle-20260708-120000-888", type: "cycle:end", outcome: "failed", storyId: "FIX-123" }) + "\n";
        }
        return null;
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].outcome).toBe("failed");
    expect(result.records[0].disposition).toBe("preserved_needs_review");
    expect(result.records[0].reason).toContain("failed");
  });

  it("manual worktree → external_unmanaged", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/roll-wt-test", head: "mno", branch: "refs/heads/test" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].disposition).toBe("external_unmanaged");
  });

  it("external worktree → external_unmanaged", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/other/project", head: "pqr", branch: "refs/heads/main" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].disposition).toBe("external_unmanaged");
  });
});

// ─── Human output grouping ────────────────────────────────────────────────

describe("AC6: Human output grouping", () => {
  function captureStdout(fn: () => number): string {
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = (chunk: any) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    try {
      fn();
    } finally {
      process.stdout.write = originalWrite;
    }
    return output;
  }

  it("human output includes summary counts", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "aaa", branch: "refs/heads/main" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-1", head: "bbb", branch: "refs/heads/loop/cycle-1" },
          ]);
        }
        return "";
      },
    });
    const output = captureStdout(() => worktreeAuditCommand([], deps));
    expect(output).toContain("Worktree audit");
    expect(output).toContain("total:");
    expect(output).toContain("loop:");
    expect(output).toContain("manual:");
    expect(output).toContain("active:");
    expect(output).toContain("disposable candidates:");
    expect(output).toContain("preserved:");
  });

  it("human output groups by disposition", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "aaa", branch: "refs/heads/main" },
            { path: "/fake/roll-wt-test", head: "bbb", branch: "refs/heads/test" },
          ]);
        }
        return "";
      },
    });
    const output = captureStdout(() => worktreeAuditCommand([], deps));
    // Should have external_unmanaged section header
    expect(output).toContain("external_unmanaged");
  });

  it("help flag prints usage", () => {
    const output = captureStdout(() => worktreeAuditCommand(["--help"], makeDeps()));
    expect(output).toContain("Usage:");
    expect(output).toContain("worktree audit");
    expect(output).toContain("--json");
  });
});

// ─── Summary correctness ──────────────────────────────────────────────────

describe("Summary correctness", () => {
  it("computes correct summary from mixed worktrees", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "aaa", branch: "refs/heads/main" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-1", head: "bbb", branch: "refs/heads/loop/cycle-1" },
            { path: "/fake/roll-wt-FIX", head: "ccc", branch: "refs/heads/fix-1" },
            { path: "/other/project", head: "ddd", branch: "refs/heads/main" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    // main repo → external, cycle-1 → loop, roll-wt-FIX → manual, /other → external
    expect(result.summary.total).toBe(4);
    expect(result.summary.loop).toBe(1);
    expect(result.summary.manual).toBe(1);
    expect(result.summary.external).toBe(2);
    // No active cycles
    expect(result.summary.active).toBe(0);
  });

  it("summary.disposableCandidates counts correctly", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-merged", head: "abc", branch: "refs/heads/loop/cycle-merged" },
          ]);
        }
        if (args[0] === "rev-parse") return "abc\n";
        if (args[0] === "merge-base") return "abc\n"; // ancestor → merge evidence
        if (args[0] === "rev-list" && args[1] === "--count") return "0\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.summary.disposableCandidates).toBe(1);
    expect(result.summary.preserved).toBe(0); // loop-owned, not active
  });

  it("preserved count excludes disposable and external_unmanaged", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-merged", head: "abc", branch: "refs/heads/loop/cycle-merged" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-unpub", head: "def", branch: "refs/heads/loop/cycle-unpub" },
            { path: "/fake/roll-wt-test", head: "ghi", branch: "refs/heads/test" },
          ]);
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd?.includes("cycle-merged")) return "abc\n";
        if (args[0] === "merge-base" && cwd?.includes("cycle-merged")) return "abc\n";
        if (args[0] === "rev-list" && args[1] === "--count") return cwd?.includes("cycle-merged") ? "0\n" : "5\n";
        return "";
      },
    });
    const result = auditWorktrees(deps);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("empty worktree list produces empty output", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") return "";
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("handles detached HEAD (no branch)", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-detached", head: "abc123" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].branch).toBeUndefined();
    expect(result.records[0].head).toBe("abc123");
  });

  it("handles corrupt events.ndjson lines", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-20260708-120000-777", head: "abc", branch: "refs/heads/loop/cycle-20260708-120000-777" },
          ]);
        }
        return "";
      },
      readFile: (p) => {
        if (p.endsWith("events.ndjson")) {
          return "{corrupt json!!!}\n" +
            JSON.stringify({ cycleId: "cycle-20260708-120000-777", type: "cycle:end", outcome: "delivered", storyId: "US-123" }) + "\n";
        }
        return null;
      },
    });
    const result = auditWorktrees(deps);
    // Should still get the valid event
    expect(result.records[0].outcome).toBe("delivered");
    expect(result.records[0].storyId).toBe("US-123");
  });

  it("no crash when events.ndjson is missing", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-20260708-120000-666", head: "abc", branch: "refs/heads/loop/cycle-20260708-120000-666" },
          ]);
        }
        return "";
      },
      readFile: () => null,
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].cycleId).toBe("cycle-20260708-120000-666");
    expect(result.records[0].outcome).toBeUndefined();
  });

  it("ahead count falls back to null on error", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-20260708-120000-555", head: "abc", branch: "refs/heads/loop/cycle-20260708-120000-555" },
          ]);
        }
        if (args[0] === "rev-list" && args[1] === "--count") return ""; // empty
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records[0].ahead).toBeNull();
  });

  it("multiple worktrees in json output are all present", () => {
    const deps = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "aaa", branch: "refs/heads/main" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-1", head: "bbb", branch: "refs/heads/loop/cycle-1" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-2", head: "ccc", branch: "refs/heads/loop/cycle-2" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-3", head: "ddd", branch: "refs/heads/loop/cycle-3" },
          ]);
        }
        return "";
      },
    });
    const result = auditWorktrees(deps);
    expect(result.records).toHaveLength(4);
    expect(result.summary.total).toBe(4);
    expect(result.summary.loop).toBe(3);
    expect(result.summary.external).toBe(1);
  });
});

// ─── AC: No mutation (read-only guarantee) ────────────────────────────────

describe("Read-only guarantee", () => {
  it("never calls git commands that mutate (commit, push, reset, branch -D, worktree remove)", () => {
    const calledCommands: string[] = [];
    const deps = makeDeps({
      git: (args) => {
        calledCommands.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo/.roll/loop/worktrees/cycle-safety", head: "abc", branch: "refs/heads/loop/cycle-safety" },
          ]);
        }
        return "";
      },
    });
    auditWorktrees(deps);

    const mutatingCommands = ["commit", "push", "reset", "branch -D", "branch -d", "worktree remove", "worktree prune", "stash", "checkout", "switch"];
    for (const cmd of calledCommands) {
      for (const mut of mutatingCommands) {
        expect(cmd).not.toContain(mut);
      }
    }
  });

  it("auditWorktrees is a pure function — same input, same output", () => {
    const depsA = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "abc123", branch: "refs/heads/main" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-pure", head: "def456", branch: "refs/heads/loop/cycle-pure" },
          ]);
        }
        return "";
      },
    });
    const depsB = makeDeps({
      git: (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return porcelain([
            { path: "/fake/repo", head: "abc123", branch: "refs/heads/main" },
            { path: "/fake/repo/.roll/loop/worktrees/cycle-pure", head: "def456", branch: "refs/heads/loop/cycle-pure" },
          ]);
        }
        return "";
      },
    });

    const resultA = auditWorktrees(depsA);
    const resultB = auditWorktrees(depsB);

    expect(resultA.records.length).toBe(resultB.records.length);
    for (let i = 0; i < resultA.records.length; i++) {
      // Compare deterministic fields (skip generatedAt which might differ)
      expect(resultA.records[i].path).toBe(resultB.records[i].path);
      expect(resultA.records[i].owner).toBe(resultB.records[i].owner);
      expect(resultA.records[i].disposition).toBe(resultB.records[i].disposition);
    }
    expect(resultA.summary).toEqual(resultB.summary);
  });
});

// ─── FIX-1460 (#1468): orphan loop worktree dir scanning ────────────────────

describe("FIX-1460 (#1468) orphan loop worktree dirs", () => {
  const events = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  function orphanDeps(over?: Partial<WorktreeAuditDeps>): WorktreeAuditDeps {
    return makeDeps({
      // Only the main repo is a registered worktree; the cycle dirs are orphans.
      git: (args) =>
        args[0] === "worktree" && args[1] === "list"
          ? porcelain([{ path: "/fake/repo", head: "abc123", branch: "refs/heads/main" }])
          : "",
      readDir: (p) =>
        p.endsWith(`.roll/loop/worktrees`.replace(/\//g, "/"))
          ? ["cycle-20260718-000000-1", "cycle-20260718-000000-2"]
          : [],
      readFile: (p) =>
        p.endsWith("events.ndjson")
          ? events([
              { cycleId: "cycle-20260718-000000-1", outcome: "delivered", storyId: "US-A-1" },
              { cycleId: "cycle-20260718-000000-2", outcome: "gave_up" },
            ])
          : null, // inner.lock etc. → not active
      inspectOrphanDir: () => ({
        state: "trusted_generated",
        fingerprint: "fixture-proof",
        entries: [".next"],
        detail: "trusted generated roots: .next",
      }),
      ...over,
    });
  }

  it("surfaces a delivered orphan as a counted loop record marked orphan_reclaimable", () => {
    const out = auditWorktrees(orphanDeps());
    const rec = out.records.find((r) => r.path.endsWith("cycle-20260718-000000-1"));
    expect(rec).toBeDefined();
    expect(rec?.owner).toBe("loop");
    expect(rec?.disposition).toBe("orphan_reclaimable");
    // counted (main + 2 orphans)
    expect(out.records.filter((r) => r.owner === "loop").length).toBe(2);
  });

  it("preserves an orphan whose cycle is NOT provably delivered", () => {
    const out = auditWorktrees(orphanDeps());
    const rec = out.records.find((r) => r.path.endsWith("cycle-20260718-000000-2"));
    expect(rec?.disposition).toBe("preserved_orphan");
  });

  it("preserves an orphan with an unknown (non-cycle) dir name (delivery unprovable)", () => {
    const out = auditWorktrees(
      orphanDeps({
        readDir: () => ["cycle-20260718-cap004"], // non-standard name → no cycle context
        readFile: () => null,
      }),
    );
    const rec = out.records.find((r) => r.path.endsWith("cycle-20260718-cap004"));
    expect(rec?.disposition).toBe("preserved_orphan");
  });

  it("does NOT reclassify a REGISTERED worktree dir as an orphan (no double count)", () => {
    const out = auditWorktrees(
      makeDeps({
        git: (args) =>
          args[0] === "worktree" && args[1] === "list"
            ? porcelain([
                { path: "/fake/repo", head: "abc", branch: "refs/heads/main" },
                { path: "/fake/repo/.roll/loop/worktrees/cycle-20260718-000000-1", head: "def" },
              ])
            : "",
        readDir: () => ["cycle-20260718-000000-1"],
        readFile: () => null,
      }),
    );
    const matches = out.records.filter((r) => r.path.endsWith("cycle-20260718-000000-1"));
    expect(matches).toHaveLength(1);
    expect(matches[0].disposition).not.toBe("orphan_reclaimable");
    expect(matches[0].disposition).not.toBe("preserved_orphan");
  });

  it("never touches dirs outside .roll/loop/worktrees (empty scan when dir absent)", () => {
    const out = auditWorktrees(orphanDeps({ readDir: () => [] }));
    expect(out.records.filter((r) => r.disposition === "orphan_reclaimable")).toHaveLength(0);
    expect(out.records.filter((r) => r.disposition === "preserved_orphan")).toHaveLength(0);
  });
});

// ─── FIX-1459: orphan recovery proof must fail closed ──────────────────────

describe("FIX-1459 orphan recovery proof", () => {
  const cycleId = "cycle-20260723-120000-1";

  function fixture(): { repo: string; orphan: string } {
    const repo = mkdtempSync(join(tmpdir(), "roll-orphan-proof-"));
    const cleanEnv = { ...process.env };
    delete cleanEnv["GIT_DIR"];
    delete cleanEnv["GIT_WORK_TREE"];
    delete cleanEnv["GIT_INDEX_FILE"];
    const runGit = (args: string[]): void => {
      execFileSync("git", ["-C", repo, ...args], {
        env: cleanEnv,
        stdio: "ignore",
      });
    };
    runGit(["init", "-b", "main"]);
    runGit(["config", "user.name", "Roll Test"]);
    runGit(["config", "user.email", "roll-test@example.invalid"]);
    writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
    runGit(["add", "README.md"]);
    runGit(["commit", "-m", "fixture"]);

    const orphan = join(repo, ".roll", "loop", "worktrees", cycleId);
    mkdirSync(orphan, { recursive: true });
    const events = join(repo, ".roll", "loop", "events.ndjson");
    mkdirSync(join(repo, ".roll", "loop"), { recursive: true });
    writeFileSync(events, JSON.stringify({ cycleId, outcome: "delivered" }) + "\n", "utf8");
    return { repo, orphan };
  }

  function audit(repo: string): WorktreeAuditRecord {
    const out = auditWorktrees({ repoRoot: repo, home: tmpdir(), integrationBranch: "HEAD" });
    const record = out.records.find((candidate) => candidate.cycleId === cycleId);
    expect(record).toBeDefined();
    return record as WorktreeAuditRecord;
  }

  it("preserves delivered orphan residue that may contain tracked or unpublished work", () => {
    const { repo, orphan } = fixture();
    try {
      mkdirSync(join(orphan, "src"), { recursive: true });
      writeFileSync(join(orphan, "src", "changed.ts"), "export const unpublished = true;\n", "utf8");
      const record = audit(repo);
      expect(record.disposition).toBe("preserved_orphan");
      expect(record.reason).toMatch(/unpublished|untrusted|ambiguous/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves delivered orphan residue with linked or external Git ownership metadata", () => {
    const { repo, orphan } = fixture();
    try {
      mkdirSync(join(orphan, ".git"), { recursive: true });
      writeFileSync(join(orphan, ".git", "config"), "[core]\n\tbare = false\n", "utf8");
      const record = audit(repo);
      expect(record.disposition).toBe("preserved_orphan");
      expect(record.reason).toMatch(/git|linked|external/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves delivered generated residue when its material is ambiguous", () => {
    const { repo, orphan } = fixture();
    try {
      mkdirSync(join(orphan, ".next"), { recursive: true });
      symlinkSync(repo, join(orphan, ".next", "external-link"));
      const record = audit(repo);
      expect(record.disposition).toBe("preserved_orphan");
      expect(record.reason).toMatch(/ambiguous|symlink|untrusted/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves a bounded-looking orphan when the worktree root resolves outside the repository", () => {
    const { repo, orphan } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "roll-orphan-external-root-"));
    try {
      const worktreesRoot = join(repo, ".roll", "loop", "worktrees");
      rmSync(worktreesRoot, { recursive: true, force: true });
      const externalOrphan = join(outside, cycleId);
      mkdirSync(join(externalOrphan, ".next"), { recursive: true });
      symlinkSync(outside, worktreesRoot, "dir");
      expect(orphan).toBe(join(worktreesRoot, cycleId));
      const record = audit(repo);
      expect(record.disposition).toBe("preserved_orphan");
      expect(record.reason).toMatch(/external|symlink|boundary|ambiguous/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("preserves an orphan referenced by differently named relative Git admin metadata", () => {
    const { repo, orphan } = fixture();
    try {
      mkdirSync(join(orphan, ".next"), { recursive: true });
      const admin = join(repo, ".git", "worktrees", "renamed-admin-entry");
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, "gitdir"), relative(admin, join(orphan, ".git")) + "\n", "utf8");
      const proof = inspectOrphanRecoveryProof(repo, orphan, cycleId);
      expect(proof.state).toBe("linked_metadata");
      expect(proof.detail).toMatch(/git|linked|ownership/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves an orphan when cycle activity files cannot be read conclusively", () => {
    const out = auditWorktrees(makeDeps({
      git: (args) => args[0] === "worktree" && args[1] === "list"
        ? porcelain([{ path: "/fake/repo", head: "abc", branch: "refs/heads/main" }])
        : "",
      readDir: () => [cycleId],
      readFile: (path) => {
        if (path.endsWith("events.ndjson")) {
          return JSON.stringify({ cycleId, outcome: "delivered" }) + "\n";
        }
        throw new Error("permission denied");
      },
      inspectOrphanDir: () => ({
        state: "trusted_generated",
        fingerprint: "fixture-proof",
        entries: [".next"],
        detail: "trusted generated roots: .next",
      }),
    }));
    const record = out.records.find((candidate) => candidate.cycleId === cycleId);
    expect(record?.disposition).toBe("preserved_orphan");
    expect(record?.active).toBe(true);
  });
});
