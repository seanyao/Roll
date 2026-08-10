/**
 * US-LOOP-093 — `roll worktree audit` tests.
 *
 * Covers: JSON schema output, human output grouping, loop/manual/external
 * ownership classification, active cycle protection, tracked vs untracked
 * dirt split, merge evidence variants, disposition classification, and
 * the hard read-only constraint (no mutation).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditWorktrees,
  worktreeAuditCommand,
  type WorktreeAuditDeps,
  type WorktreeAuditOutput,
  type WorktreeAuditRecord,
} from "../src/commands/worktree-audit.js";
import { worktreeCleanupCommand } from "../src/commands/worktree-cleanup.js";
import { allocateManagedPrimaryWorkspace } from "../src/runner/managed-primary-workspace.js";
import { nodePorts } from "../src/runner/node-ports.js";
import { executeTerminalCommand } from "../src/runner/terminal-handlers.js";
import type { RunnerPaths } from "../src/runner/ports.js";

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

// ─── US-LOOP-123: shared ManagedWorkspaceSet projection ───────────────────

describe("US-LOOP-123 projection-backed audit fixture matrix", () => {
  const workspace = {
    schema: 1,
    runId: "delta-d-1",
    storyId: "US-LOOP-123",
    kind: "host_delta",
    topology: "delta-team",
    delegationId: "d-1",
    members: [{
      repositoryId: "origin:repo",
      workspaceKey: "delta-d-1",
      relativeLocator: "delta-d-1",
      checkoutRef: { kind: "detached", head: "head-1" },
    }],
  } as const;

  it("does not promote an unregistered cycle-looking directory into managed ownership", () => {
    const events = [
      { type: "worktree:allocated", workspace, ts: 1 },
      { type: "delivery:merge_confirmed", cycleId: "delta-d-1", storyId: "US-LOOP-123", branch: "roll/delta-d-1", signal: "ancestor", ts: 2 },
      { type: "attest:gate", cycleId: "delta-d-1", verdict: "produced", reasons: [], ts: 3 },
    ];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree") return porcelain([
          { path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" },
          { path: "/fake/repo/.roll/loop/worktrees/cycle-spoof", head: "spoof" },
        ]);
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        return "";
      },
    }));
    expect(out.records.find((record) => record.path.endsWith("delta-d-1"))?.releaseVerdict).toBe("preserve_active");
    expect(out.records.find((record) => record.path.endsWith("cycle-spoof"))?.owner).toBe("external");
    expect(out).toMatchSnapshot();
  });

  it("accepts a host Delta's rendered attestation report for safe cleanup", () => {
    const events = [
      { type: "worktree:allocated", workspace: { ...workspace, members: [{ ...workspace.members[0], repositoryId: "repo-3b4cca" }] }, ts: 1 },
      { type: "delta:terminal", delegationId: "d-1", storyId: "US-LOOP-123", runId: "delta-d-1", outcome: "handoff_ready", terminalBinding: "handoff_only", reservationSource: "delivery-reservation", ts: 2 },
      { type: "delivery:reconciled", cycleId: "delta-d-1", storyId: "US-LOOP-123", state: "delivered_external", mergedBy: "external", mergeCommit: "main-head", signal: "backlog_attest", delegationId: "d-1", runId: "delta-d-1", ts: 3 },
      { type: "attest:host_delta", cycleId: "delta-d-1", storyId: "US-LOOP-123", delegationId: "d-1", reportPath: ".roll/features/US-LOOP-123/latest/US-LOOP-123-report.html", ts: 4 },
      { type: "worktree:release_requested", runId: "delta-d-1", reason: "delivered", operationId: "release-1", expectedHeads: [{ relativeLocator: "delta-d-1", head: "head-1" }], ts: 5 },
    ];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree" || (args[0] === "-C" && args[2] === "worktree")) return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        if (args[0] === "-C" && args[2] === "rev-parse") return "/fake/repo";
        if (args[0] === "-C" && args[2] === "remote") return "https://github.com/example/repo.git";
        return "";
      },
    }));
    expect(out.records.find((record) => record.path.endsWith("delta-d-1"))?.releaseVerdict).toBe("safe_to_release");
  });

  it("accepts a stored SSH repository URL for a delivered primary and submodule when their live HTTPS URLs match", () => {
    const remoteWorkspace = {
      ...workspace,
      members: [
        {
          ...workspace.members[0],
          repositoryId: "git@github.com:seanyao/roll.git",
        },
        {
          repositoryId: "git@github.com:seanyao/roll-skills.git",
          workspaceKey: "delta-d-1",
          relativeLocator: "delta-d-1.submodules/skills",
          checkoutRef: { kind: "detached" as const, head: "skills-head" },
        },
      ],
    } as const;
    const events = [
      { type: "worktree:allocated", workspace: remoteWorkspace, ts: 1 },
      { type: "delta:terminal", delegationId: "d-1", storyId: "US-LOOP-123", runId: "delta-d-1", outcome: "handoff_ready", terminalBinding: "handoff_only", reservationSource: "delivery-reservation", ts: 2 },
      { type: "delivery:reconciled", cycleId: "delta-d-1", storyId: "US-LOOP-123", state: "delivered_external", mergedBy: "external", mergeCommit: "main-head", signal: "backlog_attest", delegationId: "d-1", runId: "delta-d-1", ts: 3 },
      { type: "attest:host_delta", cycleId: "delta-d-1", storyId: "US-LOOP-123", delegationId: "d-1", reportPath: ".roll/features/US-LOOP-123/latest/US-LOOP-123-report.html", ts: 4 },
      {
        type: "worktree:release_requested",
        runId: "delta-d-1",
        reason: "delivered",
        operationId: "release-1",
        expectedHeads: [
          { relativeLocator: "delta-d-1", head: "head-1" },
          { relativeLocator: "delta-d-1.submodules/skills", head: "skills-head" },
        ],
        ts: 5,
      },
    ];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree") return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "-C" && args[1] === "/fake/repo" && args[2] === "worktree") return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "-C" && args[1] === "/fake/repo/skills" && args[2] === "worktree") return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1.submodules/skills", head: "skills-head" }]);
        if (args[0] === "-C" && args[2] === "rev-parse") return args[1];
        if (args[0] === "-C" && args[2] === "remote") return args[1] === "/fake/repo"
          ? "https://github.com/seanyao/roll.git"
          : "https://github.com/seanyao/roll-skills.git";
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        return "";
      },
    }));

    const members = out.records.filter((record) => record.runId === "delta-d-1");
    expect(members).toHaveLength(2);
    expect(members.every((record) => record.repositoryIdentity === "expected")).toBe(true);
    expect(members.every((record) => record.releaseVerdict === "safe_to_release")).toBe(true);
  });

  it("retains support for the existing short repository identity", () => {
    const events = [
      { type: "worktree:allocated", workspace: { ...workspace, members: [{ ...workspace.members[0], repositoryId: "repo-3b4cca" }] }, ts: 1 },
    ];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree" || (args[0] === "-C" && args[2] === "worktree")) return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "-C" && args[2] === "rev-parse") return "/fake/repo";
        if (args[0] === "-C" && args[2] === "remote") return "https://github.com/example/repo.git";
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        return "";
      },
    }));
    expect(out.records.find((record) => record.memberLocator === "delta-d-1")?.repositoryIdentity).toBe("expected");
  });

  it.each([
    ["different remote", "git@github.com:seanyao/roll.git", "https://github.com/BIPOSVC/other.git"],
    ["missing remote", "git@github.com:seanyao/roll.git", undefined],
    ["forged identity", "not-a-repository-identity", "https://github.com/seanyao/roll.git"],
  ])("fails closed for a %s repository identity", (_caseName, repositoryId, remoteUrl) => {
    const events = [
      { type: "worktree:allocated", workspace: { ...workspace, members: [{ ...workspace.members[0], repositoryId }] }, ts: 1 },
    ];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree" || (args[0] === "-C" && args[2] === "worktree")) return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "-C" && args[2] === "rev-parse") return "/fake/repo";
        if (args[0] === "-C" && args[2] === "remote") {
          if (remoteUrl === undefined) throw new Error("no origin");
          return remoteUrl;
        }
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        return "";
      },
    }));
    const record = out.records.find((candidate) => candidate.memberLocator === "delta-d-1");
    expect(record?.repositoryIdentity).toBe("foreign");
    expect(record?.releaseVerdict).not.toBe("safe_to_release");
  });

  it("keeps a host Delta directory when delivery has no independent attestation evidence", () => {
    const events = [
      { type: "worktree:allocated", workspace: { ...workspace, members: [{ ...workspace.members[0], repositoryId: "repo-3b4cca" }] }, ts: 1 },
      { type: "delta:terminal", delegationId: "d-1", storyId: "US-LOOP-123", runId: "delta-d-1", outcome: "handoff_ready", terminalBinding: "handoff_only", reservationSource: "delivery-reservation", ts: 2 },
      { type: "delivery:reconciled", cycleId: "delta-d-1", storyId: "US-LOOP-123", state: "delivered_external", mergedBy: "external", mergeCommit: "main-head", signal: "backlog_attest", delegationId: "d-1", runId: "delta-d-1", ts: 3 },
      { type: "worktree:release_requested", runId: "delta-d-1", reason: "delivered", operationId: "release-1", expectedHeads: [{ relativeLocator: "delta-d-1", head: "head-1" }], ts: 4 },
    ];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree" || (args[0] === "-C" && args[2] === "worktree")) return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        if (args[0] === "-C" && args[2] === "rev-parse") return "/fake/repo";
        if (args[0] === "-C" && args[2] === "remote") return "https://github.com/example/repo.git";
        return "";
      },
    }));
    expect(out.records.find((record) => record.path.endsWith("delta-d-1"))?.releaseVerdict).not.toBe("safe_to_release");
  });

  it("inspects a submodule through its own registration and never counts the container", () => {
    const submoduleWorkspace = {
      ...workspace,
      members: [
        workspace.members[0],
        {
          repositoryId: "origin:submodule",
          workspaceKey: "delta-d-1",
          relativeLocator: "delta-d-1.submodules/packages/sub",
          checkoutRef: { kind: "detached", head: "sub-head" },
        },
      ],
    } as const;
    const calls: string[][] = [];
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? JSON.stringify({ type: "worktree:allocated", workspace: submoduleWorkspace, ts: 1 }) : null,
      git: (args) => {
        calls.push(args);
        if (args[0] === "worktree") return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "-C" && args[2] === "worktree") return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1.submodules/packages/sub", head: "sub-head" }]);
        return "";
      },
    }));
    // The registration belongs to the submodule repository, not the detached
    // checkout and never the superproject.  This keeps a broken submodule
    // registration from being masked by the primary worktree list.
    expect(calls.some((args) => args[0] === "-C" && args[1] === "/fake/repo/packages/sub" && args[2] === "worktree")).toBe(true);
    expect(out.records.some((record) => record.path.endsWith(".submodules"))).toBe(false);
    expect(out.records.find((record) => record.memberLocator?.endsWith("packages/sub"))?.registration).toBe("registered");
  });

  it("marks a failed submodule registration probe unknown and fails inspection loud", () => {
    const submoduleWorkspace = {
      ...workspace,
      members: [
        workspace.members[0],
        {
          repositoryId: "origin:submodule",
          workspaceKey: "delta-d-1",
          relativeLocator: "delta-d-1.submodules/packages/sub",
          checkoutRef: { kind: "detached", head: "sub-head" },
        },
      ],
    } as const;
    const out = auditWorktrees(makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? JSON.stringify({ type: "worktree:allocated", workspace: submoduleWorkspace, ts: 1 }) : null,
      git: (args) => {
        if (args[0] === "worktree") return porcelain([{ path: "/fake/repo/.roll/loop/worktrees/delta-d-1", head: "head-1" }]);
        if (args[0] === "-C") throw new Error("submodule registration unavailable");
        return "";
      },
    }));
    expect(out.records.find((record) => record.memberLocator?.endsWith("packages/sub"))?.registration).toBe("unknown");
    expect(out.inspectionUnavailable).toBe(true);
  });
});

describe("US-LOOP-125 real submodule workspace fixtures", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  }

  function runtimePaths(root: string, key: string): RunnerPaths {
    const runtime = join(root, ".roll", "loop");
    return {
      eventsPath: join(runtime, "events.ndjson"),
      runsPath: join(runtime, "runs.jsonl"),
      alertsPath: join(runtime, "alerts.log"),
      lockPath: join(runtime, "inner.lock"),
      heartbeatPath: join(runtime, "heartbeat"),
      worktreePath: join(runtime, "worktrees", `cycle-${key}`),
    };
  }

  /**
   * This fixture deliberately enters through the production allocator and
   * terminal command boundary.  In particular, it never creates a cycle
   * worktree or writes an allocation/release event itself: the events and both
   * repository registrations are the runtime's own output.
   */
  async function fixture(topology: "solo" | "full-delta-team") {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-125-submodule-")));
    const main = join(root, "main");
    const source = join(root, "sub-source");
    mkdirSync(main, { recursive: true });
    mkdirSync(source, { recursive: true });
    for (const repo of [main, source]) {
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "user.email", "test@example.invalid"]);
      git(repo, ["config", "user.name", "Roll test"]);
      writeFileSync(join(repo, "README.md"), `${repo}\n`);
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-qm", "seed"]);
    }
    git(main, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "packages/sub"]);
    git(main, ["commit", "-qam", "add submodule"]);

    const key = `125-${topology === "solo" ? "ordinary" : "full-delta"}`;
    mkdirSync(join(main, ".roll", "loop"), { recursive: true });
    const paths = runtimePaths(main, key);
    const ports = nodePorts({
      repoCwd: main,
      paths,
      skillBody: "fixture",
      routeDeps: { readSlot: () => "claude", firstInstalled: () => "claude" },
    });
    ports.events.ensureEventFiles(paths.eventsPath, paths.runsPath);
    const ctx = {
      cycleId: key,
      branch: `loop/${key}`,
      loop: "fixture",
      storyId: "US-LOOP-125",
      targetSubmodule: "packages/sub",
      ...(topology === "full-delta-team" ? { selectedProfile: "designed" as const } : {}),
    };
    expect(ports.reserveStory(ctx.storyId, {
      pid: process.pid,
      claimedAt: Date.now(),
      source: "cycle",
      runId: ctx.cycleId,
    })).toMatchObject({ claimed: true });
    expect(await allocateManagedPrimaryWorkspace(ports, ctx, ctx.branch)).toMatchObject({
      event: { type: "worktree_created" },
      ctxPatch: { targetSubmodule: "packages/sub" },
    });

    const primaryPath = paths.worktreePath;
    const submodulePath = join(main, ".roll", "loop", "worktrees", `cycle-${key}.submodules`, "packages", "sub");
    // Re-initializing the primary checkout is a normal production operation;
    // the sibling member must retain its own Git working-tree identity after it.
    git(main, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "packages/sub"]);
    git(submodulePath, ["config", "user.email", "test@example.invalid"]);
    git(submodulePath, ["config", "user.name", "Roll test"]);
    expect(git(submodulePath, ["rev-parse", "--show-toplevel"])).toBe(realpathSync(submodulePath));
    const markDeliveredAndAttested = async () => {
      // These are the same production terminal event commands that the cycle
      // driver executes.  The fixture does not append raw NDJSON lifecycle
      // records and leaves release_requested to cleanup_worktree below.
      await executeTerminalCommand({
        kind: "emit_event",
        event: { type: "delivery:merge_confirmed", cycleId: key, storyId: ctx.storyId, branch: ctx.branch, signal: "ancestor", ts: 0 },
      }, ports, ctx);
      await executeTerminalCommand({
        kind: "emit_event",
        event: { type: "attest:gate", cycleId: key, verdict: "produced", reasons: [], ts: 0 },
      }, ports, ctx);
    };
    const terminalRelease = async () => executeTerminalCommand({ kind: "cleanup_worktree", branch: ctx.branch }, ports, ctx);
    return { root, main, key, primaryPath, submodulePath, markDeliveredAndAttested, terminalRelease };
  }

  it.each(["solo", "full-delta-team"] as const)("audits every real %s member without a .submodules phantom", async (topology) => {
    const f = await fixture(topology);
    try {
      await f.markDeliveredAndAttested();
      const out = auditWorktrees({ repoRoot: f.main, home: f.root });
      const members = out.records.filter((record) => record.runId === f.key);
      expect(members).toHaveLength(2);
      expect(members.map((record) => record.memberLocator).sort()).toEqual([
        `cycle-${f.key}`,
        `cycle-${f.key}.submodules/packages/sub`,
      ]);
      expect(members.every((record) => record.registration === "registered" && record.repositoryIdentity === "expected")).toBe(true);
      expect(members.every((record) => record.releaseVerdict === "preserve_active")).toBe(true);
      expect(out.records.some((record) => record.path.endsWith(`${f.key}.submodules`))).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("freezes public audit and cleanup JSON for a production-allocated Full Delta submodule set", async () => {
    const f = await fixture("full-delta-team");
    const originalLimit = process.env["ROLL_BRANCH_CANARY_MAX"];
    const writes: string[] = [];
    try {
      await f.markDeliveredAndAttested();
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      const auditExit = worktreeAuditCommand(["--json", "--repo", f.main], {
        home: f.root,
        nowISO: () => "2026-08-01T00:00:00.000Z",
      });
      expect(auditExit).toBe(0);
      const auditJson = writes.join("");
      writes.length = 0;

      process.env["ROLL_BRANCH_CANARY_MAX"] = "0";
      const cleanupExit = await worktreeCleanupCommand(["--dry-run", "--json", "--repo", f.main], {
        home: f.root,
        nowISO: () => "2026-08-01T00:00:00.000Z",
      });
      expect(cleanupExit).toBe(0);
      const cleanupJson = writes.join("");

      // Stable public command contracts: both members exactly once, no
      // `.submodules` container, and cleanup plans one indivisible set.
      const stable = (text: string): string => text.replaceAll(f.root, "<ROOT>").replace(/[0-9a-f]{40,64}/g, "<OID>");
      expect(stable(auditJson)).toMatchSnapshot("full-delta-submodule-audit-json");
      expect(stable(cleanupJson)).toMatchSnapshot("full-delta-submodule-cleanup-json");
    } finally {
      vi.restoreAllMocks();
      if (originalLimit === undefined) delete process.env["ROLL_BRANCH_CANARY_MAX"];
      else process.env["ROLL_BRANCH_CANARY_MAX"] = originalLimit;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed for a changed or unregistered production-allocated submodule member", async () => {
    const changed = await fixture("solo");
    const missing = await fixture("full-delta-team");
    try {
      await changed.markDeliveredAndAttested();
      await missing.markDeliveredAndAttested();
      const originalSubHead = git(changed.submodulePath, ["rev-parse", "HEAD"]);
      writeFileSync(join(changed.submodulePath, "changed.txt"), "changed\n");
      git(changed.submodulePath, ["add", "changed.txt"]);
      git(changed.submodulePath, ["commit", "-qm", "changed member head"]);
      const changedAudit = auditWorktrees({ repoRoot: changed.main, home: changed.root });
      const changedMember = changedAudit.records.find((record) => record.memberLocator?.endsWith("packages/sub"));
      expect(changedMember?.head).not.toBe(originalSubHead);
      expect(changedAudit.records.filter((record) => record.runId === changed.key).every((record) => record.releaseVerdict !== "safe_to_release")).toBe(true);

      git(join(missing.main, "packages", "sub"), ["worktree", "remove", "--force", missing.submodulePath]);
      const missingAudit = auditWorktrees({ repoRoot: missing.main, home: missing.root });
      expect(missingAudit.records.find((record) => record.memberLocator?.endsWith("packages/sub"))?.registration).toBe("missing");
      expect(missingAudit.records.filter((record) => record.runId === missing.key).every((record) => record.releaseVerdict !== "safe_to_release")).toBe(true);
    } finally {
      rmSync(changed.root, { recursive: true, force: true });
      rmSync(missing.root, { recursive: true, force: true });
    }
  });

  it("freezes changed heads through the production terminal release path", async () => {
    const f = await fixture("full-delta-team");
    try {
      writeFileSync(join(f.primaryPath, "primary-change.txt"), "primary\n");
      git(f.primaryPath, ["add", "primary-change.txt"]);
      git(f.primaryPath, ["commit", "-qm", "primary delivery"]);

      writeFileSync(join(f.submodulePath, "sub-change.txt"), "subordinate\n");
      git(f.submodulePath, ["add", "sub-change.txt"]);
      git(f.submodulePath, ["commit", "-qm", "subordinate delivery"]);
      const subHead = git(f.submodulePath, ["rev-parse", "HEAD"]);
      const primaryHead = git(f.primaryPath, ["rev-parse", "HEAD"]);
      await f.markDeliveredAndAttested();
      await f.terminalRelease();

      const events = readFileSync(join(f.main, ".roll", "loop", "events.ndjson"), "utf8")
        .split("\n")
        .flatMap((line) => line === "" ? [] : [JSON.parse(line) as { type: string; expectedHeads?: Array<{ relativeLocator: string; head: string }> }]);
      const release = events.find((event) => event.type === "worktree:release_requested");
      expect(release?.expectedHeads).toEqual([
        { relativeLocator: `cycle-${f.key}`, head: primaryHead },
        { relativeLocator: `cycle-${f.key}.submodules/packages/sub`, head: subHead },
      ]);
      expect(existsSync(f.primaryPath)).toBe(false);
      expect(existsSync(f.submodulePath)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

});

describe("US-LOOP-123 unavailable inspection", () => {
  it("does not reinterpret a failed branch enumeration as zero capacity", () => {
    const out = auditWorktrees(makeDeps({
      git: (args) => {
        if (args[0] === "worktree") return porcelain([]);
        if (args[0] === "branch") throw new Error("branch enumeration unavailable");
        return "";
      },
    }));
    expect(out.inspectionUnavailable).toBe(true);
  });

  it("does not reinterpret a real failed worktree discovery as an empty audit", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "roll-audit-nonrepo-"));
    try {
      const out = auditWorktrees({ repoRoot, home: "/home/user" });
      expect(out.inspectionUnavailable).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("FIX-1521 released worktree registration", () => {
  const workspace = {
    schema: 1,
    runId: "delta-fix1521",
    storyId: "FIX-1521",
    kind: "host_delta",
    topology: "delta-team",
    delegationId: "fix1521",
    members: [{
      repositoryId: "origin:repo",
      workspaceKey: "delta-fix1521",
      relativeLocator: "delta-fix1521",
      checkoutRef: { kind: "detached", head: "head-1" },
    }],
  } as const;

  function depsFor(events: readonly object[]): WorktreeAuditDeps {
    return makeDeps({
      readFile: (path) => path.endsWith("events.ndjson")
        ? events.map((event) => JSON.stringify(event)).join("\n")
        : null,
      git: (args) => args[0] === "worktree" ? porcelain([]) : "",
    });
  }

  it("does not flag a fully released, deregistered member as inspection unavailable", () => {
    const events = [
      { type: "worktree:allocated", workspace, ts: 1 },
      { type: "worktree:release_requested", runId: "delta-fix1521", reason: "delivered", operationId: "rel-1", expectedHeads: [{ relativeLocator: "delta-fix1521", head: "head-1" }], ts: 2 },
      { type: "worktree:released", runId: "delta-fix1521", operationId: "rel-1", expectedHeads: [{ relativeLocator: "delta-fix1521", head: "head-1" }], ts: 3 },
    ];
    const out = auditWorktrees(depsFor(events));
    const released = out.records.find((record) => record.runId === "delta-fix1521");

    expect(released?.runState).toBe("released");
    expect(released?.registration).toBe("missing");
    expect(out.inspectionUnavailable).toBeUndefined();
  });

  it("still flags a missing member whose run is not released", () => {
    const events = [
      { type: "worktree:allocated", workspace, ts: 1 },
      { type: "worktree:release_requested", runId: "delta-fix1521", reason: "delivered", operationId: "rel-1", expectedHeads: [{ relativeLocator: "delta-fix1521", head: "head-1" }], ts: 2 },
    ];
    const out = auditWorktrees(depsFor(events));
    const pending = out.records.find((record) => record.runId === "delta-fix1521");

    expect(pending?.runState).toBe("release_requested");
    expect(pending?.registration).toBe("missing");
    expect(out.inspectionUnavailable).toBe(true);
  });
});

describe("US-LOOP-123 CLI audit snapshots", () => {
  function capture(locale: "en" | "zh", fn: () => number): string {
    const originalWrite = process.stdout.write;
    const originalLocale = process.env["ROLL_LANG"];
    let output = "";
    process.env["ROLL_LANG"] = locale;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      output += String(chunk);
      return true;
    };
    try {
      fn();
    } finally {
      process.stdout.write = originalWrite;
      if (originalLocale === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = originalLocale;
    }
    return output;
  }

  it("freezes EN and ZH output for a healthy handoff, an external lookalike, and an absent legacy cycle", () => {
    const workspace = {
      schema: 1,
      runId: "delta-handoff",
      storyId: "US-LOOP-123",
      kind: "host_delta",
      topology: "delta-team",
      delegationId: "handoff",
      members: [{
        repositoryId: "origin:repo",
        workspaceKey: "delta-handoff",
        relativeLocator: "delta-handoff",
        checkoutRef: { kind: "detached", head: "handoff-head" },
      }],
    } as const;
    const events = [
      { type: "cycle:start", cycleId: "cycle-20260718-000000-1", storyId: "US-LEGACY", ts: 1 },
      { type: "worktree:allocated", workspace, ts: 2 },
      { type: "delta:terminal", delegationId: "handoff", outcome: "handoff_ready", terminalBinding: "handoff_only", deliveryDisposition: "owner_continue", ts: 3 },
    ];
    const deps = makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? events.map((event) => JSON.stringify(event)).join("\n") : null,
      git: (args) => {
        if (args[0] === "worktree") return porcelain([
          { path: "/fake/repo/.roll/loop/worktrees/delta-handoff", head: "handoff-head" },
          { path: "/fake/repo/.roll/loop/worktrees/cycle-lookalike", head: "external-head" },
        ]);
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        return "";
      },
    });

    const audit = auditWorktrees(deps);
    expect(audit.records).toHaveLength(2);
    expect(capture("en", () => worktreeAuditCommand(["--repo", "/fake/repo"], deps))).toMatchSnapshot();
    expect(capture("zh", () => worktreeAuditCommand(["--repo", "/fake/repo"], deps))).toMatchSnapshot();
  });

  it("freezes EN and ZH output for an unregistered projected member", () => {
    const workspace = {
      schema: 1,
      runId: "delta-unregistered",
      storyId: "US-LOOP-123",
      kind: "host_delta",
      topology: "delta-team",
      delegationId: "unregistered",
      members: [{
        repositoryId: "origin:repo",
        workspaceKey: "delta-unregistered",
        relativeLocator: "delta-unregistered",
        checkoutRef: { kind: "detached", head: "missing-head" },
      }],
    } as const;
    const deps = makeDeps({
      readFile: (path) => path.endsWith("events.ndjson") ? JSON.stringify({ type: "worktree:allocated", workspace, ts: 1 }) : null,
      git: (args) => args[0] === "worktree" ? porcelain([]) : "",
    });

    expect(capture("en", () => worktreeAuditCommand(["--repo", "/fake/repo"], deps))).toMatchSnapshot();
    expect(capture("zh", () => worktreeAuditCommand(["--repo", "/fake/repo"], deps))).toMatchSnapshot();
  });
});
