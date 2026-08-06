/**
 * @responsibility Defines the inventory parser and the filesystem-agnostic coverage auditor.
 */
/**
 * The inventory auditor is intentionally filesystem-agnostic.  The CLI script
 * supplies a tiny adapter; tests supply an in-memory tree.  Keeping discovery
 * here makes ordering, containment and fail-closed classification testable
 * without processes, globs, or the host filesystem.
 */
import { parse as parseYaml } from "yaml";
import { normalizePath, type ParsedRulesV2 } from "./rules.js";

export type InventoryPurpose = "responsibility" | "rule-candidate" | "doc-surface";
export type CandidateClassification = "registered" | "duplicate-of" | "out-of-scope";
export interface CoverageExclusion { readonly path: string; readonly reason: string; readonly owner: string; readonly reviewBy: string; }
export interface CoverageSet { readonly id: string; readonly purpose: InventoryPurpose; readonly roots: readonly string[]; readonly include: readonly string[]; readonly exclude: readonly CoverageExclusion[]; readonly allowOverlapWith: readonly string[]; readonly mapLabel?: string; }
export interface InventoryCandidate { readonly path: string; readonly marker: string; readonly classification: CandidateClassification; readonly ruleId?: string; readonly reason: string; readonly reviewedBy: string; }
export interface RulesInventory { readonly version: 1; readonly coverageSets: readonly CoverageSet[]; readonly candidates: readonly InventoryCandidate[]; }
export interface InventoryError { readonly message: string; }
export type InventoryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: InventoryError };
export type AuditBucket = "covered" | "excluded" | "missing" | "orphan_anchor" | "candidate" | "ignored_by_include" | "overlap_ambiguous" | "system_excluded";
export interface AuditItem { readonly coverageSetId: string; readonly path: string; readonly marker?: string; readonly reason?: string; }
export interface RulesInventoryReport { readonly covered: readonly AuditItem[]; readonly excluded: readonly AuditItem[]; readonly missing: readonly AuditItem[]; readonly orphan_anchor: readonly AuditItem[]; readonly candidate: readonly AuditItem[]; readonly ignored_by_include: readonly AuditItem[]; readonly overlap_ambiguous: readonly AuditItem[]; readonly system_excluded: readonly AuditItem[]; }
export interface InventoryFileSystem { readonly list: (directory: string) => readonly Readonly<{ readonly name: string; readonly kind: "file" | "directory" | "symlink" }> []; readonly read: (file: string) => string; readonly realpath?: (file: string) => string; }

const SET_ID = /^[a-z0-9][a-z0-9-]*$/;
const SYSTEM_DIRS = new Set(["node_modules", "dist", ".git", ".pnpm"]);
const buckets: readonly AuditBucket[] = ["covered", "excluded", "missing", "orphan_anchor", "candidate", "ignored_by_include", "overlap_ambiguous", "system_excluded"];

