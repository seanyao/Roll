/**
 * @responsibility Runs the `roll setup` subcommand, porting the v2 setup flow and its step record buffer.
 */
/**
 * `roll setup` — TS port of bin/roll cmd_setup (1410-1476) plus the helpers it
 * drives: the P1-3.4 submodule guard (1419-1424), the per-step `_record` buffer
 * + `_state_to_marker` (1428-1441), `_run_setup_step` / `_setup_snapshot`
 * (1357-1408), `_install_local`/`_sync_conventions`/`_sync_skills`/
 * `_peer_ensure_state_dir`/`_ensure_hooks_path`/`_ensure_tmux`, and the v2 UI
 * renderer `_emit_setup_v2_ui` (1482-1530) which itself shells lib/roll-setup.py
 * — reimplemented natively here via the shared render primitives.
 *
 * The full step pipeline + final v2 render are mirrored byte-for-byte. The
 * convention-source guard, convention-sync / install / skill-link FS side
 * effects (the ONLY thing the snapshot-diff observes) live in TS, so `setup`
 * has no bash fallback.
 *
 * Whitelisted divergences (no contribution to stdout; FS-only or env-only):
 *   - The submodule guard's `git submodule update` is reproduced as a guarded
 *     spawn (no-op for npm/curl installs, and for the fabricated ROLL_PKG_DIR
 *     used by difftests which carries no .git/.gitmodules).
 *   - `_ensure_tmux`'s brew-install path is darwin+brew only and emits nothing
 *     to setup's stdout; the TS port only reproduces the PRESENCE probe that
 *     decides the step's skip/ok/fail marker (`command -v tmux`).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";
import { c, renderState, row, COLS } from "../render.js";
import {
  installLocal,
  onPath,
  rollHome,
  rollPkgConventions,
  rollPkgDir,
  syncConventions,
  syncSkills,
  writeMachineAgentScope,
} from "./setup-shared.js";
import {
  discoverInteractiveAgents,
  isPrimaryValid,
  readPrimaryAgent,
  readLineFromStdin,
  selectPrimaryAgent,
} from "../lib/interactive-agent.js";
import { collectExternalTools, defaultExternalToolDeps, resolveRequirement, type ExternalToolState } from "../lib/external-tools.js";
import {
  installRollCapture,
  renderRollCaptureInstallResult,
  renderRollCaptureUpdatePrompt,
  renderRollCaptureUpdateResult,
  updateRollCapture,
} from "../lib/roll-capture-install.js";
import {
  collectRollCaptureReadiness,
  defaultRollCaptureReadinessDeps,
  detectCanonicalRollCaptureInstall,
  renderRollCaptureSetupGuidance,
} from "../lib/roll-capture-readiness.js";

// ─── bash UI helpers (bin/roll:41-56) — err only ─────────────────────────────
function err(line: string): void {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const RED = noColor ? "" : "\x1b[0;31m";
  const NC = noColor ? "" : "\x1b[0m";
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}
function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function m(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, msgLang(), key, ...args);
}

export function renderScreenRecordingSetupNotice(states: readonly ExternalToolState[]): string | null {
  const screen = states.find((state) => state.id === "screencapture");
  if (screen?.status !== "permission-missing") return null;
  return [
    "",
    "  ! macOS Screen Recording permission is missing for Terminal.app.",
    "  Screenshot evidence will be skipped until permission is granted.",
    "  Open System Settings > Privacy & Security > Screen Recording, allow Terminal.app, then restart Terminal.app.",
    "",
  ].join("\n");
}

// ─── _setup_snapshot (1357) — content fingerprint of watched dirs ────────────
/**
 * Mirrors `_setup_snapshot`'s OUTCOME: a stable string that differs iff a
 * watched dir's regular-file contents, symlink targets, or directory set
 * changed. We don't reproduce cksum's exact bytes (never observed) — the
 * change/unchanged verdict is all `_run_setup_step` reads — but we hash the
 * same three categories (files+content, symlinks+target, dirs) over the same
 * colon-separated watch list, sorted, so before==after agrees with bash.
 */
