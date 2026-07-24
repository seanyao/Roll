import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { validateWorkspaceContextPolicy, type WorkspaceContextPolicy } from "@roll/spec";

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
const AUTHORITY_WORDS = /(?:\.roll|workspace|issue|evidence|policy|tool[-_ ]?dump|backlog|features?)/iu;
const SKILL_AMBIENT = /(?:\$PWD|\bproject root\b|\brepo(?:sitory)? root\b)/iu;
const SKILL_AUTHORITY = /(?:authority|\.roll\/|backlog|features?|design|evidence|policy|dump)/iu;
const SKILL_PROHIBITION = /(?:\bnever\b|\bdo not\b|\bmust not\b|\bnot (?:the |an? )?authority\b|禁止|不得|不可|不是.*(?:权威|依据))/iu;
const TRUSTED_SELECTOR_IMPLEMENTATION_FILES = new Set([
  "packages/cli/src/lib/command-surface.ts",
  "packages/cli/src/lib/workspace-context-audit.ts",
  "packages/cli/src/lib/workspace-selector.ts",
]);

const CLI_SURFACE_FILES: Readonly<Record<string, string>> = {
  agent: "packages/cli/src/commands/agent.ts",
  attest: "packages/cli/src/commands/attest.ts",
  backlog: "packages/cli/src/commands/backlog.ts",
  capture: "packages/cli/src/commands/capture.ts",
  config: "packages/cli/src/commands/config.ts",
  context: "packages/cli/src/commands/context.ts",
  delivery: "packages/cli/src/commands/delivery.ts",
  design: "packages/cli/src/commands/design.ts",
  doctor: "packages/cli/src/commands/doctor.ts",
  help: "packages/cli/src/commands/index.ts",
  idea: "packages/cli/src/commands/idea.ts",
  index: "packages/cli/src/commands/index-gen.ts",
  init: "packages/cli/src/commands/init.ts",
  loop: "packages/cli/src/commands/loop-run-once.ts",
  next: "packages/cli/src/commands/next.ts",
  north: "packages/cli/src/commands/north.ts",
  release: "packages/cli/src/commands/release.ts",
  setup: "packages/cli/src/commands/setup.ts",
  status: "packages/cli/src/commands/status.ts",
  story: "packages/cli/src/commands/story-new.ts",
  test: "packages/cli/src/commands/test.ts",
  truth: "packages/cli/src/commands/truth.ts",
  update: "packages/cli/src/commands/update.ts",
  workspace: "packages/cli/src/commands/workspace.ts",
};

const TOOL_SURFACE_FILES: Readonly<Record<string, string>> = {
  bash: "packages/infra/src/tools/bash.ts",
  browser: "packages/infra/src/tools/browser.ts",
  filesystem: "packages/infra/src/tools/filesystem.ts",
  git: "packages/infra/src/tools/git.ts",
  github: "packages/infra/src/tools/github.ts",
  mcp: "packages/infra/src/tools/mcp.ts",
  network: "packages/infra/src/tools/network.ts",
  physical: "packages/infra/src/tools/browser.ts",
};

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

function staticStringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return staticStringValue(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringValue(span.expression);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function isSelectorValue(node: ts.Node, aliases: ReadonlySet<string>, factories: ReadonlySet<string>): boolean {
  const staticValue = staticStringValue(node);
  if (staticValue === "--workspace" || staticValue === "--ws") return true;
  if (ts.isIdentifier(node)) return aliases.has(node.text) || node.text === "CANONICAL_WORKSPACE_SELECTOR";
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factories.has(node.expression.text)) return true;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return isSelectorValue(node.expression, aliases, factories);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => isSelectorValue(element, aliases, factories));
  if (ts.isNewExpression(node)) return node.arguments?.some((argument) => isSelectorValue(argument, aliases, factories)) === true;
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return isSelectorValue(property.name, aliases, factories);
      if (ts.isPropertyAssignment(property)) return isSelectorValue(property.name, aliases, factories) || isSelectorValue(property.initializer, aliases, factories);
      return false;
    });
  }
  return false;
}

