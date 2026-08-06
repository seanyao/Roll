/**
 * @responsibility Collects browser-operation events from the project ledger into browser operations truth.
 */
/**
 * US-BROW-009b — lightweight facts collector that reads browser operation
 * events from the project's ledger and passes them to {@link browserOperationsTruth}.
 * Missing facts are honest (unknown), never inferred.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserOperationLedger, browserOperationsTruth, captureLinksFromBrowserEvents, type BrowserActiveLeaseFact } from "@roll/core";
import type { BrowserOperationsTruth } from "@roll/spec";
import { renderNowMs } from "./truth-read.js";

/** Default path for the browser operations event ledger. */
function browserLedgerPath(projectPath: string): string {
  return join(projectPath, ".roll", "browser-operations", "events.ndjson");
}

export interface CollectBrowserTruthOpts {
  projectPath: string;
  storyId?: string;
  cycleId?: string;
  nowMs?: number;
}

/**
 * Read browser operation facts from the project ledger and project a
 * {@link BrowserOperationsTruth}. Active leases are not collected, while
 * persisted CaptureBridge links are read from the same append-only ledger.
 */
export function collectBrowserTruth(opts: CollectBrowserTruthOpts): BrowserOperationsTruth {
  const eventsPath = browserLedgerPath(opts.projectPath);
  const events = existsSync(eventsPath) ? new BrowserOperationLedger().read(eventsPath) : [];

  return browserOperationsTruth({
    events,
    activeLease: undefined,
    captureLinks: captureLinksFromBrowserEvents(events),
    nowMs: opts.nowMs ?? renderNowMs(),
    storyId: opts.storyId,
    cycleId: opts.cycleId,
  });
}
