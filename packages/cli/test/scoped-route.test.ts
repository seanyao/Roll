/**
 * Scoped `story.execute` (Builder) routing keeps the Supervisor assignment
 * visible and exposes an auditable route trace.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mostRecentBuilder,
  renderScopedExecuteRoute,
  resolveScopedCastRole,
  resolveScopedStoryExecute,
  roleToScopeRole,
  scopedExecuteRouteTrace,
} from "../src/runner/scoped-route.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MACHINE = `schema: roll-agents/v1
scope: machine
agents:
  claude:
    capabilities: [supervise, execute, evaluate]
  agy:
    capabilities: [supervise, execute, evaluate]
  kimi:
    capabilities: [supervise, execute, evaluate]
  pi:
    capabilities: [supervise, execute, evaluate]
  reasonix:
    capabilities: [supervise, execute, evaluate]
  codex:
    capabilities: [supervise, execute, evaluate]
roles:
  supervise:
    kind: fixed
    agent: codex
`;

const PROJECT = `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [claude, agy, kimi, pi, reasonix, codex]
        require: [execute]
        strategy: least-recent
`;

const PROJECT_HEALTH_AWARE = `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [agy, kimi, reasonix, codex]
        require: [execute]
        strategy: health-aware
      evaluate:
        kind: select
        from: [agy, kimi, reasonix, codex]
        require: [evaluate]
        strategy: health-aware
`;

/** Build a {rollHome, repoCwd} pair seeded with the machine + project layers. */
function fixture(): { rollHome: string; repoCwd: string } {
  const rollHome = mkdtempSync(join(tmpdir(), "roll-home-"));
  const repoCwd = mkdtempSync(join(tmpdir(), "roll-proj-"));
  dirs.push(rollHome, repoCwd);
  writeFileSync(join(rollHome, "agents.yaml"), MACHINE);
  mkdirSync(join(repoCwd, ".roll"), { recursive: true });
  writeFileSync(join(repoCwd, ".roll", "agents.yaml"), PROJECT);
  return { rollHome, repoCwd };
}

function healthAwareFixture(): { rollHome: string; repoCwd: string } {
  const fx = fixture();
  writeFileSync(join(fx.repoCwd, ".roll", "agents.yaml"), PROJECT_HEALTH_AWARE);
  return fx;
}

const ALL_INSTALLED = new Set(["claude", "agy", "kimi", "pi", "reasonix", "codex"]);

describe("resolveScopedStoryExecute", () => {
  it("keeps the assigned Supervisor visible without excluding it from the Builder pool by default", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedStoryExecute(repoCwd, { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    expect(route).not.toBeNull();
    expect(route!.superviseAgent).toBe("codex");
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      // Fresh-session independence is the isolation boundary; same agent brand
      // remains eligible unless the owner explicitly configures a strict rule.
      expect(route!.resolution.resolved.agent).toBe("claude");
      expect(route!.resolution.resolved.skipped).toEqual([]);
    }
  });

  it("rotates fairly: a recently-used Builder yields to a never-used candidate", () => {
    const { rollHome, repoCwd } = fixture();
    // claude built most recently; pi/agy/etc never used → least-recent skips claude.
    const route = resolveScopedStoryExecute(repoCwd, {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 1000, agy: 2000, kimi: 3000 },
    });
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      // pi/reasonix/codex were never used; first declared never-used wins: pi.
      expect(route!.resolution.resolved.agent).toBe("pi");
    }
  });

  it("all supervise-capable agents stay eligible in the open pool", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedStoryExecute(repoCwd, { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.skipped).toEqual([]);
    expect(trace.candidates).toEqual(["claude", "agy", "kimi", "pi", "reasonix", "codex"]);
    expect(trace.supervise).toBe("codex");
  });

  it("returns null when no scoped agents.yaml is present", () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "roll-bare-"));
    dirs.push(repoCwd);
    const route = resolveScopedStoryExecute(repoCwd, { rollHome: repoCwd, installed: ALL_INSTALLED });
    expect(route).toBeNull();
  });

  it("renders an auditable trace with candidates, skipped reasons, and selection", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedStoryExecute(repoCwd, { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    const text = renderScopedExecuteRoute(scopedExecuteRouteTrace(route!));
    expect(text).toContain("builder route — story.execute");
    expect(text).toContain("Supervisor (supervise): codex");
    expect(text).toContain("strategy: least-recent");
    expect(text).toContain("ranked:");
    expect(text).toContain("skipped: (none)");
    expect(text).toContain("selected: claude");
  });

  it("US-AGENT-049: health-aware route keeps auth-degraded AGY visible but selects a healthy Builder", () => {
    const { rollHome, repoCwd } = healthAwareFixture();
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { kimi: 20, reasonix: 10 },
      healthSignals: [
        { agent: "agy", source: "cycle", status: "degraded", reason: "auth", observedAt: "2026-07-01T00:00:00Z" },
        { agent: "kimi", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:01:00Z" },
        { agent: "reasonix", source: "cycle", status: "healthy", observedAt: "2026-07-01T00:02:00Z" },
      ],
    });
    expect(route).not.toBeNull();
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.candidates).toEqual(["agy", "kimi", "reasonix", "codex"]);
    expect(trace.ranked.map((r) => r.agent)).toContain("agy");
    expect(trace.ranked.find((r) => r.agent === "agy")?.warnings).toContain("health degraded:auth");
    expect(trace.ranked.find((r) => r.agent === "codex")?.eligible).toBe(true);
    expect(trace.selected).toBe("reasonix");
  });

  it("US-AGENT-049: evaluator route uses the same open pool with session-based execute avoidance", () => {
    const { rollHome, repoCwd } = healthAwareFixture();
    const route = resolveScopedCastRole(repoCwd, "evaluator", {
      rollHome,
      installed: ALL_INSTALLED,
      healthSignals: [
        { agent: "kimi", source: "score", status: "blocked", reason: "parser", observedAt: "2026-07-01T00:00:00Z" },
        { agent: "reasonix", source: "score", status: "healthy", observedAt: "2026-07-01T00:01:00Z" },
      ],
    });
    expect(route).not.toBeNull();
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.role).toBe("evaluate");
    expect(trace.castRole).toBe("evaluator");
    expect(trace.candidates).toEqual(["agy", "kimi", "reasonix", "codex"]);
    expect(trace.skipped).toContainEqual({ agent: "kimi", reason: "health-blocked: parser" });
    expect(trace.ranked.find((r) => r.agent === "kimi")?.eligible).toBe(false);
  });
});

