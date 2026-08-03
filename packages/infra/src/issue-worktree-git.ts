import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.js";

export type IssueWorktreeIdentityState = "absent" | "compatible" | "conflict";

export interface IssueWorktreeIdentity {
  readonly state: IssueWorktreeIdentityState;
  readonly dirty: boolean;
  readonly branch: string | null;
  readonly baseSha: string | null;
}

const ABSENT_IDENTITY: IssueWorktreeIdentity = { state: "absent", dirty: false, branch: null, baseSha: null };
const CONFLICT_IDENTITY: IssueWorktreeIdentity = { state: "conflict", dirty: false, branch: null, baseSha: null };

/** Git introspection for check/preflight paths must not refresh index or
 *  worktree metadata. `--no-optional-locks` is Git's command-line equivalent
 *  of `GIT_OPTIONAL_LOCKS=0`, keeping a read-only probe truly zero-write. */
function inspectGit(args: readonly string[], cwd: string) {
  return git(["--no-optional-locks", ...args], cwd);
}

/** Walk every entry under `root` (excluding `.git`, never descending into it),
 *  applying `apply` depth-first (children before their parent directory) so a
 *  read-only parent never blocks removing write bits from its own children.
 *  A SYMLINK is passed to `apply` but never recursed into — its target may
 *  point anywhere on disk, including outside the worktree entirely. */
function walkProductEntries(root: string, apply: (entryPath: string, stat: Stats) => void): void {
  for (const name of readdirSync(root)) {
    if (name === ".git") continue;
    const entryPath = join(root, name);
    const stat = lstatSync(entryPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) walkProductEntries(entryPath, apply);
    apply(entryPath, stat);
  }
}

/** Collect every non-`.git` entry under `root` (recursing into real
 *  directories only, mirroring {@link walkProductEntries}'s traversal) BEFORE
 *  any mutation happens — used to scan for a disqualifying symlink in one
 *  pass so a later mutating pass either runs in full or not at all. */
function collectProductEntries(root: string): Array<{ readonly path: string; readonly stat: Stats }> {
  const entries: Array<{ readonly path: string; readonly stat: Stats }> = [];
  walkProductEntries(root, (path, stat) => entries.push({ path, stat }));
  return entries;
}

/** Thrown by {@link protectReadOnlyWorktree} when the checkout contains a
 *  tracked symlink — the read-only guarantee cannot be made for it (see the
 *  function's own doc for why), so the checkout must never be exposed. */
export class ReadOnlyWorktreeSymlinkError extends Error {}

/** Deny filesystem writes to every product file/directory in a read-only Issue
 *  worktree checkout — NOT merely a detached HEAD, which only blocks branch
 *  commits and leaves the working tree writable to any normal process. The
 *  worktree ROOT is included (otherwise a new top-level file could still be
 *  created directly under it) — `.git` is never touched. Chmod'ing the root
 *  is only safe because {@link unprotectReadOnlyWorktree} ALWAYS restores
 *  write permission (root first, then every descendant) before
 *  {@link issueWorktreeRemove} calls `git worktree remove`: git needs write
 *  access throughout the tree to unlink it, and a still-protected root left
 *  git unable to complete the removal in testing (worse, it could leave the
 *  worktree half-unregistered) — so protect and unprotect are a matched pair,
 *  never called independently of that ordering.
 *
 *  SYMLINK BOUNDARY — REFUSED, NOT SILENTLY ALLOWED: `chmodSync` follows a
 *  symlink to its target (verified: it changes the TARGET's mode, not the
 *  link's), and Node exposes no portable `lchmod` to change the link itself.
 *  A tracked symlink therefore CANNOT be made read-only by this function —
 *  writing through it would still reach whatever it points to, including a
 *  file outside the checkout entirely. Rather than silently expose a
 *  checkout that LOOKS protected but has a write-through hole, this SCANS
 *  the whole tree for a symlink FIRST and throws
 *  {@link ReadOnlyWorktreeSymlinkError} before a SECOND pass chmods anything
 *  — never a partial chmod followed by a throw (which would leave some
 *  files locked and others not, an inconsistent half-protected state). The
 *  caller must treat the thrown error exactly like any other real
 *  protection failure (roll the target back, never expose it). */
export function protectReadOnlyWorktree(path: string): void {
  const entries = collectProductEntries(path);
  const symlink = entries.find((entry) => entry.stat.isSymbolicLink());
  if (symlink !== undefined) {
    throw new ReadOnlyWorktreeSymlinkError(`read-only checkout contains a tracked symlink at ${symlink.path} — cannot deny writes through it`);
  }
  for (const entry of entries) {
    chmodSync(entry.path, entry.stat.mode & ~0o222);
  }
  const rootStat = statSync(path);
  chmodSync(path, rootStat.mode & ~0o222);
}

