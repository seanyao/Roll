/**
 * @responsibility Collects the tools-on-this-machine panel rows.
 */
/**
 * US-TOOL-016 — the machine-global "tools on this machine" collector. One row
 * per built-in tool adapter declaration, summarizing its capabilities and
 * default guardrails. This is the single source the Tools page (US-TOOL-017)
 * renders from, exactly as the Skills page reads `auditSkills` and the Agents
 * page reads `collectAgentPanel`: the catalog can never disagree with the
 * actually-registered adapters because it maps over `builtinToolDeclarations()`.
 *
 * Machine-global → takes no project argument. The built-in catalog is stable,
 * while requirement readiness reflects this host's dependency state.
 */
import { deriveToolReadiness, schemaParameterSummary, schemaTypeLabel } from "@roll/core";
import { builtinToolDeclarations } from "@roll/infra";
import type { ToolDeclaration, ToolDefaults, ToolKind, ToolReadinessStatus, ToolRequirement, ToolRequirementStatus, ToolSandbox } from "@roll/spec";
import { resolveRequirement } from "./external-tools.js";

export interface ToolPanelGuardrails {
  timeoutMs?: number;
  /** defaults.retry?.attempts — omitted when the declaration sets no retry. */
  retries?: number;
  /** A human label derived from defaults.sandbox — omitted when none. */
  sandbox?: string;
  maxPerCycle?: number;
}

export interface ToolPanelRequirementRow {
  name: string;
  kind: ToolRequirement["kind"];
  optional: boolean;
  label: string;
  status: ToolRequirementStatus;
  detail: string;
  repairCommand?: string;
  authorizeCommand?: string;
}

export interface ToolPanelRow {
  id: string;
  kind: ToolKind;
  title: string;
  /** declaration.description ?? "" */
  description: string;
  /** declaration.emitsEvents ?? false */
  emitsEvents: boolean;
  /** Summarized from declaration.defaults (ToolDefaults); unset sub-fields omitted. */
  guardrails: ToolPanelGuardrails;
  /** declaration.requirements mapped to human labels; [] when none. */
  requirements: string[];
  /** Live requirement resolution rows, visually nested under this tool. */
  requirementDetails: ToolPanelRequirementRow[];
  /** available / degraded / unavailable, derived from requirement resolution. */
  readiness: ToolReadinessStatus;
  /**
   * FIX-394 AC6 — a tool whose host dependency is absent is marked unavailable
   * rather than silently shown as ready. The caller (tool display / dossier
   * renderer) should degrade the row (icon, label) when this is false.
   */
  available: boolean;
  /** Human reason for unavailable — may be '' when available. */
  unavailableReason: string;
  inputContract: string;
  outputContract: string;
}

/**
 * Map every built-in tool declaration → a panel row. Order is deterministic
 * `(kind, id)`; availability comes from the requirement resolver.
 */
export function collectToolPanel(): ToolPanelRow[] {
  return builtinToolDeclarations().map(toRow);
}

function toRow(declaration: ToolDeclaration): ToolPanelRow {
  const readiness = deriveToolReadiness(declaration, resolveRequirement);
  const requirementDetails = readiness.requirements.map((resolution) => ({
    name: resolution.requirement.name,
    kind: resolution.requirement.kind,
    optional: resolution.requirement.optional === true,
    label: requirementLabel(resolution.requirement),
    status: resolution.status,
    detail: resolution.detail,
    ...(resolution.repair?.command !== undefined ? { repairCommand: resolution.repair.command } : {}),
    ...(resolution.authorize?.command !== undefined ? { authorizeCommand: resolution.authorize.command } : {}),
  }));
  return {
    id: String(declaration.id),
    kind: declaration.kind,
    title: declaration.title,
    description: declaration.description ?? "",
    emitsEvents: declaration.emitsEvents ?? false,
    guardrails: guardrailsOf(declaration.defaults),
    requirements: requirementDetails.map((requirement) => requirement.label),
    requirementDetails,
    readiness: readiness.status,
    available: readiness.status !== "unavailable",
    unavailableReason: readiness.status === "available" ? "" : (readiness.detail ?? ""),
    inputContract: schemaParameterSummary(declaration.inputSchema),
    outputContract: schemaTypeLabel(declaration.outputSchema),
  };
}

function guardrailsOf(defaults: ToolDefaults | undefined): ToolPanelGuardrails {
  // No defaults → empty guardrails (the page shows "default policy").
  if (defaults === undefined) return {};
  const sandbox = sandboxLabel(defaults.sandbox);
  return {
    ...(defaults.timeoutMs !== undefined ? { timeoutMs: defaults.timeoutMs } : {}),
    ...(defaults.retry !== undefined ? { retries: defaults.retry.attempts } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(defaults.maxInvocationsPerCycle !== undefined ? { maxPerCycle: defaults.maxInvocationsPerCycle } : {}),
  };
}

/**
 * Derive a deterministic, human-readable label from the sandbox object's most
 * distinguishing field. Returns undefined when the declaration leaves sandbox
 * unset (the page renders "—" / skips it).
 */
function sandboxLabel(sandbox: ToolSandbox | undefined): string | undefined {
  if (sandbox === undefined) return undefined;
  if (sandbox.network !== undefined) return `network:${sandbox.network}`;
  if (sandbox.headlessOnly === true) return "headless";
  if (sandbox.allowedPaths !== undefined && sandbox.allowedPaths.length > 0) return "workspace";
  if (sandbox.maxOutputBytes !== undefined) return "bounded-output";
  return "workspace";
}

/** "git", "playwright-chromium (optional)", "OPENAI_API_KEY (env)", … */
function requirementLabel(requirement: ToolRequirement): string {
  const suffix = requirement.optional === true ? " (optional)" : "";
  if (requirement.kind === "executable") return `${requirement.name}${suffix}`;
  if (requirement.kind === "env") return `${requirement.name} (env)${suffix}`;
  return `${requirement.name} (service)${suffix}`;
}
