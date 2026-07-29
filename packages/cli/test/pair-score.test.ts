/**
 * US-PAIR-010 / FIX-343 — `roll pair score <story-id>`: the manual surface for
 * the score stage (US-PAIR-009). Reuses the runScorePairing adapter; the working
 * agent NEVER grades its own work, so a no-candidate / timeout outcome is
 * FAIL-LOUD (no peer = no Review Score, exit non-zero), not a self-grade fallback.
 * Injected reviewer spawn — tests never launch a real agent.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pairScore, resolveSummary, type PairScoreCmdDeps } from "../src/commands/pair.js";
import { readStoryReviewScores, writeReviewScoreNote } from "../src/lib/review-score.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Static score config declares supported candidates. Runtime auth/VPN/account
// health is filtered by availability/readiness, not by permanent config exclusion.
const SCORE_CFG = `enabled: true\nstages: [code, score]\ncapability:\n  kimi: [code, score]\n  pi: [code, score]\n`;

function project(yaml: string | null): string {
  const p = mkdtempSync(join(tmpdir(), "roll-pairscore-"));
  dirs.push(p);
  mkdirSync(join(p, ".roll"), { recursive: true });
  if (yaml !== null) writeFileSync(join(p, ".roll", "pairing.yaml"), yaml);
  return p;
}

async function run(p: string, args: string[], deps?: Partial<PairScoreCmdDeps>): Promise<{ code: number; out: string; err: string }> {
  const old = process.cwd();
  process.chdir(p);
  let out = "";
  let err = "";
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await pairScore(args, {
      installed: ["claude", "kimi"],
      isAvailable: () => true,
      workingAgent: () => "claude",
      spawnReviewer: async () => ({ status: "ok" as const, stdout: "SCORE: 8\nVERDICT: good\nRATIONALE: tidy delivery\n" }),
      ...deps,
    });
    return { code, out, err };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    process.chdir(old);
  }
}

describe("roll pair score — US-PAIR-010", () => {
  it("scores via a fresh-session peer and prints reviewer, score, note path", async () => {
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-T-001", "--summary", "delivered the thing"]);
    expect(r.code).toBe(0);
    // FIX-343: any installed agent is a valid fresh-session scorer (claude OR
    // kimi) — the round-robin head varies by cycle id, so assert membership.
    expect(r.out).toMatch(/claude|kimi/);
    expect(r.out).toContain("8");
    expect(r.out).toContain(join(".roll", "notes"));
    const notes = readStoryReviewScores(p, "US-T-001");
    expect(notes).toHaveLength(1);
    const text = readFileSync(notes[0]?.sourcePath ?? "", "utf8");
    expect(text).toContain("scoring: pair");
    expect(text).toMatch(/scored-by: (claude|kimi)/);
  });

  it("FIX-343: MANDATORY — no pairing.yaml still scores via a fresh-session peer, exit 0", async () => {
    // The score stage is no longer gated on pairing.yaml: with installed agents
    // present, a fresh-session peer scores even without a config.
    const p = project(null);
    const r = await run(p, ["US-T-001", "--summary", "s"]);
    expect(r.code).toBe(0);
    const notes = readStoryReviewScores(p, "US-T-001");
    expect(notes).toHaveLength(1);
    expect(readFileSync(notes[0]?.sourcePath ?? "", "utf8")).toContain("scoring: pair");
  });

  it("FIX-343: single-agent env scores via a fresh SAME-TYPE session, exit 0", async () => {
    // Builder is kimi: a same-type fresh-session score uses the lone supported
    // agent when it is available.
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-T-001", "--summary", "s"], { installed: ["kimi"], workingAgent: () => "kimi" });
    expect(r.code).toBe(0);
    const notes = readStoryReviewScores(p, "US-T-001");
    expect(notes).toHaveLength(1);
    expect(readFileSync(notes[0]?.sourcePath ?? "", "utf8")).toContain("scored-by: kimi");
  });

  it("FIX-343: reviewer timeout / protocol miss → FAIL LOUD (no Review Score, exit non-zero, no self-grade escape)", async () => {
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-T-001", "--summary", "s"], {
      spawnReviewer: async () => ({ status: "ok" as const, stdout: "no protocol lines here" }),
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("No Review Score produced");
    // No note is synthesized when the peer can't score.
    expect(readStoryReviewScores(p, "US-T-001")).toHaveLength(0);
    const rawFiles = readdirSync(join(p, ".roll", "peer")).filter((name) => name.endsWith(".raw.txt"));
    expect(rawFiles.length).toBeGreaterThan(0);
    expect(readFileSync(join(p, ".roll", "peer", rawFiles[0] ?? ""), "utf8")).toContain("no protocol lines here");
  });

  it("usage failures: missing story id / unknown flag exit non-zero", async () => {
    const p = project(SCORE_CFG);
    expect((await run(p, [])).code).not.toBe(0);
    expect((await run(p, ["US-T-001", "--bogus", "x"])).code).not.toBe(0);
  });

  it("--file reads the summary from disk; missing summary sources fail loud", async () => {
    const p = project(SCORE_CFG);
    writeFileSync(join(p, "sum.txt"), "summary from file");
    expect((await run(p, ["US-T-001", "--file", "sum.txt"])).code).toBe(0);
    const r = await run(p, ["US-T-002"]); // no summary, no backlog row to derive from
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("summary");
  });
});

describe("codex pair-review fixes — US-PAIR-010", () => {
  it("--skill overrides the prefix heuristic (design sessions)", async () => {
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-T-001", "--summary", "design session", "--skill", "roll-design"]);
    expect(r.code).toBe(0);
    const text = readFileSync(readStoryReviewScores(p, "US-T-001")[0]?.sourcePath ?? "", "utf8");
    expect(text).toContain("skill: roll-design");
  });

  it("FIX-343: --worker no longer restricts scoring to a heterogeneous peer (same-vendor fresh is valid)", async () => {
    const p = project(SCORE_CFG);
    // worker kimi: the score stage allows ANY installed agent as a fresh-session
    // scorer (claude OR a fresh kimi) — independence is the fresh session, not
    // vendor heterogeneity. A pair score is produced regardless.
    const r = await run(p, ["US-T-001", "--summary", "s", "--worker", "kimi"]);
    expect(r.code).toBe(0);
    const text = readFileSync(readStoryReviewScores(p, "US-T-001")[0]?.sourcePath ?? "", "utf8");
    expect(text).toContain("scoring: pair");
    expect(text).toMatch(/scored-by: (claude|kimi)/);
  });

  it("backlog row fallback never matches a longer id (US-X-1 vs US-X-10)", async () => {
    const p = project(SCORE_CFG);
    writeFileSync(join(p, ".roll", "backlog.md"), "| US-T-0010 | the other story | Todo |\n| US-T-001 | the right story | Todo |\n");
    const r = await run(p, ["US-T-001"]);
    expect(r.code).toBe(0);
  });

  it("FIX-1475: resolveSummary picks the EXACT id-cell row, not a `<id>-` descendant sorted first", () => {
    const p = project(SCORE_CFG);
    writeFileSync(
      join(p, ".roll", "backlog.md"),
      [
        "| Story | Description | Status |",
        "|--|--|--|",
        "| [FIX-300-legacy](.roll/features/ep/FIX-300-legacy/spec.md) | the WRONG descendant row | 📋 Todo |",
        "| [FIX-300](.roll/features/ep/FIX-300/spec.md) | the RIGHT row | 🔨 In Progress |",
        "",
      ].join("\n"),
    );
    const old = process.cwd();
    process.chdir(p);
    try {
      const summary = resolveSummary("FIX-300");
      expect(summary).toContain("the RIGHT row");
      expect(summary).not.toContain("WRONG descendant");
    } finally {
      process.chdir(old);
    }
  });

  it("a retry that adds an audit field (fallback-reason) writes a new audited note, not a dedup", () => {
    const p = project(null);
    // The writer's idempotency must NOT swallow a retry that now carries an audit
    // field the prior note lacked (reusing would lose the audit). Exercise the
    // writer directly (the agent-facing self-grade command is removed in FIX-343).
    writeReviewScoreNote(p, { skill: "roll-build", story: "US-T-009", score: 7, verdict: "ok", rationale: "same rationale", scoring: "pair", scoredBy: "kimi" });
    writeReviewScoreNote(p, { skill: "roll-build", story: "US-T-009", score: 7, verdict: "ok", rationale: "same rationale", scoring: "pair", scoredBy: "kimi", fallbackReason: "pair timed out" });
    const notes = readStoryReviewScores(p, "US-T-009");
    expect(notes).toHaveLength(2);
    const latest = readFileSync(notes[1]?.sourcePath ?? "", "utf8");
    expect(latest).toContain("fallback-reason: pair timed out");
  });
});

describe("roll pair score --design — FIX-344 (design output peer Review Score)", () => {
  it("AC1: --design scores the design output via a fresh-session peer, writes a roll-design pair note", async () => {
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-DSGN-001", "--summary", "INVEST split + specs", "--design"]);
    expect(r.code).toBe(0);
    const notes = readStoryReviewScores(p, "US-DSGN-001");
    expect(notes).toHaveLength(1);
    const text = readFileSync(notes[0]?.sourcePath ?? "", "utf8");
    // AC1: pair provenance, fresh session id, default skill roll-design.
    expect(text).toContain("scoring: pair");
    expect(text).toContain("skill: roll-design");
    expect(text).toMatch(/scored-by: (claude|kimi)/);
    expect(text).toMatch(/session-id: .+:design:/); // the design stage label on the session id
  });

  it("AC1: --design grades DESIGN quality (the design prompt is sent to the reviewer, not the code prompt)", async () => {
    const p = project(SCORE_CFG);
    let seenPrompt = "";
    await run(p, ["US-DSGN-001", "--summary", "design output", "--design"], {
      spawnReviewer: async (input) => {
        seenPrompt = input.prompt;
        return { status: "ok" as const, stdout: "SCORE: 8\nVERDICT: good\nRATIONALE: solid INVEST split\n" };
      },
    });
    expect(seenPrompt).toContain("DESIGN");
    expect(seenPrompt).toMatch(/INVEST/);
    expect(seenPrompt).not.toContain("PAIRING scorer"); // NOT the code-delivery prompt
  });

  it("AC2: --design with no scorer available → fail-loud (no note, exit non-zero)", async () => {
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-DSGN-002", "--summary", "s", "--design"], { installed: [] });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("No Review Score produced");
    expect(readStoryReviewScores(p, "US-DSGN-002")).toHaveLength(0);
  });

  it("AC2: --design reviewer protocol miss → fail-loud honest unscored, no synthesized score", async () => {
    const p = project(SCORE_CFG);
    const r = await run(p, ["US-DSGN-003", "--summary", "s", "--design"], {
      spawnReviewer: async () => ({ status: "ok" as const, stdout: "I think it looks fine" }),
    });
    expect(r.code).not.toBe(0);
    expect(readStoryReviewScores(p, "US-DSGN-003")).toHaveLength(0);
  });

  it("AC3: the design agent (worker) NEVER scores its own output — the reviewer is a separate fresh session", async () => {
    const p = project(SCORE_CFG);
    // worker = the design agent (kimi); the score still comes from a fresh session whose id
    // is the reviewer's, never an in-session self-grade.
    const r = await run(p, ["US-DSGN-004", "--summary", "s", "--design", "--worker", "kimi"], { installed: ["kimi"], workingAgent: () => "kimi" });
    expect(r.code).toBe(0);
    const text = readFileSync(readStoryReviewScores(p, "US-DSGN-004")[0]?.sourcePath ?? "", "utf8");
    expect(text).toContain("scoring: pair"); // never scoring: self
    // independence is the fresh session, not vendor: a same-vendor fresh kimi is valid.
    expect(text).toMatch(/session-id: manual-design-US-DSGN-004-\d+:design:kimi:/);
  });
});
