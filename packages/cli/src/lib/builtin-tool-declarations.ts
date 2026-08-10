/**
 * @responsibility Assembles the built-in tool declarations from the infra tool adapters.
 */
import { BashTool, browserTools, fsTools, gitTools, githubTools, mcpTools, networkTools } from "@roll/infra";
import type { ToolDeclaration } from "@roll/spec";

export function collectBuiltinToolDeclarations(projectRoot: string): ToolDeclaration[] {
  const tools: Array<{ declaration: ToolDeclaration }> = [
    new BashTool(),
    ...browserTools(),
    ...fsTools(projectRoot),
    ...gitTools(),
    ...githubTools(),
    ...mcpTools(projectRoot),
    ...networkTools(),
  ];
  return tools.map((tool) => tool.declaration);
}
