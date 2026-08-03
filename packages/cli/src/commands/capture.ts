/**
 * `roll capture` — US-EVID-032 capture policy migration, evidence-only repair,
 * and readiness status.
 *
 *   roll capture status  [--workspace <id|path>] [--json]
 *     Show v2 gateway + renderer readiness and the effective capture policy,
 *     each with an actionable reason (AC4).
 *
 *   roll capture migrate [--workspace <id|path>] [--revert] [--dry-run] [--json]
 *     Enable best_effort ONLY when the v2 gateway AND renderer are both ready;
 *     otherwise retain the existing policy with an explicit reason. Idempotent
 *     and reversible (`--revert`). Writes .roll/policy.yaml unless --dry-run (AC1).
 *
 *   roll capture repair <story-id> [--workspace <id|path>] [--health <path>] [--json]
 *     Evidence-only repair for a `degraded-infrastructure` record: re-run the
 *     capture lanes and re-resolve evidence health WITHOUT reopening the
 *     completed build. Refuses (never rebuilds) for a failed delivery or any
 *     non-degraded state (AC2).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isEvidenceOnlyRepairable,
  planCapturePolicyMigration,
  refreshCaptureCapabilities,
  repairDegradedEvidence,
  revertCapturePolicyMigration,
  type AdapterCapabilityProbe,
  type CaptureLanePort,
  type CaptureMigrationCapabilities,
  type CaptureReceiptStorePort,
  type DeclaredSurface,
  type EvidenceHealthFact,
} from "@roll/core";
import {
  RollCaptureReceiptStore,
  captureControlledLocalPage,
  chromiumInstalled,
  isLoopbackCaptureUrl,
  type ControlledLocalPageCaptureInput,
  type ControlledLocalWindowCaptureResult,
  type ControlledPrepareAction,
} from "@roll/infra";
import { ROLL_CAPTURE_PROTOCOL_V1, resolveLang, t, v3Catalog, type Lang, type WorkspaceExecutionAuthorityPaths } from "@roll/spec";
import { configLang } from "./lang.js";
import { collectCapturePolicyReadiness, renderCapturePolicyReadinessDoctorSection, resolveCaptureHostRoot, type CapturePolicyReadiness } from "../lib/capture-policy-readiness.js";
import { requireWorkspaceAuthorities, requireWorkspaceMutationPath } from "../lib/workspace-project-authority.js";

/** Resolve the display language for this command, including configLang. */
function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    configLang: configLang(),
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function msg(key: string, ...args: ReadonlyArray<string | number>): string {
  return t(v3Catalog, msgLang(), key, ...args);
}

function captureUsage(): string {
  return msg("capture.usage");
}

export interface CaptureCommandDeps {
  /** Selected project/Workspace root. */
  projectPath?: string;
  /** Canonical Workspace project-data authorities. Omitted for legacy callers. */
  authorities?: WorkspaceExecutionAuthorityPaths;
  /** Read a text file; null when absent/unreadable. */
  readFileText?: (path: string) => string | null;
  /** Atomically write policy / health text. */
  writeFileText?: (path: string, text: string) => void;
  /** Readiness collector (injected for tests). */
  readiness?: (projectRoot: string) => CapturePolicyReadiness;
  /** Prior evidence-health fact reader for `repair` (injected for tests). */
  readHealthFact?: (path: string) => EvidenceHealthFact | null;
  /** Capture lanes for a real re-capture during `repair` (default: none wired). */
  lanes?: readonly CaptureLanePort[];
  /** Receipt store for `repair` (default: real RollCaptureReceiptStore). */
  store?: CaptureReceiptStorePort;
  /** Declared surface resolver for `repair` (from the story spec). */
  resolveSurface?: (storyId: string, projectRoot: string) => DeclaredSurface | null;
  /** FIX-005: isolated, loopback-only visible Chrome + Roll Capture lane. */
  captureLocalWindow?: (input: ControlledLocalPageCaptureInput) => Promise<ControlledLocalWindowCaptureResult>;
  /** US-PHYSICAL-012: override the Roll Capture host root for `refresh` (tests). */
  captureHostRoot?: string;
  /** US-PHYSICAL-012: override the renderer probe for `refresh` (tests). */
  rendererInstalled?: () => boolean;
  now?: () => Date;
}

function defaultReadFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteFileText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

