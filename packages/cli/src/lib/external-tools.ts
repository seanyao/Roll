/**
 * @responsibility Checks external tool availability and versions for command preflight.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PLAYWRIGHT_INSTALL_CHROMIUM, chromiumInstalled, PLAYWRIGHT_VERSION, PLAYWRIGHT_PIN } from "@roll/infra";
import type { ToolRequirement, ToolRequirementResolution, ToolRequirementStatus } from "@roll/spec";

export type ExternalRequirementStatus = ToolRequirementStatus;

export interface ExternalRequirementDeclaration {
  id: string;
  requirement: ToolRequirement;
  label: string;
  purpose: string;
  required: boolean;
  install: string;
  authorize: string;
  impact: string;
}

export interface ExternalRequirementState extends ExternalRequirementDeclaration {
  status: ExternalRequirementStatus;
  detail: string;
  repairCommand?: string;
}

export interface ExternalToolDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  commandOnPath: (bin: string) => boolean;
  execFile: (cmd: string, args: readonly string[]) => { code: number; stdout: string; stderr: string };
  readDir: (path: string) => string[];
  exists: (path: string) => boolean;
  /** FIX-927: false ⇒ headless/unattended (non-TTY) — skip the Screen Recording probe. */
  interactive?: boolean;
  /** macOS Aqua GUI session availability. false means a real window capture cannot be preflighted. */
  hasAquaGUI?: boolean;
  /** US-INIT-003: doctor/setup cache a successful Terminal.app Screen Recording probe. */
  cacheScreenRecording?: boolean;
}

export type ScreenRecordingPreflightStatus = "ok" | "skip" | "permission-missing" | "missing-tool";

export interface ScreenRecordingPreflightResult {
  status: ScreenRecordingPreflightStatus;
  detail: string;
  cached: boolean;
  repairCommand?: string;
}

export const EXTERNAL_REQUIREMENT_DECLARATIONS: readonly ExternalRequirementDeclaration[] = [
  {
    id: "screencapture",
    requirement: { kind: "executable", name: "screencapture", optional: true },
    label: "macOS screencapture",
    purpose: "Physical Terminal.app and browser-window screenshot evidence on macOS.",
    required: false,
    install: "Built into macOS.",
    authorize: "Open System Settings > Privacy & Security > Screen Recording and allow Terminal.app (the stable roll capture host).",
    impact: "Attest screenshots are skipped; headless, transcript-rendered, and HTML-reproduction images do not count as screenshot evidence.",
  },
  {
    id: "playwright-chromium",
    requirement: { kind: "executable", name: "playwright-chromium", optional: true },
    label: "Playwright Chromium",
    purpose: "Headless browser screenshots for non-attest diagnostics and tool use.",
    required: false,
    install: PLAYWRIGHT_INSTALL_CHROMIUM,
    authorize: "No OS permission needed.",
    impact: "Headless browser diagnostic screenshots are unavailable; attest screenshot evidence still requires physical capture.",
  },
];

/** @deprecated Use ExternalRequirementStatus. Kept for old call sites while the dependency layer is renamed. */
export type ExternalToolStatus = ExternalRequirementStatus;
/** @deprecated Use ExternalRequirementDeclaration. */
export type ExternalToolDeclaration = ExternalRequirementDeclaration;
/** @deprecated Use ExternalRequirementState. */
export type ExternalToolState = ExternalRequirementState;
/** @deprecated Use EXTERNAL_REQUIREMENT_DECLARATIONS. */
export const EXTERNAL_TOOL_DECLARATIONS = EXTERNAL_REQUIREMENT_DECLARATIONS;

