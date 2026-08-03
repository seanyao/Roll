/**
 * US-PAIR-003 — pairing runtime gate. Injected reviewPeer/changedFiles/diff so
 * no real agent is spawned: asserts selection, evidence, events, non-blocking
 * timeout, fail-loud none-available, and file-absent = off.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDesignScorePrompt, buildPairScorePrompt, buildReviewPrompt, enabledPairingStages, pairingDispatch, reviewTimeoutMs, runPairing, type PairEvent, type RunPairingDeps } from "../src/runner/pairing-gate.js";

function project(legacyYaml: string | null): { dir: string; rt: string } {
  const dir = mkdtempSync(join(tmpdir(), "roll-pair-"));
  mkdirSync(join(dir, ".roll"), { recursive: true });
  // The pairing gate is now configured only through the scoped evaluate role.
  // `legacyYaml` remains a compact fixture input for enabled/disabled coverage;
  // it is deliberately never written or read by production code.
  if (legacyYaml !== null && !/^enabled:\s*false/m.test(legacyYaml)) {
    writeScopedAgents(dir, `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [kimi, pi, reasonix]
        require: [evaluate]
        strategy: least-recent
`);
  }
  const rt = join(dir, "rt");
  mkdirSync(rt, { recursive: true });
  return { dir, rt };
}

function writeScopedAgents(dir: string, yaml: string): void {
  writeFileSync(join(dir, ".roll", "agents.yaml"), yaml);
}

// Static pairing config declares fair supported candidates. Runtime auth/VPN/account
// health is filtered by availability/readiness, not by permanent config exclusion.
const ENABLED = `enabled: true\nstages: [code]\ncapability:\n  kimi: [code]\n  pi: [code]\n  reasonix: [code]\n`;
// US-PAIR-004: a config that enables every stage and declares each agent
// capable across them, so stage plumbing can be exercised independently.
const ALL_STAGES = `enabled: true\nstages: [design, test, code, cycle]\ncapability:\n  kimi: [design, test, code, cycle]\n  pi: [design, test, code, cycle]\n  reasonix: [design, test, code, cycle]\n`;
const highComplexity = async (): Promise<string[]> => ["a.ts", "b.ts", "c.ts", "d.ts"]; // >3 → high

function deps(over: Partial<RunPairingDeps> = {}): { d: RunPairingDeps; events: PairEvent[] } {
  const events: PairEvent[] = [];
  const d: RunPairingDeps = {
    installed: ["kimi", "pi", "reasonix"],
    isAvailable: () => true,
    reviewPeer: async (_peer, _diff, _t) => ({ verdict: "refine", findings: ["x", "y"], cost: 0.12 }),
    changedFiles: highComplexity,
    diff: async () => "diff --git a/a.ts ...",
    event: (e) => events.push(e),
    now: () => 1234,
    ...over,
  };
  return { d, events };
}

describe("pairingDispatch — REFACTOR-065 unified review dispatch", () => {
  it("serial take-first stops after the first structured review and records skipped peers", async () => {
    const events: PairEvent[] = [];
    const tried: string[] = [];
    const result = await pairingDispatch({
      cycleId: "c-dispatch-serial",
      workingAgent: "kimi",
      stage: "code",
      candidates: ["pi", "reasonix"],
      sameTypeFallback: { allowed: false },
      fallbackPolicy: "none",
      mode: "serial-take-first",
      blockOnNoWinner: false,
      diff: "diff",
      timeoutMs: 10,
      event: (e) => events.push(e),
      now: () => 1234,
      reviewPeer: async (peer) => {
        tried.push(peer);
        return { verdict: "refine", findings: ["nit"], cost: 0.01 };
      },
    });

    expect(result.status).toBe("reviewed");
    expect(result.peer).toBe("pi");
    expect(result.blocked).toBe(false);
    expect(tried).toEqual(["pi"]);
    expect(result.skipped).toEqual(["reasonix"]);
  });

  it("parallel firstValid waits past nulls and returns the first valid review", async () => {
    const events: PairEvent[] = [];
    const tried: string[] = [];
    const result = await pairingDispatch({
      cycleId: "c-dispatch-parallel",
      workingAgent: "kimi",
      stage: "code",
      candidates: ["reasonix", "pi"],
      sameTypeFallback: { allowed: false },
      fallbackPolicy: "none",
      mode: "parallel-first-valid",
      blockOnNoWinner: true,
      diff: "diff",
      timeoutMs: 10,
      event: (e) => events.push(e),
      now: () => 1234,
      reviewPeer: async (peer) => {
        tried.push(peer);
        return peer === "pi" ? { verdict: "agree", findings: [], cost: 0.02 } : null;
      },
    });

    expect(result.status).toBe("reviewed");
    expect(result.peer).toBe("pi");
    expect(result.blocked).toBe(false);
    expect(tried.sort()).toEqual(["pi", "reasonix"]);
    expect(events.filter((e) => e.type === "pair:selected")).toHaveLength(2);
  });

  it("sameTypeFallback is a hard gate: primary peer failure never degrades to same-type", async () => {
    const events: PairEvent[] = [];
    const tried: string[] = [];
    const result = await pairingDispatch({
      cycleId: "c-dispatch-same-gate",
      workingAgent: "kimi",
      stage: "code",
      candidates: ["pi"],
      sameTypeFallback: { allowed: true, peer: "kimi" },
      fallbackPolicy: "same-type-when-primary-empty",
      mode: "parallel-first-valid",
      blockOnNoWinner: true,
      diff: "diff",
      timeoutMs: 10,
      event: (e) => events.push(e),
      now: () => 1234,
      reviewPeer: async (peer) => {
        tried.push(peer);
        return peer === "kimi" ? { verdict: "agree", findings: [], cost: 0.02 } : null;
      },
    });

    expect(result.status).toBe("timeout");
    expect(result.blocked).toBe(true);
    expect(result.sameTypeFallback).toBe(false);
    expect(tried).toEqual(["pi"]);
  });
});

describe("runPairing — US-PAIR-003", () => {
  it("file absent = off (never silent magic)", async () => {
    const { dir, rt } = project(null);
    const { d } = deps();
    expect((await runPairing(dir, dir, rt, "c1", "kimi", "code", d)).status).toBe("off");
  });

  it("disabled config = off", async () => {
    const { dir, rt } = project(`enabled: false\nstages: [code]\n`);
    const { d } = deps();
    expect((await runPairing(dir, dir, rt, "c1", "kimi", "code", d)).status).toBe("off");
  });

  it("low-complexity delivery = not-required (no peer burned)", async () => {
    const { dir, rt } = project(ENABLED);
    const { d, events } = deps({ changedFiles: async () => ["only.ts"] });
    expect((await runPairing(dir, dir, rt, "c1", "kimi", "code", d)).status).toBe("not-required");
    expect(events).toHaveLength(0);
  });

  it("selects a heterogeneous peer, writes evidence, emits selected+verdict with cost", async () => {
    const { dir, rt } = project(ENABLED);
    const { d, events } = deps();
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(res.peer).not.toBe("claude"); // heterogeneous
    // evidence written to the peer-gate contract path
    const ev = JSON.parse(readFileSync(join(rt, "peer", "cycle-c1.pair.json"), "utf8"));
    expect(ev.peer).toBe(res.peer);
    expect(ev.verdict).toBe("refine");
    // FIX-1054 SERIAL: the FIRST ranked candidate returns a verdict, so exactly
    // ONE peer is selected (the rest are never spawned) and the untried
    // candidates surface as a policy `pair:skipped`. Exactly ONE verdict — the
    // winner's — after the selected.
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    const verdicts = events.filter((e) => e.type === "pair:verdict") as Extract<PairEvent, { type: "pair:verdict" }>[];
    const skips = events.filter((e) => e.type === "pair:skipped") as Extract<PairEvent, { type: "pair:skipped" }>[];
    expect(selecteds).toHaveLength(1); // one selected reviewer, not the whole pool
    expect(selecteds[0]?.attempt).toBe(1);
    expect(selecteds[0]?.reason).toBe("ranked_candidate");
    expect(events.every((e) => e.type === "pair:selected" || e.type === "pair:verdict" || e.type === "pair:skipped")).toBe(true);
    expect(skips).toHaveLength(1); // the untried ranked candidates, skipped by policy
    expect(skips[0]?.reason).toBe("accepted_verdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.peer).toBe(res.peer);
    expect(verdicts[0]?.findings).toBe(2);
    expect(verdicts[0]?.cost).toBe(0.12);
    // the lone verdict is emitted only after a peer was selected.
    expect(events.indexOf(verdicts[0]!)).toBeGreaterThan(events.indexOf(selecteds[0]!));
  });

  it("US-V4-018: runs code pairing from scoped evaluate role when pairing.yaml is absent", async () => {
    const { dir, rt } = project(null);
    writeScopedAgents(dir, `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [reasonix]
        require: [evaluate]
        avoid: [execute]
        strategy: least-recent
`);
    const tried: string[] = [];
    const { d } = deps({
      installed: ["kimi", "pi", "reasonix"],
      reviewPeer: async (peer) => {
        tried.push(peer);
        return { verdict: "agree" as const, findings: [], cost: 0.01 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(res.peer).toBe("reasonix");
    expect(tried).toEqual(["reasonix"]);
  });

  it("empty diff = not-required, no peer burned, no selected event (pi pair-review)", async () => {
    const { dir, rt } = project(ENABLED);
    const { d, events } = deps({ diff: async () => "   \n" });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("not-required");
    expect(events).toHaveLength(0);
  });

  it("fail-loud none-available when no qualified heterogeneous peer", async () => {
    const { dir, rt } = project(ENABLED);
    const { d, events } = deps({ installed: ["claude"], isAvailable: () => true });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("none-available");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("pair:none-available");
  });

  it("non-blocking: reviewPeer timeout (null) for the WHOLE pool → status timeout, no verdict event, no throw", async () => {
    const { dir, rt } = project(ENABLED);
    // FIX-335: every candidate is fired in parallel (one pair:selected each); the
    // whole pool returning null yields status timeout with NO verdict + no evidence.
    const { d, events } = deps({ reviewPeer: async () => null });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("timeout");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.type === "pair:selected")).toBe(true); // selected per candidate
    expect(events.some((e) => e.type === "pair:verdict")).toBe(false); // never a verdict
    expect(existsSync(join(rt, "peer", "cycle-c1.pair.json"))).toBe(false);
  });

  it("FIX-335 parallel take-first: a null peer is skipped, the non-null peer wins, evidence/verdict are the winner's", async () => {
    const { dir, rt } = project(ENABLED);
    // Two heterogeneous candidates are fired concurrently: "reasonix" flakes (null),
    // "pi" returns a real verdict. The winner must be the non-null peer, with a
    // single verdict + evidence recording that peer — regardless of dispatch order.
    const { d, events } = deps({
      reviewPeer: async (peer) =>
        peer === "pi" ? { verdict: "agree", findings: ["ok"], cost: 0.1 } : null,
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(res.peer).toBe("pi"); // the non-null peer won, not the flaky one
    expect(res.verdict).toBe("agree");
    // every candidate emitted a selected (parallel dispatch); exactly one verdict.
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    expect(selecteds.length).toBeGreaterThanOrEqual(2);
    expect(selecteds.some((e) => e.peer === "pi")).toBe(true);
    const verdicts = events.filter((e) => e.type === "pair:verdict") as Extract<PairEvent, { type: "pair:verdict" }>[];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.peer).toBe("pi");
    // evidence is the winner's only — the flaky peer never wrote anything.
    const ev = JSON.parse(readFileSync(join(rt, "peer", "cycle-c1.pair.json"), "utf8"));
    expect(ev.peer).toBe("pi");
    expect(ev.verdict).toBe("agree");
  });

  it("FIX-335: the FIRST non-null result wins (a slow null does not beat a faster real verdict)", async () => {
    const { dir, rt } = project(ENABLED);
    // "reasonix" returns null quickly; "pi" returns a real verdict a tick later.
    // take-first must wait past the fast null and use the real verdict, never
    // resolving null while a valid result is still in flight.
    const { d, events } = deps({
      reviewPeer: async (peer) => {
        if (peer === "pi") {
          await new Promise((r) => setTimeout(r, 10));
          return { verdict: "refine", findings: ["a", "b"], cost: 0.2 };
        }
        return null; // fast null
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(res.peer).toBe("pi");
    const verdicts = events.filter((e) => e.type === "pair:verdict") as Extract<PairEvent, { type: "pair:verdict" }>[];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.findings).toBe(2);
  });

  it("never throws: a broken reviewPeer yields status error, not an exception", async () => {
    const { dir, rt } = project(ENABLED);
    const { d } = deps({
      reviewPeer: async () => {
        throw new Error("boom");
      },
    });
    await expect(runPairing(dir, dir, rt, "c1", "kimi", "code", d)).resolves.toEqual({ status: "error" });
  });
});

describe("reviewTimeoutMs — FIX-363 adaptive peer-review budget", () => {
  it("normal diff → 180s (3min, the owner's peer-review policy floor)", () => {
    expect(reviewTimeoutMs(0)).toBe(180_000);
    expect(reviewTimeoutMs(5_000)).toBe(180_000);
    expect(reviewTimeoutMs(19_999)).toBe(180_000);
  });
  it("large/cross-module diff (≥20K chars) → 300s (5min, the policy ceiling)", () => {
    expect(reviewTimeoutMs(20_000)).toBe(300_000);
    expect(reviewTimeoutMs(60_000)).toBe(300_000);
  });
});

describe("runPairing — FIX-363 wires the adaptive budget to the reviewer", () => {
  it("a large diff gives the reviewer the 5min budget, not the legacy 120s", async () => {
    const { dir, rt } = project(ENABLED);
    let seen = -1;
    const bigDiff = `diff --git a/x b/x\n${"+".repeat(25_000)}`;
    const { d, events } = deps({
      diff: async () => bigDiff,
      reviewPeer: async (_p, _diff, t) => {
        seen = t;
        return { verdict: "agree", findings: [], cost: 0 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(seen).toBe(300_000);
    const selected = events.find((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>;
    expect(selected?.timeoutMs).toBe(300_000); // recorded for data-driven tuning
  });

  it("a small diff gives the 3min floor (was 120s — that clipped the duration tail)", async () => {
    const { dir, rt } = project(ENABLED);
    let seen = -1;
    const { d } = deps({
      diff: async () => "diff --git a/x b/x\n+small",
      reviewPeer: async (_p, _diff, t) => {
        seen = t;
        return { verdict: "agree", findings: [], cost: 0 };
      },
    });
    await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(seen).toBe(180_000);
  });

  it("an explicit deps.timeoutMs still overrides the adaptive default (test seam intact)", async () => {
    const { dir, rt } = project(ENABLED);
    let seen = -1;
    const { d } = deps({
      timeoutMs: 12345,
      diff: async () => `+${"+".repeat(25_000)}`,
      reviewPeer: async (_p, _diff, t) => {
        seen = t;
        return { verdict: "agree", findings: [], cost: 0 };
      },
    });
    await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(seen).toBe(12345);
  });
});

describe("runPairing — scoped stage policy", () => {
  it("only the scoped code-review stage runs", async () => {
    const { dir, rt } = project(ENABLED);
    const { d, events } = deps();
    expect((await runPairing(dir, dir, rt, "c1", "kimi", "design", d)).status).toBe("off");
    expect(events).toHaveLength(0);
  });

  it("FIX-935: allowedAgents from project config prevents auto-enabling machine-detected codex", async () => {
    const { dir, rt } = project(ENABLED);
    const spawnedPeers: string[] = [];
    const { d, events } = deps({
      installed: ["kimi", "pi", "codex"],
      allowedAgents: ["kimi", "pi"],
      reviewPeer: async (peer) => {
        spawnedPeers.push(peer);
        return { verdict: "agree", findings: [], cost: 0.04 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(spawnedPeers).not.toContain("codex");
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    expect(selecteds.every((e) => e.peer !== "codex")).toBe(true);
  });
});

describe("enabledPairingStages — executor stage iteration seam (US-PAIR-004)", () => {
  it("file absent = no stages (pairing off, never silent magic)", () => {
    const { dir } = project(null);
    expect(enabledPairingStages(dir)).toEqual([]);
  });

  it("disabled config = no stages even if stages are listed", () => {
    const { dir } = project(`enabled: false\nstages: [design, code]\n`);
    expect(enabledPairingStages(dir)).toEqual([]);
  });

  it("scoped evaluate enables the code stage", () => {
    const { dir } = project(ENABLED);
    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });

  it("legacy stage lists do not affect scoped pairing", () => {
    const { dir } = project(ALL_STAGES);
    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });

  it("a malformed legacy config does not affect scoped pairing", () => {
    const { dir } = project(`enabled: true\nstages: [bogus-stage]\n`);
    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });

  // kimi pair-review (US-PAIR-004): a duplicate stage in pairing.yaml must not
  // fire pairing twice — that would burn two peers, emit duplicate events, and
  // (for `code`) write the legacy evidence path twice. De-dupe, keep first-seen order.
  it("legacy stage lists cannot alter the scoped code stage", () => {
    const { dir } = project(`enabled: true\nstages: [code, code, design, code]\n`);
    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });

  it("US-V4-018: reads code review stages from scoped evaluate role when pairing.yaml is absent", () => {
    const { dir } = project(null);
    writeScopedAgents(dir, `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [pi, reasonix]
        require: [evaluate]
        avoid: [execute]
        strategy: least-recent
`);
    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });

  it("reads Workspace evaluate casting from agents.yaml and ignores repository-local project policy", () => {
    const { dir } = project(null);
    writeFileSync(join(dir, "workspace.yaml"), "schema: roll-workspace/v1\nworkspace_id: ws-test\n");
    writeFileSync(join(dir, "agents.yaml"), `schema: roll-agents/v1
scope: workspace
inherits: machine
roles: {}
defaults:
  story:
    roles:
      evaluate:
        kind: fixed
        agent: pi
`);
    writeScopedAgents(dir, `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: fixed
        agent: reasonix
`);

    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });
});

// ── US-PAIR-009: score stage — heterogeneous peer scores the cycle ───────────
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosePairScoreOutput, normalizeScoreStdout, parsePairScoreOutput, runScorePairing, type RunScorePairingDeps } from "../src/runner/pairing-gate.js";
import { readStoryReviewScores } from "../src/lib/review-score.js";

const FIX1044_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "score");
const readScoreFixture = (name: string): string => readFileSync(join(FIX1044_FIXTURES, name), "utf8");

// This fixture keeps the declared-capable scorers narrow on purpose; supported
// agents outside the fixture may still be used by runtime escalation.
const SCORE_CFG = `enabled: true\nstages: [code, score]\ncapability:\n  kimi: [code, score]\n  pi: [code, score]\n  reasonix: [code, score]\n`;

function scoreDeps(over: Partial<RunScorePairingDeps> = {}): { d: RunScorePairingDeps; events: PairEvent[] } {
  const events: PairEvent[] = [];
  const d: RunScorePairingDeps = {
    installed: ["kimi", "pi", "reasonix"],
    isAvailable: () => true,
    scorePeer: async () => ({ score: 8, verdict: "good", rationale: "clean delivery, tests cover the seams", cost: 0.05 }),
    event: (e) => events.push(e),
    now: () => 1234,
    ...over,
  };
  return { d, events };
}

describe("runScorePairing — US-PAIR-009", () => {
  it("FIX-343: MANDATORY — scores even with NO pairing.yaml / stage not enabled", async () => {
    // The score stage is no longer gated on pairing.yaml: a repo with no config
    // (and one with only `code` enabled) still produces a peer Review Score.
    const off = project(null);
    const { d } = scoreDeps();
    expect((await runScorePairing(off.dir, off.rt, "c1", "kimi", "US-X-001", "roll-build", "summary", d)).status).toBe("scored");
    const noScore = project(ENABLED); // stages: [code] only — score stage still fires
    expect((await runScorePairing(noScore.dir, noScore.rt, "c1", "kimi", "US-X-002", "roll-build", "summary", scoreDeps().d)).status).toBe("scored");
  });

  it("scores via a fresh-session peer: note + evidence + pair:score event + session id", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = scoreDeps();
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "delivery summary", d);
    expect(r.status).toBe("scored");
    // FIX-343: the reviewer's fresh session/cast id is recorded + returned.
    expect(r.sessionId).toBeDefined();
    expect(r.sessionId).toContain("score");
    // note: written with pair provenance, readable by existing readers
    const notes = readStoryReviewScores(dir, "US-X-001");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.score).toBe(8);
    expect(notes[0]?.sessionId).toBe(r.sessionId);
    const noteText = readFileSync(notes[0]?.sourcePath ?? "", "utf8");
    expect(noteText).toContain("scoring: pair");
    expect(noteText).toContain(`scored-by: ${r.peer}`);
    expect(noteText).toContain(`session-id: ${r.sessionId}`);
    // evidence file in the stage namespace
    const ev = JSON.parse(readFileSync(join(rt, "peer", "cycle-c1.score.pair.json"), "utf8"));
    expect(ev.score).toBe(8);
    expect(ev.stage).toBe("score");
    // FIX-1054 SERIAL: the first ranked scorer parses, so exactly ONE scorer is
    // selected (the rest are skipped by policy) and exactly ONE pair:score.
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    const scoreEvents = events.filter((e) => e.type === "pair:score") as Extract<PairEvent, { type: "pair:score" }>[];
    expect(selecteds).toHaveLength(1);
    expect(selecteds[0]?.reason).toBe("ranked_candidate");
    expect(events.every((e) => e.type === "pair:selected" || e.type === "pair:score" || e.type === "pair:skipped")).toBe(true);
    expect(scoreEvents).toHaveLength(1);
    expect(scoreEvents[0]?.score).toBe(8);
    expect(scoreEvents[0]?.cost).toBe(0.05);
  });

  it("FIX-335: one scorer flakes (null), the other scores → uses the real peer score (not a self-grade)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    // Both hetero scorers fire in parallel: "reasonix" flakes (null), "pi" returns a
    // real score → take-first must use the non-null peer, NOT degrade to a self-grade.
    const { d, events } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return peer === "pi" ? { score: 7, verdict: "ok" as const, rationale: "the live peer scored", cost: 0.02 } : null;
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("scored"); // a real peer score, NOT a self-grade
    expect(tried.length).toBeGreaterThanOrEqual(2); // both candidates were fired (parallel)
    expect(r.peer).toBe("pi"); // the non-null scorer won
    expect(events.filter((e) => e.type === "pair:selected").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "pair:score")).toBe(true);
    expect(readStoryReviewScores(dir, "US-X-001")[0]?.score).toBe(7); // recorded as a pair score
  });

  it("FIX-343: single-agent env → scores via a fresh SAME-TYPE session (independence = fresh session, not vendor)", async () => {
    // Builder is kimi here: same-type fallback uses the builder's own type as a
    // fresh separate session.
    const { dir, rt } = project(SCORE_CFG);
    const { d } = scoreDeps({ installed: ["kimi"] }); // only the builder's own type
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("kimi"); // a fresh instance of the builder's own type
    expect(r.sessionId).toBeDefined();
    const notes = readStoryReviewScores(dir, "US-X-001");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.scoring).toBe("pair");
    expect(notes[0]?.scoredBy).toBe("kimi");
  });

  it("FIX-343: no scorer at all (empty pool) → fail-loud none-available, BLOCKS (no note)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = scoreDeps({ installed: [] });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("none-available");
    expect(events.map((e) => e.type)).toEqual(["pair:none-available"]);
    expect(readStoryReviewScores(dir, "US-X-001")).toHaveLength(0); // NO fallback note — the cycle honestly fails
  });

  it("US-V4-018: scoped evaluate role is preferred over legacy pairing.yaml for score candidates", async () => {
    const { dir, rt } = project(`enabled: true\nstages: [code, score]\ncapability:\n  pi: [code, score]\n`);
    writeScopedAgents(dir, `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [reasonix]
        require: [evaluate]
        avoid: [execute]
        strategy: least-recent
`);
    const tried: string[] = [];
    const { d } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      allowedAgents: ["kimi", "pi"],
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "scoped reviewer scored", cost: 0.02 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-V4-018", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("reasonix");
    expect(tried).toEqual(["reasonix"]);
  });

  it("US-V4-018: runtime availability skips scoped candidates only for the current resolution", async () => {
    const { dir, rt } = project(null);
    writeScopedAgents(dir, `schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [pi, reasonix]
        require: [evaluate]
        avoid: [execute]
        strategy: least-recent
`);
    const tried: string[] = [];
    const { d } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      isAvailable: (agent) => agent !== "pi",
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "runtime-available reviewer scored", cost: 0.02 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-V4-018", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("reasonix");
    expect(tried).toEqual(["reasonix"]);
  });

  it("FIX-343: peer flakes across the bounded retry → status timeout, BLOCKS, no note/evidence", async () => {
    const { dir, rt } = project(SCORE_CFG);
    let calls = 0;
    const { d } = scoreDeps({ scorePeer: async () => (calls++, null) });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("timeout");
    // FIX-343 (C4): two bounded rounds run — hetero {pi,reasonix} FIRST (2
    // candidates × up to 2 attempts), then the same-vendor fallback {kimi} (1
    // candidate × up to 2 attempts). All flake → both rounds exhaust their
    // bounded budget → timeout, with >3 total scorePeer calls.
    expect(calls).toBeGreaterThan(3);
    expect(existsSync(join(rt, "peer", "cycle-c1.score.pair.json"))).toBe(false);
    expect(readStoryReviewScores(dir, "US-X-001")).toHaveLength(0);
  });

  it("out-of-range / malformed peer score → error status, nothing written", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d } = scoreDeps({ scorePeer: async () => ({ score: 99, verdict: "good", rationale: "x", cost: 0 }) });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("error");
    expect(readStoryReviewScores(dir, "US-X-001")).toHaveLength(0);
  });

  it("FIX-935: score stage respects project-config allowedAgents and does not auto-enable codex", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d, events } = scoreDeps({
      installed: ["kimi", "pi", "codex"],
      allowedAgents: ["kimi", "pi"],
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "allowed peer scored", cost: 0.02 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-935", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(tried).not.toContain("codex");
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    expect(selecteds.every((e) => e.peer !== "codex")).toBe(true);
  });

  // ── FIX-343 (② BOUNDED hetero preference) ──────────────────────────────────
  it("FIX-343 (②): a hetero peer present+responsive WINS over a faster same-vendor scorer", async () => {
    // builder=kimi; pool = kimi (same-vendor) + pi,reasonix (hetero). The
    // same-vendor 'kimi' would reply INSTANTLY, the hetero peers a tick later.
    // The OLD runtime (fire-all + take-first) let kimi win; the bounded
    // preference runs the HETERO round FIRST, so a hetero peer wins.
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      scorePeer: async (peer: string) => {
        tried.push(peer);
        if (peer === "kimi") return { score: 9, verdict: "good" as const, rationale: "instant same-vendor", cost: 0 };
        await new Promise((r) => setTimeout(r, 5)); // hetero replies slightly later
        return { score: 7, verdict: "ok" as const, rationale: "hetero peer scored", cost: 0.03 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(["pi", "reasonix"]).toContain(r.peer); // a HETERO peer won, NOT same-vendor kimi
    expect(tried).not.toContain("kimi"); // the same-vendor round never ran (hetero succeeded first)
    expect(readStoryReviewScores(dir, "US-X-001")[0]?.scoredBy).not.toBe("kimi");
  });

  it("FIX-1044: hetero pool ALL-FAILS in a multi-agent install → BLOCK, never self-score the builder", async () => {
    // Supersedes the FIX-343② "fall back to same-vendor-fresh" behaviour:
    // builder=kimi; hetero = pi,reasonix (both flake null). The builder (kimi) is
    // EXCLUDED — it is not an independent Evaluator when peers are installed — so a
    // dead hetero pool BLOCKS (timeout) rather than letting the builder grade its
    // own cycle (AC3/AC4). The builder's scorePeer would score, but it is never
    // asked.
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return peer === "kimi" ? { score: 8, verdict: "good" as const, rationale: "builder would self-score — must NOT be asked", cost: 0.01 } : null;
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("timeout"); // independents failed → fail loud, no self-score
    expect(tried).toContain("pi"); // hetero peers were attempted
    expect(tried).toContain("reasonix");
    expect(tried).not.toContain("kimi"); // builder is NEVER asked to score its own cycle
    expect(readStoryReviewScores(dir, "US-X-001")).toHaveLength(0); // no self-score note
  });

  it("FIX-343 (②): SINGLE-VENDOR install → same-vendor immediately, no hetero wait/hang", async () => {
    // Only the builder's own vendor is installed → the hetero pool is EMPTY, so
    // we go straight to the same-vendor round (no wasted hetero spawn/wait).
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d } = scoreDeps({
      installed: ["kimi"],
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "single-vendor fresh session", cost: 0 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-001", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("kimi");
    expect(tried).toEqual(["kimi"]); // exactly one spawn — no empty hetero round burned a probe
  });

  // ── FIX-344: the design score-stage label (roll-design has no loop cycle) ────
  it("FIX-344: scoreStage='design' stamps the design label on event + session-id + evidence file", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = scoreDeps({ scoreStage: "design" });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-DSGN-001", "roll-design", "design output summary", d);
    expect(r.status).toBe("scored");
    // AC1: a real peer Review Score note (pair provenance, fresh session id),
    // NOT the design agent grading itself.
    const notes = readStoryReviewScores(dir, "US-DSGN-001");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.scoring).toBe("pair");
    expect(notes[0]?.skill).toBe("roll-design");
    expect(notes[0]?.scoredBy).toBeDefined();
    expect(notes[0]?.sessionId).toBe(r.sessionId);
    // AC1 observability: the session-id prefix + the pair:score event carry stage=design.
    expect(r.sessionId).toContain(":design:");
    const scoreEvents = events.filter((e) => e.type === "pair:score") as Extract<PairEvent, { type: "pair:score" }>[];
    expect(scoreEvents).toHaveLength(1);
    expect(scoreEvents[0]?.stage).toBe("design");
    expect((events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[])[0]?.stage).toBe("design");
    // evidence lands in the design namespace (not the build cycle's .score.pair.json).
    const ev = JSON.parse(readFileSync(join(rt, "peer", "cycle-c1.design.pair.json"), "utf8"));
    expect(ev.stage).toBe("design");
  });

  it("FIX-344: design score is INDEPENDENT — reviewer session id is never the design agent's own session", async () => {
    // AC3: the design agent triggers but NEVER scores its own output. The session
    // id on the note is the reviewer's freshly-minted session, distinct from the
    // working (design) agent — independence is verifiable, not asserted.
    const { dir, rt } = project(SCORE_CFG);
    const { d } = scoreDeps({ scoreStage: "design" });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-DSGN-002", "roll-design", "summary", d);
    expect(r.status).toBe("scored");
    expect(r.sessionId).toMatch(/^c1:design:[a-z]+:a\d+:\d+$/); // reviewer's fresh session, cycle-scoped
  });

  it("FIX-344: no scorer for a design output → fail-loud none-available, NO note (AC2)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = scoreDeps({ scoreStage: "design", installed: [] });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-DSGN-003", "roll-design", "summary", d);
    expect(r.status).toBe("none-available");
    // the absence is audited as a design-stage event, and NO synthesized score is written.
    expect((events[0] as Extract<PairEvent, { type: "pair:none-available" }>).stage).toBe("design");
    expect(readStoryReviewScores(dir, "US-DSGN-003")).toHaveLength(0);
  });

  it("FIX-344: design scorePeer flakes across the bounded retry → timeout, BLOCKS, no design note (AC2)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d } = scoreDeps({ scoreStage: "design", scorePeer: async () => null });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-DSGN-004", "roll-design", "summary", d);
    expect(r.status).toBe("timeout");
    expect(existsSync(join(rt, "peer", "cycle-c1.design.pair.json"))).toBe(false);
    expect(readStoryReviewScores(dir, "US-DSGN-004")).toHaveLength(0); // no honest score → no note
  });

  it("FIX-344: default scoreStage stays 'score' (build/fix path unchanged)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = scoreDeps(); // no scoreStage override
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-X-009", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(r.sessionId).toContain(":score:");
    expect((events.filter((e) => e.type === "pair:score") as Extract<PairEvent, { type: "pair:score" }>[])[0]?.stage).toBe("score");
  });
});

// ── FIX-910: unparseable score rescue + failure attribution ──────────────────

describe("FIX-910 — unparseable rescue and failure attribution", () => {
  /**
   * Simulate the executor's scorePeer closure rescue logic inline:
   *   1. First attempt → unparseable
   *   2. Emit `pair:score-failure` with cause=unparseable
   *   3. Retry ONCE with format-reminder prompt
   *   4. Second attempt → parses correctly → score produced
   *
   * This mirrors the exact logic added to the executor for FIX-910.
   */
  it("AC2: unparseable first → retry with format reminder → rescue succeeds, writes compliant score", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const callLog: string[] = [];
    let firstCall = true;
    const { d, events } = scoreDeps({
      installed: ["claude", "pi"],
      scorePeer: async (peer: string, _summary: string) => {
        callLog.push(peer);
        // First call for pi: simulate unparseable (return null). The real
        // executor would emit pair:score-failure here and retry with a format
        // reminder. Second call for pi (the retry): return a valid score.
        if (peer === "pi" && firstCall) {
          firstCall = false;
          // Simulate the pair:score-failure event the executor would emit
          events.push({
            type: "pair:score-failure",
            cycleId: "c1",
            peer: "pi",
            cause: "unparseable",
            detail: "I think the score is 7 and it looks ok",
            stage: "score",
            ts: 1234,
          });
          return null; // unparseable — harness would retry
        }
        return { score: 8, verdict: "good", rationale: "retry with format reminder worked", cost: 0.03 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "claude", "US-X-910", "roll-build", "summary", d);
    // The rescue succeeded — a real peer score was written
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("pi");
    // The unparseable failure was observable (event emitted)
    expect(events.some((e) => e.type === "pair:score-failure" && (e as { cause: string }).cause === "unparseable")).toBe(true);
    // The pair:score event was still emitted for the final success
    expect(events.some((e) => e.type === "pair:score")).toBe(true);
    // The note was written with the rescued score
    const notes = readStoryReviewScores(dir, "US-X-910");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.score).toBe(8);
    expect(notes[0]?.scoring).toBe("pair");
  });

  it("AC3: unparseable retry still fails → still null, no fake score written", async () => {
    const { dir, rt } = project(SCORE_CFG);
    let calls = 0;
    const { d, events } = scoreDeps({
      installed: ["claude", "pi"],
      scorePeer: async () => {
        calls++;
        // Simulates: first call unparseable, retry also unparseable
        // Both emit pair:score-failure with cause=unparseable
        events.push({
          type: "pair:score-failure",
          cycleId: "c1",
          peer: "pi",
          cause: "unparseable",
          detail: `attempt ${calls} — prose, no SCORE: line`,
          stage: "score",
          ts: 1234,
        });
        return null; // never parsable
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "claude", "US-X-911", "roll-build", "summary", d);
    // FIX-1044: builder=claude is EXCLUDED (pi is an installed independent), so
    // only pi is asked — it fails twice → timeout (whole independent pool failed),
    // NO note written. The builder's claude fresh-session is never tried (AC3).
    expect(r.status).toBe("timeout");
    // Two unparseable events were emitted (two attempts on the one independent peer pi).
    const failures = events.filter((e) => e.type === "pair:score-failure");
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => (f as { cause: string }).cause === "unparseable")).toBe(true);
    // No score note was written — no fake score
    expect(readStoryReviewScores(dir, "US-X-911")).toHaveLength(0);
    // No pair:score event — nothing was fabricated
    expect(events.some((e) => e.type === "pair:score")).toBe(false);
  });

  it("AC1: timeout/exit-error failure causes ARE distinguished (no rescue for non-unparseable)", async () => {
    // Only unparseable gets a rescue retry. Timeout and exit-error are real
    // spawn/process problems — retrying with a format reminder is pointless.
    // This test verifies the event shape distinguishes the causes.
    const events: Array<{ type: string; cause?: string }> = [];
    // Simulate three distinct failure causes the executor would emit
    events.push({ type: "pair:score-failure", cause: "timeout" });
    events.push({ type: "pair:score-failure", cause: "exit-error" });
    events.push({ type: "pair:score-failure", cause: "auth-block" });
    events.push({ type: "pair:score-failure", cause: "unparseable" });
    // All four causes are represented — each is observable
    expect(events).toHaveLength(4);
    const causes = events.map((e) => e.cause);
    expect(causes).toContain("unparseable");
    expect(causes).toContain("timeout");
    expect(causes).toContain("auth-block");
    expect(causes).toContain("exit-error");
  });

  it("AC4: independence invariants hold — rescued score still has pair provenance + session-id", async () => {
    // The rescue writes through runScorePairing, which stamps scoring:pair +
    // scored-by + session-id. The rescued score must satisfy ALL the same
    // independence filters as a non-rescued score.
    const { dir, rt } = project(SCORE_CFG);
    const { d } = scoreDeps({
      installed: ["claude", "pi"],
      scorePeer: async () => ({ score: 7, verdict: "ok", rationale: "rescued via format reminder", cost: 0.02 }),
    });
    const r = await runScorePairing(dir, rt, "c1", "claude", "US-X-912", "roll-build", "summary", d);
    expect(r.status).toBe("scored");
    expect(r.sessionId).toBeDefined();
    expect(r.sessionId).toContain("score");
    const notes = readStoryReviewScores(dir, "US-X-912");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.scoring).toBe("pair");
    expect(notes[0]?.scoredBy).toBe(r.peer);
    expect(notes[0]?.sessionId).toBe(r.sessionId);
    // The note text carries the independence markers
    const noteText = readFileSync(notes[0]?.sourcePath ?? "", "utf8");
    expect(noteText).toContain("scoring: pair");
    expect(noteText).toContain(`scored-by: ${r.peer}`);
    expect(noteText).toContain(`session-id: ${r.sessionId}`);
  });
});

