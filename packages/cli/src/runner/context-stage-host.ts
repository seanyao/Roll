import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createContextReadService } from "@roll/core";
import { createContextReadAdapter } from "@roll/infra";
import { readContextSnapshot, readWorkspace } from "@roll/infra";
import {
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { createContextCommandDeps } from "../commands/context.js";
import { workspaceRollHome } from "../commands/workspace-target.js";
import { createContextHostAdapter, type ContextStageReadInputV1 } from "./context-adapter.js";
import { invalidContextHandoff, type ContextStageReadResultV1 } from "./context-handoff.js";

export type ContextStageHostReadInputV1 = Omit<ContextStageReadInputV1, "workspace">;

export interface ContextStageHostPort {
  readForStage(input: ContextStageHostReadInputV1): Promise<ContextStageReadResultV1>;
}

function workspaceExecutionContext(workspaceRoot: string): WorkspaceExecutionContextV1 {
  const canonicalRoot = realpathSync(workspaceRoot);
  const manifest = readWorkspace(canonicalRoot);
  const runtime = join(canonicalRoot, "runtime");
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId: manifest.workspaceId,
      root: workspaceRoot,
      canonicalRoot,
      lifecycle: "active",
    },
    resolution: { source: "explicit", evidence: [] },
    bindings: manifest.repositories,
    ...(manifest.contexts === undefined ? {} : { contexts: manifest.contexts }),
    authorities: {
      backlog: join(canonicalRoot, "backlog", "index.md"),
      features: join(canonicalRoot, "features"),
      design: join(canonicalRoot, "design"),
      requirements: join(canonicalRoot, "requirements"),
      policy: join(canonicalRoot, "policy.yaml"),
      evidence: join(canonicalRoot, "evidence"),
      toolDumps: join(canonicalRoot, "artifacts", "tool-dumps"),
      events: join(runtime, "events.ndjson"),
      runtime,
      locks: join(runtime, "locks"),
    },
  };
}

/**
 * Bind Context reads and the durable Snapshot store to the real Node runner.
 * The host never discovers a Snapshot by recency: callers must carry the exact
 * typed handoff (or explicitly request a fresh read with a revision decision).
 */
export function createNodeContextStageHost(workspaceRoot: string): ContextStageHostPort | undefined {
  let workspace: WorkspaceExecutionContextV1;
  try {
    workspace = workspaceExecutionContext(workspaceRoot);
  } catch {
    // Context is an optional runner capability. Legacy Workspace fixtures and
    // installations may still use the earlier YAML manifest form, so failing
    // to decode their manifest must not break unrelated runner construction.
    return undefined;
  }
  if (workspace.contexts?.enabled !== true || !workspace.contexts.bindings.some((binding) => binding.enabled)) {
    return undefined;
  }
  const rollHome = workspaceRollHome();
  const commandDeps = createContextCommandDeps({ rollHome });
  const host = createContextHostAdapter({
    freshRead: async (request) => {
      const registry = commandDeps.readRegistry();
      return createContextReadService({
        registry,
        adapter: createContextReadAdapter({ rollHome }),
        authorizeRestrictedReference: (_readRequest, file) =>
          commandDeps.authorizeRestrictedReference(request, file),
      }).read(request);
    },
    writeSnapshot: (snapshot) => { commandDeps.writeSnapshot(workspace, snapshot); },
    readSnapshot: (_workspace, reference) => readContextSnapshot(workspace, reference),
  });
  return {
    async readForStage(input) {
      try {
        return host.readForStage({
          workspace,
          ...input,
        });
      } catch {
        return { status: "blocked", diagnostic: invalidContextHandoff() };
      }
    },
  };
}