describe("FIX-1267 — builder no-consecutive-repeat rotation", () => {
  it("mostRecentBuilder picks the largest-ts agent (deterministic on ties)", () => {
    expect(mostRecentBuilder({})).toBeNull();
    expect(mostRecentBuilder({ claude: 1000, agy: 3000, kimi: 2000 })).toBe("agy");
    // Tie on ts → deterministic by agent name (lexicographically smallest).
    expect(mostRecentBuilder({ pi: 5000, agy: 5000 })).toBe("agy");
  });

  it("excludes the previous builder (most-recent) and selects a different agent", () => {
    const { rollHome, repoCwd } = fixture();
    // agy built most recently → excluded; least-recent among the rest wins.
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 100, agy: 9000, kimi: 200 },
    });
    expect(route).not.toBeNull();
    expect(route!.previousBuilder).toBe("agy");
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      expect(route!.resolution.resolved.agent).not.toBe("agy");
      expect(route!.resolution.resolved.skipped).toContainEqual({ agent: "agy", reason: "no-consecutive-repeat" });
    }
    // The audit trace surfaces the excluded previous builder.
    const trace = scopedExecuteRouteTrace(route!);
    expect(trace.previousBuilder).toBe("agy");
    expect(renderScopedExecuteRoute(trace)).toContain("previous builder (excluded — no-consecutive-repeat): agy");
  });

  it("retry / self-heal: an explicitly-supplied previous builder is excluded", () => {
    const { rollHome, repoCwd } = fixture();
    // Self-heal re-pick: the prior attempt's builder is passed in and excluded so
    // the swap actually changes who builds.
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: {},
      previousBuilder: "claude",
    });
    expect(route!.previousBuilder).toBe("claude");
    if (route!.resolution.ok) {
      expect(route!.resolution.resolved.agent).not.toBe("claude");
      expect(route!.resolution.resolved.skipped).toContainEqual({ agent: "claude", reason: "no-consecutive-repeat" });
    }
  });

  it("cross-goal-session boundary: the previous builder is derived from persisted runtime runs, not a session var", () => {
    const { rollHome, repoCwd } = fixture();
    // recentUse stands in for runs.jsonl, which persists across goal sessions —
    // a new goal session still excludes the last builder recorded on disk.
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { pi: 12345 },
    });
    expect(route!.previousBuilder).toBe("pi");
    if (route!.resolution.ok) expect(route!.resolution.resolved.agent).not.toBe("pi");
  });

  it("fails loud when the pool reduces to only the previous builder", () => {
    const { rollHome } = fixture();
    const repoCwd = mkdtempSync(join(tmpdir(), "roll-solo-"));
    dirs.push(repoCwd);
    mkdirSync(join(repoCwd, ".roll"), { recursive: true });
    // A single-agent execute pool whose only member just built.
    writeFileSync(
      join(repoCwd, ".roll", "agents.yaml"),
      `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [claude]
        require: [execute]
        strategy: least-recent
`,
    );
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: new Set(["claude"]),
      recentUse: { claude: 500 },
    });
    expect(route!.previousBuilder).toBe("claude");
    expect(route!.resolution.ok).toBe(false);
    if (!route!.resolution.ok) {
      expect(route!.resolution.failure.errors[0]).toContain("no-consecutive-repeat");
    }
  });

  it("config off: builder_no_consecutive_repeat=false disables the exclusion", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedCastRole(repoCwd, "builder", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 100, agy: 9000 },
      builderNoConsecutiveRepeat: false,
    });
    expect(route!.previousBuilder).toBeNull();
    if (route!.resolution.ok) {
      // No exclusion → nothing skipped for rotation.
      expect(route!.resolution.resolved.skipped).toEqual([]);
    }
  });

  it("the rotation does NOT apply to the evaluator role", () => {
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedCastRole(repoCwd, "evaluator", {
      rollHome,
      installed: ALL_INSTALLED,
      recentUse: { claude: 100, agy: 9000 },
    });
    expect(route!.previousBuilder).toBeNull();
  });
});

