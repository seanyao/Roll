/**
 * @responsibility Bridges the typed process boundary for managed Chrome DevTools.
 */
/** US-BROW-002 — typed process boundary for managed Chrome DevTools. */
import {
  BrowserTransportRegistry,
  type BrowserTransport,
} from "@roll/core";
import type { BrowserDenialReason } from "@roll/spec";

/** A future typed action facade receives this connection; generic MCP never does. */
export interface DevToolsConnection {
  close(): Promise<void>;
}

/** Project policy is untrusted input: only the logical binding is consumed. */
export interface BrowserTransportPolicyBinding {
  devtoolsServer: string;
  readonly [key: string]: unknown;
}

export type OpenDevToolsTransport = (plan: BrowserTransport) => Promise<DevToolsConnection>;

export type DevToolsTransportResult =
  | { kind: "connected"; connection: DevToolsConnection }
  | { kind: "denied"; reason: BrowserDenialReason };

/**
 * Opens the managed DevTools process only after the Browser Operations policy
 * has resolved to the registry's single logical binding. No project-supplied
 * command, package, endpoint, or generic MCP resolver enters this path.
 */
export class ManagedDevToolsTransport {
  constructor(
    private readonly registry: BrowserTransportRegistry,
    private readonly openTransport: OpenDevToolsTransport,
  ) {}

  async open(policy: BrowserTransportPolicyBinding): Promise<DevToolsTransportResult> {
    const resolution = this.registry.resolve(policy.devtoolsServer);
    if (resolution.kind === "denied") return resolution;
    return { kind: "connected", connection: await this.openTransport(resolution.transport) };
  }
}