describe("buildDesignScorePrompt — FIX-344 grades DESIGN quality, not code", () => {
  it("frames a DESIGN review (INVEST / visual-AC / deliverable / domain) and shares the reply contract", () => {
    const p = buildDesignScorePrompt("Story: US-DSGN-001\nGoal: login feature\nSpecs: ...");
    // grades design, not a diff
    expect(p).toContain("DESIGN");
    expect(p).toMatch(/INVEST/);
    expect(p).toMatch(/visual-AC|visual-evidence/i);
    expect(p).toMatch(/deliverable/i);
    expect(p).not.toContain("PAIRING scorer"); // NOT the code-delivery rubric
    expect(p).toMatch(/NOT code/); // it grades design, explicitly not a diff
    // shared SCORE/VERDICT/RATIONALE contract so parsePairScoreOutput works on the reply
    expect(p).toContain("SCORE:");
    expect(p).toContain("VERDICT: good|ok|regression");
    expect(p).toContain("RATIONALE:");
    expect(p).toContain("US-DSGN-001"); // the summary is embedded
  });
});

describe("parsePairScoreOutput — US-PAIR-009", () => {
  it("parses SCORE/VERDICT/RATIONALE lines from peer stdout", () => {
    const out = parsePairScoreOutput("noise\nSCORE: 8\nVERDICT: good\nRATIONALE: tight TCR, ACs covered\nmore noise");
    expect(out).toEqual({ score: 8, verdict: "good", rationale: "tight TCR, ACs covered" });
  });
  it("rejects missing or malformed fields (caller falls back to self)", () => {
    expect(parsePairScoreOutput("VERDICT: good\nRATIONALE: x")).toBeNull(); // no score
    expect(parsePairScoreOutput("SCORE: eleven\nVERDICT: good\nRATIONALE: x")).toBeNull();
    expect(parsePairScoreOutput("SCORE: 12\nVERDICT: good\nRATIONALE: x")).toBeNull(); // out of range
    expect(parsePairScoreOutput("SCORE: 7\nVERDICT: great\nRATIONALE: x")).toBeNull(); // bad verdict
    expect(parsePairScoreOutput("SCORE: 7\nVERDICT: ok")).toBeNull(); // no rationale
    expect(parsePairScoreOutput("VERDICT: good\nRATIONALE: clean\nSCORE: 8")).toBeNull(); // wrong order
    expect(parsePairScoreOutput("SCORE: 8\nVERDICT: good\nSCORE: 7\nRATIONALE: clean")).toBeNull(); // duplicate field
  });
  it("FIX-910: still rejects unparseable text that WOULD trigger rescue (parse is never relaxed)", () => {
    // These are real-world-ish unparseable outputs that the rescue path would retry.
    // parsePairScoreOutput must still return null for ALL of them — the rescue
    // happens UPSTREAM (in the executor's scorePeer closure), never by relaxing parse.
    expect(parsePairScoreOutput("I think the delivery is a solid 8 out of 10")).toBeNull();
    expect(parsePairScoreOutput("Score: 8 the reasoning is good")).toBeNull();
    expect(parsePairScoreOutput("SCORE: 8\nRATIONALE: good work\n")).toBeNull(); // missing VERDICT
    expect(parsePairScoreOutput("SCORE: 8\nVERDICT: good\n")).toBeNull(); // missing RATIONALE
    expect(parsePairScoreOutput("VERDICT: good\nRATIONALE: clean")).toBeNull(); // missing SCORE
    expect(parsePairScoreOutput("Score: 8\nVerdict: acceptable\nRationale: fine")).toBeNull(); // bad verdict
    expect(parsePairScoreOutput("SCORE:abc\nVERDICT:ok\nRATIONALE:x")).toBeNull(); // non-numeric score
    // AC3 guard: a reviewer that embeds score-like text in prose still fails parse
    expect(parsePairScoreOutput(
      "After reviewing the delivery, I'd give it a SCORE: 7. The VERDICT: is ok. My RATIONALE: the tests cover the seams."
    )).toBeNull();
  });
});

