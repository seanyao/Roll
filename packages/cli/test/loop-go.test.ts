import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPendingDeliveryEvidenceManifest, parsePeerReviewTranscript, writePendingDeliveryEvidenceManifest } from "@roll/core";
import { parseGoalYaml, renderGoalYaml, type RollGoal } from "@roll/spec";
import { buildRunOnceChildEnv, classifyBootstrapArtifacts, deliveryGateStopDetails, hasSafetyPauseSince, loopGoCommand, planGoTmuxCommands, spawnFinalReviewAgent, type LoopGoDeps } from "../src/commands/loop-go.js";
import { GOAL_GUIDED_ENV } from "../src/lib/goal-progress.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function project(): string {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-go-")));
  dirs.push(p);
  mkdirSync(join(p, ".roll", "loop"), { recursive: true });
  return p;
}

function commitBacklog(p: string): void {
  execSync("git add .roll/backlog.md && git commit -qm backlog", {
    cwd: p,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (err.push(String(c)), true);
  return fn()
    .then((code) => ({ code, out: out.join(""), err: err.join("") }))
    .finally(() => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    });
}

function readEvents(p: string): Array<Record<string, unknown>> {
  return readFileSync(join(p, ".roll", "loop", "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeBacklog(p: string, rows: string[]): void {
  mkdirSync(join(p, ".roll"), { recursive: true });
  writeFileSync(
    join(p, ".roll", "backlog.md"),
    ["| ID | Title | Status |", "|---|---|---|", ...rows].join("\n") + "\n",
  );
}

function writeIndex(p: string, stories: Record<string, string>): void {
  writeFileSync(join(p, ".roll", "index.json"), `${JSON.stringify({ stories }, null, 2)}\n`);
}

function completeGoalDeps(p: string, review?: NonNullable<LoopGoDeps["finalReview"]>): LoopGoDeps {
  let calls = 0;
  const deps: LoopGoDeps = {
    identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
    pid: () => 12345,
    nowSec: () => 1_780_000_000 + calls,
    nowIso: () => `2026-06-11T10:00:0${calls}Z`,
    hasTmux: () => false,
    startTmux: () => false,
    prEvidence: () => Promise.resolve({ state: "MERGED", mergedAtSec: 1_779_999_000 }),
    runOnce: async ({ projectPath }) => {
      calls += 1;
      writeFileSync(
        join(projectPath, ".roll", "loop", "events.ndjson"),
        `${JSON.stringify({ type: "cycle:start", cycleId: `cycle-${calls}`, storyId: "US-DONE", agent: "", model: "", ts: 1_780_000_000 + calls })}\n`,
        { flag: "a" },
      );
      writeFileSync(
        join(projectPath, ".roll", "loop", "runs.jsonl"),
        `${JSON.stringify({ story_id: "US-DONE", cycle_id: `cycle-${calls}`, ts: `2026-06-11T10:00:0${calls}Z`, agent: "claude", status: "done" })}\n`,
        { flag: "a" },
      );
      return 0;
    },
  };
  if (review !== undefined) deps.finalReview = review;
  return deps;
}

const approveFinalReview: NonNullable<LoopGoDeps["finalReview"]> = async () => ({
  effectiveMode: "hetero",
  reviewer: "codex",
  provider: "openai",
  verdict: "APPROVE",
  reason: "accepted",
  findings: [],
});

describe("US-GOAL-002 — roll loop go", () => {
  it("FIX-1254: archives a complete goal and creates a fresh scoped goal", async () => {
    const p = project();
    const oldGoal: RollGoal = {
      schema: "goal.v1",
      scope: { kind: "cards", cards: ["FIX-OLD"] },
      review: { mode: "auto" },
      limits: {},
      status: "complete",
      usage: { cycles: 1, costUsd: 0 },
      createdAt: "2026-06-10T10:00:00Z",
      updatedAt: "2026-06-10T10:01:00Z",
    };
    writeFileSync(join(p, ".roll", "loop", "goal.yaml"), renderGoalYaml(oldGoal));
    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-NEXT", "--max-cycles", "0"], completeGoalDeps(p)));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.scope).toEqual({ kind: "cards", cards: ["FIX-NEXT"] });
    const archiveDir = join(p, ".roll", "loop", "goal-archive");
    const archived = readdirSync(archiveDir);
    expect(archived).toHaveLength(1);
    expect(parseGoalYaml(readFileSync(join(archiveDir, archived[0]!), "utf8"))).toEqual(oldGoal);
    const events = readEvents(p);
    expect(events.some((event) => event.type === "goal:archived" && event.scope.kind === "cards" && event.scope.cards[0] === "FIX-OLD")).toBe(true);
    expect(events.some((event) => event.type === "goal:created" && event.status === "active" && event.scope.kind === "cards" && event.scope.cards[0] === "FIX-NEXT")).toBe(true);
  });

  it("FIX-1254: starts a fresh all-scope goal after completion when scope is omitted", async () => {
    const p = project();
    const oldGoal: RollGoal = {
      schema: "goal.v1",
      scope: { kind: "epic", epic: "old-epic" },
      review: { mode: "auto" },
      limits: {},
      status: "complete",
      usage: { cycles: 1, costUsd: 0 },
      createdAt: "2026-06-10T10:00:00Z",
      updatedAt: "2026-06-10T10:01:00Z",
    };
    writeFileSync(join(p, ".roll", "loop", "goal.yaml"), renderGoalYaml(oldGoal));

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "0"], completeGoalDeps(p)));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.scope).toEqual({ kind: "all" });
    expect(readEvents(p).some((event) => event.type === "goal:created" && event.status === "active" && event.scope.kind === "all")).toBe(true);
  });

  it("prints help for review modes without starting a session", async () => {
    const p = project();
    const r = await capture(() => loopGoCommand(["--help"], completeGoalDeps(p)));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: roll loop go");
    expect(r.out).toContain("--for <duration>");
    expect(r.out).toContain("--max-cycles <n>");
    // The cost/usage CONTROL flags are gone — the loop stops on NO PROGRESS.
    expect(r.out).not.toContain("--budget");
    expect(r.out).not.toContain("--usage-threshold");
    expect(r.out).not.toContain("--no-wait");
    expect(r.out).toContain("Progress guardrails");
    expect(r.out).toContain("dead-loop breaker");
    expect(r.out).toContain("--review <mode>");
    expect(r.out).toContain("hetero");
    expect(r.out).toContain("goal:final_review SKIPPED");
    expect(existsSync(join(p, ".roll", "loop", "goal.yaml"))).toBe(false);
    expect(r.err).toBe("");
  });

  it("fails loud for an invalid --for duration before starting a session", async () => {
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ["--worker", "--for", "never"], message: "--for must be a duration" },
    ];

    for (const item of cases) {
      const p = project();
      let identityCalls = 0;
      const deps: LoopGoDeps = {
        ...completeGoalDeps(p),
        identity: () => {
          identityCalls += 1;
          return Promise.resolve({ path: p, slug: "proj-abc123" });
        },
      };

      await expect(loopGoCommand(item.args, deps)).rejects.toThrow(item.message);
      expect(identityCalls).toBe(0);
      expect(existsSync(join(p, ".roll", "loop", "goal.yaml"))).toBe(false);
    }
  });

  it("FIX-1072: bootstrap-only dirty artifacts pause before runOnce and do not count no-progress", async () => {
    const p = project();
    execSync("git init -q", { cwd: p });
    writeBacklog(p, [
      "| [FIX-BOOT](.roll/features/loop-engine/FIX-BOOT/spec.md) | boot | 📋 Todo |",
    ]);
    writeFileSync(join(p, "AGENTS.md"), "# project rules\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_100,
      nowIso: () => "2026-06-11T10:01:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-BOOT", "--max-cycles", "3"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0);
    expect(r.out).toContain("bootstrap_artifacts_unconfirmed");
    expect(r.out).toContain("ALERT reason: bootstrap_artifacts_unconfirmed");
    expect(r.out).toContain("AGENTS.md");
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toBe("bootstrap_artifacts_unconfirmed");
    expect(goal.progress?.noProgressCycles).toBeUndefined();
    const events = readEvents(p);
    expect(events.some((e) => e.type === "cycle:start")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "goal:gate_tripped" &&
          e.reason === "bootstrap_artifacts_unconfirmed" &&
          typeof (e.reading as Record<string, unknown> | undefined)?.reasonLine === "string" &&
          String((e.reading as Record<string, unknown>).reasonLine).includes("ALERT reason: bootstrap_artifacts_unconfirmed"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.reason === "no_progress_breaker")).toBe(false);
  });

  it("FIX-1272: manifest-verified cycle writeback files do not trip the bootstrap preflight", async () => {
    const p = project();
    execSync("git init -q", { cwd: p });
    mkdirSync(join(p, ".roll", "features", "loop-engine", "FIX-1221"), { recursive: true });
    writeBacklog(p, [
      "| [FIX-1221](.roll/features/loop-engine/FIX-1221/spec.md) | writeback | 📋 Todo |",
    ]);
    writeFileSync(join(p, ".roll", "features.md"), "# Features\n\n- FIX-1221 Todo\n");
    writeFileSync(join(p, ".roll", "features", "loop-engine", "FIX-1221", "spec.md"), "# FIX-1221\n\n- [ ] AC\n");
    execSync("git add .roll/backlog.md .roll/features.md .roll/features/loop-engine/FIX-1221/spec.md && git commit -qm init", {
      cwd: p,
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
    });
    writeBacklog(p, [
      "| [FIX-1221](.roll/features/loop-engine/FIX-1221/spec.md) | writeback | ✅ Done |",
    ]);
    writeFileSync(join(p, ".roll", "features.md"), "# Features\n\n- FIX-1221 Done\n");
    writeFileSync(join(p, ".roll", "features", "loop-engine", "FIX-1221", "spec.md"), "# FIX-1221\n\n- [x] AC\n");
    // The runner records a per-cycle manifest hashing the writeback it just
    // committed to the PR branch; the gate verifies those exact files by hash.
    writePendingDeliveryEvidenceManifest(
      p,
      buildPendingDeliveryEvidenceManifest({
        cycleId: "cycle-writeback",
        storyId: "FIX-1221",
        branch: "loop/cycle-writeback",
        repositoryRoot: p,
        files: [
          { path: ".roll/backlog.md", kind: "dossier" },
          { path: ".roll/features.md", kind: "dossier" },
          { path: ".roll/features/loop-engine/FIX-1221/spec.md", kind: "dossier" },
        ],
      }),
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_250 + calls,
      nowIso: () => `2026-06-11T10:02:5${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-1221", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    expect(r.out).not.toContain("bootstrap_artifacts_unconfirmed");
    expect(readEvents(p).some((e) => e.type === "goal:gate_tripped" && e.reason === "bootstrap_artifacts_unconfirmed")).toBe(false);
  });

  it("FIX-1072: mixed product-code dirt is not hidden behind the bootstrap-artifact preflight", async () => {
    const p = project();
    execSync("git init -q", { cwd: p });
    writeBacklog(p, [
      "| [FIX-MIXED](.roll/features/loop-engine/FIX-MIXED/spec.md) | mixed | 📋 Todo |",
    ]);
    writeFileSync(join(p, "AGENTS.md"), "# project rules\n");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "app.ts"), "export const x = 1;\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_200 + calls,
      nowIso: () => `2026-06-11T10:02:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-MIXED", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    expect(r.out).not.toContain("bootstrap_artifacts_unconfirmed");
  });

  it("FIX-1072: bootstrap artifact classifier is narrow", () => {
    expect(classifyBootstrapArtifacts(["AGENTS.md", ".roll/backlog.md", ".claude/CLAUDE.md"])).toMatchObject({
      kind: "bootstrap_only",
    });
    expect(classifyBootstrapArtifacts(["AGENTS.md", "src/app.ts"])).toMatchObject({ kind: "mixed" });
    expect(classifyBootstrapArtifacts([])).toMatchObject({ kind: "none" });
  });

  it("FIX-1272: verified pending-delivery evidence does not pause an unrelated eligible card", async () => {
    const p = project();
    execSync("git init -q", { cwd: p });
    const run = ".roll/features/organization/US-ORG-004/20260703-010203-1";
    mkdirSync(join(p, run, "screenshots"), { recursive: true });
    writeFileSync(join(p, run, "US-ORG-004-review.html"), "<html>review</html>");
    writeFileSync(join(p, run, "screenshots", "proof.png"), "PNGDATA");
    writeBacklog(p, ["| [US-CAP-011](.roll/features/cap/US-CAP-011/spec.md) | cap | 📋 Todo |"]);
    commitBacklog(p); // backlog is clean; only the untracked evidence is dirty
    // Runner-written manifest for the still-open US-ORG-004 PR evidence.
    writePendingDeliveryEvidenceManifest(
      p,
      buildPendingDeliveryEvidenceManifest({
        cycleId: "cycle-org",
        storyId: "US-ORG-004",
        branch: "loop/cycle-org",
        repositoryRoot: p,
        files: [
          { path: `${run}/US-ORG-004-review.html`, kind: "report" },
          { path: `${run}/screenshots/proof.png`, kind: "screenshot" },
        ],
      }),
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_400 + calls,
      nowIso: () => `2026-06-11T10:03:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-CAP-011", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1); // US-CAP-011 dispatched, not paused
    expect(r.out).not.toContain("bootstrap_artifacts_unconfirmed");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.reason === "bootstrap_artifacts_verified")).toBe(true);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.reason === "bootstrap_artifacts_unconfirmed")).toBe(false);
  });

  it("FIX-1272: an unmanifested .roll file pauses even beside verified evidence, and is named", async () => {
    const p = project();
    execSync("git init -q", { cwd: p });
    const run = ".roll/features/organization/US-ORG-004/20260703-010203-1";
    mkdirSync(join(p, run), { recursive: true });
    writeFileSync(join(p, run, "US-ORG-004-review.html"), "<html/>");
    writeFileSync(join(p, ".roll", "features", "organization", "US-ORG-004", "manual.txt"), "hand-written");
    writeBacklog(p, ["| [US-CAP-011](.roll/features/cap/US-CAP-011/spec.md) | cap | 📋 Todo |"]);
    commitBacklog(p);
    writePendingDeliveryEvidenceManifest(
      p,
      buildPendingDeliveryEvidenceManifest({
        cycleId: "cycle-org",
        storyId: "US-ORG-004",
        branch: "loop/cycle-org",
        repositoryRoot: p,
        files: [{ path: `${run}/US-ORG-004-review.html`, kind: "report" }],
      }),
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_500,
      nowIso: () => "2026-06-11T10:04:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-CAP-011", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0); // paused, not dispatched
    expect(r.out).toContain("bootstrap_artifacts_unconfirmed");
    expect(r.out).toContain(".roll/features/organization/US-ORG-004/manual.txt");
    // The verified review file is NOT listed as unconfirmed.
    expect(r.out).not.toContain("US-ORG-004-review.html");
  });

  it("FIX-1272: product dirt beyond a 50-item display cap is not hidden (full-list classification)", async () => {
    const p = project();
    execSync("git init -q", { cwd: p });
    // 60 verified evidence files ...
    const run = ".roll/features/x/run";
    mkdirSync(join(p, run), { recursive: true });
    const evFiles: Array<{ path: string; kind: "evidence" }> = [];
    for (let i = 0; i < 60; i += 1) {
      const rel = `${run}/f${i}.json`;
      writeFileSync(join(p, rel), `data-${i}`);
      evFiles.push({ path: rel, kind: "evidence" });
    }
    // ... plus a product file that the old .slice(0,50) would have hidden.
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "late.ts"), "export const late = 1;\n");
    writeBacklog(p, ["| [FIX-X](.roll/features/x/spec.md) | x | 📋 Todo |"]);
    commitBacklog(p);
    writePendingDeliveryEvidenceManifest(
      p,
      buildPendingDeliveryEvidenceManifest({
        cycleId: "cycle-x",
        storyId: "FIX-X",
        branch: "loop/cycle-x",
        repositoryRoot: p,
        files: evFiles,
      }),
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_600 + calls,
      nowIso: () => `2026-06-11T10:05:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-X", "--max-cycles", "1"], deps));

    // Product dirt is present → mixed → the cycle runs (not a bootstrap pause),
    // and the classifier saw src/late.ts despite it being the 61st dirty entry.
    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    expect(r.out).not.toContain("bootstrap_artifacts_unconfirmed");
  });

  it("FIX-1272: an --ignore-dirty style flag never bypasses the gate", async () => {
    // No trust-all switch exists: an unknown/permissive flag must not make the
    // gate accept unmanifested .roll pollution. The card still pauses.
    const p = project();
    execSync("git init -q", { cwd: p });
    mkdirSync(join(p, ".roll", "features", "x"), { recursive: true });
    writeFileSync(join(p, ".roll", "features", "x", "unowned.txt"), "junk");
    writeBacklog(p, ["| [FIX-X](.roll/features/x/spec.md) | x | 📋 Todo |"]);
    commitBacklog(p);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_700,
      nowIso: () => "2026-06-11T10:06:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };
    const r = await capture(() =>
      loopGoCommand(["--worker", "--cards", "FIX-X", "--max-cycles", "1", "--ignore-dirty", "--trust-all"], deps),
    );
    expect(calls).toBe(0);
    expect(r.out).toContain("bootstrap_artifacts_unconfirmed");
    expect(r.out).toContain("no --ignore-dirty or trust-all bypass");
  });

  it("FIX-1272: only manifest-hash-verified Roll evidence is accepted; a generic .roll path stays gated", () => {
    const p = project();
    const relEvidence = ".roll/features/loop-engine/FIX-1272/20260703-010203-1/evidence.json";
    const relPng = ".roll/features/loop-engine/FIX-1272/20260703-010203-1/screenshots/proof.png";
    mkdirSync(join(p, ".roll", "features", "loop-engine", "FIX-1272", "20260703-010203-1", "screenshots"), { recursive: true });
    writeFileSync(join(p, relEvidence), '{"ok":true}');
    writeFileSync(join(p, relPng), "PNGDATA");
    const manifest = buildPendingDeliveryEvidenceManifest({
      cycleId: "c1",
      storyId: "FIX-1272",
      branch: "loop/cycle-c1",
      repositoryRoot: p,
      files: [
        { path: relEvidence, kind: "evidence" },
        { path: relPng, kind: "screenshot" },
      ],
    });

    // Verified evidence does not appear in `files` and does not pause.
    expect(classifyBootstrapArtifacts([relEvidence, relPng], [manifest], p)).toMatchObject({
      kind: "none",
      files: [],
    });

    // A generic .roll path with NO manifest entry fails closed (scorer focus).
    expect(classifyBootstrapArtifacts([".roll/features/loop-engine/FIX-1272/manual.txt"], [manifest], p)).toMatchObject({
      kind: "bootstrap_only",
      files: [".roll/features/loop-engine/FIX-1272/manual.txt"],
    });

    // Tampering after the manifest (hash mismatch) fails closed.
    writeFileSync(join(p, relEvidence), "TAMPERED");
    expect(classifyBootstrapArtifacts([relEvidence], [manifest], p)).toMatchObject({
      kind: "bootstrap_only",
      files: [relEvidence],
    });

    expect(classifyBootstrapArtifacts(["AGENTS.md"], [manifest], p)).toMatchObject({ kind: "bootstrap_only", files: ["AGENTS.md"] });
  });

  it("FIX-1455: a valid browser audit ledger coexists with the gate (does not pause)", () => {
    const p = project();
    const ledger = ".roll/browser-operations/events.ndjson";
    mkdirSync(join(p, ".roll", "browser-operations"), { recursive: true });
    writeFileSync(join(p, ledger), '{"e":"approve"}\n{"e":"capture"}\n');

    // A valid ndjson ledger is owned (runtimeLedger) → no pause.
    expect(classifyBootstrapArtifacts([ledger], [], p)).toMatchObject({
      kind: "none",
      files: [],
      runtimeLedger: [ledger],
    });

    // An unrelated unknown .roll path alongside the ledger still fails closed.
    mkdirSync(join(p, ".roll", "features"), { recursive: true });
    writeFileSync(join(p, ".roll", "features", "x-pollute.txt"), "junk");
    expect(classifyBootstrapArtifacts([ledger, ".roll/features/x-pollute.txt"], [], p)).toMatchObject({
      kind: "bootstrap_only",
      files: [".roll/features/x-pollute.txt"],
      runtimeLedger: [ledger],
    });

    // A replaced/corrupted ledger (non-ndjson) is rejected — no trust-all bypass.
    writeFileSync(join(p, ledger), "not json\n");
    expect(classifyBootstrapArtifacts([ledger], [], p)).toMatchObject({
      kind: "bootstrap_only",
      files: [ledger],
    });
  });

  it("FIX-1272: a mixed checkout reports verified + external and is not called bootstrap-only", () => {
    const p = project();
    const rel = ".roll/features/loop-engine/FIX-1272/run/report.html";
    mkdirSync(join(p, ".roll", "features", "loop-engine", "FIX-1272", "run"), { recursive: true });
    writeFileSync(join(p, rel), "<html/>");
    writeFileSync(join(p, "package.json"), "{}\n");
    const manifest = buildPendingDeliveryEvidenceManifest({
      cycleId: "c1",
      storyId: "FIX-1272",
      branch: "loop/cycle-c1",
      repositoryRoot: p,
      files: [{ path: rel, kind: "report" }],
    });
    const c = classifyBootstrapArtifacts([rel, "package.json"], [manifest], p);
    expect(c.kind).toBe("mixed");
    expect(c.verified).toEqual([rel]);
    expect(c.external).toEqual(["package.json"]);
  });

  it("runs cycles back-to-back until a pause marker, then pauses the goal at the cycle boundary", async () => {
    const p = project();
    let calls = 0;
    let externalToolChecks = 0;
    let chromiumPreinstalls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T08:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      externalTools: () => {
        externalToolChecks += 1;
      },
      // FIX-394 AC2 is stubbed here so the test never triggers a real
      // `npx playwright install` (a 5-minute subprocess) on the loop path.
      preinstallChromium: () => {
        chromiumPreinstalls += 1;
      },
      runOnce: async ({ projectPath }) => {
        calls += 1;
        const rt = join(projectPath, ".roll", "loop");
        const cycle = `cycle-${calls}`;
        writeFileSync(
          join(rt, "events.ndjson"),
          `${JSON.stringify({ type: "cycle:start", cycleId: cycle, storyId: `US-${calls}`, agent: "claude", model: "m", ts: 1_780_000_000 + calls })}\n` +
            `${JSON.stringify({ type: "cycle:end", cycleId: cycle, outcome: "delivered", cost: { cycleId: cycle, agent: "claude", model: "m", tokensIn: 0, tokensOut: 0, estimatedCost: calls, revertCount: 0, effectiveCost: calls }, ts: 1_780_000_100 + calls })}\n`,
          { flag: "a" },
        );
        writeFileSync(
          join(rt, "runs.jsonl"),
          `${JSON.stringify({ story_id: `US-${calls}`, cycle_id: cycle, ts: `2026-06-11T08:00:0${calls}Z`, cost_usd: calls, cost_effective_usd: calls, status: "done" })}\n`,
          { flag: "a" },
        );
        if (calls === 2) writeFileSync(join(rt, "PAUSE-proj-abc123"), "owner pause\n");
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker"], deps));

    expect(r.code).toBe(0);
    expect(externalToolChecks).toBe(1);
    expect(chromiumPreinstalls).toBe(1);
    expect(calls).toBe(2);
    expect(existsSync(join(p, ".roll", "loop", "go.lock"))).toBe(false);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.scope).toEqual({ kind: "all" });
    expect(goal.usage).toEqual({ cycles: 2, costUsd: 3 });
    expect(goal.lastDecisionReason).toContain("pause");
    const types = readEvents(p).map((e) => e.type);
    expect(types).toContain("goal:created");
    expect(types).toContain("goal:session_start");
    expect(types).toContain("goal:state");
    expect(types).toContain("goal:session_end");
    expect(readEvents(p).find((e) => e.type === "goal:created")).toMatchObject({ review: "auto" });
  });

  it("refuses a second go worker while the go session lock is held", async () => {
    const p = project();
    writeFileSync(join(p, ".roll", "loop", "go.lock"), `${process.pid}:1780000000\n`);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 99999,
      nowSec: () => 1_780_000_001,
      nowIso: () => "2026-06-11T08:00:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0);
    expect(r.out).toContain("go session already active");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:tick_skipped" && e.reason === "go_session_lock")).toBe(true);
  });
});

