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
  type DelegationTrigger,
  type DeliveryTopology,
  type QualityProfile,
  type DeltaRole,
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
import { EventBus, projectDelegationStatus, readLeases, validateDeltaManifest } from "@roll/core";
import type { DeltaArtifactManifest } from "@roll/spec";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// ── Locale resolution ────────────────────────────────────────────────────────

function lang() {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function T(key: string, ...args: Array<string | number>): string {
  return t(v3Catalog, lang(), key, ...args);
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

// ── Subcommand routing ────────────────────────────────────────────────────────

export function deltaCommand(args: string[]): number {
  const sub = args[0];

  // Help
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(T("delta.help.usage"));
    return 0;
  }

  // Route to subcommand
  switch (sub) {
    case "prepare":
      return prepareCommand(args.slice(1));
    case "validate":
      return validateCommand(args.slice(1));
    case "conclude":
      return concludeCommand(args.slice(1));
    case "status":
      return statusCommand(args.slice(1));
    default:
      process.stderr.write(`${T("delta.error.unknown_subcommand", sub)}\n`);
      return 1;
  }
}

// ── Prepare ──────────────────────────────────────────────────────────────────

function prepareCommand(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  if ("cycle" in flags) {
    const msg = T("delta.error.cycle_rejected");
    if (json) process.stderr.write(JSON.stringify({ ok: false, error: "cycle_rejected", detail: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  const knownFlags = new Set(["trigger", "topology", "profile", "preset", "resolution", "json"]);
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
  try {
    resolutionTemplate = JSON.parse(readFileSync(resolutionPath, "utf8"));
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
    resolutionTemplate: resolutionTemplate as PrepareInput["resolutionTemplate"],
  };

  try {
    const result = prepareDelegation(process.cwd(), input);

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

      // delta:prepared
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
        ts: now,
      });
      if (_eventAppendFailure) {
        try { _eventAppendFailure({ type: "delta:prepared" }); } catch {
          if (json) process.stderr.write(JSON.stringify({ ok: false, error: "event_append_failure", detail: "Event append failure after delta:prepared" }) + "\n");
          else process.stderr.write("Prepare failed: event append failure\n");
          return 1;
        }
      }

      // delta:role_resolved for each role
      const roles = (input.resolutionTemplate as unknown as Record<string, unknown>).roles;
      if (Array.isArray(roles)) {
        for (const role of roles) {
          const r = role as Record<string, unknown>;
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

    if (json) {
      process.stdout.write(JSON.stringify({
        ok: true,
        delegationId: result.delegationId,
        runId: result.runId,
        artifacts: {
          frameDir: result.frameDir,
          resolutionPath: result.resolutionPath,
          markerPath: result.markerPath,
          preparationPath: result.preparationPath,
        },
      }) + "\n");
    } else {
      process.stdout.write(`Delegation prepared: ${result.delegationId}\n`);
      process.stdout.write(`  runId: ${result.runId}\n`);
      process.stdout.write(`  frame: ${result.frameDir}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof PrepareError) {
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: err.code, detail: err.message }) + "\n");
      } else {
        process.stderr.write(`roll delta prepare: ${err.message}\n`);
      }
      return 1;
    }
    // _prepareInterruptAfterWrite and other unexpected errors — re-throw
    throw err;
  }
}

// ── Validator seam ────────────────────────────────────────────────────────────

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

// ── Validate ─────────────────────────────────────────────────────────────────

function validateCommand(args: string[]): number {
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

  // Locate the frame directory and stage artifact
  // For US-003, we check that the delegation's frame directory exists
  // and that the stage artifact/manifest is at its prescribed path.
  // Deep validation (digest, token, attestation) is US-004.
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

  const storyId = preparedEvent.storyId as string;
  const cardDir = resolveExistingUniqueCardArchiveDir(cwd, storyId);
  if (!cardDir) {
    const msg = `Story ${storyId}: card directory not found`;
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
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "delegation_not_found", detail: msg }) + "\n");
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // ── Stage admission ──────────────────────────────────────────────────────
  // Admission checks run before the validator and short-circuit on failure.
  // Admission failures produce a typed `delta:blocked` event and never call
  // the validator.
  const now = Date.now();

  // Admission check 1: delegation must not be terminal
  const terminalEvent = delegationEvents.find((e) => e.type === "delta:terminal");
  if (terminalEvent) {
    bus.appendEvent(eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "terminal_path_unselected",
      detail: `Delegation ${delegationId} is terminal (outcome: ${(terminalEvent as Record<string, unknown>).outcome}); cannot validate further stages`,
      ts: now,
    });
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "terminal_path_unselected", detail: `Delegation is terminal`, role: stage }) + "\n");
    } else {
      process.stderr.write(`Delegation ${delegationId} is terminal` + "\n");
    }
    return 1;
  }

  // Admission check 2: delegation must not be blocked
  const blockedEvent = delegationEvents.find((e) => e.type === "delta:blocked");
  if (blockedEvent) {
    const blocked = blockedEvent as Record<string, unknown>;
    bus.appendEvent(eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "host_supervisor_required",
      detail: `Delegation ${delegationId} is blocked (${blocked.reason as string ?? "unknown"}); cannot validate further stages`,
      ts: now,
    });
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "host_supervisor_required", detail: `Delegation is blocked`, role: stage }) + "\n");
    } else {
      process.stderr.write(`Delegation ${delegationId} is blocked` + "\n");
    }
    return 1;
  }

  // Admission check 3: stage must be a role resolved in this delegation
  const resolvedRoles = delegationEvents
    .filter((e) => e.type === "delta:role_resolved")
    .map((e) => (e as Record<string, unknown>).role as string);
  if (stage && !resolvedRoles.includes(stage)) {
    bus.appendEvent(eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "invalid_resolution",
      detail: `Stage '${stage}' is not a resolved role in delegation ${delegationId}. Resolved roles: ${resolvedRoles.join(", ")}`,
      ts: now,
    });
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
    bus.appendEvent(eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: "identity_collision",
      detail: `Stage '${stage}' has already been published for delegation ${delegationId}`,
      ts: now,
    });
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
  };

  const validator = _injectedValidator ?? defaultValidator;
  const result = validator(validationInput);

  if (!result.ok) {
    // Block: append delta:blocked event, return non-zero
    bus.appendEvent(eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      role: stage,
      reason: result.reason as import("@roll/spec").DeltaBlockReason,
      detail: result.detail ?? "",
      ts: now,
    });

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

  // Allow: append lifecycle event (delta:artifact_published for US-003 thin validator)
  // Find the matching role_resolved event for hostId/modelId/roleInstanceId
  const roleResolved = delegationEvents.find(
    (e) => e.type === "delta:role_resolved" && (e as Record<string, unknown>).role === stage,
  ) as Record<string, unknown> | undefined;

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
    ts: now,
  });

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

function concludeCommand(args: string[]): number {
  const { positional, flags } = parseArgs(args);
  const json = flags["json"] === true;

  // Reject duplicate flags (parser error → zero side effects)
  const concludeKnownFlags = new Set(["delegation", "delivery-disposition", "json"]);
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
    bus.appendEvent(eventsPath, {
      type: "delta:blocked",
      delegationId,
      storyId,
      reason: "terminal_path_unselected",
      detail,
      ts: now,
    });

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

  // Verify lease identity match BEFORE writing terminal event.
  // If the lease entry has a mismatched delegationId/runId, fail-loud with
  // non-zero exit and do NOT write terminal.
  const runId = (preparedEvent.runId as string) ?? `delta-${delegationId}`;
  const slDir = join(cwd, ".roll", "loop", "leases");
  const leases = readLeases(slDir);
  const leaseEntry = leases[storyId];
  if (leaseEntry && leaseEntry.source === "host-delegation") {
    if (leaseEntry.delegationId !== delegationId || leaseEntry.runId !== runId) {
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: "lease_mismatch", detail: `Lease identity mismatch: expected delegationId=${delegationId} runId=${runId}, found delegationId=${leaseEntry.delegationId} runId=${leaseEntry.runId}` }) + "\n");
      } else {
        process.stderr.write(`Conclude failed: lease identity mismatch for story ${storyId}\n`);
      }
      return 1;
    }
  }

  // Record delta:terminal with Option C binding
  const terminalEvent = {
    type: "delta:terminal" as const,
    delegationId,
    storyId,
    outcome: "handoff_ready" as const,
    terminalBinding: "handoff_only" as const,
    deliveryDisposition: disposition as "owner_continue" | "owner_hold" | "owner_redelegate",
    ts: now,
  };
  bus.appendEvent(eventsPath, terminalEvent);

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

  // Release host-delegation lease (identity match requires delegationId + runId)
  const released = releaseHostDelegationLease(cwd, storyId, delegationId, runId);
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

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      delegationId,
      storyId,
      outcome: "handoff_ready",
      terminalBinding: "handoff_only",
      deliveryDisposition: disposition,
    }) + "\n");
  } else {
    process.stdout.write(`Delegation concluded: ${delegationId}\n`);
    process.stdout.write(`  Story: ${storyId}\n`);
    process.stdout.write(`  Outcome: handoff_ready (handoff_only)\n`);
    process.stdout.write(`  Disposition: ${disposition}\n`);
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
      process.stdout.write(`Delegation: ${statusView.delegationId}\n`);
      process.stdout.write(`  Story: ${statusView.storyId}\n`);
      process.stdout.write(`  Status: ${statusView.status}\n`);
      if (statusView.visibleMode) process.stdout.write(`  Mode: ${statusView.visibleMode}\n`);
      if (statusView.trigger) process.stdout.write(`  Trigger: ${statusView.trigger}\n`);
      if (statusView.topology) process.stdout.write(`  Topology: ${statusView.topology}\n`);
      if (statusView.qualityProfile) process.stdout.write(`  Profile: ${statusView.qualityProfile}\n`);
      process.stdout.write(`  Cost: ${statusView.totalCost}\n`);
      if (statusView.blockReason) process.stdout.write(`  Block: ${statusView.blockReason} — ${statusView.blockDetail ?? ""}\n`);
      if (statusView.terminalBinding) process.stdout.write(`  Terminal: ${statusView.terminalBinding} (${statusView.deliveryDisposition ?? ""})\n`);
      if (statusView.roles.length > 0) {
        process.stdout.write(`  Roles:\n`);
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
