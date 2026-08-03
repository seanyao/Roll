import { isAbsolute, relative, sep } from "node:path";
import {
  normalizeRepositoryRemote,
  repositoryIdFromRemote,
  type RequirementHintProvenance,
  type RequirementHintV1,
  type WorkspaceRequirementMatchEvidence,
} from "@roll/spec";
import { normalizeRequirementSourceReference } from "./requirement-source.js";

export const MAX_REQUIREMENT_MATCH_EVIDENCE = 64;

export interface PersistedRequirementIdentity {
  readonly provider: string;
  readonly ref: string;
  readonly requirementId?: string;
}

export interface PersistedRepositoryIdentity {
  readonly remote: string;
  readonly repositoryId?: string;
}

export interface WorkspaceRequirementMatchFacts {
  readonly issues: readonly {
    readonly storyId: string;
    readonly requirements: readonly PersistedRequirementIdentity[];
  }[];
  readonly requirementSources: readonly PersistedRequirementIdentity[];
  readonly repositories: readonly PersistedRepositoryIdentity[];
  /** Host-resolved canonical absolute roots; core performs no filesystem access. */
  readonly roots: readonly string[];
  readonly semanticTerms?: readonly string[];
}

export type RequirementMatchFindingCode =
  | "legacy_requirement_ref_requires_migration"
  | "requirement_identity_mismatch"
  | "legacy_repository_remote_requires_migration"
  | "repository_identity_mismatch"
  | "invalid_workspace_root";

export interface RequirementMatchFinding {
  readonly code: RequirementMatchFindingCode;
  readonly source: string;
  readonly detail: string;
}

export interface WorkspaceRequirementMatchResult {
  readonly evidence: readonly WorkspaceRequirementMatchEvidence[];
  readonly hardMatch: boolean;
  readonly score: number;
  readonly findings: readonly RequirementMatchFinding[];
}

const HARD_PROVENANCE = new Set<RequirementHintProvenance>([
  "explicit_user",
  "cli_argument",
  "issue_manifest",
  "deterministic_extraction",
]);

