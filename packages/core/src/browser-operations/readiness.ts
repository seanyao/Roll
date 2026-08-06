/**
 * @responsibility Derives honest browser environment readiness verdicts per lane.
 * US-BROW-003 — BrowserEnvironmentReadiness aggregate.
 *
 * Pure verdict logic over dependency observations. It NEVER performs IO: probes
 * live in packages/infra; this module only turns observations into an honest
 * `ready | degraded | blocked` verdict per lane. The whole point is that an
 * unavailable browser can never be interpreted as a passing check — a missing
 * dependency degrades or blocks, and existing Playwright / Roll Capture paths
 * stay usable.
 *
 * See .roll/features/browser-automation/managed-devtools-plan.md §5.0.
 */
import type {
  BrowserDependencyObservation,
  BrowserDependencyState,
  BrowserEnvironmentObservations,
  BrowserEnvironmentReadiness,
  BrowserLaneReadiness,
  BrowserProbeResult,
} from "@roll/spec";

/** The exact, owner-approved managed DevTools MCP package. The
 *  BrowserTransportRegistry (US-BROW-002, transport.ts) owns the identity and
 *  runtime launch plan; readiness reports against the same single source. */
import { MANAGED_DEVTOOLS_PACKAGE, MANAGED_DEVTOOLS_PACKAGE_VERSION } from "./transport.js";

export { MANAGED_DEVTOOLS_PACKAGE, MANAGED_DEVTOOLS_PACKAGE_VERSION };
/** Loopback-only remote debugging endpoint. Interactive lane connects here; it
 *  is never opened automatically. */
export const MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST = "127.0.0.1";
export const MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT = 9222;

function ready(lane: BrowserLaneReadiness["lane"], reason: string): BrowserLaneReadiness {
  return { lane, verdict: "ready", reason, actions: [] };
}
function configured(lane: BrowserLaneReadiness["lane"], reason: string): BrowserLaneReadiness {
  return { lane, verdict: "configured", reason, actions: [] };
}
function degraded(lane: BrowserLaneReadiness["lane"], reason: string, actions: string[]): BrowserLaneReadiness {
  return { lane, verdict: "degraded", reason, actions };
}
function blocked(lane: BrowserLaneReadiness["lane"], reason: string, actions: string[]): BrowserLaneReadiness {
  return { lane, verdict: "blocked", reason, actions };
}

function missing(states: Array<[string, BrowserDependencyState]>): string[] {
  return states.filter(([, s]) => !s.present).map(([label]) => label);
}

function deriveManaged(obs: BrowserEnvironmentObservations): BrowserLaneReadiness {
  // A binding mismatch is a hard configuration error: never guess a transport at
  // run time — report blocked so the card's browser AC stays unproven.
  if (!obs.transportBinding.present) {
    return blocked(
      "managed",
      `transport binding missing — ${obs.transportBinding.detail}`,
      ["align .roll/policy.yaml browser_operations.devtools_server with the registered logical key"],
    );
  }
  const gaps = missing([
    ["Node LTS", obs.node],
    ["npx", obs.npx],
    ["Google Chrome", obs.chrome],
    [`${MANAGED_DEVTOOLS_PACKAGE}`, obs.devtoolsPackage],
  ]);
  if (gaps.length > 0) {
    return degraded(
      "managed",
      `unavailable — ${gaps.join(", ")} not ready; existing Playwright and Roll Capture paths remain usable`,
      ["roll browser setup --dry-run", "install the missing dependency, then re-run roll browser doctor"],
    );
  }
  // US-BROW-019: static config present but no live probe — configured, not ready.
  // Only a successful `--probe` can advance the verdict to `ready`.
  return configured(
    "managed",
    "static configuration: node / chrome / devtools package present — run `roll browser doctor --probe` to verify real MCP lane readiness",
  );
}

/**
 * Apply a live MCP probe result to the managed lane verdict.
 * Only a passed probe (initialize + manifest match + cleanup) advances from
 * `configured` to `ready`. A failed probe returns `degraded` with categorized
 * failures; the static verdict is unchanged.
 */
