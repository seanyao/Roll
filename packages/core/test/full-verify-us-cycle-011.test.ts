/**
 * US-CYCLE-011 — the round-tail / pre-PR full-verify primitives:
 *   - `parseTestPassProof` additively extracts the `mode` scope tag (full/changed
 *     /legacy/absent) WITHOUT weakening the ts/tree contract.
 *   - `evaluateFullVerify` / `fullVerifyProofValid` are FAIL-CLOSED at every
 *     branch: the ONLY pass is a parsed `mode:"full"` proof whose tree equals the
 *     delivered tree and is within the freshness limit.
 *   - `gateTimeByMode` buckets gate time --changed vs full and always reconciles
 *     to the total (AC3 "accounts reconcile").
 */
import { describe, expect, it } from "vitest";
import {
  evaluateFullVerify,
  fullVerifyProofValid,
  gateTimeByMode,
  parseTestPassProof,
  FULL_VERIFY_LIMIT_SECONDS,
  type RoundJournalEntry,
} from "../src/index.js";

const TREE = "a".repeat(40);
const OTHER = "b".repeat(40);
/** A well-formed proof body with a given mode + tree, written `age` seconds before `now`. */
function proof(opts: { mode?: string; tree?: string; ts?: number }): string {
  const fields: string[] = [`"ts":${opts.ts ?? 1000}`, `"tree":"${opts.tree ?? TREE}"`];
  if (opts.mode !== undefined) fields.push(`"mode":"${opts.mode}"`);
  return `{${fields.join(",")}}\n`;
}

describe("parseTestPassProof — mode is additive (US-CYCLE-011)", () => {
  it("extracts mode:full without disturbing ts/tree", () => {
    expect(parseTestPassProof('{"ts":10,"tree":"abc","mode":"full"}')).toEqual({ ts: 10, tree: "abc", mode: "full" });
  });
  it("extracts mode:changed", () => {
    expect(parseTestPassProof('{"ts":10,"tree":"abc","mode":"changed"}')?.mode).toBe("changed");
  });
  it("preserves a legacy/other mode value verbatim (not narrowed away)", () => {
    expect(parseTestPassProof('{"ts":10,"tree":"abc","mode":"vitest","scope":"full"}')?.mode).toBe("vitest");
  });
  it("absent mode → no mode key (legacy proof still parses on ts/tree)", () => {
    const p = parseTestPassProof('{"ts":10,"tree":"abc"}');
    expect(p).toEqual({ ts: 10, tree: "abc" });
    expect(p && "mode" in p).toBe(false);
  });
  it("empty-string mode → dropped (treated as absent)", () => {
    expect(parseTestPassProof('{"ts":10,"tree":"abc","mode":""}')?.mode).toBeUndefined();
  });
  it("still fails closed when ts/tree missing even if mode present", () => {
    expect(parseTestPassProof('{"tree":"abc","mode":"full"}')).toBeUndefined();
    expect(parseTestPassProof('{"ts":10,"mode":"full"}')).toBeUndefined();
  });
});

