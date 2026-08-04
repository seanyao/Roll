/**
 * US-PAIR-001 — Cross-Agent Pairing selector + legacy migration parser.
 * Pure-function tests: vendor heterogeneity, rational hard filter, seeded
 * round-robin rotation, fail-loud empties, and config parse + cross-check.
 */
import { describe, expect, it } from "vitest";
import {
  agentVendor,
  heteroAvailable,
  isHeterogeneous,
  normalizeAgentScopeConfig,
  pairingConfigFromAgentScopeConfig,
  pairingPoolView,
  parsePairingConfig,
  PairingConfigError,
  selectPairingCandidates,
  type PairingConfig,
} from "../src/index.js";

const cfg = (over: Partial<PairingConfig> = {}): PairingConfig => ({
  enabled: true,
  stages: ["code"],
  capability: { kimi: ["code"], pi: ["code"], reasonix: ["code"] },
  ...over,
});
const always = (): boolean => true;

describe("agentVendor + isHeterogeneous", () => {
  it("maps known pool agents to distinct vendors", () => {
    expect(agentVendor("kimi")).toBe("moonshot");
    expect(agentVendor("pi")).toBe("pi");
    expect(agentVendor("reasonix")).toBe("reasonix");
    // US-AGENT-045: deepseek is now a provider alias → pi, so its vendor is pi's.
    expect(agentVendor("deepseek")).toBe("pi");
  });
  it("different vendor is heterogeneous; same vendor is NOT", () => {
    expect(isHeterogeneous("kimi", "pi")).toBe(true);
    expect(isHeterogeneous("kimi", "reasonix")).toBe(true);
    expect(isHeterogeneous("pi", "reasonix")).toBe(true);
    expect(isHeterogeneous("kimi", "kimi")).toBe(false);
  });
});

describe("heteroAvailable (FIX-312 — the review-routing switch)", () => {
  it("multi-vendor pool → true (a different-vendor peer exists for the builder)", () => {
    expect(heteroAvailable(["kimi", "pi", "reasonix"], "kimi")).toBe(true);
    expect(heteroAvailable(["kimi", "pi"], "kimi")).toBe(true);
  });
  it("single-agent / single-vendor pool → false (self-review fallback allowed)", () => {
    expect(heteroAvailable(["kimi"], "kimi")).toBe(false);
    expect(heteroAvailable([], "kimi")).toBe(false);
  });
  it("known supported agents are fair heterogeneous options; unknown/profile-less agents are ignored", () => {
    // Runtime auth/VPN/account health is not a static pairing-policy exclusion.
    expect(heteroAvailable(["claude", "made-up-a", "made-up-b"], "kimi")).toBe(true);
  });
  it("builder absent from the pool still counts other vendors", () => {
    // builder is reasonix (not installed locally) but a pi peer is available.
    expect(heteroAvailable(["pi"], "reasonix")).toBe(true);
  });
  it("unknown agents are not treated as supported reviewers without a profile", () => {
    expect(heteroAvailable(["kimi", "made-up-agent"], "kimi")).toBe(false);
  });
});

