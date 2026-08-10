/**
 * RL-TCR-001: verification anchor for the registered redline (policy/rules.yaml)
 * — non-docs-only commits must carry a fresh test-pass proof for this cycle.
 * Unit tests for the TCRPipeline pure decision logic (delivery/tcr.ts).
 * Byte-equivalence vs the bash/hook oracle is covered in tcr.difftest.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  countTcrCommits,
  countTcrFromOneline,
  freshnessVerdict,
  isDocsOnlyCommit,
  isTcrCommitMessage,
  parseTestPassProof,
  renderTcrAlert,
  tcrVerdict,
  FRESHNESS_LIMIT_SECONDS,
} from "../src/index.js";

describe("TCR commit counting", () => {
  it("isTcrCommitMessage matches a tcr: prefix only", () => {
    expect(isTcrCommitMessage("tcr: add foo")).toBe(true);
    expect(isTcrCommitMessage("Fix: x")).toBe(false);
    expect(isTcrCommitMessage(" tcr: leading space")).toBe(false);
  });
  it("countTcrCommits over message bodies", () => {
    expect(countTcrCommits(["tcr: a", "Story 1: b", "tcr: c"])).toBe(2);
  });
  it("countTcrFromOneline anchors sha + space + tcr:", () => {
    expect(
      countTcrFromOneline(["abc123 tcr: a", "def456 Fix: b", "0ff tcr: c", "not-a-sha tcr: d"]),
    ).toBe(2);
  });
});

describe("tcrVerdict (invariant I12)", () => {
  const base = { storyId: "US-X", count: 0, nowStamp: "2026-06-05 01:00" };

  it("empty started_at → pass (no-gate)", () => {
    const v = tcrVerdict({ ...base, startedAt: "", count: 0 });
    expect(v).toMatchObject({ ok: true, reason: "no-gate" });
  });
  it("started_at undefined → pass (no-gate)", () => {
    expect(tcrVerdict(base)).toMatchObject({ ok: true, reason: "no-gate" });
  });
  it("count > 0 → pass (tcr-present)", () => {
    const v = tcrVerdict({ ...base, startedAt: "1 hour ago", count: 3 });
    expect(v).toMatchObject({ ok: true, reason: "tcr-present", count: 3 });
  });
  it("zero count with active gate → failure + revert + ALERT + notify", () => {
    const v = tcrVerdict({ ...base, startedAt: "1 hour ago", count: 0 });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("zero-tcr");
    expect(v.revertStoryId).toBe("US-X");
    expect(v.alertBody).toContain("# ALERT — TCR check failed");
    expect(v.alertBody).toContain("zero tcr: commits since story start (1 hour ago)");
    expect(v.notify).toEqual({
      title: "roll ⚠ TCR Failed",
      message: "US-X: no tcr: commits found",
    });
  });
  it("renderTcrAlert interpolates story/time/started_at", () => {
    const body = renderTcrAlert("FIX-9", "2026-06-05 01:00", "yesterday");
    expect(body).toContain("**Story**: FIX-9");
    expect(body).toContain("**Time**: 2026-06-05 01:00");
    expect(body).toContain("$roll-build FIX-9");
  });
});

describe("parseTestPassProof", () => {
  it("extracts ts + tree", () => {
    expect(parseTestPassProof('{"ts":1717545600,"tree":"abc123"}')).toEqual({
      ts: 1717545600,
      tree: "abc123",
    });
  });
  it("missing ts or tree → undefined", () => {
    expect(parseTestPassProof('{"tree":"abc"}')).toBeUndefined();
    expect(parseTestPassProof('{"ts":1}')).toBeUndefined();
    expect(parseTestPassProof("garbage")).toBeUndefined();
  });
});

describe("isDocsOnlyCommit (pre-commit _docs_only)", () => {
  it("nested docs/ and guide/ exempt", () => {
    expect(isDocsOnlyCommit(["docs/x.md", "guide/y.html"])).toBe(true);
  });
  it("root-level *.md exempt", () => {
    expect(isDocsOnlyCommit(["README.md", "CHANGELOG.md"])).toBe(true);
  });
  it("any other nested path arms the gate", () => {
    expect(isDocsOnlyCommit(["README.md", "lib/foo.sh"])).toBe(false);
    expect(isDocsOnlyCommit(["skills/x.md"])).toBe(false);
  });
  it("root-level non-markdown arms the gate", () => {
    expect(isDocsOnlyCommit(["package.json"])).toBe(false);
  });
  it("empty staged set is NOT docs-only", () => {
    expect(isDocsOnlyCommit([])).toBe(false);
    expect(isDocsOnlyCommit([""])).toBe(false);
  });
});

describe("freshnessVerdict (pre-commit 60s gate)", () => {
  const tree = "deadbeef";
  const proof = (ts: number, t = tree): string => `{"ts":${ts},"tree":"${t}"}`;

  it("docs-only short-circuits before any proof check", () => {
    expect(freshnessVerdict({ stagedFiles: ["README.md"], now: 0, currentTree: tree })).toEqual({
      allowed: true,
      reason: "docs-only",
    });
  });
  it("no proof → blocked", () => {
    expect(
      freshnessVerdict({ stagedFiles: ["lib/x.sh"], now: 100, currentTree: tree }),
    ).toEqual({ allowed: false, reason: "no-proof" });
  });
  it("malformed proof → blocked", () => {
    expect(
      freshnessVerdict({
        stagedFiles: ["lib/x.sh"],
        proofBody: "{}",
        now: 100,
        currentTree: tree,
      }),
    ).toEqual({ allowed: false, reason: "malformed-proof" });
  });
  it("stale proof (>60s) → blocked with elapsed", () => {
    const v = freshnessVerdict({
      stagedFiles: ["lib/x.sh"],
      proofBody: proof(0),
      now: FRESHNESS_LIMIT_SECONDS + 1,
      currentTree: tree,
    });
    expect(v).toEqual({ allowed: false, reason: "stale", elapsed: 61 });
  });
  it("exactly 60s elapsed is still fresh (gate is > limit)", () => {
    const v = freshnessVerdict({
      stagedFiles: ["lib/x.sh"],
      proofBody: proof(0),
      now: FRESHNESS_LIMIT_SECONDS,
      currentTree: tree,
    });
    expect(v).toEqual({ allowed: true, reason: "fresh" });
  });
  it("tree changed → blocked", () => {
    const v = freshnessVerdict({
      stagedFiles: ["lib/x.sh"],
      proofBody: proof(100, "stale-tree"),
      now: 110,
      currentTree: tree,
    });
    expect(v).toEqual({ allowed: false, reason: "tree-changed" });
  });
  it("fresh + matching tree → allowed", () => {
    const v = freshnessVerdict({
      stagedFiles: ["lib/x.sh"],
      proofBody: proof(100),
      now: 110,
      currentTree: tree,
    });
    expect(v).toEqual({ allowed: true, reason: "fresh" });
  });
});
