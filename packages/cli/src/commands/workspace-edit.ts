import { lstatSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  buildWorkspaceEditPlan,
  parseWorkspaceEditConfig,
  resolveWorkspaceTarget,
} from "@roll/core";
import {
  applyWorkspaceEditPlan,
  collectWorkspaceMetadataReferenceIndex,
  readWorkspace,
  WorkspaceEditTransactionError,
  WorkspaceReferenceIndexError,
  WorkspaceRegistry,
  WorkspaceRegistryError,
} from "@roll/infra";
import { resolveLang, t, v3Catalog, type Lang, type WorkspaceEditPlan } from "@roll/spec";
import { configLang } from "./lang.js";
import {
  workspaceRegistryCandidates,
  workspaceRollHome,
  workspaceTargetSelector,
} from "./workspace-target.js";

const WORKSPACE_EDIT_ERROR_V1 = "roll.workspace-edit-error/v1" as const;
const WORKSPACE_EDIT_RESULT_V1 = "roll.workspace-edit-result/v1" as const;
const MAX_EDIT_CONFIG_BYTES = 1024 * 1024;

type WorkspaceEditErrorCode =
  | "invalid_arguments"
  | "config_read_failed"
  | "target_missing"
  | "invalid_workspace"
  | "reference_index_invalid"
  | "concurrent_edit"
  | "manifest_changed"
  | "edit_plan_changed"
  | "metadata_referenced"
  | "partial_apply_recovered"
  | "io_failure"
  | "unknown_version"
  | "unknown_field"
  | "invalid_type"
  | "invalid_value"
  | "identity_mismatch"
  | "duplicate_identity"
  | "unsafe_remote"
  | "repo_id_mismatch";

interface ParsedArgs {
  readonly workspace: string;
  readonly configPath: string;
  readonly json: boolean;
  readonly check: boolean;
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

export function workspaceEditUsage(): string {
  return msg("workspace.edit.usage");
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  let json = false;
  let check = false;
  let configPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (arg === "--check") {
      if (check) return undefined;
      check = true;
      continue;
    }
    if (arg === "--config") {
      const value = args[index + 1];
      if (configPath !== undefined || value === undefined || value.startsWith("-")) return undefined;
      configPath = resolve(value);
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith("-")) return undefined;
    positional.push(arg);
  }
  if (configPath === undefined || positional.length !== 1 || positional[0] === undefined) return undefined;
  return { workspace: positional[0], configPath, json, check };
}

