import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { doctorCommand } from "../src/commands/doctor.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(tag: string): string {
  const repo = mkdtempSync(join(tmpdir(), `roll-doctor-protection-${tag}-`));
  dirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, ".roll", "loop"), { recursive: true });
  return repo;
}

function seedResidue(repo: string): string {
  const file = join(repo, "tracked.txt");
  writeFileSync(file, "base\n", "utf8");
  chmodSync(file, 0o444);
  writeFileSync(
    join(repo, ".roll", "loop", "main-checkout-protection.json"),
    JSON.stringify({ repoCwd: repo, cycleId: "C-doctor", entries: [{ path: file, mode: 0o644 }] }, null, 2),
    "utf8",
  );
  writeFileSync(join(repo, ".git", "config.lock"), "roll main-checkout config lock sentinel\n", "utf8");
  chmodSync(join(repo, ".git", "config.lock"), 0o444);
  return file;
}

function captureDoctor(root: string, args: string[]): { status: number; stdout: string } {
  const saveCwd = process.cwd();
  const chunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  process.chdir(root);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (chunks.push(String(c)), true);
  try {
    return { status: doctorCommand(args, { externalTools: () => [] }), stdout: chunks.join("") };
  } finally {
    process.stdout.write = realOut;
    process.chdir(saveCwd);
  }
}

describe("doctor main-checkout write-protection repair", () => {
  it("surfaces stale protection residue in the normal doctor report", () => {
    const repo = tmpRepo("detect");
    seedResidue(repo);

    const result = captureDoctor(repo, []);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Main checkout write-protection residue");
    expect(result.stdout).toContain("main-checkout-protection.json");
    expect(result.stdout).toContain("fix: roll doctor repair-protection");
  });

  it("repair-protection restores marker modes and removes the owned config.lock", () => {
    const repo = tmpRepo("repair");
    const file = seedResidue(repo);

    const result = captureDoctor(repo, ["repair-protection"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("restored paths: 1");
    expect(result.stdout).toContain("config lock: removed");
    expect(existsSync(join(repo, ".roll", "loop", "main-checkout-protection.json"))).toBe(false);
    expect(existsSync(join(repo, ".git", "config.lock"))).toBe(false);
    expect(statSync(file).mode & 0o200).toBe(0o200);
    expect(readFileSync(file, "utf8")).toBe("base\n");
  });
});