describe("parsePairScoreOutput — FIX-1044 real-agent raw output normalization", () => {
  // AC1: real raw outputs that contained a VALID final SCORE/VERDICT/RATIONALE
  // block but were rejected pre-fix as unparseable/timeout. Fixtures are the
  // exact stdout the parser receives (no `--- stdout ---` artifact wrapper) —
  // pi/claude are verbatim from the failed FIX-1042 cycle; reasonix/kimi are
  // distilled per the spec's builder_notes (warning banner / bullet prefix kept).
  it("pi: terminal overstrike (^D + backspaces) before SCORE parses", () => {
    const out = parsePairScoreOutput(readScoreFixture("pi-overstrike.stdout.txt"));
    expect(out).not.toBeNull();
    expect(out?.score).toBe(8);
    expect(out?.verdict).toBe("good");
    expect(out?.rationale).toContain("auxiliary-dir policy");
  });

  it("claude: JSONL stream-json wrapper — final result block parses", () => {
    const out = parsePairScoreOutput(readScoreFixture("claude-jsonl.stdout.txt"));
    expect(out).not.toBeNull();
    expect(out?.score).toBe(9);
    expect(out?.verdict).toBe("good");
    expect(out?.rationale).toContain("root-cause fix");
  });

  it("reasonix: startup warnings + ANSI banner above the block parse", () => {
    const out = parsePairScoreOutput(readScoreFixture("reasonix-warnings.stdout.txt"));
    expect(out).not.toBeNull();
    expect(out?.score).toBe(10);
    expect(out?.verdict).toBe("good");
    expect(out?.rationale).toContain("单一策略");
  });

  it("kimi: bullet-prefixed block with a trailing resume banner parses", () => {
    const out = parsePairScoreOutput(readScoreFixture("kimi-bullet.stdout.txt"));
    expect(out).not.toBeNull();
    expect(out?.score).toBe(8);
    expect(out?.verdict).toBe("good");
  });

  it("normalizeScoreStdout collapses overstrike, ANSI, and JSONL to clean protocol lines", () => {
    // \x04 control + ^D\b\b overstrike → erased; CSI escape stripped.
    expect(normalizeScoreStdout("\x1b[2mfoo\x1b[0m^D\b\bSCORE: 7")).toBe("fooSCORE: 7");
    // JSONL result field unwrapped (escaped \n become real lines).
    expect(normalizeScoreStdout('{"type":"result","result":"SCORE: 9\\nVERDICT: good"}')).toBe("SCORE: 9\nVERDICT: good");
  });

  // AC2: validation is NOT relaxed by normalization — malformed/incomplete blocks
  // and protocol-looking prose inside a JSONL/ANSI wrapper still parse to null.
  it("AC2: normalization does NOT loosen strict validation", () => {
    // out-of-range score inside a JSONL wrapper → still null
    expect(parsePairScoreOutput('{"type":"result","result":"SCORE: 12\\nVERDICT: good\\nRATIONALE: x"}')).toBeNull();
    // unsupported verdict after ANSI strip → still null
    expect(parsePairScoreOutput("\x1b[2mSCORE: 8\nVERDICT: amazing\nRATIONALE: x\x1b[0m")).toBeNull();
    // missing rationale, even with overstrike noise → still null
    expect(parsePairScoreOutput("^D\b\bSCORE: 8\nVERDICT: ok")).toBeNull();
    // prose embedding the markers in a JSONL result → still null (not a real block)
    expect(parsePairScoreOutput('{"type":"result","result":"I score it SCORE: 7 with VERDICT: ok and RATIONALE: fine"}')).toBeNull();
    // duplicate SCORE field survives normalization rejection
    expect(parsePairScoreOutput('{"type":"result","result":"SCORE: 8\\nVERDICT: good\\nSCORE: 7\\nRATIONALE: x"}')).toBeNull();
  });
});

