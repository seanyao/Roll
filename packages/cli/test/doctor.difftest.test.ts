/**
 * diff-test: TS `roll doctor` == bash `bin/roll doctor` (frozen v2 oracle).
 *
 * doctor probes host state across four sections (agent / pr / skills / launchd).
 * Every probe honors the same env overrides bash does, so fixtures fabricate
 * both healthy and broken states deterministically:
 *   - agent  : ROLL_HOME/config.yaml present (with ai_* lines) vs absent.
 *   - pr      : run inside a git repo with NO gh on PATH → "unknown" state
 *               (the deterministic, network-free branch); non-git → skipped.
 *   - skills  : ROLL_PKG_DIR points at a fixture (lib/ symlinked so bash can
 *               source its i18n catalog) with a fresh-matching or stale catalog.
 *   - launchd : _LAUNCHD_DIR pointed at an empty dir → no stale section, AND a
 *               fixture with one stale com.roll.*.plist → the warning block.
 * PATH excludes gh so branch-protection is "unknown" without any network.
 *
 * Frozen-expectation test (US-PORT-009c): `doctorCommand` was proven byte-equal
 * to the bash oracle `bin/roll doctor` under diff-test; the oracle is retired and
 * each case freezes the TS `{status, stdout, stderr}` as an inline snapshot (zero
 * engine spawn). Volatile bits are scrubbed to placeholders so the frozen value
 * stays portable: the random ROLL_HOME/project/ROLL_PKG_DIR paths → `<HOME>` /
 * `<CWD>` / `<PKG>`, and the launchd bootout hint's `$(id -u)` → `<UID>`.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { doctorCommand } from "../src/commands/doctor.js";
import { generateCatalog } from "../src/commands/skills.js";
import { binRollVersion, seedUpdateCheckCache, seedBinaryStalenessCache, pathWithout } from "./helpers.js";

const REPO = resolve(__dirname, "../../..");
const dirs: string[] = [];
// A PATH with no `gh` (and no git would break rev-parse, so keep /usr/bin for
// git) → branch protection resolves "unknown" with zero network calls.
const NOGH_PATH = pathWithout("gh");

function freshHome(config?: string): string {
  const home = mkdtempSync(join(tmpdir(), "roll-doctor-home-"));
  dirs.push(home);
  mkdirSync(join(home, ".roll"), { recursive: true });
  seedUpdateCheckCache(join(home, ".roll"));
  seedBinaryStalenessCache(join(home, ".roll"));
  if (config !== undefined) writeFileSync(join(home, ".roll", "config.yaml"), config);
  return home;
}

function emptyLaunchd(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-doctor-la-"));
  dirs.push(d);
  return d;
}

function fakeLaunchctlBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "roll-doctor-bin-"));
  dirs.push(bin);
  writeFileSync(
    join(bin, "launchctl"),
    "#!/bin/sh\ncase \"$1\" in\n  getenv) exit 0 ;;\n  list) exit 1 ;;\n  *) exit 0 ;;\nesac\n",
    { mode: 0o755 },
  );
  return bin;
}

/** A fixture ROLL_PKG_DIR: real lib/conventions symlinked + custom skills/guide. */
function freshPkg(): string {
  const pkg = mkdtempSync(join(tmpdir(), "roll-doctor-pkg-"));
  dirs.push(pkg);
  for (const d of ["lib", "conventions"]) symlinkSync(join(REPO, d), join(pkg, d));
  for (const [name, desc] of [
    ["alpha", "First."],
    ["beta", "Second."],
  ]) {
    mkdirSync(join(pkg, "skills", name), { recursive: true });
    writeFileSync(join(pkg, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
  }
  return pkg;
}

function makeGitRepo(): string {
  const proj = mkdtempSync(join(tmpdir(), "roll-doctor-proj-"));
  dirs.push(proj);
  execSync("git init -q && git config user.email t@t.co && git config user.name t && git commit -q --allow-empty -m init", {
    cwd: proj,
  });
  return proj;
}

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

interface Env {
  home: string;
  cwd: string;
  pkg?: string;
  launchd: string;
  lang: string;
}
interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function tsDoctor(e: Env): Run {
  const keys = [
    "PATH",
    "HOME",
    "ROLL_HOME",
    "_LAUNCHD_DIR",
    "_ROLL_EXTERNAL_TOOLS_PLATFORM",
    "NO_COLOR",
    "ROLL_LANG",
    "LC_ALL",
    "LANG",
    "ROLL_PKG_DIR",
  ];
  const save: Record<string, string | undefined> = {};
  for (const k of keys) save[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  process.env["PATH"] = `${fakeLaunchctlBin()}:${NOGH_PATH}`;
  process.env["HOME"] = e.home;
  process.env["ROLL_HOME"] = join(e.home, ".roll");
  process.env["_LAUNCHD_DIR"] = e.launchd;
  process.env["_ROLL_EXTERNAL_TOOLS_PLATFORM"] = "linux";
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = e.lang;
  if (e.pkg !== undefined) process.env["ROLL_PKG_DIR"] = e.pkg;
  const saveCwd = process.cwd();
  process.chdir(e.cwd);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (c: string | Uint8Array): boolean => (outChunks.push(String(c)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (errChunks.push(String(c)), true);
  let status: number;
  try {
    status = doctorCommand([]);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const k of keys) {
      const v = save[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { status, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

const CONFIG = "primary_agent: claude\nai_claude: ~/.claude\nai_kimi: ~/.kimi | extra\n";

/** Seed pkg/guide/skills.md with the TS catalog so the skills section reads OK. */
function seedCatalog(pkg: string): void {
  mkdirSync(join(pkg, "guide"), { recursive: true });
  const savePkg = process.env["ROLL_PKG_DIR"];
  process.env["ROLL_PKG_DIR"] = pkg;
  writeFileSync(join(pkg, "guide", "skills.md"), generateCatalog());
  if (savePkg === undefined) delete process.env["ROLL_PKG_DIR"];
  else process.env["ROLL_PKG_DIR"] = savePkg;
}

/** Scrub the random fixture paths + the launchd `$(id -u)` → portable. */
function scrub(r: Run, e: Env): Run {
  const uid = String(process.getuid?.() ?? 0);
  // The staleness readout renders the RUNNING tree's version; scrub it so a
  // release bump (fold+bump happens before the release-flow test run) cannot
  // explode every frozen snapshot (REFACTOR-072 baked literals — release landmine).
  const ver = `v${binRollVersion()}`;
  const s = (x: string): string => {
    let out = x;
    if (e.pkg !== undefined) out = out.split(e.pkg).join("<PKG>");
    out = out.split(e.home).join("<HOME>").split(e.cwd).join("<CWD>").split(e.launchd).join("<LAUNCHD>");
    out = out.split(ver).join("<VER>");
    return out.split(`/${uid}/`).join("/<UID>/");
  };
  return { status: r.status, stdout: s(r.stdout), stderr: s(r.stderr) };
}

// Unrolled (inline snapshots are keyed by call site — a loop can't hold distinct
// per-case frozen values).
describe("frozen: roll doctor", () => {
  it("US-AGENT-045: skips removed ai_* keys and displays aliases as canonical agents", () => {
    const config =
      "primary_agent: openai\n" +
      "ai_openai: ~/.codex\n" +
      "ai_deepseek: ~/.pi/agent\n" +
      "ai_qwen: ~/.qwen\n" +
      "ai_cursor: ~/.cursor\n";
    const e: Env = { home: freshHome(config), cwd: makeGitRepo(), launchd: emptyLaunchd(), lang: "en" };
    const rendered = scrub(tsDoctor(e), e).stdout;
    expect(rendered).toContain("codex       CLI not found   config dir missing  (primary)");
    expect(rendered).toContain("pi          CLI not found   config dir missing");
    expect(rendered).toContain("cursor      CLI not found   config dir missing");
    expect(rendered).not.toContain("qwen");
    expect(rendered).not.toContain("deepseek");
    expect(rendered).not.toContain("openai");
  });

  it("FIX-1203: reports missing agent-session .gitignore entries for existing projects", () => {
    const cwd = makeGitRepo();
    writeFileSync(join(cwd, ".gitignore"), ".roll/\n");
    const e: Env = { home: freshHome(CONFIG), cwd, pkg: freshPkg(), launchd: emptyLaunchd(), lang: "en" };
    seedCatalog(e.pkg!);
    const rendered = scrub(tsDoctor(e), e).stdout;
    expect(rendered).toContain("Roll generated-file ignore list");
    expect(rendered).toContain("Recommended .gitignore additions: .roll/loop/ .pi/ .kimi/ .kimi-code/ .reasonix/");
  });

  it("healthy: git repo + config + matching skills + empty launchd (en)", () => {
    const pkg = freshPkg();
    seedCatalog(pkg);
    const e: Env = { home: freshHome(CONFIG), cwd: makeGitRepo(), pkg, launchd: emptyLaunchd(), lang: "en" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Agent detection
      Agent 检测

        claude      CLI not found   config dir missing  (primary)
        kimi        CLI not found   config dir missing

      PR review extras
      PR 评审两档开关

        ⚪ AI review double gate state unknown — requires gh auth

        Optional — enable AI review as a hard merge gate (path C).
        可选 —— 启用 AI 评审作为合并双门（路径 C）。

        Run once per repo (requires admin token), then claude-code-review.yml
        approvals become a required merge gate alongside CI:
        每个仓库执行一次（需要管理员 token），之后 claude-code-review.yml 的
        approve 将与 CI 一起成为合并必经的双门：

            gh api -X PATCH repos/<owner>/<repo>/branches/main/protection \\
              -f required_pull_request_reviews.required_approving_review_count=1

        Escape hatch: add [skip-ai-review] to a PR body, or include
        SKIP_AI_REVIEW in any commit message, to bypass AI review for that PR.
        紧急通道：在 PR body 加 [skip-ai-review]，或在任一 commit message
        里包含 SKIP_AI_REVIEW，可对该 PR 绕过 AI 评审。

        ⚪ Event-driven PR review not installed

        Optional — enable event-driven PR review (seconds-fast, GitHub only).
        doctor.pr_event_optional_zh

        Without this, Roll reviews PRs each loop cycle (~1h). With it,
        contributors get AI feedback on PR open/update immediately.

            cp templates/workflows/pr-review-event.yml .github/workflows/

        Then set the API key secret for your configured agent in GitHub repo settings.
        doctor.pr_event_secret_zh


      Skill catalog
      技能清单
        ✅ guide/skills.md matches skills/*/SKILL.md

      Loop binary version
      Loop 程序版本

        ✓ running <VER>, up to date (latest <VER>)

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });
  it("healthy: git repo + config + matching skills + empty launchd (zh)", () => {
    const pkg = freshPkg();
    seedCatalog(pkg);
    const e: Env = { home: freshHome(CONFIG), cwd: makeGitRepo(), pkg, launchd: emptyLaunchd(), lang: "zh" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Agent detection
      Agent 检测

        claude      CLI 未安装   配置目录不存在  (默认)
        kimi        CLI 未安装   配置目录不存在

      PR review extras
      PR 评审两档开关

        ⚪ 状态未知（需要 gh auth）

        Optional — enable AI review as a hard merge gate (path C).
        可选 —— 启用 AI 评审作为合并双门（路径 C）。

        Run once per repo (requires admin token), then claude-code-review.yml
        approvals become a required merge gate alongside CI:
        每个仓库执行一次（需要管理员 token），之后 claude-code-review.yml 的
        approve 将与 CI 一起成为合并必经的双门：

            gh api -X PATCH repos/<owner>/<repo>/branches/main/protection \\
              -f required_pull_request_reviews.required_approving_review_count=1

        Escape hatch: add [skip-ai-review] to a PR body, or include
        SKIP_AI_REVIEW in any commit message, to bypass AI review for that PR.
        紧急通道：在 PR body 加 [skip-ai-review]，或在任一 commit message
        里包含 SKIP_AI_REVIEW，可对该 PR 绕过 AI 评审。

        ⚪ 事件驱动 PR 评审未安装

        可选 —— 启用事件驱动 PR 评审（秒级响应，仅限 GitHub）。
        doctor.pr_event_optional_zh

        不安装也行 — loop 每轮会兜底评审。安装后
        PR 一开即触发 AI 评审。

            cp templates/workflows/pr-review-event.yml .github/workflows/

        然后在 GitHub 仓库设置中添加你配置的 agent 对应的 API key secret。
        doctor.pr_event_secret_zh


      Skill catalog
      技能清单
        ✅ guide/skills.md 与 skills/*/SKILL.md 一致

      Loop binary version
      Loop 程序版本

        ✓ 当前 <VER>，已是最新 <VER>

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });

  it("broken: no config (agent section skipped), non-git, skills drift (en)", () => {
    const pkg = freshPkg();
    mkdirSync(join(pkg, "guide"), { recursive: true });
    writeFileSync(join(pkg, "guide", "skills.md"), "# stale\n"); // drift
    const nonGit = mkdtempSync(join(tmpdir(), "roll-doctor-nongit-"));
    dirs.push(nonGit);
    const e: Env = { home: freshHome(), cwd: nonGit, pkg, launchd: emptyLaunchd(), lang: "en" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Skill catalog
      技能清单
        ⚠️  guide/skills.md is stale — run 'roll setup skills'

      Loop binary version
      Loop 程序版本

        ✓ running <VER>, up to date (latest <VER>)

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });
  it("broken: no config (agent section skipped), non-git, skills drift (zh)", () => {
    const pkg = freshPkg();
    mkdirSync(join(pkg, "guide"), { recursive: true });
    writeFileSync(join(pkg, "guide", "skills.md"), "# stale\n"); // drift
    const nonGit = mkdtempSync(join(tmpdir(), "roll-doctor-nongit-"));
    dirs.push(nonGit);
    const e: Env = { home: freshHome(), cwd: nonGit, pkg, launchd: emptyLaunchd(), lang: "zh" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Skill catalog
      技能清单
        ⚠️  guide/skills.md 已过期 — 请运行 'roll setup skills'

      Loop binary version
      Loop 程序版本

        ✓ 当前 <VER>，已是最新 <VER>

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });

  it("broken: skills target missing → drift (en)", () => {
    const pkg = freshPkg(); // no guide/skills.md written at all
    const nonGit = mkdtempSync(join(tmpdir(), "roll-doctor-nog2-"));
    dirs.push(nonGit);
    const e: Env = { home: freshHome(), cwd: nonGit, pkg, launchd: emptyLaunchd(), lang: "en" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Skill catalog
      技能清单
        ⚠️  guide/skills.md is stale — run 'roll setup skills'

      Loop binary version
      Loop 程序版本

        ✓ running <VER>, up to date (latest <VER>)

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });
  it("broken: skills target missing → drift (zh)", () => {
    const pkg = freshPkg(); // no guide/skills.md written at all
    const nonGit = mkdtempSync(join(tmpdir(), "roll-doctor-nog2-"));
    dirs.push(nonGit);
    const e: Env = { home: freshHome(), cwd: nonGit, pkg, launchd: emptyLaunchd(), lang: "zh" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Skill catalog
      技能清单
        ⚠️  guide/skills.md 已过期 — 请运行 'roll setup skills'

      Loop binary version
      Loop 程序版本

        ✓ 当前 <VER>，已是最新 <VER>

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });

  it("launchd: a stale com.roll plist surfaces the warning block (Darwin, en)", () => {
    if (process.platform !== "darwin") return; // section is Darwin-only
    const la = mkdtempSync(join(tmpdir(), "roll-doctor-stale-la-"));
    dirs.push(la);
    const missing = "/tmp/roll-doctor-this-dir-does-not-exist-xyz";
    writeFileSync(
      join(la, "com.roll.loop.demo.plist"),
      `<plist><dict>\n<key>WorkingDirectory</key>\n<string>${missing}</string>\n</dict></plist>\n`,
    );
    const pkg = freshPkg();
    seedCatalog(pkg);
    const nonGit = mkdtempSync(join(tmpdir(), "roll-doctor-la-proj-"));
    dirs.push(nonGit);
    const e: Env = { home: freshHome(), cwd: nonGit, pkg, launchd: la, lang: "en" };
    expect(scrub(tsDoctor(e), e)).toMatchInlineSnapshot(`
      {
        "status": 0,
        "stderr": "",
        "stdout": "
      Skill catalog
      技能清单
        ✅ guide/skills.md matches skills/*/SKILL.md

      launchd lanes (all com.roll.* jobs)

        These are leftovers from an older install — Roll no longer uses timers. Disarm each:
          launchctl bootout gui/$(id -u)/<label> && rm ~/Library/LaunchAgents/<label>.plist

        ✗ com.roll.loop.demo · not loaded
          → /tmp/roll-doctor-this-dir-does-not-exist-xyz  [missing — STALE lane]

      Stale launchd plists

        ⚠ com.roll.loop.demo
          WorkingDirectory missing: /tmp/roll-doctor-this-dir-does-not-exist-xyz
          Path is stale, clean up with: launchctl bootout gui/<UID>/com.roll.loop.demo; rm '<LAUNCHD>/com.roll.loop.demo.plist'

      Loop binary version
      Loop 程序版本

        ✓ running <VER>, up to date (latest <VER>)

      Tool readiness
      工具就绪度

        ✓ bash (bash) — available
        ~ browser.console (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.dom-query (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ~ browser.screenshot (browser) — degraded
          npx is not on PATH.
          fix: npm install -g npm
        ✓ filesystem.read (filesystem) — available
        ✓ filesystem.stat (filesystem) — available
        ✓ filesystem.write (filesystem) — available
        ✓ git.commit (git) — available
        ✓ git.merge (git) — available
        ✓ git.push (git) — available
        ✓ git.status (git) — available
        − github.ci (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        − github.pr (github) — unavailable
          gh is not on PATH.
          fix: brew install gh
        ✓ mcp.call (mcp) — available
        ✓ network.fetch (network) — available
        ~ physical.screenshot (physical) — degraded
          skipped — Roll Capture.app is a macOS-only physical screenshot host.

      External requirements
      外部依赖

        ? macOS screencapture — stale
          use: Physical Terminal.app and browser-window screenshot evidence on macOS.
          macOS-only requirement; not applicable on this host.
          impact: Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.
        − Playwright Chromium — missing
          use: Headless browser screenshots for non-attest diagnostics and tool use.
          npx is not on PATH.
          fix: npm install -g npm
          impact: Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.

      Browser operations readiness
      浏览器操作就绪度

        ~ managed: degraded — unavailable — Node LTS, npx, chrome-devtools-mcp not ready; existing Playwright and Roll Capture paths remain usable
          fix: roll browser setup --dry-run
          fix: install the missing dependency, then re-run roll browser doctor
        ~ interactive: degraded — unavailable — Node LTS, npx not ready; existing Playwright and Roll Capture paths remain usable
          fix: install the missing dependency, then re-run roll browser doctor
        ~ capture: degraded — skipped — Roll Capture.app is a macOS-only physical screenshot host.
          fix: roll doctor --tools
          fix: see Roll Capture.app setup guidance

      Browser operations readiness (truth)
      浏览器操作就绪度（事实）

        ✗ managed: unknown — no managed operation facts
        ✗ interactive: unknown — no owner lease facts
        ✗ capture: unknown — no physical capture facts

      Capture policy readiness
      截图策略就绪度

        − v2 capture gateway — unavailable
          host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
        − browser renderer — unavailable
          Playwright Chromium is not installed; run \`npx playwright install chromium\`
        · effective capture policy — unset
          no capture mode recorded; project retains legacy behavior until \`roll capture migrate\` enables best_effort
        · next migration — retained (provider_v2_unavailable)
          v2 Roll Capture gateway unavailable; retained existing policy — host advertised no capture protocols (legacy host); roll.capture.v2 is never assumed for an unadvertised host
      ",
      }
    `);
  });

  // ── US-ONBOARD-NUDGE-003: design nudge in roll doctor ──

  it("AC1: nudge appears in doctor when prd.md present + empty backlog", () => {
    const h = freshHome();
    const proj = mkdtempSync(join(tmpdir(), "roll-doctor-nudge-"));
    dirs.push(proj);
    // Set up a roll project with empty backlog
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| Story | Description | Status |\n|---|---|---|\n");
    writeFileSync(join(proj, "AGENTS.md"), "AGENTS\n");
    // Design material — triggers nudge
    writeFileSync(join(proj, "prd.md"), "# Product Requirements\n\nSome content.");
    const pkg = freshPkg();
    const e: Env = { home: h, cwd: proj, pkg, launchd: emptyLaunchd(), lang: "en" };
    const run = tsDoctor(e);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("$roll-design");
    expect(run.stdout).toContain("informational");
  });

  it("AC2: no nudge when no design materials present", () => {
    const h = freshHome();
    const proj = mkdtempSync(join(tmpdir(), "roll-doctor-nonudge-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| Story | Description | Status |\n|---|---|---|\n");
    writeFileSync(join(proj, "AGENTS.md"), "AGENTS\n");
    // No design materials
    const pkg = freshPkg();
    const e: Env = { home: h, cwd: proj, pkg, launchd: emptyLaunchd(), lang: "en" };
    const run = tsDoctor(e);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("$roll-design");
  });

  it("AC2: no nudge when backlog is non-empty", () => {
    const h = freshHome();
    const proj = mkdtempSync(join(tmpdir(), "roll-doctor-full-"));
    dirs.push(proj);
    // Set up with design material but non-empty backlog
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| [US-001](spec.md) | Test | 📋 Todo |\n");
    writeFileSync(join(proj, "prd.md"), "# PRD\n\nContent.");
    const pkg = freshPkg();
    const e: Env = { home: h, cwd: proj, pkg, launchd: emptyLaunchd(), lang: "en" };
    const run = tsDoctor(e);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("$roll-design");
  });

  it("AC4: doctor exit code stays 0 when nudge is shown", () => {
    const h = freshHome();
    const proj = mkdtempSync(join(tmpdir(), "roll-doctor-exit-"));
    dirs.push(proj);
    mkdirSync(join(proj, ".roll"), { recursive: true });
    writeFileSync(join(proj, ".roll", "backlog.md"), "| Story | Description | Status |\n|---|---|---|\n");
    writeFileSync(join(proj, "AGENTS.md"), "AGENTS\n");
    writeFileSync(join(proj, "prd.md"), "# PRD\n\nContent.");
    const pkg = freshPkg();
    const e: Env = { home: h, cwd: proj, pkg, launchd: emptyLaunchd(), lang: "en" };
    const run = tsDoctor(e);
    expect(run.status).toBe(0); // exit code unchanged
    expect(run.stdout).toContain("$roll-design"); // nudge present
  });

  // ── REFACTOR-072: binary staleness surfaced in doctor ─────────────────────────

  it("REFACTOR-072 AC1: doctor shows an up-to-date binary readout", () => {
    const pkg = freshPkg();
    seedCatalog(pkg);
    const e: Env = { home: freshHome(CONFIG), cwd: makeGitRepo(), pkg, launchd: emptyLaunchd(), lang: "en" };
    const rendered = scrub(tsDoctor(e), e).stdout;
    expect(rendered).toContain("Loop binary version");
    expect(rendered).toContain("Loop 程序版本");
    expect(rendered).toContain("running <VER>, up to date (latest <VER>)");
  });

  it("REFACTOR-072 AC1: doctor shows a stale binary readout", () => {
    const home = freshHome(CONFIG);
    // Override the freshly-seeded cache with a far-future release.
    writeFileSync(
      join(home, ".roll", ".loop-version-check"),
      JSON.stringify({ latest: "v999.999.999", fetchedAtMs: Date.now() }),
      "utf8",
    );
    const pkg = freshPkg();
    seedCatalog(pkg);
    const e: Env = { home, cwd: makeGitRepo(), pkg, launchd: emptyLaunchd(), lang: "en" };
    const rendered = scrub(tsDoctor(e), e).stdout;
    expect(rendered).toContain("Loop binary version");
    expect(rendered).toContain("roll update");
    expect(rendered).toContain("running <VER>, latest v999.999.999");
  });

  it("REFACTOR-072 AC1: doctor shows unknown when no staleness cache exists", () => {
    const home = mkdtempSync(join(tmpdir(), "roll-doctor-staleness-unknown-"));
    dirs.push(home);
    mkdirSync(join(home, ".roll"), { recursive: true });
    seedUpdateCheckCache(join(home, ".roll"));
    // Intentionally NOT seeding .loop-version-check.
    const pkg = freshPkg();
    seedCatalog(pkg);
    const e: Env = { home, cwd: makeGitRepo(), pkg, launchd: emptyLaunchd(), lang: "en" };
    const rendered = scrub(tsDoctor(e), e).stdout;
    expect(rendered).toContain("Loop binary version");
    expect(rendered).toContain("No recent version check");
  });
});
