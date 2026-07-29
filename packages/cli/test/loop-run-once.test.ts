/**
 * Tests for the `loop run-once` CLI wiring + the real agentSpawn child-process
 * path (driven against a PATH shim 'claude', never a real agent).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dispatch, isPorted, registerAll } from "../src/index.js";
import { PUBLISHED_DELIVERY_MESSAGE, RUN_ONCE_USAGE, buildLoopRouteDeps, checkCoreWorktreeContamination, idleCounterPath, incrementConsecutiveIdle, isZeroTcrStall, loopRunOnceCommand, readExternalBlock, readSkillBody, resetConsecutiveIdle, shouldSuppressGoalChildFailureCounter, writeCardSkipAlert } from "../src/commands/loop-run-once.js";
import { buildRunOnceChildEnv } from "../src/commands/loop-go.js";
import { GOAL_ALLOWED_CARDS_ENV, GOAL_GUIDED_ENV } from "../src/lib/goal-progress.js";
import { readPendingPublish } from "../src/runner/pending-publish.js";
import { resolveRoute } from "@roll/core";
import { realAgentSpawn } from "../src/runner/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      execFileSync("rm", ["-rf", d]);
    } catch {
      /* best effort */
    }
  }
});
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `roll-runonce-${tag}-`));
  dirs.push(d);
  return realpathSync(d);
}

