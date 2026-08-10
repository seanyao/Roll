/**
 * @responsibility Probes the DevTools environment without mutating it.
 */
/**
 * US-BROW-003 — non-mutating DevTools environment probes.
 *
 * These probes ONLY observe. They never install a package, never write
 * configuration, never download or launch Chrome, and never open remote
 * debugging. Each probe honors env overrides so difftests can fabricate both
 * healthy and deliberately-degraded fixtures deterministically:
 *
 *   _ROLL_BROWSER_PROBE_PLATFORM   node platform override (darwin|linux|win32)
 *   _ROLL_BROWSER_NODE             present|missing[:value]
 *   _ROLL_BROWSER_NPX              present|missing[:value]
 *   _ROLL_BROWSER_CHROME           present|missing[:path]
 *   _ROLL_BROWSER_MCP              present|missing
 *   _ROLL_BROWSER_REMOTE_DEBUG     on|off
 *   _ROLL_BROWSER_DEVTOOLS_VERSION  valid|invalid (only applies when TCP is reachable)
 *   _ROLL_BROWSER_TRANSPORT_BINDING present|missing
 *
 * When an override is absent the probe falls back to a real, read-only check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BrowserDependencyState, BrowserEnvironmentObservations } from "@roll/spec";
import {
  MANAGED_DEVTOOLS_PACKAGE,
  MANAGED_DEVTOOLS_PACKAGE_VERSION,
  MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST,
  MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT,
} from "@roll/core";

export interface DevtoolsVersionResult {
  valid: boolean;
  browser?: string;
}

export interface BrowserEnvironmentProbeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Resolve an executable on PATH, returning its absolute path or null. */
  onPath: (bin: string) => string | null;
  /** True when a directory/app bundle exists. */
  pathExists: (p: string) => boolean;
  /** Read an executable's version line (best-effort, read-only). */
  version: (bin: string) => string | null;
  /** Probe a loopback TCP endpoint without opening it. */
  tcpReachable: (host: string, port: number) => boolean;
  /**
   * Validate that a loopback endpoint is a real Chrome DevTools endpoint by
   * fetching /json/version.  Returns null when the check can't run (CI /
   * headless), `{ valid: true, browser }` when the Browser field is present,
   * and `{ valid: false }` when the endpoint responds but isn't DevTools.
   */
  devtoolsVersionCheck: (host: string, port: number) => DevtoolsVersionResult | null;
}

function commandOnPath(env: NodeJS.ProcessEnv): (bin: string) => string | null {
  return (bin: string): string | null => {
    for (const dir of (env["PATH"] ?? "").split(delimiter)) {
      if (dir === "") continue;
      const candidate = join(dir, bin);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep scanning */
      }
    }
    return null;
  };
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return (
    (env["CI"] ?? "").trim() !== "" ||
    (env["GITHUB_ACTIONS"] ?? "").trim() !== "" ||
    (env["GITLAB_CI"] ?? "").trim() !== ""
  );
}

