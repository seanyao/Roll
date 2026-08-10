/**
 * @responsibility Authorizes the managed DevTools transport and its version check.
 * US-BROW-002 — the only authority for the managed DevTools transport.
 *  US-BROW-010 — deterministic version check and atomic update (BrowserTransportVersion). */
import type {
  BrowserDenialReason,
  BrowserOperationEvent,
  BrowserTransportVersionApplyResult,
  BrowserTransportVersionCheck,
} from "@roll/spec";

export const MANAGED_DEVTOOLS_SERVER = "chrome-devtools";
export const MANAGED_DEVTOOLS_PACKAGE = "chrome-devtools-mcp";
export const MANAGED_DEVTOOLS_PACKAGE_VERSION = "1.5.0";

// ── US-BROW-010 — version source and sentinel ──────────────────────────────────

/** Sentinel: no update is available. The version source returns this instead of null
 *  so a source that genuinely wants `null` never conflicts with a missing source. */
export const NO_UPDATE_AVAILABLE = Symbol("no-update-available");

/** A deterministic, injectable source of available candidate versions.
 *  Returns a version string, or `NO_UPDATE_AVAILABLE` when no update exists.
 *  Must never perform network I/O, install packages, or write configuration. */
export type VersionSource = () => string | typeof NO_UPDATE_AVAILABLE;

export interface BrowserTransport {
  logicalServer: typeof MANAGED_DEVTOOLS_SERVER;
  command: "npx";
  // --isolated: server-managed TEMPORARY Chrome profile, deleted on close.
  // --headless: server-launched Chrome needs no display (CI lane has none).
  args: readonly ["-y", string, "--no-usage-statistics", "--isolated", "--headless"];
  remoteDebugging: { host: "127.0.0.1"; port: 9222 };
}

export type BrowserTransportResolution =
  | { kind: "resolved"; transport: BrowserTransport }
  | { kind: "denied"; reason: BrowserDenialReason };

function managedTransport(): BrowserTransport {
  return {
    logicalServer: MANAGED_DEVTOOLS_SERVER,
    command: "npx",
    args: ["-y", `${MANAGED_DEVTOOLS_PACKAGE}@${MANAGED_DEVTOOLS_PACKAGE_VERSION}`, "--no-usage-statistics", "--isolated", "--headless"],
    remoteDebugging: { host: "127.0.0.1", port: 9222 },
  };
}

/**
 * Keeps the privileged DevTools process plan outside project-controlled MCP
 * configuration. Project policy may name the logical binding, but can never
 * alter its executable, package pin, arguments, or remote-debugging endpoint.
 */
export class BrowserTransportRegistry {
  resolve(requestedServer: string): BrowserTransportResolution {
    if (requestedServer === MANAGED_DEVTOOLS_SERVER) {
      return { kind: "resolved", transport: managedTransport() };
    }
    return {
      kind: "denied",
      reason: {
        code: "transport_binding_missing",
        message: `Browser policy devtools_server must exactly match \"${MANAGED_DEVTOOLS_SERVER}\"`,
        detail: { requestedServer, registeredServer: MANAGED_DEVTOOLS_SERVER },
      },
    };
  }

  /** Records a durable-domain event payload before generic MCP can resolve or spawn. */
  denyGenericMcp(serverName: string, ts: string): Extract<BrowserOperationEvent, { type: "browser:mcp-bypass-denied" }> {
    const event = {
      type: "browser:mcp-bypass-denied" as const,
      ts,
      reason: {
        code: "generic_mcp_bypass_denied" as const,
        message: `${MANAGED_DEVTOOLS_SERVER} is reserved for Browser Operations`,
        detail: { serverName },
      },
    };
    return event;
  }
}

export function isReservedBrowserTransport(serverName: string): boolean {
  return serverName === MANAGED_DEVTOOLS_SERVER;
}

// ── US-BROW-010 — deterministic transport version check and atomic update ───────

/**
 * Owns the single source of truth for the managed DevTools package version.
 * The check is deterministic and non-mutating — it never downloads, installs,
 * or rewrites configuration. The apply transaction is atomic: verification
 * runs before the pin is changed, and a failed verification leaves the prior
 * version intact.
 */
export class BrowserTransportVersion {
  #pinned: string;
  readonly #versionSource: VersionSource;

  constructor(pinnedVersion: string, versionSource: VersionSource) {
    this.#pinned = pinnedVersion;
    this.#versionSource = versionSource;
  }

  /** The currently pinned version (read-only from outside the aggregate). */
  get pinnedVersion(): string {
    return this.#pinned;
  }

  /**
   * Reports the pinned version and available candidate without any side effect.
   * The version source is called once per check and must be deterministic for
   * the same input.
   */
  check(): BrowserTransportVersionCheck {
    const raw = this.#versionSource();
    const candidate = raw === NO_UPDATE_AVAILABLE ? null : raw;
    return {
      pinned: this.#pinned,
      candidate,
      updateAvailable: candidate !== null && candidate !== this.#pinned,
    };
  }

  /**
   * Atomically applies an update after running smoke/contract checks.
   *
   * - Rejects the candidate if it doesn't match the version source.
   * - Refuses if the candidate is empty or already pinned.
   * - Runs the smoke check; on failure keeps the prior version intact.
   * - On success, updates the pinned version atomically.
   */
  async apply(
    candidate: string,
    smokeCheck: () => Promise<boolean>,
  ): Promise<BrowserTransportVersionApplyResult> {
    if (candidate === "") {
      return { kind: "refused", reason: "candidate version must be non-empty" };
    }
    if (candidate === this.#pinned) {
      return { kind: "no_update", pinned: this.#pinned };
    }
    const available = this.#versionSource();
    const availableStr = available === NO_UPDATE_AVAILABLE ? null : available;
    if (availableStr === null || availableStr !== candidate) {
      return {
        kind: "refused",
        reason: `candidate "${candidate}" does not match available update "${availableStr ?? "(none)"}"`,
      };
    }

    const passed = await smokeCheck();
    if (!passed) {
      return {
        kind: "verification_failed",
        from: this.#pinned,
        candidate,
        reason: "smoke check failed",
      };
    }

    const from = this.#pinned;
    this.#pinned = candidate;
    return { kind: "applied", from, to: candidate };
  }
}

/** Known DevTools MCP version map. A version maps to its next known stable
 *  release. This is the default, deterministic version source — it never
 *  performs network I/O, never installs packages, and never writes config. */
const KNOWN_DEVTOOLS_VERSIONS: Record<string, string> = {
  "1.5.0": "1.6.0",
};

/** Returns a deterministic version source based on the currently pinned version.
 *  If the pinned version has a known successor, the source returns it;
 *  otherwise it returns NO_UPDATE_AVAILABLE. */
export function pinnedDevToolsVersionSource(pinned: string): VersionSource {
  const next = KNOWN_DEVTOOLS_VERSIONS[pinned];
  if (next !== undefined) {
    return () => next;
  }
  return () => NO_UPDATE_AVAILABLE;
}
