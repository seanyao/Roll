/**
 * @responsibility Repairs the project facts and scaffolding issues found during init.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type InitFacts } from "./init-diagnosis.js";

export type InitRepairAction = "create" | "keep" | "merge" | "update";
export type InitRepairTargetKind = "file" | "directory" | "section" | "metadata";

export interface InitRepairOperation {
  action: InitRepairAction;
  target: string;
  kind: InitRepairTargetKind;
  ownerContent: "preserved" | "not present" | "roll-owned";
}

export interface InitRepairPlan {
  operations: InitRepairOperation[];
  missingRequired: string[];
  staleOldMarkers: string[];
}

function existsProjectPath(projectDir: string, rel: string): boolean {
  return existsSync(join(projectDir, rel.replace(/\/$/, "")));
}

function createOrKeep(projectDir: string, target: string, kind: InitRepairTargetKind): InitRepairOperation {
  const exists = existsProjectPath(projectDir, target);
  return {
    action: exists ? "keep" : "create",
    target,
    kind,
    ownerContent: exists ? "roll-owned" : "not present",
  };
}

function mergeOrCreate(projectDir: string, target: string): InitRepairOperation {
  const exists = existsProjectPath(projectDir, target);
  return {
    action: exists ? "merge" : "create",
    target,
    kind: exists ? "section" : "file",
    ownerContent: exists ? "preserved" : "not present",
  };
}

export function requiredRollMissingPieces(facts: InitFacts): string[] {
  const missing: string[] = [];
  if (!facts.roll.agentsDoc) missing.push("AGENTS.md");
  if (!facts.roll.backlog) missing.push(".roll/backlog.md");
  if (!facts.roll.features) missing.push(".roll/features/");
  return missing;
}

export function buildInitRepairPlan(projectDir: string, facts: InitFacts): InitRepairPlan {
  const operations: InitRepairOperation[] = [
    mergeOrCreate(projectDir, "AGENTS.md"),
    createOrKeep(projectDir, ".roll/backlog.md", "file"),
    createOrKeep(projectDir, ".roll/features/", "directory"),
    createOrKeep(projectDir, ".roll/features.md", "file"),
    createOrKeep(projectDir, ".roll/.version", "file"),
    {
      action: existsProjectPath(projectDir, ".roll/onboard-changeset.yaml") ? "update" : "create",
      target: ".roll/onboard-changeset.yaml",
      kind: "metadata",
      ownerContent: "roll-owned",
    },
  ];
  return {
    operations,
    missingRequired: requiredRollMissingPieces(facts),
    staleOldMarkers: facts.roll.oldMarkers,
  };
}

