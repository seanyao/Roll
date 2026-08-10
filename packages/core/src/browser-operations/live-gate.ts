/**
 * @responsibility Evaluates the managed-lane regression gate verdict from observed capability.
 * US-BROW-020 — pure live managed-lane gate evaluator + summary renderer.
 *
 * This is the honesty core of the regression gate. It has NO Chrome, MCP or
 * process dependency; the infra harness feeds it (a) the observed environment
 * capability and (b) the emitted `RealManagedRunReport`, and this function
 * decides whether the managed lane is `verified`, `unavailable`, or `failed`.
 *
 * The invariants it guarantees (AC4, AC5):
 *   1. An `unavailable` environment never yields `verified` — it fails loud as
 *      an explicitly-unavailable environment gate, never a silent skip that
 *      still claims the feature works.
 *   2. A `fixture`-sourced report never yields `verified`, even with a
 *      transport+manifest+clean shape. Only a `real` report can verify.
 *   3. A `real` report verifies only when transport initialized, manifest was
 *      verified, every required scenario is present, and every scenario reached
 *      full MCP/Chrome/temp-profile cleanup.
 */
import type {
  LiveGateEnvironment,
  LiveGateResult,
  LiveScenarioKind,
  LiveScenarioOutcome,
  RealManagedRunReport,
} from "@roll/spec";

/**
 * The scenarios a `verified` run must include. Missing any one means the suite
 * did not actually cover the managed lane's contract — it cannot verify.
 */
export const REQUIRED_LIVE_SCENARIOS: readonly LiveScenarioKind[] = [
  "navigate",
  "snapshot",
  "console-summary",
  "network-summary",
  "diagnostic-screenshot",
  "redirect-denied",
  "timeout-cleanup",
  "chrome-crash-cleanup",
  "mcp-protocol-error-cleanup",
  "redaction-failure-cleanup",
];

/** Is the environment capable of hosting the real live suite? */
export function isLiveEnvironmentCapable(env: LiveGateEnvironment): boolean {
  return env.chromePresent && env.npxPresent && env.liveOptIn && env.missing.length === 0;
}

/** A scenario is only acceptable when it fully cleaned up. */
function scenarioCleanedUp(s: LiveScenarioOutcome): boolean {
  return s.cleanup.mcpClosed && s.cleanup.chromeExited && s.cleanup.tempProfileRemoved;
}

/**
 * Evaluate the live gate.
 *
 * When `env` is not capable, returns `unavailable` regardless of any report —
 * the suite did not (and must not) run, and this is never a pass.
 */
export function evaluateLiveGate(input: {
  env: LiveGateEnvironment;
  report?: RealManagedRunReport;
}): LiveGateResult {
  const { env, report } = input;

  if (!isLiveEnvironmentCapable(env)) {
    const missing = env.missing.length > 0 ? env.missing : deriveMissing(env);
    return {
      verdict: "unavailable",
      reason:
        "Live managed-lane gate did NOT run: environment is not Chrome-capable / not opted in. " +
        "This does not verify the managed browser lane.",
      missing,
    };
  }

  // Environment is capable, so a report is required to say anything.
  if (report === undefined) {
    return {
      verdict: "failed",
      reason: "Environment is Chrome-capable but the live suite produced no report.",
      violations: ["no-report"],
    };
  }

  // Invariant 2: a fixture can exercise seams but can never verify the lane.
  if (report.source !== "real") {
    return {
      verdict: "failed",
      reason:
        `Refusing to verify a ${report.source}-sourced report. ` +
        "Only a real MCP process + real Chrome run can satisfy this gate.",
      report,
      violations: [`non-real-source:${report.source}`],
    };
  }

  const violations: string[] = [];

  if (!report.transportInitialized) violations.push("transport-not-initialized");
  if (!report.manifestVerified) violations.push("manifest-not-verified");

  const present = new Set(report.scenarios.map((s) => s.kind));
  for (const required of REQUIRED_LIVE_SCENARIOS) {
    if (!present.has(required)) violations.push(`missing-scenario:${required}`);
  }

  for (const s of report.scenarios) {
    if (s.status === "errored") violations.push(`scenario-errored:${s.kind}`);
    if (!scenarioCleanedUp(s)) violations.push(`scenario-not-cleaned:${s.kind}`);
  }

  if (violations.length > 0) {
    return {
      verdict: "failed",
      reason: `Live suite ran but violated ${violations.length} invariant(s).`,
      report,
      violations,
    };
  }

  return {
    verdict: "verified",
    reason:
      `Verified: real ${report.mcpPackage} transport initialized, manifest verified, ` +
      `and all ${report.scenarios.length} scenarios cleaned up MCP, Chrome and temp profile.`,
    report,
  };
}

function deriveMissing(env: LiveGateEnvironment): string[] {
  const missing: string[] = [];
  if (!env.chromePresent) missing.push("chrome-binary");
  if (!env.npxPresent) missing.push("npx");
  if (!env.liveOptIn) missing.push("live-opt-in (set ROLL_BROWSER_LIVE=1)");
  return missing;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the gate result as operator-observable terminal lines. This is the
 * text a physical-terminal screenshot captures: it visibly states the real
 * transport verification and the diagnostic-only boundary (AC6), and — when
 * unavailable — loudly says the lane was NOT verified.
 */
export function renderLiveGateSummary(result: LiveGateResult): string[] {
  const lines: string[] = [
    "Live managed-lane regression gate (US-BROW-020)",
    "受管浏览器通道实况回归闸 (US-BROW-020)",
    "",
  ];

  if (result.verdict === "unavailable") {
    lines.push(
      "  verdict / 结论:  UNAVAILABLE — suite did not run / 环境不可用——未运行",
      `  missing / 缺失:  ${(result.missing ?? []).join(", ") || "unknown"}`,
      "",
      "  This is an explicit environment gate, NOT a pass.",
      "  这是显式的环境闸，不是通过；未验证受管浏览器通道。",
      "",
    );
    return lines;
  }

  const report = result.report;
  if (report !== undefined) {
    lines.push(
      `  source / 来源:              ${report.source}`,
      `  mcp package / MCP 包:       ${report.mcpPackage}`,
      `  transport initialized / 传输初始化:  ${report.transportInitialized ? "yes" : "no"}`,
      `  manifest verified / 清单验证:        ${report.manifestVerified ? "yes" : "no"}`,
      `  target origin / 目标源:     ${report.targetOrigin}`,
      "",
      "  scenarios / 场景:",
    );
    for (const s of report.scenarios) {
      const clean = scenarioCleanedUp(s) ? "cleaned" : "LEAKED";
      const kinds = s.artifactKinds.length > 0 ? ` [${s.artifactKinds.join(", ")}]` : "";
      lines.push(`    - ${s.kind}: ${s.status} (${clean})${kinds}${s.detail ? ` — ${s.detail}` : ""}`);
    }
    lines.push("");
  }

  if (result.verdict === "verified") {
    lines.push(
      "  verdict / 结论:  VERIFIED — real MCP + real Chrome, no external network.",
      "  结论:  已验证——真实 MCP + 真实 Chrome，无外部网络请求。",
    );
  } else {
    lines.push(
      "  verdict / 结论:  FAILED",
      `  violations / 违规:  ${(result.violations ?? []).join(", ")}`,
    );
  }

  lines.push(
    "",
    "  Diagnostic success is not visual acceptance evidence.",
    "  诊断通过不等于视觉验收证据。",
    "",
  );
  return lines;
}
