import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditWorkspaceContextTree,
  renderWorkspaceContextAuditHuman,
  renderWorkspaceContextAuditJson,
  type WorkspaceContextAuditInput,
} from "../src/lib/workspace-context-audit.js";

const roots: string[] = [];

afterEach(() => {
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
  it("rejects ambient authority, manual cwd/.roll paths, skill authority, parser bypass, and tool fallback", () => {
    const rootDir = fixture({
      "packages/cli/src/commands/backlog.ts": [
        "const project = join(process.cwd(), '.roll', 'backlog.md');",
        "const ws = args.includes('--ws') ? args[args.indexOf('--ws') + 1] : undefined;",
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
      allowlist: [{ ...base, policyKey: "cli:backlog:read", expiresOn: "2026-07-24" }],
    })).findings.map((finding) => finding.code)).toContain("ALLOWLIST_EXPIRED");
    expect(auditWorkspaceContextTree(input(rootDir, {
      allowlist: [{ ...base, policyKey: "cli:backlog:read", line: 99 }],
    })).findings.map((finding) => finding.code)).toContain("ALLOWLIST_UNUSED");
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
