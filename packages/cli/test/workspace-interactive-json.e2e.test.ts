import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDiscoveryFactsV1 } from "@roll/core";
import { loadWorkspaceDiscovery, WorkspaceRegistry } from "@roll/infra";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
} from "@roll/spec";
import { deliveryCommand } from "../src/commands/delivery.js";
import { backlogCommand } from "../src/commands/backlog.js";
import { resolveBacklogCommandTarget, type BacklogTargetDecision } from "../src/commands/backlog-target.js";
import { dispatch, registerPorted } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

function facts(workspaceId: string): WorkspaceDiscoveryFactsV1 {
  const root = `/workspaces/${workspaceId}`;
  const remote = `https://example.test/${workspaceId}/product.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  return {
    candidate: {
      workspaceId,
      root,
      canonicalRoot: root,
      manifestWorkspaceId: workspaceId,
      pathState: "valid",
      lifecycle: "active",
    },
    manifest: {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId,
      displayName: `${workspaceId} delivery`,
      requirements: [],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: repoId.value,
        alias: "product",
        remote,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    },
    issues: [],
  };
}

function target(root: string, workspaceId: string): BacklogTargetDecision {
  return {
    ok: true,
    workspaceId,
    workspaceRoot: root,
    canonicalRoot: root,
    backlogPath: `${root}/backlog/index.md`,
    storyRoot: `${root}/backlog`,
    runtimeRoot: `${root}/runtime`,
    configPath: `${root}/runtime/backlog-sync.yaml`,
  };
}

function capture(run: () => number): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error deterministic command capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => ((stdout += String(chunk)), true);
  // @ts-expect-error deterministic command capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
  try {
    return { status: run(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function captureDispatch(argv: string[]): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error deterministic command capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => ((stdout += String(chunk)), true);
  // @ts-expect-error deterministic command capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
  try {
    const result = await dispatch(argv, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("US-WS-030 delivery interactive JSON", () => {
  it("keeps the prompt on the TTY channel and stdout as one existing delivery-list JSON", () => {
    const prompts: string[] = [];
    const resolveTarget = vi.fn((args: readonly string[]): BacklogTargetDecision =>
      args.includes("--workspace") ? target("/tmp", "fields") : {
        ok: false,
        code: "target_missing",
        candidates: [],
      }
    );
    const result = capture(() => deliveryCommand(["list", "--interactive", "--json"], {
      resolveTarget,
      interaction: {
        cwd: "/tmp",
        capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
        ask: (prompt) => (prompts.push(prompt), "1"),
        loadDiscovery: () => ({
          schema: "roll.workspace-discovery-load/v1",
          registryRevision: 7,
          discoveryFactsSha256: "a".repeat(64),
          workspaces: [facts("fields"), facts("roll")],
          diagnostics: [],
        }),
      },
    }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "roll.delivery-list/v1",
      workspaces: [{ workspaceId: "fields", path: "/tmp", issues: [] }],
    });
    expect(result.stderr).toBe("");
    expect(prompts).toHaveLength(1);
    expect(result.stdout).not.toContain("Action:");
    expect(resolveTarget).toHaveBeenNthCalledWith(1, ["--json"], "read");
    expect(resolveTarget).toHaveBeenNthCalledWith(2, ["--json", "--workspace", "fields"], "read");
  });

  it.each([
    ["cancel", "workspace_clarification_cancelled", undefined],
    [null, "workspace_clarification_cancelled", undefined],
    ["create", "create_required", "roll workspace create <ID> --config <path> --check"],
  ] as const)("writes one canonical error JSON for %s", (answer, code, nextAction) => {
    const prompts: string[] = [];
    const resolveTarget = vi.fn((): BacklogTargetDecision => ({ ok: false, code: "target_missing", candidates: [] }));
    const result = capture(() => deliveryCommand(["list", "--interactive", "--json"], {
      resolveTarget,
      interaction: {
        cwd: "/tmp",
        capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
        ask: (prompt) => (prompts.push(prompt), answer),
        loadDiscovery: () => ({
          schema: "roll.workspace-discovery-load/v1",
          registryRevision: 7,
          discoveryFactsSha256: "a".repeat(64),
          workspaces: [facts("fields")],
          diagnostics: [],
        }),
      },
    }));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr) as { error: { code: string; nextAction?: string } };
    expect(error.error.code).toBe(code);
    expect(error.error.nextAction).toBe(nextAction);
    expect(result.stderr).not.toContain("Action:");
    expect(prompts).toHaveLength(1);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it("keeps --json non-interactive by default and embeds the shared clarification handoff", () => {
    const ask = vi.fn();
    const result = capture(() => deliveryCommand(["list", "--json"], {
      resolveTarget: () => ({ ok: false, code: "target_missing", candidates: [] }),
      interaction: {
        cwd: "/tmp",
        capabilities: { stdinTTY: false, stderrTTY: false, agentQuestionCapable: false },
        ask,
        loadDiscovery: () => ({
          schema: "roll.workspace-discovery-load/v1",
          registryRevision: 7,
          discoveryFactsSha256: "a".repeat(64),
          workspaces: [facts("fields")],
          diagnostics: [],
        }),
      },
    }));
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      error: { code: string; clarification: { schema: string; allowedActions: string[] } };
    };
    expect(payload.error.code).toBe("target_missing");
    expect(payload.error.clarification).toMatchObject({
      schema: "roll.workspace-clarification/v1",
      allowedActions: ["select_existing", "create_new"],
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("lets --no-input override a TTY and fails --interactive when no question capability exists", () => {
    const ask = vi.fn();
    const noInput = capture(() => deliveryCommand(["list", "--json", "--no-input"], {
      resolveTarget: () => ({ ok: false, code: "target_missing", candidates: [] }),
      interaction: {
        cwd: "/tmp",
        capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
        ask,
        loadDiscovery: () => ({
          schema: "roll.workspace-discovery-load/v1",
          registryRevision: 7,
          discoveryFactsSha256: "a".repeat(64),
          workspaces: [facts("fields")],
          diagnostics: [],
        }),
      },
    }));
    expect(JSON.parse(noInput.stderr).error.clarification.schema).toBe("roll.workspace-clarification/v1");
    expect(ask).not.toHaveBeenCalled();

    const resolveTarget = vi.fn();
    const unavailable = capture(() => deliveryCommand(["list", "--json", "--interactive"], {
      resolveTarget,
      interaction: {
        cwd: "/tmp",
        capabilities: { stdinTTY: false, stderrTTY: false, agentQuestionCapable: false },
        ask,
        loadDiscovery: () => {
          throw new Error("must not discover");
        },
      },
    }));
    expect(JSON.parse(unavailable.stderr).error.code).toBe("interaction_unavailable");
    expect(unavailable.stdout).toBe("");
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("preserves real bridge equivalence for --workspace/--ws on backlog and delivery", async () => {
    registerAll();
    const home = mkdtempSync(join(tmpdir(), "roll-ws030-alias-"));
    const rollHome = join(home, ".roll");
    const root = join(home, "fields");
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify(facts("fields").manifest)}\n`);
    writeFileSync(join(root, "backlog", "index.md"), "| Story | Description | Status |\n|---|---|---|\n| US-1 | fields story | 📋 Todo |\n");
    const registry = new WorkspaceRegistry({ rollHome });
    registry.register({ workspaceId: "fields", root });
    registry.activate("fields");
    const saved = {
      rollHome: process.env["ROLL_HOME"],
      rollLang: process.env["ROLL_LANG"],
      noColor: process.env["NO_COLOR"],
    };
    const previousCwd = process.cwd();
    process.env["ROLL_HOME"] = rollHome;
    process.env["ROLL_LANG"] = "en";
    process.env["NO_COLOR"] = "1";
    process.chdir(home);
    try {
      const backlogCanonical = await captureDispatch(["backlog", "--workspace", "fields"]);
      const backlogAlias = await captureDispatch(["backlog", "--ws", "fields"]);
      const deliveryCanonical = await captureDispatch(["delivery", "list", "--workspace", "fields", "--json"]);
      const deliveryAlias = await captureDispatch(["delivery", "list", "--ws", "fields", "--json"]);
      expect(backlogAlias).toEqual(backlogCanonical);
      expect(deliveryAlias).toEqual(deliveryCanonical);
      expect(backlogCanonical.status).toBe(0);
      expect(deliveryCanonical.status).toBe(0);
    } finally {
      process.chdir(previousCwd);
      if (saved.rollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = saved.rollHome;
      if (saved.rollLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = saved.rollLang;
      if (saved.noColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = saved.noColor;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("replaces a stale public selector after clarification for canonical and alias paths", async () => {
    registerAll();
    const home = mkdtempSync(join(tmpdir(), "roll-ws030-reselect-"));
    const rollHome = join(home, ".roll");
    const root = join(home, "fields");
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify(facts("fields").manifest)}\n`);
    writeFileSync(join(root, "backlog", "index.md"), "| Story | Description | Status |\n|---|---|---|\n| US-1 | fields story | 📋 Todo |\n");
    const registry = new WorkspaceRegistry({ rollHome });
    registry.register({ workspaceId: "fields", root });
    registry.activate("fields");
    const interaction = {
      cwd: home,
      capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
      ask: () => "1",
      loadDiscovery: () => loadWorkspaceDiscovery({ rollHome }),
    } as const;
    registerPorted("backlog", (args) => backlogCommand([...args], {
      resolveTarget: resolveBacklogCommandTarget,
      interaction,
    }));
    registerPorted("delivery", (args) => deliveryCommand([...args], { interaction }));
    const saved = {
      rollHome: process.env["ROLL_HOME"],
      rollLang: process.env["ROLL_LANG"],
      noColor: process.env["NO_COLOR"],
    };
    const previousCwd = process.cwd();
    process.env["ROLL_HOME"] = rollHome;
    process.env["ROLL_LANG"] = "en";
    process.env["NO_COLOR"] = "1";
    process.chdir(home);
    try {
      for (const selector of ["--workspace", "--ws"] as const) {
        const backlog = await captureDispatch(["backlog", selector, "does-not-exist", "--no-color"]);
        const delivery = await captureDispatch(["delivery", "list", selector, "does-not-exist", "--json"]);
        expect(backlog.status, `${selector} backlog`).toBe(0);
        expect(backlog.stderr, `${selector} backlog`).toBe("");
        expect(backlog.stdout, `${selector} backlog`).toContain("fields story");
        expect(delivery.status, `${selector} delivery`).toBe(0);
        expect(delivery.stderr, `${selector} delivery`).toBe("");
        expect(JSON.parse(delivery.stdout), `${selector} delivery`).toMatchObject({
          schema: "roll.delivery-list/v1",
          workspaces: [{ workspaceId: "fields" }],
        });
      }
    } finally {
      process.chdir(previousCwd);
      if (saved.rollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = saved.rollHome;
      if (saved.rollLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = saved.rollLang;
      if (saved.noColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = saved.noColor;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