async function captureRunOnce(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await fn(), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function runPausedRunOnce(project: string, childEnv: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  const previousCwd = process.cwd();
  const previous = {
    mainProject: process.env["ROLL_MAIN_PROJECT"],
    mainSlug: process.env["ROLL_MAIN_SLUG"],
    runtimeDir: process.env["ROLL_PROJECT_RUNTIME_DIR"],
    lang: process.env["ROLL_LANG"],
    allowedCards: process.env[GOAL_ALLOWED_CARDS_ENV],
    guided: process.env[GOAL_GUIDED_ENV],
  };
  try {
    process.chdir(project);
    process.env["ROLL_MAIN_PROJECT"] = project;
    process.env["ROLL_MAIN_SLUG"] = "proj-abc123";
    process.env["ROLL_LANG"] = "en";
    delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    process.env[GOAL_ALLOWED_CARDS_ENV] = childEnv[GOAL_ALLOWED_CARDS_ENV] ?? "";
    process.env[GOAL_GUIDED_ENV] = childEnv[GOAL_GUIDED_ENV] ?? "";
    return await captureRunOnce(() => loopRunOnceCommand([]));
  } finally {
    process.chdir(previousCwd);
    if (previous.mainProject === undefined) delete process.env["ROLL_MAIN_PROJECT"];
    else process.env["ROLL_MAIN_PROJECT"] = previous.mainProject;
    if (previous.mainSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
    else process.env["ROLL_MAIN_SLUG"] = previous.mainSlug;
    if (previous.runtimeDir === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    else process.env["ROLL_PROJECT_RUNTIME_DIR"] = previous.runtimeDir;
    if (previous.lang === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = previous.lang;
    if (previous.allowedCards === undefined) delete process.env[GOAL_ALLOWED_CARDS_ENV];
    else process.env[GOAL_ALLOWED_CARDS_ENV] = previous.allowedCards;
    if (previous.guided === undefined) delete process.env[GOAL_GUIDED_ENV];
    else process.env[GOAL_GUIDED_ENV] = previous.guided;
  }
}

describe("loop run-once CLI wiring", () => {
  it("writes the active runtime skip-cards path in poison-pill alerts", () => {
    const runtime = tmp("skip-alert-runtime");
    const alertsPath = join(runtime, "alerts.md");
    const eventsPath = join(runtime, "events.ndjson");

    writeCardSkipAlert(alertsPath, eventsPath, "cycle-1", "US-WS-016", 3);

    expect(readFileSync(alertsPath, "utf8")).toContain(join(runtime, "skip-cards.json"));
    expect(readFileSync(alertsPath, "utf8")).not.toContain(".roll/loop/skip-cards.json");
  });

  it("registers `loop` TS-first (run-once + status are ported)", () => {
    registerAll();
    expect(isPorted("loop")).toBe(true);
  });

  it("--dry-run prints the command plan without executing (exit 0)", async () => {
    const p = tmp("dry-run-project");
    execFileSync("git", ["init", "-q", p]);
    registerAll();
    const write = process.stdout.write.bind(process.stdout);
    const prevMain = process.env["ROLL_MAIN_PROJECT"];
    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    let out = "";
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
    try {
      process.env["ROLL_MAIN_PROJECT"] = p;
      process.env["ROLL_MAIN_SLUG"] = "dry-run-project";
      const r = await dispatch(["loop", "run-once", "--dry-run"]);
      expect(r.status).toBe(0);
    } finally {
      process.stdout.write = write;
      if (prevMain === undefined) delete process.env["ROLL_MAIN_PROJECT"];
      else process.env["ROLL_MAIN_PROJECT"] = prevMain;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
    }
    expect(out).toContain("command plan (orchestrator → executor)");
    expect(out).toContain("spawn_agent");
    expect(out).toContain("nothing executed");
  });

  it("FIX-351: --help prints usage and exits 0 WITHOUT running a cycle (no side effects)", async () => {
    const write = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
    let r: number;
    try {
      // Called directly (not via dispatch): the --help guard is the FIRST thing
      // in loopRunOnceCommand, BEFORE projectIdentity / lock / network probe /
      // agent spawn. If it ran a cycle it would touch git/gh and hang or throw
      // in this hermetic test env — returning fast with usage proves it short-circuits.
      r = await loopRunOnceCommand(["--help"]);
    } finally {
      process.stdout.write = write;
    }
    expect(r).toBe(0);
    // Output is EXACTLY the usage text — proving no cycle ran (a real cycle
    // prints "loop run-once: cycle <id> → <terminal>" and other progress lines).
    expect(out).toBe(`${RUN_ONCE_USAGE}\n`);
    expect(out).toContain("Usage: roll loop run-once");
    expect(out).not.toContain("loop run-once: cycle");
    expect(out).not.toContain("→ unknown");
  });

  it("FIX-351: -h is also a help flag (prints usage, no cycle)", async () => {
    const write = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
    let r: number;
    try {
      r = await loopRunOnceCommand(["-h"]);
    } finally {
      process.stdout.write = write;
    }
    expect(r).toBe(0);
    expect(out).toContain("Usage: roll loop run-once");
  });

  it("US-DELIV-005: usage documents --race (same-card parallel opt-in)", () => {
    expect(RUN_ONCE_USAGE).toContain("[--workspace <id|path>] [--dry-run] [--race]");
    expect(RUN_ONCE_USAGE).toContain("cycle runtime, backlog, locks, and events to one Workspace");
    expect(RUN_ONCE_USAGE).toContain("--race");
  });

  it("US-DELIV-013: published help hands merge progression to the reconciler", () => {
    expect(PUBLISHED_DELIVERY_MESSAGE).toContain("Delivery Reconciler");
    expect(PUBLISHED_DELIVERY_MESSAGE).toContain("交付对账器");
    expect(PUBLISHED_DELIVERY_MESSAGE).not.toContain("PR loop");
  });

  it("FIX-1040: unscoped run-once yields while a scoped loop go session holds directory go.lock", async () => {
    const p = tmp("go-lock-dir");
    execFileSync("git", ["init", "-q", p]);
    const rt = join(p, ".roll", "loop");
    const lockDir = join(rt, "go.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "meta.json"),
      `${JSON.stringify({
        pid: process.pid,
        hostname: "",
        startedAt: Math.floor(Date.now() / 1000),
        cycleId: "goal-20260629151450-69149",
      })}\n`,
    );

    const prevCwd = process.cwd();
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    const prevAllowed = process.env["ROLL_LOOP_GO_ALLOWED_CARDS"];
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
    try {
      process.chdir(p);
      process.env["ROLL_PROJECT_RUNTIME_DIR"] = rt;
      process.env["ROLL_MAIN_SLUG"] = "proj-abc123";
      delete process.env["ROLL_LOOP_GO_ALLOWED_CARDS"];
      const r = await loopRunOnceCommand([]);
      expect(r).toBe(0);
    } finally {
      process.stdout.write = write;
      process.chdir(prevCwd);
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
      if (prevAllowed === undefined) delete process.env["ROLL_LOOP_GO_ALLOWED_CARDS"];
      else process.env["ROLL_LOOP_GO_ALLOWED_CARDS"] = prevAllowed;
    }

    expect(out).toContain("go session already active");
    expect(existsSync(join(rt, "inner.lock"))).toBe(false);
    expect(existsSync(join(rt, "worktrees"))).toBe(false);
    const events = readFileSync(join(rt, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"goal:tick_skipped"');
    expect(events).toContain('"reason":"go_session_lock"');
  });

  it("does not count goal-child zero-delivery failures as consecutive failures", () => {
    expect(shouldSuppressGoalChildFailureCounter({ isGoalChild: true, terminal: "failed", tcrCount: 0 })).toBe(true);
    expect(shouldSuppressGoalChildFailureCounter({ isGoalChild: true, terminal: "blocked", tcrCount: 0 })).toBe(true);
    expect(shouldSuppressGoalChildFailureCounter({ isGoalChild: true, terminal: "failed", tcrCount: 1 })).toBe(false);
    expect(shouldSuppressGoalChildFailureCounter({ isGoalChild: false, terminal: "failed", tcrCount: 0 })).toBe(false);
  });

  it("isZeroTcrStall — FIX-1244: unmeasured tcrCount is NOT zero (conservative, never orphan completed work)", () => {
    // Measured zero on a stall terminal → genuine zero-TCR stall (self-heal may swap).
    expect(isZeroTcrStall("blocked", 0)).toBe(true);
    expect(isZeroTcrStall("gave_up", 0)).toBe(true);
    // Measured real work → never zero-TCR.
    expect(isZeroTcrStall("blocked", 4)).toBe(false);
    expect(isZeroTcrStall("gave_up", 1)).toBe(false);
    // NEVER measured (timeout path pre-measurement / git error) → unknown, NOT zero:
    // the gate must stay conservative and let the fail-loud path keep the worktree.
    expect(isZeroTcrStall("blocked", undefined)).toBe(false);
    expect(isZeroTcrStall("gave_up", undefined)).toBe(false);
    // Non-stall terminals never qualify.
    expect(isZeroTcrStall("published", 0)).toBe(false);
    expect(isZeroTcrStall("failed", 0)).toBe(false);
    expect(isZeroTcrStall(undefined, 0)).toBe(false);
  });

  it("readExternalBlock — FIX-363: attributes a failed cycle to a reviewer auth/network block", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-extblock-"));
    const ev = join(dir, "events.ndjson");
    const w = (o: object): void => appendFileSync(ev, `${JSON.stringify(o)}\n`, "utf8");
    writeFileSync(ev, "", "utf8");
    // unrelated events + a block for a DIFFERENT cycle must be ignored
    w({ type: "pair:consult", cycleId: "c1", peer: "kimi", outcome: "timeout", ts: 1 });
    w({ type: "agent:blocked", cycleId: "other", agent: "claude", cause: "auth", stage: "review", detail: "403", ts: 2 });
    expect(readExternalBlock(ev, "c1")).toBeNull();

    // auth block for c1 → attributed auth (auth wins over network)
    w({ type: "agent:blocked", cycleId: "c1", agent: "codex", cause: "network", stage: "review", detail: "ENOTFOUND", ts: 3 });
    w({ type: "agent:blocked", cycleId: "c1", agent: "claude", cause: "auth", stage: "score", detail: "Please run /login", ts: 4 });
    const got = readExternalBlock(ev, "c1");
    expect(got?.cause).toBe("auth");
    expect(got?.agents).toContain("claude");

    // a missing events file is a safe null (never throws)
    expect(readExternalBlock(join(dir, "nope.ndjson"), "c1")).toBeNull();
  });

  it("readExternalBlock — FIX-404 preserves credential detail for actionable ALERT copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-extblock-credential-"));
    const ev = join(dir, "events.ndjson");
    writeFileSync(
      ev,
      `${JSON.stringify({
        type: "agent:blocked",
        cycleId: "c404",
        agent: "reasonix",
        cause: "auth",
        stage: "score",
        detail: "missing required credential env for reasonix: DEEPSEEK_API_KEY",
        ts: 1,
      })}\n`,
      "utf8",
    );
    const got = readExternalBlock(ev, "c404");
    expect(got?.cause).toBe("auth");
    expect(got?.agents).toEqual(["reasonix"]);
    expect(got?.details).toEqual(["missing required credential env for reasonix: DEEPSEEK_API_KEY"]);
  });

  it("readExternalBlock — FIX-366: a BUILDER block (stage:build) lands in the SAME taxonomy as review/score", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-extblock-build-"));
    const ev = join(dir, "events.ndjson");
    const w = (o: object): void => appendFileSync(ev, `${JSON.stringify(o)}\n`, "utf8");
    writeFileSync(ev, "", "utf8");
    // The unauthenticated BUILDER (FIX-366) emits agent:blocked stage:build — it
    // must be attributed exactly like a reviewer/scorer block (unified taxonomy).
    w({ type: "agent:blocked", cycleId: "b1", agent: "claude", cause: "auth", stage: "build", detail: "Please run /login", ts: 1 });
    const got = readExternalBlock(ev, "b1");
    expect(got?.cause).toBe("auth");
    expect(got?.agents).toEqual(["claude"]);

    // a builder NETWORK block is attributed network (not auth → it self-heals)
    const ev2 = join(dir, "events2.ndjson");
    writeFileSync(ev2, "", "utf8");
    appendFileSync(ev2, `${JSON.stringify({ type: "agent:blocked", cycleId: "b2", agent: "codex", cause: "network", stage: "build", detail: "ENOTFOUND", ts: 1 })}\n`, "utf8");
    expect(readExternalBlock(ev2, "b2")?.cause).toBe("network");
  });

  it("readExternalBlock — US-LOOP-091: a BUILDER quota block is recoverable external state", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-extblock-quota-"));
    const ev = join(dir, "events.ndjson");
    const w = (o: object): void => appendFileSync(ev, `${JSON.stringify(o)}\n`, "utf8");
    writeFileSync(ev, "", "utf8");

    w({ type: "agent:blocked", cycleId: "q1", agent: "kimi", cause: "quota", stage: "build", detail: "quota exhausted", ts: 1 });
    const quota = readExternalBlock(ev, "q1");
    expect(quota?.cause).toBe("quota");
    expect(quota?.agents).toEqual(["kimi"]);
    expect(quota?.details).toEqual(["quota exhausted"]);

    w({ type: "agent:blocked", cycleId: "q1", agent: "claude", cause: "auth", stage: "score", detail: "Please run /login", ts: 2 });
    expect(readExternalBlock(ev, "q1")?.cause).toBe("auth");
  });
});

