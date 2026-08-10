/**
 * @responsibility Runs the `roll browser` setup, doctor, and update subcommands for managed browser operations.
 */
/**
 * US-BROW-003 — `roll browser setup` / `roll browser doctor`.
 * US-BROW-010 — `roll browser update` — check and approve DevTools transport updates.
 *
 * Hard invariants:
 *  - `setup --dry-run` reports the proposed machine config and dependency
 *    preflight WITHOUT writing anything.
 *  - `setup` writes ~/.roll/browser-operations.yaml ONLY with explicit owner
 *    confirmation (`--confirm`). It never touches a product repo package.json
 *    and never enables owner Chrome remote debugging.
 *  - `doctor [--json]` independently reports managed / interactive / capture as
 *    ready | degraded | blocked, with actionable reasons. Missing prerequisites
 *    are honest — never a false pass — and leave Playwright / Roll Capture usable.
 *  - `update --check` reports pinned vs candidate version without downloading,
 *    installing, or rewriting any configuration.
 *  - `update --apply` requires explicit `--confirm`; runs smoke checks + doctor;
 *    on failure keeps the prior version intact.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BrowserLeaseService,
  BrowserOperationLedger,
  BrowserTransportVersion,
  MANAGED_DEVTOOLS_PACKAGE_VERSION,
  pinnedDevToolsVersionSource,
  resolveDeviceProfile,
  resolvePerformanceProfile,
  type VersionSource,
} from "@roll/core";
import {
  createLoopbackOwnerChromeAdapter,
  proposedBrowserOperationsConfig,
  type InteractiveLowRiskAction,
  type InteractiveOperationResult,
} from "@roll/infra";
import type { BrowserActionKind, BrowserOperationEvent, BrowserOperationsTruth, BrowserProbeResult, BrowserTransportVersionCheck } from "@roll/spec";
import { randomUUID } from "node:crypto";
import { collectBrowserEnvironmentReadiness, renderBrowserDoctor } from "../lib/browser-readiness-doctor.js";
import type { ManagedFixtureFailure } from "@roll/infra";
import {
  MANAGED_FIXTURE_ACTIONS,
  renderManagedRunReport,
  runManagedFixtureOperation,
  runManagedOperation,
  loadBrowserPolicy,
} from "../lib/managed-browser-run.js";
import { collectBrowserTruth } from "../lib/browser-truth-collect.js";
import { renderBrowserTruthVerbose } from "../lib/browser-truth-surface.js";

export interface BrowserCommandDeps {
  /** Resolve the machine-level config path (never a product repo file). */
  configPath: () => string;
  writeFile: (path: string, content: string) => void;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  /** Deterministic, injectable version source for update check/apply. */
  versionSource?: VersionSource;
  /** Smoke/contract check — runs before an update is applied. */
  smokeCheck?: () => Promise<boolean>;
  readiness?: (probeResult?: BrowserProbeResult) => ReturnType<typeof collectBrowserEnvironmentReadiness>;
  /** Truth projection from the durable browser operation ledger. */
  browserTruth?: () => BrowserOperationsTruth;
  /** Live MCP lane probe (US-BROW-019). Injectable for tests. */
  runProbe?: () => Promise<BrowserProbeResult>;
  /** Terminal gate and confirmation seam for owner Chrome operations. */
  isTTY: () => boolean;
  readApproval: (prompt: string) => Promise<boolean>;
  interactiveRun: (input: InteractiveBrowserRunInput) => Promise<InteractiveOperationResult>;
  /** Durable sink for the terminal result of an approved interactive operation. */
  recordBrowserEvent: (event: BrowserOperationEvent) => void;
  stdout: (text: string) => void;
}

export interface InteractiveBrowserRunInput {
  storyId: string;
  origin: string;
  endpoint: string;
  action: InteractiveLowRiskAction;
  actionSummary: string;
}

