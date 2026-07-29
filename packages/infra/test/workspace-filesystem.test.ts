import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceCreateApplyAuthorization, normalizeAgentScopeConfig, parseWorkspaceCreateConfig } from "@roll/core";
import {
  applyWorkspaceCreation,
  inspectWorkspaceCreation,
  workspaceLegacyCreateJournalPath,
  workspaceCreateJournalPath,
  workspaceCreateLockPath,
  workspaceRegistryTransactionPath,
  workspaceRegistryPath,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-fs-"));
  roots.push(home);
  const rollHome = join(home, ".roll");
  const root = join(rollHome, "workspaces", "ws-demo");
  const parsed = parseWorkspaceCreateConfig(`
schema: roll.workspace-create/v1
id: ws-demo
root: ${root}
display_name: Demo
repositories:
  - alias: primary
    source: file:///tmp/remotes/product.git
    integration_branch: main
`, {
    workspaceId: "ws-demo",
    configPath: join(home, "workspace-create.yaml"),
    homeDir: home,
    rollHome,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return { home, rollHome, root, config: parsed.value };
}

function tree(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const rows: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const target = join(path, name.name);
      const rel = relative(root, target);
      if (name.isDirectory()) {
        rows.push(`d:${rel}`);
        visit(target);
      } else {
        const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
        rows.push(`f:${rel}:${digest}`);
      }
    }
  };
  visit(root);
  return rows;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function legacyConfigDigest(f: ReturnType<typeof fixture>): string {
  return sha256(JSON.stringify({
    workspaceId: f.config.workspaceId,
    root: f.config.root,
    manifest: f.config.manifest,
  }));
}

function writeLegacyJournal(
  f: ReturnType<typeof fixture>,
  created: readonly { readonly path: string; readonly kind: "file" | "directory"; readonly digest?: string }[],
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const path = workspaceLegacyCreateJournalPath(f.rollHome, "ws-demo");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: "roll.workspace-init-journal/v1",
    transactionId: "legacy-transaction",
    workspaceId: "ws-demo",
    root: f.root,
    configDigest: legacyConfigDigest(f),
    status: "repair_required",
    created,
    preserved: [],
    preservedCaches: [],
    ...overrides,
  }, null, 2)}\n`, "utf8");
  return path;
}

function writeCreateJournal(
  f: ReturnType<typeof fixture>,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const path = workspaceCreateJournalPath(f.rollHome, "ws-demo");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: "roll.workspace-create-journal/v1",
    transactionId: "create-transaction",
    workspaceId: "ws-demo",
    root: f.root,
    configDigest: legacyConfigDigest(f),
    status: "repair_required",
    created: [],
    preserved: [],
    preservedCaches: [],
    ...overrides,
  }, null, 2)}\n`, "utf8");
  return path;
}

