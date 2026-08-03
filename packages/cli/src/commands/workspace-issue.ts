import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  appendIdea,
  BacklogStore,
  ConflictError,
  inferEpic,
  lintIdeaDescription,
  nextIdeaId,
  prefixForKind,
  resolveWorkspaceTarget,
  validateStoryId,
  type BacklogItem,
  type IdeaKind,
  type IssueStoryContract,
  type WorkspaceContextCandidate,
} from "@roll/core";
import {
  IssueInitializationError,
  WorkspaceRegistry,
  applyIssueInit,
  inspectIssueInit,
  readWorkspace,
  resolveRequirementSourcesForStoryOnDisk,
  resolveWorkspaceBacklogStoryContract,
  withWorkspaceAuthorityLock,
  type InspectedWorkspace,
  type IssueCheckReport,
} from "@roll/infra";
import { isSafeRepositoryBaseRef, parseWorkspaceManifest, resolveLang, t, v3Catalog, type Lang } from "@roll/spec";
import { configLang } from "./lang.js";
import { generateIndex, UNCATEGORIZED } from "../lib/archive.js";
import { writeStoryCardFiles } from "../lib/story-mint.js";
import { workspaceRegistryCandidates, workspaceRollHome, workspaceTargetSelector } from "./workspace-target.js";
import { canonicalWorkspaceSelectorValue, isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";

const CHECK_RESULT_V1 = "roll.workspace-issue-check/v1" as const;
const APPLY_RESULT_V1 = "roll.workspace-issue-apply/v1" as const;
const CREATE_CHECK_RESULT_V1 = "roll.workspace-issue-create-check/v1" as const;
const CREATE_APPLY_RESULT_V1 = "roll.workspace-issue-create-apply/v1" as const;
const ERROR_V1 = "roll.workspace-issue-error/v1" as const;

interface IssueInitArgs {
  readonly kind: "init";
  readonly storyId: string;
  readonly workspace?: string;
  readonly check: boolean;
  readonly json: boolean;
}

interface IssueCreateRepositoryArgs {
  readonly alias: string;
  readonly access: "read" | "write";
  readonly baseRef?: string;
}

interface IssueCreateArgs {
  readonly kind: "create";
  readonly title: string;
  readonly workspace?: string;
  readonly type: IdeaKind;
  readonly storyId?: string;
  readonly repositories: readonly IssueCreateRepositoryArgs[];
  readonly check: boolean;
  readonly json: boolean;
}

type ParsedIssueArgs = IssueInitArgs | IssueCreateArgs;

interface IssueCommandDeps {
  readonly cwd?: () => string;
  readonly now?: () => Date;
  readonly inspect?: typeof inspectIssueInit;
  readonly apply?: typeof applyIssueInit;
  readonly afterApply?: () => void | Promise<void>;
}

class IssueCreateConflictError extends Error {}

function lang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    configLang: configLang(),
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function msg(key: string, ...args: ReadonlyArray<string | number>): string {
  return t(v3Catalog, lang(), key, ...args);
}

export function workspaceIssueUsage(): string {
  return `${msg("workspace.issue.usage")}\n`;
}

function emitError(code: string, json: boolean, candidates: readonly { readonly workspaceId: string; readonly root: string }[] = []): number {
  const message = msg(`workspace.issue.error.${code}`);
  if (json) {
    process.stderr.write(`${JSON.stringify({
      schema: ERROR_V1,
      error: { code, message, candidates: candidates.map((candidate) => ({ workspaceId: candidate.workspaceId, path: candidate.root })) },
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`${msg("workspace.issue.error.line", code, message)}\n`);
  }
  return 1;
}

function parseInitArgs(args: readonly string[]): IssueInitArgs | undefined {
  const scalar = new Map<string, string>();
  let check = false;
  let json = false;
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      if (check) return undefined;
      check = true;
      continue;
    }
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (scalar.has(arg)) return undefined;
      scalar.set(arg, value);
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith("-")) return undefined;
    positional.push(arg);
  }
  if (positional.length !== 1 || positional[0] === undefined) return undefined;
  const workspace = canonicalWorkspaceSelectorValue(args);
  return { kind: "init", storyId: positional[0], ...(workspace === undefined ? {} : { workspace }), check, json };
}

function parseRepository(value: string): IssueCreateRepositoryArgs | undefined {
  const [alias, access = "write", ...extra] = value.split(":");
  if (extra.length > 0 || alias === undefined || alias.trim() === "") return undefined;
  if (access !== "read" && access !== "write") return undefined;
  return { alias: alias.trim(), access };
}

function parseCreateArgs(args: readonly string[]): IssueCreateArgs | undefined {
  let check = false;
  let json = false;
  let type: IdeaKind | undefined;
  let storyId: string | undefined;
  const repositories: IssueCreateRepositoryArgs[] = [];
  const baseRefs = new Map<string, string>();
  const title: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      if (check) return undefined;
      check = true;
      continue;
    }
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      index += 1;
      continue;
    }
    if (arg === "--type") {
      const value = args[index + 1];
      if (value === "fix" || value === "bug") type = "bug";
      else if (value === "idea") type = "idea";
      else return undefined;
      index += 1;
      continue;
    }
    if (arg === "--id") {
      const value = args[index + 1];
      if (storyId !== undefined || value === undefined || value.startsWith("-")) return undefined;
      storyId = value;
      index += 1;
      continue;
    }
    if (arg === "--repository") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      const parsed = parseRepository(value);
      if (parsed === undefined || repositories.some((repository) => repository.alias === parsed.alias)) return undefined;
      repositories.push(parsed);
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      const value = args[index + 1];
      const separator = value?.indexOf("=") ?? -1;
      const alias = separator > 0 ? value!.slice(0, separator) : "";
      const baseRef = separator > 0 ? value!.slice(separator + 1) : "";
      if (
        value === undefined || value.startsWith("-") || baseRefs.has(alias) ||
        alias === "" || !isSafeRepositoryBaseRef(baseRef)
      ) return undefined;
      baseRefs.set(alias, baseRef);
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith("-")) return undefined;
    title.push(arg);
  }
  const workspace = canonicalWorkspaceSelectorValue(args);
  const joined = title.join(" ").trim();
  if (workspace === undefined || joined === "" || type === undefined || repositories.length === 0) return undefined;
  if ([...baseRefs.keys()].some((alias) => !repositories.some((repository) => repository.alias === alias))) return undefined;
  if (storyId !== undefined) {
    if (!validateStoryId(storyId).ok) return undefined;
    if (type === "bug" && !/^(?:FIX|BUG)-/u.test(storyId)) return undefined;
    if (type === "idea" && !/^IDEA-/u.test(storyId)) return undefined;
  }
  return {
    kind: "create",
    title: joined,
    workspace,
    type,
    ...(storyId === undefined ? {} : { storyId }),
    repositories: repositories.map((repository) => ({
      ...repository,
      ...(baseRefs.get(repository.alias) === undefined ? {} : { baseRef: baseRefs.get(repository.alias)! }),
    })),
    check,
    json,
  };
}

function parseArgs(args: readonly string[]): ParsedIssueArgs | undefined {
  if (args[0] === "init") return parseInitArgs(args);
  if (args[0] === "create") return parseCreateArgs(args);
  return undefined;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function cwdContext(cwd: string, entries: readonly InspectedWorkspace[]): WorkspaceContextCandidate | undefined {
  let cursor = resolve(cwd);
  for (;;) {
    const manifestPath = join(cursor, "workspace.yaml");
    if (existsSync(manifestPath)) {
      try {
        const parsed = parseWorkspaceManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
        if (!parsed.ok) return undefined;
        const entry = entries.find((candidate) => candidate.workspaceId === parsed.value.workspaceId);
        if (entry === undefined) return undefined;
        const canonicalCwd = realpathSync(cwd);
        return {
          workspaceId: entry.workspaceId,
          root: entry.root,
          canonicalRoot: entry.canonicalRoot,
          containment: contained(entry.canonicalRoot, canonicalCwd) ? "safe" : "symlink_escape",
        };
      } catch {
        return undefined;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function loadContract(workspaceRoot: string, storyId: string): { readonly ok: true; readonly value: IssueStoryContract } | { readonly ok: false; readonly code: string } {
  const resolved = resolveWorkspaceBacklogStoryContract(workspaceRoot, storyId);
  if (!resolved.ok) return { ok: false, code: resolved.code };
  return { ok: true, value: resolved.value };
}

function renderCheck(report: IssueCheckReport, storyId: string): string {
  const lines = [
    msg("workspace.issue.check.title", storyId, report.manifest.state),
    msg("workspace.issue.check.header"),
    ...Object.values(report.targets).map((target) => [
      target.alias,
      target.access,
      target.repoId,
      target.cachePath,
      target.cacheState,
      target.baseSha ?? "-",
      target.worktreePath,
      target.workBranch ?? "-",
      target.decision,
    ].join("\t")),
  ];
  return `${lines.join("\n")}\n`;
}

function renderApply(outcome: string, storyId: string, manifest: unknown): string {
  return `${msg("workspace.issue.apply.title", storyId, outcome)}\n${JSON.stringify(manifest, null, 2)}\n`;
}

function storyCardIds(featuresDir: string): BacklogItem[] {
  try {
    return readdirSync(featuresDir, { withFileTypes: true }).flatMap((epic) => {
      if (!epic.isDirectory()) return [];
      const epicDir = join(featuresDir, epic.name);
      return readdirSync(epicDir, { withFileTypes: true }).flatMap((card) =>
        card.isDirectory() && existsSync(join(epicDir, card.name, "spec.md"))
          ? [{ id: card.name, desc: "", status: "" }]
          : []
      );
    });
  } catch {
    return [];
  }
}

function createContract(storyId: string, repositories: readonly IssueCreateRepositoryArgs[]): IssueStoryContract {
  return {
    storyId,
    repositories: repositories.map((repository) => ({
      alias: repository.alias,
      access: repository.access,
      requiredDelivery: repository.access === "write",
      ...(repository.baseRef === undefined ? {} : { baseRef: repository.baseRef }),
    })),
  };
}

async function createIssue(
  parsed: IssueCreateArgs,
  input: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly rollHome: string;
    readonly bindings: ReturnType<typeof readWorkspace>["repositories"];
  },
  deps: IssueCommandDeps,
): Promise<number> {
  const violations = lintIdeaDescription(parsed.title);
  if (violations.length > 0) return emitError("invalid_value", parsed.json);

  const backlogPath = join(input.workspaceRoot, "backlog", "index.md");
  const featuresDir = join(input.workspaceRoot, "features");
  const store = new BacklogStore();
  let snapshot;
  try {
    snapshot = store.readBacklog(backlogPath);
  } catch {
    return emitError("invalid_workspace", parsed.json);
  }
  const storyId = parsed.storyId ?? nextIdeaId(
    [...snapshot.items, ...storyCardIds(featuresDir)],
    prefixForKind(parsed.type),
  );
  const epic = inferEpic(parsed.title) ?? UNCATEGORIZED;
  const cardDir = join(featuresDir, epic, storyId);
  if (existsSync(join(cardDir, "spec.md"))) return emitError("duplicate_story", parsed.json);

  const contract = createContract(storyId, parsed.repositories);
  const requirementManifests = resolveRequirementSourcesForStoryOnDisk(input.workspaceRoot, storyId);
  const issueRoot = join(input.workspaceRoot, "issues", storyId);
  const inspect = deps.inspect ?? inspectIssueInit;
  const report = await inspect({
    workspaceId: input.workspaceId,
    rollHome: input.rollHome,
    workspaceRoot: input.workspaceRoot,
    issueRoot,
    contract,
    bindings: input.bindings,
    requirementManifests,
  });
  const story = { id: storyId, title: parsed.title, type: parsed.type, epic };
  if (parsed.check) {
    const result = {
      schema: CREATE_CHECK_RESULT_V1,
      workspaceId: input.workspaceId,
      story,
      repositories: contract.repositories,
      report,
    };
    process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : renderCheck(report, storyId));
    return 0;
  }
  if (report.manifest.state === "conflict" || Object.values(report.targets).some((target) => target.decision === "conflict")) {
    return emitError("rejected", parsed.json);
  }

  try {
    const apply = deps.apply ?? applyIssueInit;
    const applied = await apply({
      workspaceId: input.workspaceId,
      rollHome: input.rollHome,
      workspaceRoot: input.workspaceRoot,
      issueRoot,
      contract,
      bindings: input.bindings,
      requirementManifests,
    });
    await deps.afterApply?.();
    await withWorkspaceAuthorityLock({
      rollHome: input.rollHome,
      workspaceId: input.workspaceId,
      operation: "issue-create",
    }, async () => {
      if (existsSync(join(cardDir, "spec.md"))) throw new IssueCreateConflictError(`Story ${storyId} already exists`);
      try {
        writeStoryCardFiles(cardDir, {
          id: storyId,
          title: parsed.title,
          type: parsed.type,
          ...(epic === UNCATEGORIZED ? {} : { epic }),
          created: (deps.now ?? (() => new Date()))().toISOString().slice(0, 10),
          repositories: contract.repositories,
        });
        store.writeBacklog(backlogPath, snapshot.hash, (content) =>
          appendIdea(content, storyId, parsed.type, parsed.title, { epic, linkPrefix: "../features" }).content
        );
      } catch (error) {
        rmSync(cardDir, { recursive: true, force: true });
        throw error;
      }
    });
    try {
      generateIndex(input.workspaceRoot, "workspace");
    } catch {
      // The live filesystem remains authoritative; index.json is a rebuildable cache.
    }
    const result = {
      schema: CREATE_APPLY_RESULT_V1,
      workspaceId: input.workspaceId,
      story,
      outcome: applied.outcome,
      manifest: applied.manifest,
    };
    process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : renderApply(applied.outcome, storyId, applied.manifest));
    return 0;
  } catch (error) {
    if (error instanceof ConflictError || error instanceof IssueCreateConflictError) return emitError("rejected", parsed.json);
    if (error instanceof IssueInitializationError) return emitError(error.code, parsed.json);
    return emitError("apply_failed", parsed.json);
  }
}

export async function workspaceIssueCommand(args: string[], deps: IssueCommandDeps = {}): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(workspaceIssueUsage());
    return 0;
  }
  const parsed = parseArgs(args);
  const jsonOutput = args.includes("--json");
  if (parsed === undefined) return emitError("invalid_arguments", jsonOutput);
  if (parsed.kind === "init" && !validateStoryId(parsed.storyId).ok) return emitError("invalid_story_id", parsed.json);

  const registry = new WorkspaceRegistry({ rollHome: workspaceRollHome() });
  let entries: readonly InspectedWorkspace[];
  try {
    entries = registry.inspect();
  } catch {
    return emitError("invalid_workspace", parsed.json);
  }
  const cwd = (deps.cwd ?? process.cwd)();
  const environment = process.env["ROLL_WORKSPACE"];
  const decision = resolveWorkspaceTarget({
    operation: parsed.check ? "read" : "mutation",
    registry: workspaceRegistryCandidates(entries),
    ...(parsed.workspace === undefined ? {} : { explicit: workspaceTargetSelector(parsed.workspace) }),
    ...(environment === undefined || environment === "" ? {} : { environment: workspaceTargetSelector(environment) }),
    context: { cwdManifest: cwdContext(cwd, entries) },
  });
  if (!decision.ok) return emitError(decision.error.code, parsed.json, decision.error.candidates);
  if (decision.target.kind !== "workspace") return emitError("invalid_arguments", parsed.json);
  const workspaceRoot = decision.target.root;
  const workspaceId = decision.target.workspaceId;

  let bindings;
  try {
    bindings = readWorkspace(workspaceRoot).repositories;
  } catch {
    return emitError("invalid_workspace", parsed.json);
  }
  const rollHome = workspaceRollHome();
  if (parsed.kind === "create") {
    return createIssue(parsed, { workspaceId, workspaceRoot, rollHome, bindings }, deps);
  }

  const contract = loadContract(workspaceRoot, parsed.storyId);
  if (!contract.ok) return emitError(contract.code, parsed.json);
  const requirementManifests = resolveRequirementSourcesForStoryOnDisk(workspaceRoot, parsed.storyId);
  const issueRoot = join(workspaceRoot, "issues", parsed.storyId);

  if (parsed.check) {
    const report = await inspectIssueInit({ workspaceId, rollHome, workspaceRoot, issueRoot, contract: contract.value, bindings, requirementManifests });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ schema: CHECK_RESULT_V1, storyId: parsed.storyId, workspaceId, report }, null, 2)}\n`);
    } else {
      process.stdout.write(renderCheck(report, parsed.storyId));
    }
    return 0;
  }

  try {
    const result = await applyIssueInit({
      workspaceId,
      rollHome,
      workspaceRoot,
      issueRoot,
      contract: contract.value,
      bindings,
      requirementManifests,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ schema: APPLY_RESULT_V1, storyId: parsed.storyId, workspaceId, outcome: result.outcome, manifest: result.manifest }, null, 2)}\n`);
    } else {
      process.stdout.write(renderApply(result.outcome, parsed.storyId, result.manifest));
    }
    return 0;
  } catch (error) {
    if (error instanceof IssueInitializationError) return emitError(error.code, parsed.json);
    throw error;
  }
}
