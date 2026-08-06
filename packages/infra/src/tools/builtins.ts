/**
 * @responsibility Enumerates the canonical built-in tool adapter declarations.
 */
/**
 * US-TOOL-016 — the ONE canonical enumeration of every built-in tool adapter
 * declaration. This is the machine-global catalog the Tools page (US-TOOL-017)
 * renders from, exactly as the Skills page renders from `auditSkills` and the
 * Agents page from `collectAgentPanel`: a single source of truth that can never
 * disagree with the actually-registered adapters, because it reads each
 * adapter's own `.declaration`.
 *
 * Determinism: gathers `.declaration` from every built-in adapter factory
 * (bash · browser · git · github · network · filesystem · mcp), sorted by
 * `(kind, id)`. No instantiation side-effects beyond constructing the
 * declarations; no clock, no RNG, no network. The same machine always returns
 * byte-identical declarations.
 */
import type { ToolDeclaration } from "@roll/spec";
import { BashTool } from "./bash.js";
import { browserTools } from "./browser.js";
import { fsTools } from "./filesystem.js";
import { gitTools } from "./git.js";
import { githubTools } from "./github.js";
import { mcpTools } from "./mcp.js";
import { networkTools } from "./network.js";

/**
 * Every built-in adapter's declaration, in deterministic `(kind, id)` order.
 *
 * MCP is the extensible entry point: a single row describing the adapter.
 * Discovered MCP server tools are NOT enumerated here (owner sign-off: built-in
 * adapters only).
 */
export function builtinToolDeclarations(): ToolDeclaration[] {
  const declarations: ToolDeclaration[] = [
    new BashTool().declaration,
    ...browserTools().map((tool) => tool.declaration),
    ...gitTools().map((tool) => tool.declaration),
    ...githubTools().map((tool) => tool.declaration),
    ...networkTools().map((tool) => tool.declaration),
    ...fsTools().map((tool) => tool.declaration),
    ...mcpTools().map((tool) => tool.declaration),
  ];
  return declarations.sort(byKindThenId);
}

function byKindThenId(a: ToolDeclaration, b: ToolDeclaration): number {
  const kind = String(a.kind).localeCompare(String(b.kind));
  if (kind !== 0) return kind;
  return String(a.id).localeCompare(String(b.id));
}
