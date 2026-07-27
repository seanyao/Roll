/**
 * FIX-1482 — read-only role isolation is ENFORCED OR REFUSED.
 *
 * US-DELTA-006 (#1500) introduced `readOnly` spawns for the Full Delta
 * Designer/Evaluator. Only SANDBOX-ENFORCING adapters actually jail product
 * writes at the OS level: codex (`--sandbox read-only`) and reasonix (its
 * generated Seatbelt reasonix.toml). For every other adapter (pi/kimi/agy/
 * cursor/claude) `readOnly` was merely ADVISORY (prompt + no product write
 * roots) with NO kernel block.
 *
 * Owner-chosen approach for FIX-1482: rather than build new OS sandbox
 * machinery, RESTRICT which adapters may run a readOnly role. A `readOnly:true`
 * spawn resolved to a NON-enforcing adapter now FAILS LOUD at the spawn
 * boundary (assertReadOnlyEnforceable / buildSpawnCommand) instead of silently
 * running advisory-only. Enforcing adapters still honor explicit writableRoots.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentProfile, buildSpawnCommand } from "../src/runner/agent-spawn.js";

const ENFORCING = ["codex", "reasonix"] as const;
const NON_ENFORCING = ["kimi", "pi", "agy", "cursor", "claude"] as const;

const tmpDirs: string[] = [];
function tmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "roll-ro-1482-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("FIX-1482 — profile capability: enforcesReadOnly", () => {
  it("codex and reasonix declare enforcesReadOnly:true", () => {
    for (const agent of ENFORCING) {
      expect(agentProfile(agent).enforcesReadOnly, `${agent} must enforce readOnly`).toBe(true);
    }
  });

  it("pi/kimi/agy/cursor/claude do NOT declare enforcesReadOnly", () => {
    for (const agent of NON_ENFORCING) {
      expect(agentProfile(agent).enforcesReadOnly, `${agent} must not enforce readOnly`).toBeFalsy();
    }
  });
});

describe("FIX-1482 AC1/AC4 — readOnly spawn on a non-enforcing adapter FAILS LOUD", () => {
  for (const agent of NON_ENFORCING) {
    it(`refuses a readOnly:true spawn on '${agent}' with a message naming the agent + supported adapters`, () => {
      const call = () =>
        buildSpawnCommand(agent, {
          cwd: "/cycle/wt",
          skillBody: "DESIGN",
          readOnly: true,
          writableRoots: ["/cycle/wt/artifacts"],
        });
      expect(call).toThrow(/readOnly isolation is not enforceable/);
      // The message must name the offending agent AND the supported adapters —
      // not a silent advisory spawn.
      expect(call).toThrow(new RegExp(`'${agent}'`));
      expect(call).toThrow(/codex or reasonix/);
      expect(call).toThrow(/Designer\/Evaluator/);
    });
  }
});

describe("FIX-1482 AC2 — enforcing adapters still sandbox AND still honor writableRoots", () => {
  it("codex readOnly spawn keeps `--sandbox read-only` and grants the artifact dir via --add-dir", () => {
    const artifactDir = "/cycle/wt/role-artifacts/designer";
    const { bin, args } = buildSpawnCommand("codex", {
      cwd: "/cycle/wt",
      skillBody: "DESIGN",
      storyId: "FIX-1482",
      readOnly: true,
      writableRoots: [artifactDir],
    });
    expect(bin).toBe("codex");
    // sandbox flag present AND set to read-only (not workspace-write)
    const sandboxIdx = args.indexOf("--sandbox");
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(args[sandboxIdx + 1]).toBe("read-only");
    expect(args).not.toContain("workspace-write");
    // explicit writable root still granted (the Designer's artifact dir)
    const addDirIdx = args.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(args).toContain(artifactDir);
  });

  it("reasonix readOnly spawn writes a Seatbelt reasonix.toml that allow_writes ONLY the artifact dir", () => {
    const cwd = tmpCwd();
    const artifactDir = join(cwd, "role-artifacts", "designer");
    const cleanups: Array<() => void> = [];
    const opts = {
      cwd,
      skillBody: "DESIGN",
      storyId: "FIX-1482",
      readOnly: true,
      writableRoots: [artifactDir],
      cleanup: undefined as undefined | (() => void),
    };
    const { bin, args } = buildSpawnCommand("reasonix", opts);
    expect(bin).toBe("reasonix");
    expect(args).toContain("run");
    // The Seatbelt config is written to cwd/reasonix.toml at build time.
    const configPath = join(cwd, "reasonix.toml");
    expect(existsSync(configPath)).toBe(true);
    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain("[sandbox]");
    expect(toml).toContain('bash = "enforce"');
    // allow_write is limited to the explicit artifact dir (writableRoots).
    expect(toml).toMatch(/allow_write\s*=\s*\[[^\]]*role-artifacts\/designer/);
    // cleanup restores/removes the per-cycle config.
    if (opts.cleanup) {
      opts.cleanup();
      cleanups.push(opts.cleanup);
    }
    expect(existsSync(configPath)).toBe(false);
  });

  it("reasonix readOnly spawn with EMPTY writableRoots STILL writes an enforce sandbox (allow_write=[]) — no silent bypass", () => {
    // Regression for the codex-found gap: the Seatbelt config used to be written
    // ONLY when writableRoots was non-empty, so a readOnly reasonix spawn with no
    // extra roots skipped it and fell back to reasonix's default (possibly
    // unsandboxed) — silently defeating enforcesReadOnly. It must now write a
    // fully-read-only sandbox (bash=enforce, allow_write=[]).
    const cwd = tmpCwd();
    const opts = {
      cwd,
      skillBody: "DESIGN",
      storyId: "FIX-1482",
      readOnly: true,
      writableRoots: [] as string[],
      cleanup: undefined as undefined | (() => void),
    };
    buildSpawnCommand("reasonix", opts);
    const configPath = join(cwd, "reasonix.toml");
    expect(existsSync(configPath)).toBe(true);
    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain("[sandbox]");
    expect(toml).toContain('bash = "enforce"');
    // Nothing is writable — fully read-only.
    expect(toml).toMatch(/allow_write\s*=\s*\[\s*\]/);
    if (opts.cleanup) opts.cleanup();
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("FIX-1482 AC3 — per-agent readOnly outcome (enforced → allowed, non-enforcing → refused)", () => {
  for (const agent of ENFORCING) {
    it(`enforcing agent '${agent}' is ALLOWED to run a readOnly spawn`, () => {
      expect(() =>
        buildSpawnCommand(agent, {
          cwd: tmpCwd(),
          skillBody: "EVAL",
          readOnly: true,
          writableRoots: [join(tmpCwd(), "art")],
        }),
      ).not.toThrow();
    });
  }
  for (const agent of NON_ENFORCING) {
    it(`non-enforcing agent '${agent}' is REFUSED a readOnly spawn`, () => {
      expect(() =>
        buildSpawnCommand(agent, { cwd: "/cycle/wt", skillBody: "EVAL", readOnly: true }),
      ).toThrow(/readOnly isolation is not enforceable/);
    });
  }
});

describe("FIX-1482 — non-readOnly spawns are UNAFFECTED for all adapters", () => {
  for (const agent of [...ENFORCING, ...NON_ENFORCING]) {
    it(`'${agent}' spawns normally when readOnly is not set`, () => {
      const cwd = agent === "reasonix" ? tmpCwd() : "/cycle/wt";
      const { bin, args } = buildSpawnCommand(agent, { cwd, skillBody: "DO WORK" });
      expect(typeof bin).toBe("string");
      expect(bin.length).toBeGreaterThan(0);
      expect(args.length).toBeGreaterThan(0);
      // the prompt body always rides through
      expect(args.some((a) => a.includes("DO WORK"))).toBe(true);
    });
  }

  it("kimi still requests stream-json on a normal (non-readOnly) spawn", () => {
    const { args } = buildSpawnCommand("kimi", { cwd: "/cycle/wt", skillBody: "DO WORK" });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("codex non-readOnly spawn keeps workspace-write (regression guard)", () => {
    const { args } = buildSpawnCommand("codex", { cwd: "/cycle/wt", skillBody: "DO WORK" });
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("read-only");
  });
});