describe("US-GOAL-003 — goal truth adjudication", () => {
  it("--cards scope completes only through merge-backed story truth", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
      "| [FIX-DONE](.roll/features/goal-mode/FIX-DONE/spec.md) | done | ✅ Done · PR#2 |",
    ]);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T09:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      prEvidence: () => Promise.resolve({ state: "MERGED", mergedAtSec: 1_779_999_000 }),
      finalReview: approveFinalReview,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-DONE", cycle_id: `cycle-${calls}`, ts: `2026-06-11T09:00:0${calls}Z`, cost_usd: 1, cost_effective_usd: 1, status: "done" })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE,FIX-DONE"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
    expect(goal.scope).toEqual({ kind: "cards", cards: ["US-DONE", "FIX-DONE"] });
    expect(goal.lastDecisionReason).toContain("all_delivered");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:evaluated" && e.status === "complete")).toBe(true);
    expect(events.some((e) => e.type === "goal:state" && e.to === "complete" && e.actor === "adjudicator")).toBe(true);
  });

  it("premature Done truth failure never completes the goal", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DRIFT-1](.roll/features/e/US-DRIFT-1/spec.md) | premature done | ✅ Done · PR#10 |",
    ]);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T09:10:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      prEvidence: () => Promise.resolve({ state: "OPEN" }),
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-DRIFT-1", cycle_id: `cycle-${calls}`, ts: `2026-06-11T09:10:0${calls}Z`, cost_usd: 1, status: "done" })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DRIFT-1", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).not.toBe("complete");
    const evaluated = readEvents(p).find((e) => e.type === "goal:evaluated");
    expect(evaluated).toMatchObject({
      status: "continue",
      reason: "blocked:US-DRIFT-1:premature_done",
    });
  });

  it("--epic scope resolves through index.json and ignores other epics", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-A](.roll/features/goal-mode/US-A/spec.md) | a | ✅ Done · PR#1 |",
      "| [US-B](.roll/features/other/US-B/spec.md) | b | 📋 Todo |",
    ]);
    writeIndex(p, { "US-A": "goal-mode", "US-B": "other" });
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T09:20:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      prEvidence: () => Promise.resolve({ state: "MERGED", mergedAtSec: 1_779_999_000 }),
      finalReview: approveFinalReview,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-A", cycle_id: `cycle-${calls}`, ts: `2026-06-11T09:20:0${calls}Z`, status: "done" })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--epic", "goal-mode"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
    expect(goal.scope).toEqual({ kind: "epic", epic: "goal-mode" });
    const evaluated = readEvents(p).find((e) => e.type === "goal:evaluated");
    expect(evaluated).toMatchObject({ total: 1, delivered: 1, status: "complete" });
  });

  it("default all scope completes once no backlog Todo rows remain", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T09:30:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      finalReview: approveFinalReview,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-DONE", cycle_id: `cycle-${calls}`, ts: `2026-06-11T09:30:0${calls}Z`, status: "done" })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
    expect(goal.scope).toEqual({ kind: "all" });
    const evaluated = readEvents(p).find((e) => e.type === "goal:evaluated");
    expect(evaluated).toMatchObject({ total: 0, delivered: 0, status: "complete", reason: "all_delivered" });
  });
});

