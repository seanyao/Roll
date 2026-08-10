import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDeclaration } from "@roll/spec";
import { commit, captureScreenshot, execFile, prCreate } from "../src/index.js";
import { invokeInfraTool } from "../src/tools/delegation.js";

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
  it("delegates public process execFile calls through the bash tool and appends events.ndjson entries", async () => {
    const dir = tmp("process");
    const eventsPath = setEventsPath(dir);

    const result = await execFile("node", ["-e", "process.stdout.write('ok')"], { cwd: dir });

    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["bash", "bash"]);
  });

  it("delegates public git commit calls through git.commit and appends events.ndjson entries", async () => {
    const repo = tmp("git");
    const eventsPath = setEventsPath(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "file.txt"), "hello\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo });

    const result = await commit(repo, "add file");

    expect(result.code).toBe(0);
    expect(execFileSync("git", ["show", "-s", "--format=%s", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe("add file");
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["git.commit", "git.commit"]);
  });

  it("delegates public GitHub PR creation through github.pr and appends events.ndjson entries", async () => {
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
    expect(events(eventsPath).map((event) => event.invocation?.toolId ?? event.toolId)).toEqual(["test.delegated", "test.delegated"]);
    expect(events(eventsPath).at(-1)).toMatchObject({ type: "tool:result", result: { ok: false, errorCode: "invalid_input" } });
  });
});
