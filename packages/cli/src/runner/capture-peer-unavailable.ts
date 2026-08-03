import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RollEvent } from "@roll/spec";
import type { Ports } from "./ports.js";
import { eventTs } from "./runner-time.js";

interface PeerUnavailableRetry {
  status: string;
  peer?: string;
  sameTypeFallback?: boolean;
}

interface RecordPeerPoolUnavailableOptions {
  ports: Ports;
  runtimeDir: string;
  cycleId: string;
  retry: PeerUnavailableRetry;
}

/**
 * Records the bounded peer-pool timeout fallback as durable audit evidence.
 * Only timebox-proven unavailability reaches this helper; erroring, absent, or
 * empty peers remain hard-blocked by the caller, and the Review Score gate still
 * applies after this peer-evidence fallback.
 */
export function recordPeerPoolUnavailable({
  ports,
  runtimeDir,
  cycleId,
  retry,
}: RecordPeerPoolUnavailableOptions): void {
  const how = retry.sameTypeFallback === true ? "same-type separate-session review" : "peer review";
  const evidenceTs = eventTs(ports);
  const unavailableDir = join(runtimeDir, "peer-unavailable");
  mkdirSync(unavailableDir, { recursive: true });
  writeFileSync(
    join(unavailableDir, `cycle-${cycleId}.json`),
    JSON.stringify({ cycleId, status: retry.status, how, peer: retry.peer ?? null, attempts: 2, ts: evidenceTs }, null, 2),
    "utf8",
  );
  ports.events.appendEvent(ports.paths.eventsPath, {
    type: "peer:unavailable",
    cycleId,
    status: retry.status,
    ts: eventTs(ports),
  } as unknown as RollEvent);
  ports.events.appendAlert(
    ports.paths.alertsPath,
    `peer gate (hard): peer pool unavailable after retry — the ${how} produced no evidence (${retry.status}) — cycle ${cycleId} downgraded to recorded self-review fallback (peer_unavailable evidence written; Review Score gate still applies)`,
  );
}