function isSelectorParserBypass(node: ts.Node, aliases: ReadonlySet<string>, factories: ReadonlySet<string>): boolean {
  if (ts.isCallExpression(node)) {
    const receiver = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.expression
      : ts.isElementAccessExpression(node.expression)
        ? node.expression.expression
        : undefined;
    const method = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ts.isElementAccessExpression(node.expression) && node.expression.argumentExpression !== undefined
        ? staticStringValue(node.expression.argumentExpression)
        : undefined;
    return method !== undefined
      && ["includes", "indexOf", "findIndex", "some", "has", "is", "startsWith", "endsWith", "match", "search", "test"].includes(method)
      && ((receiver !== undefined && isSelectorValue(receiver, aliases, factories))
        || node.arguments.some((argument) => isSelectorValue(argument, aliases, factories)));
  }
  if (ts.isElementAccessExpression(node)) {
    return isSelectorValue(node.expression, aliases, factories)
      || (node.argumentExpression !== undefined && isSelectorValue(node.argumentExpression, aliases, factories));
  }
  if (ts.isBinaryExpression(node)) {
    return isSelectorValue(node.left, aliases, factories) || isSelectorValue(node.right, aliases, factories);
  }
  if (ts.isCaseClause(node)) return isSelectorValue(node.expression, aliases, factories);
  if (ts.isParameter(node) && node.initializer !== undefined) return isSelectorValue(node.initializer, aliases, factories);
  if (ts.isReturnStatement(node) && node.expression !== undefined) return isSelectorValue(node.expression, aliases, factories);
  if (ts.isRegularExpressionLiteral(node)) return /--workspace|--ws/u.test(node.text);
  return false;
}

