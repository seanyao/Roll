/**
 * @responsibility Diagnoses an existing project to plan init or onboard actions.
 */
import { spawnSync } from "node:child_process";
import { existsSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Lang } from "@roll/spec";
import { detectDesignHandoff } from "./onboard-nudge.js";
import { renderInitRecommendation } from "./init-diagnosis-render.js";

export type InitProjectKind =
  | "roll-ready"
  | "roll-partial"
  | "roll-legacy-layout"
  | "codebase-no-roll"
  | "prd-only"
  | "empty"
  | "ambiguous";

export type InitRecommendedPath =
  | "repair-roll"
  | "agentic-onboard"
  | "scaffold-from-prd"
  | "guided-brief"
  | "migrate-roll-layout"
  | "already-ready";

export interface InitContentScan {
  hasContent: boolean;
  extractedSignals: string[];
}

export interface InitScanDeps {
  contentScan?: (projectDir: string) => InitContentScan;
  ignoreOnboardArtifacts?: boolean;
}

export interface InitFacts {
  root: string;
  git: { present: boolean; commits: number; branch?: string };
  roll: {
    dotRoll: boolean;
    backlog: boolean;
    features: boolean;
    agentsDoc: boolean;
    oldMarkers: string[];
  };
  codebase: {
    manifests: string[];
    sourceDirs: string[];
    testDirs: string[];
    sourceFileCount: number;
  };
  docs: {
    hasContent: boolean;
    prdFiles: string[];
    readmeFiles: string[];
    designDocs: string[];
    extractedSignals: string[];
  };
  ambiguityReasons: string[];
}

export interface InitOwnerChoice {
  label: string;
  path: InitRecommendedPath;
  nextCommand: string;
}

export interface InitDiagnosis {
  kind: InitProjectKind;
  confidence: "high" | "medium" | "low";
  recommendedPath: InitRecommendedPath;
  reasons: string[];
  ownerChoices: InitOwnerChoice[];
  nextCommand: string;
}

export interface InitExecutionOptions {
  projectDir: string;
  autoMode?: boolean;
}

export interface InitRouteDecision {
  path: InitRecommendedPath;
  mutates: boolean;
  nextCommand: string;
}

const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "app.json",
  "project.config.json",
  "mix.exs",
  "composer.json",
  "deno.json",
  "deno.jsonc",
] as const;

const SOURCE_DIRS = ["src", "app", "lib", "pkg", "cmd", "server", "api", "backend", "components", "pages"] as const;
const TEST_DIRS = ["test", "tests", "__tests__", "spec", "e2e", "cypress"] as const;
const OLD_ROLL_MARKERS = [
  "BACKLOG.md",
  "PROPOSALS.md",
  "docs/features.md",
  "docs/features/",
  "docs/briefs/",
  "docs/dream/",
  "docs/practices/loop-autorun-verification.md",
] as const;
const DOC_ROOTS = ["README.md", "README", "readme.md", "prd.md", "PRD.md", "spec.md", "SPEC.md", "requirements.md", "REQUIREMENTS.md"] as const;
const DOC_DIRS = ["docs", "doc", "spec", "specs", "prd", "requirements"] as const;
const ONBOARD_ONLY_DOT_ROLL_ENTRIES = new Set(["init-diagnosis.yaml", "onboard-plan.yaml"]);
const MAX_DOCS = 16;
const MAX_DOC_BYTES = 256_000;
const MAX_SOURCE_FILES = 200;
const MAX_SOURCE_DIR_ENTRIES = 512;
const MAX_DOC_CANDIDATES = 64;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sortedExisting(paths: readonly string[], root: string, dirsOnly = false): string[] {
  return paths.filter((rel) => (dirsOnly || rel.endsWith("/") ? isDir(join(root, rel)) : existsSync(join(root, rel)))).sort();
}

function sortedDirectoryEntries(dir: string, cap: number): { entries: string[]; capped: boolean; unreadable: boolean } {
  let handle: ReturnType<typeof opendirSync>;
  try {
    handle = opendirSync(dir);
  } catch {
    return { entries: [], capped: false, unreadable: true };
  }
  try {
    const entries: string[] = [];
    while (entries.length < cap) {
      const entry = handle.readSync();
      if (entry === null) return { entries: entries.sort(), capped: false, unreadable: false };
      entries.push(entry.name);
    }
    return { entries: entries.sort(), capped: handle.readSync() !== null, unreadable: false };
  } finally {
    handle.closeSync();
  }
}