export async function captureCommand(args: string[], deps: CaptureCommandDeps = {}): Promise<number> {
  const sub = args[0] ?? "";
  if (sub === "" || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(captureUsage());
    return 0;
  }
  const rest = args.slice(1);
  if (sub === "status") return captureStatus(rest, deps);
  if (sub === "migrate") return captureMigrate(rest, deps);
  if (sub === "repair") return captureRepair(rest, deps);
  if (sub === "refresh") return captureRefresh(rest, deps);
  if (sub === "local-window") return captureLocalWindow(rest, deps);
  process.stderr.write(msg("capture.unknown_subcommand", sub) + "\n");
  process.stderr.write(captureUsage());
  return 1;
}

// ── refresh (US-PHYSICAL-012) — write honest host capabilities.json ─────────

async function captureRefresh(args: string[], deps: CaptureCommandDeps): Promise<number> {
  const json = args.includes("--json");
  const captureRoot = deps.captureHostRoot ?? resolveCaptureHostRoot();
  const rendererServed = (deps.rendererInstalled ?? chromiumInstalled)();
  const probe: AdapterCapabilityProbe = {
    rendererServed,
    ...(rendererServed
      ? {}
      : { rendererReason: "Playwright Chromium is not installed; run `npx playwright install chromium`" }),
    // The native Roll Capture host speaks v1 (file-drop). Physical v2 is
    // US-PHYSICAL-014 — never advertised here, so status stays honest.
    physical: {
      protocol: ROLL_CAPTURE_PROTOCOL_V1,
      served: true,
      reason: "Roll Capture.app is v1-only; physical v2 pending US-PHYSICAL-014",
    },
    hostVersion: "roll-adapter",
  };
  const { advertisement, path } = refreshCaptureCapabilities(captureRoot, probe);
  if (json) {
    process.stdout.write(JSON.stringify({ path, advertisement }, null, 2) + "\n");
  } else {
    process.stdout.write(msg("capture.refresh.wrote", path) + "\n");
  }
  return 0;
}

// ── local-window (FIX-005) ──────────────────────────────────────────────────

async function captureLocalWindow(args: string[], deps: CaptureCommandDeps): Promise<number> {
  const storyId = flagValue(args, "--story");
  const url = flagValue(args, "--url");
  const projectRoot = deps.projectPath ?? flagValue(args, "--project") ?? process.cwd();
  const runId = flagValue(args, "--run") ?? `local-${(deps.now ?? (() => new Date()))().toISOString().replace(/[^0-9]/gu, "")}`;
  const rawPrepare = flagValue(args, "--prepare");
  const json = args.includes("--json");
  if (storyId === undefined || url === undefined) {
    process.stdout.write(msg("capture.local_window.usage") + "\n");
    return 1;
  }
  if (!safeSegment(storyId) || !safeSegment(runId)) {
    process.stdout.write(msg("capture.local_window.unsafe_id") + "\n");
    return 1;
  }
  if (!isLoopbackCaptureUrl(url)) {
    process.stdout.write(msg("capture.local_window.loopback_only") + "\n");
    return 1;
  }
  const prepare = parseControlledPrepare(rawPrepare);
  if (typeof prepare === "string") {
    process.stdout.write(`local-window ${prepare}\n`);
    return 1;
  }

  const now = (deps.now ?? (() => new Date()))();
  const captureId = randomUUID();
  const result = await (deps.captureLocalWindow ?? captureControlledLocalPage)({
    projectRoot,
    url,
    prepare,
    request: {
      protocol: "roll.capture.v1",
      requestId: `controlled-${storyId}-${captureId}`,
      storyId,
      runId,
      kind: "web",
      out: join(deps.authorities?.evidence ?? join(projectRoot, ".roll", "captures"), "controlled-local", storyId, runId, `controlled-window-${captureId}.png`),
      timeoutMs: 60_000,
      createdAt: now.toISOString(),
    },
  });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write([
      msg("capture.local_window.result", result.status),
      msg("capture.local_window.no_extension"),
      msg("capture.local_window.privacy"),
      ...(result.selector === undefined ? [] : [msg("capture.local_window.selector", result.selector.appName, result.selector.windowTitle)]),
      ...(result.path === undefined ? [] : [msg("capture.local_window.screenshot", result.path)]),
      ...(result.response?.responsePath === undefined ? [] : [msg("capture.local_window.receipt", result.response.responsePath)]),
      ...(result.reason === undefined ? [] : [msg("capture.local_window.reason", result.reason)]),
    ].join("\n") + "\n");
  }
  return result.status === "taken" ? 0 : 1;
}

