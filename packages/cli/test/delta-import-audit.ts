/**
 * US-DELTA-003 — Unified import closure audit helper (fail-closed, recursive).
 *
 * Resolves the full local relative import/reexport closure from a given entry
 * file (e.g. commands/index.ts), handling:
 *   - import "..." (side-effect)
 *   - export { ... } from "..."
 *   - export * from "..."
 *   - export * as name from "..."
 *   - .js → .ts mapping
 *   - directory/index.ts resolution
 *
 * Fail-closed: missing files, unresolvable local deps, dynamic import(), and
 * non-node: require() all throw. Designed for both real-source audits and
 * temporary fixture-based tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface AuditResult {
  /** All files traversed (absolute paths). */
  files: string[];
  /** Forbidden tokens found. */
  violations: Array<{ file: string; line: number; token: string }>;
}

export interface AuditOptions {
  /** Forbidden tokens to reject (case-sensitive substring in non-comment lines). */
  forbiddenTokens?: string[];
  /** If true, also reject dynamic import() calls (outside type annotations). */
  rejectDynamicImport?: boolean;
  /** If true, also reject non-node: require() calls. */
  rejectNonNodeRequire?: boolean;
}

/**
 * Recursively resolve the local relative import closure starting from `entryFile`.
 * Throws with a descriptive message on any fail-closed condition.
 */
export function auditImportClosure(entryFile: string, opts: AuditOptions = {}): AuditResult {
  const { forbiddenTokens = [], rejectDynamicImport = true, rejectNonNodeRequire = true } = opts;

  // FAIL-CLOSED: entry must exist
  if (!existsSync(entryFile)) {
    throw new Error(`Audit FAIL-CLOSED: entry file missing: ${entryFile}`);
  }

  const seen = new Set<string>();
  const violations: AuditResult["violations"] = [];
  const queue = [entryFile];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;

    // FAIL-CLOSED: file must exist
    if (!existsSync(current)) {
      throw new Error(`Audit FAIL-CLOSED: file not found during traversal: ${current}`);
    }
    seen.add(current);

    const content = readFileSync(current, "utf8");
    const dir = dirname(current);
    const lines = content.split("\n");

    // Check for forbidden tokens and dynamic import/require patterns
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      // Skip comment lines
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed === "*/" || trimmed === "*") continue;

      for (const token of forbiddenTokens) {
        if (trimmed.includes(token)) {
          violations.push({ file: current, line: i + 1, token });
        }
      }

      // Dynamic import() — reject unless it's a type annotation (`as import(...)`, `typeof import(...)`, `: import(`)
      if (rejectDynamicImport && /\bimport\s*\(/.test(trimmed)) {
        if (!/\b(as|typeof)\s+import\s*\(/.test(trimmed) && !/:\s*import\s*\(/.test(trimmed)) {
          throw new Error(
            `Audit FAIL-CLOSED: ${current}:${i + 1} contains dynamic import(): ${trimmed.slice(0, 120)}`,
          );
        }
      }

      // Non-node: require() — reject
      if (rejectNonNodeRequire && /\brequire\s*\(/.test(trimmed) && !trimmed.includes("node:")) {
        throw new Error(
          `Audit FAIL-CLOSED: ${current}:${i + 1} contains non-node require(): ${trimmed.slice(0, 120)}`,
        );
      }
    }

    // Parse local relative imports and re-exports
    // Patterns:
    //   import "..."              — side-effect import
    //   import ... from "..."     — named/default/namespace import
    //   export { ... } from "..." — named re-export
    //   export * from "..."       — wildcard re-export (no alias)
    //   export * as name from "..." — wildcard aliased re-export
    const importRe = /(?:from\s+["']|import\s+["'])(\.[^"']+)["']/g;
    const namedExportRe = /export\s+\{[^}]*\}\s+from\s+["'](\.[^"']+)["']/g;
    const starExportRe = /export\s+\*\s+from\s+["'](\.[^"']+)["']/g;
    const starAsExportRe = /export\s+\*\s+as\s+\w+\s+from\s+["'](\.[^"']+)["']/g;

    const localImports = new Set<string>();

    const collectFromRegex = (re: RegExp, source: string) => {
      let match;
      while ((match = re.exec(source)) !== null) {
        localImports.add(match[1]!);
      }
    };

    collectFromRegex(importRe, content);
    collectFromRegex(namedExportRe, content);
    collectFromRegex(starExportRe, content);
    collectFromRegex(starAsExportRe, content);

    for (const relPath of localImports) {
      // Only follow into cli/src or fixture paths (not node_modules, not ../../packages)
      const inScope = current.includes("/cli/src/") || current.includes("/cli/test/fixtures/");

      if (relPath.startsWith(".") && inScope) {
        const resolved = resolveRelative(dir, relPath);
        if (!seen.has(resolved)) queue.push(resolved);
      }
    }
  }

  return { files: Array.from(seen).sort(), violations };
}

/**
 * Resolve a relative import path to an absolute .ts file.
 * Tries: .ts direct, .js→.ts, directory/index.ts.
 * Throws if unresolvable.
 */
function resolveRelative(baseDir: string, relPath: string): string {
  // Try direct .ts
  const tsDirect = resolve(baseDir, relPath.replace(/\.js$/, ".ts"));
  if (existsSync(tsDirect)) return tsDirect;

  // Try directory/index.ts
  const indexCandidate = resolve(baseDir, relPath.replace(/\.js$/, ""), "index.ts");
  if (existsSync(indexCandidate)) return indexCandidate;

  throw new Error(
    `Audit FAIL-CLOSED: cannot resolve local import "${relPath}" from ${baseDir}`,
  );
}
