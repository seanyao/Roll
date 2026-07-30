/**
 * Frozen-expectation test: TCRPipeline pure logic.
 *
 * Three fronts were proven equal to the frozen oracle (bin/roll `_loop_tcr_count`
 * / `_loop_enforce_tcr`, and the real `hooks/pre-commit` freshness gate) under
 * diff-test. Per US-PORT-009b the oracle is retired: the fixture git repos, the
 * `sed`/`bash` extraction, and the real-hook spawn are dropped. Each unit is a
 * pure function — fed fixed inputs and asserted against the frozen value
 * captured while the oracle agreed.
 *
 *   1. {@link countTcrFromOneline} over fixed `git log --oneline` lines.
 *   2. {@link tcrVerdict} + {@link renderTcrAlert} on a zero-tcr cycle (the v2
 *      side-effect of reverting the row + writing the ALERT is reproduced by the
 *      verdict's revertStoryId + the rendered ALERT body, asserted directly).
 *   3. {@link freshnessVerdict} over the pre-commit 60s gate's input matrix.
 */
import { describe, expect, it } from "vitest";
import { countTcrFromOneline, freshnessVerdict, renderTcrAlert, tcrVerdict } from "../src/index.js";

describe("frozen: countTcrFromOneline == _loop_tcr_count", () => {
  it("counts only tcr: commits in the since-window", () => {
    const lines = [
      "d000000 Refactor: d",
      "c000000 tcr: green c",
      "b000000 tcr: green b",
      "a000000 Story 1: a",
    ];
    expect(countTcrFromOneline(lines)).toBe(2);
  });
});

describe("frozen: zero-tcr cycle == tcrVerdict failure + renderTcrAlert body", () => {
  const FROZEN_ALERT = [
    "# ALERT — TCR check failed",
    "",
    "**Time**: IGNORED",
    "**Story**: US-X",
    "**Reason**: zero tcr: commits since story start (10 years ago)",
    "",
    "**Action required** (choose one):",
    "- Add TCR commits, then drive another cycle: `roll loop go --cards US-X`",
    "- Take over manually: `$roll-build US-X`",
    "- Reset and retry: `roll loop reset` then `roll loop go --cards US-X`",
    "",
  ].join("\n");

  it("renderTcrAlert reproduces the v2 ALERT body", () => {
    expect(renderTcrAlert("US-X", "IGNORED", "10 years ago")).toBe(FROZEN_ALERT);
  });

  it("tcrVerdict flags a zero-tcr failure that reverts US-X", () => {
    const v = tcrVerdict({ storyId: "US-X", startedAt: "10 years ago", count: 0, nowStamp: "x" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.revertStoryId).toBe("US-X");
  });

  it("tcrVerdict is ok when there is at least one tcr: commit", () => {
    expect(tcrVerdict({ storyId: "US-X", startedAt: "10 years ago", count: 1, nowStamp: "x" }).ok).toBe(true);
  });
});

describe("frozen: freshnessVerdict == pre-commit 60s gate (hooks/pre-commit)", () => {
  const NOW = 1_700_000_000;
  const TREE = "1111111111111111111111111111111111111111";
  const proof = (ts: number, tree: string): string => `{"ts":${ts},"tree":"${tree}"}`;

  const CASES: Array<{ name: string; stagedFiles: string[]; proofBody?: string; allowed: boolean }> = [
    { name: "docs-only (root md) → allowed", stagedFiles: ["NOTES.md"], proofBody: undefined, allowed: true },
    { name: "code + fresh matching proof → allowed", stagedFiles: ["lib/x.sh"], proofBody: proof(NOW - 5, TREE), allowed: true },
    { name: "code + no proof → blocked", stagedFiles: ["lib/x.sh"], proofBody: undefined, allowed: false },
    { name: "code + malformed proof → blocked", stagedFiles: ["lib/x.sh"], proofBody: "{}", allowed: false },
    { name: "code + stale proof → blocked", stagedFiles: ["lib/x.sh"], proofBody: proof(NOW - 120, TREE), allowed: false },
    {
      name: "code + tree changed → blocked",
      stagedFiles: ["lib/x.sh"],
      proofBody: proof(NOW - 5, "0000000000000000000000000000000000000000"),
      allowed: false,
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const v = freshnessVerdict({ stagedFiles: c.stagedFiles, proofBody: c.proofBody, now: NOW, currentTree: TREE });
      expect(v.allowed).toBe(c.allowed);
    });
  }
});
