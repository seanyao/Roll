import { join } from "node:path";
import {
  ISSUE_MANIFEST_V1,
  type ContractErrorCode,
  type IssueManifest,
  type IssueRepositoryTarget,
  type RepositoryBinding,
  type RequirementSourceManifest,
  type RequirementSourceReference,
} from "@roll/spec";
import { resolveRequirementSourcesForStory } from "./requirement-source.js";

export interface IssueStoryContractTarget {
  readonly alias: string;
  readonly access: "read" | "write";
  readonly requiredDelivery: boolean;
  readonly dependsOnRepo?: string;
}

export interface IssueStoryContract {
  readonly storyId: string;
  readonly repositories: readonly IssueStoryContractTarget[];
  readonly integrationAcceptance?: {
    readonly command: readonly string[];
    readonly cwd: string;
  };
}

export interface IssueStoryContractError {
  readonly code: ContractErrorCode | "invalid_config";
  readonly path: string;
  readonly message: string;
}

export type IssueStoryContractResult =
  | { readonly ok: true; readonly value: IssueStoryContract }
  | { readonly ok: false; readonly errors: readonly IssueStoryContractError[] };

export interface ParseIssueStoryContractOptions {
  readonly storyId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Closed Story id syntax: US-/FIX-/REFACTOR-/IDEA-/BUG- prefix, uppercase
 *  alphanumeric segments joined by single hyphens, no separators or traversal.
 *  The trailing `[a-z]?\d*` admits existing shorthand-split suffixes like
 *  "079f1" (a lowercase split letter followed by more digits), not just a
 *  single bare trailing letter. */
const STORY_ID_RE = /^(US|FIX|REFACTOR|IDEA|BUG)(-[A-Z0-9]+)+[a-z]?\d*$/;

export type ValidateStoryIdResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: "invalid_value"; readonly message: string };

/** Validate a Story id as a safe closed identifier before ANY path use — rejects
 *  '.', '..', path separators and any character outside the closed id syntax. */
export function validateStoryId(storyId: string): ValidateStoryIdResult {
  if (!STORY_ID_RE.test(storyId)) {
    return { ok: false, code: "invalid_value", message: "Story id must match the closed US-/FIX-/REFACTOR-/IDEA-/BUG- syntax with no path separators or traversal" };
  }
  return { ok: true, value: storyId };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  return Object.keys(value).filter((key) => !allow.has(key));
}

/** Parse only the leading `--- … ---` YAML frontmatter block of a Story spec.md. */
function extractFrontmatter(text: string): string | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  return match?.[1];
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  const unquoted = trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) ? trimmed.slice(1, -1) : trimmed;
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    const body = unquoted.slice(1, -1).trim();
    return body === "" ? [] : body.split(",").map((item) => item.trim());
  }
  return unquoted;
}

function assignPair(target: Record<string, unknown>, text: string): void {
  const index = text.indexOf(":");
  if (index <= 0) throw new Error("invalid YAML mapping entry");
  const key = text.slice(0, index).trim();
  const value = text.slice(index + 1).trim();
  if (key === "") throw new Error("empty YAML key");
  target[key] = value === "" ? undefined : parseScalar(value);
}

/** Parse the closed Story Contract frontmatter shape (id + repositories: block list). */
function parseFrontmatterDocument(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: "repositories" | "integration_acceptance" | null = null;
  let item: Record<string, unknown> | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trimStart();
    if (indent === 0) {
      item = null;
      const separator = body.indexOf(":");
      if (separator <= 0) throw new Error("invalid top-level YAML mapping");
      const key = body.slice(0, separator).trim();
      const value = body.slice(separator + 1).trim();
      if (key === "repositories") {
        root[key] = [];
        section = "repositories";
      } else if (key === "integration_acceptance") {
        root[key] = {};
        section = "integration_acceptance";
      } else {
        section = null;
        root[key] = value === "" ? undefined : parseScalar(value);
      }
      continue;
    }
    if (section === null || indent < 2) continue;
    if (section === "integration_acceptance") {
      const integration = root[section];
      if (!isRecord(integration)) throw new Error("invalid integration acceptance state");
      assignPair(integration, body);
      continue;
    }
    const list = root[section];
    if (!Array.isArray(list)) throw new Error("invalid YAML list state");
    if (body.startsWith("- ")) {
      item = {};
      list.push(item);
      assignPair(item, body.slice(2));
      continue;
    }
    if (item === null) throw new Error("list fields require a preceding list item");
    assignPair(item, body);
  }
  return root;
}

