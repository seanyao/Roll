import { closeSync, openSync, readSync, writeSync } from "node:fs";
import {
  buildWorkspaceClarificationHandoff,
  discoverWorkspaceForIntent,
  resolveWorkspaceClarificationAnswer,
  validateResolvedTargetRequirement,
} from "@roll/core";
import type { WorkspaceDiscoveryLoadResultV1 } from "@roll/infra";
import {
  REQUIREMENT_HINT_V1,
  WORKSPACE_INTENT_V1,
  type WorkspaceClarificationAnswerV1,
  type WorkspaceClarificationHandoffV1,
  type WorkspaceIntentV1,
} from "@roll/spec";
import { isCanonicalWorkspaceSelectorToken } from "./workspace-selector.js";

export interface WorkspaceInteractionCapabilities {
  readonly stdinTTY: boolean;
  readonly stderrTTY: boolean;
  readonly agentQuestionCapable: boolean;
}

export interface WorkspaceInteractionHost {
  readonly cwd: string;
  readonly capabilities: WorkspaceInteractionCapabilities;
  readonly ask: (prompt: string) => string | null;
  readonly loadDiscovery: () => WorkspaceDiscoveryLoadResultV1;
}

export type WorkspaceInteractionModeDecision =
  | {
      readonly ok: true;
      readonly mode: "interactive" | "non_interactive";
      readonly args: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: "interaction_unavailable";
      readonly args: readonly string[];
    };

function removeInteractionFlags(args: readonly string[]): {
  readonly args: readonly string[];
  readonly noInput: boolean;
  readonly interactive: boolean;
} {
  const remaining: string[] = [];
  let noInput = false;
  let interactive = false;
  let optionsEnded = false;
  for (const arg of args) {
    if (optionsEnded) {
      remaining.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      remaining.push(arg);
      continue;
    }
    if (arg === "--no-input") {
      noInput = true;
      continue;
    }
    if (arg === "--interactive") {
      interactive = true;
      continue;
    }
    remaining.push(arg);
  }
  return { args: remaining, noInput, interactive };
}

/**
 * Resolve whether the host can ask a Workspace clarification question.
 * Output format flags (including --json) are deliberately left untouched.
 */
export function parseWorkspaceInteractionArgs(
  args: readonly string[],
  capabilities: WorkspaceInteractionCapabilities,
): WorkspaceInteractionModeDecision {
  const parsed = removeInteractionFlags(args);
  if (parsed.noInput) {
    return { ok: true, mode: "non_interactive", args: parsed.args };
  }
  const capable = capabilities.agentQuestionCapable ||
    (capabilities.stdinTTY && capabilities.stderrTTY);
  if (parsed.interactive && !capable) {
    return { ok: false, code: "interaction_unavailable", args: parsed.args };
  }
  return {
    ok: true,
    mode: capable ? "interactive" : "non_interactive",
    args: parsed.args,
  };
}

function requirementSummary(handoff: WorkspaceClarificationHandoffV1): string {
  const sources = handoff.requirementSummary.sources.map((source) => `${source.provider}:${source.ref}`);
  const facts = [...sources, ...handoff.requirementSummary.storyIds];
  if (facts.length > 0) return facts.join(", ");
  return handoff.requirementSummary.hasSemanticOnlyEvidence
    ? "semantic-only requirement evidence"
    : "the current requirement";
}

function evidenceSummary(candidate: WorkspaceClarificationHandoffV1["candidates"][number]): string {
  if (candidate.evidence.length === 0) return "no hard requirement evidence";
  return candidate.evidence
    .map((evidence) => `${evidence.kind} ${evidence.value} (${evidence.provenance})`)
    .join(", ");
}

function diagnosticSummary(candidate: WorkspaceClarificationHandoffV1["candidates"][number]): string {
  if (candidate.diagnostics.length === 0) return "none";
  return candidate.diagnostics
    .map((diagnostic) => `${diagnostic.code} at ${diagnostic.authorityPath}`)
    .join(", ");
}

