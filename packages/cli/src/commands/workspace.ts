import { resolve } from "node:path";
import {
  resolveWorkspaceTarget,
  type WorkspaceTargetFailureCode,
} from "@roll/core";
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  type InspectedWorkspace,
  type WorkspaceRegistryErrorCode,
} from "@roll/infra";
import { resolveLang, t, v3Catalog, type Lang } from "@roll/spec";
import { configLang } from "./lang.js";
import { workspaceCreateCommand } from "./workspace-create.js";
import { workspaceIssueCommand } from "./workspace-issue.js";
import { workspaceRequirementCommand } from "./workspace-requirement.js";
import { workspaceDoctorCommand } from "./workspace-doctor.js";
import { workspaceMigrateCommand } from "./workspace-migrate.js";
import { workspaceEditCommand } from "./workspace-edit.js";
import { workspaceRegistryCandidates, workspaceRollHome, workspaceTargetSelector } from "./workspace-target.js";
import { canonicalWorkspaceSelectorValue, containsCanonicalWorkspaceSelector, isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";

const WORKSPACE_LIST_V1 = "roll.workspace-list/v1" as const;
const WORKSPACE_VIEW_V1 = "roll.workspace-view/v1" as const;
const WORKSPACE_MUTATION_V1 = "roll.workspace-mutation/v1" as const;
const WORKSPACE_ERROR_V1 = "roll.workspace-error/v1" as const;

type WorkspaceOperation = "register" | "activate" | "pause" | "archive";

interface WorkspaceView {
  readonly workspaceId: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly lifecycle: InspectedWorkspace["lifecycle"];
  readonly manifest: {
    readonly workspaceId: string | null;
    readonly consistency: InspectedWorkspace["consistency"];
  };
  readonly runtimeHealth: {
    readonly status: "unknown";
    readonly reason: "scheduler_not_available";
  };
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

export function workspaceUsage(): string {
  return msg("workspace.usage");
}

function view(entry: InspectedWorkspace): WorkspaceView {
  return {
    workspaceId: entry.workspaceId,
    path: entry.root,
    canonicalPath: entry.canonicalRoot,
    lifecycle: entry.lifecycle,
    manifest: {
      workspaceId: entry.manifestWorkspaceId,
      consistency: entry.consistency,
    },
    runtimeHealth: {
      status: "unknown",
      reason: "scheduler_not_available",
    },
  };
}

function positionalArgs(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--all") continue;
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      index += 1;
      continue;
    }
    if (arg !== undefined) values.push(arg);
  }
  return values;
}

function unknownFlags(args: readonly string[]): string[] {
  const allowed = new Set(["--json", "--all"]);
  return args.filter((arg) => arg.startsWith("-") && !isCanonicalWorkspaceSelectorToken(arg) && !allowed.has(arg));
}

function errorMessage(code: WorkspaceTargetFailureCode | WorkspaceRegistryErrorCode | "invalid_arguments"): string {
  return msg(`workspace.error.${code}`);
}

function emitError(
  code: WorkspaceTargetFailureCode | WorkspaceRegistryErrorCode | "invalid_arguments",
  json: boolean,
  entries: readonly { readonly workspaceId: string; readonly root: string }[] = [],
): number {
  const message = errorMessage(code);
  if (json) {
    process.stderr.write(`${JSON.stringify({
      schema: WORKSPACE_ERROR_V1,
      error: {
        code,
        message,
        candidates: entries.map((entry) => ({ workspaceId: entry.workspaceId, path: entry.root })),
      },
    }, null, 2)}\n`);
    return 1;
  }
  process.stderr.write(`${msg("workspace.error.line", code, message)}\n`);
  if (entries.length > 0) {
    process.stderr.write(`${msg("workspace.error.candidates", entries.map((entry) => `${entry.workspaceId}=${entry.root}`).join(", "))}\n`);
  }
  return 1;
}

function lifecycleLabel(value: WorkspaceView["lifecycle"]): string {
  return msg(`workspace.lifecycle.${value}`);
}

function consistencyLabel(value: WorkspaceView["manifest"]["consistency"]): string {
  return msg(`workspace.consistency.${value}`);
}

function renderList(workspaces: readonly WorkspaceView[]): string {
  const lines = [
    msg("workspace.list.title", workspaces.length),
    msg("workspace.list.header"),
    ...workspaces.map((workspace) => [
      workspace.workspaceId,
      lifecycleLabel(workspace.lifecycle),
      msg("workspace.runtime.unknown"),
      consistencyLabel(workspace.manifest.consistency),
      workspace.path,
    ].join("\t")),
  ];
  return `${lines.join("\n")}\n`;
}

function renderShow(workspace: WorkspaceView): string {
  return [
    msg("workspace.show.title", workspace.workspaceId),
    msg("workspace.show.path", workspace.path),
    msg("workspace.show.lifecycle", lifecycleLabel(workspace.lifecycle)),
    msg("workspace.show.runtime", msg("workspace.runtime.unknown"), msg("workspace.runtime.scheduler_not_available")),
    msg(
      "workspace.show.consistency",
      consistencyLabel(workspace.manifest.consistency),
      workspace.manifest.workspaceId ?? msg("workspace.manifest.missing"),
    ),
  ].join("\n") + "\n";
}

function inspect(store: WorkspaceRegistry): readonly InspectedWorkspace[] {
  return store.inspect().slice().sort((left, right) => left.workspaceId.localeCompare(right.workspaceId, "en"));
}

