/**
 * US-CYCLE-011 (codex review, finding #1) — scripts/test-ts.sh must write the
 * `.roll/last-test-pass` proof ONLY after EVERY failure check has passed. The
 * FIX-1264 orphan-snapshot guard can `exit 1`; if the proof were written before
 * it, a FAILED full run would still leave a fresh `mode:"full"` proof and the
 * delivery full-verify gate would accept a run that actually failed.
 *
 * We shell the REAL script in a throwaway git repo, stubbing the heavy steps
 * (`pnpm -r build/test`, the audit script) via a PATH `pnpm` shim, and assert:
 *   - orphan snapshot present ⇒ nonzero exit ⇒ NO proof file written;
 *   - no orphan            ⇒ zero exit  ⇒ a mode:"full" proof written.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = join(HERE, "..", "..", "..", "scripts", "test-ts.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** A temp git repo carrying a copy of test-ts.sh + stubbed heavy deps. */
function repo(opts: { orphanSnapshot: boolean }): { root: string; shimDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-testsh-")));
  dirs.push(root);
  const git = (...args: string[]): void => {
    const env = { ...process.env };
    delete env["GIT_DIR"];
    delete env["GIT_WORK_TREE"];
    delete env["GIT_INDEX_FILE"];
    const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "test-ts.sh"), readFileSync(SCRIPT_SRC, "utf8"), { mode: 0o755 });
  // The script runs `node scripts/audit-role-taxonomy.mjs` — an empty file exits 0.
  writeFileSync(join(root, "scripts", "audit-role-taxonomy.mjs"), "");
  // Snapshot layout the FIX-1264 guard scans.
  const snapDir = join(root, "packages", "cli", "test", "__snapshots__");
  mkdirSync(snapDir, { recursive: true });
  if (opts.orphanSnapshot) {
    // A .snap with NO corresponding test file => orphan => guard `exit 1`.
    writeFileSync(join(snapDir, "orphan.test.ts.snap"), "// orphan\n");
  } else {
    // A .snap WITH its test file => not orphan => guard passes.
    writeFileSync(join(snapDir, "keep.test.ts.snap"), "// kept\n");
    writeFileSync(join(root, "packages", "cli", "test", "keep.test.ts"), "// test\n");
  }
  git("init", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "# t\n");
  git("add", "-A");
  git("commit", "-m", "init", "--no-verify");

  // PATH shim: stub `pnpm` (build/test) so the heavy steps no-op with exit 0.
  const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "roll-testsh-bin-")));
  dirs.push(shimDir);
  writeFileSync(join(shimDir, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, shimDir };
}

function runScript(root: string, shimDir: string): { status: number; stderr: string } {
  const env = { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  const r = spawnSync("bash", ["scripts/test-ts.sh"], { cwd: root, env, encoding: "utf8" });
  return { status: r.status ?? -1, stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

describe("test-ts.sh — proof is written only after all failure checks (US-CYCLE-011 #1)", () => {
  it("orphan snapshot ⇒ nonzero exit ⇒ NO proof written", () => {
    const { root, shimDir } = repo({ orphanSnapshot: true });
    const r = runScript(root, shimDir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Orphan vitest snapshot/i);
    expect(existsSync(join(root, ".roll", "last-test-pass"))).toBe(false);
  });

  it("no orphan ⇒ zero exit ⇒ a mode:\"full\" proof is written", () => {
    const { root, shimDir } = repo({ orphanSnapshot: false });
    const r = runScript(root, shimDir);
    expect(r.status).toBe(0);
    const proof = JSON.parse(readFileSync(join(root, ".roll", "last-test-pass"), "utf8"));
    expect(proof.mode).toBe("full");
    expect(proof.scope).toBe("full");
  });
});
