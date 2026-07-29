import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ISSUE_MANIFEST_V1,
  REPOSITORY_BINDING_V1,
  WORKSPACE_MANIFEST_V1,
  repositoryIdFromRemote,
  type RepositoryBinding,
  type WorkspaceLifecycle,
} from "@roll/spec";
import {
  WorkspaceContextLoaderError,
  WorkspaceRegistry,
  loadWorkspaceExecutionContext,
} from "../src/index.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll-workspace-context-")));
  sandboxes.push(root);
  return root;
}

function binding(alias: string): RepositoryBinding {
  const remote = `https://example.test/acme/${alias}.git`;
  const id = repositoryIdFromRemote(remote);
  if (!id.ok) throw new Error("invalid fixture remote");
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: id.value,
    alias,
    remote,
    integrationBranch: "idea-074-workspace",
    provider: "generic",
    workflow: {
      branchPattern: "roll/{workspace_id}/{story_id}/{repo_alias}",
      requiredChecks: [`${alias}-test`],
    },
  };
}

function register(
  rollHome: string,
  root: string,
  lifecycle: WorkspaceLifecycle = "active",
): void {
  const registry = new WorkspaceRegistry({ rollHome });
  registry.register({ workspaceId: "ws-demo", root });
  if (lifecycle === "active") registry.activate("ws-demo");
  if (lifecycle === "paused") {
    registry.activate("ws-demo");
    registry.pause("ws-demo");
  }
  if (lifecycle === "archived") registry.archive("ws-demo");
}

function fixture(options: {
  readonly aliases?: readonly string[];
  readonly lifecycle?: WorkspaceLifecycle;
  readonly issue?: boolean;
} = {}) {
  const base = sandbox();
  const rollHome = join(base, "home");
  const root = join(base, "workspaces", "ws-demo");
  const aliases = options.aliases ?? ["product"];
  const bindings = aliases.map(binding);
  for (const path of [
    root,
    join(root, "backlog"),
    join(root, "features"),
    join(root, "design"),
    join(root, "requirements"),
    join(root, "evidence"),
    join(root, "runtime", "tool-dumps"),
    join(root, "runtime", "events"),
    join(root, "runtime", "locks"),
  ]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "backlog", "index.md"), "# Backlog\n", "utf8");
  writeFileSync(join(root, "policy.yaml"), "{}\n", "utf8");
  writeFileSync(join(root, "workspace.yaml"), `${JSON.stringify({
    schema: WORKSPACE_MANIFEST_V1,
    workspaceId: "ws-demo",
    displayName: "Demo",
    requirements: [],
    repositories: bindings,
  }, null, 2)}\n`, "utf8");
  register(rollHome, root, options.lifecycle);
  const canonicalRoot = realpathSync(root);
  const storyId = "US-WS-031";
  const issueRoot = join(canonicalRoot, "issues", storyId);
  if (options.issue !== false) {
    mkdirSync(issueRoot, { recursive: true });
    const repositories = bindings.map((entry, index) => index === 0
      ? {
          repoId: entry.repoId,
          alias: entry.alias,
          access: "write" as const,
          requiredDelivery: true,
          noChangePolicy: "changes_required" as const,
        }
      : {
          repoId: entry.repoId,
          alias: entry.alias,
          access: "read" as const,
          requiredDelivery: false,
        });
    writeFileSync(join(issueRoot, "manifest.json"), `${JSON.stringify({
      schema: ISSUE_MANIFEST_V1,
      workspaceId: "ws-demo",
      storyId,
      requirements: [],
      repositories,
      integrationAcceptance: { command: ["pnpm", "test:integration"] },
    }, null, 2)}\n`, "utf8");
    const events = repositories.map((target, index) => {
      const worktreePath = join(issueRoot, target.alias);
      mkdirSync(worktreePath, { recursive: true });
      return JSON.stringify({
        type: "issue:repository_bound",
        workspaceId: "ws-demo",
        storyId,
        alias: target.alias,
        repoId: target.repoId,
        access: target.access,
        baseSha: String(index + 1).repeat(40),
        worktreePath,
        workBranch: target.access === "write" ? `roll/ws-demo/${storyId}/${target.alias}` : null,
        ts: index + 1,
      });
    });
    writeFileSync(join(issueRoot, "events.jsonl"), `${events.join("\n")}\n`, "utf8");
  }
  return { rollHome, root: canonicalRoot, bindings, storyId, issueRoot };
}