// US-DELTA-006 — the Designer is a first-class `design` scope role, not a
// Builder alias, and a missing `design` binding fails closed (no fallback).
describe("US-DELTA-006 — roleToScopeRole mapping", () => {
  it("maps each cast role to its distinct scope role", () => {
    expect(roleToScopeRole("designer")).toBe("design");
    expect(roleToScopeRole("builder")).toBe("execute");
    expect(roleToScopeRole("evaluator")).toBe("evaluate");
    expect(roleToScopeRole("peer_reviewer")).toBe("evaluate");
  });

  it("NEVER maps the designer to execute (no quiet Builder-alias fallback)", () => {
    expect(roleToScopeRole("designer")).not.toBe("execute");
  });
});

const PROJECT_WITH_DESIGN = `schema: roll-agents/v1
scope: project
inherits: machine
defaults:
  story:
    roles:
      design:
        kind: select
        from: [claude, agy, kimi]
        require: [design]
        strategy: first-available
      execute:
        kind: select
        from: [claude, agy, kimi, pi, reasonix, codex]
        require: [execute]
        strategy: least-recent
`;

const MACHINE_WITH_DESIGN = `schema: roll-agents/v1
scope: machine
agents:
  claude:
    capabilities: [supervise, design, execute, evaluate]
  agy:
    capabilities: [supervise, design, execute, evaluate]
  kimi:
    capabilities: [supervise, design, execute, evaluate]
  pi:
    capabilities: [supervise, execute, evaluate]
  reasonix:
    capabilities: [supervise, execute, evaluate]
  codex:
    capabilities: [supervise, execute, evaluate]
roles:
  supervise:
    kind: fixed
    agent: codex
`;

describe("US-DELTA-006 — resolveScopedCastRole('designer') → design role", () => {
  it("resolves the designer to the `design` scope role (independent of execute)", () => {
    const rollHome = mkdtempSync(join(tmpdir(), "roll-home-des-"));
    const repoCwd = mkdtempSync(join(tmpdir(), "roll-proj-des-"));
    dirs.push(rollHome, repoCwd);
    writeFileSync(join(rollHome, "agents.yaml"), MACHINE_WITH_DESIGN);
    mkdirSync(join(repoCwd, ".roll"), { recursive: true });
    writeFileSync(join(repoCwd, ".roll", "agents.yaml"), PROJECT_WITH_DESIGN);

    const route = resolveScopedCastRole(repoCwd, "designer", { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    expect(route).not.toBeNull();
    expect(route!.castRole).toBe("designer");
    expect(route!.scopeRole).toBe("design");
    expect(route!.resolution.ok).toBe(true);
    if (route!.resolution.ok) {
      // A design-capable agent — NOT forced to the builder's execute pool.
      expect(["claude", "agy", "kimi"]).toContain(route!.resolution.resolved.agent);
    }
  });

  it("FAILS CLOSED when no `design` binding exists — no fallback to execute", () => {
    // The default PROJECT fixture declares only an execute binding.
    const { rollHome, repoCwd } = fixture();
    const route = resolveScopedCastRole(repoCwd, "designer", { rollHome, installed: ALL_INSTALLED, recentUse: {} });
    expect(route).not.toBeNull();
    expect(route!.scopeRole).toBe("design");
    // No design binding → the resolution FAILS (the caller fails Full Delta
    // before the Builder), rather than quietly resolving an execute agent.
    expect(route!.resolution.ok).toBe(false);
    if (!route!.resolution.ok) {
      expect(route!.resolution.failure.errors.join(" ")).toContain("design");
    }
  });
});