function emitError(code: WorkspaceEditErrorCode, json: boolean, details: readonly unknown[] = [], action?: string): number {
  const message = msg(`workspace.edit.error.${code}`);
  if (json) {
    process.stderr.write(`${JSON.stringify({
      schema: WORKSPACE_EDIT_ERROR_V1,
      error: { code, message, ...(details.length === 0 ? {} : { details }), ...(action === undefined ? {} : { action }) },
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`${msg("workspace.edit.error.line", code, message)}\n`);
    if (action !== undefined) process.stderr.write(`${msg("workspace.edit.recovery", action)}\n`);
  }
  return 1;
}

function stableConfig(path: string): string | undefined {
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_EDIT_CONFIG_BYTES) return undefined;
    const text = readFileSync(path, "utf8");
    const after = lstatSync(path);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || Buffer.byteLength(text, "utf8") !== before.size
    ) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function renderHuman(plan: WorkspaceEditPlan): string {
  const lines = [
    msg("workspace.edit.title", plan.workspaceId, plan.outcome),
    msg("workspace.edit.manifest", plan.manifestPath),
    msg("workspace.edit.digests", plan.beforeSha256, plan.afterSha256, plan.referenceIndexSha256),
    msg("workspace.edit.header"),
    ...plan.changes.map((entry) => `${entry.safety}\t${entry.operation}\t${entry.path}`),
  ];
  for (const blocker of plan.blockers) {
    lines.push(msg("workspace.edit.blocker", blocker.code, blocker.path, blocker.references.map((reference) => reference.authorityPath).join(",")));
  }
  if (plan.nextAction.command !== undefined) lines.push(msg("workspace.edit.next", plan.nextAction.command));
  return `${lines.join("\n")}\n`;
}

function emitPlan(plan: WorkspaceEditPlan, json: boolean): number {
  process.stdout.write(json ? `${JSON.stringify(plan, null, 2)}\n` : renderHuman(plan));
  return plan.outcome === "ready" ? 0 : 2;
}

function emitResult(
  result: { readonly outcome: "applied" | "reused"; readonly workspaceId: string; readonly beforeSha256: string; readonly afterSha256: string; readonly referenceIndexSha256: string },
  manifestPath: string,
  json: boolean,
): number {
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema: WORKSPACE_EDIT_RESULT_V1, ...result, manifestPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`${msg("workspace.edit.applied", result.workspaceId, msg(`workspace.edit.outcome.${result.outcome}`), result.afterSha256)}\n`);
  }
  return 0;
}

export async function workspaceEditCommand(args: readonly string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(workspaceEditUsage());
    return 0;
  }
  const parsedArgs = parseArgs(args);
  const json = args.includes("--json");
  if (parsedArgs === undefined) return emitError("invalid_arguments", json);
  const configText = stableConfig(parsedArgs.configPath);
  if (configText === undefined) return emitError("config_read_failed", parsedArgs.json);

  try {
    const registry = new WorkspaceRegistry({ rollHome: workspaceRollHome() });
    const entries = registry.inspect();
    const decision = resolveWorkspaceTarget({
      operation: "mutation",
      registry: workspaceRegistryCandidates(entries),
      explicit: workspaceTargetSelector(parsedArgs.workspace),
    });
    if (!decision.ok || decision.target.kind !== "workspace") {
      return emitError("target_missing", parsedArgs.json, decision.ok ? [] : decision.error.candidates);
    }
    const target = decision.target;
    const entry = entries.find((candidate) => candidate.workspaceId === target.workspaceId);
    if (entry === undefined || entry.consistency !== "consistent") return emitError("invalid_workspace", parsedArgs.json);
    const config = parseWorkspaceEditConfig(configText, { workspaceId: entry.workspaceId });
    if (!config.ok) return emitError(config.errors[0]?.code ?? "invalid_value", parsedArgs.json, config.errors);
    const current = readWorkspace(entry.root);
    const references = collectWorkspaceMetadataReferenceIndex({ workspaceRoot: entry.root });
    const plan = buildWorkspaceEditPlan({
      config: config.value,
      current,
      references,
      manifestPath: join(entry.root, "workspace.yaml"),
      configPath: parsedArgs.configPath,
    });
    if (parsedArgs.check) return emitPlan(plan, parsedArgs.json);
    const result = await applyWorkspaceEditPlan({
      rollHome: workspaceRollHome(),
      plan,
      reloadCurrent: () => ({
        manifest: readWorkspace(entry.root),
        references: collectWorkspaceMetadataReferenceIndex({ workspaceRoot: entry.root }),
      }),
      rebuildPlan: (facts) => buildWorkspaceEditPlan({
        config: config.value,
        current: facts.manifest,
        references: facts.references,
        manifestPath: join(entry.root, "workspace.yaml"),
        configPath: parsedArgs.configPath,
      }),
    });
    return emitResult(result, plan.manifestPath, parsedArgs.json);
  } catch (error) {
    if (error instanceof WorkspaceEditTransactionError) {
      return emitError(error.code, parsedArgs.json, [], error.action);
    }
    if (error instanceof WorkspaceReferenceIndexError) return emitError("reference_index_invalid", parsedArgs.json, [{ code: error.code }]);
    if (error instanceof WorkspaceRegistryError) return emitError("invalid_workspace", parsedArgs.json, [{ code: error.code }]);
    return emitError("invalid_workspace", parsedArgs.json);
  }
}
