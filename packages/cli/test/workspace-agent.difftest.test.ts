import { describe, expect, it } from "vitest";
import type { AgentEnv } from "@roll/core";
import { agentCommand, type AgentCommandDeps } from "../src/commands/agent.js";

const MACHINE_PATH = "/machine/.roll/agents.yaml";
const WORKSPACE_PATH = "/workspaces/payments/agents.yaml";

const MACHINE = `schema: roll-agents/v1
scope: machine
agents:
  codex:
    capabilities: [supervise, execute, evaluate]
    models: [gpt-5.5]
  kimi:
    capabilities: [execute, evaluate]
  pi:
    capabilities: [evaluate]
    disabled: true
roles:
  supervise:
    kind: fixed
    agent: codex
`;

const WORKSPACE = `schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  supervise:
    kind: inherit
defaults:
  story:
    roles:
      execute:
        kind: select
        from: [pi, kimi, codex]
        strategy: first-available
  skill:
    roles:
      evaluate:
        kind: fixed
        agent: codex
        model: gpt-5.5
`;

function env(): AgentEnv {
  return {
    home: "/machine",
    commandOnPath: (name) => name === "codex" || name === "kimi",
    dirExists: () => false,
    fileExecutable: () => false,
  };
}

function run(lang: "en" | "zh", workspace = WORKSPACE): { code: number; stdout: string; stderr: string; files: Map<string, string> } {
  const files = new Map<string, string>([
    [MACHINE_PATH, MACHINE],
    [WORKSPACE_PATH, workspace],
  ]);
  const deps: AgentCommandDeps = {
    env: env(),
    fileExists: (path) => files.has(path),
    readText: (path) => files.get(path) ?? "",
    writeText: (path, text) => files.set(path, text),
    writeFileAtomic: (path, text) => files.set(path, text),
    resolveWorkspace: () => ({ ok: true, workspaceId: "payments", workspaceRoot: "/workspaces/payments" }),
  };
  const saveLang = process.env["ROLL_LANG"];
  const saveHome = process.env["ROLL_HOME"];
  process.env["ROLL_LANG"] = lang;
  process.env["ROLL_HOME"] = "/machine/.roll";
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let code = 1;
  try {
    code = agentCommand(["--workspace", "payments"], deps);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    if (saveLang === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = saveLang;
    if (saveHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = saveHome;
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), files };
}

describe("roll agent --workspace — US-WS-017a", () => {
  it("freezes the English effective casting and source trace", () => {
    const before = new Map(run("en").files);
    const result = run("en");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.files).toEqual(before);
    expect(result.stdout).toMatchInlineSnapshot(`
      "
        Workspace agent casting — payments
        root: /workspaces/payments
        machine: /machine/.roll/agents.yaml
        policy: /workspaces/payments/agents.yaml

        workspace.supervise
          selected: codex
          model: default
          strategy: fixed
          candidates: codex
          skipped: none
          trace: /workspaces/payments/agents.yaml:roles.supervise [inherit] -> /machine/.roll/agents.yaml:roles.supervise [resolve]

        story.execute
          selected: kimi
          model: default
          strategy: first-available
          candidates: pi, kimi, codex
          skipped: pi (disabled)
          trace: /workspaces/payments/agents.yaml:defaults.story.roles.execute [select]

        skill.evaluate
          selected: codex
          model: gpt-5.5
          strategy: fixed
          candidates: codex
          skipped: none
          trace: /workspaces/payments/agents.yaml:defaults.skill.roles.evaluate [resolve]

      "
    `);
  });

  it("freezes the Chinese single-language view", () => {
    const result = run("zh");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Workspace agent casting — payments");
    expect(result.stdout).toContain("已选择: kimi");
    expect(result.stdout).toContain("跳过: pi (已禁用)");
    expect(result.stdout).not.toContain("selected:");
  });

  it("fails loud for a Workspace fixed reference outside machine capability", () => {
    const result = run("en", `schema: roll-agents/v1
scope: workspace
inherits: machine
roles:
  supervise: { use: kimi }
`);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("selected: unresolved");
    expect(result.stdout).toContain("fixed agent 'kimi' lacks role capability 'supervise'");
    expect(result.files.get(MACHINE_PATH)).toBe(MACHINE);
    expect(result.files.get(WORKSPACE_PATH)).toContain("supervise: { use: kimi }");
  });
});
