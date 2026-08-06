/**
 * US-DELTA-003 — protocol-only `roll delta` CLI.
 *
 * Hidden from the public command surface; discoverable via `roll delta help`.
 * Implements prepare/validate/conclude/status/help command plumbing using the
 * no-cycle allocation/recovery protocol. No spawning, no Pi host API, no
 * cycle/run integration.
 */
import { resolveLang, t, v3Catalog } from "@roll/spec";
import {
  DELEGATION_TRIGGERS,
  DELIVERY_TOPOLOGIES,
  QUALITY_PROFILES,
  DELTA_ROLES,
  RESOLUTION_SOURCES,
  DELTA_BLOCK_REASONS,
  type DelegationTrigger,
  type DeliveryTopology,
  type QualityProfile,
  type DeltaRole,
  type DeltaBlockReason,
  isKnownHistoricalBlockReason,
} from "@roll/spec";
import {
  prepareDelegation,
  PrepareError,
  resolveExistingUniqueCardArchiveDir,
  detectOrphanFrames,
  releaseHostDelegationLease,
  type PrepareInput,
} from "../lib/delta-allocation.js";
import { loadLocalPresets } from "../lib/delta-artifacts.js";
import { managedWorkspaceOperationId } from "../lib/managed-workspace-operation.js";
import { renderDeltaBanner, renderDeltaPhaseBanner, type DeltaBannerCopy } from "../lib/delta-banner.js";
import { EventBus, attemptCauseFromBlockReason, projectDelegationStatus, projectDeltaMetrics, readLeases, validateDeltaManifest, promoteHostDelegationLease, transferDeliveryReservation, observeBuilderSubmission, validateBuilderSubmission, builderSubmissionSnapshotsMatch, deriveRigCandidates, type BuilderObservationResult, type BuilderSubmissionContext, type BuilderSubmissionObserver, type BuilderSubmissionSnapshot, type DeltaDeliveryFact, type DeltaMetrics, type ObservedBuilderHead } from "@roll/core";
import { parseEventLine, type DelegationResolution, type DeltaArtifactManifest, type DeltaAttemptOutcomeEvent, type DeltaRoleAvailabilityObservedEvent, type ManagedWorkspaceSet, type RollEvent } from "@roll/spec";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep, relative } from "node:path";
import { configLang } from "./lang.js";
import { loadRigAdapterMappings } from "../lib/rig-adapters.js";
import { loadRigReadinessLimits } from "../lib/rig-readiness-settings.js";
import { nodeRigStorageIo, publishRigReadinessSnapshot, readRigReadinessCache, writeRigReadinessSnapshot } from "../lib/rig-readiness-storage.js";
import { createRigProbeAdapters, nodeRigProbeDependencies, runRigReadinessProbesWithTimeout } from "../lib/delta-rig-probe.js";
import { renderRigReadiness } from "../lib/delta-rig-readiness.js";

// ── Locale resolution ────────────────────────────────────────────────────────

function lang() {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

/** US-DELTA-018 adds the persisted `roll config lang` rung to this new surface. */
function rigsLang() {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    configLang: configLang(),
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function T(key: string, ...args: Array<string | number>): string {
  return t(v3Catalog, lang(), key, ...args);
}

function rigsT(key: string, ...args: Array<string | number>): string {
  return t(v3Catalog, rigsLang(), key, ...args);
}

function deltaBannerCopy(): DeltaBannerCopy {
  return {
    title: T("delta.banner.title"),
    story: T("delta.banner.story"),
    diversity: T("delta.banner.diversity"),
    diversityDistinct: T("delta.banner.diversity_distinct", "{builder}", "{evaluator}"),
    diversityUndeclared: T("delta.banner.diversity_undeclared"),
    frame: T("delta.banner.frame"),
    leaseHeld: T("delta.banner.lease_held"),
  };
}

function validationPhaseBanner(
  delegationId: string,
  stage: DeltaRole,
  verdict: "allowed" | "blocked",
  reason?: string,
): string {
  return renderDeltaPhaseBanner({
    title: T("delta.phase.validate.title"),
    fields: [
      { label: T("delta.phase.delegation"), value: delegationId },
      { label: T("delta.phase.stage"), value: stage },
      { label: T("delta.phase.verdict"), value: verdict === "allowed" ? T("delta.phase.allowed") : T("delta.phase.blocked") },
      ...(reason === undefined ? [] : [{ label: T("delta.phase.reason"), value: reason }]),
    ],
  });
}

/**
 * Write the derived outcome alongside its source fact, while retaining the
 * source as the final event for existing lifecycle readers. A delegation gets
 * one terminal cause; conflicts remain visible in the pure read projection.
 */
function appendAttemptOutcomeBefore(
  bus: EventBus,
  eventsPath: string,
  source: Extract<RollEvent, { type: "delta:blocked" }> | Extract<RollEvent, { type: "delta:terminal" }>,
): void {
  const existing = bus.readEvents(eventsPath).some((event) =>
    event.type === "delta:attempt_outcome" && event.delegationId === source.delegationId,
  );
  if (existing) return;
  const cause = source.type === "delta:blocked"
    ? attemptCauseFromBlockReason(source.reason)
    : source.deliveryDisposition === "owner_redelegate"
      ? "owner_scope_change"
      : "unknown";
  const outcome: DeltaAttemptOutcomeEvent = {
    type: "delta:attempt_outcome",
    v: 1,
    delegationId: source.delegationId,
    storyId: source.storyId,
    cause,
    evidenceRef: source.type === "delta:blocked"
      ? `event:delta:blocked/${source.reason}`
      : `event:delta:terminal/${source.deliveryDisposition ?? "unknown"}`,
    terminalFact: source.type === "delta:blocked" ? "blocked" : "handoff_ready",
    ts: source.ts,
  };
  bus.appendEvent(eventsPath, outcome);
}

function appendDeltaBlocked(
  bus: EventBus,
  eventsPath: string,
  event: Extract<RollEvent, { type: "delta:blocked" }>,
): void {
  appendAttemptOutcomeBefore(bus, eventsPath, event);
  bus.appendEvent(eventsPath, event);
}

function concludePhaseBanner(input: {
  readonly delegationId: string;
  readonly storyId: string;
  readonly outcome: string;
  readonly disposition?: string;
  readonly reason?: string;
}): string {
  return renderDeltaPhaseBanner({
    title: T("delta.phase.conclude.title"),
    fields: [
      { label: T("delta.phase.delegation"), value: input.delegationId },
      { label: T("delta.banner.story"), value: input.storyId },
      { label: T("delta.phase.outcome"), value: input.outcome },
      { label: T("delta.phase.disposition"), value: input.disposition ?? T("delta.phase.disposition_unselected") },
      ...(input.reason === undefined ? [] : [{ label: T("delta.phase.reason"), value: input.reason }]),
    ],
  });
}

/** Read only the persisted resolution artifact before rendering any banner facts. */
function readPersistedResolution(resolutionPath: string): DelegationResolution {
  return JSON.parse(readFileSync(resolutionPath, "utf8")) as DelegationResolution;
}

/**
 * Workspace schema is a write-time protocol discriminator.  Only the absent
 * historical field and the explicitly recorded v1 boundary are legacy; an
 * unknown literal must never be quietly interpreted as old data.
 */
function preparedWorkspaceSchema(prepared: Record<string, unknown>): "legacy" | "managed-v2" | "unknown" {
  const schema = prepared.workspaceSchema;
  if (schema === undefined || schema === 1) return "legacy";
  if (schema === 2) return "managed-v2";
  return "unknown";
}

// ── Argument parser ──────────────────────────────────────────────────────────

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
};

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // Subcommand is first positional
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx >= 0) {
        const key = a.slice(2, eqIdx);
        const val = a.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        // Look ahead for value
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }

  return { positional, flags };
}

/** Detect duplicate --flags in raw args. Returns first duplicate key or null. */
function detectDuplicateFlags(rawArgs: string[], knownFlags: Set<string>): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]!;
    if (!a.startsWith("--")) continue;
    const eqIdx = a.indexOf("=");
    const key = eqIdx >= 0 ? a.slice(2, eqIdx) : a.slice(2);
    if (knownFlags.has(key)) {
      if (seen.has(key)) return key;
      seen.add(key);
    }
  }
  return null;
}

// ── Enum validation ──────────────────────────────────────────────────────────

function checkEnumFlag(flags: Record<string, string | true>, key: string, allowed: readonly string[]): string | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  if (!(allowed as readonly string[]).includes(v as string)) {
    return T("delta.error.invalid_value", String(v), `--${key}`, allowed.join("|"));
  }
  return undefined;
}

function receivedValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function receivedType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Returns a rejection reason, or null when every supplied template role is admissible. */
function validateTemplateRoles(roles: unknown): string | null {
  if (roles === undefined) return null;
  if (!Array.isArray(roles)) {
    return `Resolution template roles must be an array (received ${receivedType(roles)})`;
  }

  const seenRoles = new Map<string, number>();
  for (const [index, candidate] of roles.entries()) {
    const location = `roles[${index}]`;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return `Resolution template ${location} must be a non-null object (received ${receivedType(candidate)})`;
    }
    const roleRecord = candidate as Record<string, unknown>;
    const role = roleRecord.role;
    if (typeof role !== "string" || !(DELTA_ROLES as readonly string[]).includes(role)) {
      return `Resolution template ${location}.role ${receivedValue(role)} is not a valid Delta role (${DELTA_ROLES.join("|")})`;
    }

    const roleLocation = `${location}`;
    for (const field of ["roleInstanceId", "hostId", "modelId"] as const) {
      const value = roleRecord[field];
      if (typeof value !== "string" || value.trim() === "") {
        return `Resolution template ${roleLocation}.${field} must be a non-empty string for role ${JSON.stringify(role)} (received ${receivedValue(value)})`;
      }
    }
    const source = roleRecord.source;
    if (typeof source !== "string" || !(RESOLUTION_SOURCES as readonly string[]).includes(source)) {
      return `Resolution template ${roleLocation}.source ${receivedValue(source)} is not a valid resolution source for role ${JSON.stringify(role)} (${RESOLUTION_SOURCES.join("|")})`;
    }
    const reasons = roleRecord.reasons;
    if (!Array.isArray(reasons)) {
      return `Resolution template ${roleLocation}.reasons must be an array of strings for role ${JSON.stringify(role)} (received ${receivedType(reasons)})`;
    }
    const invalidReasonIndex = reasons.findIndex((reason) => typeof reason !== "string");
    if (invalidReasonIndex !== -1) {
      return `Resolution template ${roleLocation}.reasons must be an array of strings for role ${JSON.stringify(role)} (received ${receivedType(reasons[invalidReasonIndex])} at index ${invalidReasonIndex})`;
    }

    const firstIndex = seenRoles.get(role);
    if (firstIndex !== undefined) {
      return `Resolution template declares role ${JSON.stringify(role)} twice (roles[${firstIndex}], ${location})`;
    }
    seenRoles.set(role, index);
  }
  return null;
}

// ── Subcommand routing ────────────────────────────────────────────────────────

export async function deltaCommand(args: string[]): Promise<number> {
  const sub = args[0];

  // Help
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    const recoveryHelp = lang() === "zh"
      ? "\n  roll delta recover-held --delegation <旧委派-id> --continuation-run <继任名称> --confirm <旧委派-id> [--json]\n    仅在明确确认后恢复历史 owner_hold 暂缓记录中被错误改名给该继任者的预留。\n"
      : "\n  roll delta recover-held --delegation <old-id> --continuation-run <name> --confirm <old-id> [--json]\n    Explicitly recover only a legacy owner_hold reservation incorrectly named to this successor.\n";
    const usage = T("delta.help.usage")
      .replace("prepare|validate|conclude|status|help", "prepare|validate|conclude|recover-held|rigs|status|help")
      .replace("\n  roll delta status", `${recoveryHelp}\n  roll delta status`)
      .replace(
      "\n  roll delta conclude",
      `${T("delta.help.preflight")}${T("delta.help.metrics")}${T("delta.rigs.help")}  roll delta conclude`,
      );
    process.stdout.write(usage + T("delta.help.builder_receipt"));
    return 0;
  }

  // Route to subcommand
  switch (sub) {
    case "rigs":
      return await rigsCommand(args.slice(1));
    case "prepare":
      return await prepareCommand(args.slice(1));
    case "preflight":
      return preflightCommand(args.slice(1));
    case "validate":
      return validateCommand(args.slice(1));
    case "conclude":
      return concludeCommand(args.slice(1));
    case "recover-held":
      return recoverHeldCommand(args.slice(1));
    case "status":
      return statusCommand(args.slice(1));
    case "metrics":
      return metricsCommand(args.slice(1));
    default:
      process.stderr.write(`${T("delta.error.unknown_subcommand", sub)}\n`);
      return 1;
  }
}

// ── US-DELTA-018 — machine-local exact-model rig readiness ─────────────────

function rollHome(): string {
  return process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
}

function deriveConfiguredRigCandidates(root: string) {
  const sources = loadLocalPresets(root).flatMap((preset) =>
    (Object.entries(preset.roles) as Array<[string, { readonly preferredModelIds: readonly string[] }]>).flatMap(([role, preference]) =>
      preference.preferredModelIds.map((configuredModelId) => ({ presetId: preset.id, role, configuredModelId })),
    ),
  );
  return deriveRigCandidates(sources, loadRigAdapterMappings(root));
}

