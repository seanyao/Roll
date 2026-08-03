import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";
import { workspaceEventsPath } from "@roll/infra";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const sandboxes: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"] as const;

function sandbox(): { readonly home: string; readonly rollHome: string } {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-cli-"));
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

async function runCli(
  argv: string[],
  fixture: { readonly home: string; readonly rollHome: string },
  lang: "en" | "zh" = "en",
): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["HOME"] = fixture.home;
  process.env["ROLL_HOME"] = fixture.rollHome;
  process.env["ROLL_LANG"] = lang;
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += String(chunk);
    return true;
  };
  // @ts-expect-error test capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  };
  try {
    const result = await dispatch(argv, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function scrub(run: Run, roots: readonly string[]): Run {
  const replace = (value: string): string => roots.reduce((text, root, index) => {
    const token = `<WS_${index + 1}>`;
    let canonical = root;
    try {
      canonical = realpathSync(root);
    } catch {
      // A stale-path scenario deliberately removes the fixture before scrubbing.
    }
    return text.replaceAll(canonical, token).replaceAll(root, token);
  }, value);
  return { ...run, stdout: replace(run.stdout), stderr: replace(run.stderr) };
}

async function twoActiveFixture(lang: "en" | "zh" = "en") {
  const fixture = sandbox();
  const alpha = workspace(join(fixture.home, "alpha"), "ws-alpha");
  const beta = workspace(join(fixture.home, "beta"), "ws-beta");
  expect((await runCli(["workspace", "register", "ws-alpha", alpha], fixture, lang)).status).toBe(0);
  expect((await runCli(["workspace", "register", "ws-beta", beta], fixture, lang)).status).toBe(0);
  expect((await runCli(["workspace", "activate", "ws-alpha"], fixture, lang)).status).toBe(0);
  expect((await runCli(["workspace", "activate", "ws-beta"], fixture, lang)).status).toBe(0);
  return { fixture, alpha, beta };
}

beforeEach(() => registerAll());

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("US-WS-005 roll workspace lifecycle surface", () => {
  it("freezes locale-specific help without adjacent bilingual copy", async () => {
    const fixture = sandbox();
    const en = await runCli(["workspace", "--help"], fixture, "en");
    const zh = await runCli(["workspace", "--help"], fixture, "zh");
    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en: en.stdout, zh: zh.stdout }).toMatchSnapshot();
  });

  it("freezes two-active human list output in one locale at a time", async () => {
    const enFixture = await twoActiveFixture("en");
    const zhFixture = await twoActiveFixture("zh");
    const en = scrub(await runCli(["workspace", "list"], enFixture.fixture, "en"), [enFixture.alpha, enFixture.beta]);
    const zh = scrub(await runCli(["workspace", "list"], zhFixture.fixture, "zh"), [zhFixture.alpha, zhFixture.beta]);
    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en, zh }).toMatchSnapshot();
  });

  it("freezes stable list/show JSON contracts with honest runtime health", async () => {
    const { fixture, alpha, beta } = await twoActiveFixture();
    const list = scrub(await runCli(["workspace", "list", "--json"], fixture), [alpha, beta]);
    const show = scrub(await runCli(["workspace", "show", "ws-alpha", "--json"], fixture), [alpha, beta]);
    expect(list.status).toBe(0);
    expect(show.status).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      schema: "roll.workspace-list/v1",
      workspaces: [
        { workspaceId: "ws-alpha", lifecycle: "active", runtimeHealth: { status: "unknown", reason: "scheduler_not_available" } },
        { workspaceId: "ws-beta", lifecycle: "active", runtimeHealth: { status: "unknown", reason: "scheduler_not_available" } },
      ],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      schema: "roll.workspace-view/v1",
      workspace: { workspaceId: "ws-alpha", manifest: { workspaceId: "ws-alpha", consistency: "consistent" } },
    });
    expect({ list, show }).toMatchSnapshot();
  });

  it("pauses one explicit path without changing another active Workspace", async () => {
    const { fixture, alpha, beta } = await twoActiveFixture();
    const alphaLink = join(fixture.home, "alpha-link");
    symlinkSync(alpha, alphaLink);
    const pause = scrub(await runCli(["workspace", "pause", alphaLink, "--json"], fixture), [alpha, beta, alphaLink]);
    const list = scrub(await runCli(["workspace", "list", "--json"], fixture), [alpha, beta]);
    expect(pause.status).toBe(0);
    expect(JSON.parse(list.stdout).workspaces.map((entry: { workspaceId: string; lifecycle: string }) => ({
      workspaceId: entry.workspaceId,
      lifecycle: entry.lifecycle,
    }))).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "paused" },
      { workspaceId: "ws-beta", lifecycle: "active" },
    ]);
    expect({ pause, list }).toMatchSnapshot();
  });

  it("freezes fail-loud ambiguity, --all mutation, stale path and ID mismatch errors", async () => {
    const { fixture, alpha, beta } = await twoActiveFixture();
    const ambiguous = scrub(await runCli(["workspace", "pause", "--json"], fixture), [alpha, beta]);
    const all = scrub(await runCli(["workspace", "archive", "--all", "--json"], fixture), [alpha, beta]);
    rmSync(alpha, { recursive: true, force: true });
    const stale = scrub(await runCli(["workspace", "show", "ws-alpha", "--json"], fixture), [alpha, beta]);
    workspace(beta, "ws-other");
    const mismatch = scrub(await runCli(["workspace", "show", "ws-beta", "--json"], fixture), [alpha, beta]);

    expect([ambiguous.status, all.status, stale.status, mismatch.status]).toEqual([1, 1, 1, 1]);
    expect(JSON.parse(ambiguous.stderr).error.code).toBe("target_missing");
    expect(JSON.parse(ambiguous.stderr).error.candidates).toHaveLength(2);
    expect(JSON.parse(all.stderr).error.code).toBe("all_requires_readonly");
    expect(JSON.parse(stale.stderr).error.code).toBe("stale_registry");
    expect(JSON.parse(mismatch.stderr).error.code).toBe("identity_mismatch");
    expect({ ambiguous, all, stale, mismatch }).toMatchSnapshot();
  });

  it("rejects archived pause in both locales without changing the event stream", async () => {
    const fixture = sandbox();
    const alpha = workspace(join(fixture.home, "alpha"), "ws-alpha");
    expect((await runCli(["workspace", "register", "ws-alpha", alpha], fixture)).status).toBe(0);
    expect((await runCli(["workspace", "archive", "ws-alpha"], fixture)).status).toBe(0);
    const before = readFileSync(workspaceEventsPath(fixture.rollHome), "utf8");
    const en = scrub(await runCli(["workspace", "pause", "ws-alpha"], fixture, "en"), [alpha]);
    const zh = scrub(await runCli(["workspace", "pause", "ws-alpha"], fixture, "zh"), [alpha]);
    expect(en.status).toBe(1);
    expect(zh.status).toBe(1);
    expect(readFileSync(workspaceEventsPath(fixture.rollHome), "utf8")).toBe(before);
    expectNoAdjacentBilingualPairs(en.stderr);
    expectNoAdjacentBilingualPairs(zh.stderr);
    expect({ en, zh }).toMatchSnapshot();
  });
});
