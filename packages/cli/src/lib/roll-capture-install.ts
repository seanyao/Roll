import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLang, type Lang } from "@roll/spec";
import { detectCanonicalRollCaptureInstall, invalidateRollCaptureReadinessCache } from "./roll-capture-readiness.js";

const RELEASE_API = "https://api.github.com/repos/seanyao/roll-capture/releases/latest";
const ASSET_NAME = "Roll-Capture.app.zip";
const APP_NAME = "Roll Capture.app";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const UPDATE_HINT_TIMEOUT_MS = 1_500;
const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000;
const ROOT_INSTALL_SKIP_REASON = "run roll setup as a regular user to install Roll Capture.app";

export interface RollCaptureReleaseAsset {
  name: string;
  size: number;
  apiUrl?: string;
  browserDownloadUrl: string;
}

export interface RollCaptureRelease {
  tagName: string;
  assets: readonly RollCaptureReleaseAsset[];
}

export type RollCaptureInstallStatus = "installed" | "already-installed" | "skipped" | "manual";
export type RollCaptureUpdateStatus = "updated" | "no-update" | "declined" | "skipped" | "manual";

export interface RollCaptureInstallResult {
  status: RollCaptureInstallStatus;
  reason: string;
  appPath?: string;
  releaseTag?: string;
  installedVersion?: string;
  updateAvailable?: boolean;
}

/** The result of the deliberately opt-in Capture.app update path. */
export interface RollCaptureUpdateResult {
  status: RollCaptureUpdateStatus;
  reason: string;
  appPath?: string;
  releaseTag?: string;
  installedVersion?: string;
}

export interface RollCaptureUpdateOptions {
  /** `--yes` is the only non-interactive confirmation. */
  yes?: boolean;
  /** Tests and embedders supply the actual terminal capability explicitly. */
  interactive?: boolean;
  /** Called only after the candidate, installed version, and target are known. */
  readLine?: () => string | null;
  /** Invoked immediately before stdin is read, after the asset is known usable. */
  onConfirmationRequired?: (details: Pick<RollCaptureUpdateResult, "appPath" | "releaseTag" | "installedVersion">) => void;
}

export interface RollCaptureInstallDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  uid?: number;
  hasAquaGUI?: boolean;
  exists: (path: string) => boolean;
  renamePath?: (from: string, to: string) => void;
  execFile: (cmd: string, args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }) => { code: number; stdout: string; stderr: string };
  fetchLatestRelease: (timeoutMs: number) => Promise<RollCaptureRelease>;
  downloadAsset: (asset: RollCaptureReleaseAsset, timeoutMs: number) => Promise<Uint8Array>;
  extractZip: (zipPath: string, destination: string, timeoutMs: number) => Promise<{ ok: true } | { ok: false; detail: string }>;
}

