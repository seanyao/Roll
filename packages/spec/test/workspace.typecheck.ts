import type {
  ContractErrorCode,
  ContractResult,
  IssueManifest,
  IssueIdentity,
  IssueRepositoryTarget,
  LegacyProjectEventMigrationInput,
  RepositoryBinding,
  RepositoryHintProvenance,
  RequirementHintProvenance,
  RequirementHintV1,
  RequirementSourceKey,
  RepositoryIssueIdentity,
  RollEvent,
  StructuredRequirementProvenance,
  WorkspaceManifest,
  WorkspaceIdentity,
} from "../src/index.js";
import {
  parseIssueManifest,
  parseLegacyProjectEventMigrationInput,
  parseRepositoryBinding,
  parseWorkspaceManifest,
} from "../src/index.js";
// @ts-expect-error DeliverySet is intentionally absent from the public v1 contract
import type { DeliverySet } from "../src/index.js";
// @ts-expect-error DeliverySet is intentionally absent from the Workspace v1 module
import type { DeliverySet as WorkspaceDeliverySet } from "../src/types/workspace.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2)
    ? (<T>() => T extends Right ? 1 : 2) extends (<T>() => T extends Left ? 1 : 2)
      ? true
      : false
    : false;
type ContainsAny<T> = IsAny<T> extends true
  ? true
  : T extends readonly (infer Item)[]
    ? ContainsAny<Item>
    : T extends object
      ? true extends { [Key in keyof T]-?: ContainsAny<T[Key]> }[keyof T]
        ? true
        : false
      : false;

const result: ContractResult<string> = { ok: true, value: "typed" };
const resultIsNotAny: AssertFalse<IsAny<ContractResult<string>>> = false;
const failure: ContractResult<string> = {
  ok: false,
  errors: [{ code: "invalid_type", path: "workspaceId", message: "typed" }],
};
type Failure = Extract<ContractResult<string>, { ok: false }>;
type FailureError = Failure["errors"][number];
const failureErrorIsNotAny: AssertFalse<IsAny<FailureError>> = false;
const failureCode: ContractErrorCode = failure.errors[0]!.code;
const contractResultContainsNoAny: AssertFalse<ContainsAny<ContractResult<string>>> = false;
const contractErrorCodesStayClosed: AssertTrue<Equal<
  ContractErrorCode,
  | "invalid_type"
  | "unknown_version"
  | "unknown_field"
  | "invalid_value"
  | "identity_mismatch"
  | "duplicate_identity"
  | "unsafe_remote"
  | "repo_id_mismatch"
>> = true;
const workspaceIsNotAny: AssertFalse<IsAny<WorkspaceManifest>> = false;
const repositoryIsNotAny: AssertFalse<IsAny<RepositoryBinding>> = false;
const issueIsNotAny: AssertFalse<IsAny<IssueManifest>> = false;
const workspaceIdentityIsNotAny: AssertFalse<IsAny<WorkspaceIdentity>> = false;
const issueIdentityIsNotAny: AssertFalse<IsAny<IssueIdentity>> = false;
const repositoryIssueIdentityIsNotAny: AssertFalse<IsAny<RepositoryIssueIdentity>> = false;
const parseWorkspaceResultIsNotAny: AssertFalse<IsAny<ReturnType<typeof parseWorkspaceManifest>>> = false;
const parseRepositoryResultIsNotAny: AssertFalse<IsAny<ReturnType<typeof parseRepositoryBinding>>> = false;
const parseIssueResultIsNotAny: AssertFalse<IsAny<ReturnType<typeof parseIssueManifest>>> = false;
const parseWorkspaceResultContainsNoAny: AssertFalse<ContainsAny<ReturnType<typeof parseWorkspaceManifest>>> = false;
const parseRepositoryResultContainsNoAny: AssertFalse<ContainsAny<ReturnType<typeof parseRepositoryBinding>>> = false;
const parseIssueResultContainsNoAny: AssertFalse<ContainsAny<ReturnType<typeof parseIssueManifest>>> = false;
const parseLegacyResultContainsNoAny: AssertFalse<ContainsAny<ReturnType<typeof parseLegacyProjectEventMigrationInput>>> = false;
const workspaceRequirementsIsNotAny: AssertFalse<IsAny<WorkspaceManifest["requirements"]>> = false;
const workspaceRequirementIsNotAny: AssertFalse<IsAny<WorkspaceManifest["requirements"][number]>> = false;
const workspaceRepositoriesIsNotAny: AssertFalse<IsAny<WorkspaceManifest["repositories"]>> = false;
const repositoryWorkflowIsNotAny: AssertFalse<IsAny<RepositoryBinding["workflow"]>> = false;
const issueRepositoriesIsNotAny: AssertFalse<IsAny<IssueManifest["repositories"]>> = false;
const issueRepositoryIsNotAny: AssertFalse<IsAny<IssueManifest["repositories"][number]>> = false;
const workspaceContainsNoAny: AssertFalse<ContainsAny<WorkspaceManifest>> = false;
const repositoryContainsNoAny: AssertFalse<ContainsAny<RepositoryBinding>> = false;
const issueContainsNoAny: AssertFalse<ContainsAny<IssueManifest>> = false;
const issueTargetContainsNoAny: AssertFalse<ContainsAny<IssueRepositoryTarget>> = false;
const requirementHintIsNotAny: AssertFalse<IsAny<RequirementHintV1>> = false;
const requirementHintContainsNoAny: AssertFalse<ContainsAny<RequirementHintV1>> = false;
type RequirementHintSource = RequirementHintV1["sources"][number];
type RequirementHintStory = RequirementHintV1["storyIds"][number];
type RequirementHintRepository = RequirementHintV1["repositoryRemotes"][number];
type RequirementHintPath = RequirementHintV1["paths"][number];
const requirementHintKeysStayClosed: AssertTrue<Equal<
  keyof RequirementHintV1,
  "schema" | "sources" | "storyIds" | "repositoryRemotes" | "paths" | "semanticTerms"
