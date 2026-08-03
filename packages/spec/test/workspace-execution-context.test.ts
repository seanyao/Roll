import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type WorkspaceContextScope,
  type WorkspaceExecutionContextV1,
} from "../src/index.js";

describe("WorkspaceExecutionContextV1 contract", () => {
  it("exposes one versioned schema and the repository-required scope", () => {
    const scope: WorkspaceContextScope = "repository_required";
    const schema: WorkspaceExecutionContextV1["schema"] = WORKSPACE_EXECUTION_CONTEXT_V1;

    expect({ schema, scope }).toEqual({
      schema: "roll.workspace-execution-context/v1",
      scope: "repository_required",
    });
  });
});
