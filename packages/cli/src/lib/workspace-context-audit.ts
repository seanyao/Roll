import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { WorkspaceContextPolicy } from "@roll/spec";

export type WorkspaceContextViolationCode =
  | "ALLOWLIST_EXPIRED"
  | "ALLOWLIST_INVALID"
  | "ALLOWLIST_UNKNOWN_POLICY"
  | "ALLOWLIST_UNUSED"
  | "CLI_SELECTOR_PARSER_BYPASS"
  | "MANUAL_CWD_ROLL_AUTHORITY"
  | "SKILL_AMBIENT_AUTHORITY"
  | "TOOL_MISSING_CONTEXT_FALLBACK"
  | "UNREGISTERED_SURFACE"
  | "WORKSPACE_AUTHORITY_FROM_CWD";

export interface WorkspaceContextAuditSurface {
  readonly policyKey: string;
  readonly file: string;
}

export interface WorkspaceContextAuditAllowlistEntry {
  readonly policyKey: string;
  readonly violationCode: WorkspaceContextViolationCode;
  readonly file: string;
  readonly line: number;
  readonly rationale: string;
  readonly ownerStory: string;
  readonly expiresOn: string;
}

export interface WorkspaceContextAuditInput {
  readonly rootDir: string;
  readonly now: string;
  readonly policies: readonly WorkspaceContextPolicy[];
  readonly surfaces: readonly WorkspaceContextAuditSurface[];
  readonly allowlist: readonly WorkspaceContextAuditAllowlistEntry[];
}

export interface WorkspaceContextAuditFinding {
  readonly surface: WorkspaceContextPolicy["surface"] | "audit";
  readonly id: string;
  readonly operation: string;
  readonly policyKey: string;
  readonly file: string;
  readonly line: number;
  readonly code: WorkspaceContextViolationCode;
  readonly detail: string;
}

export interface WorkspaceContextAuditReport {
  readonly schema: "roll.workspace-context-audit/v1";
  readonly root: string;
  readonly summary: {
    readonly violations: number;
    readonly scannedSurfaces: number;
    readonly allowlisted: number;
  };
  readonly findings: readonly WorkspaceContextAuditFinding[];
}

interface ParsedPolicyKey {
  readonly surface: WorkspaceContextPolicy["surface"];
  readonly id: string;
  readonly operation: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const AUTHORITY_WORDS = /(?:\.roll|workspace|issue|evidence|policy|tool[-_ ]?dump|backlog|features?|design)/iu;
const SKILL_AMBIENT = /(?:\$PWD|\bproject root\b|\brepo(?:sitory)? root\b)/iu;
const SKILL_AUTHORITY = /(?:authority|\.roll\/|backlog|features?|design|evidence|policy|dump)/iu;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function policyKey(policy: Pick<WorkspaceContextPolicy, "surface" | "id" | "operation">): string {
  return `${policy.surface}:${policy.id}:${policy.operation}`;
}

function parsePolicyKey(key: string): ParsedPolicyKey | undefined {
  const parts = key.split(":");
  if (parts.length < 3) return undefined;
  const surface = parts[0];
  const id = parts[1];
  const operation = parts.slice(2).join(":");
  if ((surface !== "cli" && surface !== "skill" && surface !== "tool") || id === undefined || id === "" || operation === "") {
    return undefined;
  }
  return { surface, id, operation };
}

function lineAt(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function statementFor(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && !ts.isStatement(current)) current = current.parent;
  return current;
}

function isProcessCwdCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.arguments.length !== 0) return false;
  const expression = node.expression;
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "process"
    && expression.name.text === "cwd";
}

function isSelectorLiteral(node: ts.Node): boolean {
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && (node.text === "--workspace" || node.text === "--ws");
}

function isSelectorParserBypass(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    return ["includes", "indexOf", "findIndex", "some"].includes(method)
      && node.arguments.some(isSelectorLiteral);
  }
  if (ts.isBinaryExpression(node)) {
    return isSelectorLiteral(node.left) || isSelectorLiteral(node.right);
  }
  return false;
}