export function applyManagedProbe(
  base: BrowserLaneReadiness,
  probe: BrowserProbeResult,
): BrowserLaneReadiness {
  if (probe.kind === "passed") {
    return ready(
      "managed",
      `real MCP lane verified — ${probe.version}, ${probe.tools.length} tools confirmed, temporary profile cleaned up`,
    );
  }
  // Categorized failures: never a false pass.
  const failureLines = probe.failures.map((f) => `${f.category}: ${f.message}`);
  return degraded(
    "managed",
    `live probe failed — ${failureLines.join("; ")}`,
    ["review the failure category above and verify Chrome / MCP setup", "re-run roll browser doctor --probe after repair"],
  );
}

function deriveInteractive(obs: BrowserEnvironmentObservations): BrowserLaneReadiness {
  const gaps = missing([
    ["Node LTS", obs.node],
    ["npx", obs.npx],
    ["Google Chrome", obs.chrome],
  ]);
  if (gaps.length > 0) {
    return degraded(
      "interactive",
      `unavailable — ${gaps.join(", ")} not ready; existing Playwright and Roll Capture paths remain usable`,
      ["install the missing dependency, then re-run roll browser doctor"],
    );
  }
  // Remote debugging is owner-controlled and must never be auto-enabled: an
  // absent loopback endpoint is a hard blocked verdict, not a repair we run.
  if (!obs.loopbackRemoteDebug.present) {
    // FIX-1264 — port open but /json/version check failed: endpoint is
    // reachable but not a real DevTools listener (another process on 9222).
    if (obs.loopbackRemoteDebug.portReachable) {
      return degraded(
        "interactive",
        `owner Chrome remote debugging port is open but /json/version check failed — not a DevTools endpoint; ${obs.loopbackRemoteDebug.detail}`,
        [
          `verify Chrome DevTools is listening on ${MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST}:${MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT} (start Chrome with --remote-debugging-port=${MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT})`,
        ],
      );
    }
    return blocked(
      "interactive",
      `owner Chrome remote debugging is not enabled — ${obs.loopbackRemoteDebug.detail}`,
      [
        `start Chrome with --remote-debugging-port=${MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT} bound to ${MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST} yourself (Roll never enables it)`,
      ],
    );
  }
  return ready("interactive", `owner Chrome reachable on ${MANAGED_DEVTOOLS_REMOTE_DEBUG_HOST}:${MANAGED_DEVTOOLS_REMOTE_DEBUG_PORT}`);
}

function deriveCapture(obs: BrowserEnvironmentObservations): BrowserLaneReadiness {
  if (obs.capture.status === "available") {
    return ready("capture", `Roll Capture.app and Screen Recording are available — ${obs.capture.detail}`);
  }
  // Capture is never a prerequisite for managed diagnostics; a non-available
  // capture lane degrades honestly (visual AC will skip) but never blocks the
  // browser environment as a whole.
  return degraded("capture", obs.capture.detail, ["roll doctor --tools", "see Roll Capture.app setup guidance"]);
}

function toObservationList(obs: BrowserEnvironmentObservations): BrowserDependencyObservation[] {
  const row = (
    id: BrowserDependencyObservation["id"],
    s: BrowserDependencyState,
  ): BrowserDependencyObservation => (s.value === undefined
    ? { id, present: s.present, detail: s.detail }
    : { id, present: s.present, detail: s.detail, value: s.value });
  return [
    row("node", obs.node),
    row("npx", obs.npx),
    row("chrome", obs.chrome),
    row("devtools_mcp", obs.devtoolsPackage),
    row("loopback_remote_debug", obs.loopbackRemoteDebug),
    row("transport_binding", obs.transportBinding),
    {
      id: "capture",
      present: obs.capture.status === "available",
      detail: obs.capture.detail,
      value: obs.capture.status,
    },
  ];
}

/** Turn raw observations into the per-lane readiness aggregate. When a probe
 *  result is supplied, the managed lane is advanced from configured → ready or
 *  degraded per the live probe outcome. */
export function deriveBrowserEnvironmentReadiness(
  obs: BrowserEnvironmentObservations,
  probeResult?: BrowserProbeResult,
): BrowserEnvironmentReadiness {
  const managed = probeResult !== undefined
    ? applyManagedProbe(deriveManaged(obs), probeResult)
    : deriveManaged(obs);
  return {
    managed,
    interactive: deriveInteractive(obs),
    capture: deriveCapture(obs),
    observations: toObservationList(obs),
    ...(probeResult !== undefined ? { probeResult } : {}),
  };
}
