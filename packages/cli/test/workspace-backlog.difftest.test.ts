import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPOSITORY_BINDING_V1, WORKSPACE_MANIFEST_V1, repositoryIdFromRemote } from "@roll/spec";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const sandboxes: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_WORKSPACE", "ROLL_SYNC_FIXTURE", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"] as const;

function fixture(): { readonly home: string; readonly rollHome: string } {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-backlog-"));
  sandboxes.push(home);
  const rollHome = join(home, ".roll");
  mkdirSync(rollHome, { recursive: true });
  return { home, rollHome };
}

function createWorkspace(root: string, workspaceId: string): string {
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
  })}\n`);
  mkdirSync(join(root, "backlog", "epic", "feature", "US-1"), { recursive: true });
  writeFileSync(join(root, "backlog", "epic", "feature", "US-1", "spec.md"), `# US-1 ${workspaceId} contract\n`);
  writeFileSync(
    join(root, "backlog", "index.md"),
    `| Story | Description | Status |\n|---|---|---|\n| [US-1](epic/feature/US-1/spec.md) | ${workspaceId} story | 📋 Todo |\n`,
  );
  return root;
}

async function runCli(
  argv: string[],
  f: { readonly home: string; readonly rollHome: string },
  options: { readonly lang?: "en" | "zh"; readonly cwd?: string; readonly workspaceEnv?: string; readonly syncFixture?: string } = {},
): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = options.lang ?? "en";
  process.env["NO_COLOR"] = "1";
  if (options.workspaceEnv !== undefined) process.env["ROLL_WORKSPACE"] = options.workspaceEnv;
  if (options.syncFixture !== undefined) process.env["ROLL_SYNC_FIXTURE"] = options.syncFixture;
  const previousCwd = process.cwd();
  if (options.cwd !== undefined) process.chdir(options.cwd);
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
  // @ts-expect-error test capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => (stderr += String(chunk), true);
  try {
    const result = await dispatch(argv, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(previousCwd);
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function registerActive(f: { readonly home: string; readonly rollHome: string }, id: string, root: string): Promise<void> {
  expect((await runCli(["workspace", "register", id, root], f)).status).toBe(0);
  expect((await runCli(["workspace", "activate", id], f)).status).toBe(0);
}

function scrub(run: Run, roots: readonly string[]): Run {
  const replace = (value: string): string => roots.reduce((text, root, index) => {
    const canonical = realpathSync(root);
    return text.replaceAll(canonical, `<WS_${index + 1}>`).replaceAll(root, `<WS_${index + 1}>`);
  }, value);
  return { ...run, stdout: replace(run.stdout), stderr: replace(run.stderr) };
}

function treeState(root: string, relative = ""): readonly string[] {
  const path = relative === "" ? root : join(root, relative);
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) {
    return [`F ${relative} ${readFileSync(path, "utf8")}`];
  }
  const rows = relative === "" ? [] : [`D ${relative}`];
  for (const name of readdirSync(path).sort()) {
    rows.push(...treeState(root, relative === "" ? name : join(relative, name)));
  }
  return rows;
}

beforeEach(() => registerAll());

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("US-WS-009 Workspace backlog reads", () => {
  it("resolves by id and absolute path and shows the selected Workspace Story contract", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);

    const byId = await runCli(["backlog", "--workspace", "ws-alpha"], f);
    const byAlias = await runCli(["backlog", "--ws", "ws-alpha"], f);
    const byPath = await runCli(["backlog", "--workspace", beta], f);
    const showAlpha = await runCli(["backlog", "show", "US-1", "--workspace", "ws-alpha"], f);
    const showBeta = await runCli(["backlog", "show", "US-1", "--workspace", "ws-beta"], f);

    expect(byId.stdout).toContain("ws-alpha story");
    expect(byAlias).toEqual(byId);
    expect(byId.stdout).not.toContain("ws-beta story");
    expect(byPath.stdout).toContain("ws-beta story");
    expect(showAlpha.stdout).toContain("# US-1 ws-alpha contract");
    expect(showBeta.stdout).toContain("# US-1 ws-beta contract");
  });

  it("fails loud for multiple active ambiguity and conflicting explicit/env/cwd targets", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);

    // Pin cwd outside any git/.roll tree: from inside the roll repo itself the
    // cwd probe legitimately answers migration_required before ambiguity.
    const ambiguous = await runCli(["backlog"], f, { cwd: f.home });
    const conflict = await runCli(["backlog", "--workspace", "ws-alpha"], f, {
      cwd: beta,
      workspaceEnv: "ws-beta",
    });
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain("target_missing");
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("conflicting_candidates");
  });

  it("resolves an Issue cwd and renders Workspace identity on every aggregate Story row", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);
    const issueCwd = join(alpha, "issues", "US-1", "repo-a", "src");
    mkdirSync(issueCwd, { recursive: true });
    writeFileSync(join(alpha, "issues", "US-1", "completion.md"), "Delivered and merged\n");

    const issue = await runCli(["backlog"], f, { cwd: issueCwd });
    const aggregate = await runCli(["backlog", "--all"], f);
    expect(issue.stdout).toContain("ws-alpha story");
    const storyRows = aggregate.stdout.split("\n").filter((line) => line.includes("US-1"));
    expect(storyRows).toHaveLength(2);
    expect(storyRows.every((line) => line.includes("ws-alpha") || line.includes("ws-beta"))).toBe(true);
    expect(storyRows.find((line) => line.includes("ws-alpha"))).toContain("📋 Todo");
  });

  it("freezes English and Chinese read/show/all output", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);
    const en = {
      help: scrub(await runCli(["backlog", "--help"], f, { lang: "en" }), [alpha, beta]),
      read: scrub(await runCli(["backlog", "--workspace", "ws-alpha"], f, { lang: "en" }), [alpha, beta]),
      show: scrub(await runCli(["backlog", "show", "US-1", "--workspace", "ws-alpha"], f, { lang: "en" }), [alpha, beta]),
      all: scrub(await runCli(["backlog", "--all"], f, { lang: "en" }), [alpha, beta]),
    };
    const zh = {
      help: scrub(await runCli(["backlog", "--help"], f, { lang: "zh" }), [alpha, beta]),
      read: scrub(await runCli(["backlog", "--workspace", "ws-alpha"], f, { lang: "zh" }), [alpha, beta]),
      show: scrub(await runCli(["backlog", "show", "US-1", "--workspace", "ws-alpha"], f, { lang: "zh" }), [alpha, beta]),
      all: scrub(await runCli(["backlog", "--all"], f, { lang: "zh" }), [alpha, beta]),
    };
    expectNoAdjacentBilingualPairs(en.help.stdout);
    expectNoAdjacentBilingualPairs(zh.help.stdout);
    expectNoAdjacentBilingualPairs(en.read.stdout.split("\n", 1)[0] ?? "");
    expectNoAdjacentBilingualPairs(zh.read.stdout.split("\n", 1)[0] ?? "");
    expectNoAdjacentBilingualPairs(en.show.stdout);
    expectNoAdjacentBilingualPairs(zh.show.stdout);
    expectNoAdjacentBilingualPairs(en.all.stdout);
    expectNoAdjacentBilingualPairs(zh.all.stdout);
    expect({ en, zh }).toMatchSnapshot();
  });

  it("prints the exact migration check from a nested legacy cwd without writing the legacy backlog", async () => {
    const f = fixture();
    const legacy = mkdtempSync(join(tmpdir(), "roll-legacy repo-"));
    sandboxes.push(legacy);
    mkdirSync(join(legacy, ".git"));
    mkdirSync(join(legacy, ".roll"));
    const backlogPath = join(legacy, ".roll", "backlog.md");
    writeFileSync(backlogPath, "legacy\n");
    const nested = join(legacy, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const before = readFileSync(backlogPath, "utf8");

    const result = await runCli(["backlog"], f, { cwd: nested });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`roll workspace migrate --from '${realpathSync(legacy)}' --check`);
    expect(readFileSync(backlogPath, "utf8")).toBe(before);
  });

  it("scopes status, claim, lint, and unstick side effects to exactly one Workspace", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);
    const alphaBefore = treeState(alpha);

    const blocked = await runCli(["backlog", "block", "US-1", "waiting", "--workspace", "ws-beta"], f);
    expect(blocked.status).toBe(0);
    expect(blocked.stdout).toContain(`Backlog ws-beta (${realpathSync(beta)})`);
    expect(readFileSync(join(beta, "backlog", "index.md"), "utf8")).toContain("🔒 Blocked [waiting]");

    const promoted = await runCli(["backlog", "promote", "US-1", "--workspace", beta], f);
    expect(promoted.status).toBe(0);
    const issueCwd = join(beta, "issues", "US-1", "repo-a", "src");
    mkdirSync(issueCwd, { recursive: true });
    const claimed = await runCli(["backlog", "claim", "US-1"], f, { cwd: issueCwd });
    expect(claimed.status).toBe(0);
    expect(readFileSync(join(beta, "runtime", "locks", "leases", "US-1.lease"), "utf8")).toContain('"source":"human"');
    expect(existsSync(join(alpha, "runtime", "locks", "leases", "US-1.lease"))).toBe(false);

    const linted = await runCli(["backlog", "lint", "--workspace", "ws-beta"], f);
    expect(linted.status).toBe(0);
    expect(linted.stdout).toContain(`Backlog ws-beta (${realpathSync(beta)})`);

    writeFileSync(
      join(beta, "runtime", "events.ndjson"),
      `${JSON.stringify({ stage: "pick_todo", detail: "US-1", label: "cycle-1", ts: "2020-01-01T00:00:00Z" })}\n` +
        `${JSON.stringify({ stage: "cycle_end", label: "cycle-1", outcome: "failed", ts: "2020-01-01T01:00:00Z" })}\n`,
    );
    const unstuck = await runCli(["backlog", "unstick", "--workspace", "ws-beta"], f);
    expect(unstuck.status).toBe(0);
    expect(readFileSync(join(beta, "backlog", "index.md"), "utf8")).toContain("📋 Todo");
    expect(readFileSync(join(beta, "runtime", "alerts", "unstick.md"), "utf8")).toContain("unstick: reverted US-1");
    expect(treeState(alpha)).toEqual(alphaBefore);
  });

  it("rejects aggregate management mutations and legacy path overrides without writing", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);
    const before = treeState(f.home);
    const aggregateCommands = [
      ["backlog", "block", "US-1", "reason", "--all"],
      ["backlog", "defer", "US-1", "reason", "--all"],
      ["backlog", "unblock", "US-1", "--all"],
      ["backlog", "promote", "US-1", "--all"],
      ["backlog", "claim", "US-1", "--all"],
      ["backlog", "unstick", "--all"],
      ["backlog", "sync", "--repo", "acme/widgets", "--all"],
    ];
    for (const command of aggregateCommands) {
      const result = await runCli(command, f);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("all_requires_readonly");
      expect(treeState(f.home)).toEqual(before);
    }

    const outside = join(f.home, "outside.md");
    writeFileSync(outside, "outside sentinel\n");
    const overrideBefore = treeState(f.home);
    expect((await runCli(["backlog", "unstick", "--workspace", "ws-alpha", "--backlog", outside], f)).status).toBe(1);
    expect((await runCli(["backlog", "lint", outside, "--workspace", "ws-alpha"], f)).status).toBe(1);
    expect((await runCli(["backlog", "sync", "--workspace", "ws-alpha", "--repo", "a/b", "--backlog", outside], f)).status).toBe(1);
    expect((await runCli(["backlog", "sync", "--workspace", "ws-alpha", "--repo", "a/b", "--features", join(f.home, "outside-features")], f)).status).toBe(1);
    expect((await runCli(["backlog", "sync", "--workspace", "ws-alpha", "--repo", "a/b", "--local-yaml", join(f.home, "outside.yaml")], f)).status).toBe(1);
    expect(treeState(f.home)).toEqual(overrideBefore);
  });

  it("fails conflicting and legacy mutation scope before any write", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);
    const conflictBefore = treeState(f.home);
    const conflict = await runCli(["backlog", "block", "US-1", "--workspace", "ws-alpha"], f, {
      cwd: beta,
      workspaceEnv: "ws-beta",
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("conflicting_candidates");
    expect(treeState(f.home)).toEqual(conflictBefore);

    const legacy = mkdtempSync(join(tmpdir(), "roll-legacy mutation-"));
    sandboxes.push(legacy);
    mkdirSync(join(legacy, ".git"));
    mkdirSync(join(legacy, ".roll"));
    writeFileSync(join(legacy, ".roll", "backlog.md"), "legacy sentinel\n");
    const nested = join(legacy, "src");
    mkdirSync(nested);
    const legacyBefore = treeState(legacy);
    const migration = await runCli(["backlog", "block", "US-1"], fixture(), { cwd: nested });
    expect(migration.status).toBe(1);
    expect(migration.stderr).toContain("migration_required");
    expect(migration.stderr).toContain(`roll workspace migrate --from '${realpathSync(legacy)}' --check`);
    expect(treeState(legacy)).toEqual(legacyBefore);
  });

  it("syncs one Workspace with canonical planning identity and can show the generated contract", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    const beta = createWorkspace(join(f.home, "beta"), "ws-beta");
    await registerActive(f, "ws-alpha", alpha);
    await registerActive(f, "ws-beta", beta);
    const alphaBefore = treeState(alpha);
    const issueFixture = join(f.home, "issues.json");
    writeFileSync(issueFixture, `${JSON.stringify([{
      number: 7,
      title: "closed bug remains planning work",
      state: "closed",
      labels: [{ name: "bug" }],
      body: "- [ ] verify workspace scope",
    }])}\n`);

    const synced = await runCli(
      ["backlog", "sync", "--workspace", "ws-beta", "--repo", "acme/widgets"],
      f,
      { syncFixture: issueFixture },
    );
    expect(synced.status).toBe(0);
    expect(synced.stdout).toContain(`Backlog ws-beta (${realpathSync(beta)})`);
    const betaBacklog = readFileSync(join(beta, "backlog", "index.md"), "utf8");
    expect(betaBacklog).toContain("[FIX-GH-7](backlog-lifecycle/FIX-GH-7/spec.md)");
    expect(betaBacklog).toContain("📋 Todo");
    expect(betaBacklog).not.toContain("✅ Done");
    expect(readFileSync(join(beta, "runtime", "backlog-sync.yaml"), "utf8")).toContain("repo: acme/widgets");
    expect(treeState(alpha)).toEqual(alphaBefore);

    const shown = await runCli(["backlog", "show", "FIX-GH-7", "--workspace", "ws-beta"], f);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("# FIX-GH-7 closed bug remains planning work");
    expect(shown.stdout).toContain("- [ ] verify workspace scope");
  });

  it("rejects management mutations whose Workspace paths escape through symlinks", async () => {
    const f = fixture();
    const alpha = createWorkspace(join(f.home, "alpha"), "ws-alpha");
    await registerActive(f, "ws-alpha", alpha);
    const externalBacklog = mkdtempSync(join(tmpdir(), "workspace-backlog-external-"));
    sandboxes.push(externalBacklog);
    writeFileSync(join(externalBacklog, "index.md"), "| Story | Description | Status |\n|---|---|---|\n| US-1 | outside | 📋 Todo |\n");
    rmSync(join(alpha, "backlog"), { recursive: true, force: true });
    symlinkSync(externalBacklog, join(alpha, "backlog"), "dir");
    const outsideBefore = treeState(externalBacklog);

    const read = await runCli(["backlog", "--workspace", "ws-alpha"], f);
    expect(read.status).toBe(1);
    expect(read.stderr).toContain("invalid_target");
    const blocked = await runCli(["backlog", "block", "US-1", "--workspace", "ws-alpha"], f);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("invalid_target");
    expect(treeState(externalBacklog)).toEqual(outsideBefore);
  });
});
