import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitResult } from "../../src/git.js";
import { acquireLock, readLockOwner, releaseLock } from "../../src/process.js";
import { resolveContextCacheIdentity } from "../../src/context/context-cache.js";
import {
  withFreshGitLlmWikiRead,
  type GitLlmWikiCommandRunner,
} from "../../src/context/git-llm-wiki-transport.js";

const sandboxes: string[] = [];
const REVISION = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-context-concurrency-"));
  sandboxes.push(root);
  return root;
}

function provider(id = "bipo-enterprise") {
  return {
    id,
    type: "git_llm_wiki" as const,
    enabled: true,
    remote: `https://example.test/team/${id}`,
    branch: "main",
    fetch_timeout_seconds: 5,
  };
}

function successfulGit(): GitLlmWikiCommandRunner {
  return vi.fn(async (args, cwd): Promise<GitResult> => {
    const operation = args.slice(12);
    if (operation[0] === "init") {
      const target = operation.at(-1);
      if (target !== undefined) mkdirSync(target, { recursive: true });
    }
    if (operation[0] === "rev-parse" && operation[1] === "--is-bare-repository") {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    if (operation[0] === "remote" && operation[1] === "get-url") {
      const id = /([^/]+?)(?:\.git|\.creating)$/u.exec(cwd ?? "")?.[1] ?? "bipo-enterprise";
      return { code: 0, stdout: `https://example.test/team/${id}\n`, stderr: "" };
    }
    if (operation[0] === "rev-parse" && operation[1] === "--verify") {
      return { code: 0, stdout: `${REVISION}\n`, stderr: "" };
    }
    if (operation[0] === "cat-file") return { code: 0, stdout: "commit\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Git LLM Wiki provider read lease", () => {
  it("serializes the full callback for the same Provider", async () => {
    const rollHome = sandbox();
    const order: string[] = [];
    const runGit = successfulGit();
    const read = (name: string) => withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit }, async () => {
      order.push(`${name}:start`);
      await delay(25);
      order.push(`${name}:end`);
      return name;
    });

    await Promise.all([read("a"), read("b")]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("allows different Providers to hold their read leases concurrently", async () => {
    const rollHome = sandbox();
    const runGit = successfulGit();
    let started = 0;
    let releaseBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const read = (id: string) => withFreshGitLlmWikiRead({ rollHome, provider: provider(id), runGit }, async () => {
      started += 1;
      if (started === 2) releaseBoth?.();
      await bothStarted;
      return id;
    });

    await Promise.all([read("bipo-enterprise"), read("platform-handbook")]);
    expect(started).toBe(2);
  });

  it("holds the provider lock through the fixed-revision callback and releases it in finally", async () => {
    const rollHome = sandbox();
    const identity = resolveContextCacheIdentity({ rollHome, provider: provider() });
    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit: successfulGit() }, async () => {
      expect(readLockOwner(identity.lockPath)).toMatchObject({ pid: process.pid });
      throw new Error("validation failed");
    })).rejects.toThrow("validation failed");
    expect(readLockOwner(identity.lockPath)).toBeUndefined();

    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit: successfulGit() }, async () => "recovered"))
      .resolves.toMatchObject({ value: "recovered" });
  });

  it("returns context_lock_timeout without stealing a live existing owner", async () => {
    const rollHome = sandbox();
    const identity = resolveContextCacheIdentity({ rollHome, provider: provider() });
    expect(acquireLock(identity.lockPath, process.pid, {
      cycleId: "existing-reader",
      staleSec: Number.POSITIVE_INFINITY,
      unparseableIsHeld: true,
    }).acquired).toBe(true);
    try {
      await expect(withFreshGitLlmWikiRead({
        rollHome,
        provider: provider(),
        runGit: successfulGit(),
        lockTimeoutMs: 5,
        lockRetryMs: 1,
      }, async () => "unreachable")).rejects.toMatchObject({ code: "context_lock_timeout" });
      expect(readLockOwner(identity.lockPath)).toMatchObject({ cycleId: "existing-reader" });
    } finally {
      releaseLock(identity.lockPath);
    }
  });

  it("releases the provider lock after a fetch timeout", async () => {
    const rollHome = sandbox();
    const identity = resolveContextCacheIdentity({ rollHome, provider: provider() });
    const base = successfulGit();
    const runGit: GitLlmWikiCommandRunner = vi.fn(async (args, cwd, options) => {
      if (args.slice(12)[0] === "fetch") {
        return { code: 1, stdout: "", stderr: "credential-bearing detail", timedOut: true };
      }
      return base(args, cwd, options);
    });

    await expect(withFreshGitLlmWikiRead({ rollHome, provider: provider(), runGit }, async () => "unreachable"))
      .rejects.toMatchObject({ code: "fetch_timeout" });
    expect(readLockOwner(identity.lockPath)).toBeUndefined();
  });
});