function setupSnapshot(watch: string): string {
  const lines: string[] = [];
  for (const d of watch.split(":")) {
    if (d === "") continue;
    let isDir = false;
    try {
      isDir = statSync(d).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    walk(d, lines);
  }
  return lines.sort().join("\n");
}

function walk(dir: string, lines: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    let isLink = false;
    try {
      isLink = lstatSync(p).isSymbolicLink();
    } catch {
      continue;
    }
    if (isLink) {
      // bash records `L <cksum-line> -> <target>` for symlinks (type l).
      try {
        lines.push(`L ${p} -> ${readlinkSync(p)}`);
      } catch {
        /* ignore */
      }
      continue;
    }
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      lines.push(`D ${p}`);
      walk(p, lines);
    } else if (st.isFile()) {
      lines.push(`F ${p} ${fileFingerprint(p)}`);
    }
  }
}

function fileFingerprint(p: string): string {
  try {
    const buf = readFileSync(p);
    // cksum-independent but content-sensitive: length + a cheap rolling sum.
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum = (sum * 31 + (buf[i] ?? 0)) >>> 0;
    return `${buf.length}:${sum}`;
  } catch {
    return "?";
  }
}

type StepState = "changed" | "unchanged" | "failed";
type PermissionState = "ok" | "skip" | "fail";

/** Port of _run_setup_step: snapshot watch, run fn, snapshot again. */
function runSetupStep(watch: string, fn: () => void): StepState {
  const before = setupSnapshot(watch);
  try {
    fn();
  } catch {
    return "failed";
  }
  const after = setupSnapshot(watch);
  return before === after ? "unchanged" : "changed";
}

// ─── _ensure_hooks_path (1382) ────────────────────────────────────────────────
function ensureHooksPath(repoPath: string): void {
  const inRepo =
    spawnSync("git", ["-C", repoPath, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
  if (!inRepo) return;
  const cur = spawnSync("git", ["-C", repoPath, "config", "core.hooksPath"], { encoding: "utf8" });
  const current = cur.status === 0 ? (cur.stdout ?? "").trim() : "";
  if (current === "" || current === ".git/hooks") {
    spawnSync("git", ["-C", repoPath, "config", "core.hooksPath", "hooks"], { stdio: "ignore" });
  }
}

// ─── _peer_ensure_state_dir (3809) ────────────────────────────────────────────
function peerEnsureStateDir(): void {
  const base = join(rollHome(), ".peer-state");
  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, "logs"), { recursive: true });
}

// ─── tmux probe (_ensure_tmux 1324) ──────────────────────────────────────────
function tmuxPresent(): boolean {
  return onPath("tmux");
}

// ─── P1-3.4 submodule guard (1419-1424) ──────────────────────────────────────
function submoduleGuard(): void {
  const pkg = rollPkgDir();
  const skills = join(pkg, "skills");
  const hasGit = existsSync(join(pkg, ".git"));
  const hasMods = existsSync(join(pkg, ".gitmodules"));
  let empty = true;
  try {
    empty = readdirSync(skills).length === 0;
  } catch {
    empty = true;
  }
  if (hasGit && hasMods && empty) {
    spawnSync("git", ["submodule", "update", "--init", "--recursive", "--quiet"], {
      cwd: pkg,
      stdio: "ignore",
    });
  }
}

// ─── _state_to_marker (1433) ──────────────────────────────────────────────────
type Marker = "ok" | "skip" | "forced" | "fail";
function stateToMarker(s: StepState, force: boolean): Marker {
  switch (s) {
    case "changed":
      return force ? "forced" : "ok";
    case "unchanged":
      return "skip";
    default:
      return "fail";
  }
}

function permissionStateToMarker(s: PermissionState): Marker {
  if (s === "ok") return "ok";
  if (s === "skip") return "skip";
  return "fail";
}

function checkPhysicalScreenshotPermission(): PermissionState {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return "skip";
  const deps = defaultExternalToolDeps();
  const resolution = resolveRequirement({ kind: "executable", name: "screencapture" }, deps);
  if (resolution.status === "ok") return "ok";
  if (resolution.status === "permission-missing" || resolution.status === "missing") return "fail";
  return "skip";
}

// ─── _emit_setup_v2_ui (1482) → lib/roll-setup.py renderer ───────────────────
interface Step {
  num: number;
  label: string;
  status: string;
}

function divider(char = "─"): string {
  return c("dim", char.repeat(Math.min(COLS, 80)));
}
function stepIcon(status: string): string {
  if (status === "ok") return c("green", "✓");
  if (status === "skip") return c("amber", "↷");
  if (status === "forced") return c("blue", "~");
  if (status === "fail") return c("red", "✗", { bold: true });
  return c("dim", "·");
}

