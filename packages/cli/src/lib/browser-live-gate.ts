/**
 * @responsibility Provides the live managed-lane regression gate seam.
 */
/**
 * US-BROW-020 — live managed-lane gate seam.
 *
 * Minimal, testable glue between the environment and the pure evaluator
 * (`@roll/core`). Capability detection lives here so the live harness and the
 * hermetic unit tests share exactly one definition of "Chrome-capable".
 *
 * The scenario orchestration itself (local HTTP target + real
 * `runManagedOperation` scenarios) is the live harness under `test/live/`; this
 * seam only decides whether to run it and how to score the result.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { evaluateLiveGate } from "@roll/core";
import type { LiveGateEnvironment, LiveGateResult, RealManagedRunReport } from "@roll/spec";

/** Injectable capability probes (overridable in tests). */
export interface LiveCapabilityDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Returns true when `bin` resolves on PATH. */
  onPath?: (bin: string) => boolean;
  /** Returns true when a filesystem path exists (macOS Chrome.app). */
  pathExists?: (p: string) => boolean;
}

const CHROME_APP_MAC = [
  "/Applications/Google Chrome.app",
  "/Applications/Chromium.app",
];

function defaultOnPath(bin: string): boolean {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether this environment can host the real live suite.
 *
 * `liveOptIn` requires `ROLL_BROWSER_LIVE` to be a truthy value — the suite is
 * side-effecting (spawns MCP + Chrome), so it never runs implicitly.
 */
export function detectLiveCapability(deps: LiveCapabilityDeps = {}): LiveGateEnvironment {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const onPath = deps.onPath ?? defaultOnPath;
  const pathExists = deps.pathExists ?? existsSync;

  const npxPresent = onPath("npx");

  let chromePresent: boolean;
  if (platform === "darwin") {
    chromePresent = CHROME_APP_MAC.some((p) => pathExists(p));
  } else {
    chromePresent = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].some(onPath);
  }

  const optRaw = (env["ROLL_BROWSER_LIVE"] ?? "").trim().toLowerCase();
  const liveOptIn = optRaw === "1" || optRaw === "true" || optRaw === "yes";

  const missing: string[] = [];
  if (!chromePresent) missing.push("chrome-binary");
  if (!npxPresent) missing.push("npx");
  if (!liveOptIn) missing.push("live-opt-in (set ROLL_BROWSER_LIVE=1)");

  return { chromePresent, npxPresent, liveOptIn, missing };
}

/**
 * Run the live gate: when the environment is capable, invoke `runSuite` to
 * produce the real report and score it; otherwise return an explicit
 * `unavailable` verdict WITHOUT running the suite. Never a silent pass.
 */
export async function runLiveGate(input: {
  env: LiveGateEnvironment;
  runSuite: () => Promise<RealManagedRunReport>;
}): Promise<LiveGateResult> {
  if (input.env.missing.length > 0 || !input.env.chromePresent || !input.env.npxPresent || !input.env.liveOptIn) {
    return evaluateLiveGate({ env: input.env });
  }
  const report = await input.runSuite();
  return evaluateLiveGate({ env: input.env, report });
}
