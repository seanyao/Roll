/**
 * Frozen-expectation test: TS `roll agent list` render.
 *
 * `agentListCommand` was proven byte-equal to the bash oracle `bin/roll agent
 * list` under diff-test (fabricated PATH/HOME/project). Per US-PORT-009c the
 * oracle is retired: the `bin/roll agent list` spawn is dropped and each case
 * freezes the TS render as an inline snapshot (zero engine spawn). The fabricated
 * PATH/HOME/project is project I/O, not an oracle, so it stays — output is the
 * agent roster + (current) marker, fully deterministic and path-free (portable).
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENTS } from "../../core/src/agent/specs.js";
import { AGENT_ORDER, agentListCommand } from "../src/commands/agent-list.js";
import { seedUpdateCheckCache } from "./helpers.js";

const dirs: string[] = [];
let home = "";
let proj = "";
let fakeBin = "";
let PATH = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "roll-al-home-"));
  proj = mkdtempSync(join(tmpdir(), "roll-al-proj-"));
  fakeBin = mkdtempSync(join(tmpdir(), "roll-al-bin-"));
  dirs.push(home, proj, fakeBin);
  // installed: claude + kimi (via kimi-cli alias binary)
  for (const b of ["claude", "kimi-cli"]) {
    const p = join(fakeBin, b);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  PATH = `${fakeBin}:/usr/bin:/bin`;
  seedUpdateCheckCache(join(home, ".roll"));
});

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

function tsList(env: Record<string, string>, cwd = proj): string {
  const save: Record<string, string | undefined> = {};
  const keys = ["PATH", "HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"];
  for (const k of keys) save[k] = process.env[k];
  process.env["PATH"] = PATH;
  process.env["HOME"] = home;
  process.env["ROLL_HOME"] = join(home, ".roll");
  delete process.env["NO_COLOR"];
  delete process.env["LC_ALL"];
  delete process.env["LANG"];
  delete process.env["ROLL_LANG"];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const saveCwd = process.cwd();
  process.chdir(cwd);
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  // @ts-expect-error capture-only
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    agentListCommand([]);
  } finally {
    process.stdout.write = real;
    process.chdir(saveCwd);
    for (const k of keys) {
      const v = save[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return chunks.join("");
}

describe("frozen: roll agent list render", () => {
  it("US-AGENT-044: list order is derived from core AGENTS", () => {
    expect([...AGENT_ORDER]).toEqual(AGENTS.map((spec) => spec.name));
  });

  it("default current (claude), colors on, en", () => {
    expect(tsList({ ROLL_LANG: "en" })).toMatchInlineSnapshot(`
      "
        Available agents

          [0;32m✓ claude[0m  (current)
          [0;32m✓ kimi[0m
          [0;33m✗ codex[0m  (not installed)
          [0;33m✗ pi[0m  (not installed)
          [0;33m✗ antigravity (agy)[0m  (not installed)
          [0;33m✗ reasonix[0m  (not installed)
          [0;33m✗ cursor[0m  (not installed)

      "
    `);
  });

  it("zh locale renders zh single-language", () => {
    expect(tsList({ ROLL_LANG: "zh" })).toMatchInlineSnapshot(`
      "
        可用 agent

          [0;32m✓ claude[0m  (current)
          [0;32m✓ kimi[0m
          [0;33m✗ codex[0m  (not installed)
          [0;33m✗ pi[0m  (not installed)
          [0;33m✗ antigravity (agy)[0m  (not installed)
          [0;33m✗ reasonix[0m  (not installed)
          [0;33m✗ cursor[0m  (not installed)

      "
    `);
  });

  it("NO_COLOR strips colors identically", () => {
    expect(tsList({ ROLL_LANG: "en", NO_COLOR: "1" })).toMatchInlineSnapshot(`
      "
        Available agents

          ✓ claude  (current)
          ✓ kimi
          ✗ codex  (not installed)
          ✗ pi  (not installed)
          ✗ antigravity (agy)  (not installed)
          ✗ reasonix  (not installed)
          ✗ cursor  (not installed)

      "
    `);
  });

  it("ignores the retired local agent preference", () => {
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "local.yaml"), 'agent: "kimi"\n');
    try {
      const ts = tsList({ ROLL_LANG: "en", NO_COLOR: "1" });
      expect(ts).toContain("✓ claude  (current)");
      expect(ts).toMatchInlineSnapshot(`
        "
          Available agents

            ✓ claude  (current)
            ✓ kimi
            ✗ codex  (not installed)
            ✗ pi  (not installed)
            ✗ antigravity (agy)  (not installed)
            ✗ reasonix  (not installed)
            ✗ cursor  (not installed)

        "
      `);
    } finally {
      execSync(`rm -f '${join(proj, ".roll", "local.yaml")}'`);
    }
  });

  it("US-WS-017a: machine view is independent of cwd project casting", () => {
    const other = mkdtempSync(join(tmpdir(), "roll-al-other-"));
    dirs.push(other);
    mkdirSync(join(home, ".roll"), { recursive: true });
    writeFileSync(join(home, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: machine
agents:
  claude:
    capabilities: [supervise, execute]
  kimi:
    capabilities: [execute]
    disabled: true
roles:
  supervise: { use: claude }
`);
    for (const [cwd, current] of [[proj, "codex"], [other, "kimi"]] as const) {
      mkdirSync(join(cwd, ".roll"), { recursive: true });
      writeFileSync(join(cwd, ".roll", "agents.yaml"), `schema: roll-agents/v1
scope: project
agents:
  claude:
    capabilities: [supervise]
    disabled: true
  ${current}:
    capabilities: [supervise]
roles:
  supervise: { use: ${current} }
`);
    }

    const first = tsList({ ROLL_LANG: "en", NO_COLOR: "1" }, proj);
    const second = tsList({ ROLL_LANG: "en", NO_COLOR: "1" }, other);
    expect(second).toBe(first);
    expect(first).toContain("✓ claude  (current)");
    expect(first).toContain("⊘ kimi  (disabled · machine)");
    expect(first).not.toContain("disabled · project");
  });
});
