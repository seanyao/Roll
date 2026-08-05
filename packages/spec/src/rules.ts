/**
 * Rules registry contract (US-RULE-001) — the single machine-readable
 * definition layer for roll's redlines, parsed strictly from
 * `policy/rules.yaml`. Enforcement stays in its existing capability domain;
 * this module only owns parsing + the type contract.
 */
import { parse as parseYaml } from "yaml";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface RuleEnforcement {
  readonly point: string;
  readonly marker: string;
}

export interface RuleVerification {
  readonly test: string;
  readonly marker: string;
}

export interface RuleEntry {
  readonly id: string;
  readonly kind: "redline";
  readonly statement: string;
  readonly enforcement: readonly RuleEnforcement[];
  readonly verification: RuleVerification;
  readonly triggerReport: "ALERT" | "block";
  readonly since?: string;
}

export interface DocSurface {
  readonly id: string;
  readonly paths: readonly string[];
  readonly docs: readonly string[];
}

export interface RulesRegistry {
  readonly version: number;
  readonly gates: { readonly docDrift: "soft" | "hard" };
  readonly rules: readonly RuleEntry[];
  readonly docSurfaces: readonly DocSurface[];
}

export interface RulesParseError {
  readonly message: string;
}

const RULE_ID_PATTERN = /^RL-[A-Z]+-\d{3}$/;
const TRIGGER_REPORT_VALUES = new Set(["ALERT", "block"]);
const DOC_DRIFT_VALUES = new Set(["soft", "hard"]);

function err(message: string): Result<never, RulesParseError> {
  return { ok: false, error: { message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): string | undefined {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return `${context}: unknown field "${key}"`;
  }
  return undefined;
}

function isUnderPolicyDir(p: string): boolean {
  return p === "policy" || p.startsWith("policy/");
}

function parseEnforcement(
  raw: unknown,
  context: string,
): { value: readonly RuleEnforcement[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `${context}: enforcement must be a non-empty array` };
  }
  const entries: RuleEnforcement[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const entryContext = `${context}.enforcement[${i}]`;
    if (!isPlainObject(item)) return { error: `${entryContext}: must be an object` };
    const unknown = rejectUnknownFields(item, ["point", "marker"], entryContext);
    if (unknown) return { error: unknown };
    const point = item.point;
    const marker = item.marker;
    if (typeof point !== "string" || point.length === 0) {
      return { error: `${entryContext}: point must be a non-empty string` };
    }
    if (typeof marker !== "string" || marker.length === 0) {
      return { error: `${entryContext}: marker must be a non-empty string` };
    }
    if (isUnderPolicyDir(point)) {
      return { error: `${entryContext}: enforcement.point must not point under policy/** (self-audit hole)` };
    }
    entries.push({ point, marker });
  }
  return { value: entries };
}

function parseVerification(
  raw: unknown,
  context: string,
): { value: RuleVerification } | { error: string } {
  if (!isPlainObject(raw)) return { error: `${context}: verification must be an object` };
  const unknown = rejectUnknownFields(raw, ["test", "marker"], `${context}.verification`);
  if (unknown) return { error: unknown };
  const test = raw.test;
  const marker = raw.marker;
  if (typeof test !== "string" || test.length === 0) {
    return { error: `${context}.verification: test must be a non-empty string` };
  }
  if (typeof marker !== "string" || marker.length === 0) {
    return { error: `${context}.verification: marker must be a non-empty string` };
  }
  if (isUnderPolicyDir(test)) {
    return { error: `${context}.verification: test must not point under policy/** (self-audit hole)` };
  }
  return { value: { test, marker } };
}