function parseControlledPrepare(raw: string | undefined): readonly ControlledPrepareAction[] | undefined | string {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return msg("capture.local_window.prepare_must_be_list");
  }
  if (!Array.isArray(parsed)) return msg("capture.local_window.prepare_must_be_list");
  if (parsed.length > 16) return msg("capture.local_window.prepare_max_actions");
  let totalWaitMs = 0;
  const actions: ControlledPrepareAction[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return msg("capture.local_window.prepare_action_object");
    const action = item as Record<string, unknown>;
    const kind = action.kind;
    if (kind === "wait") {
      if (!hasOnly(action, ["kind", "ms"]) || typeof action.ms !== "number" || !Number.isInteger(action.ms) || action.ms < 0 || action.ms > 5_000) {
        return msg("capture.local_window.prepare_wait_ms");
      }
      totalWaitMs += action.ms;
      if (totalWaitMs > 15_000) return msg("capture.local_window.prepare_waits_max");
      actions.push({ kind, ms: action.ms });
      continue;
    }
    if (kind === "click" || kind === "scroll") {
      if (!hasOnly(action, ["kind", "selector"]) || !validPrepareSelector(action.selector)) {
        return msg("capture.local_window.prepare_selector_required", kind);
      }
      actions.push({ kind, selector: action.selector });
      continue;
    }
    if (kind === "fill") {
      if (!hasOnly(action, ["kind", "selector", "value"]) || !validPrepareSelector(action.selector) || typeof action.value !== "string" || action.value.length > 1_000) {
        return msg("capture.local_window.prepare_fill_required");
      }
      actions.push({ kind, selector: action.selector, value: action.value });
      continue;
    }
    return msg("capture.local_window.prepare_only_permits");
  }
  return actions;
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function validPrepareSelector(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 500;
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value) && !value.includes("..");
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

// ── status (AC4) ──────────────────────────────────────────────────────────────

function captureStatus(args: string[], deps: CaptureCommandDeps): number {
  const projectRoot = deps.projectPath ?? flagValue(args, "--project") ?? process.cwd();
  const readiness = (deps.readiness ?? ((root: string) => collectCapturePolicyReadiness({
    projectRoot: root,
    ...(deps.authorities === undefined ? {} : { policyPath: deps.authorities.policy }),
  })))(projectRoot);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(readiness, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderCapturePolicyReadinessDoctorSection(readiness, { lang: msgLang() }).join("\n") + "\n");
  return 0;
}

// ── migrate (AC1) ─────────────────────────────────────────────────────────────

function captureMigrate(args: string[], deps: CaptureCommandDeps): number {
  const projectRoot = deps.projectPath ?? flagValue(args, "--project") ?? process.cwd();
  const dryRun = args.includes("--dry-run");
  const revert = args.includes("--revert");
  const json = args.includes("--json");
  const readFileText = deps.readFileText ?? defaultReadFileText;
  const writeFileText = deps.writeFileText ?? defaultWriteFileText;
  const policyPath = deps.authorities?.policy ?? join(projectRoot, ".roll", "policy.yaml");
  if (deps.authorities !== undefined && !requireWorkspaceAuthorities("roll capture migrate", [
    { path: policyPath, kind: "file" },
  ])) return 1;
  const policyYaml = readFileText(policyPath) ?? "";

  if (revert) {
    const result = revertCapturePolicyMigration(policyYaml);
    if (result.changed && !dryRun) writeFileText(policyPath, result.nextYaml);
    if (json) {
      process.stdout.write(JSON.stringify({ mode: "revert", ...result, dryRun }, null, 2) + "\n");
    } else {
      const suffix = dryRun ? msg("capture.dry_run_not_written") : result.changed ? msg("capture.written") : msg("capture.no_change");
      process.stdout.write(msg("capture.migrate.revert", result.reason) + suffix + "\n");
    }
    return 0;
  }

  const readiness = (deps.readiness ?? ((root: string) => collectCapturePolicyReadiness({
    projectRoot: root,
    ...(deps.authorities === undefined ? {} : { policyPath: deps.authorities.policy }),
  })))(projectRoot);
  const capabilities: CaptureMigrationCapabilities = {
    gateway: { available: readiness.gateway.available, reason: readiness.gateway.reason },
    renderer: { available: readiness.renderer.available, reason: readiness.renderer.reason },
  };
  const plan = planCapturePolicyMigration({ policyYaml, capabilities });
  if (plan.changed && !dryRun) writeFileText(policyPath, plan.nextYaml);
  if (json) {
    process.stdout.write(JSON.stringify({ mode: "migrate", ...plan, dryRun }, null, 2) + "\n");
  } else {
    const suffix = dryRun ? msg("capture.dry_run_not_written") : plan.changed ? msg("capture.written") : msg("capture.no_change");
    process.stdout.write(msg("capture.migrate.result", plan.action, plan.reasonCode) + "\n" + msg("capture.migrate.detail", plan.reason) + suffix + "\n");
  }
  return 0;
}

