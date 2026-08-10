/**
 * @responsibility Orchestrates managed-lane browser runs with operator-observable results.
 */
/**
 * US-BROW-004c / US-BROW-018 — Managed-lane CLI orchestration + operator-observable result.
 *
 * Two modes:
 *  1. **Fixture (test/demo)**: `runManagedFixtureOperation` uses the fake-target
 *     fixture — retained ONLY as a test helper and is NOT a successful CLI
 *     fallback when real MCP is unavailable (AC1).
 *  2. **Real MCP (production)**: `runManagedOperation` performs a real,
 *     policy-authorized managed MCP operation through the US-BROW-016/017
 *     session and adapter stack. This is the path the public `roll browser run`
 *     takes when `--story` is supplied.
 *
 * Honesty contract (scorer_focus):
 *  - The managed lane always runs in a temporary profile — owner state can never
 *    enter it, so this surface never proves a logged-in / visual acceptance.
 *  - DevTools screenshots are diagnostic-only artifacts. Diagnostic *success* is
 *    never conflated with visual acceptance; the rendered result says so
 *    explicitly.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BrowserOperationRunService,
  resolvePolicy,
} from "@roll/core";
import {
  ManagedChromeAdapter,
  defaultManagedChromeAdapterDeps,
  createManagedFixtureDeps,
  McpDiagnosticSessionFactory,
  type ManagedFixtureFailure,
} from "@roll/infra";
import { loadBrowserPolicy } from "./browser-policy-loader.js";
import type {
  BrowserActionKind,
  BrowserActionResult,
  BrowserLanePolicy,
  PerformanceDiagnosticSummary,
} from "@roll/spec";

export { loadBrowserPolicy } from "./browser-policy-loader.js";

/** Actions the managed fixture surface accepts (closed subset of the vocabulary). */
export const MANAGED_FIXTURE_ACTIONS: readonly BrowserActionKind[] = [
  "navigate",
  "snapshot",
  "console",
  "network",
  "screenshot",
];

export interface ManagedFixtureRunOptions {
  action: BrowserActionKind;
  /** The fake target URL (never a real site). */
  targetUrl: string;
  /** DOM selector for a `snapshot` action. */
  selector?: string;
  /** Simulate a redirect to this URL (used to prove redirect denial pass-through). */
  redirectTo?: string;
  /** Inject a categorized diagnostic failure to prove classification pass-through. */
  failure?: ManagedFixtureFailure;
  /** Per-run timeout; defaults small for injected timeouts, 5s otherwise. */
  timeoutMs?: number;
  /** Optional device emulation profile name (US-BROW-014). */
  deviceProfile?: string;
  /** Optional performance diagnostic profile name (US-BROW-012, opt-in). */
  performanceProfile?: string;
  /** Make the performance profile collection fail (proves graceful degradation). */
  performanceFailure?: boolean;
}

/** Options for the real policy-gated MCP run (US-BROW-018). */
export interface ManagedRunOptions {
  action: BrowserActionKind;
  targetUrl: string;
  storyId: string;
  /** Project root for policy loading. */
  projectPath: string;
  /** DOM selector for a `snapshot` action. */
  selector?: string;
  /** Per-run timeout. */
  timeoutMs?: number;
  /** Optional device emulation profile name. */
  deviceProfile?: string;
  /** Optional performance diagnostic profile name (opt-in). */
  performanceProfile?: string;
}

