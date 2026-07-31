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