/** Strictly parse the intentionally small human-only `roll delta rigs` surface. */
async function rigsCommand(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const duplicate = detectDuplicateFlags(args, new Set(["refresh"]));
  if (duplicate !== null) {
    process.stderr.write(`${rigsT("delta.error.duplicate_flag", `--${duplicate}`)}\n`);
    return 1;
  }
  if (positional.length > 0) {
    process.stderr.write(`${rigsT("delta.error.unexpected_positional", positional[0]!)}\n`);
    return 1;
  }
  for (const flag of Object.keys(flags)) {
    if (flag !== "refresh") {
      process.stderr.write(`${rigsT("delta.error.unknown_flag", `--${flag}`)}\n`);
      return 1;
    }
  }
  if (flags["refresh"] !== undefined && flags["refresh"] !== true) {
    process.stderr.write(`${rigsT("delta.error.invalid_value", String(flags["refresh"]), "--refresh", "no value")}\n`);
    return 1;
  }

  try {
    const root = rollHome();
    const limits = loadRigReadinessLimits(root);
    const candidates = deriveConfiguredRigCandidates(root);
    const storage = { io: nodeRigStorageIo, root, now: () => Date.now(), newRefreshId: () => randomUUID() };
    if (flags["refresh"] === true) {
      const observations = await runRigReadinessProbesWithTimeout(
        candidates,
        limits.maxConcurrency,
        limits.probeTimeoutMs,
        createRigProbeAdapters(nodeRigProbeDependencies()),
      );
      const snapshot = writeRigReadinessSnapshot(storage, candidates, observations);
      publishRigReadinessSnapshot(storage, candidates, snapshot.refreshId);
    }
    const cache = readRigReadinessCache(storage, candidates, limits.freshnessTtlMs);
    process.stdout.write(renderRigReadiness({ candidates, snapshot: cache.snapshot, cache: cache.status, lang: rigsLang() }));
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${rigsT("delta.rigs.error", detail)}\n`);
    return 1;
  }
}

// ── US-DELTA-013 — read-only delivery metrics ───────────────────────────────

type MetricsFlags = "json" | "from" | "to" | "from-ts" | "to-ts";

function parseMetricsTs(value: string | true | undefined, flag: string): number | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (value === true || value.trim() === "") return { error: `${flag} requires an epoch-ms number or ISO timestamp` };
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return numberValue;
  const isoValue = Date.parse(value);
  return Number.isFinite(isoValue) ? isoValue : { error: `${flag} must be an epoch-ms number or ISO timestamp` };
}

function metricFiles(loopPath: string, name: string): string[] {
  if (!existsSync(loopPath)) return [];
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.(\\d+))?$`);
  return readdirSync(loopPath)
    .flatMap((entry) => {
      const matched = pattern.exec(entry);
      return matched === null ? [] : [{ path: join(loopPath, entry), rotation: matched[1] === undefined ? 0 : Number(matched[1]) }];
    })
    .sort((a, b) => b.rotation - a.rotation || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

function readMetricEvents(loopPath: string): { events: RollEvent[]; diagnostics: string[] } {
  const events: RollEvent[] = [];
  const diagnostics: string[] = [];
  for (const path of metricFiles(loopPath, "events.ndjson")) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      diagnostics.push(`cannot read event ledger ${path}`);
      continue;
    }
    for (const [index, raw] of text.split("\n").entries()) {
      if (raw.trim() === "") continue;
      const event = parseEventLine(raw);
      if (event === null) diagnostics.push(`invalid event ledger line ${path}:${index + 1} (metrics incomplete)`);
      else events.push(event);
    }
  }
  return { events, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMetricDeliveries(loopPath: string): { deliveries: DeltaDeliveryFact[]; diagnostics: string[] } {
  const deliveries: DeltaDeliveryFact[] = [];
  const diagnostics: string[] = [];
  for (const path of metricFiles(loopPath, "deliveries.jsonl")) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      diagnostics.push(`cannot read delivery ledger ${path}`);
      continue;
    }
    for (const [index, raw] of text.split("\n").entries()) {
      if (raw.trim() === "") continue;
      let row: unknown;
      try {
        row = JSON.parse(raw);
      } catch {
        diagnostics.push(`invalid delivery ledger line ${path}:${index + 1} (merge fact unavailable)`);
        continue;
      }
      if (!isRecord(row) || typeof row["storyId"] !== "string" || row["storyId"] === "") {
        diagnostics.push(`invalid delivery record ${path}:${index + 1} (merge fact unavailable)`);
        continue;
      }
      const mergedAt = row["mergedAt"];
      const mergedAtMs = isRecord(mergedAt) && mergedAt["present"] === true && typeof mergedAt["value"] === "number" && Number.isFinite(mergedAt["value"])
        ? mergedAt["value"]
        : undefined;
      deliveries.push({
        storyId: row["storyId"],
        ...(typeof row["lifecycleState"] === "string" ? { lifecycleState: row["lifecycleState"] } : {}),
        ...(mergedAtMs === undefined ? {} : { mergedAtMs }),
      });
    }
  }
  return { deliveries, diagnostics };
}

