import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkspaceExecutionAuthorities, ToolRegistry, type ToolRegistryEventSink } from "@roll/core";
import { BashTool } from "@roll/infra";
import type { ExecOpts, MinimalFs, ToolDeps, ToolEvent, WorkspaceExecutionContextV1 } from "@roll/spec";
import { REPOSITORY_BINDING_V1, WORKSPACE_EXECUTION_CONTEXT_V1 } from "@roll/spec";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkspaceToolInvocationFactory } from "../src/runner/tool-context-invocation.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `roll-cli-tool-context-${tag}-`)));
  dirs.push(dir);
  return dir;
}

function workspace(root: string, repositories: Readonly<Record<string, { path: string; access: "read" | "write" }>>): WorkspaceExecutionContextV1 {
  const issueRoot = join(root, "issues", "US-WS-035");
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId: "roll", root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "explicit", evidence: [] },
    bindings: Object.keys(repositories).map((repoId) => ({
      schema: REPOSITORY_BINDING_V1,
      repoId,
      alias: repoId,
      remote: `git@github.com:example/${repoId}.git`,
      integrationBranch: "idea-074-workspace",
      provider: "github" as const,
      workflow: { branchPattern: "story/{storyId}", requiredChecks: [] },
    })),
    issue: {
      storyId: "US-WS-035",
      manifestPath: join(issueRoot, "manifest.json"),
      execution: {
        workspaceId: "roll",
        issueRoot,
        repositories: Object.fromEntries(Object.entries(repositories).map(([repoId, repository]) => [
          repoId,
          {
            repoId,
            alias: repoId,
            access: repository.access,
            requiredDelivery: repository.access === "write",
            ...(repository.access === "write" ? { noChangePolicy: "changes_required" as const } : {}),
            worktreePath: repository.path,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            commands: { test: [], integration: [] },
          },
        ])),
      },
    },
    authorities: deriveWorkspaceExecutionAuthorities(root),
  };
}

function harness(): {
  deps: ToolDeps;
  calls: Array<{ command: string; opts?: ExecOpts }>;
  events: ToolEvent[];
  sink: ToolRegistryEventSink;
} {
  const files = new Map<string, string>();
  const calls: Array<{ command: string; opts?: ExecOpts }> = [];
  const events: ToolEvent[] = [];
  const fs: MinimalFs = {
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    mkdir: async () => undefined,
  };
  return {
    calls,
    events,
    sink: { emit: (event) => events.push(event) },
    deps: {
      fs,
      now: () => 100,
      execFile: async (command, _args, opts) => {
        calls.push({ command, opts });
        return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
      },
      redact: (value) => value,
    },
  };
}

describe("US-WS-035 runner to adapter Workspace context", () => {
  it("freezes the cycle context and carries correlation through ToolRegistry into bash", async () => {
    const root = tmp("single");
    const repo = join(root, "issues", "US-WS-035", "product");
    const ambient = tmp("ambient");
    mkdirSync(repo, { recursive: true });
    const original = workspace(root, { product: { path: repo, access: "write" } });
    const requests = createWorkspaceToolInvocationFactory({ cycleId: "cycle-1", storyId: "US-WS-035", workspace: original });
    (original.issue!.execution.repositories.product as { worktreePath: string }).worktreePath = ambient;
    const h = harness();
    const registry = new ToolRegistry({
      deps: h.deps,
      events: h.sink,
      policyEngine: { resolve: () => ({ enabled: true, sandbox: {} }) },
    });
    registry.register(new BashTool());
    const originalCwd = process.cwd();

    let result;
    try {
      process.chdir(ambient);
      result = await registry.invoke("bash", requests.request({ invocationId: "inv-1", input: { command: "pwd" } }));
    } finally {
      process.chdir(originalCwd);
    }

    expect(result).toMatchObject({
      ok: true,
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "product" } },
    });
    expect(h.calls[0]?.opts?.cwd).toBe(repo);
    const invokeEvent = h.events.find((event) => event.type === "tool:invoke");
    const resultEvent = h.events.find((event) => event.type === "tool:result");
    expect(invokeEvent?.type === "tool:invoke" && Object.isFrozen(invokeEvent.invocation.context)).toBe(true);
    expect(invokeEvent?.type === "tool:invoke" && Object.isFrozen(invokeEvent.invocation.context?.issue?.execution.repositories)).toBe(true);
    expect(resultEvent?.type === "tool:result" && resultEvent.result.meta.correlation).toEqual({
      workspaceId: "roll",
      storyId: "US-WS-035",
      repoId: "product",
    });
    expect(JSON.stringify(h.events)).not.toContain(ambient);
  });

  it("keeps multi-repo selection fail-closed until the runner supplies repoId", async () => {
    const root = tmp("multi");
    const first = join(root, "issues", "US-WS-035", "first");
    const second = join(root, "issues", "US-WS-035", "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const requests = createWorkspaceToolInvocationFactory({
      cycleId: "cycle-2",
      storyId: "US-WS-035",
      workspace: workspace(root, { first: { path: first, access: "write" }, second: { path: second, access: "write" } }),
    });
    const h = harness();
    const registry = new ToolRegistry({ deps: h.deps, policyEngine: { resolve: () => ({ enabled: true, sandbox: {} }) } });
    registry.register(new BashTool());

    const missing = await registry.invoke("bash", requests.request({ invocationId: "inv-missing", input: { command: "pwd" } }));
    const selected = await registry.invoke("bash", requests.request({ invocationId: "inv-selected", input: { command: "pwd" }, repoId: "second" }));

    expect(missing).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(selected).toMatchObject({ ok: true, meta: { correlation: { repoId: "second" } } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.opts?.cwd).toBe(second);
  });

  it("rejects a runner context whose Story identity does not match the frozen Issue", () => {
    const root = tmp("mismatch");
    const repo = join(root, "issues", "US-WS-035", "product");
    mkdirSync(repo, { recursive: true });

    expect(() => createWorkspaceToolInvocationFactory({
      cycleId: "cycle-3",
      storyId: "US-OTHER",
      workspace: workspace(root, { product: { path: repo, access: "write" } }),
    })).toThrowError(/invalid_execution_context/u);
  });

  it("rejects a schema-valid context whose repository escapes the canonical Issue root", () => {
    const root = tmp("forged-repository");
    const repo = join(root, "issues", "US-WS-035", "product");
    const outside = tmp("forged-outside");
    mkdirSync(repo, { recursive: true });
    const forged = workspace(root, { product: { path: repo, access: "write" } });
    (forged.issue!.execution.repositories.product as { worktreePath: string }).worktreePath = outside;

    expect(() => createWorkspaceToolInvocationFactory({
      cycleId: "cycle-forged",
      storyId: "US-WS-035",
      workspace: forged,
    })).toThrowError(/invalid_execution_context/u);
  });
});