function parseRule(raw: unknown, index: number): { value: RuleEntry } | { error: string } {
  const context = `rules[${index}]`;
  if (!isPlainObject(raw)) return { error: `${context}: must be an object` };
  const unknown = rejectUnknownFields(
    raw,
    ["id", "kind", "statement", "enforcement", "verification", "trigger_report", "since"],
    context,
  );
  if (unknown) return { error: unknown };

  const id = raw.id;
  if (typeof id !== "string" || !RULE_ID_PATTERN.test(id)) {
    return { error: `${context}: id must match ^RL-[A-Z]+-\\d{3}$, got ${JSON.stringify(id)}` };
  }
  if (raw.kind !== "redline") {
    return { error: `${context}: kind must be "redline", got ${JSON.stringify(raw.kind)}` };
  }
  if (typeof raw.statement !== "string" || raw.statement.length === 0) {
    return { error: `${context}: statement must be a non-empty string` };
  }
  const enforcement = parseEnforcement(raw.enforcement, context);
  if ("error" in enforcement) return { error: enforcement.error };
  const verification = parseVerification(raw.verification, context);
  if ("error" in verification) return { error: verification.error };
  const triggerReport = raw.trigger_report;
  if (typeof triggerReport !== "string" || !TRIGGER_REPORT_VALUES.has(triggerReport)) {
    return { error: `${context}: trigger_report must be "ALERT" or "block", got ${JSON.stringify(triggerReport)}` };
  }
  if (raw.since !== undefined && typeof raw.since !== "string") {
    return { error: `${context}: since must be a string when present` };
  }

  return {
    value: {
      id,
      kind: "redline",
      statement: raw.statement,
      enforcement: enforcement.value,
      verification: verification.value,
      triggerReport: triggerReport as "ALERT" | "block",
      ...(raw.since !== undefined ? { since: raw.since as string } : {}),
    },
  };
}

function parseDocSurface(raw: unknown, index: number): { value: DocSurface } | { error: string } {
  const context = `doc_surfaces[${index}]`;
  if (!isPlainObject(raw)) return { error: `${context}: must be an object` };
  const unknown = rejectUnknownFields(raw, ["id", "paths", "docs"], context);
  if (unknown) return { error: unknown };
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    return { error: `${context}: id must be a non-empty string` };
  }
  const paths = raw.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string")) {
    return { error: `${context}: paths must be a non-empty array of strings` };
  }
  const docs = raw.docs;
  if (!Array.isArray(docs) || docs.length === 0 || docs.some((d) => typeof d !== "string")) {
    return { error: `${context}: docs must be a non-empty array of strings` };
  }
  return { value: { id, paths: paths as string[], docs: docs as string[] } };
}

/**
 * Strictly parse a `policy/rules.yaml` document. Rejects unknown fields,
 * duplicate rule ids, invalid enum values, invalid rule id shapes, an empty
 * registry, and any enforcement/test path escaping into `policy/**` (which
 * would let the registry certify its own aliveness).
 */
export function parseRulesRegistry(text: string): Result<RulesRegistry, RulesParseError> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (cause) {
    return err(`invalid YAML: ${(cause as Error).message}`);
  }

  if (!isPlainObject(doc)) return err("registry root must be a mapping");
  const rootUnknown = rejectUnknownFields(doc, ["version", "gates", "rules", "doc_surfaces"], "registry");
  if (rootUnknown) return err(rootUnknown);

  if (doc.version !== 1) {
    return err(`registry: version must be 1, got ${JSON.stringify(doc.version)}`);
  }

  const gates = doc.gates;
  if (!isPlainObject(gates)) return err("registry.gates: must be an object");
  const gatesUnknown = rejectUnknownFields(gates, ["doc_drift"], "registry.gates");
  if (gatesUnknown) return err(gatesUnknown);
  const docDrift = gates.doc_drift;
  if (typeof docDrift !== "string" || !DOC_DRIFT_VALUES.has(docDrift)) {
    return err(`registry.gates.doc_drift: must be "soft" or "hard", got ${JSON.stringify(docDrift)}`);
  }

  const rawRules = doc.rules;
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    return err("registry.rules: must be a non-empty array (empty registry is not permitted)");
  }
  const rules: RuleEntry[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawRules.length; i += 1) {
    const parsed = parseRule(rawRules[i], i);
    if ("error" in parsed) return err(parsed.error);
    if (seenIds.has(parsed.value.id)) {
      return err(`rules[${i}]: duplicate rule id "${parsed.value.id}"`);
    }
    seenIds.add(parsed.value.id);
    rules.push(parsed.value);
  }

  const rawDocSurfaces = doc.doc_surfaces;
  if (!Array.isArray(rawDocSurfaces)) {
    return err("registry.doc_surfaces: must be an array");
  }
  const docSurfaces: DocSurface[] = [];
  const seenSurfaceIds = new Set<string>();
  for (let i = 0; i < rawDocSurfaces.length; i += 1) {
    const parsed = parseDocSurface(rawDocSurfaces[i], i);
    if ("error" in parsed) return err(parsed.error);
    if (seenSurfaceIds.has(parsed.value.id)) {
      return err(`doc_surfaces[${i}]: duplicate doc surface id "${parsed.value.id}"`);
    }
    seenSurfaceIds.add(parsed.value.id);
    docSurfaces.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      version: doc.version,
      gates: { docDrift: docDrift as "soft" | "hard" },
      rules,
      docSurfaces,
    },
  };
}

