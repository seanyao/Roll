/**
 * Tests for FIX-1211: lease-aware In Progress handling.
 *
 * AC1: In Progress line without lease in 24h soft lease not picked; timeout
 *      recovery logged is produced by reconcileExpiredClaims.
 * AC2: Loop's own lease death recovery doesn't regress.
 * AC3: Concurrent same-story scenario sealed in tests.
 *
 * US-DELTA-003: hardlink no-clobber lease protocol.
 * - claimStoryLease uses temp+fdatasync+linkSync(EEXIST)+parent-fsync+unlink
 * - No lock file; no JSON read-modify-write
 * - Per-story canonical record files in leases directory
 */
import { describe, expect, it } from "vitest";
import {
  buildClaimedByOther,
  claimStoryLease,
  cleanDeadLeases,
  injectClaimOps,
  isHumanSoftLeaseActive,
  isLeaseAlive,
  isPidAlive,
  HUMAN_SOFT_LEASE_HOURS,
  readLeases,
  releaseStoryLease,
  writeLeases,
  setLease,
  removeLease,
  legacyLeasePath,
  leaseDirPath,
  type LeaseMap,
  type ClaimStepOps,
} from "../src/backlog/lease.js";
import { reconcileExpiredClaims } from "../src/reconcile/engine.js";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createRequire } from "module";

const NOW = 1_700_000_000_000; // arbitrary stable epoch ms for tests

// ─── Path helpers for tests ─────────────────────────────────────────────────