/** Render the direct CLI question from the same closed handoff the agent host uses. */
export function renderDirectWorkspaceClarificationPrompt(
  handoff: WorkspaceClarificationHandoffV1,
): string {
  const selectionAllowed = handoff.allowedActions.includes("select_existing");
  const lines = [
    `Workspace requirement ${requirementSummary(handoff)} needs clarification because ${handoff.reason}.`,
    selectionAllowed
      ? "Choose one allowed action; candidate order is never an automatic selection."
      : "Candidate facts are shown for diagnosis only; this handoff does not allow selecting them.",
    "",
  ];
  handoff.candidates.forEach((candidate, index) => {
    lines.push(
      selectionAllowed
        ? `  ${index + 1}) ${candidate.displayName} (${candidate.lifecycle}) — ${evidenceSummary(candidate)}; diagnostics: ${diagnosticSummary(candidate)}`
        : `  - ${candidate.displayName} (${candidate.lifecycle}) — ${evidenceSummary(candidate)}; diagnostics: ${diagnosticSummary(candidate)} [not selectable]`,
    );
  });
  if (handoff.allowedActions.includes("create_new")) {
    lines.push(`  create) create a new Workspace (preview only: ${handoff.canonicalCreateCommand} ... --check)`);
  }
  if (handoff.allowedActions.includes("repair_discovery")) {
    lines.push("  repair) show canonical Workspace repair commands");
  }
  lines.push("  cancel) stop without selecting or mutating a Workspace", "", "Action: ");
  return lines.join("\n");
}

function parsedAnswer(
  handoff: WorkspaceClarificationHandoffV1,
  value: string,
): WorkspaceClarificationAnswerV1 | "cancelled" | undefined {
  const answer = value.trim();
  if (/^(?:q|quit|cancel)$/iu.test(answer)) return "cancelled";
  if (/^(?:c|create)$/iu.test(answer)) return { action: "create_new" };
  if (/^(?:r|repair)$/iu.test(answer)) return { action: "repair_discovery" };
  if (!handoff.allowedActions.includes("select_existing")) return undefined;
  const numeric = Number(answer);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= handoff.candidates.length) {
    const candidate = handoff.candidates[numeric - 1];
    return candidate === undefined
      ? undefined
      : { action: "select_existing", workspaceId: candidate.workspaceId };
  }
  const candidate = handoff.candidates.find((entry) => entry.workspaceId === answer);
  return candidate === undefined
    ? undefined
    : { action: "select_existing", workspaceId: candidate.workspaceId };
}

export type DirectWorkspaceClarificationAnswer<T> =
  | {
      readonly kind: "selected";
      readonly workspaceId: string;
      readonly canonicalSelector: string;
      readonly result: T;
    }
  | {
      readonly kind: "create";
      readonly nextAction: "roll workspace create <ID> --config <path> --check";
      readonly applyAuthorized: false;
    }
  | { readonly kind: "repair"; readonly commands: readonly string[] }
  | { readonly kind: "cancelled"; readonly code: "workspace_clarification_cancelled" }
  | { readonly kind: "invalid"; readonly code: "invalid_workspace_clarification"; readonly reload: true };

/** Validate one direct answer against fresh discovery facts before continuing. */
export function answerDirectWorkspaceClarification<T>(input: {
  readonly handoff: WorkspaceClarificationHandoffV1;
  readonly answer: string | null;
  readonly currentDiscovery: {
    readonly registryRevision: number;
    readonly discoveryFactsSha256: string;
  };
  readonly rerunResolver: (workspaceId: string) => T;
}): DirectWorkspaceClarificationAnswer<T> {
  if (input.answer === null) {
    return { kind: "cancelled", code: "workspace_clarification_cancelled" };
  }
  const answer = parsedAnswer(input.handoff, input.answer);
  if (answer === "cancelled") {
    return { kind: "cancelled", code: "workspace_clarification_cancelled" };
  }
  const resolution = resolveWorkspaceClarificationAnswer({
    handoff: input.handoff,
    answer,
    currentRegistryRevision: input.currentDiscovery.registryRevision,
    currentDiscoveryFactsSha256: input.currentDiscovery.discoveryFactsSha256,
  });
  if (!resolution.ok) {
    return { kind: "invalid", code: resolution.code, reload: true };
  }
  switch (resolution.action) {
    case "retry_resolution":
      return {
        kind: "selected",
        workspaceId: resolution.explicitSelector.workspaceId,
        canonicalSelector: resolution.canonicalSelector,
        result: input.rerunResolver(resolution.explicitSelector.workspaceId),
      };
    case "start_create_preview":
      return {
        kind: "create",
        nextAction: "roll workspace create <ID> --config <path> --check",
        applyAuthorized: false,
      };
    case "show_repair_actions":
      return { kind: "repair", commands: resolution.commands };
  }
}