function emitSetupUi(steps: Step[]): void {
  const nFailed = steps.filter((s) => s.status === "fail").length;
  const nForced = steps.filter((s) => s.status === "forced").length;
  const nChanged = steps.filter((s) => s.status === "ok").length;

  let footerStatus: string;
  let label: string;
  let hint: string | null;
  if (nFailed) {
    footerStatus = "fail";
    label = "Setup incomplete";
    hint = null;
  } else if (nForced) {
    footerStatus = "ok";
    label = `Setup re-installed (forced — ${nForced} item${nForced !== 1 ? "s" : ""})`;
    hint = "run roll init inside a project";
  } else if (nChanged === 0) {
    footerStatus = "ok";
    label = "Setup complete (no changes)";
    hint = "everything already up to date";
  } else {
    footerStatus = "ok";
    label = `Setup complete (${nChanged} item${nChanged !== 1 ? "s" : ""} refreshed)`;
    hint = "run roll init inside a project";
  }

  const lines: string[] = [];
  const left = "  " + c("blue", "SETUP", { bold: true }) + c("dim", "  ·  ") + c("dim", "初始化");
  // setup payload has no project_path/right → right is empty (row prints left + 1 gap min).
  lines.push(row(left, ""));
  lines.push(divider());
  lines.push("");
  for (const s of steps) {
    const num = c("dim", `  ${s.num}.`);
    const icon = stepIcon(s.status);
    lines.push(`${num} ${icon}  ${s.label}`);
  }
  lines.push("");
  lines.push(divider());
  const iconColor = footerStatus === "ok" ? "green" : "red";
  const msg = c(iconColor, label);
  if (hint !== null) lines.push(`  ${msg}  —  ${hint}`);
  else lines.push(`  ${msg}`);
  lines.push(divider("═"));

  process.stdout.write(lines.join("\n") + "\n");
}

// ─── cmd_setup (1410) ─────────────────────────────────────────────────────────
/**
 * Returns the exit code for the fully ported setup surface.
 */
