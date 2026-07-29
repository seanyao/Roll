import { createHash } from "node:crypto";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EDIT_CONFIG_V1,
  WORKSPACE_EDIT_PLAN_V1,
  WORKSPACE_MANIFEST_V1,
  WORKSPACE_METADATA_REFERENCE_INDEX_V1,
  normalizeRepositoryRemote,
  parseRepositoryBinding,
  repositoryIdFromRemote,
  type ContractError,
  type ContractResult,
  type RepositoryBinding,
  type RequirementSourceReference,
  type WorkspaceEditBlocker,
  type WorkspaceEditChange,
  type WorkspaceEditConfigV1,
  type WorkspaceEditPlan,
  type WorkspaceEditReference,
  type WorkspaceEditRepositoryInput,
  type WorkspaceManifest,
  type WorkspaceMetadataReferenceIndex,
} from "@roll/spec";
import { normalizeRequirementSourceReference } from "./requirement-source.js";

export {
  WORKSPACE_EDIT_CONFIG_V1,
  WORKSPACE_EDIT_PLAN_V1,
  WORKSPACE_METADATA_REFERENCE_INDEX_V1,
};
export type {
  WorkspaceEditConfigV1,
  WorkspaceEditPlan,
  WorkspaceMetadataReferenceIndex,
};

interface ParseWorkspaceEditOptions {
  readonly workspaceId: string;
}

interface RawRepository {
  alias?: unknown;
  remote?: unknown;
  provider?: unknown;
  integration_branch?: unknown;
  branch_pattern?: unknown;
  required_checks?: unknown;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactUnknownFields(value: Record<string, unknown>, allowed: readonly string[], path = ""): ContractError[] {
  const accepted = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !accepted.has(key))
    .sort(compareText)
    .map((key) => ({
      code: "unknown_field" as const,
      path: path === "" ? key : `${path}.${key}`,
      message: "Workspace edit config contains an unknown field",
    }));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function stripComment(value: string): string {
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === "\"") && (quote === null || quote === character)) {
      quote = quote === null ? character : null;
      continue;
    }
    if (character === "#" && quote === null && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseScalar(value: string): unknown {
  const text = unquote(value);
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1).trim();
    return body === "" ? [] : body.split(",").map((item) => unquote(item));
  }
  return text;
}

function assignPair(target: Record<string, unknown>, text: string): void {
  const separator = text.indexOf(":");
  if (separator <= 0) throw new Error("invalid YAML mapping entry");
  const key = text.slice(0, separator).trim();
  const value = text.slice(separator + 1).trim();
  if (key === "" || value === "" || Object.hasOwn(target, key)) throw new Error("invalid or duplicate YAML mapping entry");
  target[key] = parseScalar(value);
}

