import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawGit, type GitExecutionOptions, type GitResult } from "../../src/git.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGitLlmWikiCommand,
  ContextTransportError,
  GIT_LLM_WIKI_POLICY_ARGS,
  resolveContextCacheIdentity,
} from "../../src/context/context-cache.js";
import {
  withFreshGitLlmWikiRead,
  type GitLlmWikiCommandRunner,
} from "../../src/context/git-llm-wiki-transport.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-context-transport-"));
  sandboxes.push(root);
  return root;
}

function provider(remote = "https://github.com/bipo/context-wiki") {
  return {
    id: "bipo-enterprise",
    type: "git_llm_wiki" as const,
    enabled: true,
    remote,
    branch: "main",
    fetch_timeout_seconds: 30,
  };
}

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function successfulGit(remote = provider().remote): {
  readonly runGit: GitLlmWikiCommandRunner;
  readonly calls: Array<{
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  }>;
} {
  const calls: Array<{
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  }> = [];
  const runGit: GitLlmWikiCommandRunner = vi.fn(async (args, cwd, options): Promise<GitResult> => {
    const env = (options as GitExecutionOptions & { readonly env?: Readonly<Record<string, string>> }).env;
    calls.push({
      args: [...args],
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: options.timeoutMs,
      ...(env === undefined ? {} : { env }),
    });
    const operation = args.slice(12);
    if (operation[0] === "init") {
      const target = operation.at(-1);
      if (target !== undefined) mkdirSync(target, { recursive: true });
    }
    if (operation[0] === "rev-parse" && operation[1] === "--is-bare-repository") {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    if (operation[0] === "remote" && operation[1] === "get-url") {
      return { code: 0, stdout: `${remote}\n`, stderr: "" };
    }
    if (operation[0] === "rev-parse" && operation[1] === "--verify") {
      return { code: 0, stdout: `${REVISION}\n`, stderr: "" };
    }
    if (operation[0] === "cat-file" && operation[1] === "-t") {
      return { code: 0, stdout: "commit\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  return { runGit, calls };
}

async function localRemoteFixture(root: string): Promise<{ readonly remotePath: string; readonly revision: string }> {
  const remotePath = join(root, "remote.git");
  const sourcePath = join(root, "source");
  mkdirSync(sourcePath, { recursive: true });
  expect((await rawGit(["init", "--bare", remotePath])).code).toBe(0);
  expect((await rawGit(["init", "-b", "main"], sourcePath)).code).toBe(0);
  expect((await rawGit(["config", "user.name", "Roll Context Test"], sourcePath)).code).toBe(0);
  expect((await rawGit(["config", "user.email", "context-test@example.test"], sourcePath)).code).toBe(0);
  writeFileSync(join(sourcePath, "purpose.md"), "# Purpose\n", "utf8");
  expect((await rawGit(["add", "purpose.md"], sourcePath)).code).toBe(0);
  expect((await rawGit(["commit", "-m", "seed"], sourcePath)).code).toBe(0);
  expect((await rawGit(["push", remotePath, "main"], sourcePath)).code).toBe(0);
  const revision = await rawGit(["rev-parse", "HEAD"], sourcePath);
  expect(revision.code).toBe(0);
  return { remotePath, revision: revision.stdout.trim() };
}

describe("Git LLM Wiki cache identity and command policy", () => {
  it("uses the managed bare-cache and provider lock paths under ROLL_HOME", () => {
    const rollHome = sandbox();
    expect(resolveContextCacheIdentity({ rollHome, provider: provider() })).toEqual({
      providerId: "bipo-enterprise",
      remoteIdentity: "https://github.com/bipo/context-wiki",
      fetchEndpoint: "https://github.com/bipo/context-wiki",
      branch: "main",
      cacheRoot: join(rollHome, "context-cache"),
      cachePath: join(rollHome, "context-cache", "bipo-enterprise.git"),
      temporaryPath: join(rollHome, "context-cache", "bipo-enterprise.creating"),
      lockPath: join(rollHome, "context-cache", "locks", "bipo-enterprise.lock"),
      remoteName: "origin",
    });
  });

  it("keeps the explicit SSH user in the validated endpoint but not the canonical identity", () => {
    const scp = resolveContextCacheIdentity({
      rollHome: sandbox(),
      provider: provider("git@GitHub.com:bipo/context-wiki.git"),
    });
    const ssh = resolveContextCacheIdentity({
      rollHome: sandbox(),
      provider: provider("ssh://deploy@github.com:22/bipo/context-wiki"),
    });

    expect(scp).toMatchObject({
      remoteIdentity: "ssh://github.com/bipo/context-wiki",
      fetchEndpoint: "ssh://git@github.com/bipo/context-wiki",
    });
    expect(buildGitLlmWikiCommand("fetch", provider("git@GitHub.com:bipo/context-wiki.git")))
      .toContain("ssh://git@github.com/bipo/context-wiki");
    expect(ssh).toMatchObject({
      remoteIdentity: "ssh://github.com/bipo/context-wiki",
      fetchEndpoint: "ssh://deploy@github.com/bipo/context-wiki",
    });
  });

  it("builds an argv-only fetch with deny-by-default protocols, no hooks and no submodules", () => {
    const command = buildGitLlmWikiCommand("fetch", provider());
    expect(command).toEqual([
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      "-c", "protocol.ssh.allow=always",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.askPass=false",
      "-c", "credential.interactive=never",
      "fetch", "--prune", "--no-tags", "--recurse-submodules=no", "https://github.com/bipo/context-wiki",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(command).not.toContain("credential.helper=");
    expect(command).not.toContain("sh");
    expect(command.join(" ")).not.toContain("checkout");
  });

  it("preserves configured credential helpers while disabling interactive prompts", async () => {
    const cachePath = join(sandbox(), "cache.git");
    expect((await rawGit(["init", "--bare", cachePath])).code).toBe(0);
    expect((await rawGit(["config", "credential.helper", "store"], cachePath)).code).toBe(0);

    const helpers = await rawGit([...GIT_LLM_WIKI_POLICY_ARGS, "config", "--get-all", "credential.helper"], cachePath);
    expect(helpers.code).toBe(0);
    expect(helpers.stdout).toMatch(/(?:^|\n)store\n$/u);
    expect(helpers.stdout).not.toMatch(/\n\n$/u);
  });

  it.each([
    "http://example.test/team/wiki.git",
    "git://example.test/team/wiki.git",
    "file:///tmp/wiki.git",
    "/tmp/wiki.git",
    "../wiki.git",
    "ext::sh -c id",
    "helper::team/wiki",
  ])("rejects production transport %s without reflecting it in the error", (remote) => {
    let caught: unknown;
    try {
      resolveContextCacheIdentity({ rollHome: sandbox(), provider: provider(remote) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContextTransportError);
    expect(caught).toMatchObject({ code: "unsupported_git_transport" });
    expect(String(caught)).not.toContain(remote);
    expect(JSON.stringify(caught)).not.toContain(remote);
  });

  it("rejects credential-bearing HTTPS before building any Git argv", () => {
    expect(() => resolveContextCacheIdentity({
      rollHome: sandbox(),
      provider: provider("https://secret-token@example.test/team/wiki.git"),
    })).toThrowError(expect.objectContaining({ code: "unsupported_git_transport" }));
  });
});

describe("withFreshGitLlmWikiRead", () => {
  it("initializes one bare cache, fetches the exact branch and resolves a commit", async () => {
    const rollHome = sandbox();
    const fake = successfulGit();

    const result = await withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit: fake.runGit }, async (revision) => {
      return `read:${revision.revision}`;
    });

    expect(result.value).toBe(`read:${REVISION}`);
    expect(result.revision).toMatchObject({
      providerId: "bipo-enterprise",
      remoteIdentity: "https://github.com/bipo/context-wiki",
      branch: "main",
      revision: REVISION,
      cachePath: join(rollHome, "context-cache", "bipo-enterprise.git"),
    });
    expect(fake.calls.map((call) => call.args.slice(12))).toEqual([
      ["init", "--bare", join(rollHome, "context-cache", "bipo-enterprise.creating")],
      ["remote", "add", "origin", "https://github.com/bipo/context-wiki"],
      ["rev-parse", "--is-bare-repository"],
      ["remote", "get-url", "--all", "origin"],
      ["fetch", "--prune", "--no-tags", "--recurse-submodules=no", "https://github.com/bipo/context-wiki", "+refs/heads/main:refs/remotes/origin/main"],
      ["rev-parse", "--verify", "refs/remotes/origin/main"],
      ["cat-file", "-t", REVISION],
    ]);
    expect(fake.calls.every((call) => call.timeoutMs === 30_000)).toBe(true);
  });

  it("runs the production Git command sequence against a real local object database seam", async () => {
    const rollHome = sandbox();
    const fixture = await localRemoteFixture(rollHome);
    const endpoint = provider().remote;
    const runGit: GitLlmWikiCommandRunner = async (args, cwd, options) => {
      const rewritten = [...args];
      const fetchIndex = rewritten.indexOf("fetch");
      if (fetchIndex >= 0) {
        const endpointIndex = rewritten.indexOf(endpoint, fetchIndex);
        expect(endpointIndex).toBeGreaterThan(fetchIndex);
        rewritten[endpointIndex] = fixture.remotePath;
        rewritten.splice(fetchIndex, 0, "-c", "protocol.file.allow=always");
      }
      return rawGit(rewritten, cwd, options);
    };

    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit }, async () => "ok"))
      .resolves.toMatchObject({ value: "ok", revision: { revision: fixture.revision } });
  });

  it("emits one credential-free completed audit event with timing and revision", async () => {
    const audit = vi.fn();
    const ticks = [1_000, 2_000, 3_000];
    const input = {
      rollHome: sandbox(),
      provider: provider(),
      runGit: successfulGit().runGit,
      now: () => ticks.shift() ?? 4_000,
      audit,
    };

    await withFreshGitLlmWikiRead(input, async () => "ok");

    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({
      type: "context:git-llm-wiki-read",
      providerId: "bipo-enterprise",
      remoteIdentity: "https://github.com/bipo/context-wiki",
      branch: "main",
      startedAt: "1970-01-01T00:00:01.000Z",
      finishedAt: "1970-01-01T00:00:03.000Z",
      durationMs: 2_000,
      outcome: "completed",
      revision: REVISION,
    });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/(?:credential|stderr|secret|fetchEndpoint)/iu);
  });

  it("performs a real fetch command for every read even when the revision is unchanged", async () => {
    const rollHome = sandbox();
    const fake = successfulGit();
    const timestamps = [1_000, 2_000];

    const first = await withFreshGitLlmWikiRead({
      rollHome,
      provider: provider(),
      runGit: fake.runGit,
      now: () => timestamps.shift() ?? 3_000,
    }, async () => "first");
    const second = await withFreshGitLlmWikiRead({
      rollHome,
      provider: provider(),
      runGit: fake.runGit,
      now: () => timestamps.shift() ?? 3_000,
    }, async () => "second");

    const fetches = fake.calls.filter((call) => call.args.slice(12)[0] === "fetch");
    expect(fetches).toHaveLength(2);
    expect(first.revision.revision).toBe(second.revision.revision);
    expect(first.revision.fetchedAt).not.toBe(second.revision.fetchedAt);
  });

  it("accepts an equivalent normalized origin identity in an existing managed cache", async () => {
    const rollHome = sandbox();
    mkdirSync(join(rollHome, "context-cache", "bipo-enterprise.git"), { recursive: true });
    const fake = successfulGit("https://github.com/bipo/context-wiki.git");

    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit: fake.runGit }, async () => "ok"))
      .resolves.toMatchObject({ value: "ok" });
  });

  it("fails on remote mismatch without rewriting origin, fetching or exposing cached content", async () => {
    const rollHome = sandbox();
    mkdirSync(join(rollHome, "context-cache", "bipo-enterprise.git"), { recursive: true });
    const fake = successfulGit("https://example.test/other/wiki");
    const readCached = vi.fn(async () => "stale");

    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit: fake.runGit }, readCached))
      .rejects.toMatchObject({ code: "remote_identity_mismatch" });
    expect(readCached).not.toHaveBeenCalled();
    const operations = fake.calls.map((call) => call.args.slice(12));
    expect(operations.some((args) => args[0] === "fetch")).toBe(false);
    expect(operations.some((args) => args[0] === "remote" && ["add", "set-url", "remove"].includes(args[1] ?? "")))
      .toBe(false);
  });

  it.each([
    {
      label: "fetch failure",
      result: { code: 1, stdout: "", stderr: "fatal: https://secret-token@example.test failed" },
      code: "fetch_failed",
    },
    {
      label: "fetch timeout",
      result: { code: 1, stdout: "", stderr: "secret-token", timedOut: true },
      code: "fetch_timeout",
    },
    {
      label: "missing branch",
      result: { code: 128, stdout: "", stderr: "fatal: couldn't find remote ref main" },
      code: "branch_not_found",
    },
  ])("returns a redacted $code diagnostic for $label and never falls back", async ({ result, code }) => {
    const rollHome = sandbox();
    const fake = successfulGit();
    const runGit: GitLlmWikiCommandRunner = vi.fn(async (args, cwd, options) => {
      if (args.slice(12)[0] === "fetch") return result;
      return fake.runGit(args, cwd, options);
    });
    const readCached = vi.fn(async () => "stale");
    let caught: unknown;
    try {
      await withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit }, readCached);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code });
    expect(String(caught)).not.toContain("secret-token");
    expect(JSON.stringify(caught)).not.toContain("secret-token");
    expect(readCached).not.toHaveBeenCalled();
  });

  it("emits a failed audit event without credential-bearing stderr", async () => {
    const secret = "audit-secret-token";
    const audit = vi.fn();
    const ticks = [1_000, 2_000];
    const fake = successfulGit();
    const runGit: GitLlmWikiCommandRunner = vi.fn(async (args, cwd, options) => {
      if (args.slice(12)[0] === "fetch") return { code: 1, stdout: "", stderr: secret };
      return fake.runGit(args, cwd, options);
    });
    const input = {
      rollHome: sandbox(),
      provider: provider(),
      runGit,
      now: () => ticks.shift() ?? 3_000,
      audit,
    };

    await expect(withFreshGitLlmWikiRead(input, async () => "unreachable"))
      .rejects.toMatchObject({ code: "fetch_failed" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: "context:git-llm-wiki-read",
      providerId: "bipo-enterprise",
      branch: "main",
      outcome: "failed",
      diagnosticCode: "fetch_failed",
    }));
    expect(audit.mock.calls[0]?.[0]).not.toHaveProperty("revision");
    expect(JSON.stringify(audit.mock.calls)).not.toContain(secret);
  });

  it("forces a C locale so missing branches receive a stable diagnostic", async () => {
    const fake = successfulGit();
    const runGit: GitLlmWikiCommandRunner = vi.fn(async (args, cwd, options) => {
      if (args.slice(12)[0] === "fetch") {
        const env = (options as GitExecutionOptions & { readonly env?: Readonly<Record<string, string>> }).env;
        return env?.["LC_ALL"] === "C"
          ? { code: 128, stdout: "", stderr: "fatal: couldn't find remote ref main" }
          : { code: 128, stdout: "", stderr: "fatal: 远程分支不存在" };
      }
      return fake.runGit(args, cwd, options);
    });

    await expect(withFreshGitLlmWikiRead({ rollHome: sandbox(), provider: provider(), runGit }, async () => "unreachable"))
      .rejects.toMatchObject({ code: "branch_not_found" });
    expect(runGit).toHaveBeenCalledWith(expect.any(Array), expect.anything(), expect.objectContaining({
      env: expect.objectContaining({ LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0" }),
    }));
  });

  it.each([
    ["abbreviated revision", "0123456", "commit"],
    ["non-commit revision", REVISION, "blob"],
  ])("rejects %s before the fixed-SHA callback", async (_label, revision, objectType) => {
    const rollHome = sandbox();
    const fake = successfulGit();
    const runGit: GitLlmWikiCommandRunner = vi.fn(async (args, cwd, options) => {
      const operation = args.slice(12);
      if (operation[0] === "rev-parse" && operation[1] === "--verify") {
        return { code: 0, stdout: `${revision}\n`, stderr: "" };
      }
      if (operation[0] === "cat-file") return { code: 0, stdout: `${objectType}\n`, stderr: "" };
      return fake.runGit(args, cwd, options);
    });
    const readCached = vi.fn(async () => "stale");
    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit }, readCached))
      .rejects.toMatchObject({ code: "revision_missing" });
    expect(readCached).not.toHaveBeenCalled();
  });

  it("never invokes checkout, hook execution or submodule update Git operations", async () => {
    const fake = successfulGit();
    await withFreshGitLlmWikiRead({ rollHome: sandbox(), provider: provider(), runGit: fake.runGit }, async () => "ok");
    const operationText = fake.calls.map((call) => call.args.slice(12).join(" ")).join("\n");
    expect(operationText).not.toMatch(/(?:^|\s)checkout(?:\s|$)/u);
    expect(operationText).not.toMatch(/submodule\s+(?:update|init)/u);
    expect(operationText).not.toMatch(/(?:^|\s)hook(?:\s|$)/u);
  });
});
