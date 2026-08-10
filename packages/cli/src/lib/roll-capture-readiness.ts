/**
 * @responsibility Checks roll-capture readiness and repairs the install.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { t, v3Catalog, type Lang } from "@roll/spec";

export type RollCaptureOverallStatus = "available" | "degraded" | "skip";
export type RollCaptureInstallStatus = "installed" | "missing";
export type RollCapturePermissionStatus = "granted" | "denied" | "unknown" | "skipped";
export type RollCaptureInboxStatus = "writable" | "blocked" | "skipped";

export interface RollCaptureReadinessDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  interactive: boolean;
  hasAquaGUI?: boolean;
  exists: (path: string) => boolean;
  execFile: (cmd: string, args: readonly string[]) => { code: number; stdout: string; stderr: string };
  cacheReadiness?: boolean;
  refreshCache?: boolean;
  nowMs?: () => number;
}

export interface RollCaptureReadiness {
  status: RollCaptureOverallStatus;
  installed: { status: RollCaptureInstallStatus; path?: string };
  hostPermission: { status: RollCapturePermissionStatus; detail: string };
  inbox: { status: RollCaptureInboxStatus; path: string; detail: string };
  detailLines: readonly string[];
  repairCommands: readonly string[];
}

const APP_NAME = "Roll Capture.app";
const BUNDLE_ID = "com.seanyao.roll.capture";
const SYSTEM_SETTINGS_SCREEN_CAPTURE = "open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const ROLL_CAPTURE_POSITIVE_READINESS_TTL_MS = 30 * 60 * 1000;
const ROLL_CAPTURE_NEGATIVE_READINESS_TTL_MS = 60 * 1000;

export function defaultRollCaptureReadinessDeps(): RollCaptureReadinessDeps {
  const platform = externalPlatformOverride(process.env["_ROLL_EXTERNAL_TOOLS_PLATFORM"]) ?? process.platform;
  const execFile = (cmd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } => {
    const r = spawnSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return {
    platform,
    env: process.env,
    home: homedir(),
    interactive: process.stdout.isTTY === true,
    ...(platform === "darwin" && process.stdout.isTTY === true && process.env["ROLL_NO_SCREENCAP"] !== "1" && !isCi(process.env)
      ? { hasAquaGUI: macosHasAquaGUI(execFile) }
      : {}),
    exists: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    execFile,
    cacheReadiness: true,
    nowMs: () => Date.now(),
  };
}

export function collectRollCaptureReadiness(deps: RollCaptureReadinessDeps = defaultRollCaptureReadinessDeps()): RollCaptureReadiness {
  const inboxPath = rollCaptureInboxPath(deps);
  if (deps.platform !== "darwin") {
    return skipped(deps, inboxPath, "Roll Capture.app is a macOS-only physical screenshot host.");
  }
  if (deps.env["ROLL_NO_SCREENCAP"] === "1" || deps.interactive === false || isCi(deps.env)) {
    return skipped(deps, inboxPath, "Roll Capture readiness probe skipped (headless / CI / ROLL_NO_SCREENCAP).");
  }
  if (deps.hasAquaGUI === false) {
    return skipped(deps, inboxPath, "No macOS GUI session (Aqua) is available; Roll Capture probe skipped.");
  }

  const cacheKey = rollCaptureReadinessCacheKey(deps, inboxPath);
  if (deps.cacheReadiness === true && deps.refreshCache !== true) {
    const cached = readRollCaptureReadinessCache(deps, cacheKey);
    if (cached !== null) return cached;
  }

  const installed = detectRollCaptureInstall(deps);
  const hostPermission = preflightScreenCaptureAccess(deps);
  const inbox = probeInboxWritable(inboxPath);
  const degraded = installed.status !== "installed" || hostPermission.status !== "granted" || inbox.status !== "writable";
  const detailLines = [
    `installed=${installed.status}${installed.path !== undefined ? ` (${installed.path})` : ""}`,
    `hostPermission=${hostPermission.status} — ${hostPermission.detail}`,
    `hostPermission.zh=${hostPermission.status} — ${hostPermissionZhDetail(hostPermission.status)}`,
    `inbox=${inbox.status} (${inbox.path}) — ${inbox.detail}`,
  ];
  const repairCommands = [
    ...(installed.status === "missing" ? ["install Roll Capture.app to ~/Applications or /Applications"] : []),
    ...(hostPermission.status === "denied" ? [SYSTEM_SETTINGS_SCREEN_CAPTURE] : []),
  ];

  const readiness: RollCaptureReadiness = {
    status: degraded ? "degraded" : "available",
    installed,
    hostPermission,
    inbox,
    detailLines,
    repairCommands,
  };
  if (deps.cacheReadiness === true) writeRollCaptureReadinessCache(deps, cacheKey, readiness);
  return readiness;
}

export function renderRollCaptureSetupGuidance(readiness: RollCaptureReadiness, lang: Lang): string | null {
  if (readiness.status === "skip" || readiness.status === "available") return null;
  return [
    "",
    `  ! ${rollCaptureSetupText(lang, "setup.roll_capture_not_ready")}`,
    `  ${rollCaptureSetupText(lang, "setup.roll_capture_install")}`,
    `  ${rollCaptureSetupText(lang, "setup.roll_capture_permission")}`,
    `  ${rollCaptureSetupText(lang, "setup.roll_capture_inbox", readiness.inbox.path)}`,
    "",
  ].join("\n");
}

type RollCaptureSetupKey = keyof typeof ROLL_CAPTURE_SETUP_FALLBACK;

function rollCaptureSetupText(lang: Lang, key: RollCaptureSetupKey, ...args: ReadonlyArray<string | number>): string {
  const rendered = t(v3Catalog, lang, key, ...args);
  if (rendered !== key) return rendered;
  const fallback = ROLL_CAPTURE_SETUP_FALLBACK[key];
  if (fallback === undefined) return rendered;
  return t(fallback, lang, "text", ...args);
}

const ROLL_CAPTURE_SETUP_FALLBACK = {
  "setup.roll_capture_not_ready": {
    text: {
      en: "Roll Capture.app is not ready; physical screenshots will honestly skip at capture time.",
      zh: "Roll Capture.app 尚未就绪，物理截图会在捕获时降级为明确跳过。",
    },
  },
  "setup.roll_capture_install": {
    text: {
      en: "Install Roll Capture.app: place it in ~/Applications or /Applications, then open it once.",
      zh: "安装 Roll Capture.app：将它放到 ~/Applications 或 /Applications，然后打开一次。",
    },
  },
  "setup.roll_capture_permission": {
    text: {
      en: "Host permission proxy: doctor checks the current terminal host only; Roll Capture.app manages its own Screen Recording permission on first capture.",
      zh: "宿主权限代理：doctor 只检查当前终端宿主；Roll Capture.app 首次捕获时会自行管理屏幕录制权限。",
    },
  },
  "setup.roll_capture_inbox": {
    text: {
      en: "inbox: %s",
      zh: "inbox：%s",
    },
  },
} as const;

function skipped(deps: RollCaptureReadinessDeps, inboxPath: string, detail: string): RollCaptureReadiness {
  return {
    status: "skip",
    installed: detectRollCaptureInstall(deps),
    hostPermission: { status: "skipped", detail },
    inbox: { status: "skipped", path: inboxPath, detail },
    detailLines: [`skipped — ${detail}`],
    repairCommands: [],
  };
}

export function detectRollCaptureInstall(deps: Pick<RollCaptureReadinessDeps, "env" | "home" | "exists" | "execFile">): RollCaptureReadiness["installed"] {
  const canonical = detectCanonicalRollCaptureInstall(deps);
  if (canonical.status === "installed") return canonical;
  const candidates = [
    deps.env["ROLL_CAPTURE_APP"],
  ].filter((path): path is string => path !== undefined && path.trim() !== "");
  for (const candidate of candidates) {
    if (deps.exists(candidate)) return { status: "installed", path: candidate };
  }
  const mdfind = deps.execFile("mdfind", [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`]);
  if (mdfind.code === 0) {
    const found = mdfind.stdout.split("\n").map((line) => line.trim()).find((line) => line.endsWith(APP_NAME));
    if (found !== undefined && deps.exists(found)) return { status: "installed", path: found };
  }
  return { status: "missing" };
}

export function detectCanonicalRollCaptureInstall(deps: Pick<RollCaptureReadinessDeps, "home" | "exists">): RollCaptureReadiness["installed"] {
  for (const candidate of [join(deps.home, "Applications", APP_NAME), join("/Applications", APP_NAME)]) {
    if (deps.exists(candidate)) return { status: "installed", path: candidate };
  }
  return { status: "missing" };
}

function preflightScreenCaptureAccess(deps: RollCaptureReadinessDeps): RollCaptureReadiness["hostPermission"] {
  const script = "import CoreGraphics; print(CGPreflightScreenCaptureAccess() ? \"true\" : \"false\")";
  const r = deps.execFile("swift", ["-e", script]);
  if (r.code !== 0) {
    return {
      status: "unknown",
      detail:
        "host permission proxy: CGPreflightScreenCaptureAccess could not run for the current host process; Roll Capture.app manages its own Screen Recording permission on first capture.",
    };
  }
  return r.stdout.trim() === "true"
    ? {
        status: "granted",
        detail:
          "host permission proxy: CGPreflightScreenCaptureAccess returned true for the current host process; Roll Capture.app manages its own Screen Recording permission on first capture.",
      }
    : {
        status: "denied",
        detail:
          "host permission proxy: CGPreflightScreenCaptureAccess returned false for the current host process; Roll Capture.app manages its own Screen Recording permission on first capture.",
      };
}

function probeInboxWritable(path: string): RollCaptureReadiness["inbox"] {
  try {
    // Synchronous file IO can still hang on a pathological filesystem. We keep
    // this probe simple because the inbox lives on the local Application Support
    // path and adding timeout machinery would make the common path noisier than
    // the rare failure it mitigates.
    mkdirSync(path, { recursive: true });
    const requestId = `probe-${process.pid}-${Date.now()}`;
    const finalPath = join(path, `request-${requestId}.json`);
    const tempPath = join(path, `.request-${requestId}.json.tmp`);
    writeFileSync(tempPath, "{}\n");
    renameSync(tempPath, finalPath);
    rmSync(finalPath, { force: true });
    return { status: "writable", path, detail: "temp-file atomic write succeeded." };
  } catch (error) {
    return { status: "blocked", path, detail: error instanceof Error ? error.message : String(error) };
  }
}

function rollCaptureInboxPath(deps: RollCaptureReadinessDeps): string {
  const root = deps.env["ROLL_CAPTURE_HOME"] ?? join(deps.home, "Library", "Application Support", "Roll Capture");
  return join(root, "inbox");
}

function macosHasAquaGUI(execFile: RollCaptureReadinessDeps["execFile"]): boolean {
  const r = execFile("launchctl", ["managername"]);
  return r.code === 0 && r.stdout.includes("Aqua");
}

function externalPlatformOverride(raw: string | undefined): NodeJS.Platform | undefined {
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

function isCi(env: NodeJS.ProcessEnv): boolean {
  return (
    (env["CI"] ?? "").trim() !== "" ||
    (env["GITHUB_ACTIONS"] ?? "").trim() !== "" ||
    (env["GITLAB_CI"] ?? "").trim() !== "" ||
    (env["JENKINS_HOME"] ?? "").trim() !== ""
  );
}

function hostPermissionZhDetail(status: RollCapturePermissionStatus): string {
  const result = status === "granted" ? "true" : status === "denied" ? "false" : "unknown";
  return `宿主权限代理：CGPreflightScreenCaptureAccess 对当前宿主进程返回 ${result}；Roll Capture.app 首次捕获时会自行管理屏幕录制权限。`;
}

function rollCaptureReadinessCachePath(deps: Pick<RollCaptureReadinessDeps, "env" | "home">): string {
  const rollHome = (deps.env["ROLL_HOME"] ?? "").trim() || join(deps.home, ".roll");
  return join(rollHome, "cache", "roll-capture-readiness.json");
}

export function invalidateRollCaptureReadinessCache(deps: Pick<RollCaptureReadinessDeps, "env" | "home">): void {
  rmSync(rollCaptureReadinessCachePath(deps), { force: true });
}

function rollCaptureReadinessCacheKey(deps: RollCaptureReadinessDeps, inboxPath: string): string {
  return JSON.stringify({
    platform: deps.platform,
    home: deps.home,
    app: deps.env["ROLL_CAPTURE_APP"] ?? "",
    captureHome: deps.env["ROLL_CAPTURE_HOME"] ?? "",
    inboxPath,
  });
}

function nowMs(deps: RollCaptureReadinessDeps): number {
  return deps.nowMs?.() ?? Date.now();
}

function readRollCaptureReadinessCache(deps: RollCaptureReadinessDeps, cacheKey: string): RollCaptureReadiness | null {
  try {
    const parsed = JSON.parse(readFileSync(rollCaptureReadinessCachePath(deps), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (row["version"] !== 1 || row["cacheKey"] !== cacheKey) return null;
    const checkedAtMs = row["checkedAtMs"];
    const readiness = row["readiness"];
    if (!isRollCaptureReadiness(readiness)) return null;
    const ageMs = typeof checkedAtMs === "number" ? nowMs(deps) - checkedAtMs : Number.NaN;
    // Negative states (missing/denied/blocked/unknown) get a short TTL so a
    // newly granted permission or install becomes visible quickly. Positive
    // states keep a long TTL to avoid repeated probes and macOS permission UI.
    const ttlMs = readiness.status === "available" ? ROLL_CAPTURE_POSITIVE_READINESS_TTL_MS : ROLL_CAPTURE_NEGATIVE_READINESS_TTL_MS;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= ttlMs) return null;
    return readiness;
  } catch {
    return null;
  }
}

function writeRollCaptureReadinessCache(deps: RollCaptureReadinessDeps, cacheKey: string, readiness: RollCaptureReadiness): void {
  const path = rollCaptureReadinessCachePath(deps);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      tmpPath,
      JSON.stringify(
        {
          version: 1,
          cacheKey,
          checkedAtMs: nowMs(deps),
          readiness,
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
  }
}

function isRollCaptureReadiness(value: unknown): value is RollCaptureReadiness {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row["status"] !== "available" && row["status"] !== "degraded" && row["status"] !== "skip") return false;
  if (!isRecord(row["installed"]) || !isRecord(row["hostPermission"]) || !isRecord(row["inbox"])) return false;
  return Array.isArray(row["detailLines"]) && Array.isArray(row["repairCommands"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