>> = true;
const requirementHintSourceKeysStayClosed: AssertTrue<Equal<keyof RequirementHintSource, "key" | "provenance">> = true;
const requirementHintStoryKeysStayClosed: AssertTrue<Equal<keyof RequirementHintStory, "storyId" | "provenance">> = true;
const requirementHintRepositoryKeysStayClosed: AssertTrue<Equal<keyof RequirementHintRepository, "remote" | "provenance">> = true;
const requirementHintPathKeysStayClosed: AssertTrue<Equal<keyof RequirementHintPath, "path" | "provenance">> = true;
const requirementSourceKeyKeysStayClosed: AssertTrue<Equal<keyof RequirementSourceKey, "provider" | "ref">> = true;
const requirementSourceProviderStaysClosed: AssertTrue<Equal<
  RequirementSourceKey["provider"],
  "jira" | "github_issue" | "local_file" | "user_input"
>> = true;
const requirementHintProvenanceStaysClosed: AssertTrue<Equal<
  RequirementHintProvenance,
  | "explicit_user"
  | "cli_argument"
  | "issue_manifest"
  | "cwd_repository"
  | "deterministic_extraction"
  | "semantic_inference"
>> = true;
const structuredProvenanceStaysClosed: AssertTrue<Equal<
  StructuredRequirementProvenance,
  "explicit_user" | "cli_argument" | "issue_manifest" | "deterministic_extraction"
>> = true;
const repositoryProvenanceStaysClosed: AssertTrue<Equal<
  RepositoryHintProvenance,
  "explicit_user" | "cli_argument" | "issue_manifest" | "cwd_repository" | "deterministic_extraction"
>> = true;
const workspaceIdentityContainsNoAny: AssertFalse<ContainsAny<WorkspaceIdentity>> = false;
const issueIdentityContainsNoAny: AssertFalse<ContainsAny<IssueIdentity>> = false;
const repositoryIssueIdentityContainsNoAny: AssertFalse<ContainsAny<RepositoryIssueIdentity>> = false;
const workspaceIdentityKeysStayClosed: AssertTrue<Equal<keyof WorkspaceIdentity, "workspaceId">> = true;
const issueIdentityKeysStayClosed: AssertTrue<Equal<keyof IssueIdentity, "workspaceId" | "storyId">> = true;
const repositoryIssueIdentityKeysStayClosed: AssertTrue<
  Equal<keyof RepositoryIssueIdentity, "workspaceId" | "storyId" | "repoId">
> = true;
const nestedAnyDetectionProbe: AssertTrue<ContainsAny<{ nested: { value: ReturnType<typeof JSON.parse> } }>> = true;

