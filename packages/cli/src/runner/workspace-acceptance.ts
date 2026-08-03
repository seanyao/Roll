import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acForStory, type CycleContext } from "@roll/core";
import { resolveWorkspaceBacklogStorySpec } from "@roll/infra";

interface IssueEvent {
  readonly type?: unknown;
  readonly cycleId?: unknown;
  readonly repoId?: unknown;
  readonly status?: unknown;
  readonly headSha?: unknown;
  readonly [key: string]: unknown;
}

export interface WorkspaceAcceptanceResult {
  readonly produced: boolean;
  readonly runDir: string;
  readonly reasons: readonly string[];
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}

function readIssueEvents(path: string): readonly IssueEvent[] {
  if (!existsSync(path)) return [];
  const events: IssueEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as IssueEvent);
      }
    } catch {
      return [];
    }
  }
  return events;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateArtifacts(runDir: string, storyId: string, expectedAcCount: number): boolean {
  const evidencePath = join(runDir, "evidence", "repository-verification.json");
  const mapPath = join(runDir, "ac-map.json");
  const reportPath = join(runDir, `${storyId}-report.html`);
  if (!existsSync(evidencePath) || !existsSync(mapPath) || !existsSync(reportPath)) return false;
  try {
    const map: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
    if (!Array.isArray(map) || map.length !== expectedAcCount || map.length === 0) return false;
    const valid = map.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      if (row["status"] !== "partial" || !Array.isArray(row["evidence"])) return false;
      return row["evidence"].some((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item) &&
        (item as Record<string, unknown>)["textFile"] === "evidence/repository-verification.json",
      );
    });
    return valid && readFileSync(reportPath, "utf8").includes('class="ac s-partial"');
  } catch {
    return false;
  }
}

/** Materialize the Workspace acceptance contract from exact-cycle repository
 * verification events. Repository verification is evidence input, not an
 * implicit green verdict: the gate passes only after durable ac-map/report
 * artifacts are written and read back successfully. */
export function writeWorkspaceAcceptanceArtifacts(ctx: CycleContext): WorkspaceAcceptanceResult {
  const execution = ctx.repositoryExecution;
  const storyId = ctx.storyId ?? "";
  const cycleId = ctx.cycleId ?? "";
  if (execution === undefined || storyId === "" || cycleId === "") {
    return { produced: false, runDir: "", reasons: ["missing_workspace_acceptance_identity"] };
  }
  const runDir = ctx.evidenceRunDir && ctx.evidenceRunDir !== ""
    ? ctx.evidenceRunDir
    : join(execution.issueRoot, "evidence", cycleId);
  const events = readIssueEvents(join(execution.issueRoot, "events.jsonl"))
    .filter((event) => event.cycleId === cycleId);
  if (events.length === 0) return { produced: false, runDir, reasons: ["workspace_acceptance_events_missing"] };

  const writable = Object.values(execution.repositories)
    .filter((repository) => repository.access === "write")
    .sort((left, right) => left.alias.localeCompare(right.alias));
  const evidenceEvents: IssueEvent[] = [];
  const gaps: string[] = [];
  for (const repository of writable) {
    const verification = [...events].reverse().find((event) =>
      event.type === "repository:verification" && event.repoId === repository.repoId,
    );
    const observed = [...events].reverse().find((event) =>
      event.type === "repository:capture_observed" && event.repoId === repository.repoId,
    );
    const exemption = [...events].reverse().find((event) =>
      event.type === "issue:repository_no_change_exempted" && event.repoId === repository.repoId && event["approved"] === true,
    );
    const acceptedNoChange = verification?.status === "not_run" && observed?.["commitsAhead"] === 0 &&
      (repository.noChangePolicy === "no_change_allowed" || exemption !== undefined);
    if ((verification?.status !== "pass" && !acceptedNoChange) || typeof verification.headSha !== "string" || verification.headSha === "") {
      gaps.push(`repository_verification_missing:${repository.alias}`);
      continue;
    }
    evidenceEvents.push(...[observed, exemption, verification].filter((event): event is IssueEvent => event !== undefined));
  }
  const integrationRequired = writable.length > 1 || writable.some((repository) => repository.commands.integration.length > 0);
  const integration = [...events].reverse().find((event) => event.type === "issue:integration_acceptance_recorded");
  if (integrationRequired) {
    if (integration?.status !== "pass") gaps.push("integration_acceptance_missing");
    else evidenceEvents.push(integration);
  }
  if (gaps.length > 0) return { produced: false, runDir, reasons: gaps };

  const workspaceRoot = dirname(dirname(execution.issueRoot));
  const storySpec = resolveWorkspaceBacklogStorySpec(workspaceRoot, storyId);
  if (!storySpec.ok) {
    return { produced: false, runDir, reasons: [`workspace_story_spec_${storySpec.code}`] };
  }
  const acceptanceCriteria = acForStory(storySpec.text, storyId, { fileOwned: true });
  if (acceptanceCriteria.length === 0) {
    return { produced: false, runDir, reasons: ["workspace_acceptance_criteria_missing"] };
  }

  const evidenceRef = "evidence/repository-verification.json";
  const entries = acceptanceCriteria.map((criterion) => ({
    ac: criterion.text,
    status: "partial",
    evidence: [{ kind: "text", textFile: evidenceRef }],
  }));
  const sections = entries.map((entry) =>
    `<section class="ac s-partial"><h2>${escapeHtml(entry.ac)}</h2><p>Mapped to exact-cycle repository evidence for independent evaluation.</p></section>`,
  ).join("\n");
  const report = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(storyId)} Workspace Review</title></head><body><h1>${escapeHtml(storyId)}</h1>${sections}</body></html>\n`;
  try {
    atomicWrite(join(runDir, evidenceRef), `${JSON.stringify({
      schema: "roll.workspace-acceptance-evidence/v1",
      workspaceId: execution.workspaceId,
      storyId,
      cycleId,
      events: evidenceEvents,
    }, null, 2)}\n`);
    atomicWrite(join(runDir, "ac-map.json"), `${JSON.stringify(entries, null, 2)}\n`);
    atomicWrite(join(runDir, `${storyId}-review.html`), report);
    atomicWrite(join(runDir, `${storyId}-report.html`), report);
  } catch {
    return { produced: false, runDir, reasons: ["workspace_acceptance_write_failed"] };
  }
  return validateArtifacts(runDir, storyId, entries.length)
    ? { produced: true, runDir, reasons: ["workspace_acceptance_artifacts_verified"] }
    : { produced: false, runDir, reasons: ["workspace_acceptance_artifacts_invalid"] };
}
