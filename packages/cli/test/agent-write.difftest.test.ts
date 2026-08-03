/**
 * Frozen-expectation tests for the TS-owned `roll agent` write surface (v4).
 *
 * US-V4 scoped agent management makes `~/.roll/agents.yaml` and
 * `.roll/agents.yaml` the primary role-binding surfaces. Legacy write commands
 * (`default`, `set`, `use`) fail loudly with migration guidance.
 *
 * These tests inject an AgentEnv + in-memory default store and temp project
 * dirs, so they never spawn `bin/roll` and never touch the real machine config.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEnv } from "@roll/core";
import { repoRoot } from "../src/bridge.js";
import { agentCommand } from "../src/commands/agent.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempProject(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-agent-write-"));
  dirs.push(d);
  return d;
}

function env(installed: string[]): AgentEnv {
  const bins = new Set(installed);
  return {
    home: "/home/tester",
    commandOnPath: (bin) => bins.has(bin),
    dirExists: () => false,
    fileExecutable: () => false,
  };
}

function run(
  args: string[],
  opts: {
    installed?: string[];
    readLine?: () => string | undefined;
    listCommand?: (args: string[]) => number;
    before?: (cwd: string) => void;
    initialDefault?: string | null;
  } = {},
): { code: number; stdout: string; stderr: string; cwd: string; finalDefault: string | null } {
  const cwd = tempProject();
  const saveCwd = process.cwd();
  const saveEnv: Record<string, string | undefined> = {};
  for (const key of ["NO_COLOR", "ROLL_LANG", "ROLL_AGENTS_CONFIG", "ROLL_HOME"]) saveEnv[key] = process.env[key];
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  delete process.env["ROLL_AGENTS_CONFIG"];
  process.env["ROLL_HOME"] = join(cwd, "home", ".roll");
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (err.push(String(c)), true);
  process.chdir(cwd);
  // In-memory global machine default (US-V4-002 seam — never touches real ~/.roll).
  let defaultAgent: string | null = opts.initialDefault ?? null;
  let code = 1;
  try {
    opts.before?.(cwd);
    code = agentCommand(args, {
      env: env(opts.installed ?? []),
      readLine: opts.readLine,
      listCommand: opts.listCommand,
      readDefaultAgent: () => defaultAgent,
      writeDefaultAgent: (n) => {
        defaultAgent = n;
      },
    });
  } finally {
    process.chdir(saveCwd);
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const [key, value] of Object.entries(saveEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { code, stdout: out.join(""), stderr: err.join(""), cwd, finalDefault: defaultAgent };
}

/** Seed a project route profile (.roll/agents.yaml) in canonical inline form. */
function seedRoutes(cwd: string, lines: Record<string, string>): void {
  mkdirSync(join(cwd, ".roll"), { recursive: true });
  const body = ["schema: v3", ...Object.entries(lines).map(([slot, agent]) => `${slot}: { agent: ${agent} }`)].join("\n");
  writeFileSync(join(cwd, ".roll", "agents.yaml"), body + "\n", "utf8");
}

function rollHome(cwd: string): string {
  return join(cwd, "home", ".roll");
}

function scrubAgentView(stdout: string, cwd: string): string {
  return stdout
    .replaceAll(rollHome(cwd), "<ROLL_HOME>")
    .replaceAll(cwd, "<PROJECT>");
}

