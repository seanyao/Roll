/**
 * `roll backlog sync` — GitHub issues → backlog (US-PORT-019 port of
 * lib/github_sync.py's `sync` subcommand). The pure mapping/merge/config logic
 * lives in @roll/core (backlog/github-sync); this module owns the I/O: token
 * resolution, the paginated HTTP fetch (injectable opener), the fixture seam,
 * and the Workspace backlog / Story-contract / runtime-config writes.
 */
import {
  type GhIssue,
  type SyncConfig,
  dryRunPreview,
  existingStoryIdForIssue,
  featureStubContent,
  filterIssuesByLabel,
  parseLabelsFilter,
  parseLinkHeader,
  readSyncConfig,
  renderAcSection,
  renderSyncBlock,
  storyIdFromIssue,
  syncToBacklog,
  writeSyncBlock,
} from "@roll/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  emitBacklogTarget,
  emitBacklogTargetError,
  resolveBacklogCommandTarget,
  stripBacklogScopeArgs,
  workspaceOwnsPath,
  type BacklogTargetResolver,
} from "./backlog-target.js";

const API_ROOT = "https://api.github.com";
const RATE_LIMIT_FLOOR = 5;

class AuthError extends Error {}
class RateLimitError extends Error {}
class GitHubAPIError extends Error {}

/** Normalized HTTP response (the injectable opener returns this). */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type Opener = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

async function defaultOpener(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    throw new GitHubAPIError(`request failed: ${(e as Error).message}`);
  }
  const body = await resp.text();
  const h: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    h[k.toLowerCase()] = v;
  });
  return { status: resp.status, headers: h, body };
}