/** Native v2 schema.  It deliberately lives beside the v1 adapter so current
 * doc-drift callers keep their stable RulesRegistry contract during migration. */
export type RuleKindV2 = "redline" | "invariant";
export type RuleSeverity = "block" | "alert" | "observe";
export interface Anchor { readonly path: string; readonly marker: string; }
export interface InvariantProjection {
  readonly about: Readonly<{ readonly en: string; readonly zh: string }>;
  readonly verification: Readonly<{ readonly faultZh: string; readonly expectedZh: string }>;
  readonly architecture: Readonly<{ readonly zh: string }>;
}
export interface V2Rule {
  readonly id: string; readonly kind: RuleKindV2; readonly statement: string;
  readonly ownerDomain: string; readonly severity: RuleSeverity;
  readonly enforcement: readonly Anchor[]; readonly verification: readonly Anchor[];
  readonly docs: readonly Anchor[]; readonly projection?: InvariantProjection; readonly since?: string;
}
export interface PipelineStage {
  readonly id: string; readonly inputs: readonly string[]; readonly outputs: readonly string[];
  readonly exit: "advance" | "pause" | "hold" | "fail"; readonly consumer: Anchor;
}
export interface ParsedRulesV2 {
  readonly version: 2; readonly gates: { readonly docDrift: "soft" | "hard" };
  readonly rules: readonly V2Rule[]; readonly pipelineStages: readonly PipelineStage[];
  readonly docSurfaces: readonly DocSurface[];
}

const V2_RULE_ID = /^(?:I(?:[1-9]|1[0-2])|RL-[A-Z]+-\d{3})$/;
const STAGE_ID = /^STAGE-[A-Z0-9-]+$/;
const DOC_SURFACE_ID = /^DS-[A-Z0-9-]+$/;

/** Normalize a concrete repository-relative path. It is intentionally not a
 * platform path helper: callers must opt in to every accepted wildcard. */
export function normalizePath(input: unknown): string {
  if (typeof input !== "string") throw new Error("path must be a string");
  const value = input.trim().replaceAll("\\", "/").replaceAll(/\/{2,}/g, "/");
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (normalized.length === 0) throw new Error("path must not be empty");
  if (normalized.includes("\0")) throw new Error("path must not contain NUL");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new Error("path must be relative");
  if (normalized.split("/").some((part) => part === "." || part === "..")) throw new Error("path must not contain . or .. segments");
  if (/[{}\[\]!?(*)]/.test(normalized)) throw new Error("path contains unsupported glob syntax");
  return normalized;
}

