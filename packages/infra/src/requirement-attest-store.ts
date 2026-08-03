import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  deriveIssueCompletion,
  renderFinalRequirementAttest,
  type RequirementAttestStory,
} from "@roll/core";
import {
  parseIssueManifest,
  parseRequirementSourceManifest,
  parseWorkspaceManifest,
  isSafeIssueEvidencePath,
  type IssueIntegrationAcceptanceEvidence,
  type RequirementSourceManifest,
} from "@roll/spec";
import { auditRequirementArchive } from "./requirement-archive-audit.js";
import { readIssueCompletionEvidence } from "./issue-completion-store.js";

export type RequirementAttestStoreErrorCode =
  | "unsafe_requirement_path"
  | "invalid_requirement"
  | "unsafe_issue_evidence"
  | "invalid_issue_evidence"
  | "concurrent_rebuild"
  | "io_failure";

export class RequirementAttestStoreError extends Error {
  constructor(readonly code: RequirementAttestStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequirementAttestStoreError";
  }
}

export interface RequirementAttestStoreInput {
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly requirementId: string;
}

export interface RequirementAttestStoreResult {
  readonly status: "pass" | "partial" | "blocked";
  readonly path: string;
  readonly content: string;
}

export interface RequirementAttestStoreDependencies {
  readonly beforeIssueRevalidation?: () => void;
}

interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface EvidenceScan {
  readonly paths: readonly string[];
  readonly fingerprint: string;
}

const MAX_EVIDENCE_ENTRIES = 10_000;
const MAX_EVIDENCE_DEPTH = 32;

function fail(code: RequirementAttestStoreErrorCode, message: string, cause?: unknown): never {
  throw new RequirementAttestStoreError(code, message, cause === undefined ? undefined : { cause });
}

function identity(stat: Stats): NodeIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeSegment(value: string, pattern: RegExp): boolean {
  return value === value.trim() && pattern.test(value);
}

function anchoredDirectory(path: string, root?: string): NodeIdentity {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== resolve(path)) {
      return fail("unsafe_requirement_path", "Requirement attest path must use real contained directories");
    }
    if (root !== undefined && !contained(root, path)) {
      return fail("unsafe_requirement_path", "Requirement attest path escapes the Workspace");
    }
    return identity(stat);
  } catch (error) {
    if (error instanceof RequirementAttestStoreError) throw error;
    return fail("unsafe_requirement_path", "Requirement attest path could not be anchored", error);
  }
}

function resolveRoots(input: RequirementAttestStoreInput): {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly requirementRoot: string;
  readonly requirementAnchor: NodeIdentity;
} {
  if (!safeSegment(input.provider, /^[a-z][a-z0-9_]*$/u) ||
    !safeSegment(input.requirementId, /^req-[0-9a-f]{12}$/u)) {
    return fail("unsafe_requirement_path", "Requirement attest identity is invalid");
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(resolve(input.workspaceRoot));
  } catch (error) {
    return fail("unsafe_requirement_path", "Workspace root could not be resolved", error);
  }
  anchoredDirectory(workspaceRoot);
  const workspacePath = join(workspaceRoot, "workspace.yaml");
  let workspaceId: string;
  try {
    const stat = lstatSync(workspacePath);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(workspacePath) !== workspacePath) {
      return fail("invalid_requirement", "Workspace authority is unsafe");
    }
    const parsed = parseWorkspaceManifest(JSON.parse(readFileSync(workspacePath, "utf8")));
    if (!parsed.ok) return fail("invalid_requirement", "Workspace authority is invalid");
    workspaceId = parsed.value.workspaceId;
  } catch (error) {
    if (error instanceof RequirementAttestStoreError) throw error;
    return fail("invalid_requirement", "Workspace authority could not be read", error);
  }
  const requirementRoot = join(workspaceRoot, "requirements", input.provider, input.requirementId);
  const requirementAnchor = anchoredDirectory(requirementRoot, workspaceRoot);
  return { workspaceRoot, workspaceId, requirementRoot, requirementAnchor };
}

