/**
 * US-SHOW-001 — deterministic unit tests for the showcase orchestration core.
 *
 * These run in the NORMAL suite (no real agents, no sandbox, no network). They
 * prove the pure heart: casting heterogeneity validation (rejects a collapsed
 * trio), the casting agents.yaml override text, evidence-chain assembly from a
 * fixture run-result, and the pass/fail verdict (every link present ⇒ PASS, any
 * missing ⇒ FAIL). The non-deterministic real-agent step is NOT exercised here
 * — that is the ROLL_SHOWCASE=1-gated E2E.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAvailableAgents,
  probeMissingAgents,
  resetSandbox,
  type RunRollOptions,
  type SubResult,
} from "../src/commands/showcase.js";
import {
  assembleEvidenceChain,
  castingAgentsYaml,
  DEFAULT_SHOWCASE_CASTING,
  showcaseVerdict,
  validateCasting,
  type ShowcaseRunResult,
} from "../src/lib/showcase.js";

/** A run-result with every evidence link satisfied (a passing showcase). */
function goldenRun(): ShowcaseRunResult {
  return {
    casting: { ...DEFAULT_SHOWCASE_CASTING },
    loopExit: 0,
    tcrCommits: [
      { sha: "abc1234", subject: "tcr: pulse renders truth.json", testPass: true },
      { sha: "def5678", subject: "tcr: pulse --json same-source", testPass: true },
    ],
    branch: "story/US-DEMO-001",
    pr: { number: 42, url: "https://github.com/seanyao/roll/pull/42" },
    reviewRecord: { reviewer: "reasonix", scorer: "pi", recorded: true },
    screenshots: [
      { surface: "cli", path: "/tmp/pulse-cli.png", present: true },
      { surface: "web", path: "/tmp/overview.png", present: true },
    ],
    attest: { gate: "PASS", reportPath: "/tmp/report.html" },
    backlogStatus: "✅ Done",
    truthLadder: "attested",
    sameNumber: {
      backlog: "US-DEMO-001",
      report: "US-DEMO-001",
      truth: "US-DEMO-001",
      branch: "US-DEMO-001",
    },
  };
}