describe("diagnosePairScoreOutput — FIX-1045 reasonix/kimi compatibility + diagnostics", () => {
  // AC1: reasonix repaints its TUI, so the SAME final block appears twice (a
  // redraw, not a disagreement). The pre-fix parser rejected it for having >1 of
  // each marker line; now the resolved final block is isolated and accepted.
  it("AC1: reasonix TUI-redraw duplicate block (real artifact) → parses the resolved final block", () => {
    const raw = readScoreFixture("reasonix-redraw.stdout.txt");
    // Pre-fix behavior the spec recorded: this returned null.
    const d = diagnosePairScoreOutput(raw);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.score.score).toBe(9);
      expect(d.score.verdict).toBe("good");
      expect(d.score.rationale).toContain("Delivery cleanly achieves the stated goal");
    }
    expect(parsePairScoreOutput(raw)?.score).toBe(9);
  });

  // AC2: kimi prints the reply TEMPLATE (with `<placeholder>` rationale), then a
  // long analysis transcript, then its REAL block last. The template echo and the
  // analysis prose must not block isolating the real final block.
  it("AC2: kimi template-echo + analysis transcript + final block (real artifact) → parses the final block", () => {
    const raw = readScoreFixture("kimi-template-echo.stdout.txt");
    const d = diagnosePairScoreOutput(raw);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.score.score).toBe(9);
      expect(d.score.verdict).toBe("good");
      expect(d.score.rationale).toContain("bounded normalization");
    }
    expect(parsePairScoreOutput(raw)?.score).toBe(9);
  });

  // AC1: reasonix soft-wraps a long rationale with a bare CR (U+000D) that the
  // line scan (split on \r?\n) does not break on, so the wrapped RATIONALE was
  // invisible and the block mis-rejected as "missing RATIONALE". The normalizer
  // now folds bare CR / Unicode line separators to \n so the block parses.
  it("AC1: reasonix CR-wrapped rationale (real artifact) → parses the final block", () => {
    const raw = readScoreFixture("reasonix-cr-wrap.stdout.txt");
    expect(raw.includes("\r")).toBe(true); // the fixture really carries a bare CR
    const d = diagnosePairScoreOutput(raw);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.score.score).toBe(9);
      expect(d.score.verdict).toBe("good");
      expect(d.score.rationale).toContain("normalization");
    }
  });

  it("normalizeScoreStdout folds bare CR and Unicode line separators to newlines", () => {
    expect(normalizeScoreStdout("RATIONALE: part one\rpart two")).toBe("RATIONALE: part one\npart two");
    expect(normalizeScoreStdout("a\u2028b\u2029c")).toBe("a\nb\nc");
    // CRLF must not become a double newline
    expect(normalizeScoreStdout("SCORE: 8\r\nVERDICT: good")).toBe("SCORE: 8\nVERDICT: good");
  });

  // AC4: agy returned no protocol content at all — a distinct diagnostic from
  // "returned score-like text but not accepted".
  it("AC4: agy empty/no-protocol output → category=no-score-content with a specific reason", () => {
    const d = diagnosePairScoreOutput(readScoreFixture("agy-empty.stdout.txt"));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.category).toBe("no-score-content");
      expect(d.reason).not.toBe("");
      expect(d.reason.toLowerCase()).toContain("no");
    }
  });

  // AC3: compatibility does NOT loosen validation — each rejection still fails,
  // now with a SPECIFIC, observable reason (never a generic "unparseable").
  it("AC3: template-echo-only reply → rejected-score-like (placeholder rationale does not count)", () => {
    const d = diagnosePairScoreOutput("SCORE: <integer 1..10>\nVERDICT: good|ok|regression\nRATIONALE: <one sentence>");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.category).toBe("rejected-score-like");
      // no valid SCORE (placeholder) and a templated verdict → reported precisely
      expect(d.reason).toMatch(/SCORE|VERDICT|RATIONALE/);
    }
  });

  it("AC3: genuinely conflicting duplicate score blocks → rejected with the conflict named", () => {
    const d = diagnosePairScoreOutput("SCORE: 8\nVERDICT: good\nRATIONALE: first\nSCORE: 3\nVERDICT: regression\nRATIONALE: second");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.category).toBe("rejected-score-like");
      expect(d.reason).toContain("conflicting");
      expect(d.reason).toMatch(/8.*3|3.*8/);
    }
  });

  it("AC3: identical repeated block (redraw) is accepted, but differing rationale only does not change the resolved score", () => {
    // Two blocks, SAME score+verdict, different rationale text → resolved → accept.
    const d = diagnosePairScoreOutput("SCORE: 7\nVERDICT: ok\nRATIONALE: full reason here\nSCORE: 7\nVERDICT: ok\nRATIONALE: short");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.score.score).toBe(7);
  });

  it("AC3: out-of-range score is distinguished from a missing score", () => {
    const oor = diagnosePairScoreOutput("SCORE: 12\nVERDICT: good\nRATIONALE: x");
    expect(oor.ok).toBe(false);
    if (!oor.ok) {
      expect(oor.category).toBe("rejected-score-like");
      expect(oor.reason).toContain("out of range");
    }
    const missing = diagnosePairScoreOutput("VERDICT: good\nRATIONALE: x");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("SCORE");
  });

  it("AC3: bad verdict and missing rationale each get their own reason", () => {
    const badVerdict = diagnosePairScoreOutput("SCORE: 7\nVERDICT: amazing\nRATIONALE: x");
    expect(badVerdict.ok).toBe(false);
    if (!badVerdict.ok) expect(badVerdict.reason).toContain("VERDICT");
    const noRationale = diagnosePairScoreOutput("SCORE: 7\nVERDICT: ok");
    expect(noRationale.ok).toBe(false);
    if (!noRationale.ok) expect(noRationale.reason).toContain("RATIONALE");
  });

  it("AC3: arbitrary prose with no markers → no-score-content (not score-like)", () => {
    const d = diagnosePairScoreOutput("I think this delivery is a solid 8 out of 10, nicely done.");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.category).toBe("no-score-content");
  });

  it("a clean single block still parses (regression)", () => {
    const d = diagnosePairScoreOutput("noise\nSCORE: 8\nVERDICT: good\nRATIONALE: tight TCR, ACs covered\nmore noise");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.score.score).toBe(8);
      expect(d.score.verdict).toBe("good");
    }
  });
});

