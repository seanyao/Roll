import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REPOSITORY_BINDING_V1,
  WORKSPACE_MIGRATION_FACTS_V1,
  normalizeRepositoryRemote,
  parseWorkspaceManifest,
  repositoryIdFromRemote,
  type HistoricalMigrationFacts,
  type HistoricalRemoteTruth,
  type HistoricalRollEntry,
  type HistoricalRollOwnership,
  type HistoricalRollSourceClass,
  type ProductGitSafetyFacts,
  type RepositoryBinding,
} from "@roll/spec";
import { rawGit, type GitExecutionOptions, type GitResult } from "../git.js";
import { inspectRepositoryCache, resolveRepositoryCacheIdentity } from "../repository-cache.js";
import { parseWorkspaceRegistry, workspaceRegistryPath } from "../workspace-registry.js";

export type HistoricalMigrationGitRunner = (
  args: readonly string[],
  cwd?: string,
  options?: GitExecutionOptions,
) => Promise<GitResult>;

export interface CollectHistoricalMigrationFactsInput {
  readonly sourceRoot: string;
  readonly rollHome: string;
  readonly requestedWorkspaceId?: string;
  readonly runGit?: HistoricalMigrationGitRunner;
  readonly now?: () => number;
}

interface WorktreeRecord {
  readonly path: string;
  readonly head: string;
  readonly branch: string | null;
  readonly prunable: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const STORY_ID = /^(?:US|FIX|BUG|REFACTOR|IDEA|PROPOSAL)-[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const HUMAN_SOFT_LEASE_MS = 24 * 60 * 60 * 1_000;
const GIT_READ_TIMEOUT_MS = 60_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function relativeToken(root: string, path: string): string {
  const candidate = relative(root, path);
  if (candidate === "") return ".";
  if (!isAbsolute(candidate) && candidate !== ".." && !candidate.startsWith(`..${sep}`)) return posix(candidate);
  return `external-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 12)}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitRunner(runGit: HistoricalMigrationGitRunner): HistoricalMigrationGitRunner {
  return (args, cwd, options) => runGit(
    ["--no-optional-locks", ...args],
    cwd,
    { timeoutMs: options?.timeoutMs ?? GIT_READ_TIMEOUT_MS },
  );
}

async function requiredGit(
  runGit: HistoricalMigrationGitRunner,
  cwd: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) throw new Error(`historical_migration_${label}_unreadable`);
  return result.stdout.trim();
}

function normalizedRemote(value: string): string | null {
  const parsed = normalizeRepositoryRemote(value.trim());
  return parsed.ok ? parsed.value : null;
}

async function remoteTruth(
  root: string,
  runGit: HistoricalMigrationGitRunner,
  head: string,
): Promise<HistoricalRemoteTruth> {
  const origin = await runGit(["remote", "get-url", "origin"], root);
  if (origin.code !== 0 || origin.stdout.trim() === "") return { kind: "blocked", code: "remote_missing" };
  const remote = normalizedRemote(origin.stdout);
  if (remote === null) return { kind: "blocked", code: "remote_missing" };
  const symbolic = await runGit(["ls-remote", "--symref", "origin", "HEAD"], root);
  if (symbolic.code !== 0) return { kind: "blocked", code: "remote_truth_unverifiable", normalizedRemote: remote };
  const branches = symbolic.stdout.split("\n")
    .map((line) => /^ref: refs\/heads\/(.+)\tHEAD$/u.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined);
  const uniqueBranches = [...new Set(branches)];
  if (uniqueBranches.length !== 1) {
    return { kind: "blocked", code: "remote_default_ambiguous", normalizedRemote: remote };
  }
  const defaultBranch = uniqueBranches[0] as string;
  const tipResult = await runGit(["ls-remote", "origin", `refs/heads/${defaultBranch}`], root);
  const tips = tipResult.code === 0
    ? tipResult.stdout.split("\n").map((line) => /^([0-9a-f]{40,64})\t/u.exec(line.trim())?.[1])
      .filter((value): value is string => value !== undefined)
    : [];
  const uniqueTips = [...new Set(tips)];
  if (uniqueTips.length !== 1) {
    return { kind: "blocked", code: "remote_default_ambiguous", normalizedRemote: remote, defaultBranch };
  }
  const defaultTip = uniqueTips[0] as string;
  const localTip = await runGit(["cat-file", "-e", `${defaultTip}^{commit}`], root);
  if (localTip.code !== 0) {
    return {
      kind: "blocked",
      code: "remote_truth_unverifiable",
      normalizedRemote: remote,
      defaultBranch,
      defaultTip,
    };
  }
  const reachable = await runGit(["merge-base", "--is-ancestor", head, defaultTip], root);
  if (reachable.code !== 0) {
    return { kind: "blocked", code: "head_unpushed", normalizedRemote: remote, defaultBranch, defaultTip };
  }
  return {
    kind: "verified",
    normalizedRemote: remote,
    defaultBranch,
    defaultTip,
    headReachable: true,
    defaultTipPresentLocally: true,
  };
}

function gitPath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function operationState(
  root: string,
  runGit: HistoricalMigrationGitRunner,
): Promise<ProductGitSafetyFacts["operation"]> {
  const gitDirValue = await requiredGit(runGit, root, ["rev-parse", "--git-dir"], "gitdir");
  const gitDir = gitPath(root, gitDirValue);
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry_pick";
  if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
  return "none";
}

function dirtyPaths(output: string): readonly string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path !== "") paths.push(posix(path));
    if ((status.includes("R") || status.includes("C")) && records[index + 1] !== undefined) index += 1;
  }
  return [...new Set(paths)].sort(compareText);
}

async function productGitFacts(root: string, runGit: HistoricalMigrationGitRunner): Promise<ProductGitSafetyFacts> {
  const local = await localGitFacts(root, runGit);
  return { ...local, remote: await remoteTruth(root, runGit, local.head) };
}

async function localGitFacts(
  root: string,
  runGit: HistoricalMigrationGitRunner,
): Promise<Omit<ProductGitSafetyFacts, "remote">> {
  const head = await requiredGit(runGit, root, ["rev-parse", "HEAD"], "head");
  const status = await requiredGit(runGit, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "status");
  const paths = dirtyPaths(status);
  const operation = await operationState(root, runGit);
  return {
    head,
    state: operation === "none" ? (paths.length === 0 ? "clean" : "dirty") : "in_flight",
    dirtyPaths: paths,
    operation,
  };
}

function parseWorktrees(output: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: { path?: string; head?: string; branch?: string | null; prunable?: boolean } = {};
  const flush = (): void => {
    if (current.path !== undefined && current.head !== undefined) {
      records.push({
        path: current.path,
        head: current.head,
        branch: current.branch ?? null,
        prunable: current.prunable === true,
      });
    }
    current = {};
  };
  for (const token of output.split("\0")) {
    const line = token;
    if (line === "") continue;
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") current.branch = null;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  flush();
  return records;
}

async function linkedWorktrees(root: string, runGit: HistoricalMigrationGitRunner): Promise<HistoricalMigrationFacts["linkedWorktrees"]> {
  const output = await requiredGit(runGit, root, ["worktree", "list", "--porcelain", "-z"], "worktrees");
  const canonicalRoot = realpathSync(root);
  const entries = await Promise.all(parseWorktrees(output).map(async (record) => {
    let canonical = record.path;
    try {
      canonical = realpathSync(record.path);
    } catch {
      // Missing worktree is represented below rather than hidden.
    }
    if (canonical === canonicalRoot) return null;
    const pathToken = record.branch === null ? `detached-${record.head.slice(0, 12)}` : `branch-${record.branch}`;
    if (record.prunable) return { pathToken, head: record.head, state: "prunable" as const };
    if (!existsSync(record.path)) return { pathToken, head: record.head, state: "missing" as const };
    const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], record.path);
    if (status.code !== 0) return { pathToken, head: record.head, state: "missing" as const };
    return { pathToken, head: record.head, state: status.stdout === "" ? "clean" as const : "dirty" as const };
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => compareText(left.pathToken, right.pathToken));
}

async function submoduleFacts(root: string, runGit: HistoricalMigrationGitRunner): Promise<HistoricalMigrationFacts["submodules"]> {
  const result = await runGit(["submodule", "status", "--recursive"], root);
  if (result.code !== 0) throw new Error("historical_migration_submodules_unreadable");
  const entries = await Promise.all(result.stdout.split("\n").filter((line) => line !== "").map(async (line) => {
    const prefix = line[0] ?? " ";
    const match = /^[ +-U]([0-9a-f]{40,64})\s+(.+)$/u.exec(line);
    const remainder = match?.[2];
    if (remainder === undefined) throw new Error("historical_migration_submodule_status_invalid");
    const describeIndex = remainder.lastIndexOf(" (");
    const path = describeIndex < 0 ? remainder : remainder.slice(0, describeIndex);
    if (path === "") throw new Error("historical_migration_submodule_status_invalid");
    const listedHead = match?.[1];
    if (listedHead === undefined) throw new Error("historical_migration_submodule_status_invalid");
    const moduleRoot = join(root, path);
    if (prefix === "-") return { path, head: null, state: "uninitialized" as const, remote: null };
    if (prefix === "U") return { path, head: listedHead, state: "conflicted" as const, remote: null };
    try {
      const stat = lstatSync(moduleRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return { path: posix(path), head: listedHead, state: "missing" as const, remote: null };
      }
    } catch {
      return { path: posix(path), head: listedHead, state: "missing" as const, remote: null };
    }
    const head = await requiredGit(runGit, moduleRoot, ["rev-parse", "HEAD"], "submodule_head");
    const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], moduleRoot);
    const state = prefix === "+" || status.code !== 0 || status.stdout !== "" ? "dirty" as const : "clean" as const;
    return { path: posix(path), head, state, remote: await remoteTruth(moduleRoot, runGit, head) };
  }));
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeFile(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  let cursor = root;
  try {
    const rootStat = lstatSync(cursor);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) return false;
    }
    return lstatSync(cursor).isFile();
  } catch {
    return false;
  }
}

function activeCycles(rollRoot: string): readonly string[] {
  const ids = new Set<string>();
  const locks = [
    join(rollRoot, "loop", "inner.lock"),
    join(rollRoot, "loop", "cycle.lock"),
    join(rollRoot, "loop", "locks", "cycle.lock"),
  ];
  const candidates = locks.flatMap((path) => [path, join(path, "meta.json")]);
  for (const path of candidates) {
    if (!safeFile(rollRoot, path)) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const cycleId = record["cycleId"];
      if (typeof cycleId !== "string" || !SAFE_ID.test(cycleId)) continue;
      const pid = record["pid"];
      const ownerHost = record["hostname"];
      const foreign = typeof ownerHost === "string" && ownerHost !== "" && ownerHost !== hostname();
      if (typeof pid !== "number" || foreign || alive(pid)) ids.add(cycleId);
    } catch {
      for (const line of text.split("\n")) {
        const id = line.trim().split(/\s+/u)[0];
        if (id !== undefined && SAFE_ID.test(id)) ids.add(id);
      }
    }
  }
  return [...ids].sort(compareText);
}

function activeStoryLeases(rollRoot: string, now: number): readonly string[] {
  const ids = new Set<string>();
  for (const path of [join(rollRoot, "loop", "story-leases.json"), join(rollRoot, "loop", "locks", "story-leases.json")]) {
    if (!safeFile(rollRoot, path)) continue;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    for (const [storyId, candidate] of Object.entries(value)) {
      if (!SAFE_ID.test(storyId) || typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const lease = candidate as Record<string, unknown>;
      const source = lease["source"];
      const pid = lease["pid"];
      const claimedAt = lease["claimedAt"];
      const active = source === "cycle" && typeof pid === "number"
        ? alive(pid)
        : (source === "human" || source === "supervisor") && typeof claimedAt === "number" && now - claimedAt < HUMAN_SOFT_LEASE_MS;
      if (active) ids.add(storyId);
    }
  }
  return [...ids].sort(compareText);
}

function sourceClass(path: string): { readonly sourceClass: HistoricalRollSourceClass; readonly storyId?: string } {
  const parts = path.split("/");
  if (path === "backlog.md") return { sourceClass: "backlog" };
  if (parts[0] === "features") {
    const storyId = parts.find((part) => STORY_ID.test(part));
    if (storyId !== undefined) {
      const evidence = parts.some((part) => /(?:^|[-_.])(?:evidence|attest|review|report|runs?|screenshots?)(?:[-_.]|$)/iu.test(part));
      return { sourceClass: evidence ? "story_evidence" : "story_contract", storyId };
    }
    return { sourceClass: "design" };
  }
  if (["domain", "design", "decisions", "patterns"].includes(parts[0] ?? "")) return { sourceClass: "design" };
  if (["context", "requirements"].includes(parts[0] ?? "")) return { sourceClass: "requirement" };
  if (["loop", "locks"].includes(parts[0] ?? "") || ["local.yaml", "agents.yaml"].includes(path)) return { sourceClass: "runtime" };
  if (["tmp", "cache", "caches"].includes(parts[0] ?? "")) return { sourceClass: "rebuildable" };
  if (["dossier", "archive", "dashboard", "projections"].includes(parts[0] ?? "") || path.endsWith(".html")) {
    return { sourceClass: "projection" };
  }
  return { sourceClass: "unknown" };
}

function inventory(rollRoot: string, skipGitDatabase: boolean): readonly HistoricalRollEntry[] {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(rollRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (rootStat.isSymbolicLink()) return [{ kind: "symlink", path: ".", target: readlinkSync(rollRoot) }];
  const entries: HistoricalRollEntry[] = [];
  const visit = (absolute: string, relativePath: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({ kind: "symlink", path: posix(relativePath), target: readlinkSync(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort(compareText)) {
        if (skipGitDatabase && relativePath === "" && name === ".git") continue;
        visit(join(absolute, name), relativePath === "" ? name : join(relativePath, name));
      }
      return;
    }
    if (!stat.isFile()) return;
    const bytes = readFileSync(absolute);
    const classification = sourceClass(posix(relativePath));
    entries.push({
      kind: "file",
      path: posix(relativePath),
      digest: sha256(bytes),
      bytes: bytes.byteLength,
      ...classification,
    } as HistoricalRollEntry);
  };
  visit(rollRoot, "");
  return entries.sort((left, right) => compareText(left.path, right.path));
}

async function rollOwnership(
  sourceRoot: string,
  rollRoot: string,
  runGit: HistoricalMigrationGitRunner,
): Promise<HistoricalRollOwnership> {
  const tracked = await requiredGit(runGit, sourceRoot, ["ls-files", "-z", "--", ".roll"], "tracked_roll");
  const trackedPaths = tracked.split("\0").filter((path) => path !== "")
    .map((path) => posix(path.replace(/^\.roll\//u, ""))).sort(compareText);
  if (trackedPaths.length > 0) return { kind: "product_tracked", trackedPaths };
  try {
    const rootStat = lstatSync(rollRoot);
    const gitStat = lstatSync(join(rollRoot, ".git"));
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || gitStat.isSymbolicLink()) return { kind: "ordinary" };
  } catch {
    return { kind: "ordinary" };
  }
  const topLevel = await requiredGit(runGit, rollRoot, ["rev-parse", "--show-toplevel"], "roll_toplevel");
  if (realpathSync(topLevel) !== realpathSync(rollRoot)) return { kind: "ordinary" };
  const gitdir = gitPath(rollRoot, await requiredGit(runGit, rollRoot, ["rev-parse", "--git-dir"], "roll_gitdir"));
  const facts = await localGitFacts(rollRoot, runGit);
  const branchResult = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], rollRoot);
  const upstreamResult = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], rollRoot);
  const origin = await runGit(["remote", "get-url", "origin"], rollRoot);
  return {
    kind: "independent_git",
    gitdirToken: relativeToken(sourceRoot, gitdir),
    topLevelToken: relativeToken(sourceRoot, realpathSync(topLevel)),
    state: facts.state,
    head: facts.head,
    branch: branchResult.code === 0 && branchResult.stdout.trim() !== "" ? branchResult.stdout.trim() : null,
    upstream: upstreamResult.code === 0 && upstreamResult.stdout.trim() !== "" ? upstreamResult.stdout.trim() : null,
    normalizedRemote: origin.code === 0 ? normalizedRemote(origin.stdout) : null,
  };
}

function repositoryBinding(remote: string, integrationBranch: string): RepositoryBinding {
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("historical_migration_remote_unsafe");
  return {
    schema: REPOSITORY_BINDING_V1,
    repoId: repoId.value,
    alias: "primary",
    remote,
    integrationBranch,
    provider: "generic",
    workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
  };
}

function registryFacts(
  rollHome: string,
  workspaceId: string,
  repoId: string,
): HistoricalMigrationFacts["registry"] {
  const path = workspaceRegistryPath(rollHome);
  if (!existsSync(path)) return { status: "available", workspaceId };
  let snapshot: ReturnType<typeof parseWorkspaceRegistry>;
  try {
    snapshot = parseWorkspaceRegistry(readFileSync(path, "utf8"));
  } catch {
    return { status: "id_conflict", workspaceId };
  }
  let repositoryOwner: string | null = null;
  for (const entry of snapshot.entries) {
    let ownsRepository = false;
    try {
      const parsed = parseWorkspaceManifest(JSON.parse(readFileSync(join(entry.canonicalRoot, "workspace.yaml"), "utf8")));
      ownsRepository = parsed.ok && parsed.value.repositories.some((repository) => repository.repoId === repoId);
    } catch {
      ownsRepository = false;
    }
    if (entry.workspaceId === workspaceId) return { status: ownsRepository ? "same_workspace" : "id_conflict", workspaceId };
    if (ownsRepository) repositoryOwner = entry.workspaceId;
  }
  return { status: repositoryOwner === null ? "available" : "repo_conflict", workspaceId };
}

/** Collect exhaustive migration facts without creating or mutating source, cache, registry or destination state. */
export async function collectHistoricalMigrationFacts(
  input: CollectHistoricalMigrationFactsInput,
): Promise<HistoricalMigrationFacts> {
  const sourceRoot = realpathSync(input.sourceRoot);
  const rollHome = resolve(input.rollHome);
  const runGit = gitRunner(input.runGit ?? rawGit);
  const topLevel = realpathSync(await requiredGit(runGit, sourceRoot, ["rev-parse", "--show-toplevel"], "source_root"));
  if (topLevel !== sourceRoot) throw new Error("historical_migration_source_must_be_git_toplevel");
  const git = await productGitFacts(sourceRoot, runGit);
  const remote = git.remote.normalizedRemote;
  if (remote === undefined) throw new Error("historical_migration_remote_identity_unavailable");
  const repo = repositoryIdFromRemote(remote);
  if (!repo.ok) throw new Error("historical_migration_remote_identity_unavailable");
  const repoId = repo.value;
  const workspaceId = input.requestedWorkspaceId ?? `ws-${repoId.slice("repo-".length)}`;
  const integrationBranch = git.remote.defaultBranch ?? "main";
  const binding = repositoryBinding(remote, integrationBranch);
  const cacheIdentity = resolveRepositoryCacheIdentity({ rollHome, binding });
  const cacheProbe = await inspectRepositoryCache({
    rollHome,
    binding,
    runGit: (args, cwd, options) => runGit(args, cwd, options),
  });
  const rollRoot = join(sourceRoot, ".roll");
  const ownership = await rollOwnership(sourceRoot, rollRoot, runGit);
  return {
    schema: WORKSPACE_MIGRATION_FACTS_V1,
    sourceRoot,
    repoId,
    ...(input.requestedWorkspaceId === undefined ? {} : { requestedWorkspaceId: input.requestedWorkspaceId }),
    git,
    linkedWorktrees: await linkedWorktrees(sourceRoot, runGit),
    submodules: await submoduleFacts(sourceRoot, runGit),
    runtime: {
      activeCycleIds: activeCycles(rollRoot),
      activeStoryLeases: activeStoryLeases(rollRoot, (input.now ?? Date.now)()),
    },
    rollOwnership: ownership,
    rollInventory: inventory(rollRoot, ownership.kind === "independent_git"),
    cache: {
      status: cacheProbe === "compatible" ? "matching" : cacheProbe === "absent" ? "absent" : "conflict",
      repoId,
      cachePath: posix(relative(rollHome, cacheIdentity.cachePath)),
    },
    registry: registryFacts(rollHome, workspaceId, repoId),
  };
}