export function parseIssueStoryContract(
  specText: string,
  options: ParseIssueStoryContractOptions,
): IssueStoryContractResult {
  const frontmatter = extractFrontmatter(specText);
  if (frontmatter === undefined) {
    return { ok: false, errors: [{ code: "invalid_config", path: "spec", message: "Story spec has no YAML frontmatter block" }] };
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseFrontmatterDocument(frontmatter);
  } catch (error) {
    return { ok: false, errors: [{ code: "invalid_config", path: "spec", message: (error as Error).message }] };
  }
  const errors: IssueStoryContractError[] = [];
  if (!nonEmptyString(raw["id"])) {
    errors.push({ code: "invalid_value", path: "id", message: "Story spec frontmatter must declare id" });
  } else if (raw["id"] !== options.storyId) {
    errors.push({ code: "identity_mismatch", path: "id", message: "Story spec id does not match the requested Story" });
  }
  const rawRepositories = raw["repositories"];
  const repositories: IssueStoryContractTarget[] = [];
  if (!Array.isArray(rawRepositories) || rawRepositories.length === 0) {
    errors.push({ code: "invalid_value", path: "repositories", message: "Story Contract must declare at least one repository target" });
  } else {
    for (const [index, entry] of rawRepositories.entries()) {
      if (!isRecord(entry)) {
        errors.push({ code: "invalid_type", path: `repositories[${index}]`, message: "repository entry must be an object" });
        continue;
      }
      const unknown = exactKeys(entry, ["alias", "access", "required_delivery", "depends_on_repo"]);
      if (unknown.length > 0) {
        errors.push({ code: "unknown_field", path: `repositories[${index}].${unknown[0]}`, message: "unknown repository field" });
        continue;
      }
      if (!nonEmptyString(entry["alias"])) {
        errors.push({ code: "invalid_value", path: `repositories[${index}].alias`, message: "alias is required" });
        continue;
      }
      const access = entry["access"];
      if (access !== "read" && access !== "write") {
        errors.push({ code: "invalid_value", path: `repositories[${index}].access`, message: "access must be read or write" });
        continue;
      }
      const requiredDelivery = entry["required_delivery"] === undefined ? access === "write" : entry["required_delivery"];
      if (typeof requiredDelivery !== "boolean") {
        errors.push({ code: "invalid_value", path: `repositories[${index}].required_delivery`, message: "required_delivery must be a boolean" });
        continue;
      }
      const dependsOnRepo = entry["depends_on_repo"];
      if (dependsOnRepo !== undefined && !nonEmptyString(dependsOnRepo)) {
        errors.push({ code: "invalid_value", path: `repositories[${index}].depends_on_repo`, message: "depends_on_repo must be a non-empty string" });
        continue;
      }
      repositories.push({
        alias: entry["alias"],
        access,
        requiredDelivery,
        ...(dependsOnRepo === undefined ? {} : { dependsOnRepo }),
      });
    }
  }
  const aliases = new Set<string>();
  for (const repository of repositories) {
    if (aliases.has(repository.alias)) {
      errors.push({ code: "duplicate_identity", path: "repositories", message: "repository alias must be unique" });
      break;
    }
    aliases.add(repository.alias);
  }
  let integrationAcceptance: IssueStoryContract["integrationAcceptance"];
  const rawIntegration = raw["integration_acceptance"];
  if (rawIntegration !== undefined) {
    if (!isRecord(rawIntegration)) {
      errors.push({ code: "invalid_type", path: "integration_acceptance", message: "integration acceptance must be an object" });
    } else {
      const unknown = exactKeys(rawIntegration, ["command", "cwd"]);
      if (unknown.length > 0) {
        errors.push({ code: "unknown_field", path: `integration_acceptance.${unknown[0]}`, message: "unknown integration acceptance field" });
      } else {
        const command = rawIntegration["command"];
        const cwd = rawIntegration["cwd"];
        if (!Array.isArray(command) || command.length === 0 || !command.every(nonEmptyString)) {
          errors.push({ code: "invalid_value", path: "integration_acceptance.command", message: "integration command must be a non-empty argv array" });
        }
        if (!nonEmptyString(cwd)) {
          errors.push({ code: "invalid_value", path: "integration_acceptance.cwd", message: "integration cwd repository alias is required" });
        } else {
          const target = repositories.find((repository) => repository.alias === cwd);
          if (target === undefined || target.access !== "write") {
            errors.push({ code: "invalid_value", path: "integration_acceptance.cwd", message: "integration cwd must name a writable repository target" });
          }
        }
        if (Array.isArray(command) && command.length > 0 && command.every(nonEmptyString) && nonEmptyString(cwd)) {
          integrationAcceptance = { command, cwd };
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      storyId: options.storyId,
      repositories,
      ...(integrationAcceptance === undefined ? {} : { integrationAcceptance }),
    },
  };
}

export type IssueTargetProbeState = "absent" | "compatible" | "repairable" | "conflict";
export type IssueTargetAction = "created" | "reused" | "repaired";

export interface IssueInitProbe {
  readonly manifest: { readonly state: IssueTargetProbeState };
  readonly worktrees: Readonly<Record<string, IssueTargetProbeState>>;
}

export interface IssueInitTargetPlan {
  readonly alias: string;
  readonly repoId: string;
  readonly access: "read" | "write";
  readonly action: IssueTargetAction;
  readonly worktreePath: string;
  /** Unique governed Story branch for a write target; null for a read target
   *  (created detached, never represented as a writable delivery leg). */
  readonly workBranch: string | null;
}

export interface RenderBranchPatternInput {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repoAlias: string;
}

/** Render a RepositoryBinding.workflow.branchPattern into a concrete, unique
 *  work branch name. `{workspace_id}`/`{story_id}`/`{repo_alias}` placeholders
 *  are substituted where present; when the pattern omits `{repo_alias}`, the
 *  alias is appended so distinct write targets never collide on one branch. */
export function renderBranchPattern(pattern: string, input: RenderBranchPatternInput): string {
  const rendered = pattern
    .replaceAll("{workspace_id}", input.workspaceId)
    .replaceAll("{story_id}", input.storyId)
    .replaceAll("{repo_alias}", input.repoAlias);
  return pattern.includes("{repo_alias}") ? rendered : `${rendered}/${input.repoAlias}`;
}

export type IssueInitOutcome = "created" | "reused" | "repaired";

export interface IssueInitPlan {
  readonly manifest: IssueManifest;
  readonly outcome: IssueInitOutcome;
  readonly targets: readonly IssueInitTargetPlan[];
  /** Newly-created targets, latest first — the order a partial-failure rollback must undo them in. */
  readonly rollbackOrder: readonly string[];
}

export interface ResolveIssueInitPlanInput {
  readonly workspaceId: string;
  readonly contract: IssueStoryContract;
  readonly bindings: readonly RepositoryBinding[];
  readonly requirementManifests: readonly RequirementSourceManifest[];
}

export interface IssueInitPlanError {
  readonly code: ContractErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ResolveIssueInitPlanResult =
  | { readonly ok: true; readonly value: IssueInitPlan }
  | { readonly ok: false; readonly errors: readonly IssueInitPlanError[] };

function targetAction(state: IssueTargetProbeState): IssueTargetAction | "conflict" {
  if (state === "absent") return "created";
  if (state === "compatible") return "reused";
  if (state === "repairable") return "repaired";
  return "conflict";
}

export function resolveIssueInitPlan(
  input: ResolveIssueInitPlanInput,
  probe: IssueInitProbe,
): ResolveIssueInitPlanResult {
  const errors: IssueInitPlanError[] = [];
  const bindingsByAlias = new Map(input.bindings.map((binding) => [binding.alias, binding]));
  const repositories: IssueRepositoryTarget[] = [];
  const targets: IssueInitTargetPlan[] = [];
  for (const declared of input.contract.repositories) {
    const binding = bindingsByAlias.get(declared.alias);
    if (binding === undefined) {
      errors.push({
        code: "unknown_field",
        path: `repositories[${declared.alias}]`,
        message: "Story Contract declares an alias with no matching Workspace repository binding",
      });
      continue;
    }
    const state = probe.worktrees[declared.alias] ?? "absent";
    const action = targetAction(state);
    if (action === "conflict") {
      errors.push({
        code: "invalid_value",
        path: `repositories[${declared.alias}]`,
        message: "Issue worktree state conflicts with its expected identity",
      });
      continue;
    }
    const workBranch = declared.access === "write"
      ? renderBranchPattern(binding.workflow.branchPattern, {
        workspaceId: input.workspaceId,
        storyId: input.contract.storyId,
        repoAlias: declared.alias,
      })
      : null;
    repositories.push(
      declared.access === "read"
        ? { repoId: binding.repoId, alias: declared.alias, access: "read", requiredDelivery: false, ...(declared.dependsOnRepo === undefined ? {} : { dependsOnRepo: declared.dependsOnRepo }) }
        : {
          repoId: binding.repoId,
          alias: declared.alias,
          access: "write",
          requiredDelivery: declared.requiredDelivery,
          noChangePolicy: declared.requiredDelivery ? "changes_required" : "no_change_allowed",
          workBranch: workBranch as string,
          ...(declared.dependsOnRepo === undefined ? {} : { dependsOnRepo: declared.dependsOnRepo }),
        },
    );
    targets.push({
      alias: declared.alias,
      repoId: binding.repoId,
      access: declared.access,
      action,
      worktreePath: join("issues", input.contract.storyId, declared.alias),
      workBranch,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  const manifestAction = targetAction(probe.manifest.state);
  const outcome: IssueInitOutcome = manifestAction === "conflict"
    ? "repaired"
    : (manifestAction === "repaired" || targets.some((target) => target.action === "repaired"))
      ? "repaired"
      : targets.some((target) => target.action === "created")
        ? "created"
        : "reused";
  const linkedRequirements = resolveRequirementSourcesForStory(
    input.requirementManifests,
    input.contract.storyId,
  );
  const requirements: readonly RequirementSourceReference[] = linkedRequirements
    .map((manifest) => ({ provider: manifest.provider, ref: manifest.ref }));
  const deliveryTargets = new Map(linkedRequirements.flatMap((manifest) =>
    manifest.deliveryTarget === undefined ? [] : [[JSON.stringify(manifest.deliveryTarget), manifest.deliveryTarget] as const]
  ));
  if (deliveryTargets.size > 1) {
    return { ok: false, errors: [{ code: "invalid_value", path: "requirements.deliveryTarget", message: "Linked Requirements declare conflicting campaign delivery targets" }] };
  }
  const deliveryTarget = [...deliveryTargets.values()][0];
  const manifest: IssueManifest = {
    schema: ISSUE_MANIFEST_V1,
    workspaceId: input.workspaceId,
    storyId: input.contract.storyId,
    requirements,
    repositories,
    ...(input.contract.integrationAcceptance === undefined
      ? {}
      : { integrationAcceptance: input.contract.integrationAcceptance }),
    ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
  };
  const rollbackOrder = targets
    .filter((target) => target.action === "created")
    .map((target) => target.alias)
    .reverse();
  return { ok: true, value: { manifest, outcome, targets, rollbackOrder } };
}