function directIntent(input: {
  readonly operation: "read" | "mutation";
  readonly mode: "interactive" | "non_interactive";
  readonly cwd: string;
}): WorkspaceIntentV1 {
  return {
    schema: WORKSPACE_INTENT_V1,
    operation: input.operation,
    interaction: input.mode,
    scope: input.operation === "read" ? "workspace_required_read" : "workspace_required_mutation",
    cwd: input.cwd,
    requirement: {
      schema: REQUIREMENT_HINT_V1,
      sources: [],
      storyIds: [],
      repositoryRemotes: [],
      paths: [],
    },
  };
}

export function buildDirectWorkspaceClarification(input: {
  readonly operation: "read" | "mutation";
  readonly mode: "interactive" | "non_interactive";
  readonly cwd: string;
  readonly discovery: WorkspaceDiscoveryLoadResultV1;
}): WorkspaceClarificationHandoffV1 | undefined {
  const intent = directIntent(input);
  const decision = discoverWorkspaceForIntent({
    intent,
    workspaces: input.discovery.workspaces,
    diagnostics: input.discovery.diagnostics,
  });
  if (decision.ok || decision.code === "invalid_requirement_hint") return undefined;
  try {
    return buildWorkspaceClarificationHandoff({
      intent,
      reason: decision.code,
      candidates: decision.candidates,
      diagnostics: decision.diagnostics,
      facts: input.discovery.workspaces,
      registryRevision: input.discovery.registryRevision,
      discoveryFactsSha256: input.discovery.discoveryFactsSha256,
    });
  } catch {
    return undefined;
  }
}

interface WorkspaceTargetDecisionShape {
  readonly ok: boolean;
  readonly code?: string;
}

function replaceCanonicalWorkspaceSelector(
  args: readonly string[],
  workspaceId: string,
): readonly string[] {
  const replaced: string[] = [];
  let inserted = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      if (!inserted) replaced.push("--workspace", workspaceId);
      replaced.push(...args.slice(index));
      return replaced;
    }
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      if (!inserted) {
        replaced.push("--workspace", workspaceId);
        inserted = true;
      }
      const oldValue = args[index + 1];
      if (oldValue !== undefined && oldValue !== "--" && !oldValue.startsWith("-")) index += 1;
      continue;
    }
    if (arg !== undefined) replaced.push(arg);
  }
  if (!inserted) replaced.push("--workspace", workspaceId);
  return replaced;
}

export type WorkspaceTargetInteractionOutcome<T extends WorkspaceTargetDecisionShape> =
  | { readonly kind: "resolved"; readonly args: readonly string[]; readonly result: T }
  | {
      readonly kind: "target_failure";
      readonly args: readonly string[];
      readonly result: T;
      readonly clarification?: WorkspaceClarificationHandoffV1;
    }
  | {
      readonly kind: "interaction_failure";
      readonly args: readonly string[];
      readonly code:
        | "interaction_unavailable"
        | "workspace_clarification_cancelled"
        | "invalid_workspace_clarification"
        | "create_required"
        | "workspace_discovery_incomplete";
      readonly clarification?: WorkspaceClarificationHandoffV1;
      readonly nextAction?: string;
      readonly commands?: readonly string[];
    };