const PROVENANCE_PRIORITY: Readonly<Record<RequirementHintProvenance, number>> = {
  explicit_user: 0,
  cli_argument: 1,
  issue_manifest: 2,
  deterministic_extraction: 3,
  cwd_repository: 4,
  semantic_inference: 5,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceKey(value: WorkspaceRequirementMatchEvidence): string {
  return [value.kind, value.value, value.source, value.detail].join("\0");
}

function stableEvidence(values: readonly WorkspaceRequirementMatchEvidence[]): readonly WorkspaceRequirementMatchEvidence[] {
  const unique = new Map<string, WorkspaceRequirementMatchEvidence>();
  for (const value of values) {
    const key = evidenceKey(value);
    const current = unique.get(key);
    if (current === undefined || PROVENANCE_PRIORITY[value.provenance] < PROVENANCE_PRIORITY[current.provenance]) {
      unique.set(key, value);
    }
  }
  return [...unique.values()]
    .sort((left, right) => (
      right.score - left.score ||
      compareText(left.kind, right.kind) ||
      compareText(left.value, right.value) ||
      PROVENANCE_PRIORITY[left.provenance] - PROVENANCE_PRIORITY[right.provenance] ||
      compareText(left.source, right.source) ||
      compareText(left.detail, right.detail)
    ))
    .slice(0, MAX_REQUIREMENT_MATCH_EVIDENCE);
}

function stableFindings(values: readonly RequirementMatchFinding[]): readonly RequirementMatchFinding[] {
  const unique = new Map<string, RequirementMatchFinding>();
  for (const value of values) unique.set(`${value.source}\0${value.code}\0${value.detail}`, value);
  return [...unique.values()].sort((left, right) => (
    compareText(left.source, right.source) || compareText(left.code, right.code) || compareText(left.detail, right.detail)
  ));
}

function semanticTerm(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

interface ValidRequirementIdentity {
  readonly provider: "jira" | "github_issue" | "local_file" | "user_input";
  readonly ref: string;
  readonly requirementId: string;
}

function normalizePersistedRequirements(
  values: readonly PersistedRequirementIdentity[],
  findings: RequirementMatchFinding[],
): readonly ValidRequirementIdentity[] {
  const normalized: ValidRequirementIdentity[] = [];
  for (const value of values) {
    const sourceToken = `requirement:${value.provider}/${value.requirementId ?? "unidentified"}`;
    const identity = normalizeRequirementSourceReference(value.provider, value.ref);
    if (!identity.ok) {
      findings.push({
        code: "legacy_requirement_ref_requires_migration",
        source: sourceToken,
        detail: "Persisted provider/ref cannot be losslessly normalized; identity was not rewritten",
      });
      continue;
    }
    if (value.requirementId !== undefined && value.requirementId !== identity.value.requirementId) {
      findings.push({
        code: "requirement_identity_mismatch",
        source: sourceToken,
        detail: "Persisted requirementId does not match the existing provider/ref identity algorithm",
      });
      continue;
    }
    normalized.push(identity.value);
  }
  return normalized;
}

interface ValidRepositoryIdentity {
  readonly remote: string;
  readonly repositoryId: string;
}

function normalizePersistedRepositories(
  values: readonly PersistedRepositoryIdentity[],
  findings: RequirementMatchFinding[],
): readonly ValidRepositoryIdentity[] {
  const normalized: ValidRepositoryIdentity[] = [];
  for (const value of values) {
    const sourceToken = `repository:${value.repositoryId ?? "unidentified"}`;
    const remote = normalizeRepositoryRemote(value.remote);
    const identity = repositoryIdFromRemote(value.remote);
    if (!remote.ok || !identity.ok) {
      findings.push({
        code: "legacy_repository_remote_requires_migration",
        source: sourceToken,
        detail: "Persisted repository remote cannot be losslessly normalized; identity was not rewritten",
      });
      continue;
    }
    if (value.repositoryId !== undefined && value.repositoryId !== identity.value) {
      findings.push({
        code: "repository_identity_mismatch",
        source: sourceToken,
        detail: "Persisted repositoryId does not match the existing remote identity algorithm",
      });
      continue;
    }
    normalized.push({ remote: remote.value, repositoryId: identity.value });
  }
  return normalized;
}

function exactEvidence(
  kind: "issue_exact" | "requirement_source_exact",
  value: string,
  provenance: RequirementHintProvenance,
  source: string,
  detail: string,
  score: number,
): WorkspaceRequirementMatchEvidence | undefined {
  if (!HARD_PROVENANCE.has(provenance)) return undefined;
  return { kind, value, hard: true, score, source, provenance, detail };
}

export function matchWorkspaceRequirement(input: {
  readonly requirement: RequirementHintV1;
  readonly facts: WorkspaceRequirementMatchFacts;
}): WorkspaceRequirementMatchResult {
  const evidence: WorkspaceRequirementMatchEvidence[] = [];
  const findings: RequirementMatchFinding[] = [];

  const issueIds = new Set(input.facts.issues.map((issue) => issue.storyId));
  for (const hint of input.requirement.storyIds) {
    if (!issueIds.has(hint.storyId)) continue;
    const match = exactEvidence(
      "issue_exact",
      hint.storyId,
      hint.provenance,
      `issue:${hint.storyId}`,
      `Issue manifest storyId matched ${hint.storyId}`,
      100,
    );
    if (match !== undefined) evidence.push(match);
  }

  const persistedRequirements = normalizePersistedRequirements([
    ...input.facts.requirementSources,
    ...input.facts.issues.flatMap((issue) => issue.requirements),
  ], findings);
  for (const hint of input.requirement.sources) {
    const identity = normalizeRequirementSourceReference(hint.key.provider, hint.key.ref);
    if (!identity.ok) continue;
    if (!persistedRequirements.some((candidate) => candidate.requirementId === identity.value.requirementId && candidate.provider === identity.value.provider && candidate.ref === identity.value.ref)) continue;
    const match = exactEvidence(
      "requirement_source_exact",
      `${identity.value.provider}:${identity.value.ref}`,
      hint.provenance,
      `requirement:${identity.value.provider}/${identity.value.requirementId}`,
      `Requirement source identity matched ${identity.value.requirementId}`,
      90,
    );
    if (match !== undefined) evidence.push(match);
  }

  const persistedRepositories = normalizePersistedRepositories(input.facts.repositories, findings);
  for (const hint of input.requirement.repositoryRemotes) {
    const identity = repositoryIdFromRemote(hint.remote);
    if (!identity.ok || !persistedRepositories.some((candidate) => candidate.repositoryId === identity.value)) continue;
    evidence.push({
      kind: "repository_exact",
      value: identity.value,
      hard: false,
      score: 30,
      source: `repository:${identity.value}`,
      provenance: hint.provenance,
      detail: `Repository identity matched ${identity.value}`,
    });
  }

  const roots = [...new Set(input.facts.roots)].sort(compareText);
  for (const root of roots) {
    if (!isAbsolute(root)) {
      findings.push({ code: "invalid_workspace_root", source: `workspace-root:${root}`, detail: "Workspace root must be host-canonical and absolute" });
      continue;
    }
    for (const hint of input.requirement.paths) {
      if (!contained(root, hint.path)) continue;
      evidence.push({
        kind: "path_contained",
        value: hint.path,
        hard: false,
        score: 20,
        source: `workspace-root:${root}`,
        provenance: hint.provenance,
        detail: `Candidate path is contained by Workspace root ${root}`,
      });
    }
  }

  const candidateTerms = new Set((input.facts.semanticTerms ?? []).map(semanticTerm).filter((term) => term !== ""));
  for (const term of input.requirement.semanticTerms ?? []) {
    const normalized = semanticTerm(term);
    if (normalized === "" || !candidateTerms.has(normalized)) continue;
    evidence.push({
      kind: "semantic_supported",
      value: normalized,
      hard: false,
      score: 10,
      source: `semantic-index:${normalized}`,
      provenance: "semantic_inference",
      detail: `Semantic term matched ${normalized}`,
    });
  }

  const stable = stableEvidence(evidence);
  return {
    evidence: stable,
    hardMatch: stable.some((entry) => entry.hard),
    score: stable.reduce((total, entry) => total + entry.score, 0),
    findings: stableFindings(findings),
  };
}