describe("US-GOAL-004 — no-progress suppression", () => {
  it("skips a scoped card after two zero-delivery attempts and pauses when all scoped cards are skipped", async () => {
    const p = project();
    writeBacklog(p, [
      "| [REFACTOR-048](.roll/features/goal-mode/REFACTOR-048/spec.md) | stale merged card | 📋 Todo |",
    ]);
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T10:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards }) => {
        calls += 1;
        allowed.push(allowedCards);
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({
            story_id: "REFACTOR-048",
            cycle_id: `cycle-${calls}`,
            ts: `2026-06-11T10:00:0${calls}Z`,
            status: "failed",
            outcome: "failed",
            tcr_count: 0,
          })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "REFACTOR-048", "--max-cycles", "5"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(2);
    expect(allowed).toEqual([["REFACTOR-048"], ["REFACTOR-048"]]);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_progress_on_all_cards");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:card_skipped" && e.storyId === "REFACTOR-048")).toBe(true);
    expect(events.some((e) => e.type === "goal:state" && e.to === "paused" && e.reason === "no_progress_on_all_cards")).toBe(true);
    const alert = readFileSync(join(p, ".roll", "loop", "ALERT-proj-abc123.md"), "utf8");
    expect(alert).toContain("REFACTOR-048");
    // Hook 2: the first no-progress cycle is alerted immediately (no 2-hit
    // silence) and the card-skip on the streak threshold is a distinct ALERT.
    expect(alert).toContain("no progress");
    expect(alert).toContain("skipped (no-progress streak)");
  });

  it("passes only unskipped scoped cards to run-once after a card is skipped", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-STUCK](.roll/features/goal-mode/US-STUCK/spec.md) | stuck | 📋 Todo |",
      "| [US-NEXT](.roll/features/goal-mode/US-NEXT/spec.md) | next | 📋 Todo |",
    ]);
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_100 + calls,
      nowIso: () => `2026-06-11T10:10:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards }) => {
        calls += 1;
        allowed.push(allowedCards);
        const story = calls <= 2 ? "US-STUCK" : "US-NEXT";
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({
            story_id: story,
            cycle_id: `cycle-${calls}`,
            ts: `2026-06-11T10:10:0${calls}Z`,
            status: "failed",
            outcome: "failed",
            tcr_count: 0,
          })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-STUCK,US-NEXT", "--max-cycles", "3"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(3);
    expect(allowed[0]).toEqual(["US-STUCK", "US-NEXT"]);
    expect(allowed[1]).toEqual(["US-STUCK", "US-NEXT"]);
    expect(allowed[2]).toEqual(["US-NEXT"]);
  });

  it("FIX-1239: stops when run-once ignores --cards and records a different story", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-1235](.roll/features/loop-engine/FIX-1235/spec.md) | requested | 📋 Todo |",
      "| [FIX-1237](.roll/features/loop-engine/FIX-1237/spec.md) | wrong | 📋 Todo |",
    ]);
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_300 + calls,
      nowIso: () => `2026-06-11T10:03:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards }) => {
        calls += 1;
        allowed.push(allowedCards);
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "FIX-1237", cycle_id: "cycle-wrong", ts: "2026-06-11T10:03:01Z", status: "failed", tcr_count: 0 })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-1235", "--max-cycles", "5"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    expect(allowed).toEqual([["FIX-1235"]]);
    expect(r.out).toContain("scope_mismatch");
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("scope_mismatch");
    expect(goal.lastDecisionReason).toContain("FIX-1237");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.reason === "scope_mismatch")).toBe(true);
    expect(readFileSync(join(p, ".roll", "loop", "ALERT-proj-abc123.md"), "utf8")).toContain("picked out-of-scope card FIX-1237");
  });

  it("FIX-1239: refuses autonomous work when the repo-local roll package is newer than the running runner", async () => {
    const p = project();
    writeFileSync(join(p, "package.json"), JSON.stringify({ name: "@bipo-ape/roll", version: "99.0.0" }) + "\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_350,
      nowIso: () => "2026-06-11T10:03:50Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-1235"], deps));

    expect(r.code).toBe(1);
    expect(calls).toBe(0);
    expect(r.out).toContain("roll loop go: runner");
    expect(r.err).toContain("runner_stale_for_repo");
    expect(existsSync(join(p, ".roll", "loop", "goal.yaml"))).toBe(false);
  });
});

describe("US-GOAL-005 — goal session gates (progress, scope-resume, timebox)", () => {
  it("FIX-259: explicit --cards replaces a resumed paused all-backlog goal scope", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-256](.roll/features/documentation/FIX-256/spec.md) | docs | 📋 Todo |",
      "| [US-OTHER](.roll/features/documentation/US-OTHER/spec.md) | other | 📋 Todo |",
    ]);
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: all
review: auto
limits:
status: paused
usage:
  cycles: 0
  costUsd: 0
createdAt: 2026-06-11T16:11:49Z
updatedAt: 2026-06-11T16:12:26Z
lastDecisionReason: no_cycle_terminal
`,
    );
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_004_000,
      nowIso: () => "2026-06-12T00:10:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ allowedCards }) => {
        allowed.push(allowedCards);
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-256"], deps));

    expect(r.code).toBe(0);
    expect(allowed).toEqual([["FIX-256"]]);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.scope).toEqual({ kind: "cards", cards: ["FIX-256"] });
    const sessionStart = readEvents(p).find((e) => e.type === "goal:session_start");
    expect(sessionStart).toMatchObject({ scope: { kind: "cards", cards: ["FIX-256"] } });
  });

  it("FIX-260: a run-once refusal bubbles the ALERT reason into the goal terminal reason", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-256](.roll/features/documentation/FIX-256/spec.md) | docs | 📋 Todo |",
    ]);
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_004_100,
      nowIso: () => "2026-06-12T00:11:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        writeFileSync(
          join(projectPath, ".roll", "loop", "ALERT-proj-abc123.md"),
          "[2026-06-11T16:11:49.869Z] ALERT egress blocked (proxy?): network pre-check failed — cycle 20260612-001149-63334 refused to start\n",
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-256"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_cycle_terminal");
    expect(goal.lastDecisionReason).toContain("egress blocked");
    const end = readEvents(p).find((e) => e.type === "goal:session_end");
    expect(end).toMatchObject({ reason: expect.stringContaining("egress blocked") });
  });

  it("--for stops after the current cycle reaches the wall-clock box", async () => {
    const p = project();
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => (calls === 0 ? 1_780_001_000 : 1_780_001_002),
      nowIso: () => (calls === 0 ? "2026-06-11T11:50:00Z" : "2026-06-11T11:50:02Z"),
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-TIME", cycle_id: "cycle-1", ts: "2026-06-11T11:50:02Z", cost_usd: 1, cost_effective_usd: 1, status: "failed" })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--for", "1s"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toBe("timebox");
    expect(goal.limits.maxHours).toBeCloseTo(1 / 3600, 8);
    expect(readEvents(p).some((e) => e.type === "goal:gate_tripped" && e.gate === "timebox" && e.reason === "timebox")).toBe(true);
  });

  it("preserves an existing goal review mode unless --review is explicit", async () => {
    const p = project();
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: all
review: self
limits:
status: active
usage:
  cycles: 0
  costUsd: 0
createdAt: 2026-06-11T12:00:00Z
updatedAt: 2026-06-11T12:00:00Z
`,
    );
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_001_100,
      nowIso: () => "2026-06-11T12:10:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => 0,
    };

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "0"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.review.mode).toBe("self");
  });
});

