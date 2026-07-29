import { join } from "node:path";
import { deriveWorkspaceExecutionAuthorities, ToolRegistry, type ToolRegistryEventSink } from "@roll/core";
import { BrowserTool } from "@roll/infra";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type MinimalFs,
  type ToolDeps,
  type ToolEvent,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { describe, expect, it } from "vitest";

const storyId = "US-WS-036";
const repoId = "repo-product";

function context(workspaceId: string): WorkspaceExecutionContextV1 {
  const root = `/workspaces/${workspaceId}`;
  const issueRoot = join(root, "issues", storyId);
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId, root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "explicit", evidence: [] },
    bindings: [{
      schema: REPOSITORY_BINDING_V1,
      repoId,
      alias: "product",
      remote: "git@github.com:example/product.git",
      integrationBranch: "idea-074-workspace",
      provider: "github",
      workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
    }],
    issue: {
      storyId,
      manifestPath: join(issueRoot, "manifest.json"),
      execution: {
        workspaceId,
        issueRoot,
        repositories: {
          [repoId]: {
            repoId,
            alias: "product",
            access: "write",
            requiredDelivery: true,
            noChangePolicy: "changes_required",
            worktreePath: join(issueRoot, "product"),
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            commands: { test: [], integration: [] },
          },
        },
      },
    },
    authorities: deriveWorkspaceExecutionAuthorities(root),
  };
}

function dependencies(): ToolDeps & { writes: Map<string, string> } {
  const writes = new Map<string, string>();
  const fs: MinimalFs = {
    readFile: async () => "",
    writeFile: async (path, data) => {
      writes.set(path, data);
    },
    mkdir: async () => undefined,
  };
  return {
    writes,
    fs,
    now: () => 100,
    execFile: async (_command, args) => {
      const url = args.at(-1) ?? "";
      if (url.includes("dependency-failure")) {
        return { exitCode: 1, stdout: "", stderr: "browser dependency unavailable", timedOut: false };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ finalUrl: url, statusCode: 200, png: `PNG:${url}` }),
        stderr: "",
        timedOut: false,
      };
    },
    redact: (value) => value,
  };
}

function authorityEventSink(): ToolRegistryEventSink & { byPath: Map<string, ToolEvent[]> } {
  const byPath = new Map<string, ToolEvent[]>();
  const invocationPaths = new Map<string, string>();
  return {
    byPath,
    emit(event) {
      const path = event.type === "tool:invoke"
        ? event.invocation.context?.authorities.events
        : invocationPaths.get(event.invocationId);
      if (path === undefined) throw new Error("tool event lacks Workspace event authority");
      if (event.type === "tool:invoke") invocationPaths.set(event.invocation.invocationId, path);
      byPath.set(path, [...(byPath.get(path) ?? []), event]);
    },
  };
}

describe("US-WS-036 Workspace tool evidence isolation", () => {
  it("keeps concurrent dumps, events, budgets, costs, and failures scoped to their frozen Workspace", async () => {
    const alpha = context("alpha");
    const beta = context("beta");
    const deps = dependencies();
    const events = authorityEventSink();
    const registry = new ToolRegistry({
      deps,
      events,
      policyEngine: {
        resolve: () => ({
          enabled: true,
          timeoutMs: 1000,
          maxInvocationsPerCycle: 1,
          sandbox: { headlessOnly: true, allowedOrigins: ["https://example.test"] },
        }),
      },
    });
    registry.register(new BrowserTool("browser.screenshot"));

    const [alphaResult, betaResult] = await Promise.all([
      registry.invoke("browser.screenshot", {
        invocationId: "alpha-shot",
        input: { url: "https://example.test/alpha" },
        caller: { cycleId: "cycle-alpha", storyId, agent: "codex" },
        context: alpha,
        repoId,
      }),
      registry.invoke("browser.screenshot", {
        invocationId: "beta-shot",
        input: { url: "https://example.test/beta" },
        caller: { cycleId: "cycle-beta", storyId, agent: "codex" },
        context: beta,
        repoId,
      }),
    ]);

    const alphaDump = join(alpha.authorities.toolDumps, "alpha-shot.png");
    const betaDump = join(beta.authorities.toolDumps, "beta-shot.png");
    expect(alphaResult).toMatchObject({ ok: true, output: { screenshotPath: alphaDump }, meta: { correlation: { workspaceId: "alpha", storyId, repoId } } });
    expect(betaResult).toMatchObject({ ok: true, output: { screenshotPath: betaDump }, meta: { correlation: { workspaceId: "beta", storyId, repoId } } });
    expect([...deps.writes.entries()]).toEqual([
      [alphaDump, "PNG:https://example.test/alpha"],
      [betaDump, "PNG:https://example.test/beta"],
    ]);
    expect(events.byPath.get(alpha.authorities.events)).toHaveLength(2);
    expect(events.byPath.get(beta.authorities.events)).toHaveLength(2);
    expect(events.byPath.get(alpha.authorities.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool:result", result: expect.objectContaining({ meta: expect.objectContaining({ correlation: { workspaceId: "alpha", storyId, repoId } }) }) }),
    ]));
    expect(events.byPath.get(beta.authorities.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool:result", result: expect.objectContaining({ meta: expect.objectContaining({ correlation: { workspaceId: "beta", storyId, repoId } }) }) }),
    ]));
    expect(registry.snapshotCosts()).toEqual([
      expect.objectContaining({ invocations: 1, failures: 0, correlation: { workspaceId: "alpha", storyId, repoId } }),
      expect.objectContaining({ invocations: 1, failures: 0, correlation: { workspaceId: "beta", storyId, repoId } }),
    ]);

    const failure = await registry.invoke("browser.screenshot", {
      invocationId: "beta-failure",
      input: { url: "https://example.test/dependency-failure" },
      caller: { cycleId: "cycle-beta-failure", storyId, agent: "codex" },
      context: beta,
      repoId,
    });

    expect(failure).toMatchObject({
      ok: false,
      error: { code: "adapter_error", message: expect.stringContaining("browser dependency unavailable") },
      meta: { correlation: { workspaceId: "beta", storyId, repoId } },
    });
    expect(deps.writes.has(join(beta.authorities.toolDumps, "beta-failure.png"))).toBe(false);
    expect([...deps.writes.keys()].some((path) => path.startsWith(alpha.workspace.root) && path.includes("beta"))).toBe(false);
  });
});