/** Resolve a GitHub token: $GITHUB_TOKEN → `gh auth token` → AuthError. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env, ghToken = ghAuthToken): string {
  const t = (env["GITHUB_TOKEN"] ?? "").trim();
  if (t) return t;
  const gh = (ghToken() ?? "").trim();
  if (gh) return gh;
  throw new AuthError(
    "no GitHub credential found.\n" +
      "  set GITHUB_TOKEN, or run `gh auth login` so `gh auth token` works.\n" +
      "  未找到 GitHub 凭据：请设置 GITHUB_TOKEN，或运行 `gh auth login`。",
  );
}

function ghAuthToken(): string | null {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function checkRateLimit(resp: HttpResponse, warn: (m: string) => void): void {
  if (resp.status === 429) {
    throw new RateLimitError(
      "GitHub rate limit hit (HTTP 429); retry later or authenticate.\n" +
        "  触发 GitHub 限流 (HTTP 429)：请稍后重试或配置鉴权。",
    );
  }
  const raw = resp.headers["x-ratelimit-remaining"];
  if (raw === undefined) return;
  const remaining = parseInt(raw, 10);
  if (!Number.isFinite(remaining)) return;
  if (remaining < RATE_LIMIT_FLOOR) {
    const reset = resp.headers["x-ratelimit-reset"] ?? "";
    warn(
      `GitHub rate-limit low: ${remaining} requests left (resets at epoch ${reset}); backing off.\n` +
        `  GitHub 配额不足：剩余 ${remaining} 次，正在退避。`,
    );
    if (remaining <= 0) {
      throw new RateLimitError("GitHub rate-limit budget exhausted; aborting.\n  GitHub 配额已耗尽：已中止。");
    }
  }
}

export interface FetchOptions {
  state?: string;
  token?: string;
  opener?: Opener;
  warn?: (m: string) => void;
}

/** Fetch all issues for owner/repo, following Link pagination; PRs filtered out. */
export async function fetchIssues(owner: string, repo: string, opts: FetchOptions = {}): Promise<GhIssue[]> {
  const token = opts.token ?? resolveToken();
  const opener = opts.opener ?? defaultOpener;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
  let url: string | undefined = `${API_ROOT}/repos/${owner}/${repo}/issues?state=${opts.state ?? "all"}&per_page=100`;
  const issues: GhIssue[] = [];
  while (url) {
    const resp = await opener(url, {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "roll/github_sync",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    checkRateLimit(resp, warn);
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError(
        `GitHub returned HTTP ${resp.status}; check your token scopes.\n` +
          `  GitHub 返回 HTTP ${resp.status}：请检查 token 权限。`,
      );
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new GitHubAPIError(`GitHub returned HTTP ${resp.status} for ${url}`);
    }
    const page = resp.body.trim() ? (JSON.parse(resp.body) as GhIssue[]) : [];
    for (const item of page) {
      if (item.pull_request !== undefined) continue; // skip PRs
      issues.push(item);
    }
    url = parseLinkHeader(resp.headers["link"])["next"];
  }
  return issues;
}

// ─── command ──────────────────────────────────────────────────────────────────

export interface SyncDeps {
  /** Load issues for the repo (default: fixture env → live fetch). */
  loadIssues: (owner: string, repo: string) => Promise<GhIssue[]>;
  /** Now, as an RFC3339 UTC stamp (for the persisted last_sync_at). */
  nowIso: () => string;
  resolveTarget?: BacklogTargetResolver;
  writeFile?: (path: string, content: string) => void;
}
function realSyncDeps(): SyncDeps {
  return {
    loadIssues: async (owner, repo) => {
      const fixture = (process.env["ROLL_SYNC_FIXTURE"] ?? "").trim();
      if (fixture) return JSON.parse(readFileSync(fixture, "utf8")) as GhIssue[];
      return fetchIssues(owner, repo, { state: "open" });
    },
    nowIso: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    resolveTarget: resolveBacklogCommandTarget,
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

interface PlannedWrite {
  readonly path: string;
  readonly content: string;
}

interface WriteSnapshot {
  readonly path: string;
  readonly content?: string;
}

function missingParentDirs(path: string): readonly string[] {
  const missing: string[] = [];
  let current = dirname(path);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (existsSync(current) && !statSync(current).isDirectory()) {
    throw new Error(`parent path is not a directory: ${current}`);
  }
  return missing;
}

function applySyncWrites(
  writes: readonly PlannedWrite[],
  canonicalRoot: string,
  writeFile: (path: string, content: string) => void = writeFileSync,
): void {
  const snapshots: WriteSnapshot[] = [];
  const createdDirs = new Set<string>();
  for (const write of writes) {
    if (!workspaceOwnsPath(canonicalRoot, write.path)) {
      throw new Error(`Workspace-owned path escapes canonical root: ${write.path}`);
    }
    if (existsSync(write.path) && statSync(write.path).isDirectory()) {
      throw new Error(`file target is a directory: ${write.path}`);
    }
    snapshots.push({
      path: write.path,
      ...(existsSync(write.path) ? { content: readFileSync(write.path, "utf8") } : {}),
    });
    for (const dir of missingParentDirs(write.path)) createdDirs.add(dir);
  }

  try {
    for (const write of writes) {
      mkdirSync(dirname(write.path), { recursive: true });
      writeFile(write.path, write.content);
    }
  } catch (error) {
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.content === undefined) rmSync(snapshot.path, { force: true });
      else writeFileSync(snapshot.path, snapshot.content);
    }
    for (const dir of [...createdDirs].sort((left, right) => right.length - left.length)) {
      try {
        rmdirSync(dir);
      } catch {
        // A non-empty directory either predates the transaction or was restored.
      }
    }
    throw error;
  }
}

/**
 * `roll backlog sync [--workspace id|path] [--repo owner/repo]
 *  [--label a,b]... [--dry-run]`. Resolves the repo from the
 * flag or the persisted backlog_sync.repo, fetches issues (or a fixture), maps
 * them to rows (idempotent by GH id), writes feature stubs, and persists config.
 * Exit codes mirror the oracle: auth 2, rate-limit 3, api 4, usage 1.
 */
export async function backlogSyncCommand(args: string[], deps: SyncDeps = realSyncDeps()): Promise<number> {
  const scoped = stripBacklogScopeArgs(args);
  if (!scoped.ok) return 1;
  const commandArgs = [...scoped.args];
  if (["--backlog", "--features", "--local-yaml"].some((flag) => commandArgs.includes(flag))) {
    process.stderr.write("backlog: invalid_arguments — Workspace-owned paths cannot be overridden\n");
    return 1;
  }
  const decision = (deps.resolveTarget ?? resolveBacklogCommandTarget)(args, "mutation");
  if (!decision.ok) return emitBacklogTargetError(decision);
  if ("aggregate" in decision) {
    process.stderr.write("backlog: invalid_arguments — aggregate management commands are not supported\n");
    return 1;
  }
  const backlog = decision.backlogPath;
  const featuresDir = decision.storyRoot;
  const localYaml = decision.configPath;
  if (![backlog, featuresDir, localYaml].every((path) => workspaceOwnsPath(decision.canonicalRoot, path))) {
    process.stderr.write("backlog: invalid_target — Workspace-owned path escapes canonical root\n");
    return 1;
  }
  emitBacklogTarget(decision);

  let cfg: SyncConfig;
  try {
    cfg = existsSync(localYaml) ? readSyncConfig(readFileSync(localYaml, "utf8")) : {};
  } catch (error) {
    process.stderr.write(`sync config error: ${(error as Error).message}\n`);
    return 1;
  }
  const explicitRepo = flagValue(commandArgs, "--repo");
  const configuredRepo = cfg.repo?.trim() ?? "";
  const explicitRepoIdentity = explicitRepo?.trim().toLowerCase();
  const configuredRepoIdentity = configuredRepo.toLowerCase();
  if (explicitRepoIdentity !== undefined && configuredRepo !== "" && configuredRepoIdentity !== explicitRepoIdentity) {
    process.stderr.write(
      `backlog sync source conflict: Workspace is bound to ${cfg.repo}; refusing ${explicitRepo}\n`,
    );
    return 1;
  }
  const repoArg = explicitRepoIdentity !== undefined && configuredRepoIdentity === explicitRepoIdentity
    ? configuredRepo
    : (explicitRepo ?? configuredRepo);
  if (!repoArg) {
    process.stderr.write(
      "usage: roll backlog sync [--workspace <id|path>] --repo <owner/repo> [--label <a,b>] [--dry-run]\n" +
        "  首次 sync 必须显式 --repo（Workspace runtime config 中尚无 backlog_sync.repo）。\n",
    );
    return 1;
  }
  if (!repoArg.includes("/")) {
    process.stderr.write(`invalid --repo ${JSON.stringify(repoArg)}: expected owner/repo\n`);
    return 1;
  }
  const [owner, repo] = repoArg.split("/", 2) as [string, string];

  // --label may repeat; each value is comma-separated → one flat OR list.
  const labelParts: string[] = [];
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] === "--label" && commandArgs[i + 1] !== undefined) labelParts.push(commandArgs[i + 1]!);
  }
  const wanted =
    labelParts.length > 0
      ? parseLabelsFilter(labelParts.join(","))
      : parseLabelsFilter((cfg.labels ?? []).join(","));
  const dryRun = commandArgs.includes("--dry-run");

  let issues: GhIssue[];
  try {
    issues = await deps.loadIssues(owner, repo);
  } catch (e) {
    if (e instanceof AuthError) {
      process.stderr.write(`auth error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof RateLimitError) {
      process.stderr.write(`rate limit: ${e.message}\n`);
      return 3;
    }
    process.stderr.write(`api error: ${(e as Error).message}\n`);
    return 4;
  }
  issues = filterIssuesByLabel(issues, wanted);

  if (!existsSync(backlog)) {
    process.stderr.write(`backlog not found: ${backlog}\n`);
    return 1;
  }
  const content = readFileSync(backlog, "utf8");

  if (dryRun) {
    const preview = dryRunPreview(issues, content);
    for (const line of preview.lines) process.stdout.write(line + "\n");
    process.stdout.write(
      `added: ${preview.added}, skipped: ${preview.skipped}, total issues: ${preview.total} (dry-run, no changes written)\n`,
    );
    return 0;
  }

  const result = syncToBacklog(issues, content);
  try {
    const addedIssues = issues.filter((issue) => existingStoryIdForIssue(content, issue) === undefined);
    const block = renderSyncBlock(repoArg, wanted, deps.nowIso());
    const originalConfig = existsSync(localYaml) ? readFileSync(localYaml, "utf8") : "";
    const configContent = originalConfig === "" ? block + "\n" : writeSyncBlock(originalConfig, block);
    const writes: PlannedWrite[] = [
      { path: backlog, content: result.content },
      ...addedIssues.map((issue) => planFeatureStub(issue, featuresDir)),
      { path: localYaml, content: configContent },
    ];
    applySyncWrites(writes, decision.canonicalRoot, deps.writeFile);
  } catch (error) {
    process.stderr.write(`sync write error: ${(error as Error).message}\n`);
    return 1;
  }

  for (const row of result.rows) process.stdout.write(`+ ${row}\n`);
  for (const ident of result.skippedIds) process.stdout.write(`skipped (already exists): ${ident}\n`);
  process.stdout.write(`added: ${result.added}, skipped: ${result.skipped}, total issues: ${result.total}\n`);

  return 0;
}

/** Plan one create-or-append Story contract without mutating the filesystem. */
function planFeatureStub(issue: GhIssue, featuresDir: string, epic = "backlog-lifecycle"): PlannedWrite {
  const storyDir = join(featuresDir, epic, storyIdFromIssue(issue));
  const path = join(storyDir, "spec.md");
  const ac = renderAcSection(issue);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    const block = ac ? ac + "\n" : "";
    const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
    return { path, content: block === "" ? existing : existing + sep + block };
  }
  return { path, content: featureStubContent(issue) };
}