// The whole-goal dead-loop breaker is the ONLY backstop against a runaway loop
// now that the budget gate is gone. These tests prove it is AIRTIGHT: a cycle
// that keeps appending a runs row can NEVER spin forever — it either delivers
// (reset), appends a no-delivery row (increment → STOP at K), or appends no row
// at all (the no-cycle-terminal backstop breaks). GOAL_NO_PROGRESS_STOP === 3.
describe("US-GOAL-005 — dead-loop breaker is airtight (no spin-hole)", () => {
  it("FIX-1268b: screen-locked wait cycles do not advance the no-progress breaker", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-LOCKED](.roll/features/goal-mode/US-LOCKED/spec.md) | physical evidence | 📋 Todo |",
    ]);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_009_000 + calls,
      nowIso: () => `2026-06-11T12:50:${String(calls).padStart(2, "0")}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        const cycleId = `locked-${calls}`;
        writeFileSync(
          join(projectPath, ".roll", "loop", "events.ndjson"),
          `${JSON.stringify({ type: "loop:screen_locked", cycleId, locked: true, reason: "console locked", ts: 1_780_009_000 + calls })}\n`,
          { flag: "a" },
        );
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-LOCKED", cycle_id: cycleId, status: "idle", tcr_count: 0 })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-LOCKED", "--max-cycles", "4"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(4);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.lastDecisionReason).toBe("max_cycles");
    expect(goal.progress).toBeUndefined();
    expect(readEvents(p).some((event) => event.type === "goal:gate_tripped" && event.reason === "no_progress_breaker")).toBe(false);
  });

  // THE SPIN-HOLE REGRESSION: a row with NO tcr_count AND no delivery evidence
  // is `known:false`, so the per-card loop skips it — but cycles INCREASE (a row
  // was appended), so the no-cycle-terminal backstop does NOT fire. Before the
  // fail-safe fix this spun forever. It must now STOP within K cycles via the
  // global breaker, regardless of the row being unparseable as a known terminal.
  it("STOPS within K cycles when every cycle appends a known:false (no tcr_count, no evidence) row", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-SPIN](.roll/features/goal-mode/US-SPIN/spec.md) | unparseable terminal | 📋 Todo |",
    ]);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_010_000 + calls,
      nowIso: () => `2026-06-11T13:00:${String(calls).padStart(2, "0")}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        // A row WITH a story_id but WITHOUT tcr_count and WITHOUT any delivery
        // evidence → runAttemptFromRow returns known:false → per-card skip. The
        // appended row still bumps the cycle count, defeating the 1543 backstop.
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-SPIN", cycle_id: `cycle-${calls}`, ts: `2026-06-11T13:00:0${calls}Z`, status: "failed" })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    // --max-cycles 50 is deliberately MUCH higher than the breaker bound: if the
    // breaker did not fire the loop would run all 50 (or, in production, forever).
    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-SPIN", "--max-cycles", "50"], deps));

    expect(r.code).toBe(0);
    // The breaker must stop it AT the threshold — not at max-cycles, not never.
    expect(calls).toBe(3);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_progress_breaker");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.gate === "progress" && e.reason === "no_progress_breaker")).toBe(true);
    const alert = readFileSync(join(p, ".roll", "loop", "ALERT-proj-abc123.md"), "utf8");
    expect(alert).toContain("dead-loop breaker");
  });

  // Even harsher: a row with NO story_id at all is `undefined` from
  // runAttemptFromRow — the per-card loop cannot attribute it. The fail-safe
  // global accounting must still count it, so the loop STOPS within K.
  it("STOPS within K cycles when every cycle appends a row with no story_id (undefined attempt)", async () => {
    const p = project();
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_011_000 + calls,
      nowIso: () => `2026-06-11T13:10:${String(calls).padStart(2, "0")}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ cycle_id: `cycle-${calls}`, ts: `2026-06-11T13:10:0${calls}Z`, status: "failed" })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "50"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(3);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_progress_breaker");
  });

  // A KNOWN gave_up sequence (tcr_count: 0, no evidence) must also STOP within K
  // — the existing zero-delivery path, asserted here as a guard against the fix
  // accidentally changing known-row accounting.
  it("STOPS within K cycles for a known gave_up (tcr_count 0, no evidence) sequence", async () => {
    const p = project();
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_012_000 + calls,
      nowIso: () => `2026-06-11T13:20:${String(calls).padStart(2, "0")}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        // Each cycle targets a DISTINCT story so the per-card skip (which needs a
        // 2-streak on one storyId) never fires — only the GLOBAL breaker can stop
        // this, proving the global counter advances on every known no-progress.
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: `US-GAVEUP-${calls}`, cycle_id: `cycle-${calls}`, ts: `2026-06-11T13:20:0${calls}Z`, status: "gave_up", tcr_count: 0 })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "50"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(3);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_progress_breaker");
  });

  // A delivering sequence must COMPLETE — the breaker never trips when work lands
  // (each delivery resets noProgressCycles to 0).
  it("does NOT trip the breaker for a delivering sequence (completes the goal)", async () => {
    const p = project();
    writeIndex(p, { "US-DONE": "goal-mode" });
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    const deps = completeGoalDeps(p, approveFinalReview);

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE", "--max-cycles", "10"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
    const events = readEvents(p);
    // The progress breaker never tripped — delivery reset the counter each cycle.
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.gate === "progress")).toBe(false);
  });

  // A cycle that appends NO row at all must break via the no-cycle-terminal
  // backstop (cycles did not increase) — NOT spin. The global no-progress counter
  // stays unchanged in that case (rows.length === 0); the backstop owns it.
  it("breaks immediately when a cycle appends no runs row (no-cycle-terminal backstop)", async () => {
    const p = project();
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_013_000 + calls,
      nowIso: () => `2026-06-11T13:30:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      // Appends NOTHING — no runs row → cycles do not advance.
      runOnce: async () => {
        calls += 1;
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "50"], deps));

    expect(r.code).toBe(0);
    // One cycle, then the backstop breaks — it does NOT run all 50 / spin.
    expect(calls).toBe(1);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_cycle_terminal");
    // The global breaker did NOT trip — the no-row case is owned by the backstop.
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.gate === "progress")).toBe(false);
  });
});

describe("US-GOAL-006 — goal final review gate", () => {
  it("APPROVE completes the goal and records the final review event", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    const deps = completeGoalDeps(p, async (input) => {
      expect(input.mode).toBe("auto");
      expect(input.evaluation.reason).toBe("all_delivered");
      return {
        effectiveMode: "hetero",
        reviewer: "codex",
        provider: "openai",
        commandFamily: "codex",
        verdict: "APPROVE",
        reason: "accepted",
        findings: ["AC and tests line up"],
        durationMs: 1250,
        transcriptPath: join(p, ".roll", "peer", "transcripts", "review.txt"),
        evidencePath: join(p, ".roll", "peer", "runs.jsonl"),
      };
    });

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
    const events = readEvents(p);
    expect(
      events.some(
        (e) =>
          e.type === "goal:final_review" &&
          e.verdict === "APPROVE" &&
          e.reviewer === "codex" &&
          e.commandFamily === "codex" &&
          e.durationMs === 1250 &&
          typeof e.transcriptPath === "string" &&
          typeof e.evidencePath === "string",
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "goal:state" && e.to === "complete" && e.actor === "adjudicator")).toBe(true);
  });

  it("REQUEST_CHANGES pauses the goal and records the review reason", async () => {
    const p = project();
    writeIndex(p, { "US-DONE": "goal-mode" });
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    const deps = completeGoalDeps(p, async () => ({
      effectiveMode: "hetero",
      reviewer: "codex",
      provider: "openai",
      verdict: "REQUEST_CHANGES",
      reason: "missing edge test",
      findings: ["Add regression coverage for empty scope"],
    }));

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("missing edge test");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:final_review" && e.verdict === "REQUEST_CHANGES")).toBe(true);
    expect(events.some((e) => e.type === "goal:state" && e.to === "complete")).toBe(false);
    expect(events.some((e) => e.type === "goal:state" && e.to === "paused" && String(e.reason).includes("missing edge test"))).toBe(true);
    const note = readFileSync(
      join(p, ".roll", "features", "goal-mode", "US-DONE", "notes", "final-review-goal-20260611100000-12345.md"),
      "utf8",
    );
    expect(note).toContain("missing edge test");
    expect(note).toContain("Add regression coverage");
  });

  it("REQUEST_CHANGES stops the default go session instead of looping idle cycles", async () => {
    const p = project();
    writeIndex(p, { "US-DONE": "goal-mode" });
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    let reviewCalls = 0;
    const deps = completeGoalDeps(p, async (input) => {
      reviewCalls += 1;
      expect(input.workerAgents).toEqual(["claude"]);
      return {
        effectiveMode: "hetero",
        reviewer: "codex",
        provider: "openai",
        verdict: "REQUEST_CHANGES",
        reason: "missing replay evidence",
        findings: [],
      };
    });

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE"], deps));

    expect(r.code).toBe(0);
    expect(reviewCalls).toBe(1);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    const events = readEvents(p);
    expect(events.filter((e) => e.type === "goal:final_review")).toHaveLength(1);
    expect(events.some((e) => e.type === "goal:session_end" && String(e.reason).includes("missing replay evidence"))).toBe(true);
  });

  it("anchors the reviewer verdict line and fails closed on quoted APPROVE text", async () => {
    const p = project();
    writeIndex(p, { "US-DONE": "goal-mode" });
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    const deps = completeGoalDeps(p, async () => {
      const parsed = parsePeerReviewTranscript(
        "codex",
        "VERDICT: REQUEST_CHANGES\nREASON: quoted approve is not approval\nFINDING: do not treat VERDICT: APPROVE examples as approval\n",
      );
      return {
        effectiveMode: "hetero",
        reviewer: "codex",
        provider: "openai",
        verdict: parsed.verdict,
        reason: parsed.reason,
        findings: parsed.findings,
      };
    });
    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE", "--review", "self"], deps));
    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:final_review" && e.verdict === "REQUEST_CHANGES")).toBe(true);
    expect(events.some((e) => e.type === "goal:state" && e.to === "complete")).toBe(false);
  });

  it("--review off writes a skipped final_review event and completes", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    let reviewCalled = false;
    const deps = completeGoalDeps(p, async () => {
      reviewCalled = true;
      return {
        effectiveMode: "hetero",
        reviewer: "codex",
        provider: "openai",
        verdict: "APPROVE",
        reason: "accepted",
        findings: [],
      };
    });

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE", "--review", "off"], deps));

    expect(r.code).toBe(0);
    expect(reviewCalled).toBe(false);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
    expect(goal.review.mode).toBe("off");
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:final_review" && e.effectiveMode === "off" && e.verdict === "SKIPPED")).toBe(true);
  });

  it("FIX-280: a transient final-review crash is retried once and recovers", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    let reviewCalls = 0;
    const deps = completeGoalDeps(p, async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new Error("peer spawn EPIPE");
      return { effectiveMode: "hetero", reviewer: "codex", provider: "openai", verdict: "APPROVE", reason: "accepted", findings: [] };
    });

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE"], deps));

    expect(r.code).toBe(0);
    expect(reviewCalls).toBe(2); // retried once after the transient throw
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("complete");
  });

  it("FIX-280: a final-review crash that persists surfaces the real reason and raises an ALERT", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    let reviewCalls = 0;
    const deps = completeGoalDeps(p, async () => {
      reviewCalls += 1;
      throw new Error("reviewer unreachable: ECONNREFUSED");
    });

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(reviewCalls).toBe(2); // one attempt + one retry
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).not.toBe("complete");
    const events = readEvents(p);
    const review = events.find((e) => e.type === "goal:final_review" && e.verdict === "ERROR");
    expect(review).toBeDefined();
    // The real error reason is surfaced, not a reasonless generic ERROR.
    expect(String(review?.["reason"])).toContain("ECONNREFUSED");
    // The crash is observable as an ALERT, not swallowed.
    const alert = readFileSync(join(p, ".roll", "loop", "ALERT-proj-abc123.md"), "utf8");
    expect(alert).toContain("ALERT goal final review failed");
    expect(alert).toContain("ECONNREFUSED");
  });

  it("auto single-agent degradation is recorded before completion", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-DONE](.roll/features/goal-mode/US-DONE/spec.md) | done | ✅ Done · PR#1 |",
    ]);
    const deps = completeGoalDeps(p, async () => ({
      effectiveMode: "self",
      reviewer: "claude",
      provider: "anthropic",
      verdict: "APPROVE",
      reason: "accepted_self_review",
      findings: [],
      degradedReason: "single_provider_available",
    }));

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "US-DONE"], deps));

    expect(r.code).toBe(0);
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:review_degraded" && e.to === "self" && e.reason === "single_provider_available")).toBe(true);
    expect(events.some((e) => e.type === "goal:final_review" && e.effectiveMode === "self" && e.verdict === "APPROVE")).toBe(true);
  });

  it("final review timeout resolves without waiting for process close", async () => {
    const p = project();
    const bin = join(p, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nsleep 30\n", "utf8");
    chmodSync(join(bin, "claude"), 0o755);
    const prevPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${prevPath ?? ""}`;
    const started = Date.now();
    try {
      const result = await spawnFinalReviewAgent("claude", p, "prompt", 50);
      expect(result.status).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      if (prevPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = prevPath;
    }
  });
});

describe("FIX-269 — goal session waits for a running scheduled cycle", () => {
  function heldLock(p: string, ts: number): void {
    writeFileSync(join(p, ".roll", "loop", "inner.lock"), `${process.pid}:${ts}\n`);
  }

  it("waits on a held inner.lock, then runs the cycle once the lock frees", async () => {
    const p = project();
    heldLock(p, 1_780_000_000);
    let sleeps = 0;
    let runs = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_010,
      nowIso: () => "2026-06-12T02:00:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      sleep: async () => {
        sleeps += 1;
        // The scheduled cycle finishes during the second poll interval.
        if (sleeps === 2) execSync(`rm -f '${join(p, ".roll", "loop", "inner.lock")}'`);
      },
      runOnce: async ({ projectPath }) => {
        runs += 1;
        const rt = join(projectPath, ".roll", "loop");
        writeFileSync(
          join(rt, "runs.jsonl"),
          `${JSON.stringify({ story_id: "US-1", cycle_id: "cycle-1", ts: "2026-06-12T02:05:00Z", cost_usd: 1, status: "done" })}\n`,
          { flag: "a" },
        );
        writeFileSync(join(rt, "PAUSE-proj-abc123"), "owner pause\n");
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker"], deps));

    expect(r.code).toBe(0);
    expect(sleeps).toBe(2);
    expect(runs).toBe(1);
    const types = readEvents(p).map((e) => e.type);
    expect(types).toContain("goal:waiting_inner_lock");
    const waiting = readEvents(p).find((e) => e.type === "goal:waiting_inner_lock");
    expect(waiting).toMatchObject({ heldByPid: process.pid });
  });

  it("pauses with inner_lock_busy when the lock never frees within the ceiling", async () => {
    const p = project();
    let now = 1_780_000_010;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => now,
      nowIso: () => "2026-06-12T02:00:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      sleep: async () => {
        // Keep the holder fresh so the lock never goes stale while we wait.
        now += 20;
        heldLock(p, now);
      },
      runOnce: async () => {
        throw new Error("runOnce must not be called while the inner lock is held");
      },
    };
    heldLock(p, now);

    const r = await capture(() => loopGoCommand(["--worker"], deps));

    expect(r.code).toBe(0);
    expect(r.out).toContain("inner_lock_busy");
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toBe("inner_lock_busy");
  });
});