function exactExecutionConfigPath(call: ts.CallExpression, cwdArgument: (argument: ts.Expression) => boolean): boolean {
  if (!ts.isIdentifier(call.expression) || (call.expression.text !== "join" && call.expression.text !== "resolve")) return false;
  const cwdIndex = call.arguments.findIndex(cwdArgument);
  if (cwdIndex < 0) return false;
  const suffix = call.arguments.slice(cwdIndex + 1);
  const rollSegment = suffix[0];
  const configSegment = suffix[1];
  return suffix.length === 2
    && rollSegment !== undefined
    && (ts.isStringLiteral(rollSegment) || ts.isNoSubstitutionTemplateLiteral(rollSegment))
    && rollSegment.text === ".roll"
    && configSegment !== undefined
    && (ts.isStringLiteral(configSegment) || ts.isNoSubstitutionTemplateLiteral(configSegment))
    && (configSegment.text === "local.yaml" || configSegment.text === ".gitignore");
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
  policy?: WorkspaceContextPolicy,
): void {
  const kind = [".js", ".jsx", ".mjs", ".cjs"].includes(extname(file)) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, kind);
  const scopeFor = (node: ts.Node): ts.Node => {
    let current = node;
    while (current.parent !== undefined && !ts.isFunctionLike(current)) current = current.parent;
    return current;
  };
  const cwdAliases = new Map<ts.Node, Set<string>>();
  const selectorAliases = new Set<string>();
  const selectorFactories = new Set<string>();
  const collectAliases = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (imported === "CANONICAL_WORKSPACE_SELECTOR") selectorAliases.add(node.name.text);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isSelectorValue(node.initializer, selectorAliases, selectorFactories)) {
      selectorAliases.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && isSelectorValue(node.initializer, selectorAliases, selectorFactories)
    ) selectorAliases.add(node.name.text);
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
      && node.name !== undefined
      && ts.isIdentifier(node.name)
      && node.body !== undefined
    ) {
      let returnsSelector = false;
      const inspectReturn = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression !== undefined && isSelectorValue(child.expression, selectorAliases, selectorFactories)) returnsSelector = true;
        ts.forEachChild(child, inspectReturn);
      };
      if (ts.isBlock(node.body)) inspectReturn(node.body);
      else returnsSelector = isSelectorValue(node.body, selectorAliases, selectorFactories);
      if (returnsSelector) selectorFactories.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const body = node.initializer.body;
      let returnsSelector = !ts.isBlock(body) && isSelectorValue(body, selectorAliases, selectorFactories);
      if (ts.isBlock(body)) {
        const inspectReturn = (child: ts.Node): void => {
          if (child !== body && ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child) && child.expression !== undefined && isSelectorValue(child.expression, selectorAliases, selectorFactories)) returnsSelector = true;
          ts.forEachChild(child, inspectReturn);
        };
        inspectReturn(body);
      }
      if (returnsSelector) selectorFactories.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isProcessCwdCall(node.initializer)) {
      const scope = scopeFor(node);
      const aliases = cwdAliases.get(scope) ?? new Set<string>();
      aliases.add(node.name.text);
      cwdAliases.set(scope, aliases);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);
  const hasTrustedSelectorBoundary = (): boolean => TRUSTED_SELECTOR_IMPLEMENTATION_FILES.has(file);
  const visit = (node: ts.Node): void => {
    if (identity.surface === "cli" && policy?.scope !== "legacy_migration_only" && !hasTrustedSelectorBoundary()) {
      const selectorText = staticStringValue(node);
      const parentText = node.parent === undefined ? undefined : staticStringValue(node.parent);
      const selectorSpelling = selectorText === "--workspace" || selectorText === "--ws";
      const importedSelector = ts.isImportSpecifier(node)
        && (node.propertyName?.text ?? node.name.text) === "CANONICAL_WORKSPACE_SELECTOR";
      const selectorProperty = (ts.isPropertyAccessExpression(node) && node.name.text === "CANONICAL_WORKSPACE_SELECTOR")
        || (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined && staticStringValue(node.argumentExpression) === "CANONICAL_WORKSPACE_SELECTOR");
      if ((selectorSpelling && parentText !== selectorText) || importedSelector || selectorProperty) {
        addFinding(
          findings,
          seen,
          identity,
          file,
          lineAt(source, node),
          "CLI_SELECTOR_PARSER_BYPASS",
          "selector spelling or constant escapes the central Workspace selector helper",
        );
      }
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "join" || node.expression.text === "resolve")
      && node.arguments.some((argument) => (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && argument.text === ".roll")
      && node.arguments.some((argument) => ts.isIdentifier(argument) && cwdAliases.get(scopeFor(node))?.has(argument.text) === true)
    ) {
      const explicitExecutionConfig = exactExecutionConfigPath(node, (argument) =>
        ts.isIdentifier(argument) && cwdAliases.get(scopeFor(node))?.has(argument.text) === true);
      if (!explicitExecutionConfig) {
        const line = lineAt(source, node);
        addFinding(findings, seen, identity, file, line, "MANUAL_CWD_ROLL_AUTHORITY", "a process.cwd() alias is manually joined to a .roll authority path");
        addFinding(findings, seen, identity, file, line, "WORKSPACE_AUTHORITY_FROM_CWD", "a process.cwd() alias participates in Workspace authority derivation");
      }
    }
    if (isProcessCwdCall(node)) {
      const statement = statementFor(node);
      const statementText = statement.getText(source);
      const line = lineAt(source, node);
      const lineText = sourceText.split("\n")[line - 1] ?? "";
      const explicitExecutionConfig = ts.isCallExpression(node.parent)
        && exactExecutionConfigPath(node.parent, (argument) => argument === node);
      if (/['"`]\.roll(?:['"`/]|$)/u.test(lineText) && !explicitExecutionConfig) {
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
      if (AUTHORITY_WORDS.test(lineText) && !explicitExecutionConfig) {
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
    if (identity.surface === "cli" && policy?.scope !== "legacy_migration_only" && !hasTrustedSelectorBoundary() && isSelectorParserBypass(node, selectorAliases, selectorFactories)) {
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
    if (SKILL_AMBIENT.test(line) && SKILL_AUTHORITY.test(line) && !SKILL_PROHIBITION.test(line)) {
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

  const scanQueue = new Map<string, ParsedPolicyKey>();
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
    if (!scanQueue.has(file)) scanQueue.set(file, identity);
  }

  for (const [file, identity] of scanQueue) {
    const absolute = join(root, file);
    if (!existsSync(absolute)) {
      findings.push({
        ...identity,
        policyKey: `${identity.surface}:${identity.id}:${identity.operation}`,
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
      scanSource(sourceText, file, identity, findings, seen, policies.get(`${identity.surface}:${identity.id}:${identity.operation}`));
    }
  }

  const allowlistFindings: WorkspaceContextAuditFinding[] = [];
  let allowlisted = 0;
  for (const entry of input.allowlist) {
    const entryPolicy = policies.get(entry.policyKey);
    if (
      entry.rationale.trim() === ""
      || !/^US-[A-Z0-9]+-\d+$/u.test(entry.ownerStory)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expiresOn)
      || entry.line < 1
    ) {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_INVALID", "allowlist entry requires rationale, owner Story, expiry, and positive line"));
      continue;
    }
    if (entryPolicy === undefined) {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_UNKNOWN_POLICY", "allowlist entry refers to an unknown policy key"));
      continue;
    }
    if (entryPolicy.scope !== "machine_only" && entryPolicy.scope !== "legacy_migration_only") {
      allowlistFindings.push(auditAllowlistFinding(entry, "ALLOWLIST_INVALID", "allowlist is restricted to machine_only or legacy_migration_only policy boundaries"));
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

export function registeredWorkspaceContextAuditSurfaces(
  policies: readonly WorkspaceContextPolicy[],
  rootDir?: string,
): WorkspaceContextAuditSurface[] {
  const surfaces = policies.map((policy) => {
    const cliFile = policy.id === "workspace" && policy.operation.startsWith("issue.")
      ? "packages/cli/src/commands/workspace-issue.ts"
      : policy.id === "workspace" && policy.operation.startsWith("requirement.")
        ? "packages/cli/src/commands/workspace-requirement.ts"
        : policy.id === "workspace" && policy.operation.startsWith("doctor.")
          ? "packages/cli/src/commands/workspace-doctor.ts"
          : policy.id === "workspace" && policy.operation === "migrate"
            ? "packages/cli/src/commands/workspace-migrate.ts"
            : policy.id === "workspace" && policy.operation === "edit"
              ? "packages/cli/src/commands/workspace-edit.ts"
              : policy.id === "story" && policy.operation === "validate"
                ? "packages/cli/src/commands/story-validate.ts"
                : CLI_SURFACE_FILES[policy.id];
    const file = policy.surface === "cli"
      ? cliFile
      : policy.surface === "tool"
        ? TOOL_SURFACE_FILES[policy.id]
        : `skills/${policy.id}/SKILL.md`;
    return {
      policyKey: policyKey(policy),
      file: file ?? `unregistered/${policy.surface}/${policy.id}.missing`,
    };
  });
  if (rootDir === undefined) return surfaces;
  const walk = (relativeDir: string): string[] => {
    const absolute = join(rootDir, relativeDir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) return walk(relativePath);
      return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [relativePath] : [];
    });
  };
  const existing = new Set(surfaces.map((surface) => surface.file));
  const resolveImport = (fromFile: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(rootDir, fromFile, "..", specifier);
    const sourceBase = /\.(?:js|mjs|cjs)$/u.test(base) ? base.replace(/\.(?:js|mjs|cjs)$/u, "") : base;
    for (const candidate of [base, `${sourceBase}.ts`, `${sourceBase}.tsx`, `${sourceBase}.js`, join(sourceBase, "index.ts")]) {
      if (!existsSync(candidate)) continue;
      const rel = relative(resolve(rootDir), candidate).split(sep).join("/");
      if (rel !== "" && !rel.startsWith("../")) return rel;
    }
    return undefined;
  };
  const entrySurfaces = [...surfaces];
  for (const entry of entrySurfaces) {
    if (entry.policyKey === "cli:help:read") continue;
    const queue = [entry.file];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const file = queue.shift();
      if (file === undefined || visited.has(file) || !SOURCE_EXTENSIONS.has(extname(file))) continue;
      visited.add(file);
      const absolute = join(rootDir, file);
      if (!existsSync(absolute)) continue;
      const imports = ts.preProcessFile(readFileSync(absolute, "utf8"), true, true).importedFiles;
      for (const imported of imports) {
        const resolved = resolveImport(file, imported.fileName);
        if (resolved === undefined) continue;
        const entrySurface = parsePolicyKey(entry.policyKey)?.surface;
        if (entrySurface === "cli" && !resolved.startsWith("packages/cli/src/")) continue;
        if (entrySurface === "tool" && !resolved.startsWith("packages/infra/src/tools/")) continue;
        queue.push(resolved);
        if (existing.has(resolved)) continue;
        existing.add(resolved);
        surfaces.push({
          policyKey: entry.policyKey,
          file: resolved,
        });
      }
    }
  }
  const browserPolicy = policies.find((policy) => policy.surface === "tool" && policy.id === "browser");
  if (browserPolicy !== undefined) {
    for (const file of walk("packages/infra/src/browser-operations").sort(compareText)) {
      if (existing.has(file)) continue;
      existing.add(file);
      surfaces.push({ policyKey: policyKey(browserPolicy), file });
    }
  }
  return surfaces;
}

interface WorkspaceContextMatrixFile {
  readonly rows?: readonly unknown[];
}

export function auditRegisteredWorkspaceContextTree(
  rootDir: string,
  now = new Date().toISOString().slice(0, 10),
): WorkspaceContextAuditReport {
  const matrixPath = join(rootDir, "docs", "generated", "workspace-context-compatibility-matrix.json");
  const allowlistPath = join(rootDir, "config", "workspace-context-audit-allowlist.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as WorkspaceContextMatrixFile;
  if (!Array.isArray(matrix.rows)) throw new Error("workspace-context-audit: compatibility matrix rows are missing");
  const policies = matrix.rows.map((row, index) => {
    const issues = validateWorkspaceContextPolicy(row);
    if (issues.length > 0) {
      throw new Error(`workspace-context-audit: invalid matrix policy at row ${index}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    }
    return row as WorkspaceContextPolicy;
  });
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as unknown;
  if (!Array.isArray(allowlist)) throw new Error("workspace-context-audit: allowlist must be an array");
  return auditWorkspaceContextTree({
    rootDir,
    now,
    policies,
    surfaces: registeredWorkspaceContextAuditSurfaces(policies, rootDir),
    allowlist: allowlist as WorkspaceContextAuditAllowlistEntry[],
  });
}