describe("selectPairingCandidates — rational hard filter", () => {
  it("returns only installed + available + capable + heterogeneous peers", () => {
    const got = selectPairingCandidates({
      installed: ["kimi", "pi", "reasonix"],
      isAvailable: always,
      workingAgent: "kimi",
      stage: "code",
      cfg: cfg(),
      cycleId: "c1",
    });
    expect(got).not.toContain("kimi"); // never the worker itself
    expect(got.sort()).toEqual(["pi", "reasonix"]);
  });

  it("excludes unavailable agents", () => {
    const got = selectPairingCandidates({
      installed: ["kimi", "pi", "reasonix"],
      isAvailable: (a) => a !== "pi",
      workingAgent: "kimi",
      stage: "code",
      cfg: cfg(),
      cycleId: "c1",
    });
    expect(got).toEqual(["reasonix"]);
  });

  it("excludes agents not declared capable for the stage", () => {
    const got = selectPairingCandidates({
      installed: ["kimi", "pi", "reasonix"],
      isAvailable: always,
      workingAgent: "kimi",
      stage: "design", // only set up for code in cfg
      cfg: cfg({ stages: ["design"], capability: { pi: ["code"], reasonix: ["design"] } }),
      cycleId: "c1",
    });
    expect(got).toEqual(["reasonix"]); // pi not capable for design
  });

  it("never pairs same-vendor (a fresh same-type peer is excluded from the hetero code stage)", () => {
    const got = selectPairingCandidates({
      installed: ["pi", "kimi"],
      isAvailable: always,
      workingAgent: "pi",
      stage: "code",
      cfg: cfg({ capability: { kimi: ["code"], pi: ["code"] } }),
      cycleId: "c1",
    });
    expect(got).toEqual(["kimi"]); // heterogeneous only
  });

  it("FIX-935: code stage filters out machine-detected agents not in project-config allowlist", () => {
    const got = selectPairingCandidates({
      installed: ["kimi", "pi", "codex", "claude"],
      isAvailable: always,
      workingAgent: "kimi",
      stage: "code",
      cfg: cfg({ capability: { kimi: ["code"], pi: ["code"], codex: ["code"], claude: ["code"] } }),
      cycleId: "c1",
      allowedAgents: ["kimi", "pi"],
    });
    expect(got).toEqual(["pi"]); // codex/claude disallowed despite being capable+installed
  });

  it("FIX-935: score stage filters out machine-detected agents not in project-config allowlist", () => {
    const got = selectPairingCandidates({
      installed: ["kimi", "codex", "claude"],
      isAvailable: always,
      workingAgent: "kimi",
      stage: "score",
      cfg: cfg({ enabled: false, stages: [], capability: {} }),
      cycleId: "c1",
      allowedAgents: ["kimi"],
    });
    expect(got).toEqual(["kimi"]); // codex/claude disallowed despite being installed headless scorers
  });

  it("FIX-935: empty allowlist yields empty candidates (fail-loud)", () => {
    const got = selectPairingCandidates({
      installed: ["kimi", "pi"],
      isAvailable: always,
      workingAgent: "kimi",
      stage: "code",
      cfg: cfg(),
      cycleId: "c1",
      allowedAgents: [],
    });
    expect(got).toEqual([]);
  });
});

describe("selectPairingCandidates — fail-loud empties", () => {
  it("empty when pairing disabled", () => {
    expect(selectPairingCandidates({ installed: ["claude", "codex"], isAvailable: always, workingAgent: "claude", stage: "code", cfg: cfg({ enabled: false }), cycleId: "c1" })).toEqual([]);
  });
  it("empty when stage not enabled", () => {
    expect(selectPairingCandidates({ installed: ["claude", "codex"], isAvailable: always, workingAgent: "claude", stage: "test", cfg: cfg(), cycleId: "c1" })).toEqual([]);
  });
  it("empty when no heterogeneous qualified peer (sole agent)", () => {
    expect(selectPairingCandidates({ installed: ["claude"], isAvailable: always, workingAgent: "claude", stage: "code", cfg: cfg(), cycleId: "c1" })).toEqual([]);
  });
});

describe("selectPairingCandidates — seeded round-robin rotation", () => {
  it("same cycleId is replayable; different cycleIds rotate the head", () => {
    const base = { installed: ["kimi", "pi", "reasonix"], isAvailable: always, workingAgent: "kimi", stage: "code" as const, cfg: cfg() };
    const a1 = selectPairingCandidates({ ...base, cycleId: "alpha" });
    const a2 = selectPairingCandidates({ ...base, cycleId: "alpha" });
    expect(a1).toEqual(a2); // deterministic
    // all candidates always present (rotation, not truncation)
    expect([...a1].sort()).toEqual(["pi", "reasonix"]);
    // at least one cycleId rotates to a different head across a few seeds
    const heads = ["alpha", "beta", "gamma", "delta", "eps"].map((c) => selectPairingCandidates({ ...base, cycleId: c })[0]);
    expect(new Set(heads).size).toBeGreaterThan(1);
  });
});

