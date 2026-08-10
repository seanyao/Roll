import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { initCommand, seedBacklogRow } from "../src/commands/init.js";
import { offboardCommand } from "../src/commands/offboard.js";

const dirs: string[] = [];

describe("seedBacklogRow — FIX-1475 exact id-cell existence", () => {
  const HEAD = "## Epic: Initial Setup";
  function backlogFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "roll-seedrow-"));
    dirs.push(dir);
    const p = join(dir, "backlog.md");
    writeFileSync(p, body, "utf8");
    return p;
  }

  it("a row whose DESCRIPTION cell equals the id does NOT block a real seed", () => {
    const p = backlogFile([HEAD, "", "| ID | Description | Status |", "|----|----|----|", "| US-OTHER | US-NEW | 📋 Todo |", ""].join("\n"));
    const appended = seedBacklogRow(p, HEAD, "| US-NEW | real card | 📋 Todo |", "US-NEW");
    expect(appended).toBe(true);
    expect(readFileSync(p, "utf8")).toContain("| US-NEW | real card | 📋 Todo |");
  });

  it("an EXISTING id row (bare or linked) is a no-op — no duplicate append", () => {
    const bare = backlogFile([HEAD, "", "| ID | Description | Status |", "|----|----|----|", "| US-NEW | already here | 📋 Todo |", ""].join("\n"));
    expect(seedBacklogRow(bare, HEAD, "| US-NEW | dup | 📋 Todo |", "US-NEW")).toBe(false);
    const linked = backlogFile([HEAD, "", "| ID | Description | Status |", "|----|----|----|", "| [US-NEW](.roll/features/x/US-NEW/spec.md) | already here | 📋 Todo |", ""].join("\n"));
    expect(seedBacklogRow(linked, HEAD, "| US-NEW | dup | 📋 Todo |", "US-NEW")).toBe(false);
  });
});
const REPO = resolve(__dirname, "../../..");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "roll-init-command-"));
  dirs.push(dir);
  return dir;
}

function projectWithName(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "roll-init-parent-"));
  dirs.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(root: string, rel: string, text = "x\n"): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function mkdir(root: string, rel: string): void {
  mkdirSync(join(root, rel), { recursive: true });
}

function writeExistingCodebaseFixture(root: string): void {
  write(root, "package.json", '{"scripts":{"test":"vitest"}}\n');
  write(root, "src/index.ts", "export const value = 1;\n");
  write(root, "tests/index.test.ts", "import { expect, it } from 'vitest';\nit('works', () => expect(1).toBe(1));\n");
  write(root, "README.md", "# Existing App\n\nA service with real source and tests.\n");
}