function readManifest(requirementRoot: string, input: RequirementAttestStoreInput): RequirementSourceManifest {
  try {
    const sourcePath = join(requirementRoot, "source.yaml");
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(sourcePath) !== sourcePath) {
      return fail("invalid_requirement", "Requirement source authority is unsafe");
    }
    const parsed = parseRequirementSourceManifest(JSON.parse(readFileSync(sourcePath, "utf8")));
    if (!parsed.ok || parsed.value.provider !== input.provider || parsed.value.requirementId !== input.requirementId) {
      return fail("invalid_requirement", "Requirement source authority is invalid");
    }
    return parsed.value;
  } catch (error) {
    if (error instanceof RequirementAttestStoreError) throw error;
    return fail("invalid_requirement", "Requirement source authority could not be read", error);
  }
}

function scanEvidence(root: string, relativeRoot = "", depth = 0, entries: string[] = []): EvidenceScan {
  if (depth > MAX_EVIDENCE_DEPTH || entries.length > MAX_EVIDENCE_ENTRIES) {
    return fail("unsafe_issue_evidence", "Issue evidence exceeds its bounded discovery contract");
  }
  const fingerprints: string[] = [];
  for (const entry of readdirSync(join(root, relativeRoot), { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const relativePath = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    if (!isSafeIssueEvidencePath(`evidence/${relativePath}`)) {
      return fail("unsafe_issue_evidence", "Issue evidence path cannot be represented safely in Requirement attestation");
    }
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      return fail("unsafe_issue_evidence", "Issue evidence contains a symbolic link or special file");
    }
    if (realpathSync(path) !== path || !contained(root, path)) {
      return fail("unsafe_issue_evidence", "Issue evidence escapes its Issue-owned directory");
    }
    entries.push(relativePath);
    if (entries.length > MAX_EVIDENCE_ENTRIES) {
      return fail("unsafe_issue_evidence", "Issue evidence exceeds its bounded discovery contract");
    }
    const node = identity(stat);
    fingerprints.push(`${relativePath}\0${node.dev}\0${node.ino}\0${node.size}\0${node.mtimeMs}\0${node.ctimeMs}`);
    if (stat.isDirectory()) {
      const child = scanEvidence(root, relativePath, depth + 1, entries);
      fingerprints.push(child.fingerprint);
    }
  }
  return {
    paths: entries.filter((path) => lstatSync(join(root, path)).isFile()).map((path) => `evidence/${path}`).sort(),
    fingerprint: fingerprints.join("\n"),
  };
}

function matchingAcceptanceArtifact(
  acceptances: readonly IssueIntegrationAcceptanceEvidence[],
  mergeCommits: Readonly<Record<string, string>>,
): string | undefined {
  return acceptances
    .filter((acceptance) => acceptance.verdict === "pass" &&
      JSON.stringify(Object.entries(acceptance.inputMergeCommits).sort()) === JSON.stringify(Object.entries(mergeCommits).sort()))
    .sort((left, right) => left.recordedAt - right.recordedAt)
    .at(-1)?.artifactPath;
}

function readStory(workspaceRoot: string, workspaceId: string, storyId: string): {
  readonly story: RequirementAttestStory;
  readonly evidenceRoot?: string;
  readonly evidenceFingerprint?: string;
} | undefined {
  const issueRoot = join(workspaceRoot, "issues", storyId);
  if (!existsSync(issueRoot)) return undefined;
  try {
    const issueStat = lstatSync(issueRoot);
    if (issueStat.isSymbolicLink() || !issueStat.isDirectory() || realpathSync(issueRoot) !== issueRoot ||
      dirname(issueRoot) !== join(workspaceRoot, "issues")) {
      return fail("unsafe_issue_evidence", `Issue ${storyId} is not a contained Workspace Issue`);
    }
    const manifestPath = join(issueRoot, "manifest.json");
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || realpathSync(manifestPath) !== manifestPath) {
      return fail("invalid_issue_evidence", `Issue ${storyId} manifest is unsafe`);
    }
    const parsed = parseIssueManifest(JSON.parse(readFileSync(manifestPath, "utf8")), { workspaceId, storyId });
    if (!parsed.ok) {
      return fail("invalid_issue_evidence", `Issue ${storyId} manifest is invalid`);
    }
    const collection = readIssueCompletionEvidence(issueRoot);
    const completion = deriveIssueCompletion({
      workspaceId: parsed.value.workspaceId,
      storyId,
      repositories: parsed.value.repositories.map((repository) => ({
        repoId: repository.repoId,
        required: repository.requiredDelivery,
      })),
      repositoryFacts: collection.repositoryFacts,
      integrationAcceptances: collection.integrationAcceptances,
      backlogDone: false,
    });
    const evidenceRoot = join(issueRoot, "evidence");
    if (!existsSync(evidenceRoot)) {
      return { story: { storyId, state: completion.state, mergeCommits: completion.mergeCommits, evidencePaths: [] } };
    }
    const evidenceStat = lstatSync(evidenceRoot);
    if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory() || realpathSync(evidenceRoot) !== evidenceRoot) {
      return fail("unsafe_issue_evidence", `Issue ${storyId} evidence root is unsafe`);
    }
    const scan = scanEvidence(evidenceRoot);
    const artifactPath = matchingAcceptanceArtifact(collection.integrationAcceptances, completion.mergeCommits);
    const evidencePaths = artifactPath === undefined || !scan.paths.includes(artifactPath) ? [] : scan.paths;
    return {
      story: { storyId, state: completion.state, mergeCommits: completion.mergeCommits, evidencePaths },
      evidenceRoot,
      evidenceFingerprint: scan.fingerprint,
    };
  } catch (error) {
    if (error instanceof RequirementAttestStoreError) throw error;
    return fail("invalid_issue_evidence", `Issue ${storyId} evidence could not be read`, error);
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    return fail("io_failure", "Requirement attest projection could not be written", error);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function storyReadSignature(stories: readonly {
  readonly story: RequirementAttestStory;
  readonly evidenceFingerprint?: string;
}[]): string {
  return JSON.stringify(stories.map((story) => ({
    story: story.story,
    evidenceFingerprint: story.evidenceFingerprint ?? null,
  })));
}

export function rebuildRequirementAttest(
  input: RequirementAttestStoreInput,
  deps: RequirementAttestStoreDependencies = {},
): RequirementAttestStoreResult {
  const roots = resolveRoots(input);
  const manifest = readManifest(roots.requirementRoot, input);
  const auditBefore = auditRequirementArchive(input);
  const storyReads = auditBefore.status === "healthy"
    ? manifest.stories.map((storyId) => readStory(roots.workspaceRoot, roots.workspaceId, storyId)).filter((story) => story !== undefined)
    : [];
  deps.beforeIssueRevalidation?.();
  const storyReadsAfter = auditBefore.status === "healthy"
    ? manifest.stories.map((storyId) => readStory(roots.workspaceRoot, roots.workspaceId, storyId)).filter((story) => story !== undefined)
    : [];
  if (storyReadSignature(storyReadsAfter) !== storyReadSignature(storyReads)) {
    return fail("concurrent_rebuild", "Issue completion or evidence changed during Requirement attest rebuild");
  }
  const auditAfter = auditRequirementArchive(input);
  if (JSON.stringify(auditAfter) !== JSON.stringify(auditBefore)) {
    return fail("concurrent_rebuild", "Requirement archive changed during attestation rebuild");
  }
  const currentAnchor = anchoredDirectory(roots.requirementRoot, roots.workspaceRoot);
  if (!sameIdentity(roots.requirementAnchor, currentAnchor)) {
    return fail("concurrent_rebuild", "Requirement directory changed during attestation rebuild");
  }
  const projection = renderFinalRequirementAttest({
    manifest,
    archiveAudit: auditAfter,
    stories: storyReadsAfter.map((story) => story.story),
  });
  const path = join(roots.requirementRoot, "attest.md");
  atomicWrite(path, projection.content);
  return { ...projection, path };
}

export function removeRequirementAttestProjection(input: RequirementAttestStoreInput): void {
  const roots = resolveRoots(input);
  const path = join(roots.requirementRoot, "attest.md");
  try {
    rmSync(path, { force: true });
  } catch (error) {
    return fail("io_failure", "Requirement attest projection could not be removed", error);
  }
}