describe("FIX-289 — go startup feedback + reliable watch window", () => {
  function startTmuxDeps(p: string, overrides: Partial<LoopGoDeps> = {}): LoopGoDeps {
    return {
      ...completeGoalDeps(p),
      hasTmux: () => true,
      startTmux: () => true,
      ...overrides,
    };
  }

  it("AC1: prints session name, scope, first-cycle confirmation, and the read-only observe command", async () => {
    const p = project();
    const r = await capture(() => loopGoCommand(["--cards", "US-A,US-B"], startTmuxDeps(p)));

    expect(r.code).toBe(0);
    // Session name (not a vague one-liner).
    expect(r.out).toContain("Goal go session started: roll-loop-proj-abc123");
    // Scope.
    expect(r.out).toContain("scope:");
    expect(r.out).toContain("cards US-A, US-B");
    // First cycle started confirmation.
    expect(r.out).toContain("first cycle is running now");
    // Read-only way to observe.
    expect(r.out).toContain("tmux attach -t roll-loop-proj-abc123");
    expect(r.out).toContain("roll loop go --attach");
    // The worker window warning is present (do not Ctrl-C the worker).
    expect(r.out).toContain("do not Ctrl-C it");
  });

  it("AC1: describes the default 'all' scope and an --epic scope", async () => {
    const p = project();
    const rAll = await capture(() => loopGoCommand([], startTmuxDeps(p)));
    expect(rAll.out).toContain("all Todo backlog cards");

    const rEpic = await capture(() => loopGoCommand(["--epic", "goal-mode"], startTmuxDeps(p)));
    expect(rEpic.out).toContain("epic goal-mode");
  });

  it("AC2: a fresh session creates the watch window before the go window", () => {
    const plan = planGoTmuxCommands(
      { projectPath: "/proj", slug: "proj-abc123", args: ["--cards", "US-A"], rollBin: "roll" },
      { sessionExists: false, watchWindowExists: false },
    );
    expect(plan).toHaveLength(2);
    // First creates the session with a named `watch` window holding the live feed.
    expect(plan[0]?.[0]).toBe("new-session");
    expect(plan[0]).toContain("watch");
    expect(plan[0]?.[plan[0].length - 1]).toContain("loop watch");
    expect(plan[0]?.[plan[0].length - 1]).not.toContain("loop fmt");
    // Then the detached worker `go` window.
    expect(plan[1]?.[0]).toBe("new-window");
    expect(plan[1]).toContain("go");
  });

  it("US-LOOP-117: ROLL_LOOP_FORCE reaches the tmux worker when set, and only then", () => {
    const input = { projectPath: "/proj", slug: "proj-abc123", args: [], rollBin: "roll" };
    const state = { sessionExists: true, watchWindowExists: true };
    const saved = process.env["ROLL_LOOP_FORCE"];
    try {
      // Unset: the worker command must not invent the variable.
      delete process.env["ROLL_LOOP_FORCE"];
      expect(planGoTmuxCommands(input, state).at(-1)?.at(-1)).not.toContain("ROLL_LOOP_FORCE");
      // Set: the worker runs in a fresh shell, so it only sees what we forward.
      // codex r6: the docs promised readable output here and it was dropped.
      process.env["ROLL_LOOP_FORCE"] = "1";
      // Quoted, like every other value in this command line.
      expect(planGoTmuxCommands(input, state).at(-1)?.at(-1)).toContain("ROLL_LOOP_FORCE='1'");
      // Blank is not "set" — an empty value would read as interactive downstream.
      process.env["ROLL_LOOP_FORCE"] = "   ";
      expect(planGoTmuxCommands(input, state).at(-1)?.at(-1)).not.toContain("ROLL_LOOP_FORCE");
    } finally {
      if (saved === undefined) delete process.env["ROLL_LOOP_FORCE"];
      else process.env["ROLL_LOOP_FORCE"] = saved;
    }
  });

  it("AC2: a reused session WITHOUT a watch window recreates the watch window", () => {
    const plan = planGoTmuxCommands(
      { projectPath: "/proj", slug: "proj-abc123", args: [], rollBin: "roll" },
      { sessionExists: true, watchWindowExists: false },
    );
    expect(plan).toHaveLength(2);
    // The missing watch window is recreated via new-window (NOT new-session).
    expect(plan[0]?.[0]).toBe("new-window");
    expect(plan[0]).toContain("watch");
    expect(plan[0]?.[plan[0].length - 1]).toContain("loop watch");
    expect(plan[0]?.[plan[0].length - 1]).not.toContain("loop fmt");
    // Then the worker `go` window.
    expect(plan[1]?.[0]).toBe("new-window");
    expect(plan[1]).toContain("go");
  });

  it("AC2: a reused session that already has a watch window only adds the go window", () => {
    const plan = planGoTmuxCommands(
      { projectPath: "/proj", slug: "proj-abc123", args: [], rollBin: "roll" },
      { sessionExists: true, watchWindowExists: true },
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]?.[0]).toBe("new-window");
    expect(plan[0]).toContain("go");
    expect(plan.some((argv) => argv.includes("watch"))).toBe(false);
  });

  it("AC3: --attach follows the read-only live feed in the foreground and explains Ctrl-C", async () => {
    const p = project();
    let followed: { path: string } | undefined;
    const r = await capture(() =>
      loopGoCommand(
        ["--attach", "--cards", "US-A"],
        startTmuxDeps(p, {
          followFeed: async (path) => {
            followed = { path };
          },
        }),
      ),
    );

    expect(r.code).toBe(0);
    expect(followed?.path).toBe(p);
    expect(r.out).toContain("Following live feed");
    expect(r.out).toContain("Ctrl-C stops the view, not the loop");
  });

  it("AC3: without --attach the command is fire-and-forget (no follow)", async () => {
    const p = project();
    let followCalls = 0;
    const r = await capture(() =>
      loopGoCommand(
        ["--cards", "US-A"],
        startTmuxDeps(p, {
          followFeed: async () => {
            followCalls += 1;
          },
        }),
      ),
    );

    expect(r.code).toBe(0);
    expect(followCalls).toBe(0);
    expect(r.out).not.toContain("Following live feed");
  });

  it("AC3: --attach is stripped from the worker args handed to the tmux worker window", () => {
    const plan = planGoTmuxCommands(
      { projectPath: "/proj", slug: "proj-abc123", args: ["--attach", "--cards", "US-A"], rollBin: "roll" },
      { sessionExists: false, watchWindowExists: false },
    );
    const goWindow = plan.find((argv) => argv.includes("go"));
    expect(goWindow?.[goWindow.length - 1]).not.toContain("--attach");
    // The scope flag the worker needs is preserved.
    expect(goWindow?.[goWindow.length - 1]).toContain("--cards");
  });

  it("help documents the --attach flag", async () => {
    const p = project();
    const r = await capture(() => loopGoCommand(["--help"], completeGoalDeps(p)));
    expect(r.out).toContain("--attach");
    expect(r.out).toContain("follow the read-only live feed");
  });
});

describe("FIX-333 — published_pending_merge cards are not re-picked (no double delivery)", () => {
  // The double-PR bug: a card delivered as published_pending_merge (PR open,
  // merge handed to the PR lane) whose ✅ Done lives only on the cycle branch —
  // the main-checkout backlog still reads 📋 Todo. Without the in-flight guard
  // the session re-picks it next cycle and the worker opens a SECOND PR for the
  // same work (FIX-308 → #759 + #760).
  it("does NOT re-pick a card it just delivered as published_pending_merge; ends the session cleanly", async () => {
    const p = project();
    // Backlog still reads Todo (worktree-isolated Done not yet on main).
    writeBacklog(p, [
      "| [FIX-308](.roll/features/goal-mode/FIX-308/spec.md) | flaky card | 📋 Todo |",
    ]);
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_020_000 + calls,
      nowIso: () => `2026-06-13T09:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards }) => {
        calls += 1;
        allowed.push(allowedCards);
        // A genuine published delivery: PR open, merge pending.
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({
            story_id: "FIX-308",
            cycle_id: `cycle-${calls}`,
            ts: `2026-06-13T09:00:0${calls}Z`,
            agent: "claude",
            status: "published",
            outcome: "published_pending_merge",
            tcr_count: 3,
            pr_url: "https://github.com/o/r/pull/759",
          })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    // --max-cycles 10 is deliberately higher than any legitimate cycle count: a
    // re-pick would burn more cycles and produce a second PR.
    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-308", "--max-cycles", "10"], deps));

    expect(r.code).toBe(0);
    // Exactly ONE cycle: the card delivered once, then the scope is in-flight
    // and the session ends. NEVER a second delivery (the double-PR regression).
    expect(calls).toBe(1);
    expect(allowed).toEqual([["FIX-308"]]);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("scope_in_flight");
    const end = readEvents(p).find((e) => e.type === "goal:session_end");
    expect(end).toMatchObject({ reason: "scope_in_flight" });
    // The breaker never tripped — a delivery is progress, not a stall.
    const events = readEvents(p);
    expect(events.some((e) => e.type === "goal:gate_tripped" && e.gate === "progress")).toBe(false);
  });

  it("FIX-1032b: scope_in_flight stop reason includes gate diagnostic URL", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-308](.roll/features/goal-mode/FIX-308/spec.md) | flaky card | 📋 Todo |",
    ]);
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_020_000 + calls,
      nowIso: () => `2026-06-13T09:20:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({
            story_id: "FIX-308",
            cycle_id: `cycle-${calls}`,
            ts: `2026-06-13T09:20:0${calls}Z`,
            agent: "reasonix",
            status: "published",
            outcome: "ci_red_after_merge",
            tcr_count: 1,
            ci_run_url: "https://github.com/o/r/actions/runs/759",
          })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-308", "--max-cycles", "10"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(1);
    expect(deliveryGateStopDetails(p, 1_780_020_010)).toEqual([
      "ci_red_after_merge:FIX-308:https://github.com/o/r/actions/runs/759",
    ]);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.lastDecisionReason).toContain("scope_in_flight:ci_red_after_merge:FIX-308:https://github.com/o/r/actions/runs/759");
    const end = readEvents(p).find((e) => e.type === "goal:session_end");
    expect(end).toMatchObject({ reason: "scope_in_flight:ci_red_after_merge:FIX-308:https://github.com/o/r/actions/runs/759" });
  });

  it("still advances to the next scope card after the first delivers in-flight", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-308](.roll/features/goal-mode/FIX-308/spec.md) | first | 📋 Todo |",
      "| [FIX-309](.roll/features/goal-mode/FIX-309/spec.md) | second | 📋 Todo |",
    ]);
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_021_000 + calls,
      nowIso: () => `2026-06-13T09:10:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards }) => {
        calls += 1;
        allowed.push(allowedCards);
        // Cycle 1 delivers FIX-308; cycle 2 delivers FIX-309.
        const story = calls === 1 ? "FIX-308" : "FIX-309";
        const pr = calls === 1 ? 759 : 761;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({
            story_id: story,
            cycle_id: `cycle-${calls}`,
            ts: `2026-06-13T09:10:0${calls}Z`,
            agent: "claude",
            status: "published",
            outcome: "published_pending_merge",
            tcr_count: 2,
            pr_url: `https://github.com/o/r/pull/${pr}`,
          })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-308,FIX-309", "--max-cycles", "10"], deps));

    expect(r.code).toBe(0);
    // Two cycles: one per card, then both in-flight → clean end. No re-delivery.
    expect(calls).toBe(2);
    // Cycle 1 may pick either; cycle 2's allow-list EXCLUDES the delivered card.
    expect(allowed[0]).toEqual(["FIX-308", "FIX-309"]);
    expect(allowed[1]).toEqual(["FIX-309"]);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.lastDecisionReason).toContain("scope_in_flight");
  });
});

