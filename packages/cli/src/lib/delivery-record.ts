/**
 * US-EVID-033 — resolve THIS card's delivery record (PR + merge sha) for the
 * attest evidence collector.
 *
 * Reads the delivery ledger CACHE only: no fetch, no rebuild, no network. attest
 * runs inside cycle worktrees and on offline hosts, and an evidence collector
 * must never become a network-dependent step. A missing/stale cache therefore
 * degrades the `delivery_ci` lane to `unknown: no_delivery_record` — honest, and
 * never mistaken for a pass. The loop and the release gate keep the cache fresh
 * (`ensureDeliveriesFresh`).
 */
import { nodeDeliveryStore, queryStoryDelivery, readDeliveries, type DeliveryCiRecord } from "@roll/core";

export function resolveCardDeliveryRecord(projectPath: string, storyId: string): DeliveryCiRecord | undefined {
  let records;
  try {
    records = readDeliveries(nodeDeliveryStore, projectPath);
  } catch {
    return undefined;
  }
  if (records.length === 0) return undefined;
  const truth = queryStoryDelivery(storyId, records);
  if (truth.prNumber === undefined && truth.mergeCommit === undefined) return undefined;
  return {
    ...(truth.prNumber !== undefined ? { prNumber: truth.prNumber } : {}),
    ...(truth.mergeCommit !== undefined ? { mergeCommit: truth.mergeCommit } : {}),
  };
}
