import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryIdFromRemote } from "@roll/spec";
import { claimStoryLease, readLeases } from "@roll/core";
import { nodePorts, type RunnerPaths } from "../src/runner/index.js";
import { executeSetupCommand } from "../src/runner/setup-handlers.js";
import { executeTerminalCommand } from "../src/runner/terminal-handlers.js";
import { resolveStoryLeasePath } from "../src/runner/story-lease-path.js";
import { repositoryAgentWritableRoots } from "../src/runner/worktree-bootstrap.js";

function leaseRecordPath(paths: RunnerPaths, storyId: string): string {
  if (paths.storyLeasePath === undefined) throw new Error("fixture requires storyLeasePath");
  return join(paths.storyLeasePath, `${storyId}.lease`);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function materializeRemote(source: string, remote: string): void {
  mkdirSync(source, { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), `${source}\n`, "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  mkdirSync(dirname(remote), { recursive: true });
  git(dirname(remote), ["clone", "-q", "--bare", source, remote]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-multi-repo-worktree-"));
  const rollHome = join(root, "roll-home");
  const workspace = join(root, "workspace");
  const storyId = "US-WS-011";
  const remotes = ["sot", "docs"].map((alias) => {
    const remotePath = join(root, "remotes", `${alias}.git`);
    materializeRemote(join(root, "sources", alias), remotePath);
    const remote = `file://${remotePath}`;
    const repoId = repositoryIdFromRemote(remote);
    if (!repoId.ok) throw new Error("fixture remote must be canonical");
    return { alias, remote, remotePath, repoId: repoId.value };
  });
  mkdirSync(join(workspace, "backlog", "workspace-orchestration", storyId), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-alpha",
    displayName: "Workspace Alpha",
    createdAt: "2026-07-22T00:00:00.000Z",
    requirements: [],
    repositories: remotes.map((repository) => ({
      schema: "roll.repository-binding/v1",
      repoId: repository.repoId,
      alias: repository.alias,
      remote: repository.remote,
      integrationBranch: "main",
      provider: "github",
      workflow: {
        branchPattern: "roll/{workspace_id}/{story_id}/{repo_alias}",
        requiredChecks: [],
      },
    })),
  }, null, 2)}\n`);
  writeFileSync(join(workspace, "backlog", "index.md"), `| Story | Description | Status |\n|---|---|---|\n| ${storyId} | fixture | 📋 Todo |\n`);
  writeFileSync(join(workspace, "backlog", "workspace-orchestration", storyId, "spec.md"), `---
id: ${storyId}
repositories:
  - alias: sot
    access: write
    required_delivery: true
  - alias: docs
    access: read
---

# ${storyId} fixture
`);
  const runtime = join(workspace, "runtime");
  const paths: RunnerPaths = {
    eventsPath: join(runtime, "events.ndjson"),
    runsPath: join(runtime, "runs.jsonl"),
    alertsPath: join(runtime, "alerts.log"),
    lockPath: join(runtime, "cycle.lock"),
    heartbeatPath: join(runtime, "heartbeat"),
    worktreePath: join(runtime, "legacy-worktree"),
    storyLeasePath: join(runtime, "locks", "leases"),
  };
  return { workspace, rollHome, storyId, paths, remotes };
}

/** Build two independent Workspace roots that SHARE one bare remote cache
 *  (same remote URL ⇒ same repoId ⇒ same machine cache under one ROLL_HOME). */
function sharedCacheFixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-shared-cache-worktree-"));
  const rollHome = join(root, "roll-home");
  const storyId = "US-WS-011";
  const remotePath = join(root, "remotes", "sot.git");
  materializeRemote(join(root, "sources", "sot"), remotePath);
  const remote = `file://${remotePath}`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must be canonical");
  const buildWorkspace = (workspaceId: string) => {
    const workspace = join(root, workspaceId);
    mkdirSync(join(workspace, "backlog", "workspace-orchestration", storyId), { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), `${JSON.stringify({
      schema: "roll.workspace/v1",
      workspaceId,
      displayName: workspaceId,
      createdAt: "2026-07-22T00:00:00.000Z",
      requirements: [],
      repositories: [{
        schema: "roll.repository-binding/v1",
        repoId: repoId.value,
        alias: "sot",
        remote,
        integrationBranch: "main",
        provider: "github",
        workflow: {
          branchPattern: "roll/{workspace_id}/{story_id}/{repo_alias}",
          requiredChecks: [],
        },
      }],
    }, null, 2)}\n`);
    writeFileSync(join(workspace, "backlog", "index.md"), `| Story | Description | Status |\n|---|---|---|\n| ${storyId} | fixture | 📋 Todo |\n`);
    writeFileSync(join(workspace, "backlog", "workspace-orchestration", storyId, "spec.md"), `---
id: ${storyId}
repositories:
  - alias: sot
    access: write
    required_delivery: true
---

# ${storyId} fixture
`);
    const runtime = join(workspace, "runtime");
    const paths: RunnerPaths = {
      eventsPath: join(runtime, "events.ndjson"),
      runsPath: join(runtime, "runs.jsonl"),
      alertsPath: join(runtime, "alerts.log"),
      lockPath: join(runtime, "cycle.lock"),
      heartbeatPath: join(runtime, "heartbeat"),
      worktreePath: join(runtime, "legacy-worktree"),
      storyLeasePath: join(runtime, "locks", "leases"),
    };
    return { workspaceId, workspace, paths };
  };
  return {
    rollHome,
    storyId,
    alpha: buildWorkspace("ws-alpha"),
    beta: buildWorkspace("ws-beta"),
    // Mint any number of extra Workspaces that all share the SAME remote cache,
    // so a test can drive N-way concurrent preparation (a stronger regression
    // tripwire for the repoId serialization lock than a single 2-way race).
    build: buildWorkspace,
  };
}

describe("US-WS-011 Workspace repository preparation", () => {
  it("prepares one transaction for every repository leg and resolves the durable execution map", async () => {
    const f = fixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const ports = nodePorts({
        repoCwd: f.workspace,
        paths: f.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      const prepared = await ports.repositories?.prepare({ storyId: f.storyId, cycleId: "cycle-11" });
      expect(prepared).toEqual({ kind: "prepared", outcome: "created" });
      const execution = await ports.repositories?.resolve(f.storyId);
      expect(execution?.workspaceId).toBe("ws-alpha");
      expect(Object.values(execution?.repositories ?? {}).map((entry) => [entry.alias, entry.access])).toEqual([
        ["sot", "write"],
        ["docs", "read"],
      ]);

      const firstHeads = Object.fromEntries(Object.values(execution?.repositories ?? {}).map((entry) => [
        entry.repoId,
        { path: realpathSync(entry.worktreePath), headSha: entry.headSha },
      ]));
      renameSync(
        join(f.workspace, "backlog", "workspace-orchestration", f.storyId, "spec.md"),
        join(f.workspace, "backlog", "workspace-orchestration", f.storyId, "spec.md.removed"),
      );
      const resumed = await ports.repositories?.prepare({ storyId: f.storyId, cycleId: "cycle-12" });
      expect(resumed).toEqual({ kind: "prepared", outcome: "reused" });
      const resumedExecution = await ports.repositories?.resolve(f.storyId);
      expect(Object.fromEntries(Object.values(resumedExecution?.repositories ?? {}).map((entry) => [
        entry.repoId,
        { path: realpathSync(entry.worktreePath), headSha: entry.headSha },
      ]))).toEqual(firstHeads);
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("grants Builder writes only to writable worktrees, their git stores and Issue-owned runtime directories", async () => {
    const f = fixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const ports = nodePorts({
        repoCwd: f.workspace,
        paths: f.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      await ports.repositories?.prepare({ storyId: f.storyId, cycleId: "cycle-sandbox" });
      const execution = await ports.repositories?.resolve(f.storyId);
      if (execution === undefined) throw new Error("repository execution must resolve");
      const writableRoots = repositoryAgentWritableRoots(execution);
      const writable = Object.values(execution.repositories).find((entry) => entry.access === "write");
      const readOnly = Object.values(execution.repositories).find((entry) => entry.access === "read");
      if (writable === undefined || readOnly === undefined) throw new Error("fixture access modes missing");
      const gitCommon = git(writable.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

      expect(writableRoots).toEqual([
        realpathSync(join(execution.issueRoot, "artifacts")),
        realpathSync(join(execution.issueRoot, "evidence")),
        realpathSync(join(execution.issueRoot, "runtime")),
        realpathSync(writable.worktreePath),
        realpathSync(gitCommon),
      ]);
      expect(writableRoots).not.toContain(realpathSync(readOnly.worktreePath));
      expect(writableRoots).not.toContain(execution.issueRoot);
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("fails typed and releases the Story lease when a resumed Issue's durable repository facts drift", async () => {
    const f = fixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const ports = nodePorts({
        repoCwd: f.workspace,
        paths: f.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      await ports.repositories?.prepare({ storyId: f.storyId, cycleId: "cycle-prime" });
      const issueRoot = join(f.workspace, "issues", f.storyId);
      const manifestPath = join(issueRoot, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        repositories: Array<{ repoId: string }>;
      };
      const first = manifest.repositories[0];
      if (first === undefined) throw new Error("fixture manifest must include a repository");
      first.repoId = "ffffffffffff";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const result = await executeSetupCommand({ kind: "pick_story" }, ports, {
        cycleId: "cycle-drift",
        branch: "loop/cycle-drift",
        loop: "main",
      });

      expect(result.event).toEqual({ type: "repository_setup_failed", storyId: f.storyId });
      expect(readFileSync(join(f.workspace, "backlog", "index.md"), "utf8")).toContain("📋 Todo");
      expect(existsSync(leaseRecordPath(f.paths, f.storyId))).toBe(false);
      expect(existsSync(join(issueRoot, "sot"))).toBe(true);
      const event = readFileSync(f.paths.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
      expect(event).toMatchObject({
        type: "workspace:issue_init_failed",
        workspaceId: "ws-alpha",
        storyId: f.storyId,
        cycleId: "cycle-drift",
        code: "unexpected",
        repairJournal: null,
      });
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("claims the Story lease, prepares every leg, then marks In Progress and returns the resolved map", async () => {
    const f = fixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const ports = nodePorts({
        repoCwd: f.workspace,
        paths: f.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      const repositories = ports.repositories;
      if (repositories === undefined) throw new Error("Workspace ports must exist");
      let leaseObservedBeforePrepare = false;
      ports.repositories = {
        ...repositories,
        async prepare(request) {
          const recordPath = leaseRecordPath(f.paths, f.storyId);
          leaseObservedBeforePrepare = existsSync(recordPath)
            && JSON.parse(readFileSync(recordPath, "utf8")).source === "cycle";
          expect(readFileSync(join(f.workspace, "backlog", "index.md"), "utf8")).toContain("📋 Todo");
          return repositories.prepare(request);
        },
      };

      const result = await executeSetupCommand({ kind: "pick_story" }, ports, {
        cycleId: "cycle-11",
        branch: "loop/cycle-11",
        loop: "main",
      });

      expect(leaseObservedBeforePrepare).toBe(true);
      expect(result.event?.type).toBe("story_picked");
      expect(result.event).toMatchObject({ storyId: f.storyId });
      expect(readFileSync(join(f.workspace, "backlog", "index.md"), "utf8")).toContain("🔨 In Progress");
      expect(realpathSync(join(f.workspace, "issues", f.storyId, "sot"))).toContain(`/issues/${f.storyId}/sot`);
      expect(realpathSync(join(f.workspace, "issues", f.storyId, "docs"))).toContain(`/issues/${f.storyId}/docs`);
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("fails before Builder routing, restores Todo and releases the Story lease when a later remote cannot prepare", async () => {
    const f = fixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    renameSync(f.remotes[1]!.remotePath, `${f.remotes[1]!.remotePath}.unavailable`);
    try {
      const ports = nodePorts({
        repoCwd: f.workspace,
        paths: f.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      const result = await executeSetupCommand({ kind: "pick_story" }, ports, {
        cycleId: "cycle-11-failed",
        branch: "loop/cycle-11-failed",
        loop: "main",
      });

      expect(result.event).toEqual({ type: "repository_setup_failed", storyId: f.storyId });
      expect(readFileSync(join(f.workspace, "backlog", "index.md"), "utf8")).toContain("📋 Todo");
      expect(existsSync(leaseRecordPath(f.paths, f.storyId))).toBe(false);
      expect(existsSync(join(f.workspace, "issues", f.storyId))).toBe(false);
      const event = readFileSync(f.paths.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
      expect(event).toMatchObject({
        type: "workspace:issue_init_failed",
        workspaceId: "ws-alpha",
        storyId: f.storyId,
        cycleId: "cycle-11-failed",
        code: "apply_failed",
        repairJournal: null,
      });
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("preserves the prepared Issue worktrees on signal/timeout teardown while releasing only the Cycle lease", async () => {
    const f = fixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const ports = nodePorts({
        repoCwd: f.workspace,
        paths: f.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      await ports.repositories?.prepare({ storyId: f.storyId, cycleId: "cycle-signal" });
      const execution = await ports.repositories?.resolve(f.storyId);
      if (execution === undefined) throw new Error("repository execution must resolve");
      // Stamp a live Cycle lease and leave unpushed work in the writable leg so
      // teardown must NOT touch it (only setup rollback / explicit reclamation may).
      const recordPath = leaseRecordPath(f.paths, f.storyId);
      mkdirSync(dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, `${JSON.stringify({ pid: process.pid, claimedAt: 1, source: "cycle" })}\n`);
      const writable = Object.values(execution.repositories).find((entry) => entry.access === "write");
      if (writable === undefined) throw new Error("fixture must expose a writable leg");
      writeFileSync(join(writable.worktreePath, "unpushed.txt"), "in-flight work\n", "utf8");

      const ctx = {
        cycleId: "cycle-signal",
        branch: "loop/cycle-signal",
        loop: "main" as const,
        storyId: f.storyId,
        repositoryExecution: execution,
      };
      // The signal/timeout terminal drives cleanup_worktree then append_run.
      const cleanup = await executeTerminalCommand({ kind: "cleanup_worktree", branch: ctx.branch }, ports, ctx);
      const bookkeeping = await executeTerminalCommand({
        kind: "append_run",
        status: "timeout",
        outcome: "timeout",
        cycleId: ctx.cycleId,
      }, ports, ctx);

      expect(cleanup).toEqual({});
      expect(bookkeeping).toEqual({});
      // Issue worktrees (both writable and read-only legs) survive on disk.
      for (const entry of Object.values(execution.repositories)) {
        expect(existsSync(entry.worktreePath)).toBe(true);
      }
      // The in-flight unpushed work is preserved, never removed by teardown.
      expect(readFileSync(join(writable.worktreePath, "unpushed.txt"), "utf8")).toBe("in-flight work\n");
      // Only the Cycle-owned lease is released (removeLease drops the file once
      // its last entry is gone, so an absent file also means "released").
      expect(existsSync(recordPath)).toBe(false);
      const alerts = readFileSync(f.paths.alertsPath, "utf8");
      // The teardown records the exact preserved Issue worktree facts so an
      // owner can recover the dirty/unpushed leg rather than seeing only a
      // generic "cleanup skipped" message.
      const preservedLine = alerts.split("\n").find((line) => line.startsWith("workspace_issue_worktrees_preserved: "));
      expect(preservedLine).toBeDefined();
      const preserved = JSON.parse(preservedLine?.slice("workspace_issue_worktrees_preserved: ".length) ?? "null") as {
        workspaceId: string;
        storyId: string;
        cycleId: string;
        repositories: Array<{
          repoId: string;
          alias: string;
          worktreePath: string;
          headSha: string;
          baseSha: string;
          dirty: boolean;
          commitsAheadBase: number;
        }>;
      };
      expect(preserved).toMatchObject({
        workspaceId: "ws-alpha",
        storyId: f.storyId,
        cycleId: "cycle-signal",
      });
      expect(preserved.repositories).toEqual(expect.arrayContaining([
        expect.objectContaining({
          repoId: writable.repoId,
          alias: writable.alias,
          worktreePath: realpathSync(writable.worktreePath),
          dirty: true,
          commitsAheadBase: 0,
        }),
      ]));
      expect(alerts).toContain(
        "workspace_repository_scope_required: cleanup_worktree",
      );
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("gives many concurrent Workspaces on one shared cache isolated worktrees and non-shared governed branches", async () => {
    const f = sharedCacheFixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const portsFor = (ws: { workspace: string; paths: RunnerPaths }) => nodePorts({
        repoCwd: ws.workspace,
        paths: ws.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });
      // Six Workspaces all sharing ONE remote cache (same repoId) prepare the
      // SAME story CONCURRENTLY. Six racers on one shared bare cache make the
      // `git worktree prune`/`add` interleaving much more likely than a single
      // 2-way race. Deterministic lock ownership is pinned separately in the
      // infra suite; this real-git stress case protects the end-to-end isolation
      // outcome across Workspace roots.
      const workspaces = [f.alpha, f.beta, ...["ws-gamma", "ws-delta", "ws-epsilon", "ws-zeta"].map(f.build)];
      await Promise.all(workspaces.map((ws) =>
        portsFor(ws).repositories?.prepare({ storyId: f.storyId, cycleId: `cycle-${ws.workspaceId}` }),
      ));

      const branchOf = (worktreePath: string): string => execFileSync(
        "git",
        ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      const legs = await Promise.all(workspaces.map(async (ws) => {
        const resolved = await portsFor(ws).repositories?.resolve(f.storyId);
        const leg = resolved === undefined ? undefined : Object.values(resolved.repositories)[0];
        if (leg === undefined) throw new Error(`${ws.workspaceId} must resolve its sot leg`);
        return { workspaceId: ws.workspaceId, leg, branch: branchOf(leg.worktreePath) };
      }));

      // Every leg targets the SAME shared cache (same repoId) — guards against
      // the fixture accidentally handing out separate caches (which would make
      // isolation trivially true).
      const repoIds = new Set(legs.map((l) => l.leg.repoId));
      expect(repoIds.size).toBe(1);
      // …yet every worktree path and every governed branch is unique. A single
      // cross-Workspace collision (the pre-lock race) collapses one of these
      // Set sizes below the Workspace count.
      const worktreePaths = new Set(legs.map((l) => realpathSync(l.leg.worktreePath)));
      const branches = new Set(legs.map((l) => l.branch));
      expect(worktreePaths.size).toBe(workspaces.length);
      expect(branches.size).toBe(workspaces.length);
      // …and each branch is exactly its own Workspace-scoped governed name.
      for (const l of legs) {
        expect(l.branch).toBe(`roll/${l.workspaceId}/US-WS-011/sot`);
      }
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });

  it("prepares a one-repository Workspace through the same transaction path as many — cardinality one is not a mode", async () => {
    // sharedCacheFixture builds single-repo Workspaces; drive one through the
    // identical pick_story → prepare → In Progress path the two-repo case uses.
    const f = sharedCacheFixture();
    const previousRollHome = process.env["ROLL_HOME"];
    process.env["ROLL_HOME"] = f.rollHome;
    try {
      const ports = nodePorts({
        repoCwd: f.alpha.workspace,
        paths: f.alpha.paths,
        skillBody: "BUILD STORY",
        routeDeps: { readSlot: () => ({ agent: "claude" }), firstInstalled: () => "claude" },
      });

      const result = await executeSetupCommand({ kind: "pick_story" }, ports, {
        cycleId: "cycle-single",
        branch: "loop/cycle-single",
        loop: "main",
      });

      // Same event contract and lifecycle transition as the multi-repo case.
      expect(result.event?.type).toBe("story_picked");
      expect(result.event).toMatchObject({ storyId: f.storyId });
      expect(readFileSync(join(f.alpha.workspace, "backlog", "index.md"), "utf8")).toContain("🔨 In Progress");

      const execution = await ports.repositories?.resolve(f.storyId);
      if (execution === undefined) throw new Error("one-repository Workspace must resolve");
      // Exactly one leg, but the SAME resolved shape multi-repo returns.
      expect(Object.keys(execution.repositories)).toHaveLength(1);
      const leg = Object.values(execution.repositories)[0];
      if (leg === undefined) throw new Error("the single leg must resolve");
      expect(leg.alias).toBe("sot");
      expect(realpathSync(leg.worktreePath)).toContain(`/issues/${f.storyId}/sot`);
      // The governed branch follows the identical Workspace/Story/repo pattern.
      const branch = execFileSync("git", ["-C", leg.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim();
      expect(branch).toBe("roll/ws-alpha/US-WS-011/sot");
      // Writable-root projection works unchanged for cardinality one.
      const writableRoots = repositoryAgentWritableRoots(execution);
      expect(writableRoots).toContain(realpathSync(leg.worktreePath));
    } finally {
      if (previousRollHome === undefined) delete process.env["ROLL_HOME"];
      else process.env["ROLL_HOME"] = previousRollHome;
    }
  });
});