describe("FIX-333 — changing scope resets the progress counters", () => {
  // The breaker-on-start bug: a paused goal that accumulated no-progress cycles
  // on its OLD scope must not carry that count into a NEW scope and trip the
  // no_progress_breaker the instant it resumes.
  it("drops noProgressCycles/zeroStreaks/skippedCards when --cards changes the scope", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-NEW](.roll/features/goal-mode/FIX-NEW/spec.md) | fresh scope | 📋 Todo |",
    ]);
    // A persisted paused goal on a DIFFERENT scope (FIX-OLD) that already sat at
    // the breaker threshold (noProgressCycles 3 === GOAL_NO_PROGRESS_STOP).
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: cards
  cards: [FIX-OLD]
review: auto
limits:
status: paused
usage:
  cycles: 0
  costUsd: 0
progress:
  zeroStreaks:
    FIX-OLD: 2
  skippedCards: [FIX-OLD]
  noProgressCycles: 3
createdAt: 2026-06-13T08:00:00Z
updatedAt: 2026-06-13T08:30:00Z
lastDecisionReason: no_progress_breaker
`,
    );
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_022_000 + calls,
      nowIso: () => `2026-06-13T09:20:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards }) => {
        calls += 1;
        allowed.push(allowedCards);
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({
            story_id: "FIX-NEW",
            cycle_id: `cycle-${calls}`,
            ts: `2026-06-13T09:20:0${calls}Z`,
            agent: "claude",
            status: "failed",
            outcome: "failed",
            tcr_count: 0,
          })}\n`,
          { flag: "a" },
        );
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-NEW", "--max-cycles", "10"], deps));

    expect(r.code).toBe(0);
    // The breaker did NOT trip on start: the new scope began with a clean count,
    // so at least one cycle actually RAN (the OLD count of 3 was discarded).
    expect(calls).toBeGreaterThanOrEqual(1);
    // The very first run-once was reached (would be 0 if the pre-cycle breaker
    // fired immediately on the inherited count).
    expect(allowed[0]).toEqual(["FIX-NEW"]);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.scope).toEqual({ kind: "cards", cards: ["FIX-NEW"] });
    // The persisted goal no longer carries the stale OLD-scope counters.
    expect(goal.progress?.skippedCards ?? []).not.toContain("FIX-OLD");
    expect(goal.progress?.zeroStreaks?.["FIX-OLD"]).toBeUndefined();
  });

  it("keeps the progress counters when the scope is UNCHANGED on resume", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-SAME](.roll/features/goal-mode/FIX-SAME/spec.md) | same scope | 📋 Todo |",
    ]);
    // Same scope (FIX-SAME) with a noProgressCycles already at the threshold:
    // resuming must NOT reset it — the cross-session breaker must still fire.
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: cards
  cards: [FIX-SAME]
review: auto
limits:
status: paused
usage:
  cycles: 0
  costUsd: 0
progress:
  noProgressCycles: 3
createdAt: 2026-06-13T08:00:00Z
updatedAt: 2026-06-13T08:30:00Z
lastDecisionReason: no_progress_breaker
`,
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_023_000 + calls,
      nowIso: () => `2026-06-13T09:30:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 1;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-SAME", "--max-cycles", "10"], deps));

    expect(r.code).toBe(0);
    // The inherited breaker count fires on start (same scope) — NO cycle runs.
    expect(calls).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.status).toBe("paused");
    expect(goal.lastDecisionReason).toContain("no_progress_breaker");
  });
});

describe("FIX-1034 — max-cycles counts session delta, not historical usage", () => {
  // AC1: historical goal with usage.cycles: 49, --max-cycles 1 → runs one cycle.
  it("runs one cycle when historical usage is 49 and --max-cycles is 1", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-NEW](.roll/features/loop-engine/FIX-NEW/spec.md) | new fix | 📋 Todo |",
    ]);
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: cards
  cards: [FIX-NEW]
review: off
limits:
status: active
usage:
  cycles: 49
  costUsd: 10
createdAt: 2026-06-14T19:20:25Z
updatedAt: 2026-06-29T06:04:22Z
lastDecisionReason: go_start
`,
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_030_000 + calls,
      nowIso: () => `2026-06-29T10:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "FIX-NEW", cycle_id: `cycle-${calls}`, tcr_count: 1, ts: `2026-06-29T10:00:0${calls}Z` })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-NEW", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    // Must run exactly one cycle — NOT zero because of historical usage.
    expect(calls).toBe(1);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    // usage.cycles cumulative → 50, but the session-end event shows delta.
    expect(goal.usage.cycles).toBe(50);
    const events = readEvents(p);
    const endEvent = events.find((e) => e.type === "goal:session_end");
    expect(endEvent).toBeDefined();
    expect(endEvent!.cycles).toBe(1);
    expect(endEvent!.reason).toBe("max_cycles");
  });

  // AC2: session-end cycles field shows session delta (2), not total (22).
  // Uses no-progress rows (no tcr_count) so the card stays undelivered and
  // maxCycles drives the stop, not scope_in_flight.
  it("goal:session_end.cycles shows session delta when historical usage exists", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-NEW](.roll/features/loop-engine/FIX-NEW/spec.md) | new fix | 📋 Todo |",
    ]);
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: cards
  cards: [FIX-NEW]
review: off
limits:
status: active
usage:
  cycles: 20
  costUsd: 5
createdAt: 2026-06-14T19:20:25Z
updatedAt: 2026-06-29T06:04:22Z
lastDecisionReason: go_start
`,
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_031_000 + calls,
      nowIso: () => `2026-06-29T10:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        // No tcr_count → card is NOT marked as delivered → maxCycles will stop it.
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "FIX-NEW", cycle_id: `cycle-${calls}`, ts: `2026-06-29T10:00:0${calls}Z` })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    // max-cycles 2 with historical 20 → should run 2 cycles, then stop.
    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-NEW", "--max-cycles", "2"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(2);
    const events = readEvents(p);
    const endEvent = events.find((e) => e.type === "goal:session_end");
    expect(endEvent).toBeDefined();
    // session delta, NOT total cumulative
    expect(endEvent!.cycles).toBe(2);
    expect(endEvent!.reason).toBe("max_cycles");
  });

  // AC3: --max-cycles 0 still exits without calling runOnce, even with historical usage.
  it("max-cycles 0 stops immediately with historical usage present", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-NEW](.roll/features/loop-engine/FIX-NEW/spec.md) | new fix | 📋 Todo |",
    ]);
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: cards
  cards: [FIX-NEW]
review: off
limits:
status: active
usage:
  cycles: 49
  costUsd: 10
createdAt: 2026-06-14T19:20:25Z
updatedAt: 2026-06-29T06:04:22Z
lastDecisionReason: go_start
`,
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_032_000 + calls,
      nowIso: () => `2026-06-29T10:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-NEW", "--max-cycles", "0"], deps));

    expect(r.code).toBe(0);
    // Zero cycles should run — no runOnce call.
    expect(calls).toBe(0);
    const events = readEvents(p);
    const endEvent = events.find((e) => e.type === "goal:session_end");
    expect(endEvent).toBeDefined();
    expect(endEvent!.cycles).toBe(0);
    expect(endEvent!.reason).toBe("max_cycles");
  });

  // AC4: scope-change still resets progress counters but does NOT zero historical usage.
  it("scope change resets progress but preserves historical usage for session delta", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-OLD](.roll/features/loop-engine/FIX-OLD/spec.md) | old scope | 📋 Todo |",
      "| [FIX-NEW](.roll/features/loop-engine/FIX-NEW/spec.md) | new scope | 📋 Todo |",
    ]);
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      `schema: goal.v1
scope:
  kind: cards
  cards: [FIX-OLD]
review: off
limits:
status: active
usage:
  cycles: 49
  costUsd: 10
createdAt: 2026-06-14T19:20:25Z
updatedAt: 2026-06-29T06:04:22Z
lastDecisionReason: go_start
`,
    );
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_033_000 + calls,
      nowIso: () => `2026-06-29T10:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath }) => {
        calls += 1;
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "FIX-NEW", cycle_id: `cycle-${calls}`, tcr_count: 1, ts: `2026-06-29T10:00:0${calls}Z` })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    // Change scope from FIX-OLD to FIX-NEW.
    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-NEW", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    // Scope changed → progress counters cleared → one cycle runs, then max_cycles.
    expect(calls).toBe(1);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    // Historical usage preserved after scope change.
    expect(goal.usage.cycles).toBe(50);
    // Progress counters were cleared by the scope change.
    expect(goal.progress).toBeUndefined();
    const events = readEvents(p);
    const endEvent = events.find((e) => e.type === "goal:session_end");
    expect(endEvent).toBeDefined();
    expect(endEvent!.cycles).toBe(1);
  });
});

describe("FIX-1255 — safety-pause stop check normalizes s/ms event timestamps", () => {
  function eventsFile(p: string, rows: Array<Record<string, unknown>>): string {
    const path = join(p, ".roll", "loop", "events.ndjson");
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return path;
  }

  // The live-repro shape: a HISTORICAL safety_pause stamped in MILLISECONDS
  // (run-once auth-block path used Date.now()). since is seconds "session
  // start". Before the fix the ms stamp (≈1.78e12) always compared >= the
  // seconds since (≈1.78e9) and stopped every session after its first cycle.
  it("ignores a historical ms-stamped safety_pause from before the session", () => {
    const p = project();
    const sessionStartSec = 1_784_022_572; // 2026-07-14
    const staleMs = 1_783_879_922_944; // 2026-07-13, in MILLISECONDS
    const path = eventsFile(p, [
      { type: "policy:safety_pause", loop: "ci", reason: "agent auth block: kimi", ts: staleMs },
    ]);
    expect(hasSafetyPauseSince(path, sessionStartSec)).toBe(false);
  });

  it("ignores a historical seconds-stamped safety_pause from before the session", () => {
    const p = project();
    const path = eventsFile(p, [
      { type: "policy:safety_pause", loop: "ci", reason: "consecutive failures 3 >= 3", ts: 1_781_078_541 },
    ]);
    expect(hasSafetyPauseSince(path, 1_784_022_572)).toBe(false);
  });

  it("detects a new safety_pause regardless of stamp unit", () => {
    const p = project();
    const sinceSec = 1_784_022_572;
    const freshSec = sinceSec + 60;
    const freshMs = (sinceSec + 60) * 1000;
    const secPath = eventsFile(p, [
      { type: "policy:safety_pause", loop: "ci", reason: "fresh (s)", ts: freshSec },
    ]);
    expect(hasSafetyPauseSince(secPath, sinceSec)).toBe(true);
    const msPath = join(p, ".roll", "loop", "events-ms.ndjson");
    writeFileSync(msPath, `${JSON.stringify({ type: "policy:safety_pause", loop: "ci", reason: "fresh (ms)", ts: freshMs })}\n`);
    expect(hasSafetyPauseSince(msPath, sinceSec)).toBe(true);
  });

  it("ignores non-safety_pause rows and malformed lines", () => {
    const p = project();
    const path = join(p, ".roll", "loop", "events.ndjson");
    writeFileSync(path, `not-json\n${JSON.stringify({ type: "alert:notify", channel: "loop-safety", message: "x", ts: 9_999_999_999_999 })}\n`);
    expect(hasSafetyPauseSince(path, 1_784_022_572)).toBe(false);
  });
});

