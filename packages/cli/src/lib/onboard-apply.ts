/**
 * @responsibility Applies the onboard plan to an existing project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectInitFacts, type InitFacts } from "./init-diagnosis.js";
import { computeInitFactsHash } from "./onboard-plan.js";

export interface OnboardApplyPreflightDeps {
  collectFacts?: (projectDir: string) => InitFacts;
  readPlanFactsHash?: (planPath: string) => string | null;
}

export interface OnboardApplyPreflightResult {
  ok: boolean;
  errors: string[];
  currentFactsHash?: string;
  planFactsHash?: string;
}

export interface OnboardApplyReviewInput {
  projectDir: string;
  approved: readonly string[];
  gitignoreDotRoll: boolean;
  agentRoutesTemplate: string;
  includeClaudeConventions: boolean;
  includeAgentRoutes: boolean;
  includePhase2Artifacts: boolean;
}

export interface OnboardApplyReviewOperation {
  action: "append" | "create" | "keep" | "merge" | "replace";
  target: string;
  mode: "append-line" | "create-if-missing" | "ensure-directory" | "replace" | "section-merge";
  ownerContent: "not present" | "preserved" | "replaced" | "roll-owned";
}

export interface OnboardApplyReviewLabels {
  title: string;
  action: string;
  target: string;
  mode: string;
  ownerContent: string;
  actions: Record<OnboardApplyReviewOperation["action"], string>;
  modes: Record<OnboardApplyReviewOperation["mode"], string>;
  ownerContentValues: Record<OnboardApplyReviewOperation["ownerContent"], string>;
}

const DEFAULT_ONBOARD_APPLY_REVIEW_LABELS: OnboardApplyReviewLabels = {
  title: "Onboard apply review checkpoint",
  action: "action",
  target: "target",
  mode: "mode",
  ownerContent: "owner content",
  actions: { append: "append", create: "create", keep: "keep", merge: "merge", replace: "replace" },
  modes: {
    "append-line": "append-line",
    "create-if-missing": "create-if-missing",
    "ensure-directory": "ensure-directory",
    replace: "replace",
    "section-merge": "section-merge",
  },
  ownerContentValues: {
    "not present": "not present",
    preserved: "preserved",
    replaced: "replaced",
    "roll-owned": "roll-owned",
  },
};

export function readPlanFactsHash(planPath: string): string | null {
  const script = `
import json, sys, yaml
p = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}
value = p.get("factsHash")
print(json.dumps(value if isinstance(value, str) else None))
`;
  const result = spawnSync("python3", ["-c", script, planPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function validateOnboardApplyPreflight(
  projectDir: string,
  planPath: string,
  deps: OnboardApplyPreflightDeps = {},
): OnboardApplyPreflightResult {
  const facts = deps.collectFacts?.(projectDir) ?? collectInitFacts(projectDir, { ignoreOnboardArtifacts: true });
  const currentFactsHash = computeInitFactsHash(facts);
  const planFactsHash = (deps.readPlanFactsHash ?? readPlanFactsHash)(planPath);
  const errors: string[] = [];
  if (planFactsHash === null) errors.push("could not read factsHash from .roll/onboard-plan.yaml");
  else if (planFactsHash !== currentFactsHash) {
    const diagnosisFactsHash = readDiagnosisFactsHash(join(projectDir, ".roll", "init-diagnosis.yaml"));
    const hasApplyMetadata = existsSync(join(projectDir, ".roll", "onboard-changeset.yaml"));
    if (hasApplyMetadata && diagnosisFactsHash === planFactsHash) {
      return { ok: true, errors: [], currentFactsHash, planFactsHash };
    }
    errors.push(`plan factsHash is stale: expected ${currentFactsHash}, got ${planFactsHash}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    currentFactsHash,
    ...(planFactsHash !== null ? { planFactsHash } : {}),
  };
}

function readDiagnosisFactsHash(path: string): string | null {
  if (!existsSync(path)) return null;
  const match = /^factsHash:\s*"?([^"\n]+)"?/m.exec(readFileSync(path, "utf8"));
  return match?.[1] ?? null;
}

function existsProjectPath(projectDir: string, target: string): boolean {
  return existsSync(join(projectDir, target.replace(/\/$/, "")));
}

function createIfMissing(projectDir: string, target: string): OnboardApplyReviewOperation {
  const exists = existsProjectPath(projectDir, target);
  return {
    action: exists ? "keep" : "create",
    target,
    mode: target.endsWith("/") ? "ensure-directory" : "create-if-missing",
    ownerContent: exists ? "roll-owned" : "not present",
  };
}

function replaceOrCreate(projectDir: string, target: string): OnboardApplyReviewOperation {
  const exists = existsProjectPath(projectDir, target);
  return {
    action: exists ? "replace" : "create",
    target,
    mode: exists ? "replace" : "create-if-missing",
    ownerContent: exists ? "replaced" : "not present",
  };
}

function mergeSections(projectDir: string, target: string): OnboardApplyReviewOperation {
  const exists = existsProjectPath(projectDir, target);
  return {
    action: exists ? "merge" : "create",
    target,
    mode: exists ? "section-merge" : "create-if-missing",
    ownerContent: exists ? "preserved" : "not present",
  };
}

function gitignoreOperation(projectDir: string): OnboardApplyReviewOperation {
  const target = ".gitignore";
  const path = join(projectDir, target);
  const exists = existsSync(path);
  const hasEntry = exists && readFileSync(path, "utf8").split("\n").includes(".roll/");
  return {
    action: hasEntry ? "keep" : "append",
    target,
    mode: "append-line",
    ownerContent: exists ? "preserved" : "not present",
  };
}

export function buildOnboardApplyReviewOperations(input: OnboardApplyReviewInput): OnboardApplyReviewOperation[] {
  const approved = new Set(input.approved);
  const operations: OnboardApplyReviewOperation[] = [mergeSections(input.projectDir, "AGENTS.md")];

  if (input.includeClaudeConventions) operations.push(mergeSections(input.projectDir, ".claude/CLAUDE.md"));

  operations.push(replaceOrCreate(input.projectDir, ".roll/onboard-changeset.yaml"));
  operations.push(createIfMissing(input.projectDir, ".roll/.version"));
  if (approved.has("backlog")) operations.push(createIfMissing(input.projectDir, ".roll/backlog.md"));
  if (input.agentRoutesTemplate !== "skip" && input.includeAgentRoutes) {
    operations.push(createIfMissing(input.projectDir, ".roll/agents.yaml"));
  }
  if (approved.has("features")) {
    operations.push(createIfMissing(input.projectDir, ".roll/features/"));
    operations.push(createIfMissing(input.projectDir, ".roll/features.md"));
  }
  if (approved.has("domain")) operations.push(createIfMissing(input.projectDir, ".roll/domain/"));
  if (approved.has("briefs")) operations.push(createIfMissing(input.projectDir, ".roll/briefs/"));
  if (input.includePhase2Artifacts) {
    if (!approved.has("domain")) operations.push(createIfMissing(input.projectDir, ".roll/domain/"));
    operations.push(replaceOrCreate(input.projectDir, ".roll/domain/context-map.md"));
    operations.push(replaceOrCreate(input.projectDir, ".roll/tech-analysis.md"));
    operations.push(replaceOrCreate(input.projectDir, ".roll/test-assessment.md"));
  }
  if (input.gitignoreDotRoll) operations.push(gitignoreOperation(input.projectDir));

  return operations;
}

export function renderOnboardApplyReview(
  operations: readonly OnboardApplyReviewOperation[],
  labels: OnboardApplyReviewLabels = DEFAULT_ONBOARD_APPLY_REVIEW_LABELS,
): string {
  const actionWidth = Math.max(10, labels.action.length, ...operations.map((op) => labels.actions[op.action].length));
  const targetWidth = Math.max(32, labels.target.length, ...operations.map((op) => op.target.length));
  const modeWidth = Math.max(19, labels.mode.length, ...operations.map((op) => labels.modes[op.mode].length));
  const lines = [
    labels.title,
    `  ${labels.action.padEnd(actionWidth)}  ${labels.target.padEnd(targetWidth)}  ${labels.mode.padEnd(modeWidth)}  ${labels.ownerContent}`,
    ...operations.map(
      (op) =>
        `  ${labels.actions[op.action].padEnd(actionWidth)}  ${op.target.padEnd(targetWidth)}  ${labels.modes[op.mode].padEnd(modeWidth)}  ${labels.ownerContentValues[op.ownerContent]}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
