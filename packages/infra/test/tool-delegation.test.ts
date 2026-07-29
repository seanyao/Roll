import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDeclaration } from "@roll/spec";
import { commit, captureScreenshot, execFile, prCreate } from "../src/index.js";
import { invokeInfraTool } from "../src/tools/delegation.js";
import { TOOL_TEST_REPO_ID, toolWorkspaceContext } from "./tool-workspace-context.js";

const dirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

function tmp(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `roll-infra-tool-delegation-${tag}-`));
  dirs.push(dir);
  return dir;
}

function events(path: string): Array<{ type?: string; toolId?: string; invocation?: { toolId?: string } }> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; toolId?: string; invocation?: { toolId?: string } });
}

function setEventsPath(dir: string): string {
  const path = join(dir, "events.ndjson");
  process.env["ROLL_TOOL_EVENTS_PATH"] = path;
  process.env["ROLL_TOOL_CYCLE_ID"] = "cycle-tool-014";
  process.env["ROLL_STORY_ID"] = "US-TOOL-014";
  return path;
}

function fakeBin(name: string, script: string): void {
  const dir = tmp(`bin-${name}`);
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  process.env["PATH"] = `${dir}:${originalEnv.PATH ?? ""}`;
}

describe("US-TOOL-014 infra tool delegation", () => {
  it("freezes and forwards Workspace context while isolating events under its authority", async () => {
    delete process.env["ROLL_TOOL_EVENTS_PATH"];
    delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const root = tmp("workspace-context");
    const executionContext = toolWorkspaceContext("US-WS-036", root);
    const declaration: ToolDeclaration = {
      id: "network.test" as ToolDeclaration["id"],
      kind: "network",
      title: "Workspace-bound delegated test",
      defaults: { enabled: true },
    };
    let receivedFrozen = false;

    const result = await invokeInfraTool({
      declaration,
      input: { url: "https://example.test" },
      scope: "repository_required",
      caller: { cycleId: "cycle-context", storyId: "US-WS-036", agent: "codex" },
      context: executionContext,
      repoId: TOOL_TEST_REPO_ID,
      run: async (invocation) => {
        receivedFrozen = Object.isFrozen(invocation.context) && Object.isFrozen(invocation.context?.workspace);
        return {
          ok: true,
          output: { accepted: true },
          meta: {
            invocationId: invocation.invocationId,
            toolId: invocation.toolId,
            caller: invocation.caller,
            startedAt: invocation.ts,
            endedAt: invocation.ts,
            durationMs: 0,
          },
        };
      },
    });

    expect(receivedFrozen).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      meta: { correlation: { workspaceId: "tool-tests", storyId: "US-WS-036", repoId: TOOL_TEST_REPO_ID } },
    });
    const authorityEvents = join(root, "runtime", "events", "tools.ndjson");
    expect(events(authorityEvents).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual([
      "network.test",
      "network.test",
    ]);
  });

  it("does not let a machine event-path override redirect Workspace-scoped events", async () => {
    const root = tmp("workspace-event-precedence");
    const redirected = join(tmp("redirected-events"), "events.ndjson");
    process.env["ROLL_TOOL_EVENTS_PATH"] = redirected;
    const executionContext = toolWorkspaceContext("US-WS-036", root);
    const declaration: ToolDeclaration = {
      id: "network.test" as ToolDeclaration["id"],
      kind: "network",
      title: "Workspace event authority test",
      defaults: { enabled: true },
    };

    const result = await invokeInfraTool({
      declaration,
      input: { url: "https://example.test" },
      scope: "repository_required",
      caller: { cycleId: "cycle-context", storyId: "US-WS-036", agent: "codex" },
      context: executionContext,
      repoId: TOOL_TEST_REPO_ID,
      run: async (invocation) => ({
        ok: true,
        output: { accepted: true },
        meta: {
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          caller: invocation.caller,
          startedAt: invocation.ts,
          endedAt: invocation.ts,
          durationMs: 0,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(events(join(executionContext.authorities.events, "tools.ndjson"))).toHaveLength(2);
    expect(existsSync(redirected)).toBe(false);
  });

  it("redacts common provider and credential forms from delegated invoke events", async () => {
    const root = tmp("workspace-event-redaction");
    const executionContext = toolWorkspaceContext("US-WS-036", root);
    const declaration: ToolDeclaration = {
      id: "network.secret-test" as ToolDeclaration["id"],
      kind: "network",
      title: "Workspace event redaction test",
      defaults: { enabled: true },
    };
    const secrets = ["sk-example123456", "Bearer bearer-secret", "password=hunter2", "api_key=key-secret"];

    const result = await invokeInfraTool({
      declaration,
      input: {
        nested: { secrets, secret: "nested-secret" },
        password: "structured-password",
        token: "structured-token",
        api_key: "structured-key",
        access_token: "structured-access-token",
        clientSecret: "structured-client-secret",
      },
      scope: "issue_required",
      context: executionContext,
      run: async (invocation) => ({
        ok: true,
        output: invocation.input,
        meta: {
          invocationId: invocation.invocationId,
          toolId: invocation.toolId,
          caller: invocation.caller,
          startedAt: invocation.ts,
          endedAt: invocation.ts,
          durationMs: 0,
        },
      }),
    });

    expect(result.ok).toBe(true);
    const persisted = readFileSync(join(executionContext.authorities.events, "tools.ndjson"), "utf8");
    for (const secret of [
      "sk-example123456", "bearer-secret", "hunter2", "key-secret",
      "nested-secret", "structured-password", "structured-token", "structured-key",
      "structured-access-token", "structured-client-secret",
    ]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).toContain("[REDACTED]");
  });

  it("keeps the legacy machine process wrapper explicit even when Story environment is present", async () => {
    const dir = tmp("process");
    const eventsPath = setEventsPath(dir);

    const result = await execFile("node", ["-e", "process.stdout.write('ok')"], { cwd: dir });

    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["bash", "bash"]);
  });

  it("rejects a delegated repository operation before its runner when context is missing", async () => {
    const dir = tmp("missing-context");
    const eventsPath = setEventsPath(dir);
    let ran = false;
    const declaration: ToolDeclaration = {
      id: "bash.test" as ToolDeclaration["id"],
      kind: "bash",
      title: "Missing Workspace context test",
      defaults: { enabled: true },
    };

    const result = await invokeInfraTool({
      declaration,
      input: { command: "pwd" },
      scope: "repository_required",
      run: async (invocation) => {
        ran = true;
        return {
          ok: true,
          output: invocation.input,
          meta: {
            invocationId: invocation.invocationId,
            toolId: invocation.toolId,
            caller: invocation.caller,
            startedAt: invocation.ts,
            endedAt: invocation.ts,
            durationMs: 0,
          },
        };
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "missing_execution_context" } });
    expect(ran).toBe(false);
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["bash.test", "bash.test"]);
  });

  it("keeps the legacy machine git wrapper available without Workspace context", async () => {
    const repo = tmp("git");
    const eventsPath = setEventsPath(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "file.txt"), "hello\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo });

    const result = await commit(repo, "add file");

    expect(result).toMatchObject({ code: 0 });
    expect(execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toMatch(/^[0-9a-f]{40}$/u);
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["git.commit", "git.commit"]);
  });

  it("keeps the legacy machine GitHub wrapper available without Workspace context", async () => {
    const dir = tmp("gh");
    const eventsPath = setEventsPath(dir);
    fakeBin("gh", `#!/bin/sh
if [ "$*" = "-R o/r pr create --base main --head topic --title Title --body Body" ]; then
  echo "https://github.com/o/r/pull/42"
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`);

    const url = await prCreate({ slug: "o/r", head: "topic", title: "Title", body: "Body" });

    expect(url).toBe("https://github.com/o/r/pull/42");
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["github.pr", "github.pr"]);
  });

  it("default web screenshots require physical capture and do not delegate to browser.screenshot", async () => {
    const dir = tmp("shot");
    const eventsPath = setEventsPath(dir);
    const out = join(dir, "web.png");
    fakeBin("npx", `#!/bin/sh
payload=""
for arg in "$@"; do
  case "$arg" in
    \\{*) payload="$arg" ;;
  esac
done
node -e 'const fs=require("fs"); const input=JSON.parse(process.argv[1]); fs.writeFileSync(input.screenshotPath, "png"); console.log(JSON.stringify({ finalUrl: input.url, statusCode: 200 }));' "$payload"
`);

    const result = await captureScreenshot({ kind: "web", url: "https://example.com", out }, { env: {}, platform: "linux" });

    expect(result).toMatchObject({ kind: "web", out, taken: false });
    expect(result.skipped).toContain("physical browser screenshots require macOS");
    expect(existsSync(eventsPath)).toBe(false);
  });

  it("rejects invalid input before the delegated adapter runs and still appends a result event", async () => {
    const dir = tmp("invalid");
    const eventsPath = setEventsPath(dir);
    const executionContext = toolWorkspaceContext("US-TOOL-014", dir);
    let ran = false;
    const declaration: ToolDeclaration = {
      id: "test.delegated" as ToolDeclaration["id"],
      kind: "bash",
      title: "Delegated Test",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      defaults: { enabled: true },
    };

    const result = await invokeInfraTool({
      declaration,
      input: { args: ["--version"] },
      scope: "repository_required",
      context: executionContext,
      repoId: TOOL_TEST_REPO_ID,
      run: async (invocation) => {
        ran = true;
        return {
          ok: true,
          output: invocation.input,
          meta: {
            invocationId: invocation.invocationId,
            toolId: invocation.toolId,
            caller: invocation.caller,
            startedAt: invocation.ts,
            endedAt: invocation.ts,
            durationMs: 0,
          },
        };
      },
    });

    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.message).toContain("$.command is required");
    }
    const authorityEvents = join(executionContext.authorities.events, "tools.ndjson");
    expect(existsSync(eventsPath)).toBe(false);
    expect(events(authorityEvents).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["test.delegated", "test.delegated"]);
    expect(events(authorityEvents).at(-1)).toMatchObject({ type: "tool:result", result: { ok: false, errorCode: "invalid_input" } });
  });
});
