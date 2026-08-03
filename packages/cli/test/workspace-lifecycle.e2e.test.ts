/**
 * US-WS-005 process-level golden path. This deliberately invokes the built
 * public CLI instead of dispatching in-process, so argument parsing, locale,
 * exit status, JSON contracts, and the durable event stream are exercised
 * together.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const sandboxes: string[] = [];

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function sandbox(): { readonly home: string; readonly rollHome: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "roll-workspace-e2e-")));
  sandboxes.push(home);
  const rollHome = join(home, ".roll");
  mkdirSync(rollHome, { recursive: true });
  return { home, rollHome };
}

function workspace(root: string, workspaceId: string): string {
  mkdirSync(root, { recursive: true });
  const remote = `https://example.test/workspaces/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be valid");
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId,
    displayName: workspaceId,
    requirements: [],
    repositories: [{
      schema: REPOSITORY_BINDING_V1,
      repoId: repoId.value,
      alias: "primary",
      remote,
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  })}\n`, "utf8");
  return root;
}

function run(cwd: string, fixture: { readonly home: string; readonly rollHome: string }, args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [rollBin, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: fixture.home,
      ROLL_HOME: fixture.rollHome,
      ROLL_LANG: "en",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("US-WS-005 workspace lifecycle E2E", () => {
  it("registers and activates two workspaces, pauses one explicit target, and rejects ambiguity", () => {
    const fixture = sandbox();
    const alpha = workspace(join(fixture.home, "alpha"), "ws-alpha");
    const beta = workspace(join(fixture.home, "beta"), "ws-beta");

    for (const args of [
      ["workspace", "register", "ws-alpha", alpha, "--json"],
      ["workspace", "register", "ws-beta", beta, "--json"],
      ["workspace", "activate", "ws-alpha", "--json"],
      ["workspace", "activate", "ws-beta", "--json"],
    ] as const) {
      const result = run(repoRoot, fixture, args);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).schema).toBe("roll.workspace-mutation/v1");
    }

    const beforePause = run(repoRoot, fixture, ["workspace", "list", "--json"]);
    expect(beforePause.status, beforePause.stderr).toBe(0);
    expect(JSON.parse(beforePause.stdout).workspaces.map((entry: { workspaceId: string; lifecycle: string }) => ({
      workspaceId: entry.workspaceId,
      lifecycle: entry.lifecycle,
    }))).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "active" },
      { workspaceId: "ws-beta", lifecycle: "active" },
    ]);

    const pause = run(repoRoot, fixture, ["workspace", "pause", alpha, "--json"]);
    expect(pause.status, pause.stderr).toBe(0);
    expect(JSON.parse(pause.stdout)).toMatchObject({
      schema: "roll.workspace-mutation/v1",
      operation: "pause",
      workspace: { workspaceId: "ws-alpha", lifecycle: "paused" },
    });

    const afterPause = run(repoRoot, fixture, ["workspace", "list", "--json"]);
    expect(JSON.parse(afterPause.stdout).workspaces.map((entry: { workspaceId: string; lifecycle: string }) => ({
      workspaceId: entry.workspaceId,
      lifecycle: entry.lifecycle,
    }))).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "paused" },
      { workspaceId: "ws-beta", lifecycle: "active" },
    ]);

    const ambiguous = run(repoRoot, fixture, ["workspace", "pause", "--json"]);
    expect(ambiguous.status).toBe(1);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      schema: "roll.workspace-error/v1",
      error: { code: "target_missing" },
    });

    const events = readFileSync(join(fixture.rollHome, "workspace-events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; workspaceId: string });
    expect(events.map((event) => `${event.type}:${event.workspaceId}`)).toEqual([
      "workspace:registered:ws-alpha",
      "workspace:registered:ws-beta",
      "workspace:activated:ws-alpha",
      "workspace:activated:ws-beta",
      "workspace:paused:ws-alpha",
    ]);
  });
});
