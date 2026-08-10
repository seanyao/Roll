/**
 * FIX-1512 — the repository launcher must never quietly run a stale build.
 *
 * This is deliberately a subprocess test of the public `bin/roll.js` entry,
 * rather than a direct call into a command handler. The fixture gives that
 * entry a newer source file and an older (linked) build, then proves an
 * otherwise-writing command never reaches the project's backlog.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const rollBin = join(packageRoot, "bin", "roll.js");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeProject(): { project: string; backlog: string } {
  const project = tempDir("roll-dev-build-project-");
  const features = join(project, ".roll", "features");
  mkdirSync(features, { recursive: true });
  const backlog = join(project, ".roll", "backlog.md");
  writeFileSync(backlog, "# Backlog\n\n", "utf8");
  return { project, backlog };
}

function staleDevLauncher(): string {
  const fixture = tempDir("roll-dev-build-launcher-");
  mkdirSync(join(fixture, "bin"), { recursive: true });
  mkdirSync(join(fixture, "src"), { recursive: true });
  copyFileSync(rollBin, join(fixture, "bin", "roll.js"));
  symlinkSync(join(packageRoot, "dist"), join(fixture, "dist"), "dir");
  const source = join(fixture, "src", "new-command.ts");
  writeFileSync(source, "export const current = true;\n", "utf8");
  const later = new Date(Date.now() + 10_000);
  utimesSync(source, later, later);
  return join(fixture, "bin", "roll.js");
}

function run(bin: string, project: string, args: string[]): { code: number; out: string; err: string } {
  const child = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    env: { ...process.env, ROLL_LANG: "en", NO_COLOR: "1" },
    encoding: "utf8",
  });
  return { code: child.status ?? 1, out: child.stdout ?? "", err: child.stderr ?? "" };
}

describe("FIX-1512 — repository CLI build freshness", () => {
  it("stops before a writing command when the development build is stale", () => {
    const { project, backlog } = writeProject();
    const before = readFileSync(backlog, "utf8");

    const result = run(staleDevLauncher(), project, ["idea", "--type", "fix", "do not write"]);

    expect(result.code).not.toBe(0);
    expect(`${result.out}${result.err}`).toContain("pnpm -r build");
    expect(readFileSync(backlog, "utf8")).toBe(before);
    expect(existsSync(join(project, ".roll", "features", "FIX-1"))).toBe(false);
  });

  it.each([
    ["--type", "fix", "separate type argument"],
    ["--type=fix", "equals type argument"],
  ])("passes %s through the real current entry without putting it in the card text", (...args: string[]) => {
    const { project, backlog } = writeProject();

    const result = run(rollBin, project, ["idea", ...args]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/Recorded as FIX-\d+/);
    expect(readFileSync(backlog, "utf8")).toContain("FIX-001");
    expect(readFileSync(backlog, "utf8")).not.toContain("--type");
    expect(readFileSync(backlog, "utf8")).not.toContain("fix separate");
    expect(readFileSync(backlog, "utf8")).not.toContain("fix equals");
  });
});
