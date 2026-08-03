/**
 * US-LOOP-093 — `roll worktree audit`: 只读 worktree 生命周期审计。
 *
 * Read-only audit of all git worktrees registered for the current repo.
 * Classifies loop/manual/external ownership, splits dirty state into tracked
 * vs untracked, determines merge evidence (ancestor / PR-merged / patch-equivalent
 * / none / unknown), and assigns a disposition. Never deletes, moves, stashes,
 * pushes, or rewrites any file or git ref.
 *
 * Data contract: {@link WorktreeAuditRecord}, {@link WorktreeAuditOutput}
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isEphemeralBranch, managedWorkspaceReleaseVerdict, projectManagedWorkspaceRuns, type ManagedWorkspaceRunView } from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";
import { normalizeRemoteUrl, parseEventLine, projectSlug, resolveLang, type RollEvent } from "@roll/spec";

// ─── types (shared with the spec) ───────────────────────────────────────────

export type WorktreeOwner = "loop" | "manual" | "external";

export type MergeEvidenceKind =
  | "ancestor"
  | "pr_merged"
  | "patch_equivalent"
  | "none"
  | "unknown";

export type WorktreeDisposition =
  | "active"
  | "disposable_candidate"
  | "preserved_needs_review"
  | "preserved_unpublished"
  | "preserved_dirty_no_tcr"
  | "external_unmanaged"
  // FIX-1460 (#1468): a loop worktree DIR that exists on disk under
  // `.roll/loop/worktrees` but is absent from `git worktree list` (its
  // registration was removed — e.g. a failed `git worktree remove` that left
  // untracked scratch). The runtime canary counts these dirs, so they must be
  // visible here or they leak. `orphan_reclaimable` = owning cycle is provably
  // delivered → safe bounded reclaim; `preserved_orphan` = delivery not provable
  // → preserved + surfaced (never auto-deleted).
  | "orphan_reclaimable"
  | "preserved_orphan";

export interface WorktreeAuditRecord {
  path: string;
  branch?: string;
  head?: string;
  owner: WorktreeOwner;
  cycleId?: string;
  storyId?: string;
  outcome?: string;
  dirtyTracked: boolean | "unknown";
  dirtyUntracked: boolean | "unknown";
  ahead: number | null;
  mergeEvidence: {
    kind: MergeEvidenceKind;
    detail?: string;
  };
  openPr?: {
    url: string;
    state: "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
  };
  active: boolean;
  disposition: WorktreeDisposition;
  reason: string;
  /** US-LOOP-123: projection identity, never inferred from a path name. */
  runId?: string;
  memberLocator?: string;
  runState?: string;
  registration?: "registered" | "missing" | "unknown" | "foreign";
  /** The recorded repository identity matched during a subordinate-repo audit. */
  repositoryIdentity?: "expected" | "foreign" | "unknown";
  releaseVerdict?: "safe_to_release" | "preserve_active" | "preserve_unmerged" | "preserve_pending_evidence" | "preserve_truth_disagreement" | "preserve_unknown";
}

export interface WorktreeAuditOutput {
  schema: 1;
  generatedAt: string;
  repo: string;
  records: WorktreeAuditRecord[];
  /**
   * FIX-1273: the EXACT ephemeral local branches the branch/worktree canary
   * counts (isEphemeralBranch over `git branch`). Enumerated here so the canary
   * trip + cleanup planner can report the full counted set — the audit is the
   * SOLE authority over what the canary sees, never a separate ad-hoc count.
   */
  ephemeralBranches: string[];
  /** A missing inspection is a safety fault, never an empty managed set. */
  inspectionUnavailable?: boolean;
  summary: {
    total: number;
    loop: number;
    manual: number;
    external: number;
    active: number;
    disposableCandidates: number;
    preserved: number;
    /** FIX-1273: ephemeral local branch count (canary's other addend). */
    ephemeralBranches: number;
  };
}

interface ProjectedMember {
  readonly run: ManagedWorkspaceRunView;
  readonly locator: string;
  readonly expectedHead?: string;
}

interface RawWorktree {
  path: string;
  head: string;
  branch: string;
}

// ─── dependency hooks (injectable for tests) ──────────────────────────────

export interface WorktreeAuditDeps {
  /** CWD for the repo root. */
  repoRoot: string;
  /** Replacement for `git` invocations (array of ['git', 'arg', …'] → stdout). */
  git?: (args: string[], cwd: string) => string;
  /** Read file content (for events.ndjson, lock files). */
  readFile?: (p: string) => string | null;
  /**
   * FIX-1460: list immediate subdirectory NAMES of a path (for the orphan
   * loop-worktree disk scan). Defaults to a real readdir filtered to directories.
   * Injectable in tests. Must NOT throw — returns [] when the path is absent.
   */
  readDir?: (p: string) => string[];
  /** Current timestamp as ISO-8601 string. */
  nowISO?: () => string;
  /** Current UTC seconds. */
  nowSec?: () => number;
  /** Home directory (for sibling worktree detection). */
  home: string;
  /**
   * E1: the integration branch the merge/ahead probes compare against. Defaults
   * to the project's resolved `integration_branch` config (origin/main unless
   * overridden). Injected in tests.
   */
  integrationBranch?: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

function readFileSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Known manual/sibling worktree directory name patterns. */
const MANUAL_PATTERNS = [/roll-wt-/, /^wt-/, /roll-us-init-/];

// ─── classification ─────────────────────────────────────────────────────────

function classifyOwner(absPath: string, repoRoot: string): WorktreeOwner {
  const loopRoot = resolve(repoRoot, ".roll", "loop", "worktrees");
  const rp = resolve(absPath);
  if (rp.startsWith(loopRoot + "/") || rp === loopRoot) return "loop";

  // Check sibling directories: direct children of repo's parent dir
  const repoParent = dirname(resolve(repoRoot));
  const rel = relative(repoParent, rp);
  if (!rel.startsWith("..")) {
    const name = basename(rp);
    for (const re of MANUAL_PATTERNS) {
      if (re.test(name)) return "manual";
    }
  }
  return "external";
}

// ─── events.ndjson helpers ─────────────────────────────────────────────────

interface CycleEvent {
  cycleId?: string;
  storyId?: string;
  outcome?: string;
  type?: string;
  ts?: number;
}

function readCycleContext(eventsPath: string, deps: WorktreeAuditDeps): Map<string, CycleEvent> {
  const map = new Map<string, CycleEvent>();
  const text = deps.readFile ? deps.readFile(eventsPath) : readFileSafe(eventsPath);
  if (!text) return map;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev: CycleEvent = JSON.parse(trimmed);
      if (!ev.cycleId) continue;
      const existing = map.get(ev.cycleId);
      if (!existing) {
        map.set(ev.cycleId, ev);
      } else {
        if (ev.storyId) existing.storyId = ev.storyId;
        if (ev.outcome) existing.outcome = ev.outcome;
      }
    } catch {
      /* corrupt line: skip */
    }
  }
  return map;
}

