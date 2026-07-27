import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isNoTestsFoundOutput,
  planRepositoryPublish,
  resolveGateCommand,
  storyVerification,
  type CapturedFacts,
  type IntegrationFacts,
  type RepositoryLegFacts,
} from "@roll/core";
import type { CycleContext } from "@roll/core";
import type { RepositoryExecutionContext } from "@roll/spec";
import type { BoundRepositoryPorts, ExecuteResult, Ports } from "./ports.js";
import { observeWritableRepositories, type RepositoryObservationSummary } from "./repository-observation.js";
import { eventTs } from "./runner-time.js";

export interface RepositoryCaptureVerification {
  readonly blocked: boolean;
  readonly reason?: string;
  readonly publishPending?: boolean;
}

interface ResolvedTestCommand {
  readonly command?: readonly string[];
  readonly diagnostic?: string;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function nestedString(record: Record<string, unknown>, section: string, key: string): string | undefined {
  const value = record[section];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function resolveRepositoryTestCommand(repository: RepositoryExecutionContext): ResolvedTestCommand {
  if (repository.commands.test.length > 0) return { command: repository.commands.test };
  const packagePath = join(repository.worktreePath, "package.json");
  if (!existsSync(packagePath)) {
    return { diagnostic: "unsupported_toolchain: package.json and an explicit test command are both absent" };
  }
  const packageJson = readJsonObject(packagePath);
  if (packageJson === undefined) return { diagnostic: "invalid_package_json" };
  const vitestPackage = readJsonObject(join(repository.worktreePath, "node_modules", "vitest", "package.json"));
  const vitestVersion = vitestPackage?.["version"];
  const resolution = resolveGateCommand({
    hasPackageJson: true,
    testScript: nestedString(packageJson, "scripts", "test"),
    ...(typeof vitestVersion === "string" ? { vitestVersion } : {}),
  });
  if (!resolution.ok) return { diagnostic: resolution.reason };
  return {
    command: [
      "npm",
      "test",
      ...(resolution.plan.npmTestArgs.length === 0 ? [] : ["--", ...resolution.plan.npmTestArgs]),
    ],
  };
}

function outputHasNoTests(stdout: string, stderr: string): boolean {
  return isNoTestsFoundOutput(`${stdout}\n${stderr}`);
}

function dependencyRepoId(
  execution: NonNullable<CycleContext["repositoryExecution"]>,
  dependency: string | undefined,
): string | undefined {
  if (dependency === undefined) return undefined;
  if (execution.repositories[dependency] !== undefined) return dependency;
  return Object.values(execution.repositories).find((repository) => repository.alias === dependency)?.repoId ?? dependency;
}

function currentCycleOwnerExemptions(ctx: CycleContext): ReadonlySet<string> {
  const execution = ctx.repositoryExecution;
  const storyId = ctx.storyId ?? "";
  if (execution === undefined || storyId === "") return new Set();
  const path = join(execution.issueRoot, "events.jsonl");
  if (!existsSync(path)) return new Set();
  const exempted = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof event === "object" && event !== null && !Array.isArray(event) &&
      (event as Record<string, unknown>)["type"] === "issue:repository_no_change_exempted" &&
      (event as Record<string, unknown>)["workspaceId"] === execution.workspaceId &&
      (event as Record<string, unknown>)["storyId"] === storyId &&
      (event as Record<string, unknown>)["cycleId"] === ctx.cycleId &&
      (event as Record<string, unknown>)["approved"] === true &&
      typeof (event as Record<string, unknown>)["repoId"] === "string"
    ) {
      exempted.add((event as Record<string, unknown>)["repoId"] as string);
    }
  }
  return exempted;
}

