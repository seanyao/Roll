/**
 * @responsibility Gathers and renders the `roll doctor language` check.
 */
/**
 * US-LANG-002 — `roll doctor language` gatherer and renderer.
 *
 * Walks the active convention / skill / guide surface, runs the pure
 * {@link auditLanguageSurfaceText} rules from `@roll/core`, and renders the
 * findings in the resolved locale.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { auditLanguageSurfaceText, type LanguageAuditFinding } from "@roll/core";
import { t, v3Catalog, type Lang } from "@roll/spec";

export interface LanguageDoctorOptions {
  /** Project root to audit. */
  root: string;
  /** Also scan generated evidence / historical archive trees (`.roll`, `archive`). */
  includeGenerated?: boolean;
}

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".pnpm-store",
  ".claude",
  ".cursor",
  "__snapshots__",
  ".github",
]);

function isMarkdownFile(name: string): boolean {
  return name.endsWith(".md");
}

function walkMarkdownFiles(dir: string, out: string[], includeGenerated: boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (!includeGenerated && (entry.name === ".roll" || entry.name === "archive")) continue;
      walkMarkdownFiles(resolve(dir, entry.name), out, includeGenerated);
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      out.push(resolve(dir, entry.name));
    }
  }
}

function defaultScanRoots(root: string, includeGenerated: boolean): string[] {
  const roots: string[] = [];
  for (const rel of ["AGENTS.md", "roll.md", "conventions", "skills", "guide"]) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    roots.push(abs);
  }
  if (includeGenerated) {
    for (const rel of [".roll", "archive"]) {
      const abs = resolve(root, rel);
      if (existsSync(abs)) roots.push(abs);
    }
  }
  return roots;
}

/** Collect findings across the default active surfaces under `root`. */
export function collectLanguageDoctorFindings(options: LanguageDoctorOptions): LanguageAuditFinding[] {
  const { root, includeGenerated = false } = options;
  const roots = defaultScanRoots(root, includeGenerated);
  const files: string[] = [];
  for (const abs of roots) {
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkMarkdownFiles(abs, files, includeGenerated);
    } else if (st.isFile() && isMarkdownFile(abs)) {
      files.push(abs);
    }
  }

  const findings: LanguageAuditFinding[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file);
    for (const finding of auditLanguageSurfaceText(rel, text)) {
      findings.push(finding);
    }
  }
  return findings;
}

/** Render the language audit section in a single language (`lang`). */
export function renderLanguageDoctorSection(findings: readonly LanguageAuditFinding[], lang: Lang): string[] {
  const lines: string[] = [
    "",
    t(v3Catalog, lang, "doctor.language_audit_title"),
    "",
  ];
  if (findings.length === 0) {
    lines.push(`  ✓ ${t(v3Catalog, lang, "doctor.language_audit_ok")}`);
    lines.push("");
    return lines;
  }
  for (const f of findings) {
    const marker = f.severity === "fail" ? "✗" : "⚠";
    lines.push(`  ${marker} ${f.path}:${f.line} [${f.surface}] ${f.message}`);
  }
  lines.push("");
  lines.push(`  ${findings.length} ${t(v3Catalog, lang, "doctor.language_audit_findings_count")}`);
  lines.push("");
  return lines;
}