/** Resolve once, ask if permitted, then rerun the complete resolver with an explicit selector. */
export function resolveWorkspaceTargetInteraction<T extends WorkspaceTargetDecisionShape>(input: {
  readonly args: readonly string[];
  readonly operation: "read" | "mutation";
  readonly resolveTarget: (args: readonly string[], operation: "read" | "mutation") => T;
  readonly host: WorkspaceInteractionHost;
  readonly parsedInteraction?: Extract<WorkspaceInteractionModeDecision, { readonly ok: true }>;
}): WorkspaceTargetInteractionOutcome<T> {
  const interaction = input.parsedInteraction ?? parseWorkspaceInteractionArgs(input.args, input.host.capabilities);
  if (!interaction.ok) {
    return { kind: "interaction_failure", args: interaction.args, code: interaction.code };
  }
  const initial = input.resolveTarget(interaction.args, input.operation);
  if (initial.ok) return { kind: "resolved", args: interaction.args, result: initial };
  if (initial.code !== "target_missing") {
    return { kind: "target_failure", args: interaction.args, result: initial };
  }
  const discovery = input.host.loadDiscovery();
  const handoff = buildDirectWorkspaceClarification({
    operation: input.operation,
    mode: interaction.mode,
    cwd: input.host.cwd,
    discovery,
  });
  if (handoff === undefined) {
    return { kind: "target_failure", args: interaction.args, result: initial };
  }
  if (interaction.mode === "non_interactive") {
    return { kind: "target_failure", args: interaction.args, result: initial, clarification: handoff };
  }
  const answer = input.host.ask(renderDirectWorkspaceClarificationPrompt(handoff));
  if (answer === null || /^(?:q|quit|cancel)$/iu.test(answer.trim())) {
    return {
      kind: "interaction_failure",
      args: interaction.args,
      code: "workspace_clarification_cancelled",
      clarification: handoff,
    };
  }
  const currentDiscovery = input.host.loadDiscovery();
  const resolved = answerDirectWorkspaceClarification({
    handoff,
    answer,
    currentDiscovery,
    rerunResolver: (workspaceId) => input.resolveTarget(
      replaceCanonicalWorkspaceSelector(interaction.args, workspaceId),
      input.operation,
    ),
  });
  switch (resolved.kind) {
    case "selected": {
      const selectedFacts = currentDiscovery.workspaces.find(
        (facts) => facts.candidate.workspaceId === resolved.workspaceId,
      );
      const requirementValidation = selectedFacts === undefined
        ? undefined
        : validateResolvedTargetRequirement({
            target: selectedFacts,
            allWorkspaces: currentDiscovery.workspaces,
            requirement: directIntent({
              operation: input.operation,
              mode: interaction.mode,
              cwd: input.host.cwd,
            }).requirement,
            operation: input.operation,
          });
      if (requirementValidation === undefined || !requirementValidation.ok) {
        return {
          kind: "interaction_failure",
          args: interaction.args,
          code: "invalid_workspace_clarification",
          clarification: buildDirectWorkspaceClarification({
            operation: input.operation,
            mode: interaction.mode,
            cwd: input.host.cwd,
            discovery: currentDiscovery,
          }) ?? handoff,
        };
      }
      const selectedArgs = replaceCanonicalWorkspaceSelector(interaction.args, resolved.workspaceId);
      return resolved.result.ok
        ? { kind: "resolved", args: selectedArgs, result: resolved.result }
        : { kind: "target_failure", args: selectedArgs, result: resolved.result };
    }
    case "create":
      return {
        kind: "interaction_failure",
        args: interaction.args,
        code: "create_required",
        clarification: handoff,
        nextAction: resolved.nextAction,
      };
    case "repair":
      return {
        kind: "interaction_failure",
        args: interaction.args,
        code: "workspace_discovery_incomplete",
        clarification: handoff,
        commands: resolved.commands,
      };
    case "cancelled":
      return { kind: "interaction_failure", args: interaction.args, code: resolved.code, clarification: handoff };
    case "invalid":
      return {
        kind: "interaction_failure",
        args: interaction.args,
        code: resolved.code,
        clarification: buildDirectWorkspaceClarification({
          operation: input.operation,
          mode: interaction.mode,
          cwd: input.host.cwd,
          discovery: currentDiscovery,
        }) ?? handoff,
      };
  }
}

/** Ask through the controlling terminal so prompt bytes never enter stdout/stderr data capture. */
export function askDirectWorkspaceClarification(prompt: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", "r+");
    writeSync(fd, prompt);
    const byte = Buffer.alloc(1);
    let line = "";
    for (let index = 0; index < 1_000_000; index += 1) {
      const bytesRead = readSync(fd, byte, 0, 1, null);
      if (bytesRead === 0) return line === "" ? null : line;
      const character = byte.toString("utf8");
      if (character === "\n") return line;
      if (character !== "\r") line += character;
    }
    return line;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Cancellation remains fail-closed if the descriptor was already closed.
      }
    }
  }
}
