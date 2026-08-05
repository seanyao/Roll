#!/usr/bin/env node
/**
 * US-RULE-001 — CI audit for the rules registry (`policy/rules.yaml`).
 *
 * Bidirectional check, both directions rooted at the registry, never at a
 * fixture:
 *   (forward)  every rule's enforcement.point exists and contains its marker;
 *              every verification.test exists, contains its marker, AND its
 *              path is one vitest would actually discover (matches the
 *              default test glob and isn't excluded by the root vitest
 *              config) — a test that vitest never runs cannot prove aliveness.
 *   (reverse)  every `RL-<KIND>-<NNN>` marker found in source outside
 *              `policy/rules.yaml` itself and test paths must resolve to a
 *              registered rule id — an unregistered marker is a red line with
 *              no declared owner.
 *
 * A registry with zero rules is rejected by the strict parser itself (empty
 * registry is not permitted), so "registered 0" can never print as success —
 * closing the "empty registry is vacuously green" hole.
 *
 * Usage: node scripts/audit-rules.mjs [--root DIR] [--json]
 * Exit codes: 0 = every registered rule verified alive, N unregistered
 * markers = 0; 1 = one or more audit findings; 2 = the audit itself failed
 * (registry missing/malformed, @roll/spec not built).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// The default vitest test glob (**/*.{test,spec}.?(c|m)[jt]s?(x)) plus the
// exclusions declared in the root vitest.config.ts — a verification.test path
// outside this set would never actually execute under `pnpm -r test`.
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "dist", ".git", ".pnpm", ".roll", "coverage"]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh", ".yaml", ".yml"]);
const RL_MARKER_PATTERN = /\bRL-[A-Z]+-\d{3}\b/g;