function parseConfigDocument(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Continue with the dependency-free closed-shape YAML reader.
  }
  const root: Record<string, unknown> = {};
  let section: "requirements" | "repositories" | null = null;
  let item: Record<string, unknown> | null = null;
  let nestedList: "required_checks" | null = null;
  for (const rawLine of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (rawLine.includes("\t")) throw new Error("tabs are not supported");
    const line = stripComment(rawLine).trimEnd();
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();
    if (indent === 0) {
      item = null;
      nestedList = null;
      const separator = body.indexOf(":");
      if (separator <= 0) throw new Error("invalid top-level mapping");
      const key = body.slice(0, separator).trim();
      const value = body.slice(separator + 1).trim();
      if (key === "requirements" || key === "repositories") {
        if (Object.hasOwn(root, key)) throw new Error("invalid list mapping");
        if (value === "") {
          root[key] = [];
          section = key;
        } else if (key === "requirements" && value === "[]") {
          root[key] = [];
          section = null;
        } else {
          throw new Error("invalid list mapping");
        }
      } else {
        if (value === "" || Object.hasOwn(root, key)) throw new Error("invalid scalar mapping");
        root[key] = parseScalar(value);
        section = null;
      }
      continue;
    }
    if (section === null || indent < 2) throw new Error("unexpected indentation");
    const list = root[section];
    if (!Array.isArray(list)) throw new Error("unexpected list state");
    if (indent === 6 && item !== null && nestedList !== null && body.startsWith("- ")) {
      const values = item[nestedList];
      if (!Array.isArray(values)) throw new Error("invalid nested list state");
      const value = unquote(body.slice(2));
      if (value === "") throw new Error("nested list values must be non-empty");
      values.push(value);
      continue;
    }
    if (body.startsWith("- ")) {
      if (indent !== 2) throw new Error("list items must use two-space indentation");
      item = {};
      nestedList = null;
      list.push(item);
      assignPair(item, body.slice(2));
      continue;
    }
    if (indent !== 4 || item === null) throw new Error("list fields must use four-space indentation");
    if (section === "repositories" && body === "required_checks:") {
      if (Object.hasOwn(item, "required_checks")) throw new Error("duplicate required_checks");
      item["required_checks"] = [];
      nestedList = "required_checks";
      continue;
    }
    nestedList = null;
    assignPair(item, body);
  }
  return root;
}

