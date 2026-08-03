/**
 * FIX-1056 — `roll agent readiness [agent]` probes agy's HEADLESS auth context
 * through the SAME spawn envelope the loop's peer/evaluator spawn uses. These
 * tests lock: ok when the auth-context dir exists, an actionable boundary when
 * it does not, and NO credential value ever printed (redaction).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEnv } from "@roll/core";
import { agentCommand } from "../src/commands/agent.js";
import { AGY_AUTH_CONTEXT_ENV } from "../src/runner/agent-spawn.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function homeEnv(home: string): AgentEnv {
  return { home, commandOnPath: () => true, dirExists: () => false, fileExecutable: () => false };
}

function run(args: string[], home: string, envVars: Record<string, string | undefined> = {}): { code: number; stdout: string } {
  const out: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(envVars)) {
    saved[k] = process.env[k];
    if (envVars[k] === undefined) delete process.env[k];
    else process.env[k] = envVars[k];
  }
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => true;
  let code = 1;
  try {
    code = agentCommand(args, { env: homeEnv(home) });
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { code, stdout: out.join("") };
}

function homeWithAgy(): string {
  const h = mkdtempSync(join(tmpdir(), "roll-readiness-ok-"));
  dirs.push(h);
  mkdirSync(join(h, ".config", "agy"), { recursive: true });
  return h;
}
function homeWithoutAgy(): string {
  const h = mkdtempSync(join(tmpdir(), "roll-readiness-no-"));
  dirs.push(h);
  return h;
}

describe("roll agent readiness (FIX-1056)", () => {
  it("reports agy ready and exits 0 when the auth-context dir exists (same spawn envelope)", () => {
    const r = run(["readiness", "agy"], homeWithAgy(), { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_APPLICATION_CREDENTIALS: undefined });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("readiness agy ok");
    expect(r.stdout).toContain(`${AGY_AUTH_CONTEXT_ENV}=`);
    expect(r.stdout).toContain(join(".config", "agy"));
  });

  it("reports an actionable missing boundary and exits 1 when no auth context exists", () => {
    const r = run(["readiness"], homeWithoutAgy(), { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_APPLICATION_CREDENTIALS: undefined });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("readiness agy auth-blocked");
    expect(r.stdout).toContain("no headless auth context");
    expect(r.stdout).toContain("GEMINI_API_KEY");
  });

  it("NEVER prints a credential value — only names/paths (redaction)", () => {
    const secret = "AIza-super-secret-token-value";
    const r = run(["readiness", "agy"], homeWithoutAgy(), { GEMINI_API_KEY: secret });
    expect(r.stdout).not.toContain(secret);
    expect(r.stdout).toContain("GEMINI_API_KEY");
    expect(r.code).toBe(0); // an auth env var alone satisfies readiness
  });

  it("a non-agy agent reports no separate readiness probe (auth resolved at spawn)", () => {
    const r = run(["readiness", "kimi"], homeWithoutAgy());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no headless auth-context probe for 'kimi'");
  });

  it("US-WS-017a: readiness is independent of cwd project casting", () => {
    const home = homeWithAgy();
    const first = mkdtempSync(join(tmpdir(), "roll-readiness-project-a-"));
    const second = mkdtempSync(join(tmpdir(), "roll-readiness-project-b-"));
    dirs.push(first, second);
    for (const [cwd, agent] of [[first, "codex"], [second, "kimi"]] as const) {
      mkdirSync(join(cwd, ".roll"), { recursive: true });
      writeFileSync(join(cwd, ".roll", "agents.yaml"), `schema: roll-agents/v1\nscope: project\nroles:\n  supervise: { use: ${agent} }\n`);
    }
    const original = process.cwd();
    try {
      process.chdir(first);
      const a = run(["readiness", "agy"], home, { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_APPLICATION_CREDENTIALS: undefined });
      process.chdir(second);
      const b = run(["readiness", "agy"], home, { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GOOGLE_APPLICATION_CREDENTIALS: undefined });
      expect(b).toEqual(a);
    } finally {
      process.chdir(original);
    }
  });
});