describe("parsePairingConfig", () => {
  it("parses enabled/stages/capability", () => {
    const c = parsePairingConfig(`enabled: true\nstages: [code, design]\ncapability:\n  pi: [code, test]\n  kimi: [code, design, cycle]\n`);
    expect(c.enabled).toBe(true);
    expect(c.stages).toEqual(["code", "design"]);
    expect(c.capability.pi).toEqual(["code", "test"]);
    expect(c.capability.kimi).toEqual(["code", "design", "cycle"]);
  });
  it("ignores comments and blank lines", () => {
    const c = parsePairingConfig(`# pairing\nenabled: true  # on\n\nstages: [code]\n`);
    expect(c.enabled).toBe(true);
    expect(c.stages).toEqual(["code"]);
  });
  it("fail-loud on an illegal stage", () => {
    expect(() => parsePairingConfig(`enabled: true\nstages: [bogus]\n`)).toThrow(PairingConfigError);
  });
  it("fail-loud on capability for an unknown agent (registry cross-check)", () => {
    expect(() => parsePairingConfig(`enabled: true\ncapability:\n  notanagent: [code]\n`)).toThrow(PairingConfigError);
  });
  it("FIX-328: fail-loud on capability for an unregistered reviewer", () => {
    expect(() => parsePairingConfig(`enabled: true\ncapability:\n  openclaw: [code]\n`)).toThrow(PairingConfigError);
  });
  it("absent/empty config is disabled (file-absent = off)", () => {
    expect(parsePairingConfig("").enabled).toBe(false);
  });
  // fail-loud fixes from kimi pair-review:
  it("fail-loud on an unknown top-level key (typo'd stages)", () => {
    expect(() => parsePairingConfig(`enabled: true\nstage: [code]\n`)).toThrow(PairingConfigError);
  });
  it("fail-loud on an indented line outside the capability block", () => {
    expect(() => parsePairingConfig(`enabled: true\n  stages: [code]\n`)).toThrow(PairingConfigError);
  });
  it("fail-loud on a malformed non-key line", () => {
    expect(() => parsePairingConfig(`enabled: true\ngarbage line\n`)).toThrow(PairingConfigError);
  });
});