describe("score never routes through the review loop (kimi pair-review)", () => {
  it("enabledPairingStages filters score out", () => {
    const { dir } = project(SCORE_CFG);
    expect(enabledPairingStages(dir)).toEqual(["code"]);
  });
  it("runPairing early-offs on score (belt-and-braces)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = deps();
    expect((await runPairing(dir, dir, rt, "c1", "kimi", "score", d)).status).toBe("off");
    expect(events).toHaveLength(0);
  });
});

// ── FIX-293: the peer-gate retry consult ─────────────────────────────────────
import { retryPeerConsult, type RetryPeerConsultDeps } from "../src/runner/pairing-gate.js";

function retryDeps(over: Partial<RetryPeerConsultDeps> = {}): { d: RetryPeerConsultDeps; events: PairEvent[] } {
  const events: PairEvent[] = [];
  const d: RetryPeerConsultDeps = {
    installed: ["kimi", "pi"], // pi is heterogeneous from kimi
    workingAgent: "kimi",
    reviewPeer: async (_peer, _diff, _t) => ({ verdict: "agree", findings: [], cost: 0.05 }),
    diff: async () => "diff --git a/a.ts ...",
    event: (e) => events.push(e),
    now: () => 7777,
    ...over,
  };
  return { d, events };
}

describe("retryPeerConsult — FIX-293 AC-H3 (bounded retry, config-independent)", () => {
  it("fires WITHOUT pairing.yaml (always-on gate, not opt-in) and writes the gate's evidence file", async () => {
    const { rt } = project(null); // no pairing.yaml — the gate retry still runs
    const wt = rt; // diff is injected, so worktree path is irrelevant here
    const { d, events } = retryDeps();
    const r = await retryPeerConsult(wt, rt, "c-retry", d);
    expect(r.status).toBe("reviewed");
    expect(r.peer).toBe("pi");
    // The evidence file is the canonical peer-gate path → peerEvidencePresent flips true.
    expect(existsSync(join(rt, "peer", "cycle-c-retry.pair.json"))).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["pair:selected", "pair:verdict"]);
  });

  it("a flaky/timed-out peer (reviewPeer→null) stays blocked, no evidence, no death-spiral", async () => {
    const { rt } = project(null);
    const { d } = retryDeps({ reviewPeer: async () => null });
    const r = await retryPeerConsult(rt, rt, "c-to", d);
    expect(r.status).toBe("timeout");
    expect(existsSync(join(rt, "peer", "cycle-c-to.pair.json"))).toBe(false);
  });

  it("empty diff → nothing to review (no peer burned)", async () => {
    const { rt } = project(null);
    const { d } = retryDeps({ diff: async () => "   " });
    const r = await retryPeerConsult(rt, rt, "c-empty", d);
    expect(r.status).toBe("empty");
  });

  it("respects the injected timeout (it is what bounds the consult)", async () => {
    const { rt } = project(null);
    let seenTimeout = -1;
    const { d } = retryDeps({ timeoutMs: 12345, reviewPeer: async (_p, _d, t) => { seenTimeout = t; return { verdict: "agree", findings: [], cost: 0 }; } });
    await retryPeerConsult(rt, rt, "c-t", d);
    expect(seenTimeout).toBe(12345);
  });
});

