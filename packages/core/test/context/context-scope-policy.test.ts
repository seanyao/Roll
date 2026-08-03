import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_EXECUTION_CONTEXT_V1,
  type ContextPageScopeV1,
  type RepositoryBinding,
  type WorkspaceExecutionContextV1,
} from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  evaluateContextScope,
  normalizeContextScopeRequest,
  type ContextScopeRequestFacts,
} from "../../src/context/scope-policy.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function binding(remote: string, index: number): RepositoryBinding {
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: `repo-${index}`,
    alias: `repo-${index}`,
    remote,
    integrationBranch: "main",
    provider: "github",
    workflow: { branchPattern: "roll/{workspaceId}/{storyId}", requiredChecks: [] },
  };
}

function workspace(remotes: readonly string[] = ["https://gitee.com/bipo/dukang-axis.git"]): WorkspaceExecutionContextV1 {
  return {
    schema: WORKSPACE_EXECUTION_CONTEXT_V1,
    workspace: {
      workspaceId: "roll",
      root: "/workspace/roll",
      canonicalRoot: "/workspace/roll",
      lifecycle: "active",
    },
    resolution: { source: "explicit", evidence: [] },
    bindings: remotes.map(binding),
    authorities: {
      backlog: "/workspace/roll/backlog",
      features: "/workspace/roll/features",
      design: "/workspace/roll/design",
      requirements: "/workspace/roll/requirements",
      policy: "/workspace/roll/policy.yaml",
      evidence: "/workspace/roll/evidence",
      toolDumps: "/workspace/roll/tool-dumps",
      events: "/workspace/roll/events",
      runtime: "/workspace/roll/runtime",
      locks: "/workspace/roll/locks",
    },
  };
}

function request(overrides: Partial<ContextScopeRequestFacts> = {}): ContextScopeRequestFacts {
  return {
    workspace: workspace(),
    storyId: "US-CONTEXT-004",
    stage: "build",
    environmentIds: ["sit"],
    ...overrides,
  };
}

type DecisionCase = {
  readonly label: string;
  readonly page: ContextPageScopeV1;
  readonly request: ContextScopeRequestFacts;
  readonly allowed: boolean;
  readonly matchedScope?: Readonly<Record<string, readonly string[]>>;
  readonly mismatchedDimensions?: readonly string[];
};