function readEvents(eventsPath: string, deps: WorktreeAuditDeps): RollEvent[] {
  const text = deps.readFile ? deps.readFile(eventsPath) : readFileSafe(eventsPath);
  if (!text) return [];
  return text.split("\n").map(parseEventLine).filter((event): event is RollEvent => event !== null);
}

/**
 * Materialise the shared projection at the filesystem boundary.  Legacy cycles
 * are adapted by the core projection's run id, not by scanning a prefix.
 */
function projectedMembers(events: readonly RollEvent[]): ProjectedMember[] {
  const members: ProjectedMember[] = [];
  for (const run of projectManagedWorkspaceRuns(events)) {
    if (run.workspace !== undefined) {
      // Allocation HEAD names the checkout created for a run. Once release has
      // been requested, the only valid destructive expectation is the fresh
      // per-member HEAD frozen immediately before release (a child may have
      // committed since allocation). Use the latest matching durable request.
      const release = [...events].reverse().find((event) => event.type === "worktree:release_requested" && event.runId === run.runId) as unknown as {
        readonly expectedHeads: readonly { readonly relativeLocator: string; readonly head: string }[];
      } | undefined;
      const releaseHeads = release?.expectedHeads;
      for (const member of run.workspace.members) {
        members.push({
          run,
          locator: member.relativeLocator,
          expectedHead: releaseHeads?.find((head) => head.relativeLocator === member.relativeLocator)?.head ?? member.checkoutRef.head,
        });
      }
    } else if (run.state === "legacy_cycle") {
      // The legacy adapter is deliberately bounded to the event identity.  It
      // does not promote an arbitrary `cycle-*` directory into Roll ownership.
      members.push({ run, locator: run.runId });
    }
  }
  return members;
}

function withinManagedRoot(repoRoot: string, locator: string): string | undefined {
  const root = resolve(repoRoot, ".roll", "loop", "worktrees");
  const path = resolve(root, locator);
  if (!path.startsWith(root + "/")) return undefined;
  // Git returns physical worktree paths.  On macOS `/var` commonly resolves to
  // `/private/var`; compare the same physical locator so a valid registered
  // member is never downgraded to an unregistered phantom.
  const physicalRoot = realpathSafe(root);
  const physicalPath = realpathSafe(path);
  // A missing member cannot be realpath'd. Preserve its canonical-root
  // relative locator while using the physical root, so missing registration is
  // a first-class audit fault rather than a silently omitted member.
  const comparablePath = physicalPath === path ? resolve(physicalRoot, relative(root, path)) : physicalPath;
  return comparablePath.startsWith(physicalRoot + "/") ? comparablePath : undefined;
}

/**
 * Submodules own separate Git registrations.  Looking only at the superproject
 * list would turn every real submodule checkout into a false orphan, while the
 * `<key>.submodules` directory itself is intentionally never a member.
 */
function submoduleRepositoryPath(repoRoot: string, locator: string): string | undefined {
  const marker = ".submodules/";
  const index = locator.indexOf(marker);
  if (index < 1) return undefined;
  const submodule = locator.slice(index + marker.length);
  return submodule === "" ? undefined : resolve(repoRoot, submodule);
}

function parseWorktreeEntries(output: string): RawWorktree[] {
  const entries: RawWorktree[] = [];
  let current: Partial<RawWorktree> = {};
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? "" });
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (line === "" && current.path) {
      entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? "" });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? "" });
  return entries;
}

/**
 * A host-guided Delta allocation persists the configured origin URL, while
 * older Cycle allocations persist `projectSlug`.  A URL only proves identity
 * when both sides are recognised Git remote spellings; never treat a similar
 * repository name as equivalent.
 */
function canonicalRemoteIdentity(value: string): string | undefined {
  const remote = value.trim();
  if (/^git@[^/:\s]+:[^/\s]+\/.+$/i.test(remote) || /^https?:\/\/[^/\s]+\/.+$/i.test(remote)) {
    return normalizeRemoteUrl(remote);
  }
  const sshUrl = /^ssh:\/\/git@([^/:\s]+)(?::22)?\/(.+)$/i.exec(remote);
  return sshUrl === null ? undefined : normalizeRemoteUrl(`https://${sshUrl[1]}/${sshUrl[2]}`);
}

