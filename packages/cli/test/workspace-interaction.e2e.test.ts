import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildWorkspaceClarificationHandoff, type WorkspaceDiscoveryFactsV1 } from "@roll/core";
import {
  REPOSITORY_BINDING_V1,
  REQUIREMENT_HINT_V1,
  WORKSPACE_INTENT_V1,
  WORKSPACE_MANIFEST_V1,
  type WorkspaceClarificationHandoffV1,
  type WorkspaceIntentV1,
  type WorkspaceMatchCandidateV1,
} from "@roll/spec";
import {
  answerDirectWorkspaceClarification,
  parseWorkspaceInteractionArgs,
  renderDirectWorkspaceClarificationPrompt,
  resolveWorkspaceTargetInteraction,
  type WorkspaceInteractionCapabilities,
} from "../src/lib/workspace-interaction.js";
import { backlogCommand } from "../src/commands/backlog.js";
import type { BacklogTargetDecision } from "../src/commands/backlog-target.js";

const noCapability: WorkspaceInteractionCapabilities = {
  stdinTTY: false,
  stderrTTY: false,
  agentQuestionCapable: false,
};

function intent(operation: "read" | "mutation" = "read"): WorkspaceIntentV1 {
  return {
    schema: WORKSPACE_INTENT_V1,
    operation,
    interaction: "interactive",
    scope: operation === "read" ? "workspace_required_read" : "workspace_required_mutation",
    cwd: "/tmp",
    requirement: {
      schema: REQUIREMENT_HINT_V1,
      sources: [{ key: { provider: "jira", ref: "APE-234" }, provenance: "deterministic_extraction" }],
      storyIds: [],
      repositoryRemotes: [],
      paths: [],
    },
  };
}

function facts(workspaceId: string): WorkspaceDiscoveryFactsV1 {
  const root = `/workspaces/${workspaceId}`;
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
      requirements: workspaceId === "fields" ? [{ provider: "jira", ref: "APE-234" }] : [],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId: `repo-${workspaceId}`,
        alias: "product",
        remote: `https://example.test/${workspaceId}/product.git`,
        integrationBranch: "main",
        provider: "generic",
        workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
      }],
    },
    issues: [],
  };
}

function candidate(workspaceId: string): WorkspaceMatchCandidateV1 {
  return {
    workspaceId,
    root: `/workspaces/${workspaceId}`,
    lifecycle: "active",
    evidence: workspaceId === "fields" ? [{
      kind: "requirement_source_exact",
      value: "jira:APE-234",
      hard: true,
      score: 100,
      source: "jira:APE-234",
      provenance: "deterministic_extraction",
      detail: "exact requirement source",
    }] : [],
    hardMatch: workspaceId === "fields",
    score: workspaceId === "fields" ? 100 : 0,
  };
}

function handoff(): WorkspaceClarificationHandoffV1 {
  return buildWorkspaceClarificationHandoff({
    intent: intent(),
    reason: "requirement_match_required",
    candidates: [candidate("fields"), candidate("roll")],
    diagnostics: [],
    facts: [facts("fields"), facts("roll")],
    registryRevision: 7,
    discoveryFactsSha256: "a".repeat(64),
  });
}

function repairOnlyHandoff(): WorkspaceClarificationHandoffV1 {
  const diagnostic = {
    workspaceId: "fields",
    root: "/workspaces/fields",
    code: "invalid_issue_manifest" as const,
    authorityPath: "/workspaces/fields/issues/US-1/manifest.json",
    message: "Issue authority is invalid",
  };
  return buildWorkspaceClarificationHandoff({
    intent: intent("mutation"),
    reason: "workspace_discovery_incomplete",
    candidates: [candidate("fields")],
    diagnostics: [diagnostic],
    facts: [facts("fields")],
    registryRevision: 7,
    discoveryFactsSha256: "a".repeat(64),
  });
}

describe("US-WS-030 direct Workspace interaction capability", () => {
  it("keeps interaction capability independent from JSON format", () => {
    expect(parseWorkspaceInteractionArgs(["--json"], {
      stdinTTY: true,
      stderrTTY: true,
      agentQuestionCapable: false,
    })).toEqual({ ok: true, mode: "interactive", args: ["--json"] });
    expect(parseWorkspaceInteractionArgs(["--json", "--no-input"], {
      stdinTTY: true,
      stderrTTY: true,
      agentQuestionCapable: false,
    })).toEqual({ ok: true, mode: "non_interactive", args: ["--json"] });
    expect(parseWorkspaceInteractionArgs(["--json"], noCapability)).toEqual({
      ok: true,
      mode: "non_interactive",
      args: ["--json"],
    });
  });

  it("requires a real direct TTY pair or an agent question capability when forced", () => {
    expect(parseWorkspaceInteractionArgs(["--interactive"], noCapability)).toEqual({
      ok: false,
      code: "interaction_unavailable",
      args: [],
    });
    expect(parseWorkspaceInteractionArgs(["--interactive"], {
      ...noCapability,
      agentQuestionCapable: true,
    })).toEqual({ ok: true, mode: "interactive", args: [] });
    expect(parseWorkspaceInteractionArgs(["--interactive"], {
      ...noCapability,
      stdinTTY: true,
      stderrTTY: true,
    })).toEqual({ ok: true, mode: "interactive", args: [] });
  });

  it("lets --no-input force non-interactive handling without changing other argv bytes", () => {
    expect(parseWorkspaceInteractionArgs([
      "list",
      "--no-input",
      "--json",
      "--workspace",
      "roll",
    ], {
      stdinTTY: true,
      stderrTTY: true,
      agentQuestionCapable: true,
    })).toEqual({
      ok: true,
      mode: "non_interactive",
      args: ["list", "--json", "--workspace", "roll"],
    });
  });
});