const decisionTable: readonly DecisionCase[] = [
  {
    label: "unscoped page",
    page: {},
    request: request(),
    allowed: true,
    matchedScope: {},
  },
  {
    label: "workspace comes from WorkspaceExecutionContextV1",
    page: { workspace_ids: ["other", "roll"] },
    request: request(),
    allowed: true,
    matchedScope: { workspace_ids: ["roll"] },
  },
  {
    label: "workspace mismatch",
    page: { workspace_ids: ["other"] },
    request: request(),
    allowed: false,
    mismatchedDimensions: ["workspace_ids"],
  },
  {
    label: "one repository exact match",
    page: { repository_ids: ["https://gitee.com/bipo/dukang-axis"] },
    request: request(),
    allowed: true,
    matchedScope: { repository_ids: ["https://gitee.com/bipo/dukang-axis"] },
  },
  {
    label: "multiple repositories use OR and sort the intersection",
    page: {
      repository_ids: [
        "https://github.com/Bipo/Web.git",
        "git@gitee.com:bipo/dukang-axis.git",
        "https://github.com/Bipo/Web.git",
      ],
    },
    request: request({
      workspace: workspace([
        "https://github.com/Bipo/Web.git",
        "git@gitee.com:bipo/dukang-axis.git",
        "https://github.com/Bipo/Web.git",
      ]),
    }),
    allowed: true,
    matchedScope: {
      repository_ids: [
        "https://github.com/Bipo/Web",
        "ssh://gitee.com/bipo/dukang-axis",
      ],
    },
  },
  {
    label: "SSH and HTTPS identities stay unequal",
    page: { repository_ids: ["git@gitee.com:bipo/dukang-axis.git"] },
    request: request({ workspace: workspace(["https://gitee.com/bipo/dukang-axis.git"]) }),
    allowed: false,
    mismatchedDimensions: ["repository_ids"],
  },
  {
    label: "multiple environments use OR and stable sorted intersection",
    page: { environment_ids: ["uat", "sit", "sit"] },
    request: request({ environmentIds: ["sit", "uat", "sit"] }),
    allowed: true,
    matchedScope: { environment_ids: ["sit", "uat"] },
  },
  {
    label: "missing explicit environment never infers from repository",
    page: { environment_ids: ["sit"] },
    request: request({
      workspace: workspace(["https://gitee.com/sit/axis-sit.git"]),
      environmentIds: undefined,
    }),
    allowed: false,
    mismatchedDimensions: ["environment_ids"],
  },
  {
    label: "empty request environment is a missing constrained dimension",
    page: { environment_ids: ["sit"] },
    request: request({ environmentIds: [] }),
    allowed: false,
    mismatchedDimensions: ["environment_ids"],
  },
  {
    label: "empty page arrays impose no restriction",
    page: { workspace_ids: [], repository_ids: [], environment_ids: [], story_ids: [], stages: [] },
    request: request({ storyId: undefined, environmentIds: undefined }),
    allowed: true,
    matchedScope: {},
  },
  {
    label: "Story trims and uppercases before exact membership",
    page: { story_ids: [" us-context-004 "] },
    request: request({ storyId: " us-context-004 " }),
    allowed: true,
    matchedScope: { story_ids: ["US-CONTEXT-004"] },
  },
  {
    label: "missing Story mismatches a constrained page",
    page: { story_ids: ["US-CONTEXT-004"] },
    request: request({ storyId: undefined }),
    allowed: false,
    mismatchedDimensions: ["story_ids"],
  },
  {
    label: "invalid Story syntax fails closed",
    page: {},
    request: request({ storyId: "../../US-CONTEXT-004" }),
    allowed: false,
    mismatchedDimensions: ["story_ids"],
  },
  {
    label: "stage is an exact closed value",
    page: { stages: ["qa", "build"] },
    request: request({ stage: "build" }),
    allowed: true,
    matchedScope: { stages: ["build"] },
  },
  {
    label: "stage mismatch",
    page: { stages: ["qa"] },
    request: request({ stage: "build" }),
    allowed: false,
    mismatchedDimensions: ["stages"],
  },
  {
    label: "invalid stage fails closed even for an unscoped page",
    page: {},
    request: request({ stage: "deploy" }),
    allowed: false,
    mismatchedDimensions: ["stages"],
  },
  {
    label: "uppercase environment is not silently canonicalized",
    page: {},
    request: request({ environmentIds: ["SIT"] }),
    allowed: false,
    mismatchedDimensions: ["environment_ids"],
  },
  {
    label: "AND across dimensions reports every mismatch in canonical order",
    page: {
      workspace_ids: ["roll"],
      repository_ids: ["https://gitee.com/bipo/other"],
      environment_ids: ["prod"],
      story_ids: ["US-CONTEXT-999"],
      stages: ["qa"],
    },
    request: request(),
    allowed: false,
    mismatchedDimensions: ["repository_ids", "environment_ids", "story_ids", "stages"],
  },
  {
    label: "glob substring and regex-like values never match",
    page: {
      workspace_ids: ["rol"],
      repository_ids: ["https://gitee.com/bipo/*"],
      environment_ids: ["si"],
      story_ids: ["US-CONTEXT-.*"],
      stages: ["buil" as "build"],
    },
    request: request(),
    allowed: false,
    mismatchedDimensions: ["workspace_ids", "repository_ids", "environment_ids", "story_ids", "stages"],
  },
];

