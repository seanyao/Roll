/**
 * @responsibility Audits the skills catalog against the one yardstick.
 */
/**
 * US-DOSSIER-032 — the ONE skills-audit yardstick, ported to TS so it ships
 * inside `@roll/cli` as a pinned, version-controlled dependency. This is the
 * single source consumed by:
 *   - the machine-global Skills page (`page-skills.ts`) at generate time, and
 *   - `roll skills audit` (and the canonical `scripts/audit-skills.mjs` wrapper),
 *   - the legacy in-console Skills tab (`skills-panel.ts`).
 *
 * Every surface reads the SAME computation, so skills · violations · hub lines
 * match everywhere (four common principles: one yardstick across surfaces). The
 * audit emits `--strict --json` identically to the historical
 * `skills/scripts/audit-skills.mjs`, which this port supersedes.
 *
 * Determinism: pure fs reads of a fixed `skills/` tree, lexicographic skill
 * order, stable field ordering. No clock, no randomness.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SkillAuditRouteCoverage {
  positiveCount: number;
  negativeCount: number;
  hasMinimumCoverage: boolean;
}

export interface SkillAuditEntry {
  name: string;
  file: string;
  frontmatterOk: boolean;
  lines: number;
  description: string;
  descriptionWordCount: number;
  descriptionLoadTrigger: boolean;
  hasWhenNotToUse: boolean;
  hasGotchas: boolean;
  hasReviewedWaiver: boolean;
  auxiliaryDirs: string[];
  spokeFiles: string[];
  referencedSpokes: string[];
  missingSpokeRefs: string[];
  unreferencedSpokes: string[];
  deadBashRefs: string[];
  routeCoverage: SkillAuditRouteCoverage;
  violations: string[];
}

export interface SkillAuditSummary {
  skills: number;
  violations: number;
  over250: number;
  withGotchas: number;
  loadTriggerDescriptions: number;
  withAuxiliaryFiles: number;
}

export interface SkillAuditReport {
  summary: SkillAuditSummary;
  skills: SkillAuditEntry[];
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
  ok: boolean;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse the leading `---`-delimited YAML frontmatter (scalar + block scalars). */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith("---\n")) return { fields: {}, body: text, ok: false };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fields: {}, body: text, ok: false };
  const raw = text.slice(4, end);
  const bodyStart = text.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1);
  const fields: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const blockMatch = line.match(/^([A-Za-z0-9_.-]+):\s*\|\s*$/);
    if (blockMatch) {
      const key = blockMatch[1] ?? "";
      const blockLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (/^\S[^:]*:/.test(next)) {
          index -= 1;
          break;
        }
        blockLines.push(next.replace(/^ {0,2}/, ""));
        index += 1;
      }
      fields[key] = blockLines.join("\n").trim();
      continue;
    }
    const scalarMatch = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (scalarMatch) fields[scalarMatch[1] ?? ""] = stripYamlQuotes(scalarMatch[2] ?? "");
  }
  return { fields, body, ok: true };
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full);
    if (entry.isFile()) return [full];
    return [];
  });
}

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

const SPOKE_DIRS = ["references", "assets", "scripts"] as const;

function collectSpokeFiles(skillDir: string): string[] {
  return SPOKE_DIRS.flatMap((dirName) =>
    walkFiles(join(skillDir, dirName)).map((file) => toPosix(relative(skillDir, file))),
  );
}

/** Detect retired v2 bash invocation patterns that cannot work in v3.
 *  - `source "$(command -v roll)"` — v3 `roll` is a TS binary, not sourceable.
 *  - `_loop_*` function names — the bash loop engine is retired; any skill
 *    contract still instructing agents to call them is a "Done-but-broken"
 *    reference (FIX-364).
 */
export function findDeadBashRefs(text: string): string[] {
  const refs: string[] = [];
  if (/source\s+"?\$\(command -v roll\)"?/.test(text)) {
    refs.push("source-roll");
  }
  // Lines that explicitly mention a "retired" helper are documentation notes
  // telling agents *not* to call them; skip those matches.
  for (const line of text.split(/\r?\n/)) {
    if (/retired/i.test(line)) continue;
    for (const match of line.matchAll(/_loop_[A-Za-z0-9_]+/g)) {
      const name = match[0];
      if (name !== undefined && !refs.includes(name)) refs.push(name);
    }
  }
  return refs.sort();
}

/** Scan every markdown file under a skill directory for dead bash references. */
function collectDeadBashRefs(skillDir: string): string[] {
  const all = new Set<string>();
  for (const file of walkFiles(skillDir).filter((f) => f.endsWith(".md"))) {
    try {
      const text = readFileSync(file, "utf8");
      for (const ref of findDeadBashRefs(text)) all.add(ref);
    } catch {
      /* ignore unreadable */
    }
  }
  return [...all].sort();
}

function collectReferencedSpokes(body: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\]\(((?:references|assets|scripts)\/[^)#\s]+)(?:#[^)]+)?\)/g,
    /`((?:references|assets|scripts)\/[^`#]+)(?:#[^`]*)?`/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      if (match[1] !== undefined) refs.add(match[1].replace(/^\.\//, ""));
    }
  }
  return [...refs].sort();
}