describe("US-WS-030 direct Workspace clarification", () => {
  it("renders the shared handoff facts without claiming that the CLI loaded a skill", () => {
    const prompt = renderDirectWorkspaceClarificationPrompt(handoff());
    expect(prompt).toContain("jira:APE-234");
    expect(prompt).toContain("fields delivery (active)");
    expect(prompt).toContain("requirement_source_exact jira:APE-234");
    expect(prompt).toContain("roll delivery (active)");
    expect(prompt).toContain("create a new Workspace");
    expect(prompt).not.toMatch(/load(?:ed|ing)? .*skill/i);
  });

  it("turns a selection into an explicit selector and reruns the resolver", () => {
    const rerunResolver = vi.fn((selector: string) => ({ ok: true, selector }));
    expect(answerDirectWorkspaceClarification({
      handoff: handoff(),
      answer: "1",
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: "a".repeat(64) },
      rerunResolver,
    })).toEqual({
      kind: "selected",
      workspaceId: "fields",
      canonicalSelector: "--workspace fields",
      result: { ok: true, selector: "fields" },
    });
    expect(rerunResolver).toHaveBeenCalledExactlyOnceWith("fields");
  });

  it("stops the original family on create and never authorizes apply", () => {
    const rerunResolver = vi.fn();
    expect(answerDirectWorkspaceClarification({
      handoff: handoff(),
      answer: "create",
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: "a".repeat(64) },
      rerunResolver,
    })).toEqual({
      kind: "create",
      nextAction: "roll workspace create <ID> --config <path> --check",
      applyAuthorized: false,
    });
    expect(rerunResolver).not.toHaveBeenCalled();
  });

  it.each([null, "cancel", "q"])("cancels on %s without resolving a target", (answer) => {
    const rerunResolver = vi.fn();
    expect(answerDirectWorkspaceClarification({
      handoff: handoff(),
      answer,
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: "a".repeat(64) },
      rerunResolver,
    })).toEqual({ kind: "cancelled", code: "workspace_clarification_cancelled" });
    expect(rerunResolver).not.toHaveBeenCalled();
  });

  it("rejects stale answers before rerunning resolution", () => {
    const rerunResolver = vi.fn();
    expect(answerDirectWorkspaceClarification({
      handoff: handoff(),
      answer: "fields",
      currentDiscovery: { registryRevision: 8, discoveryFactsSha256: "b".repeat(64) },
      rerunResolver,
    })).toEqual({ kind: "invalid", code: "invalid_workspace_clarification", reload: true });
    expect(rerunResolver).not.toHaveBeenCalled();
  });

  it("shows mutation discovery candidates as non-selectable facts when only repair is allowed", () => {
    const handoff = repairOnlyHandoff();
    const prompt = renderDirectWorkspaceClarificationPrompt(handoff);
    expect(handoff.allowedActions).toEqual(["repair_discovery"]);
    expect(prompt).toContain("[not selectable]");
    expect(prompt).toContain("repair) show canonical Workspace repair commands");
    expect(prompt).not.toContain("1) fields delivery");
    expect(prompt).not.toContain("Selection:");

    for (const answer of ["1", "fields"]) {
      const rerunResolver = vi.fn();
      expect(answerDirectWorkspaceClarification({
        handoff,
        answer,
        currentDiscovery: { registryRevision: 7, discoveryFactsSha256: "a".repeat(64) },
        rerunResolver,
      })).toEqual({ kind: "invalid", code: "invalid_workspace_clarification", reload: true });
      expect(rerunResolver).not.toHaveBeenCalled();
    }
  });

  it("replaces the pre-sentinel selector and preserves post-sentinel payload bytes", () => {
    const resolveTarget = vi.fn((args: readonly string[]) => {
      const sentinel = args.indexOf("--");
      const prefix = sentinel < 0 ? args : args.slice(0, sentinel);
      const selectorIndex = prefix.indexOf("--workspace");
      return prefix[selectorIndex + 1] === "fields"
        ? { ok: true as const }
        : { ok: false as const, code: "target_missing" };
    });
    const result = resolveWorkspaceTargetInteraction({
      args: ["show", "US-1", "--workspace", "does-not-exist", "--", "--workspace", "literal"],
      operation: "read",
      resolveTarget,
      host: {
        cwd: "/tmp",
        capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
        ask: () => "1",
        loadDiscovery: () => ({
          schema: "roll.workspace-discovery-load/v1",
          registryRevision: 7,
          discoveryFactsSha256: "a".repeat(64),
          workspaces: [facts("fields")],
          diagnostics: [],
        }),
      },
    });

    expect(result).toMatchObject({
      kind: "resolved",
      args: ["show", "US-1", "--workspace", "fields", "--", "--workspace", "literal"],
      result: { ok: true },
    });
    expect(resolveTarget).toHaveBeenNthCalledWith(
      2,
      ["show", "US-1", "--workspace", "fields", "--", "--workspace", "literal"],
      "read",
    );
  });
});

