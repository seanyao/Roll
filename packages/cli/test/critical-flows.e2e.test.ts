/**
 * Critical CLI E2E coverage distilled from real loop incidents:
 * - pre-v3 loop logs carried aborted/preflight/publish-fail terminal records.
 * - v3 card minting must write card + backlog + index through one public entry.
 * - attest must parse modern card specs instead of producing facts-only shells.
 *
 * These tests run the public CLI subprocess from this checkout. They never call
 * the user's installed `roll` entry.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) execFileSync("rm", ["-rf", dir]);
});

function tmpProject(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `roll-e2e-${prefix}-`)));
  dirs.push(dir);
  mkdirSync(join(dir, ".roll", "features"), { recursive: true });
  return dir;
}

function tmpEmptyProject(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `roll-e2e-${prefix}-`)));
  dirs.push(dir);
  return dir;
}

function runRoll(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ROLL_LANG: "en",
    ...env,
  };
  delete childEnv["ROLL_PROJECT_RUNTIME_DIR"];
  delete childEnv["_LOOP_RUNS"];
  const result = spawnSync(process.execPath, [rollBin, ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? 1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function scrubExistingCodebaseSmokeOutput(text: string): string {
  return text
    .replace(/workspace: .+roll-init-existing-codebase-[^\n]+/g, "workspace: <existing-codebase-workspace>")
    .replace(/cleanup: removed .+roll-init-existing-codebase-[^\n]+/g, "cleanup: removed <existing-codebase-workspace>");
}

function scrubPartialLegacySmokeOutput(text: string): string {
  return text
    .replace(/workspace: .+roll-init-partial-legacy-[^\n]+/g, "workspace: <partial-legacy-workspace>")
    .replace(/cleanup: removed .+roll-init-partial-legacy-[^\n]+/g, "cleanup: removed <partial-legacy-workspace>");
}

function scrubNextJourneySmokeOutput(text: string): string {
  return text
    .replace(/workspace: .+roll-next-journey-[^\n]+/g, "workspace: <next-journey-workspace>")
    .replace(/cleanup: removed .+roll-next-journey-[^\n]+/g, "cleanup: removed <next-journey-workspace>");
}

describe("critical CLI E2E", () => {
  it("roll browser doctor projects an expired interactive lease from the project ledger", () => {
    const project = tmpProject("browser-lease-truth");
    const eventsPath = join(project, ".roll", "browser-operations", "events.ndjson");
    mkdirSync(dirname(eventsPath), { recursive: true });
    writeFileSync(eventsPath, [
      JSON.stringify({
        schema: "browser-ledger.v1",
        event: {
          type: "browser:lease-granted",
          leaseId: "lease-e2e",
          ts: "2026-07-15T00:00:00.000Z",
          storyId: "US-BROW-022",
          origin: "http://127.0.0.1:9222",
          actionSummary: "navigate to owner page",
          expiresAt: "2026-07-15T00:15:00.000Z",
          credentialExportDenied: true,
        },
      }),
      JSON.stringify({
        schema: "browser-ledger.v1",
        event: { type: "browser:lease-expired", leaseId: "lease-e2e", ts: "2026-07-15T00:15:00.000Z" },
      }),
      "",
    ].join("\n"));

    const result = runRoll(project, ["browser", "doctor"], { ROLL_RENDER_NOW: "2026-07-15T00:16:00.000Z" });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Browser operations facts");
    expect(result.out).toContain("interactive:   expired");
    expect(result.out).toContain("owner lease expired");
  });

  it("roll init diagnosis fixture prints the full state matrix without mutating cwd", () => {
    const project = tmpEmptyProject("init-diagnose");

    const result = runRoll(project, ["init", "--diagnose", "--fixture", "state-matrix"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("roll init diagnosis fixture: state-matrix");
    for (const kind of ["roll-partial", "roll-legacy-layout", "codebase-no-roll", "prd-only", "empty", "ambiguous"]) {
      expect(result.out).toContain(`Detected: ${kind}`);
    }
    expect(result.out).toContain("Already initialized.");
    expect(result.out).toContain("Recommended path: migrate-roll-layout");
    expect(result.out).toContain("Recommended path: scaffold-from-prd");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll init PRD-only attest smoke runs the intel-radar path and cleans up", () => {
    const project = tmpEmptyProject("init-prd-only-smoke");

    const result = runRoll(project, ["init", "--attest-smoke", "prd-only"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("roll init attest smoke: prd-only");
    expect(result.out).toContain("INIT");
    expect(result.out).toContain("Initialized");
    expect(result.out).toContain("Created files:");
    expect(result.out).toContain("AGENTS.md");
    expect(result.out).toContain(".roll/brief.md");
    expect(result.out).toContain(".roll/onboard-changeset.yaml");
    expect(result.out).toContain("roll design --from-file docs/intel-radar-PRD.md");
    expect(result.out).toContain("cleanup: removed");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll init existing-codebase diagnosis attest smoke runs isolated and cleans up", () => {
    const project = tmpEmptyProject("init-codebase-smoke");

    const result = runRoll(project, ["init", "--attest-smoke", "existing-codebase-diagnose"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("roll init attest smoke: existing-codebase-diagnose");
    expect(result.out).toContain("Fixture tree:");
    expect(result.out).toContain("package.json");
    expect(result.out).toContain("src/index.ts");
    expect(result.out).toContain("tests/index.test.ts");
    expect(result.out).toContain("Detected: existing codebase without Roll");
    expect(result.out).toContain("Recommended path: agentic-onboard");
    expect(result.out).toMatch(/facts hash: sha256:[0-9a-f]{64}/);
    expect(result.out).toContain("Next: $roll-onboard");
    expect(result.out).toContain("No files changed.");
    expect(result.out).toContain("cleanup: removed");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll init existing-codebase invalid-plan attest smoke refuses before mutation", () => {
    const project = tmpEmptyProject("init-invalid-plan-smoke");

    const result = runRoll(project, ["init", "--attest-smoke", "existing-codebase-invalid-plan"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("roll init attest smoke: existing-codebase-invalid-plan");
    expect(result.out).toContain("Fixture tree:");
    expect(result.out).toContain("package.json");
    expect(result.out).toContain("src/index.ts");
    expect(result.out).toContain("tests/index.test.ts");
    expect(result.out).toContain(".roll/init-diagnosis.yaml");
    expect(result.out).toContain(".roll/onboard-plan.yaml");
    expect(result.err).toContain("plan factsHash is stale: expected sha256:");
    expect(result.err).toContain("got sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
    expect(result.out).toContain("Post-apply mutation check:");
    expect(result.out).toContain("AGENTS.md: missing");
    expect(result.out).toContain(".roll/backlog.md: missing");
    expect(result.out).toContain(".gitignore: missing");
    expect(result.out).toContain("cleanup: removed");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll init existing-codebase review checkpoint attest smoke waits before mutation", () => {
    const project = tmpEmptyProject("init-review-smoke");

    const result = runRoll(project, ["init", "--attest-smoke", "existing-codebase-review"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    expect(result.err).toContain("Proceed with these changes? [y/N]");
    expect(result.err).toContain("No files changed.");
    expect(result.out).toContain("roll init attest smoke: existing-codebase-review");
    expect(result.out).toContain("Fixture tree:");
    expect(result.out).toContain("package.json");
    expect(result.out).toContain("src/index.ts");
    expect(result.out).toContain("tests/index.test.ts");
    expect(result.out).toContain(".roll/init-diagnosis.yaml");
    expect(result.out).toContain(".roll/onboard-plan.yaml");
    expect(result.out).toContain("Onboard apply review checkpoint");
    expect(result.out).toContain("Post-review mutation check:");
    expect(result.out).toContain("AGENTS.md: missing");
    expect(result.out).toContain(".roll/backlog.md: missing");
    expect(result.out).toContain(".gitignore: missing");
    expect(result.out).toContain("cleanup: removed");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll init integrated existing-codebase attest smoke applies, re-applies, and cleans up", () => {
    const project = tmpEmptyProject("init-codebase-integrated-smoke");

    const result = runRoll(project, ["init", "--attest-smoke", "existing-codebase"], {
      HOME: project,
      ROLL_ATTEST_NO_BROWSER: "1",
      ROLL_HOME: repoRoot,
      ROLL_PKG_DIR: repoRoot,
    });

    expect(result.code).toBe(0);
    expect(result.err).toContain("Proceed with these changes? [y/N]");
    const out = scrubExistingCodebaseSmokeOutput(result.out);
    expect(out).toContain("roll init attest smoke: existing-codebase");
    expect(out).toContain("workspace: <existing-codebase-workspace>");
    expect(out).toContain("Before fixture tree:");
    expect(out).toContain("Detected: existing codebase without Roll");
    expect(out).toContain("Onboard apply review checkpoint");
    expect(out).toContain("Apply result: pass (exit 0)");
    expect(out).toContain("After apply tree:");
    expect(out).toContain("Idempotent re-apply result: pass (exit 0)");
    expect(out).toContain("After idempotent re-apply tree:");
    expect(out).toContain(".claude/CLAUDE.md: present");
    expect(out).toContain("Idempotency checks:");
    expect(out).toContain("result: pass");
    expect(out).toContain("cleanup: removed <existing-codebase-workspace>");
    expect(out).toContain("Smoke summary:");
    expect(out).toContain("diagnosis: codebase-no-roll");
    expect(out).toContain("review checkpoint: shown");
    expect(out).toContain("apply result: pass");
    expect(out).toContain("idempotent re-apply result: pass");
    expect(out).toContain("idempotency checks: pass");
    expect(out).toContain("cleanup: removed");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll init partial and legacy attest smoke repairs, routes migration, and cleans up", () => {
    const project = tmpEmptyProject("init-partial-legacy-smoke");

    const result = runRoll(project, ["init", "--attest-smoke", "partial-and-roll-legacy"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    const out = scrubPartialLegacySmokeOutput(result.out);
    expect(out).toContain("roll init attest smoke: partial-and-roll-legacy");
    expect(out).toContain("workspace: <partial-legacy-workspace>");
    expect(out).toContain("Partial Roll diagnosis:");
    expect(out).toContain("Detected: roll-partial");
    expect(out).toContain("Partial repair result: pass");
    expect(out).toContain("Idempotent repair result: pass");
    expect(out).toContain("Legacy Roll diagnosis:");
    expect(out).toContain("Detected: roll-legacy-layout");
    expect(out).toContain("Recommended path: migrate-roll-layout");
    expect(out).toContain("Legacy mutation check:");
    expect(out).toContain("AGENTS.md: missing");
    expect(out).toContain(".roll/: missing");
    expect(out).toContain("cleanup: removed <partial-legacy-workspace>");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll next init journey attest smoke renders each next action and cleans up", () => {
    const project = tmpEmptyProject("next-init-journey-smoke");

    const result = runRoll(project, ["next", "--attest-smoke", "init-journey"], {
      ROLL_ATTEST_NO_BROWSER: "1",
    });

    expect(result.code).toBe(0);
    const out = scrubNextJourneySmokeOutput(result.out);
    expect(out).toContain("roll next attest smoke: init-journey");
    expect(out).toContain("workspace: <next-journey-workspace>");
    expect(out).toContain("[prd-only]");
    expect(out).toContain("Next: roll design --from-file docs/PRD.md");
    expect(out).toContain("[codebase-onboard]");
    expect(out).toContain("Next: roll init --apply");
    expect(out).toContain("[partial-roll]");
    expect(out).toContain("Next: roll init --repair");
    expect(out).toContain("[old-roll-layout]");
    expect(out).toContain("Next: npx @seanyao/roll@2 migrate --dry-run");
    expect(out).toContain("[roll-ready]");
    expect(out).toContain("Next: roll loop go");
    expect(out).toContain("cleanup: removed <next-journey-workspace>");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, ".roll"))).toBe(false);
  });

  it("roll story new is the single card-minting entry: card folder + backlog row + index", () => {
    const project = tmpProject("story-new");
    writeFileSync(join(project, ".roll", "backlog.md"), "| Story | Description | Status |\n|---|---|---|\n");

    const result = runRoll(project, ["story", "new", "FIX-901", "--title", "critical e2e card", "--epic", "qa-testing"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("card minted");
    expect(result.out).toContain("backlog row appended");
    expect(existsSync(join(project, ".roll", "features", "qa-testing", "FIX-901", "spec.md"))).toBe(true);
    expect(readFileSync(join(project, ".roll", "backlog.md"), "utf8")).toContain(
      "| [FIX-901](.roll/features/qa-testing/FIX-901/spec.md) | critical e2e card | 📋 Todo |",
    );
    const index = JSON.parse(readFileSync(join(project, ".roll", "index.json"), "utf8")) as { stories: Record<string, string> };
    expect(index.stories["FIX-901"]).toBe("qa-testing");
  });

  it("roll attest parses modern `## Acceptance Criteria` specs instead of facts-only reports", () => {
    const project = tmpProject("attest-modern-ac");
    const storyDir = join(project, ".roll", "features", "acceptance-evidence", "FIX-902");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "spec.md"),
      [
        "---",
        "id: FIX-902",
        "title: modern AC parsing",
        "type: fix",
        "epic: acceptance-evidence",
        "created: 2026-06-12",
        "---",
        "",
        "# FIX-902 — modern AC parsing",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] AC1 report renders this checklist",
        "- [ ] AC2 report stays claim-only without ac-map",
        "",
      ].join("\n"),
    );

    const result = runRoll(project, ["attest", "FIX-902"]);

    expect(result.code).toBe(0);
    expect(result.err).not.toContain("no **AC:** block");
    const report = readFileSync(join(storyDir, "latest", "FIX-902-report.html"), "utf8");
    expect(report).toContain("FIX-902:AC1");
    expect(report).toContain("AC1 report renders this checklist");
    expect(report).toContain("Claimed");
  });

  it("physical_terminal stories validate and attest without headless stdout masquerading as pixels", () => {
    const project = tmpProject("physical-terminal");
    const storyDir = join(project, ".roll", "features", "acceptance-evidence", "US-PHYS-E2E");
    mkdirSync(storyDir, { recursive: true });
    const command = `node ${rollBin} doctor --tools`;
    writeFileSync(
      join(storyDir, "spec.md"),
      [
        "---",
        "id: US-PHYS-E2E",
        "title: physical terminal evidence e2e",
        "type: us",
        "epic: acceptance-evidence",
        "created: 2026-06-26",
        `deliverable_cmd: ${command}`,
        "physical_terminal:",
        "  app: Terminal.app",
        `  command: ${command}`,
        "  evidence: screenshot",
        "---",
        "",
        "# US-PHYS-E2E — physical terminal evidence e2e",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] [visual-evidence] real physical Terminal.app screenshot proves the CLI output",
        "",
      ].join("\n"),
    );

    const validate = runRoll(project, ["story", "validate", "US-PHYS-E2E"]);
    expect(validate.code).toBe(0);
    expect(validate.out).toContain("visual-evidence: ok (surface: terminal)");

    const attest = runRoll(project, ["attest", "US-PHYS-E2E", "--capture-command", command], {
      ROLL_NO_SCREENCAP: "1",
    });
    expect(attest.code).toBe(0);
    const latest = join(storyDir, "latest");
    expect(existsSync(join(latest, "screenshots", "terminal-headless.txt"))).toBe(false);
    const evidence = JSON.parse(readFileSync(join(latest, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    expect(evidence.captures?.[0]).toMatchObject({ kind: "physical_terminal", taken: false });
    expect(evidence.captures?.[0]?.skipped).toContain("ROLL_NO_SCREENCAP");
  });

  it("cards can declare fullscreen capture and attest degrades gracefully without Roll Capture.app", () => {
    const project = tmpProject("fullscreen-declare");
    const storyDir = join(project, ".roll", "features", "capture-tool", "US-PHYS-007-E2E");
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, "spec.md"),
      [
        "---",
        "id: US-PHYS-007-E2E",
        "title: fullscreen declaration e2e",
        "type: us",
        "epic: capture-tool",
        "created: 2026-07-05",
        "evidence_profile: physical",
        "capture_fullscreen: true",
        "deliverable_cmd: roll status",
        "---",
        "",
        "# US-PHYS-007-E2E — fullscreen declaration e2e",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] [visual-evidence] fullscreen screenshot is declared explicitly",
        "",
      ].join("\n"),
    );

    const validate = runRoll(project, ["story", "validate", "US-PHYS-007-E2E"]);
    expect(validate.code).toBe(0);
    expect(validate.out).toContain("visual-evidence: ok");

    const attest = runRoll(project, ["attest", "US-PHYS-007-E2E"], {
      ROLL_NO_SCREENCAP: "1",
    });
    expect(attest.code).toBe(0);
    const latest = join(storyDir, "latest");
    const evidence = JSON.parse(readFileSync(join(latest, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    const capture = evidence.captures?.find((c) => c.kind === "display");
    expect(capture).toBeDefined();
    expect(capture!.taken).toBe(false);
    expect(capture!.skipped).toBeDefined();
  });

  it("roll doctor --tools is a focused tool and screenshot-readiness smoke", () => {
    const project = tmpProject("doctor-tools");
    const result = runRoll(project, ["doctor", "--tools"], {
      _ROLL_EXTERNAL_TOOLS_PLATFORM: "linux",
      ROLL_NO_SCREENCAP: "1",
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Tool readiness");
    expect(result.out).toContain("External requirements");
    expect(result.out).toContain("macOS screencapture");
    expect(result.out).toContain("Terminal.app Screen Recording");
    expect(result.out).not.toContain("Skill catalog");
    expect(result.out).not.toContain("PR review extras");
  });

  it("roll loop runs reads real pre-v3 terminal patterns through the public CLI", () => {
    const project = tmpProject("loop-runs");
    const runtime = join(project, ".roll", "loop");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, "runs.jsonl"),
      [
        JSON.stringify({
          ts: "2026-05-27T11:54:43Z",
          project: "roll-ecf079",
          run_id: "loop-20260527-194711",
          status: "failed",
          built: [],
          skipped: [],
          alerts: ["agent_invoke"],
          tcr_count: 0,
          duration_sec: 743,
          reason: "agent_invoke aborted",
        }),
        JSON.stringify({
          ts: "2026-06-04T03:41:12Z",
          project: "roll-ecf079",
          run_id: "loop-20260604-113328",
          status: "failed",
          built: [],
          skipped: [],
          alerts: ["publish_pr"],
          tcr_count: 0,
          duration_sec: 600,
          reason: "PR publish failed",
        }),
        JSON.stringify({
          ts: "2026-06-06T19:45:25Z",
          project: "roll-ecf079",
          run_id: "loop-20260606-1945",
          status: "built",
          built: ["US-CLI-003"],
          skipped: [],
          alerts: [],
          tcr_count: 4,
          duration_sec: 1662,
        }),
      ].join("\n") + "\n",
    );

    const result = runRoll(project, ["loop", "runs", "--all", "3"], {
      ROLL_LOOP_RUNS_ALL_DIRS: runtime,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("[roll-ecf079] ✅ built 1 item");
    expect(result.out).toContain("US-CLI-003");
    expect(result.out).toContain("[roll-ecf079] ✗ FAILED — PR publish failed");
    expect(result.out).toContain("[roll-ecf079] ✗ FAILED — agent_invoke aborted");
  });
});