describe("roll agent write surface (v4)", () => {
  it("delegates list without fallback", () => {
    let seen: string[] = [];
    const r = run(["list", "--x"], {
      listCommand: (args) => {
        seen = args;
        return 44;
      },
    });
    expect(r.code).toBe(44);
    expect(seen).toEqual(["--x"]);
  });

  it("bare view shows the scope-role-agent model with no config", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(scrubAgentView(r.stdout, r.cwd)).toMatchInlineSnapshot(`
      "
        Agent Scope View

        Machine Scope

          file: <ROLL_HOME>/agents.yaml
          status: missing

        Project Scope

          file: .roll/agents.yaml
          status: missing

        Agent pool

          agent       status        note
          claude      not found     runtime auth/network/account checked at spawn
          kimi        not found     runtime auth/network/account checked at spawn
          codex       not found     runtime auth/network/account checked at spawn
          pi          not found     runtime auth/network/account checked at spawn
          agy         not found     runtime auth/network/account checked at spawn
          reasonix    not found     runtime auth/network/account checked at spawn
          cursor      not found     runtime auth/network/account checked at spawn

        Role bindings are authored in ~/.roll/agents.yaml and .roll/agents.yaml.
        roll agent migrate [--dry-run]  — convert legacy defaults/routes/pairing to roll-agents/v1
        roll agent list                 — show installed agents

      "
    `);
  });

  it("bare view renders effective project capability without statically resolving roles", () => {
    const r = run([], {
      installed: ["codex", "kimi", "reasonix"],
      before: (cwd) => {
        mkdirSync(rollHome(cwd), { recursive: true });
        writeFileSync(join(rollHome(cwd), "agents.yaml"), `schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [supervise, execute, evaluate]
  kimi:
    capabilities: [execute, evaluate]
  reasonix:
    capabilities: [evaluate]
roles:
  supervise:
    use: codex
`, "utf8");
        mkdirSync(join(cwd, ".roll"), { recursive: true });
        writeFileSync(join(cwd, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: project
inherits: machine
roles:
  supervise:
    inherit: true
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [kimi, codex]
        require: [execute]
        strategy: first-available
      evaluate:
        kind: select
        from: [reasonix, codex]
        require: [evaluate]
        avoid: [execute]
        strategy: least-recent
rigs:
  builder:
    agent: kimi
    model: kimi-k2
`, "utf8");
      },
    });
    expect(r.code).toBe(0);
    expect(scrubAgentView(r.stdout, r.cwd)).toMatchInlineSnapshot(`
      "
        Agent Scope View

        Machine Scope

          file: <ROLL_HOME>/agents.yaml
          status: roll-agents/v1
          agents: codex, kimi, reasonix
          models: -

        Project Scope

          file: .roll/agents.yaml
          status: roll-agents/v1
          agents: -
          models: -
          effective agents: codex, kimi, reasonix
          effective models: kimi-k2
          route models: kimi=kimi-k2

        Agent pool

          agent       status        note
          claude      not found     runtime auth/network/account checked at spawn
          kimi        installed     runtime auth/network/account checked at spawn
          codex       installed     runtime auth/network/account checked at spawn
          pi          not found     runtime auth/network/account checked at spawn
          agy         not found     runtime auth/network/account checked at spawn
          reasonix    installed     runtime auth/network/account checked at spawn
          cursor      not found     runtime auth/network/account checked at spawn

        Role bindings are authored in ~/.roll/agents.yaml and .roll/agents.yaml.
        roll agent migrate [--dry-run]  — convert legacy defaults/routes/pairing to roll-agents/v1
        roll agent list                 — show installed agents

      "
    `);
  });

  it("shows only project declarations when the project does not inherit the machine scope", () => {
    const r = run([], {
      before: (cwd) => {
        mkdirSync(rollHome(cwd), { recursive: true });
        writeFileSync(join(rollHome(cwd), "agents.yaml"), `schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [supervise]
`, "utf8");
        mkdirSync(join(cwd, ".roll"), { recursive: true });
        writeFileSync(join(cwd, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: project
agents:
  pi:
    capabilities: [execute]
`, "utf8");
      },
    });
    expect(scrubAgentView(r.stdout, r.cwd)).toContain("effective agents: pi");
    expect(scrubAgentView(r.stdout, r.cwd)).not.toContain("effective agents: codex");
  });

  it("bare view directs legacy project config to migration without reading other legacy inputs", () => {
    const r = run([], {
      before: (cwd) => {
        seedRoutes(cwd, { default: "pi", hard: "kimi" });
        writeFileSync(join(cwd, ".roll", "pairing.yaml"), "enabled: true\nstages: [score]\ncapability:\n  reasonix: [score]\n", "utf8");
        writeFileSync(join(cwd, ".roll", "local.yaml"), "agent: 'claude' # legacy local default\n", "utf8");
      },
    });
    expect(r.code).toBe(0);
    expect(scrubAgentView(r.stdout, r.cwd)).toMatchInlineSnapshot(`
      "
        Agent Scope View

        Machine Scope

          file: <ROLL_HOME>/agents.yaml
          status: missing

        Project Scope

          file: .roll/agents.yaml
          status: legacy config (run \`roll agent migrate\` to convert)

        Agent pool

          agent       status        note
          claude      not found     runtime auth/network/account checked at spawn
          kimi        not found     runtime auth/network/account checked at spawn
          codex       not found     runtime auth/network/account checked at spawn
          pi          not found     runtime auth/network/account checked at spawn
          agy         not found     runtime auth/network/account checked at spawn
          reasonix    not found     runtime auth/network/account checked at spawn
          cursor      not found     runtime auth/network/account checked at spawn

        Role bindings are authored in ~/.roll/agents.yaml and .roll/agents.yaml.
        roll agent migrate [--dry-run]  — convert legacy defaults/routes/pairing to roll-agents/v1
        roll agent list                 — show installed agents

      "
    `);
  });

  it("bare view reports invalid roll-agents/v1 config fail-loud", () => {
    const r = run([], {
      before: (cwd) => {
        mkdirSync(join(cwd, ".roll"), { recursive: true });
        writeFileSync(join(cwd, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: project
roles:
  execute:
    use: openclaw
`, "utf8");
      },
    });
    expect(r.code).toBe(0);
    expect(scrubAgentView(r.stdout, r.cwd)).toMatchInlineSnapshot(`
      "
        Agent Scope View

        Machine Scope

          file: <ROLL_HOME>/agents.yaml
          status: missing

        Project Scope

          file: .roll/agents.yaml
          status: invalid roll-agents/v1
          error: roles.execute: unknown agent 'openclaw'

        Agent pool

          agent       status        note
          claude      not found     runtime auth/network/account checked at spawn
          kimi        not found     runtime auth/network/account checked at spawn
          codex       not found     runtime auth/network/account checked at spawn
          pi          not found     runtime auth/network/account checked at spawn
          agy         not found     runtime auth/network/account checked at spawn
          reasonix    not found     runtime auth/network/account checked at spawn
          cursor      not found     runtime auth/network/account checked at spawn

        Role bindings are authored in ~/.roll/agents.yaml and .roll/agents.yaml.
        roll agent migrate [--dry-run]  — convert legacy defaults/routes/pairing to roll-agents/v1
        roll agent list                 — show installed agents

      "
    `);
  });

  // ── retired legacy route commands ────────────────────────────────
  it("default is RETIRED — fails loudly with scoped-role migration guidance", () => {
    const r = run(["default", "codex"], { initialDefault: "claude" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("retired");
    expect(r.stderr).toContain("roll agent migrate --dry-run");
    expect(r.stderr).toContain("~/.roll/agents.yaml");
    expect(r.stderr).toContain(".roll/agents.yaml");
    expect(r.finalDefault).toBe("claude");
    expect(existsSync(join(r.cwd, ".roll", "agents.yaml"))).toBe(false);
  });

  // ── roll agent use (retired) ─────────────────────────────────────
  it("use is RETIRED — fails loudly with migration guidance, writes nothing", () => {
    const r = run(["use", "kimi"], { installed: ["kimi"] });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("retired");
    expect(r.stderr).toContain("roll agent migrate --dry-run");
    expect(r.stderr).toContain("~/.roll/agents.yaml");
    expect(r.stderr).toContain(".roll/agents.yaml");
    expect(existsSync(join(r.cwd, ".roll", "agents.yaml"))).toBe(false);
    expect(existsSync(join(r.cwd, ".roll", "local.yaml"))).toBe(false);
  });

  it("set is RETIRED — fails loudly and never writes v3 route slots", () => {
    const r = run(["set", "fallback", "pi"], { initialDefault: "claude" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("retired");
    expect(r.stderr).toContain("roll agent migrate --dry-run");
    expect(r.finalDefault).toBe("claude");
    expect(existsSync(join(r.cwd, ".roll", "agents.yaml"))).toBe(false);
  });

  // ── roll agent migrate ───────────────────────────────────────────
  it("migrate --dry-run prints source files, target files, and exact bindings without writing", () => {
    const r = run(["migrate", "--dry-run"], {
      before: (cwd) => {
        mkdirSync(rollHome(cwd), { recursive: true });
        writeFileSync(join(rollHome(cwd), "config.yaml"), "primary_agent: codex\nai_codex: ~/.codex|AGENTS.md|AGENTS.md\n", "utf8");
        seedRoutes(cwd, { default: "pi", hard: "kimi" });
        writeFileSync(join(cwd, ".roll", "pairing.yaml"), "enabled: true\nstages: [score]\ncapability:\n  reasonix: [score]\n", "utf8");
        writeFileSync(join(cwd, ".roll", "local.yaml"), "agent: claude\n", "utf8");
      },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Agent config migration");
    expect(r.stdout).toContain(`${rollHome(r.cwd)}/config.yaml`);
    expect(r.stdout).toContain(`${rollHome(r.cwd)}/agents.yaml`);
    expect(r.stdout).toContain(`${rollHome(r.cwd)}/config.yaml ai_codex -> ${rollHome(r.cwd)}/agents.yaml agents.codex`);
    expect(r.stdout).toContain(`${rollHome(r.cwd)}/config.yaml primary_agent -> ${rollHome(r.cwd)}/agents.yaml roles.supervise = fixed codex`);
    expect(r.stdout).toContain(".roll/agents.yaml v3 routes -> .roll/agents.yaml defaults.story.roles.execute = select [pi, kimi]");
    expect(r.stdout).toContain(".roll/pairing.yaml capability -> .roll/agents.yaml defaults.story.roles.evaluate = select [reasonix]");
    expect(r.stdout).toContain(".roll/local.yaml agent ignored (project execute binding already exists; legacy source preserved)");
    expect(r.stdout).toContain("Dry run: no files written");
    expect(existsSync(join(rollHome(r.cwd), "agents.yaml"))).toBe(false);
    expect(readFileSync(join(r.cwd, ".roll", "agents.yaml"), "utf8")).toContain("schema: v3");
  });

  it("migrate writes roll-agents/v1 targets and preserves legacy source files", () => {
    const r = run(["migrate"], {
      before: (cwd) => {
        mkdirSync(rollHome(cwd), { recursive: true });
        writeFileSync(join(rollHome(cwd), "config.yaml"), "primary_agent: codex\nai_codex: ~/.codex|AGENTS.md|AGENTS.md\n", "utf8");
        seedRoutes(cwd, { default: "pi" });
        writeFileSync(join(cwd, ".roll", "pairing.yaml"), "enabled: true\nstages: [score]\ncapability:\n  kimi: [score]\n", "utf8");
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Migration written");
    expect(readFileSync(join(rollHome(r.cwd), "config.yaml"), "utf8")).toContain("primary_agent: codex");
    expect(readFileSync(join(r.cwd, ".roll", "pairing.yaml"), "utf8")).toContain("kimi: [score]");
    const machine = readFileSync(join(rollHome(r.cwd), "agents.yaml"), "utf8");
    const project = readFileSync(join(r.cwd, ".roll", "agents.yaml"), "utf8");
    expect(machine).toContain("schema: roll-agents/v1");
    expect(machine).toContain("scope: machine");
    expect(machine).toContain("agent: codex");
    expect(project).toContain("schema: roll-agents/v1");
    expect(project).toContain("scope: project");
    expect(project).toContain("execute:");
    expect(project).toContain("evaluate:");

    const again = run(["migrate"], {
      before: (cwd) => {
        mkdirSync(rollHome(cwd), { recursive: true });
        writeFileSync(join(rollHome(cwd), "config.yaml"), "primary_agent: codex\nai_codex: ~/.codex|AGENTS.md|AGENTS.md\n", "utf8");
        writeFileSync(join(rollHome(cwd), "agents.yaml"), machine, "utf8");
        mkdirSync(join(cwd, ".roll"), { recursive: true });
        writeFileSync(join(cwd, ".roll", "agents.yaml"), project, "utf8");
        writeFileSync(join(cwd, ".roll", "pairing.yaml"), "enabled: true\nstages: [score]\ncapability:\n  kimi: [score]\n", "utf8");
      },
    });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("no legacy bindings to migrate");
    expect(readFileSync(join(rollHome(again.cwd), "agents.yaml"), "utf8")).toBe(machine);
    expect(readFileSync(join(again.cwd, ".roll", "agents.yaml"), "utf8")).toBe(project);
  });

  it("unknown subcommand is TS-owned (v4 usage line)", () => {
    expect(run(["bogus"])).toMatchObject({
      code: 1,
      stdout: "Usage: roll agent [--workspace <id|path>|migrate [--dry-run]|list|readiness [agent]|disable <name> [--machine] [--force]|enable <name> [--machine]]\n",
      stderr: "[roll] Unknown subcommand: bogus\n",
    });
  });

  it("agent registry no longer has a bash fallback branch", () => {
    const src = readFileSync(`${repoRoot()}/packages/cli/src/commands/index.ts`, "utf8");
    expect(src).not.toContain('fallbackToBash(["agent"');
  });

  it("US-V4-002: agent writes no longer trigger a global dossier refresh", () => {
    const src = readFileSync(`${repoRoot()}/packages/cli/src/commands/agent.ts`, "utf8");
    expect(src).not.toContain("refreshAggregates");
    expect(src).not.toContain("refreshAgentDossier");
  });
});