export async function verifyRepositoryCapture(
  ctx: CycleContext,
  repositories: BoundRepositoryPorts,
  observed: RepositoryObservationSummary,
  now: () => number,
): Promise<RepositoryCaptureVerification> {
  const execution = ctx.repositoryExecution;
  const storyId = ctx.storyId ?? "";
  if (execution === undefined) throw new Error("missing_repository_context");
  if (storyId === "") throw new Error("missing_story_id");

  const legFacts: RepositoryLegFacts[] = [];
  const currentHeads: Record<string, string> = {};
  const ownerExemptions = currentCycleOwnerExemptions(ctx);
  const writable = observed.legs.map((leg) => repositories.context(leg.repoId));
  for (const leg of observed.legs) {
    const repository = repositories.context(leg.repoId);
    let headSha: string;
    try {
      headSha = await repositories.git.headSha(leg.repoId);
    } catch {
      repositories.events.append(leg.repoId, {
        type: "repository:verification",
        status: "fail",
        command: [],
        diagnostic: "head_observation_failed",
        headSha: "",
        ts: now(),
      });
      legFacts.push({
        repoId: leg.repoId,
        alias: repository.alias,
        access: repository.access,
        requiredDelivery: repository.requiredDelivery,
        changed: leg.commitsAhead > 0,
        dirty: leg.worktreeDirty,
        tcrCount: leg.tcrCount,
        testResult: "fail",
        noChangeAllowed: repository.noChangePolicy === "no_change_allowed",
        ownerExemption: ownerExemptions.has(leg.repoId),
      });
      continue;
    }
    currentHeads[leg.repoId] = headSha;
    const resolved = resolveRepositoryTestCommand(repository);
    let testResult: RepositoryLegFacts["testResult"] = "not_run";
    let exitCode: number | undefined;
    let diagnostic = resolved.diagnostic;
    if (leg.commitsAhead > 0 && resolved.command !== undefined) {
      try {
        const result = await repositories.verification.runRepository(leg.repoId, resolved.command);
        exitCode = result.exitCode;
        testResult = result.exitCode === 0 && !outputHasNoTests(result.stdout, result.stderr) ? "pass" : "fail";
        if (result.exitCode === 0 && outputHasNoTests(result.stdout, result.stderr)) diagnostic = "zero_tests";
      } catch {
        exitCode = 127;
        testResult = "fail";
        diagnostic = "command_execution_failed";
      }
    }
    repositories.events.append(leg.repoId, {
      type: "repository:verification",
      status: testResult,
      command: resolved.command ?? [],
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      headSha,
      ts: now(),
    });
    legFacts.push({
      repoId: leg.repoId,
      alias: repository.alias,
      access: repository.access,
      requiredDelivery: repository.requiredDelivery,
      changed: leg.commitsAhead > 0,
      dirty: leg.worktreeDirty,
      tcrCount: leg.tcrCount,
      testResult,
      noChangeAllowed: repository.noChangePolicy === "no_change_allowed",
      ownerExemption: ownerExemptions.has(leg.repoId),
    });
  }

  const integrationAcceptance = execution.integrationAcceptance;
  let integration: IntegrationFacts = { ran: false };
  const headsComplete = writable.every((repository) => currentHeads[repository.repoId] !== undefined);
  if (integrationAcceptance !== undefined && headsComplete) {
    const env = { ROLL_INTEGRATION_INPUTS: JSON.stringify(currentHeads) };
    try {
      const result = await repositories.verification.runIntegration(
        integrationAcceptance.cwdRepoId,
        integrationAcceptance.command,
        env,
      );
      integration = { ran: true, exitCode: result.exitCode, inputHeads: currentHeads };
      repositories.events.appendIssue({
        type: "issue:integration_acceptance_recorded",
        status: result.exitCode === 0 ? "pass" : "fail",
        command: integrationAcceptance.command,
        exitCode: result.exitCode,
        inputHeads: currentHeads,
        ts: now(),
      });
    } catch {
      integration = { ran: true, exitCode: 127, inputHeads: currentHeads };
      repositories.events.appendIssue({
        type: "issue:integration_acceptance_recorded",
        status: "fail",
        command: integrationAcceptance.command,
        exitCode: 127,
        diagnostic: "command_execution_failed",
        inputHeads: currentHeads,
        ts: now(),
      });
    }
  } else if (integrationAcceptance !== undefined || writable.length > 1) {
    repositories.events.appendIssue({
      type: "issue:integration_acceptance_recorded",
      status: "not_run",
      command: [],
      inputHeads: currentHeads,
      diagnostic: headsComplete ? "integration_command_missing" : "integration_heads_incomplete",
      ts: now(),
    });
  }

  const verdict = storyVerification(legFacts, integration, {
    integrationDeclared: integrationAcceptance !== undefined,
  });
  if (!verdict.ok) return { blocked: true, reason: verdict.code };

  const plan = planRepositoryPublish(
    legFacts.map((leg) => {
      const dependency = dependencyRepoId(execution, repositories.context(leg.repoId).dependsOnRepo);
      return {
        repoId: leg.repoId,
        alias: leg.alias,
        changed: leg.changed,
        workBranch: repositories.context(leg.repoId).workBranch ?? "",
        ...(dependency === undefined ? {} : { dependsOnRepo: dependency }),
      };
    }),
  );
  if (!plan.ok) return { blocked: true, reason: plan.code };
  for (const entry of plan.entries) {
    repositories.events.append(entry.repoId, {
      type: "repository:publish_planned",
      branch: entry.branch,
      dependsOn: entry.dependsOn,
      headSha: currentHeads[entry.repoId] ?? "",
      ts: now(),
    });
  }
  return { blocked: false, publishPending: plan.entries.length > 0 };
}

export async function executeRepositoryCaptureFactsCommand(
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  const repositories = ports.repositories?.bind(ctx);
  if (repositories === undefined) throw new Error("missing_repository_ports");
  const observed = await observeWritableRepositories(ctx, repositories);
  for (const leg of observed.legs) {
    repositories.events.append(leg.repoId, {
      type: "repository:capture_observed",
      commitsAhead: leg.commitsAhead,
      tcrCount: leg.tcrCount,
      worktreeDirty: leg.worktreeDirty,
      ts: eventTs(ports),
    });
  }
  const verification = await verifyRepositoryCapture(ctx, repositories, observed, () => eventTs(ports));
  if (verification.blocked) {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `repository_verification_failed: Workspace cycle ${ctx.cycleId ?? "?"} failed repository-scoped verification (${verification.reason ?? "unknown"}); per-leg evidence is preserved in the Issue event stream`,
    );
  } else if (verification.publishPending === true) {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `repository_publish_pending: Workspace cycle ${ctx.cycleId ?? "?"} passed repository verification and recorded per-repository publish plans; provider delivery remains pending`,
    );
  }
  const facts: CapturedFacts = {
    usedWorktree: true,
    agentExecuted: (ctx.agent ?? "").trim() !== "",
    agentExit: ctx.agentExitCode ?? 0,
    timedOut: false,
    commitsAhead: observed.commitsAhead,
    ...(observed.worktreeDirty ? { worktreeDirty: true } : {}),
    ...(verification.blocked ? { repositoryVerificationPending: true } : {}),
    ...(verification.publishPending === true ? { repositoryPublishPending: true } : {}),
    ...(ctx.agentInternalFailure !== undefined ? { agentInternalFailure: ctx.agentInternalFailure } : {}),
  };
  return {
    event: { type: "facts_captured", facts },
    ctxPatch: {
      tcrCount: observed.tcrCount,
      ...(verification.blocked
        ? { failureClass: "harness" as const, rootCauseKey: "harness:repository_verification_failed" }
        : {}),
    },
  };
}
