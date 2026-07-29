/**
 * Frozen-expectation test: TS `roll status`.
 *
 * `statusCommand` was proven byte-equal to the python oracle lib/roll-status.py
 * under diff-test (fixture render + live render in a fabricated HOME/project).
 * Per US-PORT-009c the oracle is retired: the `python3 roll-status.py` spawn is
 * dropped and each case freezes the TS render as an inline snapshot (zero engine
 * spawn). The fixture render (ROLL_RENDER_FIXTURE=1) is fully deterministic; the
 * live render embeds the random HOME/project paths, scrubbed to `<HOME>`/`<PROJ>`
 * so the frozen value stays portable (macOS `/var/folders` vs Linux CI `/tmp`).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { statusCommand } from "../src/commands/status.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

/** Run the TS command in-process with env/cwd, capturing stdout. */
function tsStatus(env: Record<string, string | undefined>, cwd?: string): string {
  const saveEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saveEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const saveCwd = process.cwd();
  if (cwd !== undefined) process.chdir(cwd);
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — capture-only override
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    statusCommand(["--no-color"]);
  } finally {
    process.stdout.write = realWrite;
    process.chdir(saveCwd);
    for (const [k, v] of Object.entries(saveEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return chunks.join("");
}

describe("frozen: roll status render", () => {
  it("fixture render", () => {
    // In fixture mode every section is fixtured EXCEPT the THIS PROJECT header,
    // which is `basename(cwd)`. Run in a uniquely-named temp dir and scrub that
    // basename → a placeholder. (Must NOT use the repo root: its basename is
    // "roll" on CI, which would scrub every "roll"/".roll"/"roll setup" in the
    // output.)
    const fixProj = mkdtempSync(join(tmpdir(), "roll-status-fixproj-"));
    dirs.push(fixProj);
    const ts = tsStatus({ ROLL_RENDER_FIXTURE: "1" }, fixProj).split(basename(fixProj)).join("<PROJECT>");
    expect(ts.trimStart().split("\n")[0]).toContain("WARN");
    expect(ts.trimStart().split("\n")[1]).toContain("North");
    expect(ts.trimStart().split("\n")[1]).not.toContain("…");
    expect(ts).toMatchInlineSnapshot(`
      "  WARN    main reconciled vs backlog   exit 1
        North  no data

        LOOP      session-driven · go session open
        CYCLE     17 / 3d   12 failed · $0.59
        RELEASE   v3.611.2 staged   pass · f:0 w:44 ?:78 · 366 merged · 214 pending
        STORY     67% attest coverage      fail 0 · unknown 197

        drift 0 · done 366 (incl. legacy 366) · unknown 197 · todo 7

        → roll cycles --since 3d    → roll release    → roll backlog

      ────────────────────────────────────────────────────────────────────────────────────────────────────


        ! drift  1/3 AI clients in sync · 12 skills · 4 templates

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        GLOBAL CONVENTIONS  ·  全局约定                                        ~/.roll/conventions/global/

        + AGENTS.md
        + CLAUDE.md
        + .cursor-rules
        − project_rules.md  missing

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        AI CLIENTS  ·  AI 客户端同步                                     convention · path · sync · skills

        name          convention    sync          skills
        ────────────────────────────────────────────────────────────────────────────────────────────────
        claude        CLAUDE.md     ✓ in sync     12
        kimi          AGENTS.md     ~ out of sync 12
             fix: roll setup -f
        pi            AGENTS.md     − missing     0
             fix: roll setup -f

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        PROJECT TEMPLATES  ·  项目模板                                      ~/.roll/conventions/templates/

        fullstack 14f  ·  frontend-only 9f  ·  backend-service 11f  ·  cli 7f

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        THIS PROJECT  ·  本项目                                                 <PROJECT>

        + AGENTS.md
        + .roll/backlog.md
        + .roll/features/  23 feature docs
        ◆ driver · session

      "
    `);
  });

  it("live render in a fabricated HOME + project", () => {
    const home = mkdtempSync(join(tmpdir(), "roll-status-home-"));
    const proj = mkdtempSync(join(tmpdir(), "roll-status-proj-"));
    dirs.push(home, proj);

    // ROLL_HOME with: 3/5 conventions, 2 templates, 2 skills, config with
    // one synced + one missing AI client.
    const rollHome = join(home, ".roll");
    const gd = join(rollHome, "conventions", "global");
    mkdirSync(gd, { recursive: true });
    for (const f of ["AGENTS.md", "CLAUDE.md", ".cursor-rules"]) {
      writeFileSync(join(gd, f), `# ${f}\n`);
    }
    const td = join(rollHome, "conventions", "templates");
    mkdirSync(join(td, "fullstack", "sub"), { recursive: true });
    writeFileSync(join(td, "fullstack", "a.md"), "a");
    writeFileSync(join(td, "fullstack", "sub", "b.md"), "b");
    mkdirSync(join(td, "cli"), { recursive: true });
    writeFileSync(join(td, "cli", "c.md"), "c");
    mkdirSync(join(rollHome, "skills", "roll-build"), { recursive: true });
    mkdirSync(join(rollHome, "skills", "roll-fix"), { recursive: true });

    // synced client: cfg file with @roll.md + roll.md identical to src
    const claudeDir = join(home, ".claude");
    mkdirSync(join(claudeDir, "skills", "roll-build"), { recursive: true });
    symlinkSync(join(rollHome, "skills", "roll-fix"), join(claudeDir, "skills", "roll-fix"));
    writeFileSync(join(claudeDir, "CLAUDE.md"), "hello\n@roll.md\n");
    writeFileSync(join(claudeDir, "roll.md"), "ROLL GLOBAL\n");
    writeFileSync(join(gd, "CLAUDE.md"), "ROLL GLOBAL\n"); // src == roll.md
    // missing client: dir exists but no cfg file
    mkdirSync(join(home, ".kimi"), { recursive: true });
    writeFileSync(
      join(rollHome, "config.yaml"),
      [
        `ai_claude: ${claudeDir}|CLAUDE.md|CLAUDE.md`,
        `ai_kimi: ${join(home, ".kimi")}|AGENTS.md|AGENTS.md`,
        "",
      ].join("\n"),
    );

    // project dir: AGENTS.md + backlog + 2 feature docs, plain dir (no git)
    writeFileSync(join(proj, "AGENTS.md"), "x\n");
    mkdirSync(join(proj, ".roll", "features"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "b\n");
    writeFileSync(join(proj, ".roll", "features", "f1.md"), "f\n");
    writeFileSync(join(proj, ".roll", "features", "f2.md"), "f\n");

    const env = { HOME: home, ROLL_HOME: rollHome };
    // Live render embeds the random HOME/project paths → scrub to placeholders
    // so the frozen value stays portable (rollHome/claudeDir live under home; the
    // THIS PROJECT header is `basename(cwd)`).
    //
    // US-LOOP-118: the loop/dream launchd lines are gone, so there is nothing
    // platform-dependent left to normalise here — a fabricated project has no
    // leftover lane on any OS, and the driver line is derived from the PAUSE
    // marker alone.
    const ts = tsStatus(env, proj)
      .split(proj)
      .join("<PROJ>")
      .split(home)
      .join("<HOME>")
      .split(basename(proj))
      .join("<PROJ>");
    expect(ts.trimStart().split("\n")[0]).toContain("UNKNOWN");
    expect(ts.trimStart().split("\n")[1]).toContain("North");
    expect(ts.trimStart().split("\n")[1]).not.toContain("…");
    expect(ts).toMatchInlineSnapshot(`
      "  UNKNOWN  no truth snapshot — run roll index
        North  auto no data ● · delivery no data ● · fix no data ● · attr no data ●

      ────────────────────────────────────────────────────────────────────────────────────────────────────


        ! drift  1/2 AI clients in sync · 2 skills · 2 templates

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        GLOBAL CONVENTIONS  ·  全局约定                                        ~/.roll/conventions/global/

        + AGENTS.md
        + CLAUDE.md
        + .cursor-rules
        − project_rules.md  missing

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        AI CLIENTS  ·  AI 客户端同步                                     convention · path · sync · skills

        name          convention    sync          skills
        ────────────────────────────────────────────────────────────────────────────────────────────────
        claude        CLAUDE.md     ✓ in sync     2
        kimi          AGENTS.md     − missing     0
             fix: roll setup -f

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        PROJECT TEMPLATES  ·  项目模板                                      ~/.roll/conventions/templates/

        fullstack 2f  ·  − frontend-only missing  ·  − backend-service missing  ·  cli 1f

      ────────────────────────────────────────────────────────────────────────────────────────────────────

        THIS PROJECT  ·  本项目                                                    <PROJ>

        + AGENTS.md
        + .roll/backlog.md
        + .roll/features/  2 feature docs
        ◆ driver · session

      "
    `);
  });

  // ── US-ONBOARD-NUDGE-003: design nudge in roll status ──

  it("AC1: nudge appears when prd.md present + empty backlog", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-status-nudge-"));
    dirs.push(proj);
    // Set up a roll project with empty backlog
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| Story | Description | Status |\n|---|---|---|\n");
    writeFileSync(join(proj, "AGENTS.md"), "AGENTS\n");
    // Design material
    writeFileSync(join(proj, "prd.md"), "# Product Requirements\n\nSome content.");
    const ts = tsStatus({}, proj)
      .split(proj).join("<PROJ>")
      .split(basename(proj)).join("<PROJ>");
    expect(ts).toContain("$roll-design");
    expect(ts).toContain("Found requirement docs");
  });

  it("AC3: no nudge when no design materials present", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-status-nonudge-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| Story | Description | Status |\n|---|---|---|\n");
    writeFileSync(join(proj, "AGENTS.md"), "AGENTS\n");
    // No design materials
    const ts = tsStatus({}, proj)
      .split(proj).join("<PROJ>")
      .split(basename(proj)).join("<PROJ>");
    expect(ts).not.toContain("$roll-design");
  });

  it("AC3: no nudge when backlog is non-empty", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-status-full-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| [US-001](spec.md) | Test | 📋 Todo |\n");
    writeFileSync(join(proj, "AGENTS.md"), "AGENTS\n");
    writeFileSync(join(proj, "prd.md"), "# PRD\n\nContent.");
    const ts = tsStatus({}, proj)
      .split(proj).join("<PROJ>")
      .split(basename(proj)).join("<PROJ>");
    expect(ts).not.toContain("$roll-design");
  });
});