function addFinding(
  target: WorkspaceContextAuditFinding[],
  seen: Set<string>,
  identity: ParsedPolicyKey,
  file: string,
  line: number,
  code: WorkspaceContextViolationCode,
  detail: string,
): void {
  const key = `${identity.surface}:${identity.id}:${identity.operation}:${file}:${line}:${code}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    ...identity,
    policyKey: `${identity.surface}:${identity.id}:${identity.operation}`,
    file,
    line,
    code,
    detail,
  });
}

function scanSource(
  sourceText: string,
  file: string,
  identity: ParsedPolicyKey,
  findings: WorkspaceContextAuditFinding[],
  seen: Set<string>,
): void {
  const kind = [".js", ".jsx", ".mjs", ".cjs"].includes(extname(file)) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, kind);
  const visit = (node: ts.Node): void => {
    if (isProcessCwdCall(node)) {
      const statement = statementFor(node);
      const statementText = statement.getText(source);
      const line = lineAt(source, node);
      if (/['"`]\.roll(?:['"`/]|$)/u.test(statementText)) {
        addFinding(
          findings,
          seen,
          identity,
          file,
          line,
          "MANUAL_CWD_ROLL_AUTHORITY",
          "process.cwd() is manually joined to a .roll authority path",
        );
      }
      if (AUTHORITY_WORDS.test(statementText)) {
        addFinding(
          findings,
          seen,
          identity,
          file,
          line,
          "WORKSPACE_AUTHORITY_FROM_CWD",
          "process.cwd() participates in Workspace, Issue, evidence, policy, or dump authority derivation",
        );
      }
      if (identity.surface === "tool") {
        const parentText = node.parent?.getText(source) ?? "";
        if (/\?\?|\|\|/u.test(parentText) || /(?:context|executionContext).{0,80}process\.cwd\(\)/su.test(statementText)) {
          addFinding(
            findings,
            seen,
            identity,
            file,
            line,
            "TOOL_MISSING_CONTEXT_FALLBACK",
            "tool adapter continues with host cwd when required execution context is absent",
          );
        }
      }
    }
    if (identity.surface === "cli" && isSelectorParserBypass(node)) {
      addFinding(
        findings,
        seen,
        identity,
        file,
        lineAt(source, node),
        "CLI_SELECTOR_PARSER_BYPASS",
        "leaf/router parses --workspace or --ws instead of the shared selector parser",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scanSkill(
  sourceText: string,
  file: string,
  identity: ParsedPolicyKey,
  findings: WorkspaceContextAuditFinding[],
  seen: Set<string>,
): void {
  let fenced = false;
  for (const [index, line] of sourceText.split("\n").entries()) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*<!--/u.test(line)) continue;
    if (SKILL_AMBIENT.test(line) && SKILL_AUTHORITY.test(line)) {
      addFinding(
        findings,
        seen,
        identity,
        file,
        index + 1,
        "SKILL_AMBIENT_AUTHORITY",
        "skill contract treats PWD/project/repository root as the sole authority",
      );
    }
  }
}

function auditAllowlistFinding(
  entry: WorkspaceContextAuditAllowlistEntry,
  code: WorkspaceContextViolationCode,
  detail: string,
): WorkspaceContextAuditFinding {
  return {
    surface: "audit",
    id: "allowlist",
    operation: "validate",
    policyKey: entry.policyKey,
    file: entry.file,
    line: entry.line,
    code,
    detail,
  };
}

function findingOrder(a: WorkspaceContextAuditFinding, b: WorkspaceContextAuditFinding): number {
  return compareText(a.code, b.code)
    || compareText(a.surface, b.surface)
    || compareText(a.id, b.id)
    || compareText(a.operation, b.operation)
    || compareText(a.file, b.file)
    || a.line - b.line;
}

function normalizedRelative(rootDir: string, file: string): string | undefined {
  const absolute = resolve(rootDir, file);
  const root = resolve(rootDir);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join("/");
}

