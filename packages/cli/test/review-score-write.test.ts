/**
 * FIX-343 — the Review Score writer (renamed from the old self-grade writer; AC1: peer-only).
 *
 * The cycle's quality score is the Review Score, produced SOLELY by a fresh-
 * session peer Reviewer (runScorePairing) — the working agent NEVER grades its
 * own work. There is no agent-facing self-grade command and no `scoring`
 * default: `scoring` is REQUIRED, and the sole live caller passes
 * `scoring: 'pair'`. A legacy `scoring: self` value is tolerated on READ
 * (historical notes) but never gates.
 *
 * This suite freezes (a) the writer's observable contract, (b) that an explicit
 * `scoring` is required, and (c) the gate's STRICT cycle-scoped freshness.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeReviewScoreNote } from "../src/lib/review-score.js";
import { evaluateReviewScoreGate, readLatestStoryReviewScore, readStoryReviewScores } from "../src/lib/review-score.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const p = mkdtempSync(join(tmpdir(), "roll-reviewscore-"));
  dirs.push(p);
  mkdirSync(join(p, ".roll"), { recursive: true });
  return p;
}

function workspace(): string {
  const p = mkdtempSync(join(tmpdir(), "roll-reviewscore-workspace-"));
  dirs.push(p);
  writeFileSync(join(p, "workspace.yaml"), "schema: roll.workspace/v1\n");
  mkdirSync(join(p, "issues", "FIX-900"), { recursive: true });
  return p;
}

function withCard(p: string, epic: string, id: string): void {
  mkdirSync(join(p, ".roll", "features", epic, id), { recursive: true });
  writeFileSync(join(p, ".roll", "features", epic, id, "spec.md"), `# ${id}\n`);
  writeFileSync(join(p, ".roll", "index.json"), JSON.stringify({ [id]: epic }));
}

const PAYLOAD = {
  skill: "roll-fix",
  story: "FIX-900",
  score: 9,
  verdict: "good" as const,
  rationale: "clean root-cause fix with regression test",
  ts: "2026-06-13T03:00:00Z",
  scoring: "pair" as const,
  scoredBy: "pi",
};

describe("writeReviewScoreNote", () => {
  it("writes and reads a canonical Workspace Issue score without a legacy .roll directory", () => {
    const p = workspace();
    const res = writeReviewScoreNote(p, {
      ...PAYLOAD,
      sessionId: "cycle-workspace:score:pi:a1",
    });

    expect(res.path).toContain(join("issues", "FIX-900", "notes"));
    expect(existsSync(join(p, ".roll"))).toBe(false);
    expect(readLatestStoryReviewScore(p, "FIX-900")).toMatchObject({
      score: 9,
      scoredBy: "pi",
      sessionId: "cycle-workspace:score:pi:a1",
    });
  });

  it("writes a card-local note that existing readers parse back", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    const res = writeReviewScoreNote(p, PAYLOAD);
    expect(res.written).toBe(true);
    expect(res.path).toContain(join(".roll", "features", "goal-mode", "FIX-900", "notes"));
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain("skill: roll-fix");
    expect(text).toContain("story: FIX-900");
    expect(text).toContain("score: 9");
    expect(text).toContain("verdict: good");
    expect(text).toContain("ts: 2026-06-13T03:00:00Z");
    expect(text).toContain("scoring: pair");
    expect(text).toContain(PAYLOAD.rationale);
    const entry = readLatestStoryReviewScore(p, "FIX-900");
    expect(entry).toBeDefined();
    expect(entry?.score).toBe(9);
    expect(entry?.verdict).toBe("good");
    expect(entry?.skill).toBe("roll-fix");
    expect(entry?.note).toContain("clean root-cause fix");
  });

  it("falls back to .roll/notes/ when no card folder exists", () => {
    const p = project();
    const res = writeReviewScoreNote(p, { ...PAYLOAD, story: "US-NOCARD-001" });
    expect(res.path).toContain(join(".roll", "notes"));
    expect(existsSync(res.path)).toBe(true);
    expect(readStoryReviewScores(p, "US-NOCARD-001")).toHaveLength(1);
  });

  it("is idempotent: same payload re-run keeps a single note", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    const first = writeReviewScoreNote(p, PAYLOAD);
    const second = writeReviewScoreNote(p, PAYLOAD);
    expect(second.written).toBe(false);
    expect(second.path).toBe(first.path);
    const notesDir = join(p, ".roll", "features", "goal-mode", "FIX-900", "notes");
    expect(readdirSync(notesDir)).toHaveLength(1);
  });

  it("is idempotent across retries without an explicit ts (Reviewer retry path)", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    const { ts: _ts, ...noTs } = PAYLOAD;
    const first = writeReviewScoreNote(p, noTs);
    const second = writeReviewScoreNote(p, noTs);
    expect(second.written).toBe(false);
    expect(second.path).toBe(first.path);
    const notesDir = join(p, ".roll", "features", "goal-mode", "FIX-900", "notes");
    expect(readdirSync(notesDir)).toHaveLength(1);
    // a genuinely different Review Score (new rationale) is NOT swallowed
    const third = writeReviewScoreNote(p, { ...noTs, score: 8, rationale: "second cycle after review fixes" });
    expect(third.written).toBe(true);
  });

  it("rejects a contradictory rewrite of the same skill/story/ts", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    writeReviewScoreNote(p, PAYLOAD);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, score: 3, verdict: "ok" })).toThrow(/contradict/i);
  });

  it("fails loud on invalid inputs", () => {
    const p = project();
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, score: 0 })).toThrow(/score/i);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, score: 11 })).toThrow(/score/i);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, score: 7.5 })).toThrow(/score/i);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, verdict: "great" as never })).toThrow(/verdict/i);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, rationale: "  " })).toThrow(/rationale/i);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, skill: "" })).toThrow(/skill/i);
    expect(() => writeReviewScoreNote(p, { ...PAYLOAD, story: "" })).toThrow(/story/i);
  });

  it("US-PAIR-009: provenance fields land in frontmatter and readers stay compatible", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    const res = writeReviewScoreNote(p, { ...PAYLOAD, scoredBy: "codex", scoring: "pair" });
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain("scored-by: codex");
    expect(text).toContain("scoring: pair");
    const entry = readLatestStoryReviewScore(p, "FIX-900");
    expect(entry?.score).toBe(9); // reader unaffected by extra fields
    expect(entry?.scoring).toBe("pair");
    expect(entry?.scoredBy).toBe("codex");
  });

  it("FIX-343: requires an explicit scoring (no silent self default) and records session-id", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    const res = writeReviewScoreNote(p, { ...PAYLOAD, scoring: "pair", scoredBy: "pi", sessionId: "c1:score:pi:a1:42" });
    const text = readFileSync(res.path, "utf8");
    // the live path is always a peer score; never a silent `scoring: self`.
    expect(text).toContain("scoring: pair");
    expect(text).not.toContain("scoring: self");
    expect(text).toContain("session-id: c1:score:pi:a1:42");
    expect(readLatestStoryReviewScore(p, "FIX-900")?.sessionId).toBe("c1:score:pi:a1:42");
  });

  it("tolerates a legacy scoring: self value on READ (display) but never via the writer's live path", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    // A legacy on-disk note (written before FIX-343) still parses for display.
    const notesDir = join(p, ".roll", "features", "goal-mode", "FIX-900", "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      join(notesDir, "2026-06-01-roll-fix-FIX-900-1.md"),
      "---\nskill: roll-fix\nstory: FIX-900\nscore: 8\nverdict: good\nts: 2026-06-01T00:00:00Z\nscoring: self\n---\n\nlegacy self note\n",
    );
    const entry = readLatestStoryReviewScore(p, "FIX-900");
    expect(entry?.scoring).toBe("self"); // tolerated on read
  });

  it("refuses to write outside a roll project (no stray .roll/ minting)", () => {
    const p = mkdtempSync(join(tmpdir(), "roll-noproject-"));
    dirs.push(p);
    expect(() => writeReviewScoreNote(p, PAYLOAD)).toThrow(/not a roll project/i);
    expect(existsSync(join(p, ".roll"))).toBe(false);
  });

  it("two writers for different stories never collide", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-900");
    const a = writeReviewScoreNote(p, PAYLOAD);
    const b = writeReviewScoreNote(p, { ...PAYLOAD, story: "FIX-901" });
    expect(a.path).not.toBe(b.path);
    expect(readStoryReviewScores(p, "FIX-900")).toHaveLength(1);
    expect(readStoryReviewScores(p, "FIX-901")).toHaveLength(1);
  });
});

describe("FIX-343 (①): evaluateReviewScoreGate — STRICT cycle-scoped freshness", () => {
  /** Write a `scoring: pair` note with an explicit session-id for the story. */
  function withPairNote(p: string, story: string, sessionId: string, scoredBy = "pi"): void {
    withCard(p, "goal-mode", story);
    writeReviewScoreNote(p, { skill: "roll-build", story, score: 8, verdict: "good", rationale: "peer reviewed clean", scoring: "pair", scoredBy, sessionId });
  }

  it("a PRIOR-cycle peer note does NOT satisfy THIS cycle's gate (RESUME staleness rejected)", () => {
    const p = project();
    withPairNote(p, "FIX-RESUME", "c-old:score:pi:a1:1700000000");
    // THIS cycle = c-new; the only note on disk is c-old's → not honored.
    const gate = evaluateReviewScoreGate(p, "FIX-RESUME", "", "c-new");
    expect(gate.status).toBe("missing");
    expect(gate.reason).toMatch(/missing peer review score/i);
  });

  it("THIS cycle's own peer note (`${cycleId}:score:...`) PASSES (no over-rejection deadlock)", () => {
    const p = project();
    withPairNote(p, "FIX-FRESH", "c-cur:score:pi:a1:1700000099");
    const gate = evaluateReviewScoreGate(p, "FIX-FRESH", "", "c-cur");
    expect(gate.status).toBe("pass");
    expect(gate.entry?.sessionId).toBe("c-cur:score:pi:a1:1700000099");
  });

  it("EMPTY cycleId does NOT vacuously accept a stale note via startsWith(\"\") — other checks still apply", () => {
    const p = project();
    // With NO cycle id the scope can't be enforced, but the pair+session checks
    // still run: a valid pair note still passes (we don't reject everything), and
    // a builder-session note is still rejected (we don't accept everything).
    withPairNote(p, "FIX-NOCYCLE", "c-any:score:pi:a1:1700000000");
    expect(evaluateReviewScoreGate(p, "FIX-NOCYCLE", "", "").status).toBe("pass");
    const p2 = project();
    withPairNote(p2, "FIX-NOCYCLE2", "builder-sess-123", "claude");
    // builderSessionId === the note's session → rejected even with empty cycle id.
    expect(evaluateReviewScoreGate(p2, "FIX-NOCYCLE2", "builder-sess-123", "").status).toBe("missing");
  });

  it("a legacy scoring: self note NEVER satisfies the gate (peer-only)", () => {
    const p = project();
    withCard(p, "goal-mode", "FIX-LEGACY");
    const notesDir = join(p, ".roll", "features", "goal-mode", "FIX-LEGACY", "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      join(notesDir, "2026-06-01-roll-fix-FIX-LEGACY-1.md"),
      "---\nskill: roll-fix\nstory: FIX-LEGACY\nscore: 9\nverdict: good\nts: 2026-06-01T00:00:00Z\nscoring: self\n---\n\nlegacy self note\n",
    );
    expect(evaluateReviewScoreGate(p, "FIX-LEGACY", "", "c-cur").status).toBe("missing");
  });
});