export function parseSkillFile(file: string): Omit<SkillAuditEntry, "routeCoverage" | "violations"> {
  const text = readFileSync(file, "utf8");
  const { fields, body, ok } = parseFrontmatter(text);
  const skillDir = join(file, "..");
  const description = fields["description"] ?? "";
  const spokeFiles = collectSpokeFiles(skillDir);
  const referencedSpokes = collectReferencedSpokes(body);
  const deadBashRefs = collectDeadBashRefs(skillDir);
  return {
    name: fields["name"] ?? skillDir.split(sep).pop() ?? file,
    file,
    frontmatterOk: ok,
    lines: text.replace(/\s+$/, "").split(/\r?\n/).length,
    description,
    descriptionWordCount: wordCount(description),
    descriptionLoadTrigger: /^Load when\b/i.test(description),
    hasWhenNotToUse: /^##\s+When Not to Use\b/im.test(body),
    hasGotchas: /^##\s+(Gotchas|Known Failure Modes)\b/im.test(body),
    hasReviewedWaiver: /Reviewed Waiver:/i.test(body),
    auxiliaryDirs: SPOKE_DIRS.filter((dirName) => existsSync(join(skillDir, dirName))),
    spokeFiles,
    referencedSpokes,
    missingSpokeRefs: referencedSpokes.filter((ref) => !spokeFiles.includes(ref)),
    unreferencedSpokes: spokeFiles.filter((filePath) => !referencedSpokes.includes(filePath)),
    deadBashRefs,
  };
}

export function findSkillFiles(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsDir, entry.name, "SKILL.md"))
    .filter((file) => existsSync(file))
    .sort();
}

interface RouteCasesFile {
  skills?: Record<string, { positive?: unknown; negative?: unknown }>;
}

export function loadRouteCases(routeFile: string): RouteCasesFile {
  if (!existsSync(routeFile)) return { skills: {} };
  try {
    return JSON.parse(readFileSync(routeFile, "utf8")) as RouteCasesFile;
  } catch {
    return { skills: {} };
  }
}

function routeCoverageFor(skillName: string, routes: RouteCasesFile): SkillAuditRouteCoverage {
  const entry = routes.skills?.[skillName] ?? {};
  const positive = Array.isArray(entry.positive) ? entry.positive.length : 0;
  const negative = Array.isArray(entry.negative) ? entry.negative.length : 0;
  return { positiveCount: positive, negativeCount: negative, hasMinimumCoverage: positive >= 2 && negative >= 2 };
}

function violationsFor(
  skill: Omit<SkillAuditEntry, "routeCoverage" | "violations">,
  route: SkillAuditRouteCoverage,
): string[] {
  const violations: string[] = [];
  if (!skill.frontmatterOk) violations.push("frontmatter-missing-or-invalid");
  if (!skill.descriptionLoadTrigger) violations.push("description-not-load-trigger");
  if (skill.descriptionWordCount > 50) violations.push("description-over-50-words");
  if (!route.hasMinimumCoverage) violations.push("route-fixture-coverage-missing");
  if (!skill.hasGotchas) violations.push("gotchas-missing");
  if (skill.lines > 250 && !skill.hasReviewedWaiver) violations.push("hub-over-250-lines");
  for (const missing of skill.missingSpokeRefs) violations.push(`missing-spoke-ref:${missing}`);
  for (const extra of skill.unreferencedSpokes) violations.push(`unreferenced-spoke:${extra}`);
  for (const ref of skill.deadBashRefs) violations.push(`dead-bash-ref:${ref}`);
  return violations;
}

export interface AuditSkillsOptions {
  skillsDir: string;
  routeFile?: string;
}

/** The audit. Reads `skillsDir/<name>/SKILL.md` from disk; the directory is the
 *  catalog (drift-proof). `routeFile` defaults to `<skillsDir>/route-cases/skills.json`. */
export function auditSkills(options: AuditSkillsOptions): SkillAuditReport {
  const routeFile = options.routeFile ?? join(options.skillsDir, "route-cases", "skills.json");
  const routes = loadRouteCases(routeFile);
  const skills: SkillAuditEntry[] = findSkillFiles(options.skillsDir).map((file) => {
    const parsed = parseSkillFile(file);
    const routeCoverage = routeCoverageFor(parsed.name, routes);
    return { ...parsed, routeCoverage, violations: violationsFor(parsed, routeCoverage) };
  });
  const summary: SkillAuditSummary = {
    skills: skills.length,
    violations: skills.reduce((count, skill) => count + skill.violations.length, 0),
    over250: skills.filter((skill) => skill.lines > 250).length,
    withGotchas: skills.filter((skill) => skill.hasGotchas).length,
    loadTriggerDescriptions: skills.filter((skill) => skill.descriptionLoadTrigger).length,
    withAuxiliaryFiles: skills.filter((skill) => skill.spokeFiles.length > 0).length,
  };
  return { summary, skills };
}

/** The human report `roll skills audit` prints (no `--json`); byte-stable for snapshots. */
export function formatHumanReport(report: SkillAuditReport): string {
  const out: string[] = [];
  out.push(`Skill audit: ${report.summary.skills} skills`);
  out.push(`Load-trigger descriptions: ${report.summary.loadTriggerDescriptions}/${report.summary.skills}`);
  out.push(`Gotchas coverage: ${report.summary.withGotchas}/${report.summary.skills}`);
  out.push(`Skills over 250 lines: ${report.summary.over250}`);
  out.push(`Skills with auxiliary files: ${report.summary.withAuxiliaryFiles}`);
  out.push(`Violations: ${report.summary.violations}`);
  for (const skill of report.skills) {
    const markers: string[] = [
      `${skill.lines} lines`,
      `${skill.descriptionWordCount} desc words`,
      `${skill.routeCoverage.positiveCount}+/${skill.routeCoverage.negativeCount}- route cases`,
    ];
    if (skill.spokeFiles.length > 0) markers.push(`${skill.spokeFiles.length} spokes`);
    const status = skill.violations.length === 0 ? "ok" : skill.violations.join(", ");
    out.push(`- ${skill.name}: ${status} (${markers.join("; ")})`);
  }
  return out.join("\n") + "\n";
}