function parseRequirements(value: unknown, errors: ContractError[]): readonly RequirementSourceReference[] {
  if (!Array.isArray(value)) {
    errors.push({ code: "invalid_type", path: "requirements", message: "requirements must be an array" });
    return [];
  }
  const normalized: Array<RequirementSourceReference & { readonly requirementId: string }> = [];
  for (const [index, entry] of value.entries()) {
    const path = `requirements[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ code: "invalid_type", path, message: "requirement source must be an object" });
      continue;
    }
    errors.push(...exactUnknownFields(entry, ["provider", "ref"], path));
    if (!nonEmptyString(entry["provider"]) || !nonEmptyString(entry["ref"])) {
      errors.push({ code: "invalid_type", path, message: "requirement source must contain provider and ref" });
      continue;
    }
    const source = normalizeRequirementSourceReference(entry["provider"], entry["ref"]);
    if (!source.ok) {
      errors.push(...source.errors.map((error) => ({ code: "invalid_value" as const, path: `${path}.${error.path}`, message: error.message })));
      continue;
    }
    normalized.push(source.value);
  }
  const seen = new Set<string>();
  for (const source of normalized) {
    if (seen.has(source.requirementId)) {
      errors.push({ code: "duplicate_identity", path: "requirements", message: "requirement source identities must be unique" });
    }
    seen.add(source.requirementId);
  }
  return normalized
    .slice()
    .sort((left, right) => compareText(left.requirementId, right.requirementId))
    .map(({ provider, ref }) => ({ provider, ref }));
}

function parseRepositories(value: unknown, errors: ContractError[]): readonly WorkspaceEditRepositoryInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ code: "invalid_type", path: "repositories", message: "repositories must be a non-empty array" });
    return [];
  }
  const repositories: Array<WorkspaceEditRepositoryInput & { readonly repoId: string }> = [];
  for (const [index, candidate] of value.entries()) {
    const path = `repositories[${index}]`;
    if (!isRecord(candidate)) {
      errors.push({ code: "invalid_type", path, message: "repository must be an object" });
      continue;
    }
    const raw = candidate as RawRepository & Record<string, unknown>;
    errors.push(...exactUnknownFields(raw, ["alias", "remote", "provider", "integration_branch", "branch_pattern", "required_checks"], path));
    if (
      !nonEmptyString(raw.alias) || !nonEmptyString(raw.remote) || !nonEmptyString(raw.provider) ||
      !nonEmptyString(raw.integration_branch) || !nonEmptyString(raw.branch_pattern) ||
      !Array.isArray(raw.required_checks) || !raw.required_checks.every(nonEmptyString)
    ) {
      errors.push({ code: "invalid_type", path, message: "repository fields are incomplete or invalid" });
      continue;
    }
    if (new Set(raw.required_checks).size !== raw.required_checks.length) {
      errors.push({ code: "duplicate_identity", path: `${path}.required_checks`, message: "required checks must be unique" });
      continue;
    }
    const remote = normalizeRepositoryRemote(raw.remote);
    const repoId = repositoryIdFromRemote(raw.remote);
    if (!remote.ok) {
      errors.push(...remote.errors.map((error) => ({ ...error, path: `${path}.remote` })));
      continue;
    }
    if (!repoId.ok) {
      errors.push(...repoId.errors.map((error) => ({ ...error, path: `${path}.remote` })));
      continue;
    }
    const parsed = parseRepositoryBinding({
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId.value,
      alias: raw.alias,
      remote: remote.value,
      integrationBranch: raw.integration_branch,
      provider: raw.provider,
      workflow: {
        branchPattern: raw.branch_pattern,
        requiredChecks: [...raw.required_checks].sort(compareText),
      },
    });
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((error) => ({ ...error, path: `${path}.${error.path}` })));
      continue;
    }
    repositories.push({
      repoId: parsed.value.repoId,
      alias: parsed.value.alias,
      remote: parsed.value.remote,
      provider: parsed.value.provider,
      integrationBranch: parsed.value.integrationBranch,
      branchPattern: parsed.value.workflow.branchPattern,
      requiredChecks: parsed.value.workflow.requiredChecks,
    });
  }
  const aliases = new Set<string>();
  const ids = new Set<string>();
  for (const repository of repositories) {
    if (aliases.has(repository.alias) || ids.has(repository.repoId)) {
      errors.push({ code: "duplicate_identity", path: "repositories", message: "repository bindings must have unique aliases and identities" });
    }
    aliases.add(repository.alias);
    ids.add(repository.repoId);
  }
  return repositories.slice().sort((left, right) => compareText(left.repoId, right.repoId)).map((repository) => ({
    alias: repository.alias,
    remote: repository.remote,
    provider: repository.provider,
    integrationBranch: repository.integrationBranch,
    branchPattern: repository.branchPattern,
    requiredChecks: repository.requiredChecks,
  }));
}

export function parseWorkspaceEditConfig(
  text: string,
  options: ParseWorkspaceEditOptions,
): ContractResult<WorkspaceEditConfigV1> {
  let value: unknown;
  try {
    value = parseConfigDocument(text);
  } catch {
    return { ok: false, errors: [{ code: "invalid_value", path: "config", message: "Workspace edit config is not valid closed YAML or JSON" }] };
  }
  if (!isRecord(value)) return { ok: false, errors: [{ code: "invalid_type", path: "config", message: "Workspace edit config must be an object" }] };
  const errors = exactUnknownFields(value, [
    "schema",
    "workspace_id",
    "expected_manifest_sha256",
    "display_name",
    "requirements",
    "repositories",
  ]);
  if (value["schema"] !== WORKSPACE_EDIT_CONFIG_V1) {
    errors.push({ code: "unknown_version", path: "schema", message: `expected ${WORKSPACE_EDIT_CONFIG_V1}` });
  }
  const workspaceId = value["workspace_id"];
  const expectedManifestSha256 = value["expected_manifest_sha256"];
  const displayName = value["display_name"];
  if (!nonEmptyString(workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(workspaceId)) {
    errors.push({ code: "invalid_value", path: "workspace_id", message: "Workspace ID is invalid" });
  } else if (workspaceId !== options.workspaceId) {
    errors.push({ code: "identity_mismatch", path: "workspace_id", message: "Command and config Workspace identities do not match" });
  }
  if (typeof expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedManifestSha256)) {
    errors.push({ code: "invalid_value", path: "expected_manifest_sha256", message: "expected manifest digest must be lowercase SHA-256" });
  }
  if (!nonEmptyString(displayName)) {
    errors.push({ code: "invalid_value", path: "display_name", message: "display name must be non-empty and losslessly normalized" });
  }
  const requirements = parseRequirements(value["requirements"], errors);
  const repositories = parseRepositories(value["repositories"], errors);
  if (
    errors.length > 0 || !nonEmptyString(workspaceId) || typeof expectedManifestSha256 !== "string" ||
    !nonEmptyString(displayName)
  ) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schema: WORKSPACE_EDIT_CONFIG_V1,
      workspaceId,
      expectedManifestSha256,
      displayName,
      requirements,
      repositories,
    },
  };
}

function canonicalRequirement(source: RequirementSourceReference): RequirementSourceReference & { readonly requirementId: string } | undefined {
  const normalized = normalizeRequirementSourceReference(source.provider, source.ref);
  return normalized.ok ? normalized.value : undefined;
}

function canonicalManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  const requirements = manifest.requirements
    .map(canonicalRequirement)
    .filter((source): source is NonNullable<typeof source> => source !== undefined)
    .sort((left, right) => compareText(left.requirementId, right.requirementId))
    .map(({ provider, ref }) => ({ provider, ref }));
  const repositories = manifest.repositories.slice().sort((left, right) => compareText(left.repoId, right.repoId)).map((repository) => ({
    schema: REPOSITORY_BINDING_V1,
    repoId: repository.repoId,
    alias: repository.alias,
    remote: repository.remote,
    integrationBranch: repository.integrationBranch,
    provider: repository.provider,
    workflow: {
      branchPattern: repository.workflow.branchPattern,
      requiredChecks: repository.workflow.requiredChecks.slice().sort(compareText),
    },
  }));
  return {
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: manifest.workspaceId,
    displayName: manifest.displayName,
    ...(manifest.createdAt === undefined ? {} : { createdAt: manifest.createdAt }),
    requirements,
    repositories,
  };
}

export function serializeWorkspaceManifest(manifest: WorkspaceManifest): string {
  return `${JSON.stringify(canonicalManifest(manifest), null, 2)}\n`;
}

function stableReferenceIndex(index: WorkspaceMetadataReferenceIndex): WorkspaceMetadataReferenceIndex {
  const sourceOrder = (left: RequirementSourceReference, right: RequirementSourceReference): number =>
    compareText(`${left.provider}\0${left.ref}`, `${right.provider}\0${right.ref}`);
  return {
    schema: WORKSPACE_METADATA_REFERENCE_INDEX_V1,
    workspaceId: index.workspaceId,
    issues: index.issues.slice().sort((left, right) => compareText(left.storyId, right.storyId)).map((issue) => ({
      storyId: issue.storyId,
      manifestSha256: issue.manifestSha256,
      requirementKeys: issue.requirementKeys.slice().sort(sourceOrder),
      repoIds: [...new Set(issue.repoIds)].sort(compareText),
    })),
    requirementArchives: index.requirementArchives.slice().sort((left, right) => compareText(left.requirementId, right.requirementId)).map((archive) => ({
      requirementId: archive.requirementId,
      source: archive.source,
      manifestSha256: archive.manifestSha256,
    })),
    additionalFacts: index.additionalFacts.slice().sort((left, right) =>
      compareText(`${left.authorityPath}\0${left.kind}`, `${right.authorityPath}\0${right.kind}`)
    ).map((fact) => ({
      kind: fact.kind,
      authorityPath: fact.authorityPath,
      sha256: fact.sha256,
      requirementKeys: fact.requirementKeys.slice().sort(sourceOrder),
      repoIds: [...new Set(fact.repoIds)].sort(compareText),
    })),
  };
}

export function serializeWorkspaceMetadataReferenceIndex(index: WorkspaceMetadataReferenceIndex): string {
  return `${JSON.stringify(stableReferenceIndex(index), null, 2)}\n`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function repositoryBindingFromEdit(repository: WorkspaceEditRepositoryInput): RepositoryBinding {
  const repoId = repositoryIdFromRemote(repository.remote);
  if (!repoId.ok) throw new Error("parsed Workspace edit config contains an invalid repository remote");
  const parsed = parseRepositoryBinding({
    schema: REPOSITORY_BINDING_V1,
    repoId: repoId.value,
    alias: repository.alias,
    remote: repository.remote,
    integrationBranch: repository.integrationBranch,
    provider: repository.provider,
    workflow: {
      branchPattern: repository.branchPattern,
      requiredChecks: repository.requiredChecks,
    },
  });
  if (!parsed.ok) throw new Error("parsed Workspace edit config contains an invalid repository binding");
  return parsed.value;
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function validDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function indexIsTrustworthy(index: WorkspaceMetadataReferenceIndex): boolean {
  return index.schema === WORKSPACE_METADATA_REFERENCE_INDEX_V1 &&
    index.issues.every((issue) => validDigest(issue.manifestSha256)) &&
    index.requirementArchives.every((archive) => validDigest(archive.manifestSha256)) &&
    index.additionalFacts.every((fact) => validDigest(fact.sha256) && !fact.authorityPath.includes(".."));
}

function referenceMaps(index: WorkspaceMetadataReferenceIndex): {
  readonly requirements: ReadonlyMap<string, readonly WorkspaceEditReference[]>;
  readonly repositories: ReadonlyMap<string, readonly WorkspaceEditReference[]>;
  readonly normalizationFailed: boolean;
} {
  const requirements = new Map<string, WorkspaceEditReference[]>();
  const repositories = new Map<string, WorkspaceEditReference[]>();
  let normalizationFailed = false;
  const addRequirement = (source: RequirementSourceReference, reference: WorkspaceEditReference): void => {
    const normalized = canonicalRequirement(source);
    if (normalized === undefined) {
      normalizationFailed = true;
      return;
    }
    requirements.set(normalized.requirementId, [...(requirements.get(normalized.requirementId) ?? []), reference]);
  };
  const addRepository = (repoId: string, reference: WorkspaceEditReference): void => {
    repositories.set(repoId, [...(repositories.get(repoId) ?? []), reference]);
  };
  for (const issue of index.issues) {
    for (const source of issue.requirementKeys) addRequirement(source, {
      kind: "issue_requirement",
      authorityPath: `issues/${issue.storyId}/manifest.json`,
      storyId: issue.storyId,
    });
    for (const repoId of issue.repoIds) addRepository(repoId, {
      kind: "issue_repository",
      authorityPath: `issues/${issue.storyId}/manifest.json`,
      storyId: issue.storyId,
      repoId,
    });
  }
  for (const archive of index.requirementArchives) addRequirement(archive.source, {
    kind: "requirement_archive",
    authorityPath: `requirements/${archive.source.provider}/${archive.requirementId}/source.yaml`,
    requirementId: archive.requirementId,
  });
  for (const fact of index.additionalFacts) {
    for (const source of fact.requirementKeys) addRequirement(source, { kind: "additional_fact", authorityPath: fact.authorityPath });
    for (const repoId of fact.repoIds) addRepository(repoId, { kind: "additional_fact", authorityPath: fact.authorityPath, repoId });
  }
  const sortReferences = (map: Map<string, WorkspaceEditReference[]>): ReadonlyMap<string, readonly WorkspaceEditReference[]> => {
    for (const [key, entries] of map) {
      map.set(key, entries.slice().sort((left, right) => compareText(left.authorityPath, right.authorityPath)));
    }
    return map;
  };
  return { requirements: sortReferences(requirements), repositories: sortReferences(repositories), normalizationFailed };
}

function blocker(code: WorkspaceEditBlocker["code"], path: string, references: readonly WorkspaceEditReference[] = []): WorkspaceEditBlocker {
  const messages: Record<WorkspaceEditBlocker["code"], string> = {
    manifest_changed: "Workspace manifest no longer matches the config preview digest",
    metadata_referenced: "Workspace metadata is referenced by durable authority facts",
    normalization_failed: "Workspace metadata cannot be normalized without losing identity",
    reference_index_invalid: "Workspace metadata reference index is incomplete or invalid",
  };
  return { code, path, message: messages[code], references };
}

function change(
  kind: WorkspaceEditChange["kind"],
  path: string,
  operation: WorkspaceEditChange["operation"],
  safety: WorkspaceEditChange["safety"],
  before?: unknown,
  after?: unknown,
): WorkspaceEditChange {
  return { kind, path, operation, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), safety };
}

export function buildWorkspaceEditPlan(input: {
  readonly config: WorkspaceEditConfigV1;
  readonly current: WorkspaceManifest;
  readonly references: WorkspaceMetadataReferenceIndex;
  readonly manifestPath: string;
  readonly configPath?: string;
}): WorkspaceEditPlan {
  const beforeManifest = canonicalManifest(input.current);
  const afterManifest = canonicalManifest({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: input.current.workspaceId,
    displayName: input.config.displayName,
    ...(input.current.createdAt === undefined ? {} : { createdAt: input.current.createdAt }),
    requirements: input.config.requirements,
    repositories: input.config.repositories.map(repositoryBindingFromEdit),
  });
  const beforeSha256 = sha256(serializeWorkspaceManifest(beforeManifest));
  const afterSha256 = sha256(serializeWorkspaceManifest(afterManifest));
  const referenceIndexSha256 = sha256(serializeWorkspaceMetadataReferenceIndex(input.references));
  const blockers: WorkspaceEditBlocker[] = [];
  const changes: WorkspaceEditChange[] = [];

  if (input.current.workspaceId !== input.config.workspaceId || input.references.workspaceId !== input.current.workspaceId) {
    blockers.push(blocker("reference_index_invalid", "workspaceId"));
  }
  if (input.config.expectedManifestSha256 !== beforeSha256) blockers.push(blocker("manifest_changed", "expected_manifest_sha256"));
  if (!indexIsTrustworthy(input.references)) blockers.push(blocker("reference_index_invalid", "references"));
  if (input.current.requirements.some((source) => canonicalRequirement(source) === undefined)) {
    blockers.push(blocker("normalization_failed", "requirements"));
  }

  const refs = referenceMaps(input.references);
  if (refs.normalizationFailed) blockers.push(blocker("reference_index_invalid", "references.requirementKeys"));

  if (beforeManifest.displayName !== afterManifest.displayName) {
    changes.push(change("display_name", "displayName", "updated", "safe", beforeManifest.displayName, afterManifest.displayName));
  }

  const currentRequirements = new Map(input.current.requirements.map((source) => {
    const normalized = canonicalRequirement(source);
    return normalized === undefined ? [`invalid:${source.provider}:${source.ref}`, { ...source, requirementId: "" }] : [normalized.requirementId, normalized];
  }));
  const desiredRequirements = new Map(input.config.requirements.map((source) => {
    const normalized = canonicalRequirement(source);
    if (normalized === undefined) throw new Error("parsed Workspace edit config contains an invalid requirement source");
    return [normalized.requirementId, normalized];
  }));
  for (const [requirementId, source] of [...currentRequirements.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (desiredRequirements.has(requirementId) || source.requirementId === "") continue;
    const references = refs.requirements.get(requirementId) ?? [];
    const path = `requirements[${source.provider}:${source.ref}]`;
    changes.push(change("requirement", path, "removed", references.length > 0 ? "blocked" : "safe", { provider: source.provider, ref: source.ref }));
    if (references.length > 0) blockers.push(blocker("metadata_referenced", path, references));
  }
  for (const [requirementId, source] of [...desiredRequirements.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (currentRequirements.has(requirementId)) continue;
    changes.push(change("requirement", `requirements[${source.provider}:${source.ref}]`, "added", "safe", undefined, { provider: source.provider, ref: source.ref }));
  }

  const currentRepositories = new Map(beforeManifest.repositories.map((repository) => [repository.repoId, repository]));
  const desiredRepositories = new Map(afterManifest.repositories.map((repository) => [repository.repoId, repository]));
  const consumedDesired = new Set<string>();
  for (const repository of beforeManifest.repositories) {
    const exact = desiredRepositories.get(repository.repoId);
    const sameAlias = afterManifest.repositories.find((candidate) => candidate.alias === repository.alias);
    if (exact === undefined) {
      const references = refs.repositories.get(repository.repoId) ?? [];
      const remoteChanged = sameAlias !== undefined;
      const path = `repositories[${repository.repoId}].${remoteChanged ? "remote" : "binding"}`;
      changes.push(change("repository_identity", path, remoteChanged ? "updated" : "removed", references.length > 0 ? "blocked" : "safe", repository, sameAlias));
      if (references.length > 0) blockers.push(blocker("metadata_referenced", path, references));
      if (sameAlias !== undefined) consumedDesired.add(sameAlias.repoId);
      continue;
    }
    consumedDesired.add(exact.repoId);
    const references = refs.repositories.get(repository.repoId) ?? [];
    if (repository.alias !== exact.alias) {
      const path = `repositories[${repository.repoId}].alias`;
      changes.push(change("repository_identity", path, "updated", references.length > 0 ? "blocked" : "safe", repository.alias, exact.alias));
      if (references.length > 0) blockers.push(blocker("metadata_referenced", path, references));
    }
    const workflowFields: readonly {
      readonly name: "provider" | "integrationBranch" | "branchPattern" | "requiredChecks";
      readonly before: unknown;
      readonly after: unknown;
    }[] = [
      { name: "provider", before: repository.provider, after: exact.provider },
      { name: "integrationBranch", before: repository.integrationBranch, after: exact.integrationBranch },
      { name: "branchPattern", before: repository.workflow.branchPattern, after: exact.workflow.branchPattern },
      { name: "requiredChecks", before: repository.workflow.requiredChecks, after: exact.workflow.requiredChecks },
    ];
    for (const field of workflowFields) {
      if (JSON.stringify(field.before) === JSON.stringify(field.after)) continue;
      const path = `repositories[${repository.repoId}].${field.name}`;
      changes.push(change("repository_workflow", path, "updated", references.length > 0 ? "blocked" : "safe", field.before, field.after));
      if (references.length > 0) blockers.push(blocker("metadata_referenced", path, references));
    }
  }
  for (const repository of afterManifest.repositories) {
    if (currentRepositories.has(repository.repoId) || consumedDesired.has(repository.repoId)) continue;
    changes.push(change("repository", `repositories[${repository.repoId}]`, "added", "safe", undefined, repository));
  }

  const sortedChanges = changes.slice().sort((left, right) => compareText(left.path, right.path));
  const sortedBlockers = blockers.slice().sort((left, right) => compareText(`${left.path}\0${left.code}`, `${right.path}\0${right.code}`));
  const outcome = sortedBlockers.length === 0 ? "ready" : "blocked";
  const configPath = shellArgument(input.configPath ?? "<path>");
  return {
    schema: WORKSPACE_EDIT_PLAN_V1,
    outcome,
    workspaceId: input.current.workspaceId,
    manifestPath: input.manifestPath,
    beforeSha256,
    afterSha256,
    referenceIndexSha256,
    beforeManifest,
    afterManifest,
    changes: sortedChanges,
    blockers: sortedBlockers,
    warnings: [],
    nextAction: outcome === "ready"
      ? { kind: "apply", command: `roll workspace edit ${input.current.workspaceId} --config ${configPath} --json` }
      : { kind: "blocked", command: `roll workspace edit ${input.current.workspaceId} --config ${configPath} --check --json` },
  };
}