describe("FIX-1253 — go banner shows the EFFECTIVE scope, never the parsed default", () => {
  // The tmux-parent path prints the banner and returns without running the
  // worker, so it exercises resolveEffectiveScope against the persisted goal.
  function bannerDeps(p: string, overrides: Partial<LoopGoDeps> = {}): LoopGoDeps {
    return { ...completeGoalDeps(p), hasTmux: () => true, startTmux: () => true, ...overrides };
  }

  function writeActiveGoal(p: string, scope: RollGoal["scope"]): void {
    const goal: RollGoal = {
      schema: "goal.v1",
      scope,
      review: { mode: "auto" },
      limits: {},
      status: "active",
      usage: { cycles: 0, costUsd: 0 },
      createdAt: "2026-07-14T10:00:00Z",
      updatedAt: "2026-07-14T10:00:00Z",
    };
    writeFileSync(join(p, ".roll", "loop", "goal.yaml"), renderGoalYaml(goal));
  }

  it("AC1/AC2/AC4: a flagless go over a persisted cards goal shows the inherited scope + source hint", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "cards", cards: ["FIX-1250"] });
    const r = await capture(() => loopGoCommand([], bannerDeps(p)));
    expect(r.code).toBe(0);
    expect(r.out).toContain("cards FIX-1250");
    expect(r.out).toContain("inherited from existing goal");
    expect(r.out).toContain("--cards/--epic/--all to change");
    // The regression: the banner must NOT print the misleading full-backlog
    // default that hid the silent narrowing to a stale cards goal.
    expect(r.out).not.toContain("all Todo backlog cards");
  });

  it("AC1: a flagless go over a persisted epic goal shows the inherited epic", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "epic", epic: "loop-engine" });
    const r = await capture(() => loopGoCommand([], bannerDeps(p)));
    expect(r.out).toContain("epic loop-engine");
    expect(r.out).toContain("inherited from existing goal");
  });

  it("AC1: a flagless go over a persisted all goal shows 'all' with NO inheritance callout", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "all" });
    const r = await capture(() => loopGoCommand([], bannerDeps(p)));
    expect(r.out).toContain("all Todo backlog cards");
    expect(r.out).not.toContain("inherited from existing goal");
  });

  it("AC1: with no persisted goal, a flagless go shows the plain 'all' default", async () => {
    const p = project();
    const r = await capture(() => loopGoCommand([], bannerDeps(p)));
    expect(r.out).toContain("all Todo backlog cards");
    expect(r.out).not.toContain("inherited from existing goal");
  });

  it("AC1: an explicit --cards run over a cards goal is NOT flagged as inherited", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "cards", cards: ["FIX-1250"] });
    const r = await capture(() => loopGoCommand(["--cards", "US-NEW"], bannerDeps(p)));
    expect(r.out).toContain("cards US-NEW");
    expect(r.out).not.toContain("inherited from existing goal");
  });

  it("AC3: --all banner resets a persisted cards goal to the full backlog", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "cards", cards: ["FIX-1250"] });
    const r = await capture(() => loopGoCommand(["--all"], bannerDeps(p)));
    expect(r.out).toContain("all Todo backlog cards");
    expect(r.out).not.toContain("inherited from existing goal");
  });

  it("AC3: --all PERSISTS an all scope over a prior cards goal in goal.yaml", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "cards", cards: ["FIX-1250"] });
    // --worker takes the resolution path that writes goal.yaml; --max-cycles 0
    // stops the loop right after the reset scope is persisted.
    const r = await capture(() => loopGoCommand(["--worker", "--all", "--max-cycles", "0"], completeGoalDeps(p)));
    expect(r.code).toBe(0);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.scope).toEqual({ kind: "all" });
  });

  it("AC3: --all is documented in help", async () => {
    const p = project();
    const r = await capture(() => loopGoCommand(["--help"], completeGoalDeps(p)));
    expect(r.out).toContain("--all");
    expect(r.out).toContain("Reset the goal scope to the full Todo backlog");
  });

  it("AC1: the direct --no-tmux run also prints the inherited scope banner", async () => {
    const p = project();
    writeActiveGoal(p, { kind: "cards", cards: ["FIX-1250"] });
    const r = await capture(() => loopGoCommand(["--no-tmux", "--max-cycles", "0"], completeGoalDeps(p)));
    expect(r.code).toBe(0);
    expect(r.out).toContain("cards FIX-1250");
    expect(r.out).toContain("inherited from existing goal");
  });
});

describe("FIX-1472 — guided/supervisor one-shot runs the scoped card while paused", () => {
  it("runs exactly the explicit --cards X (never an unscoped Todo) while the loop is paused, and leaves the PAUSE marker in place", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-007](.roll/features/loop-engine/FIX-007/spec.md) | scoped | 📋 Todo |",
      "| [US-ELIGIBLE](.roll/features/loop-engine/US-ELIGIBLE/spec.md) | unscoped eligible | 📋 Todo |",
    ]);
    // Autonomous scheduling is paused (owner ran `roll loop pause`).
    writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    let calls = 0;
    const allowed: Array<string[] | undefined> = [];
    const guidedFlags: Array<boolean | undefined> = [];
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_000 + calls,
      nowIso: () => `2026-06-11T10:00:0${calls}Z`,
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async ({ projectPath, allowedCards, guided }) => {
        calls += 1;
        allowed.push(allowedCards);
        guidedFlags.push(guided);
        writeFileSync(
          join(projectPath, ".roll", "loop", "runs.jsonl"),
          `${JSON.stringify({ story_id: "FIX-007", cycle_id: `cycle-${calls}`, ts: `2026-06-11T10:00:0${calls}Z`, status: "done" })}\n`,
          { flag: "a" },
        );
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--cards", "FIX-007", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    // Exactly one cycle started — the scoped card ran despite the pause.
    expect(calls).toBe(1);
    // Only the explicitly scoped card was handed to run-once; the unscoped
    // eligible Todo was never selected.
    expect(allowed).toEqual([["FIX-007"]]);
    // The guided signal is threaded to the run-once child so the real child
    // (which also honors the PAUSE marker) knows to run rather than skip.
    expect(guidedFlags).toEqual([true]);
    // The session stopped on the explicit --max-cycles bound, not the pause.
    expect(r.out).toContain("max_cycles");
    expect(r.out).not.toContain("pause_marker");
    // `pause` still stops autonomous scheduling — the marker is untouched.
    expect(existsSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
    const goal = parseGoalYaml(readFileSync(join(p, ".roll", "loop", "goal.yaml"), "utf8"));
    expect(goal.lastDecisionReason).toContain("max_cycles");
  });

  it("fails closed: a paused flagless go (no explicit --cards) still stops at pause_marker without running a cycle", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-ELIGIBLE](.roll/features/loop-engine/US-ELIGIBLE/spec.md) | unscoped eligible | 📋 Todo |",
    ]);
    writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_500,
      nowIso: () => "2026-06-11T10:05:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    // No card was explicitly scoped, so the pause is honored: zero cycles.
    expect(calls).toBe(0);
    expect(r.out).toContain("pause_marker");
    expect(existsSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
  });

  it("fails closed: paused --all does not bypass the pause marker or start run-once", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-ELIGIBLE](.roll/features/loop-engine/US-ELIGIBLE/spec.md) | unscoped eligible | 📋 Todo |",
    ]);
    writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_550,
      nowIso: () => "2026-06-11T10:05:50Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--all", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0);
    expect(r.out).toContain("pause_marker");
    expect(existsSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
  });

  it("fails closed: paused --epic does not bypass the pause marker or start run-once", async () => {
    const p = project();
    writeBacklog(p, [
      "| [US-ELIGIBLE](.roll/features/loop-engine/US-ELIGIBLE/spec.md) | scoped eligible | 📋 Todo |",
    ]);
    writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_575,
      nowIso: () => "2026-06-11T10:05:57Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--epic", "loop-engine", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0);
    expect(r.out).toContain("pause_marker");
    expect(existsSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
  });

  it("fails closed: a POSITIONAL card token (no --cards flag) does not bypass the pause", async () => {
    // `roll loop go FIX-007 --max-cycles 1` forms a cards SCOPE from the bare
    // positional token, but it is NOT an explicit `--cards` flag. Only the flag
    // is the sanctioned supervisor gesture, so a positional scope must keep
    // honoring the PAUSE marker (fail closed).
    const p = project();
    writeBacklog(p, [
      "| [FIX-007](.roll/features/loop-engine/FIX-007/spec.md) | scoped | 📋 Todo |",
    ]);
    writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_700,
      nowIso: () => "2026-06-11T10:07:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "FIX-007", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0);
    expect(r.out).toContain("pause_marker");
    expect(existsSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
  });

  it("fails closed: an INHERITED cards scope (not named this run) does not bypass the pause", async () => {
    const p = project();
    writeBacklog(p, [
      "| [FIX-007](.roll/features/loop-engine/FIX-007/spec.md) | scoped | 📋 Todo |",
    ]);
    // A prior goal narrowed the scope to cards; this run names nothing.
    writeFileSync(
      join(p, ".roll", "loop", "goal.yaml"),
      renderGoalYaml({
        schema: "goal.v1",
        scope: { kind: "cards", cards: ["FIX-007"] },
        review: { mode: "auto" },
        limits: {},
        status: "active",
        usage: { cycles: 0, costUsd: 0 },
        createdAt: "2026-06-11T16:11:49Z",
        updatedAt: "2026-06-11T16:12:26Z",
      }),
    );
    writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    let calls = 0;
    const deps: LoopGoDeps = {
      identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
      pid: () => 12345,
      nowSec: () => 1_780_000_600,
      nowIso: () => "2026-06-11T10:06:00Z",
      hasTmux: () => false,
      startTmux: () => false,
      runOnce: async () => {
        calls += 1;
        return 0;
      },
    };

    const r = await capture(() => loopGoCommand(["--worker", "--max-cycles", "1"], deps));

    expect(r.code).toBe(0);
    expect(calls).toBe(0);
    expect(r.out).toContain("pause_marker");
  });
});

describe("FIX-1472 (supervisor review) — buildRunOnceChildEnv sets guided EXPLICITLY, never inherits ambient", () => {
  it("forces GOAL_GUIDED_ENV to \"0\" for an unguided child even when the parent env has an ambient \"1\"", () => {
    // Ambient guided=1 leaked from a parent go-driver; an autonomous child that
    // merely carries an allowed-card scope (e.g. `go --all`) must NOT inherit it,
    // or it would bypass the PAUSE marker.
    const env = buildRunOnceChildEnv(
      { projectPath: "/tmp/x", allowedCards: ["FIX-007"] },
      { [GOAL_GUIDED_ENV]: "1" },
    );
    expect(env[GOAL_GUIDED_ENV]).toBe("0");
  });

  it("forces GOAL_GUIDED_ENV to \"0\" when input.guided is explicitly false and ambient is \"1\"", () => {
    const env = buildRunOnceChildEnv(
      { projectPath: "/tmp/x", guided: false },
      { [GOAL_GUIDED_ENV]: "1" },
    );
    expect(env[GOAL_GUIDED_ENV]).toBe("0");
  });

  it("sets GOAL_GUIDED_ENV to \"1\" only when this call is guided", () => {
    const env = buildRunOnceChildEnv(
      { projectPath: "/tmp/x", allowedCards: ["FIX-007"], guided: true },
      {},
    );
    expect(env[GOAL_GUIDED_ENV]).toBe("1");
  });
});