export function defaultBrowserEnvironmentProbeDeps(): BrowserEnvironmentProbeDeps {
  const env = process.env;
  const platformOverride = env["_ROLL_BROWSER_PROBE_PLATFORM"];
  return {
    env,
    platform: (platformOverride as NodeJS.Platform) || process.platform,
    onPath: commandOnPath(env),
    pathExists: (p) => existsSync(p),
    version: (bin) => {
      try {
        const r = spawnSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
        if ((r.status ?? 1) !== 0) return null;
        return (r.stdout ?? "").trim().split("\n")[0] ?? null;
      } catch {
        return null;
      }
    },
    tcpReachable: (host, port) => {
      // A real connect check is intentionally skipped under CI / headless — the
      // owner endpoint is never present there and we must not hang the probe.
      if (isCi(env)) return false;
      try {
        const r = spawnSync(
          "bash",
          ["-c", `exec 3<>/dev/tcp/${host}/${port}`],
          { stdio: ["ignore", "ignore", "ignore"], timeout: 2000 },
        );
        return (r.status ?? 1) === 0;
      } catch {
        return false;
      }
    },
    devtoolsVersionCheck: (host, port) => {
      // Skip the HTTP round-trip under CI — the owner endpoint is never present.
      if (isCi(env)) return null;
      try {
        const r = spawnSync(
          "curl",
          ["-sS", "--max-time", "3", `http://${host}:${port}/json/version`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
        );
        if ((r.status ?? 1) !== 0 || !r.stdout) return null;
        const body = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
        if (body && typeof body["Browser"] === "string") {
          return { valid: true, browser: body["Browser"] as string };
        }
        return { valid: false };
      } catch {
        return null;
      }
    },
  };
}

/** Parse an override of the form `present|missing[:value]`. Returns null when unset. */
function readOverride(raw: string | undefined): { present: boolean; value?: string } | null {
  if (raw === undefined || raw.trim() === "") return null;
  const [state, ...rest] = raw.split(":");
  const value = rest.join(":");
  return { present: state === "present" || state === "on", ...(value !== "" ? { value } : {}) };
}

function nodeState(deps: BrowserEnvironmentProbeDeps): BrowserDependencyState {
  const ov = readOverride(deps.env["_ROLL_BROWSER_NODE"]);
  if (ov !== null) {
    return ov.present
      ? { present: true, detail: "Node runtime present (override)", ...(ov.value !== undefined ? { value: ov.value } : {}) }
      : { present: false, detail: "Node runtime missing (override)" };
  }
  const bin = deps.onPath("node");
  if (bin === null) return { present: false, detail: "node is not on PATH" };
  const v = deps.version("node");
  const isLts = v !== null && isEvenMajor(v);
  return {
    present: true,
    detail: isLts ? "Node LTS present" : `Node present${v !== null ? " (verify LTS)" : ""}`,
    ...(v !== null ? { value: v } : {}),
  };
}

function isEvenMajor(version: string): boolean {
  const m = /v?(\d+)\./.exec(version);
  if (m === null) return false;
  return Number(m[1]) % 2 === 0;
}

function npxState(deps: BrowserEnvironmentProbeDeps): BrowserDependencyState {
  const ov = readOverride(deps.env["_ROLL_BROWSER_NPX"]);
  if (ov !== null) {
    return ov.present
      ? { present: true, detail: "npx present (override)" }
      : { present: false, detail: "npx missing (override)" };
  }
  const bin = deps.onPath("npx");
  return bin === null
    ? { present: false, detail: "npx is not on PATH" }
    : { present: true, detail: "npx present", value: bin };
}

const CHROME_APP_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app",
    join(process.env["HOME"] ?? "", "Applications/Google Chrome.app"),
  ],
};

function chromeState(deps: BrowserEnvironmentProbeDeps): BrowserDependencyState {
  const ov = readOverride(deps.env["_ROLL_BROWSER_CHROME"]);
  if (ov !== null) {
    return ov.present
      ? { present: true, detail: "Google Chrome present (override)", ...(ov.value !== undefined ? { value: ov.value } : {}) }
      : { present: false, detail: "Google Chrome not found (override)" };
  }
  if (deps.platform === "darwin") {
    for (const candidate of CHROME_APP_CANDIDATES["darwin"] ?? []) {
      if (candidate !== "" && deps.pathExists(candidate)) return { present: true, detail: "Google Chrome present", value: candidate };
    }
    return { present: false, detail: "Google Chrome.app not found in /Applications or ~/Applications" };
  }
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium"]) {
    const found = deps.onPath(bin);
    if (found !== null) return { present: true, detail: "Chrome/Chromium present", value: found };
  }
  return { present: false, detail: "google-chrome / chromium is not on PATH" };
}

function devtoolsPackageState(deps: BrowserEnvironmentProbeDeps): BrowserDependencyState {
  const pin = `${MANAGED_DEVTOOLS_PACKAGE}@${MANAGED_DEVTOOLS_PACKAGE_VERSION}`;
  const ov = readOverride(deps.env["_ROLL_BROWSER_MCP"]);
  if (ov !== null) {
    return ov.present
      ? { present: true, detail: `${pin} configured (override)`, value: pin }
      : { present: false, detail: `${MANAGED_DEVTOOLS_PACKAGE} not configured (override)` };
  }
  // The pin is declared, not resolved at run time — a machine config written by
  // `roll browser setup` is the owner-approved source of truth. Absent that,
  // report honestly that it is not configured rather than probing the network.
  const cfg = deps.env["ROLL_BROWSER_OPERATIONS_CONFIG"] ?? join(deps.env["HOME"] ?? "", ".roll", "browser-operations.yaml");
  return deps.pathExists(cfg)
    ? { present: true, detail: `${pin} pinned in ${cfg}`, value: pin }
    : { present: false, detail: `${MANAGED_DEVTOOLS_PACKAGE} not configured — run roll browser setup` };
}

