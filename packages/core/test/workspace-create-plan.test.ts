import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CREATE_CONFIG_V1,
  buildWorkspaceCreatePlan,
  parseWorkspaceCreateConfig,
  type WorkspaceCreateProbe,
} from "../src/workspace/create-plan.js";

const config = `
schema: roll.workspace-create/v1
id: ws-demo
root: ~/.roll/workspaces/ws-demo
repositories:
  - alias: product
    source: file:///tmp/remotes/product.git
    integration_branch: main
`;

const options = {
  workspaceId: "ws-demo",
  configPath: "/tmp/workspace-create.yaml",
  homeDir: "/tmp/home",
  rollHome: "/tmp/home/.roll",
} as const;

function probe(overrides: Partial<WorkspaceCreateProbe> = {}): WorkspaceCreateProbe {
  return {
    paths: {},
    caches: {},
    registry: { state: "absent" },
    journal: { state: "absent" },
    ...overrides,
  };
}

describe("US-WS-023 WorkspaceCreatePlan", () => {
  it("parses only the closed create/v1 config and emits create/v1 plan paths", () => {
    const parsed = parseWorkspaceCreateConfig(config, options);
    expect(parsed).toMatchObject({ ok: true, value: { schema: WORKSPACE_CREATE_CONFIG_V1, workspaceId: "ws-demo" } });
    if (!parsed.ok) throw new Error("fixture must parse");

    const plan = buildWorkspaceCreatePlan(parsed.value, probe());
    expect(plan.schema).toBe("roll.workspace-create-plan/v1");
    expect(plan.steps[0]).toEqual({
      kind: "journal",
      target: join(options.rollHome, "workspace-create", "ws-demo.pending.json"),
      action: "created",
    });
  });

  it("fails loud for the legacy init config with a deterministic conversion list", () => {
    const parsed = parseWorkspaceCreateConfig(config.replace("roll.workspace-create/v1", "roll.workspace-init/v1"), options);
    expect(parsed).toEqual({
      ok: false,
      errors: [{
        code: "legacy_create_config",
        path: "schema",
        message: "Legacy Workspace init config must be converted before create",
        conversions: [
          { path: "schema", from: "roll.workspace-init/v1", to: "roll.workspace-create/v1" },
        ],
        nextAction: "roll workspace create ws-demo --config <converted-path>",
      }],
    });
  });
});