// ── US-CYCLE-013 — scheduler mutex + FIFO admission (matrix #4/#5/#6/#9/#10) ─
import { EventBus, projectCycleHandoff, projectHandoffCapacity } from "@roll/core";
import type { HandoffIdentity, ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import { handoffSchedulerDecision, latestHandedOffCycleId, nextHandoffQueueSequence, runHandedOffSince, type HandoffSchedulerInput } from "../src/commands/loop-go.js";

function handoffWorkspace(cycleId: string, storyId: string): ManagedWorkspaceSet {
  return {
    schema: 1,
    runId: cycleId,
    storyId,
    kind: "cycle",
    topology: "solo",
    members: [{
      repositoryId: "repo-id",
      workspaceKey: `cycle-${cycleId}`,
      relativeLocator: `cycle-${cycleId}`,
      checkoutRef: { kind: "detached", head: "base-sha" },
      publishRef: `refs/heads/loop/cycle-${cycleId}`,
    }],
  };
}

function handoffIdentity(cycleId: string, storyId: string, fence = "fence"): HandoffIdentity {
  return {
    schema: "cycle-handoff/v1",
    cycleId,
    storyId,
    workspace: handoffWorkspace(cycleId, storyId),
    branch: `loop/cycle-${cycleId}`,
    builderHead: "head-sha",
    baseSha: "base-sha",
    builderEvidenceRefs: [],
    builderValidationRef: `builder-validation:${cycleId}:1`,
    profile: "standard",
    attempt: 1,
    fence,
  };
}

function handoffProjectDir(tag: string): { eventsPath: string; lockPath: string } {
  const rt = mkdtempSync(join(tmpdir(), `roll-loopgo-handoff-${tag}-`));
  dirs.push(rt);
  return { eventsPath: join(rt, "events.ndjson"), lockPath: join(rt, "handoff.lock") };
}

function writeHandoffEvents(eventsPath: string, events: RollEvent[]): void {
  const bus = new EventBus();
  for (const ev of events) bus.appendEvent(eventsPath, ev);
}

function baseInput(p: { eventsPath: string; lockPath: string }, nowSec = 1_780_000_000): HandoffSchedulerInput {
  return { eventsPath: p.eventsPath, lockPath: p.lockPath, nowSec };
}

describe("US-CYCLE-013 — handoffSchedulerDecision (project-wide mutex + FIFO)", () => {
  it("promotes the oldest ready holder when the tail is free (before any new admission)", () => {
    const p = handoffProjectDir("promote");
    const A = handoffIdentity("cA", "US-A");
    writeHandoffEvents(p.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
    ]);
    const decision = handoffSchedulerDecision(baseInput(p));
    expect(decision.decision).toBe("promoted");
    if (decision.decision === "promoted") expect(decision.cycleId).toBe("cA");
    const view = projectCycleHandoff(new EventBus().readEvents(p.eventsPath), "cA");
    expect(view?.state).toBe("waiting_for_evaluation_or_test");
  });

  it("with a build-slot holder (ready) while A owns the tail, the next card is durably queued — matrix #4/#10", () => {
    const p = handoffProjectDir("queue");
    const A = handoffIdentity("cA", "US-A");
    const B = handoffIdentity("cB", "US-B");
    writeHandoffEvents(p.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 5 },
      { type: "worktree:allocated", workspace: handoffWorkspace("cB", "US-B"), ts: 6 },
      { type: "cycle:admitted", eventId: "e5", idempotencyKey: "admit:cB:1", identity: B, queueSequence: 2, ts: 7 },
      { type: "cycle:builder_ready", eventId: "e6", idempotencyKey: "ready:US-B:1:fence", identity: B, reason: "tail_capacity_full", ts: 8 },
    ]);
    const decision = handoffSchedulerDecision({
      ...baseInput(p),
      nextStory: { storyId: "US-C", requestedByCycleId: "cC" },
    });
    expect(decision.decision).toBe("queued");
    if (decision.decision === "queued") {
      expect(decision.storyId).toBe("US-C");
      expect(decision.reason).toBe("build_slot_full");
      expect(decision.queueSequence).toBe(3);
    }
    // The queued entry is visible in the capacity graph.
    const cap = projectHandoffCapacity(new EventBus().readEvents(p.eventsPath));
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.readyHolderCycleId).toBe("cB");
    expect(cap.queue.map((q) => q.storyId)).toEqual(["US-C"]);
    // The ready holder still owns the ONE build slot — C cannot start.
    expect(cap.buildHolderCycleId).toBe("cB");
  });

  it("capacity free → admit the next card (the run-once child performs the durable admitted append)", () => {
    const p = handoffProjectDir("admit");
    const decision = handoffSchedulerDecision({ ...baseInput(p), nextStory: { storyId: "US-B", requestedByCycleId: "cB" } });
    expect(decision.decision).toBe("admit");
  });

  it("the mutex serializes: a held handoff.lock yields admission_unknown (fail closed, no decision event)", () => {
    const p = handoffProjectDir("mutex");
    // Hold the mutex from "another process" — a directory lock the helper
    // cannot take over while its (fake) owner is live.
    mkdirSync(p.lockPath, { recursive: true });
    writeFileSync(join(p.lockPath, "meta.json"), JSON.stringify({ pid: process.pid, hostname: "", startedAt: Math.floor(Date.now() / 1000), cycleId: "other" }), "utf8");
    const decision = handoffSchedulerDecision({ ...baseInput(p), nextStory: { storyId: "US-B", requestedByCycleId: "cB" } });
    expect(decision.decision).toBe("admission_unknown");
    // No decision event was written (the append is the linearization point).
    const events = new EventBus().readEvents(p.eventsPath);
    expect(events.length).toBe(0);
  });

  it("A frees the tail before B completes → B is promoted on the next scheduler tick (matrix #5/#6)", () => {
    const p = handoffProjectDir("free");
    const A = handoffIdentity("cA", "US-A");
    const B = handoffIdentity("cB", "US-B");
    writeHandoffEvents(p.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 5 },
      { type: "cycle:tail_completed", eventId: "e5", idempotencyKey: "tail_completed:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 6 },
      { type: "cycle:cleanup_completed", eventId: "e6", idempotencyKey: "cleanup_completed:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", releasedWorkspace: true, ts: 7 },
      { type: "worktree:allocated", workspace: handoffWorkspace("cB", "US-B"), ts: 8 },
      { type: "cycle:admitted", eventId: "e7", idempotencyKey: "admit:cB:1", identity: B, queueSequence: 2, ts: 9 },
      { type: "cycle:builder_ready", eventId: "e8", idempotencyKey: "ready:US-B:1:fence", identity: B, reason: "tail_capacity_full", ts: 10 },
    ]);
    // Before the tick: B is ready, A is terminal — the tail is FREE.
    const capBefore = projectHandoffCapacity(new EventBus().readEvents(p.eventsPath));
    expect(capBefore.readyHolderCycleId).toBe("cB");
    expect(capBefore.tailCycleId).toBeUndefined();
    const decision = handoffSchedulerDecision(baseInput(p));
    expect(decision.decision).toBe("promoted");
    if (decision.decision === "promoted") expect(decision.cycleId).toBe("cB");
    const capAfter = projectHandoffCapacity(new EventBus().readEvents(p.eventsPath));
    expect(capAfter.tailCycleId).toBe("cB");
    expect(capAfter.buildHolderCycleId).toBeUndefined();
  });

  it("queue sequence is monotonic across queued + admitted facts", () => {
    const p = handoffProjectDir("seq");
    const A = handoffIdentity("cA", "US-A");
    writeHandoffEvents(p.eventsPath, [
      { type: "cycle:queued", eventId: "e1", idempotencyKey: "queue:US-X:1", storyId: "US-X", requestedByCycleId: "cx", queueSequence: 1, reason: "build_slot_full", ts: 1 },
      { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 2 },
      { type: "cycle:admitted", eventId: "e2", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 3, ts: 3 },
    ]);
    expect(nextHandoffQueueSequence(p.eventsPath)).toBe(4);
  });

  it("runHandedOffSince/latestHandedOffCycleId read the durable handoff (build, not terminal)", () => {
    const p = handoffProjectDir("handed");
    const A = handoffIdentity("cA", "US-A");
    writeHandoffEvents(p.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
    ]);
    expect(runHandedOffSince(p.eventsPath, "cA")).toBe(true);
    expect(latestHandedOffCycleId(p.eventsPath)).toBe("cA");
    // After the tail reaches a terminal, it is no longer a live handoff.
    writeHandoffEvents(p.eventsPath, [
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 5 },
      { type: "cycle:tail_completed", eventId: "e5", idempotencyKey: "tail_completed:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 6 },
      { type: "cycle:cleanup_completed", eventId: "e6", idempotencyKey: "cleanup_completed:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", releasedWorkspace: true, ts: 7 },
    ]);
    expect(runHandedOffSince(p.eventsPath, "cA")).toBe(false);
    expect(latestHandedOffCycleId(p.eventsPath)).toBeUndefined();
  });

  // US-CYCLE-013 F1 — idempotent queued append (matrix #2): two consecutive
  // scheduler ticks with the same blocked next card append EXACTLY ONE
  // `cycle:queued`; the second tick returns the SAME queueSequence (FIFO
  // position stable — a fresh monotonic sequence would push the card to the
  // back of the FIFO on every tick).
  it("F1: a card already live in the queue is NOT re-appended (same FIFO sequence on the next tick)", () => {
    const p = handoffProjectDir("queue-idempotent");
    const A = handoffIdentity("cA", "US-A");
    const B = handoffIdentity("cB", "US-B");
    writeHandoffEvents(p.eventsPath, [
      { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 5 },
      { type: "worktree:allocated", workspace: handoffWorkspace("cB", "US-B"), ts: 6 },
      { type: "cycle:admitted", eventId: "e5", idempotencyKey: "admit:cB:1", identity: B, queueSequence: 2, ts: 7 },
      { type: "cycle:builder_ready", eventId: "e6", idempotencyKey: "ready:US-B:1:fence", identity: B, reason: "tail_capacity_full", ts: 8 },
    ]);
    const input = { ...baseInput(p, 1_780_000_100), nextStory: { storyId: "US-C", requestedByCycleId: "cC" } };
    const first = handoffSchedulerDecision(input);
    expect(first.decision).toBe("queued");
    if (first.decision === "queued") expect(first.queueSequence).toBe(3);
    // Second tick, same blocked card — must NOT append a second cycle:queued.
    const second = handoffSchedulerDecision({ ...input, nowSec: 1_780_000_200 });
    expect(second.decision).toBe("queued");
    if (second.decision === "queued") {
      expect(second.queueSequence).toBe(3); // FIFO position stable
      expect(second.storyId).toBe("US-C");
    }
    const events = new EventBus().readEvents(p.eventsPath);
    const queued = events.filter((ev) => ev.type === "cycle:queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ storyId: "US-C", queueSequence: 3 });
    // The capacity graph still shows exactly one queue row for US-C.
    const cap = projectHandoffCapacity(events);
    expect(cap.queue.map((q) => q.storyId)).toEqual(["US-C"]);
  });

  // US-CYCLE-013 F1 — the go worker NEVER hands a `queued` card to run-once
  // (matrix #1): runOnceCalls === 0, the queue line is printed, a cycle:queued
  // event exists, no cycle:admitted for the blocked card, and the loop
  // continues (no no-cycle-terminal pause — the queued card is progress being
  // waited on). The worker exits on the next tick's PAUSE marker.
  it("F1: a queued verdict makes the go worker skip the build (runOnce not called)", async () => {
    const p = project();
    const savedFlag = process.env["ROLL_CYCLE_HANDOFF_V1"];
    process.env["ROLL_CYCLE_HANDOFF_V1"] = "1";
    try {
      writeBacklog(p, [
        "| [US-B](.roll/features/loop-engine/US-B/spec.md) | queued card | 📋 Todo |",
      ]);
      // A owns the live tail; the READY holder occupies the one build slot, so
      // the scheduler queues US-B on every tick until a slot frees (the ready
      // holder can NOT be promoted while A's tail is live).
      const A = handoffIdentity("cA", "US-A");
      const READY = handoffIdentity("cREADY", "US-READY");
      writeHandoffEvents(join(p, ".roll", "loop", "events.ndjson"), [
        { type: "worktree:allocated", workspace: handoffWorkspace("cA", "US-A"), ts: 1 },
        { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
        { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
        { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
        { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 5 },
        { type: "worktree:allocated", workspace: handoffWorkspace("cREADY", "US-READY"), ts: 6 },
        { type: "cycle:admitted", eventId: "e5", idempotencyKey: "admit:cREADY:1", identity: READY, queueSequence: 2, ts: 7 },
        { type: "cycle:builder_ready", eventId: "e6", idempotencyKey: "ready:US-READY:1:fence", identity: READY, reason: "tail_capacity_full", ts: 8 },
      ]);
      let runOnceCalls = 0;
      let sleepCalls = 0;
      const deps: LoopGoDeps = {
        identity: () => Promise.resolve({ path: p, slug: "proj-abc123" }),
        pid: () => 12345,
        nowSec: () => 1_780_000_300,
        nowIso: () => "2026-06-11T11:00:00Z",
        hasTmux: () => false,
        startTmux: () => false,
        runOnce: async () => {
          runOnceCalls += 1;
          return 0;
        },
        sleep: async () => {
          sleepCalls += 1;
          // Free the worker on the next tick: the queued card is being waited
          // on, so the only way out of the wait-loop is a PAUSE marker.
          writeFileSync(join(p, ".roll", "loop", "PAUSE-proj-abc123"), "paused\n");
        },
      };

      const r = await capture(() => loopGoCommand(["--worker"], deps));

      expect(r.code).toBe(0);
      // The queued card was NEVER handed to the runner.
      expect(runOnceCalls).toBe(0);
      expect(sleepCalls).toBeGreaterThanOrEqual(1); // waited for a free slot
      // The queue line is printed with the FIFO sequence + reason.
      expect(r.out).toContain("handoff queue seq=3 US-B — build_slot_full; awaiting a free slot");
      // A durable cycle:queued exists; NO admission/build was started for US-B.
      const events = readEvents(p);
      expect(events.some((e) => e.type === "cycle:queued" && e.storyId === "US-B")).toBe(true);
      expect(events.some((e) => e.type === "cycle:admitted" && "identity" in e && e.identity?.storyId === "US-B")).toBe(false);
      expect(events.some((e) => e.type === "cycle:start")).toBe(false);
    } finally {
      if (savedFlag === undefined) delete process.env["ROLL_CYCLE_HANDOFF_V1"];
      else process.env["ROLL_CYCLE_HANDOFF_V1"] = savedFlag;
    }
  });
});
