import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pairCommand } from "../src/commands/pair.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], before?: (cwd: string) => void): { code: number; stdout: string; stderr: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "roll-pair-command-"));
  dirs.push(cwd);
  const priorCwd = process.cwd();
  const priorHome = process.env["ROLL_HOME"];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout.push(String(chunk)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (chunk: string | Uint8Array): boolean => (stderr.push(String(chunk)), true);
  process.env["ROLL_HOME"] = join(cwd, "home", ".roll");
  process.chdir(cwd);
  try {
    before?.(cwd);
    const result = pairCommand(args);
    if (typeof result !== "number") throw new Error("pair command unexpectedly returned a promise");
    return { code: result, stdout: stdout.join(""), stderr: stderr.join(""), cwd };
  } finally {
    process.chdir(priorCwd);
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    if (priorHome === undefined) delete process.env["ROLL_HOME"];
    else process.env["ROLL_HOME"] = priorHome;
  }
}

describe("roll pair — scoped evaluator configuration", () => {
  it("has no pair-init compatibility branch", () => {
    const result = run(["init"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown pair subcommand: init");
    expect(result.stderr).not.toContain("`roll pair init` is retired");
  });

  it("does not read a legacy pairing pool for status", () => {
    const result = run(["status"], (cwd) => {
      mkdirSync(join(cwd, ".roll"), { recursive: true });
      writeFileSync(join(cwd, ".roll", "pairing.yaml"), "enabled: true\nstages: [code]\ncapability:\n  pi: [code]\n", "utf8");
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No scoped evaluator binding");
    expect(result.stdout).not.toContain("pi");
  });
});
