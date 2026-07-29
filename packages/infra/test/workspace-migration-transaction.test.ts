import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAgentScopeConfig, planHistoricalWorkspaceMigration } from "@roll/core";
import type { HistoricalMigrationPlan } from "@roll/spec";
import {
  applyHistoricalWorkspaceMigration,
  acquireLock,
  collectHistoricalMigrationFacts,
  historicalWorkspaceMigrationJournalPath,
  rollbackHistoricalWorkspaceMigration,
  releaseLock,
  workspaceRegistryPath,
  workspaceAuthorityLockPath,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeDigest(root: string): string {
  const rows: string[] = [];
  const visit = (path: string, prefix: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const target = join(path, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`);
        visit(target, relative);
      } else {
        rows.push(`f:${relative}:${sha256(target)}`);
      }
    }
  };
  visit(root, "");
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

interface Fixture {
  readonly home: string;
  readonly source: string;
  readonly remote: string;
  readonly rollHome: string;
}

function fixture(mode: "ordinary" | "tracked" | "independent" = "ordinary"): Fixture {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-migration-"));
  roots.push(home);
  const source = join(home, "product");
  const remote = join(home, "product.git");
  const rollHome = join(home, "machine");
  mkdirSync(source, { recursive: true });
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Roll Test");
  git(source, "config", "user.email", "roll@example.test");
  writeFileSync(join(source, "product.txt"), "product\n", "utf8");
  mkdirSync(join(source, ".roll", "features", "US-1"), { recursive: true });
  mkdirSync(join(source, ".roll", "loop"), { recursive: true });
  writeFileSync(join(source, ".roll", "backlog.md"), "# Backlog\n", "utf8");
  writeFileSync(join(source, ".roll", "features", "US-1", "spec.md"), "# US-1\n", "utf8");
  writeFileSync(join(source, ".roll", "loop", "runs.jsonl"), "{}\n", "utf8");
  if (mode !== "tracked") writeFileSync(join(source, ".git", "info", "exclude"), ".roll/\n", "utf8");
  git(source, "add", "product.txt");
  if (mode === "tracked") git(source, "add", ".roll");
  git(source, "commit", "-m", "fixture");
  git(home, "init", "--bare", "product.git");
  git(source, "remote", "add", "origin", `file://${remote}`);
  git(source, "push", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  if (mode === "independent") {
    git(join(source, ".roll"), "init", "-b", "main");
    git(join(source, ".roll"), "config", "user.name", "Roll Test");
    git(join(source, ".roll"), "config", "user.email", "roll@example.test");
    git(join(source, ".roll"), "add", ".");
    git(join(source, ".roll"), "commit", "-m", "meta");
  }
  return { home, source, remote, rollHome };
}

async function plan(f: Fixture): Promise<HistoricalMigrationPlan> {
  return planHistoricalWorkspaceMigration(await collectHistoricalMigrationFacts({
    sourceRoot: f.source,
    rollHome: f.rollHome,
    requestedWorkspaceId: "ws-demo",
  }));
}

function simulateMovedPendingTransfer(f: Fixture, saved: HistoricalMigrationPlan): {
  readonly source: string;
  readonly destination: string;
} {
  const journal = JSON.parse(
    readFileSync(historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId), "utf8"),
  ) as {
    readonly stagingRoot: string;
    readonly transfers: ReadonlyArray<{
      readonly source: string;
      readonly destination: string | null;
      readonly mode: string;
      readonly state: string;
    }>;
  };
  const transfer = journal.transfers.find((candidate) =>
    candidate.mode === "move" && candidate.state === "pending" && candidate.destination !== null
  );
  if (transfer === undefined || transfer.destination === null) throw new Error("move transfer fixture missing");
  const source = join(f.source, ".roll", transfer.source);
  const destination = join(journal.stagingRoot, transfer.destination);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  return { source, destination };
}

describe("US-WS-019a historical Workspace migration transaction", () => {
  it("journals first, activates last, relocates ordinary metadata and reuses the completed migration", async () => {
    const f = fixture();
    const saved = await plan(f);
    expect(saved.verdict).toBe("ready");
    const phases: string[] = [];
    const lockOrder: string[] = [];

    const first = await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      onLockAcquired: (lock) => lockOrder.push(lock),
      afterPhase: (phase) => {
        expect(existsSync(workspaceAuthorityLockPath(f.rollHome, "ws-demo"))).toBe(true);
        phases.push(phase);
      },
    });

    const workspace = join(f.rollHome, "workspaces", "ws-demo");
    expect(first.outcome).toBe("migrated");
    expect(lockOrder.slice(0, 3)).toEqual(["authority", "migration", "repository"]);
    expect(phases).toEqual(["prepared", "cache_ready", "content_ready", "workspace_ready", "registered", "activated", "cleanup_complete"]);
    expect(readFileSync(join(workspace, "backlog", "index.md"), "utf8")).toBe("# Backlog\n");
    expect(readFileSync(join(workspace, "backlog", "legacy", "US-1", "spec.md"), "utf8")).toBe("# US-1\n");
    expect(readFileSync(join(workspace, "runtime", "legacy-import", "loop", "runs.jsonl"), "utf8")).toBe("{}\n");
    const agentScope = normalizeAgentScopeConfig(readFileSync(join(workspace, "agents.yaml"), "utf8"));
    expect(agentScope.errors).toEqual([]);
    expect(agentScope.config).toMatchObject({ scope: "workspace", inherits: "machine" });
    expect(existsSync(join(workspace, "primary"))).toBe(false);
    expect(existsSync(join(f.rollHome, "repos", `${saved.repository.repoId}.git`))).toBe(true);
    expect(JSON.parse(readFileSync(workspaceRegistryPath(f.rollHome), "utf8"))).toMatchObject({
      entries: [{ workspaceId: "ws-demo", root: workspace }],
    });
    expect(readFileSync(join(f.source, ".roll", "RELOCATED.json"), "utf8")).toContain(saved.planId);
    expect(existsSync(historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId))).toBe(false);

    const second = await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });
    expect(second.outcome).toBe("reused");
  });

  it.each(["prepared", "cache_ready", "content_ready", "workspace_ready", "registered", "activated"] as const)(
    "resumes idempotently after an injected %s failure",
    async (failedPhase) => {
      const f = fixture();
      const saved = await plan(f);
      await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
        afterPhase: (phase) => {
          if (phase === failedPhase) throw new Error(`fail:${phase}`);
        },
      })).rejects.toThrow(`fail:${failedPhase}`);
      expect(existsSync(historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId))).toBe(true);

      const resumed = await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });
      expect(resumed.outcome).toBe("migrated");
      expect(existsSync(historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId))).toBe(false);
    },
  );

  it("rolls back a non-active staging Workspace and restores atomically moved source files", async () => {
    const f = fixture();
    const saved = await plan(f);
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      afterPhase: (phase) => {
        if (phase === "content_ready") throw new Error("stop before activation");
      },
    })).rejects.toThrow("stop before activation");

    const rolledBack = rollbackHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });
    expect(rolledBack.outcome).toBe("rolled_back");
    expect(readFileSync(join(f.source, ".roll", "backlog.md"), "utf8")).toBe("# Backlog\n");
    expect(existsSync(join(f.rollHome, "workspaces", "ws-demo"))).toBe(false);
    expect(existsSync(historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId))).toBe(false);
  });

  it("resumes when a move completed before its staged journal update", async () => {
    const f = fixture();
    const saved = await plan(f);
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      afterPhase: (phase) => {
        if (phase === "cache_ready") throw new Error("crash before transfer journal update");
      },
    })).rejects.toThrow("crash before transfer journal update");
    const moved = simulateMovedPendingTransfer(f, saved);
    expect(existsSync(moved.source)).toBe(false);
    expect(existsSync(moved.destination)).toBe(true);

    const resumed = await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });

    expect(resumed.outcome).toBe("migrated");
    expect(existsSync(historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId))).toBe(false);
  });

  it("rolls back a pending move whose bytes already reached staging", async () => {
    const f = fixture();
    const saved = await plan(f);
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      afterPhase: (phase) => {
        if (phase === "cache_ready") throw new Error("crash before transfer journal update");
      },
    })).rejects.toThrow("crash before transfer journal update");
    const moved = simulateMovedPendingTransfer(f, saved);
    const movedBytes = readFileSync(moved.destination, "utf8");

    expect(rollbackHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }).outcome)
      .toBe("rolled_back");
    expect(readFileSync(moved.source, "utf8")).toBe(movedBytes);
    expect(existsSync(moved.destination)).toBe(false);
  });

  it("serializes rollback against an in-flight apply transaction", async () => {
    const f = fixture();
    const saved = await plan(f);
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      afterPhase: (phase) => {
        if (phase === "content_ready") throw new Error("pause");
      },
    })).rejects.toThrow("pause");
    const lockPath = join(f.rollHome, "locks", "workspace-migration", "ws-demo.lock");
    const lock = acquireLock(lockPath, process.pid, { cycleId: "test", unparseableIsHeld: true });
    expect(lock.acquired).toBe(true);
    try {
      expect(() => rollbackHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }))
        .toThrow(expect.objectContaining({ code: "concurrent_migration" }));
    } finally {
      releaseLock(lockPath);
    }
    expect(rollbackHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }).outcome).toBe("rolled_back");
  });

  it("copies independent roll-meta surface data and leaves its Git repository byte-identical", async () => {
    const f = fixture("independent");
    const saved = await plan(f);
    expect(saved.verdict).toBe("manual_metadata_handoff");
    const before = treeDigest(join(f.source, ".roll"));
    const head = git(join(f.source, ".roll"), "rev-parse", "HEAD");

    const result = await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });

    expect(result.manualHandoff).toMatchObject({ required: true, gitMutationPerformed: false });
    expect(treeDigest(join(f.source, ".roll"))).toBe(before);
    expect(git(join(f.source, ".roll"), "rev-parse", "HEAD")).toBe(head);
    expect(git(join(f.source, ".roll"), "status", "--porcelain")).toBe("");
  });

  it("rejects a tampered resume journal without mutating independent roll-meta", async () => {
    const f = fixture("independent");
    const saved = await plan(f);
    const before = treeDigest(join(f.source, ".roll"));
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      afterPhase: (phase) => {
        if (phase === "content_ready") throw new Error("pause");
      },
    })).rejects.toThrow("pause");
    const journalPath = historicalWorkspaceMigrationJournalPath(f.rollHome, saved.workspaceId);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    const transfers = journal["transfers"] as Array<Record<string, unknown>>;
    transfers[0] = { ...transfers[0], mode: "move" };
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }))
      .rejects.toMatchObject({ code: "journal_conflict" });
    expect(treeDigest(join(f.source, ".roll"))).toBe(before);
  });

  it("refuses reused completion when mapped Workspace bytes drift", async () => {
    const f = fixture();
    const saved = await plan(f);
    await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });
    writeFileSync(join(f.rollHome, "workspaces", "ws-demo", "backlog", "index.md"), "corrupt\n", "utf8");

    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }))
      .rejects.toMatchObject({ code: "destination_conflict" });
  });

  it("rejects source drift before creating journal, cache, registry or destination state", async () => {
    const f = fixture();
    const saved = await plan(f);
    writeFileSync(join(f.source, ".roll", "backlog.md"), "changed\n", "utf8");

    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }))
      .rejects.toMatchObject({ code: "plan_drift" });
    expect(existsSync(f.rollHome)).toBe(false);
  });

  it("rejects an open or malformed saved plan before any machine write", async () => {
    const f = fixture();
    const saved = await plan(f);
    const malformed = { ...saved, unexpected: true } as unknown as HistoricalMigrationPlan;

    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: malformed }))
      .rejects.toMatchObject({ code: "invalid_plan" });
    expect(existsSync(f.rollHome)).toBe(false);
  });

  it("uses verified copy cleanup when an atomic source move is unavailable", async () => {
    const f = fixture();
    const saved = await plan(f);
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved }, {
      forceCopy: true,
      afterPhase: (phase) => {
        if (phase === "content_ready") throw new Error("cross-filesystem pause");
      },
    })).rejects.toThrow("cross-filesystem pause");
    expect(readFileSync(join(f.source, ".roll", "backlog.md"), "utf8")).toBe("# Backlog\n");

    const resumed = await applyHistoricalWorkspaceMigration({ sourceRoot: f.source, rollHome: f.rollHome, plan: saved });
    expect(resumed.outcome).toBe("migrated");
    expect(existsSync(join(f.source, ".roll", "backlog.md"))).toBe(false);
  });

  it("accepts exactly one remote-reachable cutover commit and rejects mixed-purpose cutover history", async () => {
    const good = fixture("tracked");
    const saved = await plan(good);
    expect(saved.verdict).toBe("repository_cutover_required");
    writeFileSync(join(good.source, ".git", "info", "exclude"), ".roll/\n", "utf8");
    git(good.source, "rm", "--cached", "-r", ".roll");
    git(good.source, "commit", "-m", "cut over roll metadata");
    git(good.source, "push", "origin", "main");
    const result = await applyHistoricalWorkspaceMigration({ sourceRoot: good.source, rollHome: good.rollHome, plan: saved });
    expect(result.outcome).toBe("migrated");

    const mixed = fixture("tracked");
    const mixedPlan = await plan(mixed);
    writeFileSync(join(mixed.source, ".git", "info", "exclude"), ".roll/\n", "utf8");
    git(mixed.source, "rm", "--cached", "-r", ".roll");
    writeFileSync(join(mixed.source, "product.txt"), "mixed\n", "utf8");
    git(mixed.source, "add", "product.txt");
    git(mixed.source, "commit", "-m", "mixed cutover");
    git(mixed.source, "push", "origin", "main");
    await expect(applyHistoricalWorkspaceMigration({ sourceRoot: mixed.source, rollHome: mixed.rollHome, plan: mixedPlan }))
      .rejects.toMatchObject({ code: "cutover_invalid" });
    expect(existsSync(mixed.rollHome)).toBe(false);
  });
});
