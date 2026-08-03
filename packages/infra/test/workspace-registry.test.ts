import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
} from "@roll/spec";
import { acquireLock } from "../src/process.js";
import {
  WORKSPACE_REGISTRY_V1,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  parseWorkspaceRegistry,
  serializeWorkspaceRegistry,
  workspaceEventsPath,
  workspaceRegistryPath,
} from "../src/workspace-registry.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-workspace-registry-"));
  homes.push(root);
  return root;
}

function workspace(root: string, workspaceId: string): string {
  mkdirSync(root, { recursive: true });
  const remote = `https://example.test/workspaces/${workspaceId}.git`;
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("test remote must be valid");
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

describe("Workspace registry v1 persistence", () => {
  it("uses a closed schema and deterministic serialization", () => {
    const snapshot = {
      schema: WORKSPACE_REGISTRY_V1,
      revision: 2,
      entries: [
        { workspaceId: "ws-z", root: "/z", canonicalRoot: "/z", pathState: "valid" as const },
        { workspaceId: "ws-alpha", root: "/alpha", canonicalRoot: "/alpha", pathState: "stale" as const },
      ],
    };
    const text = serializeWorkspaceRegistry(snapshot);
    expect(text).toBe([
      "{",
      '  "schema": "roll.workspace-registry/v1",',
      '  "revision": 2,',
      '  "entries": [',
      "    {",
      '      "workspaceId": "ws-alpha",',
      '      "root": "/alpha",',
      '      "canonicalRoot": "/alpha",',
      '      "pathState": "stale"',
      "    },",
      "    {",
      '      "workspaceId": "ws-z",',
      '      "root": "/z",',
      '      "canonicalRoot": "/z",',
      '      "pathState": "valid"',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"));
    expect(parseWorkspaceRegistry(text)).toEqual({
      ...snapshot,
      entries: [snapshot.entries[1], snapshot.entries[0]],
    });
    expect(() => parseWorkspaceRegistry(JSON.stringify({ ...snapshot, activeWorkspaceId: "ws-z" })))
      .toThrowError(WorkspaceRegistryError);
    expect(() => parseWorkspaceRegistry(JSON.stringify({ ...snapshot, schema: "roll.workspace-registry/v2" })))
      .toThrowError(expect.objectContaining({ code: "invalid_registry" }));
    expect(() => parseWorkspaceRegistry(JSON.stringify({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], extra: true }],
    }))).toThrowError(expect.objectContaining({ code: "invalid_registry" }));
    expect(() => parseWorkspaceRegistry(JSON.stringify({
      ...snapshot,
      entries: [{ workspaceId: "ws-z", root: "/z", canonicalRoot: "/z" }],
    }))).toThrowError(expect.objectContaining({ code: "invalid_registry" }));
  });

  it("atomically registers and idempotently upserts by immutable Workspace ID", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const renames: { from: string; to: string }[] = [];
    const store = new WorkspaceRegistry({
      rollHome,
      now: () => 100,
      renameFile: (from, to) => {
        renames.push({ from, to });
        renameSync(from, to);
      },
    });

    expect(store.register({ workspaceId: "ws-alpha", root: alpha })).toMatchObject({
      workspaceId: "ws-alpha",
      root: alpha,
      pathState: "valid",
    });
    expect(store.register({ workspaceId: "ws-alpha", root: alpha })).toMatchObject({ workspaceId: "ws-alpha" });

    const snapshot = parseWorkspaceRegistry(readFileSync(workspaceRegistryPath(rollHome), "utf8"));
    expect(snapshot.revision).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(workspaceRegistryPath(rollHome)).toBe(join(rollHome, "workspaces.json"));
    expect(workspaceEventsPath(rollHome)).toBe(join(rollHome, "workspace-events.ndjson"));
    expect(renames).toContainEqual({
      from: expect.stringMatching(/workspaces\.json\.tmp\./),
      to: workspaceRegistryPath(rollHome),
    });
    expect(readFileSync(workspaceEventsPath(rollHome), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rejects a workspace.yaml that is not a closed roll.workspace/v1 manifest", () => {
    const rollHome = sandbox();
    const root = join(rollHome, "roots", "legacy");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({ id: "ws-alpha" })}\n`, "utf8");

    expect(() => new WorkspaceRegistry({ rollHome }).register({ workspaceId: "ws-alpha", root })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    expect(existsSync(workspaceRegistryPath(rollHome))).toBe(false);

    const closedRoot = workspace(join(rollHome, "roots", "open"), "ws-open");
    const openManifest = JSON.parse(readFileSync(join(closedRoot, "workspace.yaml"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(closedRoot, "workspace.yaml"), `${JSON.stringify({ ...openManifest, extra: true })}\n`, "utf8");
    expect(() => new WorkspaceRegistry({ rollHome }).register({ workspaceId: "ws-open", root: closedRoot })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
  });

  it("revalidates the immutable manifest identity on an idempotent upsert", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    workspace(alpha, "ws-other");

    expect(() => store.register({ workspaceId: "ws-alpha", root: alpha })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    expect(store.read().entries).toEqual([expect.objectContaining({ workspaceId: "ws-alpha", root: alpha })]);
  });

  it("refuses manifest identity mismatch and a live canonical path collision without losing rows", () => {
    const rollHome = sandbox();
    const shared = workspace(join(rollHome, "roots", "shared"), "ws-alpha");
    const mismatch = workspace(join(rollHome, "roots", "mismatch"), "ws-other");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: shared });

    expect(() => store.register({ workspaceId: "ws-beta", root: mismatch })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    const sharedAlias = join(rollHome, "roots", "shared-alias");
    symlinkSync(shared, sharedAlias, "dir");
    workspace(shared, "ws-beta");
    expect(() => store.register({ workspaceId: "ws-beta", root: sharedAlias })).toThrowError(
      expect.objectContaining({ code: "path_conflict" }),
    );
    expect(store.read().entries.map((entry) => entry.workspaceId)).toEqual(["ws-alpha"]);
  });

  it("requires explicit move when an existing Workspace ID is registered at another root", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const moved = workspace(join(rollHome, "roots", "moved"), "ws-alpha");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    expect(() => store.register({ workspaceId: "ws-alpha", root: moved })).toThrowError(
      expect.objectContaining({ code: "path_change_requires_move" }),
    );
    expect(store.read().entries).toEqual([
      expect.objectContaining({ workspaceId: "ws-alpha", root: alpha }),
    ]);
  });

  it("rejects open or unsafe Workspace event records through the public reader", () => {
    const rollHome = sandbox();
    writeFileSync(workspaceEventsPath(rollHome), `${JSON.stringify({
      schema: "roll.workspace-event/v1",
      type: "workspace:path_updated",
      workspaceId: "ws-alpha",
      ts: 1,
      oldRoot: "relative/old",
      newRoot: "/new",
    })}\n`, "utf8");
    expect(() => new WorkspaceRegistry({ rollHome }).readEvents()).toThrowError(
      expect.objectContaining({ code: "invalid_registry" }),
    );

    writeFileSync(workspaceEventsPath(rollHome), `${JSON.stringify({
      schema: "roll.workspace-event/v1",
      type: "workspace:registered",
      workspaceId: "ws-alpha",
      ts: 1,
      extra: true,
    })}\n`, "utf8");
    expect(() => new WorkspaceRegistry({ rollHome }).readEvents()).toThrowError(
      expect.objectContaining({ code: "invalid_registry" }),
    );
  });

  it("wraps registry and event filesystem failures in the typed public error model", () => {
    const rollHome = sandbox();
    mkdirSync(workspaceRegistryPath(rollHome));
    expect(() => new WorkspaceRegistry({ rollHome }).read()).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
    rmSync(workspaceRegistryPath(rollHome), { recursive: true });
    mkdirSync(workspaceEventsPath(rollHome));
    expect(() => new WorkspaceRegistry({ rollHome }).readEvents()).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
  });

  it("writes the registration event before the registry projection so retry repairs a failed commit", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    let failCommit = false;
    let registryAtRename = "";
    let betaEventsAtRename = 0;
    let registryTempsAtRename: string[] = [];
    const store = new WorkspaceRegistry({
      rollHome,
      now: () => 100,
      beforeRegistryRename: () => {
        if (failCommit) {
          registryAtRename = readFileSync(workspaceRegistryPath(rollHome), "utf8");
          betaEventsAtRename = store.readEvents().filter((event) =>
            event.type === "workspace:registered" && event.workspaceId === "ws-beta"
          ).length;
          registryTempsAtRename = readdirSync(rollHome).filter((name) => name.startsWith("workspaces.json.tmp."));
          throw new Error("planned registry commit failure");
        }
      },
    });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    const before = readFileSync(workspaceRegistryPath(rollHome), "utf8");
    failCommit = true;

    expect(() => store.register({ workspaceId: "ws-beta", root: beta })).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
    expect(registryAtRename).toBe(before);
    expect(betaEventsAtRename).toBe(1);
    expect(registryTempsAtRename).toHaveLength(1);
    expect(readdirSync(rollHome).filter((name) => name.startsWith("workspaces.json.tmp."))).toEqual([]);
    expect(readFileSync(workspaceRegistryPath(rollHome), "utf8")).toBe(before);

    failCommit = false;
    store.register({ workspaceId: "ws-beta", root: beta });
    expect(store.list().map((entry) => entry.workspaceId)).toEqual(["ws-alpha", "ws-beta"]);
    expect(store.readEvents().filter((event) => event.type === "workspace:registered" && event.workspaceId === "ws-beta"))
      .toHaveLength(1);
  });

  it("uses an append-only event-store port for lifecycle persistence", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    let text = "";
    const appendCalls: string[] = [];
    const eventStore = {
      readText: () => text,
      appendLine: (_path: string, line: string) => {
        appendCalls.push(line);
        text += line;
      },
    };
    const store = new WorkspaceRegistry({ rollHome, now: () => 100, eventStore });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    store.activate("ws-alpha");
    store.pause("ws-alpha");
    expect(appendCalls).toHaveLength(3);
    expect(appendCalls.every((line) => line.endsWith("\n"))).toBe(true);
    expect(store.list()).toEqual([
      expect.objectContaining({ workspaceId: "ws-alpha", lifecycle: "paused" }),
    ]);
  });
});

describe("Workspace lifecycle, moves, and concurrent writers", () => {
  it("inspects manifest consistency without collapsing ID mismatch into stale path", () => {
    const rollHome = sandbox();
    const stale = workspace(join(rollHome, "roots", "stale"), "ws-stale");
    const mismatch = workspace(join(rollHome, "roots", "mismatch"), "ws-mismatch");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-stale", root: stale });
    store.register({ workspaceId: "ws-mismatch", root: mismatch });
    rmSync(stale, { recursive: true, force: true });
    workspace(mismatch, "ws-other");

    expect(store.inspect().map(({ workspaceId, consistency, manifestWorkspaceId }) => ({
      workspaceId,
      consistency,
      manifestWorkspaceId,
    }))).toEqual([
      { workspaceId: "ws-mismatch", consistency: "identity_mismatch", manifestWorkspaceId: "ws-other" },
      { workspaceId: "ws-stale", consistency: "stale_path", manifestWorkspaceId: null },
    ]);
  });

  it("rejects archived pause/archive without appending events and permits explicit activation", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const store = new WorkspaceRegistry({ rollHome, now: (() => {
      let ts = 0;
      return () => ++ts;
    })() });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    store.archive("ws-alpha");
    const before = readFileSync(workspaceEventsPath(rollHome), "utf8");

    expect(() => store.pause("ws-alpha")).toThrowError(
      expect.objectContaining({ code: "archived_requires_activation" }),
    );
    expect(() => store.archive("ws-alpha")).toThrowError(
      expect.objectContaining({ code: "already_archived" }),
    );
    expect(readFileSync(workspaceEventsPath(rollHome), "utf8")).toBe(before);

    store.activate("ws-alpha");
    expect(store.list().find((entry) => entry.workspaceId === "ws-alpha")?.lifecycle).toBe("active");
  });

  it("derives multiple active Workspaces from events and isolates later transitions", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    const store = new WorkspaceRegistry({ rollHome, now: (() => {
      let ts = 0;
      return () => ++ts;
    })() });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    store.register({ workspaceId: "ws-beta", root: beta });
    store.activate("ws-alpha");
    store.activate("ws-beta");
    expect(store.list().map(({ workspaceId, lifecycle }) => ({ workspaceId, lifecycle }))).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "active" },
      { workspaceId: "ws-beta", lifecycle: "active" },
    ]);
    const persisted = JSON.parse(readFileSync(workspaceRegistryPath(rollHome), "utf8")) as {
      entries: readonly Record<string, unknown>[];
    };
    expect(persisted.entries.every((entry) => !("lifecycle" in entry))).toBe(true);

    store.pause("ws-alpha");
    store.archive("ws-beta");
    expect(existsSync(beta)).toBe(true);
    expect(new WorkspaceRegistry({ rollHome }).list().map(({ workspaceId, lifecycle }) => ({ workspaceId, lifecycle }))).toEqual([
      { workspaceId: "ws-alpha", lifecycle: "paused" },
      { workspaceId: "ws-beta", lifecycle: "archived" },
    ]);
    expect(store.readEvents().map((event) => event.type)).toEqual([
      "workspace:registered",
      "workspace:registered",
      "workspace:activated",
      "workspace:activated",
      "workspace:paused",
      "workspace:archived",
    ]);
    const rewrittenEvents = store.readEvents().map((event) =>
      event.type === "workspace:archived" && event.workspaceId === "ws-beta"
        ? { ...event, type: "workspace:activated" as const }
        : event
    );
    writeFileSync(workspaceEventsPath(rollHome), rewrittenEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
    expect(new WorkspaceRegistry({ rollHome }).list().find((entry) => entry.workspaceId === "ws-beta")?.lifecycle)
      .toBe("active");
    store.archive("ws-beta");
    store.activate("ws-beta");
    expect(store.list().find((entry) => entry.workspaceId === "ws-beta")?.lifecycle).toBe("active");
    rmSync(workspaceEventsPath(rollHome));
    expect(() => new WorkspaceRegistry({ rollHome }).list()).toThrowError(
      expect.objectContaining({ code: "invalid_registry" }),
    );
  });

  it("moves only after explicit old/new manifest validation", () => {
    const rollHome = sandbox();
    const oldRoot = workspace(join(rollHome, "roots", "old"), "ws-alpha");
    const newRoot = workspace(join(rollHome, "roots", "new"), "ws-alpha");
    const wrongRoot = workspace(join(rollHome, "roots", "wrong"), "ws-other");
    const unrelatedOld = workspace(join(rollHome, "roots", "unrelated-old"), "ws-alpha");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: oldRoot });

    expect(() => store.move({ workspaceId: "ws-alpha", oldRoot, newRoot: wrongRoot })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    expect(() => store.move({ workspaceId: "ws-alpha", oldRoot: unrelatedOld, newRoot })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    workspace(oldRoot, "ws-other");
    expect(() => store.move({ workspaceId: "ws-alpha", oldRoot, newRoot })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    workspace(oldRoot, "ws-alpha");
    expect(store.move({ workspaceId: "ws-alpha", oldRoot, newRoot })).toMatchObject({
      workspaceId: "ws-alpha",
      root: newRoot,
      pathState: "valid",
    });
    expect(store.read().entries).toHaveLength(1);
    expect(store.readEvents().at(-1)).toMatchObject({
      type: "workspace:path_updated",
      oldRoot,
      newRoot,
    });
  });

  it("recovers an interrupted move exactly once and makes the retry idempotent", () => {
    const rollHome = sandbox();
    const oldRoot = workspace(join(rollHome, "roots", "old"), "ws-alpha");
    const newRoot = workspace(join(rollHome, "roots", "new"), "ws-alpha");
    let failCommit = false;
    const store = new WorkspaceRegistry({
      rollHome,
      now: () => 100,
      beforeRegistryRename: () => {
        if (failCommit) throw new Error("planned move commit failure");
      },
    });
    store.register({ workspaceId: "ws-alpha", root: oldRoot });
    failCommit = true;
    expect(() => store.move({ workspaceId: "ws-alpha", oldRoot, newRoot })).toThrowError(
      expect.objectContaining({ code: "io_failure" }),
    );
    expect(store.read().entries).toEqual([expect.objectContaining({ root: oldRoot })]);
    expect(() => store.list()).toThrowError(expect.objectContaining({ code: "concurrent_write" }));

    failCommit = false;
    expect(store.move({ workspaceId: "ws-alpha", oldRoot, newRoot })).toMatchObject({ root: newRoot });
    expect(store.readEvents().filter((event) => event.type === "workspace:path_updated")).toHaveLength(1);
  });

  it("refuses a move onto another Workspace canonical path without changing either row", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    store.register({ workspaceId: "ws-beta", root: beta });
    workspace(beta, "ws-alpha");

    expect(() => store.move({ workspaceId: "ws-alpha", oldRoot: alpha, newRoot: beta })).toThrowError(
      expect.objectContaining({ code: "path_conflict" }),
    );
    expect(store.read().entries.map(({ workspaceId, root }) => ({ workspaceId, root }))).toEqual([
      { workspaceId: "ws-alpha", root: alpha },
      { workspaceId: "ws-beta", root: beta },
    ]);
  });

  it("refuses a stale-path repair onto another Workspace canonical path", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    store.register({ workspaceId: "ws-beta", root: beta });
    rmSync(alpha, { recursive: true });
    workspace(beta, "ws-alpha");

    expect(() => store.repair({ workspaceId: "ws-alpha", oldRoot: alpha, newRoot: beta })).toThrowError(
      expect.objectContaining({ code: "path_conflict" }),
    );
    expect(store.read().entries.map(({ workspaceId, root }) => ({ workspaceId, root }))).toEqual([
      { workspaceId: "ws-alpha", root: alpha },
      { workspaceId: "ws-beta", root: beta },
    ]);
  });

  it("keeps a missing old path visible as stale until an explicit repair", () => {
    const rollHome = sandbox();
    const oldRoot = workspace(join(rollHome, "roots", "old"), "ws-alpha");
    const recoveredRoot = workspace(join(rollHome, "roots", "recovered"), "ws-alpha");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: oldRoot });
    rmSync(oldRoot, { recursive: true });

    expect(() => store.move({ workspaceId: "ws-alpha", oldRoot, newRoot: recoveredRoot })).toThrowError(
      expect.objectContaining({ code: "stale_path" }),
    );
    expect(store.read().entries).toEqual([
      expect.objectContaining({ workspaceId: "ws-alpha", root: oldRoot, pathState: "stale" }),
    ]);
    expect(store.repair({ workspaceId: "ws-alpha", oldRoot, newRoot: recoveredRoot })).toMatchObject({
      workspaceId: "ws-alpha",
      root: recoveredRoot,
      pathState: "valid",
    });
  });

  it("reports canonical-path or manifest identity drift as stale", () => {
    const rollHome = sandbox();
    const alphaReal = workspace(join(rollHome, "roots", "alpha-real"), "ws-alpha");
    const foreignReal = workspace(join(rollHome, "roots", "foreign-real"), "ws-foreign");
    const recovered = workspace(join(rollHome, "roots", "alpha-recovered"), "ws-alpha");
    const alphaLink = join(rollHome, "roots", "alpha-link");
    symlinkSync(alphaReal, alphaLink, "dir");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: alphaLink });

    rmSync(alphaLink);
    symlinkSync(foreignReal, alphaLink, "dir");
    expect(store.list()).toEqual([
      expect.objectContaining({ workspaceId: "ws-alpha", root: alphaLink, pathState: "stale" }),
    ]);
    expect(store.repair({ workspaceId: "ws-alpha", oldRoot: alphaLink, newRoot: recovered })).toMatchObject({
      workspaceId: "ws-alpha",
      root: recovered,
      pathState: "valid",
    });
  });

  it("detects a concurrent writer fail-loud and preserves every existing row", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    const gamma = workspace(join(rollHome, "roots", "gamma"), "ws-gamma");
    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    store.register({ workspaceId: "ws-alpha", root: alpha });
    store.register({ workspaceId: "ws-gamma", root: gamma });
    const lock = join(rollHome, "locks", "workspace-registry.lock");
    expect(acquireLock(lock, process.pid).acquired).toBe(true);

    expect(() => store.register({ workspaceId: "ws-beta", root: beta })).toThrowError(
      expect.objectContaining({ code: "concurrent_write" }),
    );
    expect(store.read().entries.map((entry) => entry.workspaceId)).toEqual(["ws-alpha", "ws-gamma"]);
  });

  it("fails loud on an abandoned registry lock instead of guessing ownership", () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const lock = join(rollHome, "locks", "workspace-registry.lock");
    expect(acquireLock(lock, 999_999_999, { pidAlive: () => true }).acquired).toBe(true);

    const store = new WorkspaceRegistry({ rollHome, now: () => 100 });
    expect(() => store.register({ workspaceId: "ws-alpha", root: alpha })).toThrowError(
      expect.objectContaining({ code: "concurrent_write" }),
    );
    expect(store.read().entries).toEqual([]);
  });

  it("serializes or rejects two real writers without losing a successful row", async () => {
    const rollHome = sandbox();
    const alpha = workspace(join(rollHome, "roots", "alpha"), "ws-alpha");
    const beta = workspace(join(rollHome, "roots", "beta"), "ws-beta");
    const moduleUrl = new URL("../dist/workspace-registry.js", import.meta.url).href;
    const script = [
      'import { existsSync, writeFileSync } from "node:fs";',
      `import { WorkspaceRegistry } from ${JSON.stringify(moduleUrl)};`,
      "const [rollHome, workspaceId, root, hold, release] = process.argv.slice(1);",
      "const beforeRegistryRename = hold ? () => { writeFileSync(hold, workspaceId);",
      "while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } : undefined;",
      "try { new WorkspaceRegistry({ rollHome, beforeRegistryRename }).register({ workspaceId, root });",
      "process.stdout.write(JSON.stringify({ ok: true, workspaceId })); }",
      "catch (error) { process.stdout.write(JSON.stringify({ ok: false, workspaceId, code: error.code })); }",
    ].join("\n");
    const run = (workspaceId: string, root: string, hold = "", release = ""): Promise<{ ok: boolean; workspaceId: string; code?: string }> =>
      new Promise((resolveResult, rejectResult) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, rollHome, workspaceId, root, hold, release], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("error", rejectResult);
        child.on("close", (code) => {
          if (code !== 0) rejectResult(new Error(stderr));
          else resolveResult(JSON.parse(stdout) as { ok: boolean; workspaceId: string; code?: string });
        });
      });

    const alphaHold = join(rollHome, "alpha.hold");
    const alphaRelease = join(rollHome, "alpha.release");
    const alphaPending = run("ws-alpha", alpha, alphaHold, alphaRelease);
    await Promise.race([
      (async () => {
        const deadline = Date.now() + 2_000;
        while (!existsSync(alphaHold)) {
          if (Date.now() >= deadline) throw new Error("writer did not enter the registry rename critical section");
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        }
      })(),
      alphaPending.then((result) => { throw new Error(`writer exited before hold: ${JSON.stringify(result)}`); }),
    ]);
    expect(await run("ws-beta", beta)).toEqual({ ok: false, workspaceId: "ws-beta", code: "concurrent_write" });
    writeFileSync(alphaRelease, "go");
    expect(await alphaPending).toEqual({ ok: true, workspaceId: "ws-alpha" });
    expect(new WorkspaceRegistry({ rollHome }).read().entries.map((entry) => entry.workspaceId)).toEqual(["ws-alpha"]);
  });
});
