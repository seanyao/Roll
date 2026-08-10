/**
 * US-ONBOARD-NUDGE-004 — `roll design` unit tests.
 *
 * All agent selection and spawn behaviour is verified through an injected spawn
 * adapter and a temporary ROLL_HOME/PATH; no real agent is launched.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { designCommand, type DesignCommandDeps } from "../src/commands/design.js";

const REPO = resolve(__dirname, "../../..");

type SpawnCall = { bin: string; args: string[]; opts: { cwd: string } };
type LoopGoCall = { args: string[] };
type StderrCapture = { out: { data: string }; restore: () => void };

function freshHome(): { home: string; bin: string } {
  const home = mkdtempSync(join(tmpdir(), "roll-design-home-"));
  const bin = mkdtempSync(join(tmpdir(), "roll-design-bin-"));
  mkdirSync(join(home, ".roll"), { recursive: true });
  return { home: join(home, ".roll"), bin };
}

function freshProj(): string {
  const proj = mkdtempSync(join(tmpdir(), "roll-design-proj-"));
  mkdirSync(join(proj, ".roll"), { recursive: true });
  return proj;
}

function writeConfig(home: string, lines: string): void {
  writeFileSync(join(home, "config.yaml"), lines, "utf8");
}

function makeAgent(bin: string, name: string): void {
  const path = join(bin, name);
  writeFileSync(path, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(path, 0o755);
}

function makeDeps(proj: string, bin: string): DesignCommandDeps & { calls: SpawnCall[]; loopGoCalls: LoopGoCall[] } {
  const calls: SpawnCall[] = [];
  const loopGoCalls: LoopGoCall[] = [];
  return {
    cwd: proj,
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    readLine: () => null,
    spawn: (binName, args, opts) => {
      calls.push({ bin: binName, args, opts: { cwd: String(opts.cwd ?? "") } });
      return { status: 0, signal: null };
    },
    runLoopGo: (args) => {
      loopGoCalls.push({ args });
      return 0;
    },
    calls,
    loopGoCalls,
  };
}

describe("roll design", () => {
  let home: string;
  let bin: string;
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const f = freshHome();
    home = f.home;
    bin = f.bin;
    dirs.push(home, bin);
    savedEnv["ROLL_HOME"] = process.env["ROLL_HOME"];
    savedEnv["ROLL_PKG_DIR"] = process.env["ROLL_PKG_DIR"];
    savedEnv["ROLL_DESIGN_AGENT"] = process.env["ROLL_DESIGN_AGENT"];
    savedEnv["ROLL_LANG"] = process.env["ROLL_LANG"];
    process.env["ROLL_HOME"] = home;
    process.env["ROLL_PKG_DIR"] = REPO;
    process.env["ROLL_LANG"] = "en";
    delete process.env["ROLL_DESIGN_AGENT"];
  });

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prints help and exits 0", () => {
    const out = { data: "" };
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.data += String(s);
      return true;
    });
    const code = designCommand(["--help"]);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out.data).toContain("Usage: roll design");
    expect(out.data).toContain("--from-file <path>");
    expect(out.data).toContain("\"<requirement>\"");
    expect(out.data).toContain("ROLL_DESIGN_AGENT");
  });

  it("fails with usage on unknown flag", () => {
    const code = designCommand(["--unknown"]);
    expect(code).toBe(1);
  });

  it("fails in a non-roll project", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-design-noroll-"));
    dirs.push(proj);
    writeConfig(home, "# config\n");
    const code = designCommand([], { cwd: proj });
    expect(code).toBe(1);
  });

  it("fails when the skill file is missing", () => {
    const proj = freshProj();
    dirs.push(proj);
    writeConfig(home, "# config\n");
    makeAgent(bin, "claude");
    const badPkg = mkdtempSync(join(tmpdir(), "roll-design-pkg-"));
    dirs.push(badPkg);
    process.env["ROLL_PKG_DIR"] = badPkg;
    const code = designCommand([], { cwd: proj });
    expect(code).toBe(1);
  });

  it("fails when no agent is installed", () => {
    const proj = freshProj();
    dirs.push(proj);
    writeConfig(home, "# config\n");
    const code = designCommand([], { cwd: proj });
    expect(code).toBe(1);
  });

  it("spawns claude when selected by --agent", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    makeAgent(bin, "kimi");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["--agent", "claude"], d);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.bin).toBe("claude");
    expect(d.calls[0]?.args).toHaveLength(1);
    expect(d.calls[0]?.args[0]).toContain("Run the $roll-design skill");
    expect(d.calls[0]?.args[0]).toContain("Load when the user wants to discuss approaches");
    expect(d.calls[0]?.opts.cwd).toBe(proj);
  });

  it("accepts the init-suggested --from-file handoff and binds the source file in the prompt", () => {
    const proj = freshProj();
    dirs.push(proj);
    mkdirSync(join(proj, "docs"), { recursive: true });
    writeFileSync(join(proj, "docs", "intel-radar-PRD.md"), "# Intel Radar PRD\n", "utf8");
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["--from-file", "docs/intel-radar-PRD.md"], d);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.bin).toBe("claude");
    expect(d.calls[0]?.args[0]).toContain("Use this product brief file as the design input: docs/intel-radar-PRD.md");
  });

  it("fails loud when --from-file has no value", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["--from-file"], d);
    expect(code).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("fails loud when --from-file points at a missing file", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["--from-file", "docs/missing.md"], d);
    expect(code).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("selects agent from ROLL_DESIGN_AGENT", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "kimi");
    makeAgent(bin, "pi");
    writeConfig(home, "lang: en\nai_kimi: ~/.kimi\n");
    process.env["ROLL_DESIGN_AGENT"] = "kimi";
    const d = makeDeps(proj, bin);
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls[0]?.bin).toBe("kimi");
  });

  it("uses primary_agent when installed and multiple agents exist", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    makeAgent(bin, "pi");
    writeConfig(home, "lang: en\nprimary_agent: pi\nai_claude: ~/.claude\nai_pi: ~/.pi\n");
    const d = makeDeps(proj, bin);
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls[0]?.bin).toBe("pi");
  });

  it("auto-selects the only installed agent", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls[0]?.bin).toBe("claude");
  });

  it("prompts interactively when multiple agents are installed and no primary is set", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    makeAgent(bin, "kimi");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\nai_kimi: ~/.kimi\n");
    const d = makeDeps(proj, bin);
    d.readLine = () => "2";
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls[0]?.bin).toBe("kimi");
  });

  it("is fail-loud for an unknown --agent", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["--agent", "unknown"], d);
    expect(code).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("is fail-loud for an unknown ROLL_DESIGN_AGENT", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    process.env["ROLL_DESIGN_AGENT"] = "bogus";
    const d = makeDeps(proj, bin);
    const code = designCommand([], d);
    expect(code).toBe(1);
    expect(d.calls).toHaveLength(0);
  });

  it("ignores an uninstalled primary_agent and prompts", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    makeAgent(bin, "kimi");
    writeConfig(home, "lang: en\nprimary_agent: pi\nai_claude: ~/.claude\nai_kimi: ~/.kimi\n");
    const d = makeDeps(proj, bin);
    d.readLine = () => "1";
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls[0]?.bin).toBe("claude");
  });

  it("returns the spawn exit code", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    d.spawn = (binName, args, opts) => {
      d.calls.push({ bin: binName, args, opts: { cwd: String(opts.cwd ?? "") } });
      return { status: 42, signal: null };
    };
    const code = designCommand([], d);
    expect(code).toBe(42);
  });

  it("bare design with non-empty backlog prints bounded help and does not spawn", () => {
    const proj = freshProj();
    dirs.push(proj);
    // Write a non-empty backlog
    const backlog = [
      "| Story | Description | Status |",
      "|-------|-------------|--------|",
      "| [US-TEST-001](.roll/features/test/US-TEST-001/spec.md) | Test item | 📋 Todo |",
    ].join("\n") + "\n";
    writeFileSync(join(proj, ".roll", "backlog.md"), backlog, "utf8");
    const d = makeDeps(proj, bin);
    const out = { data: "" };
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.data += String(s);
      return true;
    });
    const code = designCommand([], d);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out.data).toContain("No design target given");
    expect(out.data).toContain("--from-file");
    expect(d.calls).toHaveLength(0);
  });

  it("bare design with empty backlog still spawns agent (onboarding path)", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.bin).toBe("claude");
  });

  it("bare design with only done backlog rows still spawns agent (onboarding path)", () => {
    const proj = freshProj();
    dirs.push(proj);
    writeFileSync(
      join(proj, ".roll", "backlog.md"),
      [
        "| Story | Description | Status |",
        "|-------|-------------|--------|",
        "| [US-DONE-001](.roll/features/test/US-DONE-001/spec.md) | Delivered item | ✅ Done |",
      ].join("\n") + "\n",
      "utf8",
    );
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand([], d);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
  });

  it("design with positional requirement text includes it in the prompt", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["build a login system"], d);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.args[0]).toContain("Design requirement: build a login system");
  });

  it("--from-file and positional requirement text are mutually exclusive", () => {
    const proj = freshProj();
    dirs.push(proj);
    const req = join(proj, "req.md");
    writeFileSync(req, "# Requirement\n", "utf8");
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const code = designCommand(["--from-file", "req.md", "extra target"], d);
    expect(code).toBe(1);
    expect(d.calls).toHaveLength(0);
  });
});

function captureStderr(fn: () => number): string {
  const out: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((s: unknown) => {
    out.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out.join("");
}

function startStderrCapture(): StderrCapture {
  const out = { data: "" };
  const original = process.stderr.write;
  process.stderr.write = ((s: unknown) => {
    out.data += String(s);
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

function readSingleTranscript(proj: string): string {
  const runsDir = join(proj, ".roll", "runs", "design");
  const entries = readdirSync(runsDir);
  expect(entries.length).toBe(1);
  return readFileSync(join(runsDir, entries[0] ?? "x", "transcript.log"), "utf8");
}

function claudeTextLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function claudeStreamFixture(longPrompt: string): string {
  return [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: longPrompt }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "echo 'loaded roll-design contract'" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "loaded roll-design contract" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: ".roll/features/acceptance-evidence/IDEA-066/spec.md" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "" }] } }),
  ].join("\n");
}

describe("roll design bounded progress and handoff", () => {
  let home: string;
  let bin: string;
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const f = freshHome();
    home = f.home;
    bin = f.bin;
    dirs.push(home, bin);
    savedEnv["ROLL_HOME"] = process.env["ROLL_HOME"];
    savedEnv["ROLL_PKG_DIR"] = process.env["ROLL_PKG_DIR"];
    savedEnv["ROLL_DESIGN_AGENT"] = process.env["ROLL_DESIGN_AGENT"];
    savedEnv["ROLL_LANG"] = process.env["ROLL_LANG"];
    process.env["ROLL_HOME"] = home;
    process.env["ROLL_PKG_DIR"] = REPO;
    process.env["ROLL_LANG"] = "en";
    delete process.env["ROLL_DESIGN_AGENT"];
  });

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prints a start block before launching the agent", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const out = captureStderr(() => designCommand(["IDEA-066"], d));
    expect(out).toContain("Design run started");
    expect(out).toContain("target: IDEA-066");
    expect(out).toContain("agent: claude");
    expect(out).toContain("raw transcript:");
  });

  it("handoff for an IDEA target lists the Design Review Page, zero cards, and sign-off status", () => {
    const proj = freshProj();
    dirs.push(proj);
    writeFileSync(join(proj, ".roll", "index.json"), JSON.stringify({ stories: { "IDEA-066": "acceptance-evidence" } }), "utf8");
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    d.spawn = (binName, args, opts) => {
      d.calls.push({ bin: binName, args, opts: { cwd: String(opts.cwd ?? "") } });
      const feat = join(proj, ".roll", "features", "acceptance-evidence", "IDEA-066");
      mkdirSync(feat, { recursive: true });
      writeFileSync(join(feat, "spec.md"), "# IDEA-066\n\n## Detailed design\n", "utf8");
      writeFileSync(join(feat, "design-review.html"), "<html></html>", "utf8");
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const out = captureStderr(() => designCommand(["IDEA-066"], d));
    expect(out).toContain("Design Review Page handoff");
    expect(out).toContain("design: .roll/features/acceptance-evidence/IDEA-066/spec.md#detailed-design");
    expect(out).toContain("Design Review Page: .roll/features/acceptance-evidence/IDEA-066/design-review.html");
    expect(out).not.toContain("dossier");
    expect(out).toContain("cards: 0");
    expect(out).toContain("status: awaiting owner sign-off");
    expect(out).toContain("next:");
  });

  it("renders a Design Review Page when an IDEA detailed design is written", () => {
    const proj = freshProj();
    dirs.push(proj);
    writeFileSync(join(proj, ".roll", "index.json"), JSON.stringify({ stories: { "IDEA-066": "acceptance-evidence" } }), "utf8");
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    d.spawn = () => {
      const feat = join(proj, ".roll", "features", "acceptance-evidence", "IDEA-066");
      mkdirSync(feat, { recursive: true });
      writeFileSync(
        join(feat, "spec.md"),
        [
          "# IDEA-066 — Roll Capture.app",
          "",
          "## Detailed design",
          "",
          "## Architecture Map",
          "CaptureHostClient ---- request.json ----> Roll Capture.app",
          "",
          "## Flow",
          "validate evidence contract -> create capture request -> open app -> write response",
          "",
          "## Decision Matrix",
          "- Roll Capture.app stable host: chosen, one Screen Recording permission owner",
          "",
          "## Prototype Frames",
          "roll doctor --tools:",
          "Capture host: Roll Capture.app",
          "",
          "## Sign-off",
          "approve design -> roll design IDEA-066 --split",
          "",
        ].join("\n"),
        "utf8",
      );
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };

    const out = captureStderr(() => designCommand(["IDEA-066"], d));
    const reviewPath = join(proj, ".roll", "features", "acceptance-evidence", "IDEA-066", "design-review.html");
    expect(out).toContain("Design Review Page: .roll/features/acceptance-evidence/IDEA-066/design-review.html");
    expect(readFileSync(reviewPath, "utf8")).toContain("Design Review Page · IDEA-066");
  });

  it("suppresses the raw prompt and skill-contract firehose by default but shows artifact progress", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const longPrompt = "You are a helpful assistant. ".repeat(50);
    const raw = claudeStreamFixture(longPrompt);
    const d = makeDeps(proj, bin);
    d.spawn = () => ({ status: 0, signal: null, stdout: raw, stderr: "" });
    const out = captureStderr(() => designCommand(["build a thing"], d));
    expect(out).not.toContain(longPrompt);
    expect(out).not.toContain("loaded roll-design contract");
    expect(out).toContain("spec.md");
  });

  it("streams default progress and transcript writes before the child exits", async () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    let finish: (() => void) | undefined;
    d.spawn = (_binName, _args, _opts, live) => new Promise((resolveSpawn) => {
      live?.onStdout(`${claudeTextLine("Designing bounded contexts for the PRD")}\n`);
      finish = () => resolveSpawn({ status: 0, signal: null });
    });

    const cap = startStderrCapture();
    try {
      const run = Promise.resolve(designCommand(["build a thing"], d));
      await Promise.resolve();
      expect(cap.out.data).toContain("Designing bounded contexts");
      expect(cap.out.data).not.toContain("Design Review Page handoff");
      expect(readSingleTranscript(proj)).toContain("Designing bounded contexts");
      expect(finish).toBeTypeOf("function");
      finish?.();
      expect(await run).toBe(0);
      expect(cap.out.data).toContain("Design Review Page handoff");
    } finally {
      cap.restore();
    }
  });

  it("emits a live card-created event when backlog gains a new card", async () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    writeFileSync(join(proj, "brief.md"), "# Brief\n", "utf8");
    writeFileSync(join(proj, ".roll", "backlog.md"), ["| Story | Description | Status |", "|---|---|---|"].join("\n") + "\n", "utf8");
    const d = makeDeps(proj, bin);
    let finish: (() => void) | undefined;
    d.spawn = (_binName, _args, _opts, live) => new Promise((resolveSpawn) => {
      writeFileSync(
        join(proj, ".roll", "backlog.md"),
        [
          "| Story | Description | Status |",
          "|---|---|---|",
          "| [US-CLI-001](.roll/features/cli/US-CLI-001/spec.md) | Scaffold installable CLI · solves missing operator entrypoint | 📋 Todo |",
        ].join("\n") + "\n",
        "utf8",
      );
      live?.onStdout(`${claudeTextLine("Writing the first story spec")}\n`);
      finish = () => resolveSpawn({ status: 0, signal: null });
    });

    const cap = startStderrCapture();
    try {
      const run = Promise.resolve(designCommand(["--from-file", "brief.md"], d));
      await Promise.resolve();
      expect(cap.out.data).toContain("card created: US-CLI-001");
      expect(cap.out.data).toContain("Scaffold installable CLI");
      expect(cap.out.data).toContain("solves missing operator entrypoint");
      expect(cap.out.data).not.toContain("cards: 1");
      expect(finish).toBeTypeOf("function");
      finish?.();
      expect(await run).toBe(0);
      expect(cap.out.data).toContain("cards: 1");
    } finally {
      cap.restore();
    }
  });

  it("offers loop go after a successful design creates a Todo card and default decline keeps manual command", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    makeAgent(bin, "pi");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\nai_pi: ~/.pi\n");
    writeFileSync(join(proj, "brief.md"), "# Brief\n", "utf8");
    writeFileSync(join(proj, ".roll", "backlog.md"), ["| Story | Description | Status |", "|---|---|---|"].join("\n") + "\n", "utf8");
    mkdirSync(join(proj, ".roll", "loop"), { recursive: true });
    writeFileSync(
      join(proj, ".roll", "loop", "rig-lifecycle.json"),
      JSON.stringify({ rigs: { pi: { status: "suspended", cause: "quota", detail: "quota exceeded" } } }),
      "utf8",
    );
    const d = makeDeps(proj, bin);
    d.spawn = () => {
      writeFileSync(
        join(proj, ".roll", "backlog.md"),
        [
          "| Story | Description | Status |",
          "|---|---|---|",
          "| [US-CLI-001](.roll/features/cli/US-CLI-001/spec.md) | Scaffold installable CLI | 📋 Todo |",
        ].join("\n") + "\n",
        "utf8",
      );
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const out = captureStderr(() => designCommand(["--agent", "claude", "--from-file", "brief.md"], d));
    expect(out).toContain("Agent pool: 1 active, 1 suspended");
    expect(out).toContain("suspended: pi (quota)");
    expect(out).toContain("Start loop now? [y/N]");
    expect(out).toContain("Next: roll loop go --review auto");
    expect(d.loopGoCalls).toHaveLength(0);
  });

  it("starts loop go with auto review when the post-design prompt is accepted", async () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    writeFileSync(join(proj, "brief.md"), "# Brief\n", "utf8");
    writeFileSync(join(proj, ".roll", "backlog.md"), ["| Story | Description | Status |", "|---|---|---|"].join("\n") + "\n", "utf8");
    const d = makeDeps(proj, bin);
    d.readLine = () => "y";
    d.spawn = () => {
      writeFileSync(
        join(proj, ".roll", "backlog.md"),
        [
          "| Story | Description | Status |",
          "|---|---|---|",
          "| [US-CLI-001](.roll/features/cli/US-CLI-001/spec.md) | Scaffold installable CLI | 📋 Todo |",
        ].join("\n") + "\n",
        "utf8",
      );
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const code = await Promise.resolve(designCommand(["--from-file", "brief.md"], d));
    expect(code).toBe(0);
    expect(d.loopGoCalls).toEqual([{ args: ["--review", "auto"] }]);
  });

  it("returns the loop go exit code when accepted startup fails", async () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    writeFileSync(join(proj, "brief.md"), "# Brief\n", "utf8");
    writeFileSync(join(proj, ".roll", "backlog.md"), ["| Story | Description | Status |", "|---|---|---|"].join("\n") + "\n", "utf8");
    const d = makeDeps(proj, bin);
    d.readLine = () => "y";
    d.runLoopGo = (args) => {
      d.loopGoCalls.push({ args });
      return 23;
    };
    d.spawn = () => {
      writeFileSync(
        join(proj, ".roll", "backlog.md"),
        [
          "| Story | Description | Status |",
          "|---|---|---|",
          "| [US-CLI-001](.roll/features/cli/US-CLI-001/spec.md) | Scaffold installable CLI | 📋 Todo |",
        ].join("\n") + "\n",
        "utf8",
      );
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const code = await Promise.resolve(designCommand(["--from-file", "brief.md"], d));
    expect(code).toBe(23);
    expect(d.loopGoCalls).toEqual([{ args: ["--review", "auto"] }]);
  });

  it("does not offer loop go when design fails or creates no Todo card", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    d.spawn = () => ({ status: 1, signal: null, stdout: "", stderr: "" });
    const out = captureStderr(() => designCommand(["build a thing"], d));
    expect(out).not.toContain("Start loop now?");
    expect(d.loopGoCalls).toHaveLength(0);
  });

  it("keeps the intel-radar-shaped noise out of default live progress", async () => {
    const proj = freshProj();
    dirs.push(proj);
    mkdirSync(join(proj, "docs"), { recursive: true });
    writeFileSync(join(proj, "docs", "intel-radar-PRD.md"), "# PRD\n", "utf8");
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const noisy = [
      '$roll-design "What approach should we use for search? Postgres FTS or Meilisearch?"',
      "- [ ] Is the ID generation algorithm consistent?",
      "- [ ] Who writes the data? (Producer)",
      "?? .roll/",
      "?? AGENTS.md",
      claudeTextLine("Designing: bounded contexts selected for ingestion, scoring, and digest output"),
    ].join("\n") + "\n";
    const d = makeDeps(proj, bin);
    let finish: (() => void) | undefined;
    d.spawn = (_binName, _args, _opts, live) => new Promise((resolveSpawn) => {
      live?.onStdout(noisy);
      finish = () => resolveSpawn({ status: 0, signal: null });
    });

    const cap = startStderrCapture();
    try {
      const run = Promise.resolve(designCommand(["--from-file", "docs/intel-radar-PRD.md"], d));
      await Promise.resolve();
      expect(cap.out.data).toContain("bounded contexts selected");
      expect(cap.out.data).not.toContain("What approach should we use for search");
      expect(cap.out.data).not.toContain("ID generation algorithm");
      expect(cap.out.data).not.toContain("Who writes the data");
      expect(cap.out.data).not.toContain("?? .roll/");
      expect(finish).toBeTypeOf("function");
      finish?.();
      expect(await run).toBe(0);
    } finally {
      cap.restore();
    }
  });

  // ── FIX-1076: generic-agent (codex) live view suppresses echoed skill prompt,
  // template examples, repeated diffs and raw peer-review shell; keeps real
  // progress and surfaces peer review as one structured event. ──────────────
  const NOISY_DESIGN_STREAM = [
    // skill hub / gate / contract instruction echo
    "This hub keeps the routing boundary, hard gates, and execution skeleton in context.",
    "- **Evaluation contract (US-SKILL-030)**: every newly split story spec MUST carry it.",
    "## Bounded Contexts",
    "| Context | Boundary | Core concepts |",
    "│ [peer] Direction Review │ ← if complexity=medium/large",
    // template DDD teaching example from another domain
    "- Order Context (OrderPlaced, OrderShipped, OrderCancelled)",
    "支付失败后如何回滚库存预留？",
    "| [US-{DOMAIN}-{N}](.roll/features/<epic>/US-{DOMAIN}-{N}/spec.md) | {one-line} | 📋 Todo |",
    // echoed diff (first copy)
    "diff --git a/.roll/domain/context-map.md b/.roll/domain/context-map.md",
    "+++ b/.roll/domain/context-map.md",
    "+# intel-radar Domain Context Map",
    "+ published_at?: string;",
    // raw shell / tool echo
    `/bin/zsh -lc "sed -n '1,260p' .roll/backlog.md" in /Users/x/intel-radar[main]`,
    // real progress
    "This is effectively greenfield: no app source exists yet, and the backlog is empty.",
    // echoed diff AGAIN (dedup target)
    "diff --git a/.roll/domain/context-map.md b/.roll/domain/context-map.md",
    "+ published_at?: string;",
    // peer review invocations (raw shell) — surfaced as one event each, deduped
    `/bin/zsh -lc 'claude -p '"'"'[PEER_REVIEW round=1 tool=codex→claude] ...'"'"''`,
    `/bin/zsh -lc 'kimi -p '"'"'[PEER_REVIEW round=1 tool=codex→kimi] ...'"'"''`,
    `/bin/zsh -lc 'claude -p '"'"'[PEER_REVIEW round=1 tool=codex→claude] ...'"'"''`,
  ].join("\n") + "\n";

  function codexProj(): string {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "codex");
    writeConfig(home, "lang: en\nai_codex: ~/.codex\n");
    return proj;
  }

  it("codex live view drops skill prompt, template examples, diffs and raw shell", () => {
    const proj = codexProj();
    const d = makeDeps(proj, bin);
    d.spawn = (_b, _a, _o, live) => {
      live?.onStdout(NOISY_DESIGN_STREAM);
      return { status: 0, signal: null };
    };
    const out = captureStderr(() => designCommand(["--agent", "codex", "design a thing"], d));
    // real progress survives
    expect(out).toContain("greenfield");
    // skill prompt / contract echo gone (AC1)
    expect(out).not.toContain("routing boundary");
    expect(out).not.toContain("Evaluation contract");
    expect(out).not.toContain("Bounded Contexts");
    // template / other-domain example gone (AC2)
    expect(out).not.toContain("Order Context");
    expect(out).not.toContain("回滚库存");
    expect(out).not.toContain("{DOMAIN}");
    // echoed diff / code gone (AC1)
    expect(out).not.toContain("diff --git");
    expect(out).not.toContain("published_at");
    // raw shell gone (AC4)
    expect(out).not.toContain("/bin/zsh");
    expect(out).not.toContain("sed -n");
  });

  it("codex live view surfaces peer review as one structured event, deduped", () => {
    const proj = codexProj();
    const d = makeDeps(proj, bin);
    d.spawn = (_b, _a, _o, live) => {
      live?.onStdout(NOISY_DESIGN_STREAM);
      return { status: 0, signal: null };
    };
    const out = captureStderr(() => designCommand(["--agent", "codex", "design a thing"], d));
    expect(out).toContain("peer review · codex → claude");
    expect(out).toContain("peer review · codex → kimi");
    // codex→claude appeared twice in the stream but is emitted once (AC3/AC4)
    expect(out.match(/peer review · codex → claude/g)?.length).toBe(1);
    // raw PEER_REVIEW payload never leaks
    expect(out).not.toContain("[PEER_REVIEW");
  });

  it("codex live view emits a repeated diff at most once (dedup, AC3)", () => {
    const proj = codexProj();
    const d = makeDeps(proj, bin);
    // A line that is NOT structural noise but repeats — must show exactly once.
    const repeated = "analyzed: greenfield · empty backlog\n".repeat(4);
    d.spawn = (_b, _a, _o, live) => {
      live?.onStdout(repeated);
      return { status: 0, signal: null };
    };
    const out = captureStderr(() => designCommand(["--agent", "codex", "design a thing"], d));
    expect(out.match(/analyzed: greenfield · empty backlog/g)?.length).toBe(1);
  });

  it("codex run preserves the full raw stream in transcript.log (AC6)", () => {
    const proj = codexProj();
    const d = makeDeps(proj, bin);
    d.spawn = (_b, _a, _o, live) => {
      live?.onStdout(NOISY_DESIGN_STREAM);
      return { status: 0, signal: null };
    };
    captureStderr(() => designCommand(["--agent", "codex", "design a thing"], d));
    const transcript = readSingleTranscript(proj);
    // everything the view dropped is still archived verbatim
    expect(transcript).toContain("routing boundary");
    expect(transcript).toContain("diff --git");
    expect(transcript).toContain("[PEER_REVIEW");
    expect(transcript).toContain("Order Context");
  });

  it("--verbose and --raw stream live before the child exits", async () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    let finishVerbose: (() => void) | undefined;
    d.spawn = (_binName, _args, _opts, live) => new Promise((resolveSpawn) => {
      live?.onStdout(`${claudeTextLine("Verbose-only design reasoning")}\n`);
      finishVerbose = () => resolveSpawn({ status: 0, signal: null });
    });
    const verboseCap = startStderrCapture();
    try {
      const run = Promise.resolve(designCommand(["--verbose", "IDEA-066"], d));
      await Promise.resolve();
      expect(verboseCap.out.data).toContain("Verbose-only design reasoning");
      expect(verboseCap.out.data).not.toContain("Design Review Page handoff");
      expect(finishVerbose).toBeTypeOf("function");
      finishVerbose?.();
      expect(await run).toBe(0);
    } finally {
      verboseCap.restore();
    }

    let finishRaw: (() => void) | undefined;
    d.spawn = (_binName, _args, _opts, live) => new Promise((resolveSpawn) => {
      live?.onStdout("raw live line\n");
      finishRaw = () => resolveSpawn({ status: 0, signal: null });
    });
    const rawCap = startStderrCapture();
    try {
      const run = Promise.resolve(designCommand(["--raw", "IDEA-066"], d));
      await Promise.resolve();
      expect(rawCap.out.data).toContain("raw live line");
      expect(rawCap.out.data).not.toContain("Design Review Page handoff");
      expect(finishRaw).toBeTypeOf("function");
      finishRaw?.();
      expect(await run).toBe(0);
    } finally {
      rawCap.restore();
    }
  });

  it("emits a quiet-period heartbeat while the child is still running", async () => {
    vi.useFakeTimers();
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    let now = Date.UTC(2026, 6, 2, 10, 0, 0);
    const d = { ...makeDeps(proj, bin), now: () => now, heartbeatMs: 1_000 };
    let finish: (() => void) | undefined;
    d.spawn = () => new Promise((resolveSpawn) => {
      finish = () => resolveSpawn({ status: 0, signal: null });
    });

    const cap = startStderrCapture();
    try {
      const run = Promise.resolve(designCommand(["IDEA-066"], d));
      await Promise.resolve();
      expect(cap.out.data).not.toContain("heartbeat: still designing");
      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cap.out.data).toContain("heartbeat: still designing");
      expect(cap.out.data).toContain("elapsed 1s");
      expect(cap.out.data).toContain("transcript 0 B");
      expect(cap.out.data).not.toContain("Design Review Page handoff");
      expect(finish).toBeTypeOf("function");
      finish?.();
      expect(await run).toBe(0);
    } finally {
      cap.restore();
      vi.useRealTimers();
    }
  });

  it("--verbose exposes tier-C assistant text", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const reasoning = "Detailed design reasoning that should stay hidden in default mode";
    const raw = claudeStreamFixture(reasoning);
    const d = makeDeps(proj, bin);
    d.spawn = () => ({ status: 0, signal: null, stdout: raw, stderr: "" });
    const defaultOut = captureStderr(() => designCommand(["IDEA-066"], d));
    const verboseOut = captureStderr(() => designCommand(["--verbose", "IDEA-066"], d));
    expect(defaultOut).not.toContain(reasoning);
    expect(verboseOut).toContain(reasoning);
  });

  it("--raw dumps the captured transcript", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const raw = "raw agent line 1\nraw agent line 2\n";
    const d = makeDeps(proj, bin);
    d.spawn = () => ({ status: 0, signal: null, stdout: raw, stderr: "" });
    const out = captureStderr(() => designCommand(["--raw", "IDEA-066"], d));
    expect(out).toContain("raw agent line 1");
    expect(out).toContain("raw agent line 2");
  });

  it("still prints a handoff and transcript path when the agent exits non-zero", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    d.spawn = () => ({ status: 7, signal: null, stdout: "partial output\n", stderr: "" });
    const out = captureStderr(() => designCommand(["IDEA-066"], d));
    expect(out).toContain("Design Review Page handoff");
    expect(out).toContain("status: agent exited with code 7");
    expect(out).toContain("transcript:");
  });

  it("writes the raw transcript to disk before returning", () => {
    const proj = freshProj();
    dirs.push(proj);
    makeAgent(bin, "claude");
    writeConfig(home, "lang: en\nai_claude: ~/.claude\n");
    const raw = "captured raw output\n";
    const d = makeDeps(proj, bin);
    d.spawn = () => ({ status: 0, signal: null, stdout: raw, stderr: "" });
    designCommand(["IDEA-066"], d);
    const runsDir = join(proj, ".roll", "runs", "design");
    expect(existsSync(runsDir)).toBe(true);
    const entries = readdirSync(runsDir);
    expect(entries.length).toBe(1);
    const transcript = readFileSync(join(runsDir, entries[0] ?? "x", "transcript.log"), "utf8");
    expect(transcript).toContain("captured raw output");
  });

  it("uses Chinese strings when ROLL_LANG=zh", () => {
    const proj = freshProj();
    dirs.push(proj);
    process.env["ROLL_LANG"] = "zh";
    makeAgent(bin, "claude");
    writeConfig(home, "lang: zh\nai_claude: ~/.claude\n");
    const d = makeDeps(proj, bin);
    const out = captureStderr(() => designCommand(["IDEA-066"], d));
    expect(out).toContain("设计运行开始");
    expect(out).not.toContain("Design run started");
  });
});