/** Restore owner read+write across a previously-protected checkout (root
 *  first, then every descendant) — required before `git worktree remove` can
 *  unlink the tree, and before any repair/reuse can write into it again.
 *  Directories additionally regain the owner EXECUTE bit (needed to traverse
 *  them at all — `readdirSync` requires it, root included, regardless of what
 *  state a directory was actually left in). A REGULAR FILE never gains an
 *  execute bit it did not already have: git tracks a file's executable bit as
 *  part of its tracked mode, so unconditionally adding `0o100` would make an
 *  ordinary tracked file look modified to `git status` and make `git worktree
 *  remove` refuse it as "contains modified or untracked files" even though
 *  its content never changed. Idempotent and safe to call on an unprotected
 *  worktree. Same symlink boundary as {@link protectReadOnlyWorktree}: a
 *  symlinked entry is never chmod'd, since doing so would follow it to its
 *  target. */
export function unprotectReadOnlyWorktree(path: string): void {
  if (!existsSync(path)) return;
  const rootStat = statSync(path);
  chmodSync(path, rootStat.mode | 0o600 | (rootStat.isDirectory() ? 0o100 : 0));
  function restore(root: string): void {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // the directory itself vanished concurrently.
      throw error;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const entryPath = join(root, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entryPath);
      } catch (error) {
        // Real TOCTOU: git itself (worktree remove/branch -D/prune running
        // concurrently, or its own transient lock files like
        // `packed-refs.lock`) can remove an entry between the `readdirSync`
        // snapshot above and this `lstatSync` — that entry no longer needs
        // unprotecting since it no longer exists. Any OTHER error is a real
        // failure and must not be swallowed.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink()) continue;
      chmodSync(entryPath, stat.mode | 0o600 | (stat.isDirectory() ? 0o100 : 0));
      if (stat.isDirectory()) restore(entryPath);
    }
  }
  restore(path);
}

/** True when `branch` already exists as a real ref in this cache. */
export async function branchExists(cachePath: string, branch: string): Promise<boolean> {
  const result = await inspectGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cachePath);
  return result.code === 0;
}

export interface IssueWorktreeAddOptions {
  /** Only a target with a valid Issue-local pin (an existing journal/event
   *  fact for this alias — see {@link resolveExpectedTargetFacts} in
   *  issue-worktrees.ts) may recover an orphan governed branch of the same
   *  name. Defaults to `false`: a brand-new, never-pinned target must never
   *  silently adopt a pre-existing branch just because the name happens to
   *  collide (another Workspace/Story rendering the same pattern, or manual
   *  git use) — it fails loud instead. */
  readonly allowOrphanRecovery?: boolean;
}

export interface IssueWorktreeAddResult {
  /** True when this call itself created `branch` as a brand-new ref (or the
   *  target is a read target / detached, where there is no branch at all).
   *  False when an existing branch was RECOVERED (orphan reuse) — the
   *  caller (applyIssueInit) persists this into the journal so rollback
   *  only ever deletes a branch THIS run actually created, never one it
   *  merely reused from a prior run's orphan. */
  readonly branchCreatedThisRun: boolean;
}

/** Create a REAL git worktree for one Issue repository target. Never touches a
 *  pre-existing path — the caller must have already probed it as absent.
 *  `branch === null` creates a detached worktree (no local branch).
 *
 *  For a write target (`branch !== null`), a NEW branch is created UNLESS
 *  that exact branch name already exists as a real ref (ORPHAN GOVERNED
 *  BRANCH RECOVERY — e.g. an earlier interrupted run created the branch and
 *  a worktree, then the worktree path was deleted by hand without the
 *  branch itself ever being cleaned up). Orphan recovery is REFUSED outright
 *  (fail loud, branch left untouched) unless the caller passes
 *  `options.allowOrphanRecovery: true` — reserved for a target that already
 *  has a valid Issue-local pin; see {@link IssueWorktreeAddOptions}. When
 *  recovery IS allowed, the branch is reused ONLY when `baseSha` is
 *  confirmed an ancestor of the branch's real current tip (so a
 *  diverged/unrelated branch of the same name is refused, never silently
 *  adopted) — checking out its ACTUAL tip, which may already hold later real
 *  story commits made before the interruption. Git's own
 *  one-worktree-per-branch guard naturally refuses the reuse if that branch
 *  is already checked out somewhere else; this function does not re-derive
 *  that check itself.
 *
 *  Deliberately does NOT apply read-only filesystem protection itself —
 *  the CALLER must record the target as created (journal) BEFORE calling
 *  {@link protectReadOnlyWorktree} separately, so a protection failure can
 *  never leave a real, ungoverned worktree the journal doesn't know to roll
 *  back (see applyIssueInit). */