describe("validateCasting — heterogeneity", () => {
  it("accepts the default kimi/reasonix/pi trio (three distinct vendors)", () => {
    const r = validateCasting(DEFAULT_SHOWCASE_CASTING);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("rejects reviewer == builder (collapsed casting)", () => {
    const r = validateCasting({ builder: "kimi", reviewer: "kimi", scorer: "pi" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("reviewer-equals-builder");
  });

  it("rejects scorer == builder (collapsed casting)", () => {
    const r = validateCasting({ builder: "kimi", reviewer: "claude", scorer: "kimi" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("scorer-equals-builder");
  });

  it("rejects provider aliases that collapse to the same vendor", () => {
    const r = validateCasting({ builder: "codex", reviewer: "openai", scorer: "pi" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("reviewer-not-hetero");
  });

  it("rejects an empty slot", () => {
    const r = validateCasting({ builder: "kimi", reviewer: "", scorer: "pi" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("empty-slot");
  });
});

describe("castingAgentsYaml — builder routing override", () => {
  it("pins all three executor slots to the builder so the loop routes to it", () => {
    const yaml = castingAgentsYaml({ builder: "kimi", reviewer: "reasonix", scorer: "pi" });
    expect(yaml).toContain("schema: v3");
    expect(yaml).toContain("easy: { agent: kimi }");
    expect(yaml).toContain("default: { agent: kimi }");
    expect(yaml).toContain("hard: { agent: kimi }");
    // The reviewer/scorer are recorded in a comment, not as executor slots.
    expect(yaml).toContain("reviewer=reasonix scorer=pi");
  });
});

describe("assembleEvidenceChain — from a fixture run-result", () => {
  it("a golden run satisfies every link", () => {
    const chain = assembleEvidenceChain(goldenRun());
    expect(chain.links.every((l) => l.present)).toBe(true);
    expect(chain.sameNumber).toBe("US-DEMO-001");
  });

  it("a TCR commit without a test-pass proof does NOT satisfy the tcr link", () => {
    const run = goldenRun();
    run.tcrCommits = [{ sha: "x", subject: "tcr: code", testPass: false }];
    const chain = assembleEvidenceChain(run);
    expect(chain.links.find((l) => l.key === "tcr-commits")?.present).toBe(false);
  });

  it("a skipped CLI screenshot is recorded honestly (present:false, reason)", () => {
    const run = goldenRun();
    run.screenshots = [
      { surface: "cli", path: "/tmp/cli.png", present: false, skipped: "no GUI session" },
      { surface: "web", path: "/tmp/web.png", present: true },
    ];
    const chain = assembleEvidenceChain(run);
    const cli = chain.links.find((l) => l.key === "cli-screenshot");
    expect(cli?.present).toBe(false);
    expect(cli?.detail).toContain("no GUI session");
  });

  it("attest gate SKIP/FAIL does NOT satisfy the gate link (only PASS does)", () => {
    const run = goldenRun();
    run.attest = { gate: "SKIP" };
    const chain = assembleEvidenceChain(run);
    expect(chain.links.find((l) => l.key === "attest-gate")?.present).toBe(false);
  });

  it("a non-Done backlog status does NOT satisfy the done link", () => {
    const run = goldenRun();
    run.backlogStatus = "📋 Todo";
    const chain = assembleEvidenceChain(run);
    expect(chain.links.find((l) => l.key === "backlog-done")?.present).toBe(false);
  });

  it("truth ladder below attested does NOT satisfy the truth link", () => {
    const run = goldenRun();
    run.truthLadder = "merged";
    const chain = assembleEvidenceChain(run);
    expect(chain.links.find((l) => l.key === "truth-attested")?.present).toBe(false);
  });

  it("the same-number link fails when surfaces disagree", () => {
    const run = goldenRun();
    run.sameNumber = { backlog: "US-DEMO-001", report: "US-DEMO-002", truth: "US-DEMO-001" };
    const chain = assembleEvidenceChain(run);
    const sn = chain.links.find((l) => l.key === "same-number");
    expect(sn?.present).toBe(false);
    expect(sn?.detail).toContain("disagree");
    expect(chain.sameNumber).toBeUndefined();
  });

  it("the same-number link fails when fewer than two surfaces recorded a number", () => {
    const run = goldenRun();
    run.sameNumber = { backlog: "US-DEMO-001" };
    const chain = assembleEvidenceChain(run);
    expect(chain.links.find((l) => l.key === "same-number")?.present).toBe(false);
  });

  it("a collapsed casting fails the casting link", () => {
    const run = goldenRun();
    run.casting = { builder: "kimi", reviewer: "kimi", scorer: "pi" };
    const chain = assembleEvidenceChain(run);
    expect(chain.links.find((l) => l.key === "casting-heterogeneous")?.present).toBe(false);
  });
});

describe("showcaseVerdict", () => {
  it("PASS only when every link is present", () => {
    const v = showcaseVerdict(assembleEvidenceChain(goldenRun()));
    expect(v.pass).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.present).toBe(v.total);
    expect(v.summary).toContain("PASS");
  });

  it("FAIL with the missing link keys when any link is absent", () => {
    const run = goldenRun();
    run.attest = { gate: "FAIL" };
    run.backlogStatus = "📋 Todo";
    const v = showcaseVerdict(assembleEvidenceChain(run));
    expect(v.pass).toBe(false);
    expect(v.missing.map((m) => m.key)).toEqual(expect.arrayContaining(["attest-gate", "backlog-done"]));
    expect(v.summary).toContain("FAIL");
  });

  it("FAIL on an empty chain (defensive — never a vacuous PASS)", () => {
    const v = showcaseVerdict({ links: [], sameNumber: undefined });
    expect(v.pass).toBe(false);
  });
});

describe("probeMissingAgents — queries the REAL env, not the sandbox (FIX-292)", () => {
  const casting = { ...DEFAULT_SHOWCASE_CASTING }; // kimi / reasonix / pi

  /** A runner that records the options it was invoked with and returns a canned `agent list`. */
  function recordingRunner(stdout: string, code = 0): {
    runner: (s: string, h: string, args: string[], opts?: RunRollOptions) => SubResult;
    calls: { args: string[]; opts?: RunRollOptions }[];
  } {
    const calls: { args: string[]; opts?: RunRollOptions }[] = [];
    const runner = (_s: string, _h: string, args: string[], opts?: RunRollOptions): SubResult => {
      calls.push({ args, ...(opts !== undefined ? { opts } : {}) });
      return { code, stdout, stderr: "" };
    };
    return { runner, calls };
  }

  it("probes `roll agent list` with {realHome:true} — NOT the throwaway sandbox home", () => {
    const { runner, calls } = recordingRunner("reasonix\nkimi\npi\n");
    probeMissingAgents("/sandbox", "/throwaway-home", casting, runner);
    expect(calls.length).toBe(1);
    expect(calls[0]?.args).toEqual(["agent", "list"]);
    // The whole point of the fix: availability is a machine fact, so the probe
    // must run against the real ROLL_HOME, never the empty sandbox home.
    expect(calls[0]?.opts?.realHome).toBe(true);
  });

  // ANSI color escapes, exactly as agentListCommand emits them.
  const G = "\x1b[0;32m"; // green (installed)
  const Y = "\x1b[0;33m"; // yellow (not installed)
  const NC = "\x1b[0m";

  it("when the cast trio IS available in the real env, nothing is missing (no false abort)", () => {
    // The real `roll agent list` lists reasonix / kimi / pi with a ✓ marker.
    const { runner } = recordingRunner(
      `  Available agents\n\n    ${G}✓ reasonix${NC}\n    ${G}✓ kimi${NC}\n    ${G}✓ pi${NC}\n`,
    );
    expect(probeMissingAgents("/sandbox", "/throwaway-home", casting, runner)).toEqual([]);
  });

  it("a GENUINELY-missing cast agent fails loud (reported as missing)", () => {
    // pi is NOT installed (✗ … not installed) in the real env → only pi is reported missing.
    const { runner } = recordingRunner(
      `  Available agents\n\n    ${G}✓ reasonix${NC}\n    ${G}✓ kimi${NC}\n    ${Y}✗ pi${NC}  (not installed)\n`,
    );
    expect(probeMissingAgents("/sandbox", "/throwaway-home", casting, runner)).toEqual(["pi"]);
  });

  it("an empty real env (the OLD sandbox-home bug) would report all cast agents missing", () => {
    // This is exactly the false-abort the fix avoids: probing an EMPTY home lists
    // zero agents. The probe must NOT do this (it uses realHome), but if the real
    // env genuinely has no agents, fail loud — never fabricate availability.
    const { runner } = recordingRunner("", 1);
    expect(probeMissingAgents("/sandbox", "/throwaway-home", casting, runner)).toEqual([
      "kimi",
      "reasonix",
      "pi",
    ]);
  });

  // FIX-299 — the probe MISPARSED the real, colored, marker-bearing output and
  // reported installed agents as missing. This pins the real format end-to-end.
  it("FIX-299: parses the REAL colored ✓/✗ output — installed cast agents are NOT flagged missing", () => {
    // The exact shape `roll agent list` prints: ANSI color codes, ✓ for installed,
    // ✗  …  (not installed) for absent, "(current)" on the active agent, and a
    // localized header (here zh, as on the reporter's box).
    const realOutput =
      `\n  可用 agent\n\n` +
      `    ${G}✓ reasonix${NC}\n` +
      `    ${G}✓ claude${NC}  (current)\n` +
      `    ${G}✓ kimi${NC}\n` +
      `    ${Y}✗ deepseek${NC}  (not installed)\n` +
      `    ${G}✓ codex${NC}\n` +
      `    ${G}✓ openai${NC}\n` +
      `    ${G}✓ pi${NC}\n` +
      `    ${Y}✗ qwen${NC}  (not installed)\n` +
      `    ${G}✓ antigravity (agy)${NC}\n\n`;
    const { runner } = recordingRunner(realOutput);
    // kimi / reasonix / pi are ALL ✓ available → none reported missing (the bug).
    expect(probeMissingAgents("/sandbox", "/throwaway-home", casting, runner)).toEqual([]);

    // deepseek is a pi alias now, so the installed canonical pi row makes it available.
    const deepseekAliasCast = { builder: "kimi", reviewer: "claude", scorer: "deepseek" };
    expect(probeMissingAgents("/sandbox", "/throwaway-home", deepseekAliasCast, runner)).toEqual([]);

    // A genuinely ✗ (not installed) cast agent IS reported missing.
    const qwenCast = { builder: "kimi", reviewer: "claude", scorer: "qwen" };
    expect(probeMissingAgents("/sandbox", "/throwaway-home", qwenCast, runner)).toEqual(["qwen"]);
  });

  it("FIX-299: parseAvailableAgents reads ✓/✗ markers, strips ANSI, takes the first word", () => {
    const realOutput =
      `\n  可用 agent\n\n` +
      `    ${G}✓ claude${NC}  (current)\n` +
      `    ${G}✓ kimi${NC}\n` +
      `    ${Y}✗ deepseek${NC}  (not installed)\n` +
      `    ${G}✓ pi${NC}\n` +
      `    ${G}✓ reasonix${NC}\n`;
    const available = parseAvailableAgents(realOutput);
    // ✓ rows are available; the token is the first word (canonicalAgentName is a no-op).
    expect(available.has("claude")).toBe(true);
    expect(available.has("kimi")).toBe(true);
    expect(available.has("pi")).toBe(true);
    expect(available.has("reasonix")).toBe(true);
    // ✗ "not installed" alias rows are NOT available by themselves; the canonical pi row is.
    expect(available.has("deepseek")).toBe(false);
    expect(available.has("pi")).toBe(true);
  });
});

describe("resetSandbox — already-Todo is a benign success, not a failure (FIX-292)", () => {
  function sandboxWithBacklog(backlog: string): string {
    const root = mkdtempSync(join(tmpdir(), "roll-showcase-reset-"));
    mkdirSync(join(root, ".roll"), { recursive: true });
    writeFileSync(join(root, ".roll", "backlog.md"), backlog, "utf8");
    return root;
  }

  it("flipping a Done card back to Todo is ok (and records the flip)", () => {
    const sandbox = sandboxWithBacklog("| US-DEMO-001 | demo | ✅ Done |\n");
    const r = resetSandbox(sandbox, "US-DEMO-001");
    expect(r.ok).toBe(true);
    expect(r.reset).toBe(true);
    expect(readFileSync(join(sandbox, ".roll", "backlog.md"), "utf8")).toContain("📋 Todo");
  });

  it("a card ALREADY Todo is ok (benign no-op), NOT a failure", () => {
    const sandbox = sandboxWithBacklog("| US-DEMO-001 | demo | 📋 Todo |\n");
    const r = resetSandbox(sandbox, "US-DEMO-001");
    expect(r.ok).toBe(true); // <- the fix: already-Todo must not mark the step ✗
    expect(r.reset).toBe(false); // nothing physically flipped
    expect(r.notes.join(" ")).toContain("already Todo");
  });

  it("a card row with no recognizable status token is NOT ok (genuinely can't reset)", () => {
    const sandbox = sandboxWithBacklog("| US-DEMO-001 | demo | someday |\n");
    const r = resetSandbox(sandbox, "US-DEMO-001");
    expect(r.ok).toBe(false);
  });

  // FIX-300: status markers are single-source. The reset must recognize BOTH the
  // canonical 🚫 Hold (which the old divergent regex was blind to → "no status
  // token") AND the legacy markers, flipping each to canonical 📋 Todo.
  it("recognizes the canonical 🚫 Hold marker the old divergent reset missed", () => {
    const sandbox = sandboxWithBacklog("| US-DEMO-001 | demo | 🚫 Hold (parked) |\n");
    const r = resetSandbox(sandbox, "US-DEMO-001");
    expect(r.ok).toBe(true);
    expect(r.reset).toBe(true);
    expect(r.notes.join(" ")).not.toContain("no status token");
    const after = readFileSync(join(sandbox, ".roll", "backlog.md"), "utf8");
    expect(after).toContain("📋 Todo");
    expect(after).not.toContain("🚫 Hold");
  });

  it("tolerates legacy markers (🚧 WIP / 🔄 In Progress / ⏳ Hold / ✔️ Done) → 📋 Todo", () => {
    for (const legacy of ["🚧 WIP", "🔄 In Progress", "⏳ Hold", "✔️ Done"]) {
      const sandbox = sandboxWithBacklog(`| US-DEMO-001 | demo | ${legacy} |\n`);
      const r = resetSandbox(sandbox, "US-DEMO-001");
      expect(r.ok, legacy).toBe(true);
      expect(r.reset, legacy).toBe(true);
      const after = readFileSync(join(sandbox, ".roll", "backlog.md"), "utf8");
      expect(after, legacy).toContain("📋 Todo");
      expect(after, legacy).not.toContain(legacy);
    }
  });

  it("FIX-1475: resets ONLY the exact card — a `<id>-` descendant row is untouched", () => {
    const sandbox = sandboxWithBacklog(
      "| US-DEMO-001 | demo | ✅ Done |\n| US-DEMO-001-legacy | sibling | ✅ Done |\n",
    );
    const r = resetSandbox(sandbox, "US-DEMO-001");
    expect(r.ok).toBe(true);
    expect(r.reset).toBe(true);
    const after = readFileSync(join(sandbox, ".roll", "backlog.md"), "utf8");
    // The exact card flipped to Todo …
    expect(after).toContain("| US-DEMO-001 | demo | 📋 Todo |");
    // … the descendant (substring `line.includes` would have hit) stays Done.
    expect(after).toContain("| US-DEMO-001-legacy | sibling | ✅ Done |");
  });

  it("FIX-1475: readBacklogStatus reads only the exact card, not a descendant", () => {
    const sandbox = sandboxWithBacklog(
      "| US-DEMO-001 | demo | 📋 Todo |\n| US-DEMO-001-legacy | sibling | ✅ Done |\n",
    );
    // Resetting US-DEMO-001 (already Todo) must not be confused by the Done sibling.
    const r = resetSandbox(sandbox, "US-DEMO-001");
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toContain("already Todo");
  });
});