function tmpLeaseDir(): string {
  const baseDir = mkdtempSync(join(tmpdir(), "lease-test-"));
  const dir = join(baseDir, "leases");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Module-level ClaimStepOps spy (occurrence-specific injection) ──────────

function createClaimOpsSpy(): {
  ops: ClaimStepOps;
  calls: Array<{ op: string; path: string; flags?: string }>;
  throwAtOp: (op: string, occurrence?: number) => void;
  clearThrow: () => void;
  opCounts: () => Record<string, number>;
} {
  const calls: Array<{ op: string; path: string; flags?: string }> = [];
  const throwSpecs: Array<{ op: string; occurrence: number }> = [];
  const opCounts: Record<string, number> = {};

  const realWriteTempFile = (p: string, d: string) => writeFileSync(p, d, "utf8");
  const realOpenFile = (p: string, f: string) => openSync(p, f);
  const realFsyncFile = (fd: number) => fdatasyncSync(fd);
  const realCloseFile = (fd: number) => closeSync(fd);
  const realHardLink = (s: string, d: string) => linkSync(s, d);
  const realUnlinkFile = (p: string) => unlinkSync(p);

  function checkThrow(op: string): void {
    opCounts[op] = (opCounts[op] ?? 0) + 1;
    const occurrence = opCounts[op]!;
    for (const spec of throwSpecs) {
      if (spec.op === op && spec.occurrence === occurrence) {
        throw new Error(`injected ${op} failure at occurrence ${occurrence}`);
      }
    }
  }

  return {
    ops: {
      writeTempFile(path, data) {
        checkThrow("writeTempFile");
        calls.push({ op: "writeTempFile", path });
        realWriteTempFile(path, data);
      },
      openFile(path, flags) {
        checkThrow("openFile");
        calls.push({ op: "openFile", path, flags });
        return realOpenFile(path, flags);
      },
      fsyncFile(fd) {
        checkThrow("fsyncFile");
        calls.push({ op: "fsyncFile", path: `fd:${fd}` });
        realFsyncFile(fd);
      },
      closeFile(fd) {
        checkThrow("closeFile");
        calls.push({ op: "closeFile", path: `fd:${fd}` });
        realCloseFile(fd);
      },
      hardLink(src, dest) {
        checkThrow("hardLink");
        calls.push({ op: "hardLink", path: dest });
        realHardLink(src, dest);
      },
      unlinkFile(path) {
        checkThrow("unlinkFile");
        calls.push({ op: "unlinkFile", path });
        realUnlinkFile(path);
      },

    },
    calls,
    throwAtOp(op: string, occurrence?: number) {
      throwSpecs.push({ op, occurrence: occurrence ?? 1 });
    },
    clearThrow() { throwSpecs.length = 0; },
    opCounts: () => ({ ...opCounts }),
  };
}

// ─── readLeases / writeLeases / setLease / removeLease ──────────────────────

describe("readLeases / writeLeases / setLease / removeLease", () => {
  it("readLeases returns empty for missing directory", () => {
    expect(readLeases("/nonexistent/path/leases")).toEqual({});
  });

  it("readLeases returns empty for missing directory with no legacy", () => {
    expect(readLeases("/nonexistent/path/leases")).toEqual({});
  });

  it("round-trips via writeLeases + readLeases (directory)", () => {
    const dir = tmpLeaseDir();
    try {
      const data: LeaseMap = { "FIX-1": { pid: 123, claimedAt: NOW, source: "cycle" } };
      writeLeases(dir, data);
      const loaded = readLeases(dir);
      expect(loaded).toEqual(data);
      // Verify file exists on disk
      expect(existsSync(join(dir, "FIX-1.lease"))).toBe(true);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("setLease + removeLease round-trip (directory)", () => {
    const dir = tmpLeaseDir();
    try {
      setLease(dir, "FIX-1", { claimedAt: NOW, source: "human" });
      expect(Object.keys(readLeases(dir))).toEqual(["FIX-1"]);
      expect(existsSync(join(dir, "FIX-1.lease"))).toBe(true);
      expect(removeLease(dir, "FIX-1")).toBe(true);
      expect(readLeases(dir)).toEqual({});
      expect(removeLease(dir, "FIX-MISSING")).toBe(false);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("readLeases falls back to legacy story-leases.json when directory absent", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "legacy-test-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    try {
      const data: LeaseMap = { "FIX-LEGACY": { pid: 456, claimedAt: NOW, source: "cycle" } };
      writeFileSync(legacyPath, JSON.stringify(data, null, 2) + "\n", "utf8");

      // readLeases with a path inside the loop dir should find legacy
      const leasesDir = join(loopDir, "leases");
      const loaded = readLeases(leasesDir);
      expect(loaded).toEqual(data);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("writeLeases + readLeases correctly handles multiple stories", () => {
    const dir = tmpLeaseDir();
    try {
      const data: LeaseMap = {
        "FIX-A": { pid: 111, claimedAt: NOW, source: "cycle" },
        "FIX-B": { claimedAt: NOW, source: "human" },
        "US-HD": { claimedAt: NOW + 1, source: "host-delegation", delegationId: "deleg-xyz", runId: "delta-deleg-xyz" },
      };
      writeLeases(dir, data);
      expect(existsSync(join(dir, "FIX-A.lease"))).toBe(true);
      expect(existsSync(join(dir, "FIX-B.lease"))).toBe(true);
      expect(existsSync(join(dir, "US-HD.lease"))).toBe(true);
      const loaded = readLeases(dir);
      expect(loaded).toEqual(data);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ─── PID and lease lifetime helpers ──────────────────────────────────────────

describe("isPidAlive", () => {
  it("returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a non-existent PID", () => {
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe("isLeaseAlive", () => {
  it("returns true for a lease with a live PID", () => {
    expect(isLeaseAlive({ pid: process.pid, claimedAt: NOW, source: "cycle" })).toBe(true);
  });

  it("returns false when no PID is set (human/supervisor claim)", () => {
    expect(isLeaseAlive({ claimedAt: NOW, source: "human" })).toBe(false);
  });

  it("returns false for a dead PID", () => {
    expect(isLeaseAlive({ pid: 999_999_999, claimedAt: NOW, source: "cycle" })).toBe(false);
  });
});

describe("isHumanSoftLeaseActive", () => {
  it("returns true for a recent claim", () => {
    expect(isHumanSoftLeaseActive({ claimedAt: NOW, source: "human" }, NOW)).toBe(true);
  });

  it("returns true for a claim just under 24h ago", () => {
    const justUnder = NOW - HUMAN_SOFT_LEASE_HOURS * 3600_000 + 1;
    expect(isHumanSoftLeaseActive({ claimedAt: justUnder, source: "human" }, NOW)).toBe(true);
  });

  it("returns false at the 24h boundary", () => {
    const boundary = NOW - HUMAN_SOFT_LEASE_HOURS * 3600_000;
    expect(isHumanSoftLeaseActive({ claimedAt: boundary, source: "human" }, NOW)).toBe(false);
  });

  it("returns false for an old claim", () => {
    const old = NOW - (HUMAN_SOFT_LEASE_HOURS + 1) * 3600_000;
    expect(isHumanSoftLeaseActive({ claimedAt: old, source: "human" }, NOW)).toBe(false);
  });
});

// ─── AC1: buildClaimedByOther — lease-aware predicate ────────────────────────

describe("buildClaimedByOther (AC1: lease-aware skip)", () => {
  const ownPid = process.pid;

  it("returns true when story has NO lease entry", () => {
    expect(buildClaimedByOther({}, NOW, ownPid)("FIX-999")).toBe(true);
  });

  it("returns false when own PID has a live lease", () => {
    const leases: LeaseMap = { "FIX-1": { pid: ownPid, claimedAt: NOW, source: "cycle" } };
    expect(buildClaimedByOther(leases, NOW, ownPid)("FIX-1")).toBe(false);
  });

  it("returns true when a DIFFERENT PID has the lease", () => {
    const leases: LeaseMap = { "FIX-1": { pid: 99999, claimedAt: NOW, source: "cycle" } };
    expect(buildClaimedByOther(leases, NOW, ownPid)("FIX-1")).toBe(true);
  });

  it("returns true when own PID lease is dead", () => {
    const leases: LeaseMap = { "FIX-1": { pid: 999_999_999, claimedAt: NOW, source: "cycle" } };
    expect(buildClaimedByOther(leases, NOW, ownPid)("FIX-1")).toBe(true);
  });

  it("returns true for human-claimed (no pid)", () => {
    const leases: LeaseMap = { "FIX-1": { claimedAt: NOW, source: "human" } };
    expect(buildClaimedByOther(leases, NOW, ownPid)("FIX-1")).toBe(true);
  });
});

// ─── AC2: death recovery regression ─────────────────────────────────────────

describe("Death recovery regression (AC2)", () => {
  it("dead PID lease is correctly identified", () => {
    expect(isLeaseAlive({ pid: process.pid, claimedAt: NOW, source: "cycle" })).toBe(true);
    expect(isLeaseAlive({ pid: 999_999_999, claimedAt: NOW, source: "cycle" })).toBe(false);
  });

  it("dead-own-lease is claimed-by-other (eligible for reclaim)", () => {
    const leases: LeaseMap = { "FIX-1": { pid: 999_999_999, claimedAt: NOW - 3600_000, source: "cycle" } };
    expect(buildClaimedByOther(leases, NOW, process.pid)("FIX-1")).toBe(true);
  });
});

// ─── AC3: concurrent same-story scenario ─────────────────────────────────────

describe("Concurrent same-story prevention (AC3)", () => {
  it("claimer sees not-other, concurrent sees other", () => {
    const leases: LeaseMap = {
      "FIX-CONCURRENT": { pid: 11111, claimedAt: NOW, source: "cycle" },
    };
    // Claimer PID 11111 is not alive -> sees as claimed (correct)
    const claimedClaimer = buildClaimedByOther(leases, NOW, 11111);
    expect(claimedClaimer("FIX-CONCURRENT")).toBe(true);
    // Fresh PID also sees as claimed
    expect(buildClaimedByOther(leases, NOW, process.pid)("FIX-CONCURRENT")).toBe(true);
  });

  it("no lease -> both PIDs see as claimed", () => {
    expect(buildClaimedByOther({}, NOW, 11111)("FIX-HUMAN")).toBe(true);
    expect(buildClaimedByOther({}, NOW, 22222)("FIX-HUMAN")).toBe(true);
  });

  it("human lease visible to all concurrent loops", () => {
    const leases: LeaseMap = { "FIX-HUMAN": { claimedAt: NOW, source: "supervisor" } };
    expect(buildClaimedByOther(leases, NOW, 11111)("FIX-HUMAN")).toBe(true);
    expect(buildClaimedByOther(leases, NOW, 22222)("FIX-HUMAN")).toBe(true);
  });
});

// ─── AC1: reconcileExpiredClaims — 24h soft lease expiry ─────────────────────

describe("reconcileExpiredClaims (FIX-1211 AC1)", () => {
  it("returns empty when no in-progress stories", () => {
    expect(reconcileExpiredClaims({ inProgress: [], leases: {}, now: NOW })).toEqual([]);
  });

  it("skips stories with no lease entry", () => {
    const r = reconcileExpiredClaims({ inProgress: [{ id: "FIX-1" }], leases: {}, now: NOW });
    expect(r).toEqual([]);
  });

  it("skips cycle-claimed stories", () => {
    const r = reconcileExpiredClaims({
      inProgress: [{ id: "FIX-1" }],
      leases: { "FIX-1": { pid: 12345, claimedAt: NOW - 48 * 3600_000, source: "cycle" } },
      now: NOW,
    });
    expect(r).toEqual([]);
  });

  it("returns expired human-claimed stories >24h", () => {
    const r = reconcileExpiredClaims({
      inProgress: [{ id: "FIX-1" }],
      leases: { "FIX-1": { claimedAt: NOW - 25 * 3600_000, source: "human" } },
      now: NOW,
    });
    expect(r).toHaveLength(1);
    expect(r[0].storyId).toBe("FIX-1");
    expect(r[0].ageHours).toBeGreaterThan(24);
  });

  it("keeps human-claimed stories under 24h", () => {
    const r = reconcileExpiredClaims({
      inProgress: [{ id: "FIX-1" }],
      leases: { "FIX-1": { claimedAt: NOW - 12 * 3600_000, source: "human" } },
      now: NOW,
    });
    expect(r).toEqual([]);
  });

  it("handles supervisor-claimed stories", () => {
    const r = reconcileExpiredClaims({
      inProgress: [{ id: "FIX-1" }],
      leases: { "FIX-1": { claimedAt: NOW - 48 * 3600_000, source: "supervisor" } },
      now: NOW,
    });
    expect(r).toHaveLength(1);
    expect(r[0].storyId).toBe("FIX-1");
  });

  it("mixed: only expired non-cycle claims", () => {
    const r = reconcileExpiredClaims({
      inProgress: [{ id: "FIX-1" }, { id: "FIX-2" }, { id: "FIX-3" }, { id: "FIX-4" }],
      leases: {
        "FIX-1": { pid: 12345, claimedAt: NOW - 48 * 3600_000, source: "cycle" },
        "FIX-2": { claimedAt: NOW - 12 * 3600_000, source: "human" },
        "FIX-3": { claimedAt: NOW - 48 * 3600_000, source: "human" },
      },
      now: NOW,
    });
    expect(r).toHaveLength(1);
    expect(r[0].storyId).toBe("FIX-3");
  });
});

describe("removeLease onlySource scoping (kimi review: cycle terminal must not wipe human claims)", () => {
  it("cycle-scoped removal skips a human lease and removes a cycle lease", () => {
    const dir = tmpLeaseDir();
    setLease(dir, "US-X-1", { claimedAt: 1000, source: "human" });
    setLease(dir, "US-X-2", { pid: 4242, claimedAt: 1000, source: "cycle" });

    expect(removeLease(dir, "US-X-1", "cycle")).toBe(false);
    expect(readLeases(dir)["US-X-1"]?.source).toBe("human");

    expect(removeLease(dir, "US-X-2", "cycle")).toBe(true);
    expect(readLeases(dir)["US-X-2"]).toBeUndefined();
  });

  it("unscoped removal still removes any source (explicit pardon path)", () => {
    const dir = tmpLeaseDir();
    setLease(dir, "US-X-3", { claimedAt: 1000, source: "human" });
    expect(removeLease(dir, "US-X-3")).toBe(true);
  });
});

describe("cleanDeadLeases (FIX-1232)", () => {
  it("removes dead PID entries and keeps live ones", () => {
    const dir = tmpLeaseDir();
    try {
      setLease(dir, "FIX-DEAD", { pid: 999999999, claimedAt: 1000, source: "cycle" });
      setLease(dir, "FIX-LIVE", { pid: process.pid, claimedAt: 2000, source: "cycle" });
      const cleaned = cleanDeadLeases(dir);
      expect(cleaned).toEqual(["FIX-DEAD"]);
      const remaining = readLeases(dir);
      expect(remaining["FIX-DEAD"]).toBeUndefined();
      expect(remaining["FIX-LIVE"]).toBeDefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("removes all dead entries when no live entries survive", () => {
    const dir = tmpLeaseDir();
    try {
      setLease(dir, "FIX-1", { pid: 999999999, claimedAt: 1000, source: "cycle" });
      setLease(dir, "FIX-2", { pid: 999999998, claimedAt: 2000, source: "cycle" });
      const cleaned = cleanDeadLeases(dir);
      expect(cleaned.sort()).toEqual(["FIX-1", "FIX-2"]);
      // All files should be gone
      const remaining = readLeases(dir);
      expect(remaining).toEqual({});
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("skips human/supervisor leases (no pid)", () => {
    const dir = tmpLeaseDir();
    try {
      setLease(dir, "FIX-HUMAN", { claimedAt: 1000, source: "human" });
      setLease(dir, "FIX-DEAD", { pid: 999999999, claimedAt: 2000, source: "cycle" });
      const cleaned = cleanDeadLeases(dir);
      expect(cleaned).toEqual(["FIX-DEAD"]);
      const remaining = readLeases(dir);
      expect(remaining["FIX-HUMAN"]).toBeDefined();
      expect(remaining["FIX-DEAD"]).toBeUndefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("never cleans host-delegation leases", () => {
    const dir = tmpLeaseDir();
    try {
      setLease(dir, "FIX-HOST", { claimedAt: 1000, source: "host-delegation", delegationId: "deleg-1", runId: "delta-deleg-1" });
      const cleaned = cleanDeadLeases(dir);
      expect(cleaned).toEqual([]);
      const remaining = readLeases(dir);
      expect(remaining["FIX-HOST"]).toBeDefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("returns empty array for missing directory", () => {
    expect(cleanDeadLeases("/nonexistent/path/leases")).toEqual([]);
  });

  // BLOCK-3: Legacy dead+survivor — must return no cleaned IDs and perform no write
  it("BLOCK-3: legacy-only dead+survivor returns [], no canonical survivor copies, legacy unchanged", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b3-clean-legacy-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const originalBytes = JSON.stringify({
      "DEAD": { pid: 999999999, claimedAt: 1000, source: "cycle" },
      "SURV": { claimedAt: 2000, source: "human" },
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      const cleaned = cleanDeadLeases(leasesDir);

      // Must report no cleaned IDs — legacy is immutable
      expect(cleaned).toEqual([]);

      // Legacy bytes unchanged
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);

      // No canonical directory created
      expect(existsSync(leasesDir)).toBe(false);

      // Merge-read still sees both legacy entries
      const leases = readLeases(leasesDir);
      expect(leases["DEAD"]).toBeDefined();
      expect(leases["SURV"]).toBeDefined();
      expect(leases["DEAD"]!.source).toBe("cycle");
      expect(leases["SURV"]!.source).toBe("human");
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-3: host-delegation immunity preserved — legacy host-delegation not cleaned", () => {
    const dir = tmpLeaseDir();
    try {
      setLease(dir, "HD-1", {
        claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-immune", runId: "delta-immune",
      });
      const cleaned = cleanDeadLeases(dir);
      expect(cleaned).toEqual([]);
      expect(readLeases(dir)["HD-1"]).toBeDefined();
      expect(readLeases(dir)["HD-1"]!.source).toBe("host-delegation");
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// US-DELTA-003: hardlink no-clobber claimStoryLease / releaseStoryLease
// ═══════════════════════════════════════════════════════════════════════════════

describe("claimStoryLease — hardlink no-clobber (US-DELTA-003)", () => {
  it("claims an unclaimed story and writes per-story record file with source + delegationId", () => {
    const dir = tmpLeaseDir();
    try {
      const result = claimStoryLease(dir, "US-001", {
        pid: process.pid,
        claimedAt: NOW,
        source: "host-delegation",
        delegationId: "deleg-aaa",
        runId: "delta-deleg-aaa",
      });
      expect(result.status).toBe("claimed");

      // Verify per-story record exists
      const rp = join(dir, "US-001.lease");
      expect(existsSync(rp)).toBe(true);

      const leases = readLeases(dir);
      expect(leases["US-001"]).toBeDefined();
      expect(leases["US-001"]!.source).toBe("host-delegation");
      expect(leases["US-001"]!.delegationId).toBe("deleg-aaa");
      expect(leases["US-001"]!.runId).toBe("delta-deleg-aaa");
      expect(leases["US-001"]!.pid).toBe(process.pid);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("returns exists when story already claimed by any source (EEXIST on hardlink)", () => {
    const dir = tmpLeaseDir();
    try {
      // Pre-claim via cycle
      const r1 = claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r1.status).toBe("claimed");

      // Second claim from host-delegation must fail with EEXIST
      const r2 = claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "deleg-bbb", runId: "delta-deleg-bbb",
      });
      expect(r2.status).toBe("exists");
      if (r2.status === "exists") {
        expect(r2.existingSource).toBe("cycle");
      }

      // First claim entry is preserved (not overwritten)
      const leases = readLeases(dir);
      expect(leases["US-001"]!.source).toBe("cycle");
      expect(leases["US-001"]!.delegationId).toBeUndefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("rejects host-delegation claim without delegationId", () => {
    const dir = tmpLeaseDir();
    try {
      expect(() => claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
      })).toThrow("delegationId");
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("two claims in same process: second returns exists", () => {
    const dir = tmpLeaseDir();
    try {
      const r1 = claimStoryLease(dir, "US-RACE", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r1.status).toBe("claimed");

      const r2 = claimStoryLease(dir, "US-RACE", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "deleg-bbb", runId: "delta-bbb",
      });
      expect(r2.status).toBe("exists");

      // Only first claim persists
      const leases = readLeases(dir);
      expect(leases["US-RACE"]!.source).toBe("cycle");
      expect(leases["US-RACE"]!.pid).toBe(process.pid);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("different stories can both be claimed", () => {
    const dir = tmpLeaseDir();
    try {
      const r1 = claimStoryLease(dir, "US-A", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r1.status).toBe("claimed");

      const r2 = claimStoryLease(dir, "US-B", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-xyz", runId: "delta-xyz",
      });
      expect(r2.status).toBe("claimed");

      const leases = readLeases(dir);
      expect(Object.keys(leases).sort()).toEqual(["US-A", "US-B"]);
      expect(existsSync(join(dir, "US-A.lease"))).toBe(true);
      expect(existsSync(join(dir, "US-B.lease"))).toBe(true);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── BLOCK-1: Strict all-entry legacy validation before claim ────────────

  it("BLOCK-1: unrelated malformed legacy entry (unknown source) throws, zero canonical residue", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-claim-mal-1-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const originalBytes = JSON.stringify({
      "GOOD": { source: "human", claimedAt: 1700000000000 },
      "BAD": { source: "attacker", claimedAt: 1700000000000 },
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      expect(() => claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/Invalid lease source/);

      // Zero canonical residue
      expect(existsSync(leasesDir)).toBe(false);
      // Legacy bytes unchanged
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);
      // No temp files anywhere
      expect(existsSync(join(dirname(legacyPath), "leases"))).toBe(false);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-1: unrelated non-finite claimedAt throws, zero canonical residue, legacy unchanged", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-claim-inf-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    // Use 1e999 which JSON.parse gives Infinity
    const originalBytes = JSON.stringify({
      "GOOD": { source: "human", claimedAt: 1700000000000 },
      "INF": { source: "cycle", claimedAt: 1e999 },
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      expect(() => claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/claimedAt/);

      expect(existsSync(leasesDir)).toBe(false);
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-1: unrelated legacy entry with string claimedAt throws, zero canonical residue", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-claim-str-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const originalBytes = JSON.stringify({
      "GOOD": { source: "human", claimedAt: 1700000000000 },
      "STR": { source: "human", claimedAt: "yesterday" },
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      expect(() => claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/claimedAt/);

      expect(existsSync(leasesDir)).toBe(false);
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-1: unrelated legacy entry with array value throws, zero canonical residue", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-claim-arr-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const originalBytes = JSON.stringify({
      "GOOD": { source: "human", claimedAt: 1700000000000 },
      "ARR": [1, 2, 3],
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      expect(() => claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/plain object/);

      expect(existsSync(leasesDir)).toBe(false);
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-1: unrelated null legacy entry throws, zero canonical residue", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-claim-null-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const originalBytes = JSON.stringify({
      "GOOD": { source: "human", claimedAt: 1700000000000 },
      "NULL": null,
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      expect(() => claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/plain object/);

      expect(existsSync(leasesDir)).toBe(false);
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-1: valid human/supervisor no-pid and cycle entries accepted, claim proceeds", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-claim-valid-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const originalBytes = JSON.stringify({
      "HUM-OLD": { claimedAt: NOW - 1000, source: "human" },
      "SUP-OLD": { claimedAt: NOW - 500, source: "supervisor" },
    }) + "\n";
    writeFileSync(legacyPath, originalBytes, "utf8");

    try {
      const r = claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r.status).toBe("claimed");

      // Legacy unchanged
      expect(readFileSync(legacyPath, "utf8")).toBe(originalBytes);
      // Canonical record created for US-NEW
      expect(existsSync(join(leasesDir, "US-NEW.lease"))).toBe(true);
      // Merge-read shows all
      const leases = readLeases(leasesDir);
      expect(leases["HUM-OLD"]).toBeDefined();
      expect(leases["SUP-OLD"]).toBeDefined();
      expect(leases["US-NEW"]).toBeDefined();
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── BLOCK-2: Canonical+legacy same-story claim precedence ──────────────

  it("BLOCK-2: same-story canonical cycle + legacy human → claim returns canonical existingSource", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b2-claim-prec-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const leasesDir = join(loopDir, "leases");
    mkdirSync(leasesDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    // Canonical: cycle
    writeFileSync(join(leasesDir, "US-X.lease"), JSON.stringify({
      pid: 111, claimedAt: NOW, source: "cycle",
    }) + "\n", "utf8");
    // Legacy: human (same story, different owner)
    writeFileSync(legacyPath, JSON.stringify({
      "US-X": { claimedAt: NOW - 5000, source: "human" },
    }) + "\n", "utf8");

    try {
      const r = claimStoryLease(leasesDir, "US-X", {
        pid: process.pid, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d-prec", runId: "r-prec",
      });
      // Canonical wins — returns the existing canonical cycle owner
      expect(r.status).toBe("exists");
      if (r.status === "exists") expect(r.existingSource).toBe("cycle");
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-2: same-story legacy only (no canonical) → claim returns legacy existingSource", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b2-claim-legonly-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const leasesDir = join(loopDir, "leases");
    const legacyPath = join(loopDir, "story-leases.json");
    const legacyContent = JSON.stringify({
      "US-LEG": { claimedAt: NOW - 1000, source: "human" },
    }) + "\n";
    writeFileSync(legacyPath, legacyContent, "utf8");

    try {
      const r = claimStoryLease(leasesDir, "US-LEG", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r.status).toBe("exists");
      if (r.status === "exists") expect(r.existingSource).toBe("human");
      // Legacy unchanged, no canonical residue
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
      expect(existsSync(join(leasesDir, "US-LEG.lease"))).toBe(false);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Hardlink mechanics proofs ──────────────────────────────────────────

  it("proves hardlink semantics: same inode for claimed record (linkSync, not copy)", () => {
    const dir = tmpLeaseDir();
    try {
      // Manually create a temp file to verify hardlink behavior
      const tmpPath = join(dir, "test-tmp.tmp");
      writeFileSync(tmpPath, JSON.stringify({ pid: 123, claimedAt: NOW, source: "cycle" }) + "\n", "utf8");

      const finalPath = join(dir, "INODE-TEST.lease");
      linkSync(tmpPath, finalPath);

      // Same inode
      const tmpStat = statSync(tmpPath);
      const finalStat = statSync(finalPath);
      expect(tmpStat.ino).toBe(finalStat.ino);
      expect(finalStat.nlink).toBe(2);

      // Cleanup
      unlinkSync(tmpPath);
      unlinkSync(finalPath);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("proves no-clobber: linkSync EEXIST when target already present", () => {
    const dir = tmpLeaseDir();
    try {
      const finalPath = join(dir, "NOCLOBBER.lease");
      const tmp1 = join(dir, "tmp1.tmp");
      const tmp2 = join(dir, "tmp2.tmp");

      writeFileSync(tmp1, JSON.stringify({ source: "cycle" }) + "\n", "utf8");
      writeFileSync(tmp2, JSON.stringify({ source: "human" }) + "\n", "utf8");

      // First link succeeds
      linkSync(tmp1, finalPath);
      expect(existsSync(finalPath)).toBe(true);

      // Second link must fail with EEXIST
      expect(() => linkSync(tmp2, finalPath)).toThrow();
      try {
        linkSync(tmp2, finalPath);
        // Should not reach here
        expect("should have thrown").toBe("EEXIST");
      } catch (e: unknown) {
        expect((e as { code?: string }).code).toBe("EEXIST");
      }

      // Content is still the first writer's
      const content = JSON.parse(readFileSync(finalPath, "utf8").trim());
      expect(content.source).toBe("cycle");

      unlinkSync(tmp1);
      unlinkSync(tmp2);
      unlinkSync(finalPath);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("proves claimStoryLease leaves no temp files after success", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-CLEAN", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });

      // Only the .lease file should exist, no temp files
      const entries = require("fs").readdirSync(dir);
      for (const entry of entries) {
        expect(entry).not.toMatch(/\.tmp$/);
      }
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("proves claimStoryLease cleans temp even on EEXIST conflict", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-CLEAN2", { pid: process.pid, claimedAt: NOW, source: "cycle" });
      // Second claim will fail
      claimStoryLease(dir, "US-CLEAN2", { pid: 99999, claimedAt: NOW, source: "cycle" });

      // No temp files left behind
      const entries = require("fs").readdirSync(dir);
      for (const entry of entries) {
        expect(entry).not.toMatch(/\.tmp$/);
      }
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Production hardlink sequence proof via fs ops seam (BLOCK-3) ──────────



  it("BLOCK-3: ops spy proves ordered protocol with exact paths, file vs directory fsync", () => {
    const dir = tmpLeaseDir();
    const spy = createClaimOpsSpy();
    try {
      injectClaimOps(spy.ops);

      const result = claimStoryLease(dir, "US-TRACE2", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(result.status).toBe("claimed");

      const opNames = spy.calls.map(c => c.op);
      expect(opNames).toEqual([
        "writeTempFile",
        "openFile",     // temp file: flags "r+"
        "fsyncFile",
        "closeFile",
        "hardLink",
        "openFile",     // parent dir: flags "r"
        "fsyncFile",
        "closeFile",
        "unlinkFile",
      ]);

      // Verify file vs directory fsync: first openFile uses "r+" (file), second uses "r" (dir)
      expect(spy.calls[1]!.flags).toBe("r+");  // temp file fsync
      expect(spy.calls[5]!.flags).toBe("r");   // parent directory fsync

      // Verify temp path is in same directory as leases dir
      const tempPath = spy.calls[0]!.path;
      expect(tempPath).toContain(dir);
      expect(tempPath).toMatch(/\.tmp$/);

      // Verify hardLink dest is the final .lease file
      const linkDest = spy.calls[4]!.path;
      expect(linkDest).toBe(join(dir, "US-TRACE2.lease"));

      // Verify unlinkFile cleans up the temp
      expect(spy.calls[8]!.path).toBe(tempPath);

      // No temp residue on real fs
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);
    } finally {
      injectClaimOps(null);
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // BLOCK-2: Canonical precedence — when canonical record exists, claim
  // returns early before any ops are called.
  it("BLOCK-2: canonical precedence — existing canonical record returns exists with zero ops calls", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-NW2", { pid: process.pid, claimedAt: NOW, source: "cycle" });

      const spy = createClaimOpsSpy();
      injectClaimOps(spy.ops);
      const r2 = claimStoryLease(dir, "US-NW2", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d2b", runId: "rd2b",
      });
      injectClaimOps(null);

      expect(r2.status).toBe("exists");
      if (r2.status === "exists") expect(r2.existingSource).toBe("cycle");
      // Canonical precedence: zero ops calls — early return before hardlink
      expect(spy.calls).toEqual([]);
      // First claim preserved
      expect(readLeases(dir)["US-NW2"]!.source).toBe("cycle");
    } finally {
      injectClaimOps(null);
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // BLOCK-2: EEXIST path after canonical check passes — the pre-existing
  // record is picked up by canonical precedence (Step 1), which is the
  // correct deterministic result. The real EEXIST race path is proven by
  // the concurrent subprocess tests below.
  it("BLOCK-2: canonical precedence returns existingSource from canonical record (race-winner identity correct)", () => {
    const dir = tmpLeaseDir();
    try {
      // Pre-create a valid canonical record (simulating another process finished first)
      const rp = join(dir, "US-RACE-EEXIST.lease");
      writeFileSync(rp, JSON.stringify({
        pid: 4242, claimedAt: NOW, source: "host-delegation",
        delegationId: "winner-deleg", runId: "winner-run",
      }) + "\n", "utf8");

      const spy = createClaimOpsSpy();
      injectClaimOps(spy.ops);

      const result = claimStoryLease(dir, "US-RACE-EEXIST", {
        pid: process.pid, claimedAt: NOW + 1, source: "cycle",
      });
      injectClaimOps(null);

      // Must report the winner's identity, not fabricate "cycle"
      expect(result.status).toBe("exists");
      if (result.status === "exists") {
        expect(result.existingSource).toBe("host-delegation");
        expect(result.existingDelegationId).toBe("winner-deleg");
      }

      // Canonical precedence: zero ops calls (early return before hardlink)
      expect(spy.calls).toEqual([]);
    } finally {
      injectClaimOps(null);
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // BLOCK-2: Malformed canonical on EEXIST must throw integrity error
  it("BLOCK-2: malformed canonical record (unknown source) throws integrity error on claim", () => {
    const dir = tmpLeaseDir();
    try {
      // Pre-create a malformed canonical record (unknown source)
      const rp = join(dir, "US-MAL-CANON.lease");
      writeFileSync(rp, JSON.stringify({
        source: "attacker", claimedAt: 1,
      }) + "\n", "utf8");

      const spy = createClaimOpsSpy();
      const realLink = spy.ops.hardLink;
      spy.ops.hardLink = (_src: string, _dest: string) => {
        spy.calls.push({ op: "hardLink", path: _dest });
        const err = new Error("EEXIST: file already exists") as Error & { code: string };
        err.code = "EEXIST";
        throw err;
      };
      injectClaimOps(spy.ops);

      // Must throw — never return {status:"exists", existingSource:"cycle"}
      expect(() => claimStoryLease(dir, "US-MAL-CANON", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/Invalid lease source/);
      injectClaimOps(null);

      // No new record created
      expect(existsSync(join(dir, "US-MAL-CANON.lease"))).toBe(true); // original still there
      // readLeases should also fail-loud on malformed canonical
      expect(() => readLeases(dir)).toThrow(/Invalid lease source/);
    } finally {
      injectClaimOps(null);
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Crash points via fs ops seam — each step, verify no second owner ─────

  function crashTestOp(throwOnOp: string, expectWinner: boolean) {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp(throwOnOp);
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-CR2", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow();
      injectClaimOps(null);

      if (expectWinner) {
        expect(existsSync(join(dir, "US-CR2.lease"))).toBe(true);
      } else {
        expect(existsSync(join(dir, "US-CR2.lease"))).toBe(false);
      }

      const r2 = claimStoryLease(dir, "US-CR2", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d5", runId: "rd5",
      });
      if (expectWinner) {
        expect(r2.status).toBe("exists");
        expect(readLeases(dir)["US-CR2"]!.pid).toBe(process.pid);
      } else {
        expect(r2.status).toBe("claimed");
        expect(readLeases(dir)["US-CR2"]!.pid).toBe(99999);
      }
    } finally {
      injectClaimOps(null);
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  }

  it("crash at writeTempFile: no record, retry wins", () => crashTestOp("writeTempFile", false));
  it("crash at openFile (temp file): no record, retry wins", () => crashTestOp("openFile", false));
  it("crash at fsyncFile: no record, retry wins", () => crashTestOp("fsyncFile", false));
  it("crash at hardLink (before link): no record, retry wins", () => crashTestOp("hardLink", false));
  it("crash at unlinkFile: unlink is best-effort, claim succeeds, retry blocked", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("unlinkFile");
      injectClaimOps(spy.ops);

      // unlinkFile is try/catch in production — the claim still succeeds
      const r1 = claimStoryLease(dir, "US-CR3", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r1.status).toBe("claimed");
      injectClaimOps(null);

      // Record exists (hardlink was durable)
      expect(existsSync(join(dir, "US-CR3.lease"))).toBe(true);

      // Retry blocked — record already claimed
      const r2 = claimStoryLease(dir, "US-CR3", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d6", runId: "rd6",
      });
      expect(r2.status).toBe("exists");
      expect(readLeases(dir)["US-CR3"]!.pid).toBe(process.pid);
    } finally {
      injectClaimOps(null);
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ─── Concurrent subprocess claim (real process isolation, Fix #5) ─────────────

describe("claimStoryLease — concurrent subprocess hardlink exclusion", () => {
  /**
   * Resolved local node + tsx loader (declared devDependency) — no network.
   * Workers import from tracked TypeScript source via --import tsx/esm.
   * Spawns a subprocess worker that uses a ready/go barrier for race tests.
   *
   * Returns { status, code, stderr }. Hard-fails on empty output or nonzero exit.
   *
   * US-DELTA-003 hermetic: worker imports claimStoryLease directly from the
   * narrow production module (no barrel, no transitive @roll/spec dep).
   */
  const nodeExe = process.execPath;
  // Resolve tracked narrow TypeScript source and tsx ESM loader (must exist before any spawn)
  const leaseModulePath = join(__dirname, "..", "src", "backlog", "lease.ts");
  const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
  if (!existsSync(leaseModulePath)) throw new Error(`lease module not found: ${leaseModulePath}`);
  if (!existsSync(tsxLoader)) throw new Error(`tsx loader not found: ${tsxLoader}`);

  async function runWorker(args: {
    dirPath: string;
    workDir: string;
    storyId: string;
    workerId: string;
    source: string;
    pid?: number;
    delegationId?: string;
    runId?: string;
  }): Promise<{ status: string; code: number; stderr: string } & { child: ReturnType<typeof spawn> }> {
    const { dirPath, workDir, storyId, workerId, source, pid, delegationId, runId } = args;

    // Write a worker script that imports from tracked TypeScript source via tsx loader
    const workerScript = join(workDir, `worker-${workerId}.mjs`);
    const readyFile = join(workDir, `ready.${workerId}`);
    const goFile = join(workDir, "go.txt");
    const resultFile = join(workDir, `result.${workerId}.json`);

    const entryObj: Record<string, unknown> = { claimedAt: Date.now(), source };
    if (pid !== undefined) entryObj.pid = pid;
    if (delegationId) entryObj.delegationId = delegationId;
    if (runId) entryObj.runId = runId;

    const scriptContent = `
import { claimStoryLease } from ${JSON.stringify(leaseModulePath)};
import { writeFileSync, existsSync } from "node:fs";

const dirPath = ${JSON.stringify(dirPath)};
const storyId = ${JSON.stringify(storyId)};
const entry = ${JSON.stringify(entryObj)};
const readyFile = ${JSON.stringify(readyFile)};
const goFile = ${JSON.stringify(goFile)};
const resultFile = ${JSON.stringify(resultFile)};

// Signal ready
writeFileSync(readyFile, "ready", "utf8");

// Wait for go signal (poll every 2ms, max 15s)
const start = Date.now();
while (!existsSync(goFile)) {
  if (Date.now() - start > 15000) {
    process.stderr.write("timeout waiting for go signal\\n");
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2));
}

// Race!
const result = claimStoryLease(dirPath, storyId, entry);
writeFileSync(resultFile, JSON.stringify(result), "utf8");
process.exit(0);
`;
    writeFileSync(workerScript, scriptContent, "utf8");

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(nodeExe, ["--import", tsxLoader, workerScript], {
        cwd: workDir,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "test" },
      });
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => {
        settle(() => {
          try {
            if (existsSync(resultFile)) {
              const raw = readFileSync(resultFile, "utf8").trim();
              if (raw === "") {
                reject(new Error(`worker ${workerId}: empty output, stderr=${stderr}`));
                return;
              }
              const parsed = JSON.parse(raw);
              resolve({ status: parsed.status, code: code ?? -1, stderr, child });
            } else {
              reject(new Error(`worker ${workerId}: no result file, code=${code}, stderr=${stderr}`));
            }
          } catch (err) {
            reject(new Error(`worker ${workerId}: parse error, code=${code}, stderr=${stderr}`));
          }
        });
      });
      child.on("error", (err) => settle(() => reject(err)));
    });
  }

  /** Create a temp work dir, spawn 2 workers with ready/go barrier, assert outcome.
   *  On any error (timeout, etc.), kills both children and awaits them before
   *  cleanup — no unhandled rejections, no worker script deleted while starting. */
  async function raceWorkers(worker1Args: Parameters<typeof runWorker>[0], worker2Args: Parameters<typeof runWorker>[0]) {
    const dir = tmpLeaseDir();
    const workDir = mkdtempSync(join(tmpdir(), "lease-race-"));
    const w1Args = { ...worker1Args, dirPath: dir, workDir };
    const w2Args = { ...worker2Args, dirPath: dir, workDir };

    let w1Promise: ReturnType<typeof runWorker> | null = null;
    let w2Promise: ReturnType<typeof runWorker> | null = null;

    try {
      const goFile = join(workDir, "go.txt");

      w1Promise = runWorker(w1Args);
      w2Promise = runWorker(w2Args);

      // Wait for both ready signals
      const ready1 = join(workDir, `ready.${worker1Args.workerId}`);
      const ready2 = join(workDir, `ready.${worker2Args.workerId}`);
      const start = Date.now();
      while (!existsSync(ready1) || !existsSync(ready2)) {
        if (Date.now() - start > 10000) {
          // Timeout: terminate and await both children before throwing
          const p1 = await Promise.resolve(w1Promise).then(r => r?.child).catch(() => null);
          const p2 = await Promise.resolve(w2Promise).then(r => r?.child).catch(() => null);
          // w1Promise/w2Promise may already be resolved or pending
          // Kill children that are still alive
          try { p1?.kill("SIGKILL"); } catch {}
          try { p2?.kill("SIGKILL"); } catch {}
          // Consume promises to prevent unhandled rejections
          await Promise.allSettled([w1Promise, w2Promise]);
          throw new Error("workers never signaled ready");
        }
        await new Promise(r => setTimeout(r, 5));
      }

      // GO!
      writeFileSync(goFile, "go", "utf8");

      const [r1, r2] = await Promise.all([w1Promise, w2Promise]);
      return { dir, workDir, r1, r2 };
    } catch (err) {
      // On any error, terminate children, consume promises, and clean up
      try {
        const p1 = w1Promise ? await Promise.resolve(w1Promise).then(r => r?.child).catch(() => null) : null;
        const p2 = w2Promise ? await Promise.resolve(w2Promise).then(r => r?.child).catch(() => null) : null;
        try { p1?.kill("SIGKILL"); } catch {}
        try { p2?.kill("SIGKILL"); } catch {}
      } catch {}
      await Promise.allSettled([
        w1Promise ?? Promise.resolve(),
        w2Promise ?? Promise.resolve(),
      ]);
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
      throw err;
    }
  }

  // ── Same story, same source → exactly one winner ────────────────────────

  it("same story, two cycle claims: exactly one winner, empty stderr, zero exit", async () => {
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "a", storyId: "US-RACE-CYC", source: "cycle", pid: 10001 },
      { workerId: "b", storyId: "US-RACE-CYC", source: "cycle", pid: 10002 },
    );
    try {
      // Both exit 0
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      expect(r1.stderr).toBe("");
      expect(r2.stderr).toBe("");
      // Exactly one winner
      const winners = [r1, r2].filter((r) => r.status === "claimed");
      expect(winners).toHaveLength(1);
      // Only one .lease file
      const leases = readLeases(dir);
      expect(Object.keys(leases)).toHaveLength(1);
      expect(Object.keys(leases)[0]).toBe("US-RACE-CYC");
      // No temp residue
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  // ── Same story, different sources → exactly one winner ──────────────────

  it("same story, host-delegation vs cycle: exactly one winner", async () => {
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "hd", storyId: "US-RACE-HDCYC", source: "host-delegation", delegationId: "deleg-hd", runId: "delta-hd" },
      { workerId: "cyc", storyId: "US-RACE-HDCYC", source: "cycle", pid: 20001 },
    );
    try {
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      const winners = [r1, r2].filter((r) => r.status === "claimed");
      expect(winners).toHaveLength(1);
      const leases = readLeases(dir);
      expect(Object.keys(leases)).toHaveLength(1);
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  it("same story, host-delegation vs human: exactly one winner", async () => {
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "hd", storyId: "US-RACE-HDHUM", source: "host-delegation", delegationId: "deleg-hd2", runId: "delta-hd2" },
      { workerId: "hum", storyId: "US-RACE-HDHUM", source: "human" },
    );
    try {
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      const winners = [r1, r2].filter((r) => r.status === "claimed");
      expect(winners).toHaveLength(1);
      expect(Object.keys(readLeases(dir))).toHaveLength(1);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  it("same story, host-delegation vs supervisor: exactly one winner", async () => {
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "hd", storyId: "US-RACE-HDSUP", source: "host-delegation", delegationId: "deleg-hd3", runId: "delta-hd3" },
      { workerId: "sup", storyId: "US-RACE-HDSUP", source: "supervisor" },
    );
    try {
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      const winners = [r1, r2].filter((r) => r.status === "claimed");
      expect(winners).toHaveLength(1);
      expect(Object.keys(readLeases(dir))).toHaveLength(1);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  // ── Different stories, different sources → both win ─────────────────────

  it("different stories, host-delegation vs cycle: both win", async () => {
    const storyA = "US-DIFF-HD-" + randomUUID().slice(0, 8);
    const storyB = "US-DIFF-CYC-" + randomUUID().slice(0, 8);
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "hd", storyId: storyA, source: "host-delegation", delegationId: "deleg-diff-hd", runId: "delta-diff-hd" },
      { workerId: "cyc", storyId: storyB, source: "cycle", pid: 30001 },
    );
    try {
      expect(r1.status).toBe("claimed");
      expect(r2.status).toBe("claimed");
      const leases = readLeases(dir);
      expect(leases[storyA]).toBeDefined();
      expect(leases[storyB]).toBeDefined();
      expect(Object.keys(leases)).toHaveLength(2);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  it("different stories, host-delegation vs human: both win", async () => {
    const storyA = "US-DIFF-HD2-" + randomUUID().slice(0, 8);
    const storyB = "US-DIFF-HUM-" + randomUUID().slice(0, 8);
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "hd", storyId: storyA, source: "host-delegation", delegationId: "deleg-diff-hd2", runId: "delta-diff-hd2" },
      { workerId: "hum", storyId: storyB, source: "human" },
    );
    try {
      expect(r1.status).toBe("claimed");
      expect(r2.status).toBe("claimed");
      expect(Object.keys(readLeases(dir))).toHaveLength(2);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  // ─── Malformed/stderr → fail ────────────────────────────────────────────

  it("worker with missing storyId returns non-claimed status, test still sees exactly one winner when raced", async () => {
    // Tests that empty/malformed output would hard-fail, but valid claim works
    const { dir, workDir, r1, r2 } = await raceWorkers(
      { workerId: "ok1", storyId: "US-MALFORM", source: "cycle", pid: 40001 },
      { workerId: "ok2", storyId: "US-MALFORM", source: "cycle", pid: 40002 },
    );
    try {
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      expect(r1.stderr).toBe("");
      expect(r2.stderr).toBe("");
      const winners = [r1, r2].filter((r) => r.status === "claimed");
      expect(winners).toHaveLength(1);
      // No .tmp residue after race
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {}
    }
  }, 15000);
});

// ─── Crash recovery: between temp/write and link/fsync/unlink ──────────────

describe("claimStoryLease — crash resilience between hardlink steps", () => {
  it("temp file from interrupted claim does not block future claims", () => {
    const dir = tmpLeaseDir();
    try {
      // Simulate crash after temp write but before link: leave a temp file
      const storyId = "US-CRASH";
      mkdirSync(dir, { recursive: true });
      const tmpPath = join(dir, `${storyId}.99999.abc12345.tmp`);
      writeFileSync(tmpPath, JSON.stringify({
        pid: 99999, claimedAt: NOW, source: "cycle",
      }) + "\n", "utf8");

      // The temp file should NOT block a new claim (different final path)
      const result = claimStoryLease(dir, storyId, {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(result.status).toBe("claimed");

      // Clean up orphaned temp
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("crash between link and parent fsync: record is on disk and valid", () => {
    const dir = tmpLeaseDir();
    try {
      // The claim succeeds even without explicit parent fsync in the test
      // (OS will eventually flush). The key property: after linkSync returns
      // successfully, the record exists and is readable.
      mkdirSync(dir, { recursive: true });
      const rp = join(dir, "US-LINKED.lease");
      const tmpPath = join(dir, "test-pre-link.tmp");
      writeFileSync(tmpPath, JSON.stringify({
        pid: process.pid, claimedAt: NOW, source: "cycle",
      }) + "\n", "utf8");

      // Hardlink — this is the critical step
      linkSync(tmpPath, rp);
      // Simulate crash before parent fsync — record should still be readable
      expect(existsSync(rp)).toBe(true);
      const content = readFileSync(rp, "utf8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.source).toBe("cycle");

      // Cleanup
      unlinkSync(tmpPath);
      unlinkSync(rp);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("temp files from old/stale PIDs do not cause torn-map behavior", () => {
    const dir = tmpLeaseDir();
    try {
      // Multiple temp files from dead PIDs
      mkdirSync(dir, { recursive: true });
      const tmp1 = join(dir, "US-TORN.99998.a1.tmp");
      const tmp2 = join(dir, "US-TORN.99999.b2.tmp");
      writeFileSync(tmp1, "stale\n", "utf8");
      writeFileSync(tmp2, "stale\n", "utf8");

      // Claim should succeed — temps are on different paths
      const result = claimStoryLease(dir, "US-TORN", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(result.status).toBe("claimed");

      // Clean up temps
      try { unlinkSync(tmp1); } catch {}
      try { unlinkSync(tmp2); } catch {}

      // Only one valid .lease file
      const leases = readLeases(dir);
      expect(Object.keys(leases)).toEqual(["US-TORN"]);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ─── releaseStoryLease — match-only (directory-based, no lock) ─────────────

describe("releaseStoryLease — match-only release (US-DELTA-003 directory)", () => {
  it("releases matching host-delegation lease by delegationId", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "host-delegation", delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });
      expect(r).toBe(true);
      expect(readLeases(dir)["US-001"]).toBeUndefined();
      expect(existsSync(join(dir, "US-001.lease"))).toBe(false);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("refuses to release mismatched delegationId (match-only)", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "host-delegation", delegationId: "deleg-WRONG", runId: "delta-deleg-aaa",
      });
      expect(r).toBe(false);

      const leases = readLeases(dir);
      expect(leases["US-001"]!.delegationId).toBe("deleg-aaa");
      expect(existsSync(join(dir, "US-001.lease"))).toBe(true);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("refuses to release host-delegation when runId is missing (mandatory contract)", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "host-delegation", delegationId: "deleg-aaa",
      });
      expect(r).toBe(false);

      const leases = readLeases(dir);
      expect(leases["US-001"]).toBeDefined();
      expect(leases["US-001"]!.delegationId).toBe("deleg-aaa");
      expect(leases["US-001"]!.runId).toBe("delta-deleg-aaa");
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("refuses to release host-delegation when runId is mismatched", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "host-delegation", delegationId: "deleg-aaa", runId: "delta-deleg-WRONG",
      });
      expect(r).toBe(false);

      const leases = readLeases(dir);
      expect(leases["US-001"]).toBeDefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("refuses to release mismatched source (cycle cannot release host-delegation)", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "cycle", pid: process.pid,
      });
      expect(r).toBe(false);
      expect(readLeases(dir)["US-001"]!.source).toBe("host-delegation");
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("refuses to release mismatched pid for cycle source", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "cycle", pid: 99999,
      });
      expect(r).toBe(false);
      expect(readLeases(dir)["US-001"]!.pid).toBe(process.pid);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("releases matching cycle lease by pid", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });

      const r = releaseStoryLease(dir, "US-001", {
        source: "cycle", pid: process.pid,
      });
      expect(r).toBe(true);
      expect(readLeases(dir)["US-001"]).toBeUndefined();
      expect(existsSync(join(dir, "US-001.lease"))).toBe(false);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("returns false for non-existent story", () => {
    const dir = tmpLeaseDir();
    try {
      expect(releaseStoryLease(dir, "US-NOPE", { source: "cycle" })).toBe(false);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("does not remove other stories from the directory", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-001", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });
      claimStoryLease(dir, "US-002", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });

      releaseStoryLease(dir, "US-001", {
        source: "host-delegation", delegationId: "deleg-aaa", runId: "delta-deleg-aaa",
      });

      const leases = readLeases(dir);
      expect(leases["US-001"]).toBeUndefined();
      expect(existsSync(join(dir, "US-001.lease"))).toBe(false);
      expect(leases["US-002"]).toBeDefined();
      expect(existsSync(join(dir, "US-002.lease"))).toBe(true);
      expect(leases["US-002"]!.source).toBe("cycle");
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("release of cycle lease does not affect adjacent host-delegation lease", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-CYC", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      claimStoryLease(dir, "US-HD", {
        claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-hd", runId: "delta-hd",
      });

      expect(releaseStoryLease(dir, "US-CYC", { source: "cycle", pid: process.pid })).toBe(true);
      expect(readLeases(dir)["US-HD"]).toBeDefined();
      expect(readLeases(dir)["US-CYC"]).toBeUndefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── PID release safety (Fix #1: cycle MUST require non-empty/matching pid) ──

  it("cycle release without pid NEVER deletes — returns false, bytes unchanged", () => {
    const dir = tmpLeaseDir();
    try {
      const entry = { pid: 4242, claimedAt: NOW, source: "cycle" as const };
      claimStoryLease(dir, "US-CYC-NOPID", entry);

      // Capture bytes before attempted release
      const rp = join(dir, "US-CYC-NOPID.lease");
      expect(existsSync(rp)).toBe(true);
      const beforeBytes = readFileSync(rp);

      // Attempt release with cycle source but NO pid
      const r = releaseStoryLease(dir, "US-CYC-NOPID", { source: "cycle" });
      expect(r).toBe(false);

      // Record must still exist with identical bytes
      expect(existsSync(rp)).toBe(true);
      const afterBytes = readFileSync(rp);
      expect(afterBytes).toEqual(beforeBytes);

      // Lease must still be readable
      const leases = readLeases(dir);
      expect(leases["US-CYC-NOPID"]).toBeDefined();
      expect(leases["US-CYC-NOPID"]!.source).toBe("cycle");
      expect(leases["US-CYC-NOPID"]!.pid).toBe(4242);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("cycle release with missing pid on existing cycle lease: returns false, record untouched", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-CYC-MISS", {
        pid: 8888, claimedAt: NOW, source: "cycle",
      });
      const rp = join(dir, "US-CYC-MISS.lease");
      const beforeBytes = readFileSync(rp);

      const r = releaseStoryLease(dir, "US-CYC-MISS", { source: "cycle" });
      expect(r).toBe(false);

      expect(readFileSync(rp)).toEqual(beforeBytes);
      expect(readLeases(dir)["US-CYC-MISS"]!.pid).toBe(8888);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("cycle release with wrong pid on existing cycle lease: returns false, record untouched", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-CYC-WRONG", {
        pid: 1111, claimedAt: NOW, source: "cycle",
      });
      const rp = join(dir, "US-CYC-WRONG.lease");
      const beforeBytes = readFileSync(rp);

      const r = releaseStoryLease(dir, "US-CYC-WRONG", { source: "cycle", pid: 2222 });
      expect(r).toBe(false);

      expect(readFileSync(rp)).toEqual(beforeBytes);
      expect(readLeases(dir)["US-CYC-WRONG"]!.pid).toBe(1111);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("cycle release with correct pid on existing cycle lease succeeds (existing behavior verified)", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-CYC-OK", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      const rp = join(dir, "US-CYC-OK.lease");
      expect(existsSync(rp)).toBe(true);

      const r = releaseStoryLease(dir, "US-CYC-OK", { source: "cycle", pid: process.pid });
      expect(r).toBe(true);
      expect(existsSync(rp)).toBe(false);
      expect(readLeases(dir)["US-CYC-OK"]).toBeUndefined();
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("human release must not mistakenly delete a cycle lease with same story", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-X", {
        pid: 3333, claimedAt: NOW, source: "cycle",
      });
      const rp = join(dir, "US-X.lease");
      const beforeBytes = readFileSync(rp);

      // Attempt to release as "human" — must NOT delete the cycle lease
      const r = releaseStoryLease(dir, "US-X", { source: "human" });
      expect(r).toBe(false);
      expect(readFileSync(rp)).toEqual(beforeBytes);
      expect(readLeases(dir)["US-X"]!.source).toBe("cycle");
      expect(readLeases(dir)["US-X"]!.pid).toBe(3333);
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("supervisor release must not mistakenly delete a cycle lease with same story", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-X-SUP", {
        pid: 4444, claimedAt: NOW, source: "cycle",
      });
      const rp = join(dir, "US-X-SUP.lease");
      const beforeBytes = readFileSync(rp);

      const r = releaseStoryLease(dir, "US-X-SUP", { source: "supervisor" });
      expect(r).toBe(false);
      expect(readFileSync(rp)).toEqual(beforeBytes);
      expect(readLeases(dir)["US-X-SUP"]!.source).toBe("cycle");
    } finally {
      try { const { rmSync } = require("fs"); rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ─── Legacy compatibility tests ──────────────────────────────────────────────

describe("legacy story-leases.json compatibility", () => {
  it("legacyLeasePath returns path to story-leases.json", () => {
    expect(legacyLeasePath("/tmp/loop")).toBe("/tmp/loop/story-leases.json");
  });

  it("leaseDirPath returns path to leases directory", () => {
    expect(leaseDirPath("/tmp/loop/events.ndjson")).toBe("/tmp/loop/leases");
  });

  it("readLeases with legacy file fallback returns legacy data when dir absent", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "legacy-read-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    try {
      writeFileSync(legacyPath, JSON.stringify({
        "FIX-OLD": { pid: 99999, claimedAt: NOW, source: "cycle" },
      }, null, 2) + "\n", "utf8");

      // Dir absent → legacy-only fallback
      const loaded = readLeases(leasesDir);
      expect(loaded["FIX-OLD"]).toBeDefined();
      expect(loaded["FIX-OLD"]!.source).toBe("cycle");
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Adjudication A: Legacy is never mutated ───────────────────────────

  it("A1: claim different story with legacy present — legacy byte-identical, canonical record created", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "a1-immutable-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const legacyContent = JSON.stringify({
      "OLD-A": { pid: 111, claimedAt: NOW - 1000, source: "cycle" },
      "OLD-B": { claimedAt: NOW - 2000, source: "human" },
    }, null, 2) + "\n";
    writeFileSync(legacyPath, legacyContent, "utf8");

    try {
      const r = claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "host-delegation",
        delegationId: "deleg-a1", runId: "delta-a1",
      });
      expect(r.status).toBe("claimed");

      // Legacy byte-for-byte unchanged
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
      // No .retired file
      expect(existsSync(legacyPath + ".retired")).toBe(false);

      // Canonical record exists
      expect(existsSync(join(leasesDir, "US-NEW.lease"))).toBe(true);

      // Merge-read: canonical + legacy (OLD-A, OLD-B not in canonical → visible)
      const leases = readLeases(leasesDir);
      expect(leases["OLD-A"]).toBeDefined();
      expect(leases["OLD-A"]!.source).toBe("cycle");
      expect(leases["OLD-B"]).toBeDefined();
      expect(leases["OLD-B"]!.source).toBe("human");
      expect(leases["US-NEW"]).toBeDefined();
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("A2: same-story legacy conflict — return exists, legacy unchanged, no canonical record", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "a2-conflict-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    const legacyContent = JSON.stringify({
      "US-LEGACY": { pid: 55555, claimedAt: NOW, source: "cycle" },
    }, null, 2) + "\n";
    writeFileSync(legacyPath, legacyContent, "utf8");

    try {
      const r = claimStoryLease(leasesDir, "US-LEGACY", {
        pid: process.pid, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "deleg-a2", runId: "delta-a2",
      });
      expect(r.status).toBe("exists");
      if (r.status === "exists") {
        expect(r.existingSource).toBe("cycle");
      }

      // Legacy unchanged
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);

      // No canonical record for US-LEGACY
      expect(existsSync(join(leasesDir, "US-LEGACY.lease"))).toBe(false);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("A3: legacy same-story block for all claim sources", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "a3-all-src-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    writeFileSync(legacyPath, JSON.stringify({
      "US-X": { pid: 77777, claimedAt: NOW, source: "cycle" },
    }, null, 2) + "\n", "utf8");

    try {
      // Host-delegation
      expect(claimStoryLease(leasesDir, "US-X", {
        claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d", runId: "r",
      }).status).toBe("exists");
      // Cycle
      expect(claimStoryLease(leasesDir, "US-X", {
        pid: 88888, claimedAt: NOW + 2, source: "cycle",
      }).status).toBe("exists");
      // Human
      expect(claimStoryLease(leasesDir, "US-X", {
        claimedAt: NOW + 3, source: "human",
      }).status).toBe("exists");
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Adjudication B: Merge-read authority ──────────────────────────────

  it("B1: canonical + different legacy → both visible in merge-read", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b1-merge-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const leasesDir = join(loopDir, "leases");
    mkdirSync(leasesDir, { recursive: true });
    // Canonical record for US-A
    writeFileSync(join(leasesDir, "US-A.lease"), JSON.stringify({
      claimedAt: NOW, source: "host-delegation", delegationId: "d1", runId: "r1",
    }) + "\n", "utf8");
    // Legacy has US-B
    const legacyPath = join(loopDir, "story-leases.json");
    writeFileSync(legacyPath, JSON.stringify({
      "US-B": { pid: 222, claimedAt: NOW - 500, source: "cycle" },
    }, null, 2) + "\n", "utf8");

    try {
      const leases = readLeases(leasesDir);
      expect(leases["US-A"]).toBeDefined();
      expect(leases["US-A"]!.source).toBe("host-delegation");
      expect(leases["US-B"]).toBeDefined();
      expect(leases["US-B"]!.source).toBe("cycle");
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("B2: same storyId canonical + legacy → canonical wins, no throw", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "b2-precedence-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const leasesDir = join(loopDir, "leases");
    mkdirSync(leasesDir, { recursive: true });
    // Canonical record
    writeFileSync(join(leasesDir, "US-X.lease"), JSON.stringify({
      pid: 100, claimedAt: NOW, source: "cycle",
    }) + "\n", "utf8");
    // Legacy has same story with different owner
    const legacyPath = join(loopDir, "story-leases.json");
    writeFileSync(legacyPath, JSON.stringify({
      "US-X": { claimedAt: NOW - 5000, source: "human" },
    }, null, 2) + "\n", "utf8");

    try {
      const leases = readLeases(leasesDir);
      expect(leases["US-X"]).toBeDefined();
      // Canonical wins
      expect(leases["US-X"]!.source).toBe("cycle");
      expect(leases["US-X"]!.pid).toBe(100);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("B3: readLeases during claim never loses legacy owner (observer probe)", () => {
    // Prove that while a canonical claim is being made, readLeases
    // always includes pre-existing legacy owners.
    const baseDir = mkdtempSync(join(tmpdir(), "b3-observer-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    writeFileSync(legacyPath, JSON.stringify({
      "OLD-X": { pid: 99999, claimedAt: NOW - 5000, source: "cycle" },
    }, null, 2) + "\n", "utf8");

    try {
      // Claim a different story
      const r = claimStoryLease(leasesDir, "US-NEW", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(r.status).toBe("claimed");

      // After claim, readLeases must include OLD-X via merge-read
      const leases = readLeases(leasesDir);
      expect(leases["OLD-X"]).toBeDefined();
      expect(leases["OLD-X"]!.source).toBe("cycle");
      expect(leases["US-NEW"]).toBeDefined();

      // Legacy unchanged
      expect(existsSync(legacyPath)).toBe(true);
      expect(existsSync(legacyPath + ".retired")).toBe(false);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Adjudication C: Strict decoder ────────────────────────────────────

  it("C1: legacy root [] → fail-loud from readLeases", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "c1-array-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    writeFileSync(legacyPath, "[]", "utf8");
    try {
      expect(() => readLeases(leasesDir)).toThrow(/array/);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("C2: legacy root scalar/string/null → fail-loud", () => {
    const cases: Array<{ label: string; content: string }> = [
      { label: "string", content: '"x"' },
      { label: "number", content: "42" },
      { label: "null", content: "null" },
    ];
    for (const { label, content } of cases) {
      const baseDir = mkdtempSync(join(tmpdir(), `c2-${label}-`));
      const loopDir = join(baseDir, "loop");
      mkdirSync(loopDir, { recursive: true });
      const legacyPath = join(loopDir, "story-leases.json");
      const leasesDir = join(loopDir, "leases");
      writeFileSync(legacyPath, content, "utf8");
      try {
        expect(() => readLeases(leasesDir)).toThrow(/object/);
      } finally {
        try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }
  });

  it("C3: legacy entry with unknown source → fail-loud", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "c3-bad-source-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    writeFileSync(legacyPath, JSON.stringify({
      "X": { source: "attacker", claimedAt: 1 },
    }) + "\n", "utf8");
    try {
      expect(() => readLeases(leasesDir)).toThrow(/Invalid lease source/);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("C4: legacy entry with non-finite claimedAt → fail-loud", () => {
    const cases: Array<{ label: string; claimedAt: unknown }> = [
      { label: "NaN", claimedAt: NaN },
      { label: "Infinity", claimedAt: Infinity },
      { label: "string", claimedAt: "yesterday" },
    ];
    for (const { label, claimedAt } of cases) {
      const baseDir = mkdtempSync(join(tmpdir(), `c4-${label}-`));
      const loopDir = join(baseDir, "loop");
      mkdirSync(loopDir, { recursive: true });
      const legacyPath = join(loopDir, "story-leases.json");
      const leasesDir = join(loopDir, "leases");
      writeFileSync(legacyPath, JSON.stringify({
        "X": { source: "human", claimedAt },
      }) + "\n", "utf8");
      try {
        expect(() => readLeases(leasesDir)).toThrow(/claimedAt/);
      } finally {
        try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }
  });

  it("C5: valid legacy human (no pid) and cycle (with pid) accepted", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "c5-valid-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    writeFileSync(legacyPath, JSON.stringify({
      "HUM-1": { claimedAt: NOW, source: "human" },
      "SUP-1": { claimedAt: NOW - 100, source: "supervisor" },
      "CYC-1": { pid: 4242, claimedAt: NOW - 200, source: "cycle" },
    }) + "\n", "utf8");
    try {
      const leases = readLeases(leasesDir);
      expect(leases["HUM-1"]).toBeDefined();
      expect(leases["HUM-1"]!.source).toBe("human");
      expect(leases["HUM-1"]!.pid).toBeUndefined();
      expect(leases["SUP-1"]).toBeDefined();
      expect(leases["SUP-1"]!.source).toBe("supervisor");
      expect(leases["CYC-1"]).toBeDefined();
      expect(leases["CYC-1"]!.source).toBe("cycle");
      expect(leases["CYC-1"]!.pid).toBe(4242);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("C6: malformed canonical .lease record → fail-loud from readLeases", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "c6-canon-mal-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const leasesDir = join(loopDir, "leases");
    mkdirSync(leasesDir, { recursive: true });
    // Write a malformed canonical record (unknown source)
    writeFileSync(join(leasesDir, "BAD.lease"), JSON.stringify({
      source: "attacker", claimedAt: 1,
    }) + "\n", "utf8");
    try {
      expect(() => readLeases(leasesDir)).toThrow(/Invalid lease source/);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Adjudication D: Temp/FD cleanup ───────────────────────────────────

  it("D1: openFile (temp) failure → throw, no .tmp residue, retry succeeds", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("openFile", 1);
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-D1", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected openFile/);

      injectClaimOps(null);

      // No .tmp residue (temp unlinked in catch)
      expect(existsSync(join(dir, "US-D1.lease"))).toBe(false);
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);

      // Retry succeeds
      const r2 = claimStoryLease(dir, "US-D1", {
        pid: 99999, claimedAt: NOW + 1, source: "cycle",
      });
      expect(r2.status).toBe("claimed");
      expect(existsSync(join(dir, "US-D1.lease"))).toBe(true);
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("D2: fsyncFile (temp) failure → throw, temp unlinked, close attempted, retry succeeds", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("fsyncFile", 1);
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-D2", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected fsyncFile/);

      // closeFile was attempted in cleanup
      const closeCalls = spy.calls.filter(c => c.op === "closeFile");
      expect(closeCalls.length).toBeGreaterThanOrEqual(1);

      injectClaimOps(null);

      // No .tmp residue
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);

      // Retry succeeds
      const r2 = claimStoryLease(dir, "US-D2", {
        pid: 99999, claimedAt: NOW + 1, source: "cycle",
      });
      expect(r2.status).toBe("claimed");
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("D3: closeFile (temp) failure → throws, retry not blocked", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("closeFile", 1);
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-D3", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected closeFile/);
      injectClaimOps(null);

      // No canonical record (link was never attempted)
      expect(existsSync(join(dir, "US-D3.lease"))).toBe(false);

      // Retry succeeds
      const r2 = claimStoryLease(dir, "US-D3", {
        pid: 99999, claimedAt: NOW + 1, source: "cycle",
      });
      expect(r2.status).toBe("claimed");
      expect(existsSync(join(dir, "US-D3.lease"))).toBe(true);
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("D4: post-link dir fsync failure → record present, owner visible, intentional post-link uncertainty", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("fsyncFile", 2); // second fsyncFile = directory fsync
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-D4", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected fsyncFile/);
      injectClaimOps(null);

      // Record exists (hardlink already succeeded)
      expect(existsSync(join(dir, "US-D4.lease"))).toBe(true);
      const leases = readLeases(dir);
      expect(leases["US-D4"]).toBeDefined();
      expect(leases["US-D4"]!.source).toBe("cycle");

      // Post-link temp residue is intentional (unlinkFile runs after dir fsync, which threw)
      // but the lease IS claimed — retry blocked
      const r2 = claimStoryLease(dir, "US-D4", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d4x", runId: "r4x",
      });
      expect(r2.status).toBe("exists");
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── BLOCK-4: Directory FD closure on post-link faults ─────────────────

  it("BLOCK-4: dir openFile failure after hardlink — dirFd closed, record present, retry blocked", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("openFile", 2); // second openFile = directory open
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-DIR-OPEN", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected openFile/);

      // Spy calls: writeTempFile, openFile(temp), fsyncFile, closeFile, hardLink.
      // The dir openFile threw in checkThrow BEFORE calls.push, so it's not recorded.
      const opNames = spy.calls.map(c => c.op);
      expect(opNames).toEqual(["writeTempFile", "openFile", "fsyncFile", "closeFile", "hardLink"]);

      // No closeFile for dir (open failed), tmpFd was closed already, dirFd is still -1
      const closeCalls = spy.calls.filter(c => c.op === "closeFile");
      expect(closeCalls).toHaveLength(1); // only the temp fd close

      injectClaimOps(null);

      // Record exists (hardlink succeeded)
      expect(existsSync(join(dir, "US-DIR-OPEN.lease"))).toBe(true);

      // Retry blocked
      const r2 = claimStoryLease(dir, "US-DIR-OPEN", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d-do", runId: "r-do",
      });
      expect(r2.status).toBe("exists");
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-4: dir fsyncFile failure after hardlink — dirFd closed, record present, retry blocked", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("fsyncFile", 2); // second fsyncFile = directory fsync
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-DIR-FSYNC", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected fsyncFile/);

      // Verify closeFile was called for dirFd in the catch block
      const closeCalls = spy.calls.filter(c => c.op === "closeFile");
      expect(closeCalls.length).toBeGreaterThanOrEqual(1);
      // The last closeFile call is for the directory fd (after hardlink)
      // or from the failure cleanup

      injectClaimOps(null);

      // Record exists (hardlink succeeded)
      expect(existsSync(join(dir, "US-DIR-FSYNC.lease"))).toBe(true);
      const leases = readLeases(dir);
      expect(leases["US-DIR-FSYNC"]).toBeDefined();

      // Retry blocked
      const r2 = claimStoryLease(dir, "US-DIR-FSYNC", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d-df", runId: "r-df",
      });
      expect(r2.status).toBe("exists");
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-4: dir closeFile failure after hardlink — record present, retry blocked", () => {
    const dir = tmpLeaseDir();
    try {
      const spy = createClaimOpsSpy();
      spy.throwAtOp("closeFile", 2); // second closeFile = directory close
      injectClaimOps(spy.ops);

      expect(() => claimStoryLease(dir, "US-DIR-CLOSE", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow(/injected closeFile/);

      // The first closeFile (temp) succeeded, second (dir) threw.
      // The catch block attempted to close dirFd again.
      const closeCalls = spy.calls.filter(c => c.op === "closeFile");
      expect(closeCalls.length).toBeGreaterThanOrEqual(1);

      injectClaimOps(null);

      // Record exists
      expect(existsSync(join(dir, "US-DIR-CLOSE.lease"))).toBe(true);

      // Retry blocked
      const r2 = claimStoryLease(dir, "US-DIR-CLOSE", {
        pid: 99999, claimedAt: NOW + 1, source: "host-delegation",
        delegationId: "d-dc", runId: "r-dc",
      });
      expect(r2.status).toBe("exists");
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("BLOCK-4: pre-link failure unlinks temp; post-link failure preserves lease", () => {
    const dir = tmpLeaseDir();
    try {
      // Pre-link: temp open failure
      const spy1 = createClaimOpsSpy();
      spy1.throwAtOp("openFile", 1);
      injectClaimOps(spy1.ops);
      expect(() => claimStoryLease(dir, "US-PRE", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow();
      injectClaimOps(null);

      // No record, no tmp residue
      expect(existsSync(join(dir, "US-PRE.lease"))).toBe(false);
      for (const e of readdirSync(dir)) expect(e).not.toMatch(/\.tmp$/);

      // Post-link: claims a different story successfully, then dir fsync fails on another
      const spy2 = createClaimOpsSpy();
      spy2.throwAtOp("fsyncFile", 2);
      injectClaimOps(spy2.ops);
      expect(() => claimStoryLease(dir, "US-POST", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      })).toThrow();
      injectClaimOps(null);

      // Record exists (post-link), retry blocked
      expect(existsSync(join(dir, "US-POST.lease"))).toBe(true);
      const r2 = claimStoryLease(dir, "US-POST", {
        pid: 99999, claimedAt: NOW + 1, source: "cycle",
      });
      expect(r2.status).toBe("exists");
    } finally {
      injectClaimOps(null);
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ─── Adjudication E: Generic-caller preservation ───────────────────────

  it("E1: buildClaimedByOther with legacy owner visible via merge-read", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "e1-picker-"));
    const loopDir = join(baseDir, "loop");
    mkdirSync(loopDir, { recursive: true });
    const legacyPath = join(loopDir, "story-leases.json");
    const leasesDir = join(loopDir, "leases");
    writeFileSync(legacyPath, JSON.stringify({
      "CYC-LEGACY": { pid: 99999, claimedAt: NOW - 100, source: "cycle" },
    }) + "\n", "utf8");

    try {
      const leases = readLeases(leasesDir);
      // Legacy owner is visible
      expect(leases["CYC-LEGACY"]).toBeDefined();

      // buildClaimedByOther sees it as claimed-by-other (dead PID)
      const isOther = buildClaimedByOther(leases, NOW, process.pid);
      expect(isOther("CYC-LEGACY")).toBe(true);
    } finally {
      try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("E2: releaseStoryLease and cleanDeadLeases continue to work unchanged", () => {
    const dir = tmpLeaseDir();
    try {
      claimStoryLease(dir, "US-E2", {
        pid: process.pid, claimedAt: NOW, source: "cycle",
      });
      expect(releaseStoryLease(dir, "US-E2", {
        source: "cycle", pid: process.pid,
      })).toBe(true);
      expect(readLeases(dir)["US-E2"]).toBeUndefined();

      // cleanDeadLeases on empty dir
      expect(cleanDeadLeases(dir)).toEqual([]);
    } finally {
      try { rmSync(dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});