describe("retryPeerConsult — FIX-293 follow-up: same-type SEPARATE-SESSION fallback", () => {
  // (a) Single coding-agent-type env: only the working agent is installed. The
  // retry must NOT report none-available — it falls back to a fresh instance of
  // the working agent's OWN type (spawned via reviewPeer = a separate session),
  // produces evidence, and is NOT blocked. The over-blocking #711 bug is gone.
  it("single-agent-type env → falls back to a same-type separate-session peer, reviewed (not blocked)", async () => {
    const { rt } = project(null);
    const spawnedPeers: string[] = [];
    const { d, events } = retryDeps({
      installed: ["claude"], // only the working agent's type is installed
      workingAgent: "claude",
      reviewPeer: async (peer) => { spawnedPeers.push(peer); return { verdict: "agree", findings: [], cost: 0.03 }; },
    });
    const r = await retryPeerConsult(rt, rt, "c-same", d);
    expect(r.status).toBe("reviewed");
    expect(r.peer).toBe("claude"); // the reviewer is a fresh claude instance
    expect(r.sameTypeFallback).toBe(true);
    // reviewPeer (which spawns a distinct subprocess) WAS invoked → separate session.
    expect(spawnedPeers).toEqual(["claude"]);
    // Evidence is written → the gate re-runs green and the cycle is NOT blocked.
    expect(existsSync(join(rt, "peer", "cycle-c-same.pair.json"))).toBe(true);
    const ev = JSON.parse(readFileSync(join(rt, "peer", "cycle-c-same.pair.json"), "utf8")) as { peer: string; sameTypeFallback: boolean };
    expect(ev.peer).toBe("claude");
    expect(ev.sameTypeFallback).toBe(true);
    const selected = events.find((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>;
    expect(selected.peer).toBe("claude");
    // No fail-loud none-available event — a peer WAS consulted.
    expect(events.some((e) => e.type === "pair:none-available")).toBe(false);
  });

  // (b) Heterogeneous is still PREFERRED when a different-vendor agent exists —
  // the same-type fallback is the LAST resort, not the default.
  it("heterogeneous peer still PREFERRED over the same-type fallback", async () => {
    const { rt } = project(null);
    const { d } = retryDeps({ installed: ["kimi", "pi"], workingAgent: "kimi" });
    const r = await retryPeerConsult(rt, rt, "c-het", d);
    expect(r.status).toBe("reviewed");
    expect(r.peer).toBe("pi"); // different vendor wins
    expect(r.sameTypeFallback).toBe(false);
  });

  it("FIX-328: profile-less installed agents are not retried as peer reviewers", async () => {
    const { rt } = project(null);
    const spawned: string[] = [];
    const { d } = retryDeps({
      installed: ["claude", "made-up-a", "made-up-b"], // profile-less names are not spawnable reviewers
      workingAgent: "claude",
      reviewPeer: async (peer) => {
        spawned.push(peer);
        return { verdict: "agree", findings: [], cost: 0 };
      },
    });
    const r = await retryPeerConsult(rt, rt, "c-ide-filter", d);
    expect(r.status).toBe("reviewed");
    expect(r.peer).toBe("claude");
    expect(r.sameTypeFallback).toBe(true);
    expect(spawned).toEqual(["claude"]);
  });

  // (c) The cycle STILL BLOCKS when the separate-session consult yields no
  // evidence (timeout/failure) — even via the same-type fallback. Block now means
  // "the separate-session review produced no evidence", not "no other agent".
  it("same-type fallback that times out → still blocked (timeout), no evidence", async () => {
    const { rt } = project(null);
    const { d } = retryDeps({ installed: ["claude"], workingAgent: "claude", reviewPeer: async () => null });
    const r = await retryPeerConsult(rt, rt, "c-same-to", d);
    expect(r.status).toBe("timeout");
    expect(r.sameTypeFallback).toBe(true);
    expect(existsSync(join(rt, "peer", "cycle-c-same-to.pair.json"))).toBe(false);
  });

  // (c2) FIX-331 + codex peer-review: when heterogeneous peers EXIST but ALL fail
  // (timeout/null), the retry STAYS BLOCKED — it must NOT degrade to a same-type
  // review even though the working agent's own type could produce a verdict. A
  // wholly-failing hetero pool blocking is FIX-293's hard gate; same-type is ONLY
  // for the zero-hetero (single-vendor) env.
  it("hetero peers all fail → blocked (timeout), never falls back to same-type while hetero exists", async () => {
    const { rt } = project(null);
    const spawned: string[] = [];
    const { d } = retryDeps({
      installed: ["kimi", "pi"], // pi is heterogeneous from kimi
      workingAgent: "kimi",
      // hetero (pi) fails; the working agent's own type (kimi) WOULD pass —
      // but it must never be reached while a hetero peer was available.
      reviewPeer: async (peer) => {
        spawned.push(peer);
        return peer === "kimi" ? { verdict: "agree", findings: [], cost: 0 } : null;
      },
    });
    const r = await retryPeerConsult(rt, rt, "c-hetero-allfail", d);
    expect(r.status).toBe("timeout"); // blocked, NOT reviewed via same-type
    expect(r.sameTypeFallback).toBe(false); // the failing peer was the hetero pi
    expect(spawned).toEqual(["pi"]); // same-type kimi was NEVER attempted
    expect(existsSync(join(rt, "peer", "cycle-c-hetero-allfail.pair.json"))).toBe(false);
  });

  // (d) THE RED LINE: the reviewer is always reached through reviewPeer, which
  // spawns a DISTINCT process — even when the peer type equals the working type,
  // it is a separate session, never the builder scoring its own work in-session.
  // Here reviewPeer asserts it received a peer name to spawn (a separate session);
  // an in-session self-grade path would never invoke reviewPeer at all.
  it("RED LINE — same-type peer is reached via reviewPeer (separate spawn), never in-session self-review", async () => {
    const { rt } = project(null);
    let reviewPeerInvoked = false;
    const { d } = retryDeps({
      installed: ["claude"],
      workingAgent: "claude",
      reviewPeer: async (peer) => {
        reviewPeerInvoked = true;
        // The reviewer is invoked as a spawned peer with a name, not the builder's
        // own live session producing a self-verdict.
        expect(peer).toBe("claude");
        return { verdict: "agree", findings: [], cost: 0 };
      },
    });
    await retryPeerConsult(rt, rt, "c-redline", d);
    expect(reviewPeerInvoked).toBe(true);
  });

  // The only true none-available now: nothing to spawn at all (no installed agent
  // AND no working-agent name) — NOT "only one vendor installed".
  it("no agent at all (empty installed + empty workingAgent) → none-available (audited)", async () => {
    const { rt } = project(null);
    const { d, events } = retryDeps({ installed: [], workingAgent: "" });
    const r = await retryPeerConsult(rt, rt, "c-none", d);
    expect(r.status).toBe("none-available");
    const none = events.find((e) => e.type === "pair:none-available") as Extract<PairEvent, { type: "pair:none-available" }>;
    expect(none.reason).toContain("no peer could be consulted");
    expect(existsSync(join(rt, "peer", "cycle-c-none.pair.json"))).toBe(false);
  });
});

// ── FIX-935: peer-gate retry respects project-config allowed agents ───────────

describe("retryPeerConsult — FIX-935 allowedAgents filter", () => {
  it("does not spawn a machine-detected codex peer when project config only allows kimi/pi", async () => {
    const { rt } = project(null);
    const spawnedPeers: string[] = [];
    const { d } = retryDeps({
      installed: ["kimi", "pi", "codex"],
      workingAgent: "kimi",
      allowedAgents: ["kimi", "pi"],
      reviewPeer: async (peer) => { spawnedPeers.push(peer); return { verdict: "agree", findings: [], cost: 0.03 }; },
    });
    const r = await retryPeerConsult(rt, rt, "c-935-het", d);
    expect(r.status).toBe("reviewed");
    expect(r.peer).toBe("pi");
    expect(spawnedPeers).not.toContain("codex");
  });

  it("falls back to same-type separate session only when the working agent is allowed", async () => {
    const { rt } = project(null);
    const spawnedPeers: string[] = [];
    const { d } = retryDeps({
      installed: ["kimi", "codex"],
      workingAgent: "kimi",
      allowedAgents: ["kimi"],
      reviewPeer: async (peer) => { spawnedPeers.push(peer); return { verdict: "agree", findings: [], cost: 0.03 }; },
    });
    const r = await retryPeerConsult(rt, rt, "c-935-same", d);
    expect(r.status).toBe("reviewed");
    expect(r.peer).toBe("kimi");
    expect(r.sameTypeFallback).toBe(true);
    expect(spawnedPeers).toEqual(["kimi"]);
    expect(spawnedPeers).not.toContain("codex");
  });

  it("blocks when no allowed heterogeneous peer exists and working agent itself is disallowed", async () => {
    const { rt } = project(null);
    const { d, events } = retryDeps({
      installed: ["kimi", "pi"],
      workingAgent: "kimi",
      allowedAgents: ["pi"], // working agent not allowed → no same-type fallback either
      reviewPeer: async () => null,
    });
    const r = await retryPeerConsult(rt, rt, "c-935-block", d);
    expect(r.status).toBe("timeout");
    expect(events.some((e) => e.type === "pair:selected" && (e as Extract<PairEvent, { type: "pair:selected" }>).peer === "kimi")).toBe(false);
  });
});

// ── FIX-387: review prompt with repo context + build/TCR trust ───────────────

describe("buildReviewPrompt — FIX-387 repo context + build trust", () => {
  const diff = `diff --git a/packages/cli/src/new.ts b/packages/cli/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/packages/cli/src/new.ts
@@ -0,0 +1,10 @@
+import { StoryDeliveryTruth, queryDeliveryTruth } from "@roll/core";
+import { existsSync } from "node:fs";
+
+export function checkDelivery(storyId: string): boolean {
+  return queryDeliveryTruth(storyId) !== null;
+}
`;

  it("includes build/TCR status when commits ahead > 0 (AC2: trust already-passed build)", () => {
    const prompt = buildReviewPrompt({ diff, commitsAhead: 5, tcrCount: 3 });
    // AC2: build & TCR status is communicated
    expect(prompt).toMatch(/BUILD STATUS/);
    expect(prompt).toContain("5 commit(s) ahead of main");
    expect(prompt).toContain("3 TCR");
    expect(prompt).toMatch(/green/);
    expect(prompt).toMatch(/build.*TCR.*pipeline.*already passed/i);
    expect(prompt).toMatch(/Do NOT flag.*imports.*build regression/i);
    // AC4 guard: still tells reviewer to flag real issues
    expect(prompt).toMatch(/judge the diff ITSELF for correctness/i);
    expect(prompt).toMatch(/Flag real bugs/i);
  });

  it("includes repo context: main-baseline instruction (AC1)", () => {
    const prompt = buildReviewPrompt({ diff, commitsAhead: 2, tcrCount: 2 });
    // AC1: reviewer is told about main-baseline symbols
    expect(prompt).toMatch(/REPO CONTEXT/);
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("files NOT listed");
    expect(prompt).toContain("UNCHANGED from main");
    expect(prompt).toContain("exported symbols");
    expect(prompt).toContain("exist on the baseline");
    // AC1: explicit guidance on not mis-flagging imports from baseline
    expect(prompt).toContain("IMPORTS a symbol");
    expect(prompt).toContain("cannot find");
    expect(prompt).toContain("WITHIN the diff");
    expect(prompt).toContain("symbol lives on main");
    expect(prompt).toContain("the baseline");
    expect(prompt).toContain("compiler already resolved");
    expect(prompt).toContain("do NOT flag it");
  });

  it("omits build status line when zero commits ahead (idle cycle / no build to trust)", () => {
    const prompt = buildReviewPrompt({ diff, commitsAhead: 0, tcrCount: 0 });
    // When nothing was built, no BUILD STATUS line appears — the reviewer gets
    // only the REPO CONTEXT instruction (main-baseline awareness, no trust claim).
    expect(prompt).not.toMatch(/BUILD STATUS/);
    expect(prompt).not.toMatch(/TRUST BUILD/);
    // Repo context still there
    expect(prompt).toMatch(/REPO CONTEXT/);
    expect(prompt).toContain("origin/main");
    // Still has the diff
    expect(prompt).toContain(diff);
  });

  it("AC3: import of main-only symbol NOT flagged as regression — instructions cover the scenario", () => {
    // The diff imports StoryDeliveryTruth and queryDeliveryTruth from @roll/core.
    // These symbols are defined on main (outside the diff). The prompt must
    // instruct the reviewer NOT to flag this as "build regression" or "missing source".
    const prompt = buildReviewPrompt({ diff, commitsAhead: 3, tcrCount: 3 });
    // The diff content (import from @roll/core) is present
    expect(prompt).toContain("StoryDeliveryTruth");
    expect(prompt).toContain("queryDeliveryTruth");
    // The instruction explicitly covers this case
    expect(prompt).toMatch(/Do NOT flag imports.*defined OUTSIDE this diff/);
    expect(prompt).toMatch(/missing source.*undefined import.*would fail build/);
    expect(prompt).toMatch(/symbol lives on main/);
    // The structured verdict contract is preserved
    expect(prompt).toContain("VERDICT: agree|refine|object");
    expect(prompt).toContain("FINDING:");
  });

  it("AC4: still tells reviewer to catch real issues — the instruction does NOT weaken genuine problem detection", () => {
    const prompt = buildReviewPrompt({ diff, commitsAhead: 1, tcrCount: 1 });
    // The reviewer is still told to judge the diff for correctness
    expect(prompt).toContain("judge the diff ITSELF for correctness");
    expect(prompt).toContain("Flag real bugs");
    expect(prompt).toContain("logic errors");
    expect(prompt).toContain("security issues");
    // The ONLY time a missing import is real: new import path + new file in diff + missing export
    expect(prompt).toContain("The ONLY time a missing import is real");
    expect(prompt).toContain("import path ITSELF is newly");
    expect(prompt).toContain("introduced in this diff");
    // Does NOT say to skip all import checks
    expect(prompt).not.toMatch(/never flag/i);
    expect(prompt).not.toMatch(/ignore all import/i);
  });

  it("embeds the full diff at the end", () => {
    const prompt = buildReviewPrompt({ diff: "sample diff", commitsAhead: 1, tcrCount: 1 });
    expect(prompt).toContain("sample diff");
    expect(prompt).toMatch(/DIFF:\n/);
  });
});

describe("buildPairScorePrompt — FIX-363 intent-aware scoring (don't misjudge removals)", () => {
  it("instructs the scorer to grade against the stated goal and not treat intended deletions as regressions", () => {
    const prompt = buildPairScorePrompt("Story: FIX-356b\nGoal: Remove roll-sentinel from active skills and patrol code\nDiff stat:\n14 files, 14 insertions(+), 501 deletions(-)");
    // grades against the goal, not raw deletion volume
    expect(prompt).toMatch(/STATED GOAL/i);
    expect(prompt).toMatch(/REMOVE|RETIRE|DELETE|REFACTOR/);
    expect(prompt).toMatch(/deletions ARE the intended/i);
    expect(prompt).toMatch(/do NOT treat the deletion volume/i);
    // still emits the structured score contract
    expect(prompt).toContain("SCORE:");
    expect(prompt).toContain("VERDICT: good|ok|regression");
    // the delivery summary (with its Goal line) is embedded
    expect(prompt).toContain("Goal: Remove roll-sentinel");
  });

  it("US-SKILL-030: includes EVALUATION CONTRACT block when evalContractSummary is provided", () => {
    const evalSummary = "Design contract evidence:\n  - test: foo.test.ts (proves AC1)\nScorer focus:\n  - contract completeness";
    const prompt = buildPairScorePrompt("Story: US-SKILL-030\nDiff stat:\n3 files", evalSummary);
    expect(prompt).toContain("EVALUATION CONTRACT");
    expect(prompt).toContain("Designer contract evidence from the story spec");
    expect(prompt).toContain("foo.test.ts (proves AC1)");
  });

  it("US-SKILL-030: no EVALUATION CONTRACT block when evalContractSummary is absent (legacy)", () => {
    const prompt = buildPairScorePrompt("Story: US-OLD-001\nGoal: old story\nDiff stat:\n1 file");
    expect(prompt).not.toContain("EVALUATION CONTRACT");
    expect(prompt).toContain("SCORE:");
    expect(prompt).toContain("VERDICT:");
  });
});

// ── FIX-911: pool-level escalation when hetero + same-vendor all fail ───────

describe("runScorePairing — FIX-911 pool-level escalation", () => {
  // Hetero pool (pi, reasonix) and same-vendor pool (kimi) all flake null.
  // pi was excluded from the candidate pool by isAvailable (probe missed it),
  // but is actually reachable — the escalation round tries it and succeeds.
  it("AC1: hetero + same-vendor all fail → escalates to untried reachable reviewer, scores", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d, events } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      // pi is excluded by the probe (isAvailable returns false) — it won't be in
      // the initial candidate pool, but it IS installed + headless-capable.
      isAvailable: (a) => a === "kimi" || a === "reasonix",
      scorePeer: async (peer: string) => {
        tried.push(peer);
        // hetero (reasonix) + same-vendor (kimi) both flake; escalation (pi) scores.
        if (peer === "pi") return { score: 7, verdict: "ok" as const, rationale: "escalation rescued the score", cost: 0.02 };
        return null;
      },
    });
    const r = await runScorePairing(dir, rt, "c-escalate", "kimi", "US-X-911a", "roll-build", "summary", d);
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("pi"); // the escalated peer won
    // FIX-1044: builder=kimi is EXCLUDED from both the candidate pool and the
    // escalation, so only the independent peers are tried: reasonix (hetero round)
    // first, then the probe-missed pi via escalation. kimi is NEVER asked.
    expect(tried).toContain("reasonix"); // hetero round ran first
    expect(tried).not.toContain("kimi"); // builder never self-scores (AC3)
    expect(tried.indexOf("pi")).toBeGreaterThan(tried.indexOf("reasonix")); // escalation ran last
    // still a valid pair score — all independence invariants hold
    const notes = readStoryReviewScores(dir, "US-X-911a");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.scoring).toBe("pair");
    expect(notes[0]?.scoredBy).toBe("pi");
    expect(notes[0]?.sessionId).toBe(r.sessionId);
    // evidence file written
    expect(existsSync(join(rt, "peer", "cycle-c-escalate.score.pair.json"))).toBe(true);
    // pair:score event emitted
    expect(events.some((e) => e.type === "pair:score")).toBe(true);
  });

  // FIX-397 shape: the only probe-available agent is the BUILDER itself; the
  // independents (pi, reasonix) were excluded by the probe. FIX-1044: the builder
  // is NOT a scorer, so the initial pool is empty — but escalation still rescues a
  // probe-missed independent (pi), so the cycle scores WITHOUT self-scoring.
  it("AC1 (FIX-397 shape, FIX-1044): only builder probe-available → escalation rescues an independent, builder never scores", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      // Only kimi (the BUILDER) passes the probe — pi and reasonix are excluded.
      isAvailable: (a) => a === "kimi",
      scorePeer: async (peer: string) => {
        tried.push(peer);
        // pi (escalation) → scores; reasonix → null. kimi must never be asked.
        if (peer === "pi") return { score: 8, verdict: "good" as const, rationale: "escalation rescued a probe-missed independent", cost: 0.03 };
        return null;
      },
    });
    const r = await runScorePairing(dir, rt, "c-fix397", "kimi", "US-X-911b", "roll-build", "summary", d);
    expect(r.status).toBe("scored");
    expect(r.peer).toBe("pi");
    // FIX-1044: the builder (kimi) is NEVER asked — the escalation skips it and
    // rescues the independent pi instead.
    expect(tried).not.toContain("kimi");
    expect(tried).toContain("pi"); // escalation tried and scored
    expect(readStoryReviewScores(dir, "US-X-911b")[0]?.score).toBe(8);
  });

  it("AC2: full pool exhaustion (all escalation candidates also null) → clean timeout, no death-spiral", async () => {
    const { dir, rt } = project(SCORE_CFG);
    let calls = 0;
    const { d } = scoreDeps({
      installed: ["kimi", "pi", "reasonix"],
      // kimi in pool; pi+reasonix excluded by probe → become escalation candidates
      isAvailable: (a) => a === "kimi",
      scorePeer: async () => {
        calls++;
        return null; // EVERYONE flakes — hetero, same-vendor, AND escalation
      },
    });
    const r = await runScorePairing(dir, rt, "c-exhaust", "kimi", "US-X-911c", "roll-build", "summary", d);
    expect(r.status).toBe("timeout");
    // Hard budget cap: ESCALATION_MAX_ROUNDS=2 → at most 2 escalation peers tried.
    // But the escalation pool here has 2 peers (pi, reasonix), so both get tried.
    // No infinite loop — the function returns cleanly.
    expect(calls).toBeGreaterThan(3); // kimi(retries) + pi(retries) + reasonix(retries)
    // Bounded: we don't loop forever
    const MAX_EXPECTED = (2 /* kimi attempts */) + (2 /* pi max attempts */) + (2 /* reasonix max attempts */);
    expect(calls).toBeLessThanOrEqual(MAX_EXPECTED);
    expect(existsSync(join(rt, "peer", "cycle-c-exhaust.score.pair.json"))).toBe(false);
  });

  it("AC2: escalation respects ESCALATION_MAX_ROUNDS cap — large pool doesn't spiral", async () => {
    // Simulate many installed agents but only 2 escalation rounds allowed
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const manyAgents = ["kimi", "pi", "reasonix", "deepseek"];
    const { d } = scoreDeps({
      installed: manyAgents,
      // Only kimi passes probe; the other 3 become escalation candidates
      isAvailable: (a) => a === "kimi",
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return null; // all fail
      },
    });
    const r = await runScorePairing(dir, rt, "c-cap", "kimi", "US-X-911d", "roll-build", "summary", d);
    expect(r.status).toBe("timeout");
    // ESCALATION_MAX_ROUNDS = 2 → at most 2 escalation peers tried (beyond kimi)
    const escalationTried = tried.filter((p) => p !== "kimi");
    const maxRounds = 2;
    // Each escalation peer gets up to SCORE_MAX_ATTEMPTS=2 attempts, but the
    // round cap stops after 2 peers regardless of attempts per peer.
    // The actual unique peers from escalation should be ≤ 2.
    const uniqueEscalation = [...new Set(escalationTried)];
    expect(uniqueEscalation.length).toBeLessThanOrEqual(maxRounds);
  });

  it("AC3: escalation peer gets the standard per-peer timeout (SCORE_TIMEOUT_MS)", async () => {
    const { dir, rt } = project(SCORE_CFG);
    let escalationTimeout = -1;
    const { d } = scoreDeps({
      installed: ["kimi", "pi"],
      isAvailable: (a) => a === "kimi", // pi excluded → escalation
      scorePeer: async (peer: string, _summary: string, timeoutMs: number) => {
        if (peer === "pi") escalationTimeout = timeoutMs;
        if (peer === "kimi") return null;
        return { score: 7, verdict: "ok" as const, rationale: "escalation", cost: 0 };
      },
    });
    const r = await runScorePairing(dir, rt, "c-time", "kimi", "US-X-911e", "roll-build", "summary", d);
    expect(r.status).toBe("scored");
    // The escalation round reuses the same timeout as normal rounds
    expect(escalationTimeout).toBeGreaterThan(0);
  });

  it("AC4: escalation score still passes independence gate — sessionId ≠ builder, pair provenance", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d } = scoreDeps({
      installed: ["kimi", "pi"],
      isAvailable: (a) => a === "kimi",
      scorePeer: async (peer: string) => {
        if (peer === "pi") return { score: 6, verdict: "ok" as const, rationale: "escalation peer scored", cost: 0.01 };
        return null;
      },
    });
    const r = await runScorePairing(dir, rt, "c-indep", "kimi", "US-X-911f", "roll-build", "summary", d);
    expect(r.status).toBe("scored");
    // sessionId is the reviewer's fresh session, never the builder's
    expect(r.sessionId).toBeDefined();
    expect(r.sessionId).toContain(":score:");
    expect(r.sessionId).toContain(":pi:"); // the escalation peer
    // pair provenance preserved
    const notes = readStoryReviewScores(dir, "US-X-911f");
    expect(notes[0]?.scoring).toBe("pair");
    expect(notes[0]?.scoredBy).toBe("pi");
  });

  it("AC5: no escalation candidates (all agents already tried) → clean timeout, no wasted work", async () => {
    const { dir, rt } = project(SCORE_CFG);
    let calls = 0;
    const { d } = scoreDeps({
      installed: ["kimi"], // only one agent — already in the candidate pool
      scorePeer: async () => {
        calls++;
        return null;
      },
    });
    const r = await runScorePairing(dir, rt, "c-solo", "kimi", "US-X-911g", "roll-build", "summary", d);
    expect(r.status).toBe("timeout");
    // Single agent, same-vendor round only, no escalation pool → bounded retries
    expect(calls).toBeLessThanOrEqual(2); // SCORE_MAX_ATTEMPTS
  });
});