function formatMetricMs(value: number | null): string {
  if (value === null) return "?";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(2)}s`;
}

function formatMetricRate(value: number | null): string {
  return value === null ? "?" : `${(value * 100).toFixed(1)}%`;
}

export function renderDeltaMetrics(report: DeltaMetrics, language = lang()): string {
  const zh = language === "zh";
  const window = report.window.fromTs === undefined && report.window.toTs === undefined
    ? (zh ? "全部已记录事件时间" : "all observed event time")
    : `${report.window.fromTs ?? "…"}..${report.window.toTs ?? "…"}`;
  const samples = report.phaseSamples;
  const title = zh ? "Delta 团队交付指标（只读）" : "Delta delivery metrics (read-only)";
  const labels = zh
    ? [
      `窗口：${window}（按事件记录时间）`,
      `样本：${report.cards} 张卡，${report.attempts} 次尝试，${report.mergedCards} 张已合并`,
      `首次合并：${formatMetricRate(report.firstPassMergeRate.value)}（${report.firstPassMergeRate.numerator}/${report.firstPassMergeRate.denominator}）`,
      `重新交接：${formatMetricRate(report.redelegateRate.value)}（${report.redelegateRate.numerator}/${report.redelegateRate.denominator}）`,
      `建造耗时：${formatMetricMs(samples.builder.totalMs)}；样本 ${samples.builder.sampleSize}，P50 ${formatMetricMs(samples.builder.p50Ms)}，P95 ${formatMetricMs(samples.builder.p95Ms)}`,
      `评审耗时：${formatMetricMs(samples.evaluator.totalMs)}；样本 ${samples.evaluator.sampleSize}，P50 ${formatMetricMs(samples.evaluator.p50Ms)}，P95 ${formatMetricMs(samples.evaluator.p95Ms)}`,
      `合并尾段：${formatMetricMs(samples.mergeTail.totalMs)}；样本 ${samples.mergeTail.sampleSize}，P50 ${formatMetricMs(samples.mergeTail.p50Ms)}，P95 ${formatMetricMs(samples.mergeTail.p95Ms)}`,
      `TCR：回合 ${report.tcr.rounds ?? "?"}，绿 ${report.tcr.green ?? "?"}，红 ${report.tcr.red ?? "?"}，测试耗时 ${formatMetricMs(report.tcr.testWallMs)}`,
      `百分位算法：nearest-rank；数据${report.incomplete ? `不完整（${report.diagnostics.length} 条提示）` : "完整"}`,
    ]
    : [
      `window: ${window} (observed event time)`,
      `sample: ${report.cards} cards, ${report.attempts} attempts, ${report.mergedCards} merged cards`,
      `first-pass merge: ${formatMetricRate(report.firstPassMergeRate.value)} (${report.firstPassMergeRate.numerator}/${report.firstPassMergeRate.denominator})`,
      `redelegated: ${formatMetricRate(report.redelegateRate.value)} (${report.redelegateRate.numerator}/${report.redelegateRate.denominator})`,
      `builder wall: ${formatMetricMs(samples.builder.totalMs)}; sample ${samples.builder.sampleSize}, P50 ${formatMetricMs(samples.builder.p50Ms)}, P95 ${formatMetricMs(samples.builder.p95Ms)}`,
      `evaluator wall: ${formatMetricMs(samples.evaluator.totalMs)}; sample ${samples.evaluator.sampleSize}, P50 ${formatMetricMs(samples.evaluator.p50Ms)}, P95 ${formatMetricMs(samples.evaluator.p95Ms)}`,
      `merge tail: ${formatMetricMs(samples.mergeTail.totalMs)}; sample ${samples.mergeTail.sampleSize}, P50 ${formatMetricMs(samples.mergeTail.p50Ms)}, P95 ${formatMetricMs(samples.mergeTail.p95Ms)}`,
      `TCR: rounds ${report.tcr.rounds ?? "?"}, green ${report.tcr.green ?? "?"}, red ${report.tcr.red ?? "?"}, test wall ${formatMetricMs(report.tcr.testWallMs)}`,
      `percentiles: nearest-rank; data ${report.incomplete ? `incomplete (${report.diagnostics.length} diagnostics)` : "complete"}`,
    ];
  return `${[title, "", ...labels.map((label) => `  ${label}`)].join("\n")}\n`;
}

function metricsCommand(args: string[]): number {
  const known = new Set<MetricsFlags>(["json", "from", "to", "from-ts", "to-ts"]);
  const duplicate = detectDuplicateFlags(args, known);
  const parsed = parseArgs(args);
  if (duplicate !== null || parsed.positional.length > 0 || Object.keys(parsed.flags).some((flag) => !known.has(flag as MetricsFlags))) {
    process.stderr.write("Usage: roll delta metrics [--from <epoch-ms|ISO>] [--to <epoch-ms|ISO>] [--json]\n");
    return 1;
  }
  if (parsed.flags["from"] !== undefined && parsed.flags["from-ts"] !== undefined || parsed.flags["to"] !== undefined && parsed.flags["to-ts"] !== undefined) {
    process.stderr.write("Use only one of --from/--from-ts and --to/--to-ts.\n");
    return 1;
  }
  const from = parseMetricsTs(parsed.flags["from"] ?? parsed.flags["from-ts"], "--from");
  const to = parseMetricsTs(parsed.flags["to"] ?? parsed.flags["to-ts"], "--to");
  const parseError = typeof from === "object" ? from : typeof to === "object" ? to : undefined;
  if (parseError !== undefined) {
    process.stderr.write(`${parseError.error}\n`);
    return 1;
  }
  const fromTs = typeof from === "number" ? from : undefined;
  const toTs = typeof to === "number" ? to : undefined;
  if (fromTs !== undefined && toTs !== undefined && fromTs > toTs) {
    process.stderr.write("--from must be before or equal to --to.\n");
    return 1;
  }
  const loopPath = join(process.cwd(), ".roll", "loop");
  const eventInput = readMetricEvents(loopPath);
  const deliveryInput = readMetricDeliveries(loopPath);
  const report = projectDeltaMetrics({
    events: eventInput.events,
    deliveries: deliveryInput.deliveries,
    window: { ...(fromTs === undefined ? {} : { fromTs }), ...(toTs === undefined ? {} : { toTs }) },
    sourceDiagnostics: [...eventInput.diagnostics, ...deliveryInput.diagnostics],
  });
  if (parsed.flags["json"] === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderDeltaMetrics(report));
  return 0;
}

// ── Prepare ──────────────────────────────────────────────────────────────────

async function prepareCommand(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  if ("cycle" in flags) {
    const msg = T("delta.error.cycle_rejected");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "cycle_rejected", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const knownFlags = new Set(["trigger", "topology", "profile", "preset", "resolution", "continuation-run", "json"]);
  const dupFlag = detectDuplicateFlags(args, knownFlags);
  if (dupFlag) {
    const msg = T("delta.error.duplicate_flag", `--${dupFlag}`);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "duplicate_flag", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (positional.length > 1) {
    const msg = T("delta.error.unexpected_positional", positional[1]!);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unexpected_positional", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  for (const k of Object.keys(flags)) {
    if (!knownFlags.has(k)) {
      const msg = T("delta.error.unknown_flag", `--${k}`);
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unknown_flag", detail: msg }) + "\n");
      else process.stderr.write(`${msg}\n`);
      return 1;
    }
  }

  const storyId = positional[0];
  if (!storyId) {
    const msg = T("delta.error.missing_story");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "missing_story", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const required = ["trigger", "topology", "profile", "preset", "resolution"];
  for (const r of required) {
    const v = flags[r];
    if (v === undefined || v === true) {
      const msg = v === true ? T("delta.error.missing_value", `--${r}`) : T("delta.error.missing_required", `--${r}`);
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: v === true ? "missing_value" : "missing_required", detail: msg, flag: r }) + "\n");
      else process.stderr.write(`${msg}\n`);
      return 1;
    }
  }

  // --continuation-run is optional but must name a successor when present.
  const continuationRun = flags["continuation-run"];
  if (continuationRun !== undefined && (continuationRun === true || continuationRun === "")) {
    const msg = T("delta.error.missing_value", "--continuation-run");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "missing_value", detail: msg, flag: "continuation-run" }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // Validate enum values
  const triggerErr = checkEnumFlag(flags, "trigger", DELEGATION_TRIGGERS);
  if (triggerErr) {
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: triggerErr }) + "\n");
    else process.stderr.write(`${triggerErr}\n`);
    return 1;
  }
  const topologyErr = checkEnumFlag(flags, "topology", DELIVERY_TOPOLOGIES);
  if (topologyErr) {
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: topologyErr }) + "\n");
    else process.stderr.write(`${topologyErr}\n`);
    return 1;
  }
  // A host-guided session has no Cycle-owned allocator to attach to.  Full
  // Delta is the runner topology and must reuse that Cycle WorkspaceSet; do
  // not create a nested host frame/lease and discover the incompatibility
  // after durable side effects.
  if (flags["topology"] === "full-delta-team") {
    const msg = T("delta.error.full_delta_requires_cycle_workspace");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const profileErr = checkEnumFlag(flags, "profile", QUALITY_PROFILES);
  if (profileErr) {
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: profileErr }) + "\n");
    else process.stderr.write(`${profileErr}\n`);
    return 1;
  }

  // Read resolution template from host-provided path
  const resolutionPath = flags["resolution"] as string;
  if (!existsSync(resolutionPath)) {
    const msg = `Resolution file not found: ${resolutionPath}`;
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "resolution_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  let resolutionTemplate: unknown;
  let resolutionSha256: string;
  try {
    const resolutionBytes = readFileSync(resolutionPath, "utf8");
    resolutionTemplate = JSON.parse(resolutionBytes);
    resolutionSha256 = createHash("sha256").update(resolutionBytes).digest("hex");
  } catch {
    const msg = `Failed to parse resolution file: ${resolutionPath}`;
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "resolution_parse_error", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Read presetSha256 / inventorySha256 / inventoryObservedAt from the host-supplied
  // resolution template (credible provenance claims). The host is the attestation authority
  // for these fields; they must never be fabricated or re-used from other sources.
  const templateRecord = resolutionTemplate as Record<string, unknown>;

  // US-LOOP-110 (codex review r5): the template's own `trigger` is persisted into
  // the resolution on disk. Unchecked, a `--trigger host-guided` prepare could
  // write a NEW resolution claiming the retired `loop-autonomous`, contradicting
  // its own delta:prepared event. A new record must never carry a retired literal,
  // so refuse rather than silently rewrite the host's template.
  const templateTrigger = templateRecord.trigger;
  if (templateTrigger !== undefined) {
    const liveTrigger =
      typeof templateTrigger === "string" && (DELEGATION_TRIGGERS as readonly string[]).includes(templateTrigger);
    if (!liveTrigger) {
      const msg = `Resolution template declares trigger ${JSON.stringify(templateTrigger)}, which is not a live trigger (${DELEGATION_TRIGGERS.join("|")})`;
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: msg }) + "\n");
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 1;
    }
    const flagTrigger = flags["trigger"];
    if (typeof flagTrigger === "string" && flagTrigger !== templateTrigger) {
      const msg = `Resolution template trigger ${JSON.stringify(templateTrigger)} disagrees with --trigger ${JSON.stringify(flagTrigger)}`;
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: msg }) + "\n");
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 1;
    }
  }

  const templateRolesErr = validateTemplateRoles(templateRecord.roles);
  if (templateRolesErr) {
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: templateRolesErr }) + "\n");
    } else {
      process.stderr.write(`${templateRolesErr}\n`);
    }
    return 1;
  }

  const hostPresetSha256 = templateRecord.presetSha256 as string | undefined;
  const hostInventorySha256 = templateRecord.inventorySha256 as string | undefined;
  const hostInventoryObservedAt = templateRecord.inventoryObservedAt as string | undefined;

  // Resolve hostId from the machine-local preset identified by presetId.
  const presetId = flags["preset"] as string;
  let resolvedHostId = "unknown";
  try {
    const presets = loadLocalPresets();
    const matched = presets.find((p) => p.id === presetId);
    if (matched) {
      resolvedHostId = matched.hostId;
    }
  } catch {
    // preset file unreadable — hostId stays "unknown"
  }

  const input: PrepareInput = {
    storyId,
    trigger: flags["trigger"] as DelegationTrigger,
    topology: flags["topology"] as DeliveryTopology,
    qualityProfile: flags["profile"] as QualityProfile,
    presetId,
    presetSha256: hostPresetSha256 ?? "",
    resolutionSha256,
    resolutionTemplate: resolutionTemplate as PrepareInput["resolutionTemplate"],
    ...(typeof continuationRun === "string" ? { continuationRunId: continuationRun } : {}),
  };

  try {
    const result = await prepareDelegation(process.cwd(), input);

    // FIX-1502 — pickup provenance is durable in the preparation record, so
    // even a resumed prepare (after a crash between the occupancy swap and
    // the event append) publishes a prepared event that traces the source.
    const persistedContinuation = result.continuation ?? (() => {
      try {
        const preparation = JSON.parse(readFileSync(result.preparationPath, "utf8")) as { continuation?: unknown };
        const c = preparation.continuation as Record<string, unknown> | undefined;
        if (typeof c?.fromDelegationId === "string" && typeof c.fromRunId === "string" && typeof c.continuationRunId === "string") {
          return { fromDelegationId: c.fromDelegationId, fromRunId: c.fromRunId, continuationRunId: c.continuationRunId };
        }
      } catch { /* a normal prepare carries no continuation */ }
      return undefined;
    })();

    // ── Test seam: crash point between file write and event append ──────────
    // At this point marker, resolution, preparation, and lease are all on disk.
    // If the process crashes here (before events), the frame is a real orphan.
    if (_prepareInterruptAfterWrite) {
      _prepareInterruptAfterWrite();
    }

    // Append events (with its own try/catch so EventBus I/O failures
    // are caught gracefully while _prepareInterruptAfterWrite throws still propagate)
    try {
      const bus = getEventBus();
      const now = Date.now();
      const alreadyPrepared = (() => {
        try {
          return readFileSync(result.eventsPath, "utf8").split("\n").some((line) => {
            try { const event = JSON.parse(line) as Record<string, unknown>; return event.type === "delta:prepared" && event.delegationId === result.delegationId; } catch { return false; }
          });
        } catch { return false; }
      })();

      // delta:prepared
      if (!alreadyPrepared) {
        bus.appendEvent(result.eventsPath, {
          type: "delta:prepared",
          delegationId: result.delegationId,
          runId: result.runId,
          storyId,
          trigger: input.trigger,
          topology: input.topology,
          qualityProfile: input.qualityProfile,
          presetId: input.presetId,
          presetSha256: input.presetSha256,
          hostId: resolvedHostId,
          ...(result.workspace === undefined ? {} : { workspaceSchema: 2 as const }),
          ...(persistedContinuation === undefined ? {} : { continuation: persistedContinuation }),
          ts: now,
        });
      }
      // The allocator wrote worktree:allocated before returning.  Role
      // admission can therefore never observe delta:prepared without the
      // matching durable allocation fact.
      if (_eventAppendFailure) {
        try { _eventAppendFailure({ type: "delta:prepared" }); } catch {
          if (json) process.stderr.write(JSON.stringify({ ok: false, error: "event_append_failure", detail: "Event append failure after delta:prepared" }) + "\n");
          else process.stderr.write("Prepare failed: event append failure\n");
          return 1;
        }
      }

      // Each role event is independently resumable.  A process can die after
      // `delta:prepared`; retrying must complete the persisted resolution
      // rather than silently treating the delegation as ready.
      const roles = readPersistedResolution(result.resolutionPath).roles;
      const resolvedRoles = new Set<string>();
      const observedAvailabilityRoles = new Set<string>();
      try {
        for (const line of readFileSync(result.eventsPath, "utf8").split("\n")) {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "delta:role_resolved" && event.delegationId === result.delegationId && typeof event.role === "string") resolvedRoles.add(event.role);
          if (event.type === "delta:role_availability_observed" && event.delegationId === result.delegationId && typeof event.role === "string") observedAvailabilityRoles.add(event.role);
        }
      } catch { /* no event stream means every role still needs publication */ }
      if (Array.isArray(roles)) {
        for (const role of roles) {
          const r = role as Record<string, unknown>;
          if (!resolvedRoles.has(r.role as string)) {
            bus.appendEvent(result.eventsPath, {
              type: "delta:role_resolved",
              delegationId: result.delegationId,
              storyId,
              role: r.role as DeltaRole,
              roleInstanceId: r.roleInstanceId as string,
              hostId: r.hostId as string,
              modelId: r.modelId as string,
              source: r.source as "user-pin" | "preset-preference" | "availability-fallback",
              reasons: r.reasons as string[],
              inventorySha256: hostInventorySha256 ?? "",
              inventoryObservedAt: hostInventoryObservedAt ?? "",
              ts: now,
            });
          }
          // A resolved role is an observed host-resolution selection, not proof
          // that its model was invoked. No latency is invented when no probe ran.
          if (!observedAvailabilityRoles.has(r.role as string)) {
            const availability: DeltaRoleAvailabilityObservedEvent = {
              type: "delta:role_availability_observed",
              v: 1,
              delegationId: result.delegationId,
              storyId,
              role: r.role as DeltaRole,
              hostId: r.hostId as string,
              modelId: r.modelId as string,
              transportClass: "host-resolution",
              probeOutcome: "not_measured",
              selection: "selected",
              reason: Array.isArray(r.reasons) && typeof r.reasons[0] === "string" ? r.reasons[0] : "resolved role selection",
              invocationObserved: false,
              ts: now,
            };
            bus.appendEvent(result.eventsPath, availability);
          }
        }
      }
    } catch (eventErr) {
      // EventBus I/O failure — fail-loud but not a crash.
      // Allocation (lease + frame) already persisted; events may be partial.
      const msg = eventErr instanceof Error ? eventErr.message : String(eventErr);
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "event_append_failure", detail: msg }) + "\n");
      } else {
        process.stderr.write(`Prepare failed: ${msg}\n`);
      }
      return 1;
    }

    // The assembly banner is deliberately derived from the immutable resolution
    // artifact, never from the host-supplied in-memory template. It goes to
    // stderr in both modes so the JSON stdout protocol stays byte-for-byte stable.
    const persistedResolution = readPersistedResolution(result.resolutionPath);
    process.stderr.write(`${renderDeltaBanner({
      storyId: persistedResolution.storyId,
      roles: persistedResolution.roles,
      frameDir: result.frameDir,
    }, deltaBannerCopy())}\n`);

    if (json) {
      process.stdout.write(JSON.stringify({
        ok: true,
        delegationId: result.delegationId,
        runId: result.runId,
        ...(persistedContinuation === undefined ? {} : { continuation: persistedContinuation }),
        artifacts: {
          frameDir: result.frameDir,
          resolutionPath: result.resolutionPath,
          markerPath: result.markerPath,
          preparationPath: result.preparationPath,
          ...(result.workspace === undefined ? {} : { workspace: result.workspace }),
        },
      }) + "\n");
    } else {
      process.stdout.write(`${T("delta.prepare.prepared")}: ${result.delegationId}\n`);
      process.stdout.write(`  ${T("delta.field.run_id")}: ${result.runId}\n`);
      process.stdout.write(`  ${T("delta.field.frame")}: ${result.frameDir}\n`);
      if (persistedContinuation !== undefined) {
        process.stdout.write(`  ${T("delta.prepare.continuation_picked_up", persistedContinuation.continuationRunId, persistedContinuation.fromRunId)}\n`);
      }
      if (result.workspace !== undefined) {
        process.stdout.write(`  ${T("delta.field.workspace")}: ${result.workspace.runId}\n`);
        for (const member of result.workspace.members) {
          process.stdout.write(`    ${T("delta.field.member")}: ${member.relativeLocator}\n`);
          process.stdout.write(`    ${T("delta.field.detached_head")}: ${member.checkoutRef.head}\n`);
          if (member.publishRef !== undefined) process.stdout.write(`    ${T("delta.field.publish_ref")}: ${member.publishRef}\n`);
        }
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof PrepareError) {
      // FIX-1502 — pickup refusals are explained in plain language in both
      // locales; any other PrepareError keeps its historical English detail.
      const msg = prepareContinuationErrorMessage(err.code, storyId, typeof continuationRun === "string" ? continuationRun : undefined) ?? err.message;
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: err.code, detail: msg }) + "\n");
      } else {
        process.stderr.write(`roll delta prepare: ${msg}\n`);
      }
      return 1;
    }
    // _prepareInterruptAfterWrite and other unexpected errors — re-throw
    throw err;
  }
}

// ── Validator seam ────────────────────────────────────────────────────────────

/** FIX-1502 — human-readable pickup refusal, keyed by PrepareError code. */
function prepareContinuationErrorMessage(code: string, storyId: string, continuationRun: string | undefined): string | undefined {
  if (continuationRun === undefined) return undefined;
  switch (code) {
    case "continuation_not_available":
      return T("delta.error.continuation_not_available", storyId, continuationRun);
    case "continuation_not_verifiable":
      return T("delta.error.continuation_not_verifiable", storyId, continuationRun);
    case "continuation_adoption_failed":
      return T("delta.error.continuation_adoption_failed", storyId, continuationRun);
    default:
      return undefined;
  }
}

/** Result from the thin protocol-validator boundary. */
export interface ValidatorResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  role?: string;
}

/** Narrow, host-neutral input passed into the protocol validator boundary. */
export interface DeltaValidationInput {
  /** Fixed path to the stage artifact file (e.g. evaluation-manifest.json). */
  readonly artifactPath: string;
  /** Fixed path to the manifest for this validation. */
  readonly manifestPath: string;
  /** The delegation being validated. */
  readonly delegationId: string;
  /** The stage/role being validated. */
  readonly stage: string;
  /** Story ID from the prepared delegation. */
  readonly storyId: string;
  /** Role instance identity from resolution. */
  readonly roleInstanceId: string;
  /** Host identity from resolution (may be "unknown" if preset unavailable). */
  readonly hostId: string;
  /** Model identity from resolution. */
  readonly modelId: string;
  /** Delegation trigger from prepared event. */
  readonly trigger: string;
  /** Delivery topology from prepared event. */
  readonly topology: string;
  /** Quality profile from prepared event. */
  readonly qualityProfile: string;
  /** Frame directory for the delegation (read-only reference, not for path derivation). */
  readonly frameDir: string;
  /** Undefined exclusively for a pre-cutover record with no workspace facts. */
  readonly workspace?: ManagedWorkspaceSet;
  /** True only for an explicitly persisted post-cutover preparation record. */
  readonly managedRecord?: boolean;
}

/** Narrow validator interface — tests inject, production uses the default stub. */
export type DeltaProtocolValidator = (
  input: DeltaValidationInput,
) => ValidatorResult;

let _injectedValidator: DeltaProtocolValidator | null = null;

/** Inject a validator for testing. Call with null to reset to default. */
export function injectValidator(v: DeltaProtocolValidator | null): void {
  _injectedValidator = v;
}

// ── Prepare interruption seam (test-only) ────────────────────────────────────

/** Seam: called after prepareDelegation writes all files but before events are appended. */
let _prepareInterruptAfterWrite: (() => void) | null = null;

/** Inject a prepare interruption hook for crash testing. Call with null to reset. */
export function injectPrepareInterrupt(fn: (() => void) | null): void {
  _prepareInterruptAfterWrite = fn;
}

// ── EventBus injection seam (test-only) ──────────────────────────────────────

/** Seam: if set, all commands use this EventBus instead of creating a new one.
 *  Tests inject an EventBus with a throwing EventStore to simulate real
 *  append I/O failures (BLOCK-A). */
let _injectedEventBus: EventBus | null = null;

/** Inject an EventBus for testing append failures. Call with null to reset. */
export function injectEventBus(bus: EventBus | null): void {
  _injectedEventBus = bus;
}

function getEventBus(): EventBus {
  return _injectedEventBus ?? new EventBus();
}

/**
 * Re-inspect the materialized member rather than trusting a manifest's copied
 * WorkspaceSet literals.  A member is valid only when it lives below the one
 * managed root, is registered by Git, belongs to this repository identity, and
 * is still detached. The Builder manifest keeps the immutable allocation
 * identity; a committed Builder head is admitted only when it is either already
 * checkpointed for this run or is the exact head in this read-only observation.
 * Formal validation checkpoints that observed head only after its unchanged
 * second observation succeeds.
 */
function allocationMemberForBinding(
  workspace: ManagedWorkspaceSet,
  member: NonNullable<DeltaArtifactManifest["workspaceMember"]>,
) {
  return workspace.members.find((candidate) =>
    candidate.workspaceKey === member.workspaceKey
    && candidate.relativeLocator === member.relativeLocator
    && candidate.checkoutRef.kind === member.checkoutRef.kind
    && candidate.checkoutRef.head === member.checkoutRef.head
    && candidate.publishRef === member.publishRef,
  );
}

/** Side-effect-free authentication performed before a Builder checkpoint. */
function preflightVerifyWorkspaceMemberIdentity(
  projectPath: string,
  workspace: ManagedWorkspaceSet,
  member: NonNullable<DeltaArtifactManifest["workspaceMember"]>,
): boolean {
  const root = resolve(projectPath, ".roll", "loop", "worktrees");
  const checkout = resolve(root, member.relativeLocator);
  if (relative(root, checkout) === "" || relative(root, checkout).startsWith("..") || relative(root, checkout).includes(`..${sep}`)) return false;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalCheckout = realpathSync(checkout);
    if (!canonicalCheckout.startsWith(`${canonicalRoot}${sep}`)) return false;
    const git = (args: string[], cwd = projectPath): string => execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const primary = workspace.members[0];
    if (primary === undefined) return false;
    // Each WorkspaceSet member owns a repository identity.  A submodule
    // checkout is registered by that submodule's Git directory, not by its
    // superproject; inspecting from projectPath accepted/rejected the wrong
    // worktree list and collapsed multi-repository identity into one repo.
    const prefix = `${primary.workspaceKey}.submodules/`;
    const submodulePath = member.relativeLocator.startsWith(prefix)
      ? member.relativeLocator.slice(prefix.length)
      : undefined;
    const repositoryCwd = submodulePath === undefined
      ? projectPath
      : join(projectPath, submodulePath);
    const registered = git(["worktree", "list", "--porcelain"], repositoryCwd)
      .split("\n\n")
      .some((entry) => entry.split("\n").some((line) => {
        if (!line.startsWith("worktree ")) return false;
        try { return realpathSync(line.slice("worktree ".length)) === canonicalCheckout; } catch { return false; }
      }));
    if (!registered || !existsSync(checkout)) return false;
    try { if (git(["symbolic-ref", "-q", "HEAD"], checkout) !== "") return false; } catch { /* detached HEAD returns non-zero */ }
    let repositoryId = "";
    try { repositoryId = git(["config", "--get", "remote.origin.url"], repositoryCwd); } catch { /* local identity below */ }
    if (repositoryId === "") repositoryId = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryCwd).replace(/[^A-Za-z0-9._/-]/g, "_");
    const expected = allocationMemberForBinding(workspace, member);
    // A copied WorkspaceSet literal is insufficient: the Builder must attest
    // the canonical cwd it used, and that assertion must resolve to this exact
    // registered member (not main, a sibling run, or a symlink escape).
    const executionCwd = (member as { executionCwd?: string }).executionCwd;
    if (executionCwd === undefined || executionCwd === "") return false;
    let assertedCwd: string;
    try { assertedCwd = realpathSync(executionCwd); } catch { return false; }
    return expected !== undefined
      && expected.repositoryId === repositoryId
      && assertedCwd === canonicalCheckout;
  } catch {
    return false;
  }
}

/**
 * Checks whether an observed Builder head is either its immutable allocation
 * base or a complete same-run Builder validation checkpoint. This is exported
 * for protocol tests that need checkpoint combinations no command can produce.
 */
export function isBuilderValidationHeadAllowed(
  workspace: ManagedWorkspaceSet,
  member: NonNullable<DeltaArtifactManifest["workspaceMember"]>,
  head: string,
  events: readonly Record<string, unknown>[],
): boolean {
  const allocated = allocationMemberForBinding(workspace, member);
  if (allocated === undefined) return false;
  if (head === allocated.checkoutRef.head) return true;
  return events.some((event) => {
    if (
      event.type !== "worktree:release_requested"
      || event.reason !== "builder_validation"
      || event.runId !== workspace.runId
      || !Array.isArray(event.expectedHeads)
      || event.expectedHeads.length !== workspace.members.length
    ) return false;
    const expectedHeads = event.expectedHeads.flatMap((expected) => {
      if (typeof expected !== "object" || expected === null) return [];
      const value = expected as Record<string, unknown>;
      return typeof value.relativeLocator === "string" && typeof value.head === "string"
        ? [{ relativeLocator: value.relativeLocator, head: value.head }]
        : [];
    });
    if (
      expectedHeads.length !== workspace.members.length
      || new Set(expectedHeads.map((expected) => expected.relativeLocator)).size !== workspace.members.length
      || !workspace.members.every((candidate) => expectedHeads.some((expected) => expected.relativeLocator === candidate.relativeLocator))
    ) return false;
    const operationId = `${workspace.runId}:builder-validation:${createHash("sha256").update(JSON.stringify(expectedHeads)).digest("hex").slice(0, 16)}`;
    if (event.operationId !== operationId || typeof event.ts !== "number" || !Number.isSafeInteger(event.ts) || event.ts <= 0) return false;
    return expectedHeads.find((expected) => expected.relativeLocator === member.relativeLocator)?.head === head;
  });
}

function independentlyVerifyWorkspaceMember(
  projectPath: string,
  workspace: ManagedWorkspaceSet,
  member: NonNullable<DeltaArtifactManifest["workspaceMember"]>,
  observedHeads: readonly ObservedBuilderHead[],
): boolean {
  if (!preflightVerifyWorkspaceMemberIdentity(projectPath, workspace, member)) return false;
  try {
    const checkout = resolve(projectPath, ".roll", "loop", "worktrees", member.relativeLocator);
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
    const events = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8").split("\n").flatMap((line) => {
        try { return line === "" ? [] : [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      })
      : [];
    // A prior deterministic checkpoint admits a retried successful submission.
    // Before that checkpoint exists, only the head captured by this same
    // read-only observation is admissible. The caller re-observes it before
    // writing the checkpoint, so an arbitrary later checkout cannot piggyback
    // on a prior green preflight.
    return isBuilderValidationHeadAllowed(workspace, member, head, events)
      || observedHeads.some((observed) => observed.relativeLocator === member.relativeLocator && observed.head === head);
  } catch {
    return false;
  }
}

/**
 * Persist the observed managed set immediately before Builder admission.  This
 * is deliberately a write-ahead lifecycle checkpoint: it freezes the heads a
 * Builder actually produced without changing the workspace to
 * `release_requested` in the execution projection.  Cleanup still requires its
 * separate delivered/attested release request.
 *
 * US-DELTA-015: the heads come from the already-verified read-only snapshot,
 * never from a fresh read, so the checkpoint is exactly the submission formal
 * validation accepted.  A formal failure writes no checkpoint; a formal success
 * writes at most one matching one (idempotent on retry).
 */
function recordBuilderValidationHeads(
  projectPath: string,
  eventsPath: string,
  workspace: ManagedWorkspaceSet,
  now: number,
  heads: readonly ObservedBuilderHead[],
): boolean {
  try {
    if (
      heads.length !== workspace.members.length
      || new Set(heads.map((head) => head.relativeLocator)).size !== workspace.members.length
      || !workspace.members.every((member) => heads.some((head) => head.relativeLocator === member.relativeLocator && head.head !== ""))
    ) return false;
    const opDigest = createHash("sha256").update(JSON.stringify(heads)).digest("hex").slice(0, 16);
    const operationId = `${workspace.runId}:builder-validation:${opDigest}`;
    const prior = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8").split("\n").some((line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          return event.type === "worktree:release_requested"
            && event.runId === workspace.runId
            && event.operationId === operationId
            && event.reason === "builder_validation";
        } catch { return false; }
      })
      : false;
    if (!prior) new EventBus().appendEvent(eventsPath, {
      type: "worktree:release_requested",
      runId: workspace.runId,
      reason: "builder_validation",
      operationId,
      expectedHeads: heads.map((head) => ({ relativeLocator: head.relativeLocator, head: head.head })),
      ts: now,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Event append failure seam (test-only, retained for backward compat) ───────

/** Seam: if set, EventBus.appendEvent calls this after real append; if it throws, the test can simulate a post-append crash. */
let _eventAppendFailure: ((event: Record<string, unknown>) => void) | null = null;

/** Inject an event append failure for testing. Call with null to reset. */
export function injectEventAppendFailure(fn: ((event: Record<string, unknown>) => void) | null): void {
  _eventAppendFailure = fn;
}

function defaultValidator(input: DeltaValidationInput): ValidatorResult {
  // US-003 uses the HOST-SUPPLIED fixed artifact path — never re-derive from frameDir.
  // The host writes the prescribed role evidence/manifest at this fixed path.
  if (!existsSync(input.artifactPath)) {
    return {
      ok: false,
      reason: "artifact_invalid",
      detail: `Stage artifact not found for role '${input.stage}' at ${input.artifactPath}`,
      role: input.stage,
    };
  }
  // US-DELTA-004: deep artifact-protocol enforcement (digest / path / role-access
  // / host-attestation / identity-collision / evidence-format).
  let manifest: DeltaArtifactManifest;
  try {
    const parsed = JSON.parse(readFileSync(input.manifestPath, "utf8")) as { schemaVersion?: unknown };
    if (parsed?.schemaVersion !== 2) {
      // v1 / placeholder manifests remain PARSEABLE but cannot satisfy a NEW run.
      return {
        ok: false,
        reason: "artifact_invalid",
        detail: `manifest at ${input.manifestPath} is not schemaVersion 2 (a new Delta run requires a v2 manifest)`,
        role: input.stage,
      };
    }
    manifest = parsed as unknown as DeltaArtifactManifest;
  } catch (e) {
    return { ok: false, reason: "artifact_invalid", detail: `manifest unreadable/invalid JSON at ${input.manifestPath}: ${String(e)}`, role: input.stage };
  }
  // The manifest's declared role MUST match the stage being validated — else an
  // evaluator-stage file declaring `designer` would bypass the evaluator-only
  // identity + report-format checks yet still publish an evaluator event.
  if (manifest.role !== input.stage) {
    return { ok: false, reason: "artifact_invalid", detail: `manifest role '${manifest.role}' ≠ validated stage '${input.stage}'`, role: input.stage };
  }
  if (input.managedRecord === true && input.workspace === undefined) {
    return { ok: false, reason: "artifact_invalid", detail: "managed Delta has no durable allocated WorkspaceSet", role: input.stage };
  }
  if (input.workspace !== undefined) {
    if (input.stage === "builder" && (
      manifest.delegationId !== input.delegationId
      || manifest.storyId !== input.storyId
      || manifest.trigger !== input.trigger
      || manifest.topology !== input.topology
      || manifest.qualityProfile !== input.qualityProfile
    )) {
      return {
        ok: false,
        reason: "artifact_invalid",
        detail: "manifest delegation context does not match the immutable prepared delegation",
        role: input.stage,
      };
    }
    if (input.stage === "builder") {
      const binding = manifest.workspaceMember;
      const member = binding === undefined ? undefined : allocationMemberForBinding(input.workspace, binding);
      const independentlyVerified = binding !== undefined
        && independentlyVerifyWorkspaceMember(process.cwd(), input.workspace, binding, []);
      if (manifest.runId !== input.workspace.runId || member === undefined || !independentlyVerified) {
        return {
          ok: false,
          reason: "artifact_invalid",
          detail: "manifest is not bound to a registered canonical DeliveryRun managed workspace member",
          role: input.stage,
        };
      }
    }
  }
  const frameDir = input.frameDir;
  const contains = (p: string): boolean => {
    const abs = resolve(frameDir, p);
    return abs === frameDir || abs.startsWith(frameDir + sep);
  };
  const readBytes = (p: string): string | null => {
    try {
      return readFileSync(resolve(frameDir, p), "utf8");
    } catch {
      return null;
    }
  };
  // Builder and Evaluator MUST publish their evidence document (fail-closed): a
  // missing evidence/report output — or an unreadable one — is a violation, not
  // a skipped format check.
  let evidenceContent: string | undefined;
  if (input.stage === "builder" || input.stage === "evaluator") {
    const wantKind = input.stage === "builder" ? "evidence" : "report";
    const ref = manifest.outputs.find((o) => o.kind === wantKind);
    if (ref === undefined) {
      return { ok: false, reason: "artifact_invalid", detail: `${input.stage} manifest declares no '${wantKind}' output`, role: input.stage };
    }
    const content = readBytes(ref.path);
    if (content === null) {
      return { ok: false, reason: "artifact_invalid", detail: `${input.stage} ${wantKind} artifact missing on disk: ${ref.path}`, role: input.stage };
    }
    evidenceContent = content;
  }
  // The Evaluator MUST validate identity distinctness against a published Builder
  // manifest (fail-closed): no valid Builder manifest → the evaluator stage
  // cannot be admitted (it runs AFTER the Builder).
  let builderManifest: DeltaArtifactManifest | undefined;
  if (input.stage === "evaluator") {
    const bp = join(frameDir, "role-artifacts", "builder", "evaluation-manifest.json");
    try {
      const bm = existsSync(bp) ? (JSON.parse(readFileSync(bp, "utf8")) as { schemaVersion?: unknown; role?: unknown }) : undefined;
      // Must be a v2 manifest that ACTUALLY declares role "builder" — a wrong-role
      // v2 file at the builder path must not satisfy the identity-distinctness
      // requirement.
      if (bm?.schemaVersion === 2 && bm.role === "builder") builderManifest = bm as unknown as DeltaArtifactManifest;
    } catch {
      /* fall through to the fail-closed block below */
    }
    if (builderManifest === undefined) {
      return { ok: false, reason: "artifact_invalid", detail: `evaluator requires a published v2 Builder manifest (role: "builder") for identity distinctness (none valid at ${bp})`, role: input.stage };
    }
  }
  const r = validateDeltaManifest(manifest, {
    contains,
    readBytes,
    ...(builderManifest !== undefined ? { builderManifest } : {}),
    ...(evidenceContent !== undefined ? { evidenceContent } : {}),
  });
  if (!r.ok) {
    return { ok: false, reason: r.reason ?? "artifact_invalid", detail: r.detail ?? "artifact protocol violation", role: input.stage };
  }
  return { ok: true };
}

// ── Preflight (Builder self-check, US-DELTA-015) ─────────────────────────────

const BUILDER_PREFLIGHT_RECEIPT_SCHEMA = "roll-delta-builder-preflight-receipt/v1";

/**
 * The receipt deliberately contains only an observation. It is neither a
 * signature nor a delivery claim: validate always compares it with a fresh
 * observation before it can append any event.
 */
type BuilderPreflightReceipt = {
  readonly schema: typeof BUILDER_PREFLIGHT_RECEIPT_SCHEMA;
  readonly ok: true;
  readonly class: "artifact_protocol";
  readonly delegationId: string;
  readonly storyId: string;
  readonly trigger: string;
  readonly topology: string;
  readonly qualityProfile: string;
  readonly runId: string;
  readonly stage: "builder";
  readonly snapshot: {
    readonly workspaceRunId: string;
    readonly members: readonly ObservedBuilderHead[];
    readonly manifestSha256: string;
    readonly outputSha256: readonly { readonly path: string; readonly sha256: string }[];
  };
};

function makeBuilderPreflightReceipt(
  context: BuilderSubmissionContext,
  snapshot: BuilderSubmissionSnapshot,
): BuilderPreflightReceipt {
  return {
    schema: BUILDER_PREFLIGHT_RECEIPT_SCHEMA,
    ok: true,
    class: "artifact_protocol",
    delegationId: context.delegationId,
    storyId: context.storyId,
    trigger: context.trigger,
    topology: context.topology,
    qualityProfile: context.qualityProfile,
    runId: context.runId,
    stage: "builder",
    snapshot: {
      workspaceRunId: snapshot.heads.workspaceRunId,
      members: snapshot.heads.members,
      manifestSha256: snapshot.manifestSha256,
      outputSha256: snapshot.outputSha256,
    },
  };
}

function receiptMatchesContext(receipt: BuilderPreflightReceipt, context: BuilderSubmissionContext): boolean {
  return receipt.delegationId === context.delegationId
    && receipt.storyId === context.storyId
    && receipt.trigger === context.trigger
    && receipt.topology === context.topology
    && receipt.qualityProfile === context.qualityProfile
    && receipt.runId === context.runId;
}

function receiptMatchesSnapshot(receipt: BuilderPreflightReceipt, snapshot: BuilderSubmissionSnapshot): boolean {
  const observed = {
    heads: {
      workspaceRunId: receipt.snapshot.workspaceRunId,
      members: receipt.snapshot.members,
      observedAt: 0,
    },
    manifestSha256: receipt.snapshot.manifestSha256,
    outputSha256: receipt.snapshot.outputSha256,
  };
  return builderSubmissionSnapshotsMatch(observed, snapshot);
}

function isReceiptSnapshot(value: unknown): value is BuilderPreflightReceipt["snapshot"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.workspaceRunId !== "string" || typeof snapshot.manifestSha256 !== "string"
    || !Array.isArray(snapshot.members) || !Array.isArray(snapshot.outputSha256)) return false;
  return snapshot.members.every((member) => typeof member === "object" && member !== null
    && !Array.isArray(member)
    && typeof (member as Record<string, unknown>).relativeLocator === "string"
    && typeof (member as Record<string, unknown>).head === "string")
    && snapshot.outputSha256.every((output) => typeof output === "object" && output !== null
      && !Array.isArray(output)
      && typeof (output as Record<string, unknown>).path === "string"
      && typeof (output as Record<string, unknown>).sha256 === "string");
}

function parseBuilderPreflightReceipt(path: string): { readonly ok: true; readonly receipt: BuilderPreflightReceipt } | { readonly ok: false; readonly detail: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return { ok: false, detail: `preflight receipt cannot be read: ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "preflight receipt is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: "preflight receipt is not a complete canonical receipt" };
  }
  const receipt = parsed as Record<string, unknown>;
  const receiptKeys = ["schema", "ok", "class", "delegationId", "storyId", "trigger", "topology", "qualityProfile", "runId", "stage", "snapshot"];
  const valid = receipt.schema === BUILDER_PREFLIGHT_RECEIPT_SCHEMA
    && receipt.ok === true
    && receipt.class === "artifact_protocol"
    && receipt.stage === "builder"
    && Object.keys(receipt).length === receiptKeys.length
    && receiptKeys.every((key) => key in receipt)
    && ["delegationId", "storyId", "trigger", "topology", "qualityProfile", "runId"].every((key) => typeof receipt[key] === "string")
    && isReceiptSnapshot(receipt.snapshot);
  if (!valid || raw !== JSON.stringify(parsed)) {
    return { ok: false, detail: "preflight receipt is not a complete canonical receipt" };
  }
  return { ok: true, receipt: parsed as BuilderPreflightReceipt };
}