function fail<T = never>(message: string): InventoryResult<T> { return { ok: false, error: { message } }; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function unknownFields(value: Record<string, unknown>, allowed: readonly string[], context: string): string | undefined { return Object.keys(value).find((key) => !allowed.includes(key)) ? `${context}: unknown field \"${Object.keys(value).find((key) => !allowed.includes(key))}\"` : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim().length > 0 ? value : undefined; }
function normalized(value: unknown, context: string): InventoryResult<string> { try { return { ok: true, value: normalizePath(value) }; } catch (cause) { return fail(`${context}: ${(cause as Error).message}`); } }

/** The allowed include language is deliberately smaller than a glob. */
export function parseIncludePattern(value: unknown): InventoryResult<string> {
  const input = text(value);
  if (!input) return fail("include pattern must be a non-empty string");
  const pattern = input.trim();
  if (/[{}\[\]!?(]|\\/.test(pattern) || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return fail(`unsupported include pattern \"${pattern}\"`);
  if (/^\*\*\/\*\.[^*/]+$/.test(pattern) || /^\*\.[^*/]+$/.test(pattern) || /^[^*]+$/.test(pattern)) return { ok: true, value: pattern };
  return fail(`unsupported include pattern \"${pattern}\"`);
}
function stringArray(raw: unknown, context: string, nonempty = true): InventoryResult<readonly string[]> {
  if (!Array.isArray(raw) || (nonempty && raw.length === 0)) return fail(`${context}: must be a${nonempty ? " non-empty" : ""} array`);
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 1) { const value = text(raw[index]); if (!value) return fail(`${context}[${index}]: must be a non-empty string`); values.push(value); }
  return { ok: true, value: values };
}

export function parseRulesInventory(textInput: string): InventoryResult<RulesInventory> {
  let root: unknown; try { root = parseYaml(textInput); } catch (cause) { return fail(`invalid YAML: ${(cause as Error).message}`); }
  if (!plain(root)) return fail("inventory root must be a mapping");
  const rootUnknown = unknownFields(root, ["version", "coverage_sets", "candidates"], "inventory"); if (rootUnknown) return fail(rootUnknown);
  if (root.version !== 1) return fail(`inventory.version: must be 1, got ${JSON.stringify(root.version)}`);
  if (!Array.isArray(root.coverage_sets) || !Array.isArray(root.candidates)) return fail("inventory.coverage_sets and inventory.candidates must be arrays");
  const ids = new Set<string>(); const mapLabels = new Set<string>(); const coverageSets: CoverageSet[] = [];
  for (let index = 0; index < root.coverage_sets.length; index += 1) {
    const raw = root.coverage_sets[index]; const context = `coverage_sets[${index}]`;
    if (!plain(raw)) return fail(`${context}: must be an object`);
    const fieldError = unknownFields(raw, ["id", "purpose", "roots", "include", "exclude", "allow_overlap_with", "map_label"], context); if (fieldError) return fail(fieldError);
    const id = text(raw.id); if (!id || !SET_ID.test(id) || ids.has(id)) return fail(`${context}.id: invalid or duplicate coverage set id`); ids.add(id);
    if (raw.purpose !== "responsibility" && raw.purpose !== "rule-candidate" && raw.purpose !== "doc-surface") return fail(`${context}.purpose: invalid purpose`);
    let mapLabel: string | undefined;
    if (raw.map_label !== undefined) {
      const label = text(raw.map_label);
      if (!label || !SET_ID.test(label)) return fail(`${context}.map_label: invalid map_label`);
      if (raw.purpose !== "responsibility") return fail(`${context}.map_label: only valid on responsibility sets`);
      if (label === "core") return fail(`${context}.map_label: "core" is reserved; the legacy core set omits map_label`);
      if (mapLabels.has(label)) return fail(`${context}.map_label: duplicate map_label "${label}"`);
      mapLabels.add(label);
      mapLabel = label;
    }
    const rootsRaw = stringArray(raw.roots, `${context}.roots`); if (!rootsRaw.ok) return rootsRaw;
    const roots: string[] = []; for (const rootPath of rootsRaw.value) { const parsed = normalized(rootPath, `${context}.roots`); if (!parsed.ok) return parsed; roots.push(parsed.value); }
    if (new Set(roots).size !== roots.length) return fail(`${context}.roots: duplicate root`);
    if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && other.startsWith(`${root}/`)))) return fail(`${context}.roots: overlapping roots are not permitted`);
    const includeRaw = stringArray(raw.include, `${context}.include`); if (!includeRaw.ok) return includeRaw;
    const include: string[] = []; for (const pattern of includeRaw.value) { const parsed = parseIncludePattern(pattern); if (!parsed.ok) return parsed; include.push(parsed.value); }
    const overlapRaw = raw.allow_overlap_with === undefined ? { ok: true as const, value: [] as readonly string[] } : stringArray(raw.allow_overlap_with, `${context}.allow_overlap_with`, false); if (!overlapRaw.ok) return overlapRaw;
    const excludeRaw = raw.exclude === undefined ? [] : raw.exclude; if (!Array.isArray(excludeRaw)) return fail(`${context}.exclude: must be an array`);
    const exclude: CoverageExclusion[] = []; const excluded = new Set<string>();
    for (let ex = 0; ex < excludeRaw.length; ex += 1) { const item = excludeRaw[ex]; const exContext = `${context}.exclude[${ex}]`; if (!plain(item)) return fail(`${exContext}: must be an object`); const field = unknownFields(item, ["path", "reason", "owner", "review_by"], exContext); if (field) return fail(field); const path = normalized(item.path, `${exContext}.path`); if (!path.ok) return path; const reason = text(item.reason); const owner = text(item.owner); const reviewBy = text(item.review_by); if (!reason || !owner || !reviewBy || excluded.has(path.value)) return fail(`${exContext}: path, reason, owner and review_by must be non-empty; path must be unique`); excluded.add(path.value); exclude.push({ path: path.value, reason, owner, reviewBy }); }
    if (exclude.some((entry) => !roots.some((root) => entry.path.startsWith(`${root}/`)))) return fail(`${context}.exclude: path must be contained by a declared root`);
    coverageSets.push({ id, purpose: raw.purpose, roots, include, exclude, allowOverlapWith: overlapRaw.value, ...(mapLabel === undefined ? {} : { mapLabel }) });
  }
  const seenCandidates = new Set<string>(); const candidates: InventoryCandidate[] = [];
  for (let index = 0; index < root.candidates.length; index += 1) {
    const raw = root.candidates[index]; const context = `candidates[${index}]`; if (!plain(raw)) return fail(`${context}: must be an object`);
    const field = unknownFields(raw, ["path", "marker", "classification", "rule_id", "reason", "reviewed_by"], context); if (field) return fail(field);
    const path = normalized(raw.path, `${context}.path`); if (!path.ok) return path; const marker = text(raw.marker); const reason = text(raw.reason); const reviewedBy = text(raw.reviewed_by);
    if (!marker || !reason || !reviewedBy || (raw.classification !== "registered" && raw.classification !== "duplicate-of" && raw.classification !== "out-of-scope")) return fail(`${context}: marker, classification, reason and reviewed_by are required`);
    const ruleId = raw.rule_id === undefined ? undefined : text(raw.rule_id); if ((raw.classification === "out-of-scope" && ruleId !== undefined) || (raw.classification !== "out-of-scope" && !ruleId)) return fail(`${context}: rule_id role requirement violated`);
    const key = `${path.value}\u0000${marker}`; if (seenCandidates.has(key)) return fail(`${context}: duplicate candidate`); seenCandidates.add(key);
    candidates.push({ path: path.value, marker, classification: raw.classification, ...(ruleId ? { ruleId } : {}), reason, reviewedBy });
  }
  for (const candidate of candidates) {
    const inCandidateScope = coverageSets.some((set) => set.purpose === "rule-candidate" && set.roots.some((root) => candidate.path.startsWith(`${root}/`)));
    if (!inCandidateScope && coverageSets.some((set) => set.purpose === "rule-candidate")) return fail(`candidate ${candidate.path}: outside declared rule-candidate roots`);
  }
  return { ok: true, value: { version: 1, coverageSets, candidates } };
}