describe("US-LOOP-118 — leftover lane scan honours _LAUNCHD_DIR (codex r4)", () => {
  it("names a leftover lane found in the configured LaunchAgents dir", () => {
    // roll status hardcoded the home LaunchAgents path, making it the ONE surface
    // that could not see a lane in a configured/sandboxed environment — its verdict
    // silently disagreed with dashboard / doctor / index, and no test could reach it.
    const home = mkdtempSync(join(tmpdir(), "roll-status-la-home-"));
    const proj = mkdtempSync(join(tmpdir(), "roll-status-la-proj-"));
    const la = mkdtempSync(join(tmpdir(), "roll-status-la-agents-"));
    dirs.push(home, proj, la);
    mkdirSync(join(proj, ".roll", "features"), { recursive: true });
    // status.ts derives its own path-based slug (projectSlugPy) and does NOT read
    // ROLL_MAIN_SLUG, so compute the same value here rather than assume an override.
    const real = realpathSync(proj);
    const slug = `${basename(real).replace(/[^A-Za-z0-9]+/g, "-")}-${createHash("md5").update(real).digest("hex").slice(0, 6)}`;
    writeFileSync(join(la, `com.roll.dream.${slug}.plist`), "<plist/>\n");

    const env = { HOME: home, ROLL_HOME: join(home, ".roll"), _LAUNCHD_DIR: la };
    const out = tsStatus(env, proj);
    expect(out).toContain("leftover launchd lane");
    expect(out).toContain("dream");

    // Same project, no plist in that dir → nothing claimed.
    const empty = mkdtempSync(join(tmpdir(), "roll-status-la-empty-"));
    dirs.push(empty);
    expect(tsStatus({ ...env, _LAUNCHD_DIR: empty }, proj)).not.toContain("leftover launchd lane");
  });
});
