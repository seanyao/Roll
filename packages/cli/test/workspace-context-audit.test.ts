import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSISTENCY_DIMENSIONS } from "@roll/core";
import {
  auditWorkspaceContextTree,
  auditRegisteredWorkspaceContextTree,
  renderWorkspaceContextAuditHuman,
  renderWorkspaceContextAuditJson,
  type WorkspaceContextAuditInput,
} from "../src/lib/workspace-context-audit.js";
import { buildConsistencyReport, checkWorkspaceContextAudit } from "../src/lib/release-consistency.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-context-audit-"));
  roots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

function input(rootDir: string, overrides: Partial<WorkspaceContextAuditInput> = {}): WorkspaceContextAuditInput {
  return {
    rootDir,
    now: "2026-07-25",
    policies: [
      {
        surface: "cli",
        id: "backlog",
        operation: "read",
        scope: "workspace_required_read",
        allowsAmbientCwd: false,
        allowsLegacyRollPath: false,
      },
      {
        surface: "tool",
        id: "bash",
        operation: "bash",
        scope: "repository_required",
        allowsAmbientCwd: false,
        allowsLegacyRollPath: false,
      },
      {
        surface: "skill",
        id: "roll-onboard",
        operation: "diagnose",
        scope: "legacy_migration_only",
        allowsAmbientCwd: true,
        allowsLegacyRollPath: true,
        rationale: "Inspects an explicitly selected legacy project.",
      },
    ],
    surfaces: [
      { policyKey: "cli:backlog:read", file: "packages/cli/src/commands/backlog.ts" },
      { policyKey: "tool:bash:bash", file: "packages/infra/src/tools/bash.ts" },
      { policyKey: "skill:roll-onboard:diagnose", file: "skills/roll-onboard/SKILL.md" },
    ],
    allowlist: [],
    ...overrides,
  };
}

