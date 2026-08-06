/**
 * @responsibility Collects declared browser-operation facts and projects the optional dossier timeline.
 */
/**
 * US-BROW-013 — collect declared browser-operation facts and project the
 * optional dossier timeline via {@link browserOperationsTimeline}.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserOperationLedger, browserOperationsTimeline, captureLinksFromBrowserEvents } from "@roll/core";
import type { BrowserOperationsTimeline, CaptureBridgeLink } from "@roll/spec";
import { renderNowMs } from "./truth-read.js";

function browserLedgerPath(projectPath: string): string {
  return join(projectPath, ".roll", "browser-operations", "events.ndjson");
}

export interface CollectBrowserTimelineOpts {
  projectPath: string;
  storyId?: string;
  cycleId?: string;
  nowMs?: number;
  /** Declared capture-bridge links when the collector has them. */
  captureLinks?: readonly CaptureBridgeLink[];
}

/**
 * Read ledger events and project a {@link BrowserOperationsTimeline}.
 * Missing facts become honest absences; an empty ledger yields hasFacts=false
 * so the dossier keeps the pre-timeline report shape.
 */
export function collectBrowserTimeline(opts: CollectBrowserTimelineOpts): BrowserOperationsTimeline {
  const eventsPath = browserLedgerPath(opts.projectPath);
  const events = existsSync(eventsPath) ? new BrowserOperationLedger().read(eventsPath) : [];

  return browserOperationsTimeline({
    events,
    captureLinks: opts.captureLinks ?? captureLinksFromBrowserEvents(events),
    nowMs: opts.nowMs ?? renderNowMs(),
    storyId: opts.storyId,
    cycleId: opts.cycleId,
  });
}