/** The operator-observable outcome of a managed run (fixture or real). */
export interface ManagedRunReport {
  lane: "managed";
  action: BrowserActionKind;
  targetUrl: string;
  /** Terminal run state from the aggregate: passed | failed | denied | expired. */
  runState: string;
  /** Terminal diagnostic result: pass | fail | skipped | denied. */
  result: "pass" | "fail" | "skipped" | "denied";
  /** The action-level status returned by the adapter. */
  actionStatus: BrowserActionResult["status"];
  /** Whether the temporary profile reached its terminal "removed" state. */
  profileRemoved: boolean;
  /** Number of diagnostic-only artifacts produced (never visual AC evidence). */
  diagnosticArtifacts: number;
  /** Categorized diagnostic failures (empty on a clean pass). */
  failures: { category: string; message: string }[];
  /** Redacted, operator-safe one-line summary from the adapter. */
  summary: string;
  /** The device profile applied, if any (US-BROW-014). */
  deviceProfile?: string;
  /** The performance profile requested, if any (US-BROW-012). */
  performanceProfile?: string;
  /** The bounded, redacted performance summary, when collected (US-BROW-012). */
  performanceSummary?: PerformanceDiagnosticSummary;
  /** Structured denial when the profile was disabled by policy or unknown. */
  performanceDenied?: string;
  /** For real MCP runs: pinned MCP package version (AC3). */
  mcpVersion?: string;
  /** For real MCP runs: whether transport was initialized (AC3). */
  transportInitialized?: boolean;
  /** For real MCP runs: whether the tool manifest was verified (AC3). */
  manifestVerified?: boolean;
  /** Denial reason when the operation is blocked before MCP spawn (AC2). */
  deniedReason?: string;
  /** True when this report came from the real MCP path (not fixture). */
  isRealMcp?: boolean;
}

const DEFAULT_MANAGED_POLICY = (targetUrl: string, performanceDiagnostics: boolean): BrowserLanePolicy => ({
  enabled: true,
  allowedOrigins: [originOf(targetUrl)],
  allowedActions: [...MANAGED_FIXTURE_ACTIONS],
  maxRunsPerCycle: 5,
  timeoutMs: 5_000,
  performanceDiagnostics,
});

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// ── Real MCP run (US-BROW-018) ───────────────────────────────────────────────

/**
 * Run a real, policy-authorized managed browser operation through the MCP lane.
 *
 * On policy denial or unavailable MCP, returns a structured denial report
 * WITHOUT spawning a browser or MCP process (AC2).
 */
export async function runManagedOperation(options: ManagedRunOptions): Promise<ManagedRunReport> {
  const policy = loadBrowserPolicy(options.projectPath);

  // Resolve policy (gates 1-6).
  const decision = resolvePolicy({
    policy,
    lane: "managed",
    caller: "builder",
    action: options.action,
    targetUrl: options.targetUrl,
  });

  if (!decision.authorized) {
    return deniedReport(options, decision.denial?.message ?? "Policy denied the managed operation");
  }

  const lanePolicy = decision.lanePolicy!;
  const timeoutMs = options.timeoutMs ?? lanePolicy.timeoutMs ?? 30_000;
  const storyId = options.storyId;

  const runId = `mcp-${randomUUID().slice(0, 8)}`;
  const runService = BrowserOperationRunService.create({
    runId,
    idempotencyKey: `mcp-key-${storyId}-${options.action}`,
    caller: "builder",
    lane: "managed",
    requestedOrigin: options.targetUrl,
    holderTokenHash: randomUUID(),
    storyId,
    now: () => new Date().toISOString(),
  });

  let transportInitialized = false;
  let manifestVerified = false;
  let mcpVersion = "";

  try {
    const cwd = options.projectPath;
    const diagDir = join(cwd, ".roll", "browser-operations", "diagnostics");

    // Wire the real MCP transport (US-BROW-016/017).
    const deps = {
      ...defaultManagedChromeAdapterDeps(diagDir),
      // Override mcpDiagnosticSessionFactory to capture init events.
      mcpDiagnosticSessionFactory: new McpDiagnosticSessionFactory({
        emit: (event) => {
          if (event.type === "browser:mcp-initialized") {
            transportInitialized = true;
            manifestVerified = true;
            mcpVersion = event.version;
          }
        },
      }),
    };

    const adapter = new ManagedChromeAdapter(deps);

    const outcome = await adapter.execute({
      runService,
      lanePolicy,
      action: options.action,
      payload: buildPayload({ action: options.action, targetUrl: options.targetUrl, selector: options.selector }),
      timeoutMs,
      deviceProfile: options.deviceProfile,
      performanceProfile: options.performanceProfile,
    });

    const terminal = outcome.service.terminalResult();
    return {
      lane: "managed",
      action: options.action,
      targetUrl: options.targetUrl,
      runState: outcome.service.run.state,
      result: outcome.service.run.result,
      actionStatus: outcome.result.status,
      profileRemoved: outcome.service.isProfileRemoved(),
      diagnosticArtifacts: outcome.result.diagnosticRefs.length,
      failures: terminal?.kind === "fail"
        ? terminal.failures.map((f) => ({ category: f.category, message: f.message }))
        : outcome.service.diagnosticFailures.map((f) => ({ category: f.category, message: f.message })),
      summary: outcome.result.redactedSummary,
      deviceProfile: options.deviceProfile,
      performanceProfile: options.performanceProfile,
      performanceSummary: outcome.performance?.summary,
      performanceDenied: outcome.performance?.denial
        ? `${outcome.performance.denial.code}: ${outcome.performance.denial.message}`
        : undefined,
      mcpVersion,
      transportInitialized,
      manifestVerified,
      isRealMcp: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      lane: "managed",
      action: options.action,
      targetUrl: options.targetUrl,
      runState: "failed",
      result: "fail",
      actionStatus: "failed",
      profileRemoved: false,
      diagnosticArtifacts: 0,
      failures: [{ category: "devtools-error", message }],
      summary: `Real MCP run failed: ${message}`,
      mcpVersion,
      transportInitialized,
      manifestVerified,
      deniedReason: transportInitialized ? undefined : `MCP unavailable: ${message}`,
      isRealMcp: true,
    };
  }
}

