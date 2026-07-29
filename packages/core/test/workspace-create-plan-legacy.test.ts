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
display_name: Demo Workspace
requirements:
  - provider: jira
    ref: SOT-15499
repositories:
  - alias: api
    source: file:///tmp/remotes/api.git
    integration_branch: main
    provider: generic
    required_checks: [unit, integration]
  - alias: web
    source: ssh://git@example.test/team/web.git
    integration_branch: release
`;

function probe(overrides: Partial<WorkspaceCreateProbe> = {}): WorkspaceCreateProbe {
  return {
    paths: {},
    caches: {},
    registry: { state: "absent" },
    journal: { state: "absent" },
    ...overrides,
  };
}

describe("WorkspaceCreationPlan", () => {
  it("parses the closed YAML config and produces one stable ordered create plan", () => {
    const parsed = parseWorkspaceCreateConfig(config, {
      workspaceId: "ws-demo",
      configPath: "/tmp/config/workspace-create.yaml",
      homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        schema: WORKSPACE_CREATE_CONFIG_V1,
        workspaceId: "ws-demo",
        root: "/tmp/home/.roll/workspaces/ws-demo",
        manifest: {
          schema: "roll.workspace/v1",
          workspaceId: "ws-demo",
          displayName: "Demo Workspace",
          requirements: [{ provider: "jira", ref: "SOT-15499" }],
          repositories: [
            { alias: "api", remote: "file:///tmp/remotes/api", integrationBranch: "main" },
            { alias: "web", remote: "ssh://example.test/team/web", integrationBranch: "release" },
          ],
        },
      },
    });
    if (!parsed.ok) throw new Error("fixture must parse");

    const plan = buildWorkspaceCreatePlan(parsed.value, probe());
    expect(plan.outcome).toBe("created");
    expect(plan.steps.map((step) => `${step.kind}:${step.action}:${step.target}`)).toEqual([
      "journal:created:/tmp/home/.roll/workspace-create/ws-demo.pending.json",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo",
      "file:created:/tmp/home/.roll/workspaces/ws-demo/workspace.yaml",
      "file:created:/tmp/home/.roll/workspaces/ws-demo/charter.md",
      "file:created:/tmp/home/.roll/workspaces/ws-demo/agents.yaml",
      "file:created:/tmp/home/.roll/workspaces/ws-demo/policy.yaml",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/requirements",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/design",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/backlog",
      "file:created:/tmp/home/.roll/workspaces/ws-demo/backlog/index.md",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/issues",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/runtime",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/runtime/locks",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/runtime/heartbeats",
      "directory:created:/tmp/home/.roll/workspaces/ws-demo/runtime/alerts",
      expect.stringMatching(/^cache:created:repo-[0-9a-f]{12}$/),
      expect.stringMatching(/^cache:created:repo-[0-9a-f]{12}$/),
      "registry:created:ws-demo",
    ]);
    expect(plan.steps.filter((step) => step.kind === "cache").map((step) => step.target))
      .toEqual([...plan.steps.filter((step) => step.kind === "cache").map((step) => step.target)].sort());
  });

  it("summarizes compatible retries deterministically as reused or repaired", () => {
    const parsed = parseWorkspaceCreateConfig(config, {
      workspaceId: "ws-demo",
      configPath: "/tmp/workspace-create.yaml",
      homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    if (!parsed.ok) throw new Error("fixture must parse");
    const compatiblePaths = Object.fromEntries(
      buildWorkspaceCreatePlan(parsed.value, probe()).steps
        .filter((step) => step.kind === "directory" || step.kind === "file")
        .map((step) => [step.target, "compatible" as const]),
    );
    const cacheIds = parsed.value.manifest.repositories.map((repo) => repo.repoId);
    const reused = buildWorkspaceCreatePlan(parsed.value, probe({
      paths: compatiblePaths,
      caches: Object.fromEntries(cacheIds.map((id) => [id, "compatible" as const])),
      registry: { state: "compatible" },
    }));
    expect(reused.outcome).toBe("reused");
    expect(reused.steps.every((step) => step.kind === "journal" || step.action === "reused")).toBe(true);

    const repaired = buildWorkspaceCreatePlan(parsed.value, probe({
      paths: { ...compatiblePaths, [join(parsed.value.root, "runtime", "alerts")]: "absent" },
      caches: Object.fromEntries(cacheIds.map((id) => [id, "compatible" as const])),
      registry: { state: "compatible" },
      journal: { state: "repairable" },
    }));
    expect(repaired.outcome).toBe("repaired");
    expect(repaired.steps[0]).toMatchObject({ kind: "journal", action: "repaired" });
  });

  it.each([
    ["unknown schema", config.replace(WORKSPACE_CREATE_CONFIG_V1, "roll.workspace-create/v2"), "unknown_version"],
    ["mismatched id", config.replace("id: ws-demo", "id: ws-other"), "identity_mismatch"],
    ["unsafe remote", config.replace("file:///tmp/remotes/api.git", "https://token@example.test/team/api.git"), "unsafe_remote"],
    ["duplicate alias", config.replace("alias: web", "alias: api"), "duplicate_identity"],
  ])("rejects %s before a plan can be applied", (_name, text, code) => {
    const parsed = parseWorkspaceCreateConfig(text, {
      workspaceId: "ws-demo",
      configPath: "/tmp/workspace-create.yaml",
      homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    expect(parsed).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code })]) });
  });

  it("rejects an unsafe Workspace ID before deriving mutation paths", () => {
    const parsed = parseWorkspaceCreateConfig(config.replaceAll("ws-demo", "../../escape"), {
      workspaceId: "../../escape",
      configPath: "/tmp/workspace-create.yaml",
      homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    expect(parsed).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ code: "invalid_value" }),
    ]) });
  });

  it("does not derive manifest identity from config file metadata", () => {
    const original = parseWorkspaceCreateConfig(config, {
      workspaceId: "ws-demo", configPath: "/tmp/original/workspace-create.yaml", homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    const copied = parseWorkspaceCreateConfig(config, {
      workspaceId: "ws-demo", configPath: "/tmp/copied/workspace-create.yaml", homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    expect(original).toEqual(copied);
  });

  it("rejects a Workspace root that contains the machine cache root", () => {
    const parsed = parseWorkspaceCreateConfig(config.replace("~/.roll/workspaces/ws-demo", "~/.roll"), {
      workspaceId: "ws-demo",
      configPath: "/tmp/workspace-create.yaml",
      homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    expect(parsed).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "path_conflict" })] });
  });

  it("returns an ordered rejected plan when any probed target conflicts", () => {
    const parsed = parseWorkspaceCreateConfig(config, {
      workspaceId: "ws-demo",
      configPath: "/tmp/workspace-create.yaml",
      homeDir: "/tmp/home",
      rollHome: "/tmp/home/.roll",
    });
    if (!parsed.ok) throw new Error("fixture must parse");
    const plan = buildWorkspaceCreatePlan(parsed.value, probe({
      paths: { [join(parsed.value.root, "workspace.yaml")]: "conflict" },
    }));
    expect(plan.outcome).toBe("rejected");
    expect(plan.steps.find((step) => step.target.endsWith("workspace.yaml"))).toMatchObject({ action: "rejected" });
    expect(plan.steps.at(-1)).toMatchObject({ kind: "registry", target: "ws-demo" });
  });
});