describe("evaluateFullVerify — fail-closed at every branch", () => {
  const NOW = 1000; // proof ts default is 1000 → elapsed 0

  it("valid: mode=full + tree match + fresh → ok", () => {
    expect(evaluateFullVerify(proof({ mode: "full" }), TREE, NOW)).toEqual({ ok: true });
    expect(fullVerifyProofValid(proof({ mode: "full" }), TREE, NOW)).toBe(true);
  });

  it("blocks when the proof is ABSENT (no round-tail full run)", () => {
    const v = evaluateFullVerify(undefined, TREE, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no full-suite test proof/i);
    expect(fullVerifyProofValid(undefined, TREE, NOW)).toBe(false);
  });

  it("blocks a MALFORMED proof (no ts/tree)", () => {
    expect(fullVerifyProofValid("garbage", TREE, NOW)).toBe(false);
    expect(fullVerifyProofValid('{"tree":"abc","mode":"full"}', TREE, NOW)).toBe(false);
  });

  it("blocks a CHANGED-mode proof (per-commit gate is not a full verify)", () => {
    const v = evaluateFullVerify(proof({ mode: "changed" }), TREE, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/not "full"/);
  });

  it("blocks a proof with NO mode (legacy / absent ⇒ not full)", () => {
    expect(fullVerifyProofValid(proof({}), TREE, NOW)).toBe(false);
  });

  it("blocks a legacy mode:vitest proof (only canonical full passes)", () => {
    expect(fullVerifyProofValid(proof({ mode: "vitest" }), TREE, NOW)).toBe(false);
  });

  it("blocks when the delivered tree is UNCOMPUTABLE (headTree empty)", () => {
    const v = evaluateFullVerify(proof({ mode: "full" }), "", NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/could not be computed/i);
  });

  it("blocks a TREE MISMATCH (code changed since the full run)", () => {
    const v = evaluateFullVerify(proof({ mode: "full", tree: OTHER }), TREE, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/tree does not match/i);
  });

  it("blocks a STALE full proof (beyond the freshness limit)", () => {
    const ts = 1000;
    const now = ts + FULL_VERIFY_LIMIT_SECONDS + 1;
    const v = evaluateFullVerify(proof({ mode: "full", ts }), TREE, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/stale/i);
  });

  it("accepts a full proof exactly AT the freshness limit (boundary)", () => {
    const ts = 1000;
    const now = ts + FULL_VERIFY_LIMIT_SECONDS;
    expect(fullVerifyProofValid(proof({ mode: "full", ts }), TREE, now)).toBe(true);
  });

  it("blocks a FUTURE-timestamp proof (clock skew / replay — negative elapsed)", () => {
    const now = 1000;
    const v = evaluateFullVerify(proof({ mode: "full", ts: now + 10_000 }), TREE, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/future/i);
    expect(fullVerifyProofValid(proof({ mode: "full", ts: now + 1 }), TREE, now)).toBe(false);
  });

  it("blocks a MULTI-RECORD proof body (mode-spoof across records)", () => {
    // First line says mode:full; the ts/tree come from a SECOND record. The
    // independent parseTestPassProof regexes would otherwise read full+ts+tree.
    const spoof = `{"mode":"full"}\n{"ts":1000,"tree":"${TREE}","mode":"changed"}`;
    const v = evaluateFullVerify(spoof, TREE, 1000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/single well-formed record/i);
  });

  it("blocks a body with a duplicated mode/ts field on one logical record", () => {
    const dupMode = `{"ts":1000,"tree":"${TREE}","mode":"changed","mode":"full"}`;
    expect(fullVerifyProofValid(dupMode, TREE, 1000)).toBe(false);
    const twoLines = `{"ts":1000,"tree":"${TREE}","mode":"full"}\n{"ts":1000,"tree":"${TREE}","mode":"full"}`;
    expect(fullVerifyProofValid(twoLines, TREE, 1000)).toBe(false);
  });

  it("blocks a body with a duplicated tree field (parse takes the first tree)", () => {
    // parseTestPassProof reads the FIRST "tree" (the delivered HEAD), while a
    // second, different tree hides in the same line — an ambiguous record the
    // single-record guard must reject even though ts/mode appear only once.
    const dupTree = `{"ts":1000,"tree":"${TREE}","tree":"deadbeef","mode":"full"}`;
    expect(fullVerifyProofValid(dupTree, TREE, 1000)).toBe(false);
    const v = evaluateFullVerify(dupTree, TREE, 1000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/single well-formed record/i);
  });

  it("a single clean full record with a trailing newline still passes", () => {
    expect(fullVerifyProofValid(`{"ts":1000,"tree":"${TREE}","mode":"full"}\n`, TREE, 1000)).toBe(true);
  });

  it("honours a custom (tighter) freshness limit", () => {
    const ts = 1000;
    expect(fullVerifyProofValid(proof({ mode: "full", ts }), TREE, ts + 11, 10)).toBe(false);
    expect(fullVerifyProofValid(proof({ mode: "full", ts }), TREE, ts + 10, 10)).toBe(true);
  });
});

describe("gateTimeByMode — buckets reconcile to the total (AC3)", () => {
  const row = (gateTimeMs: number | undefined, gateMode?: "changed" | "full"): RoundJournalEntry => ({
    schemaVersion: 1,
    card: "US-CYCLE-011",
    role: "builder",
    start: 0,
    durMs: 1,
    outcome: "delivered",
    ...(gateTimeMs !== undefined ? { gateTimeMs } : {}),
    ...(gateMode !== undefined ? { gateMode } : {}),
  });

  it("splits changed vs full and reconciles", () => {
    const b = gateTimeByMode([row(300, "changed"), row(200, "changed"), row(5000, "full")]);
    expect(b).toEqual({ changedMs: 500, fullMs: 5000, untaggedMs: 0, totalMs: 5500 });
    expect(b.changedMs + b.fullMs + b.untaggedMs).toBe(b.totalMs);
  });

  it("gate time with no mode falls into untagged, still reconciling", () => {
    const b = gateTimeByMode([row(100, "changed"), row(400), row(1000, "full")]);
    expect(b).toEqual({ changedMs: 100, fullMs: 1000, untaggedMs: 400, totalMs: 1500 });
  });

  it("rows without gate time contribute nothing", () => {
    const b = gateTimeByMode([row(undefined, "full"), row(250, "changed")]);
    expect(b).toEqual({ changedMs: 250, fullMs: 0, untaggedMs: 0, totalMs: 250 });
  });

  it("a NEGATIVE gateTimeMs is dropped (corrupt; never counted)", () => {
    const b = gateTimeByMode([row(-100, "full"), row(200, "changed"), row(-5)]);
    expect(b).toEqual({ changedMs: 200, fullMs: 0, untaggedMs: 0, totalMs: 200 });
  });
});