describe("Context scope decision table", () => {
  it.each(decisionTable)("$label", ({ page, request: scopeRequest, allowed, matchedScope, mismatchedDimensions }) => {
    const result = evaluateContextScope(page, scopeRequest);
    if (allowed) {
      expect(result).toEqual({ allowed: true, matchedScope });
    } else {
      expect(result).toEqual({ allowed: false, code: "scope_mismatch", mismatchedDimensions });
      expect(result).not.toHaveProperty("content");
      expect(JSON.stringify(result)).not.toMatch(/Approved operational context|secret-value/u);
    }
  });

  it("stores every matched dimension in deterministic key and value order", () => {
    const page: ContextPageScopeV1 = {
      workspace_ids: ["roll"],
      repository_ids: ["https://github.com/Bipo/Web", "git@gitee.com:bipo/dukang-axis.git"],
      environment_ids: ["uat", "sit"],
      story_ids: ["US-CONTEXT-004"],
      stages: ["qa", "build"],
    };
    const facts = request({
      workspace: workspace(["git@gitee.com:bipo/dukang-axis.git", "https://github.com/Bipo/Web.git"]),
      environmentIds: ["sit", "uat"],
    });
    expect(evaluateContextScope(page, facts)).toEqual({
      allowed: true,
      matchedScope: {
        workspace_ids: ["roll"],
        repository_ids: ["https://github.com/Bipo/Web", "ssh://gitee.com/bipo/dukang-axis"],
        environment_ids: ["sit", "uat"],
        story_ids: ["US-CONTEXT-004"],
        stages: ["build"],
      },
    });
  });

  it("applies the identical policy to an implicit entrypoint and returns no page payload on mismatch", () => {
    const implicitEntrypointMetadata = { environment_ids: ["prod"] } satisfies ContextPageScopeV1;
    const result = evaluateContextScope(implicitEntrypointMetadata, request({ environmentIds: ["sit"] }));
    expect(result).toEqual({
      allowed: false,
      code: "scope_mismatch",
      mismatchedDimensions: ["environment_ids"],
    });
    expect(Object.keys(result).sort()).toEqual(["allowed", "code", "mismatchedDimensions"]);
  });

  it("is deterministic, input-immutable and uses only explicit scope facts", () => {
    const page: ContextPageScopeV1 = { environment_ids: ["uat", "sit", "sit"] };
    const facts = request({ environmentIds: ["sit", "uat", "sit"] });
    const before = structuredClone({ page, facts });
    expect(evaluateContextScope(page, facts)).toEqual(evaluateContextScope(page, facts));
    expect({ page, facts }).toEqual(before);

    const source = ["scope-normalization.ts", "scope-policy.ts"]
      .map((file) => readFileSync(join(testDirectory, "..", "..", "src", "context", file), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/node:(?:fs|path|child_process)|process\.cwd|namespace|branch|semantic|natural.?language|substring|glob|regex|\bfetch\s*\(/iu);
  });

  it("normalizes repository facts through the Workspace normalizer and reports invalid request dimensions", () => {
    expect(normalizeContextScopeRequest(request({
      workspace: workspace(["git@Gitee.com:bipo/dukang-axis.git", "https://GitHub.com/Bipo/Web.git"]),
      storyId: " us-context-004 ",
      environmentIds: ["sit", "sit", "uat"],
    }))).toEqual({
      value: {
        workspace_ids: ["roll"],
        repository_ids: ["https://github.com/Bipo/Web", "ssh://gitee.com/bipo/dukang-axis"],
        environment_ids: ["sit", "uat"],
        story_ids: ["US-CONTEXT-004"],
        stages: ["build"],
      },
      invalidDimensions: [],
    });

    expect(normalizeContextScopeRequest(request({
      workspace: workspace(["https://token@example.com/bipo/private.git"]),
      storyId: "not a story",
      stage: "deploy",
      environmentIds: ["SIT"],
    })).invalidDimensions).toEqual(["repository_ids", "environment_ids", "story_ids", "stages"]);
  });
});