function v2Error(message: string): Result<never, RulesParseError> { return err(`v2: ${message}`); }
function requiredText(value: unknown, context: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function parseV2Anchor(raw: unknown, context: string): { value: Anchor } | { error: string } {
  if (!isPlainObject(raw)) return { error: `${context}: must be an object` };
  const unknown = rejectUnknownFields(raw, ["path", "marker"], context);
  if (unknown) return { error: unknown };
  const marker = requiredText(raw.marker, context);
  if (!marker) return { error: `${context}.marker: must be a non-empty string` };
  let anchorPath: string;
  try { anchorPath = normalizePath(raw.path); } catch (cause) { return { error: `${context}.path: ${(cause as Error).message}` }; }
  if (anchorPath === "policy" || anchorPath.startsWith("policy/")) return { error: `${context}.path: policy self-certification is forbidden` };
  return { value: { path: anchorPath, marker } };
}
function parseAnchors(raw: unknown, context: string): { value: readonly Anchor[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: `${context}: must be a non-empty array` };
  const values: Anchor[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseV2Anchor(raw[index], `${context}[${index}]`);
    if ("error" in parsed) return parsed;
    values.push(parsed.value);
  }
  return { value: values };
}
function parseProjection(raw: unknown, context: string): { value: InvariantProjection } | { error: string } {
  if (!isPlainObject(raw)) return { error: `${context}: must be an object` };
  const rootUnknown = rejectUnknownFields(raw, ["about", "verification", "architecture"], context);
  if (rootUnknown) return { error: rootUnknown };
  const about = raw.about; const verification = raw.verification; const architecture = raw.architecture;
  if (!isPlainObject(about) || !isPlainObject(verification) || !isPlainObject(architecture)) return { error: `${context}: about, verification and architecture must be objects` };
  const aUnknown = rejectUnknownFields(about, ["en", "zh"], `${context}.about`);
  const vUnknown = rejectUnknownFields(verification, ["fault_zh", "expected_zh"], `${context}.verification`);
  const arUnknown = rejectUnknownFields(architecture, ["zh"], `${context}.architecture`);
  if (aUnknown || vUnknown || arUnknown) return { error: aUnknown ?? vUnknown ?? arUnknown ?? "unknown projection field" };
  const en = requiredText(about.en, context); const aboutZh = requiredText(about.zh, context);
  const faultZh = requiredText(verification.fault_zh, context); const expectedZh = requiredText(verification.expected_zh, context);
  const architectureZh = requiredText(architecture.zh, context);
  if (!en || !aboutZh || !faultZh || !expectedZh || !architectureZh) return { error: `${context}: all projection strings must be non-empty` };
  return { value: { about: { en, zh: aboutZh }, verification: { faultZh, expectedZh }, architecture: { zh: architectureZh } } };
}

/** Strict native v2 parser. No v1 fallback is attempted from this entrypoint. */
export function parseRulesV2(text: string): Result<ParsedRulesV2, RulesParseError> {
  let doc: unknown;
  try { doc = parseYaml(text); } catch (cause) { return v2Error(`invalid YAML: ${(cause as Error).message}`); }
  if (!isPlainObject(doc)) return v2Error("registry root must be a mapping");
  const rootUnknown = rejectUnknownFields(doc, ["version", "gates", "rules", "pipeline_stages", "doc_surfaces"], "registry");
  if (rootUnknown) return v2Error(rootUnknown);
  if (doc.version !== 2) return v2Error(`registry: version must be 2, got ${JSON.stringify(doc.version)}`);
  if (!isPlainObject(doc.gates)) return v2Error("registry.gates: must be an object");
  const gatesUnknown = rejectUnknownFields(doc.gates, ["doc_drift"], "registry.gates");
  if (gatesUnknown) return v2Error(gatesUnknown);
  if (doc.gates.doc_drift !== "soft" && doc.gates.doc_drift !== "hard") return v2Error("registry.gates.doc_drift: must be soft or hard");
  if (!Array.isArray(doc.rules)) return v2Error("registry.rules: must be an array");
  const ids = new Set<string>(); const rules: V2Rule[] = [];
  for (let index = 0; index < doc.rules.length; index += 1) {
    const raw = doc.rules[index]; const context = `rules[${index}]`;
    if (!isPlainObject(raw)) return v2Error(`${context}: must be an object`);
    const unknown = rejectUnknownFields(raw, ["id", "kind", "statement", "owner_domain", "severity", "enforcement", "verification", "docs", "projection", "since"], context);
    if (unknown) return v2Error(unknown);
    const id = requiredText(raw.id, context); if (!id || !V2_RULE_ID.test(id)) return v2Error(`${context}.id: invalid rule id`);
    if (ids.has(id)) return v2Error(`${context}: duplicate rule id \"${id}\"`); ids.add(id);
    if (raw.kind !== "redline" && raw.kind !== "invariant") return v2Error(`${context}.kind: must be redline or invariant`);
    const statement = requiredText(raw.statement, context); const ownerDomain = requiredText(raw.owner_domain, context);
    if (!statement || !ownerDomain) return v2Error(`${context}: statement and owner_domain must be non-empty strings`);
    if (raw.severity !== "block" && raw.severity !== "alert" && raw.severity !== "observe") return v2Error(`${context}.severity: invalid enum`);
    const enforcement = parseAnchors(raw.enforcement, `${context}.enforcement`); const verification = parseAnchors(raw.verification, `${context}.verification`); const docs = parseAnchors(raw.docs, `${context}.docs`);
    if ("error" in enforcement) return v2Error(enforcement.error);
    if ("error" in verification) return v2Error(verification.error);
    if ("error" in docs) return v2Error(docs.error);
    if (raw.kind === "redline" && raw.projection !== undefined) return v2Error(`${context}.projection: redline must not define projection`);
    let projection: InvariantProjection | undefined;
    if (raw.kind === "invariant") { if (raw.projection === undefined) return v2Error(`${context}.projection: invariant requires projection`); const parsed = parseProjection(raw.projection, `${context}.projection`); if ("error" in parsed) return v2Error(parsed.error); projection = parsed.value; }
    if (raw.since !== undefined && !requiredText(raw.since, context)) return v2Error(`${context}.since: must be a non-empty string when present`);
    rules.push({ id, kind: raw.kind, statement, ownerDomain, severity: raw.severity, enforcement: enforcement.value, verification: verification.value, docs: docs.value, ...(projection ? { projection } : {}), ...(raw.since !== undefined ? { since: raw.since as string } : {}) });
  }
  const stagesRaw = doc.pipeline_stages ?? [];
  if (!Array.isArray(stagesRaw)) return v2Error("registry.pipeline_stages: must be an array");
  const stageIds = new Set<string>(); const pipelineStages: PipelineStage[] = [];
  for (let index = 0; index < stagesRaw.length; index += 1) {
    const raw = stagesRaw[index]; const context = `pipeline_stages[${index}]`;
    if (!isPlainObject(raw)) return v2Error(`${context}: must be an object`);
    const unknown = rejectUnknownFields(raw, ["id", "inputs", "outputs", "exit", "consumer"], context); if (unknown) return v2Error(unknown);
    const id = requiredText(raw.id, context); if (!id || !STAGE_ID.test(id) || stageIds.has(id)) return v2Error(`${context}.id: invalid or duplicate stage id`); stageIds.add(id);
    const inputs = raw.inputs; const outputs = raw.outputs;
    if (!Array.isArray(inputs) || !Array.isArray(outputs) || inputs.some((value) => !requiredText(value, context)) || outputs.some((value) => !requiredText(value, context))) return v2Error(`${context}: inputs and outputs must be string arrays`);
    if (raw.exit !== "advance" && raw.exit !== "pause" && raw.exit !== "hold" && raw.exit !== "fail") return v2Error(`${context}.exit: invalid enum`);
    const consumer = parseV2Anchor(raw.consumer, `${context}.consumer`); if ("error" in consumer) return v2Error(consumer.error);
    if (!/^packages\/(?:core|cli|infra|spec)\/src\//.test(consumer.value.path)) return v2Error(`${context}.consumer.path: must name production source`);
    pipelineStages.push({ id, inputs: inputs as string[], outputs: outputs as string[], exit: raw.exit, consumer: consumer.value });
  }
  if (!Array.isArray(doc.doc_surfaces)) return v2Error("registry.doc_surfaces: must be an array");
  const surfaceIds = new Set<string>(); const docSurfaces: DocSurface[] = [];
  for (let index = 0; index < doc.doc_surfaces.length; index += 1) {
    const raw = doc.doc_surfaces[index]; const context = `doc_surfaces[${index}]`;
    if (!isPlainObject(raw)) return v2Error(`${context}: must be an object`);
    const unknown = rejectUnknownFields(raw, ["id", "paths", "docs"], context); if (unknown) return v2Error(unknown);
    const id = requiredText(raw.id, context); if (!id || !DOC_SURFACE_ID.test(id) || surfaceIds.has(id)) return v2Error(`${context}.id: invalid or duplicate doc surface id`); surfaceIds.add(id);
    if (!Array.isArray(raw.paths) || !Array.isArray(raw.docs) || raw.paths.length === 0 || raw.docs.length === 0 || raw.paths.some((value) => typeof value !== "string") || raw.docs.some((value) => typeof value !== "string")) return v2Error(`${context}: paths and docs must be non-empty string arrays`);
    docSurfaces.push({ id, paths: raw.paths as string[], docs: raw.docs as string[] });
  }
  return { ok: true, value: { version: 2, gates: { docDrift: doc.gates.doc_drift }, rules, pipelineStages, docSurfaces } };
}