function defaultDeps(): BrowserCommandDeps {
  return {
    configPath: () => process.env["ROLL_BROWSER_OPERATIONS_CONFIG"] ?? join(homedir(), ".roll", "browser-operations.yaml"),
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    readFile: (path) => readFileSync(path, "utf8"),
    fileExists: (path) => existsSync(path),
    smokeCheck: async () => true,
    isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    readApproval: readOwnerApproval,
    interactiveRun: defaultInteractiveRun,
    recordBrowserEvent: (event) => new BrowserOperationLedger().recordBrowserEvent(
      join(process.cwd(), ".roll", "browser-operations", "events.ndjson"),
      event,
    ),
    stdout: (text) => process.stdout.write(text),
  };
}

const USAGE =
  "Usage: roll browser <setup|doctor|run|interactive|update>\n" +
  "  setup --dry-run       Report proposed machine config + dependency preflight (writes nothing).\n" +
  "  setup --confirm       Write ~/.roll/browser-operations.yaml after explicit owner confirmation.\n" +
  "  doctor [--json] [--probe]  Report managed / interactive / capture readiness (ready|configured|degraded|blocked).\n" +
  "     --probe                 Run a live MCP lane probe (spawns temporary chrome-devtools-mcp, validates,\n" +
  "                             cleans up). Only a successful probe advances the managed lane to 'ready'.\n" +
  "  run [opts]            Run a managed-lane operation through the real policy-gated MCP lane.\n" +
  "     --story <US-ID>    Required: story identifier (US-BROW-018, etc.).\n" +
  "     --url <targetUrl>  Target URL for the browser action.\n" +
  "     --action <navigate|snapshot|console|network|screenshot>  (default: navigate)\n" +
  "     --selector <sel>   DOM selector for --action snapshot.\n" +
  "     --profile <name>   Device emulation profile (Pixel 7, iPhone 14, iPad Pro).\n" +
  "     --perf-profile <name>  Opt-in performance diagnostic profile (web-vitals-lite); diagnostic-only.\n" +
  "     Optional profiles are not visual acceptance evidence or a multi-browser matrix.\n" +
  "     --json             Emit the machine-readable run report.\n" +
  "     --fixture          Test-only: use the fake-target fixture instead of real MCP.\n" +
  "     --fail <timeout|crash|devtools-error>  (fixture only) Inject a categorized diagnostic failure.\n" +
  "     --redirect <url>   (fixture only) Simulate a redirect (proves redirect denial).\n" +
  "     --perf-fail        (fixture only) Simulate a performance-profile failure.\n" +
  "  interactive --story <US-ID> --origin <https-origin> --action <navigate|click|fill|press_key> [action flags]\n" +
  "     Requires an attached TTY and one owner approval. Connects only to an already-open loopback Chrome debug endpoint.\n" +
  "     No background scheduler, remote endpoint, cookie export, or automatic Chrome startup is supported.\n" +
  "     --endpoint <http://127.0.0.1:9222> (default); navigate: --url; click: --selector; fill: --selector --value; press_key: --key.\n" +
  "  update [--check] [--json]   Check for DevTools transport update (pinned vs candidate).\n" +
  "  update --apply --confirm    Apply update after smoke checks + doctor.\n";

function readiness(deps: BrowserCommandDeps, probeResult?: BrowserProbeResult): ReturnType<typeof collectBrowserEnvironmentReadiness> {
  return deps.readiness?.(probeResult) ?? collectBrowserEnvironmentReadiness(undefined, undefined, probeResult);
}

function setupCommand(args: string[], deps: BrowserCommandDeps): number {
  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--confirm") || args.includes("--yes");
  const cfgPath = deps.configPath();
  const proposed = proposedBrowserOperationsConfig();
  const r = readiness(deps);

  const preflight = [
    "Browser operations setup",
    "浏览器操作安装",
    "",
    `  target (machine-level, never committed): ${cfgPath}`,
    "",
    "  proposed ~/.roll/browser-operations.yaml:",
    ...proposed.split("\n").map((line: string) => (line === "" ? "" : `    ${line}`)),
    "  dependency preflight:",
    ...renderBrowserDoctor(r).map((line) => `    ${line}`),
    "",
    "  Roll never installs into a product package.json and never enables owner Chrome remote debugging.",
    "  Roll 绝不改动产品仓 package.json，也绝不自动开启 owner Chrome 的远程调试。",
    "",
  ];

  if (dryRun) {
    deps.stdout([...preflight, "  dry-run: no configuration was written.", ""].join("\n") + "\n");
    return 0;
  }

  if (!confirmed) {
    deps.stdout(
      [
        ...preflight,
        "  refused: writing the machine config requires explicit owner confirmation.",
        "  已拒绝：写入机器级配置需要 owner 显式确认。",
        "  Re-run with --confirm to write, or --dry-run to preview only.",
        "",
      ].join("\n") + "\n",
    );
    return 0;
  }

  deps.writeFile(cfgPath, proposed);
  deps.stdout(
    [...preflight, `  confirmed: wrote ${cfgPath}`, "  已确认：配置已写入。", ""].join("\n") + "\n",
  );
  return 0;
}

