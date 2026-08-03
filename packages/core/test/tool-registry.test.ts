import type {
  MinimalFs,
  ToolDeclaration,
  ToolDeps,
  ToolEvent,
  ToolId,
  ToolInvocation,
  ToolPolicy,
  ToolRequirementResolution,
  ToolResult,
  WorkspaceExecutionContextV1,
} from "@roll/spec";
import { WORKSPACE_EXECUTION_CONTEXT_V1 } from "@roll/spec";
import { describe, expect, it } from "vitest";
import { ToolRegistry, type Tool, type ToolRegistryEventSink, type ToolRegistryPolicyEngine } from "../src/index.js";

const TOOL_ID = "test.echo" as ToolId;

const declaration: ToolDeclaration = {
  id: TOOL_ID,
  kind: "bash",
  title: "Echo",
  defaults: {
    enabled: true,
    timeoutMs: 1000,
    maxInvocationsPerCycle: 10,
  },
};

function deps(redact: ToolDeps["redact"] = (value) => value): ToolDeps {
  const fs: MinimalFs = {
    readFile: async () => "",
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
  return {
    fs,
    now: () => 100,
    execFile: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    redact,
  };
}

function policyEngine(policy: Partial<ToolPolicy> = {}): ToolRegistryPolicyEngine {
  return {
    resolve: async (_toolId, defaults) => ({
      enabled: defaults.enabled ?? true,
      timeoutMs: defaults.timeoutMs,
      retry: defaults.retry,
      sandbox: defaults.sandbox,
      maxInvocationsPerCycle: defaults.maxInvocationsPerCycle,
      ...policy,
    }),
  };
}

function resolution(status: ToolRequirementResolution["status"], detail = status): ToolRequirementResolution {
  return { requirement: { kind: "executable", name: "git", optional: false }, status, detail };
}

function sink(): ToolRegistryEventSink & { types: string[]; events: ToolEvent[] } {
  return {
    types: [],
    events: [],
    emit(event) {
      this.types.push(event.type);
      this.events.push(event);
    },
  };
}

function request(input: unknown = "ok") {
  return {
    invocationId: "inv-1",
    input,
    caller: { cycleId: "cycle-1", storyId: "US-TOOL-002", agent: "codex" },
  };
}

function workspaceContext(workspaceId = "roll"): WorkspaceExecutionContextV1 {
  const root = `/ws/${workspaceId}`;
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: { workspaceId, root, canonicalRoot: root, lifecycle: "active" },
    resolution: { source: "explicit", evidence: [] },
    bindings: [],
    issue: {
      storyId: "US-WS-035",
      manifestPath: `${root}/issues/US-WS-035/manifest.json`,
      execution: {
        workspaceId,
        issueRoot: `${root}/issues/US-WS-035`,
        repositories: {
          "repo-product": {
            repoId: "repo-product",
            alias: "product",
            access: "write",
            requiredDelivery: true,
            noChangePolicy: "changes_required",
            worktreePath: `${root}/issues/US-WS-035/product`,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            commands: { test: [], integration: [] },
          },
        },
      },
    },
    authorities: {
      backlog: `${root}/backlog`,
      features: `${root}/features`,
      design: `${root}/design`,
      requirements: `${root}/requirements`,
      policy: `${root}/policy`,
      evidence: `${root}/evidence`,
      toolDumps: `${root}/tool-dumps`,
      events: `${root}/events`,
      runtime: `${root}/runtime`,
      locks: `${root}/locks`,
    },
  };
}

function cliRequest(input: unknown = "ok") {
  return {
    invocationId: "inv-cli",
    input,
    caller: { storyId: "US-TOOL-011", agent: "codex" },
  };
}

function okResult(invocation: ToolInvocation<unknown>, output: unknown = invocation.input): ToolResult<unknown> {
  return {
    ok: true,
    output,
    meta: {
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      caller: invocation.caller,
      startedAt: 100,
      endedAt: 101,
      durationMs: 1,
    },
  };
}

function tool(overrides: Partial<Tool<unknown, unknown>> = {}): Tool<unknown, unknown> & { initCount: number; disposeCount: number; executes: number } {
  return {
    initCount: 0,
    disposeCount: 0,
    executes: 0,
    declaration,
    async init() {
      this.initCount += 1;
    },
    async execute(invocation) {
      this.executes += 1;
      return okResult(invocation);
    },
    async dispose() {
      this.disposeCount += 1;
    },
    ...overrides,
  };
}

