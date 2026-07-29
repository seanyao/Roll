import {
  CONTEXT_READ_REQUEST_V1,
  type ContextDiagnosticV1,
  type ContextReadRequestV1,
  type ContextReadResultV1,
  type ContextStage,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import {
  LLM_WIKI_MAX_FILE_BYTES,
  LLM_WIKI_MAX_PAGES,
  LLM_WIKI_MAX_PROVIDER_BYTES,
  compareContextRevisions,
  contextSnapshotReference,
  decideContextRevision,
  verifyContextSnapshot,
  type ContextRevisionDecisionV1,
  type ContextSnapshotReferenceV1,
} from "@roll/core";
import {
  CONTEXT_AGENT_ENVELOPE_V1,
  CONTEXT_AUTHORITY_DISCLAIMER,
  contextAgentPage,
  createContextStageHandoff,
  encodeContextAgentEnvelope,
  invalidContextHandoff,
  type ContextAgentEnvelopeV1,
  type ContextStageDecisionRecordV1,
  type ContextStageHandoffV1,
  type ContextStageReadResultV1,
} from "./context-handoff.js";

export type ContextStageReadModeV1 = "handoff_snapshot" | "fresh";

export interface ContextStageReadInputV1 {
  readonly workspace: WorkspaceExecutionContextV1;
  readonly storyId?: string;
  readonly stage: ContextStage;
  readonly environmentIds?: readonly string[];
  readonly refs: readonly string[];
  readonly readMode?: ContextStageReadModeV1;
  readonly handoff?: ContextStageHandoffV1;
  readonly revisionDecision?: ContextRevisionDecisionV1;
  readonly includeNonActive?: boolean;
  readonly allowRestrictedReferences?: boolean;
}

export type ContextHostObservationV1 =
  | {
      readonly type: "context:stage_handoff";
      readonly workspaceId: string;
      readonly storyId?: string;
      readonly stage: ContextStage;
      readonly source: "fresh" | "handoff_snapshot";
      readonly snapshotId: string;
      readonly snapshotDigest: string;
      readonly providerRevisions: readonly { readonly providerId: string; readonly revision: string }[];
    }
  | {
      readonly type: "context:revision_decision";
      readonly workspaceId: string;
      readonly storyId?: string;
      readonly stage: ContextStage;
      readonly decision: ContextStageDecisionRecordV1;
    };

export interface CreateContextHostAdapterOptions {
  readonly freshRead: (request: ContextReadRequestV1) => Promise<ContextReadResultV1>;
  readonly writeSnapshot: (snapshot: ContextReadResultV1) => void;
  readonly readSnapshot: (
    workspace: WorkspaceExecutionContextV1,
    reference: ContextSnapshotReferenceV1,
  ) => ContextReadResultV1;
  readonly authorizeRestrictedOperation?: (input: {
    readonly workspaceId: string;
    readonly storyId?: string;
    readonly stage: ContextStage;
    readonly refs: readonly string[];
  }) => boolean;
  readonly observe?: (observation: ContextHostObservationV1) => void;
}

export interface ContextHostAdapter {
  readForStage(input: ContextStageReadInputV1): Promise<ContextStageReadResultV1>;
}

const CONTEXT_BOOTSTRAP_STAGES = new Set<ContextStage>(["clarify", "design"]);

function sameReference(left: ContextSnapshotReferenceV1, right: ContextSnapshotReferenceV1): boolean {
  return left.snapshotId === right.snapshotId &&
    left.snapshotDigest === right.snapshotDigest &&
    left.artifactPath === right.artifactPath;
}

function readHandoffSnapshot(
  options: CreateContextHostAdapterOptions,
  input: ContextStageReadInputV1,
  handoff: ContextStageHandoffV1,
): ContextReadResultV1 | undefined {
  if (handoff.workspaceId !== input.workspace.workspace.workspaceId || handoff.storyId !== input.storyId) return undefined;
  let snapshot: ContextReadResultV1;
  try {
    snapshot = options.readSnapshot(input.workspace, handoff.snapshot);
  } catch {
    return undefined;
  }
  const verification = verifyContextSnapshot(snapshot);
  if (!verification.valid || !sameReference(verification.reference, handoff.snapshot)) return undefined;
  if (snapshot.requestScope.workspaceId !== handoff.workspaceId || snapshot.requestScope.storyId !== handoff.storyId) return undefined;
  return snapshot;
}

function restrictedOperationAllowed(
  options: CreateContextHostAdapterOptions,
  input: ContextStageReadInputV1,
): boolean {
  return input.allowRestrictedReferences === true && options.authorizeRestrictedOperation?.({
    workspaceId: input.workspace.workspace.workspaceId,
    ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
    stage: input.stage,
    refs: input.refs,
  }) === true;
}

function buildEnvelope(
  options: CreateContextHostAdapterOptions,
  input: ContextStageReadInputV1,
  snapshot: ContextReadResultV1,
  authorizedRestrictedOperation?: boolean,
): { readonly envelope?: ContextAgentEnvelopeV1; readonly diagnostic?: ContextDiagnosticV1 } {
  const explicitRefs = new Set(input.refs);
  const capturedRefs = new Set(snapshot.providers.flatMap((provider) => provider.files.map((file) => file.ref)));
  const missingRef = input.refs.find((ref) => !capturedRefs.has(ref));
  if (missingRef !== undefined) {
    return {
      diagnostic: {
        code: "context_file_missing",
        severity: "blocking",
        ref: missingRef,
        message: "Explicit Context ref was not captured in the handed-off Snapshot",
      },
    };
  }
  const operationAllowed = authorizedRestrictedOperation ?? restrictedOperationAllowed(options, input);
  const pages = [];
  for (const provider of snapshot.providers) {
    if (provider.files.length > LLM_WIKI_MAX_PAGES) {
      return {
        diagnostic: {
          code: "context_budget_exceeded",
          severity: "blocking",
          providerId: provider.providerId,
          message: "Context Agent envelope exceeds the page budget",
        },
      };
    }
    const oversized = provider.files.find((file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LLM_WIKI_MAX_FILE_BYTES);
    if (oversized !== undefined) {
      return {
        diagnostic: {
          code: "context_file_too_large",
          severity: "blocking",
          providerId: provider.providerId,
          ref: oversized.ref,
          message: "Context Agent envelope file exceeds the byte budget",
        },
      };
    }
    const providerBytes = provider.files.reduce((sum, file) => sum + file.bytes, 0);
    if (!Number.isSafeInteger(providerBytes) || providerBytes > LLM_WIKI_MAX_PROVIDER_BYTES) {
      return {
        diagnostic: {
          code: "context_budget_exceeded",
          severity: "blocking",
          providerId: provider.providerId,
          message: "Context Agent envelope exceeds the Provider byte budget",
        },
      };
    }
    for (const file of provider.files) {
      if (file.page?.sensitivity === "restricted_reference") {
        const explicit = explicitRefs.has(file.ref);
        if (explicit && !operationAllowed) {
          return {
            diagnostic: {
              code: "restricted_context_denied",
              severity: "blocking",
              providerId: provider.providerId,
              ref: file.ref,
              message: "Restricted Context requires an explicit ref, request intent and operation authorization",
            },
          };
        }
        if (!explicit || !operationAllowed) continue;
      }
      pages.push(contextAgentPage(provider.providerId, provider.revision, file));
    }
  }
  return {
    envelope: {
      schema: CONTEXT_AGENT_ENVELOPE_V1,
      authority: {
        classification: "untrusted_context_data",
        disclaimer: CONTEXT_AUTHORITY_DISCLAIMER,
        wikiCommands: "never_execute",
      },
      workspaceId: input.workspace.workspace.workspaceId,
      ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
      stage: input.stage,
      snapshot: contextSnapshotReference(snapshot),
      pages,
    },
  };
}

function observeReady(
  options: CreateContextHostAdapterOptions,
  input: ContextStageReadInputV1,
  source: "fresh" | "handoff_snapshot",
  snapshot: ContextReadResultV1,
): void {
  options.observe?.({
    type: "context:stage_handoff",
    workspaceId: input.workspace.workspace.workspaceId,
    ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
    stage: input.stage,
    source,
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.snapshotDigest,
    providerRevisions: snapshot.providers.map((provider) => ({
      providerId: provider.providerId,
      revision: provider.revision,
    })),
  });
}

function observeDecision(
  options: CreateContextHostAdapterOptions,
  input: ContextStageReadInputV1,
  decision: ContextStageDecisionRecordV1,
): void {
  options.observe?.({
    type: "context:revision_decision",
    workspaceId: input.workspace.workspace.workspaceId,
    ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
    stage: input.stage,
    decision,
  });
}

function ready(
  options: CreateContextHostAdapterOptions,
  input: ContextStageReadInputV1,
  source: "fresh" | "handoff_snapshot",
  snapshot: ContextReadResultV1,
  decision?: ContextStageDecisionRecordV1,
  authorizedRestrictedOperation?: boolean,
): ContextStageReadResultV1 {
  const built = buildEnvelope(options, input, snapshot, authorizedRestrictedOperation);
  if (built.diagnostic !== undefined || built.envelope === undefined) {
    return { status: "blocked", diagnostic: built.diagnostic ?? invalidContextHandoff() };
  }
  const handoff = createContextStageHandoff(snapshot);
  observeReady(options, input, source, snapshot);
  return {
    status: "ready",
    source,
    handoff,
    envelope: built.envelope,
    encodedEnvelope: encodeContextAgentEnvelope(built.envelope),
    ...(decision === undefined ? {} : { decision }),
  };
}

function unavailable(snapshot: ContextReadResultV1): ContextDiagnosticV1 {
  return snapshot.gaps.find((gap) => gap.severity === "blocking") ?? snapshot.gaps[0] ?? {
    code: snapshot.outcome === "disabled" ? "context_disabled" : "invalid_context_snapshot",
    severity: "blocking",
    message: snapshot.outcome === "disabled" ? "Context is disabled" : "Context Snapshot is not consumable",
  };
}

function snapshotBlockingDiagnostic(snapshot: ContextReadResultV1): ContextDiagnosticV1 | undefined {
  if (snapshot.outcome === "disabled" || snapshot.outcome === "blocked") return unavailable(snapshot);
  return snapshot.gaps.find((gap) => gap.severity === "blocking");
}

export function createContextHostAdapter(options: CreateContextHostAdapterOptions): ContextHostAdapter {
  return {
    async readForStage(input: ContextStageReadInputV1): Promise<ContextStageReadResultV1> {
      if ((input.readMode ?? "handoff_snapshot") === "handoff_snapshot") {
        if (input.handoff === undefined) return { status: "blocked", diagnostic: invalidContextHandoff() };
        const snapshot = readHandoffSnapshot(options, input, input.handoff);
        if (snapshot === undefined) return { status: "blocked", diagnostic: invalidContextHandoff() };
        const blocking = snapshotBlockingDiagnostic(snapshot);
        return blocking === undefined
          ? ready(options, input, "handoff_snapshot", snapshot)
          : { status: "blocked", diagnostic: blocking };
      }

      if (input.handoff === undefined && !CONTEXT_BOOTSTRAP_STAGES.has(input.stage)) {
        return { status: "blocked", diagnostic: invalidContextHandoff() };
      }

      const operationAllowed = restrictedOperationAllowed(options, input);
      const fresh = await options.freshRead({
        schema: CONTEXT_READ_REQUEST_V1,
        workspace: input.workspace,
        ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
        stage: input.stage,
        ...(input.environmentIds === undefined ? {} : { environmentIds: input.environmentIds }),
        refs: input.refs,
        ...(input.includeNonActive === undefined ? {} : { includeNonActive: input.includeNonActive }),
        ...(operationAllowed ? { includeRestrictedReferences: true } : {}),
      });
      if (fresh.outcome === "disabled") return { status: "blocked", diagnostic: unavailable(fresh) };
      options.writeSnapshot(fresh);
      const freshHandoff = createContextStageHandoff(fresh);
      const freshBlocking = snapshotBlockingDiagnostic(fresh);
      if (freshBlocking !== undefined) {
        return { status: "blocked", diagnostic: freshBlocking, freshHandoff };
      }
      if (input.handoff === undefined) return ready(options, input, "fresh", fresh, undefined, operationAllowed);

      const previous = readHandoffSnapshot(options, input, input.handoff);
      if (previous === undefined) return { status: "blocked", diagnostic: invalidContextHandoff(), freshHandoff };
      const comparison = compareContextRevisions(previous, fresh);
      if (comparison.status === "unchanged") return ready(options, input, "fresh", fresh, undefined, operationAllowed);

      const decision = decideContextRevision(comparison, input.revisionDecision);
      if (!decision.accepted) {
        return {
          status: "blocked",
          diagnostic: decision.diagnostic,
          previousHandoff: input.handoff,
          freshHandoff,
          comparison,
        };
      }
      const record: ContextStageDecisionRecordV1 = {
        comparison,
        ...decision.record,
        useSnapshot: decision.useSnapshot,
      };
      observeDecision(options, input, record);
      if (decision.useSnapshot === "none") {
        return {
          status: "needs_reconciliation",
          previousHandoff: input.handoff,
          freshHandoff,
          decision: record,
        };
      }
      return decision.useSnapshot === "new"
        ? ready(options, input, "fresh", fresh, record, operationAllowed)
        : ready(options, input, "handoff_snapshot", previous, record, operationAllowed);
    },
  };
}
