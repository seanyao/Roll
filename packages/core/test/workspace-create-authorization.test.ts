import { describe, expect, it } from "vitest";
import {
  buildWorkspaceCreateApplyAuthorization,
  buildWorkspaceCreatePlan,
  parseWorkspaceCreateApplyAuthorization,
  parseWorkspaceCreateConfig,
  validateWorkspaceCreateApplyAuthorization,
  type WorkspaceCreateProbe,
} from "../src/index.js";

const configText = `
schema: roll.workspace-create/v1
id: ws-demo
root: /tmp/workspaces/ws-demo
display_name: Demo Workspace
repositories:
  - alias: product
    source: ssh://git@example.test/team/product.git
    integration_branch: main
`;

function config() {
  const parsed = parseWorkspaceCreateConfig(configText, {
    workspaceId: "ws-demo",
    configPath: "/tmp/config/create.yaml",
    homeDir: "/tmp/home",
    rollHome: "/tmp/home/.roll",
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

function probe(): WorkspaceCreateProbe {
  return {
    paths: {},
    caches: {},
    registry: { state: "absent" },
    journal: { state: "absent" },
  };
}

describe("US-WS-024 Workspace create authorization", () => {
  it("binds stable config and plan digests to the exact Workspace preview", () => {
    const first = buildWorkspaceCreatePlan(config(), probe());
    const second = buildWorkspaceCreatePlan(config(), probe());

    expect(first.configSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.planSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toEqual(first);
    const otherMachine = buildWorkspaceCreatePlan({ ...config(), rollHome: "/tmp/other/.roll" }, probe());
    expect(otherMachine.configSha256).toBe(first.configSha256);
    expect(otherMachine.planSha256).not.toBe(first.planSha256);

    const authorization = buildWorkspaceCreateApplyAuthorization(first, "owner_after_preview");
    expect(authorization).toEqual({
      schema: "roll.workspace-create-apply-authorization/v1",
      workspaceId: "ws-demo",
      configSha256: first.configSha256,
      planSha256: first.planSha256,
      source: "owner_after_preview",
    });
    expect(validateWorkspaceCreateApplyAuthorization(first, authorization)).toEqual({ ok: true });
  });

  it("accepts only the closed authorization schema and source set", () => {
    const plan = buildWorkspaceCreatePlan(config(), probe());
    const direct = buildWorkspaceCreateApplyAuthorization(plan, "direct_cli_apply");

    expect(parseWorkspaceCreateApplyAuthorization(JSON.stringify(direct))).toEqual({ ok: true, value: direct });
    expect(parseWorkspaceCreateApplyAuthorization(JSON.stringify({ ...direct, source: "create_new" }))).toEqual({
      ok: false,
      code: "invalid_apply_authorization",
    });
    expect(parseWorkspaceCreateApplyAuthorization(JSON.stringify({ ...direct, extra: true }))).toEqual({
      ok: false,
      code: "invalid_apply_authorization",
    });
  });

  it("fails closed when authorization is absent or any exact preview fact changed", () => {
    const plan = buildWorkspaceCreatePlan(config(), probe());
    const approved = buildWorkspaceCreateApplyAuthorization(plan, "owner_after_preview");
    const nextAction = "roll workspace create ws-demo --config <path> --check --json";

    expect(validateWorkspaceCreateApplyAuthorization(plan, undefined)).toEqual({
      ok: false,
      code: "apply_authorization_required",
      nextAction,
    });
    expect(validateWorkspaceCreateApplyAuthorization(plan, { ...approved, workspaceId: "ws-other" })).toEqual({
      ok: false,
      code: "apply_authorization_stale",
      nextAction,
    });
    expect(validateWorkspaceCreateApplyAuthorization(plan, { ...approved, configSha256: "0".repeat(64) })).toEqual({
      ok: false,
      code: "apply_authorization_stale",
      nextAction,
    });
    expect(validateWorkspaceCreateApplyAuthorization(plan, { ...approved, planSha256: "f".repeat(64) })).toEqual({
      ok: false,
      code: "apply_authorization_stale",
      nextAction,
    });
  });
});