function doctorSubcommand(args: string[], deps: BrowserCommandDeps): number | Promise<number> {
  const probeRequested = args.includes("--probe");

  if (probeRequested) {
    return doctorWithProbe(args, deps);
  }

  const r = readiness(deps);
  if (args.includes("--json")) {
    deps.stdout(JSON.stringify(r, null, 2) + "\n");
    return 0;
  }
  const truth = deps.browserTruth?.() ?? collectBrowserTruth({ projectPath: process.cwd() });
  deps.stdout([
    "Browser operations doctor",
    "浏览器操作体检",
    "",
    ...renderBrowserDoctor(r),
    "",
    "Browser operations facts",
    "浏览器操作事实",
    "",
    ...renderBrowserTruthVerbose(truth),
    "",
  ].join("\n") + "\n");
  return 0;
}

async function doctorWithProbe(args: string[], deps: BrowserCommandDeps): Promise<number> {
  const json = args.includes("--json");

  // Side-effect announcement (AC2): before any spawn, tell the operator exactly
  // what will happen. Skip when --json for machine readability.
  if (!json) {
    deps.stdout([
      "Browser operations doctor --probe",
      "浏览器操作体检 --probe",
      "",
      "⏳ Running live MCP lane probe — this will:",
      "   1. Spawn the pinned chrome-devtools-mcp session (temporary process)",
      "   2. Run MCP initialize + tools/list + manifest validation",
      "   3. Close the session and clean up the temporary Chrome profile",
      "The probe may take a few seconds. No owner state enters the temporary profile.",
      "",
      "⏳ 正在运行实时 MCP 通道探测——将会：",
      "   1. 启动固定版本的 chrome-devtools-mcp 会话（临时进程）",
      "   2. 运行 MCP initialize + tools/list + 清单验证",
      "   3. 关闭会话并清理临时 Chrome 档案",
      "探测可能需要几秒。绝不会进入 owner 状态。",
      "",
    ].join("\n") + "\n");
  }

  let probeResult: BrowserProbeResult;
  if (deps.runProbe !== undefined) {
    probeResult = await deps.runProbe();
  } else {
    // Production path: use the real MCP probe.
    const { runMcpProbe, defaultMcpProbeObserver } = await import("@roll/infra");
    const observer = defaultMcpProbeObserver(deps.stdout);
    // Announce side effects via the observer too (probe-level announcements).
    probeResult = await runMcpProbe({ observer });
  }

  const r = readiness(deps, probeResult);

  if (json) {
    deps.stdout(JSON.stringify(r, null, 2) + "\n");
    return 0;
  }

  if (probeResult.kind === "passed") {
    deps.stdout([
      "",
      "✅ Live probe passed — managed lane is ready.",
      "✅ 实时探测通过——受管通道就绪。",
      "",
    ].join("\n") + "\n");
  } else {
    deps.stdout([
      "",
      "❌ Live probe failed — see categorized failures below.",
      "❌ 实时探测失败——见下方分类失败信息。",
      ...probeResult.failures.map((f) => `   ${f.category}: ${f.message}`),
      "",
    ].join("\n") + "\n");
  }

  deps.stdout([
    ...renderBrowserDoctor(r),
    "",
  ].join("\n") + "\n");

  return 0;
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const FAILURE_KINDS: readonly ManagedFixtureFailure[] = ["timeout", "crash", "devtools-error"];

async function runSubcommand(args: string[], deps: BrowserCommandDeps): Promise<number> {
  const actionArg = (flagValue(args, "--action") ?? "navigate") as BrowserActionKind;
  if (!MANAGED_FIXTURE_ACTIONS.includes(actionArg)) {
    process.stderr.write(
      `roll browser run: unsupported --action '${actionArg}'. Supported: ${MANAGED_FIXTURE_ACTIONS.join(", ")}.\n`,
    );
    return 1;
  }

  // ── Fixture path (test-only, --fixture flag) ────────────────────────────
  if (args.includes("--fixture")) {
    const failArg = flagValue(args, "--fail");
    if (failArg !== undefined && !FAILURE_KINDS.includes(failArg as ManagedFixtureFailure)) {
      process.stderr.write(`roll browser run: unknown --fail '${failArg}'. Supported: ${FAILURE_KINDS.join(", ")}.\n`);
      return 1;
    }
    const profileArg = flagValue(args, "--profile");
    if (profileArg !== undefined) {
      const resolved = resolveDeviceProfile(profileArg);
      if ("code" in resolved) { process.stderr.write(`roll browser run: ${resolved.message}\n`); return 1; }
    }
    const perfProfileArg = flagValue(args, "--perf-profile");
    if (perfProfileArg !== undefined) {
      const resolved = resolvePerformanceProfile(perfProfileArg);
      if ("code" in resolved) { process.stderr.write(`roll browser run: ${resolved.message}\n`); return 1; }
    }

    const report = await runManagedFixtureOperation({
      action: actionArg,
      targetUrl: flagValue(args, "--url") ?? "https://fake.target.test",
      selector: flagValue(args, "--selector"),
      redirectTo: flagValue(args, "--redirect"),
      failure: failArg as ManagedFixtureFailure | undefined,
      deviceProfile: profileArg,
      performanceProfile: perfProfileArg,
      performanceFailure: args.includes("--perf-fail"),
    });

    if (args.includes("--json")) {
      deps.stdout(JSON.stringify(report, null, 2) + "\n");
    } else {
      deps.stdout(renderManagedRunReport(report).join("\n") + "\n");
    }
    return 0;
  }

  // ── Real MCP path (production, US-BROW-018 AC1) ─────────────────────────
  const storyId = flagValue(args, "--story");
  const targetUrl = flagValue(args, "--url");

  if (storyId === undefined || targetUrl === undefined) {
    deps.stdout(
      "roll browser run requires --story <US-ID> and --url <targetUrl> for the real managed MCP lane.\n" +
      "  Use --fixture for the test-only fake-target path.\n" +
      "  The fixture is not a successful CLI fallback when real MCP is unavailable.\n"
    );
    return 1;
  }

  // Validate device profile early (US-BROW-014).
  const profileArg = flagValue(args, "--profile");
  if (profileArg !== undefined) {
    const resolved = resolveDeviceProfile(profileArg);
    if ("code" in resolved) { process.stderr.write(`roll browser run: ${resolved.message}\n`); return 1; }
  }

  // Validate performance profile name early (US-BROW-012).
  const perfProfileArg = flagValue(args, "--perf-profile");
  if (perfProfileArg !== undefined) {
    const resolved = resolvePerformanceProfile(perfProfileArg);
    if ("code" in resolved) { process.stderr.write(`roll browser run: ${resolved.message}\n`); return 1; }
  }

  const projectPath = process.cwd();
  const report = await runManagedOperation({
    action: actionArg,
    targetUrl,
    storyId,
    projectPath,
    selector: flagValue(args, "--selector"),
    deviceProfile: profileArg,
    performanceProfile: perfProfileArg,
  });

  if (args.includes("--json")) {
    deps.stdout(JSON.stringify(report, null, 2) + "\n");
  } else {
    deps.stdout(renderManagedRunReport(report).join("\n") + "\n");
  }

  // A denied/failed report is still a successfully-observed outcome (exit 0).
  // The caller inspects report.runState / report.result to determine truth.
  return 0;
}

async function interactiveSubcommand(args: string[], deps: BrowserCommandDeps): Promise<number> {
  if (!deps.isTTY()) {
    deps.stdout("roll browser interactive requires an attached TTY; no owner Chrome connection was attempted.\n");
    return 1;
  }
  const storyId = flagValue(args, "--story");
  const origin = flagValue(args, "--origin");
  if (storyId === undefined || origin === undefined) {
    deps.stdout("roll browser interactive requires --story <US-ID> and --origin <https-origin>.\n");
    return 1;
  }
  const action = interactiveAction(args);
  if (action === undefined) {
    deps.stdout("roll browser interactive requires a supported typed --action and its required flags.\n");
    return 1;
  }
  const endpoint = flagValue(args, "--endpoint") ?? "http://127.0.0.1:9222";
  const actionSummary = interactiveActionSummary(action);
  const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const prompt = [
    "Owner Chrome approval required (one operation only)",
    `  story: ${storyId}`,
    `  origin: ${origin}`,
    `  action: ${actionSummary}`,
    `  expiry: ${expiry} (15 minutes maximum)`,
    "  credential export: denied (cookies, storage, and network bodies are unavailable)",
    "Approve this owner-run operation? [y/N] ",
  ].join("\n");
  if (!(await deps.readApproval(prompt))) {
    deps.stdout("Owner declined the interactive operation; no owner Chrome connection was attempted.\n");
    return 1;
  }
  const outcome = await deps.interactiveRun({ storyId, origin, endpoint, action, actionSummary });
  if (outcome.kind === "denied") {
    deps.stdout(`Interactive operation denied: ${outcome.reason.code} — ${outcome.reason.message}\n`);
    return 1;
  }
  deps.recordBrowserEvent({
    type: "browser:operation-finished",
    runId: outcome.result.runId,
    ts: new Date().toISOString(),
    result: outcome.result,
  });
  deps.stdout(
    `manual owner-run result: ${outcome.result.status} (tab: ${outcome.tabId})\n` +
    "This interactive result does not make CI pass and is not background automation.\n",
  );
  return 0;
}

function interactiveAction(args: string[]): InteractiveLowRiskAction | undefined {
  switch (flagValue(args, "--action")) {
    case "navigate": {
      const url = flagValue(args, "--url");
      return url === undefined ? undefined : { kind: "navigate", url };
    }
    case "click": {
      const selector = flagValue(args, "--selector");
      return selector === undefined ? undefined : { kind: "click", selector };
    }
    case "fill": {
      const selector = flagValue(args, "--selector");
      const value = flagValue(args, "--value");
      return selector === undefined || value === undefined ? undefined : { kind: "fill", selector, value };
    }
    case "press_key": {
      const key = flagValue(args, "--key");
      return key === undefined ? undefined : { kind: "press_key", key };
    }
    default:
      return undefined;
  }
}

function interactiveActionSummary(action: InteractiveLowRiskAction): string {
  switch (action.kind) {
    case "navigate": return `navigate to ${new URL(action.url).origin}`;
    case "click": return `click ${action.selector}`;
    case "fill": return `fill ${action.selector}`;
    case "press_key": return `press ${action.key}`;
  }
}

async function defaultInteractiveRun(input: InteractiveBrowserRunInput): Promise<InteractiveOperationResult> {
  const holderToken = randomUUID();
  const eventsPath = join(process.cwd(), ".roll", "browser-operations", "events.ndjson");
  const ledger = new BrowserOperationLedger();
  const service = new BrowserLeaseService(
    join(process.cwd(), ".roll", "browser-operations", "leases"),
    undefined,
    (event) => ledger.recordBrowserEvent(eventsPath, event),
  );
  service.releaseIfExpired(input.endpoint);
  service.reclaimDeadHolder(input.endpoint);
  const granted = service.grant({
    approval: {
      storyId: input.storyId,
      origin: input.endpoint,
      actionSummary: input.actionSummary,
      requestedMs: 15 * 60 * 1000,
      credentialExportDenied: true,
    },
    holderPid: process.pid,
    holderToken,
    operator: process.env["USER"] ?? "owner",
    callerTty: true,
    callerIsScheduler: false,
  });
  if (granted.kind === "denied") return { kind: "denied", reason: granted.reason, ciPassed: false };
  try {
    return await createLoopbackOwnerChromeAdapter(input.endpoint).execute({ lease: granted.lease, origin: input.origin, action: input.action });
  } finally {
    service.release(granted.lease, holderToken);
  }
}

async function readOwnerApproval(prompt: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(prompt)).trim().toLowerCase() === "y";
  } finally {
    terminal.close();
  }
}