function repositoryIdentityMatches(
  expectedRepositoryId: string,
  observed: { readonly top: string; readonly remoteUrl?: string },
): boolean {
  const expectedRemote = canonicalRemoteIdentity(expectedRepositoryId);
  if (expectedRemote !== undefined) {
    const observedRemote = observed.remoteUrl === undefined ? undefined : canonicalRemoteIdentity(observed.remoteUrl);
    return observedRemote !== undefined && observedRemote === expectedRemote;
  }
  // Preserve the pre-URL allocation contract. `projectSlug` includes the
  // normalized remote hash when available and a canonical local-path hash when
  // it is not, so this is still an exact identity comparison.
  return projectSlug({ path: observed.top, remoteUrl: observed.remoteUrl }) === expectedRepositoryId;
}

function memberRepositoryEntry(
  repository: string,
  path: string,
  expectedRepositoryId: string,
  deps: WorktreeAuditDeps,
): { registration: "registered" | "missing" | "unknown" | "foreign"; repositoryIdentity: "expected" | "foreign" | "unknown"; entry?: RawWorktree } {
  try {
    const g = deps.git ?? git;
    const listed = g(["-C", repository, "worktree", "list", "--porcelain"], repository);
    const entry = parseWorktreeEntries(listed).find((candidate) => realpathSafe(resolve(candidate.path)) === realpathSafe(resolve(path)));
    if (entry === undefined) return { registration: "missing", repositoryIdentity: "unknown" };
    const top = g(["-C", repository, "rev-parse", "--show-toplevel"], repository).trim();
    if (top === "") return { registration: "registered", repositoryIdentity: "unknown", entry };
    let remoteUrl: string | undefined;
    try {
      const origin = g(["-C", repository, "remote", "get-url", "origin"], repository).trim();
      remoteUrl = origin === "" ? undefined : origin;
    } catch { /* a local repository has a path-derived identity */ }
    // Do not pass ROLL_MAIN_SLUG here. It is the owner namespace, whereas this
    // comparison proves the identity of this independently registered repo.
    const matches = repositoryIdentityMatches(expectedRepositoryId, {
      top: realpathSafe(resolve(top)),
      remoteUrl,
    });
    return matches
      ? { registration: "registered", repositoryIdentity: "expected", entry }
      : { registration: "foreign", repositoryIdentity: "foreign", entry };
  } catch {
    return { registration: "unknown", repositoryIdentity: "unknown" };
  }
}

function submoduleMemberEntry(
  repoRoot: string,
  path: string,
  locator: string,
  expectedRepositoryId: string,
  deps: WorktreeAuditDeps,
): { registration: "registered" | "missing" | "unknown" | "foreign"; repositoryIdentity: "expected" | "foreign" | "unknown"; entry?: RawWorktree } {
  const repository = submoduleRepositoryPath(repoRoot, locator);
  return repository === undefined
    ? { registration: "missing", repositoryIdentity: "unknown" }
    : memberRepositoryEntry(repository, path, expectedRepositoryId, deps);
}

function deliveryFacts(events: readonly RollEvent[], runId: string): {
  delivery: "merged" | "unmerged" | "unknown";
  attest: "accepted" | "missing" | "unknown";
  factsAgree: boolean;
} {
  let merged = false;
  let unmerged = false;
  let accepted = false;
  let missing = false;
  for (const event of events) {
    if ("cycleId" in event && event.cycleId === runId) {
      if (event.type === "delivery:merge_confirmed"
        || (event.type === "delivery:reconciled"
          && (event.state === "delivered" || event.state === "delivered_external" || event.state === "delivered_local"))) merged = true;
      if (event.type === "delivery:abandoned") unmerged = true;
      if (event.type === "attest:gate") {
        if (event.verdict === "produced") accepted = true;
        else missing = true;
      }
      if (event.type === "attest:host_delta") accepted = true;
    }
  }
  return {
    delivery: merged ? "merged" : unmerged ? "unmerged" : "unknown",
    attest: accepted ? "accepted" : missing ? "missing" : "unknown",
    factsAgree: !(merged && unmerged) && !(accepted && missing),
  };
}

function extractCycleId(dirName: string): string | undefined {
  const m = /^(cycle-\d{8}-\d{6}-\d+)$/.exec(dirName);
  return m ? m[1] : undefined;
}

/**
 * FIX-1460 (#1468): conservative delivered-outcome allowlist. Only a cycle whose
 * work is on the integration branch makes its orphan worktree dir redundant and
 * therefore safely reclaimable. Mirrors the consistency audit's DELIVERED_OUTCOMES
 * plus `merged` (reconcile treats status==="merged" as delivered).
 */
const ORPHAN_DELIVERED_OUTCOMES = new Set(["delivered", "merged"]);

/** Resolve symlinks for path comparison; returns the input unchanged if it can't. */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Default real directory-name lister for the orphan scan (dirs only, never throws). */
function defaultReadDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e: Dirent) => e.isDirectory())
      .map((e: Dirent) => e.name);
  } catch {
    return [];
  }
}

/**
 * FIX-1460 (#1468): enumerate ORPHAN loop worktree directories — dirs under
 * `.roll/loop/worktrees` that are NOT registered in `git worktree list`. Such a
 * dir is what a failed `git worktree remove --force` (blocked by untracked scratch
 * like `.next`) leaves behind: the registration is gone but the directory remains,
 * so the runtime canary keeps counting it while cleanup cannot see it.
 *
 * Each orphan becomes a loop-owned record so it is COUNTED + VISIBLE. It is marked
 * `orphan_reclaimable` ONLY when it is inactive AND its owning cycle's recorded
 * outcome is delivered/merged (its work is on main → the checkout is redundant);
 * otherwise `preserved_orphan` (delivery not provable → never auto-deleted).
 */