const requirementHint: RequirementHintV1 = {
  schema: "roll.requirement-hint/v1",
  sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "explicit_user" }],
  storyIds: [{ storyId: "US-WS-027", provenance: "cli_argument" }],
  repositoryRemotes: [{ remote: "https://github.com/Owner/Repo", provenance: "cwd_repository" }],
  paths: [{ path: "/work/ws", provenance: "deterministic_extraction" }],
  semanticTerms: ["workspace resolver"],
};
// @ts-expect-error semantic inference cannot enter a structured source/story identity
const structuredSemantic: StructuredRequirementProvenance = "semantic_inference";
// @ts-expect-error cwd repository context cannot enter a structured source/story identity
const structuredCwd: StructuredRequirementProvenance = "cwd_repository";
// @ts-expect-error semantic inference cannot enter repository/path structured hints
const repositorySemantic: RepositoryHintProvenance = "semantic_inference";
const invalidHintUnknownField: RequirementHintV1 = {
  schema: "roll.requirement-hint/v1",
  sources: [],
  storyIds: [],
  repositoryRemotes: [],
  paths: [],
  // @ts-expect-error RequirementHintV1 is a closed object contract
  extra: true,
};

const read: IssueRepositoryTarget = {
  repoId: "repo-0123456789ab",
  alias: "context",
  access: "read",
  requiredDelivery: false,
};
const write: IssueRepositoryTarget = {
  repoId: "repo-0123456789ac",
  alias: "product",
  access: "write",
  requiredDelivery: true,
  noChangePolicy: "changes_required",
  workBranch: "roll/ws/US-1/product",
};

// @ts-expect-error read targets cannot require delivery
const invalidRead: IssueRepositoryTarget = { ...read, requiredDelivery: true };
// @ts-expect-error write targets require an explicit no-change policy
const invalidWrite: IssueRepositoryTarget = {
  repoId: "repo-0123456789ad",
  alias: "missing-policy",
  access: "write",
  requiredDelivery: true,
};
declare const migration: LegacyProjectEventMigrationInput;
// @ts-expect-error migration wrappers are deliberately outside the runtime RollEvent union
const runtimeEvent: RollEvent = migration;

declare const workspaceIdentity: WorkspaceIdentity;
declare const issueIdentity: IssueIdentity;
declare const repositoryIssueIdentity: RepositoryIssueIdentity;

void [
  result,
  resultIsNotAny,
  failure,
  failureErrorIsNotAny,
  failureCode,
  contractResultContainsNoAny,
  contractErrorCodesStayClosed,
  workspaceIsNotAny,
  repositoryIsNotAny,
  issueIsNotAny,
  workspaceIdentityIsNotAny,
  issueIdentityIsNotAny,
  repositoryIssueIdentityIsNotAny,
  parseWorkspaceResultIsNotAny,
  parseRepositoryResultIsNotAny,
  parseIssueResultIsNotAny,
  parseWorkspaceResultContainsNoAny,
  parseRepositoryResultContainsNoAny,
  parseIssueResultContainsNoAny,
  parseLegacyResultContainsNoAny,
  workspaceRequirementsIsNotAny,
  workspaceRequirementIsNotAny,
  workspaceRepositoriesIsNotAny,
  repositoryWorkflowIsNotAny,
  issueRepositoriesIsNotAny,
  issueRepositoryIsNotAny,
  workspaceContainsNoAny,
  repositoryContainsNoAny,
  issueContainsNoAny,
  issueTargetContainsNoAny,
  requirementHintIsNotAny,
  requirementHintContainsNoAny,
  requirementHintKeysStayClosed,
  requirementHintSourceKeysStayClosed,
  requirementHintStoryKeysStayClosed,
  requirementHintRepositoryKeysStayClosed,
  requirementHintPathKeysStayClosed,
  requirementSourceKeyKeysStayClosed,
  requirementSourceProviderStaysClosed,
  requirementHintProvenanceStaysClosed,
  structuredProvenanceStaysClosed,
  repositoryProvenanceStaysClosed,
  workspaceIdentityContainsNoAny,
  issueIdentityContainsNoAny,
  repositoryIssueIdentityContainsNoAny,
  workspaceIdentityKeysStayClosed,
  issueIdentityKeysStayClosed,
  repositoryIssueIdentityKeysStayClosed,
  nestedAnyDetectionProbe,
  requirementHint,
  structuredSemantic,
  structuredCwd,
  repositorySemantic,
  invalidHintUnknownField,
  read,
  write,
  invalidRead,
  invalidWrite,
  runtimeEvent,
  workspaceIdentity,
  issueIdentity,
  repositoryIssueIdentity,
  parseLegacyProjectEventMigrationInput,
];