export function defaultRollCaptureInstallDeps(): RollCaptureInstallDeps {
  const platform = externalPlatformOverride(process.env["_ROLL_EXTERNAL_TOOLS_PLATFORM"]) ?? process.platform;
  const execFile: RollCaptureInstallDeps["execFile"] = (cmd, args, opts) => {
    const r = spawnSync(cmd, [...args], {
      cwd: opts?.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts?.timeoutMs ?? 15_000,
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return {
    platform,
    env: process.env,
    home: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    ...(platform === "darwin" && !isCi(process.env) && process.env["ROLL_SKIP_CAPTURE_INSTALL"] !== "1"
      ? { hasAquaGUI: macosHasAquaGUI(execFile) }
      : {}),
    exists: existsSync,
    renamePath: renameSync,
    execFile,
    fetchLatestRelease: (timeoutMs) => defaultFetchLatestRelease(timeoutMs, process.env, execFile),
    downloadAsset: (asset, timeoutMs) => defaultDownloadAsset(asset, timeoutMs, process.env, execFile),
    extractZip: async (zipPath, destination, timeoutMs) => extractZip(zipPath, destination, execFile, timeoutMs),
  };
}

export async function installRollCapture(deps: RollCaptureInstallDeps = defaultRollCaptureInstallDeps()): Promise<RollCaptureInstallResult> {
  const gate = installGate(deps);
  if (gate !== null) return gate;

  const installed = detectCanonicalRollCaptureInstall(deps);
  if (installed.status === "installed") {
    const appPath = installed.path;
    invalidateRollCaptureReadinessCache(deps);
    const installedVersion = appPath === undefined ? undefined : readInstalledVersion(appPath, deps);
    const update = await latestReleaseHint(deps, installedVersion);
    return {
      status: "already-installed",
      reason: "installed",
      ...(appPath !== undefined ? { appPath } : {}),
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      ...(update.releaseTag !== undefined ? { releaseTag: update.releaseTag } : {}),
      updateAvailable: update.updateAvailable,
    };
  }

  const deadlineMs = Date.now() + DOWNLOAD_TIMEOUT_MS;
  const remainingMs = () => Math.max(1, deadlineMs - Date.now());

  let release: RollCaptureRelease;
  try {
    release = await deps.fetchLatestRelease(remainingMs());
  } catch (error) {
    return manual(`release lookup failed: ${errorMessage(error)}`);
  }

  const asset = release.assets.find((candidate) => candidate.name === ASSET_NAME);
  if (asset === undefined) return manual(`latest release has no ${ASSET_NAME} asset`);

  let bytes: Uint8Array;
  try {
    bytes = await deps.downloadAsset(asset, remainingMs());
  } catch (error) {
    return manual(`download failed: ${errorMessage(error)}`, release.tagName);
  }
  if (bytes.byteLength !== asset.size) {
    return manual(`download size mismatch: expected ${asset.size} bytes, got ${bytes.byteLength}`, release.tagName);
  }

  const applicationsDir = join(deps.home, "Applications");
  const targetApp = join(applicationsDir, APP_NAME);
  mkdirSync(applicationsDir, { recursive: true });
  const workDir = mkdtempSync(join(applicationsDir, ".roll-capture-install-"));
  const zipPath = join(workDir, ASSET_NAME);
  const extractDir = join(workDir, "extract");
  try {
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(zipPath, bytes);
    const extracted = await deps.extractZip(zipPath, extractDir, remainingMs());
    if (!extracted.ok) return manual(extracted.detail, release.tagName);
    const app = findExtractedApp(extractDir);
    if (app === null) return manual("zip did not contain Roll Capture.app", release.tagName);
    const executable = findBundleExecutable(app);
    if (executable === null) return manual("Roll Capture.app has no executable in Contents/MacOS", release.tagName);
    chmodSync(executable, statSync(executable).mode | 0o111);
    replaceAppAtomically(app, targetApp, deps);
    invalidateRollCaptureReadinessCache(deps);
    // TODO: once Roll Capture is signed/notarized, verify the Developer ID
    // certificate here before moving the bundle into place.
    return { status: "installed", reason: "installed", appPath: targetApp, releaseTag: release.tagName };
  } catch (error) {
    return manual(`install failed: ${errorMessage(error)}`, release.tagName);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Update the canonical per-user Capture.app bundle, but only after a separate
 * explicit confirmation. This intentionally does not share the postinstall
 * behaviour: seeing a newer release is never consent to replace an app.
 */
export async function updateRollCapture(
  opts: RollCaptureUpdateOptions = {},
  deps: RollCaptureInstallDeps = defaultRollCaptureInstallDeps(),
): Promise<RollCaptureUpdateResult> {
  const gate = installGate(deps);
  if (gate !== null) return { status: "skipped", reason: gate.reason };

  const targetApp = join(deps.home, "Applications", APP_NAME);
  if (!deps.exists(targetApp)) {
    return { status: "manual", reason: "no Roll Capture.app is installed in ~/Applications", appPath: targetApp };
  }
  const installedVersion = readInstalledVersion(targetApp, deps);
  if (installedVersion === undefined || normalizeVersion(installedVersion) === "") {
    return { status: "manual", reason: "installed Roll Capture.app has no readable version", appPath: targetApp };
  }

  const deadlineMs = Date.now() + DOWNLOAD_TIMEOUT_MS;
  const remainingMs = () => Math.max(1, deadlineMs - Date.now());
  let release: RollCaptureRelease;
  try {
    release = await deps.fetchLatestRelease(remainingMs());
  } catch (error) {
    return updateManual(`release lookup failed: ${errorMessage(error)}`, targetApp, installedVersion);
  }
  const candidateVersion = normalizeVersion(release.tagName);
  if (!isNewerVersion(candidateVersion, normalizeVersion(installedVersion))) {
    return {
      status: "no-update",
      reason: candidateVersion === "" ? "latest release has no usable version" : "installed version is current or newer",
      appPath: targetApp,
      releaseTag: release.tagName,
      installedVersion,
    };
  }
  const asset = release.assets.find((candidate) => candidate.name === ASSET_NAME);
  if (asset === undefined) return updateManual(`latest release has no ${ASSET_NAME} asset`, targetApp, installedVersion, release.tagName);

  const interactive = opts.interactive ?? process.stdin.isTTY === true;
  if (opts.yes !== true && interactive) {
    opts.onConfirmationRequired?.({ appPath: targetApp, releaseTag: release.tagName, installedVersion });
  }
  const accepted = opts.yes === true || (interactive && (opts.readLine?.() ?? "").trim().toLowerCase() === "y");
  if (!accepted) {
    const reason = opts.yes === true ? "confirmation failed" : interactive ? "update was not confirmed" : "use --yes in a non-interactive terminal";
    return { status: "declined", reason, appPath: targetApp, releaseTag: release.tagName, installedVersion };
  }

  try {
    const bytes = await deps.downloadAsset(asset, remainingMs());
    if (bytes.byteLength !== asset.size) {
      return updateManual(`download size mismatch: expected ${asset.size} bytes, got ${bytes.byteLength}`, targetApp, installedVersion, release.tagName);
    }
    const workDir = mkdtempSync(join(deps.home, "Applications", ".roll-capture-update-"));
    const zipPath = join(workDir, ASSET_NAME);
    const extractDir = join(workDir, "extract");
    try {
      mkdirSync(extractDir, { recursive: true });
      writeFileSync(zipPath, bytes);
      const extracted = await deps.extractZip(zipPath, extractDir, remainingMs());
      if (!extracted.ok) return updateManual(extracted.detail, targetApp, installedVersion, release.tagName);
      const app = findExtractedApp(extractDir);
      if (app === null) return updateManual("zip did not contain Roll Capture.app", targetApp, installedVersion, release.tagName);
      const executable = findBundleExecutable(app);
      if (executable === null) return updateManual("Roll Capture.app has no executable in Contents/MacOS", targetApp, installedVersion, release.tagName);
      chmodSync(executable, statSync(executable).mode | 0o111);
      replaceAppAtomically(app, targetApp, deps);
      invalidateRollCaptureReadinessCache(deps);
      return { status: "updated", reason: "updated", appPath: targetApp, releaseTag: release.tagName, installedVersion };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    return updateManual(`update failed: ${errorMessage(error)}`, targetApp, installedVersion, release.tagName);
  }
}

export function renderRollCaptureUpdateResult(result: RollCaptureUpdateResult, lang: Lang): string {
  if (lang === "zh") return renderZhUpdate(result);
  return renderEnUpdate(result);
}

/** The prompt is rendered separately so callers can show all facts before reading stdin. */
export function renderRollCaptureUpdatePrompt(result: Pick<RollCaptureUpdateResult, "appPath" | "releaseTag" | "installedVersion">, lang: Lang): string {
  const path = result.appPath ?? join("~", "Applications", APP_NAME);
  if (lang === "zh") {
    return `Roll Capture.app：已安装 ${result.installedVersion ?? "未知"}；可更新到 ${result.releaseTag ?? "未知"}。\n目标位置：${path}\n要替换吗？[y/N] `;
  }
  return `Roll Capture.app: installed ${result.installedVersion ?? "unknown"}; compatible release ${result.releaseTag ?? "unknown"} is available.\nTarget: ${path}\nReplace it? [y/N] `;
}

export function renderRollCaptureInstallResult(result: RollCaptureInstallResult, lang: Lang): string {
  if (lang === "zh") return renderZh(result);
  return renderEn(result);
}

export async function runRollCapturePostinstall(opts?: {
  deps?: RollCaptureInstallDeps;
  writeLine?: (line: string) => void;
  lang?: Lang;
}): Promise<number> {
  const writeLine = opts?.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  const lang = opts?.lang ?? resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
  try {
    const result = await installRollCapture(opts?.deps);
    writeLine(renderRollCaptureInstallResult(result, lang));
  } catch (error) {
    writeLine(lang === "zh" ? `Roll Capture.app 安装跳过：${errorMessage(error)}` : `Roll Capture.app install skipped: ${errorMessage(error)}`);
  }
  return 0;
}

type FetchRequestInit = RequestInit & { dispatcher?: unknown };
type FetchLike = (url: string, init?: FetchRequestInit) => Promise<Response>;
type ProxyDispatcherFactory = (env: NodeJS.ProcessEnv) => Promise<unknown> | unknown;

interface RollCaptureCredential {
  token: string;
}

async function defaultFetchLatestRelease(
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  execFile: RollCaptureInstallDeps["execFile"],
  fetchImpl: FetchLike = fetch,
  createProxyDispatcher: ProxyDispatcherFactory = defaultProxyDispatcher,
): Promise<RollCaptureRelease> {
  const response = await fetchImpl(
    RELEASE_API,
    await withProxyDispatcher(
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "@seanyao/roll" },
        signal: AbortSignal.timeout(timeoutMs),
      },
      env,
      createProxyDispatcher,
    ),
  );
  if (response.ok) return parseRelease(await response.json());
  if (!isAuthRetryableStatus(response.status)) throw new Error(`GitHub release API returned ${response.status}`);

  for (const credential of credentialFallbacks(env, execFile)) {
    const authed = await fetchImpl(
      RELEASE_API,
      await withProxyDispatcher(
        {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${credential.token}`, "User-Agent": "@seanyao/roll" },
          signal: AbortSignal.timeout(timeoutMs),
        },
        env,
        createProxyDispatcher,
      ),
    );
    if (authed.ok) return parseRelease(await authed.json());
    if (!isAuthRetryableStatus(authed.status)) throw new Error(`GitHub release API returned ${authed.status}`);
  }

  throw new Error(`GitHub release API returned ${response.status}`);
}

async function defaultDownloadAsset(
  asset: RollCaptureReleaseAsset,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  execFile: RollCaptureInstallDeps["execFile"],
  fetchImpl: FetchLike = fetch,
  createProxyDispatcher: ProxyDispatcherFactory = defaultProxyDispatcher,
): Promise<Uint8Array> {
  const response = await fetchImpl(
    asset.browserDownloadUrl,
    await withProxyDispatcher(
      {
        headers: { "User-Agent": "@seanyao/roll" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      },
      env,
      createProxyDispatcher,
    ),
  );
  if (response.ok) return new Uint8Array(await response.arrayBuffer());
  if (!isAuthRetryableStatus(response.status)) throw new Error(`asset download returned ${response.status}`);
  if (asset.apiUrl === undefined || asset.apiUrl === "") throw new Error("asset API URL missing for authenticated download");

  for (const credential of credentialFallbacks(env, execFile)) {
    const authed = await fetchImpl(
      asset.apiUrl,
      await withProxyDispatcher(
        {
          headers: { Accept: "application/octet-stream", Authorization: `Bearer ${credential.token}`, "User-Agent": "@seanyao/roll" },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        },
        env,
        createProxyDispatcher,
      ),
    );
    if (authed.ok) return new Uint8Array(await authed.arrayBuffer());
    if (!isAuthRetryableStatus(authed.status)) throw new Error(`asset download returned ${authed.status}`);
  }

  throw new Error(`asset download returned ${response.status}`);
}

function parseRelease(value: unknown): RollCaptureRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("release JSON is not an object");
  const row = value as Record<string, unknown>;
  const tagName = typeof row["tag_name"] === "string" ? row["tag_name"] : "";
  const rawAssets = Array.isArray(row["assets"]) ? row["assets"] : [];
  const assets = rawAssets.flatMap((raw): RollCaptureReleaseAsset[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const asset = raw as Record<string, unknown>;
    const name = typeof asset["name"] === "string" ? asset["name"] : "";
    const apiUrl = typeof asset["url"] === "string" ? asset["url"] : "";
    const browserDownloadUrl = typeof asset["browser_download_url"] === "string" ? asset["browser_download_url"] : "";
    const size = typeof asset["size"] === "number" ? asset["size"] : Number.NaN;
    return name !== "" && browserDownloadUrl !== "" && Number.isFinite(size)
      ? [{ name, browserDownloadUrl, size, ...(apiUrl !== "" ? { apiUrl } : {}) }]
      : [];
  });
  return { tagName, assets };
}

function isAuthRetryableStatus(status: number): boolean {
  return status === 401 || status === 404;
}

function* credentialFallbacks(env: NodeJS.ProcessEnv, execFile: RollCaptureInstallDeps["execFile"]): Generator<RollCaptureCredential> {
  const seen = new Set<string>();
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const token = (env[key] ?? "").trim();
    if (token !== "" && !seen.has(token)) {
      seen.add(token);
      yield { token };
    }
  }
  const gh = ghAuthToken(execFile);
  if (gh !== null && !seen.has(gh)) yield { token: gh };
}

function ghAuthToken(execFile: RollCaptureInstallDeps["execFile"]): string | null {
  try {
    const result = execFile("gh", ["auth", "token"], { timeoutMs: GH_AUTH_TOKEN_TIMEOUT_MS });
    const token = result.code === 0 ? result.stdout.trim() : "";
    return isUsableGhAuthToken(token) ? token : null;
  } catch {
    return null;
  }
}

function isUsableGhAuthToken(token: string): boolean {
  return token.length >= 20 && token.length <= 512 && !/\s/.test(token);
}

async function extractZip(
  zipPath: string,
  destination: string,
  execFile: RollCaptureInstallDeps["execFile"],
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const ditto = execFile("ditto", ["-x", "-k", zipPath, destination], { timeoutMs });
  if (ditto.code === 0) return { ok: true };
  const unzip = execFile("unzip", ["-q", zipPath, "-d", destination], { timeoutMs });
  if (unzip.code === 0) return { ok: true };
  const detail = [ditto.stderr.trim(), unzip.stderr.trim()].filter((line) => line !== "").join("; ");
  return { ok: false, detail: detail === "" ? "zip extraction failed" : detail };
}

function installGate(deps: RollCaptureInstallDeps): RollCaptureInstallResult | null {
  if (deps.platform !== "darwin") return { status: "skipped", reason: "non-darwin" };
  if (skipInstallEnv(deps.env)) return { status: "skipped", reason: "disabled" };
  if (deps.uid === 0 || (deps.env["SUDO_USER"] ?? "").trim() !== "") {
    return { status: "skipped", reason: ROOT_INSTALL_SKIP_REASON };
  }
  if (isCi(deps.env)) return { status: "skipped", reason: "ci" };
  if (deps.hasAquaGUI === false) return { status: "skipped", reason: "headless" };
  return null;
}

function skipInstallEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env["ROLL_SKIP_CAPTURE_INSTALL"] === "1" ||
    env["npm_config_roll_skip_capture_install"] === "1" ||
    env["ROLL_NO_SCREENCAP"] === "1"
  );
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return (
    (env["CI"] ?? "").trim() !== "" ||
    (env["GITHUB_ACTIONS"] ?? "").trim() !== "" ||
    (env["GITLAB_CI"] ?? "").trim() !== "" ||
    (env["JENKINS_HOME"] ?? "").trim() !== ""
  );
}

function macosHasAquaGUI(execFile: RollCaptureInstallDeps["execFile"]): boolean {
  const r = execFile("launchctl", ["managername"]);
  return r.code === 0 && r.stdout.includes("Aqua");
}

function findExtractedApp(dir: string): string | null {
  try {
    for (const name of readdirSync(dir)) {
      const candidate = join(dir, name);
      const st = lstatSync(candidate);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && name === APP_NAME) return candidate;
      if (st.isDirectory()) {
        const nested = findExtractedApp(candidate);
        if (nested !== null) return nested;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function findBundleExecutable(appPath: string): string | null {
  const macosDir = join(appPath, "Contents", "MacOS");
  try {
    for (const name of readdirSync(macosDir)) {
      const candidate = join(macosDir, name);
      const st = lstatSync(candidate);
      if (st.isSymbolicLink()) continue;
      if (st.isFile()) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function replaceAppAtomically(app: string, targetApp: string, deps: RollCaptureInstallDeps): void {
  const renamePath = deps.renamePath ?? renameSync;
  const backupApp = `${targetApp}.bak`;
  const hadExisting = lstatExists(targetApp);
  rmSync(backupApp, { recursive: true, force: true });
  if (!hadExisting) {
    renamePath(app, targetApp);
    return;
  }

  let backupCreated = false;
  let targetReplaced = false;
  try {
    renamePath(targetApp, backupApp);
    backupCreated = true;
    renamePath(app, targetApp);
    targetReplaced = true;
    rmSync(backupApp, { recursive: true, force: true });
  } catch (error) {
    if (targetReplaced) rmSync(targetApp, { recursive: true, force: true });
    if (backupCreated) {
      try {
        renamePath(backupApp, targetApp);
      } catch {
        /* preserve original install error */
      }
    }
    throw error;
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function withProxyDispatcher(
  init: FetchRequestInit,
  env: NodeJS.ProcessEnv,
  createProxyDispatcher: ProxyDispatcherFactory,
): Promise<FetchRequestInit> {
  if (!hasProxyEnv(env)) return init;
  const dispatcher = await createProxyDispatcher(env);
  return dispatcher === undefined || dispatcher === null ? init : { ...init, dispatcher };
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some((key) => (env[key] ?? "").trim() !== "");
}

async function defaultProxyDispatcher(_env: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    const imported = (await optionalImport("undici")) as { EnvHttpProxyAgent?: new () => unknown };
    if (typeof imported.EnvHttpProxyAgent === "function") return new imported.EnvHttpProxyAgent();
    enableNodeGlobalProxyFromEnv(_env);
    return undefined;
  } catch {
    enableNodeGlobalProxyFromEnv(_env);
    return undefined;
  }
}

const optionalImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

function enableNodeGlobalProxyFromEnv(env: NodeJS.ProcessEnv): void {
  const getBuiltinModule = (process as typeof process & { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
  const http = getBuiltinModule?.("node:http") ?? getBuiltinModule?.("http");
  const setGlobalProxyFromEnv = isRecord(http) ? http["setGlobalProxyFromEnv"] : undefined;
  if (typeof setGlobalProxyFromEnv !== "function") return;
  try {
    setGlobalProxyFromEnv(env);
  } catch {
    /* proxy remains best-effort; fetch still reports network failures normally */
  }
}

function readInstalledVersion(appPath: string, deps: RollCaptureInstallDeps): string | undefined {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const plutil = deps.execFile("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath]);
  const raw = plutil.code === 0 ? plutil.stdout.trim() : "";
  if (raw !== "") return raw;
  try {
    const text = readFileSync(plistPath, "utf8");
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function latestReleaseHint(
  deps: RollCaptureInstallDeps,
  installedVersion: string | undefined,
): Promise<{ releaseTag?: string; updateAvailable?: boolean }> {
  try {
    const release = await deps.fetchLatestRelease(UPDATE_HINT_TIMEOUT_MS);
    const latest = normalizeVersion(release.tagName);
    const installed = normalizeVersion(installedVersion ?? "");
    return {
      releaseTag: release.tagName,
      updateAvailable: latest !== "" && installed !== "" && latest !== installed,
    };
  } catch {
    return {};
  }
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

/** Compare normal dotted numeric release versions without treating a mere tag
 * difference as permission to downgrade an installed companion app. */
function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (value: string): number[] | null => {
    if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
    return value.split(".").map((part) => Number(part));
  };
  const next = parse(candidate);
  const current = parse(installed);
  if (next === null || current === null) return false;
  const length = Math.max(next.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (next[index] ?? 0) - (current[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

function updateManual(reason: string, appPath: string, installedVersion: string, releaseTag?: string): RollCaptureUpdateResult {
  return {
    status: "manual",
    reason,
    appPath,
    installedVersion,
    ...(releaseTag !== undefined ? { releaseTag } : {}),
  };
}

function manual(reason: string, releaseTag?: string): RollCaptureInstallResult {
  return { status: "manual", reason, ...(releaseTag !== undefined ? { releaseTag } : {}) };
}

function renderEn(result: RollCaptureInstallResult): string {
  if (result.status === "installed") {
    return `Roll Capture.app installed at ${result.appPath ?? join("~", "Applications", APP_NAME)}; open it once and grant Screen Recording permission.`;
  }
  if (result.status === "already-installed") {
    const update = result.updateAvailable === true && result.releaseTag !== undefined ? `; newer release ${result.releaseTag} is available` : "";
    return `Roll Capture.app already installed at ${result.appPath ?? "(detected)"}${update}.`;
  }
  if (result.status === "skipped") return `Roll Capture.app install skipped (${result.reason}).`;
  return `Roll Capture.app automatic install failed (${result.reason}); install it manually, then open it once and grant Screen Recording permission.`;
}

function renderZh(result: RollCaptureInstallResult): string {
  if (result.status === "installed") {
    return `Roll Capture.app 已安装到 ${result.appPath ?? join("~", "Applications", APP_NAME)}；请打开一次并授予屏幕录制权限。`;
  }
  if (result.status === "already-installed") {
    const update = result.updateAvailable === true && result.releaseTag !== undefined ? `；有新版 ${result.releaseTag} 可用` : "";
    return `Roll Capture.app 已安装：${result.appPath ?? "已检测到"}${update}。`;
  }
  if (result.status === "skipped") return `Roll Capture.app 安装已跳过（${renderZhReason(result.reason)}）。`;
  return `Roll Capture.app 自动安装失败（${result.reason}）；请手动安装，打开一次并授予屏幕录制权限。`;
}

function renderEnUpdate(result: RollCaptureUpdateResult): string {
  if (result.status === "updated") {
    return `Roll Capture.app updated to ${result.releaseTag ?? "the selected release"}. Run roll doctor tools to confirm readiness.`;
  }
  if (result.status === "no-update") {
    return `Roll Capture.app was not updated: ${result.reason}.`;
  }
  if (result.status === "declined") {
    return `Roll Capture.app was not updated: ${result.reason}. Run roll setup --update-capture when you are ready.`;
  }
  if (result.status === "skipped") return `Roll Capture.app update skipped (${result.reason}).`;
  return `Roll Capture.app update failed (${result.reason}); the installed app was kept unchanged.`;
}

function renderZhUpdate(result: RollCaptureUpdateResult): string {
  if (result.status === "updated") {
    return `Roll Capture.app 已更新到 ${result.releaseTag ?? "所选版本"}。请运行 roll doctor tools 确认就绪状态。`;
  }
  if (result.status === "no-update") return `Roll Capture.app 未更新：${result.reason}。`;
  if (result.status === "declined") return `Roll Capture.app 未更新：${result.reason}。准备好后请运行 roll setup --update-capture。`;
  if (result.status === "skipped") return `Roll Capture.app 更新已跳过（${result.reason}）。`;
  return `Roll Capture.app 更新失败（${result.reason}）；已保留原来的应用。`;
}

function renderZhReason(reason: string): string {
  if (reason === ROOT_INSTALL_SKIP_REASON) return "请以普通用户运行 roll setup 安装";
  return reason;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export const rollCaptureInstallInternals = {
  ASSET_NAME,
  APP_NAME,
  RELEASE_API,
  downloadAsset: defaultDownloadAsset,
  fetchLatestRelease: defaultFetchLatestRelease,
  parseRelease,
  isNewerVersion,
};