describe("US-WS-039 Workspace context static audit", () => {
  it("passes the registered product, skill, and tool tree after governed exceptions", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const report = auditRegisteredWorkspaceContextTree(repoRoot, "2026-07-25");
    expect(report.summary).toEqual({ violations: 0, scannedSurfaces: 253, allowlisted: 1 });
  });

  it("rejects ambient authority, manual cwd/.roll paths, skill authority, parser bypass, and tool fallback", () => {
    const rootDir = fixture({
      "packages/cli/src/commands/backlog.ts": [
        "const project = join(process.cwd(), '.roll', 'backlog.md');",
        "const ws = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : undefined;",
      ].join("\n"),
      "packages/infra/src/tools/bash.ts": "const cwd = context?.cwd ?? process.cwd();\n",
      "skills/roll-onboard/SKILL.md": "Use `$PWD/.roll/backlog.md` as the project authority.\n",
    });

    const report = auditWorkspaceContextTree(input(rootDir));
    expect(report.summary.violations).toBe(5);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "CLI_SELECTOR_PARSER_BYPASS",
      "MANUAL_CWD_ROLL_AUTHORITY",
      "SKILL_AMBIENT_AUTHORITY",
      "TOOL_MISSING_CONTEXT_FALLBACK",
      "WORKSPACE_AUTHORITY_FROM_CWD",
    ]);
  });

  it("does not flag comments, tests, generated/vendor trees, or explicit execution cwd", () => {
    const rootDir = fixture({
      "packages/cli/src/commands/backlog.ts": [
        "// legacy example: join(process.cwd(), '.roll')",
        "export function run(command: string, executionCwd: string) {",
        "  return spawnSync(command, { cwd: executionCwd });",
        "}",
      ].join("\n"),
      "packages/cli/test/example.test.ts": "expect(\"process.cwd()/.roll\").toContain('.roll');\n",
      "packages/cli/dist/generated.js": "join(process.cwd(), '.roll');\n",
      "vendor/copied.ts": "join(process.cwd(), '.roll');\n",
      "packages/infra/src/tools/bash.ts": "if (!context) return missingExecutionContext();\nspawn(cmd, { cwd: context.repositoryCwd });\n",
      "skills/roll-onboard/SKILL.md": "Use the explicit `legacyProjectRoot`; cwd is never a selector.\n",
    });

    expect(auditWorkspaceContextTree(input(rootDir)).findings).toEqual([]);
  });

  it("detects split process.cwd data flow and an unregistered helper surface", () => {
    const rootDir = fixture({
      "packages/cli/src/commands/backlog.ts": "const cwd = process.cwd();\nconst evidence = join(cwd, '.roll', 'evidence');\n",
      "packages/infra/src/tools/bash.ts": "if (!context) return missingExecutionContext();\n",
      "skills/roll-onboard/SKILL.md": "Use the explicit legacy project root.\n",
      "packages/cli/src/lib/future-helper.ts": "join(process.cwd(), '.roll', 'backlog.md');\n",
    });
    const report = auditWorkspaceContextTree(input(rootDir, {
      surfaces: [
        ...input(rootDir).surfaces,
        { policyKey: "cli:future:read", file: "packages/cli/src/lib/future-helper.ts" },
      ],
    }));
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "MANUAL_CWD_ROLL_AUTHORITY",
      "UNREGISTERED_SURFACE",
      "WORKSPACE_AUTHORITY_FROM_CWD",
    ]);
  });

  it("follows registered .js ESM imports to TypeScript helpers and audits selector bypass in production mode", () => {
    const policy = { ...input("unused").policies[0], contextConsumer: "workspace" as const };
    const rootDir = fixture({
      "docs/generated/workspace-context-compatibility-matrix.json": `${JSON.stringify({ rows: [policy] })}\n`,
      "config/workspace-context-audit-allowlist.json": "[]\n",
      "packages/cli/src/commands/backlog.ts": "import '../lib/helper.js';\nconst selected = args.includes('--workspace');\n",
      "packages/cli/src/lib/helper.ts": "const workspaceRoot = process.cwd();\njoin(workspaceRoot, '.roll', 'backlog.md');\n",
    });
    const report = auditRegisteredWorkspaceContextTree(rootDir, "2026-07-25");
    expect(report.summary.scannedSurfaces).toBe(2);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "CLI_SELECTOR_PARSER_BYPASS",
      "MANUAL_CWD_ROLL_AUTHORITY",
      "WORKSPACE_AUTHORITY_FROM_CWD",
      "WORKSPACE_AUTHORITY_FROM_CWD",
    ]);
  });

  it("does not let comments or unused boundary-shaped variables hide selector parser bypass", () => {
    const policy = { ...input("unused").policies[0], contextConsumer: "workspace" as const };
    const rootDir = fixture({
      "docs/generated/workspace-context-compatibility-matrix.json": `${JSON.stringify({ rows: [policy] })}\n`,
      "config/workspace-context-audit-allowlist.json": "[]\n",
      "packages/cli/src/commands/backlog.ts": [
        "// parseWorkspaceSelectorArgs is not actually called",
        "const parseWorkspaceSelectorArgs = undefined;",
        "const selected = args.includes('--workspace');",
      ].join("\n"),
    });
    expect(auditRegisteredWorkspaceContextTree(rootDir, "2026-07-25").findings.map((finding) => finding.code)).toEqual([
      "CLI_SELECTOR_PARSER_BYPASS",
    ]);
  });

  it("does not trust local name collisions, unrelated receiver methods, or called child helpers", () => {
    const policy = { ...input("unused").policies[0], contextConsumer: "workspace" as const };
    for (const source of [
      "function parseWorkspaceSelectorArgs() {}\nparseWorkspaceSelectorArgs();\nargs.includes('--workspace');\n",
      "helper.resolveTarget();\nargs.includes('--workspace');\n",
      "function child(args) { return args.includes('--workspace'); }\nfunction contextCommand(args) { child(args); }\ncontextCommand(args);\n",
    ]) {
      const rootDir = fixture({
        "docs/generated/workspace-context-compatibility-matrix.json": `${JSON.stringify({ rows: [policy] })}\n`,
        "config/workspace-context-audit-allowlist.json": "[]\n",
        "packages/cli/src/commands/backlog.ts": source,
      });
      expect(auditRegisteredWorkspaceContextTree(rootDir, "2026-07-25").findings.map((finding) => finding.code)).toContain("CLI_SELECTOR_PARSER_BYPASS");
    }
  });

  it("does not trust shadowed imports, parser calls on unrelated input, or same-name methods", () => {
    const policy = { ...input("unused").policies[0], contextConsumer: "workspace" as const };
    for (const source of [
      [
        "import { parseWorkspaceInteractionArgs } from '../lib/workspace-interaction.js';",
        "function run(args) {",
        "  const parseWorkspaceInteractionArgs = () => null;",
        "  parseWorkspaceInteractionArgs();",
        "  return args.includes('--workspace');",
        "}",
      ].join("\n"),
      [
        "import { parseWorkspaceInteractionArgs } from '../lib/workspace-interaction.js';",
        "function run(args) {",
        "  parseWorkspaceInteractionArgs([], caps);",
        "  return args.includes('--workspace');",
        "}",
      ].join("\n"),
      [
        "const helper = { positionalArgs(args) { return args.includes('--workspace'); } };",
        "helper.positionalArgs(args);",
      ].join("\n"),
      [
        "function positionalArgs(args) { return args.includes('--workspace'); }",
        "positionalArgs(args);",
      ].join("\n"),
      [
        "function positionalArgs(args: readonly string[]): boolean { return args.includes('--workspace'); }",
        "positionalArgs(args);",
      ].join("\n"),
    ]) {
      const rootDir = fixture({
        "docs/generated/workspace-context-compatibility-matrix.json": `${JSON.stringify({ rows: [policy] })}\n`,
        "config/workspace-context-audit-allowlist.json": "[]\n",
        "packages/cli/src/commands/backlog.ts": source,
      });
      expect(auditRegisteredWorkspaceContextTree(rootDir, "2026-07-25").findings.map((finding) => finding.code)).toContain("CLI_SELECTOR_PARSER_BYPASS");
    }
  });

  it("detects selector literal aliases, receiver collections, and switch cases", () => {
    const policy = { ...input("unused").policies[0], contextConsumer: "workspace" as const };
    for (const source of [
      [
        "const selector = '--workspace' as const;",
        "export function run(args: readonly string[]): boolean { return args.includes(selector); }",
      ].join("\n"),
      "export function run(arg: string): boolean { return ['--workspace'].includes(arg); }\n",
      [
        "export function run(arg: string): boolean {",
        "  switch (arg) { case '--workspace': return true; default: return false; }",
        "}",
      ].join("\n"),
      "const selectors = new Set(['--workspace']);\nexport function run(arg: string): boolean { return selectors.has(arg); }\n",
      "const selectors = { '--workspace': true };\nexport function run(arg: string): boolean { return selectors[arg] === true; }\n",
      "const selector = '--' + 'workspace';\nexport function run(args: readonly string[]): boolean { return args.includes(selector); }\n",
      "export function run(arg: string): boolean { return /--workspace/u.test(arg); }\n",
      "const selector = `--${'workspace'}`;\nexport function run(args: readonly string[]): boolean { return args.includes(selector); }\n",
      "import { CANONICAL_WORKSPACE_SELECTOR as selector } from '../lib/workspace-selector.js';\nexport function run(args: readonly string[]): boolean { return args.includes(selector); }\n",
      "export function run(args: readonly string[]): boolean { return args['includes']('--workspace'); }\n",
      "export function run(arg: string): boolean { return Object.is(arg, '--workspace'); }\n",
      "export function run(args: readonly string[], selector = '--workspace'): boolean { return args.includes(selector); }\n",
      "function selector(): string { return '--workspace'; }\nexport function run(args: readonly string[]): boolean { return args.includes(selector()); }\n",
    ]) {
      const rootDir = fixture({
        "docs/generated/workspace-context-compatibility-matrix.json": `${JSON.stringify({ rows: [policy] })}\n`,
        "config/workspace-context-audit-allowlist.json": "[]\n",
        "packages/cli/src/commands/backlog.ts": source,
      });
      expect(auditRegisteredWorkspaceContextTree(rootDir, "2026-07-25").findings.map((finding) => finding.code)).toContain("CLI_SELECTOR_PARSER_BYPASS");
    }
  });

  it("audits repository-required split cwd authority while allowing explicit execution config", () => {
    const repositoryPolicy = { ...input("unused").policies[1], surface: "cli" as const, id: "test", operation: "run", contextConsumer: "repository" as const };
    const rootDir = fixture({
      "packages/cli/src/commands/test.ts": [
        "const cwd = process.cwd();",
        "const evidence = join(cwd, '.roll', 'evidence');",
        "const executionConfig = join(cwd, '.roll', 'local.yaml');",
      ].join("\n"),
    });
    const report = auditWorkspaceContextTree(input(rootDir, {
      policies: [repositoryPolicy],
      surfaces: [{ policyKey: "cli:test:run", file: "packages/cli/src/commands/test.ts" }],
    }));
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "MANUAL_CWD_ROLL_AUTHORITY",
      "WORKSPACE_AUTHORITY_FROM_CWD",
    ]);
  });

  it("does not let a nested evidence path borrow the exact local.yaml execution-config exception", () => {
    const repositoryPolicy = { ...input("unused").policies[1], surface: "cli" as const, id: "test", operation: "run", contextConsumer: "repository" as const };
    const rootDir = fixture({
      "packages/cli/src/commands/test.ts": "const cwd = process.cwd();\njoin(cwd, '.roll', 'evidence', 'local.yaml');\n",
    });
    expect(auditWorkspaceContextTree(input(rootDir, {
      policies: [repositoryPolicy],
      surfaces: [{ policyKey: "cli:test:run", file: "packages/cli/src/commands/test.ts" }],
    })).findings.map((finding) => finding.code)).toEqual([
      "MANUAL_CWD_ROLL_AUTHORITY",
      "WORKSPACE_AUTHORITY_FROM_CWD",
    ]);
  });

  it("fails closed for unknown, expired, and unused allowlist entries", () => {
    const rootDir = fixture({
      "packages/cli/src/commands/backlog.ts": "const root = join(process.cwd(), '.roll');\n",
      "packages/infra/src/tools/bash.ts": "if (!context) return missingExecutionContext();\n",
      "skills/roll-onboard/SKILL.md": "Use the explicit legacy project root.\n",
    });
    const base = {
      violationCode: "MANUAL_CWD_ROLL_AUTHORITY" as const,
      file: "packages/cli/src/commands/backlog.ts",
      line: 1,
      rationale: "Temporary migration boundary.",
      ownerStory: "US-WS-039",
      expiresOn: "2026-08-01",
    };

    expect(auditWorkspaceContextTree(input(rootDir, {
      allowlist: [{ ...base, policyKey: "cli:missing:read" }],
    })).findings.map((finding) => finding.code)).toContain("ALLOWLIST_UNKNOWN_POLICY");
    expect(auditWorkspaceContextTree(input(rootDir, {
      allowlist: [{ ...base, policyKey: "cli:backlog:read" }],
    })).findings.map((finding) => finding.code)).toContain("ALLOWLIST_INVALID");
    const machineInput: WorkspaceContextAuditInput = {
      ...input(rootDir),
      policies: [{ surface: "cli", id: "help", operation: "read", scope: "machine_only", allowsAmbientCwd: false, allowsLegacyRollPath: false }],
      surfaces: [{ policyKey: "cli:help:read", file: "packages/cli/src/commands/backlog.ts" }],
      allowlist: [],
    };
    expect(auditWorkspaceContextTree({
      ...machineInput,
      allowlist: [{ ...base, policyKey: "cli:help:read", expiresOn: "2026-07-24" }],
    }).findings.map((finding) => finding.code)).toContain("ALLOWLIST_EXPIRED");
    expect(auditWorkspaceContextTree({
      ...machineInput,
      allowlist: [{ ...base, policyKey: "cli:help:read", line: 99 }],
    }).findings.map((finding) => finding.code)).toContain("ALLOWLIST_UNUSED");
  });

  it("wires the real static report into the release consistency gate", () => {
    const rootDir = fixture({
      "docs/generated/workspace-context-compatibility-matrix.json": `${JSON.stringify({ rows: [{ ...input("unused").policies[0], contextConsumer: "workspace" }] })}\n`,
      "config/workspace-context-audit-allowlist.json": "[]\n",
      "packages/cli/src/commands/backlog.ts": "export const clean = true;\n",
    });
    expect(checkWorkspaceContextAudit(rootDir)).toEqual({ status: "pass", gaps: [] });
    writeFileSync(join(rootDir, "packages/cli/src/commands/backlog.ts"), "join(process.cwd(), '.roll', 'backlog.md');\n");
    expect(checkWorkspaceContextAudit(rootDir)).toMatchObject({ status: "fail", gaps: [expect.stringContaining("2 violation(s)")] });
    const passChecks = Object.fromEntries(CONSISTENCY_DIMENSIONS.map((dimension) => [dimension, () => ({ status: "pass" as const, gaps: [] })])) as Parameters<typeof buildConsistencyReport>[1];
    expect(buildConsistencyReport(rootDir, passChecks)).toMatchObject({
      overall: "fail",
      dimensions: { tests: { status: "fail", gaps: [expect.stringContaining("Workspace context audit reports")] } },
    });
  });

  it("renders byte-stable JSON and deterministic human groups", () => {
    const rootDir = fixture({
      "packages/cli/src/commands/backlog.ts": "const root = join(process.cwd(), '.roll');\n",
      "packages/infra/src/tools/bash.ts": "const cwd = context?.cwd ?? process.cwd();\n",
      "skills/roll-onboard/SKILL.md": "Use the explicit legacy project root.\n",
    });
    const report = auditWorkspaceContextTree(input(rootDir));

    expect(renderWorkspaceContextAuditJson(report)).toBe(renderWorkspaceContextAuditJson(report));
    expect(renderWorkspaceContextAuditHuman(report)).toMatchInlineSnapshot(`
      "Workspace context audit: FAIL (3 violations)
      CLI backlog/read
        packages/cli/src/commands/backlog.ts:1 MANUAL_CWD_ROLL_AUTHORITY
        packages/cli/src/commands/backlog.ts:1 WORKSPACE_AUTHORITY_FROM_CWD
      TOOL bash/bash
        packages/infra/src/tools/bash.ts:1 TOOL_MISSING_CONTEXT_FALLBACK"
    `);
  });
});