function parseArgs(argv) {
  const options = { root: repoRoot, json: false, inventory: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = path.resolve(argv[++i]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--inventory") options.inventory = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function loadParser() {
  const dist = path.join(repoRoot, "packages", "spec", "dist", "rules.js");
  if (!existsSync(dist)) {
    throw new Error("@roll/spec not built — run `pnpm -r build` first (canonical source: packages/spec/src/rules.ts)");
  }
  return import(pathToFileURL(dist).href);
}

async function loadInventorySpec() {
  const dist = path.join(repoRoot, "packages", "spec", "dist", "index.js");
  if (!existsSync(dist)) throw new Error("@roll/spec not built — run `pnpm -r build` first (canonical source: packages/spec/src/rules-inventory.ts)");
  return import(pathToFileURL(dist).href);
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isUnderRollLoopWorktree(relPath) {
  return relPath.startsWith(".roll/loop/worktrees/");
}

/** Would vitest's default include/exclude actually discover this test path? */
function isDiscoverableTestPath(relPath) {
  if (!TEST_FILE_PATTERN.test(relPath)) return false;
  if (relPath.endsWith(".live.test.ts")) return false;
  if (isUnderRollLoopWorktree(relPath)) return false;
  for (const segment of relPath.split("/")) {
    if (segment === "node_modules" || segment === "dist") return false;
  }
  return true;
}

/** A path the reverse marker scan must not treat as "loose source". */
function isTestOrRegistryPath(relPath) {
  if (relPath === "policy/rules.yaml") return true;
  if (TEST_FILE_PATTERN.test(relPath)) return true;
  return relPath.split("/").some((segment) => segment === "test" || segment === "tests" || segment === "__snapshots__");
}

function walk(root, dir, out) {
  if (!existsSync(dir)) return;
  const st = statSync(dir);
  if (st.isDirectory()) {
    const base = path.basename(dir);
    if (SKIP_DIR_SEGMENTS.has(base)) return;
    for (const entry of readdirSync(dir)) walk(root, path.join(dir, entry), out);
    return;
  }
  if (st.isFile() && SCAN_EXTENSIONS.has(path.extname(dir))) out.push(dir);
}

function forwardCheck(root, registry) {
  const findings = [];
  for (const rule of registry.rules) {
    for (const enforcement of rule.enforcement) {
      const full = path.join(root, enforcement.point);
      if (!existsSync(full) || !statSync(full).isFile()) {
        findings.push(`[${rule.id}] missing enforcement point: ${enforcement.point}`);
        continue;
      }
      const content = readFileSync(full, "utf8");
      if (!content.includes(enforcement.marker)) {
        findings.push(`[${rule.id}] enforcement point ${enforcement.point} does not contain marker "${enforcement.marker}"`);
      }
    }

    const { test, marker } = rule.verification;
    const fullTest = path.join(root, test);
    if (!existsSync(fullTest) || !statSync(fullTest).isFile()) {
      findings.push(`[${rule.id}] missing verification test file: ${test}`);
      continue;
    }
    if (!isDiscoverableTestPath(test)) {
      findings.push(`[${rule.id}] verification.test path is not discoverable by vitest (excluded or non-matching pattern): ${test}`);
    }
    const testContent = readFileSync(fullTest, "utf8");
    if (!testContent.includes(marker)) {
      findings.push(`[${rule.id}] verification test ${test} does not contain marker "${marker}"`);
    }
  }
  return findings;
}

function reverseCheck(root, registry) {
  const registeredIds = new Set(registry.rules.map((r) => r.id));
  const files = [];
  walk(root, root, files);
  const findings = [];
  for (const file of files.sort()) {
    const relPath = rel(root, file);
    if (isTestOrRegistryPath(relPath)) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const matches = line.match(RL_MARKER_PATTERN);
      if (!matches) return;
      for (const id of matches) {
        if (!registeredIds.has(id)) {
          findings.push(`${relPath}:${index + 1} unregistered marker: ${id}`);
        }
      }
    });
  }
  return findings;
}

async function runAudit(root) {
  const registryPath = path.join(root, "policy", "rules.yaml");
  if (!existsSync(registryPath)) {
    return { ok: false, findings: [`policy/rules.yaml not found at ${registryPath}`], registered: 0 };
  }
  const { parseRulesRegistry } = await loadParser();
  const text = readFileSync(registryPath, "utf8");
  const parsed = parseRulesRegistry(text);
  if (!parsed.ok) {
    return { ok: false, findings: [`policy/rules.yaml failed to parse: ${parsed.error.message}`], registered: 0 };
  }
  const registry = parsed.value;
  const findings = [...forwardCheck(root, registry), ...reverseCheck(root, registry)];
  return { ok: findings.length === 0, findings, registered: registry.rules.length };
}

function inventoryFs(root) {
  return {
    list(directory) {
      if (!existsSync(directory)) throw new Error(`inventory root does not exist: ${directory}`);
      return readdirSync(directory).map((name) => {
        const stat = lstatSync(path.join(directory, name));
        return { name, kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file" };
      });
    },
    read(file) { return readFileSync(file, "utf8"); },
    realpath(file) { return file; },
  };
}

async function runInventoryAudit(root) {
  const inventoryPath = path.join(root, "policy", "rules-inventory.yaml");
  const rulesPath = path.join(root, "policy", "rules.yaml");
  if (!existsSync(inventoryPath) || !existsSync(rulesPath)) throw new Error("policy/rules.yaml and policy/rules-inventory.yaml are required for --inventory");
  const { auditRulesInventory, inventoryReportFails, parseRulesInventory, parseRulesV2 } = await loadInventorySpec();
  const inventory = parseRulesInventory(readFileSync(inventoryPath, "utf8"));
  if (!inventory.ok) throw new Error(`policy/rules-inventory.yaml failed to parse: ${inventory.error.message}`);
  const rules = parseRulesV2(readFileSync(rulesPath, "utf8"));
  if (!rules.ok) throw new Error(`policy/rules.yaml must be v2 for --inventory: ${rules.error.message}`);
  const report = auditRulesInventory(inventory.value, rules.value, inventoryFs(root), root);
  return { report, ok: !inventoryReportFails(report) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.inventory) {
    const outcome = await runInventoryAudit(options.root);
    process.stdout.write(JSON.stringify(outcome.report, null, 2) + "\n");
    if (!outcome.ok) process.exitCode = 1;
    return;
  }
  const report = await runAudit(options.root);
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (report.ok) {
    process.stdout.write(
      `rules audit: ok — registered ${report.registered} (coverage expansion tracked separately; not a completeness claim)\n`,
    );
  } else {
    process.stderr.write(`rules audit: ${report.findings.length} finding(s)\n`);
    for (const finding of report.findings) process.stderr.write(`  ${finding}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write((error?.message ?? String(error)) + "\n");
  process.exitCode = 2;
}
