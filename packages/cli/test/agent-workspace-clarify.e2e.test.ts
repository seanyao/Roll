import { describe, expect, it, vi } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY_BINDING_V1,
  REQUIREMENT_HINT_V1,
  WORKSPACE_INTENT_V1,
  WORKSPACE_MANIFEST_V1,
  type WorkspaceIntentV1,
  type WorkspaceLifecycle,
  type WorkspaceMatchCandidateV1,
} from "@roll/spec";
import type { WorkspaceDiscoveryFactsV1 } from "@roll/core";
import {
  beginAgentWorkspaceClarification,
  continueAgentWorkspaceClarification,
} from "../src/runner/workspace-clarification.js";
import { workspaceCommand } from "../src/commands/workspace.js";

const SHA = "a".repeat(64);
const evidenceDir = fileURLToPath(new URL("./fixtures/workspace/us-ws-029-terminal-evidence", import.meta.url));

function intent(operation: "read" | "mutation" = "mutation"): WorkspaceIntentV1 {
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

function facts(workspaceId: string, lifecycle: WorkspaceLifecycle): WorkspaceDiscoveryFactsV1 {
  const root = `/workspaces/${workspaceId}`;
  const repoId = workspaceId === "roll" ? "repo-0546df57f869" : "repo-5dbd8c5f9311";
  return {
    candidate: {
      workspaceId,
      root,
      canonicalRoot: root,
      manifestWorkspaceId: workspaceId,
      pathState: "valid",
      lifecycle,
    },
    manifest: {
      schema: WORKSPACE_MANIFEST_V1,
      workspaceId,
      displayName: `${workspaceId} delivery`,
      requirements: [{ provider: "jira", ref: workspaceId === "fields" ? "APE-234" : "IDEA-074" }],
      repositories: [{
        schema: REPOSITORY_BINDING_V1,
        repoId,
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

function candidate(workspaceId: string, lifecycle: WorkspaceLifecycle): WorkspaceMatchCandidateV1 {
  return {
    workspaceId,
    root: `/workspaces/${workspaceId}`,
    lifecycle,
    evidence: workspaceId === "fields"
      ? [{
          kind: "requirement_source_exact",
          value: "jira:APE-234",
          hard: true,
          score: 100,
          source: "jira:APE-234",
          provenance: "deterministic_extraction",
          detail: "exact requirement source",
        }]
      : [],
    hardMatch: workspaceId === "fields",
    score: workspaceId === "fields" ? 100 : 0,
  };
}

function snapshotAuthorityTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (absolutePath: string, relativePath: string): void => {
    const stat = lstatSync(absolutePath);
    if (stat.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      for (const name of readdirSync(absolutePath).sort()) {
        walk(join(absolutePath, name), relativePath === "." ? name : `${relativePath}/${name}`);
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push(`symlink:${relativePath}:${readlinkSync(absolutePath)}`);
      return;
    }
    entries.push(`file:${relativePath}:${readFileSync(absolutePath).toString("base64")}`);
  };
  walk(root, ".");
  return entries;
}

function snapshotDurableAuthorityTree(root: string): readonly string[] {
  return snapshotAuthorityTree(root).filter((entry) => (
    entry !== "directory:.roll/cache" &&
    !entry.startsWith("directory:.roll/cache/") &&
    !entry.startsWith("file:.roll/cache/")
  ));
}

function isolatedAuthorityFixture(): {
  readonly home: string;
  readonly rollHome: string;
  readonly workspaceRoot: (workspaceId: string) => string;
  readonly facts: (workspaceId: string, lifecycle: WorkspaceLifecycle) => WorkspaceDiscoveryFactsV1;
  readonly candidate: (workspaceId: string, lifecycle: WorkspaceLifecycle) => WorkspaceMatchCandidateV1;
  readonly cleanup: () => void;
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws029-zero-mutation-")));
  const rollHome = join(home, ".roll");
  const workspaceRoot = (workspaceId: string): string => join(home, "workspaces", workspaceId);
  mkdirSync(join(rollHome, "workspace-create"), { recursive: true });
  for (const workspaceId of ["roll", "fields"] as const) {
    const root = workspaceRoot(workspaceId);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify(facts(workspaceId, workspaceId === "roll" ? "active" : "registered").manifest, null, 2)}\n`, "utf8");
  }
  writeFileSync(join(rollHome, "workspaces.json"), `${JSON.stringify({
    schema: "roll.workspace-registry/v1",
    revision: 7,
    entries: ["fields", "roll"].map((workspaceId) => ({
      workspaceId,
      root: workspaceRoot(workspaceId),
      canonicalRoot: workspaceRoot(workspaceId),
      pathState: "valid",
    })),
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(rollHome, "workspace-events.ndjson"), [
    JSON.stringify({ schema: "roll.workspace-event/v1", type: "workspace:registered", workspaceId: "roll", ts: 1 }),
    JSON.stringify({ schema: "roll.workspace-event/v1", type: "workspace:activated", workspaceId: "roll", ts: 2 }),
    JSON.stringify({ schema: "roll.workspace-event/v1", type: "workspace:registered", workspaceId: "fields", ts: 3 }),
    "",
  ].join("\n"), "utf8");
  return {
    home,
    rollHome,
    workspaceRoot,
    facts: (workspaceId, lifecycle) => {
      const value = facts(workspaceId, lifecycle);
      const root = workspaceRoot(workspaceId);
      return {
        ...value,
        candidate: { ...value.candidate, root, canonicalRoot: root },
      };
    },
    candidate: (workspaceId, lifecycle) => ({
      ...candidate(workspaceId, lifecycle),
      root: workspaceRoot(workspaceId),
    }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe("US-WS-029 agent Workspace clarification host", () => {
  it("routes the real workspace handoff command through clarification, then emits paired context after selection", async () => {
    const fixture = isolatedAuthorityFixture();
    const originalCwd = process.cwd();
    const output: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    vi.stubEnv("HOME", fixture.home);
    vi.stubEnv("ROLL_HOME", fixture.rollHome);
    vi.stubEnv("ROLL_WORKSPACE", "");
    process.stdout.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      process.chdir(fixture.home);
      const before = snapshotDurableAuthorityTree(fixture.home);
      const stopped = await workspaceCommand([
        "handoff",
        "--skill", "roll-design",
        "--operation", "design",
        "--requirement", "review the complete workspace feature",
        "--json",
      ]);
      expect(stopped).toBe(0);
      const clarification = JSON.parse(output.join("")) as {
        route: string;
        stopped: boolean;
        question: { handoff: { allowedActions: string[]; candidates: Array<{ workspaceId: string }> } };
      };
      expect(clarification).toMatchObject({ route: "workspace_target", stopped: true });
      expect(
        clarification.question.handoff.allowedActions,
        JSON.stringify(clarification.question.handoff, null, 2),
      ).toEqual(["select_existing", "create_new"]);
      expect(clarification.question.handoff.candidates.map((entry) => entry.workspaceId)).toEqual(["fields", "roll"]);
      expect(snapshotDurableAuthorityTree(fixture.home)).toEqual(before);

      output.length = 0;
      const selected = await workspaceCommand([
        "handoff",
        "--skill", "roll-design",
        "--operation", "design",
        "--requirement", "review the complete workspace feature",
        "--workspace", "roll",
        "--json",
      ]);
      expect(selected).toBe(0);
      const resolved = JSON.parse(output.join("")) as {
        route: string;
        promptContext: string;
        environmentContext: string;
        context: { workspace: { workspaceId: string } };
      };
      expect(resolved).toMatchObject({ route: "context", context: { workspace: { workspaceId: "roll" } } });
      expect(resolved.promptContext).toContain("[Roll Workspace skill handoff]");
      expect(JSON.parse(resolved.environmentContext)).toEqual(resolved.context);
      expect(snapshotDurableAuthorityTree(fixture.home)).toEqual(before);
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
      fixture.cleanup();
    }
  });

  it("keeps isolated HOME, ROLL_HOME, registry, events, manifests, and journals byte-identical", () => {
    const fixture = isolatedAuthorityFixture();
    vi.stubEnv("HOME", fixture.home);
    vi.stubEnv("ROLL_HOME", fixture.rollHome);
    try {
      const before = snapshotAuthorityTree(fixture.home);
      const question = beginAgentWorkspaceClarification({
        intent: intent(),
        reason: "requirement_match_required",
        candidates: [fixture.candidate("roll", "active")],
        diagnostics: [],
        discovery: {
          registryRevision: 7,
          discoveryFactsSha256: SHA,
          workspaces: [fixture.facts("roll", "active"), fixture.facts("fields", "registered")],
        },
      });
      expect(snapshotAuthorityTree(fixture.home)).toEqual(before);

      const selected = continueAgentWorkspaceClarification({
        handoff: question.handoff,
        answer: { action: "select_existing", workspaceId: "roll" },
        currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
        rerunResolver: (selector) => ({ selector, status: "read_only_recheck" }),
      });
      expect(selected).toMatchObject({ kind: "resolution_retried", stopped: true });
      expect(snapshotAuthorityTree(fixture.home)).toEqual(before);

      const created = continueAgentWorkspaceClarification({
        handoff: question.handoff,
        answer: { action: "create_new", workspaceId: "ws-new" },
        currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
        rerunResolver: () => ({ unexpected: true }),
      });
      expect(created).toMatchObject({ kind: "collect_create_input", stopped: true, applyAuthorized: false });
      expect(snapshotAuthorityTree(fixture.home)).toEqual(before);

      const repairQuestion = beginAgentWorkspaceClarification({
        intent: intent("mutation"),
        reason: "workspace_discovery_incomplete",
        candidates: [],
        diagnostics: [{
          workspaceId: "fields",
          root: fixture.workspaceRoot("fields"),
          code: "invalid_workspace_manifest",
          authorityPath: `${fixture.workspaceRoot("fields")}/workspace.yaml`,
          message: "invalid manifest",
        }],
        discovery: { registryRevision: 7, discoveryFactsSha256: SHA, workspaces: [] },
      });
      const repaired = continueAgentWorkspaceClarification({
        handoff: repairQuestion.handoff,
        answer: { action: "repair_discovery" },
        currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
        rerunResolver: () => ({ unexpected: true }),
      });
      expect(repaired).toMatchObject({ kind: "repair_actions", stopped: true });
      expect(snapshotAuthorityTree(fixture.home)).toEqual(before);

      const stale = continueAgentWorkspaceClarification({
        handoff: question.handoff,
        answer: { action: "select_existing", workspaceId: "roll" },
        currentDiscovery: { registryRevision: 8, discoveryFactsSha256: "b".repeat(64) },
        rerunResolver: () => ({ unexpected: true }),
      });
      expect(stale).toEqual({ kind: "reload_required", stopped: true, code: "invalid_workspace_clarification" });
      expect(snapshotAuthorityTree(fixture.home)).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
      fixture.cleanup();
    }
  });

  it("deposits the single-active requirement-mismatch select/create stopping transcript", () => {
    const question = beginAgentWorkspaceClarification({
      intent: intent(),
      reason: "requirement_match_required",
      candidates: [candidate("roll", "active")],
      diagnostics: [],
      discovery: { registryRevision: 7, discoveryFactsSha256: SHA, workspaces: [facts("roll", "active")] },
    });
    const selected = continueAgentWorkspaceClarification({
      handoff: question.handoff,
      answer: { action: "select_existing", workspaceId: "roll" },
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
      rerunResolver: (selector) => ({ selector, status: "explicit_recheck_required" }),
    });
    const created = continueAgentWorkspaceClarification({
      handoff: question.handoff,
      answer: { action: "create_new", workspaceId: "ws-ape-234" },
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
      rerunResolver: () => ({ unexpected: true }),
    });
    const transcript = [
      "US-WS-029 normalized agent terminal transcript",
      "Generated from the public agent Workspace clarification host.",
      "",
      "$ agent -> roll-.clarify workspace_target",
      question.prompt,
      "",
      "> select_existing roll",
      JSON.stringify(selected, null, 2),
      "",
      "> create_new ws-ape-234",
      JSON.stringify(created, null, 2),
      "",
    ].join("\n");

    expect(question.handoff.allowedActions).toEqual(["select_existing", "create_new"]);
    expect(selected).toMatchObject({ kind: "resolution_retried", stopped: true, canonicalSelector: "--workspace roll" });
    expect(created).toMatchObject({
      kind: "collect_create_input",
      stopped: true,
      previewCommand: "roll workspace create <ID> --config <path> --check",
      applyAuthorized: false,
    });
    expect(readFileSync(`${evidenceDir}/transcript.txt`, "utf8")).toBe(transcript);
    expect(JSON.parse(readFileSync(`${evidenceDir}/evidence.json`, "utf8"))).toMatchObject({
      storyId: "US-WS-029",
      physical: false,
      taken: false,
      reason: "headless_terminal_capture_unavailable",
    });
    expect(readFileSync(`${evidenceDir}/capture-skip.txt`, "utf8")).toContain("No PNG was generated");
  });

  it.each(["registered", "paused"] as const)("stops on a %s exact match without activating or mutating", (lifecycle) => {
    const question = beginAgentWorkspaceClarification({
      intent: intent(),
      reason: "workspace_activation_required",
      candidates: [candidate("fields", lifecycle)],
      diagnostics: [],
      discovery: {
        registryRevision: 7,
        discoveryFactsSha256: SHA,
        workspaces: [facts("fields", lifecycle), facts("roll", "active")],
      },
    });

    expect(question).toMatchObject({ route: "workspace_target", stopped: true });
    expect(question.handoff.allowedActions).toEqual(["select_existing"]);
    expect(question.prompt).toContain("APE-234");
    expect(question.prompt).toContain(`fields (${lifecycle})`);
    expect(question.prompt).toContain("requirement_source_exact");
    expect(question.prompt.match(/\?/gu)).toHaveLength(1);
    expect(question.prompt).not.toContain("planning / building");
  });

  it("reruns the resolver with a canonical explicit selector and does nothing else", () => {
    const question = beginAgentWorkspaceClarification({
      intent: intent(),
      reason: "workspace_activation_required",
      candidates: [candidate("fields", "registered")],
      diagnostics: [],
      discovery: {
        registryRevision: 7,
        discoveryFactsSha256: SHA,
        workspaces: [facts("fields", "registered"), facts("roll", "active")],
      },
    });
    const rerunResolver = vi.fn((selector: { readonly kind: "id"; readonly workspaceId: string }) => ({
      ok: false as const,
      code: "workspace_activation_required" as const,
      selector,
    }));

    expect(continueAgentWorkspaceClarification({
      handoff: question.handoff,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
      rerunResolver,
    })).toEqual({
      kind: "resolution_retried",
      stopped: true,
      canonicalSelector: "--workspace fields",
      result: {
        ok: false,
        code: "workspace_activation_required",
        selector: { kind: "id", workspaceId: "fields" },
      },
    });
    expect(rerunResolver).toHaveBeenCalledOnce();
  });

  it("turns create intent into ID/config collection and an authorization-free check preview", () => {
    const question = beginAgentWorkspaceClarification({
      intent: intent(),
      reason: "create_required",
      candidates: [],
      diagnostics: [],
      discovery: { registryRevision: 7, discoveryFactsSha256: SHA, workspaces: [] },
    });
    const rerunResolver = vi.fn();
    const next = continueAgentWorkspaceClarification({
      handoff: question.handoff,
      answer: { action: "create_new", workspaceId: "ws-ape-234" },
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
      rerunResolver,
    });

    expect(next).toEqual({
      kind: "collect_create_input",
      stopped: true,
      requestedWorkspaceId: "ws-ape-234",
      previewCommand: "roll workspace create <ID> --config <path> --check",
      applyAuthorized: false,
    });
    expect(JSON.stringify(next)).not.toContain("--authorization");
    expect(rerunResolver).not.toHaveBeenCalled();
  });

  it("offers only repair for mutation discovery-incomplete and never executes it", () => {
    const diagnostic = {
      workspaceId: "fields",
      root: "/workspaces/fields",
      code: "invalid_workspace_manifest" as const,
      authorityPath: "/workspaces/fields/workspace.yaml",
      message: "invalid manifest",
    };
    const question = beginAgentWorkspaceClarification({
      intent: intent("mutation"),
      reason: "workspace_discovery_incomplete",
      candidates: [],
      diagnostics: [diagnostic],
      discovery: { registryRevision: 7, discoveryFactsSha256: SHA, workspaces: [] },
    });
    const rerunResolver = vi.fn();

    expect(question.handoff.allowedActions).toEqual(["repair_discovery"]);
    expect(continueAgentWorkspaceClarification({
      handoff: question.handoff,
      answer: { action: "repair_discovery" },
      currentDiscovery: { registryRevision: 7, discoveryFactsSha256: SHA },
      rerunResolver,
    })).toEqual({
      kind: "repair_actions",
      stopped: true,
      commands: ["roll workspace doctor fields --json"],
    });
    expect(rerunResolver).not.toHaveBeenCalled();
  });

  it("stops and reloads stale answers without rerunning or mutating", () => {
    const question = beginAgentWorkspaceClarification({
      intent: intent(),
      reason: "workspace_activation_required",
      candidates: [candidate("fields", "registered")],
      diagnostics: [],
      discovery: { registryRevision: 7, discoveryFactsSha256: SHA, workspaces: [facts("fields", "registered")] },
    });
    const rerunResolver = vi.fn();
    expect(continueAgentWorkspaceClarification({
      handoff: question.handoff,
      answer: { action: "select_existing", workspaceId: "fields" },
      currentDiscovery: { registryRevision: 8, discoveryFactsSha256: "b".repeat(64) },
      rerunResolver,
    })).toEqual({
      kind: "reload_required",
      stopped: true,
      code: "invalid_workspace_clarification",
    });
    expect(rerunResolver).not.toHaveBeenCalled();
  });
});