function writeReceiptFailure(json: boolean, detail: string): number {
  if (json) process.stderr.write(JSON.stringify({ ok: false, error: "preflight_receipt_invalid", detail, role: "builder" }) + "\n");
  else process.stderr.write(`${detail}\n`);
  return 1;
}

function readManagedBuilderHeads(
  root: string,
  members: readonly { readonly relativeLocator: string }[],
): readonly ObservedBuilderHead[] | null {
  try {
    const canonicalRoot = realpathSync(root);
    const heads: ObservedBuilderHead[] = [];
    for (const member of members) {
      const checkout = resolve(root, member.relativeLocator);
      const canonicalCheckout = realpathSync(checkout);
      if (!canonicalCheckout.startsWith(`${canonicalRoot}${sep}`)) return null;
      try {
        if (execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: canonicalCheckout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "") return null;
      } catch (error) {
        // `symbolic-ref -q HEAD` exits 1 for a detached HEAD, which is required;
        // another Git/I/O failure is unobservable and must fail closed.
        if (typeof error !== "object" || error === null || (error as { status?: unknown }).status !== 1) return null;
      }
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: canonicalCheckout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (head === "") return null;
      heads.push({ relativeLocator: member.relativeLocator, head });
    }
    return heads;
  } catch {
    return null;
  }
}