function gitFacts(projectDir: string): InitFacts["git"] {
  const present = existsSync(join(projectDir, ".git"));
  if (!present) return { present: false, commits: 0 };
  const count = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: projectDir, encoding: "utf8" });
  const commits = count.status === 0 ? Number.parseInt((count.stdout ?? "0").trim(), 10) : 0;
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf8" });
  const branchName = branch.status === 0 ? (branch.stdout ?? "").trim() : "";
  return {
    present: true,
    commits: Number.isFinite(commits) ? commits : 0,
    ...(branchName !== "" ? { branch: branchName } : {}),
  };
}

function countFiles(root: string, remainingDepth: number, cap: number): { count: number; fileCapped: boolean; entryCapped: boolean } {
  let count = 0;
  let fileCapped = false;
  let entryCapped = false;
  const walk = (dir: string, depth: number): void => {
    if (count >= cap) {
      fileCapped = true;
      return;
    }
    const listed = sortedDirectoryEntries(dir, MAX_SOURCE_DIR_ENTRIES);
    entryCapped = entryCapped || listed.capped;
    for (const entry of listed.entries) {
      if (count >= cap) {
        fileCapped = true;
        return;
      }
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth > 0) walk(path, depth - 1);
        continue;
      }
      if (st.isFile() && st.size > 0) count += 1;
    }
  };
  walk(root, remainingDepth);
  return { count, fileCapped, entryCapped };
}

function hasProjectIntent(text: string): boolean {
  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("<!--"))
    .slice(0, 12)
    .join(" ");
  if (normalized.length < 20) return false;
  return /project|product|app|service|cli|library|tool|platform|domain|feature|requirement|spec|prd|用户|产品|项目|需求|功能|服务|工具|平台/i.test(
    normalized,
  );
}

function addDocSignal(projectDir: string, rel: string, docs: Omit<InitFacts["docs"], "hasContent" | "extractedSignals">, ambiguityReasons: string[]): void {
  if (docs.prdFiles.length + docs.readmeFiles.length + docs.designDocs.length >= MAX_DOCS) {
    if (!ambiguityReasons.includes("document scan capped at 16 files")) ambiguityReasons.push("document scan capped at 16 files");
    return;
  }
  const path = join(projectDir, rel);
  if (!isFile(path)) return;
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.size <= 0) return;
  if (st.size > MAX_DOC_BYTES) {
    ambiguityReasons.push(`skipped large document: ${rel}`);
    return;
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    ambiguityReasons.push(`unreadable document: ${rel}`);
    return;
  }
  if (!hasProjectIntent(text)) {
    if (/^readme(?:\.md)?$/i.test(rel)) ambiguityReasons.push(`${rel} exists but has no project intent`);
    return;
  }
  if (/(?:^|\/|[-_.])(?:prd|requirements?|spec)(?:[-_.\/]|$)/i.test(rel)) {
    if (!docs.prdFiles.includes(rel)) docs.prdFiles.push(rel);
  } else if (/(?:^|\/|[-_.])(?:design|rfc)(?:[-_.\/]|$)/i.test(rel)) {
    if (!docs.designDocs.includes(rel)) docs.designDocs.push(rel);
  } else if (/^readme(?:\.md)?$/i.test(rel)) {
    if (!docs.readmeFiles.includes(rel)) docs.readmeFiles.push(rel);
  }
}

function collectDocs(projectDir: string, ambiguityReasons: string[]): Omit<InitFacts["docs"], "hasContent" | "extractedSignals"> {
  const docs = { prdFiles: [] as string[], readmeFiles: [] as string[], designDocs: [] as string[] };
  const seen = new Set<string>();
  const add = (rel: string): void => {
    try {
      const real = realpathSync(join(projectDir, rel)).toLowerCase();
      if (seen.has(real)) return;
      seen.add(real);
    } catch {
      return;
    }
    addDocSignal(projectDir, rel, docs, ambiguityReasons);
  };
  for (const rel of DOC_ROOTS) add(rel);
  for (const dir of DOC_DIRS) {
    const root = join(projectDir, dir);
    if (!isDir(root)) continue;
    const listed = sortedDirectoryEntries(root, MAX_DOC_CANDIDATES);
    if (listed.unreadable) {
      ambiguityReasons.push(`unreadable document directory: ${dir}/`);
      continue;
    }
    if (listed.capped) ambiguityReasons.push(`document candidate scan capped at ${MAX_DOC_CANDIDATES} entries: ${dir}/`);
    for (const entry of listed.entries) {
      if (!/\.(md|mdx|txt)$/i.test(entry)) continue;
      add(join(dir, entry));
    }
  }
  docs.prdFiles.sort();
  docs.readmeFiles.sort();
  docs.designDocs.sort();
  return docs;
}