export async function issueWorktreeAdd(
  cachePath: string,
  path: string,
  baseSha: string,
  branch: string | null,
  options: IssueWorktreeAddOptions = {},
): Promise<IssueWorktreeAddResult> {
  if (existsSync(path)) {
    throw new Error(`refusing to create an Issue worktree over a pre-existing path: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  // Clear STALE worktree admin metadata a prior run left behind (e.g. the
  // worktree directory was deleted by hand rather than via `worktree
  // remove`) — prune only ever drops registrations already missing on disk,
  // never a live worktree, so this is always safe before `worktree add`.
  await git(["worktree", "prune"], cachePath);

  if (branch !== null && await branchExists(cachePath, branch)) {
    if (options.allowOrphanRecovery !== true) {
      throw new Error(
        `refusing to reuse pre-existing branch "${branch}" for ${path}: this target has no valid Issue-local pin, so orphan recovery is not permitted — a brand-new target must never silently adopt a pre-existing branch`,
      );
    }
    const ancestor = await git(["merge-base", "--is-ancestor", baseSha, branch], cachePath);
    if (ancestor.code !== 0) {
      throw new Error(
        `refusing to recover orphan governed branch "${branch}" for ${path}: its current tip does not have the pinned base ${baseSha} as an ancestor (diverged history)`,
      );
    }
    // Reuse the existing branch at its REAL current tip — git's own
    // one-worktree-per-branch guard is what actually refuses this if the
    // branch is checked out elsewhere; no separate check is duplicated here.
    const reuse = await git(["worktree", "add", path, branch], cachePath);
    if (reuse.code !== 0) {
      throw new Error(`git worktree add (orphan branch recovery) failed for ${path}: ${reuse.stderr || reuse.stdout}`);
    }
    return { branchCreatedThisRun: false };
  }

  const args = branch === null
    ? ["worktree", "add", "--detach", path, baseSha]
    : ["worktree", "add", "-b", branch, path, baseSha];
  const result = await git(args, cachePath);
  if (result.code !== 0) {
    throw new Error(`git worktree add failed for ${path}: ${result.stderr || result.stdout}`);
  }
  return { branchCreatedThisRun: branch !== null };
}

/** Parse `git worktree list --porcelain` into path → absolute worktree path set. */
function worktreeListPaths(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length).trim());
  }
  return paths;
}

/** Branches reserved by registrations that `git worktree prune` will retain.
 *  Only an explicit `prunable` marker is recoverable; a missing but locked
 *  registration still owns its branch and must remain a conflict. */
function worktreeListActiveBranches(porcelain: string): Set<string> {
  const branches = new Set<string>();
  const prefix = "refs/heads/";
  for (const block of porcelain.split("\0\0")) {
    const lines = block.split("\0");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    const branchLine = lines.find((line) => line.startsWith("branch "));
    if (worktreeLine === undefined || branchLine === undefined) continue;
    if (lines.some((line) => line.startsWith("prunable"))) continue;
    const ref = branchLine.slice("branch ".length).trim();
    if (ref.startsWith(prefix)) branches.add(ref.slice(prefix.length));
  }
  return branches;
}

export type GovernedBranchState = "absent" | "recoverable" | "conflict";

/** Inspect a write target's governed branch without mutating the shared cache. */
export async function inspectGovernedBranchState(cachePath: string, branch: string, baseSha: string): Promise<GovernedBranchState> {
  if (!await branchExists(cachePath, branch)) return "absent";
  const list = await inspectGit(["worktree", "list", "--porcelain", "-z"], cachePath);
  if (list.code !== 0) return "conflict";
  if (worktreeListActiveBranches(list.stdout).has(branch)) return "conflict";
  const ancestor = await inspectGit(["merge-base", "--is-ancestor", baseSha, branch], cachePath);
  return ancestor.code === 0 ? "recoverable" : "conflict";
}

/** Probe the REAL git identity of a path claiming to be an Issue worktree:
 *  is it actually registered as a worktree of `expectedCachePath`, what is its
 *  HEAD/branch, and does it have uncommitted changes. Read-only — no writes. */
