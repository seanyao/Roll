import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { collectInitFacts, classifyInitState, type InitFacts } from "../src/lib/init-diagnosis.js";
import {
  buildOnboardApplyReviewOperations,
  renderOnboardApplyReview,
  validateOnboardApplyPreflight,
} from "../src/lib/onboard-apply.js";
import {
  buildOnboardDiagnosisArtifact,
  computeInitFactsHash,
  defaultOnboardFileOperations,
  renderOnboardDiagnosisYaml,
  validateOnboardFactsHashMatch,
  validateOnboardPlanContract,
} from "../src/lib/onboard-plan.js";

const REPO = resolve(__dirname, "../../..");
const VALID_HASH = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_HASH = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const dirs: string[] = [];

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function project(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `roll-init-agentic-${name}-`));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeExistingCodebase(root: string): void {
  write(root, "package.json", '{"scripts":{"test":"vitest"}}\n');
  write(root, "src/index.ts", "export const answer = 42;\n");
  write(root, "tests/index.test.ts", "import { expect, it } from 'vitest';\nit('works', () => expect(1).toBe(1));\n");
}

function withCapturedInit(cwd: string): Run {
  const saveCwd = process.cwd();
  const emptyBin = mkdtempSync(join(tmpdir(), "roll-init-agentic-empty-bin-"));
  dirs.push(emptyBin);
  const saveEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    ROLL_HOME: process.env["ROLL_HOME"],
    ROLL_PKG_DIR: process.env["ROLL_PKG_DIR"],
    NO_COLOR: process.env["NO_COLOR"],
    ROLL_LANG: process.env["ROLL_LANG"],
  };
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const restore = (): void => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const [key, value] of Object.entries(saveEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  process.chdir(cwd);
  process.env["PATH"] = emptyBin;
  process.env["HOME"] = cwd;
  process.env["ROLL_HOME"] = REPO;
  process.env["ROLL_PKG_DIR"] = REPO;
  process.env["NO_COLOR"] = "1";
  process.env["ROLL_LANG"] = "en";
  // @ts-expect-error capture-only
  process.stdout.write = (chunk: string | Uint8Array): boolean => (out.push(String(chunk)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (chunk: string | Uint8Array): boolean => (err.push(String(chunk)), true);
  try {
    const status = initCommand([]);
    return { status, stdout: out.join(""), stderr: err.join("") };
  } finally {
    restore();
  }
}

function validPlan(hash = VALID_HASH): string {
  return `version: 1
generated_at: "${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}"
factsHash: "${hash}"
file_operations:
  - path: .roll/init-diagnosis.yaml
    operation: write
    idempotent: true
  - path: .roll/onboard-plan.yaml
    operation: write
    idempotent: true
merge_intents:
  - target: roll_conventions
    owner: roll-init-apply
    strategy: merge global Roll conventions into AGENTS.md
  - target: backlog
    owner: roll-init-apply
    strategy: create only when approved by scope
project_understanding:
  type: cli
  description: test cli
  domains: []
  key_modules: []
scope:
  approved: [backlog]
  declined: []
include_existing: []
privacy:
  gitignore_dot_roll: true
sync_targets: []
agent_routes_template: skip
domain_model:
  bounded_contexts: []
tech_analysis:
  stack: [TypeScript]
  dependencies: [Vitest]
  architecture_notes: [test fixture]
  risks: []
test_assessment:
  current_layers:
    - claim: "1 test file detected"
      evidence: detected
  gaps:
    - claim: "none detected"
      evidence: detected
  recommended_actions: []
`;
}

function diagnosis(hash = VALID_HASH): string {
  return `version: 1
createdAt: "2026-06-27T00:00:00Z"
factsHash: "${hash}"
diagnosis:
  kind: codebase-no-roll
  recommendedPath: agentic-onboard
  confidence: high
  reasons:
    - Existing source, tests, or manifests found without Roll markers.
agent:
  name: codex
  status: available
`;
}

function validatePlan(planText: string, diagnosisText = diagnosis()): Run {
  const dir = project("validator");
  mkdirSync(join(dir, ".roll"), { recursive: true });
  writeFileSync(join(dir, ".roll", "init-diagnosis.yaml"), diagnosisText);
  const planPath = join(dir, ".roll", "onboard-plan.yaml");
  writeFileSync(planPath, planText);
  const result = spawnSync("python3", [join(REPO, "lib", "roll-plan-validate.py"), planPath], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function facts(overrides: Partial<InitFacts> = {}): InitFacts {
  return {
    root: "/tmp/one",
    git: { present: false, commits: 0 },
    roll: { dotRoll: false, backlog: false, features: false, agentsDoc: false, oldMarkers: [] },
    codebase: { manifests: ["package.json"], sourceDirs: ["src"], testDirs: ["tests"], sourceFileCount: 2 },
    docs: { hasContent: false, prdFiles: [], readmeFiles: [], designDocs: [], extractedSignals: [] },
    ambiguityReasons: [],
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("agentic onboard structured artifacts", () => {
  it("renders the init diagnosis artifact with version, createdAt, factsHash, diagnosis, and agent metadata", () => {
    const inputFacts = facts();
    const diagnosisResult = classifyInitState(inputFacts);

    const artifact = buildOnboardDiagnosisArtifact({
      createdAt: "2026-06-27T00:00:00Z",
      facts: inputFacts,
      diagnosis: diagnosisResult,
      agent: { name: "codex", status: "available" },
    });
    const yaml = renderOnboardDiagnosisYaml(artifact);

    expect(artifact.version).toBe(1);
    expect(artifact.factsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(yaml).toContain('createdAt: "2026-06-27T00:00:00Z"');
    expect(yaml).toContain("factsHash: ");
    expect(yaml).toContain('kind: "codebase-no-roll"');
    expect(yaml).toContain('recommendedPath: "agentic-onboard"');
    expect(yaml).toContain("name: \"codex\"");
    expect(yaml).toContain("status: \"available\"");
  });

  it("computes deterministic facts hashes and prints the same hash in the existing-codebase init diagnosis", () => {
    const root = project("hash");
    writeExistingCodebase(root);
    const collected = collectInitFacts(root);
    const expectedHash = computeInitFactsHash(collected);

    expect(computeInitFactsHash(collected)).toBe(expectedHash);
    expect(computeInitFactsHash({ ...collected, root: "/different/path" })).toBe(expectedHash);

    const run = withCapturedInit(root);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(`facts hash: ${expectedHash}`);
    expect(existsSync(join(root, ".roll"))).toBe(false);
  });

  it("accepts valid plan artifacts with idempotent file operations and CLI-owned merge intents", () => {
    const operations = defaultOnboardFileOperations();
    expect(operations).toEqual([
      { path: ".roll/init-diagnosis.yaml", operation: "write", idempotent: true },
      { path: ".roll/onboard-plan.yaml", operation: "write", idempotent: true },
    ]);

    const errors = validateOnboardPlanContract({
      version: 1,
      factsHash: VALID_HASH,
      file_operations: operations,
      merge_intents: [{ target: "roll_conventions", owner: "roll-init-apply", strategy: "merge conventions" }],
    });
    expect(errors).toEqual([]);

    const result = validatePlan(validPlan());
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("rejects forbidden file operations and arbitrary shell commands", () => {
    const errors = validateOnboardPlanContract({
      version: 1,
      factsHash: VALID_HASH,
      file_operations: [
        { path: ".roll/init-diagnosis.yaml", operation: "write", idempotent: true },
        { path: "AGENTS.md", operation: "write", idempotent: true },
        { path: ".gitignore", operation: "write", idempotent: true },
        { path: "src/index.ts", operation: "write", idempotent: true },
        { path: ".roll/backlog.md", operation: "write", idempotent: true },
        { path: "docs/architecture.md", operation: "write", idempotent: true },
        { path: ".roll/onboard-changeset.yaml", operation: "write", idempotent: true },
      ],
      merge_intents: [{ path: "AGENTS.md", owner: "agent", strategy: "write directly" }],
      shell_commands: ["touch AGENTS.md"],
    });

    expect(errors.join("\n")).toContain("AGENTS.md");
    expect(errors.join("\n")).toContain(".gitignore");
    expect(errors.join("\n")).toContain("src/index.ts");
    expect(errors.join("\n")).toContain(".roll/backlog.md");
    expect(errors.join("\n")).toContain("docs/architecture.md");
    expect(errors.join("\n")).toContain(".roll/onboard-changeset.yaml");
    expect(errors.join("\n")).toContain("$.shell_commands is not allowed");
    expect(errors.join("\n")).toContain("merge_intents[0] must describe a target, not a file path");

    const result = validatePlan(
      validPlan().replace(".roll/onboard-plan.yaml", "AGENTS.md").replace("recommended_actions: []", "recommended_actions: []\nshell: touch AGENTS.md"),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the agent writable outputs");
    expect(result.stderr).toContain("$.shell is not allowed");
  });

  it("rejects direct merge-intent paths through the Python apply validator", () => {
    const result = validatePlan(
      validPlan().replace(
        "  - target: roll_conventions\n    owner: roll-init-apply",
        "  - path: AGENTS.md\n    target: roll_conventions\n    owner: roll-init-apply",
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("merge_intents[0] must describe a target, not a file path");
  });

  it("rejects facts-hash mismatches between diagnosis and plan artifacts", () => {
    const contractErrors = validateOnboardFactsHashMatch({ factsHash: VALID_HASH }, { factsHash: OTHER_HASH });
    expect(contractErrors).toEqual(["plan factsHash must match .roll/init-diagnosis.yaml factsHash"]);

    const result = validatePlan(validPlan(OTHER_HASH), diagnosis(VALID_HASH));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plan factsHash must match .roll/init-diagnosis.yaml factsHash");
  });

  it("apply preflight recomputes current facts and rejects stale plan hashes", () => {
    const root = project("stale-preflight");
    writeExistingCodebase(root);
    mkdirSync(join(root, ".roll"), { recursive: true });
    const planPath = join(root, ".roll", "onboard-plan.yaml");
    writeFileSync(planPath, validPlan(VALID_HASH));

    const result = validateOnboardApplyPreflight(root, planPath);

    expect(result.ok).toBe(false);
    expect(result.currentFactsHash).toBe(computeInitFactsHash(collectInitFacts(root, { ignoreOnboardArtifacts: true })));
    expect(result.errors.join("\n")).toContain("plan factsHash is stale: expected sha256:");
    expect(result.errors.join("\n")).toContain(`got ${VALID_HASH}`);
  });

  it("apply preflight ignores only the two onboard artifacts when recomputing the facts hash", () => {
    const root = project("fresh-preflight");
    writeExistingCodebase(root);
    const hash = computeInitFactsHash(collectInitFacts(root));
    mkdirSync(join(root, ".roll"), { recursive: true });
    const planPath = join(root, ".roll", "onboard-plan.yaml");
    writeFileSync(planPath, validPlan(hash));
    writeFileSync(join(root, ".roll", "init-diagnosis.yaml"), diagnosis(hash));

    const result = validateOnboardApplyPreflight(root, planPath);

    expect(result).toMatchObject({ ok: true, errors: [], currentFactsHash: hash, planFactsHash: hash });
  });

  it("renders the onboard apply review checkpoint with every deterministic operation", () => {
    const root = project("apply-review-render");
    const operations = buildOnboardApplyReviewOperations({
      projectDir: root,
      approved: ["backlog", "features", "domain", "briefs"],
      gitignoreDotRoll: true,
      agentRoutesTemplate: "default",
      includeClaudeConventions: false,
      includeAgentRoutes: true,
      includePhase2Artifacts: false,
    });

    expect(renderOnboardApplyReview(operations)).toMatchInlineSnapshot(`
      "Onboard apply review checkpoint
        action      target                            mode                 owner content
        create      AGENTS.md                         create-if-missing    not present
        create      .roll/onboard-changeset.yaml      create-if-missing    not present
        create      .roll/.version                    create-if-missing    not present
        create      .roll/backlog.md                  create-if-missing    not present
        create      .roll/agents.yaml                 create-if-missing    not present
        create      .roll/features/                   ensure-directory     not present
        create      .roll/features.md                 create-if-missing    not present
        create      .roll/domain/                     ensure-directory     not present
        create      .roll/briefs/                     ensure-directory     not present
        append      .gitignore                        append-line          not present
      "
    `);
  });

  it("renders the onboard apply review checkpoint with caller-provided labels", () => {
    const rendered = renderOnboardApplyReview(
      [
        {
          action: "merge",
          target: "AGENTS.md",
          mode: "section-merge",
          ownerContent: "preserved",
        },
      ],
      {
        title: "Review",
        action: "Act",
        target: "Path",
        mode: "Mode",
        ownerContent: "Owner",
        actions: { append: "A", create: "C", keep: "K", merge: "M", replace: "R" },
        modes: {
          "append-line": "Append",
          "create-if-missing": "Create",
          "ensure-directory": "Dir",
          replace: "Replace",
          "section-merge": "Merge",
        },
        ownerContentValues: { "not present": "Missing", preserved: "Saved", replaced: "Changed", "roll-owned": "Roll" },
      },
    );

    expect(rendered).toMatchInlineSnapshot(`
      "Review
        Act         Path                              Mode                 Owner
        M           AGENTS.md                         Merge                Saved
      "
    `);
  });

  it("marks .gitignore owner content as preserved only when the file already exists", () => {
    const root = project("apply-review-gitignore");
    write(root, ".gitignore", "dist/\n");

    const operation = buildOnboardApplyReviewOperations({
      projectDir: root,
      approved: [],
      gitignoreDotRoll: true,
      agentRoutesTemplate: "skip",
      includeClaudeConventions: false,
      includeAgentRoutes: false,
      includePhase2Artifacts: false,
    }).find((op) => op.target === ".gitignore");

    expect(operation).toEqual({
      action: "append",
      target: ".gitignore",
      mode: "append-line",
      ownerContent: "preserved",
    });
  });

  it("marks existing merge, keep, and replace targets accurately", () => {
    const root = project("apply-review-existing-targets");
    write(root, "AGENTS.md", "# Project Agents\n");
    write(root, ".gitignore", ".roll/\n");
    write(root, ".roll/domain/context-map.md", "# Old Context\n");
    write(root, ".roll/tech-analysis.md", "# Old Tech\n");
    write(root, ".roll/test-assessment.md", "# Old Tests\n");

    const operations = buildOnboardApplyReviewOperations({
      projectDir: root,
      approved: [],
      gitignoreDotRoll: true,
      agentRoutesTemplate: "skip",
      includeClaudeConventions: false,
      includeAgentRoutes: false,
      includePhase2Artifacts: true,
    });

    expect(operations.find((op) => op.target === "AGENTS.md")).toEqual({
      action: "merge",
      target: "AGENTS.md",
      mode: "section-merge",
      ownerContent: "preserved",
    });
    expect(operations.find((op) => op.target === ".gitignore")).toEqual({
      action: "keep",
      target: ".gitignore",
      mode: "append-line",
      ownerContent: "preserved",
    });
    expect(operations.find((op) => op.target === ".roll/domain/context-map.md")).toEqual({
      action: "replace",
      target: ".roll/domain/context-map.md",
      mode: "replace",
      ownerContent: "replaced",
    });
  });

  it("includes generated Phase 2 artifacts in the onboard apply review checkpoint", () => {
    const root = project("apply-review-phase2");
    const operations = buildOnboardApplyReviewOperations({
      projectDir: root,
      approved: ["backlog"],
      gitignoreDotRoll: false,
      agentRoutesTemplate: "skip",
      includeClaudeConventions: false,
      includeAgentRoutes: false,
      includePhase2Artifacts: true,
    });

    expect(operations.filter((op) => op.target.startsWith(".roll/"))).toEqual([
      { action: "create", target: ".roll/onboard-changeset.yaml", mode: "create-if-missing", ownerContent: "not present" },
      { action: "create", target: ".roll/.version", mode: "create-if-missing", ownerContent: "not present" },
      { action: "create", target: ".roll/backlog.md", mode: "create-if-missing", ownerContent: "not present" },
      { action: "create", target: ".roll/domain/", mode: "ensure-directory", ownerContent: "not present" },
      { action: "create", target: ".roll/domain/context-map.md", mode: "create-if-missing", ownerContent: "not present" },
      { action: "create", target: ".roll/tech-analysis.md", mode: "create-if-missing", ownerContent: "not present" },
      { action: "create", target: ".roll/test-assessment.md", mode: "create-if-missing", ownerContent: "not present" },
    ]);
  });

  it("rejects unrooted or non-normalized file operation paths through both TS and Python validators", () => {
    for (const badPath of ["../.roll/onboard-plan.yaml", "/tmp/onboard-plan.yaml", ".roll\\onboard-plan.yaml"]) {
      const errors = validateOnboardPlanContract({
        version: 1,
        factsHash: VALID_HASH,
        file_operations: [
          { path: ".roll/init-diagnosis.yaml", operation: "write", idempotent: true },
          { path: badPath, operation: "write", idempotent: true },
        ],
        merge_intents: [{ target: "roll_conventions", owner: "roll-init-apply", strategy: "merge conventions" }],
      });
      expect(errors.join("\n")).toContain("file_operations[1].path must be a normalized relative project path without traversal");
    }

    for (const badPath of ["../.roll/onboard-plan.yaml", "/tmp/onboard-plan.yaml", ".roll\\onboard-plan.yaml"]) {
      const result = validatePlan(validPlan().replace(".roll/onboard-plan.yaml", badPath));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("file_operations[1].path must be a normalized relative project path without traversal");
    }
  });

  it("rejects duplicate file operation paths through both TS and Python validators", () => {
    const errors = validateOnboardPlanContract({
      version: 1,
      factsHash: VALID_HASH,
      file_operations: [
        { path: ".roll/init-diagnosis.yaml", operation: "write", idempotent: true },
        { path: ".roll/init-diagnosis.yaml", operation: "write", idempotent: true },
      ],
      merge_intents: [{ target: "roll_conventions", owner: "roll-init-apply", strategy: "merge conventions" }],
    });

    expect(errors.join("\n")).toContain("file_operations[1].path '.roll/init-diagnosis.yaml' must not be duplicated");

    const result = validatePlan(validPlan().replace(".roll/onboard-plan.yaml", ".roll/init-diagnosis.yaml"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("file_operations[1].path '.roll/init-diagnosis.yaml' must not be duplicated");
  });

  it("rejects non-idempotent file operations through both TS and Python validators", () => {
    const errors = validateOnboardPlanContract({
      version: 1,
      factsHash: VALID_HASH,
      file_operations: [
        { path: ".roll/init-diagnosis.yaml", operation: "write", idempotent: true },
        { path: ".roll/onboard-plan.yaml", operation: "write", idempotent: false },
      ],
      merge_intents: [{ target: "roll_conventions", owner: "roll-init-apply", strategy: "merge conventions" }],
    });

    expect(errors.join("\n")).toContain("file_operations[1].idempotent must be true");

    const result = validatePlan(validPlan().replace("    idempotent: true\nmerge_intents:", "    idempotent: false\nmerge_intents:"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("file_operations[1].idempotent must be true");
  });

  it("rejects unsupported onboard plan schema versions", () => {
    const result = validatePlan(validPlan().replace("version: 1", "version: 99"));

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("version 99 not supported");
  });

  it("documents the roll-onboard skill contract as structured existing-codebase outputs only", () => {
    const body = readFileSync(join(REPO, "skills", "roll-onboard", "SKILL.md"), "utf8");

    expect(body).toContain("existing codebase without Roll");
    expect(body).toContain("You may write exactly these two files");
    expect(body).toContain("1. `.roll/init-diagnosis.yaml`");
    expect(body).toContain("2. `.roll/onboard-plan.yaml`");
    expect(body).toContain("Do not use this skill for PRD-only workspaces");
    expect(body).toContain("No `cmd`, `command`, `commands`, `exec`, `run`, `script`, `shell`, or `shell_commands` keys.");
    expect(body).toContain("Do not run `roll init --apply` yourself.");
    expect(body).toContain("Review `.roll/init-diagnosis.yaml` and `.roll/onboard-plan.yaml` before applying.");
    expect(body).toContain("roll init --apply --auto");
  });
});
