/**
 * FIX-1056 — agy headless auth-context propagation.
 *
 * The observed break (cycle 20260701-000657-76542): agy was selected for both
 * code review and score and emitted `agent:blocked cause=auth` twice even though
 * the owner had authenticated agy interactively. Root cause: agy used the generic
 * simplePromptProfile with NO childEnv, so its headless (launchd) child never saw
 * the owner's authenticated auth-context home. These tests lock the fix: the agy
 * spawn envelope forwards the SAME auth-context dir the interactive CLI uses, the
 * readiness diagnostic reuses that same envelope, and NO credential value is ever
 * surfaced.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGY_AUTH_CONTEXT_ENV,
  agentProfile,
  agentSpawnEnvironment,
  agyAuthContext,
  agyAuthContextDir,
  agyEnv,
  buildSpawnCommand,
  realAgentSpawn,
} from "../src/runner/agent-spawn.js";

const tmpDirs: string[] = [];
function homeWithAgyConfig(): string {
  const home = mkdtempSync(join(tmpdir(), "roll-agy-home-"));
  tmpDirs.push(home);
  mkdirSync(join(home, ".config", "agy"), { recursive: true });
  return home;
}
function homeWithoutAgyConfig(): string {
  const home = mkdtempSync(join(tmpdir(), "roll-agy-nohome-"));
  tmpDirs.push(home);
  return home;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("FIX-1056 — agy spawn envelope propagates the authenticated auth-context", () => {
  it("agy has an EXPLICIT profile with a childEnv hook (not the generic simplePromptProfile)", () => {
    const agy = agentProfile("agy");
    expect(agy.name).toBe("agy");
    expect(typeof agy.childEnv).toBe("function");
  });

  it("the argv shape is unchanged (`agy -p <prompt>`) — only the child env is added", () => {
    const prompt = agentProfile("agy").buildSpawnCommand({ cwd: "/wt", skillBody: "DO WORK" }).args[1];
    const { bin, args } = buildSpawnCommand("agy", { cwd: "/wt", skillBody: "DO WORK" });
    expect(bin).toBe("agy");
    expect(args).toEqual(["-p", prompt]);
  });

  it("forwards the resolved auth-context dir to the headless child when it exists", () => {
    const home = homeWithAgyConfig();
    expect(agentSpawnEnvironment("agy", home)).toEqual({
      [AGY_AUTH_CONTEXT_ENV]: agyAuthContextDir(home),
    });
  });

  it("adds nothing when the owner has no auth-context dir (an absent context is surfaced, not masked)", () => {
    const home = homeWithoutAgyConfig();
    expect(agentSpawnEnvironment("agy", home)).toEqual({});
  });

  it("respects an explicit owner AGY_CONFIG_DIR override — never clobbers it", () => {
    const home = homeWithAgyConfig();
    expect(agyEnv(home, { [AGY_AUTH_CONTEXT_ENV]: "/owner/custom" })).toEqual({});
  });

  it("readiness reuses the SAME envelope (same auth-context dir) as the spawn", () => {
    const home = homeWithAgyConfig();
    const ctx = agyAuthContext(home, {});
    expect(ctx.ok).toBe(true);
    expect(ctx.configDir).toBe(agyAuthContextDir(home));
    expect(ctx.configDir).toBe(agentSpawnEnvironment("agy", home)[AGY_AUTH_CONTEXT_ENV]);
    expect(ctx.missingBoundary).toBeNull();
  });

  it("reports an actionable missing boundary when NO auth context exists (never a silent exclude)", () => {
    const home = homeWithoutAgyConfig();
    const ctx = agyAuthContext(home, {});
    expect(ctx.ok).toBe(false);
    expect(ctx.configDirExists).toBe(false);
    expect(ctx.missingBoundary).toContain(agyAuthContextDir(home));
    expect(ctx.missingBoundary).toContain("GEMINI_API_KEY");
  });

  it("an auth env var alone satisfies readiness (env-based auth, no config dir)", () => {
    const home = homeWithoutAgyConfig();
    const ctx = agyAuthContext(home, { GEMINI_API_KEY: "super-secret-token-value" });
    expect(ctx.ok).toBe(true);
    expect(ctx.authEnvPresent).toEqual(["GEMINI_API_KEY"]);
  });

  it("NEVER surfaces a credential VALUE — only names/paths are reported (redaction)", () => {
    const home = homeWithoutAgyConfig();
    const secret = "AIza-super-secret-token-value";
    const ctx = agyAuthContext(home, { GEMINI_API_KEY: secret, GOOGLE_API_KEY: secret });
    const blob = JSON.stringify(ctx);
    expect(blob).not.toContain(secret);
    expect(ctx.authEnvPresent).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  });
});

describe("US-AGENT-048 — Cursor headless Builder argv", () => {
  it("builds the documented headless argv with --workspace (not --worktree)", () => {
    const { bin, args } = buildSpawnCommand("cursor", { cwd: "/cycle/wt", skillBody: "DO WORK" });
    expect(bin).toBe("cursor-agent");
    expect(args).toEqual([
      "--print",
      "--trust",
      "--force",
      "--workspace",
      "/cycle/wt",
      "--output-format",
      "text",
      expect.stringContaining("DO WORK"),
    ]);
    expect(args).not.toContain("--worktree");
  });

  it("carries the story pin and autorun directive in the prompt", () => {
    const { args } = buildSpawnCommand("cursor", {
      cwd: "/cycle/wt",
      skillBody: "skill body",
      storyId: "US-AGENT-048",
    });
    const prompt = args[args.length - 1] ?? "";
    expect(prompt).toContain("[roll 自主模式]");
    expect(prompt).toContain("US-AGENT-048");
    expect(prompt).toContain("skill body");
  });

  it("bare reviewer spawn omits the worker directive and story pin", () => {
    const { args } = buildSpawnCommand("cursor", {
      cwd: "/cycle/wt",
      skillBody: "review prompt",
      storyId: "US-AGENT-048",
      bare: true,
    });
    const prompt = args[args.length - 1] ?? "";
    expect(prompt).toBe("review prompt");
    expect(prompt).not.toContain("[roll 自主模式]");
  });
});

describe("FIX-1264 — Kimi Builder activity is observable", () => {
  it("requests stream-json so tool progress reaches the loop runner", () => {
    const { bin, args } = buildSpawnCommand("kimi", { cwd: "/cycle/wt", skillBody: "DO WORK" });
    expect(bin).toBe("kimi");
    expect(args).toEqual(["-p", expect.stringContaining("DO WORK"), "--output-format", "stream-json"]);
  });
});

describe("FIX-1231 — codex git isolation", () => {
  it("codex profile declares isolateGit:true", () => {
    const profile = agentProfile("codex");
    expect(profile.isolateGit).toBe(true);
  });

  it("non-codex agents do NOT declare isolateGit", () => {
    for (const agent of ["claude", "pi", "kimi", "reasonix", "agy", "cursor"]) {
      const profile = agentProfile(agent);
      expect(profile.isolateGit, `${agent} should not isolate git`).toBeFalsy();
    }
  });

  it("codex spawn command still builds correctly with isolateGit", () => {
    const { bin, args } = buildSpawnCommand("codex", {
      cwd: "/cycle/wt",
      skillBody: "DO WORK",
      storyId: "FIX-1231",
      writableRoots: ["/repo/.roll"],
    });
    expect(bin).toBe("codex");
    expect(args).toContain("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
    const prompt = args[args.length - 1] ?? "";
    expect(prompt).toContain("DO WORK");
    expect(prompt).toContain("FIX-1231");
  });
});

describe("FIX-1473 — spawned agents discover Git from cwd", () => {
  it("removes inherited repository-binding GIT_* variables for every agent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "roll-fix1473-agent-env-"));
    tmpDirs.push(repo);
    execFileSync("git", ["init", "-q", "-b", "cycle"], { cwd: repo });

    const shim = join(repo, "claude-shim");
    writeFileSync(
      shim,
      [
        "#!/usr/bin/env node",
        'const { execFileSync } = require("node:child_process");',
        'const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];',
        "for (const name of names) {",
        "  const value = process.env[name] ?? '';",
        "  if (value !== '') { process.stderr.write(`${name}=${value}\\n`); process.exit(41); }",
        "}",
        'process.stdout.write(`top=${execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()}\\n`);',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(shim, 0o755);

    const result = await realAgentSpawn("claude", {
      cwd: repo,
      skillBody: "X",
      bin: shim,
      env: {
        ...process.env,
        GIT_DIR: "/poison/git-dir",
        GIT_WORK_TREE: "/poison/work-tree",
        GIT_COMMON_DIR: "/poison/common-dir",
        GIT_INDEX_FILE: "/poison/index",
        GIT_OBJECT_DIRECTORY: "/poison/objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/poison/alternates",
        GIT_NAMESPACE: "poison",
      },
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain(`top=${realpathSync(repo)}`);
    expect(result.stderr).toBe("");
  });
});

describe("cursor is a builder again (reverses the FIX-1257 config-only downgrade)", () => {
  const projectAgentsYaml = fileURLToPath(new URL("../../../.roll/agents.yaml", import.meta.url));
  // .roll/ is the nested PRIVATE roll-meta repo — absent in CI checkouts. The
  // pool membership lives in config (deliberately not code), so these assertions
  // can only run where that config exists; skipping elsewhere is honest.
  const hasProjectConfig = existsSync(projectAgentsYaml);

  function poolAgents(yaml: string, role: "execute" | "evaluate"): string[] {
    const match = new RegExp(`${role}:[\\s\\S]*?from:\\s*\\[([^\\]]*)\\]`).exec(yaml);
    if (match === null) return [];
    return match[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  it.skipIf(!hasProjectConfig)("project agents.yaml includes cursor in the builder (execute) pool", () => {
    const yaml = readFileSync(projectAgentsYaml, "utf8");
    const builders = poolAgents(yaml, "execute");
    expect(builders).toContain("codex");
    expect(builders).toContain("claude");
    expect(builders).toContain("cursor");
  });

  it.skipIf(!hasProjectConfig)("project agents.yaml keeps cursor in the peer/score (evaluate) pool", () => {
    const yaml = readFileSync(projectAgentsYaml, "utf8");
    const reviewers = poolAgents(yaml, "evaluate");
    expect(reviewers).toContain("cursor");
  });
});

describe("FIX-1249 — reasonix model is config-driven, no source-baked fallback", () => {
  it("a configured (routed) model reaches the spawn's --model", () => {
    const { bin, args } = buildSpawnCommand("reasonix", {
      cwd: "/cycle/wt",
      skillBody: "DO WORK",
      model: "deepseek-v4-pro",
    });
    expect(bin).toBe("reasonix");
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("deepseek-v4-pro");
  });

  it("editing the model to any value passes it through verbatim (config is the truth)", () => {
    const { args } = buildSpawnCommand("reasonix", {
      cwd: "/cycle/wt",
      skillBody: "DO WORK",
      model: "deepseek-v5-max",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v5-max");
  });

  it("NO configured model → OMITS --model (native default), never the source-baked deepseek-flash", () => {
    for (const opts of [
      { cwd: "/cycle/wt", skillBody: "DO WORK" },
      { cwd: "/cycle/wt", skillBody: "DO WORK", model: "" },
      { cwd: "/cycle/wt", skillBody: "DO WORK", model: "   " },
    ]) {
      const { args } = buildSpawnCommand("reasonix", opts);
      // The old defect injected `--model deepseek-flash` here; now the source
      // holds no runtime model, so --model is simply omitted (like pi/kimi).
      expect(args, JSON.stringify(opts)).not.toContain("--model");
      expect(args).not.toContain("deepseek-flash");
      // The rest of the argv shape is intact.
      expect(args.slice(0, 3)).toEqual(["run", "--max-steps", "1000"]);
      expect(args).toContain("--dir");
    }
  });
});
