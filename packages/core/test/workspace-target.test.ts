import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceTarget,
  type WorkspaceRegistryCandidate,
  type WorkspaceTargetInput,
  type WorkspaceTargetSelector,
} from "../src/workspace/target.js";

const registry: readonly WorkspaceRegistryCandidate[] = [
  {
    workspaceId: "ws-alpha",
    root: "/workspaces/alpha",
    canonicalRoot: "/real/workspaces/alpha",
    manifestWorkspaceId: "ws-alpha",
    pathState: "valid",
    lifecycle: "active",
  },
  {
    workspaceId: "ws-beta",
    root: "/workspaces/beta",
    canonicalRoot: "/real/workspaces/beta",
    manifestWorkspaceId: "ws-beta",
    pathState: "valid",
    lifecycle: "active",
  },
];

function id(workspaceId: string): WorkspaceTargetSelector {
  return { kind: "id", workspaceId };
}

function path(absolutePath: string, canonicalPath: string = absolutePath): WorkspaceTargetSelector {
  return { kind: "path", absolutePath, canonicalPath };
}

function input(overrides: Partial<WorkspaceTargetInput> = {}): WorkspaceTargetInput {
  return {
    operation: "read",
    registry,
    ...overrides,
  };
}

describe("resolveWorkspaceTarget precedence and registry identity", () => {
  it.each([
    {
      name: "explicit id",
      value: input({
        explicit: id("ws-alpha"),
        environment: id("ws-alpha"),
        context: {
          cwdManifest: {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            containment: "safe",
          },
        },
      }),
      source: "explicit",
    },
    {
      name: "environment id",
      value: input({ environment: id("ws-beta") }),
      source: "environment",
    },
    {
      name: "cwd manifest",
      value: input({
        context: {
          cwdManifest: {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            containment: "safe",
          },
        },
      }),
      source: "cwd_manifest",
    },
    {
      name: "Issue manifest reverse lookup",
      value: input({
        context: {
          issueManifest: {
            workspaceId: "ws-beta",
            root: "/workspaces/beta",
            canonicalRoot: "/real/workspaces/beta",
            containment: "safe",
          },
        },
      }),
      source: "issue_manifest",
    },
  ])("resolves the $name source without selecting an active default", ({ value, source }) => {
    expect(resolveWorkspaceTarget(value)).toEqual({
      ok: true,
      source,
      target: {
        kind: "workspace",
        workspaceId: source === "environment" || source === "issue_manifest" ? "ws-beta" : "ws-alpha",
        root: source === "environment" || source === "issue_manifest" ? "/workspaces/beta" : "/workspaces/alpha",
        canonicalRoot: source === "environment" || source === "issue_manifest" ? "/real/workspaces/beta" : "/real/workspaces/alpha",
      },
    });
  });

  it.each([
    {
      name: "environment over injected nearest cwd and Issue facts",
      value: input({
        environment: id("ws-alpha"),
        context: {
          cwdManifest: {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            containment: "safe",
          },
          issueManifest: {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            containment: "safe",
          },
        },
      }),
      source: "environment",
    },
    {
      name: "injected nearest cwd manifest over Issue reverse lookup",
      value: input({
        context: {
          cwdManifest: {
            workspaceId: "ws-beta",
            root: "/workspaces/beta",
            canonicalRoot: "/real/workspaces/beta",
            containment: "safe",
          },
          issueManifest: {
            workspaceId: "ws-beta",
            root: "/workspaces/beta",
            canonicalRoot: "/real/workspaces/beta",
            containment: "safe",
          },
        },
      }),
      source: "cwd_manifest",
    },
  ])("applies $name", ({ value, source }) => {
    expect(resolveWorkspaceTarget(value)).toMatchObject({ ok: true, source });
  });

  it("resolves registered absolute and canonical paths while preserving workspaceId", () => {
    expect(resolveWorkspaceTarget(input({ explicit: path("/workspaces/alpha", "/real/workspaces/alpha") }))).toMatchObject({
      ok: true,
      target: { kind: "workspace", workspaceId: "ws-alpha" },
    });
    expect(resolveWorkspaceTarget(input({ explicit: path("/real/workspaces/beta") }))).toMatchObject({
      ok: true,
      target: { kind: "workspace", workspaceId: "ws-beta" },
    });
    const foreignPlatformRegistry: readonly WorkspaceRegistryCandidate[] = [{
      workspaceId: "ws-windows",
      root: "C:\\workspaces\\product",
      canonicalRoot: "C:\\workspaces\\product",
      manifestWorkspaceId: "ws-windows",
      pathState: "valid",
      lifecycle: "registered",
    }];
    expect(resolveWorkspaceTarget(input({
      registry: foreignPlatformRegistry,
      explicit: path("C:\\workspaces\\product"),
    }))).toMatchObject({ ok: false, error: { code: "invalid_target" } });
  });

  it("represents --all as a stable read-only aggregate and rejects mutation", () => {
    expect(resolveWorkspaceTarget(input({ all: true }))).toEqual({
      ok: true,
      source: "all",
      target: {
        kind: "all",
        workspaces: [
          { workspaceId: "ws-alpha", root: "/workspaces/alpha", canonicalRoot: "/real/workspaces/alpha", lifecycle: "active" },
          { workspaceId: "ws-beta", root: "/workspaces/beta", canonicalRoot: "/real/workspaces/beta", lifecycle: "active" },
        ],
      },
    });

    expect(resolveWorkspaceTarget(input({ all: true, operation: "mutation" }))).toMatchObject({
      ok: false,
      error: { code: "all_requires_readonly" },
    });
  });

  it("allows archived Workspace authority only through an explicit read target", () => {
    const archived = { ...registry[0]!, lifecycle: "archived" as const };
    expect(resolveWorkspaceTarget(input({
      operation: "read",
      registry: [archived],
      explicit: id("ws-alpha"),
    }))).toMatchObject({ ok: true, source: "explicit", target: { workspaceId: "ws-alpha" } });
    expect(resolveWorkspaceTarget(input({
      operation: "mutation",
      registry: [archived],
      explicit: id("ws-alpha"),
    }))).toMatchObject({ ok: false, error: { code: "invalid_target", candidates: [{ workspaceId: "ws-alpha" }] } });
    expect(resolveWorkspaceTarget(input({
      operation: "read",
      registry: [archived],
      environment: id("ws-alpha"),
    }))).toMatchObject({ ok: false, error: { code: "invalid_target", candidates: [{ workspaceId: "ws-alpha" }] } });
  });
});

