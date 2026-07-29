import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  resolveWorkspaceTarget,
  validateStoryId,
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
  type InspectedWorkspace,
  type IssueCheckReport,
} from "@roll/infra";
import { parseWorkspaceManifest, resolveLang, t, v3Catalog, type Lang } from "@roll/spec";
import { configLang } from "./lang.js";
import { workspaceRegistryCandidates, workspaceRollHome, workspaceTargetSelector } from "./workspace-target.js";
import { canonicalWorkspaceSelectorValue, isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";

const CHECK_RESULT_V1 = "roll.workspace-issue-check/v1" as const;
const APPLY_RESULT_V1 = "roll.workspace-issue-apply/v1" as const;
const ERROR_V1 = "roll.workspace-issue-error/v1" as const;

interface IssueInitArgs {
  readonly storyId: string;
  readonly workspace?: string;
  readonly check: boolean;
  readonly json: boolean;
}

interface IssueCommandDeps {
  readonly cwd?: () => string;
}

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

function parseArgs(args: readonly string[]): IssueInitArgs | undefined {
  if (args[0] !== "init") return undefined;
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
  return { storyId: positional[0], ...(workspace === undefined ? {} : { workspace }), check, json };
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

export async function workspaceIssueCommand(args: string[], deps: IssueCommandDeps = {}): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(workspaceIssueUsage());
    return 0;
  }
  const parsed = parseArgs(args);
  const jsonOutput = args.includes("--json");
  if (parsed === undefined) return emitError("invalid_arguments", jsonOutput);
  if (!validateStoryId(parsed.storyId).ok) return emitError("invalid_story_id", parsed.json);

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

  const contract = loadContract(workspaceRoot, parsed.storyId);
  if (!contract.ok) return emitError(contract.code, parsed.json);

  let bindings;
  try {
    bindings = readWorkspace(workspaceRoot).repositories;
  } catch {
    return emitError("invalid_workspace", parsed.json);
  }
  const requirementManifests = resolveRequirementSourcesForStoryOnDisk(workspaceRoot, parsed.storyId);
  const issueRoot = join(workspaceRoot, "issues", parsed.storyId);
  const rollHome = workspaceRollHome();

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