describe("US-TOOL-002 ToolRegistry", () => {
  it("returns not_found and never throws for an unknown tool", async () => {
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });

    const result = await registry.invoke(TOOL_ID, request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("register() is idempotent and invokes the registered tool through policy and events", async () => {
    const events = sink();
    const t = tool();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine(), events });

    registry.register(t);
    registry.register(t);
    const result = await registry.invoke(TOOL_ID, request("hello"));

    expect(result).toMatchObject({ ok: true, output: "hello" });
    expect(t.initCount).toBe(1);
    expect(t.executes).toBe(1);
    expect(events.types).toEqual(["tool:invoke", "tool:result"]);
  });

  it("does not emit success events when the tool declaration sets emitsEvents:false", async () => {
    const events = sink();
    const t = tool({ declaration: { ...declaration, emitsEvents: false } });
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine(), events });

    registry.register(t);
    const result = await registry.invoke(TOOL_ID, request("quiet"));

    expect(result).toMatchObject({ ok: true, output: "quiet" });
    expect(events.types).toEqual([]);
    expect(registry.snapshotCosts()).toEqual([
      expect.objectContaining({ toolId: TOOL_ID, invocations: 1, durationMs: 1, failures: 0, currency: "USD" }),
    ]);
  });

  it("emits sanitized result events without adapter output payloads", async () => {
    const events = sink();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine(), events });
    registry.register(tool());

    const result = await registry.invoke(TOOL_ID, request({ secret: "stdout should not leak" }));

    expect(result).toMatchObject({ ok: true, output: { secret: "stdout should not leak" } });
    const emitted = events.events.find((event) => event.type === "tool:result");
    expect(emitted).toBeDefined();
    expect(JSON.stringify(emitted)).not.toContain("stdout should not leak");
    expect(JSON.stringify(emitted)).not.toContain("output");
  });

  it("redacts nested invocation input in events without changing adapter input", async () => {
    const events = sink();
    const secret = "token-secret";
    const registry = new ToolRegistry({
      deps: deps((value) => value.replaceAll(secret, "[REDACTED]")),
      policyEngine: policyEngine(),
      events,
    });
    registry.register(tool());

    const input = { token: secret, nested: { headers: [secret], password: "field-secret", access_token: "access-secret" } };
    const result = await registry.invoke(TOOL_ID, request(input));

    expect(result).toMatchObject({ ok: true, output: input });
    const emitted = events.events.find((event) => event.type === "tool:invoke");
    expect(JSON.stringify(emitted)).not.toContain(secret);
    expect(emitted).toMatchObject({
      invocation: {
        input: {
          token: "[REDACTED]",
          nested: { headers: ["[REDACTED]"], password: "[REDACTED]", access_token: "[REDACTED]" },
        },
      },
    });
  });

  it("emits a sanitized failure result even when emitsEvents:false suppresses success events", async () => {
    const events = sink();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine(), events });
    registry.register(
      tool({
        declaration: { ...declaration, emitsEvents: false },
        async execute(invocation) {
          this.executes += 1;
          return {
            ok: false,
            error: {
              code: "adapter_error",
              message: "stderr should not leak",
              retryable: false,
              detail: { stderr: "hidden" },
            },
            meta: {
              invocationId: invocation.invocationId,
              toolId: invocation.toolId,
              caller: invocation.caller,
              startedAt: 100,
              endedAt: 101,
              durationMs: 1,
            },
          };
        },
      }),
    );

    const result = await registry.invoke(TOOL_ID, request("x"));

    expect(result.ok).toBe(false);
    expect(events.types).toEqual(["tool:result"]);
    const emitted = events.events[0];
    expect(emitted).toMatchObject({
      type: "tool:result",
      result: { ok: false, errorCode: "adapter_error" },
    });
    expect(JSON.stringify(emitted)).not.toContain("stderr should not leak");
    expect(JSON.stringify(emitted)).not.toContain("hidden");
  });

  it("does not track costs for CLI invocations without a cycleId", async () => {
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });
    registry.register(tool());

    const result = await registry.invoke(TOOL_ID, cliRequest("cli"));

    expect(result).toMatchObject({ ok: true, output: "cli" });
    expect(registry.snapshotCosts()).toEqual([]);
  });

  it("still emits tool events for CLI invocations without a cycleId", async () => {
    const events = sink();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine(), events });
    registry.register(tool());

    const result = await registry.invoke(TOOL_ID, cliRequest("cli"));

    expect(result).toMatchObject({ ok: true, output: "cli" });
    expect(events.types).toEqual(["tool:invoke", "tool:result"]);
    expect(events.events[0]).toMatchObject({ type: "tool:invoke", invocation: expect.objectContaining({ invocationId: "inv-cli" }) });
    expect(events.events[1]).toMatchObject({ type: "tool:result", invocationId: "inv-cli", result: { ok: true, meta: expect.any(Object) } });
    expect(registry.snapshotCosts()).toEqual([]);
  });

  it("preserves the registry currency on tool cost rows", async () => {
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine(), currency: "CNY" });
    registry.register(tool());

    await registry.invoke(TOOL_ID, request("人民币成本不应标成美元"));

    expect(registry.snapshotCosts()).toEqual([
      expect.objectContaining({ toolId: TOOL_ID, invocations: 1, currency: "CNY" }),
    ]);
  });

  it("keeps concurrent tool costs separated by Workspace correlation", async () => {
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });
    registry.register(tool());

    await Promise.all([
      registry.invoke(TOOL_ID, { ...request("alpha"), invocationId: "inv-alpha", context: workspaceContext("alpha"), repoId: "repo-product" }),
      registry.invoke(TOOL_ID, { ...request("beta"), invocationId: "inv-beta", context: workspaceContext("beta"), repoId: "repo-product" }),
    ]);

    expect(registry.snapshotCosts()).toEqual([
      expect.objectContaining({ invocations: 1, correlation: { workspaceId: "alpha", storyId: "US-WS-035", repoId: "repo-product" } }),
      expect.objectContaining({ invocations: 1, correlation: { workspaceId: "beta", storyId: "US-WS-035", repoId: "repo-product" } }),
    ]);
  });

  it("denies disabled policy before execution", async () => {
    const t = tool();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine({ enabled: false }) });
    registry.register(t);

    const result = await registry.invoke(TOOL_ID, request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("policy_denied");
    expect(t.executes).toBe(0);
  });

  it("rejects invalid input against inputSchema before init or execution", async () => {
    const t = tool({
      declaration: {
        ...declaration,
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: { command: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
      },
    });
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });
    registry.register(t);

    const result = await registry.invoke(TOOL_ID, request({ command: "" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.message).toContain("$.command must have length >= 1");
    }
    expect(t.initCount).toBe(0);
    expect(t.executes).toBe(0);
  });

  it("gates execution when a non-optional requirement is missing", async () => {
    const t = tool({ declaration: { ...declaration, requirements: [{ kind: "executable", name: "git", optional: false }] } });
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine(),
      requirementResolver: () => resolution("missing", "git is not on PATH."),
    });
    registry.register(t);

    const result = await registry.invoke(TOOL_ID, request("x"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("policy_denied");
      expect(result.error.message).toContain("missing required tool requirement");
      expect(result.error.message).toContain("git is not on PATH.");
    }
    expect(t.initCount).toBe(0);
    expect(t.executes).toBe(0);
  });

  it("warns but executes when only optional requirements are missing", async () => {
    const t = tool({ declaration: { ...declaration, requirements: [{ kind: "executable", name: "playwright-chromium", optional: true }] } });
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine(),
      requirementResolver: () => ({
        requirement: { kind: "executable", name: "playwright-chromium", optional: true },
        status: "missing",
        detail: "Chromium missing.",
        repair: { command: "npx playwright install chromium" },
      }),
    });
    registry.register(t);

    const result = await registry.invoke(TOOL_ID, request("x"));

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["optional requirement playwright-chromium is missing: Chromium missing. fix: npx playwright install chromium"]);
    expect(t.executes).toBe(1);
  });

  it("enforces maxInvocationsPerCycle with an atomic check before async execution", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = tool({
      async execute(invocation) {
        this.executes += 1;
        await gate;
        return okResult(invocation);
      },
    });
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine({ maxInvocationsPerCycle: 1 }),
    });
    registry.register(t);

    const first = registry.invoke(TOOL_ID, request("a"));
    const second = registry.invoke(TOOL_ID, { ...request("b"), invocationId: "inv-2" });
    release();

    const results = await Promise.all([first, second]);

    expect(results.map((r) => (r.ok ? "ok" : r.error.code)).sort()).toEqual(["budget_exhausted", "ok"]);
    expect(t.executes).toBe(1);
  });

  it("keeps invocation budgets isolated across concurrent Workspace cycles", async () => {
    const t = tool();
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine({ maxInvocationsPerCycle: 1 }),
    });
    registry.register(t);
    const alpha = { ...request("alpha"), invocationId: "inv-alpha", caller: { ...request().caller, cycleId: "cycle-alpha" }, context: workspaceContext("alpha"), repoId: "repo-product" };
    const beta = { ...request("beta"), invocationId: "inv-beta", caller: { ...request().caller, cycleId: "cycle-beta" }, context: workspaceContext("beta"), repoId: "repo-product" };

    const [alphaResult, betaResult] = await Promise.all([
      registry.invoke(TOOL_ID, alpha),
      registry.invoke(TOOL_ID, beta),
    ]);
    const alphaSecond = await registry.invoke(TOOL_ID, { ...alpha, invocationId: "inv-alpha-2" });

    expect(alphaResult.ok).toBe(true);
    expect(betaResult.ok).toBe(true);
    expect(alphaSecond).toMatchObject({ ok: false, error: { code: "budget_exhausted" } });
    expect(t.executes).toBe(2);
  });

  it("catches adapter crashes and returns adapter_error", async () => {
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });
    registry.register(
      tool({
        async execute() {
          throw new Error("boom");
        },
      }),
    );

    const result = await registry.invoke(TOOL_ID, request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("adapter_error");
  });

  it("guards lazy init so concurrent invocations initialize once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = tool({
      async init() {
        this.initCount += 1;
        await gate;
      },
    });
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });
    registry.register(t);

    const first = registry.invoke(TOOL_ID, request("a"));
    const second = registry.invoke(TOOL_ID, { ...request("b"), invocationId: "inv-2" });
    release();
    await Promise.all([first, second]);

    expect(t.initCount).toBe(1);
    expect(t.executes).toBe(2);
  });

  it("retries retryable adapter errors and accumulates costs", async () => {
    let calls = 0;
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine({ retry: { attempts: 2, backoffMs: 0 } }),
    });
    registry.register(
      tool({
        async execute(invocation) {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return okResult(invocation, "recovered");
        },
      }),
    );

    const result = await registry.invoke(TOOL_ID, request("x"));

    expect(result).toMatchObject({ ok: true, output: "recovered" });
    expect(calls).toBe(2);
    expect(registry.snapshotCosts()).toEqual([
      expect.objectContaining({ toolId: TOOL_ID, invocations: 1, durationMs: 1, failures: 0, currency: "USD" }),
    ]);
  });

  it("retries retryable failed ToolResult values", async () => {
    let calls = 0;
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine({ retry: { attempts: 2, backoffMs: 0 } }),
    });
    registry.register(
      tool({
        async execute(invocation) {
          calls += 1;
          if (calls === 1) {
            return {
              ok: false,
              error: { code: "timeout", message: "try again", retryable: true },
              meta: {
                invocationId: invocation.invocationId,
                toolId: invocation.toolId,
                caller: invocation.caller,
                startedAt: 100,
                endedAt: 101,
                durationMs: 1,
              },
            };
          }
          return okResult(invocation, "ok");
        },
      }),
    );

    const result = await registry.invoke(TOOL_ID, request("x"));

    expect(result).toMatchObject({ ok: true, output: "ok" });
    expect(calls).toBe(2);
  });

  it("freezes Workspace context and repo selection across adapter retries", async () => {
    const context = workspaceContext();
    const seen: Array<{ context: WorkspaceExecutionContextV1 | undefined; repoId: string | undefined }> = [];
    let calls = 0;
    const registry = new ToolRegistry({
      deps: deps(),
      policyEngine: policyEngine({ retry: { attempts: 2, backoffMs: 0 } }),
    });
    registry.register(tool({
      async execute(invocation) {
        calls += 1;
        seen.push({ context: invocation.context, repoId: invocation.repoId });
        if (calls === 1) {
          return {
            ok: false,
            error: { code: "timeout", message: "retry", retryable: true },
            meta: {
              invocationId: invocation.invocationId,
              toolId: invocation.toolId,
              caller: invocation.caller,
              startedAt: 100,
              endedAt: 101,
              durationMs: 1,
            },
          };
        }
        return okResult(invocation, "ok");
      },
    }));

    const result = await registry.invoke(TOOL_ID, {
      ...request("x"),
      context,
      repoId: "repo-product",
    });

    expect(result).toMatchObject({
      ok: true,
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "repo-product" } },
    });
    expect(seen).toEqual([
      { context, repoId: "repo-product" },
      { context, repoId: "repo-product" },
    ]);
    expect(seen[0]?.context).toBe(context);
    expect(seen[1]?.context).toBe(context);
  });

  it("correlates registry failures without exposing Workspace paths", async () => {
    const context = workspaceContext();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });

    const result = await registry.invoke(TOOL_ID, {
      ...request(),
      context,
      repoId: "repo-product",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "not_found" },
      meta: { correlation: { workspaceId: "roll", storyId: "US-WS-035", repoId: "repo-product" } },
    });
    expect(JSON.stringify(result)).not.toContain("/ws/roll");
  });

  it("shutdown disposes initialized tools once and is idempotent", async () => {
    const t = tool();
    const registry = new ToolRegistry({ deps: deps(), policyEngine: policyEngine() });
    registry.register(t);
    await registry.invoke(TOOL_ID, request());

    await registry.shutdown();
    await registry.shutdown();

    expect(t.disposeCount).toBe(1);
  });
});
