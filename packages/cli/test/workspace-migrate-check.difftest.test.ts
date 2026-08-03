import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planHistoricalWorkspaceMigration } from "@roll/core";
import {
  parseHistoricalMigrationFacts,
  type HistoricalMigrationFacts,
} from "@roll/spec";
import { workspaceMigrateCommand } from "../src/commands/workspace-migrate.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ENV_KEYS = ["ROLL_HOME", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"] as const;

function facts(overrides: Partial<HistoricalMigrationFacts> = {}): HistoricalMigrationFacts {
  const raw = {
    schema: "roll.workspace-migration-facts/v1",
    sourceRoot: "/fixture/repo",
    repoId: "repo-ab12cd34ef56",
    git: {
      head: "1".repeat(40),
      state: "clean",
      dirtyPaths: [],
      operation: "none",
      remote: {
        kind: "verified",
        normalizedRemote: "ssh://git.example.test/team/product",
        defaultBranch: "main",
        defaultTip: "1".repeat(40),
        headReachable: true,
        defaultTipPresentLocally: true,
      },
    },
    linkedWorktrees: [],
    submodules: [],
    runtime: { activeCycleIds: [], activeStoryLeases: [] },
    rollOwnership: { kind: "ordinary" },
    rollInventory: [{
      kind: "file",
      path: "backlog.md",
      digest: "b".repeat(64),
      bytes: 10,
      sourceClass: "backlog",
    }],
    cache: { status: "absent", repoId: "repo-ab12cd34ef56", cachePath: "repos/repo-ab12cd34ef56.git" },
    registry: { status: "available", workspaceId: "ws-ab12cd34ef56" },
    ...overrides,
  };
  const parsed = parseHistoricalMigrationFacts(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

async function run(input: HistoricalMigrationFacts, args: string[], language: "en" | "zh" = "en"): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["ROLL_HOME"] = "/fixture/roll-home";
  process.env["ROLL_LANG"] = language;
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
    const status = await workspaceMigrateCommand(args, {
      collectFacts: async () => input,
      plan: planHistoricalWorkspaceMigration,
      apply: async () => { throw new Error("unexpected apply"); },
      rollback: () => { throw new Error("unexpected rollback"); },
    });
    return { status, stdout, stderr };
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

describe("US-WS-019b migration check CLI contract", () => {
  it("freezes ready output in one locale at a time", async () => {
    const args = ["--from", "/fixture/repo", "--check"];
    const en = await run(facts(), args, "en");
    const zh = await run(facts(), args, "zh");

    expect(en.status).toBe(0);
    expect(zh.status).toBe(0);
    expectNoAdjacentBilingualPairs(en.stdout);
    expectNoAdjacentBilingualPairs(zh.stdout);
    expect({ en, zh }).toMatchSnapshot();
  });

  it("freezes dirty, unpushed and in-flight safety blocks with exit code 2", async () => {
    const base = facts();
    const dirty = await run(facts({ git: { ...base.git, state: "dirty", dirtyPaths: ["src/wip.ts"] } }), ["--from", "/fixture/repo", "--check"]);
    const unpushed = await run(facts({
      git: {
        ...base.git,
        remote: {
          kind: "blocked",
          code: "head_unpushed",
          normalizedRemote: "ssh://git.example.test/team/product",
          defaultBranch: "main",
          defaultTip: "2".repeat(40),
        },
      },
    }), ["--from", "/fixture/repo", "--check"]);
    const inFlight = await run(facts({ git: { ...base.git, state: "in_flight", operation: "rebase" } }), ["--from", "/fixture/repo", "--check"]);

    expect([dirty.status, unpushed.status, inFlight.status]).toEqual([2, 2, 2]);
    expect({ dirty, unpushed, inFlight }).toMatchSnapshot();
  });

  it("freezes symlink and unverifiable remote blocks", async () => {
    const base = facts();
    const symlink = await run(facts({
      rollInventory: [...base.rollInventory, { kind: "symlink", path: "features/current", target: "/private/secret" }],
    }), ["--from", "/fixture/repo", "--check"], "zh");
    const remote = await run(facts({
      git: {
        ...base.git,
        remote: {
          kind: "blocked",
          code: "remote_truth_unverifiable",
          normalizedRemote: "ssh://git.example.test/team/product",
          defaultBranch: "main",
          defaultTip: "2".repeat(40),
        },
      },
    }), ["--from", "/fixture/repo", "--check"], "zh");

    expect([symlink.status, remote.status]).toEqual([2, 2]);
    expect({ symlink, remote }).toMatchSnapshot();
  });

  it("freezes product cutover and independent metadata handoff", async () => {
    const cutover = await run(facts({
      rollOwnership: { kind: "product_tracked", trackedPaths: ["backlog.md"] },
    }), ["--from", "/fixture/repo", "--check"]);
    const handoff = await run(facts({
      rollOwnership: {
        kind: "independent_git",
        gitdirToken: ".roll/.git",
        topLevelToken: ".roll",
        state: "clean",
        head: "4".repeat(40),
        branch: "main",
        upstream: "origin/main",
        normalizedRemote: "ssh://git.example.test/team/roll-meta",
      },
    }), ["--from", "/fixture/repo", "--check"], "zh");

    expect([cutover.status, handoff.status]).toEqual([0, 0]);
    expect(handoff.stdout).toContain("不会 link、commit 或 push");
    expect({ cutover, handoff }).toMatchSnapshot();
  });

  it("emits the complete byte-stable JSON plan and honors an explicit Workspace ID", async () => {
    const input = facts({
      requestedWorkspaceId: "ws-explicit",
      registry: { status: "available", workspaceId: "ws-explicit" },
    });
    const args = ["--from", "/fixture/repo", "--workspace", "ws-explicit", "--check", "--json"];
    const first = await run(input, args);
    const second = await run(input, args);
    const expected = planHistoricalWorkspaceMigration(input);

    expect(first).toEqual(second);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(expected);
    expect(first.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(first.stderr).toBe("");
    expect(first).toMatchSnapshot();
  });

  it("rejects anything except the explicit check-only grammar without collecting", async () => {
    const previousLang = process.env["ROLL_LANG"];
    process.env["ROLL_LANG"] = "en";
    let collected = 0;
    let stderr = "";
    const realErr = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test capture
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderr += String(chunk);
      return true;
    };
    let status: number;
    try {
      status = await workspaceMigrateCommand(["--from", resolve("/fixture/repo")], {
        collectFacts: async () => {
          collected += 1;
          return facts();
        },
        plan: planHistoricalWorkspaceMigration,
        apply: async () => { throw new Error("unexpected apply"); },
        rollback: () => { throw new Error("unexpected rollback"); },
      });
    } finally {
      process.stderr.write = realErr;
      if (previousLang === undefined) delete process.env["ROLL_LANG"];
      else process.env["ROLL_LANG"] = previousLang;
    }

    expect(status).toBe(1);
    expect(collected).toBe(0);
    expect(stderr).toContain("workspace migrate: invalid_arguments");
  });
});