function defaultContentScan(projectDir: string): InitContentScan {
  const signal = detectDesignHandoff(projectDir) as { materialPresent: boolean; hasContent?: boolean; extractedSignals?: string[] };
  return {
    hasContent: signal.hasContent ?? signal.materialPresent,
    extractedSignals: signal.extractedSignals ?? [],
  };
}

export function collectInitFacts(projectDir: string, deps: InitScanDeps = {}): InitFacts {
  const ambiguityReasons: string[] = [];
  const dotRoll = isDir(join(projectDir, ".roll"));
  let dotRollMarker = dotRoll;
  if (dotRoll && deps.ignoreOnboardArtifacts === true) {
    const listed = sortedDirectoryEntries(join(projectDir, ".roll"), MAX_SOURCE_DIR_ENTRIES);
    dotRollMarker = listed.unreadable || listed.capped || listed.entries.some((entry) => !ONBOARD_ONLY_DOT_ROLL_ENTRIES.has(entry));
  }
  const roll = {
    dotRoll: dotRollMarker,
    backlog: isFile(join(projectDir, ".roll", "backlog.md")),
    features: isDir(join(projectDir, ".roll", "features")),
    agentsDoc: isFile(join(projectDir, "AGENTS.md")),
    oldMarkers: sortedExisting(OLD_ROLL_MARKERS, projectDir),
  };
  if (roll.dotRoll || roll.backlog || roll.features || roll.agentsDoc || roll.oldMarkers.length > 0) {
    return {
      root: projectDir,
      git: { present: existsSync(join(projectDir, ".git")), commits: 0 },
      roll,
      codebase: { manifests: [], sourceDirs: [], testDirs: [], sourceFileCount: 0 },
      docs: { hasContent: false, prdFiles: [], readmeFiles: [], designDocs: [], extractedSignals: [] },
      ambiguityReasons,
    };
  }
  const sourceDirs = sortedExisting(SOURCE_DIRS, projectDir, true);
  let sourceFileCount = 0;
  for (const dir of sourceDirs) {
    const counted = countFiles(join(projectDir, dir), 4, MAX_SOURCE_FILES - sourceFileCount);
    sourceFileCount += counted.count;
    if (counted.entryCapped) ambiguityReasons.push(`source directory scan capped at ${MAX_SOURCE_DIR_ENTRIES} entries: ${dir}/`);
    if (counted.fileCapped) {
      ambiguityReasons.push(`source file scan capped at ${MAX_SOURCE_FILES} files`);
      break;
    }
    if (counted.entryCapped) break;
  }
  const docSignals = collectDocs(projectDir, ambiguityReasons);
  const contentScan = deps.contentScan?.(projectDir) ?? defaultContentScan(projectDir);
  return {
    root: projectDir,
    git: gitFacts(projectDir),
    roll,
    codebase: {
      manifests: sortedExisting(MANIFESTS, projectDir),
      sourceDirs,
      testDirs: sortedExisting(TEST_DIRS, projectDir, true),
      sourceFileCount,
    },
    docs: {
      hasContent:
        contentScan.hasContent ||
        docSignals.prdFiles.length > 0 ||
        docSignals.readmeFiles.length > 0 ||
        docSignals.designDocs.length > 0,
      ...docSignals,
      extractedSignals: [...contentScan.extractedSignals].sort(),
    },
    ambiguityReasons: [...new Set(ambiguityReasons)].sort(),
  };
}

function diagnosis(
  kind: InitProjectKind,
  recommendedPath: InitRecommendedPath,
  nextCommand: string,
  reasons: string[],
  confidence: InitDiagnosis["confidence"] = "high",
  ownerChoices: InitOwnerChoice[] = [],
): InitDiagnosis {
  return { kind, confidence, recommendedPath, reasons, ownerChoices, nextCommand };
}

function hasCurrentRollMarker(facts: InitFacts): boolean {
  return facts.roll.dotRoll || facts.roll.agentsDoc || facts.roll.backlog || facts.roll.features;
}

function hasCodebaseSignal(facts: InitFacts): boolean {
  return (
    facts.codebase.manifests.length > 0 ||
    facts.codebase.sourceFileCount > 0
  );
}

function hasDocSignal(facts: InitFacts): boolean {
  return (
    facts.docs.hasContent ||
    facts.docs.extractedSignals.length > 0 ||
    facts.docs.prdFiles.length > 0 ||
    facts.docs.readmeFiles.length > 0 ||
    facts.docs.designDocs.length > 0
  );
}

