/**
 * US-INIT-003b — `roll attest` records `physical_terminal` evidence as its own kind
 * and rejects non-physical captures for physical_terminal ACs.
 *
 * AC1: `roll attest` records `physical_terminal` evidence as a distinct evidence kind.
 * AC2: For a `physical_terminal` AC, headless/transcript-rendered captures are rejected.
 * AC3: Non-`physical_terminal` cards are unaffected by the new rejection logic (regression).
 * AC4: On Linux/headless/no-GUI hosts the report honestly says blocked/missing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureScreenshot,
  WorkspaceRegistry,
  type CaptureFact,
  type EvidenceRun,
  type ScreenshotKind,
  type ShotRun,
} from "@roll/infra";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";
import { attestCommand } from "../src/commands/attest.js";
import {
  hasPhysicalTerminalCapture,
  hasRejectedTerminalForPhysical,
  owesPhysicalTerminalCapture,
  runAttestGate,
} from "../src/runner/attest-gate.js";
import { physicalTerminalFromSpecText } from "../src/lib/physical-terminal.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});

const T0 = new Date("2026-06-06T01:02:03");
const quietRun: EvidenceRun = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `roll-003b-${tag}-`)));
  dirs.push(d);
  return d;
}

function inDir<T>(proj: string, fn: () => Promise<T>): Promise<T> {
  const save = process.cwd();
  process.chdir(proj);
  return fn().finally(() => process.chdir(save));
}

function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (): boolean => true;
  // @ts-expect-error capture-only
  process.stderr.write = (): boolean => true;
  return fn().finally(() => {
    process.stdout.write = o;
    process.stderr.write = e;
  });
}

function doctorPhysicalSpec(id: string): string {
  return [
    "---",
    `id: ${id}`,
    "physical_terminal:",
    "  app: Terminal.app",
    "  command: roll doctor --tools",
    "  evidence: screenshot",
    "---",
    "",
    `# ${id} — Physical Terminal evidence`,
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] [visual-evidence] real physical Terminal.app screenshot proves the CLI output",
    "",
  ].join("\n");
}

function writePeerScore(wt: string, id: string, cycleId: string): void {
  const dir = join(wt, ".roll", "features", "init-onboard", id, "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `2026-06-08-roll-build-${id}-8.md`),
    [
      "---",
      "skill: roll-build",
      `story: ${id}`,
      "score: 8",
      "verdict: good",
      "ts: 2026-06-08T12:00:00Z",
      "scoring: pair",
      "scored-by: pi",
      `session-id: ${cycleId}:score:pi:a1:1700000000`,
      "---",
      "",
      "peer score fixture.",
    ].join("\n"),
  );
}

// ── AC0: ScreenshotKind includes physical_terminal ──
describe("ScreenshotKind includes physical_terminal", () => {
  it("physical_terminal is a valid ScreenshotKind", () => {
    const kinds: ScreenshotKind[] = ["web", "mobile-ios", "mobile-android", "terminal", "physical_terminal"];
    expect(kinds).toContain("physical_terminal");
  });
});

// ── AC4: physical_terminal captures honestly skip on headless ──
describe("AC4: physical_terminal capture skips on headless / no-GUI", () => {
  it("returns taken:false with blocked/missing reason on non-macOS", async () => {
    const out = join(tmp("linux"), "pt.png");
    const result = await captureScreenshot(
      { kind: "physical_terminal", out, command: "echo hello" },
      { platform: "linux", env: {} },
    );
    expect(result.taken).toBe(false);
    expect(result.skipped).toMatch(/physical_terminal/);
  });

  it("returns taken:false with blocked/missing reason when ROLL_NO_SCREENCAP=1", async () => {
    const out = join(tmp("noscreencap"), "pt.png");
    const result = await captureScreenshot(
      { kind: "physical_terminal", out, command: "echo hello" },
      { platform: "darwin", env: { ROLL_NO_SCREENCAP: "1" } },
    );
    expect(result.taken).toBe(false);
    expect(result.skipped).toMatch(/physical_terminal/);
  });

  it("returns taken:false with blocked/missing reason when ROLL_ATTEST_NO_TERMINAL=1", async () => {
    const out = join(tmp("noterm"), "pt.png");
    const result = await captureScreenshot(
      { kind: "physical_terminal", out, command: "echo hello" },
      { platform: "darwin", env: { ROLL_ATTEST_NO_TERMINAL: "1" } },
    );
    expect(result.taken).toBe(false);
    expect(result.skipped).toMatch(/physical_terminal/);
  });

  it("does NOT fall back to headless text artifact (unlike terminal lane)", async () => {
    const out = join(tmp("no-fallback"), "pt.png");
    const result = await captureScreenshot(
      { kind: "physical_terminal", out, command: "echo hello" },
      { platform: "linux", env: {} },
    );
    expect(result.taken).toBe(false);
    expect(result.skipped).toBeDefined();
    expect(result.skipped!.toLowerCase()).toMatch(/physical/);
  });
});

// ── AC1: evidence kind is "physical_terminal" ──
describe("AC1: evidence records kind: physical_terminal", () => {
  it("CaptureFact carries kind physical_terminal", () => {
    const fact: CaptureFact = { kind: "physical_terminal", out: "/tmp/pt.png", taken: true };
    expect(fact.kind).toBe("physical_terminal");
  });
});

// ── AC2: rejection of non-physical evidence for physical_terminal AC ──
describe("AC2: attest gate rejects non-physical evidence for physical_terminal ACs", () => {
  it("physicalTerminalFromSpecText returns spec for valid physical_terminal frontmatter", () => {
    const spec = [
      "---",
      "id: US-PT-TEST",
      "physical_terminal:",
      "  app: Terminal.app",
      "  command: roll doctor --tools",
      "  evidence: screenshot",
      "---",
      "",
      "# US-PT-TEST",
      "",
      "## Acceptance Criteria",
      "- [ ] [visual-evidence] real physical Terminal.app screenshot",
    ].join("\n");

    const pt = physicalTerminalFromSpecText(spec);
    expect(pt).not.toBeNull();
    expect(pt!.app).toBe("Terminal.app");
    expect(pt!.command).toBe("roll doctor --tools");
    expect(pt!.evidence).toBe("screenshot");
  });

  it("physicalTerminalFromSpecText returns null for non-physical_terminal spec", () => {
    const spec = [
      "---",
      "id: US-REGULAR",
      "deliverable_url: https://example.com",
      "---",
      "",
      "# US-REGULAR",
    ].join("\n");

    expect(physicalTerminalFromSpecText(spec)).toBeNull();
  });
});

// ── AC3: regression — non-physical_terminal cards unaffected ──
describe("AC3: non-physical_terminal cards unaffected", () => {
  it("regular terminal capture still works (kind: terminal)", async () => {
    const out = join(tmp("reg-term"), "t.png");
    const result = await captureScreenshot(
      { kind: "terminal", out, command: "echo hello" },
      {
        platform: "linux",
        env: {},
        run: async (_cmd, _argv) => ({ code: 0, stdout: "hello\n", stderr: "" }),
      },
    );
    expect(result.kind).toBe("terminal");
  });

  it("web capture still works with kind: web", async () => {
    const out = join(tmp("reg-web"), "w.png");
    const result = await captureScreenshot(
      { kind: "web", out, url: "https://example.com" },
      { platform: "linux", env: { ROLL_ATTEST_NO_BROWSER: "1" } },
    );
    expect(result.kind).toBe("web");
    expect(result.taken).toBe(false);
  });
});

// ── Attest gate: physical_terminal evidence validation ──
describe("Attest gate: physical_terminal evidence validation", () => {
  function physicalTerminalProject(id: string): string {
    const wt = tmp(`gate-${id}`);
    const specDir = join(wt, ".roll", "features", "init-onboard", id);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), [
      "---",
      `id: ${id}`,
      "physical_terminal:",
      "  app: Terminal.app",
      "  command: roll doctor --tools",
      "  evidence: screenshot",
      "---",
      "",
      `# ${id}`,
      "",
      "## Acceptance Criteria",
      "- [ ] [visual-evidence] real physical Terminal.app screenshot",
    ].join("\n"));
    return wt;
  }

  function withEvidenceManifest(wt: string, storyId: string, captures: CaptureFact[]): void {
    const cardDir = join(wt, ".roll", "features", "init-onboard", storyId);
    const latestDir = join(cardDir, "latest");
    mkdirSync(latestDir, { recursive: true });
    mkdirSync(join(cardDir, "screenshots"), { recursive: true });
    writeFileSync(join(cardDir, "screenshots", "pt.png"), "png\n");
    writeFileSync(join(latestDir, `evidence.json`), JSON.stringify({ captures }));
    writeFileSync(
      join(latestDir, `${storyId}-report.html`),
      `<html><body><section class="ac s-pass" id="${storyId}:AC1"><figure class="shot"><img src="screenshots/pt.png"></figure></section></body></html>`,
    );
    writeFileSync(
      join(cardDir, "ac-map.json"),
      JSON.stringify([{ ac: `${storyId}:AC1`, status: "pass", evidence: [{ kind: "screenshot", label: "terminal", href: "screenshots/pt.png" }] }]),
    );
  }

  it("owesPhysicalTerminalCapture returns true when spec has physical_terminal:", () => {
    const wt = physicalTerminalProject("US-PT-GATE-1");
    expect(owesPhysicalTerminalCapture(wt, "US-PT-GATE-1")).toBe(true);
  });

  it("owesPhysicalTerminalCapture returns false for non-physical_terminal cards", () => {
    const wt = tmp("no-pt");
    const specDir = join(wt, ".roll", "features", "uncategorized", "US-REGULAR");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), "---\nid: US-REGULAR\n---\n# US-REGULAR\n");
    expect(owesPhysicalTerminalCapture(wt, "US-REGULAR")).toBe(false);
  });

  it("hasPhysicalTerminalCapture returns true when evidence has kind:physical_terminal taken capture", () => {
    const wt = physicalTerminalProject("US-PT-GATE-2");
    withEvidenceManifest(wt, "US-PT-GATE-2", [
      { kind: "physical_terminal", out: "/tmp/pt.png", taken: true },
    ]);
    expect(hasPhysicalTerminalCapture(wt, "US-PT-GATE-2")).toBe(true);
  });

  it("hasPhysicalTerminalCapture returns false when evidence has kind:terminal (wrong kind)", () => {
    const wt = physicalTerminalProject("US-PT-GATE-3");
    withEvidenceManifest(wt, "US-PT-GATE-3", [
      { kind: "terminal", out: "/tmp/t.png", taken: true },
    ]);
    expect(hasPhysicalTerminalCapture(wt, "US-PT-GATE-3")).toBe(false);
  });

  it("hasPhysicalTerminalCapture returns false when capture is taken:false", () => {
    const wt = physicalTerminalProject("US-PT-GATE-4");
    withEvidenceManifest(wt, "US-PT-GATE-4", [
      { kind: "physical_terminal", out: "/tmp/pt.png", taken: false, skipped: "physical_terminal: not macOS" },
    ]);
    expect(hasPhysicalTerminalCapture(wt, "US-PT-GATE-4")).toBe(false);
  });

  it("hard gate blocks a skipped physical_terminal capture; owner-local macOS evidence stays required", () => {
    const wt = physicalTerminalProject("US-PT-GATE-SKIP");
    withEvidenceManifest(wt, "US-PT-GATE-SKIP", [
      { kind: "physical_terminal", out: "screenshots/terminal.png", taken: false, skipped: "ROLL_NO_SCREENCAP=1" },
    ]);
    writePeerScore(wt, "US-PT-GATE-SKIP", "c-phys-skip");
    const alerts: string[] = [];
    const events: Array<{ verdict: string; reasons: string[] }> = [];

    expect(hasPhysicalTerminalCapture(wt, "US-PT-GATE-SKIP")).toBe(false);
    const result = runAttestGate(wt, "US-PT-GATE-SKIP", "c-phys-skip", "hard", 0, {
      alert: (message) => alerts.push(message),
      event: (payload) => events.push(payload),
    });

    expect(result.verdict).toBe("skipped");
    expect(result.blocked).toBe(true);
    expect(result.reasons.join("\n")).toContain("physical_terminal declared");
    expect(alerts[0]).toContain("BLOCKED");
    expect(events[0]?.verdict).toBe("skipped");
  });

  it("hasRejectedTerminalForPhysical returns true when physical_terminal card has kind:terminal capture", () => {
    const wt = physicalTerminalProject("US-PT-GATE-5");
    withEvidenceManifest(wt, "US-PT-GATE-5", [
      { kind: "terminal", out: "/tmp/t.png", taken: true },
    ]);
    expect(hasRejectedTerminalForPhysical(wt, "US-PT-GATE-5")).toBe(true);
  });

  it("hasRejectedTerminalForPhysical returns false for non-physical_terminal cards", () => {
    const wt = tmp("no-pt-rej");
    const specDir = join(wt, ".roll", "features", "uncategorized", "US-REGULAR-2");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), "---\nid: US-REGULAR-2\n---\n# US-REGULAR-2\n");
    const latestDir = join(wt, ".roll", "features", "uncategorized", "US-REGULAR-2", "latest");
    mkdirSync(latestDir, { recursive: true });
    writeFileSync(join(latestDir, "evidence.json"), JSON.stringify({
      captures: [{ kind: "terminal", out: "/tmp/t.png", taken: true }],
    }));
    expect(hasRejectedTerminalForPhysical(wt, "US-REGULAR-2")).toBe(false);
  });
});

describe("US-INIT-003d: doctor --tools physical Terminal.app evidence", () => {
  it("roll attest maps a real doctor --tools Terminal.app screenshot into a passing AC", async () => {
    const proj = tmp("attest-gui");
    const cardDir = join(proj, ".roll", "features", "demo", "US-PHYS-4A");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "spec.md"), doctorPhysicalSpec("US-PHYS-4A"));
    writeFileSync(
      join(cardDir, "ac-map.json"),
      JSON.stringify(
        [
          {
            ac: "US-PHYS-4A:AC1",
            status: "pass",
            evidence: [{ kind: "screenshot", label: "real Terminal.app doctor --tools", href: "screenshots/terminal.png" }],
          },
        ],
        null,
        2,
      ) + "\n",
    );
    const guiShot: ShotRun = (cmd, argv) => {
      if (cmd === "sh") {
        const joined = argv.join(" ");
        if (joined.includes("lsappinfo")) return Promise.resolve({ code: 0, stdout: '"LSDisplayName"="Terminal"\n', stderr: "" });
        return Promise.resolve({ code: 0, stdout: "Tool readiness\nTerminal.app Screen Recording - ok\n", stderr: "" });
      }
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Aqua\n", stderr: "" });
      if (cmd === "osascript" && String(argv[1] ?? "").includes("bounds of w")) {
        return Promise.resolve({ code: 0, stdout: "0, 0, 1280, 800\n", stderr: "" });
      }
      if (cmd === "screencapture") {
        writeFileSync(String(argv[argv.length - 1]), "PNGDATA");
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYS-4A", "--capture-command", "roll doctor --tools"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: guiShot, platform: "darwin", env: {} },
        }),
      ),
    );

    const runDir = join(cardDir, "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "terminal.png"))).toBe(true);
    expect(existsSync(join(runDir, "screenshots", "terminal-headless.txt"))).toBe(false);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; out?: string }>;
    };
    expect(evidence.captures?.[0]).toMatchObject({ kind: "physical_terminal", taken: true });
    expect(evidence.captures?.[0]?.out).toContain("screenshots/terminal.png");
    const html = readFileSync(join(runDir, "US-PHYS-4A-report.html"), "utf8");
    expect(html).toContain('class="ac s-pass" id="US-PHYS-4A:AC1"');
    expect(html).toContain('src="screenshots/terminal.png"');
  });

  it("roll attest does not promote headless stdout fallback to physical Terminal.app evidence", async () => {
    const proj = tmp("attest-headless");
    const cardDir = join(proj, ".roll", "features", "demo", "US-PHYS-4");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "spec.md"), doctorPhysicalSpec("US-PHYS-4"));
    const headlessNoGui: ShotRun = (cmd) => {
      if (cmd === "sh") return Promise.resolve({ code: 0, stdout: "doctor tools output\n", stderr: "" });
      if (cmd === "launchctl") return Promise.resolve({ code: 0, stdout: "Background\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    await silenced(() =>
      inDir(proj, () =>
        attestCommand(["US-PHYS-4", "--capture-command", "roll doctor --tools"], {
          now: () => T0,
          run: quietRun,
          ghProbe: () => Promise.resolve(false),
          capture: { run: headlessNoGui, platform: "darwin", env: {} },
        }),
      ),
    );

    const runDir = join(cardDir, "2026-06-06T01-02-03");
    expect(existsSync(join(runDir, "screenshots", "terminal-headless.txt"))).toBe(false);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    expect(evidence.captures?.[0]).toMatchObject({ kind: "physical_terminal", taken: false });
    expect(evidence.captures?.[0]?.skipped).toMatch(/no GUI|screen|permission|macOS|Terminal/i);
  });

  // US-INIT-003d fix-forward regression: the public CLI entry point must honour
  // physical_terminal cards and refuse the headless text fallback. A stale
  // globally-installed `roll` binary produced kind:terminal + terminal-headless.txt
  // for this story; this subprocess test exercises the CLI exactly as the loop
  // invokes it, so the bundled dev entry point is the code under test.
  it("CLI entry point records physical_terminal skip for `roll doctor --tools` on a no-GUI host", () => {
    const proj = tmp("attest-cli-entry");
    const rollHome = tmp("attest-cli-roll-home");
    const remote = "https://example.test/workspaces/physical-cli.git";
    const repoId = repositoryIdFromRemote(remote);
    if (!repoId.ok) throw new Error("fixture remote must be valid");
    writeFileSync(join(proj, "workspace.yaml"), `${JSON.stringify({
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId: "physical-cli",
      displayName: "Physical CLI",
      requirements: [],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: repoId.value,
        alias: "product",
        remote,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    }, null, 2)}\n`, "utf8");
    mkdirSync(join(proj, "backlog"), { recursive: true });
    writeFileSync(join(proj, "backlog", "index.md"), "| ID | Description | Status |\n|----|----|----|\n", "utf8");
    const cardDir = join(proj, "features", "init-onboard", "US-PHYS-CLI");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "spec.md"), doctorPhysicalSpec("US-PHYS-CLI"));
    const registry = new WorkspaceRegistry({ rollHome });
    registry.register({ workspaceId: "physical-cli", root: proj });
    registry.activate("physical-cli");
    const here = dirname(fileURLToPath(import.meta.url));
    const rollBin = resolve(here, "..", "bin", "roll.js");

    const result = spawnSync(
      process.execPath,
      [rollBin, "attest", "US-PHYS-CLI", "--capture-command", `node ${rollBin} doctor --tools`],
      {
        cwd: proj,
        env: {
          ...process.env,
          ROLL_LANG: "en",
          ROLL_HOME: rollHome,
          ROLL_WORKSPACE: "physical-cli",
          NO_COLOR: "1",
          ROLL_ATTEST_NO_TERMINAL: "1",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // The command may warn about the skipped capture but exits 0 (attest degrades gracefully).
    expect(result.status).toBe(0);
    let runDir = "";
    for (const name of readdirIfPossible(cardDir)) {
      if (/^\d{4}-\d{2}-\d{2}T/.test(name) || /^\d{8}-\d{6}-\d+/.test(name)) {
        runDir = join(cardDir, name);
        break;
      }
    }
    expect(runDir).not.toBe("");
    expect(existsSync(join(runDir, "screenshots", "terminal-headless.txt"))).toBe(false);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ kind?: string; taken?: boolean; skipped?: string }>;
    };
    expect(evidence.captures?.[0]).toMatchObject({ kind: "physical_terminal", taken: false });
    expect(evidence.captures?.[0]?.skipped).toMatch(/physical_terminal/);
  });
});

function readdirIfPossible(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