describe("resolveWorkspaceTarget fail-loud safety matrix", () => {
  it.each([
    {
      name: "explicit versus environment",
      value: input({ explicit: id("ws-alpha"), environment: id("ws-beta") }),
      sources: ["environment", "explicit"],
    },
    {
      name: "explicit versus cwd manifest",
      value: input({
        explicit: id("ws-alpha"),
        context: {
          cwdManifest: {
            workspaceId: "ws-beta",
            root: "/workspaces/beta",
            canonicalRoot: "/real/workspaces/beta",
            containment: "safe",
          },
        },
      }),
      sources: ["cwd_manifest", "explicit"],
    },
    {
      name: "cwd manifest versus Issue manifest",
      value: input({
        context: {
          cwdManifest: {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            containment: "safe",
          },
          issueManifest: {
            workspaceId: "ws-beta",
            root: "/workspaces/beta",
            canonicalRoot: "/real/workspaces/beta",
            containment: "safe",
          },
        },
      }),
      sources: ["cwd_manifest", "issue_manifest"],
    },
  ])("rejects conflicting $name evidence instead of applying a hidden fallback", ({ value, sources }) => {
    expect(resolveWorkspaceTarget(value)).toEqual({
      ok: false,
      error: {
        code: "conflicting_candidates",
        message: "Workspace target sources resolve to conflicting identities",
        candidates: [
          { workspaceId: "ws-alpha", root: "/workspaces/alpha", canonicalRoot: "/real/workspaces/alpha", lifecycle: "active" },
          { workspaceId: "ws-beta", root: "/workspaces/beta", canonicalRoot: "/real/workspaces/beta", lifecycle: "active" },
        ],
        sources,
      },
    });
  });

  it("returns typed missing evidence with active Workspaces and never auto-selects one", () => {
    expect(resolveWorkspaceTarget(input())).toEqual({
      ok: false,
      error: {
        code: "target_missing",
        message: "No Workspace target could be resolved",
        candidates: [
          { workspaceId: "ws-alpha", root: "/workspaces/alpha", canonicalRoot: "/real/workspaces/alpha", lifecycle: "active" },
          { workspaceId: "ws-beta", root: "/workspaces/beta", canonicalRoot: "/real/workspaces/beta", lifecycle: "active" },
        ],
      },
    });
    expect(resolveWorkspaceTarget(input({ explicit: id("ws-missing") }))).toMatchObject({
      ok: false,
      error: { code: "target_missing" },
    });
    expect(resolveWorkspaceTarget(input({ registry: [registry[0]!] }))).toMatchObject({
      ok: false,
      error: { code: "target_missing", candidates: [{ workspaceId: "ws-alpha" }] },
    });
    expect(resolveWorkspaceTarget(input({
      registry: [registry[0]!, { ...registry[1]!, lifecycle: "paused" }],
    }))).toMatchObject({
      ok: false,
      error: { code: "target_missing", candidates: [{ workspaceId: "ws-alpha" }] },
    });
  });

  it.each([
    {
      name: "stale selected path",
      entries: [{ ...registry[0]!, pathState: "stale" as const }, registry[1]!],
      target: id("ws-alpha"),
      code: "stale_registry",
    },
    {
      name: "registry/manifest mismatch",
      entries: [{ ...registry[0]!, manifestWorkspaceId: "ws-other" }, registry[1]!],
      target: id("ws-alpha"),
      code: "identity_mismatch",
    },
    {
      name: "duplicate identity",
      entries: [registry[0]!, { ...registry[1]!, workspaceId: "ws-alpha" }],
      target: id("ws-alpha"),
      code: "duplicate_candidate",
    },
    {
      name: "duplicate canonical path",
      entries: [registry[0]!, { ...registry[1]!, canonicalRoot: "/real/workspaces/alpha" }],
      target: id("ws-alpha"),
      code: "duplicate_candidate",
    },
    {
      name: "relative registry root",
      entries: [{ ...registry[0]!, root: "relative/alpha" }, registry[1]!],
      target: id("ws-alpha"),
      code: "invalid_target",
    },
    {
      name: "relative canonical root",
      entries: [{ ...registry[0]!, canonicalRoot: "relative/alpha" }, registry[1]!],
      target: id("ws-alpha"),
      code: "invalid_target",
    },
  ])("rejects $name", ({ entries, target, code }) => {
    expect(resolveWorkspaceTarget(input({ registry: entries, explicit: target }))).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it("rejects path and context escapes before returning a Workspace", () => {
    expect(resolveWorkspaceTarget(input({ explicit: path("/workspaces/alpha", "/outside/alpha") }))).toMatchObject({
      ok: false,
      error: { code: "symlink_escape" },
    });
    expect(resolveWorkspaceTarget(input({
      context: {
        cwdManifest: {
          workspaceId: "ws-alpha",
          root: "/workspaces/alpha",
          canonicalRoot: "/real/workspaces/alpha",
          containment: "symlink_escape",
        },
      },
    }))).toMatchObject({ ok: false, error: { code: "symlink_escape" } });
    expect(resolveWorkspaceTarget(input({
      context: {
        issueManifest: {
          workspaceId: "ws-alpha",
          root: "/workspaces/alpha",
          canonicalRoot: "/real/workspaces/alpha",
          containment: "unrelated_worktree",
        },
      },
    }))).toMatchObject({ ok: false, error: { code: "unrelated_worktree" } });
    expect(resolveWorkspaceTarget(input({
      context: {
        cwdManifest: {
          workspaceId: "ws-alpha",
          root: "/workspaces/alpha",
          canonicalRoot: "/real/workspaces/alpha",
          containment: "unrelated_worktree",
        },
      },
    }))).toMatchObject({ ok: false, error: { code: "unrelated_worktree" } });
  });

  it("allows explicit targets from unrelated or legacy cwd but never infers those contexts", () => {
    const unrelated = {
      workspaceId: "ws-beta",
      root: "/workspaces/beta",
      canonicalRoot: "/real/workspaces/beta",
      containment: "unrelated_worktree" as const,
    };
    expect(resolveWorkspaceTarget(input({ explicit: id("ws-alpha"), context: { issueManifest: unrelated } }))).toMatchObject({
      ok: true,
      source: "explicit",
      target: { workspaceId: "ws-alpha" },
    });
    expect(resolveWorkspaceTarget(input({ explicit: id("ws-alpha"), context: { legacyProject: true } }))).toMatchObject({
      ok: true,
      source: "explicit",
      target: { workspaceId: "ws-alpha" },
    });
    expect(resolveWorkspaceTarget(input({ context: { legacyProject: true } }))).toMatchObject({
      ok: false,
      error: { code: "migration_required" },
    });
  });

  it("fails aggregate reads when any registry entry is stale or mismatched", () => {
    expect(resolveWorkspaceTarget(input({
      all: true,
      registry: [registry[0]!, { ...registry[1]!, pathState: "stale" }],
    }))).toMatchObject({ ok: false, error: { code: "stale_registry" } });
    expect(resolveWorkspaceTarget(input({
      all: true,
      registry: [registry[0]!, { ...registry[1]!, manifestWorkspaceId: "ws-other" }],
    }))).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
  });

  it("retains non-active selected candidates in typed failure evidence", () => {
    const pausedStale: WorkspaceRegistryCandidate = {
      ...registry[0]!,
      lifecycle: "paused",
      pathState: "stale",
    };
    expect(resolveWorkspaceTarget(input({ registry: [pausedStale], explicit: id("ws-alpha") }))).toEqual({
      ok: false,
      error: {
        code: "stale_registry",
        message: "Workspace registry target is stale",
        candidates: [
          {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            lifecycle: "paused",
          },
        ],
      },
    });
  });

  it("retains candidate evidence for manifest mismatch without leaking unrelated credential-like facts", () => {
    const mismatched: WorkspaceRegistryCandidate = {
      ...registry[0]!,
      lifecycle: "archived",
      manifestWorkspaceId: "ws-other",
    };
    const credentialSentinel = "https://token-sentinel@example.test/private.git";
    const facts: WorkspaceTargetInput & { readonly remote: string } = {
      ...input({ registry: [mismatched], explicit: id("ws-alpha") }),
      remote: credentialSentinel,
    };
    const decision = resolveWorkspaceTarget(facts);
    expect(decision).toEqual({
      ok: false,
      error: {
        code: "identity_mismatch",
        message: "Workspace registry and manifest identities do not match",
        candidates: [
          {
            workspaceId: "ws-alpha",
            root: "/workspaces/alpha",
            canonicalRoot: "/real/workspaces/alpha",
            lifecycle: "archived",
          },
        ],
      },
    });
    expect(JSON.stringify(decision)).not.toContain("token-sentinel");
  });

  it.each([
    {
      name: "identity",
      entries: [registry[0]!, { ...registry[1]!, workspaceId: "ws-alpha" }],
      message: "Workspace registry contains a duplicate workspace identity",
    },
    {
      name: "path",
      entries: [registry[0]!, { ...registry[1]!, canonicalRoot: "/real/workspaces/alpha" }],
      message: "Workspace registry contains a duplicate workspace path",
    },
  ])("retains complete duplicate $name evidence", ({ entries, message }) => {
    expect(resolveWorkspaceTarget(input({ registry: entries, explicit: id("ws-alpha") }))).toEqual({
      ok: false,
      error: {
        code: "duplicate_candidate",
        message,
        candidates: entries.map((entry) => ({
          workspaceId: entry.workspaceId,
          root: entry.root,
          canonicalRoot: entry.canonicalRoot,
          lifecycle: entry.lifecycle,
        })),
      },
    });
  });
});

describe("resolveWorkspaceTarget purity", () => {
  it("returns byte-equivalent decisions for repeated identical inputs without mutating facts", () => {
    const facts = input({
      operation: "mutation",
      explicit: path("/workspaces/alpha", "/real/workspaces/alpha"),
      environment: id("ws-alpha"),
      context: {
        cwdManifest: {
          workspaceId: "ws-alpha",
          root: "/workspaces/alpha",
          canonicalRoot: "/real/workspaces/alpha",
          containment: "safe",
        },
        issueManifest: {
          workspaceId: "ws-alpha",
          root: "/workspaces/alpha",
          canonicalRoot: "/real/workspaces/alpha",
          containment: "safe",
        },
      },
    });
    const before = JSON.stringify(facts);

    const first = resolveWorkspaceTarget(facts);
    const second = resolveWorkspaceTarget(facts);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(facts)).toBe(before);
  });

  it("uses locale-independent code-unit ordering for aggregate and error evidence", () => {
    const entries: readonly WorkspaceRegistryCandidate[] = [
      { ...registry[0]!, workspaceId: "ws-ä", manifestWorkspaceId: "ws-ä" },
      { ...registry[1]!, workspaceId: "ws-z", manifestWorkspaceId: "ws-z" },
    ];
    const aggregate = resolveWorkspaceTarget(input({ all: true, registry: entries }));
    expect(aggregate).toMatchObject({
      ok: true,
      target: { workspaces: [{ workspaceId: "ws-z" }, { workspaceId: "ws-ä" }] },
    });
  });

  it("keeps the core resolver behind an explicit runtime import and global-capability boundary", () => {
    const source = readFileSync(new URL("../src/workspace/target.ts", import.meta.url), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual([
      'import { isAbsolute } from "node:path";',
      'import type { WorkspaceIdentity, WorkspaceLifecycle } from "@roll/spec";',
    ]);
    expect(source).not.toMatch(/\b(?:process|globalThis|require|Deno|Bun|eval|Function)\b|import\s*\(/);
  });
});