const heads = {
  headSha: (path: string): string => path.endsWith("product") ? "a".repeat(40) : "b".repeat(40),
};

function expectCode(action: () => unknown, code: WorkspaceContextLoaderError["code"]): void {
  try {
    action();
    throw new Error("expected loader failure");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceContextLoaderError);
    expect(error).toMatchObject({ code });
  }
}

describe("loadWorkspaceExecutionContext", () => {
  it("builds a bounded single-repository snapshot from the selected registry target", () => {
    const f = fixture();
    const context = loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      target: { kind: "workspace", workspaceId: "ws-demo", root: f.root, canonicalRoot: f.root },
      source: "explicit",
      scope: "repository_required",
      storyId: f.storyId,
      evidence: [],
    }, heads);

    expect(context).toMatchObject({
      workspace: { workspaceId: "ws-demo", lifecycle: "active", canonicalRoot: f.root },
      bindings: [{ workflow: { requiredChecks: ["product-test"] } }],
      issue: {
        storyId: f.storyId,
        execution: {
          issueRoot: f.issueRoot,
          repositories: {
            [f.bindings[0]!.repoId]: {
              access: "write",
              requiredDelivery: true,
              noChangePolicy: "changes_required",
              baseSha: "1".repeat(40),
              headSha: "a".repeat(40),
              commands: { test: [], integration: ["pnpm", "test:integration"] },
            },
          },
        },
      },
      authorities: {
        backlog: join(f.root, "backlog", "index.md"),
        policy: join(f.root, "policy.yaml"),
        locks: join(f.root, "runtime", "locks"),
      },
    });
    expect(Object.isFrozen(context?.issue?.execution.repositories)).toBe(true);
  });

  it("preserves every multi-repository execution leg without choosing the first repository", () => {
    const f = fixture({ aliases: ["product", "skills"] });
    const context = loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      target: { kind: "workspace", workspaceId: "ws-demo", root: f.root, canonicalRoot: f.root },
      source: "requirement_discovery",
      scope: "repository_required",
      storyId: f.storyId,
      evidence: [],
    }, heads);

    expect(Object.keys(context?.issue?.execution.repositories ?? {}).sort()).toEqual(
      f.bindings.map((entry) => entry.repoId).sort(),
    );
    expect(context?.issue?.execution.repositories[f.bindings[1]!.repoId]).toMatchObject({
      alias: "skills",
      access: "read",
      requiredDelivery: false,
      headSha: "b".repeat(40),
    });
  });

  it("returns undefined for machine, optional read, and legacy migration without fabricating a context", () => {
    for (const scope of ["machine_only", "workspace_optional_read", "legacy_migration_only"] as const) {
      expect(loadWorkspaceExecutionContext({
        rollHome: sandbox(),
        source: "explicit",
        scope,
        evidence: [],
      }, heads)).toBeUndefined();
    }

    expectCode(() => loadWorkspaceExecutionContext({
      rollHome: sandbox(),
      source: "explicit",
      scope: "workspace_required_read",
      evidence: [],
    }, heads), "missing_execution_context");
  });

  it("enforces paused and archived lifecycle policy after loading the exact target", () => {
    const paused = fixture({ lifecycle: "paused" });
    const archived = fixture({ lifecycle: "archived", issue: false });
    const pausedTarget = { kind: "workspace" as const, workspaceId: "ws-demo", root: paused.root, canonicalRoot: paused.root };
    const archivedTarget = { kind: "workspace" as const, workspaceId: "ws-demo", root: archived.root, canonicalRoot: archived.root };

    expect(loadWorkspaceExecutionContext({
      rollHome: paused.rollHome,
      target: pausedTarget,
      source: "explicit",
      scope: "workspace_required_read",
      evidence: [],
    }, heads)?.workspace.lifecycle).toBe("paused");
    expect(loadWorkspaceExecutionContext({
      rollHome: archived.rollHome,
      target: archivedTarget,
      source: "explicit",
      scope: "workspace_required_read",
      evidence: [],
    }, heads)?.workspace.lifecycle).toBe("archived");
    expectCode(() => loadWorkspaceExecutionContext({
      rollHome: paused.rollHome,
      target: pausedTarget,
      source: "explicit",
      scope: "workspace_required_mutation",
      evidence: [],
    }, heads), "workspace_lifecycle_forbidden");
  });

  it("rejects Issue identity mismatch and a repository symlink escape", () => {
    const mismatch = fixture();
    const manifestPath = join(mismatch.issueRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, workspaceId: "other" }, null, 2)}\n`, "utf8");
    expectCode(() => loadWorkspaceExecutionContext({
      rollHome: mismatch.rollHome,
      target: { kind: "workspace", workspaceId: "ws-demo", root: mismatch.root, canonicalRoot: mismatch.root },
      source: "explicit",
      scope: "issue_required",
      storyId: mismatch.storyId,
      evidence: [],
    }, heads), "workspace_discovery_incomplete");

    const escaped = fixture();
    const worktree = join(escaped.issueRoot, "product");
    const outside = join(sandbox(), "outside");
    mkdirSync(outside, { recursive: true });
    rmSync(worktree, { recursive: true });
    symlinkSync(outside, worktree);
    expectCode(() => loadWorkspaceExecutionContext({
      rollHome: escaped.rollHome,
      target: { kind: "workspace", workspaceId: "ws-demo", root: escaped.root, canonicalRoot: escaped.root },
      source: "explicit",
      scope: "repository_required",
      storyId: escaped.storyId,
      evidence: [],
    }, heads), "symlink_escape");
  });

  it("detects a worktree swapped after the repository head snapshot", () => {
    const f = fixture();
    const worktree = join(f.issueRoot, "product");
    const moved = join(f.issueRoot, "product-before");
    const outside = join(sandbox(), "outside");
    mkdirSync(outside, { recursive: true });

    expectCode(() => loadWorkspaceExecutionContext({
      rollHome: f.rollHome,
      target: { kind: "workspace", workspaceId: "ws-demo", root: f.root, canonicalRoot: f.root },
      source: "explicit",
      scope: "repository_required",
      storyId: f.storyId,
      evidence: [],
    }, {
      headSha: heads.headSha,
      afterRepositoryHead: (path) => {
        if (path !== worktree) return;
        renameSync(path, moved);
        symlinkSync(outside, path);
      },
    }), "authority_changed");
  });

  it.each(["workspace", "issue"] as const)(
    "fails closed when the selected %s root is replaced by an identical copy during loading",
    (authority) => {
      const f = fixture();
      let replaced = false;
      const replaceDirectory = (path: string): void => {
        const moved = `${path}-before`;
        renameSync(path, moved);
        cpSync(moved, path, { recursive: true });
        replaced = true;
      };

      expectCode(() => loadWorkspaceExecutionContext({
        rollHome: f.rollHome,
        target: { kind: "workspace", workspaceId: "ws-demo", root: f.root, canonicalRoot: f.root },
        source: "explicit",
        scope: "repository_required",
        storyId: f.storyId,
        evidence: [],
      }, {
        headSha: heads.headSha,
        ...(authority === "workspace" ? {
          afterAuthorityRead: (path: string) => {
            if (!replaced && path === join(f.root, "workspace.yaml")) replaceDirectory(f.root);
          },
        } : {
          afterRepositoryHead: (path: string) => {
            if (!replaced && path === join(f.issueRoot, "product")) replaceDirectory(f.issueRoot);
          },
        }),
      }), authority === "workspace" ? "workspace_discovery_incomplete" : "authority_changed");

      expect(replaced).toBe(true);
    },
  );
});