export async function issueWorktreeIdentity(path: string, expectedCachePath: string): Promise<IssueWorktreeIdentity> {
  if (!existsSync(path)) return ABSENT_IDENTITY;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return ABSENT_IDENTITY;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return CONFLICT_IDENTITY;

  const commonDir = await inspectGit(["rev-parse", "--git-common-dir"], path);
  if (commonDir.code !== 0) return CONFLICT_IDENTITY;

  const list = await inspectGit(["worktree", "list", "--porcelain"], expectedCachePath);
  if (list.code !== 0) return CONFLICT_IDENTITY;
  const registered = worktreeListPaths(list.stdout);
  const canonicalPath = realpathSync(path);
  const isRegisteredHere = [...registered].some((registeredPath) => registeredPath === canonicalPath);
  if (!isRegisteredHere) return CONFLICT_IDENTITY;

  const head = await inspectGit(["rev-parse", "HEAD"], path);
  if (head.code !== 0) return CONFLICT_IDENTITY;
  const branchResult = await inspectGit(["symbolic-ref", "-q", "--short", "HEAD"], path);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;

  const status = await inspectGit(["status", "--porcelain"], path);
  const dirty = status.code !== 0 || status.stdout.trim() !== "";

  return { state: "compatible", dirty, branch: branch === "" ? null : branch, baseSha: head.stdout.trim() };
}

export interface ExpectedWorktreeFacts {
  readonly access: "read" | "write";
  /** The exact governed Story branch for a write target; null for a read
   *  target (must be detached). */
  readonly workBranch: string | null;
  /** The Issue-pinned immutable base SHA — NEVER the shared cache's current
   *  `refs/remotes/origin/<branch>`, which can advance independently of any
   *  one Issue (another Workspace sharing the same machine cache can refresh
   *  it at any time). Null means the pinned base itself is unavailable
   *  (e.g. its object is missing from the cache) — compatibility can never
   *  be claimed in that case. */
  readonly baseSha: string | null;
}

/** Compare a real worktree's ACTUAL identity against what THIS Issue target
 *  expects, per the corrected compatibility contract:
 *   - READ target: branch must be detached (null) AND HEAD must equal the
 *     pinned base EXACTLY.
 *   - WRITE target: branch must equal the expected governed branch EXACTLY
 *     AND the pinned base must be an ancestor of HEAD (HEAD may equal the
 *     base or contain later story commits — that's the whole point of a
 *     write target). A diverged/unrelated HEAD (base NOT an ancestor) is a
 *     conflict, never silently reused.
 *  A `null` expected baseSha (pinned base unavailable) can never be
 *  compatible — this function reports conflict rather than let a caller
 *  guess from a shared, mutable ref. Never mutates anything — pure git
 *  introspection (`merge-base --is-ancestor`) plus the pre-computed identity. */
export async function checkWorktreeCompatibility(
  identity: IssueWorktreeIdentity,
  expectedCachePath: string,
  expected: ExpectedWorktreeFacts,
): Promise<boolean> {
  if (identity.state !== "compatible") return false;
  if (expected.baseSha === null) return false;
  if (expected.access === "read") {
    return identity.branch === null && identity.baseSha === expected.baseSha;
  }
  if (identity.branch !== expected.workBranch) return false;
  if (identity.baseSha === expected.baseSha) return true;
  const ancestor = await inspectGit(["merge-base", "--is-ancestor", expected.baseSha, identity.baseSha ?? ""], expectedCachePath);
  return ancestor.code === 0;
}

export interface IssueWorktreeRemoveOptions {
  /** Set when the target being removed is a READ (protected) target — if
   *  `git worktree remove` genuinely fails, the worktree is PRESERVED, and
   *  since {@link unprotectReadOnlyWorktree} already ran to give git the
   *  write access it needs, that preserved target must be re-protected
   *  before this function returns; otherwise a "preserved" read target would
   *  silently end up fully writable. */
  readonly readOnly?: boolean;
}

/** Remove a worktree via `git worktree remove` — refuses (git's own guard) if
 *  the worktree has uncommitted changes. Never a blind `rm -rf`: the caller's
 *  clean/dirty decision is enforced by git itself, not re-derived here.
 *  Restores any read-only write-protection FIRST — `git worktree remove` must
 *  unlink every entry itself, which requires write permission throughout the
 *  tree; a still-protected checkout would make git fail (or, worse, abort
 *  with the worktree left half-registered), never a clean removal. */
export async function issueWorktreeRemove(cachePath: string, path: string, options: IssueWorktreeRemoveOptions = {}): Promise<void> {
  unprotectReadOnlyWorktree(path);
  const result = await git(["worktree", "remove", path], cachePath);
  if (result.code !== 0) {
    if (options.readOnly === true && existsSync(path)) protectReadOnlyWorktree(path);
    throw new Error(`git worktree remove refused for ${path}: ${result.stderr || result.stdout}`);
  }
}