// ── repair (AC2) ──────────────────────────────────────────────────────────────

/** Default location of the durable evidence-health fact for a story's latest run. */
export function evidenceHealthFactPath(projectRoot: string, storyId: string, evidenceRoot?: string): string {
  return join(evidenceRoot ?? join(projectRoot, ".roll", "features", "_evidence-health"), `${storyId}.json`);
}

function defaultReadHealthFact(path: string): EvidenceHealthFact | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as EvidenceHealthFact;
  } catch {
    return null;
  }
}

async function captureRepair(args: string[], deps: CaptureCommandDeps): Promise<number> {
  const storyId = args.find((a) => !a.startsWith("--") && a !== flagValue(args, "--project") && a !== flagValue(args, "--health"));
  if (storyId === undefined || storyId === "") {
    process.stderr.write(msg("capture.repair.usage") + "\n");
    return 1;
  }
  const projectRoot = deps.projectPath ?? flagValue(args, "--project") ?? process.cwd();
  const json = args.includes("--json");
  const evidenceHealthRoot = deps.authorities === undefined
    ? undefined
    : join(deps.authorities.evidence, "_health");
  const requestedHealthPath = flagValue(args, "--health");
  const healthPath = evidenceHealthRoot === undefined || requestedHealthPath === undefined
    ? requestedHealthPath ?? evidenceHealthFactPath(projectRoot, storyId, evidenceHealthRoot)
    : resolve(
        requestedHealthPath.startsWith("evidence/") ? projectRoot : evidenceHealthRoot,
        requestedHealthPath,
      );
  if (evidenceHealthRoot !== undefined && !contained(deps.authorities?.evidence ?? evidenceHealthRoot, healthPath)) {
    process.stderr.write(`roll capture repair: authority_outside: ${healthPath}\n`);
    return 1;
  }
  if (
    deps.authorities !== undefined &&
    !requireWorkspaceMutationPath("roll capture repair", deps.authorities.evidence, healthPath, "file")
  ) return 1;
  const readHealthFact = deps.readHealthFact ?? defaultReadHealthFact;
  const writeFileText = deps.writeFileText ?? defaultWriteFileText;

  const prior = readHealthFact(healthPath);
  if (prior === null) {
    emitRepair(json, { repaired: false, reopenedBuild: false, buildUntouched: true, reason: msg("capture.repair.no_record", healthPath) });
    return 1;
  }

  // Guard FIRST — never rebuild a failed or non-degraded delivery.
  if (!isEvidenceOnlyRepairable(prior)) {
    const reason =
      prior.delivery === "failed"
        ? msg("capture.repair.failed_delivery")
        : msg("capture.repair.not_degraded", prior.visual);
    emitRepair(json, { repaired: false, reopenedBuild: false, buildUntouched: true, priorHealth: prior, reason });
    return 1;
  }

  const store = deps.store ?? new RollCaptureReceiptStore();
  const lanes = deps.lanes ?? [];
  const surface =
    deps.resolveSurface?.(storyId, projectRoot) ?? {
      declaredUrl: prior.surfaceId ?? "",
      expectedAcIds: [],
    };
  const runId = `repair-${(deps.now ?? (() => new Date()))().toISOString().replace(/[^0-9]/gu, "")}`;
  const runDir = join(
    evidenceHealthRoot ?? join(projectRoot, ".roll", "features", "_evidence-health"),
    "repairs",
    `${storyId}-${runId}`,
  );

  const outcome = await repairDegradedEvidence(
    prior,
    { storyId, runId, runDir, projectRoot, surface },
    lanes,
    store,
  );
  if (outcome.newHealth !== undefined) {
    writeFileText(healthPath, JSON.stringify(outcome.newHealth, null, 2) + "\n");
  }
  emitRepair(json, outcome);
  return 0;
}

function emitRepair(
  json: boolean,
  outcome: {
    repaired: boolean;
    reopenedBuild: boolean;
    buildUntouched: boolean;
    priorHealth?: EvidenceHealthFact;
    newHealth?: EvidenceHealthFact;
    reason: string;
  },
): void {
  if (json) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
    return;
  }
  const status = outcome.repaired ? "re-ran capture (evidence-only)" : "no repair";
  process.stdout.write(
    msg("capture.repair.result", status) + "\n" +
      msg("capture.repair.reopened", String(outcome.reopenedBuild), String(outcome.buildUntouched)) + "\n" +
      (outcome.newHealth !== undefined ? msg("capture.repair.visual", outcome.priorHealth?.visual ?? "?", outcome.newHealth.visual) + "\n" : "") +
      `  ${outcome.reason}\n`,
  );
}