// ── Fixture run (test helper, US-BROW-004c) ──────────────────────────────────

/**
 * Run one managed browser operation against the fake-target fixture and return a
 * structured, operator-observable report.
 *
 * ⚠️ Retained only as a test helper. The public CLI path MUST use
 *    {@link runManagedOperation} and must not silently fall back here (AC1).
 */
export async function runManagedFixtureOperation(options: ManagedFixtureRunOptions): Promise<ManagedRunReport> {
  const timeoutMs = options.timeoutMs ?? (options.failure === "timeout" ? 30 : 5_000);
  const lanePolicy = DEFAULT_MANAGED_POLICY(options.targetUrl, options.performanceProfile !== undefined);

  const runService = BrowserOperationRunService.create({
    runId: "fixture-run",
    idempotencyKey: "fixture-key",
    caller: "builder",
    lane: "managed",
    requestedOrigin: options.targetUrl,
    holderTokenHash: "fixture-token-hash",
    now: () => "2026-07-15T00:00:00.000Z",
  });

  const { deps } = createManagedFixtureDeps({
    targetUrl: options.targetUrl,
    redirectTo: options.redirectTo,
    domNodes: options.selector ? [`text for ${options.selector}`] : undefined,
    failure: options.failure,
    performanceFailure: options.performanceFailure,
  });
  const adapter = new ManagedChromeAdapter(deps);

  const { service, result, performance } = await adapter.execute({
    runService,
    lanePolicy,
    action: options.action,
    payload: buildPayload({ action: options.action, targetUrl: options.targetUrl, selector: options.selector }),
    timeoutMs,
    deviceProfile: options.deviceProfile,
    performanceProfile: options.performanceProfile,
  });

  const terminal = service.terminalResult();
  return {
    lane: "managed",
    action: options.action,
    targetUrl: options.targetUrl,
    runState: service.run.state,
    result: service.run.result,
    actionStatus: result.status,
    profileRemoved: service.isProfileRemoved(),
    diagnosticArtifacts: result.diagnosticRefs.length,
    failures:
      terminal?.kind === "fail"
        ? terminal.failures.map((f) => ({ category: f.category, message: f.message }))
        : service.diagnosticFailures.map((f) => ({ category: f.category, message: f.message })),
    summary: result.redactedSummary,
    deviceProfile: options.deviceProfile,
    performanceProfile: options.performanceProfile,
    performanceSummary: performance?.summary,
    performanceDenied: performance?.denial ? `${performance.denial.code}: ${performance.denial.message}` : undefined,
  };
}

function buildPayload(opts: { action: BrowserActionKind; targetUrl: string; selector?: string }): Record<string, string | number | boolean> {
  switch (opts.action) {
    case "navigate":
      return { url: opts.targetUrl };
    case "snapshot":
      return { selector: opts.selector ?? "body" };
    default:
      return {};
  }
}