function backlogTarget(root: string, workspaceId: string): BacklogTargetDecision {
  return {
    ok: true,
    workspaceId,
    workspaceRoot: root,
    canonicalRoot: root,
    backlogPath: join(root, "backlog", "index.md"),
    storyRoot: join(root, "backlog"),
    runtimeRoot: join(root, "runtime"),
    configPath: join(root, "runtime", "backlog-sync.yaml"),
  };
}

describe("US-WS-030 backlog text interaction", () => {
  it("selects an existing Workspace through an in-process explicit selector rerun", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-ws030-backlog-"));
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(join(root, "backlog", "index.md"), "| Story | Description | Status |\n|---|---|---|\n| US-1 | fields story | 📋 Todo |\n");
    const prompt: string[] = [];
    const resolveTarget = vi.fn((args: readonly string[]): BacklogTargetDecision =>
      args.includes("--workspace") ? backlogTarget(root, "fields") : {
        ok: false,
        code: "target_missing",
        candidates: [],
      }
    );
    let stdout = "";
    let stderr = "";
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error deterministic command capture
    process.stdout.write = (chunk: string | Uint8Array): boolean => ((stdout += String(chunk)), true);
    // @ts-expect-error deterministic command capture
    process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
    try {
      expect(backlogCommand(["--interactive"], {
        resolveTarget,
        interaction: {
          cwd: "/tmp",
          capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
          ask: (question) => (prompt.push(question), "1"),
          loadDiscovery: () => ({
            schema: "roll.workspace-discovery-load/v1",
            registryRevision: 7,
            discoveryFactsSha256: "a".repeat(64),
            workspaces: [facts("fields"), facts("roll")],
            diagnostics: [],
          }),
        },
      })).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      rmSync(root, { recursive: true, force: true });
    }
    expect(prompt).toHaveLength(1);
    expect(prompt[0]).toContain("fields delivery");
    expect(stdout).toContain("fields story");
    expect(stderr).toBe("");
    expect(resolveTarget).toHaveBeenNthCalledWith(1, [], "read");
    expect(resolveTarget).toHaveBeenNthCalledWith(2, ["--workspace", "fields"], "read");
  });

  it.each([
    ["create", "create_required", "roll workspace create <ID> --config <path> --check"],
    ["cancel", "workspace_clarification_cancelled", undefined],
    [null, "workspace_clarification_cancelled", undefined],
  ] as const)("stops without running backlog when the answer is %s", (answer, code, nextAction) => {
    const resolveTarget = vi.fn((): BacklogTargetDecision => ({
      ok: false,
      code: "target_missing",
      candidates: [],
    }));
    let stderr = "";
    const originalErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error deterministic command capture
    process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
    try {
      expect(backlogCommand(["--interactive"], {
        resolveTarget,
        interaction: {
          cwd: "/tmp",
          capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
          ask: () => answer,
          loadDiscovery: () => ({
            schema: "roll.workspace-discovery-load/v1",
            registryRevision: 7,
            discoveryFactsSha256: "a".repeat(64),
            workspaces: [facts("fields"), facts("roll")],
            diagnostics: [],
          }),
        },
      })).toBe(1);
    } finally {
      process.stderr.write = originalErr;
    }
    expect(stderr).toContain(code);
    if (nextAction !== undefined) expect(stderr).toContain(nextAction);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it("fails closed when discovery changes while the prompt is open", () => {
    const resolveTarget = vi.fn((): BacklogTargetDecision => ({
      ok: false,
      code: "target_missing",
      candidates: [],
    }));
    let loadCount = 0;
    let stderr = "";
    const originalErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error deterministic command capture
    process.stderr.write = (chunk: string | Uint8Array): boolean => ((stderr += String(chunk)), true);
    try {
      expect(backlogCommand(["--interactive"], {
        resolveTarget,
        interaction: {
          cwd: "/tmp",
          capabilities: { stdinTTY: true, stderrTTY: true, agentQuestionCapable: false },
          ask: () => "fields",
          loadDiscovery: () => {
            loadCount += 1;
            return {
              schema: "roll.workspace-discovery-load/v1",
              registryRevision: loadCount,
              discoveryFactsSha256: String(loadCount).repeat(64),
              workspaces: [facts("fields"), facts("roll")],
              diagnostics: [],
            };
          },
        },
      })).toBe(1);
    } finally {
      process.stderr.write = originalErr;
    }
    expect(stderr).toContain("invalid_workspace_clarification");
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });
});