export async function setupCommand(args: string[]): Promise<number> {
  let force = false;
  let reselect = false;
  let noCaptureInstall = false;
  let updateCapture = false;
  let updateYes = false;
  for (const a of args) {
    if (a === "--force" || a === "-f") force = true;
    else if (a === "--reselect") reselect = true;
    else if (a === "--no-capture-install") noCaptureInstall = true;
    else if (a === "--update-capture") updateCapture = true;
    else if (a === "--yes") updateYes = true;
    else {
      // FIX-238 AC2: name the offending argument (the v2 oracle quirk that
      // dropped it is retired — an empty-name error was useless).
      err(`${m("setup.unknown_argument_1")}${a}`);
      // bash exits 1; mirror via a real return so the caller propagates it.
      return 1;
    }
  }

  if (updateCapture) {
    if (force || reselect || noCaptureInstall) {
      err("--update-capture cannot be combined with setup synchronization options");
      return 1;
    }
    const lang = msgLang();
    const result = await updateRollCapture({
      yes: updateYes,
      interactive: process.stdin.isTTY === true,
      readLine: readLineFromStdin,
      onConfirmationRequired: (details) => process.stdout.write(renderRollCaptureUpdatePrompt(details, lang)),
    });
    process.stdout.write(`${renderRollCaptureUpdateResult(result, lang)}\n`);
    return result.status === "updated" || result.status === "no-update" || result.status === "declined" || result.status === "skipped" ? 0 : 1;
  }
  if (updateYes) {
    err("--yes is only valid with --update-capture");
    return 1;
  }

  if (!existsSync(rollPkgConventions())) {
    err(m("shared.convention_source_not_found_at_2", rollPkgConventions()));
    err(m("shared.run_this_from_the_roll_repo"));
    return 1;
  }

  submoduleGuard();

  const home = rollHome();
  const aiDirsList = [".claude", ".kimi", ".kimi-code", ".codex", ".pi", ".agentrules", ".reasonix"];
  const homeDir = process.env["HOME"] ?? "";
  const aiDirs = aiDirsList.map((d) => join(homeDir, d)).join(":");

  const steps: Step[] = [];

  const s1 = runSetupStep(home, () => {
    installLocal(force);
  });
  steps.push({ num: 1, label: "Install templates & conventions to ~/.roll", status: stateToMarker(s1, force) });

  const s2 = runSetupStep(aiDirs, () => {
    syncConventions(force);
  });
  steps.push({ num: 2, label: "Sync conventions to AI tools", status: stateToMarker(s2, force) });

  const s3 = runSetupStep(aiDirs, () => {
    syncSkills(force);
  });
  steps.push({ num: 3, label: "Install skills to ~/.claude", status: stateToMarker(s3, force) });

  const s4 = runSetupStep(join(home, ".peer-state"), () => {
    peerEnsureStateDir();
  });
  steps.push({ num: 4, label: "Initialize peer-review state directory", status: stateToMarker(s4, force) });

  const s5 = runSetupStep(process.cwd(), () => {
    ensureHooksPath(process.cwd());
  });
  steps.push({ num: 5, label: "Configure git hooks path", status: stateToMarker(s5, force) });

  const s6 = checkPhysicalScreenshotPermission();
  steps.push({ num: 6, label: "Check physical screenshot permissions (Terminal.app)", status: permissionStateToMarker(s6) });

  if (tmuxPresent()) {
    steps.push({ num: 7, label: "Ensure tmux is installed (already present)", status: "skip" });
  } else {
    // _ensure_tmux best-effort install, then re-probe. The brew path is
    // darwin-only and emits nothing to stdout; if tmux still absent → fail.
    steps.push({ num: 7, label: "Ensure tmux is installed", status: tmuxPresent() ? "ok" : "fail" });
  }

  const noColor = (process.env["NO_COLOR"] ?? "") !== "" || !process.stdout.isTTY;
  renderState.useColor = !noColor;
  emitSetupUi(steps);

  // US-ONBOARD-NUDGE-006: Machine Scope supervise agent selection.
  // Runs after all setup steps; discovered installed set reflects any
  // config changes from this run (e.g. first-ever config creation).
  const { installed } = discoverInteractiveAgents();
  const currentPrimary = readPrimaryAgent();
  const isTTY = process.stdin.isTTY === true;
  const selection = selectPrimaryAgent({
    installed,
    primary: currentPrimary,
    isTTY,
    reselect,
    readLine: readLineFromStdin,
  });
  if (selection.selected !== null) {
    writeMachineAgentScope(selection.selected);
  }
  if (selection.guidance !== null) {
    process.stdout.write(`\n  ${c("dim", selection.guidance)}\n`);
  }

  const screenRecordingNotice = renderScreenRecordingSetupNotice(collectExternalTools());
  if (screenRecordingNotice !== null) process.stdout.write(screenRecordingNotice);

  const rollCaptureReadinessDeps = defaultRollCaptureReadinessDeps();
  let rollCaptureReadiness = collectRollCaptureReadiness({ ...rollCaptureReadinessDeps, refreshCache: force });
  const canonicalRollCaptureInstall = detectCanonicalRollCaptureInstall(rollCaptureReadinessDeps);
  if (!noCaptureInstall && canonicalRollCaptureInstall.status === "missing") {
    const result = await installRollCapture();
    if (result.status !== "skipped") process.stdout.write(`\n  ${renderRollCaptureInstallResult(result, msgLang())}\n`);
    rollCaptureReadiness = collectRollCaptureReadiness({ ...defaultRollCaptureReadinessDeps(), refreshCache: true });
  }
  const rollCaptureGuidance = renderRollCaptureSetupGuidance(rollCaptureReadiness, msgLang());
  if (rollCaptureGuidance !== null) process.stdout.write(rollCaptureGuidance);

  // FIX-288 AC5: `roll release` drives the merge via GitHub-native auto-merge
  // (`gh pr merge --auto --squash`). That needs "Allow auto-merge" enabled on
  // the repo; otherwise the release aborts with an honest error. Surface the
  // one-time toggle here so a first release does not hit a wall. EN and ZH on
  // separate lines (project bilingual convention — never inline-mixed).
  process.stdout.write(
    "\n" +
      `  ${c("dim", "→ For `roll release`: enable \"Allow auto-merge\" in your repo (Settings → General → Pull Requests),")}\n` +
      `  ${c("dim", "  or the release will stop and ask you to merge the PR manually.")}\n` +
      `  ${c("dim", "→ roll release 需要仓库开启 “Allow auto-merge”（Settings → General → Pull Requests），")}\n` +
      `  ${c("dim", "  否则发版会停下并提示你手动合并 PR。")}\n`,
  );
  return 0;
}
