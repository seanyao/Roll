import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  ISSUE_INTEGRATION_ACCEPTANCE_EVIDENCE_RECORDED,
  REPOSITORY_MERGE_EVIDENCE_RECORDED,
  integrationAcceptanceCommandDigest,
  isImmutableGitObjectId,
  isSafeIssueEvidencePath,
  parseIssueManifest,
  type IssueIntegrationAcceptanceEvidence,
  type IssueIntegrationAcceptanceEvidenceRecordedEvent,
  type IssueManifest,
  type RepositoryMergeEvidence,
  type RepositoryMergeEvidenceRecordedEvent,
} from "@roll/spec";
import { appendIssueEventAtomically } from "./issue-worktrees.js";

export interface IssueCompletionEvidenceCollection {
  readonly repositoryFacts: readonly RepositoryMergeEvidence[];
  readonly integrationAcceptances: readonly IssueIntegrationAcceptanceEvidence[];
}

export class IssueCompletionEvidenceError extends Error {}

function readIssueManifest(issueRoot: string): IssueManifest {
  const path = join(issueRoot, "manifest.json");
  if (!existsSync(path)) throw new IssueCompletionEvidenceError(`Issue manifest is missing: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new IssueCompletionEvidenceError(`Issue manifest is corrupted: ${(error as Error).message}`);
  }
  const parsed = parseIssueManifest(raw);
  if (!parsed.ok) {
    throw new IssueCompletionEvidenceError(`Issue manifest is invalid: ${parsed.errors.map((error) => `${error.path}:${error.code}`).join(", ")}`);
  }
  return parsed.value;
}

function assertRepositoryIssueIdentity(manifest: IssueManifest, evidence: RepositoryMergeEvidence): void {
  if (evidence.workspaceId !== manifest.workspaceId || evidence.storyId !== manifest.storyId) {
    throw new IssueCompletionEvidenceError("repository merge evidence does not match the Issue identity");
  }
  if (!manifest.repositories.some((repository) => repository.repoId === evidence.repoId)) {
    throw new IssueCompletionEvidenceError(`repository merge evidence names undeclared repoId: ${evidence.repoId}`);
  }
}

function assertAcceptanceIssueIdentity(manifest: IssueManifest, evidence: IssueIntegrationAcceptanceEvidence): void {
  if (evidence.workspaceId !== manifest.workspaceId || evidence.storyId !== manifest.storyId) {
    throw new IssueCompletionEvidenceError("integration acceptance evidence does not match the Issue identity");
  }
  if (manifest.integrationAcceptance === undefined ||
    evidence.commandDigest !== integrationAcceptanceCommandDigest(manifest.integrationAcceptance.command)) {
    throw new IssueCompletionEvidenceError("integration acceptance command identity does not match the Issue manifest");
  }
  const expectedRepoIds = manifest.repositories
    .filter((repository) => repository.requiredDelivery)
    .map((repository) => repository.repoId)
    .sort();
  const actualRepoIds = Object.keys(evidence.inputMergeCommits).sort();
  if (JSON.stringify(actualRepoIds) !== JSON.stringify(expectedRepoIds)) {
    throw new IssueCompletionEvidenceError("integration acceptance merge inputs do not match the required repository set");
  }
}

function assertAcceptanceArtifact(issueRoot: string, evidence: IssueIntegrationAcceptanceEvidence): void {
  try {
    const canonicalIssueRoot = realpathSync(issueRoot);
    const artifactPath = join(canonicalIssueRoot, evidence.artifactPath);
    const stat = lstatSync(artifactPath);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(artifactPath) !== artifactPath) {
      throw new IssueCompletionEvidenceError("integration acceptance artifact must be an Issue-owned regular file");
    }
  } catch (error) {
    if (error instanceof IssueCompletionEvidenceError) throw error;
    throw new IssueCompletionEvidenceError("integration acceptance artifact is missing or unsafe");
  }
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  const value = record(raw);
  if (value === undefined) throw new IssueCompletionEvidenceError(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new IssueCompletionEvidenceError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IssueCompletionEvidenceError(`${label} must be a finite number`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requireFiniteNumber(value, label);
}

function optionalMergeCommit(value: unknown, label: string): string | undefined {
  const mergeCommit = optionalString(value, label);
  if (mergeCommit !== undefined && !isImmutableGitObjectId(mergeCommit)) {
    throw new IssueCompletionEvidenceError(`${label} must be a full lowercase immutable Git object id`);
  }
  return mergeCommit;
}

function assertClosed(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new IssueCompletionEvidenceError(`${label} contains unsupported keys: ${unexpected.sort().join(", ")}`);
  }
}

const REPOSITORY_IDENTITY_KEYS = [
  "type",
  "ts",
  "workspaceId",
  "storyId",
  "repoId",
  "cycleId",
  "authority",
  "recordedAt",
] as const;

function repositoryIdentity(value: Record<string, unknown>): {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repoId: string;
  readonly cycleId: string;
  readonly recordedAt: number;
  readonly ts: number;
} {
  const recordedAt = requireFiniteNumber(value["recordedAt"], "repository evidence recordedAt");
  const ts = requireFiniteNumber(value["ts"], "repository evidence ts");
  if (ts !== recordedAt) throw new IssueCompletionEvidenceError("repository evidence ts must equal recordedAt");
  return {
    workspaceId: requireString(value["workspaceId"], "repository evidence workspaceId"),
    storyId: requireString(value["storyId"], "repository evidence storyId"),
    repoId: requireString(value["repoId"], "repository evidence repoId"),
    cycleId: requireString(value["cycleId"], "repository evidence cycleId"),
    recordedAt,
    ts,
  };
}

function validateRepositoryEvent(raw: unknown): RepositoryMergeEvidenceRecordedEvent {
  const value = requireRecord(raw, "repository merge evidence event");
  if (value["type"] !== REPOSITORY_MERGE_EVIDENCE_RECORDED) {
    throw new IssueCompletionEvidenceError("repository merge evidence event has an invalid type");
  }
  const identity = repositoryIdentity(value);
  const authority = value["authority"];
  if (authority === "provider") {
    assertClosed(value, new Set([...REPOSITORY_IDENTITY_KEYS, "prNumber", "prUrl", "prState", "ci", "mergeCommit", "mergedAt"]), "provider merge evidence");
    const prNumber = optionalFiniteNumber(value["prNumber"], "provider prNumber");
    if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber <= 0)) {
      throw new IssueCompletionEvidenceError("provider prNumber must be a positive integer");
    }
    const prState = value["prState"];
    if (prState !== "OPEN" && prState !== "MERGED" && prState !== "CLOSED" && prState !== "UNKNOWN") {
      throw new IssueCompletionEvidenceError("provider prState is invalid");
    }
    const ci = value["ci"];
    if (ci !== "green" && ci !== "red" && ci !== "pending" && ci !== "unknown") {
      throw new IssueCompletionEvidenceError("provider ci is invalid");
    }
    const prUrl = optionalString(value["prUrl"], "provider prUrl");
    const mergeCommit = optionalMergeCommit(value["mergeCommit"], "provider mergeCommit");
    const mergedAt = optionalFiniteNumber(value["mergedAt"], "provider mergedAt");
    return {
      type: REPOSITORY_MERGE_EVIDENCE_RECORDED,
      ...identity,
      authority,
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(prUrl === undefined ? {} : { prUrl }),
      prState,
      ci,
      ...(mergeCommit === undefined ? {} : { mergeCommit }),
      ...(mergedAt === undefined ? {} : { mergedAt }),
    };
  }
  if (authority === "integration_branch") {
    assertClosed(value, new Set([...REPOSITORY_IDENTITY_KEYS, "reachable", "mergeCommit"]), "integration-branch merge evidence");
    if (typeof value["reachable"] !== "boolean") {
      throw new IssueCompletionEvidenceError("integration-branch reachable must be boolean");
    }
    const mergeCommit = optionalMergeCommit(value["mergeCommit"], "integration-branch mergeCommit");
    return {
      type: REPOSITORY_MERGE_EVIDENCE_RECORDED,
      ...identity,
      authority,
      reachable: value["reachable"],
      ...(mergeCommit === undefined ? {} : { mergeCommit }),
    };
  }
  if (authority === "projection") {
    assertClosed(value, new Set([...REPOSITORY_IDENTITY_KEYS, "state", "mergeCommit"]), "repository projection evidence");
    const state = value["state"];
    if (state !== "building" && state !== "awaiting_merge" && state !== "merged" && state !== "blocked" && state !== "abandoned") {
      throw new IssueCompletionEvidenceError("repository projection state is invalid");
    }
    const mergeCommit = optionalMergeCommit(value["mergeCommit"], "repository projection mergeCommit");
    return {
      type: REPOSITORY_MERGE_EVIDENCE_RECORDED,
      ...identity,
      authority,
      state,
      ...(mergeCommit === undefined ? {} : { mergeCommit }),
    };
  }
  throw new IssueCompletionEvidenceError("repository merge evidence authority is invalid");
}

function validateAcceptanceEvent(raw: unknown): IssueIntegrationAcceptanceEvidenceRecordedEvent {
  const value = requireRecord(raw, "integration acceptance evidence event");
  assertClosed(value, new Set(["type", "ts", "workspaceId", "storyId", "inputMergeCommits", "commandDigest", "profile", "verdict", "artifactPath", "recordedAt"]), "integration acceptance evidence");
  if (value["type"] !== ISSUE_INTEGRATION_ACCEPTANCE_EVIDENCE_RECORDED) {
    throw new IssueCompletionEvidenceError("integration acceptance evidence event has an invalid type");
  }
  const recordedAt = requireFiniteNumber(value["recordedAt"], "integration acceptance recordedAt");
  const ts = requireFiniteNumber(value["ts"], "integration acceptance ts");
  if (ts !== recordedAt) throw new IssueCompletionEvidenceError("integration acceptance ts must equal recordedAt");
  const rawMergeCommits = requireRecord(value["inputMergeCommits"], "integration acceptance inputMergeCommits");
  const inputMergeCommits: Record<string, string> = {};
  for (const [repoId, rawSha] of Object.entries(rawMergeCommits)) {
    requireString(repoId, "integration acceptance repoId");
    const sha = requireString(rawSha, `integration acceptance merge commit for ${repoId}`);
    if (!isImmutableGitObjectId(sha)) {
      throw new IssueCompletionEvidenceError(`integration acceptance merge commit for ${repoId} must be immutable`);
    }
    inputMergeCommits[repoId] = sha;
  }
  const verdict = value["verdict"];
  if (verdict !== "pass" && verdict !== "fail") {
    throw new IssueCompletionEvidenceError("integration acceptance verdict is invalid");
  }
  const commandDigest = requireString(value["commandDigest"], "integration acceptance commandDigest");
  if (!/^[0-9a-f]{64}$/u.test(commandDigest)) {
    throw new IssueCompletionEvidenceError("integration acceptance commandDigest must be lowercase SHA-256");
  }
  const profile = requireString(value["profile"], "integration acceptance profile");
  if (profile !== profile.trim() || /[\x00-\x1f\x7f]/u.test(profile)) {
    throw new IssueCompletionEvidenceError("integration acceptance profile is invalid");
  }
  const artifactPath = requireString(value["artifactPath"], "integration acceptance artifactPath");
  if (!isSafeIssueEvidencePath(artifactPath)) {
    throw new IssueCompletionEvidenceError("integration acceptance artifactPath must remain under evidence/");
  }
  return {
    type: ISSUE_INTEGRATION_ACCEPTANCE_EVIDENCE_RECORDED,
    ts,
    workspaceId: requireString(value["workspaceId"], "integration acceptance workspaceId"),
    storyId: requireString(value["storyId"], "integration acceptance storyId"),
    inputMergeCommits,
    commandDigest,
    profile,
    verdict,
    artifactPath,
    recordedAt,
  };
}

function repositoryFact(event: RepositoryMergeEvidenceRecordedEvent): RepositoryMergeEvidence {
  const { type: _type, ts: _ts, ...fact } = event;
  return fact;
}

function integrationAcceptance(event: IssueIntegrationAcceptanceEvidenceRecordedEvent): IssueIntegrationAcceptanceEvidence {
  const { type: _type, ts: _ts, ...evidence } = event;
  return evidence;
}

export function appendRepositoryMergeEvidence(
  issueRoot: string,
  evidence: RepositoryMergeEvidence,
): RepositoryMergeEvidenceRecordedEvent {
  const manifest = readIssueManifest(issueRoot);
  const event = validateRepositoryEvent({
    type: REPOSITORY_MERGE_EVIDENCE_RECORDED,
    ...evidence,
    ts: evidence.recordedAt,
  });
  assertRepositoryIssueIdentity(manifest, repositoryFact(event));
  appendIssueEventAtomically(issueRoot, { ...event });
  return event;
}

export function appendIssueIntegrationAcceptanceEvidence(
  issueRoot: string,
  evidence: IssueIntegrationAcceptanceEvidence,
): IssueIntegrationAcceptanceEvidenceRecordedEvent {
  const manifest = readIssueManifest(issueRoot);
  const event = validateAcceptanceEvent({
    type: ISSUE_INTEGRATION_ACCEPTANCE_EVIDENCE_RECORDED,
    ...evidence,
    ts: evidence.recordedAt,
  });
  assertAcceptanceIssueIdentity(manifest, integrationAcceptance(event));
  assertAcceptanceArtifact(issueRoot, integrationAcceptance(event));
  appendIssueEventAtomically(issueRoot, { ...event });
  return event;
}

export function readIssueCompletionEvidence(issueRoot: string): IssueCompletionEvidenceCollection {
  const manifest = readIssueManifest(issueRoot);
  const path = join(issueRoot, "events.jsonl");
  if (!existsSync(path)) return { repositoryFacts: [], integrationAcceptances: [] };
  const repositoryFacts: RepositoryMergeEvidence[] = [];
  const integrationAcceptances: IssueIntegrationAcceptanceEvidence[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new IssueCompletionEvidenceError(`events.jsonl line ${index + 1} is corrupted: ${(error as Error).message}`);
    }
    const value = record(raw);
    if (value?.["type"] === REPOSITORY_MERGE_EVIDENCE_RECORDED) {
      const evidence = repositoryFact(validateRepositoryEvent(value));
      assertRepositoryIssueIdentity(manifest, evidence);
      repositoryFacts.push(evidence);
    } else if (value?.["type"] === ISSUE_INTEGRATION_ACCEPTANCE_EVIDENCE_RECORDED) {
      const evidence = integrationAcceptance(validateAcceptanceEvent(value));
      assertAcceptanceIssueIdentity(manifest, evidence);
      integrationAcceptances.push(evidence);
    }
  }
  return { repositoryFacts, integrationAcceptances };
}
