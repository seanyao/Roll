import {
  isSafeIssueEvidencePath,
  type IssueCompletionState,
  type RequirementArchiveAudit,
  type RequirementSourceManifest,
} from "@roll/spec";

export interface RequirementAttestStory {
  readonly storyId: string;
  readonly state: IssueCompletionState;
  readonly mergeCommits: Readonly<Record<string, string>>;
  readonly evidencePaths: readonly string[];
}

export interface FinalRequirementAttestInput {
  readonly manifest: RequirementSourceManifest;
  readonly archiveAudit: RequirementArchiveAudit;
  readonly stories: readonly RequirementAttestStory[];
}

export interface FinalRequirementAttestProjection {
  readonly status: "pass" | "partial" | "blocked";
  readonly content: string;
}

export class RequirementAttestError extends Error {}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateStories(stories: readonly RequirementAttestStory[]): void {
  const seen = new Set<string>();
  for (const story of stories) {
    if (seen.has(story.storyId)) throw new RequirementAttestError(`duplicate Requirement Story ${story.storyId}`);
    seen.add(story.storyId);
    if (story.evidencePaths.some((path) => !isSafeIssueEvidencePath(path))) {
      throw new RequirementAttestError(`unsafe Issue evidence path for ${story.storyId}`);
    }
  }
}

function storySummary(storyId: string, story: RequirementAttestStory | undefined): string {
  if (story === undefined) return `- ${storyId}: pending (Issue state/evidence missing)`;
  const reasons: string[] = [];
  if (story.state !== "delivered") reasons.push(story.state);
  if (story.evidencePaths.length === 0) reasons.push("Issue evidence missing");
  return reasons.length === 0
    ? `- ${storyId}: delivered`
    : `- ${storyId}: pending (${reasons.join("; ")})`;
}

function storyDetails(storyId: string, story: RequirementAttestStory | undefined): string[] {
  if (story === undefined) {
    return [
      `## ${storyId}`,
      "",
      "- State: missing",
      "- Exact merge commits: pending",
      "- Issue evidence: missing",
      "",
    ];
  }
  const commits = Object.entries(story.mergeCommits).sort(([left], [right]) => compareText(left, right));
  const evidence = [...story.evidencePaths].sort(compareText);
  return [
    `## ${storyId}`,
    "",
    `- State: ${story.state}`,
    "- Exact merge commits:",
    ...(commits.length === 0 ? ["  - pending"] : commits.map(([repoId, sha]) => `  - ${repoId}@${sha}`)),
    "- Issue evidence:",
    ...(evidence.length === 0
      ? ["  - missing"]
      : evidence.map((path) => `  - [${path}](../../../issues/${storyId}/${path})`)),
    "",
  ];
}

export function renderFinalRequirementAttest(
  input: FinalRequirementAttestInput,
): FinalRequirementAttestProjection {
  validateStories(input.stories);
  const storyById = new Map(input.stories.map((story) => [story.storyId, story]));
  const linkedStories = [...input.manifest.stories].sort(compareText);
  const archiveBlocked = input.archiveAudit.requirementId !== input.manifest.requirementId ||
    input.archiveAudit.status !== "healthy";
  const complete = linkedStories.length > 0 && linkedStories.every((storyId) => {
    const story = storyById.get(storyId);
    return story?.state === "delivered" && story.evidencePaths.length > 0;
  });
  const status = archiveBlocked ? "blocked" : complete ? "pass" : "partial";
  const verdict = status.toUpperCase();
  const findings = input.archiveAudit.requirementId !== input.manifest.requirementId
    ? ["- requirement_identity_mismatch: source.yaml"]
    : input.archiveAudit.findings.map((finding) =>
      `- ${finding.code}${finding.revision === undefined ? "" : ` [${finding.revision}]`}: ${finding.evidencePath}`
    );
  const lines = [
    `# Requirement ${input.manifest.provider}:${input.manifest.ref} attestation`,
    "",
    "> Generated exact-SHA projection. Issue-owned evidence remains authoritative; rebuilding this file cannot change Issue truth.",
    "",
    `Final verdict: ${verdict}`,
    `Revision: ${input.manifest.revision}`,
    `Archive status: ${input.archiveAudit.status}`,
    "",
  ];
  if (archiveBlocked) {
    lines.push("Blocking archive findings:", ...(findings.length === 0 ? ["- archive is not trusted"] : findings), "");
  }
  lines.push(
    "Linked Stories:",
    ...(linkedStories.length === 0 ? ["- none"] : linkedStories.map((storyId) => storySummary(storyId, storyById.get(storyId)))),
    "",
    ...linkedStories.flatMap((storyId) => storyDetails(storyId, storyById.get(storyId))),
  );
  return { status, content: `${lines.join("\n").trimEnd()}\n` };
}
