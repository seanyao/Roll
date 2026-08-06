/**
 * @responsibility Declares the versioned minimum tool manifest for the managed DevTools session.
 * US-BROW-016 — versioned minimum tool manifest for the managed DevTools MCP
 * session.
 *
 * The manifest is the contract between Roll and the pinned chrome-devtools-mcp
 * package. The session refuses to execute any browser action until the MCP
 * server advertises every required tool from the manifest.
 */

import { MANAGED_DEVTOOLS_PACKAGE_VERSION } from "./transport.js";
import type { BrowserActionKind, BrowserDenialReason } from "@roll/spec";

/** The only MCP capabilities the Browser Operations facade may invoke. */
export type DevToolsMcpToolName =
  | "navigate_page"
  | "take_snapshot"
  | "list_console_messages"
  | "list_network_requests"
  | "take_screenshot"
  | "click"
  | "fill"
  | "press_key";

/** A policy-approved action paired with the one MCP capability it may invoke. */
export interface ApprovedBrowserAction {
  readonly kind: BrowserActionKind;
  readonly tool: DevToolsMcpToolName;
}

const ACTION_TO_TOOL: Readonly<Record<BrowserActionKind, DevToolsMcpToolName>> = {
  navigate: "navigate_page",
  snapshot: "take_snapshot",
  console: "list_console_messages",
  network: "list_network_requests",
  screenshot: "take_screenshot",
  click: "click",
  fill: "fill",
  press_key: "press_key",
};

/** The machine-approved minimum capability surface the MCP server must expose. */
export interface DevToolsMcpManifest {
  /** Pinned package version this manifest applies to. */
  readonly version: string;
  /** Required tool names. Missing or renamed tools fail closed. */
  readonly requiredTools: readonly string[];
}

/**
 * Minimum manifest for the pinned chrome-devtools-mcp package.
 *
 * Required tools are exactly the facade's ACTION_TO_TOOL targets — the tool
 * names chrome-devtools-mcp@1.5.0 REALLY exposes (verified live via
 * tools/list, US-BROW-019). There is no generic `chrome_devtools_call` CDP
 * proxy in the real server; requiring one made every live probe fail with
 * manifest-mismatch while fixture tests (which fabricated it) stayed green.
 */
export const MINIMUM_DEVTOOLS_MCP_MANIFEST: DevToolsMcpManifest = {
  version: MANAGED_DEVTOOLS_PACKAGE_VERSION,
  requiredTools: [...Object.values(ACTION_TO_TOOL)],
};

/**
 * Turns an untrusted runtime action string into the closed facade vocabulary.
 * A caller can never nominate an MCP tool name independently of this mapping.
 */
export function approveBrowserAction(rawAction: string): ApprovedBrowserAction | BrowserDenialReason {
  const tool = ACTION_TO_TOOL[rawAction as BrowserActionKind];
  if (tool === undefined) {
    return {
      code: "action_not_allowed",
      message: `Browser action "${rawAction}" is not supported by the DevTools MCP facade`,
      detail: { action: rawAction },
    };
  }
  return { kind: rawAction as BrowserActionKind, tool };
}

/** Returns the manifest-approved MCP tool for an action, or undefined when denied. */
export function resolveMcpToolForAction(rawAction: string): DevToolsMcpToolName | undefined {
  const approved = approveBrowserAction(rawAction);
  return "tool" in approved ? approved.tool : undefined;
}

/** Error raised when the MCP session cannot initialize or lacks the manifest. */
export class DevToolsProtocolError extends Error {
  readonly code = "devtools_protocol_error" as const;
  constructor(message: string) {
    super(message);
  }
}