describe("pairing selection invariants", () => {
  it("FIX-328: score candidates exclude installed profile-less agents", () => {
    // Worker is kimi. Profile-less agents are excluded from the score pool.
    // FIX-1044: the builder (kimi) is ALSO excluded — another known agent (pi) is
    // installed, so the independent Evaluator pi scores, never the builder itself.
    const picked = selectPairingCandidates({
      installed: ["kimi", "made-up-a", "made-up-b", "pi"],
      isAvailable: () => true,
      workingAgent: "kimi",
      stage: "score",
      cfg: cfg({ enabled: false, stages: [], capability: {} }),
      cycleId: "c1",
    });
    expect(picked).not.toContain("kimi"); // FIX-1044: builder never self-scores when an independent peer exists
    expect(picked).toContain("pi");
    expect(picked).not.toContain("made-up-a");
    expect(picked).not.toContain("made-up-b");
  });
  it("FIX-328: heteroAvailable ignores profile-less agents", () => {
    expect(heteroAvailable(["kimi", "made-up-a", "made-up-b"], "kimi")).toBe(false);
    expect(heteroAvailable(["kimi", "made-up-a", "pi"], "kimi")).toBe(true);
  });

  it("FIX-935: heteroAvailable respects project-config allowed agents", () => {
    // Machine detects codex and pi, but project config only allows pi.
    expect(heteroAvailable(["kimi", "pi", "codex"], "kimi", ["kimi", "pi"])).toBe(true);
    // Machine detects codex, but project config does not allow it.
    expect(heteroAvailable(["kimi", "codex"], "kimi", ["kimi"])).toBe(false);
    // Empty allowlist → no heterogeneous peer available.
    expect(heteroAvailable(["kimi", "pi"], "kimi", [])).toBe(false);
  });
  it("FIX-1044: in a multi-agent install the BUILDER is EXCLUDED from the score pool (no self-score fallback)", () => {
    // Supersedes the FIX-343 "builder's own type qualifies" behaviour: when an
    // independent Evaluator is installed, a delivery is graded by that peer or it
    // fails loud — the builder never grades its own cycle (AC3). Independence is
    // still verified by SESSION id downstream, so the single-agent anti-deadlock
    // guarantee (next test) is untouched.
    const picked = selectPairingCandidates({
      installed: ["kimi", "pi", "reasonix"],
      isAvailable: () => true,
      workingAgent: "kimi",
      stage: "score",
      cfg: cfg({ stages: ["score"], capability: { pi: ["score"], reasonix: ["score"] } }),
      cycleId: "c1",
    });
    expect(picked.length).toBe(2);
    expect(picked).not.toContain("kimi"); // builder excluded — not an independent Evaluator
    expect(picked).toContain("pi");
    expect(picked).toContain("reasonix");
  });

  it("FIX-1044: independents installed but ALL unavailable → empty pool (fail loud, never self-score)", () => {
    // The builder (kimi) is available, but the only other installed agent (pi) is
    // down. The builder must NOT be picked as a fallback — the pool is empty and
    // the cycle fails loud (AC4) rather than self-scoring.
    const picked = selectPairingCandidates({
      installed: ["kimi", "pi"],
      isAvailable: (a) => a === "kimi", // builder up, independent peer down
      workingAgent: "kimi",
      stage: "score",
      cfg: cfg({ stages: ["score"], capability: { pi: ["score"] } }),
      cycleId: "c1",
    });
    expect(picked).toEqual([]); // independent peer installed but unavailable → no self-score fallback
  });

  it("FIX-343: the score stage is MANDATORY — qualifies even when pairing is disabled / no score stage / no capability", () => {
    // A repo with no scoped evaluator binding (cfg.enabled=false, empty stages/capability)
    // still owes a Review Score: the selector must yield installed supported
    // agents. A single-agent env of kimi still yields that agent (a fresh
    // same-type session is the minimum independence).
    const picked = selectPairingCandidates({
      installed: ["kimi"],
      isAvailable: () => true,
      workingAgent: "kimi",
      stage: "score",
      cfg: cfg({ enabled: false, stages: [], capability: {} }),
      cycleId: "c1",
    });
    expect(picked).toEqual(["kimi"]); // single-agent env: a fresh same-type session

    const claudeOnly = selectPairingCandidates({
      installed: ["claude"],
      isAvailable: () => true,
      workingAgent: "claude",
      stage: "score",
      cfg: cfg({ enabled: false, stages: [], capability: {} }),
      cycleId: "c1",
    });
    expect(claudeOnly).toEqual(["claude"]); // fresh same-type session
  });
});