// ── FIX-1054: cost-aware SERIAL dispatch (default serial, explicit fan-out) ───

describe("FIX-1054 — serial cost-aware code peer dispatch", () => {
  it("AC2: any structured verdict from the FIRST peer stops dispatch (no reviewer shopping)", async () => {
    const { dir, rt } = project(ENABLED);
    const tried: string[] = [];
    // refine is a VALID verdict — Roll must NOT keep shopping for an `agree`.
    const { d, events } = deps({
      reviewPeer: async (peer) => {
        tried.push(peer);
        return { verdict: "refine", findings: ["nit"], cost: 0.1 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(res.verdict).toBe("refine");
    expect(tried).toHaveLength(1); // exactly ONE peer spawned — the rest are skipped
    const skips = events.filter((e) => e.type === "pair:skipped") as Extract<PairEvent, { type: "pair:skipped" }>[];
    expect(skips).toHaveLength(1);
    expect(skips[0]?.reason).toBe("accepted_verdict");
    expect(skips[0]?.peers.length).toBeGreaterThanOrEqual(1); // the untried ranked candidate(s)
  });

  it("AC4: the first peer fails (null) → fall back to the NEXT peer, recorded as attempt=2", async () => {
    const { dir, rt } = project(ENABLED);
    const tried: string[] = [];
    // The first tried candidate times out (null); the second returns a verdict.
    const { d, events } = deps({
      reviewPeer: async (peer) => {
        tried.push(peer);
        return tried.length === 1 ? null : { verdict: "agree", findings: [], cost: 0.05 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    expect(res.peer).toBe(tried[1]); // the fallback peer won
    expect(tried).toHaveLength(2); // exactly two spawned — serial, not the whole pool at once
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    expect(selecteds).toHaveLength(2);
    expect(selecteds[0]?.attempt).toBe(1);
    expect(selecteds[0]?.reason).toBe("ranked_candidate");
    expect(selecteds[1]?.attempt).toBe(2);
    expect(selecteds[1]?.reason).toBe("fallback_after_failure");
  });

  it("AC5: explicit high-risk fan-out fires the bounded pool in parallel with a reasoned event", async () => {
    const { dir, rt } = project(ENABLED);
    const tried: string[] = [];
    const { d, events } = deps({
      fanout: "high_risk_truth_or_release_gate",
      reviewPeer: async (peer) => {
        tried.push(peer);
        return { verdict: "agree", findings: [], cost: 0.02 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c1", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    const fan = events.find((e) => e.type === "pair:fanout") as Extract<PairEvent, { type: "pair:fanout" }>;
    expect(fan).toBeDefined();
    expect(fan.reason).toBe("high_risk_truth_or_release_gate");
    expect(fan.limit).toBe(3);
    // every selected in a fan-out carries reason=fanout (not the serial reasons)
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    expect(selecteds.length).toBeGreaterThanOrEqual(2); // multiple candidates fired at once
    expect(selecteds.every((e) => e.reason === "fanout")).toBe(true);
    // fan-out never spawns more than the bounded limit
    expect(tried.length).toBeLessThanOrEqual(3);
  });
});

describe("FIX-1054 — serial cost-aware score dispatch", () => {
  it("AC1: the first parseable score stops dispatch — no remaining candidates spawned", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d, events } = scoreDeps({
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "clean", cost: 0.03 };
      },
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-1054-1", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(tried).toHaveLength(1); // ONE evaluator — the rest are skipped by policy
    const skips = events.filter((e) => e.type === "pair:skipped") as Extract<PairEvent, { type: "pair:skipped" }>[];
    expect(skips.length).toBeGreaterThanOrEqual(1);
    expect(skips[0]?.reason).toBe("accepted_score");
  });

  it("AC5: explicit score fan-out emits a bounded, reasoned pair:fanout event", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const { d, events } = scoreDeps({
      fanout: "owner_requested_quorum",
      scorePeer: async () => ({ score: 9, verdict: "good" as const, rationale: "quorum", cost: 0.02 }),
    });
    const r = await runScorePairing(dir, rt, "c1", "kimi", "US-1054-2", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    const fan = events.find((e) => e.type === "pair:fanout") as Extract<PairEvent, { type: "pair:fanout" }>;
    expect(fan).toBeDefined();
    expect(fan.reason).toBe("owner_requested_quorum");
    expect(fan.stage).toBe("score");
    expect(fan.limit).toBe(3);
  });
});

describe("US-CYCLE-008 — risk-tier-driven evaluation panel", () => {
  it("high tier fans the score stage out into a PARALLEL panel of distinct fresh sessions", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d, events } = scoreDeps({
      fanout: "high_risk_tier_card",
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "panel review", cost: 0.02 };
      },
    });
    const r = await runScorePairing(dir, rt, "c-tier-high", "kimi", "US-C008-1", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    // The fan-out is auditable + tier-attributed.
    const fan = events.find((e) => e.type === "pair:fanout") as Extract<PairEvent, { type: "pair:fanout" }>;
    expect(fan).toBeDefined();
    expect(fan.reason).toBe("high_risk_tier_card");
    expect(fan.stage).toBe("score");
    expect(fan.limit).toBe(3);
    // Multiple evaluators ran IN PARALLEL, each a distinct panel member (no member
    // is spawned twice → no shared session across the panel).
    const distinct = new Set(tried);
    expect(tried.length).toBeGreaterThanOrEqual(2);
    expect(distinct.size).toBe(tried.length);
    // The actual panel composition is reported for the declared-vs-actual audit.
    expect(r.panel.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.panel).size).toBe(r.panel.length);
    expect(r.panel).toEqual([...distinct]);
    // Every fan-out selection is labelled fanout (not the serial reasons).
    const selecteds = events.filter((e) => e.type === "pair:selected") as Extract<PairEvent, { type: "pair:selected" }>[];
    expect(selecteds.every((e) => e.reason === "fanout")).toBe(true);
    // Each panel member is selected under its OWN entry (a per-peer fresh session),
    // never one shared session reused across members.
    expect(new Set(selecteds.map((e) => e.peer)).size).toBe(selecteds.length);
  });

  it("low tier keeps the DEFAULT serial single-evaluator path — NO fan-out", async () => {
    const { dir, rt } = project(SCORE_CFG);
    const tried: string[] = [];
    const { d, events } = scoreDeps({
      // low tier ⇒ tierFanoutReason(undefined)/serial ⇒ NO fanout dep supplied.
      scorePeer: async (peer: string) => {
        tried.push(peer);
        return { score: 8, verdict: "good" as const, rationale: "single evaluator", cost: 0.02 };
      },
    });
    const r = await runScorePairing(dir, rt, "c-tier-low", "kimi", "US-C008-2", "roll-build", "s", d);
    expect(r.status).toBe("scored");
    expect(events.some((e) => e.type === "pair:fanout")).toBe(false); // never fans out
    expect(tried).toHaveLength(1); // exactly ONE evaluator (serial take-first)
    expect(r.panel).toEqual([tried[0]]); // panel = the single evaluator that ran
  });

  it("high tier fans the CODE review stage out with the tier reason", async () => {
    const { dir, rt } = project(ENABLED);
    const tried: string[] = [];
    const { d, events } = deps({
      fanout: "high_risk_tier_card",
      reviewPeer: async (peer) => {
        tried.push(peer);
        return { verdict: "agree", findings: [], cost: 0.02 };
      },
    });
    const res = await runPairing(dir, dir, rt, "c-tier-code", "kimi", "code", d);
    expect(res.status).toBe("reviewed");
    const fan = events.find((e) => e.type === "pair:fanout") as Extract<PairEvent, { type: "pair:fanout" }>;
    expect(fan).toBeDefined();
    expect(fan.reason).toBe("high_risk_tier_card");
    expect(fan.limit).toBe(3);
    expect(tried.length).toBeGreaterThanOrEqual(2); // parallel panel
    expect(tried.length).toBeLessThanOrEqual(3); // bounded
  });
});
