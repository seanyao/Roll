import type { ContextDiagnosticV1, ContextReadResultV1 } from "@roll/spec";
import { contextSnapshotReference, type ContextSnapshotReferenceV1 } from "./snapshot.js";

export type ContextRevisionDecisionV1 =
  | "continue_with_handoff_snapshot"
  | "adopt_new_snapshot"
  | "needs_reconciliation";

export interface ContextProviderRevisionChangeV1 {
  readonly providerId: string;
  readonly fromRevision?: string;
  readonly toRevision?: string;
  readonly changedRefs: readonly string[];
}

export interface ContextRevisionComparisonV1 {
  readonly status: "unchanged" | "changed";
  readonly handoffSnapshot: ContextSnapshotReferenceV1;
  readonly freshSnapshot: ContextSnapshotReferenceV1;
  readonly providers: readonly ContextProviderRevisionChangeV1[];
}

export interface ContextRevisionDecisionRecordV1 {
  readonly decision: ContextRevisionDecisionV1;
  readonly handoffSnapshot: ContextSnapshotReferenceV1;
  readonly freshSnapshot: ContextSnapshotReferenceV1;
}

export type ContextRevisionDecisionResultV1 =
  | {
      readonly accepted: true;
      readonly record: ContextRevisionDecisionRecordV1;
      readonly useSnapshot: "handoff" | "new" | "none";
    }
  | { readonly accepted: false; readonly diagnostic: ContextDiagnosticV1 };

function fileDigests(snapshot: ContextReadResultV1, providerId: string): ReadonlyMap<string, string> {
  const provider = snapshot.providers.find((entry) => entry.providerId === providerId);
  return new Map(provider?.files.map((file) => [file.ref, file.sha256]) ?? []);
}

function changedRefs(from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): readonly string[] {
  const refs = new Set([...from.keys(), ...to.keys()]);
  return [...refs].filter((ref) => from.get(ref) !== to.get(ref)).sort();
}

export function compareContextRevisions(
  handoff: ContextReadResultV1,
  fresh: ContextReadResultV1,
): ContextRevisionComparisonV1 {
  const fromProviders = new Map(handoff.providers.map((provider) => [provider.providerId, provider]));
  const toProviders = new Map(fresh.providers.map((provider) => [provider.providerId, provider]));
  const providerIds = [...new Set([...fromProviders.keys(), ...toProviders.keys()])].sort();
  const providers = providerIds.map((providerId): ContextProviderRevisionChangeV1 => {
    const from = fromProviders.get(providerId);
    const to = toProviders.get(providerId);
    return {
      providerId,
      ...(from === undefined ? {} : { fromRevision: from.revision }),
      ...(to === undefined ? {} : { toRevision: to.revision }),
      changedRefs: changedRefs(fileDigests(handoff, providerId), fileDigests(fresh, providerId)),
    };
  });
  const status = providers.some((provider) =>
    provider.fromRevision !== provider.toRevision || provider.changedRefs.length > 0
  ) ? "changed" : "unchanged";
  return {
    status,
    handoffSnapshot: contextSnapshotReference(handoff),
    freshSnapshot: contextSnapshotReference(fresh),
    providers,
  };
}

export function decideContextRevision(
  comparison: ContextRevisionComparisonV1,
  decision?: ContextRevisionDecisionV1,
): ContextRevisionDecisionResultV1 {
  if (comparison.status === "changed" && decision === undefined) {
    return {
      accepted: false,
      diagnostic: {
        code: "context_revision_changed",
        severity: "blocking",
        message: "Context revision changed and requires an explicit consuming-stage decision",
      },
    };
  }
  const resolved = decision ?? "continue_with_handoff_snapshot";
  return {
    accepted: true,
    record: {
      decision: resolved,
      handoffSnapshot: comparison.handoffSnapshot,
      freshSnapshot: comparison.freshSnapshot,
    },
    useSnapshot: resolved === "adopt_new_snapshot" ? "new" :
      resolved === "continue_with_handoff_snapshot" ? "handoff" : "none",
  };
}