function readPinnedVersion(configPath: string, deps: BrowserCommandDeps): string {
  if (!deps.fileExists(configPath)) {
    return MANAGED_DEVTOOLS_PACKAGE_VERSION;
  }
  const cfg = deps.readFile(configPath);
  const m = /package_version:\s*(\S+)/.exec(cfg);
  return m?.[1] ?? MANAGED_DEVTOOLS_PACKAGE_VERSION;
}

function updateProposedConfig(pinned: string): string {
  return proposedBrowserOperationsConfig().replace(
    `package_version: ${MANAGED_DEVTOOLS_PACKAGE_VERSION}`,
    `package_version: ${pinned}`,
  );
}

function updateCheckCommand(args: string[], deps: BrowserCommandDeps): number {
  const json = args.includes("--json");
  const cfgPath = deps.configPath();
  const pinned = readPinnedVersion(cfgPath, deps);
  const vs = deps.versionSource ?? pinnedDevToolsVersionSource(pinned);
  const version = new BrowserTransportVersion(pinned, vs);
  const result = version.check();

  if (json) {
    deps.stdout(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  const lines = [
    "DevTools transport update check",
    "DevTools 传输更新检查",
    "",
    `  pinned:    ${result.pinned}`,
    `  candidate: ${result.candidate ?? "(none)"}`,
    "",
  ];
  if (result.updateAvailable) {
    lines.push(
      `  Update available: ${result.pinned} → ${result.candidate}`,
      `  有可用更新：${result.pinned} → ${result.candidate}`,
      "",
      "  Run `roll browser update --apply --confirm` to apply after approval.",
      "  运行 `roll browser update --apply --confirm` 经确认后应用。",
    );
  } else {
    lines.push(
      `  Already up to date at ${result.pinned}.`,
      `  已是最新版本 ${result.pinned}。`,
    );
  }
  lines.push("");
  deps.stdout(lines.join("\n") + "\n");
  return 0;
}

async function updateApplyCommand(args: string[], deps: BrowserCommandDeps): Promise<number> {
  const confirmed = args.includes("--confirm") || args.includes("--yes");
  const cfgPath = deps.configPath();
  const pinned = readPinnedVersion(cfgPath, deps);
  const vs = deps.versionSource ?? pinnedDevToolsVersionSource(pinned);
  const version = new BrowserTransportVersion(pinned, vs);

  if (!confirmed) {
    const check = version.check();
    deps.stdout(
      [
        "DevTools transport update apply",
        "DevTools 传输更新应用",
        "",
        `  pinned:    ${check.pinned}`,
        `  candidate: ${check.candidate ?? "(none)"}`,
        "",
        "  refused: applying an update requires explicit owner confirmation.",
        "  已拒绝：应用更新需要 owner 显式确认。",
        "  Re-run with --apply --confirm to apply.",
        "",
      ].join("\n") + "\n",
    );
    return 0;
  }

  const candidate = version.check().candidate;
  if (candidate === null) {
    deps.stdout(
      [
        `Already up to date at ${pinned}. Nothing to apply.`,
        `已是最新版本 ${pinned}，无需更新。`,
        "",
      ].join("\n") + "\n",
    );
    return 0;
  }

  if (deps.smokeCheck === undefined) {
    deps.stdout("error: smoke check is not available (headless / CI)\n");
    return 1;
  }

  // US-BROW-019 AC4: run smoke check first, then the real MCP probe.
  // A failed probe leaves the prior pin/config unchanged (atomic rollback).
  const smokePassed = await deps.smokeCheck();
  if (!smokePassed) {
    const doctorResult = readiness(deps);
    const doctorLines = renderBrowserDoctor(doctorResult);
    deps.stdout(
      [
        `Update verification failed: ${pinned} → ${candidate}`,
        `更新验证失败：${pinned} → ${candidate}`,
        `  reason: smoke check failed`,
        `  原因：冒烟检查失败`,
        "",
        `  Prior version ${pinned} is kept intact.`,
        `  已保留原版本 ${pinned}。`,
        "",
        `  browser doctor:`,
        `  浏览器体检：`,
        ...doctorLines.map((l) => `    ${l}`),
        "",
      ].join("\n") + "\n",
    );
    return 1;
  }

  // US-BROW-019 AC4: run the real MCP lane probe after candidate validation.
  // A failed probe aborts the update; the prior pin stays intact.
  let probeResult: BrowserProbeResult;
  if (deps.runProbe !== undefined) {
    probeResult = await deps.runProbe();
  } else {
    // Production path: real MCP probe.
    const { runMcpProbe, defaultMcpProbeObserver } = await import("@roll/infra");
    const observer = defaultMcpProbeObserver(deps.stdout);
    probeResult = await runMcpProbe({ observer });
  }

  if (probeResult.kind === "failed") {
    deps.stdout(
      [
        `Update aborted: live MCP probe failed for ${candidate}`,
        `更新中止：${candidate} 实时 MCP 探测失败`,
        "",
        `  Prior version ${pinned} is kept intact.`,
        `  已保留原版本 ${pinned}。`,
        "",
        ...probeResult.failures.map((f) => `  ${f.category}: ${f.message}`),
        "",
      ].join("\n") + "\n",
    );
    return 1;
  }

  // Probe passed — apply the update.
  const applySmokeCheck = deps.smokeCheck;
  const result = await version.apply(candidate, applySmokeCheck);

  if (result.kind === "applied") {
    const newCfg = updateProposedConfig(result.to);
    deps.writeFile(cfgPath, newCfg);
    const doctorResult = readiness(deps, probeResult);
    const doctorLines = renderBrowserDoctor(doctorResult);
    deps.stdout(
      [
        `Update applied: ${result.from} → ${result.to}`,
        `更新已应用：${result.from} → ${result.to}`,
        `  wrote: ${cfgPath}`,
        "",
        `  smoke check: passed`,
        `  冒烟检查：通过`,
        "",
        `  MCP probe: passed (${probeResult.version})`,
        `  MCP 探测：通过 (${probeResult.version})`,
        "",
        `  browser doctor:`,
        `  浏览器体检：`,
        ...doctorLines.map((l) => `    ${l}`),
        "",
      ].join("\n") + "\n",
    );
    return 0;
  }

  if (result.kind === "verification_failed") {
    const doctorLines = renderBrowserDoctor(readiness(deps));
    deps.stdout(
      [
        `Update verification failed: ${result.from} → ${result.candidate}`,
        `更新验证失败：${result.from} → ${result.candidate}`,
        `  reason: ${result.reason}`,
        `  原因：${result.reason}`,
        "",
        `  Prior version ${result.from} is kept intact.`,
        `  已保留原版本 ${result.from}。`,
        "",
        `  browser doctor:`,
        `  浏览器体检：`,
        ...doctorLines.map((l) => `    ${l}`),
        "",
      ].join("\n") + "\n",
    );
    return 1;
  }

  deps.stdout(`Update refused: ${result.kind === "no_update" ? "already at this version" : result.reason}\n`);
  return 0;
}

export async function browserCommand(args: string[], depsOverride?: Partial<BrowserCommandDeps>): Promise<number> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    deps.stdout(USAGE);
    return 0;
  }
  if (sub === "setup") return setupCommand(args.slice(1), deps);
  if (sub === "doctor") return doctorSubcommand(args.slice(1), deps);
  if (sub === "run") return runSubcommand(args.slice(1), deps);
  if (sub === "interactive") return interactiveSubcommand(args.slice(1), deps);
  if (sub === "update") return updateSubcommand(args.slice(1), deps);
  process.stderr.write(`roll browser: unknown subcommand '${sub}'\n\n${USAGE}`);
  return 1;
}

function updateSubcommand(args: string[], deps: BrowserCommandDeps): number | Promise<number> {
  // Default to --check when no flags
  if (args.length === 0 || args.includes("--check")) {
    return updateCheckCommand(args, deps);
  }
  if (args.includes("--apply")) {
    return updateApplyCommand(args, deps);
  }
  return updateCheckCommand(args, deps);
}