function withCapturedOutput<T>(
  cwd: string,
  run: () => T,
  options: { pathEntries?: string[]; rollHome?: string } = {},
): T extends Promise<unknown> ? Promise<Run> : Run {
  const saveCwd = process.cwd();
  const emptyBin = mkdtempSync(join(tmpdir(), "roll-init-empty-bin-"));
  dirs.push(emptyBin);
  const saveEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    ROLL_HOME: process.env["ROLL_HOME"],
    ROLL_PKG_DIR: process.env["ROLL_PKG_DIR"],
    NO_COLOR: process.env["NO_COLOR"],
    ROLL_LANG: process.env["ROLL_LANG"],
    ROLL_ATTEST_NO_BROWSER: process.env["ROLL_ATTEST_NO_BROWSER"],
  };
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const restore = (): void => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const [key, value] of Object.entries(saveEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  process.chdir(cwd);
  process.env["PATH"] = [emptyBin, ...(options.pathEntries ?? [])].join(":");
  process.env["HOME"] = cwd;
  process.env["ROLL_HOME"] = options.rollHome ?? REPO;
  process.env["ROLL_PKG_DIR"] = REPO;
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  process.env["ROLL_ATTEST_NO_BROWSER"] = "1";
  // @ts-expect-error capture-only
  process.stdout.write = (chunk: string | Uint8Array): boolean => (out.push(String(chunk)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (chunk: string | Uint8Array): boolean => (err.push(String(chunk)), true);

  const wrap = (status: number): Run => ({ status, stdout: out.join(""), stderr: err.join("") });
  try {
    const result = run();
    if (result instanceof Promise) {
      return result.then((r) => {
        restore();
        return wrap(typeof r === "object" && r !== null && "status" in r ? Number(r.status) : 0);
      }) as T extends Promise<unknown> ? Promise<Run> : Run;
    }
    restore();
    return wrap(typeof result === "number" ? result : 0) as T extends Promise<unknown> ? Promise<Run> : Run;
  } catch (error) {
    restore();
    throw error;
  }
}

function runInit(cwd: string, args: string[], options: { pathEntries?: string[] } = {}): Run {
  return withCapturedOutput(cwd, () => initCommand(args), options);
}

function runInitInteractive(cwd: string, args: string[], answer: string): Run {
  return withCapturedOutput(cwd, () => initCommand(args, { forceInteractive: true, readLine: () => answer }));
}

function runOffboard(cwd: string, args: string[]): Run {
  return withCapturedOutput(cwd, () => offboardCommand(args));
}

function scrubExistingCodebaseSmokeOutput(text: string): string {
  return text
    .replace(/workspace: .+roll-init-existing-codebase-[^\n]+/g, "workspace: <existing-codebase-workspace>")
    .replace(/cleanup: removed .+roll-init-existing-codebase-[^\n]+/g, "cleanup: removed <existing-codebase-workspace>");
}

function gitOnlyPath(): string {
  const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const git = (found.stdout ?? "").trim();
  expect(found.status).toBe(0);
  expect(git).not.toBe("");
  const bin = mkdtempSync(join(tmpdir(), "roll-init-git-only-bin-"));
  dirs.push(bin);
  const quotedGit = git.replace(/'/g, "'\\''");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nexec '${quotedGit}' -c core.hooksPath=/dev/null "$@"\n`, { mode: 0o755 });
  return [bin, "/usr/bin", "/bin"].join(":");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  return String(result.stdout ?? "");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("roll init --diagnose fixture", () => {
  it("prints the hidden state matrix and does not mutate the current project", () => {
    const cwd = project();
    const run = runInit(cwd, ["--diagnose", "--fixture", "state-matrix"]);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatchSnapshot();
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("does not expose the hidden fixture in normal init help", async () => {
    registerAll();
    const cwd = project();
    const run = await withCapturedOutput(cwd, () => dispatch(["init", "--help"], async () => ({ ok: true })));

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Usage: roll init");
    expect(run.stdout).toContain("--auto");
    expect(run.stdout).toContain("--repair");
    expect(run.stdout).not.toContain("--diagnose");
    expect(run.stdout).not.toContain("--attest-smoke");
    expect(run.stdout).not.toContain("state-matrix");
  });
});

describe("roll init diagnosis router", () => {
  it("renders Already initialized for a Roll-ready project without re-scaffolding", () => {
    const cwd = project();
    write(cwd, "AGENTS.md", "# Agents\n");
    write(cwd, ".roll/backlog.md", "# Backlog\n");
    mkdir(cwd, ".roll/features");

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Already initialized");
    expect(run.stdout).toContain("Next: roll status");
  });

  it("renders missing pieces for partial Roll projects and does not create AGENTS.md", () => {
    const cwd = project();
    write(cwd, ".roll/backlog.md", "# Backlog\n");
    write(cwd, "BACKLOG.md", "# Old Roll backlog\n");

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Detected: roll-partial");
    expect(run.stdout).toContain("Recommended path: repair-roll");
    expect(run.stdout).toContain("Next: roll init");
    expect(run.stdout).toContain("Missing Roll pieces:");
    expect(run.stdout).toContain("AGENTS.md");
    expect(run.stdout).toContain(".roll/features/");
    expect(run.stdout).toContain("Pre-v2 Roll markers still present:");
    expect(run.stdout).toContain("BACKLOG.md");
    expect(run.stdout).toContain("No files changed.");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("previews partial Roll repair without mutating in non-interactive mode", () => {
    const cwd = project();
    write(cwd, ".roll/backlog.md", "# Backlog\n");

    const run = runInit(cwd, ["--repair"]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Partial Roll repair preview");
    expect(run.stdout).toContain("roll init --repair --auto");
    expect(run.stdout).toContain("No files changed.");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll", "features"))).toBe(false);
  });

  it("repairs partial Roll projects with --auto, preserves owner content, and records reversible metadata", () => {
    const cwd = project();
    write(cwd, "AGENTS.md", "# Owner Guide\n\nKeep this owner text.\n");
    write(cwd, ".roll/backlog.md", "# Owner Backlog\n\n| Story | Description | Status |\n|-------|-------------|--------|\n| US-OWN | keep me | 📋 Todo |\n");

    const first = runInit(cwd, ["--repair", "--auto"]);
    const second = runInit(cwd, ["--repair", "--auto"]);
    const third = runInit(cwd, ["--repair", "--auto"]);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(third.status).toBe(0);
    expect(first.stdout).toContain("REPAIR");
    expect(first.stdout).toContain("Repair complete");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "backlog.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "features"))).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("Keep this owner text.");
    expect(readFileSync(join(cwd, ".roll", "backlog.md"), "utf8")).toContain("US-OWN");
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect((agents.match(/<!-- roll:onboard:start -->/g) ?? []).length).toBe(1);
    const changeset = readFileSync(join(cwd, ".roll", "onboard-changeset.yaml"), "utf8");
    expect((changeset.match(/"AGENTS.md"/g) ?? []).length).toBe(1);
    expect((changeset.match(new RegExp('".roll/features"', "g")) ?? []).length).toBe(1);
    expect(changeset).toContain("files_merged:");
    expect(changeset).toContain("dirs_created:");
    expect(changeset).not.toContain('  - ".roll/backlog.md"');
  });

  it("fails loud when a stale .roll/features file blocks repair", () => {
    const cwd = project();
    write(cwd, ".roll/backlog.md", "# Backlog\n");
    write(cwd, ".roll/features", "not a directory\n");

    const run = runInit(cwd, ["--repair", "--auto"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(".roll/features exists but is not a directory");
    expect(readFileSync(join(cwd, ".roll", "features"), "utf8")).toContain("not a directory");
  });

  it("offboards only Roll-owned artifacts after partial repair", () => {
    const cwd = project();
    write(cwd, "AGENTS.md", "# Owner Guide\n\nKeep this owner text.\n");
    write(cwd, ".roll/backlog.md", "# Owner Backlog\n\nKeep this owner backlog.\n");

    expect(runInit(cwd, ["--repair", "--auto"]).status).toBe(0);
    const offboard = runOffboard(cwd, ["--confirm"]);

    expect(offboard.status).toBe(0);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("Keep this owner text.");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).not.toContain("<!-- roll:onboard:start -->");
    expect(readFileSync(join(cwd, ".roll", "backlog.md"), "utf8")).toContain("Keep this owner backlog.");
    expect(existsSync(join(cwd, ".roll", "features"))).toBe(false);
    expect(existsSync(join(cwd, ".roll", "features.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll", "onboard-changeset.yaml"))).toBe(false);
  });

  it("repairs partial Roll projects interactively when confirmed", () => {
    const cwd = project();
    write(cwd, ".roll/backlog.md", "# Backlog\n");

    const run = runInitInteractive(cwd, ["--repair"], "y");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("REPAIR");
    expect(run.stdout).toContain("Repair complete");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "backlog.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "features"))).toBe(true);
  });

  it("does not let --repair scaffold projects that are not partial Roll", () => {
    const cwd = project();

    const run = runInit(cwd, ["--repair"]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Detected: empty");
    expect(run.stderr).toContain("roll init --repair only applies to partial Roll projects.");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("routes pre-v2 Roll layout markers to migration without fresh scaffold", () => {
    const cwd = project();
    write(cwd, "BACKLOG.md", "# Old Roll backlog\n");
    mkdir(cwd, "docs/features");
    writeExistingCodebaseFixture(cwd);

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Detected: roll-legacy-layout");
    expect(run.stdout).toContain("Recommended path: migrate-roll-layout");
    expect(run.stdout).toContain("npx @seanyao/roll@2 migrate --dry-run");
    expect(run.stdout).toContain("Old Roll markers:");
    expect(run.stdout).toContain("BACKLOG.md");
    expect(run.stdout).toContain("docs/features/");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("routes PRD-only workspaces to fresh scaffold without launching onboard", () => {
    const cwd = project();
    write(cwd, "docs/intel-radar-PRD.md", "# Product Requirements\n\nBuild a radar for intelligence signals.\n");

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain("Initialized");
    expect(run.stdout).toContain("roll design --from-file docs/intel-radar-PRD.md");
    expect(run.stdout).not.toContain("Onboarding");
    expect(run.stdout).not.toContain("Detected: legacy project");
    expect(existsSync(join(cwd, "prompt.txt"))).toBe(false);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll"))).toBe(true);
  });

  it("scaffolds PRD-only workspaces and writes a design handoff brief", () => {
    const cwd = project();
    write(
      cwd,
      "docs/intel-radar-PRD.md",
      "# Intel Radar PRD\n\nBuild a radar for intelligence signals with source ranking and daily review.\n",
    );

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain("Initialized");
    expect(run.stdout).not.toContain("Onboarding");
    expect(run.stdout).toContain(".roll/brief.md");
    expect(run.stdout).toContain("roll design --from-file docs/intel-radar-PRD.md");
    expect((run.stdout.match(/roll design/g) ?? []).length).toBe(1);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "backlog.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "brief.md"))).toBe(true);
    const brief = readFileSync(join(cwd, ".roll", "brief.md"), "utf8");
    expect(brief).toContain("docs/intel-radar-PRD.md");
    expect(brief).toContain("Build a radar for intelligence signals");
    const changeset = readFileSync(join(cwd, ".roll", "onboard-changeset.yaml"), "utf8");
    expect(changeset).toContain(".roll/brief.md");
    expect(changeset).toContain(".roll/backlog.md");
  });

  it("diagnoses existing codebases without Roll as non-mutating agentic onboarding", () => {
    const cwd = project();
    writeExistingCodebaseFixture(cwd);

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Detected: existing codebase without Roll");
    expect(run.stdout).toContain("Recommended path: agentic-onboard");
    expect(run.stdout).toContain("Facts:");
    expect(run.stdout).toContain("manifests: package.json");
    expect(run.stdout).toContain("source dirs: src");
    expect(run.stdout).toContain("test dirs: tests");
    expect(run.stdout).toContain("Roll markers: none");
    expect(run.stdout).toMatch(/facts hash: sha256:[0-9a-f]{64}/);
    expect(run.stdout).toContain("Next: $roll-onboard");
    expect(run.stdout).toContain("$roll-onboard requires an AI agent");
    expect(run.stdout).toContain("No suitable AI agent detected");
    expect(run.stdout).toContain("roll agent migrate --dry-run");
    expect(run.stdout).toContain("No files changed.");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("does not mutate empty non-interactive workspaces without --auto", () => {
    const cwd = project();

    const run = runInit(cwd, []);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Detected: empty");
    expect(run.stdout).toContain("Recommended path: guided-brief");
    expect(run.stdout).toContain("Next: roll design");
    expect(run.stdout).toContain("No files changed.");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("writes a placeholder brief for empty non-interactive workspaces with --auto", () => {
    const cwd = project();

    const run = runInit(cwd, ["--auto"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain(".roll/brief.md");
    expect(run.stdout).toContain("roll design");
    expect((run.stdout.match(/roll design/g) ?? []).length).toBe(1);
    expect(readFileSync(join(cwd, ".roll", "brief.md"), "utf8")).toContain("TODO: Describe the product");
    expect(readFileSync(join(cwd, ".roll", "onboard-changeset.yaml"), "utf8")).toContain(".roll/brief.md");
  });

  it("FIX-1072: commits and pushes Roll-owned meta files generated by fresh init", () => {
    const cwd = project();
    const remote = mkdtempSync(join(tmpdir(), "roll-init-command-remote-"));
    dirs.push(remote);
    git(remote, ["init", "--bare", "--initial-branch=main"]);
    git(cwd, ["init", "--initial-branch=main"]);
    git(cwd, ["config", "user.email", "roll-test@example.com"]);
    git(cwd, ["config", "user.name", "Roll Test"]);
    git(cwd, ["remote", "add", "origin", remote]);
    write(cwd, "docs/PRD.md", "# Product Requirements\n\nUser-owned source document.\n");

    const run = runInit(cwd, ["--auto"], { pathEntries: [gitOnlyPath()] });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Saved Roll setup files to git");
    expect(run.stdout).toContain("Pushed Roll setup to origin/main");
    // FIX-1076 (AC8): no internal "Roll meta" jargon leaks to the user.
    expect(run.stdout).not.toContain("Roll meta");
    const committed = git(cwd, ["show", "--name-only", "--format=", "HEAD"]);
    expect(committed).toContain("AGENTS.md");
    expect(committed).toContain(".roll/backlog.md");
    expect(committed).toContain(".roll/brief.md");
    expect(committed).toContain(".roll/onboard-changeset.yaml");
    expect(committed).not.toContain("docs/PRD.md");
    expect(git(cwd, ["status", "--short"])).toContain("?? docs/");
    expect(git(cwd, ["ls-remote", "--heads", "origin", "main"])).toContain("refs/heads/main");
  });

  it("FIX-1072: does not stage Roll-owned meta files into a parent git worktree", () => {
    const parent = project();
    git(parent, ["init", "--initial-branch=main"]);
    git(parent, ["config", "user.email", "roll-test@example.com"]);
    git(parent, ["config", "user.name", "Roll Test"]);
    write(parent, "README.md", "# Parent\n");
    git(parent, ["add", "README.md"]);
    git(parent, ["commit", "-m", "seed parent"]);
    const child = join(parent, "nested-app");
    mkdir(parent, "nested-app");

    const run = runInit(child, ["--auto"], { pathEntries: [gitOnlyPath()] });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("Saved Roll setup files to git");
    expect(git(parent, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(parent, ["status", "--short"])).toContain("?? nested-app/");
  });

  // ── US-INIT-010: init offers to continue into design (consent gate) ────────
  function prdProject(): string {
    const cwd = project();
    write(cwd, "docs/PRD.md", "# Product Requirements\n\nBuild an intel radar.\n");
    return cwd;
  }

  it("US-INIT-010: PRD + interactive 'y' continues straight into design", () => {
    const cwd = prdProject();
    const calls: string[][] = [];
    // `--auto` skips the init Proceed? prompt, so readLine drives only the
    // design continuation gate.
    const run = withCapturedOutput(cwd, () =>
      initCommand(["--auto"], { forceInteractive: true, readLine: () => "y", runDesign: (a) => (calls.push(a), 0) }),
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Run design now?");
    expect(run.stdout).toContain("Detected docs/PRD.md");
    expect(calls).toEqual([["--from-file", "docs/PRD.md"]]);
  });

  it("US-INIT-010: interactive 'n' keeps the printed NEXT hint and does not run design", () => {
    const cwd = prdProject();
    const calls: string[][] = [];
    const run = withCapturedOutput(cwd, () =>
      initCommand(["--auto"], { forceInteractive: true, readLine: () => "n", runDesign: (a) => (calls.push(a), 0) }),
    );

    expect(run.status).toBe(0);
    expect(calls).toEqual([]); // AC2: not run
    expect(run.stdout).toContain("roll design --from-file docs/PRD.md"); // NEXT hint intact
  });

  it("US-INIT-010: no PRD → no continuation prompt at all", () => {
    const cwd = project(); // empty workspace, no design material
    const calls: string[][] = [];
    const run = withCapturedOutput(cwd, () =>
      initCommand(["--auto"], { forceInteractive: true, readLine: () => "y", runDesign: (a) => (calls.push(a), 0) }),
    );

    expect(run.status).toBe(0);
    expect(calls).toEqual([]); // AC3: nothing to continue into
    expect(run.stderr).not.toContain("Run design now?");
  });

  it("US-INIT-010: --yes auto-continues without a prompt in a non-interactive run", () => {
    const cwd = prdProject();
    const calls: string[][] = [];
    const run = withCapturedOutput(cwd, () =>
      initCommand(["--yes"], { runDesign: (a) => (calls.push(a), 0) }), // no forceInteractive → non-TTY
    );

    expect(run.status).toBe(0);
    expect(calls).toEqual([["--from-file", "docs/PRD.md"]]); // AC4: flag path
    expect(run.stderr).not.toContain("Run design now?"); // no prompt
  });

  it("FIX-1220: chained design uses argv semantics when the project path contains glob characters", () => {
    const cwd = projectWithName("intel-radar[main] app");
    write(cwd, "docs/PRD.md", "# Product Requirements\n\nBuild an intel radar.\n");
    const calls: string[][] = [];

    const run = withCapturedOutput(cwd, () => initCommand(["--yes"], { runDesign: (a) => (calls.push(a), 0) }));

    expect(run.status).toBe(0);
    expect(calls).toEqual([["--from-file", "docs/PRD.md"]]);
    expect(run.stdout).toContain("roll design --from-file docs/PRD.md");
  });

  it("FIX-1220: chained design failure is visible and returns non-zero with the manual retry command", () => {
    const cwd = prdProject();
    const run = withCapturedOutput(cwd, () =>
      initCommand(["--yes"], {
        runDesign: () => 1,
      }),
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("roll design --from-file docs/PRD.md");
    expect(run.stderr).toContain("roll design failed");
    expect(run.stderr).toContain("roll design --from-file docs/PRD.md");
  });

  it("US-INIT-010: non-interactive without a flag never auto-runs design", () => {
    const cwd = prdProject();
    const calls: string[][] = [];
    const run = withCapturedOutput(cwd, () =>
      initCommand([], { runDesign: (a) => (calls.push(a), 0) }), // non-TTY, no --yes
    );

    expect(run.status).toBe(0);
    expect(calls).toEqual([]); // AC4: no silent burn
    expect(run.stdout).toContain("roll design --from-file docs/PRD.md"); // hint still printed
  });

  it("asks empty interactive workspaces what they are building and writes that brief", () => {
    const cwd = project();

    const run = runInitInteractive(cwd, [], "A weekly ops dashboard for release owners");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("What are you building?");
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain("roll design");
    expect(readFileSync(join(cwd, ".roll", "brief.md"), "utf8")).toContain("A weekly ops dashboard for release owners");
  });

  it("runs the hidden PRD-only attest smoke in an isolated workspace and cleans it up", () => {
    const cwd = project();

    const run = runInit(cwd, ["--attest-smoke", "prd-only"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("roll init attest smoke: prd-only");
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain("Initialized");
    expect(run.stdout).toContain("Created files:");
    expect(run.stdout).toContain("AGENTS.md");
    expect(run.stdout).toContain(".roll/brief.md");
    expect(run.stdout).toContain(".roll/onboard-changeset.yaml");
    expect(run.stdout).toContain("roll design --from-file docs/intel-radar-PRD.md");
    expect(run.stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("runs the hidden PRD-only attest smoke without a preinstalled owner ROLL_HOME", () => {
    const cwd = project();

    const run = withCapturedOutput(cwd, () => initCommand(["--attest-smoke", "prd-only"]), {
      rollHome: join(cwd, "missing-roll-home"),
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("roll init attest smoke: prd-only");
    expect(run.stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "missing-roll-home"))).toBe(false);
  });

  it("runs the hidden existing-codebase diagnosis attest smoke in an isolated workspace and cleans it up", () => {
    const cwd = project();

    const run = runInit(cwd, ["--attest-smoke", "existing-codebase-diagnose"]);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("roll init attest smoke: existing-codebase-diagnose");
    expect(run.stdout).toContain("Fixture tree:");
    expect(run.stdout).toContain("package.json");
    expect(run.stdout).toContain("src/index.ts");
    expect(run.stdout).toContain("tests/index.test.ts");
    expect(run.stdout).toContain("Detected: existing codebase without Roll");
    expect(run.stdout).toContain("Recommended path: agentic-onboard");
    expect(run.stdout).toContain("manifests: package.json");
    expect(run.stdout).toContain("source dirs: src");
    expect(run.stdout).toContain("test dirs: tests");
    expect(run.stdout).toContain("Roll markers: none");
    expect(run.stdout).toMatch(/facts hash: sha256:[0-9a-f]{64}/);
    expect(run.stdout).toContain("Next: $roll-onboard");
    expect(run.stdout).toContain("No files changed.");
    expect(run.stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("runs the hidden existing-codebase invalid-plan attest smoke and cleans it up", () => {
    const cwd = project();

    const run = runInit(cwd, ["--attest-smoke", "existing-codebase-invalid-plan"], {
      pathEntries: [process.env["PATH"] ?? ""],
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("roll init attest smoke: existing-codebase-invalid-plan");
    expect(run.stdout).toContain("Fixture tree:");
    expect(run.stdout).toContain("package.json");
    expect(run.stdout).toContain("src/index.ts");
    expect(run.stdout).toContain("tests/index.test.ts");
    expect(run.stdout).toContain(".roll/init-diagnosis.yaml");
    expect(run.stdout).toContain(".roll/onboard-plan.yaml");
    expect(run.stderr).toContain("plan factsHash is stale: expected sha256:");
    expect(run.stderr).toContain("got sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
    expect(run.stdout).toContain("Post-apply mutation check:");
    expect(run.stdout).toContain("AGENTS.md: missing");
    expect(run.stdout).toContain(".roll/backlog.md: missing");
    expect(run.stdout).toContain(".gitignore: missing");
    expect(run.stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("runs the hidden existing-codebase review checkpoint attest smoke and cleans it up", () => {
    const cwd = project();

    const run = runInit(cwd, ["--attest-smoke", "existing-codebase-review"], {
      pathEntries: [process.env["PATH"] ?? ""],
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Proceed with these changes? [y/N]");
    expect(run.stderr).toContain("No files changed.");
    expect(run.stdout).toContain("roll init attest smoke: existing-codebase-review");
    expect(run.stdout).toContain("Fixture tree:");
    expect(run.stdout).toContain(".roll/init-diagnosis.yaml");
    expect(run.stdout).toContain(".roll/onboard-plan.yaml");
    expect(run.stdout).toContain("Onboard apply review checkpoint");
    expect(run.stdout).toContain("Post-review mutation check:");
    expect(run.stdout).toContain("AGENTS.md: missing");
    expect(run.stdout).toContain(".roll/backlog.md: missing");
    expect(run.stdout).toContain(".gitignore: missing");
    expect(run.stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("runs the hidden integrated existing-codebase attest smoke through apply and idempotent re-apply", () => {
    const cwd = project();

    const run = runInit(cwd, ["--attest-smoke", "existing-codebase"], {
      pathEntries: [process.env["PATH"] ?? ""],
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Proceed with these changes? [y/N]");
    const stdout = scrubExistingCodebaseSmokeOutput(run.stdout);
    expect(stdout).toContain("roll init attest smoke: existing-codebase");
    expect(stdout).toContain("workspace: <existing-codebase-workspace>");
    expect(stdout).toContain("Before fixture tree:");
    expect(stdout).toContain("README.md");
    expect(stdout).toContain("package.json");
    expect(stdout).toContain("src/index.ts");
    expect(stdout).toContain("tests/index.test.ts");
    expect(stdout).toContain("Detected: existing codebase without Roll");
    expect(stdout).toContain("Recommended path: agentic-onboard");
    expect(stdout).toContain("Onboard apply review checkpoint");
    expect(stdout).toContain("Apply result: pass (exit 0)");
    expect(stdout).toContain("After apply tree:");
    expect(stdout).toContain("Idempotent re-apply result: pass (exit 0)");
    expect(stdout).toContain("After idempotent re-apply tree:");
    expect(stdout).toContain("AGENTS.md: present");
    expect(stdout).toContain(".claude/CLAUDE.md: present");
    expect(stdout).toContain(".roll/backlog.md: present");
    expect(stdout).toContain(".gitignore: present");
    expect(stdout).toContain("Idempotency checks:");
    expect(stdout).toContain(".gitignore .roll/loop/ entries: 1");
    expect(stdout).toContain("changeset AGENTS.md entries: 1");
    expect(stdout).toContain("changeset .claude/CLAUDE.md entries: 1");
    expect(stdout).toContain("changeset .roll/backlog.md entries: 1");
    expect(stdout).toContain("result: pass");
    expect(stdout).toContain("cleanup: removed <existing-codebase-workspace>");
    expect(stdout).toContain("Smoke summary:");
    expect(stdout).toContain("diagnosis: codebase-no-roll");
    expect(stdout).toContain("review checkpoint: shown");
    expect(stdout).toContain("apply result: pass");
    expect(stdout).toContain("idempotent re-apply result: pass");
    expect(stdout).toContain("idempotency checks: pass");
    expect(stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("runs the hidden partial and legacy Roll attest smoke in isolated workspaces and cleans it up", () => {
    const cwd = project();

    const run = runInit(cwd, ["--attest-smoke", "partial-and-roll-legacy"], {
      pathEntries: [process.env["PATH"] ?? ""],
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("roll init attest smoke: partial-and-roll-legacy");
    expect(run.stdout).toContain("Partial Roll diagnosis:");
    expect(run.stdout).toContain("Detected: roll-partial");
    expect(run.stdout).toContain("Partial repair result: pass");
    expect(run.stdout).toContain("Idempotent repair result: pass");
    expect(run.stdout).toContain("Legacy Roll diagnosis:");
    expect(run.stdout).toContain("Detected: roll-legacy-layout");
    expect(run.stdout).toContain("Recommended path: migrate-roll-layout");
    expect(run.stdout).toContain("Legacy mutation check:");
    expect(run.stdout).toContain("AGENTS.md: missing");
    expect(run.stdout).toContain(".roll/: missing");
    expect(run.stdout).toContain("cleanup: removed");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".roll"))).toBe(false);
  });

  it("does not route git-only or empty source shells to existing-codebase onboarding", () => {
    const cwd = project();
    mkdir(cwd, "src");
    mkdir(cwd, "tests");

    const run = runInit(cwd, ["--auto"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain("Initialized");
    expect(run.stdout).not.toContain("Onboarding");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "backlog.md"))).toBe(true);
  });

  it("does not route git history alone to existing-codebase onboarding", () => {
    const cwd = project();
    write(cwd, ".keep", "x\n");
    expect(spawnSync("git", ["init"], { cwd, stdio: "ignore" }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "roll-test@example.com"], { cwd, stdio: "ignore" }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Roll Test"], { cwd, stdio: "ignore" }).status).toBe(0);
    expect(spawnSync("git", ["add", ".keep"], { cwd, stdio: "ignore" }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "seed"], { cwd, stdio: "ignore" }).status).toBe(0);

    const run = runInit(cwd, ["--auto"], { pathEntries: [gitOnlyPath()] });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("INIT");
    expect(run.stdout).toContain("Initialized");
    expect(run.stdout).not.toContain("Onboarding");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".roll", "backlog.md"))).toBe(true);
  });
});
