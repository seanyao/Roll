/**
 * @responsibility Resolves a card's delivery record (PR and merge sha) for the attest evidence collector.
 */
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
  // codex review r1: only a MERGED delivery with a merge commit may be bound. A
  // card that is merely in flight has no delivery-time CI truth yet, and binding
  // its open PR's checks would let a green in-flight run read as acceptance.
  if (!truth.delivered) return undefined;
  if (truth.prNumber === undefined || truth.mergeCommit === undefined) return undefined;
  return { prNumber: truth.prNumber, mergeCommit: truth.mergeCommit };
}
