/**
 * @responsibility Scans repository structure into architecture-health findings.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export type DreamScanKind =
  | "dead_export"
  | "unused_file"
  | "unreachable_branch"
  | "duplicate_ast"
  | "single_implementation_abstraction"
  | "delegating_wrapper"
  | "frozen_flag"
  | "undocumented_env";

export type DreamFindingSeverity = "blocker" | "high" | "medium" | "low";
export type DreamFindingConfidence = "high" | "medium" | "low";

export interface TextSpan {
  start: number;
  length: number;
}

export interface StaticDiagnostic {
  path?: string;
  message: string;
  code?: number;
}

export interface SkippedPath {
  path: string;
  reason: string;
}

export interface SourceFileNode {
  path: string;
  packageName?: string;
  kind: "source" | "test" | "config" | "generated" | "declaration";
  entrypoint: boolean;
  publicApi: boolean;
}

export interface SymbolNode {
  id: string;
  name: string;
  kind: "function" | "class" | "const" | "enum" | "interface" | "type" | "namespace";
  file: string;
  exported: boolean;
  declarationSpan: TextSpan;
  typeOnly: boolean;
  publicApi: boolean;
}

export interface ImportEdge {
  fromFile: string;
  toFile?: string;
  moduleSpecifier: string;
  kind: "import" | "reexport" | "dynamic_import";
}

export interface ReferenceEdge {
  fromFile: string;
  toSymbolId: string;
  kind: "value" | "type" | "import" | "reexport" | "dynamic_import";
}

export interface StaticProjectGraph {
  projectRoot: string;
  tsconfigPath?: string;
  files: SourceFileNode[];
  symbols: SymbolNode[];
  imports: ImportEdge[];
  references: ReferenceEdge[];
  diagnostics: StaticDiagnostic[];
  skipped: SkippedPath[];
  program?: ts.Program;
  languageService?: ts.LanguageService;
}

export interface FindingEvidence {
  path: string;
  span?: TextSpan;
  detail: string;
}

export interface DreamFinding {
  id: string;
  kind: DreamScanKind;
  severity: DreamFindingSeverity;
  confidence: DreamFindingConfidence;
  title: string;
  rationale: string;
  evidence: FindingEvidence[];
  suggestedRefactor: string;
  sourceScan: "dream-structure";
  stableKey: string;
}

export interface SuppressedFinding {
  kind: DreamScanKind;
  path: string;
  reason: string;
}

export interface DreamScanResult {
  schema: "dream-structure.v1";
  generatedAt: string;
  projectRoot: string;
  graphStats: {
    files: number;
    symbols: number;
    imports: number;
    references: number;
  };
  findings: DreamFinding[];
  suppressed: SuppressedFinding[];
  errors: StaticDiagnostic[];
}

export interface DreamStructurePolicy {
  envReferenceThreshold?: number;
  duplicateMinimumOccurrences?: number;
  duplicateMinimumNodes?: number;
  backlogCap?: number;
}

interface ExportDecl {
  node: ts.Node;
  name: string;
  nameStart: number;
  kind: SymbolNode["kind"];
  file: string;
  fileName: string;
  exported: boolean;
  typeOnly: boolean;
  publicApi: boolean;
}

interface ProgramContext {
  root: string;
  program: ts.Program;
  languageService: ts.LanguageService;
  files: readonly ts.SourceFile[];
}

const GENERATED_SEGMENTS = new Set(["dist", "coverage", "node_modules", ".roll"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SEVERITY_RANK: Record<DreamFindingSeverity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
const CONFIDENCE_RANK: Record<DreamFindingConfidence, number> = { high: 0, medium: 1, low: 2 };

export function buildStaticProjectGraph(input: {
  root: string;
  tsconfigPath?: string;
  includeTests?: boolean;
  excludeGlobs?: string[];
}): StaticProjectGraph {
  const root = resolve(input.root);
  const tsconfigPaths = input.tsconfigPath ? [resolve(root, input.tsconfigPath)] : findTsconfigs(root);
  if (tsconfigPaths.length === 0) {
    return emptyGraph(root, "No tsconfig.json found for Dream structure scan");
  }

  const diagnostics: StaticDiagnostic[] = [];
  const fileSet = new Set<string>();
  let compilerOptions: ts.CompilerOptions = {};
  for (const tsconfigPath of tsconfigPaths) {
    const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (config.error !== undefined) {
      diagnostics.push(flattenDiagnostic(config.error));
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfigPath));
    diagnostics.push(...parsed.errors.map(flattenDiagnostic));
    compilerOptions = { ...compilerOptions, ...parsed.options };
    for (const fileName of parsed.fileNames) fileSet.add(fileName);
  }

  const fileNames = [...fileSet]
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .filter((file) => !isExcluded(root, file));
  const program = ts.createProgram(fileNames, compilerOptions);
  const servicesHost = createLanguageServiceHost(fileNames, compilerOptions);
  const languageService = ts.createLanguageService(servicesHost, ts.createDocumentRegistry());
  const sourceFiles = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile)
    .filter((file) => fileNames.includes(file.fileName))
    .sort((a, b) => normalizePath(root, a.fileName).localeCompare(normalizePath(root, b.fileName)));

  const ctx: ProgramContext = { root, program, languageService, files: sourceFiles };
  const files = sourceFiles.map((file) => classifySourceFile(root, file.fileName));
  const exports = sourceFiles.flatMap((file) => exportedDeclarations(ctx, file));
  const symbols = exports.map((decl) => symbolFromExport(root, decl));
  const symbolByFileName = new Map<string, string>();
  for (const symbol of symbols) symbolByFileName.set(`${symbol.file}:${symbol.name}`, symbol.id);
  const imports = sourceFiles.flatMap((file) => importEdges(root, file));
  const references = exports.flatMap((decl) => referenceEdges(root, decl, symbolByFileName, languageService));

  return {
    projectRoot: root,
    tsconfigPath: tsconfigPaths.map((path) => normalizePath(root, path)).join(","),
    files,
    symbols,
    imports,
    references,
    diagnostics,
    skipped: [],
    program,
    languageService,
  };
}

export function scanDreamStructure(
  graph: StaticProjectGraph,
  policy: DreamStructurePolicy = {},
): DreamScanResult {
  const findings = graph.program
    ? [
        ...scanDeadExports(graph),
        ...scanUnusedFiles(graph),
        ...scanUnreachableBranches(graph),
        ...scanDuplicateAst(graph, policy),
        ...scanSingleImplementationAbstractions(graph),
        ...scanUndocumentedEnv(graph, policy),
      ]
    : [];
  const sorted = findings
    .map((finding, index) => ({ ...finding, id: `DS-${String(index + 1).padStart(3, "0")}` }))
    .sort(compareFindings)
    .map((finding, index) => ({ ...finding, id: `DS-${String(index + 1).padStart(3, "0")}` }));

  return {
    schema: "dream-structure.v1",
    generatedAt: "1970-01-01T00:00:00.000Z",
    projectRoot: graph.projectRoot,
    graphStats: {
      files: graph.files.length,
      symbols: graph.symbols.length,
      imports: graph.imports.length,
      references: graph.references.length,
    },
    findings: sorted,
    suppressed: [],
    errors: graph.diagnostics,
  };
}

export function rankDreamFindings(findings: readonly DreamFinding[], cap = 5): DreamFinding[] {
  return [...findings].sort(compareFindings).slice(0, cap);
}

export function renderDreamStructureLog(result: DreamScanResult): string {
  const lines = [
    "## Code structure static analysis",
    "",
    `schema: ${result.schema}`,
    `graph: ${result.graphStats.files} files / ${result.graphStats.symbols} symbols / ${result.graphStats.references} references`,
    "",
  ];
  if (result.errors.length > 0) {
    lines.push("degraded:");
    for (const error of result.errors) lines.push(`- ${error.path ? `${error.path}: ` : ""}${error.message}`);
    return `${lines.join("\n")}\n`;
  }
  const ranked = rankDreamFindings(result.findings);
  lines.push(`findings: ${result.findings.length}; backlog candidates: ${ranked.length} (cap 5)`);
  for (const [index, finding] of ranked.entries()) {
    lines.push(
      `${index + 1}. ${finding.severity}/${finding.confidence} ${finding.kind}: ${finding.title} (${finding.stableKey})`,
    );
  }
  lines.push(`suppressed: ${result.suppressed.length}`);
  return `${lines.join("\n")}\n`;
}

export function renderRefactorRows(input: {
  result: DreamScanResult;
  existingBacklog: string;
  date: string;
}): string[] {
  const dateId = input.date.replaceAll("-", "");
  const rows: string[] = [];
  for (const finding of rankDreamFindings(input.result.findings, 5)) {
    if (input.existingBacklog.includes(finding.stableKey)) continue;
    const index = String(rows.length + 1).padStart(3, "0");
    rows.push(
      `| [REFACTOR-DREAM-${dateId}-${index}](.roll/features/refactor/REFACTOR-DREAM-${dateId}-${index}/spec.md) | ${finding.suggestedRefactor} detected by Dream structure scan ${finding.stableKey} | 📋 Todo |`,
    );
  }
  return rows;
}

function emptyGraph(root: string, error: string | StaticDiagnostic): StaticProjectGraph {
  const diagnostic = typeof error === "string" ? { message: error } : error;
  return {
    projectRoot: root,
    files: [],
    symbols: [],
    imports: [],
    references: [],
    diagnostics: [diagnostic],
    skipped: [],
  };
}

function findTsconfigs(root: string): string[] {
  const direct = join(root, "tsconfig.json");
  if (existsSync(direct)) return [direct];
  return ["packages/spec/tsconfig.json", "packages/core/tsconfig.json", "packages/infra/tsconfig.json", "packages/cli/tsconfig.json"]
    .map((candidate) => join(root, candidate))
    .filter((path) => existsSync(path));
}

function createLanguageServiceHost(fileNames: readonly string[], options: ts.CompilerOptions): ts.LanguageServiceHost {
  return {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...fileNames],
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      if (!existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
}

function normalizePath(root: string, path: string): string {
  return relative(root, resolve(path)).split(sep).join("/");
}

function isExcluded(root: string, path: string): boolean {
  const rel = normalizePath(root, path);
  return rel.split("/").some((segment) => GENERATED_SEGMENTS.has(segment)) || rel.endsWith(".d.ts");
}

function classifySourceFile(root: string, fileName: string): SourceFileNode {
  const path = normalizePath(root, fileName);
  const base = basename(path);
  const isTest = /\.test\.|\.spec\./.test(path);
  const isConfig = base.startsWith("config") || base.includes(".config.");
  const isGenerated = path.includes("/__snapshots__/") || path.includes("/generated/");
  const entrypoint = path.endsWith("src/index.ts") || path.endsWith("/index.ts");
  return {
    path,
    kind: isGenerated ? "generated" : isTest ? "test" : isConfig ? "config" : "source",
    entrypoint,
    publicApi: entrypoint,
  };
}

function exportedDeclarations(ctx: ProgramContext, sourceFile: ts.SourceFile): ExportDecl[] {
  const file = normalizePath(ctx.root, sourceFile.fileName);
  const publicApi = file.endsWith("src/index.ts") || file.endsWith("/index.ts");
  const declarations: ExportDecl[] = [];
  const visit = (node: ts.Node): void => {
    const named = declarationName(node);
    if (named !== undefined) {
      declarations.push({
        node,
        name: named.name,
        nameStart: named.nameStart,
        kind: named.kind,
        file,
        fileName: sourceFile.fileName,
        exported: hasExportModifier(node),
        typeOnly: named.typeOnly,
        publicApi,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations.filter((decl) => decl.exported || decl.publicApi);
}

function declarationName(
  node: ts.Node,
): { name: string; nameStart: number; kind: SymbolNode["kind"]; typeOnly: boolean } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return named(node.name, "function", false);
  if (ts.isClassDeclaration(node) && node.name) return named(node.name, "class", false);
  if (ts.isInterfaceDeclaration(node)) return named(node.name, "interface", true);
  if (ts.isTypeAliasDeclaration(node)) return named(node.name, "type", true);
  if (ts.isEnumDeclaration(node)) return named(node.name, "enum", false);
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    const first = node.declarationList.declarations[0];
    if (first && ts.isIdentifier(first.name)) return named(first.name, "const", false);
  }
  return undefined;
}

function named(identifier: ts.Identifier, kind: SymbolNode["kind"], typeOnly: boolean): {
  name: string;
  nameStart: number;
  kind: SymbolNode["kind"];
  typeOnly: boolean;
} {
  return { name: identifier.text, nameStart: spanOf(identifier).start, kind, typeOnly };
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function symbolFromExport(root: string, decl: ExportDecl): SymbolNode {
  return {
    id: stableKey(["symbol", decl.file, decl.name]),
    name: decl.name,
    kind: decl.kind,
    file: decl.file,
    exported: decl.exported,
    declarationSpan: spanOf(decl.node),
    typeOnly: decl.typeOnly,
    publicApi: decl.publicApi || normalizePath(root, decl.fileName).endsWith("src/index.ts"),
  };
}

function importEdges(root: string, sourceFile: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const fromFile = normalizePath(root, sourceFile.fileName);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        edges.push({
          fromFile,
          toFile: resolveModulePath(root, sourceFile.fileName, spec.text),
          moduleSpecifier: spec.text,
          kind: ts.isExportDeclaration(node) ? "reexport" : "import",
        });
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        edges.push({
          fromFile,
          toFile: resolveModulePath(root, sourceFile.fileName, first.text),
          moduleSpecifier: first.text,
          kind: "dynamic_import",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

function resolveModulePath(root: string, containingFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(containingFile), specifier);
  for (const suffix of [".ts", ".tsx", ".mts", ".cts", "/index.ts"]) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate)) return normalizePath(root, candidate);
  }
  return undefined;
}

function referenceEdges(
  root: string,
  decl: ExportDecl,
  symbolByFileName: ReadonlyMap<string, string>,
  languageService: ts.LanguageService,
): ReferenceEdge[] {
  const symbolId = symbolByFileName.get(`${decl.file}:${decl.name}`);
  if (symbolId === undefined) return [];
  const refs = languageService.findReferences(decl.fileName, decl.nameStart) ?? [];
  return refs.flatMap((ref) =>
    ref.references.map((entry) => ({
      fromFile: normalizePath(root, entry.fileName),
      toSymbolId: symbolId,
      kind: entry.isWriteAccess ? "value" : "import",
    }) satisfies ReferenceEdge),
  );
}

function scanDeadExports(graph: StaticProjectGraph): DreamFinding[] {
  return graph.symbols
    .filter((symbol) => symbol.exported)
    .filter((symbol) => !symbol.typeOnly)
    .filter((symbol) => !symbol.publicApi)
    .filter((symbol) => productionReferenceCount(graph, symbol) === 0)
    .map((symbol) =>
      finding({
        kind: "dead_export",
        severity: "medium",
        confidence: "high",
        title: `${symbol.name} is exported but has no production references`,
        rationale: "TypeScript Language Service found no external production value references.",
        evidence: [{ path: symbol.file, span: symbol.declarationSpan, detail: "0 production references" }],
        suggestedRefactor: `Remove or justify unused exported \`${symbol.name}\``,
      }),
    );
}

function productionReferenceCount(graph: StaticProjectGraph, symbol: SymbolNode): number {
  return graph.references.filter((ref) => ref.toSymbolId === symbol.id && ref.fromFile !== symbol.file && !isTestPath(ref.fromFile)).length;
}

function scanUnusedFiles(graph: StaticProjectGraph): DreamFinding[] {
  const inbound = new Set(graph.imports.map((edge) => edge.toFile).filter((path): path is string => path !== undefined));
  return graph.files
    .filter((file) => file.kind === "source")
    .filter((file) => !file.entrypoint && !file.publicApi)
    .filter((file) => !inbound.has(file.path))
    .map((file) =>
      finding({
        kind: "unused_file",
        severity: "low",
        confidence: "medium",
        title: `${file.path} has no inbound imports`,
        rationale: "The static import graph has no inbound import, reexport, or literal dynamic import edge.",
        evidence: [{ path: file.path, detail: "0 inbound import edges" }],
        suggestedRefactor: `Remove or justify unused source file \`${file.path}\``,
      }),
    );
}

function scanUnreachableBranches(graph: StaticProjectGraph): DreamFinding[] {
  const findings: DreamFinding[] = [];
  for (const sourceFile of graph.program?.getSourceFiles() ?? []) {
    if (sourceFile.isDeclarationFile || isExcluded(graph.projectRoot, sourceFile.fileName)) continue;
    const path = normalizePath(graph.projectRoot, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node) && node.expression.kind === ts.SyntaxKind.FalseKeyword) {
        findings.push(
          finding({
            kind: "unreachable_branch",
            severity: "medium",
            confidence: "high",
            title: `Explicit unreachable branch in ${path}`,
            rationale: "The branch condition is the literal false keyword.",
            evidence: [{ path, span: spanOf(node), detail: "if (false)" }],
            suggestedRefactor: `Remove unreachable branch in \`${path}\``,
          }),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return findings;
}

function scanDuplicateAst(graph: StaticProjectGraph, policy: DreamStructurePolicy): DreamFinding[] {
  const minOccurrences = policy.duplicateMinimumOccurrences ?? 3;
  const minNodes = policy.duplicateMinimumNodes ?? 12;
  const groups = new Map<string, FindingEvidence[]>();
  for (const sourceFile of graph.program?.getSourceFiles() ?? []) {
    if (sourceFile.isDeclarationFile || isExcluded(graph.projectRoot, sourceFile.fileName)) continue;
    const path = normalizePath(graph.projectRoot, sourceFile.fileName);
    if (isTestPath(path)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isTryStatement(node) || ts.isFunctionLike(node)) {
        const normalized = normalizeAst(node);
        const nodeCount = normalized.split(" ").length;
        if (nodeCount >= minNodes) {
          const key = stableKey(["duplicate", normalized]);
          const existing = groups.get(key) ?? [];
          existing.push({ path, span: spanOf(node), detail: `fingerprint ${key}` });
          groups.set(key, existing);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...groups.values()]
    .filter((evidence) => evidence.length >= minOccurrences)
    .map((evidence) =>
      finding({
        kind: "duplicate_ast",
        severity: "low",
        confidence: "medium",
        title: `${evidence.length} code blocks share the same normalized AST shape`,
        rationale: "Normalized AST fingerprints match across repeated blocks after replacing identifiers and literals.",
        evidence,
        suggestedRefactor: "Consider extracting repeated structural code detected by Dream",
      }),
    );
}

function scanSingleImplementationAbstractions(graph: StaticProjectGraph): DreamFinding[] {
  const interfaces = new Map<string, FindingEvidence>();
  const implementations = new Map<string, FindingEvidence[]>();
  for (const sourceFile of graph.program?.getSourceFiles() ?? []) {
    if (sourceFile.isDeclarationFile || isExcluded(graph.projectRoot, sourceFile.fileName)) continue;
    const path = normalizePath(graph.projectRoot, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && !hasExportModifier(node)) {
        interfaces.set(node.name.text, {
          path,
          span: spanOf(node),
          detail: "internal interface",
        });
      }
      if (ts.isClassDeclaration(node) && node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const type of clause.types) {
            const name = type.expression.getText(sourceFile);
            const existing = implementations.get(name) ?? [];
            existing.push({
              path,
              span: spanOf(node),
              detail: `implemented by ${node.name?.text ?? "<anonymous>"}`,
            });
            implementations.set(name, existing);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const findings: DreamFinding[] = [];
  for (const [name, evidence] of interfaces) {
    const impls = implementations.get(name) ?? [];
    if (impls.length !== 1) continue;
    findings.push(
      finding({
        kind: "single_implementation_abstraction",
        severity: "low",
        confidence: "medium",
        title: `${name} has exactly one non-public implementation`,
        rationale: "An internal interface with one implementation may be unnecessary indirection.",
        evidence: [evidence, ...impls],
        suggestedRefactor: `Inline or justify single-implementation abstraction \`${name}\``,
      }),
    );
  }
  return findings;
}

function scanUndocumentedEnv(graph: StaticProjectGraph, policy: DreamStructurePolicy): DreamFinding[] {
  const threshold = policy.envReferenceThreshold ?? 5;
  const refs = new Map<string, FindingEvidence[]>();
  for (const sourceFile of graph.program?.getSourceFiles() ?? []) {
    if (sourceFile.isDeclarationFile || isExcluded(graph.projectRoot, sourceFile.fileName)) continue;
    const path = normalizePath(graph.projectRoot, sourceFile.fileName);
    if (isTestPath(path)) continue;
    const visit = (node: ts.Node): void => {
      const envName = processEnvName(node);
      if (envName !== undefined) {
        const existing = refs.get(envName) ?? [];
        existing.push({
          path,
          span: spanOf(node),
          detail: "AST process.env reference",
        });
        refs.set(envName, existing);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...refs.entries()]
    .filter(([, evidence]) => evidence.length >= threshold)
    .filter(([name]) => !isEnvDocumented(graph.projectRoot, name))
    .map(([name, evidence]) =>
      finding({
        kind: "undocumented_env",
        severity: "medium",
        confidence: "high",
        title: `${name} is used repeatedly but is not documented`,
        rationale: `AST found ${evidence.length} source references and no README/docs mention.`,
        evidence,
        suggestedRefactor: `Document or simplify repeated \`${name}\` env usage`,
      }),
    );
}

function processEnvName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isProcessEnvExpression(node.expression)) return node.name.text;
  if (ts.isElementAccessExpression(node) && isProcessEnvExpression(node.expression)) {
    const arg = node.argumentExpression;
    if (ts.isStringLiteral(arg)) return arg.text;
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    const parent = node.parent?.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && parent.initializer && isProcessEnvExpression(parent.initializer)) {
      return node.name.text;
    }
  }
  return undefined;
}

function isProcessEnvExpression(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "env" && ts.isIdentifier(node.expression) && node.expression.text === "process";
  }
  if (ts.isPropertyAccessChain(node)) {
    return node.name.text === "env" && ts.isIdentifier(node.expression) && node.expression.text === "process";
  }
  return false;
}

function isEnvDocumented(root: string, name: string): boolean {
  for (const file of ["README.md", "docs/README.md", "docs/architecture.md"]) {
    const path = join(root, file);
    if (existsSync(path) && readFileSync(path, "utf8").includes(name)) return true;
  }
  return false;
}

function normalizeAst(node: ts.Node): string {
  const parts: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      parts.push("Identifier");
      return;
    }
    if (ts.isStringLiteral(current) || ts.isNumericLiteral(current) || current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) {
      parts.push("Literal");
      return;
    }
    parts.push(ts.SyntaxKind[current.kind] ?? String(current.kind));
    ts.forEachChild(current, visit);
  };
  visit(node);
  return parts.join(" ");
}

function finding(input: Omit<DreamFinding, "id" | "sourceScan" | "stableKey">): DreamFinding {
  const primary = input.evidence[0]?.path ?? "unknown";
  const stable = stableKey([input.kind, input.title, primary, ...input.evidence.map((item) => item.path)]);
  return {
    id: "DS-000",
    ...input,
    sourceScan: "dream-structure",
    stableKey: `dream-structure:${input.kind}:${stable}`,
  };
}

function compareFindings(a: DreamFinding, b: DreamFinding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
    a.kind.localeCompare(b.kind) ||
    a.stableKey.localeCompare(b.stableKey)
  );
}

function stableKey(parts: readonly string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 12);
}

function flattenDiagnostic(diagnostic: ts.Diagnostic): StaticDiagnostic {
  return {
    code: diagnostic.code,
    path: diagnostic.file?.fileName,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

function isTestPath(path: string): boolean {
  return /\.test\.|\.spec\.|\/test\//.test(path);
}

function spanOf(node: ts.Node): TextSpan {
  const start = Math.max(0, node.pos);
  return { start, length: Math.max(0, node.end - start) };
}
