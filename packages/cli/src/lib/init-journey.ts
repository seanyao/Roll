/**
 * @responsibility Drives the init and onboard journey steps and next-step recommendations.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseBacklog } from "@roll/core";
import { classifyStatus } from "@roll/spec";
import { classifyInitState, collectInitFacts, type InitDiagnosis } from "./init-diagnosis.js";
import { initDesignNextCommand } from "./init-brief.js";

export interface JourneyRecommendation {
  state: string;
  next: string;
  why: string;
  story?: { id: string; desc: string };
  missingFact?: string;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function existsFile(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function hasPendingOnboardPlan(projectDir: string): boolean {
  return existsFile(join(projectDir, ".roll", "onboard-plan.yaml")) && !existsFile(join(projectDir, ".roll", "onboard-changeset.yaml"));
}

function briefDesignCommand(projectDir: string): string | null {
  return existsFile(join(projectDir, ".roll", "brief.md")) ? "roll design --from-file .roll/brief.md" : null;
}

function firstSentence(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function renderReason(diagnosis: InitDiagnosis): string {
  return firstSentence(diagnosis.reasons[0] ?? "Current project state determines the next action.");
}

function rollReadyRecommendation(projectDir: string): JourneyRecommendation {
  const backlogPath = join(projectDir, ".roll", "backlog.md");
  const items = parseBacklog(safeRead(backlogPath));
  const todo = items.find((item) => classifyStatus(item.status) === "todo");
  if (todo !== undefined) {
    return {
      state: "roll-ready",
      next: "roll loop go",
      story: { id: todo.id, desc: todo.desc },
      why: `${items.filter((item) => classifyStatus(item.status) === "todo").length} actionable Todo row found in .roll/backlog.md.`,
    };
  }

  const briefCommand = briefDesignCommand(projectDir);
  if (items.length === 0 && briefCommand !== null) {
    return {
      state: "roll-ready",
      next: briefCommand,
      missingFact: "no backlog stories in .roll/backlog.md",
      why: ".roll/brief.md exists, so design is the next step to create the first backlog story.",
    };
  }

  return {
    state: "roll-ready",
    next: items.length === 0 ? "roll design" : "roll status",
    missingFact: "no actionable 📋 Todo row in .roll/backlog.md",
    why: items.length === 0
      ? "Backlog exists, but it has no story rows yet."
      : "Backlog exists, but every row is done, in progress, or on hold.",
  };
}

export function recommendNext(projectDir: string): JourneyRecommendation {
  if (hasPendingOnboardPlan(projectDir)) {
    return {
      state: "onboard-plan-ready",
      next: "roll init --apply",
      why: ".roll/onboard-plan.yaml exists and has not been applied yet.",
    };
  }

  const facts = collectInitFacts(projectDir);
  const diagnosis = classifyInitState(facts);
  switch (diagnosis.kind) {
    case "roll-ready":
      return rollReadyRecommendation(projectDir);
    case "roll-partial":
      return { state: diagnosis.kind, next: "roll init --repair", why: renderReason(diagnosis) };
    case "roll-legacy-layout":
      return { state: diagnosis.kind, next: diagnosis.nextCommand, why: renderReason(diagnosis) };
    case "codebase-no-roll":
      return { state: diagnosis.kind, next: "$roll-onboard", why: renderReason(diagnosis) };
    case "prd-only":
      return { state: diagnosis.kind, next: initDesignNextCommand(diagnosis.kind, facts), why: renderReason(diagnosis) };
    case "empty":
      return {
        state: diagnosis.kind,
        next: "roll init",
        missingFact: "no project brief or product document found",
        why: renderReason(diagnosis),
      };
    case "ambiguous":
      return {
        state: diagnosis.kind,
        next: "roll init",
        missingFact: diagnosis.reasons[0] ?? "project intent is ambiguous",
        why: "Choose whether this directory is an existing codebase or a new product brief before mutating files.",
      };
  }
}

export function renderNextRecommendation(input: JourneyRecommendation): string {
  const lines = [
    "roll next",
    `State: ${input.state}`,
  ];
  if (input.missingFact !== undefined) lines.push(`Missing fact: ${input.missingFact}`);
  lines.push(`Next: ${input.next}`);
  if (input.story !== undefined) lines.push(`Story: ${input.story.id} — ${input.story.desc}`);
  lines.push(`Why: ${input.why}`);
  return `${lines.join("\n")}\n`;
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function mkdir(root: string, rel: string): void {
  mkdirSync(join(root, rel), { recursive: true });
}

function writeReady(root: string): void {
  write(root, "AGENTS.md", "# Agents\n");
  mkdir(root, ".roll/features");
  write(
    root,
    ".roll/backlog.md",
    [
      "| ID | Description | Status |",
      "|---|---|---|",
      "| [US-NEXT](.roll/features/app/US-NEXT/spec.md) | Ship the next useful slice | 📋 Todo |",
    ].join("\n") + "\n",
  );
}

export function renderInitJourneyAttestSmoke(): string {
  const original = process.cwd();
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "roll-next-journey-")));
  const lines = ["roll next attest smoke: init-journey", `workspace: ${workspace}`, ""];
  try {
    const prdOnly = { label: "prd-only", dir: join(workspace, "prd-only") };
    const codebaseOnboard = { label: "codebase-onboard", dir: join(workspace, "codebase-onboard") };
    const partialRoll = { label: "partial-roll", dir: join(workspace, "partial-roll") };
    const oldRollLayout = { label: "old-roll-layout", dir: join(workspace, "old-roll-layout") };
    const rollReady = { label: "roll-ready", dir: join(workspace, "roll-ready") };
    const fixtures = [prdOnly, codebaseOnboard, partialRoll, oldRollLayout, rollReady];

    write(prdOnly.dir, "docs/PRD.md", "# Radar\n\nA product requirements document for an app.\n");
    mkdir(codebaseOnboard.dir, ".roll");
    write(codebaseOnboard.dir, ".roll/init-diagnosis.yaml", "kind: codebase-no-roll\n");
    write(codebaseOnboard.dir, ".roll/onboard-plan.yaml", "schema_version: 1\n");
    write(codebaseOnboard.dir, "package.json", "{\"scripts\":{\"test\":\"vitest\"}}\n");
    mkdir(partialRoll.dir, ".roll");
    write(partialRoll.dir, ".roll/backlog.md", "# Backlog\n");
    write(oldRollLayout.dir, "BACKLOG.md", "# Old Roll backlog\n");
    writeReady(rollReady.dir);

    for (const { label, dir } of fixtures) {
      process.chdir(dir);
      lines.push(`[${label}]`);
      lines.push(renderNextRecommendation(recommendNext(dir)).trimEnd());
      lines.push("");
    }
  } finally {
    process.chdir(original);
    rmSync(workspace, { recursive: true, force: true });
  }
  lines.push(`cleanup: removed ${workspace}`);
  return `${lines.join("\n")}\n`;
}