export function classifyInitState(facts: InitFacts): InitDiagnosis {
  if (hasCurrentRollMarker(facts)) {
    if (facts.roll.dotRoll && facts.roll.agentsDoc && facts.roll.backlog && facts.roll.features) {
      return diagnosis("roll-ready", "already-ready", "roll status", ["Roll markers are complete: .roll/, AGENTS.md, backlog, and features."]);
    }
    return diagnosis("roll-partial", "repair-roll", "roll init --repair", ["Roll markers are present but incomplete; repair before scaffolding."], "medium");
  }
  if (facts.roll.oldMarkers.length > 0) {
    return diagnosis(
      "roll-legacy-layout",
      "migrate-roll-layout",
      "npx @seanyao/roll@2 migrate --dry-run",
      [`Old Roll layout marker(s): ${facts.roll.oldMarkers.join(", ")}.`],
      "medium",
    );
  }
  if (hasCodebaseSignal(facts)) {
    return diagnosis("codebase-no-roll", "agentic-onboard", "$roll-onboard", ["Existing source, tests, or manifests found without Roll markers."]);
  }
  if (hasDocSignal(facts)) {
    return diagnosis(
      "prd-only",
      "scaffold-from-prd",
      "$roll-design",
      ["Product or requirements documents found without source/manifests."],
    );
  }
  if (facts.ambiguityReasons.length > 0) {
    return diagnosis(
      "ambiguous",
      "agentic-onboard",
      "roll init",
      facts.ambiguityReasons,
      "low",
      [
        { label: "Treat as existing codebase", path: "agentic-onboard", nextCommand: "$roll-onboard" },
        { label: "Treat as new project", path: "guided-brief", nextCommand: "roll init" },
      ],
    );
  }
  return diagnosis("empty", "guided-brief", "roll init", ["No Roll, codebase, or product-document signals found."]);
}

export function shouldRunAgenticDiagnosis(diagnosisResult: InitDiagnosis): boolean {
  return diagnosisResult.kind === "codebase-no-roll" || diagnosisResult.kind === "ambiguous";
}

export function executeInitPath(path: InitRecommendedPath, _opts: InitExecutionOptions): InitRouteDecision {
  switch (path) {
    case "already-ready":
      return { path, mutates: false, nextCommand: "roll status" };
    case "repair-roll":
      return { path, mutates: false, nextCommand: "roll init --repair" };
    case "migrate-roll-layout":
      return { path, mutates: false, nextCommand: "npx @seanyao/roll@2 migrate --dry-run" };
    case "agentic-onboard":
      return { path, mutates: false, nextCommand: "$roll-onboard" };
    case "scaffold-from-prd":
      return { path, mutates: true, nextCommand: "roll design" };
    case "guided-brief":
      return { path, mutates: true, nextCommand: "roll design" };
  }
}

function fixtureFacts(kind: InitProjectKind): InitFacts {
  const base: InitFacts = {
    root: `<fixture:${kind}>`,
    git: { present: false, commits: 0 },
    roll: { dotRoll: false, backlog: false, features: false, agentsDoc: false, oldMarkers: [] },
    codebase: { manifests: [], sourceDirs: [], testDirs: [], sourceFileCount: 0 },
    docs: { hasContent: false, prdFiles: [], readmeFiles: [], designDocs: [], extractedSignals: [] },
    ambiguityReasons: [],
  };
  switch (kind) {
    case "roll-ready":
      return { ...base, roll: { dotRoll: true, backlog: true, features: true, agentsDoc: true, oldMarkers: [] } };
    case "roll-partial":
      return { ...base, roll: { dotRoll: true, backlog: true, features: false, agentsDoc: false, oldMarkers: [] } };
    case "roll-legacy-layout":
      return { ...base, roll: { dotRoll: false, backlog: false, features: false, agentsDoc: false, oldMarkers: ["BACKLOG.md"] } };
    case "codebase-no-roll":
      return { ...base, codebase: { manifests: ["package.json"], sourceDirs: ["src"], testDirs: ["test"], sourceFileCount: 12 } };
    case "prd-only":
      return { ...base, docs: { hasContent: true, prdFiles: ["docs/PRD.md"], readmeFiles: [], designDocs: [], extractedSignals: ["docs/PRD.md"] } };
    case "empty":
      return base;
    case "ambiguous":
      return { ...base, ambiguityReasons: ["README.md exists but has no project intent"] };
  }
}

export function renderStateMatrixFixture(lang: Lang): string {
  const kinds: InitProjectKind[] = [
    "roll-ready",
    "roll-partial",
    "roll-legacy-layout",
    "codebase-no-roll",
    "prd-only",
    "empty",
    "ambiguous",
  ];
  const lines = ["roll init diagnosis fixture: state-matrix", ""];
  for (const kind of kinds) {
    lines.push(renderInitRecommendation(classifyInitState(fixtureFacts(kind)), lang));
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