function resolveOne(
  entries: readonly InspectedWorkspace[],
  target: string | undefined,
  all: boolean,
  operation: "read" | "mutation",
) {
  return resolveWorkspaceTarget({
    operation,
    registry: workspaceRegistryCandidates(entries),
    all,
    ...(target === undefined ? {} : { explicit: workspaceTargetSelector(target) }),
  });
}

function parseTarget(args: readonly string[]): { readonly ok: true; readonly target?: string } | { readonly ok: false } {
  if (unknownFlags(args).length > 0) return { ok: false };
  const optionTarget = canonicalWorkspaceSelectorValue(args);
  if (containsCanonicalWorkspaceSelector(args) && optionTarget === undefined) return { ok: false };
  const positional = positionalArgs(args);
  if (positional.length > 1 || (optionTarget !== undefined && positional.length > 0)) return { ok: false };
  const target = optionTarget ?? positional[0];
  return target === undefined ? { ok: true } : { ok: true, target };
}

function mutationSuccess(operation: WorkspaceOperation, workspace: WorkspaceView, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema: WORKSPACE_MUTATION_V1, operation, workspace }, null, 2)}\n`);
  } else {
    process.stdout.write(`${msg(`workspace.success.${operation}`, workspace.workspaceId, workspace.path)}\n`);
  }
  return 0;
}

function listCommand(args: readonly string[], store: WorkspaceRegistry): number {
  const json = args.includes("--json");
  if (unknownFlags(args).length > 0 || positionalArgs(args).length > 0 || containsCanonicalWorkspaceSelector(args)) {
    return emitError("invalid_arguments", json);
  }
  try {
    const workspaces = inspect(store).map(view);
    process.stdout.write(json
      ? `${JSON.stringify({ schema: WORKSPACE_LIST_V1, workspaces }, null, 2)}\n`
      : renderList(workspaces));
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) return emitError(error.code, json);
    throw error;
  }
}

function showCommand(args: readonly string[], store: WorkspaceRegistry): number {
  const json = args.includes("--json");
  const parsed = parseTarget(args);
  if (!parsed.ok || args.includes("--all")) return emitError("invalid_arguments", json);
  try {
    const entries = inspect(store);
    const decision = resolveOne(entries, parsed.target, false, "read");
    if (!decision.ok) return emitError(decision.error.code, json, decision.error.candidates);
    if (decision.target.kind !== "workspace") return emitError("invalid_arguments", json);
    const target = decision.target;
    const entry = entries.find((candidate) => candidate.workspaceId === target.workspaceId);
    if (entry === undefined) return emitError("target_missing", json);
    const workspace = view(entry);
    process.stdout.write(json
      ? `${JSON.stringify({ schema: WORKSPACE_VIEW_V1, workspace }, null, 2)}\n`
      : renderShow(workspace));
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) return emitError(error.code, json);
    throw error;
  }
}

function registerCommand(args: readonly string[], store: WorkspaceRegistry): number {
  const json = args.includes("--json");
  if (unknownFlags(args).length > 0 || args.includes("--all") || containsCanonicalWorkspaceSelector(args)) {
    return emitError("invalid_arguments", json);
  }
  const positional = positionalArgs(args);
  const workspaceId = positional[0];
  const root = positional[1];
  if (workspaceId === undefined || root === undefined || positional.length !== 2) {
    return emitError("invalid_arguments", json);
  }
  try {
    store.register({ workspaceId, root: resolve(root) });
    const entry = inspect(store).find((candidate) => candidate.workspaceId === workspaceId);
    if (entry === undefined) return emitError("not_found", json);
    return mutationSuccess("register", view(entry), json);
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) return emitError(error.code, json);
    throw error;
  }
}

function lifecycleCommand(
  operation: Exclude<WorkspaceOperation, "register">,
  args: readonly string[],
  store: WorkspaceRegistry,
): number {
  const json = args.includes("--json");
  const parsed = parseTarget(args);
  if (!parsed.ok) return emitError("invalid_arguments", json);
  try {
    const entries = inspect(store);
    const decision = resolveOne(entries, parsed.target, args.includes("--all"), "mutation");
    if (!decision.ok) return emitError(decision.error.code, json, decision.error.candidates);
    if (decision.target.kind !== "workspace") return emitError("invalid_arguments", json);
    const target = decision.target;
    store[operation](target.workspaceId);
    const entry = inspect(store).find((candidate) => candidate.workspaceId === target.workspaceId);
    if (entry === undefined) return emitError("target_missing", json);
    return mutationSuccess(operation, view(entry), json);
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) return emitError(error.code, json);
    throw error;
  }
}

export function workspaceCommand(args: string[]): number | Promise<number> {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(workspaceUsage());
    return 0;
  }
  const rest = args.slice(1);
  if (subcommand === "create") return workspaceCreateCommand(rest);
  if (subcommand === "init") {
    process.stderr.write(`${msg("workspace.error.legacy_init_subcommand")}\n`);
    return 1;
  }
  if (subcommand === "issue") return workspaceIssueCommand(rest);
  if (subcommand === "requirement") return workspaceRequirementCommand(rest);
  if (subcommand === "doctor") return workspaceDoctorCommand(rest);
  if (subcommand === "migrate") return workspaceMigrateCommand(rest);
  if (subcommand === "edit") return workspaceEditCommand(rest);
  const store = new WorkspaceRegistry({ rollHome: workspaceRollHome() });
  if (subcommand === "list") return listCommand(rest, store);
  if (subcommand === "show") return showCommand(rest, store);
  if (subcommand === "register") return registerCommand(rest, store);
  if (subcommand === "activate" || subcommand === "pause" || subcommand === "archive") {
    return lifecycleCommand(subcommand, rest, store);
  }
  return emitError("invalid_arguments", rest.includes("--json"));
}