describe("Workspace filesystem transaction", () => {
  it("keeps read-only inspection byte-for-byte side-effect free", async () => {
    const f = fixture();
    const beforeHome = tree(f.home);
    const beforeRoot = tree(f.root);
    const plan = await inspectWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
    });
    expect(plan.outcome).toBe("created");
    expect(tree(f.home)).toEqual(beforeHome);
    expect(tree(f.root)).toEqual(beforeRoot);
  });

  it("creates the complete layout, registers last, and reuses an identical config", async () => {
    const f = fixture();
    const ensureCache = vi.fn(async () => ({ action: "created" as const }));
    const first = await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache,
    });
    expect(first.outcome).toBe("created");
    expect(first.plan.steps.at(-1)).toMatchObject({ kind: "registry", target: "ws-demo" });
    expect(JSON.parse(readFileSync(join(f.root, "workspace.yaml"), "utf8"))).toMatchObject({ workspaceId: "ws-demo" });
    const agentScope = normalizeAgentScopeConfig(readFileSync(join(f.root, "agents.yaml"), "utf8"));
    expect(agentScope.errors).toEqual([]);
    expect(agentScope.config).toMatchObject({ scope: "workspace", inherits: "machine" });
    expect(tree(f.root).map((row) => row.split(":").slice(0, 2).join(":"))).toEqual(expect.arrayContaining([
      "f:agents.yaml",
      "f:backlog/index.md",
      "f:charter.md",
      "d:design",
      "d:issues",
      "f:policy.yaml",
      "d:requirements",
      "d:runtime",
      "f:workspace.yaml",
    ]));
    expect(tree(f.root).some((row) => row.includes(".git"))).toBe(false);
    expect(JSON.parse(readFileSync(workspaceRegistryPath(f.rollHome), "utf8"))).toMatchObject({
      entries: [{ workspaceId: "ws-demo", root: f.root }],
    });
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(false);

    ensureCache.mockResolvedValue({ action: "reused" as const });
    const second = await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "compatible",
      ensureCache,
    });
    expect(second.outcome).toBe("reused");
    expect(ensureCache).toHaveBeenCalledTimes(2);
  });

  it("rolls back clean transaction artifacts after several steps while preserving pre-existing and dirty content", async () => {
    const f = fixture();
    mkdirSync(f.rollHome, { recursive: true });
    const preExisting = join(f.rollHome, "operator-owned.txt");
    writeFileSync(preExisting, "keep\n", "utf8");
    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
      afterStep: (step) => {
        if (step.target.endsWith("workspace.yaml")) {
          expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(true);
          writeFileSync(step.target, "operator changed this file\n", "utf8");
        }
        if (step.target.endsWith(join("backlog", "index.md"))) {
          throw new Error("injected failure");
        }
      },
    })).rejects.toThrow("injected failure");

    expect(readFileSync(preExisting, "utf8")).toBe("keep\n");
    expect(readFileSync(join(f.root, "workspace.yaml"), "utf8")).toBe("operator changed this file\n");
    for (const clean of ["charter.md", "agents.yaml", "policy.yaml", join("backlog", "index.md")]) {
      expect(existsSync(join(f.root, clean)), clean).toBe(false);
    }
    for (const cleanDirectory of ["requirements", "design", "backlog"]) {
      expect(existsSync(join(f.root, cleanDirectory)), cleanDirectory).toBe(false);
    }
    expect(existsSync(workspaceRegistryPath(f.rollHome))).toBe(false);
    const journal = JSON.parse(readFileSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"), "utf8")) as Record<string, unknown>;
    expect(journal).toMatchObject({
      schema: "roll.workspace-create-journal/v1",
      workspaceId: "ws-demo",
      status: "repair_required",
    });
    expect(journal["preserved"]).toEqual(expect.arrayContaining([expect.stringContaining("workspace.yaml")]));
  });

  it("removes a failed atomic write temporary without exposing partial target content", async () => {
    const f = fixture();
    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
      renameFile: (from, to) => {
        if (to.endsWith("charter.md")) throw new Error("atomic rename failure");
        renameSync(from, to);
      },
    })).rejects.toThrow("atomic rename failure");

    expect(existsSync(join(f.root, "charter.md"))).toBe(false);
    expect(tree(f.home).filter((row) => row.includes(".tmp."))).toEqual([]);
    expect(JSON.parse(readFileSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"), "utf8")))
      .toMatchObject({ status: "repair_required" });
  });

  it("rejects incompatible pre-existing content without creating registry, cache or journal state", async () => {
    const f = fixture();
    mkdirSync(f.root, { recursive: true });
    writeFileSync(join(f.root, "workspace.yaml"), "not the requested manifest\n", "utf8");
    const ensureCache = vi.fn(async () => ({ action: "created" as const }));
    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache,
    })).rejects.toMatchObject({ code: "rejected" });
    expect(ensureCache).not.toHaveBeenCalled();
    expect(existsSync(workspaceRegistryPath(f.rollHome))).toBe(false);
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(false);
  });

  it("rejects a root that aliases the machine cache through a symbolic link without writing state", async () => {
    const f = fixture();
    const repos = join(f.rollHome, "repos");
    const linked = join(f.home, "linked");
    mkdirSync(repos, { recursive: true });
    symlinkSync(repos, linked, "dir");
    const config = { ...f.config, root: join(linked, "ws-demo") };
    const before = tree(f.rollHome);

    const plan = await inspectWorkspaceCreation(config, { inspectCache: async () => "absent" });

    expect(plan.outcome).toBe("rejected");
    expect(tree(f.rollHome)).toEqual(before);
  });

  it("fails closed when another process holds the Workspace create lock", async () => {
    const f = fixture();
    const lock = workspaceCreateLockPath(f.rollHome, "ws-other");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "meta.json"), `${JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: Math.floor(Date.now() / 1000),
      cycleId: "other-create",
    })}\n`, "utf8");

    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "concurrent_create" });
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(false);
  });

  it("rejects a second lexical root for an already registered canonical Workspace", async () => {
    const f = fixture();
    await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    });
    const alias = join(f.home, "workspace-alias");
    symlinkSync(dirname(f.root), alias, "dir");
    const aliased = { ...f.config, root: join(alias, "ws-demo") };
    const before = tree(f.rollHome);

    await expect(applyWorkspaceCreation(aliased, {
      inspectCache: async () => "compatible",
      ensureCache: async () => ({ action: "reused" as const }),
    })).rejects.toMatchObject({ code: "rejected" });
    expect(tree(f.rollHome)).toEqual(before);
  });

  it("keeps the winner when another Workspace ID targets the same canonical root", async () => {
    const f = fixture();
    await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    });
    const winner = tree(f.rollHome);
    const loser = {
      ...f.config,
      workspaceId: "ws-other",
      manifest: { ...f.config.manifest, workspaceId: "ws-other" },
    };

    await expect(applyWorkspaceCreation(loser, {
      inspectCache: async () => "compatible",
      ensureCache: async () => ({ action: "reused" as const }),
    })).rejects.toMatchObject({ code: "rejected" });

    expect(tree(f.rollHome)).toEqual(winner);
    expect(JSON.parse(readFileSync(join(f.root, "workspace.yaml"), "utf8"))).toMatchObject({ workspaceId: "ws-demo" });
    expect(JSON.parse(readFileSync(workspaceRegistryPath(f.rollHome), "utf8"))).toMatchObject({
      entries: [{ workspaceId: "ws-demo", root: f.root }],
    });
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-other"))).toBe(false);
  });

  it("rejects a pending registry transaction before creating create state", async () => {
    const f = fixture();
    mkdirSync(f.rollHome, { recursive: true });
    writeFileSync(workspaceRegistryTransactionPath(f.rollHome), "{}\n", "utf8");
    const before = tree(f.rollHome);

    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "rejected" });
    expect(tree(f.rollHome)).toEqual(before);
  });

  it("preserves committed Workspace state when cleanup fails after registry commit", async () => {
    const f = fixture();
    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
      afterStep: (step) => {
        if (step.kind === "registry") throw new Error("post-registry cleanup failure");
      },
    })).rejects.toThrow("post-registry cleanup failure");

    expect(existsSync(join(f.root, "workspace.yaml"))).toBe(true);
    expect(existsSync(workspaceRegistryPath(f.rollHome))).toBe(true);
    expect(JSON.parse(readFileSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"), "utf8")))
      .toMatchObject({ status: "repair_required" });
  });

  it("reconciles a completed legacy init journal as idempotent success without rewriting Workspace authority", async () => {
    const f = fixture();
    await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    });
    const workspaceBefore = tree(f.root);
    const legacyPath = writeLegacyJournal(f, [
      { path: f.root, kind: "directory" },
      {
        path: join(f.root, "workspace.yaml"),
        kind: "file",
        digest: sha256(readFileSync(join(f.root, "workspace.yaml"), "utf8")),
      },
    ]);
    const beforePreview = tree(f.rollHome);

    const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "compatible" });
    expect(preview).toMatchObject({
      outcome: "repaired",
      recovery: { kind: "legacy_completed", journalPath: legacyPath },
    });
    expect(tree(f.rollHome)).toEqual(beforePreview);

    const result = await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "compatible",
      ensureCache: async () => ({ action: "reused" as const }),
    });
    expect(result).toMatchObject({ outcome: "repaired", plan: { recovery: { kind: "legacy_completed" } } });
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(false);
    expect(tree(f.root)).toEqual(workspaceBefore);
  });

  it("rolls back only proven-safe legacy residue and continues through the new create journal", async () => {
    const f = fixture();
    mkdirSync(f.root, { recursive: true });
    const manifestPath = join(f.root, "workspace.yaml");
    const manifest = `${JSON.stringify(f.config.manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifest, "utf8");
    const legacyPath = writeLegacyJournal(f, [
      { path: f.root, kind: "directory" },
      { path: manifestPath, kind: "file", digest: sha256(manifest) },
    ]);

    const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "absent" });
    expect(preview).toMatchObject({
      outcome: "repaired",
      recovery: { kind: "legacy_rollback", journalPath: legacyPath },
    });
    expect(preview.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", target: manifestPath, action: "repaired" }),
    ]));

    const result = await applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    });
    expect(result.outcome).toBe("repaired");
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ workspaceId: "ws-demo" });
    expect(JSON.parse(readFileSync(workspaceRegistryPath(f.rollHome), "utf8"))).toMatchObject({
      entries: [{ workspaceId: "ws-demo", root: f.root }],
    });
  });

  it("fails closed for modified legacy residue or simultaneous legacy and create journals", async () => {
    const modified = fixture();
    mkdirSync(modified.root, { recursive: true });
    const manifestPath = join(modified.root, "workspace.yaml");
    writeFileSync(manifestPath, "operator-owned\n", "utf8");
    const legacyPath = writeLegacyJournal(modified, [
      { path: modified.root, kind: "directory" },
      { path: manifestPath, kind: "file", digest: sha256("expected\n") },
    ]);
    const beforeModified = tree(modified.rollHome);

    const modifiedPlan = await inspectWorkspaceCreation(modified.config, { inspectCache: async () => "absent" });
    expect(modifiedPlan).toMatchObject({
      outcome: "rejected",
      recovery: {
        kind: "legacy_recovery_required",
        journalPath: legacyPath,
        nextAction: "roll workspace doctor ws-demo --json",
      },
    });
    await expect(applyWorkspaceCreation(modified.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "legacy_create_recovery_required" });
    expect(tree(modified.rollHome)).toEqual(beforeModified);

    const conflict = fixture();
    writeLegacyJournal(conflict, []);
    const createPath = workspaceCreateJournalPath(conflict.rollHome, "ws-demo");
    mkdirSync(dirname(createPath), { recursive: true });
    writeFileSync(createPath, "{}\n", "utf8");
    const beforeConflict = tree(conflict.rollHome);
    const conflictPlan = await inspectWorkspaceCreation(conflict.config, { inspectCache: async () => "absent" });
    expect(conflictPlan).toMatchObject({ outcome: "rejected", recovery: { kind: "journal_conflict" } });
    await expect(applyWorkspaceCreation(conflict.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "legacy_create_recovery_required" });
    expect(tree(conflict.rollHome)).toEqual(beforeConflict);
  });

  it("fails closed for malformed new create journals without overwriting them", async () => {
    const cases: readonly [string, (f: ReturnType<typeof fixture>) => Readonly<Record<string, unknown>>][] = [
      ["unknown key", () => ({ unexpected: true })],
      ["unknown status", () => ({ status: "completed" })],
      ["empty transaction", () => ({ transactionId: "" })],
      ["relative created path", () => ({ created: [{ path: "workspace.yaml", kind: "file", digest: sha256("x") }] })],
      ["unexpected absolute created path", (f) => ({ created: [{ path: join(f.rollHome, "operator-owned"), kind: "directory" }] })],
      ["unexpected workspace descendant", (f) => ({ created: [{ path: join(f.root, "operator-owned-empty"), kind: "directory" }] })],
      ["directory digest", (f) => ({ created: [{ path: f.root, kind: "directory", digest: sha256("x") }] })],
      ["relative preserved path", () => ({ preserved: ["workspace.yaml"] })],
      ["unknown preserved cache", () => ({ preservedCaches: ["unknown-repo"] })],
      ["duplicate created path", (f) => ({ created: [
        { path: f.root, kind: "directory" },
        { path: f.root, kind: "directory" },
      ] })],
    ];

    for (const [name, overrides] of cases) {
      const f = fixture();
      const journalPath = writeCreateJournal(f, overrides(f));
      const before = tree(f.rollHome);
      const beforeJournal = readFileSync(journalPath, "utf8");

      const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "absent" });
      expect(preview, name).toMatchObject({ outcome: "rejected" });
      await expect(applyWorkspaceCreation(f.config, {
        inspectCache: async () => "absent",
        ensureCache: async () => ({ action: "created" as const }),
      }), name).rejects.toMatchObject({ code: "rejected" });
      expect(tree(f.rollHome), name).toEqual(before);
      expect(readFileSync(journalPath, "utf8"), name).toBe(beforeJournal);
    }
  });

  it("requires doctor when a legacy journal records preserved authority residue", async () => {
    const f = fixture();
    mkdirSync(f.root, { recursive: true });
    const manifestPath = join(f.root, "workspace.yaml");
    const manifest = `${JSON.stringify(f.config.manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifest, "utf8");
    const legacyPath = writeLegacyJournal(f, [
      { path: f.root, kind: "directory" },
      { path: manifestPath, kind: "file", digest: sha256(manifest) },
    ], { preserved: [manifestPath] });
    const before = tree(f.rollHome);

    const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "absent" });
    expect(preview).toMatchObject({
      outcome: "rejected",
      recovery: {
        kind: "legacy_recovery_required",
        journalPath: legacyPath,
        nextAction: "roll workspace doctor ws-demo --json",
      },
    });
    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "legacy_create_recovery_required" });
    expect(tree(f.rollHome)).toEqual(before);
  });

  it("never rolls back an operator-owned directory that is not an exact layout target", async () => {
    const f = fixture();
    const operatorDirectory = join(f.root, "operator-owned-empty");
    mkdirSync(operatorDirectory, { recursive: true });
    const legacyPath = writeLegacyJournal(f, [
      { path: f.root, kind: "directory" },
      { path: operatorDirectory, kind: "directory" },
    ]);
    const before = tree(f.rollHome);

    const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "absent" });
    expect(preview).toMatchObject({
      outcome: "rejected",
      recovery: {
        kind: "legacy_recovery_required",
        journalPath: legacyPath,
        nextAction: "roll workspace doctor ws-demo --json",
      },
    });
    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "legacy_create_recovery_required" });
    expect(tree(f.rollHome)).toEqual(before);
    expect(existsSync(operatorDirectory)).toBe(true);
  });

  it("never overwrites a current journal that claims a real operator-owned directory", async () => {
    const f = fixture();
    const operatorDirectory = join(f.root, "operator-owned-empty");
    mkdirSync(operatorDirectory, { recursive: true });
    const journalPath = writeCreateJournal(f, {
      created: [
        { path: f.root, kind: "directory" },
        { path: operatorDirectory, kind: "directory" },
      ],
    });
    const before = tree(f.rollHome);
    const beforeJournal = readFileSync(journalPath, "utf8");

    const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "absent" });
    expect(preview).toMatchObject({ outcome: "rejected" });
    expect(tree(f.rollHome)).toEqual(before);
    expect(readFileSync(journalPath, "utf8")).toBe(beforeJournal);

    await expect(applyWorkspaceCreation(f.config, {
      inspectCache: async () => "absent",
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({ code: "rejected" });
    expect(tree(f.rollHome)).toEqual(before);
    expect(existsSync(operatorDirectory)).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toBe(beforeJournal);
  });

  it("invalidates an exact authorization when the lock-in plan digest changes", async () => {
    const f = fixture();
    const preview = await inspectWorkspaceCreation(f.config, { inspectCache: async () => "absent" });
    const inspectCache = vi.fn()
      .mockResolvedValueOnce("absent")
      .mockResolvedValueOnce("compatible");

    await expect(applyWorkspaceCreation(f.config, {
      authorization: buildWorkspaceCreateApplyAuthorization(preview, "owner_after_preview"),
      inspectCache,
      ensureCache: async () => ({ action: "created" as const }),
    })).rejects.toMatchObject({
      code: "apply_authorization_stale",
      nextAction: "roll workspace create ws-demo --config <path> --check --json",
    });
    expect(existsSync(workspaceCreateJournalPath(f.rollHome, "ws-demo"))).toBe(false);
    expect(existsSync(f.root)).toBe(false);
  });
});
