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
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isEphemeralBranch } from "@roll/core";
import { resolveIntegrationBranch } from "@roll/infra";

// ─── types (shared with the spec) ───────────────────────────────────────────

export type WorktreeOwner = "loop" | "workspace" | "manual" | "external";

export type WorkspaceDeliveryProof =
  | "delivered"
  | "abandoned"
  | "incomplete"
  | "blocked"
  | "unknown";

/** Registry- and Issue-fact-backed ownership supplied by the Workspace aggregate.
 * Path names never create this authority: callers must derive it from one valid
 * Workspace registry entry plus one matching `issue:repository_bound` fact. */
export interface WorkspaceWorktreeOwnership {
  readonly workspaceId: string;
  readonly storyId: string;
  readonly repoId: string;
  readonly repositoryAlias: string;
  readonly cachePath: string;
  readonly expectedBranch: string | null;
  readonly active: boolean;
  readonly deliveryProof: WorkspaceDeliveryProof;
}

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
  // delivered AND the path-specific recovery proof contains only trusted
  // generated residue; every missing, linked, untrusted, or ambiguous proof is
  // `preserved_orphan` and cannot be overridden by cleanup.
  | "orphan_reclaimable"
  | "preserved_orphan";

export interface WorktreeAuditRecord {
  path: string;
  branch?: string;
  head?: string;
  owner: WorktreeOwner;
  workspaceId?: string;
  repoId?: string;
  repositoryAlias?: string;
  cachePath?: string;
  deliveryProof?: WorkspaceDeliveryProof;
  ownershipState?: "verified" | "mismatch";
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
  orphanRecoveryProof?: OrphanRecoveryProof;
  disposition: WorktreeDisposition;
  reason: string;
}

export interface OrphanRecoveryProof {
  state: "empty" | "trusted_generated" | "linked_metadata" | "untrusted_material" | "ambiguous";
  fingerprint: string | null;
  entries: readonly string[];
  detail: string;
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
  summary: {
    total: number;
    loop: number;
    workspace?: number;
    manual: number;
    external: number;
    active: number;
    disposableCandidates: number;
    preserved: number;
    /** FIX-1273: ephemeral local branch count (canary's other addend). */
    ephemeralBranches: number;
  };
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
  /** Inspect one unregistered direct child for path-specific recovery proof. */
  inspectOrphanDir?: (repoRoot: string, path: string, name: string) => OrphanRecoveryProof;
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
  /** Exact registered worktree path -> Workspace ownership facts. */
  workspaceOwnership?: ReadonlyMap<string, WorkspaceWorktreeOwnership>;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return "";
  }
}

function readFileSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readActivityFile(p: string, deps: WorktreeAuditDeps): string | null {
  if (deps.readFile) return deps.readFile(p);
  try {
    return readFileSync(p, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw error;
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
  let text: string | null;
  try {
    text = deps.readFile ? deps.readFile(eventsPath) : readFileSafe(eventsPath);
  } catch {
    return map;
  }
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
const TRUSTED_ORPHAN_GENERATED_ROOTS = new Set([".next"]);
const MAX_ORPHAN_PROOF_ENTRIES = 100_000;

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

function ambiguousOrphanProof(entries: readonly string[], detail: string): OrphanRecoveryProof {
  return { state: "ambiguous", fingerprint: null, entries, detail };
}

function inspectTrustedOrphanTree(path: string, entries: readonly string[]): OrphanRecoveryProof {
  const hash = createHash("sha256");
  const pending = [...entries].sort().reverse();
  let seen = 0;

  try {
    const root = lstatSync(path);
    hash.update(`.\0directory\0${root.mode}\0${root.mtimeMs}\0${root.ctimeMs}\0${root.dev}\0${root.ino}\n`);
  } catch {
    return ambiguousOrphanProof(entries, "orphan directory identity could not be fingerprinted");
  }

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (relativePath === undefined) break;
    seen += 1;
    if (seen > MAX_ORPHAN_PROOF_ENTRIES) {
      return ambiguousOrphanProof(entries, `recovery material exceeds ${MAX_ORPHAN_PROOF_ENTRIES} entries`);
    }

    const absolutePath = join(path, relativePath);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      return ambiguousOrphanProof(entries, `could not inspect '${relativePath}'`);
    }
    if (stat.isSymbolicLink()) {
      return ambiguousOrphanProof(entries, `symbolic link '${relativePath}' is untrusted recovery material`);
    }
    if (stat.isDirectory()) {
      hash.update(`${relativePath}\0directory\0${stat.mode}\0${stat.mtimeMs}\0${stat.ctimeMs}\n`);
      let children: string[];
      try {
        children = readdirSync(absolutePath).sort();
      } catch {
        return ambiguousOrphanProof(entries, `could not enumerate '${relativePath}'`);
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(join(relativePath, children[index] as string));
      }
      continue;
    }
    if (!stat.isFile()) {
      return ambiguousOrphanProof(entries, `unsupported entry '${relativePath}' is untrusted recovery material`);
    }
    hash.update(
      `${relativePath}\0file\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}\n`,
    );
  }

  return {
    state: entries.length === 0 ? "empty" : "trusted_generated",
    fingerprint: hash.digest("hex"),
    entries,
    detail: entries.length === 0 ? "empty orphan directory" : `trusted generated roots: ${entries.join(", ")}`,
  };
}

export function inspectOrphanRecoveryProof(repoRoot: string, path: string, name: string): OrphanRecoveryProof {
  const worktreesRoot = resolve(repoRoot, ".roll", "loop", "worktrees");
  try {
    const root = lstatSync(worktreesRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return ambiguousOrphanProof([], "loop worktree root is a symlink or external boundary");
    }
    if (dirname(realpathSync(path)) !== realpathSync(worktreesRoot)) {
      return ambiguousOrphanProof([], "orphan path resolves outside the loop worktree root");
    }
  } catch {
    return ambiguousOrphanProof([], "loop worktree boundary could not be verified");
  }

  let rootStat;
  try {
    rootStat = lstatSync(path);
  } catch {
    return ambiguousOrphanProof([], "orphan directory disappeared during audit");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return ambiguousOrphanProof([], "orphan path is not a stable directory");
  }

  let entries: string[];
  try {
    entries = readdirSync(path).sort();
  } catch {
    return ambiguousOrphanProof([], "orphan directory could not be enumerated");
  }

  if (entries.includes(".git")) {
    return {
      state: "linked_metadata",
      fingerprint: null,
      entries,
      detail: "orphan directory still contains .git ownership metadata",
    };
  }

  const g = git;
  const commonOutput = g(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot).trim();
  if (!commonOutput) {
    return ambiguousOrphanProof(entries, "Git common directory could not be resolved");
  }
  const commonDir = resolve(repoRoot, commonOutput);
  try {
    const adminRoot = join(commonDir, "worktrees");
    const adminNames = readdirSync(adminRoot, { withFileTypes: true })
      .filter((entry: Dirent) => entry.isDirectory())
      .map((entry: Dirent) => entry.name);
    if (adminNames.includes(name)) {
      return {
        state: "linked_metadata",
        fingerprint: null,
        entries,
        detail: `Git linked-worktree admin metadata still exists for '${name}'`,
      };
    }
    for (const adminName of adminNames) {
      const gitdirPath = join(adminRoot, adminName, "gitdir");
      const gitdir = readFileSafe(gitdirPath);
      if (gitdir === null) {
        return ambiguousOrphanProof(entries, `Git worktree metadata '${adminName}' could not be verified`);
      }
      if (gitdir.trim() === "") {
        return ambiguousOrphanProof(entries, `Git worktree metadata '${adminName}' has an empty gitdir`);
      }
      const linkedPath = dirname(resolve(dirname(gitdirPath), gitdir.trim()));
      if (realpathSafe(linkedPath) === realpathSafe(path)) {
        return {
          state: "linked_metadata",
          fingerprint: null,
          entries,
          detail: `Git linked-worktree admin metadata '${adminName}' still owns this path`,
        };
      }
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      return ambiguousOrphanProof(entries, "Git linked-worktree metadata could not be enumerated");
    }
  }

  const untrusted = entries.filter((entry) => !TRUSTED_ORPHAN_GENERATED_ROOTS.has(entry));
  if (untrusted.length > 0) {
    return {
      state: "untrusted_material",
      fingerprint: null,
      entries,
      detail: `untrusted material may contain tracked or unpublished work: ${untrusted.join(", ")}`,
    };
  }
  return inspectTrustedOrphanTree(path, entries);
}

/**
 * FIX-1460 (#1468): enumerate ORPHAN loop worktree directories — dirs under
 * `.roll/loop/worktrees` that are NOT registered in `git worktree list`. Such a
 * dir is what a failed `git worktree remove --force` (blocked by untracked scratch
 * like `.next`) leaves behind: the registration is gone but the directory remains,
 * so the runtime canary keeps counting it while cleanup cannot see it.
 *
 * Each orphan becomes a loop-owned record so it is COUNTED + VISIBLE. It is marked
 * `orphan_reclaimable` ONLY when it is inactive, its owning cycle is delivered,
 * linked Git metadata is absent, and a bounded material inspection produces a
 * stable fingerprint for empty or explicitly trusted generated residue. Otherwise
 * it is `preserved_orphan`; no manual cleanup override is authorized.
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
    if (basename(name) !== name || name === "." || name === "..") continue;
    const absPath = resolve(join(worktreesDir, name));
    if (registeredPaths.has(realpathSafe(absPath))) continue; // a registered worktree — already recorded above
    const cycleId = extractCycleId(name);
    const ce = cycleId ? cycles.get(cycleId) : undefined;
    const outcome = ce?.outcome;
    const active = isActiveCycle(cycleId, repoRoot, deps);
    const recoveryProof = deps.inspectOrphanDir
      ? deps.inspectOrphanDir(repoRoot, absPath, name)
      : inspectOrphanRecoveryProof(repoRoot, absPath, name);

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
      orphanRecoveryProof: recoveryProof,
      disposition: "preserved_orphan",
      reason: "",
    };

    if (active) {
      rec.reason = "orphan loop dir with an active cycle or inconclusive activity proof; never reclaimed";
    } else if (recoveryProof.state === "linked_metadata") {
      rec.reason = `orphan loop dir has linked or external Git ownership metadata (${recoveryProof.detail}); preserved`;
    } else if (recoveryProof.state === "untrusted_material") {
      rec.reason = `orphan loop dir contains untrusted recovery material (${recoveryProof.detail}); preserved`;
    } else if (recoveryProof.state === "ambiguous") {
      rec.reason = `orphan loop dir recovery proof is ambiguous (${recoveryProof.detail}); preserved`;
    } else if (outcome && ORPHAN_DELIVERED_OUTCOMES.has(outcome)) {
      rec.disposition = "orphan_reclaimable";
      rec.reason = `orphan loop dir (deregistered from git); owning cycle outcome '${outcome}' is delivered and material is ${recoveryProof.state} — bounded reclaim`;
    } else {
      rec.reason = `orphan loop dir (deregistered from git); delivery not provable (cycle outcome '${outcome ?? "unknown"}') — preserved until a complete recovery proof exists`;
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
  let lock: string | null;
  try {
    lock = readActivityFile(lockPath, deps);
  } catch {
    return true;
  }
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
    const hb = readActivityFile(heartbeatPath, deps);
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
    return true;
  }

  return false;
}

// ─── disposition ────────────────────────────────────────────────────────────

function classifyDisposition(
  rec: WorktreeAuditRecord,
): { disposition: WorktreeDisposition; reason: string } {
  if (rec.active) return { disposition: "active", reason: "active cycle with fresh lock/heartbeat" };

  if (rec.owner === "workspace") {
    if (rec.ownershipState === "mismatch") {
      return { disposition: "preserved_needs_review", reason: "Workspace Issue branch does not match its repository-bound fact" };
    }
    if (rec.dirtyTracked === "unknown" || rec.dirtyUntracked === "unknown") {
      return { disposition: "preserved_needs_review", reason: "Workspace Issue dirt could not be verified" };
    }
    if (rec.dirtyTracked || rec.dirtyUntracked) {
      return { disposition: "preserved_dirty_no_tcr", reason: "Workspace Issue worktree is dirty; cleanup is forbidden" };
    }
    if (rec.deliveryProof === "delivered" || rec.deliveryProof === "abandoned") {
      return { disposition: "disposable_candidate", reason: `Workspace Issue ${rec.deliveryProof} proof permits clean inactive disposal` };
    }
    if (rec.deliveryProof === "blocked") {
      return { disposition: "preserved_needs_review", reason: "Workspace Issue delivery is blocked; cleanup is forbidden" };
    }
    if (rec.deliveryProof === "incomplete") {
      return { disposition: "preserved_unpublished", reason: "Workspace Issue delivery is incomplete; cleanup is forbidden" };
    }
    return { disposition: "preserved_needs_review", reason: "Workspace Issue delivery proof is unknown; cleanup is forbidden" };
  }

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
  const workspaceOwnership = new Map<string, WorkspaceWorktreeOwnership>();
  for (const [path, ownership] of deps.workspaceOwnership ?? []) {
    workspaceOwnership.set(realpathSafe(resolve(path)), ownership);
  }
  // E1: resolve the integration branch ONCE (injected override wins for tests;
  // otherwise the project's `integration_branch` config, default origin/main).
  const integrationBranch = deps.integrationBranch ?? resolveIntegrationBranch(repoRoot);

  // 1. Parse `git worktree list --porcelain`
  const wtOutput = deps.git
    ? deps.git(["worktree", "list", "--porcelain"], repoRoot)
    : git(["worktree", "list", "--porcelain"], repoRoot);

  // 2. Read events.ndjson for cycle context
  const eventsPath = join(repoRoot, ".roll", "loop", "events.ndjson");
  const cycles = readCycleContext(eventsPath, deps);

  // 3. Parse worktree entries
  interface RawWorktree { path: string; head: string; branch: string; }
  const entries: RawWorktree[] = [];
  let current: Partial<RawWorktree> = {};

  for (const line of wtOutput.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? "" });
      current = { path: line.slice(9).trim() };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim();
    } else if (line === "") {
      if (current.path) {
        entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? "" });
        current = {};
      }
    }
  }
  if (current.path) {
    entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? "" });
  }

  // 4. Build records
  const records: WorktreeAuditRecord[] = [];

  for (const entry of entries) {
    const absPath = resolve(entry.path);
    const owned = workspaceOwnership.get(realpathSafe(absPath));
    const owner = owned === undefined ? classifyOwner(absPath, repoRoot) : "workspace";

    let cycleId: string | undefined;
    let storyId: string | undefined;
    let outcome: string | undefined;

    if (owner === "loop") {
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
    const active = owned?.active ?? isActiveCycle(cycleId, repoRoot, deps);
    const actualBranch = entry.branch.replace(/^refs\/heads\//, "") || null;
    const ownershipState = owned === undefined || owned.expectedBranch === actualBranch
      ? "verified"
      : "mismatch";

    const baseRec: WorktreeAuditRecord = {
      path: absPath,
      branch: entry.branch || undefined,
      head: entry.head || undefined,
      owner,
      ...(owned === undefined ? {} : {
        workspaceId: owned.workspaceId,
        repoId: owned.repoId,
        repositoryAlias: owned.repositoryAlias,
        cachePath: owned.cachePath,
        deliveryProof: owned.deliveryProof,
        ownershipState,
      }),
      cycleId,
      storyId: owned?.storyId ?? storyId,
      outcome,
      dirtyTracked: dirty.dirtyTracked,
      dirtyUntracked: dirty.dirtyUntracked,
      ahead,
      mergeEvidence,
      active,
      disposition: "preserved_needs_review",
      reason: "",
    };

    const disp = classifyDisposition(baseRec);
    baseRec.disposition = disp.disposition;
    baseRec.reason = disp.reason;

    records.push(baseRec);
  }

  // 4a. FIX-1460 (#1468): scan `.roll/loop/worktrees` on disk for ORPHAN dirs —
  // present on disk but absent from `git worktree list` above. These are what the
  // runtime canary counts, so surfacing them here keeps the two counters in sync
  // and stops the leak (a deregistered dir that pauses the loop but is invisible
  // to cleanup). Fail-closed: only a dir whose owning cycle is provably delivered
  // is reclaimable; every other orphan is preserved + surfaced.
  // Dedup by realpath — `git worktree list` returns realpath'd paths while the
  // scan joins onto repoRoot; a symlinked prefix (e.g. macOS /tmp→/private/tmp)
  // must not make a registered worktree look like an orphan (double-count).
  const registeredLoopPaths = new Set(records.map((r) => realpathSafe(resolve(r.path))));
  for (const orphan of scanOrphanLoopWorktrees(repoRoot, registeredLoopPaths, cycles, deps)) {
    records.push(orphan);
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
    // A git hiccup while listing branches must not topple the audit — the
    // canary/cleanup surface simply sees zero enumerated branches.
    ephemeralBranches = [];
  }

  // 5. Summary
  const summary = {
    total: records.length,
    loop: records.filter((r) => r.owner === "loop").length,
    ...(records.some((r) => r.owner === "workspace")
      ? { workspace: records.filter((r) => r.owner === "workspace").length }
      : {}),
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
  };
}

// ─── human output ───────────────────────────────────────────────────────────

function renderHuman(output: WorktreeAuditOutput): string {
  const lines: string[] = ["Worktree audit", ""];

  lines.push(`  total: ${output.summary.total}`);
  lines.push(`  loop: ${output.summary.loop}`);
  if ((output.summary.workspace ?? 0) > 0) lines.push(`  workspace: ${output.summary.workspace}`);
  lines.push(`  manual: ${output.summary.manual}`);
  if (output.summary.external > 0) lines.push(`  external: ${output.summary.external}`);
  lines.push(`  active: ${output.summary.active}`);
  lines.push(`  disposable candidates: ${output.summary.disposableCandidates}`);
  lines.push(`  preserved: ${output.summary.preserved}`);
  lines.push(`  ephemeral branches: ${output.summary.ephemeralBranches}`);
  lines.push("");

  if (output.ephemeralBranches.length > 0) {
    lines.push("ephemeral branches (canary-counted)");
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
  "Usage: roll worktree audit [--json] [--workspace <id|path> | --repo <path>]\n" +
  "  Read-only audit of Workspace Issue worktrees or historical repo-local worktrees.\n" +
  "  Classifies ownership, dirt, merge evidence, and disposition.\n" +
  "  --json    print schema-1 JSON output\n" +
  "  --workspace resolve Issue ownership through the Workspace registry\n" +
  "  --repo    explicit historical repo-local/migration input (default: current directory)\n";

export function worktreeAuditCommand(args: string[], deps?: Partial<WorktreeAuditDeps>): number {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
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
