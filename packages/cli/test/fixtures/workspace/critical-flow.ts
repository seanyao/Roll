import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendIssueIntegrationAcceptanceEvidence,
  appendRepositoryMergeEvidence,
  rebuildRequirementAttest,
} from "@roll/infra";
import { integrationAcceptanceCommandDigest } from "@roll/spec";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const systemGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

export interface CriticalRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkspaceAcceptanceFixture {
  readonly home: string;
  readonly rollHome: string;
  readonly alphaRoot: string;
  readonly betaRoot: string;
  readonly alphaConfig: string;
  readonly betaConfig: string;
  readonly apiRemote: string;
  readonly webRemote: string;
  readonly apiSource: string;
  readonly webSource: string;
  readonly commandLog: string;
  readonly blockedExternalLog: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface IssueTarget {
  readonly repoId: string;
  readonly alias: string;
  readonly worktreePath: string;
  readonly baseSha: string;
}

export interface IssueView {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repositories: readonly IssueTarget[];
  readonly integrationAcceptance?: { readonly command: readonly string[] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(systemGit, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function materializeRemote(home: string, alias: string): { readonly source: string; readonly remote: string } {
  const source = join(home, `${alias}-source`);
  const remote = join(home, `${alias}.git`);
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Roll Test");
  git(source, "config", "user.email", "roll@example.test");
  writeFileSync(join(source, "README.md"), `${alias} fixture\n`, "utf8");
  writeFileSync(
    join(source, "verify.mjs"),
    `import { existsSync } from "node:fs";\nif (!existsSync(new URL("./feature.txt", import.meta.url))) process.exit(1);\n`,
    "utf8",
  );
  git(source, "add", "README.md", "verify.mjs");
  git(source, "commit", "-q", "-m", "fixture");
  git(home, "clone", "-q", "--bare", source, remote);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { source, remote };
}

export function createWorkspaceAcceptanceFixture(): WorkspaceAcceptanceFixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "roll-workspace-critical-")));
  const rollHome = join(home, ".roll");
  const alphaRoot = join(home, "alpha");
  const betaRoot = join(home, "beta");
  const alphaConfig = join(home, "alpha.yaml");
  const betaConfig = join(home, "beta.yaml");
  const commandLog = join(home, "commands.log");
  const blockedExternalLog = join(home, "blocked-external.log");
  const guardBin = join(home, "guard-bin");
  mkdirSync(guardBin, { recursive: true });
  const api = materializeRemote(home, "api");
  const web = materializeRemote(home, "web");

  writeExecutable(
    join(guardBin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(commandLog)}\nexec ${shellQuote(systemGit)} "$@"\n`,
  );
  for (const command of ["gh", "curl", "ssh"]) {
    writeExecutable(
      join(guardBin, command),
      `#!/bin/sh\nprintf '%s %s\\n' ${shellQuote(command)} "$*" >> ${shellQuote(blockedExternalLog)}\nexit 97\n`,
    );
  }

  writeFileSync(alphaConfig, [
    "schema: roll.workspace-create/v1",
    "id: ws-alpha",
    `root: ${alphaRoot}`,
    "requirements:",
    "  - provider: file",
    "    ref: REQ-1",
    "repositories:",
    "  - alias: api",
    `    source: file://${api.remote}`,
    "    integration_branch: main",
    "  - alias: web",
    `    source: file://${web.remote}`,
    "    integration_branch: main",
    "",
  ].join("\n"), "utf8");
  writeFileSync(betaConfig, [
    "schema: roll.workspace-create/v1",
    "id: ws-beta",
    `root: ${betaRoot}`,
    "repositories:",
    "  - alias: api",
    `    source: file://${api.remote}`,
    "    integration_branch: main",
    "",
  ].join("\n"), "utf8");

  return {
    home,
    rollHome,
    alphaRoot,
    betaRoot,
    alphaConfig,
    betaConfig,
    apiRemote: api.remote,
    webRemote: web.remote,
    apiSource: api.source,
    webSource: web.source,
    commandLog,
    blockedExternalLog,
    env: {
      ...process.env,
      HOME: home,
      ROLL_HOME: rollHome,
      ROLL_LANG: "en",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: `${guardBin}:${process.env["PATH"] ?? ""}`,
    },
  };
}

export function removeWorkspaceAcceptanceFixture(fixture: WorkspaceAcceptanceFixture): void {
  rmSync(fixture.home, { recursive: true, force: true });
}