function scanOrphanLoopWorktrees(
  repoRoot: string,
  registeredPaths: ReadonlySet<string>,
  cycles: Map<string, CycleEvent>,
  deps: WorktreeAuditDeps,
): WorktreeAuditRecord[] {
  const worktreesDir = join(repoRoot, ".roll", "loop", "worktrees");
  const names = deps.readDir ? deps.readDir(worktreesDir) : defaultReadDirNames(worktreesDir);
  const out: WorktreeAuditRecord[] = [];
  for (const name of [...names].sort()) {
    const absPath = resolve(join(worktreesDir, name));
    if (registeredPaths.has(realpathSafe(absPath))) continue; // a registered worktree — already recorded above
    const cycleId = extractCycleId(name);
    const ce = cycleId ? cycles.get(cycleId) : undefined;
    const outcome = ce?.outcome;
    const active = isActiveCycle(cycleId, repoRoot, deps);

    const rec: WorktreeAuditRecord = {
      path: absPath,
      owner: "loop",
      ...(cycleId ? { cycleId } : {}),
      ...(ce?.storyId ? { storyId: ce.storyId } : {}),
      ...(outcome ? { outcome } : {}),
      dirtyTracked: "unknown", // no git metadata for a deregistered dir
      dirtyUntracked: "unknown",
      ahead: null,
      mergeEvidence: { kind: "none" },
      active,
      disposition: "preserved_orphan",
      reason: "",
    };

    if (active) {
      rec.reason = "orphan loop dir with an active cycle lock; never reclaimed";
    } else if (outcome && ORPHAN_DELIVERED_OUTCOMES.has(outcome)) {
      rec.disposition = "orphan_reclaimable";
      rec.reason = `orphan loop dir (deregistered from git); owning cycle outcome '${outcome}' is delivered — bounded reclaim`;
    } else {
      rec.reason = `orphan loop dir (deregistered from git); delivery not provable (cycle outcome '${outcome ?? "unknown"}') — preserved, reclaim manually after review`;
    }
    out.push(rec);
  }
  return out;
}

// ─── dirty detection ────────────────────────────────────────────────────────

function detectDirty(
  wtPath: string,
  deps: WorktreeAuditDeps,
): { dirtyTracked: boolean | "unknown"; dirtyUntracked: boolean | "unknown" } {
  try {
    const g = deps.git ?? git;
    // Tracked-only dirt: no untracked files
    const tracked = g(["status", "--porcelain", "--untracked-files=no"], wtPath);
    // Full status
    const all = g(["status", "--porcelain", "--untracked-files=normal"], wtPath);

    const trackedLines = tracked.split("\n").filter((l) => l.trim());
    const allLines = all.split("\n").filter((l) => l.trim());

    return {
      dirtyTracked: trackedLines.length > 0,
      dirtyUntracked: allLines.length > trackedLines.length,
    };
  } catch {
    return { dirtyTracked: "unknown", dirtyUntracked: "unknown" };
  }
}

// ─── merge evidence ─────────────────────────────────────────────────────────

function detectMergeEvidence(
  wtPath: string,
  branch: string | undefined,
  deps: WorktreeAuditDeps,
  integrationBranch: string,
): { kind: MergeEvidenceKind; detail?: string } {
  // 1. Check if HEAD is ancestor of the integration branch via merge-base compare
  try {
    const g = deps.git ?? git;
    const headSha = g(["rev-parse", "HEAD"], wtPath);
    const mergeBase = g(["merge-base", "HEAD", integrationBranch], wtPath);
    if (headSha && mergeBase && headSha === mergeBase) {
      return { kind: "ancestor", detail: `HEAD is ancestor of ${integrationBranch}` };
    }
  } catch {
    // Fall through
  }

  // 2. Check --is-ancestor via exit code (covers squash merges where
  //    branch is listed in `git branch --merged <integrationBranch>`)
  if (branch) {
    try {
      const g = deps.git ?? git;
      const merged = g(["branch", "--merged", integrationBranch], wtPath);
      const branchName = branch.replace(/^refs\/heads\//, "");
      for (const line of merged.split("\n")) {
        const trimmed = line.replace(/^\*?\s+/, "").trim();
        if (trimmed === branchName) {
          return {
            kind: "pr_merged",
            detail: `branch ${branchName} is merged into ${integrationBranch} (squash-safe)`,
          };
        }
      }
    } catch {
      // Fall through
    }
  }

  // 3. Explicit is-ancestor exit code check
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", integrationBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
    return { kind: "ancestor", detail: `HEAD is ancestor of ${integrationBranch}` };
  } catch {
    // Not an ancestor
  }

  return { kind: "none" };
}

// ─── ahead count ────────────────────────────────────────────────────────────