// ── Denied report ────────────────────────────────────────────────────────────

function deniedReport(options: Pick<ManagedRunOptions, "action" | "targetUrl">, reason: string): ManagedRunReport {
  return {
    lane: "managed",
    action: options.action,
    targetUrl: options.targetUrl,
    runState: "denied",
    result: "denied",
    actionStatus: "denied",
    profileRemoved: false,
    diagnosticArtifacts: 0,
    failures: [],
    summary: `Denied: ${reason}`,
    deniedReason: reason,
    isRealMcp: true,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a managed run report as operator-observable terminal lines. This is the
 * text a physical-terminal screenshot captures for attest evidence — concise,
 * and explicit that diagnostic success is not visual acceptance.
 */
export function renderManagedRunReport(report: ManagedRunReport): string[] {
  const isReal = report.isRealMcp === true;
  const fixtureLabel = isReal ? " — real MCP" : " — fixture (fake target)";
  const lines: string[] = [
    `Managed browser operation${fixtureLabel}`,
    `受管浏览器操作${isReal ? " — 真实 MCP" : " — fixture（假目标）"}`,
    "",
  ];

  if (isReal) {
    if (report.mcpVersion !== undefined) {
      lines.push(`  mcp package / MCP 包:  ${report.mcpVersion}`);
    }
    if (report.transportInitialized !== undefined) {
      lines.push(`  transport initialized / 传输初始化:  ${report.transportInitialized ? "yes" : "no"}`);
    }
    if (report.manifestVerified !== undefined) {
      lines.push(`  manifest verified / 清单验证:  ${report.manifestVerified ? "yes" : "no"}`);
    }
  }

  if (report.deniedReason !== undefined) {
    lines.push(`  denied / 已拒绝:       ${report.deniedReason}`);
    lines.push("");
    lines.push("  Diagnostic success is not visual acceptance evidence.");
    lines.push("  诊断通过不等于视觉验收证据。");
    lines.push("");
    return lines;
  }

  lines.push(
    `  lane / 通道:            ${report.lane}`,
    `  action / 动作:          ${report.action}`,
    `  target / 目标:          ${report.targetUrl}`,
    `  run state / 运行状态:   ${report.runState}`,
    `  result / 结果:          ${report.result} (action: ${report.actionStatus})`,
    `  temp profile / 临时档案: ${report.profileRemoved ? "removed" : "NOT removed"} (owner state never entered / 绝不进入 owner 状态)`,
    `  diagnostics / 诊断产物:  ${report.diagnosticArtifacts} (diagnostic-only, NOT visual acceptance / 仅诊断，非视觉验收)`,
  );

  if (report.failures.length > 0) {
    lines.push("  failures / 失败分类:");
    for (const failure of report.failures) {
      lines.push(`    - ${failure.category}: ${failure.message}`);
    }
  }

  if (report.deviceProfile !== undefined) {
    lines.push(`  device profile / 设备仿真: ${report.deviceProfile}`);
  }

  if (report.performanceProfile !== undefined) {
    lines.push(`  perf profile / 性能诊断: ${report.performanceProfile} (opt-in, diagnostic-only / 需选启，仅诊断)`);
    if (report.performanceDenied !== undefined) {
      lines.push(`    denied / 已拒绝: ${report.performanceDenied}`);
    } else if (report.performanceSummary !== undefined) {
      const s = report.performanceSummary;
      if (s.degraded) {
        lines.push("    result / 结果: degraded — no signal collected (action verdict unchanged) / 降级——未采到信号（动作结论不变）");
      } else {
        lines.push(`    metrics / 指标 (${s.metrics.length}, bounded & redacted / 有界脱敏):`);
        for (const m of s.metrics) {
          lines.push(`      - ${m.name}: ${m.value}`);
        }
      }
    }
  }

  lines.push(`  summary / 摘要:         ${report.summary}`);
  lines.push("");
  lines.push("  Diagnostic success is not visual acceptance evidence.");
  lines.push("  诊断通过不等于视觉验收证据。");
  lines.push("");
  return lines;
}