function relativeTo(root: string, file: string): string | undefined { return file === root ? "" : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined; }
export function includeMatches(pattern: string, relativePath: string): boolean {
  if (/^\*\*\/\*\.[^*/]+$/.test(pattern)) return relativePath.endsWith(pattern.slice(4));
  if (/^\*\.[^*/]+$/.test(pattern)) return !relativePath.includes("/") && relativePath.endsWith(pattern.slice(1));
  return relativePath === pattern;
}
function pathMatchesSurface(pattern: string, file: string): boolean { return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -3)) : pattern === file; }
function item(coverageSetId: string, path: string, more: Omit<AuditItem, "coverageSetId" | "path"> = {}): AuditItem { return { coverageSetId, path, ...more }; }
function sort(items: readonly AuditItem[]): readonly AuditItem[] { return [...items].sort((a, b) => `${a.coverageSetId}\u0000${a.path}\u0000${a.marker ?? ""}`.localeCompare(`${b.coverageSetId}\u0000${b.path}\u0000${b.marker ?? ""}`)); }
function isSystemDirectory(path: string): boolean { const parts = path.split("/"); return parts.some((part, index) => SYSTEM_DIRS.has(part) || (part === ".roll" && parts[index + 1] === "loop" && parts[index + 2] === "worktrees")); }
const RESPONSIBILITY_HEADER = /^\s*\/\*\*[\s\S]*?\*\//;
const RESPONSIBILITY_DECLARATION = /^\s*\*[ \t]*@responsibility(?:[ \t]+(.*))?[ \t]*$/gm;
/** Counts `@responsibility` declaration lines inside the FIRST JSDoc header block only (US-RULE-011). */
function responsibilityCount(source: string): number { return [...(RESPONSIBILITY_HEADER.exec(source)?.[0] ?? "").matchAll(RESPONSIBILITY_DECLARATION)].length; }