describe("pairingConfigFromAgentScopeConfig — US-V4-018 evaluate role bridge", () => {
  it("projects an explicit evaluate candidate pool into code+score capabilities", () => {
    const parsed = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
defaults:
  story:
    roles:
      evaluate:
        kind: select
        from: [claude, codex, kimi, pi, agy, reasonix]
        require: [evaluate]
        avoid: [execute]
        strategy: least-recent
`);
    expect(parsed.errors).toEqual([]);
    const c = pairingConfigFromAgentScopeConfig(parsed.config!, ["claude", "codex", "kimi", "pi", "agy", "reasonix"]);
    expect(c).toEqual({
      enabled: true,
      stages: ["code", "score"],
      capability: {
        claude: ["code", "score"],
        codex: ["code", "score"],
        kimi: ["code", "score"],
        pi: ["code", "score"],
        agy: ["code", "score"],
        reasonix: ["code", "score"],
      },
    });
  });

  it("uses the installed supported pool when evaluate select has no explicit from", () => {
    const parsed = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
roles:
  evaluate:
    kind: select
    require: [evaluate]
    strategy: first-available
`);
    expect(parsed.errors).toEqual([]);
    const c = pairingConfigFromAgentScopeConfig(parsed.config!, ["kimi", "made-up", "claude"]);
    expect(c?.capability).toEqual({ kimi: ["code", "score"], claude: ["code", "score"] });
  });

  it("lets an explicit project binding narrow the pool", () => {
    const parsed = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
roles:
  evaluate:
    kind: select
    from: [reasonix]
    strategy: first-available
`);
    expect(parsed.errors).toEqual([]);
    expect(pairingConfigFromAgentScopeConfig(parsed.config!, ["kimi", "reasonix"])?.capability).toEqual({ reasonix: ["code", "score"] });
  });

  it("keeps unknown agents fail-loud in scoped config normalization", () => {
    const parsed = normalizeAgentScopeConfig(`schema: roll-agents/v1
scope: project
roles:
  evaluate:
    kind: select
    from: [openclaw]
    strategy: first-available
`);
    expect(parsed.errors).toContain("roles.evaluate.from: unknown agent 'openclaw'");
  });
});

describe("pairingPoolView (US-PAIR-002 observability)", () => {
  const cfg2 = { enabled: true, stages: ["code"] as const, capability: { claude: ["code"], codex: ["code"] } } as any;
  it("marks capable heterogeneous agents in-pool, others excluded with a reason", () => {
    const v = pairingPoolView(["claude", "codex", "kimi"], cfg2);
    const byName = Object.fromEntries(v.agents.map((a) => [a.agent, a]));
    expect(byName["claude"].inPool).toBe(true);
    expect(byName["claude"].vendor).toBe("anthropic");
    expect(byName["codex"].inPool).toBe(true);
    // kimi has no capability entry → excluded with a reason
    expect(byName["kimi"].inPool).toBe(false);
    expect(byName["kimi"].reason).toContain("no capability");
  });
  it("when disabled, nobody is in-pool and reason says disabled", () => {
    const v = pairingPoolView(["claude", "codex"], { ...cfg2, enabled: false });
    expect(v.enabled).toBe(false);
    expect(v.agents.every((a) => !a.inPool)).toBe(true);
    expect(v.agents[0].reason).toContain("disabled");
  });
  it("single vendor → heterogeneity reason", () => {
    const v = pairingPoolView(["codex"], { enabled: true, stages: ["code"], capability: { codex: ["code"] } } as any);
    expect(v.agents[0].inPool).toBe(false);
    expect(v.agents[0].reason).toContain("heterogeneous");
  });
});

describe("pairingPoolView — capability must overlap an enabled stage (codex pair-review)", () => {
  it("excludes an agent capable only for a non-enabled stage", () => {
    const v = pairingPoolView(["claude", "codex"], {
      enabled: true,
      stages: ["code"],
      capability: { claude: ["code"], codex: ["design"] }, // codex only design, code enabled
    } as any);
    const codex = v.agents.find((a) => a.agent === "codex")!;
    expect(codex.inPool).toBe(false);
    expect(codex.reason).toContain("enabled stage");
  });
});

// ── FIX-346: auth-failure pool exclusion ─────────────────────────────────────
import {
  excludedPeers,
  peerAuthStates,
  authCooldownExclusions,
  DEFAULT_AUTH_EXCLUDE_THRESHOLD,
  aggregatePairingCost,
} from "../src/index.js";

const blocked = (agent: string, cause: "auth" | "network" = "auth"): any => ({
  type: "agent:blocked",
  cycleId: "c",
  agent,
  cause,
  stage: "review",
  detail: "",
  ts: 1,
});
const verdict = (peer: string): any => ({
  type: "pair:verdict",
  cycleId: "c",
  peer,
  verdict: "agree",
  findings: 0,
  cost: 0,
  stage: "code",
  ts: 1,
});

describe("peerAuthStates / excludedPeers (V4 fair pool)", () => {
  it("default threshold is two strikes", () => {
    expect(DEFAULT_AUTH_EXCLUDE_THRESHOLD).toBe(2);
  });

  it("a single auth failure does NOT exclude (transient blip tolerated)", () => {
    const ex = excludedPeers([blocked("claude")]);
    expect(ex.has("claude")).toBe(false);
    expect(peerAuthStates([blocked("claude")]).claude).toEqual({
      consecutiveAuthFailures: 1,
      excluded: false,
    });
  });

  it("two consecutive auth failures remain diagnostic only", () => {
    const ex = excludedPeers([blocked("claude"), blocked("claude")]);
    expect(ex.has("claude")).toBe(false);
    expect(peerAuthStates([blocked("claude"), blocked("claude")]).claude.excluded).toBe(true);
  });

  it("a successful verdict RESETS the streak (re-login recovers the peer)", () => {
    const ex = excludedPeers([blocked("claude"), verdict("claude"), blocked("claude")]);
    expect(ex.has("claude")).toBe(false);
    expect(peerAuthStates([blocked("claude"), verdict("claude"), blocked("claude")]).claude.consecutiveAuthFailures).toBe(1);
  });

  it("network blocks NEVER exclude (transient connectivity, not bad creds)", () => {
    const ex = excludedPeers([blocked("kimi", "network"), blocked("kimi", "network"), blocked("kimi", "network")]);
    expect(ex.has("kimi")).toBe(false);
  });

  it("does not exclude one auth-failing peer from the fair pool", () => {
    const ex = excludedPeers([blocked("claude"), blocked("claude"), verdict("codex")]);
    expect(ex.has("claude")).toBe(false);
    expect(ex.has("codex")).toBe(false);
  });

  it("keys the agent name verbatim (no overseas alias collapse remains)", () => {
    const ex = excludedPeers([blocked("kimi"), blocked("kimi")]);
    expect(ex.has("kimi")).toBe(false);
  });
});

// ── FIX-1056: same-envelope auth cooldown (regression for cycle 20260701-000657-76542)
describe("authCooldownExclusions (FIX-1056 same-envelope auth cooldown)", () => {
  // The observed broken cycle: agy was selected for BOTH code review and score
  // and emitted `agent:blocked cause:auth` twice — a genuine same-envelope auth
  // failure the loop must handle without pulling the owner into an interactive
  // verify. One failure is a tolerated blip; the streak reaching threshold is
  // what benches agy for this cycle's repeated attempts.
  const agyReviewBlock = (): any => ({ ...blocked("agy"), stage: "review", detail: "Error: authentication failed or timed out" });
  const agyScoreBlock = (): any => ({ ...blocked("agy"), stage: "score", detail: "Error: authentication failed or timed out" });

  it("a single same-envelope auth failure does NOT cool down (blip tolerated)", () => {
    const cd = authCooldownExclusions([agyReviewBlock()]);
    expect(cd.has("agy")).toBe(false);
  });

  it("the observed 76542-shaped double auth failure cools agy down with its failure count", () => {
    const cd = authCooldownExclusions([agyReviewBlock(), agyScoreBlock()]);
    expect(cd.get("agy")).toBe(2);
  });

  it("a later success resets the streak — a re-authenticated agy is NOT cooled down", () => {
    const cd = authCooldownExclusions([agyReviewBlock(), agyScoreBlock(), verdict("agy")]);
    expect(cd.has("agy")).toBe(false);
  });

  it("network blocks NEVER cool an agent down (transient connectivity, not bad creds)", () => {
    const cd = authCooldownExclusions([blocked("agy", "network"), blocked("agy", "network"), blocked("agy", "network")]);
    expect(cd.has("agy")).toBe(false);
  });

  it("cools down ONLY the auth-blocked peer — every other ready agent stays eligible (fairness)", () => {
    const cd = authCooldownExclusions([agyReviewBlock(), agyScoreBlock(), verdict("reasonix")]);
    expect(cd.has("agy")).toBe(true);
    expect(cd.has("reasonix")).toBe(false);
    expect(cd.has("claude")).toBe(false);
  });

  // The executor turns the cooldown Map into the `isAvailable` predicate the
  // pairing selector consults. This proves the end-to-end selection contract:
  // a genuinely auth-blocked agy is excluded and the NEXT eligible candidate is
  // chosen, while a passing (no-streak) agy stays fully eligible.
  const installed = ["reasonix", "agy", "kimi"];
  const cfg: PairingConfig = {
    enabled: true,
    stages: ["code", "score"],
    capability: { reasonix: ["code", "score"], agy: ["code", "score"], kimi: ["code", "score"] },
  };
  const availableExcept = (cd: Map<string, number>) => (a: string): boolean => !cd.has(a);

  it("agy stays eligible when it has NOT hit the auth-failure threshold (readiness passes)", () => {
    const cd = authCooldownExclusions([agyReviewBlock()]); // one blip — no cooldown
    const got = selectPairingCandidates({
      installed,
      isAvailable: availableExcept(cd),
      workingAgent: "reasonix",
      stage: "code",
      cfg,
      cycleId: "c-eligible",
    });
    expect(got).toContain("agy");
  });

  it("a cooled-down agy is excluded and the next eligible candidate is chosen", () => {
    const cd = authCooldownExclusions([agyReviewBlock(), agyScoreBlock()]); // streak=2 → cooldown
    const got = selectPairingCandidates({
      installed,
      isAvailable: availableExcept(cd),
      workingAgent: "reasonix",
      stage: "code",
      cfg,
      cycleId: "c-cooled",
    });
    expect(got).not.toContain("agy");
    expect(got.length).toBeGreaterThan(0); // a heterogeneous peer is still chosen (kimi)
    expect(got).toContain("kimi");
  });
});

describe("aggregatePairingCost — pair:excluded (FIX-346)", () => {
  it("surfaces the most-recent exclusion failure count per peer", () => {
    const s = aggregatePairingCost([
      { type: "pair:excluded", cycleId: "c1", agent: "claude", cause: "auth", failures: 2, ts: 1 },
      { type: "pair:excluded", cycleId: "c2", agent: "claude", cause: "auth", failures: 5, ts: 2 },
    ] as any[]);
    expect(s.excludedPeers).toEqual({ claude: 5 });
  });

  it("empty stream → no excluded peers", () => {
    expect(aggregatePairingCost([]).excludedPeers).toEqual({});
  });
});

describe("FIX-1491 — a peer that stated no verdict produces NO review", () => {
  // The investigation expected to find "auth failure parsed as agree/0 findings".
  // It is NOT there: the review path refuses on timeout, non-zero exit, AND a
  // missing VERDICT line. These tests pin that refusal so a later "helpful"
  // default cannot turn an empty response into a fabricated green light.
  it("empty output is refused, never defaulted to agree", async () => {
    const { parsePeerReviewOutput } = await import("../src/agent/peer-review.js");
    expect(parsePeerReviewOutput("")).toEqual({ ok: false, reason: "no_verdict_line" });
  });

  it("a broken-credential style error dump is refused", async () => {
    const { parsePeerReviewOutput } = await import("../src/agent/peer-review.js");
    const authNoise = "Error: authentication required\nPlease run `login` first.\n";
    expect(parsePeerReviewOutput(authNoise).ok).toBe(false);
  });

  it("prose that merely discusses agreeing is refused", async () => {
    const { parsePeerReviewOutput } = await import("../src/agent/peer-review.js");
    // No VERDICT: line — a model that ignored the protocol must not be read as a pass.
    expect(parsePeerReviewOutput("I agree this looks fine overall.").ok).toBe(false);
  });

  it("accepts a real verdict and collects its findings", async () => {
    const { parsePeerReviewOutput } = await import("../src/agent/peer-review.js");
    const r = parsePeerReviewOutput("VERDICT: refine\nFINDING: off-by-one in the loop\nFINDING: missing null check\n");
    expect(r).toEqual({ ok: true, verdict: "refine", findings: ["off-by-one in the loop", "missing null check"] });
  });

  it("an explicit agree with zero findings is a REAL review, not an artifact", async () => {
    const { parsePeerReviewOutput } = await import("../src/agent/peer-review.js");
    // This matters for reading history: claude's 27 zero-finding verdicts are
    // genuine 'agree' responses, not auth artifacts — the auth path never reaches here.
    expect(parsePeerReviewOutput("VERDICT: agree\n")).toEqual({ ok: true, verdict: "agree", findings: [] });
  });
});
