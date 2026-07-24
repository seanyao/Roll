import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveWorkspaceTarget, type WorkspaceContextCandidate } from "@roll/core";
import {
  RequirementSourceStoreError,
  WorkspaceRegistry,
  captureRequirementSource,
  type InspectedWorkspace,
} from "@roll/infra";
import { parseWorkspaceManifest, resolveLang, t, v3Catalog, type Lang } from "@roll/spec";
import { configLang } from "./lang.js";
import { workspaceRegistryCandidates, workspaceRollHome, workspaceTargetSelector } from "./workspace-target.js";
import { isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";

const RESULT_V1 = "roll.workspace-requirement-result/v1" as const;
const ERROR_V1 = "roll.workspace-requirement-error/v1" as const;

interface RequirementArgs {
  readonly workspace?: string;
  readonly provider: string;
  readonly ref: string;
  readonly revision: string;
  readonly bodyFile: string;
  readonly contextRoot?: string;
  readonly contextPaths: readonly string[];
  readonly storyIds: readonly string[];
  readonly json: boolean;
}

interface RequirementCommandDeps {
  readonly now?: () => Date;
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

export function workspaceRequirementUsage(): string {
  return `${msg("workspace.requirement.usage")}\n`;
}

function emitError(code: string, json: boolean, candidates: readonly { readonly workspaceId: string; readonly root: string }[] = []): number {
  const key = code.startsWith("workspace_") ? code.slice("workspace_".length) : code;
  const targetMessage = v3Catalog[`workspace.error.${key}`];
  const message = targetMessage === undefined ? msg(`workspace.requirement.error.${key}`) : msg(`workspace.error.${key}`);
  if (json) {
    process.stderr.write(`${JSON.stringify({
      schema: ERROR_V1,
      error: { code: key, message, candidates: candidates.map((candidate) => ({ workspaceId: candidate.workspaceId, path: candidate.root })) },
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`${msg("workspace.requirement.error.line", key, message)}\n`);
  }
  return 1;
}

function parseArgs(args: readonly string[]): RequirementArgs | undefined {
  if (args[0] !== "add") return undefined;
  const scalar = new Map<string, string>();
  const contextPaths: string[] = [];
  const storyIds: string[] = [];
  let json = false;
  const scalarFlags = new Set(["--provider", "--ref", "--revision", "--body-file", "--context-root"]);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (arg === "--context" || arg === "--story" || isCanonicalWorkspaceSelectorToken(arg) || (arg !== undefined && scalarFlags.has(arg))) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      index += 1;
      if (arg === "--context") contextPaths.push(value);
      else if (arg === "--story") storyIds.push(value);
      else {
        if (scalar.has(arg)) return undefined;
        scalar.set(arg, value);
      }
      continue;
    }
    return undefined;
  }
  const provider = scalar.get("--provider");
  const ref = scalar.get("--ref");
  const revision = scalar.get("--revision");
  const bodyFile = scalar.get("--body-file");
  if (provider === undefined || ref === undefined || revision === undefined || bodyFile === undefined || storyIds.length === 0) return undefined;
  const workspace = scalar.get("--workspace");
  const contextRoot = scalar.get("--context-root");
  if (contextPaths.length > 0 && contextRoot === undefined) return undefined;
  return {
    ...(workspace === undefined ? {} : { workspace }),
    provider,
    ref,
    revision,
    bodyFile: resolve(bodyFile),
    ...(contextRoot === undefined ? {} : { contextRoot: resolve(contextRoot) }),
    contextPaths,
    storyIds,
    json,
  };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function cwdContext(cwd: string, entries: readonly InspectedWorkspace[]): WorkspaceContextCandidate | undefined {
  let cursor = resolve(cwd);
  while (true) {
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

function emitResult(result: ReturnType<typeof captureRequirementSource>, jsonOutput: boolean): number {
  const view = {
    schema: RESULT_V1,
    outcome: result.outcome,
    workspaceId: result.workspaceId,
    source: { provider: result.manifest.provider, ref: result.manifest.ref },
    revision: result.manifest.revision,
    contextCount: result.contextCount,
    storyCount: result.manifest.stories.length,
    path: result.requirementPath,
  };
  if (jsonOutput) process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  else {
    process.stdout.write([
      msg("workspace.requirement.result.title", view.source.provider, view.source.ref, view.revision, view.outcome),
      msg("workspace.requirement.result.context", view.contextCount),
      msg("workspace.requirement.result.stories", view.storyCount),
      msg("workspace.requirement.result.path", view.path),
    ].join("\n") + "\n");
  }
  return 0;
}

export function workspaceRequirementCommand(args: string[], deps: RequirementCommandDeps = {}): number {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(workspaceRequirementUsage());
    return 0;
  }
  const parsed = parseArgs(args);
  const jsonOutput = args.includes("--json");
  if (parsed === undefined) return emitError("invalid_arguments", jsonOutput);
  const registry = new WorkspaceRegistry({ rollHome: workspaceRollHome() });
  let entries: readonly InspectedWorkspace[];
  try {
    entries = registry.inspect();
  } catch {
    return emitError("invalid_workspace", parsed.json);
  }
  const environment = process.env["ROLL_WORKSPACE"];
  const decision = resolveWorkspaceTarget({
    operation: "mutation",
    registry: workspaceRegistryCandidates(entries),
    ...(parsed.workspace === undefined ? {} : { explicit: workspaceTargetSelector(parsed.workspace) }),
    ...(environment === undefined || environment === "" ? {} : { environment: workspaceTargetSelector(environment) }),
    context: { cwdManifest: cwdContext((deps.cwd ?? process.cwd)(), entries) },
  });
  if (!decision.ok) return emitError(decision.error.code, parsed.json, decision.error.candidates);
  if (decision.target.kind !== "workspace") return emitError("invalid_arguments", parsed.json);
  try {
    return emitResult(captureRequirementSource({
      rollHome: workspaceRollHome(),
      workspaceRoot: decision.target.root,
      provider: parsed.provider,
      ref: parsed.ref,
      revision: parsed.revision,
      capturedAt: (deps.now ?? (() => new Date()))().toISOString(),
      bodyFile: parsed.bodyFile,
      ...(parsed.contextRoot === undefined ? {} : { contextRoot: parsed.contextRoot }),
      contextPaths: parsed.contextPaths,
      storyIds: parsed.storyIds,
    }), parsed.json);
  } catch (error) {
    if (error instanceof RequirementSourceStoreError) return emitError(error.code, parsed.json);
    return emitError("io_failure", parsed.json);
  }
}