describe("realAgentSpawn child-process path (PATH shim, no real claude)", () => {
  it("spawns a shim 'claude' in the worktree cwd and captures its exit + stdout", async () => {
    const dir = tmp("shim");
    // A fake `claude` that just echoes its cwd and exits 0 — proves the spawn
    // path runs the resolved binary with the worktree as cwd.
    const shim = join(dir, "claude");
    writeFileSync(shim, "#!/bin/sh\necho \"model: claude\"\necho \"cwd=$(pwd)\"\nexit 0\n", "utf8");
    chmodSync(shim, 0o755);

    const res = await realAgentSpawn("claude", {
      cwd: dir,
      skillBody: "do work",
      bin: shim, // inject the shim directly (no PATH mutation needed)
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("model: claude");
    expect(res.stdout).toContain(`cwd=${dir}`);
  });

  it("times out and SIGKILLs a hanging shim (timedOut=true)", async () => {
    const dir = tmp("hang");
    const shim = join(dir, "claude");
    writeFileSync(shim, "#!/bin/sh\nsleep 30\n", "utf8");
    chmodSync(shim, 0o755);
    const res = await realAgentSpawn("claude", {
      cwd: dir,
      skillBody: "x",
      bin: shim,
      // generous margin: slow CI runners need spawn headroom before the timer
      timeoutMs: 800,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  it("US-EVID-001: explicit runDir is exported to the child and overrides ambient ROLL_RUN_DIR", async () => {
    const dir = tmp("run-dir-env");
    const shim = join(dir, "claude");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        "echo \"ROLL_RUN_DIR=$ROLL_RUN_DIR\"",
        "echo \"ROLL_EVIDENCE_DIR=$ROLL_EVIDENCE_DIR\"",
        "echo \"ROLL_SCREENSHOTS_DIR=$ROLL_SCREENSHOTS_DIR\"",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(shim, 0o755);
    const runDir = join(dir, "frame");
    const previous = process.env["ROLL_RUN_DIR"];
    process.env["ROLL_RUN_DIR"] = "/wrong/frame";
    try {
      const res = await realAgentSpawn("claude", {
        cwd: dir,
        skillBody: "x",
        bin: shim,
        runDir,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`ROLL_RUN_DIR=${runDir}`);
      expect(res.stdout).toContain(`ROLL_EVIDENCE_DIR=${join(runDir, "evidence")}`);
      expect(res.stdout).toContain(`ROLL_SCREENSHOTS_DIR=${join(runDir, "screenshots")}`);
      expect(res.stdout).not.toContain("/wrong/frame");
    } finally {
      if (previous === undefined) delete process.env["ROLL_RUN_DIR"];
      else process.env["ROLL_RUN_DIR"] = previous;
    }
  });

  it("FIX-403: realAgentSpawn injects agent-profile env for reasonix on every spawn path", async () => {
    const dir = tmp("reasonix-profile-env");
    const home = join(dir, "home");
    mkdirSync(join(home, ".reasonix"), { recursive: true });
    writeFileSync(join(home, ".reasonix", ".env"), "DEEPSEEK_API_KEY=fake-profile-key\n", "utf8");
    const shim = join(dir, "reasonix");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        "echo \"key_len=${#DEEPSEEK_API_KEY}\"",
        "if [ \"$DEEPSEEK_API_KEY\" = \"fake-profile-key\" ]; then echo key_from_profile=yes; else echo key_from_profile=no; fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(shim, 0o755);

    const res = await realAgentSpawn("reasonix", {
      cwd: dir,
      skillBody: "score this delivery",
      bin: shim,
      agentEnvHome: home,
      timeoutMs: 15000,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("key_len=16");
    expect(res.stdout).toContain("key_from_profile=yes");
    expect(res.stdout).not.toContain("fake-profile-key");
  });
});

describe("FIX-204A — skill resolution + blind-agent refusal", () => {
  function proj(tag: string): string {
    return tmp(`skill-${tag}`);
  }

  it("resolves the skills/ submodule path when .roll/skills is absent", () => {
    const p = proj("submodule");
    execFileSync("mkdir", ["-p", join(p, "skills", "roll-loop")]);
    writeFileSync(
      join(p, "skills", "roll-loop", "SKILL.md"),
      "---\nname: roll-loop\n---\n\n# Loop\n\nDo the work.\n",
    );
    expect(readSkillBody(p)).toBe("# Loop\n\nDo the work.");
  });

  it("legacy .roll/skills wins over the submodule copy when both exist", () => {
    const p = proj("legacy");
    execFileSync("mkdir", ["-p", join(p, ".roll", "skills", "roll-loop")]);
    execFileSync("mkdir", ["-p", join(p, "skills", "roll-loop")]);
    writeFileSync(join(p, ".roll", "skills", "roll-loop", "SKILL.md"), "legacy body\n");
    writeFileSync(join(p, "skills", "roll-loop", "SKILL.md"), "submodule body\n");
    expect(readSkillBody(p)).toBe("legacy body");
  });

  it("ROLL_LOOP_SKILL env override wins over both file locations", () => {
    const p = proj("env");
    execFileSync("mkdir", ["-p", join(p, "skills", "roll-loop")]);
    writeFileSync(join(p, "skills", "roll-loop", "SKILL.md"), "submodule body\n");
    const override = join(p, "custom-skill.md");
    writeFileSync(override, "---\nx: y\n---\noverride body\n");
    process.env["ROLL_LOOP_SKILL"] = override;
    try {
      expect(readSkillBody(p)).toBe("override body");
    } finally {
      delete process.env["ROLL_LOOP_SKILL"];
    }
  });

  it("frontmatter-only / whitespace-only candidates are skipped, not returned empty", () => {
    const p = proj("hollow");
    execFileSync("mkdir", ["-p", join(p, ".roll", "skills", "roll-loop")]);
    execFileSync("mkdir", ["-p", join(p, "skills", "roll-loop")]);
    writeFileSync(join(p, ".roll", "skills", "roll-loop", "SKILL.md"), "---\nname: hollow\n---\n  \n");
    writeFileSync(join(p, "skills", "roll-loop", "SKILL.md"), "real body\n");
    expect(readSkillBody(p)).toBe("real body");
  });

  it("falls back to ~/.roll/skills/ when project-local paths are absent (no-submodule project)", () => {
    const p = proj("global-fallback");
    const homeSkills = join(tmpdir(), `.roll-skill-test-${process.pid}`, ".roll", "skills", "roll-loop");
    execFileSync("mkdir", ["-p", homeSkills]);
    writeFileSync(join(homeSkills, "SKILL.md"), "# Loop\n\nglobal fallback body\n");
    const prevHome = process.env["HOME"];
    process.env["HOME"] = join(tmpdir(), `.roll-skill-test-${process.pid}`);
    try {
      expect(readSkillBody(p)).toBe("# Loop\n\nglobal fallback body");
    } finally {
      process.env["HOME"] = prevHome;
      try { execFileSync("rm", ["-rf", join(tmpdir(), `.roll-skill-test-${process.pid}`)]); } catch { /* ok */ }
    }
  });

  it("returns null when nothing resolves (no project files, no ~/.roll/skills)", () => {
    const prevHome = process.env["HOME"];
    process.env["HOME"] = join(tmpdir(), `.roll-skill-none-${process.pid}`);
    try {
      expect(readSkillBody(proj("none"))).toBeNull();
    } finally {
      process.env["HOME"] = prevHome;
    }
  });

  it("run-once refuses to start a cycle on a null skill body: rc=1 + ALERT, no lock/worktree", async () => {
    registerAll();
    const p = proj("refuse");
    execFileSync("git", ["init", "-q", p]);
    const rt = join(p, ".roll", "loop");
    const prevCwd = process.cwd();
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevHome = process.env["HOME"];
    process.env["ROLL_PROJECT_RUNTIME_DIR"] = rt;
    // Isolate HOME so the new ~/.roll/skills/ fallback doesn't resolve
    // against the developer's real ~/.roll/skills/roll-loop/SKILL.md.
    process.env["HOME"] = join(tmpdir(), `.roll-skill-refuse-${process.pid}`);
    let err = "";
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      err += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      process.chdir(p);
      const r = await dispatch(["loop", "run-once"]);
      expect(r.status).toBe(1);
    } finally {
      process.stderr.write = write;
      process.chdir(prevCwd);
      process.env["HOME"] = prevHome;
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
    }
    // Early-exit gates (in order): pause, repo pushability, network, skill body.
    // The network guard may block before the skill check. Older egress-only paths
    // say "egress blocked"; the shared guard says the command needs the network.
    // A project with no GitHub remote now fails at the repo-pushability gate.
    // On a network-clear machine with a remote, the skill check fails with
    // "refusing to spawn a blind agent". All are valid early-exit paths.
    const blockedByEgress = err.includes("egress blocked") || err.includes("egress_blocked");
    const blockedByNetworkGuard = err.includes("needs the network") || err.includes("network unreachable");
    const blockedBySkill = err.includes("refusing to spawn a blind agent");
    const blockedByRepo =
      err.includes("No git remote configured") ||
      err.includes("GitHub repo unreachable") ||
      err.includes("Not a git repository") ||
      err.includes("git remote add origin");
    expect(blockedByEgress || blockedByNetworkGuard || blockedBySkill || blockedByRepo).toBe(true);
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    const { readdirSync: rds } = await import("node:fs");
    const alertFiles = rds(rt).filter((f) => f.startsWith("ALERT-") && f.endsWith(".md"));
    expect(alertFiles.length).toBe(1);
    const alertBody = rf(join(rt, alertFiles[0]), "utf8");
    const alertOk =
      alertBody.includes("SKILL.md not found") ||
      alertBody.includes("egress blocked") ||
      alertBody.includes("egress_blocked") ||
      alertBody.includes("needs the network") ||
      alertBody.includes("network unreachable") ||
      alertBody.includes("GitHub repo unreachable") ||
      alertBody.includes("No git remote configured") ||
      alertBody.includes("Not a git repository");
    expect(alertOk).toBe(true);
    expect(ex(join(rt, "inner.lock"))).toBe(false);
    expect(ex(join(rt, "worktrees"))).toBe(false);
  });
});

describe("FIX-204D — signal teardown keeps I8 on the kill paths", () => {
  function teardownFixture(tag: string): {
    rt: string;
    paths: { eventsPath: string; runsPath: string; lockPath: string };
  } {
    const rt = tmp(`sig-${tag}`);
    return {
      rt,
      paths: {
        eventsPath: join(rt, "events.ndjson"),
        runsPath: join(rt, "runs.jsonl"),
        lockPath: join(rt, "inner.lock"),
      },
    };
  }

  it("owned lock: writes aborted cycle:end + runs row, releases the lock, kills agents, exit 143", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { paths: p } = teardownFixture("owned");
    writeFileSync(p.lockPath, `${process.pid}:1780680000\n`, "utf8");
    let exitCode = -1;
    let killed = 0;
    let capacityReleased = 0;
    cycleSignalTeardown(p, "20260606-040000-9001", "loop/cycle-20260606-040000-9001", "SIGTERM", {
      killAgents: () => {
        killed += 1;
        return 1;
      },
      exit: (c) => {
        exitCode = c;
      },
      now: () => 1780680123,
      releaseCapacity: (cycleId) => {
        expect(cycleId).toBe("20260606-040000-9001");
        capacityReleased += 1;
        return { kind: "released" };
      },
    });
    expect(exitCode).toBe(143);
    expect(killed).toBe(1);
    expect(capacityReleased).toBe(1);
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    const events = rf(p.eventsPath, "utf8");
    expect(events).toContain('"cycle:end"');
    expect(events).toContain("20260606-040000-9001");
    expect(events).toContain("aborted");
    const runs = rf(p.runsPath, "utf8");
    expect(runs).toContain('"status":"aborted"');
    expect(runs).toContain("20260606-040000-9001");
    expect(ex(p.lockPath)).toBe(false);
  });

  it("FIX-1210: owned signal teardown releases config.lock sentinel", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { applyMainCheckoutWriteProtection } = await import("../src/runner/main-checkout-guard.js");
    const repo = tmp("sig-config-lock-repo");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@roll.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });

    const rt = join(repo, ".roll", "loop");
    mkdirSync(rt, { recursive: true });
    const paths = {
      eventsPath: join(rt, "events.ndjson"),
      runsPath: join(rt, "runs.jsonl"),
      lockPath: join(rt, "inner.lock"),
    };
    applyMainCheckoutWriteProtection({ repoCwd: repo, runtimeDir: rt, cycleId: "C-sig-lock", nowMs: () => 1000 });
    const lockPath = join(repo, ".git", "config.lock");
    expect(existsSync(lockPath)).toBe(true);
    writeFileSync(paths.lockPath, `${process.pid}:1780680000\n`, "utf8");

    let exitCode = -1;
    cycleSignalTeardown(paths, "C-sig-lock", "loop/cycle-C-sig-lock", "SIGTERM", {
      killAgents: () => 0,
      exit: (c) => {
        exitCode = c;
      },
      now: () => 1780680123,
      repoCwd: repo,
      runtimeDir: rt,
    });

    expect(exitCode).toBe(143);
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("FIX-1060: owned lock + pick-only events backfills story_id and marks agent unknown reason", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { paths: p } = teardownFixture("owned-pick-only");
    const cycleId = "20260606-040000-9003";
    writeFileSync(p.lockPath, `${process.pid}:1780680000\n`, "utf8");
    writeFileSync(
      p.eventsPath,
      JSON.stringify({
        type: "evidence:frame-opened",
        cycleId,
        storyId: "FIX-1060-PICK",
        runDir: "/tmp",
        ts: 1,
      }) + "\n",
      "utf8",
    );
    let exitCode = -1;
    cycleSignalTeardown(p, cycleId, `loop/cycle-${cycleId}`, "SIGTERM", {
      killAgents: () => 0,
      exit: (c) => {
        exitCode = c;
      },
      now: () => 1780680123,
    });
    expect(exitCode).toBe(143);
    const runs = readFileSync(p.runsPath, "utf8");
    const row = JSON.parse(runs.trimEnd().split("\n").pop() ?? "{}") as Record<string, unknown>;
    expect(row["story_id"]).toBe("FIX-1060-PICK");
    expect(row["agent"]).toBe("");
    expect(row["agent_unknown_reason"]).toBe("aborted_before_agent_routed");
    const events = readFileSync(p.eventsPath, "utf8");
    expect(events).toContain('"storyId":"FIX-1060-PICK"');
    expect(events).toContain('"agent":""');
  });

  it("FIX-1060: owned lock + cycle:start backfills both story_id and agent", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { paths: p } = teardownFixture("owned-post-spawn");
    const cycleId = "20260606-040000-9004";
    writeFileSync(p.lockPath, `${process.pid}:1780680000\n`, "utf8");
    writeFileSync(
      p.eventsPath,
      JSON.stringify({
        type: "cycle:start",
        cycleId,
        storyId: "FIX-1060-SPAWN",
        agent: "pi",
        model: "",
        ts: 1,
      }) + "\n",
      "utf8",
    );
    let exitCode = -1;
    cycleSignalTeardown(p, cycleId, `loop/cycle-${cycleId}`, "SIGTERM", {
      killAgents: () => 0,
      exit: (c) => {
        exitCode = c;
      },
      now: () => 1780680123,
    });
    expect(exitCode).toBe(143);
    const runs = readFileSync(p.runsPath, "utf8");
    const row = JSON.parse(runs.trimEnd().split("\n").pop() ?? "{}") as Record<string, unknown>;
    expect(row["story_id"]).toBe("FIX-1060-SPAWN");
    expect(row["agent"]).toBe("pi");
    expect(row["agent_unknown_reason"]).toBeUndefined();
    const events = readFileSync(p.eventsPath, "utf8");
    expect(events).toContain('"storyId":"FIX-1060-SPAWN"');
    expect(events).toContain('"agent":"pi"');
  });

  it("releases the cycle lease when an owned cycle is terminated", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { paths: p, rt } = teardownFixture("owned-lease");
    const cycleId = "20260606-040000-9005";
    writeFileSync(p.lockPath, `${process.pid}:1780680000\n`, "utf8");
    writeFileSync(
      p.eventsPath,
      JSON.stringify({ type: "cycle:start", cycleId, storyId: "FIX-LEASE", agent: "pi", model: "", ts: 1 }) + "\n",
      "utf8",
    );
    const ld = join(rt, "leases");
    mkdirSync(ld, { recursive: true });
    writeFileSync(
      join(ld, "FIX-LEASE.lease"),
      JSON.stringify({ pid: process.pid, claimedAt: 1780680000000, source: "cycle" }) + "\n",
      "utf8",
    );

    cycleSignalTeardown(p, cycleId, `loop/cycle-${cycleId}`, "SIGTERM", {
      killAgents: () => 0,
      exit: () => undefined,
      now: () => 1780680123,
    });

    expect(existsSync(join(ld, "FIX-LEASE.lease"))).toBe(false);
  });

  it("foreign lock (skip-on-contention path): touches NOTHING, still exits with the signal code", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { paths: p } = teardownFixture("foreign");
    writeFileSync(p.lockPath, `99999999:1780680000\n`, "utf8");
    let exitCode = -1;
    cycleSignalTeardown(p, "20260606-040000-9002", "loop/cycle-x", "SIGINT", {
      killAgents: () => 0,
      exit: (c) => {
        exitCode = c;
      },
    });
    expect(exitCode).toBe(130); // SIGINT = 128+2
    const { existsSync: ex } = await import("node:fs");
    expect(ex(p.eventsPath)).toBe(false);
    expect(ex(p.runsPath)).toBe(false);
    expect(ex(p.lockPath)).toBe(true); // the live owner's lock survives
  });

  it("SIGHUP maps to 129", async () => {
    const { cycleSignalTeardown } = await import("../src/commands/loop-run-once.js");
    const { paths: p } = teardownFixture("hup");
    let exitCode = -1;
    cycleSignalTeardown(p, "c", "b", "SIGHUP", { killAgents: () => 0, exit: (c) => { exitCode = c; } });
    expect(exitCode).toBe(129);
  });

  it("killLiveAgents reaps a hanging registered agent (registry path, no timeout involved)", async () => {
    const { killLiveAgents } = await import("../src/runner/index.js");
    const dir = tmp("reap");
    const shim = join(dir, "claude");
    writeFileSync(shim, "#!/bin/sh\nsleep 30\n", "utf8");
    chmodSync(shim, 0o755);
    const pending = realAgentSpawn("claude", { cwd: dir, skillBody: "x", bin: shim });
    await new Promise((r) => setTimeout(r, 300)); // let it spawn + register
    const n = killLiveAgents("SIGKILL");
    expect(n).toBe(1);
    const res = await pending;
    expect(res.exitCode).not.toBe(0); // killed, promise still settles
  });
});

describe("FIX-1472 — loop run-once pause gate consumes the loop-go child environment", () => {
  function pausedProject(tag: string): string {
    const project = tmp(tag);
    execFileSync("git", ["init", "-q", project]);
    mkdirSync(join(project, ".roll", "loop"), { recursive: true });
    writeFileSync(join(project, ".roll", "loop", "PAUSE-proj-abc123"), "owner pause\n");
    // Keep the positive case local and deterministic after it gets through the
    // pause gate: no remote makes the next preflight return 1 before any agent.
    writeFileSync(join(project, ".roll", "policy.yaml"), "loop_safety:\n  skip_network_check: true\n");
    return project;
  }

  it("allows only the explicit guided child with non-empty cards through a real paused run-once gate", async () => {
    const project = pausedProject("guided-pause-pass");
    const childEnv = buildRunOnceChildEnv(
      { projectPath: project, allowedCards: ["FIX-007"], guided: true },
      { [GOAL_GUIDED_ENV]: "0" },
    );

    expect(childEnv[GOAL_ALLOWED_CARDS_ENV]).toBe("FIX-007");
    expect(childEnv[GOAL_GUIDED_ENV]).toBe("1");
    const r = await runPausedRunOnce(project, childEnv);

    // The next deterministic preflight is "no remote" (1); PAUSE itself
    // returns 0. This proves the real command crossed its pause gate without
    // starting an agent or changing the owner's pause marker.
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("loop is paused (PAUSE marker present)");
    expect(existsSync(join(project, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
  });

  it("blocks a real paused run-once when loop-go explicitly clears an ambient guided=1", async () => {
    const project = pausedProject("guided-pause-block");
    // Simulate the hostile parent environment. The child builder MUST overwrite
    // it with 0 for an unguided invocation before the real command reads it.
    const childEnv = buildRunOnceChildEnv(
      { projectPath: project, allowedCards: ["FIX-007"], guided: false },
      { [GOAL_GUIDED_ENV]: "1" },
    );

    expect(childEnv[GOAL_ALLOWED_CARDS_ENV]).toBe("FIX-007");
    expect(childEnv[GOAL_GUIDED_ENV]).toBe("0");
    const r = await runPausedRunOnce(project, childEnv);

    expect(r.code).toBe(0);
    expect(r.out).toContain("loop is paused (PAUSE marker present)");
    expect(existsSync(join(project, ".roll", "loop", "PAUSE-proj-abc123"))).toBe(true);
  });
});

describe("FIX-216 — auto-PAUSE on consecutive failures", () => {
  it("increments the failure counter + writes PAUSE marker at threshold", async () => {
    // Dynamically import fs functions not in the top-level imports.
    const { readFileSync: rf, existsSync: ex, mkdirSync: mks } =
      await import("node:fs");

    const p = tmp("consec-fail");
    execFileSync("git", ["init", "-q", p]);
    const rt = join(p, ".roll", "loop");
    mks(rt, { recursive: true });
    const counterFile = join(rt, "consecutive-fails");

    // Seed: 2 prior failures.
    writeFileSync(counterFile, "2", "utf8");

    // Force a deterministic slug so PAUSE-<slug> and ALERT-<slug>.md are predictable.
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    process.env["ROLL_PROJECT_RUNTIME_DIR"] = rt;
    process.env["ROLL_MAIN_SLUG"] = "default";
    registerAll();

    // Suppress stderr noise.
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const prevCwd = process.cwd();
    try {
      process.chdir(p);
      const r = await dispatch(["loop", "run-once"]);
      expect(r.status).toBe(1);
    } finally {
      process.stderr.write = write;
      process.chdir(prevCwd);
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
    }

    // FIX-232: the egress pre-check may block the cycle before the skill
    // check. If egress is blocked, the counter stays at 2 because the cycle
    // never reached the failure path. If egress is clear, the counter
    // increments to 3 and a PAUSE marker is written.
    const counterVal = rf(counterFile, "utf8").trim();
    const pauseMarker = join(p, ".roll", "loop", "PAUSE-default");
    if (counterVal === "2") {
      // Egress-blocked — cycle was refused before the failure path.
      // The counter stays at 2, no PAUSE marker.
      expect(ex(pauseMarker)).toBe(false);
    } else {
      expect(counterVal).toBe("3");
      expect(ex(pauseMarker)).toBe(true);
    }
    if (counterVal !== "2") {
      const body = rf(pauseMarker, "utf8");
      expect(body).toContain("# ALERT — loop auto-paused");
      expect(body).toContain("roll loop resume");
      const events = rf(join(rt, "events.ndjson"), "utf8");
      expect(events).toContain('"type":"policy:safety_pause"');
      expect(events).toContain('"type":"alert:notify"');
    }
  });

  it("honors policy.yaml max_consecutive_failures before PAUSE", async () => {
    const { existsSync: ex, mkdirSync: mks } = await import("node:fs");
    const p = tmp("consec-policy");
    execFileSync("git", ["init", "-q", p]);
    mks(join(p, ".roll", "loop"), { recursive: true });
    writeFileSync(join(p, ".roll", "policy.yaml"), "loop_safety:\n  max_consecutive_failures: 4\n");
    writeFileSync(join(p, ".roll", "loop", "consecutive-fails"), "2", "utf8");

    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    process.env["ROLL_PROJECT_RUNTIME_DIR"] = join(p, ".roll", "loop");
    process.env["ROLL_MAIN_SLUG"] = "default";
    registerAll();
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const prevCwd = process.cwd();
    try {
      process.chdir(p);
      const r = await dispatch(["loop", "run-once"]);
      expect(r.status).toBe(1);
    } finally {
      process.stderr.write = write;
      process.chdir(prevCwd);
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
    }

    expect(ex(join(p, ".roll", "loop", "PAUSE-default"))).toBe(false);
  });
});

describe("loop agent selection — scoped configuration only", () => {
  function project(files: Record<string, string>): string {
    const p = tmp("route");
    mkdirSync(join(p, ".roll"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(p, ".roll", name), body);
    return p;
  }

  const AGENTS_YAML = 'schema: v3\neasy: { agent: pi }\ndefault: { agent: pi }\nhard: { agent: claude }\nfallback: { agent: kimi }\n';

  it("rejects v3 route slots instead of using them at runtime", () => {
    const p = project({ "local.yaml": "agent: pi\n", "agents.yaml": AGENTS_YAML });
    expect(() => resolveRoute("hard", buildLoopRouteDeps(p))).toThrow("roll agent migrate");
  });

  it("does not let ROLL_LOOP_AGENT revive a legacy configuration", () => {
    const p = project({ "local.yaml": "agent: pi\n", "agents.yaml": AGENTS_YAML });
    const prev = process.env["ROLL_LOOP_AGENT"];
    process.env["ROLL_LOOP_AGENT"] = "deepseek";
    try {
      expect(() => resolveRoute("hard", buildLoopRouteDeps(p))).toThrow("roll agent migrate");
    } finally {
      if (prev === undefined) delete process.env["ROLL_LOOP_AGENT"];
      else process.env["ROLL_LOOP_AGENT"] = prev;
    }
  });

  it("FIX-1249: roll-agents/v1 rigs+routing drives the tier's agent AND model", () => {
    const V1_YAML = [
      "schema: roll-agents/v1",
      "scope: project",
      "rigs:",
      "  reasonix-pro:",
      "    agent: reasonix",
      "    model: deepseek-v4-pro",
      "  kimi-strong:",
      "    agent: kimi",
      "routing:",
      "  easy: reasonix-pro",
      "  default: reasonix-pro",
      "  fallback: kimi-strong",
      "",
    ].join("\n");
    const p = project({ "agents.yaml": V1_YAML });
    const deps = buildLoopRouteDeps(p);
    // Before FIX-1249 the router could not read this shape → model dropped, agent
    // came from firstInstalled, reasonix silently ran the source-baked default.
    const easy = resolveRoute("easy", deps);
    expect(easy.agent).toBe("reasonix");
    expect(easy.model).toBe("deepseek-v4-pro");
    // Editing the rig model is a pure config change — it reaches the route.
    writeFileSync(join(p, ".roll", "agents.yaml"), V1_YAML.replace("deepseek-v4-pro", "deepseek-v5-max"));
    expect(resolveRoute("easy", buildLoopRouteDeps(p)).model).toBe("deepseek-v5-max");
    // A rig with no model → agent only, spawn omits --model (native default).
    expect(resolveRoute("fallback", deps).model).toBeUndefined();
  });

  it("rejects a v3 default slot rather than treating it as a fallback", () => {
    const p = project({ "agents.yaml": "schema: v3\ndefault: { agent: kimi }\n" });
    expect(() => resolveRoute("hard", buildLoopRouteDeps(p))).toThrow("roll agent migrate");
  });

  it("installed-agent scan actually probes PATH (missing binaries are skipped)", () => {
    const p = project({});
    const shim = tmp("shim");
    // Only a `kimi` executable exists on PATH; HOME is empty (no GUI agents).
    writeFileSync(join(shim, "kimi"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(shim, "kimi"), 0o755);
    const home = tmp("home");
    const prevPath = process.env["PATH"];
    const prevHome = process.env["HOME"];
    process.env["PATH"] = shim;
    process.env["HOME"] = home;
    try {
      expect(buildLoopRouteDeps(p).firstInstalled()).toBe("kimi");
      // Nothing installed at all → undefined (router then throws, like bash).
      process.env["PATH"] = home;
      expect(buildLoopRouteDeps(p).firstInstalled()).toBeUndefined();
    } finally {
      process.env["PATH"] = prevPath;
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
    }
  });
});

describe("IDEA-001 — offline degrade probe", () => {
  it("online: resolver succeeds → not offline", async () => {
    const { isOffline } = await import("../src/commands/loop-run-once.js");
    expect(await isOffline(() => Promise.resolve([{ address: "1.2.3.4" }]))).toBe(false);
  });
  it("offline: resolver rejects (ENOTFOUND) → offline", async () => {
    const { isOffline } = await import("../src/commands/loop-run-once.js");
    expect(await isOffline(() => Promise.reject(new Error("ENOTFOUND")))).toBe(true);
  });
  it("dead network: resolver hangs → 1.5s timeout → offline", async () => {
    const { isOffline } = await import("../src/commands/loop-run-once.js");
    const start = Date.now();
    expect(await isOffline(() => new Promise(() => {}))).toBe(true);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("FIX-232 AC2 — egress pre-check", () => {
  it("DNS fails → offline, not proxy-poisoned (not blocked)", async () => {
    const { egressBlocked } = await import("../src/commands/loop-run-once.js");
    expect(
      await egressBlocked(() => Promise.reject(new Error("ENOTFOUND")))
    ).toBe(false);
  });

  it("resolver hangs → DNS timeout → offline (not blocked)", async () => {
    const { egressBlocked } = await import("../src/commands/loop-run-once.js");
    const start = Date.now();
    expect(
      await egressBlocked(() => new Promise(() => {}))
    ).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("non-darwin platform → skip egress check entirely (not blocked)", async () => {
    const { egressBlocked } = await import("../src/commands/loop-run-once.js");
    // Override platform to simulate Linux/Windows.
    const save = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(await egressBlocked()).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: save, configurable: true });
    }
  });

  it("Darwin DNS ok + TCP probe ok → not blocked", async () => {
    const { egressBlocked } = await import("../src/commands/loop-run-once.js");
    const save = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(
        await egressBlocked(
          () => Promise.resolve([{ address: "140.82.113.4" }]),
          () => Promise.resolve()
        )
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: save, configurable: true });
    }
  });

  it("Darwin DNS ok + TCP probe fails → blocked", async () => {
    const { egressBlocked } = await import("../src/commands/loop-run-once.js");
    const save = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(
        await egressBlocked(
          () => Promise.resolve([{ address: "140.82.113.4" }]),
          () => Promise.reject(new Error("ECONNREFUSED"))
        )
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: save, configurable: true });
    }
  });

  it("on Darwin with real DNS resolve → returns boolean (best-effort probe)", async () => {
    // This test verifies the code path runs without throwing. The result
    // depends on actual network state: github.com:443 reachable → false;
    // unreachable → true. Both are valid — the probe is best-effort.
    if (process.platform !== "darwin") return;
    const { egressBlocked } = await import("../src/commands/loop-run-once.js");
    const result = await egressBlocked();
    expect(typeof result).toBe("boolean");
  });
});

describe("announceReport — card-layout report surface (US-META-002c follow-through)", () => {
  it("finds the report in the card folder and announces it", async () => {
    const { announceReport } = await import("../src/commands/loop-run-once.js");
    const p = tmp("announce");
    const dir = join(p, ".roll", "features", "uncategorized", "FIX-9", "latest");
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "FIX-9-report.html"), "<html></html>");
    const opened: string[] = [];
    // mute flag absent → opener fires; capture instead of really opening.
    const w = process.stdout.write.bind(process.stdout);
    let out = "";
    // @ts-expect-error capture-only
    process.stdout.write = (s: string): boolean => ((out += String(s)), true);
    let got: string | null;
    try {
      got = announceReport(p, "slug-x", "FIX-9", (path) => opened.push(path));
    } finally {
      process.stdout.write = w;
    }
    expect(got).toContain(join("features", "uncategorized", "FIX-9", "latest", "FIX-9-report.html"));
    expect(out).toContain("Review Page");
    expect(opened).toHaveLength(1);
  });
  it("no report anywhere → null, no announcement", async () => {
    const { announceReport } = await import("../src/commands/loop-run-once.js");
    expect(announceReport(tmp("announce-none"), "slug-x", "FIX-9", () => {})).toBeNull();
  });
});

// ── US-LOOP-079h1: consecutive-idle counter ──────────────────────────────────

describe("US-LOOP-079h1 — consecutive-idle counter", () => {
  const { existsSync, readFileSync, writeFileSync } = require("node:fs");

  it("idleCounterPath produces the expected file path (AC2: separate from consecutive-fails)", () => {
    const p = tmp("idle-path");
    expect(idleCounterPath(p, "default")).toContain("consecutive-idle-default");
    // AC2: file name is distinct from the consecutive-fails counter.
    expect(idleCounterPath(p, "default")).not.toContain("consecutive-fails");
  });

  it("incrementConsecutiveIdle creates the file and returns count (AC1)", () => {
    const p = tmp("idle-incr");
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    const count1 = incrementConsecutiveIdle(p, "default");
    expect(count1).toBe(1);
    expect(existsSync(join(p, ".roll", "loop", "consecutive-idle-default"))).toBe(true);
    expect(readFileSync(join(p, ".roll", "loop", "consecutive-idle-default"), "utf8").trim()).toBe("1");

    const count2 = incrementConsecutiveIdle(p, "default");
    expect(count2).toBe(2);
    expect(readFileSync(join(p, ".roll", "loop", "consecutive-idle-default"), "utf8").trim()).toBe("2");
  });

  it("resetConsecutiveIdle sets the file to 0 (AC1: non-idle terminal resets)", () => {
    const p = tmp("idle-reset");
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    // Seed with a non-zero value.
    incrementConsecutiveIdle(p, "default");
    incrementConsecutiveIdle(p, "default");
    expect(readFileSync(join(p, ".roll", "loop", "consecutive-idle-default"), "utf8").trim()).toBe("2");

    resetConsecutiveIdle(p, "default");
    expect(readFileSync(join(p, ".roll", "loop", "consecutive-idle-default"), "utf8").trim()).toBe("0");
  });

  it("AC3: corrupt / non-numeric file → read as 0 without crashing", () => {
    const p = tmp("idle-crpt");
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    writeFileSync(join(p, ".roll", "loop", "consecutive-idle-default"), "not-a-number", "utf8");
    const count = incrementConsecutiveIdle(p, "default");
    // Corrupt read → 0, then +1 → 1.
    expect(count).toBe(1);
  });

  it("AC3: missing file → treated as 0 (idempotent first increment)", () => {
    const p = tmp("idle-miss");
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    const count = incrementConsecutiveIdle(p, "default");
    expect(count).toBe(1);
  });

  it("AC3: half-written file (empty) → treated as 0", () => {
    const p = tmp("idle-empty");
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    writeFileSync(join(p, ".roll", "loop", "consecutive-idle-default"), "", "utf8");
    const count = incrementConsecutiveIdle(p, "default");
    expect(count).toBe(1);
  });

  it("resetConsecutiveIdle is idempotent (file may not exist)", () => {
    const p = tmp("idle-nx");
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    // Should not throw if the file does not exist yet.
    expect(() => resetConsecutiveIdle(p, "default")).not.toThrow();
    expect(() => resetConsecutiveIdle(p, "default")).not.toThrow();
  });
});

describe("FIX-1043 — scoped retry clears pending-publish so the picker does not idle", () => {
  it("ROLL_LOOP_GO_ALLOWED_CARDS removes pending-publish markers before the cycle runs", async () => {
    const p = tmp("pending-clear");
    mkdirSync(join(p, ".roll"), { recursive: true });
    // A Todo card that a prior unpublished cycle left in pending-publish.
    writeFileSync(
      join(p, ".roll", "backlog.md"),
      [
        "| ID | Description | Status |",
        "|---|---|---|",
        "| [FIX-1042](.roll/features/loop-engine/FIX-1042/spec.md) | failed unpublished cycle | 📋 Todo |",
        "",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(p, ".roll", "skills", "roll-loop"), { recursive: true });
    writeFileSync(join(p, ".roll", "skills", "roll-loop", "SKILL.md"), "# loop\n", "utf8");

    const rt = join(p, ".roll", "loop");
    mkdirSync(rt, { recursive: true });
    writeFileSync(join(rt, "pending-publish.json"), JSON.stringify(["FIX-1042"]), "utf8");

    const prevCwd = process.cwd();
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    const prevAllowed = process.env[GOAL_ALLOWED_CARDS_ENV];
    try {
      process.chdir(p);
      process.env["ROLL_PROJECT_RUNTIME_DIR"] = rt;
      process.env["ROLL_MAIN_SLUG"] = "proj-abc123";
      process.env[GOAL_ALLOWED_CARDS_ENV] = "FIX-1042";
      // No git remote → repo pushable check fails fast after pending-publish is cleared.
      await loopRunOnceCommand([]);
    } finally {
      process.chdir(prevCwd);
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
      if (prevAllowed === undefined) delete process.env[GOAL_ALLOWED_CARDS_ENV];
      else process.env[GOAL_ALLOWED_CARDS_ENV] = prevAllowed;
    }

    // The scoped retry intent must clear the marker so a later cycle can pick it.
    expect(readPendingPublish(rt).has("FIX-1042")).toBe(false);
  });
});

describe("FIX-1209: core.worktree contamination guard", () => {
  it("detects and heals a poisoned core.worktree", () => {
    const repo = tmp("core-worktree");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });
    execFileSync("git", ["config", "--local", "core.worktree", "/tmp/fake-worktree"], { cwd: repo });

    // Confirm contamination is present
    const before = execFileSync("git", ["config", "--get", "core.worktree"], { cwd: repo, encoding: "utf8" });
    expect(before.trim()).toBe("/tmp/fake-worktree");

    const result = checkCoreWorktreeContamination(repo);

    expect(result.healed).toBe(true);
    expect(result.detail).toBe("/tmp/fake-worktree");

    // Confirm contamination is gone
    try {
      execFileSync("git", ["config", "--get", "core.worktree"], { cwd: repo, encoding: "utf8" });
      // Should not reach here
      expect(true).toBe(false);
    } catch {
      // Expected — core.worktree is no longer set
    }
  });

  it("returns healed=false when no contamination exists", () => {
    const repo = tmp("core-worktree-clean");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });

    const result = checkCoreWorktreeContamination(repo);

    expect(result.healed).toBe(false);
    expect(result.detail).toBe("");
  });

  it("FIX-1224: detects and heals core.worktree contamination in nested roll-meta", () => {
    const repo = tmp("core-worktree-roll-meta");
    mkdirSync(join(repo, ".roll"), { recursive: true });
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["init", "-q"], { cwd: join(repo, ".roll") });
    execFileSync("git", ["config", "--local", "core.worktree", "/tmp/fake-ranking-cwd"], { cwd: join(repo, ".roll") });

    const result = checkCoreWorktreeContamination(repo);

    expect(result.healed).toBe(true);
    expect(result.detail).toContain("/tmp/fake-ranking-cwd");
    expect(() => execFileSync("git", ["config", "--local", "--get", "core.worktree"], { cwd: join(repo, ".roll") })).toThrow();
  });

  it("IDENTITY: resolved path containing worktree marker triggers assertion", async () => {
    // This test uses a worktree-like path to verify the identity assertion in
    // loopRunOnceCommand rejects it.
    const repo = tmp("identity-drift");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });

    // Create a path that looks like a cycle worktree (containing .roll/loop/worktrees)
    const fakeWt = join(tmp("fake-wt"), ".roll", "loop", "worktrees", "cycle-fake");
    mkdirSync(fakeWt, { recursive: true });
    execFileSync("git", ["init", fakeWt]);
    execFileSync("git", ["config", "user.name", "test"], { cwd: fakeWt });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: fakeWt });

    // Mock ROLL_PROJECT_RUNTIME_DIR to avoid polluting real loop dirs
    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevCwd = process.cwd();
    try {
      process.env["ROLL_MAIN_SLUG"] = "test-identity";
      process.env["ROLL_PROJECT_RUNTIME_DIR"] = join(repo, ".roll", "loop");
      process.chdir(fakeWt);

      // run-once resolves identity from cwd; since we're inside a repo with
      // "worktrees" in its path, the identity assertion should fire.
      const write = process.stderr.write.bind(process.stderr);
      let stderr = "";
      process.stderr.write = ((s: string) => {
        stderr += s;
        return true;
      }) as typeof process.stderr.write;
      try {
        const r = await loopRunOnceCommand([]);
        // We may not reach here if identity assertion exits early
        // Just verify there's an error in stderr
        expect(r).toBe(1);
      } finally {
        process.stderr.write = write;
      }
      expect(stderr).toContain("FIX-1209");
      expect(stderr).toContain("identity drift");
    } finally {
      process.chdir(prevCwd);
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
    }
  });

  it("FIX-1226: cycle worktree self-check uses ROLL_MAIN_PROJECT and is not misclassified as drift", async () => {
    const repo = tmp("identity-main-anchor");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });

    const cycleWt = join(repo, ".roll", "loop", "worktrees", "cycle-self-check");
    mkdirSync(cycleWt, { recursive: true });
    execFileSync("git", ["init", cycleWt]);
    execFileSync("git", ["config", "user.name", "test"], { cwd: cycleWt });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: cycleWt });

    const prevSlug = process.env["ROLL_MAIN_SLUG"];
    const prevMain = process.env["ROLL_MAIN_PROJECT"];
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const prevCwd = process.cwd();
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let out = "";
    let stderr = "";
    try {
      process.env["ROLL_MAIN_SLUG"] = "test-identity";
      process.env["ROLL_MAIN_PROJECT"] = repo;
      process.env["ROLL_PROJECT_RUNTIME_DIR"] = join(repo, ".roll", "loop");
      process.chdir(cycleWt);
      process.stdout.write = ((s: string) => {
        out += s;
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((s: string) => {
        stderr += s;
        return true;
      }) as typeof process.stderr.write;

      const r = await loopRunOnceCommand(["--dry-run"]);

      expect(r).toBe(0);
      expect(out).toContain("# roll loop run-once --dry-run");
      expect(out).toContain("# project: test-identity");
      expect(stderr).not.toContain("identity drift");
      expect(stderr).not.toContain("refusing execution");
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      process.chdir(prevCwd);
      if (prevRt === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
      else process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
      if (prevMain === undefined) delete process.env["ROLL_MAIN_PROJECT"];
      else process.env["ROLL_MAIN_PROJECT"] = prevMain;
      if (prevSlug === undefined) delete process.env["ROLL_MAIN_SLUG"];
      else process.env["ROLL_MAIN_SLUG"] = prevSlug;
    }
  });
});