function loopbackState(deps: BrowserEnvironmentProbeDeps): BrowserDependencyState {
  const ov = readOverride(deps.env["_ROLL_BROWSER_REMOTE_DEBUG"]);
  const versionOvRaw = deps.env["_ROLL_BROWSER_DEVTOOLS_VERSION"]?.trim();
  const endpoint = `${MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST}:${MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT}`;
  if (ov !== null) {
    if (ov.present) {
      // TCP override says reachable — check whether the version override marks
      // it as a real DevTools endpoint or just an open port.
      if (versionOvRaw === "valid") {
        return { present: true, detail: `${endpoint} reachable + DevTools validated (override)`, value: endpoint };
      }
      if (versionOvRaw === "invalid") {
        return { present: false, detail: `${endpoint} reachable but /json/version check failed — not a DevTools endpoint (override)`, value: endpoint, portReachable: true };
      }
      return { present: true, detail: `${endpoint} reachable (override)`, value: endpoint };
    }
    return { present: false, detail: "owner Chrome remote debugging is not enabled (override)" };
  }
  const tcpOk = deps.tcpReachable(MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST, MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT);
  if (!tcpOk) {
    return { present: false, detail: `owner Chrome remote debugging is not enabled on ${endpoint}` };
  }
  // TCP is open — validate it's a real DevTools endpoint via /json/version.
  const versionResult = deps.devtoolsVersionCheck(MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST, MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT);
  if (versionResult === null) {
    // Couldn't run the version check (CI / headless / curl not available).
    // Report honest: present=false so the readiness aggregate doesn't claim
    // ready on a port that may not be DevTools.
    return { present: false, detail: `${endpoint} reachable but /json/version check unavailable`, value: endpoint, portReachable: true };
  }
  if (versionResult.valid) {
    return { present: true, detail: `${endpoint} reachable + DevTools validated (${versionResult.browser ?? "Chrome"})`, value: endpoint };
  }
  return { present: false, detail: `${endpoint} reachable but /json/version check failed — not a DevTools endpoint`, value: endpoint, portReachable: true };
}

function transportBindingState(deps: BrowserEnvironmentProbeDeps): BrowserDependencyState {
  const ov = readOverride(deps.env["_ROLL_BROWSER_TRANSPORT_BINDING"]);
  if (ov !== null) {
    return ov.present
      ? { present: true, detail: "devtools_server matches the registered logical key (override)" }
      : { present: false, detail: "devtools_server does not match a registered logical key (override)" };
  }
  // The BrowserTransportRegistry (US-BROW-002) owns real binding validation.
  // Until it reports a mismatch, treat the binding as present so the readiness
  // aggregate degrades on missing deps rather than falsely blocking.
  return { present: true, detail: "devtools_server binding assumed present (registry validates at run time)" };
}

/**
 * Observe the DevTools environment (DevTools deps only). Capture readiness is
 * collected separately in the CLI layer and combined by the caller, keeping
 * infra free of a `cli` dependency and honoring the plan's rule that Capture is
 * never a prerequisite for managed diagnostics.
 */
export function probeBrowserEnvironment(
  captureStatus: { status: "available" | "degraded" | "skip"; detail: string },
  deps: BrowserEnvironmentProbeDeps = defaultBrowserEnvironmentProbeDeps(),
): BrowserEnvironmentObservations {
  return {
    node: nodeState(deps),
    npx: npxState(deps),
    chrome: chromeState(deps),
    devtoolsPackage: devtoolsPackageState(deps),
    loopbackRemoteDebug: loopbackState(deps),
    transportBinding: transportBindingState(deps),
    capture: captureStatus,
  };
}

/** The exact machine-level transport config `roll browser setup` proposes. It is
 *  never written without explicit owner confirmation; the dry-run only prints it. */
export function proposedBrowserOperationsConfig(): string {
  return [
    "devtools:",
    `  command: npx`,
    `  args: ["-y", "${MANAGED_DEVTOOLS_PACKAGE}@${MANAGED_DEVTOOLS_PACKAGE_VERSION}", "--no-usage-statistics", "--isolated", "--headless"]`,
    `  package: ${MANAGED_DEVTOOLS_PACKAGE}`,
    `  package_version: ${MANAGED_DEVTOOLS_PACKAGE_VERSION}`,
    `  chrome_channel: stable`,
    `  remote_debugging: { host: "${MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST}", port: ${MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT} }`,
    "",
  ].join("\n");
}
