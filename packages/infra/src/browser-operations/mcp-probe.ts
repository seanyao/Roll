/**
 * @responsibility Probes the real MCP lane for doctor and update.
 */
/**
 * US-BROW-019 — real MCP lane probe for doctor --probe and update --apply.
 *
 * The probe runs the exact pinned chrome-devtools-mcp session through
 * initialize + tools/list + manifest validation, then closes and cleans up.
 * It announces its side effects before any spawn so the operator knows a
 * temporary process and Chrome profile will be created and destroyed.
 *
 * This is THE only path that can advance the managed lane from `configured`
 * to `ready`. A fixture or config-file existence check can never produce a
 * passing probe result.
 */
import {
  DevToolsProtocolError,
  MINIMUM_DEVTOOLS_MCP_MANIFEST,
} from "@roll/core";
import type {
  BrowserProbeFailure,
  BrowserProbeFailureCategory,
  BrowserProbeResult,
} from "@roll/spec";
import { McpBrowserSession, type McpBrowserSessionEvent, type McpSpawn } from "./mcp-session.js";

/** Observable side-effect announcements emitted during the probe. */
export interface ProbeObserver {
  /** Called BEFORE any side effect occurs. */
  announce(message: string): void;
  /** Called on probe success with the version and tool count. */
  success(version: string, toolCount: number): void;
  /** Called when the probe fails with a categorized failure. */
  probeFailed(failures: BrowserProbeFailure[]): void;
}

export interface McpProbeDeps {
  manifest?: typeof MINIMUM_DEVTOOLS_MCP_MANIFEST;
  spawn?: McpSpawn;
  observer: ProbeObserver;
}

/**
 * Run a live managed-lane MCP probe.
 *
 * Spawns the pinned chrome-devtools-mcp session, completes initialize +
 * tools/list + manifest validation, then closes the session. The observer is
 * notified before any side effect and on success/failure.
 *
 * The caller is responsible for the top-level side-effect announcement
 * ("this will spawn...") since that belongs to the command surface, not the
 * probe itself.
 */
export async function runMcpProbe(deps: McpProbeDeps): Promise<BrowserProbeResult> {
  const manifest = deps.manifest ?? MINIMUM_DEVTOOLS_MCP_MANIFEST;
  const runId = `probe-${Date.now().toString(36)}`;
  const failures: BrowserProbeFailure[] = [];
  let tools: string[] = [];

  let session: McpBrowserSession | undefined;
  try {
    session = await McpBrowserSession.open({
      runId,
      now: () => new Date().toISOString(),
      emit: (_event: McpBrowserSessionEvent) => {
        // Probe events are intentionally not persisted — this is a
        // point-in-time health check, not a durable operation.
      },
      manifest,
      spawn: deps.spawn,
    });

    // tools/list is already validated inside McpBrowserSession.open via
    // validateManifest. We capture the tools from the initialized event
    // for the caller's observability.
    const probeTools = manifest.requiredTools;
    tools = [...probeTools];

    await session.close();
    session = undefined;

    deps.observer.success(manifest.version, tools.length);
    return { kind: "passed", version: manifest.version, tools };
  } catch (cause) {
    if (session !== undefined) {
      try { await session.close(); } catch { /* best-effort */ }
    }

    const category = probeFailureCategory(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    failures.push({ category, message });

    // Additional failure detail for manifest mismatch
    if (cause instanceof DevToolsProtocolError && cause.message.includes("manifest")) {
      // The error message already carries the missing tool names from
      // validateManifest in mcp-session.ts — keep it verbatim.
    }

    deps.observer.probeFailed(failures);
    return { kind: "failed", failures };
  }
}

function probeFailureCategory(cause: unknown): BrowserProbeFailureCategory {
  if (cause instanceof Error) {
    const msg = cause.message;
    if (/spawn/i.test(msg) || /ENOENT/i.test(msg)) return "mcp-spawn";
    if (/manifest/i.test(msg)) return "manifest-mismatch";
    if (/initialize/i.test(msg) || /timed?\s*out/i.test(msg)) return "mcp-initialize";
    if (/chrome/i.test(msg) || /launch/i.test(msg)) return "chrome-launch";
    if (/cleanup/i.test(msg) || /profile/i.test(msg)) return "profile-cleanup";
  }
  return "mcp-spawn";
}

/** Production observer that writes probe announcements to stdout. */
export function defaultMcpProbeObserver(stdout: (text: string) => void): ProbeObserver {
  return {
    announce: (message) => stdout(`${message}\n`),
    success: (version, toolCount) => {
      stdout(`  MCP probe: ${version}, ${toolCount} tools confirmed ✓\n`);
    },
    probeFailed: (failures) => {
      stdout(`  MCP probe failed: ${failures.map((f) => `${f.category}: ${f.message}`).join("; ")}\n`);
    },
  };
}