export function defaultExternalToolDeps(): ExternalToolDeps {
  const platform = externalToolPlatform(process.env["_ROLL_EXTERNAL_TOOLS_PLATFORM"]) ?? process.platform;
  const interactive = process.stdout.isTTY === true;
  const execFile = (cmd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } => {
    const r = spawnSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return {
    platform,
    env: process.env,
    home: homedir(),
    // FIX-927: a non-TTY stdout (launchd lane / CI / piped) is headless → skip the probe.
    interactive,
    commandOnPath,
    execFile,
    readDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    exists: existsSync,
    ...(platform === "darwin" && interactive && process.env["ROLL_NO_SCREENCAP"] !== "1" ? { hasAquaGUI: macosHasAquaGUI(execFile) } : {}),
    cacheScreenRecording: true,
  };
}

function macosHasAquaGUI(execFile: ExternalToolDeps["execFile"]): boolean {
  const r = execFile("launchctl", ["managername"]);
  return r.code === 0 && r.stdout.includes("Aqua");
}

function externalToolPlatform(raw: string | undefined): NodeJS.Platform | undefined {
  if (
    raw === "aix" ||
    raw === "android" ||
    raw === "darwin" ||
    raw === "freebsd" ||
    raw === "haiku" ||
    raw === "linux" ||
    raw === "openbsd" ||
    raw === "sunos" ||
    raw === "win32" ||
    raw === "cygwin" ||
    raw === "netbsd"
  ) {
    return raw;
  }
  return undefined;
}

export function commandOnPath(bin: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

export function collectExternalRequirements(deps: ExternalToolDeps = defaultExternalToolDeps()): ExternalRequirementState[] {
  return EXTERNAL_REQUIREMENT_DECLARATIONS.map((decl) => toExternalRequirementState(decl, resolveRequirement(decl.requirement, deps)));
}

/** @deprecated Use collectExternalRequirements. */
export function collectExternalTools(deps: ExternalToolDeps = defaultExternalToolDeps()): ExternalToolState[] {
  return collectExternalRequirements(deps);
}

export function resolveRequirement(requirement: ToolRequirement, deps: ExternalToolDeps = defaultExternalToolDeps()): ToolRequirementResolution {
  if (requirement.kind === "executable" && requirement.name === "playwright-chromium") {
    return playwrightChromiumResolution(requirement, deps);
  }
  if (requirement.kind === "executable" && requirement.name === "screencapture") {
    return screencaptureResolution(requirement, deps);
  }
  if (requirement.kind === "executable" && requirement.name === "system-shell") {
    return deps.commandOnPath("sh") || deps.commandOnPath("bash") || (deps.env["SHELL"] ?? "").trim() !== ""
      ? { requirement, status: "ok", detail: "A system shell is available." }
      : {
          requirement,
          status: "missing",
          detail: "No system shell was found.",
          repair: { command: "install sh or bash and ensure it is on PATH", description: "Install a POSIX-compatible shell." },
        };
  }
  if (requirement.kind === "executable") {
    const repair = executableRepair(requirement.name);
    return deps.commandOnPath(requirement.name)
      ? { requirement, status: "ok", detail: `${requirement.name} is on PATH.` }
      : { requirement, status: "missing", detail: `${requirement.name} is not on PATH.`, ...(repair !== undefined ? { repair } : {}) };
  }
  if (requirement.kind === "env") {
    return (deps.env[requirement.name] ?? "").trim() !== ""
      ? { requirement, status: "ok", detail: `${requirement.name} is set.` }
      : { requirement, status: "missing", detail: `${requirement.name} is not set.` };
  }
  if (requirement.kind === "service" && requirement.name === "roll-capture-app") {
    return rollCaptureAppResolution(requirement, deps);
  }
  return {
    requirement,
    status: "stale",
    detail: `No live detector is registered for service requirement ${requirement.name}.`,
  };
}

function executableRepair(name: string): { command: string; description?: string } | undefined {
  if (name === "git") return { command: "brew install git", description: "Install Git and ensure it is on PATH." };
  if (name === "gh") return { command: "brew install gh", description: "Install the GitHub CLI and authenticate with gh auth login." };
  if (name === "npx") return { command: "npm install -g npm", description: "Install npm/npx." };
  return undefined;
}

function toExternalRequirementState(decl: ExternalRequirementDeclaration, resolution: ToolRequirementResolution): ExternalRequirementState {
  return {
    ...decl,
    status: resolution.status,
    detail: resolution.detail,
    ...(resolution.repair !== undefined ? { repairCommand: resolution.repair.command } : {}),
  };
}

export function screenRecordingPreflight(deps: ExternalToolDeps = defaultExternalToolDeps()): ScreenRecordingPreflightResult {
  if (deps.platform !== "darwin") {
    return { status: "skip", detail: "macOS-only requirement; not applicable on this host.", cached: false };
  }
  if (!deps.commandOnPath("screencapture")) {
    return {
      status: "missing-tool",
      detail: "screencapture is not on PATH.",
      cached: false,
      repairCommand: "xcode-select --install",
    };
  }
  // FIX-927: never probe in a headless / unattended context. The probe is a real
  // `screencapture` (1×1 px) that re-fires — and BLOCKS on — the macOS TCC Screen
  // Recording prompt with no one to answer it; every `roll loop go` / `roll doctor`
  // cycle would stack another dialog. `ROLL_NO_SCREENCAP=1` is the explicit escape
  // hatch; `interactive === false` (a non-TTY stdout, set in defaultExternalToolDeps)
  // covers the launchd lane / CI. Real captures still alert on failure (the runtime
  // attest gate), so skipping the readiness probe loses no safety.
  if (deps.env["ROLL_NO_SCREENCAP"] === "1" || deps.interactive === false) {
    const cached = deps.cacheScreenRecording === true && readScreenRecordingCache(deps);
    if (cached && deps.env["ROLL_NO_SCREENCAP"] !== "1") {
      return {
        status: "ok",
        detail: "Terminal.app Screen Recording readiness is cached; restart Terminal.app if macOS recently granted permission.",
        cached: true,
      };
    }
    return {
      status: "skip",
      detail: "Screen Recording probe skipped (headless / ROLL_NO_SCREENCAP); real captures surface permission failures at capture time.",
      cached: false,
    };
  }
  if (deps.cacheScreenRecording === true && readScreenRecordingCache(deps)) {
    return {
      status: "ok",
      detail: "Terminal.app Screen Recording readiness is cached; restart Terminal.app if macOS recently granted permission.",
      cached: true,
    };
  }
  if (deps.hasAquaGUI === false) {
    return {
      status: "skip",
      detail: "No macOS GUI session (Aqua) is available; Screen Recording preflight skipped.",
      cached: false,
    };
  }
  const tmp = join(mkdtempSync(join(tmpdir(), "roll-screen-probe-")), "probe.png");
  const r = deps.execFile("screencapture", ["-x", "-R", "0,0,1,1", tmp]);
  const capturedPixels = fileNonEmpty(tmp);
  try {
    rmSync(tmp, { force: true });
    rmSync(dirname(tmp), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  if (r.code === 0 && capturedPixels) {
    if (deps.cacheScreenRecording === true) writeScreenRecordingCache(deps);
    return { status: "ok", detail: "Installed and Screen Recording permission is usable for Terminal.app.", cached: false };
  }
  if (r.code === 0) {
    return {
      status: "skip",
      detail: "screencapture reported success but produced no pixels; Terminal.app Screen Recording readiness was not cached.",
      cached: false,
    };
  }
  const command = "open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  return {
    status: "permission-missing",
    detail: "screencapture ran but could not capture pixels; Screen Recording permission is likely missing. If permission was recently granted, restart Terminal.app.",
    cached: false,
    repairCommand: command,
  };
}

function screencaptureResolution(requirement: ToolRequirement, deps: ExternalToolDeps): ToolRequirementResolution {
  const preflight = screenRecordingPreflight(deps);
  switch (preflight.status) {
    case "ok":
      return { requirement, status: "ok", detail: preflight.detail };
    case "skip":
      return { requirement, status: "stale", detail: preflight.detail };
    case "missing-tool": {
      const command = preflight.repairCommand ?? "xcode-select --install";
      return {
        requirement,
        status: "missing",
        detail: preflight.detail,
        repair: { command, description: "Install Apple command line tools." },
      };
    }
    case "permission-missing": {
      const command = preflight.repairCommand ?? "";
      return {
        requirement,
        status: "permission-missing",
        detail: preflight.detail,
        repair: { command, description: "Open Screen Recording privacy settings." },
        authorize: { command, description: "Allow Terminal.app, the stable roll capture host, to record the screen." },
      };
    }
  }
}

function rollCaptureAppResolution(requirement: ToolRequirement, deps: ExternalToolDeps): ToolRequirementResolution {
  if (deps.platform !== "darwin") {
    return { requirement, status: "stale", detail: "macOS-only requirement; not applicable on this host." };
  }
  return {
    requirement,
    status: "missing",
    detail: "Roll Capture.app is not detected; install or start the capture service before requesting physical screenshots.",
  };
}

function fileNonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function screenRecordingCachePath(deps: ExternalToolDeps): string {
  const rollHome = (deps.env["ROLL_HOME"] ?? "").trim() || join(deps.home, ".roll");
  return join(rollHome, "cache", "terminal-screen-recording.json");
}

function readScreenRecordingCache(deps: ExternalToolDeps): boolean {
  const path = screenRecordingCachePath(deps);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const row = parsed as Record<string, unknown>;
    return row["version"] === 1 && row["platform"] === "darwin" && row["app"] === "Terminal.app" && row["status"] === "ok";
  } catch {
    return false;
  }
}

function writeScreenRecordingCache(deps: ExternalToolDeps): void {
  const path = screenRecordingCachePath(deps);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      tmpPath,
      JSON.stringify(
        {
          version: 1,
          platform: "darwin",
          app: "Terminal.app",
          status: "ok",
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    renameSync(tmpPath, path);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup failures */
    }
    /* cache is an optimization; capture failures still surface at attest time */
  }
}
function playwrightChromiumResolution(requirement: ToolRequirement, deps: ExternalToolDeps): ToolRequirementResolution {
  if (!deps.commandOnPath("npx")) {
    return {
      requirement,
      status: "missing",
      detail: "npx is not on PATH.",
      repair: { command: "npm install -g npm", description: "Install npm/npx." },
    };
  }
  const cache = deps.env["PLAYWRIGHT_BROWSERS_PATH"] ?? defaultPlaywrightBrowsersPath(deps);
  const entries = deps.readDir(cache);
  const hasChromium = entries.some((name) => /^chromium(-|_headless_shell-|$)/.test(name) || /^chromium_headless_shell-/.test(name)) || deps.exists(join(cache, "chromium"));
  if (hasChromium) {
    return { requirement, status: "ok", detail: `Chromium browser files found in ${cache} (playwright pinned v${PLAYWRIGHT_VERSION}).` };
  }
  return {
    requirement,
    status: "missing",
    detail: `No Chromium browser files found in ${cache} (playwright pinned v${PLAYWRIGHT_VERSION}).`,
    repair: { command: PLAYWRIGHT_INSTALL_CHROMIUM, description: "Install the pinned Playwright Chromium browser." },
  };
}

function defaultPlaywrightBrowsersPath(deps: ExternalToolDeps): string {
  if (deps.platform === "darwin") return join(deps.home, "Library", "Caches", "ms-playwright");
  if (deps.platform === "win32") return join(deps.env["LOCALAPPDATA"] ?? join(deps.home, "AppData", "Local"), "ms-playwright");
  return join(deps.home, ".cache", "ms-playwright");
}

export function renderExternalRequirementDoctorSection(states: readonly ExternalRequirementState[]): string[] {
  const lines = ["", "External requirements", "外部依赖", ""];
  for (const requirement of states) {
    const marker = requirement.status === "ok" ? "✓" : requirement.status === "permission-missing" ? "!" : requirement.status === "missing" ? "−" : "?";
    lines.push(`  ${marker} ${requirement.label} — ${requirement.status}`);
    lines.push(`    use: ${requirement.purpose}`);
    lines.push(`    ${requirement.detail}`);
    if (requirement.repairCommand !== undefined) lines.push(`    fix: ${requirement.repairCommand}`);
    if (requirement.status !== "ok") lines.push(`    impact: ${requirement.impact}`);
  }
  return lines;
}

/** @deprecated Use renderExternalRequirementDoctorSection. */
export function renderExternalToolDoctorSection(states: readonly ExternalToolState[]): string[] {
  return renderExternalRequirementDoctorSection(states);
}

export interface ExternalToolRequestDeps {
  states: () => ExternalToolState[];
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readLine: () => string | null;
  execFile: (cmd: string, args: readonly string[]) => { code: number };
}

export function defaultExternalToolRequestDeps(): ExternalToolRequestDeps {
  return {
    states: () => collectExternalTools(),
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readLine: readStdinLine,
    execFile: (cmd, args) => {
      try {
        execFileSync(cmd, [...args], { stdio: "ignore" });
        return { code: 0 };
      } catch {
        return { code: 1 };
      }
    },
  };
}

function readStdinLine(): string | null {
  const fd = process.stdin.fd;
  if (fd === undefined) return null;
  const buf = Buffer.alloc(1024);
  try {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) return null;
    return buf.toString("utf8", 0, n).split(/\r?\n/, 1)[0] ?? "";
  } catch {
    return null;
  }
}

export function guideExternalToolSetup(
  surface: "init" | "go",
  deps: ExternalToolRequestDeps = defaultExternalToolRequestDeps(),
): void {
  const missing = deps.states().filter((s) => s.status !== "ok");
  if (missing.length === 0) return;
  const forced = (deps.env["ROLL_EXTERNAL_TOOLS"] ?? "").trim().toLowerCase();
  if (forced === "" && !deps.stdinIsTTY) return;
  deps.stderr(`[roll] External requirement setup (${surface})`);
  for (const requirement of missing) {
    deps.stderr(`  ${requirement.label}: ${requirement.status}`);
    deps.stderr(`    impact: ${requirement.impact}`);
    if (requirement.repairCommand !== undefined) deps.stderr(`    fix: ${requirement.repairCommand}`);
  }
  const answer =
    forced === "yes" || forced === "y"
      ? "y"
      : forced === "no" || forced === "n"
        ? "n"
        : deps.stdinIsTTY
          ? (deps.stderr("  Install/open missing tools now? [y/N]"), deps.readLine())
          : null;
  if (answer === null) {
    deps.stderr("  non-interactive: continuing without changes; evidence may be degraded.");
    return;
  }
  if (!/^y(es)?$/i.test(answer.trim())) {
    deps.stderr("  declined: continuing without changes; evidence may be degraded.");
    return;
  }
  for (const requirement of missing) {
    if (requirement.repairCommand === undefined) continue;
    const [cmd, ...args] = requirement.repairCommand.split(" ");
    if (cmd === undefined || cmd === "") continue;
    const r = deps.execFile(cmd, args);
    deps.stderr(`  ${requirement.label}: ${r.code === 0 ? "repair command started" : "repair command failed"}`);
  }
}

/**
 * FIX-394 AC2 — best-effort silent Chromium pre-install. Called during init
 * and at the start of every unattended loop cycle. When Chromium is already
 * cached the call is a cheap no-op (a readdir + exist check). When missing and
 * npx is reachable, runs `PLAYWRIGHT_INSTALL_CHROMIUM` with a generous timeout
 * and swallows all errors — this is an optional tool, never a hard gate.
 *
 * Returns `true` when Chromium was installed (or was already present), `false`
 * when the attempt failed or was skipped.
 */
export function silentPreinstallChromium(env: NodeJS.ProcessEnv = process.env): boolean {
  if (chromiumInstalled()) return true;
  // Skip entirely when the owner opted out.
  if ((env["ROLL_ATTEST_NO_BROWSER"] ?? "") === "1") return false;
  try {
    const r = spawnSync("npx", ["-y", PLAYWRIGHT_PIN, "install", "chromium"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000, // 5 min — Chromium download can be large
      env,
    });
    return r.status === 0 && chromiumInstalled();
  } catch {
    return false;
  }
}


/**
 * FIX-394 AC6 — whether the browser tool is usable on this host.
 * The browser tool (headless Chromium diagnostics / console / DOM query) depends
 * on chromium being installed. When chromium is absent, the Tools page marks the
 * browser diagnostic tool as degraded. Attest screenshots use physical capture.
 */
export function browserToolAvailable(): boolean {
  return chromiumInstalled();
}