export function runRoll(
  fixture: WorkspaceAcceptanceFixture,
  args: readonly string[],
  cwd = repoRoot,
  language: "en" | "zh" = "en",
): CriticalRun {
  const result = spawnSync(process.execPath, [rollBin, ...args], {
    cwd,
    env: { ...fixture.env, ROLL_LANG: language },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function writeStoryContract(
  workspaceRoot: string,
  storyId: string,
  aliases: readonly string[] = ["api", "web"],
): void {
  const storyRoot = join(workspaceRoot, "backlog", "workspace-orchestration", storyId);
  mkdirSync(storyRoot, { recursive: true });
  const repositories = aliases.flatMap((alias) => [
    `  - alias: ${alias}`,
    "    access: write",
    "    required_delivery: true",
  ]);
  writeFileSync(join(storyRoot, "spec.md"), [
    "---",
    `id: ${storyId}`,
    "repositories:",
    ...repositories,
    "integration_acceptance:",
    "  command: ./verify-workspace.sh",
    "---",
    "",
    `# ${storyId} critical fixture`,
    "",
  ].join("\n"), "utf8");
  const backlogPath = join(workspaceRoot, "backlog", "index.md");
  const current = readFileSync(backlogPath, "utf8");
  writeFileSync(backlogPath, `${current.trimEnd()}\n| [${storyId}](workspace-orchestration/${storyId}/spec.md) | Critical flow | 📋 Todo |\n`, "utf8");
}

export function readIssue(workspaceRoot: string, storyId: string): IssueView {
  const issueRoot = join(workspaceRoot, "issues", storyId);
  const manifest = JSON.parse(readFileSync(join(issueRoot, "manifest.json"), "utf8")) as {
    readonly workspaceId: string;
    readonly storyId: string;
    readonly repositories: readonly { readonly repoId: string; readonly alias: string }[];
    readonly integrationAcceptance?: { readonly command: readonly string[] };
  };
  const bound = readFileSync(join(issueRoot, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event["type"] === "issue:repository_bound");
  return {
    workspaceId: manifest.workspaceId,
    storyId: manifest.storyId,
    repositories: manifest.repositories.map((repository) => {
      const event = bound.find((candidate) => candidate["repoId"] === repository.repoId);
      if (event === undefined || typeof event["worktreePath"] !== "string" || typeof event["baseSha"] !== "string") {
        throw new Error(`missing repository-bound event for ${repository.alias}`);
      }
      return {
        ...repository,
        worktreePath: event["worktreePath"],
        baseSha: event["baseSha"],
      };
    }),
    ...(manifest.integrationAcceptance === undefined ? {} : { integrationAcceptance: manifest.integrationAcceptance }),
  };
}

export function runFakeAgentLeg(workspaceRoot: string, storyId: string, target: IssueTarget): string {
  writeFileSync(join(target.worktreePath, "feature.txt"), `${storyId}/${target.alias}\n`, "utf8");
  execFileSync(process.execPath, [join(target.worktreePath, "verify.mjs")], {
    cwd: target.worktreePath,
    stdio: "pipe",
  });
  git(target.worktreePath, "add", "feature.txt");
  git(
    target.worktreePath,
    "-c", "user.name=Roll Test",
    "-c", "user.email=roll@example.test",
    "commit", "-q", "-m", `tcr: ${storyId} ${target.alias}`,
  );
  const head = git(target.worktreePath, "rev-parse", "HEAD");
  const count = git(target.worktreePath, "rev-list", "--count", `${target.baseSha}..${head}`, "--grep", "^tcr:");
  if (count !== "1") throw new Error(`fake agent did not produce one attributable TCR commit for ${target.alias}`);
  return head;
}

export function recordRepositoryFact(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repoId: string;
  readonly cycleId: string;
  readonly recordedAt: number;
  readonly prNumber: number;
  readonly prState: "OPEN" | "MERGED";
  readonly ci: "green" | "pending";
  readonly mergeCommit?: string;
}): void {
  appendRepositoryMergeEvidence(join(input.workspaceRoot, "issues", input.storyId), {
    workspaceId: input.workspaceId,
    storyId: input.storyId,
    repoId: input.repoId,
    cycleId: input.cycleId,
    authority: "provider",
    prNumber: input.prNumber,
    prState: input.prState,
    ci: input.ci,
    ...(input.mergeCommit === undefined ? {} : { mergeCommit: input.mergeCommit }),
    recordedAt: input.recordedAt,
  });
}

export function recordAcceptance(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly storyId: string;
  readonly mergeCommits: Readonly<Record<string, string>>;
  readonly recordedAt: number;
}): void {
  const issueRoot = join(input.workspaceRoot, "issues", input.storyId);
  const artifactPath = "evidence/integration/result.txt";
  mkdirSync(join(issueRoot, "evidence", "integration"), { recursive: true });
  writeFileSync(join(issueRoot, artifactPath), "PASS\n", "utf8");
  appendIssueIntegrationAcceptanceEvidence(issueRoot, {
    workspaceId: input.workspaceId,
    storyId: input.storyId,
    inputMergeCommits: input.mergeCommits,
    commandDigest: integrationAcceptanceCommandDigest(["./verify-workspace.sh"]),
    profile: "workspace-critical/v1",
    verdict: "pass",
    artifactPath,
    recordedAt: input.recordedAt,
  });
}

export function rebuildCapturedRequirement(input: {
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly requirementId: string;
}): ReturnType<typeof rebuildRequirementAttest> {
  return rebuildRequirementAttest(input);
}

export function restoreBareRemote(source: string, remote: string): void {
  rmSync(remote, { recursive: true, force: true });
  git(dirname(remote), "clone", "-q", "--bare", source, remote);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
}

export function gitCommandLog(fixture: WorkspaceAcceptanceFixture): readonly string[] {
  try {
    return readFileSync(fixture.commandLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function blockedExternalCommands(fixture: WorkspaceAcceptanceFixture): string {
  try {
    return readFileSync(fixture.blockedExternalLog, "utf8");
  } catch {
    return "";
  }
}