export function auditRulesInventory(inventory: RulesInventory, rules: ParsedRulesV2, fs: InventoryFileSystem, repositoryRoot = ""): RulesInventoryReport {
  const report = Object.fromEntries(buckets.map((bucket) => [bucket, [] as AuditItem[]])) as Record<AuditBucket, AuditItem[]>;
  const observations: Array<{ readonly set: CoverageSet; readonly path: string }> = [];
  const walk = (set: CoverageSet, directory: string): void => {
    for (const entry of [...fs.list(directory)].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      const rel = repositoryRoot && path.startsWith(`${repositoryRoot}/`) ? path.slice(repositoryRoot.length + 1) : path;
      if (entry.kind === "symlink") { report.system_excluded.push(item(set.id, rel, { reason: "symlink" })); continue; }
      if (isSystemDirectory(rel)) { report.system_excluded.push(item(set.id, rel, { reason: "system directory" })); continue; }
      if (entry.kind === "directory") { walk(set, path); continue; }
      let normalizedPath: string; try { normalizedPath = normalizePath(rel); } catch { report.system_excluded.push(item(set.id, rel, { reason: "unsafe path" })); continue; }
      const relative = relativeTo(set.roots.find((root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`)) ?? "", normalizedPath);
      if (relative === undefined) continue;
      if (!set.include.some((pattern) => includeMatches(pattern, relative))) { report.ignored_by_include.push(item(set.id, normalizedPath)); continue; }
      const exclusion = set.exclude.find((candidate) => candidate.path === normalizedPath);
      if (exclusion) { report.excluded.push(item(set.id, normalizedPath, { reason: exclusion.reason })); continue; }
      observations.push({ set, path: normalizedPath });
    }
  };
  for (const set of inventory.coverageSets) for (const root of set.roots) walk(set, repositoryRoot ? `${repositoryRoot}/${root}` : root);
  for (let left = 0; left < observations.length; left += 1) for (let right = left + 1; right < observations.length; right += 1) { const a = observations[left]; const b = observations[right]; if (!a || !b || a.path !== b.path || a.set.purpose !== b.set.purpose || (a.set.allowOverlapWith.includes(b.set.id) && b.set.allowOverlapWith.includes(a.set.id))) continue; report.overlap_ambiguous.push(item(a.set.id, a.path, { reason: b.set.id }), item(b.set.id, b.path, { reason: a.set.id })); }
  const registered = new Set(rules.rules.map((rule) => rule.id));
  for (const observation of observations) {
    const source = fs.read(repositoryRoot ? `${repositoryRoot}/${observation.path}` : observation.path);
    if (observation.set.purpose === "responsibility") { const count = responsibilityCount(source); if (count === 1) report.covered.push(item(observation.set.id, observation.path)); else report.missing.push(item(observation.set.id, observation.path, { reason: count === 0 ? "missing @responsibility" : "multiple @responsibility declarations" })); continue; }
    if (observation.set.purpose === "rule-candidate") { const found = inventory.candidates.filter((candidate) => candidate.path === observation.path); if (found.length === 0) { report.candidate.push(item(observation.set.id, observation.path, { reason: "unclassified candidate" })); continue; } for (const candidate of found) { if (candidate.classification === "registered" && candidate.ruleId && registered.has(candidate.ruleId)) report.covered.push(item(observation.set.id, observation.path, { marker: candidate.marker })); else if (candidate.classification === "out-of-scope") report.excluded.push(item(observation.set.id, observation.path, { marker: candidate.marker, reason: candidate.reason })); else report.orphan_anchor.push(item(observation.set.id, observation.path, { marker: candidate.marker, reason: "candidate has no registered v2 rule" })); } continue; }
    const surface = rules.docSurfaces.find((candidate) => candidate.paths.some((pattern) => pathMatchesSurface(pattern, observation.path)));
    if (surface) report.covered.push(item(observation.set.id, observation.path, { marker: surface.id })); else report.missing.push(item(observation.set.id, observation.path, { reason: "no matching doc surface" }));
  }
  return Object.fromEntries(buckets.map((bucket) => [bucket, sort(report[bucket])])) as unknown as RulesInventoryReport;
}

export function inventoryReportFails(report: RulesInventoryReport): boolean { return report.missing.length > 0 || report.orphan_anchor.length > 0 || report.candidate.length > 0 || report.overlap_ambiguous.length > 0; }