function countAhead(wtPath: string, deps: WorktreeAuditDeps, integrationBranch: string): number | null {
  try {
    const g = deps.git ?? git;
    const out = g(["rev-list", "--count", "HEAD", `^${integrationBranch}`], wtPath).trim();
    if (!out) return null;
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ─── active cycle detection ─────────────────────────────────────────────────

function isActiveCycle(
  cycleId: string | undefined,
  repoRoot: string,
  deps: WorktreeAuditDeps,
): boolean {
  if (!cycleId) return false;

  // Check inner.lock for the active cycleId
  const lockPath = join(repoRoot, ".roll", "loop", "inner.lock");
  const lock = deps.readFile ? deps.readFile(lockPath) : readFileSafe(lockPath);
  if (lock) {
    for (const line of lock.split("\n")) {
      if (line.trim().startsWith(cycleId)) return true;
    }
  }

  // Check heartbeat freshness
  const nowSec = deps.nowSec?.() ?? Math.floor(Date.now() / 1000);
  const HEARTBEAT_STALE_SEC = 300;

  try {
    const heartbeatPath = join(repoRoot, ".roll", "loop", "heartbeat");
    const hb = deps.readFile ? deps.readFile(heartbeatPath) : readFileSafe(heartbeatPath);
    if (hb) {
      for (const line of hb.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === cycleId && parts.length >= 3) {
          const ts = Number(parts[1]);
          if (Number.isFinite(ts) && nowSec - ts <= HEARTBEAT_STALE_SEC) return true;
        }
      }
    }
  } catch {
    /* heartbeat read failed — not a reason to mark active */
  }

  return false;
}

// ─── disposition ────────────────────────────────────────────────────────────

function classifyDisposition(
  rec: WorktreeAuditRecord,
): { disposition: WorktreeDisposition; reason: string } {
  if (rec.active) return { disposition: "active", reason: "active cycle with fresh lock/heartbeat" };

  if (rec.owner === "external") {
    return { disposition: "external_unmanaged", reason: "external worktree; not managed by loop" };
  }
  if (rec.owner === "manual") {
    return { disposition: "external_unmanaged", reason: "manual sibling worktree; not managed by loop" };
  }

  const hasDirtyTracked = rec.dirtyTracked === true;
  const hasMerge =
    rec.mergeEvidence.kind === "ancestor" ||
    rec.mergeEvidence.kind === "pr_merged" ||
    rec.mergeEvidence.kind === "patch_equivalent";
  const hasOpenPr = rec.openPr?.state === "OPEN";
  const hasMergedPr = rec.openPr?.state === "MERGED";

  // Merged + no tracked dirt + no open PR → disposable
  if (hasMerge && !hasDirtyTracked && !hasOpenPr) {
    return { disposition: "disposable_candidate", reason: "merged worktree with no tracked dirt; candidate for future gc" };
  }

  // Ahead / unpublished
  if (rec.ahead !== null && rec.ahead > 0) {
    if (hasDirtyTracked) {
      return { disposition: "preserved_dirty_no_tcr", reason: "unpublished loop worktree with uncommitted tracked changes; audit only" };
    }
    if (hasOpenPr) {
      return { disposition: "preserved_unpublished", reason: `unpublished loop worktree has open PR (${rec.openPr?.url ?? "unknown"}); audit only` };
    }
    return { disposition: "preserved_unpublished", reason: "unpublished loop worktree has unmerged work ahead; audit only" };
  }

  if (hasDirtyTracked) {
    return { disposition: "preserved_dirty_no_tcr", reason: "loop worktree with tracked changes and no clear merge evidence; audit only" };
  }

  const terminal = ["failed", "blocked", "aborted_no_delivery", "handoff_without_tcr"];
  if (rec.outcome && terminal.includes(rec.outcome)) {
    return { disposition: "preserved_needs_review", reason: `loop worktree with terminal outcome '${rec.outcome}'; may need rescue` };
  }

  if ((hasMerge || hasMergedPr) && rec.dirtyUntracked === true) {
    return { disposition: "disposable_candidate", reason: "merged worktree with only untracked scratch; candidate for future gc" };
  }

  return { disposition: "preserved_needs_review", reason: "loop worktree with unclear state; needs manual review" };
}

// ─── main audit function ───────────────────────────────────────────────────

export function auditWorktrees(deps: WorktreeAuditDeps): WorktreeAuditOutput {
  const repoRoot = resolve(deps.repoRoot);
  // E1: resolve the integration branch ONCE (injected override wins for tests;
  // otherwise the project's `integration_branch` config, default origin/main).
  const integrationBranch = deps.integrationBranch ?? resolveIntegrationBranch(repoRoot);

  // 1. Parse `git worktree list --porcelain`
  let inspectionUnavailable = false;
  let wtOutput = "";
  try {
    wtOutput = deps.git
      ? deps.git(["worktree", "list", "--porcelain"], repoRoot)
      : git(["worktree", "list", "--porcelain"], repoRoot);
  } catch {
    inspectionUnavailable = true;
  }

  // 2. Read events.ndjson for cycle context
  const eventsPath = join(repoRoot, ".roll", "loop", "events.ndjson");
  const cycles = readCycleContext(eventsPath, deps);
  const events = readEvents(eventsPath, deps);
  const projectionMembers = projectedMembers(events);
  // Once the lifecycle vocabulary exists, it is the sole ownership authority.
  // Empty historical ledgers retain the pre-cutover read-compatible surface.
  const projectionEnabled = events.some((event) => event.type.startsWith("worktree:"));

  // 3. Parse the superproject registrations. Submodule registrations are
  // enumerated separately below from each member's own repository.
  const entries = parseWorktreeEntries(wtOutput);

  // 4. Build records
  const records: WorktreeAuditRecord[] = [];
  const seenProjectedLocators = new Set<string>();

  for (const entry of entries) {
    const absPath = resolve(entry.path);
    const projected = projectionMembers.find((member) => withinManagedRoot(repoRoot, member.locator) === absPath);
    const owner = projected !== undefined ? "loop" : projectionEnabled ? "external" : classifyOwner(absPath, repoRoot);

    let cycleId: string | undefined;
    let storyId: string | undefined;
    let outcome: string | undefined;

    if (projected !== undefined) {
      seenProjectedLocators.add(projected.locator);
      cycleId = projected.run.kind === "cycle" ? projected.run.runId : undefined;
      storyId = projected.run.storyId;
    } else if (owner === "loop") {
      cycleId = extractCycleId(basename(absPath));
      if (cycleId) {
        const ce = cycles.get(cycleId);
        if (ce) {
          storyId = ce.storyId;
          outcome = ce.outcome;
        }
      }
    }

    const dirty = detectDirty(absPath, deps);
    const ahead = countAhead(absPath, deps, integrationBranch);
    const mergeEvidence = detectMergeEvidence(absPath, entry.branch || undefined, deps, integrationBranch);
    const active = projected !== undefined
      ? projected.run.state === "active" || projected.run.state === "active_unstarted"
      : isActiveCycle(cycleId, repoRoot, deps);

    const baseRec: WorktreeAuditRecord = {
      path: absPath,
      branch: entry.branch || undefined,
      head: entry.head || undefined,
      owner,
      cycleId,
      storyId,
      outcome,
      dirtyTracked: dirty.dirtyTracked,
      dirtyUntracked: dirty.dirtyUntracked,
      ahead,
      mergeEvidence,
      active,
      disposition: "preserved_needs_review",
      reason: "",
      ...(projected === undefined
        ? {}
        : {
            runId: projected.run.runId,
            memberLocator: projected.locator,
            runState: projected.run.state,
            registration: "registered" as const,
          }),
    };

    if (projected !== undefined) {
      const expectedRepositoryId = projected.run.workspace?.members.find(
        (member) => member.relativeLocator === projected.locator,
      )?.repositoryId ?? "";
      // The superproject list proves only registration. Verify its own live
      // repository identity too; otherwise a replaced primary can masquerade
      // as the recorded member just as a replaced submodule could.
      const memberInspection = memberRepositoryEntry(repoRoot, absPath, expectedRepositoryId, deps);
      const facts = deliveryFacts(events, projected.run.runId);
      const release = managedWorkspaceReleaseVerdict({
        runState: projected.run.state,
        ...facts,
        members: [{
          relativeLocator: projected.locator,
          registration: memberInspection.registration,
          activity: active ? "active" : "inactive",
          head: projected.expectedHead === undefined || entry.head === projected.expectedHead ? "expected" : "mismatch",
          cleanliness: dirty.dirtyTracked === false && dirty.dirtyUntracked === false ? "clean" : dirty.dirtyTracked === "unknown" || dirty.dirtyUntracked === "unknown" ? "unknown" : "dirty",
        }],
      });
      baseRec.releaseVerdict = release.verdict;
      baseRec.registration = memberInspection.registration;
      baseRec.repositoryIdentity = memberInspection.repositoryIdentity;
      if (release.verdict === "safe_to_release") {
        baseRec.disposition = "disposable_candidate";
        baseRec.reason = "projection confirms merged delivery, accepted attest, and a clean registered member";
      } else if (release.verdict === "preserve_active") {
        baseRec.disposition = "active";
        baseRec.reason = "projection retains an active delivery reservation";
      } else {
        baseRec.disposition = "preserved_needs_review";
        baseRec.reason = `projection release verdict: ${release.verdict}`;
      }
    } else {
      const disp = classifyDisposition(baseRec);
      baseRec.disposition = disp.disposition;
      baseRec.reason = disp.reason;
    }

    records.push(baseRec);
  }

  // 4a. Legacy-only orphan scan. New lifecycle projections never inspect raw
  // directories as ownership evidence: an unregistered projected member below
  // remains a first-class preserved record instead.
  // present on disk but absent from `git worktree list` above. These are what the
  // runtime canary counts, so surfacing them here keeps the two counters in sync
  // and stops the leak (a deregistered dir that pauses the loop but is invisible
  // to cleanup). Fail-closed: only a dir whose owning cycle is provably delivered
  // is reclaimable; every other orphan is preserved + surfaced.
  // Dedup by realpath — `git worktree list` returns realpath'd paths while the
  // scan joins onto repoRoot; a symlinked prefix (e.g. macOS /tmp→/private/tmp)
  // must not make a registered worktree look like an orphan (double-count).
  if (!projectionEnabled) {
    const registeredLoopPaths = new Set(records.map((r) => realpathSafe(resolve(r.path))));
    for (const orphan of scanOrphanLoopWorktrees(repoRoot, registeredLoopPaths, cycles, deps)) {
      records.push(orphan);
    }
  } else {
    for (const member of projectionMembers) {
      // A legacy cycle is an event-only compatibility view, not a promised
      // on-disk workspace.  It can identify a registered legacy checkout above,
      // but an absent historical path must not become a phantom member, consume
      // capacity, or turn inspection into an unavailable safety fault.
      if (member.run.workspace === undefined) continue;
      if (seenProjectedLocators.has(member.locator)) continue;
      const containedPath = withinManagedRoot(repoRoot, member.locator);
      // Never omit an expected member. A lexical or realpath containment fault
      // is a first-class, counted projection record so a clean sibling cannot
      // obtain a release verdict by hiding it behind a symlink or `..` locator.
      const path = containedPath ?? resolve(repoRoot, ".roll", "loop", "worktrees", member.locator);
      const observed = containedPath === undefined
        ? { registration: "unknown" as const, repositoryIdentity: "unknown" as const }
        : submoduleMemberEntry(repoRoot, path, member.locator, member.run.workspace.members.find((candidate) => candidate.relativeLocator === member.locator)?.repositoryId ?? "", deps);
      const registration = observed.registration;
      const facts = deliveryFacts(events, member.run.runId);
      const dirty = observed.entry === undefined
        ? { dirtyTracked: "unknown" as const, dirtyUntracked: "unknown" as const }
        : detectDirty(path, deps);
      const active = member.run.state === "active" || member.run.state === "active_unstarted";
      const release = managedWorkspaceReleaseVerdict({
        runState: member.run.state,
        ...facts,
        members: [{
          relativeLocator: member.locator,
          registration,
          activity: active ? "active" : observed.entry === undefined ? "unknown" : "inactive",
          head: observed.entry === undefined || member.expectedHead === undefined
            ? "unknown"
            : observed.entry.head === member.expectedHead ? "expected" : "mismatch",
          cleanliness: dirty.dirtyTracked === false && dirty.dirtyUntracked === false
            ? "clean"
            : dirty.dirtyTracked === "unknown" || dirty.dirtyUntracked === "unknown" ? "unknown" : "dirty",
        }],
      });
      records.push({
        path,
        owner: "loop",
        runId: member.run.runId,
        memberLocator: member.locator,
        runState: member.run.state,
        registration,
        repositoryIdentity: observed.repositoryIdentity,
        storyId: member.run.storyId,
        ...(observed.entry?.branch ? { branch: observed.entry.branch } : {}),
        ...(observed.entry?.head ? { head: observed.entry.head } : {}),
        dirtyTracked: dirty.dirtyTracked,
        dirtyUntracked: dirty.dirtyUntracked,
        ahead: observed.entry === undefined ? null : countAhead(path, deps, integrationBranch),
        mergeEvidence: observed.entry === undefined ? { kind: "unknown" } : detectMergeEvidence(path, observed.entry.branch || undefined, deps, integrationBranch),
        active,
        disposition: active ? "active" : "preserved_needs_review",
        releaseVerdict: release.verdict,
        reason: containedPath === undefined
          ? "projection member escapes its canonical managed root; preserved for owner recovery"
          : registration === "registered"
          ? "submodule member registration was found but its live inspection is unavailable; preserved"
          : "projection member is not registered in its repository; preserved for recovery",
      });
    }
  }

  // A workspace set is all-or-nothing.  Re-run the pure selector with every
  // member of each run so a clean primary can never make a dirty submodule an
  // independent cleanup candidate.
  const recordsByRun = new Map<string, WorktreeAuditRecord[]>();
  for (const record of records) {
    if (record.runId === undefined) continue;
    const group = recordsByRun.get(record.runId) ?? [];
    group.push(record);
    recordsByRun.set(record.runId, group);
  }
  for (const [runId, runRecords] of recordsByRun) {
    const run = projectionMembers.find((member) => member.run.runId === runId)?.run;
    if (run === undefined) continue;
    const facts = deliveryFacts(events, runId);
    const expectedMembers = run.workspace?.members ?? [];
    const recordsByLocator = new Map(runRecords.map((record) => [record.memberLocator, record]));
    const complete = expectedMembers.length === runRecords.length
      && expectedMembers.every((member) => recordsByLocator.has(member.relativeLocator));
    const decision = managedWorkspaceReleaseVerdict({
      runState: run.state,
      ...facts,
      members: expectedMembers.map((member) => {
        const record = recordsByLocator.get(member.relativeLocator);
        if (record === undefined) {
          return {
            relativeLocator: member.relativeLocator,
            registration: "unknown" as const,
            activity: "unknown" as const,
            head: "unknown" as const,
            cleanliness: "unknown" as const,
          };
        }
        // `projectedMembers` is the single lifecycle projection boundary. It
        // already resolves the latest durable release request for this exact
        // locator, so do not fall back to the allocation checkout here. A
        // member is allowed to commit after allocation and freeze that newer
        // HEAD when terminal release is requested.
        const expected = projectionMembers.find(
          (projected) => projected.run.runId === runId && projected.locator === member.relativeLocator,
        )?.expectedHead;
        return {
          relativeLocator: member.relativeLocator,
          registration: record.repositoryIdentity === "foreign" || record.repositoryIdentity === "unknown"
            ? record.repositoryIdentity === "foreign" ? "foreign" : "unknown"
            : record.registration ?? "unknown",
          activity: record.active ? "active" : "inactive",
          head: expected === undefined || record.head === expected ? "expected" : record.head === undefined ? "unknown" : "mismatch",
          cleanliness: record.dirtyTracked === false && record.dirtyUntracked === false ? "clean" : record.dirtyTracked === "unknown" || record.dirtyUntracked === "unknown" ? "unknown" : "dirty",
        };
      }),
    });
    for (const record of runRecords) {
      const verdict = complete ? decision.verdict : "preserve_unknown";
      record.releaseVerdict = verdict;
      if (verdict === "safe_to_release") {
        record.disposition = "disposable_candidate";
        record.reason = "projection confirms every workspace member is release-safe";
      } else if (verdict === "preserve_active") {
        record.disposition = "active";
        record.reason = "projection retains an active delivery reservation";
      } else {
        record.disposition = "preserved_needs_review";
        record.reason = complete
          ? `projection release verdict: ${verdict}`
          : "projection member set is incomplete; preserved for owner recovery";
      }
    }
  }

  // 4b. Enumerate the EXACT ephemeral local branches the canary counts. The
  // canary's total = ephemeral branches + loop worktree dirs; surfacing the
  // branch names here makes the audit the single source of truth for what the
  // canary sees (FIX-1273 AC1).
  let ephemeralBranches: string[] = [];
  try {
    const g = deps.git ?? git;
    const branchOut = g(["branch", "--format=%(refname:short)"], repoRoot);
    ephemeralBranches = branchOut
      .split("\n")
      .map((s) => s.trim())
      .filter((b) => b !== "" && isEphemeralBranch(b))
      .sort();
  } catch {
    // A branch list failure leaves the canary's total unknown. Preserve the
    // readable audit but flag it so callers pause rather than treating it as 0.
    ephemeralBranches = [];
    inspectionUnavailable = true;
  }

  // 5. Summary
  const summary = {
    total: records.length,
    loop: records.filter((r) => r.owner === "loop").length,
    manual: records.filter((r) => r.owner === "manual").length,
    external: records.filter((r) => r.owner === "external").length,
    active: records.filter((r) => r.active).length,
    disposableCandidates: records.filter((r) => r.disposition === "disposable_candidate").length,
    preserved: records.filter(
      (r) => r.disposition !== "disposable_candidate" && r.disposition !== "external_unmanaged",
    ).length,
    ephemeralBranches: ephemeralBranches.length,
  };

  const repoName = basename(repoRoot);
  const nowISO = deps.nowISO?.() ?? new Date().toISOString();

  return {
    schema: 1,
    generatedAt: nowISO,
    repo: repoName,
    records,
    ephemeralBranches,
    summary,
    ...(inspectionUnavailable || (projectionEnabled && records.some((record) => record.registration === "missing" || record.registration === "unknown"))
      ? { inspectionUnavailable: true }
      : {}),
  };
}

// ─── human output ───────────────────────────────────────────────────────────

function renderHuman(output: WorktreeAuditOutput): string {
  const lang = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
  const zh = lang === "zh";
  const lines: string[] = [zh ? "工作树审计" : "Worktree audit", ""];

  lines.push(`  ${zh ? "总计" : "total"}: ${output.summary.total}`);
  lines.push(`  ${zh ? "受管" : "loop"}: ${output.summary.loop}`);
  lines.push(`  ${zh ? "手动" : "manual"}: ${output.summary.manual}`);
  if (output.summary.external > 0) lines.push(`  ${zh ? "外部" : "external"}: ${output.summary.external}`);
  lines.push(`  ${zh ? "活跃" : "active"}: ${output.summary.active}`);
  lines.push(`  ${zh ? "可释放候选" : "disposable candidates"}: ${output.summary.disposableCandidates}`);
  lines.push(`  ${zh ? "保留" : "preserved"}: ${output.summary.preserved}`);
  lines.push(`  ${zh ? "临时分支" : "ephemeral branches"}: ${output.summary.ephemeralBranches}`);
  lines.push("");

  if (output.ephemeralBranches.length > 0) {
    lines.push(zh ? "临时分支（canary 计数）" : "ephemeral branches (canary-counted)");
    for (const b of output.ephemeralBranches) lines.push(`  ${b}`);
    lines.push("");
  }

  // Group by disposition
  const groups = new Map<WorktreeDisposition, WorktreeAuditRecord[]>();
  for (const r of output.records) {
    const list = groups.get(r.disposition) ?? [];
    list.push(r);
    groups.set(r.disposition, list);
  }

  const order: WorktreeDisposition[] = [
    "active",
    "preserved_unpublished",
    "preserved_dirty_no_tcr",
    "preserved_needs_review",
    "preserved_orphan",
    "disposable_candidate",
    "orphan_reclaimable",
    "external_unmanaged",
  ];

  for (const disp of order) {
    const group = groups.get(disp);
    if (!group || group.length === 0) continue;
    lines.push(disp);
    for (const r of group) {
      const parts: string[] = [];
      let displayPath = r.path;
      try {
        const rel = relative(process.cwd(), r.path);
        if (!rel.startsWith("..") && rel.length < r.path.length) displayPath = rel;
      } catch { /* keep absolute */ }
      parts.push(`  ${displayPath}`);
      if (r.storyId) parts.push(r.storyId);
      if (r.openPr) parts.push(`${r.openPr.url} ${r.openPr.state}`);
      const tags: string[] = [];
      if (r.dirtyTracked === true) tags.push("tracked dirt");
      else if (r.dirtyTracked === "unknown") tags.push("dirty=?");
      if (r.dirtyUntracked === true && r.dirtyTracked !== true) tags.push("untracked dirt");
      if (r.ahead !== null && r.ahead > 0) tags.push(`ahead=${r.ahead}`);
      if (r.mergeEvidence.kind === "unknown") tags.push("merge=?");
      if (tags.length > 0) parts.push(tags.join(", "));
      lines.push(parts.join("  "));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ─── CLI command ────────────────────────────────────────────────────────────

const USAGE =
  "Usage: roll worktree audit [--json] [--repo <path>]\n" +
  "  Read-only audit of all git worktrees registered for this repo.\n" +
  "  Classifies ownership, dirt, merge evidence, and disposition.\n" +
  "  --json    print schema-1 JSON output\n" +
  "  --repo    override the project root (default: current directory)\n";

export function worktreeAuditUsage(): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  return zh
    ? "用法：roll worktree audit [--json] [--repo <path>]\n  只读审计本仓库已注册的 Git 工作树。\n  输出归属、脏改动、合并证据和处置；外部或旧记录只呈现，不自动认领。\n  --json    输出 schema-1 JSON\n  --repo    覆盖项目根目录（默认：当前目录）\n"
    : USAGE;
}

export function worktreeAuditCommand(args: string[], deps?: Partial<WorktreeAuditDeps>): number {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(worktreeAuditUsage());
    return 0;
  }

  const jsonFlag = args.includes("--json");
  const repoIdx = args.indexOf("--repo");
  const repoOverride = repoIdx >= 0 ? args[repoIdx + 1] : undefined;

  const repoRoot = repoOverride ?? process.cwd();

  const fullDeps: WorktreeAuditDeps = {
    repoRoot,
    home: deps?.home ?? homedir(),
    git: deps?.git,
    readFile: deps?.readFile,
    nowISO: deps?.nowISO,
    nowSec: deps?.nowSec,
  };

  const output = auditWorktrees(fullDeps);

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    process.stdout.write(renderHuman(output));
  }

  return 0;
}