/**
 * `roll delta preflight --delegation <id> --stage builder [--json]` — a
 * read-only Builder self-check. It consumes the SAME immutable prepared/
 * resolution context and the current Builder artifact as formal validation, but
 * appends no event and changes no lease, frame, workspace, or checkpoint. A
 * failed preflight is a loud local diagnostic the Builder can repair in the
 * same delegation/frame. Structural failures render `class: artifact_protocol`
 * — never `delta:blocked`, never an Evaluator verdict or delivery claim.
 */
function preflightCommand(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  const knownFlags = new Set(["delegation", "stage", "json"]);
  const dupFlag = detectDuplicateFlags(args, knownFlags);
  if (dupFlag) {
    const msg = T("delta.error.duplicate_flag", `--${dupFlag}`);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "duplicate_flag", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (positional.length > 0) {
    const msg = T("delta.error.unexpected_positional", positional[0]!);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unexpected_positional", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  for (const k of Object.keys(flags)) {
    if (!knownFlags.has(k)) {
      const msg = T("delta.error.unknown_flag", `--${k}`);
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unknown_flag", detail: msg }) + "\n");
      else process.stderr.write(`${msg}\n`);
      return 1;
    }
  }

  const delegationId = flags["delegation"];
  if (!delegationId || delegationId === true) {
    const msg = T("delta.error.missing_required", "--delegation");
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "missing_required", detail: msg, flag: "delegation" }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  const stageErr = checkEnumFlag(flags, "stage", DELTA_ROLES);
  if (stageErr) {
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: stageErr }) + "\n");
    else process.stderr.write(`${stageErr}\n`);
    return 1;
  }

  const stage = flags["stage"] as DeltaRole | undefined;
  if (!stage) {
    const msg = T("delta.error.missing_required", "--stage");
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "missing_required", detail: msg, flag: "stage" }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Preflight is deliberately Builder-only: a read-only self-check of the
  // managed Builder submission.  Other stages are an explicit
  // unsupported-stage diagnostic — never a silent no-op, a routing decision,
  // or an automatic fallback — with zero state mutation.
  if (stage !== "builder") {
    const msg = T("delta.preflight.unsupported_stage", stage);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unsupported_stage", detail: msg, stage }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // Load delegation events
  const cwd = process.cwd();
  const bus = getEventBus();
  const eventsPath = join(cwd, ".roll", "loop", "events.ndjson");
  const events = existsSync(eventsPath) ? bus.readEvents(eventsPath) : [];

  const delegationEvents = events.filter(
    (e) => "delegationId" in e && (e as Record<string, unknown>).delegationId === delegationId,
  );
  if (delegationEvents.length === 0) {
    const msg = `Delegation not found: ${delegationId}`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const preparedEvent = delegationEvents.find((e) => e.type === "delta:prepared") as Record<string, unknown> | undefined;
  if (!preparedEvent) {
    const msg = `Delegation ${delegationId}: no prepared event found`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (preparedWorkspaceSchema(preparedEvent) === "unknown") {
    const msg = `Delegation ${delegationId}: unsupported workspace schema ${JSON.stringify(preparedEvent.workspaceSchema)}`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unsupported_workspace_schema", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  // Preflight requires the managed Builder workspace facts.  A legacy record
  // (no WorkspaceSet) is an explicit unsupported diagnostic, never a
  // zero-member or successful workspace.
  if (preparedWorkspaceSchema(preparedEvent) === "legacy") {
    const msg = T("delta.preflight.managed_required");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "managed_workspace_required", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const storyId = preparedEvent.storyId as string;
  const cardDir = resolveExistingUniqueCardArchiveDir(cwd, storyId);
  if (!cardDir) {
    const msg = `Story ${storyId}: card directory not found`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const frameDir = join(cardDir, `delta-${delegationId}`);
  if (!existsSync(frameDir)) {
    const msg = `Frame directory not found: ${frameDir}`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // Load the same immutable managed context formal validation uses, including
  // the durable `worktree:allocated` identity cross-check.
  const stageArtifactPath = join(frameDir, "role-artifacts", "builder", "evaluation-manifest.json");
  let workspace: ManagedWorkspaceSet | undefined;
  try {
    const preparation = JSON.parse(readFileSync(join(frameDir, "preparation.json"), "utf8")) as { schema?: unknown; workspace?: ManagedWorkspaceSet; runId?: unknown };
    if (preparation.schema === "roll-delta-preparation/v2") workspace = preparation.workspace;
    if (workspace !== undefined) {
      const operationId = managedWorkspaceOperationId(preparation.runId as string, "prepare");
      const allocated = events.some((event) => event.type === "worktree:allocated"
        && (event as Record<string, unknown>).operationId === operationId
        && JSON.stringify((event as Record<string, unknown>).workspace) === JSON.stringify(workspace));
      if (!allocated) workspace = undefined;
    }
  } catch { /* a v2 prepared event remains managed and fails closed below */ }
  if (workspace === undefined) {
    const msg = T("delta.preflight.managed_required");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "managed_workspace_required", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }
  const boundWorkspace = workspace;

  const context: BuilderSubmissionContext = {
    delegationId,
    storyId,
    trigger: preparedEvent.trigger as string,
    topology: preparedEvent.topology as string,
    qualityProfile: preparedEvent.qualityProfile as string,
    runId: boundWorkspace.runId,
    workspace: boundWorkspace,
    frameDir,
    manifestPath: stageArtifactPath,
  };
  const root = resolve(cwd, ".roll", "loop", "worktrees");
  const observer: BuilderSubmissionObserver = {
    contains: (p: string): boolean => {
      const abs = resolve(frameDir, p);
      return abs === frameDir || abs.startsWith(frameDir + sep);
    },
    readBytes: (p: string): string | null => {
      try { return readFileSync(resolve(frameDir, p), "utf8"); } catch { return null; }
    },
    readMemberHeads: (members: readonly { readonly relativeLocator: string }[]): readonly ObservedBuilderHead[] | null =>
      readManagedBuilderHeads(root, members),
    verifyMemberBinding: (binding: NonNullable<DeltaArtifactManifest["workspaceMember"]>, observedHeads: readonly ObservedBuilderHead[]): boolean =>
      independentlyVerifyWorkspaceMember(cwd, boundWorkspace, binding, observedHeads),
  };

  const observed = observeBuilderSubmission(context, observer);
  const verdict = observed.ok
    ? validateBuilderSubmission(context, observed.manifest, observed.snapshot, observed.evidenceContent)
    : { ok: false, reason: observed.reason, detail: observed.detail };

  if (!observed.ok || !verdict.ok) {
    const reason = observed.ok ? (verdict.reason ?? "artifact_invalid") : observed.reason;
    const detail = observed.ok ? (verdict.detail ?? "artifact protocol violation") : observed.detail;
    // Loud but repairable: advisory execution feedback, never lifecycle truth.
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, class: "artifact_protocol", reason, detail }) + "\n");
    } else {
      process.stderr.write(`${T("delta.preflight.failed", detail)}\n`);
    }
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(makeBuilderPreflightReceipt(context, observed.snapshot)) + "\n");
  } else {
    process.stdout.write(`${T("delta.preflight.passed", `${T("delta.phase.delegation")} ${delegationId} ${T("delta.phase.stage")} builder`)}\n`);
  }
  return 0;
}

// ── Validate ─────────────────────────────────────────────────────────────────

function validateCommand(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  const knownFlags = new Set(["delegation", "stage", "json", "preflight-receipt"]);
  const dupFlag = detectDuplicateFlags(args, knownFlags);
  if (dupFlag) {
    const msg = T("delta.error.duplicate_flag", `--${dupFlag}`);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "duplicate_flag", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (positional.length > 0) {
    const msg = T("delta.error.unexpected_positional", positional[0]!);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unexpected_positional", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  for (const k of Object.keys(flags)) {
    if (!knownFlags.has(k)) {
      const msg = T("delta.error.unknown_flag", `--${k}`);
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unknown_flag", detail: msg }) + "\n");
      else process.stderr.write(`${msg}\n`);
      return 1;
    }
  }

  const delegationId = flags["delegation"];
  if (!delegationId || delegationId === true) {
    const msg = T("delta.error.missing_required", "--delegation");
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "missing_required", detail: msg, flag: "delegation" }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  const stageErr = checkEnumFlag(flags, "stage", DELTA_ROLES);
  if (stageErr) {
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: stageErr }) + "\n");
    else process.stderr.write(`${stageErr}\n`);
    return 1;
  }

  const stage = flags["stage"] as DeltaRole | undefined;
  if (!stage) {
    const msg = T("delta.error.missing_required", "--stage");
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "missing_required", detail: msg, flag: "stage" }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Load delegation events
  const cwd = process.cwd();
  const bus = getEventBus();
  const eventsPath = join(cwd, ".roll", "loop", "events.ndjson");
  const events = existsSync(eventsPath) ? bus.readEvents(eventsPath) : [];

  // Verify delegation exists
  const delegationEvents = events.filter(
    (e) => "delegationId" in e && (e as Record<string, unknown>).delegationId === delegationId,
  );
  if (delegationEvents.length === 0) {
    const msg = `Delegation not found: ${delegationId}`;
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "delegation_not_found")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Locate the frame directory and stage artifact
  // For US-003, we check that the delegation's frame directory exists
  // and that the stage artifact/manifest is at its prescribed path.
  // Deep validation (digest, token, attestation) is US-004.
  const preparedEvent = delegationEvents.find((e) => e.type === "delta:prepared") as Record<string, unknown> | undefined;
  if (!preparedEvent) {
    const msg = `Delegation ${delegationId}: no prepared event found`;
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "delegation_not_found")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  if (preparedWorkspaceSchema(preparedEvent) === "unknown") {
    const msg = `Delegation ${delegationId}: unsupported workspace schema ${JSON.stringify(preparedEvent.workspaceSchema)}`;
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "artifact_invalid")}\n`);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unsupported_workspace_schema", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const storyId = preparedEvent.storyId as string;
  const cardDir = resolveExistingUniqueCardArchiveDir(cwd, storyId);
  if (!cardDir) {
    const msg = `Story ${storyId}: card directory not found`;
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "delegation_not_found")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  const frameDir = join(cardDir, `delta-${delegationId}`);
  if (!existsSync(frameDir)) {
    const msg = `Frame directory not found: ${frameDir}`;
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "delegation_not_found")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Do this before any admission branch can append a lifecycle fact. A Builder
  // can repair a missing or malformed receipt in the same delegation.
  let builderReceipt: BuilderPreflightReceipt | undefined;
  if (stage === "builder" && preparedWorkspaceSchema(preparedEvent) === "managed-v2" && _injectedValidator === null) {
    const receiptPath = flags["preflight-receipt"];
    if (receiptPath === undefined || receiptPath === true) {
      return writeReceiptFailure(json, "managed Builder validation requires --preflight-receipt <path>");
    }
    const parsedReceipt = parseBuilderPreflightReceipt(receiptPath);
    if (!parsedReceipt.ok) return writeReceiptFailure(json, parsedReceipt.detail);
    builderReceipt = parsedReceipt.receipt;
  }

  // ── Stage admission ──────────────────────────────────────────────────────
  // Admission checks run before the validator and short-circuit on failure.
  // Admission failures produce a typed `delta:blocked` event and never call
  // the validator.
  const now = Date.now();

  // Admission check 1: delegation must not be terminal
  const terminalEvent = delegationEvents.find((e) => e.type === "delta:terminal");
  if (terminalEvent) {
    appendDeltaBlocked(bus, eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "terminal_path_unselected",
      detail: `Delegation ${delegationId} is terminal (outcome: ${(terminalEvent as Record<string, unknown>).outcome}); cannot validate further stages`,
      ts: now,
    });
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "terminal_path_unselected")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "terminal_path_unselected", detail: `Delegation is terminal`, role: stage }) + "\n");
    } else {
      process.stderr.write(`Delegation ${delegationId} is terminal` + "\n");
    }
    return 1;
  }

  // Admission check 2: delegation must not be blocked.
  // US-LOOP-110: this used to re-emit `host_supervisor_required`, which was never
  // what happened here — the delegation was blocked for its OWN reason and this
  // check only refuses to advance past it. The original reason is now PROPAGATED
  // (never replaced by an unrelated one, never invented when unparseable).
  const blockedEvent = delegationEvents.find((e) => e.type === "delta:blocked");
  if (blockedEvent) {
    const blocked = blockedEvent as Record<string, unknown>;
    const rawReason = blocked.reason;
    // A NEW event may only carry a LIVE reason — the ledger is append-only, so
    // writing a retired or arbitrary literal would make this fresh record
    // schema-invalid (codex review r1 + r2). Two distinct things therefore:
    //   - `propagated` is what the new event carries: the prior reason when it is
    //     still live, otherwise the honest live fallback;
    //   - `originalNote` is what the DETAIL says the prior reason actually was,
    //     verbatim, including a retired or malformed value.
    // Nothing is invented and nothing is hidden.
    const isLiveReason =
      typeof rawReason === "string" && (DELTA_BLOCK_REASONS as readonly string[]).includes(rawReason);
    const propagated: DeltaBlockReason = isLiveReason ? (rawReason as DeltaBlockReason) : "artifact_invalid";
    const originalNote = isLiveReason
      ? rawReason
      : isKnownHistoricalBlockReason(rawReason)
        ? `retired prior reason ${String(rawReason)}`
        : `unrecognised prior reason ${JSON.stringify(rawReason)}`;
    const detail = `Delegation ${delegationId} is blocked (${originalNote}); cannot validate further stages`;
    appendDeltaBlocked(bus, eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: propagated,
      detail,
      ts: now,
    });
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", propagated)}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: propagated, detail: `Delegation is blocked`, role: stage }) + "\n");
    } else {
      process.stderr.write(`Delegation ${delegationId} is blocked (${originalNote})` + "\n");
    }
    return 1;
  }

  // Admission check 3: stage must be a role resolved in this delegation
  const resolvedRoles = delegationEvents
    .filter((e) => e.type === "delta:role_resolved")
    .map((e) => (e as Record<string, unknown>).role as string);
  if (stage && !resolvedRoles.includes(stage)) {
    appendDeltaBlocked(bus, eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "invalid_resolution",
      detail: `Stage '${stage}' is not a resolved role in delegation ${delegationId}. Resolved roles: ${resolvedRoles.join(", ")}`,
      ts: now,
    });
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "invalid_resolution")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "invalid_resolution", detail: `Stage '${stage}' not in resolved roles`, role: stage }) + "\n");
    } else {
      process.stderr.write(`Stage '${stage}' is not a resolved role in delegation ${delegationId}` + "\n");
    }
    return 1;
  }

  // Admission check 4: stage must not already be published
  const alreadyPublished = delegationEvents.find(
    (e) => e.type === "delta:artifact_published" && (e as Record<string, unknown>).role === stage,
  );
  if (alreadyPublished) {
    appendDeltaBlocked(bus, eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "identity_collision",
      detail: `Stage '${stage}' has already been published for delegation ${delegationId}`,
      ts: now,
    });
    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "identity_collision")}\n`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "identity_collision", detail: `Stage '${stage}' already published`, role: stage }) + "\n");
    } else {
      process.stderr.write(`Stage '${stage}' has already been published` + "\n");
    }
    return 1;
  }

  // ── Build validation input from immutable delegation context ─────────────
  // Gather the resolved role metadata from the event stream (role_resolved event)
  // and the prepared event so the validator receives the complete, fixed context.
  const roleResolvedEvent = delegationEvents.find(
    (e) => e.type === "delta:role_resolved" && (e as Record<string, unknown>).role === stage,
  ) as Record<string, unknown> | undefined;

  const stageArtifactDir = join(frameDir, "role-artifacts", stage);
  const stageArtifactPath = join(stageArtifactDir, "evaluation-manifest.json");
  const evaluationManifestPath = stageArtifactPath;

  let workspace: ManagedWorkspaceSet | undefined;
  // Only the immutable prepared event chooses the compatibility path.  A
  // missing/corrupt new preparation can never impersonate legacy history.
  const managedRecord = preparedWorkspaceSchema(preparedEvent) === "managed-v2";
  try {
    const preparation = JSON.parse(readFileSync(join(frameDir, "preparation.json"), "utf8")) as { schema?: unknown; workspace?: ManagedWorkspaceSet; runId?: unknown };
    if (managedRecord && preparation.schema === "roll-delta-preparation/v2") workspace = preparation.workspace;
    if (managedRecord && workspace !== undefined) {
      const operationId = managedWorkspaceOperationId(preparation.runId as string, "prepare");
      const allocated = events.some((event) => event.type === "worktree:allocated"
        && (event as Record<string, unknown>).operationId === operationId
        && JSON.stringify((event as Record<string, unknown>).workspace) === JSON.stringify(workspace));
      if (!allocated) workspace = undefined;
    }
  } catch { /* a v2 prepared event remains managed and fails closed below */ }
  const validationInput: DeltaValidationInput = {
    artifactPath: stageArtifactPath,
    manifestPath: evaluationManifestPath,
    delegationId,
    stage,
    storyId: preparedEvent.storyId as string,
    roleInstanceId: (roleResolvedEvent?.roleInstanceId as string) ?? "",
    hostId: (roleResolvedEvent?.hostId as string) ?? (preparedEvent.hostId as string) ?? "unknown",
    modelId: (roleResolvedEvent?.modelId as string) ?? "?",
    trigger: preparedEvent.trigger as string,
    topology: preparedEvent.topology as string,
    qualityProfile: preparedEvent.qualityProfile as string,
    frameDir,
    ...(managedRecord ? { managedRecord: true } : {}),
    ...(workspace === undefined ? {} : { workspace }),
  };

  // US-DELTA-015: managed Builder admission is a read-only two-pass observation.
  // Pass 1 observes + validates the submission entirely in memory — no event,
  // lease, frame, workspace, or checkpoint write. Pass 2 re-observes from fresh
  // state; only an unchanged success writes the single matching checkpoint.
  let builderContext: BuilderSubmissionContext | undefined;
  let builderObserver: BuilderSubmissionObserver | undefined;
  let builderObservation: BuilderObservationResult | undefined;
  if (stage === "builder" && workspace !== undefined && _injectedValidator === null) {
    const boundWorkspace = workspace;
    builderContext = {
      delegationId,
      storyId: preparedEvent.storyId as string,
      trigger: preparedEvent.trigger as string,
      topology: preparedEvent.topology as string,
      qualityProfile: preparedEvent.qualityProfile as string,
      runId: boundWorkspace.runId,
      workspace: boundWorkspace,
      frameDir,
      manifestPath: stageArtifactPath,
    };
    const root = resolve(cwd, ".roll", "loop", "worktrees");
    builderObserver = {
      contains: (p: string): boolean => {
        const abs = resolve(frameDir, p);
        return abs === frameDir || abs.startsWith(frameDir + sep);
      },
      readBytes: (p: string): string | null => {
        try { return readFileSync(resolve(frameDir, p), "utf8"); } catch { return null; }
      },
      readMemberHeads: (members: readonly { readonly relativeLocator: string }[]): readonly ObservedBuilderHead[] | null =>
        readManagedBuilderHeads(root, members),
      verifyMemberBinding: (binding: NonNullable<DeltaArtifactManifest["workspaceMember"]>, observedHeads: readonly ObservedBuilderHead[]): boolean =>
        independentlyVerifyWorkspaceMember(cwd, boundWorkspace, binding, observedHeads),
    };
    builderObservation = observeBuilderSubmission(builderContext, builderObserver);
    if (!receiptMatchesContext(builderReceipt!, builderContext)) {
      return writeReceiptFailure(json, "preflight receipt does not match this immutable Builder delegation");
    }
    if (!builderObservation.ok || !receiptMatchesSnapshot(builderReceipt!, builderObservation.snapshot)) {
      const detail = builderObservation.ok
        ? "preflight receipt does not match the current Builder submission"
        : `preflight receipt does not match the current Builder submission: ${builderObservation.detail}`;
      return writeReceiptFailure(json, detail);
    }
  }

  const validator = _injectedValidator ?? defaultValidator;
  const result = (() => {
    if (builderObservation !== undefined) {
      // The shared read-only observation IS the validator input for the managed
      // production Builder path (the injected seam is intentionally bypassed).
      return builderObservation.ok
        ? validateBuilderSubmission(builderContext!, builderObservation.manifest, builderObservation.snapshot, builderObservation.evidenceContent)
        : { ok: false, reason: builderObservation.reason, detail: builderObservation.detail, role: "builder" };
    }
    return validator(validationInput);
  })();

  if (!result.ok) {
    // Block: append delta:blocked event, return non-zero.
    // codex review r4: the validator seam is typed `reason?: string`, so it can
    // hand back an absent, retired, or foreign literal. A new ledger record may
    // carry a LIVE reason only — otherwise this fresh event is permanently
    // schema-invalid. Same split as the already-blocked path: the event gets a
    // live reason, the detail keeps the validator's own words verbatim.
    const validatorReason = result.reason;
    const liveReason: import("@roll/spec").DeltaBlockReason =
      typeof validatorReason === "string" && (DELTA_BLOCK_REASONS as readonly string[]).includes(validatorReason)
        ? (validatorReason as import("@roll/spec").DeltaBlockReason)
        : "artifact_invalid";
    const blockDetail =
      liveReason === validatorReason || validatorReason === undefined
        ? (result.detail ?? "")
        : `${result.detail ?? ""}${result.detail !== undefined && result.detail !== "" ? " " : ""}(validator reported ${JSON.stringify(validatorReason)})`;
    appendDeltaBlocked(bus, eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: liveReason,
      detail: blockDetail,
      ts: now,
    });

    process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", liveReason)}\n`);

    if (json) {
      process.stderr.write(JSON.stringify({
        ok: false,
        error: result.reason ?? "blocked",
        detail: result.detail,
        role: stage,
      }) + "\n");
    } else {
      process.stderr.write(`${result.detail ?? result.reason}\n`);
    }
    return 1;
  }

  // Pass 2 — time-of-check/time-of-use guard: re-observe the heads, manifest,
  // and output digests from fresh state.  Any change is a formal validation
  // failure, never a pass carried from pass 1 or from a green preflight.
  if (builderObservation !== undefined && builderContext !== undefined && builderObserver !== undefined && builderObservation.ok) {
    const reobserved = observeBuilderSubmission(builderContext, builderObserver);
    const changedDetail = reobserved.ok
      ? "builder submission changed between observation and formal validation"
      : reobserved.detail;
    if (!reobserved.ok || !builderSubmissionSnapshotsMatch(builderObservation.snapshot, reobserved.snapshot)) {
      appendDeltaBlocked(bus, eventsPath, {
        type: "delta:blocked",
        delegationId,
        storyId,
        role: stage,
        reason: "artifact_invalid",
        detail: changedDetail,
        ts: now,
      });
      process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "artifact_invalid")}\n`);
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "artifact_invalid", detail: changedDetail, role: stage }) + "\n");
      } else {
        process.stderr.write(`${changedDetail}\n`);
      }
      return 1;
    }
    // Formal success writes exactly one matching checkpoint from the validated
    // snapshot, then lifecycle facts below.  A formal failure never gets here.
    if (!recordBuilderValidationHeads(cwd, eventsPath, builderContext.workspace, now, builderObservation.snapshot.heads.members)) {
      const msg = "managed workspace release checkpoint could not be recorded";
      appendDeltaBlocked(bus, eventsPath, {
        type: "delta:blocked",
        delegationId,
        storyId,
        role: stage,
        reason: "artifact_invalid",
        detail: msg,
        ts: now,
      });
      process.stderr.write(`${validationPhaseBanner(delegationId, stage, "blocked", "artifact_invalid")}\n`);
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "artifact_invalid", detail: msg, role: stage }) + "\n");
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 1;
    }
  }

  // Allow: append lifecycle event (delta:artifact_published for US-003 thin validator)
  // Find the matching role_resolved event for hostId/modelId/roleInstanceId
  const roleResolved = delegationEvents.find(
    (e) => e.type === "delta:role_resolved" && (e as Record<string, unknown>).role === stage,
  ) as Record<string, unknown> | undefined;
  const admittedBuilderDelivery = (() => {
    if (stage !== "builder" || workspace === undefined) return undefined;
    try {
      const published = JSON.parse(readFileSync(evaluationManifestPath, "utf8")) as DeltaArtifactManifest;
      const selectedLocator = published.workspaceMember?.relativeLocator;
      if (selectedLocator === undefined) return undefined;
      const root = resolve(cwd, ".roll", "loop", "worktrees");
      const primaryMember = workspace.members.find((member) => member.relativeLocator === workspace.runId);
      if (primaryMember === undefined) throw new Error("missing primary workspace member");
      const primaryCheckout = realpathSync(resolve(root, primaryMember.relativeLocator));
      const primaryDeliveryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: primaryCheckout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const primaryDeliveryTree = execFileSync("git", ["show", "-s", "--format=%T", primaryDeliveryCommit], {
        cwd: primaryCheckout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (primaryDeliveryCommit === "" || primaryDeliveryTree === "") throw new Error("missing primary delivery Git fact");
      const submoduleGitlink = (commit: string, path: string): string => {
        const line = execFileSync("git", ["ls-tree", commit, "--", path], {
          cwd: primaryCheckout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const match = /^160000 commit ([0-9a-f]{40})\t/.exec(line);
        if (match?.[1] === undefined) throw new Error("missing submodule gitlink");
        return match[1];
      };
      const members = workspace.members.map((member) => {
        const checkout = resolve(root, member.relativeLocator);
        const canonical = realpathSync(checkout);
        const prefix = `${workspace.runId}.submodules/`;
        const submodulePath = member.relativeLocator.startsWith(prefix) ? member.relativeLocator.slice(prefix.length) : undefined;
        // A subordinate checkout can remain on its allocation base after the
        // primary commit has adopted a separately delivered gitlink.  The
        // primary commit is the immutable cross-repository truth, never the
        // mutable checkout HEAD.
        const deliveryCommit = submodulePath === undefined
          ? primaryDeliveryCommit
          : submoduleGitlink(primaryDeliveryCommit, submodulePath);
        const deliveryTree = execFileSync("git", ["show", "-s", "--format=%T", deliveryCommit], {
          cwd: canonical, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (deliveryCommit === "" || deliveryTree === "") throw new Error("missing delivery Git fact");
        const deliveryState = submodulePath === undefined
          ? "changed" as const
          : submoduleGitlink(primaryMember.checkoutRef.head, submodulePath) === deliveryCommit ? "unchanged" as const : "changed" as const;
        return {
          repositoryId: member.repositoryId,
          relativeLocator: member.relativeLocator,
          deliveryBase: member.checkoutRef.head,
          deliveryCommit,
          deliveryTree,
          ...(submodulePath === undefined ? {} : { deliveryState }),
          ...(member.publishRef === undefined ? {} : { publishRef: member.publishRef }),
        };
      });
      const selected = members.find((member) => member.relativeLocator === selectedLocator);
      return selected === undefined ? undefined : { selected, members };
    } catch {
      // The structural validator has already authenticated the selected member.
      // A missing immutable Git fact must leave publication without delivery
      // authority; attest will fail closed instead of guessing from primary.
      return undefined;
    }
  })();

  bus.appendEvent(eventsPath, {
    type: "delta:artifact_published",
    delegationId,
    storyId,
    role: stage,
    path: stageArtifactPath,
    // US-DELTA-004: real digest of the published stage artifact for the truth
    // projection to cross-check (empty only if the file vanished mid-publish).
    sha256: (() => {
      try {
        return createHash("sha256").update(readFileSync(stageArtifactPath)).digest("hex");
      } catch {
        return "";
      }
    })(),
    manifestPath: evaluationManifestPath,
    sessionId: "host-native",
    roleInstanceId: (roleResolved?.roleInstanceId as string) ?? "",
    identityProvenance: "host-attested" as const,
    ...(stage === "builder" && workspace !== undefined ? { runId: workspace.runId } : {}),
    ...(admittedBuilderDelivery !== undefined
      ? { deliveryCommit: admittedBuilderDelivery.selected.deliveryCommit }
      : {}),
    ...(admittedBuilderDelivery !== undefined ? { deliveryTree: admittedBuilderDelivery.selected.deliveryTree } : {}),
    ...(admittedBuilderDelivery?.selected.publishRef !== undefined
      ? { publishRef: admittedBuilderDelivery.selected.publishRef }
      : {}),
    ...(admittedBuilderDelivery !== undefined ? { deliveryMembers: admittedBuilderDelivery.members } : {}),
    ts: now,
  });

  process.stderr.write(`${validationPhaseBanner(delegationId, stage, "allowed")}\n`);

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      delegationId,
      stage,
      verdict: "allow",
    }) + "\n");
  } else {
    process.stdout.write(`Validation passed: delegation ${delegationId} stage ${stage}\n`);
  }
  return 0;
}

// ── Conclude ─────────────────────────────────────────────────────────────────

/**
 * FIX-1517 — append one explicit authorization for the one historical state
 * where an owner_hold terminal's live reservation was incorrectly renamed to a
 * successor.  This command deliberately never touches a lease or frame; the
 * existing continuation pickup CAS remains the only takeover operation.
 */
function recoverHeldCommand(args: string[]): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    const usage = lang() === "zh"
      ? "用法：roll delta recover-held --delegation <旧委派-id> --continuation-run <继任名称> --confirm <旧委派-id> [--json]\n\n只处理一类历史矛盾：旧交付已明确 owner_hold，但仍在保留的交付预留被错误写成了指定继任名称。--confirm 必须与旧委派 id 完全一致。命令只追加确认恢复记录；下一步仍需由同名继任者运行 roll delta prepare --continuation-run 接手。\n"
      : "Usage: roll delta recover-held --delegation <old-id> --continuation-run <name> --confirm <old-id> [--json]\n\nRecovers only the legacy contradiction where an explicitly owner_hold old delivery still has a reservation incorrectly named to the specified successor. --confirm must exactly match the old delegation id. This appends an authorization only; the named successor must still run roll delta prepare --continuation-run to take over.\n";
    process.stdout.write(usage);
    return 0;
  }
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;
  const knownFlags = new Set(["delegation", "continuation-run", "confirm", "json"]);
  const refuse = (error: string, detail: string): number => {
    if (json) process.stderr.write(JSON.stringify({ ok: false, error, detail }) + "\n");
    else process.stderr.write(`Recovery refused: ${detail}\n`);
    return 1;
  };
  const duplicate = detectDuplicateFlags(args, knownFlags);
  if (duplicate) return refuse("duplicate_flag", T("delta.error.duplicate_flag", `--${duplicate}`));
  if (positional.length > 0) return refuse("unexpected_positional", T("delta.error.unexpected_positional", positional[0]!));
  for (const key of Object.keys(flags)) {
    if (!knownFlags.has(key)) return refuse("unknown_flag", T("delta.error.unknown_flag", `--${key}`));
  }
  const delegationId = flags["delegation"];
  const continuationRunId = flags["continuation-run"];
  const confirmation = flags["confirm"];
  if (typeof delegationId !== "string" || delegationId === "") return refuse("missing_required", "recover-held requires --delegation <old-delegation-id>");
  if (typeof continuationRunId !== "string" || continuationRunId === "") return refuse("missing_required", "recover-held requires --continuation-run <successor-name>");
  if (typeof confirmation !== "string" || confirmation === "") return refuse("missing_required", "recover-held requires --confirm <old-delegation-id>");
  if (confirmation !== delegationId) return refuse("confirmation_mismatch", "--confirm must exactly match --delegation before a held reservation can be recovered");

  const cwd = process.cwd();
  const eventsPath = join(cwd, ".roll", "loop", "events.ndjson");
  const bus = getEventBus();
  const events = existsSync(eventsPath) ? bus.readEvents(eventsPath) : [];
  const preparations = events.filter((event) => event.type === "delta:prepared"
    && event.delegationId === delegationId);
  if (preparations.length !== 1) return refuse("recovery_not_available", "the old delegation must have exactly one managed preparation");
  const prepared = preparations[0]! as Record<string, unknown>;
  if (preparedWorkspaceSchema(prepared) !== "managed-v2" || typeof prepared.storyId !== "string" || typeof prepared.runId !== "string") {
    return refuse("recovery_not_available", "the old delegation is not a complete managed-v2 preparation");
  }
  const storyId = prepared.storyId;
  const runId = prepared.runId;
  const terminals = events.filter((event) => event.type === "delta:terminal"
    && event.delegationId === delegationId
    && event.storyId === storyId
    && event.runId === runId) as Array<Extract<RollEvent, { type: "delta:terminal" }>>;
  if (terminals.length !== 1) return refuse("recovery_not_available", "the old delegation must have exactly one terminal decision");
  const terminal = terminals[0]!;
  if (terminal.outcome !== "handoff_ready" || terminal.terminalBinding !== "handoff_only" || terminal.deliveryDisposition !== "owner_hold") {
    return refuse("recovery_not_available", "the old delegation was not explicitly concluded as owner_hold");
  }
  const lease = readLeases(join(cwd, ".roll", "loop", "leases"))[storyId];
  if (lease?.source !== "delivery-reservation" || lease.delegationId !== delegationId || lease.runId !== continuationRunId) {
    return refuse("recovery_not_available", "the live reservation does not name this exact held delegation and successor");
  }
  const recoveries = events.filter((event) => event.type === "delta:hold_recovered"
    && event.delegationId === delegationId && event.storyId === storyId);
  const typedRecoveries = recoveries as Array<Extract<RollEvent, { type: "delta:hold_recovered" }>>;
  if (typedRecoveries.length > 1) return refuse("recovery_not_available", "the legacy held delegation already has conflicting recovery evidence");
  if (typedRecoveries.length === 1) {
    const recovery = typedRecoveries[0]!;
    if (recovery.runId !== runId || recovery.continuationRunId !== continuationRunId || recovery.confirmation !== "explicit") {
      return refuse("recovery_not_available", "the legacy held delegation was already recovered for a different identity");
    }
  } else {
    bus.appendEvent(eventsPath, {
      type: "delta:hold_recovered",
      delegationId,
      storyId,
      runId,
      continuationRunId,
      confirmation: "explicit",
      ts: Date.now(),
    });
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, delegationId, storyId, continuationRunId, recovery: "owner_hold_confirmed" }) + "\n");
  else process.stdout.write(`Held delivery ${delegationId} is confirmed for '${continuationRunId}'. Next: roll delta prepare ${storyId} --continuation-run ${continuationRunId}\n`);
  return 0;
}

function concludeCommand(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  // Reject duplicate flags (parser error → zero side effects)
  const concludeKnownFlags = new Set(["delegation", "delivery-disposition", "continuation-run", "json"]);
  const dupFlag = detectDuplicateFlags(args, concludeKnownFlags);
  if (dupFlag) {
    const msg = T("delta.error.duplicate_flag", `--${dupFlag}`);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "duplicate_flag", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Reject unexpected positional args (conclude takes no positionals)
  if (positional.length > 0) {
    const msg = T("delta.error.unexpected_positional", positional[0]!);
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "unexpected_positional", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Check for unknown flags
  const knownFlags = concludeKnownFlags;
  for (const k of Object.keys(flags)) {
    if (!knownFlags.has(k)) {
      const msg = T("delta.error.unknown_flag", `--${k}`);
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "unknown_flag", detail: msg }) + "\n");
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 1;
    }
  }

  const delegationId = flags["delegation"];
  if (!delegationId || delegationId === true) {
    const msg = T("delta.error.missing_required", "--delegation");
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "missing_required", detail: msg, flag: "delegation" }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Load delegation events
  const cwd = process.cwd();
  const bus = getEventBus();
  const eventsPath = join(cwd, ".roll", "loop", "events.ndjson");
  const events = existsSync(eventsPath) ? bus.readEvents(eventsPath) : [];

  // Verify delegation exists
  const delegationEvents = events.filter(
    (e) => "delegationId" in e && (e as Record<string, unknown>).delegationId === delegationId,
  );
  if (delegationEvents.length === 0) {
    const msg = `Delegation not found: ${delegationId}`;
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // Get the prepared event for storyId
  const preparedEvent = delegationEvents.find((e) => e.type === "delta:prepared") as Record<string, unknown> | undefined;
  if (!preparedEvent) {
    const msg = `Delegation ${delegationId}: no prepared event found`;
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  if (preparedWorkspaceSchema(preparedEvent) === "unknown") {
    const detail = `Delegation ${delegationId}: unsupported workspace schema ${JSON.stringify(preparedEvent.workspaceSchema)}`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unsupported_workspace_schema", detail }) + "\n");
    else process.stderr.write(`Conclude failed: ${detail}\n`);
    return 1;
  }

  const storyId = preparedEvent.storyId as string;
  const now = Date.now();

  // Per-delegation owner terminal decision required (plan §7, §8.2 step 8).
  // The project-level Option-C ratification (§0.1/§14.5) is satisfied; what
  // remains is the per-delegation deliveryDisposition choice.
  const disposition = flags["delivery-disposition"];
  const validDispositions = ["owner_continue", "owner_hold", "owner_redelegate"];

  // Invalid enum value → parser error, ZERO side effects (no event, no delegation lookup needed beyond what we already have).
  // Design contract §5: "Reject … invalid enum literals … before side effects."
  if (disposition !== undefined && disposition !== true && !validDispositions.includes(disposition as string)) {
    const dispositionErr = T("delta.error.invalid_value", disposition as string, "--delivery-disposition", validDispositions.join("|"));
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail: dispositionErr }) + "\n");
    } else {
      process.stderr.write(`${dispositionErr}\n`);
    }
    return 1;
  }

  // Missing delivery-disposition → domain error, terminal_path_unselected (append event, retain lease)
  if (!disposition || disposition === true) {
    const detail = "No delivery-disposition selected; owner must choose owner_continue, owner_hold, or owner_redelegate";
    appendDeltaBlocked(bus, eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      reason: "terminal_path_unselected",
      detail,
      ts: now,
    });

    process.stderr.write(`${concludePhaseBanner({
      delegationId,
      storyId,
      outcome: T("delta.phase.blocked"),
      reason: "terminal_path_unselected",
    })}\n`);

    if (json) {
      process.stderr.write(JSON.stringify({
        ok: false,
        error: "terminal_path_unselected",
        detail,
      }) + "\n");
    } else {
      process.stderr.write(`${detail}\n`);
    }
    return 1;
  }

  const continuationRun = flags["continuation-run"];
  // Redelegation is a real delivery handoff, never a silent deletion of the
  // host guard.  Require the next durable owner before any terminal event is
  // written so an interrupted owner cannot make the Story claimable by an
  // anonymous competing Cycle.
  if (disposition === "owner_redelegate" && preparedWorkspaceSchema(preparedEvent) === "managed-v2"
    && (typeof continuationRun !== "string" || continuationRun === "")) {
    const detail = "Managed owner_redelegate requires --continuation-run <named-run-id>";
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "continuation_required", detail }) + "\n");
    else process.stderr.write(`Conclude failed: ${detail}\n`);
    return 1;
  }
  if (disposition !== "owner_redelegate" && continuationRun !== undefined) {
    const detail = "--continuation-run is only valid with owner_redelegate";
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "invalid_value", detail }) + "\n");
    else process.stderr.write(`Conclude failed: ${detail}\n`);
    return 1;
  }

  const runId = (preparedEvent.runId as string) ?? `delta-${delegationId}`;
  // A terminal decision is an immutable fact.  Check it before any promotion,
  // activity row, transfer, or other write.  An exact retry remains available
  // for crash recovery; every changed disposition/successor is refused.
  const recordedTerminals = delegationEvents.filter((event) => event.type === "delta:terminal") as Array<Record<string, unknown>>;
  if (recordedTerminals.length > 0) {
    const prior = recordedTerminals.length === 1 ? recordedTerminals[0]! : undefined;
    const sameRun = preparedWorkspaceSchema(preparedEvent) === "managed-v2"
      ? prior?.runId === runId
      : prior?.runId === undefined;
    const sameContinuation = disposition === "owner_redelegate"
      ? prior?.continuationRunId === continuationRun
      : prior?.continuationRunId === undefined;
    const exactRetry = prior?.outcome === "handoff_ready"
      && prior.terminalBinding === "handoff_only"
      && prior.deliveryDisposition === disposition
      && sameRun
      && sameContinuation;
    // Preserve FIX-1502's more specific read-only diagnosis for an old
    // redelegator after its named successor has already taken over.  It still
    // reaches no write: the lease admission below rejects it as superseded.
    const alreadyAdopted = prior?.deliveryDisposition === "owner_redelegate"
      && typeof prior.continuationRunId === "string"
      && events.some((event) => event.type === "delta:prepared"
        && (event as Record<string, unknown>).continuation !== undefined
        && ((event as Record<string, unknown>).continuation as Record<string, unknown>).fromDelegationId === delegationId);
    if (!exactRetry && !alreadyAdopted) {
      const detail = `Delegation ${delegationId} already has an immutable terminal decision`;
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "terminal_immutable", detail }) + "\n");
      else process.stderr.write(`Conclude failed: ${detail}\n`);
      return 1;
    }
  }

  // Verify lease identity match BEFORE writing terminal event.
  // If the lease entry has a mismatched delegationId/runId, fail-loud with
  // non-zero exit and do NOT write terminal.
  const slDir = join(cwd, ".roll", "loop", "leases");
  const leases = readLeases(slDir);
  const leaseEntry = leases[storyId];

  // Read the immutable cutover fact before accepting a terminal transition.
  // Historical frames retain their previous readable behavior; a prepared v2
  // event must prove it still owns the exact workspace reservation.  Missing
  // files never turn a post-cutover run into legacy behavior.
  let managedWorkspace: ManagedWorkspaceSet | undefined;
  const managedRecord = preparedWorkspaceSchema(preparedEvent) === "managed-v2";
  if (managedRecord) {
    try {
      const preparation = JSON.parse(readFileSync(join(
        resolveExistingUniqueCardArchiveDir(cwd, storyId)!,
        `delta-${delegationId}`,
        "preparation.json",
      ), "utf8")) as { schema?: unknown; workspace?: ManagedWorkspaceSet; runId?: unknown };
      if (preparation.schema !== "roll-delta-preparation/v2" || preparation.runId !== runId || preparation.workspace === undefined) {
        throw new Error("v2 preparation identity is incomplete");
      }
      managedWorkspace = preparation.workspace;
    } catch {
      const detail = `Managed Delta preparation is missing or corrupt for story ${storyId}`;
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "recovery_required", detail }) + "\n");
      else process.stderr.write(`Conclude failed: ${detail}\n`);
      return 1;
    }
  }

  if (managedWorkspace !== undefined) {
    const requestedContinuation = disposition === "owner_redelegate" && typeof continuationRun === "string"
      ? continuationRun
      : undefined;
    const matchingReservation = leaseEntry?.source === "delivery-reservation"
      && leaseEntry.delegationId === delegationId
      && leaseEntry.runId === runId;
    // A kill after the continuation CAS has changed the durable holder but
    // before this command returned must be a retry of the same terminal, not
    // a lease mismatch.  A different successor is deliberately refused.
    const matchingTransferredReservation = requestedContinuation !== undefined
      && leaseEntry?.source === "delivery-reservation"
      && leaseEntry.delegationId === delegationId
      && leaseEntry.runId === requestedContinuation;
    const matchingHostGuard = leaseEntry?.source === "host-delegation"
      && leaseEntry.delegationId === delegationId
      && leaseEntry.runId === runId;
    if (!matchingHostGuard && !matchingReservation && !matchingTransferredReservation) {
      // FIX-1502 — a redelegated delegation whose reservation has been picked
      // up by its named successor is superseded, not merely mismatched.  Say
      // so plainly and record nothing: the old events stay exactly as written.
      const redelegatedTerminal = delegationEvents.find((event) => event.type === "delta:terminal"
        && (event as Record<string, unknown>).deliveryDisposition === "owner_redelegate"
        && typeof (event as Record<string, unknown>).continuationRunId === "string") as Record<string, unknown> | undefined;
      const successorPrepared = redelegatedTerminal === undefined ? undefined : events.find((event) => {
        if (event.type !== "delta:prepared") return false;
        const c = (event as Record<string, unknown>).continuation as Record<string, unknown> | undefined;
        return c?.fromDelegationId === delegationId;
      }) as Record<string, unknown> | undefined;
      if (redelegatedTerminal !== undefined && successorPrepared !== undefined) {
        const detail = T(
          "delta.error.continuation_adopted",
          delegationId,
          redelegatedTerminal.continuationRunId as string,
          (successorPrepared.runId as string) ?? "unknown",
        );
        if (json) process.stderr.write(JSON.stringify({ ok: false, error: "continuation_adopted", detail }) + "\n");
        else process.stderr.write(`Conclude failed: ${detail}\n`);
        return 1;
      }
      const detail = `Managed Delta reservation missing or foreign for story ${storyId}`;
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "lease_mismatch", detail }) + "\n");
      else process.stderr.write(`Conclude failed: ${detail}\n`);
      return 1;
    }
  } else if (leaseEntry && leaseEntry.source === "host-delegation") {
    if (leaseEntry.delegationId !== delegationId || leaseEntry.runId !== runId) {
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "lease_mismatch", detail: `Lease identity mismatch: expected delegationId=${delegationId} runId=${runId}, found delegationId=${leaseEntry.delegationId} runId=${leaseEntry.runId}` }) + "\n");
      } else {
        process.stderr.write(`Conclude failed: lease identity mismatch for story ${storyId}\n`);
      }
      return 1;
    }
  }

  // Promote while the canonical lease filename remains present.  This has no
  // claimable gap: a concurrent Cycle sees either the host guard or the named
  // delivery reservation, never an absent story lease.
  const priorTerminal = delegationEvents.find((event) => event.type === "delta:terminal") as Record<string, unknown> | undefined;
  const promotedReservation = managedWorkspace !== undefined;
  const alreadyTransferred = disposition === "owner_redelegate" && typeof continuationRun === "string"
    && leaseEntry?.source === "delivery-reservation"
    && leaseEntry.delegationId === delegationId
    && leaseEntry.runId === continuationRun;
  if (promotedReservation && !alreadyTransferred && !promoteHostDelegationLease(slDir, storyId, delegationId, runId)) {
    const detail = `Managed Delta reservation promotion failed for story ${storyId}`;
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "lease_promotion_failed", detail }) + "\n");
    else process.stderr.write(`Conclude failed: ${detail}\n`);
    return 1;
  }

  // Persist the managed activity before terminal truth.  If this append fails,
  // the promoted reservation remains conservative and no handoff is claimed.
  // Lifecycle activity is keyed by run, not delegationId, so it is present in
  // the global ledger rather than the delegation-only projection.
  const hasActivity = managedWorkspace !== undefined && events.some((event) =>
    event.type === "worktree:activity_observed" && (event as Record<string, unknown>).runId === managedWorkspace!.runId,
  );
  if (managedWorkspace !== undefined && !hasActivity) {
    bus.appendEvent(eventsPath, {
      type: "worktree:activity_observed",
      runId: managedWorkspace.runId,
      source: "host_attested",
      ts: now,
    });
  }

  // Record delta:terminal with Option C binding
  const terminalEvent = {
    type: "delta:terminal" as const,
    delegationId,
    storyId,
    ...(managedWorkspace !== undefined ? { runId } : {}),
    outcome: "handoff_ready" as const,
    terminalBinding: "handoff_only" as const,
    deliveryDisposition: disposition as "owner_continue" | "owner_hold" | "owner_redelegate",
    ...(promotedReservation ? { reservationSource: "delivery-reservation" as const } : {}),
    ...(disposition === "owner_redelegate" && typeof continuationRun === "string" ? { continuationRunId: continuationRun } : {}),
    ts: now,
  };
  if (priorTerminal === undefined) {
    appendAttemptOutcomeBefore(bus, eventsPath, terminalEvent);
    bus.appendEvent(eventsPath, terminalEvent);
  }

  // ── Test seam: event append failure after terminal write ────────────────
  // If the seam throws, the terminal event IS written but the caller must
  // preserve the lease and not report success.
  if (_eventAppendFailure) {
    try {
      _eventAppendFailure(terminalEvent as Record<string, unknown>);
    } catch {
      // The seam threw — terminal event is on disk, but we must NOT release
      // the lease or report success. Return fail-loud.
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "event_append_failure", detail: "Event append failed after terminal write" }) + "\n");
      } else {
        process.stderr.write("Conclude failed: event append failure\n");
      }
      return 1;
    }
  }

  if (managedWorkspace !== undefined && disposition === "owner_redelegate") {
    // The terminal fact is written before the transfer.  A process death here
    // is recoverable: retrying conclude observes the same promoted reservation
    // and idempotently installs the named successor rather than dropping it.
    if (!transferDeliveryReservation(slDir, storyId, delegationId, runId, continuationRun as string)) {
      const detail = `Managed Delta continuation transfer failed for story ${storyId}`;
      if (json) process.stderr.write(JSON.stringify({ ok: false, error: "continuation_transfer_failed", detail }) + "\n");
      else process.stderr.write(`Conclude failed: ${detail}\n`);
      return 1;
    }
  }

  // A managed handoff is only a role-guard transfer.  It is not delivery and
  // must continue excluding a competing Cycle until the owner deliberately
  // abandons/redelegates or normal delivery reconciliation releases it.  Legacy
  // frames retain their historical behavior for read compatibility.
  const mustRetainReservation = promotedReservation;
  const released = mustRetainReservation || releaseHostDelegationLease(cwd, storyId, delegationId, runId);
  if (!released) {
    // Lease release failed — terminal event already written, but the lease
    // remains. Fail-loud so the caller knows the state is split.
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "lease_release_failed", detail: `Failed to release host-delegation lease for story ${storyId}` }) + "\n");
    } else {
      process.stderr.write(`Conclude warning: terminal recorded but lease release failed for story ${storyId}\n`);
    }
    return 1;
  }

  process.stderr.write(`${concludePhaseBanner({
    delegationId,
    storyId,
    outcome: "handoff_ready (handoff_only)",
    disposition: disposition as string,
  })}\n`);

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      delegationId,
      storyId,
      outcome: "handoff_ready",
      terminalBinding: "handoff_only",
      deliveryDisposition: disposition,
    }) + "\n");
  }

  return 0;
}

// ── Status ───────────────────────────────────────────────────────────────────

function statusCommand(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  const knownFlags = new Set(["story", "delegation", "json"]);
  const dupFlag = detectDuplicateFlags(args, knownFlags);
  if (dupFlag) {
    const msg = T("delta.error.duplicate_flag", `--${dupFlag}`);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "duplicate_flag", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  if (positional.length > 0) {
    const msg = T("delta.error.unexpected_positional", positional[0]!);
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "unexpected_positional", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const storyId = flags["story"];
  const delegationId = flags["delegation"];

  if (!storyId && !delegationId) {
    const msg = T("delta.error.status_selector");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "status_selector", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // Check for unknown flags
  for (const k of Object.keys(flags)) {
    if (!knownFlags.has(k)) {
      const msg = T("delta.error.unknown_flag", `--${k}`);
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "unknown_flag", detail: msg }) + "\n");
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 1;
    }
  }

  const cwd = process.cwd();
  const bus = getEventBus();
  const eventsPath = join(cwd, ".roll", "loop", "events.ndjson");

  // Read events for projection
  const events = existsSync(eventsPath) ? bus.readEvents(eventsPath) : [];

  // Detect orphan frames (folds events AND leases to avoid false positives)
  const orphans: Array<{ delegationId: string; frameDir: string; hasMatchingLease: boolean }> = [];

  if (storyId && typeof storyId === "string") {
    // Check for orphan frames for this story
    const cardDir = resolveExistingUniqueCardArchiveDir(cwd, storyId);
    if (cardDir) {
      const slDir = join(cwd, ".roll", "loop", "leases");
      const leases = readLeases(slDir);
      const detected = detectOrphanFrames(cardDir, events, leases, storyId);
      orphans.push(...detected);
    }
  }

  // If we have a delegationId, project it
  let statusView: ReturnType<typeof projectDelegationStatus> | null = null;
  if (delegationId && typeof delegationId === "string") {
    statusView = projectDelegationStatus(delegationId, events);
  }

  const workspaceFor = (view: NonNullable<typeof statusView>): ManagedWorkspaceSet | undefined => {
    const cardDir = resolveExistingUniqueCardArchiveDir(cwd, view.storyId);
    if (cardDir === null) return undefined;
    try {
      const preparation = JSON.parse(readFileSync(join(cardDir, `delta-${view.delegationId}`, "preparation.json"), "utf8")) as {
        schema?: unknown; workspace?: ManagedWorkspaceSet;
      };
      return preparation.schema === "roll-delta-preparation/v2" ? preparation.workspace : undefined;
    } catch { return undefined; }
  };
  const statusWorkspace = statusView === null ? undefined : workspaceFor(statusView);

  // If we have a storyId but no delegation, project ALL delegations for that story
  const delegationViews: Array<ReturnType<typeof projectDelegationStatus>> = [];
  if (storyId && typeof storyId === "string" && !delegationId) {
    for (const ev of events) {
      if (ev.type === "delta:prepared" && ev.storyId === storyId) {
        const view = projectDelegationStatus(ev.delegationId, events);
        delegationViews.push(view);
      }
    }
  }

  // Build output
  const output: Record<string, unknown> = {};

  if (json) {
    // JSON output
    if (statusView) {
      Object.assign(output, {
        ok: true,
        delegationId: statusView.delegationId,
        storyId: statusView.storyId,
        status: statusView.status,
        visibleMode: statusView.visibleMode,
        trigger: statusView.trigger,
        topology: statusView.topology,
        qualityProfile: statusView.qualityProfile,
        blockReason: statusView.blockReason,
        blockDetail: statusView.blockDetail,
        terminalBinding: statusView.terminalBinding,
        deliveryDisposition: statusView.deliveryDisposition,
        roles: statusView.roles,
        totalCost: statusView.totalCost,
        ...(statusWorkspace === undefined ? {} : { workspace: statusWorkspace }),
      });
    }
    if (delegationViews.length > 0) {
      output.delegations = delegationViews.map((v) => ({
        delegationId: v.delegationId,
        status: v.status,
        visibleMode: v.visibleMode,
        roles: v.roles,
        totalCost: v.totalCost,
      }));
    }
    if (orphans.length > 0) {
      output.uncommittedFrames = orphans.map((o) => ({
        delegationId: o.delegationId,
        frameDir: o.frameDir,
        status: o.hasMatchingLease
          ? "unknown: uncommitted_delegation_frame (lease held)"
          : "unknown: uncommitted_delegation_frame",
        hasMatchingLease: o.hasMatchingLease,
      }));
    }
    if (!statusView && delegationViews.length === 0 && orphans.length === 0) {
      output.ok = true;
      output.note = "no delegation found for this story";
    }
    process.stdout.write(JSON.stringify(output) + "\n");
  } else {
    // Human output
    if (statusView) {
      process.stdout.write(`${T("delta.field.delegation")}: ${statusView.delegationId}\n`);
      process.stdout.write(`  ${T("delta.field.story")}: ${statusView.storyId}\n`);
      process.stdout.write(`  ${T("delta.field.status")}: ${statusView.status}\n`);
      if (statusView.visibleMode) process.stdout.write(`  ${T("delta.field.mode")}: ${statusView.visibleMode}\n`);
      if (statusView.trigger) process.stdout.write(`  ${T("delta.field.trigger")}: ${statusView.trigger}\n`);
      if (statusView.topology) process.stdout.write(`  ${T("delta.field.topology")}: ${statusView.topology}\n`);
      if (statusView.qualityProfile) process.stdout.write(`  ${T("delta.field.profile")}: ${statusView.qualityProfile}\n`);
      process.stdout.write(`  ${T("delta.field.cost")}: ${statusView.totalCost}\n`);
      if (statusView.blockReason) process.stdout.write(`  ${T("delta.field.block")}: ${statusView.blockReason} — ${statusView.blockDetail ?? ""}\n`);
      if (statusView.terminalBinding) process.stdout.write(`  ${T("delta.field.terminal")}: ${statusView.terminalBinding} (${statusView.deliveryDisposition ?? ""})\n`);
      if (statusWorkspace !== undefined) {
        process.stdout.write(`  ${T("delta.field.workspace")}: ${statusWorkspace.runId}\n`);
        for (const member of statusWorkspace.members) {
          process.stdout.write(`    ${T("delta.field.member")}: ${member.relativeLocator}\n`);
          process.stdout.write(`    ${T("delta.field.detached_head")}: ${member.checkoutRef.head}\n`);
          if (member.publishRef !== undefined) process.stdout.write(`    ${T("delta.field.publish_ref")}: ${member.publishRef}\n`);
        }
      }
      if (statusView.roles.length > 0) {
        process.stdout.write(`  ${T("delta.field.roles")}:\n`);
        for (const role of statusView.roles) {
          const prov = role.identityProvenance ? ` (${role.identityProvenance})` : "";
          process.stdout.write(`    ${role.role}: ${role.status} [${role.hostId ?? "?"}/${role.modelId ?? "?"}]${prov} cost=${role.cost}\n`);
        }
      }
    }
    if (delegationViews.length > 0 && !statusView) {
      for (const v of delegationViews) {
        process.stdout.write(`Delegation: ${v.delegationId} — ${v.status} (${v.visibleMode ?? "?"})\n`);
      }
    }
    if (orphans.length > 0) {
      process.stdout.write(T("delta.status.orphan_header") + "\n");
      for (const o of orphans) {
        process.stdout.write(`  ${o.delegationId}: ${T("delta.status.orphan_status")}\n`);
        process.stdout.write(`    frame: ${o.frameDir}\n`);
        process.stdout.write(`    recovery: ${T("delta.status.orphan_recovery")}\n`);
      }
    }
    if (!statusView && delegationViews.length === 0 && orphans.length === 0) {
      process.stdout.write(T("delta.status.no_delegation") + "\n");
    }
  }

  return 0;
}