export function auditWorkspaceContextTree(input: WorkspaceContextAuditInput): WorkspaceContextAuditReport {
  const root = resolve(input.rootDir);
  const policies = new Map(input.policies.map((policy) => [policyKey(policy), policy]));
  const findings: WorkspaceContextAuditFinding[] = [];
  const seen = new Set<string>();
  const registeredFiles = new Set<string>();

  for (const surface of [...input.surfaces].sort((a, b) => compareText(a.file, b.file) || compareText(a.policyKey, b.policyKey))) {
    const identity = parsePolicyKey(surface.policyKey);
    const file = normalizedRelative(root, surface.file);
    if (identity === undefined || file === undefined || !policies.has(surface.policyKey)) {
      findings.push({
        surface: "audit",
        id: "registry",
        operation: "validate",
        policyKey: surface.policyKey,
        file: surface.file,
        line: 1,
        code: "UNREGISTERED_SURFACE",
        detail: "surface file is not bound to a known Workspace context policy",
      });
      continue;
    }
    registeredFiles.add(file);
    const absolute = join(root, file);
    if (!existsSync(absolute)) {
      findings.push({
        ...identity,
        policyKey: surface.policyKey,
        file,
        line: 1,
        code: "UNREGISTERED_SURFACE",
        detail: "registered surface file does not exist",
      });
      continue;
    }
    if (/(?:^|\/)(?:dist|generated|vendor|node_modules|coverage)(?:\/|$)/u.test(file)) continue;
    const sourceText = readFileSync(absolute, "utf8");
    if (file.endsWith("/SKILL.md") || file === "SKILL.md") scanSkill(sourceText, file, identity, findings, seen);
    else if (SOURCE_EXTENSIONS.has(extname(file)) && !/(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/u.test(file)) {
      scanSource(sourceText, file, identity, findings, seen);
    }
  }

  const allowlistFindings: WorkspaceContextAuditFinding[] = [];
  let allowlisted = 0;
  for (const entry of input.allowlist) {
    if (
      entry.rationale.trim() === ""
      || !/^US-[A-Z0-9]+-\d+$/u.test(entry.ownerStory)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expiresOn)
      || entry.line < 1
    ) {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_INVALID", "allowlist entry requires rationale, owner Story, expiry, and positive line"));
      continue;
    }
    if (!policies.has(entry.policyKey)) {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_UNKNOWN_POLICY", "allowlist entry refers to an unknown policy key"));
      continue;
    }
    if (entry.expiresOn < input.now) {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_EXPIRED", `allowlist entry expired on ${entry.expiresOn}`));
      continue;
    }
    const match = findings.findIndex((finding) =>
      finding.policyKey === entry.policyKey
      && finding.code === entry.violationCode
      && finding.file === entry.file
      && finding.line === entry.line);
    if (match < 0) {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_UNUSED", "allowlist entry no longer matches a violation"));
      continue;
    }
    findings.splice(match, 1);
    allowlisted += 1;
  }
  findings.push(...allowlistFindings);
  findings.sort(findingOrder);

  return {
    schema: "roll.workspace-context-audit/v1",
    root,
    summary: {
      violations: findings.length,
      scannedSurfaces: registeredFiles.size,
      allowlisted,
    },
    findings,
  };
}

export function renderWorkspaceContextAuditJson(report: WorkspaceContextAuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const SURFACE_ORDER: Record<WorkspaceContextAuditFinding["surface"], number> = {
  cli: 0,
  skill: 1,
  tool: 2,
  audit: 3,
};

export function renderWorkspaceContextAuditHuman(report: WorkspaceContextAuditReport): string {
  if (report.findings.length === 0) return "Workspace context audit: PASS (0 violations)";
  const lines = [`Workspace context audit: FAIL (${report.findings.length} violations)`];
  const grouped = new Map<string, WorkspaceContextAuditFinding[]>();
  for (const finding of report.findings) {
    const key = `${finding.surface}\u0000${finding.id}\u0000${finding.operation}`;
    const current = grouped.get(key) ?? [];
    current.push(finding);
    grouped.set(key, current);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => {
    const [as] = a.split("\u0000") as [WorkspaceContextAuditFinding["surface"]];
    const [bs] = b.split("\u0000") as [WorkspaceContextAuditFinding["surface"]];
    return SURFACE_ORDER[as] - SURFACE_ORDER[bs] || compareText(a, b);
  });
  for (const [key, group] of groups) {
    const [surface, id, operation] = key.split("\u0000");
    lines.push(`${surface?.toUpperCase()} ${id}/${operation}`);
    for (const finding of [...group].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.code, b.code))) {
      lines.push(`  ${finding.file}:${finding.line} ${finding.code}`);
    }
  }
  return lines.join("\n");
}
