/**
 * Git module — TS I/O adapters mirroring the git operations the v2 loop performs
 * (US-INFRA-002).
 *
 * ─── v2 oracle (frozen bash, bin/roll) ──────────────────────────────────────
 *   worktree helpers (12758-12810):
 *     - `_worktree_create  path branch base` 12762-12773
 *         mkdir parent; if path exists → `git worktree remove --force` + rm -rf;
 *         if branch ref exists → `git branch -D` (FIX-114: a branch left by a
 *         prior failed run, or one checked out elsewhere, would make
 *         `worktree add -b` error — delete it first); then
 *         `git worktree add <path> -b <branch> <base>`.
 *     - `_worktree_cleanup path branch` 12779-12785
 *         `git worktree remove --force` (tolerant) + rm -rf + `git branch -D`
 *         (tolerant); always returns 0 so retry / rollback is safe.
 *     - `_worktree_fetch_origin branch` 12791-12798
 *         `git fetch origin <branch> --quiet`; lenient — returns 0 even on
 *         failure (network blips must not derail the loop).
 *     - `_worktree_submodule_init path` 12806-12809
 *         `( cd <path> && git submodule update --init --recursive --quiet )`.
 *     - `_worktree_merge_back branch` 12895+
 *         `git pull --ff-only origin main --quiet`,
 *         `git merge --ff-only <branch>`, `git push origin main`.
 *   slug path canonicalization preamble inside `_project_slug` (6949-7026):
 *     - FIX-056: on Darwin, `realpath <path>` (case-normalize symlink-resolve).
 *     - FIX-034: `git -C <path> rev-parse --git-common-dir`; if it ends in
 *       `/.git`, the project is `${common%/.git}` (worktree → main tree).
 *     - remote: `git -C <path> remote get-url origin`, else first
 *       `git -C <path> remote | head -1` → `remote get-url <first>`.
 *
 * ─── Lib choice: raw `git` via execFile, NOT simple-git ─────────────────────
 * The card suggests simple-git. REJECTED for behavioral fidelity: the oracle is
 * literal `git` CLI invocations with a precise, observable flag set (e.g.
 * `worktree add -b`, `--ff-only`, `remove --force`). Driving git through
 * `execFile("git", [...])` keeps byte-parity with those invocations, keeps the
 * cited flag sets auditable line-for-line, and adds ZERO runtime dependencies.
 * simple-git would interpose its own argument synthesis and error semantics,
 * risking silent drift from the oracle. This divergence is deliberate.
 *
 * All wrappers are thin: they shell out and surface git's exit status. Lenient
 * wrappers (mirroring bash `|| true` paths) swallow failures exactly where the
 * oracle does, and say so.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  isImmutableGitObjectId,
  isSafeGitRef,
  type ProjectIdentityInputs,
  projectSlug,
  type ToolDeclaration,
  type ToolInvocation,
  type ToolResult,
} from "@roll/spec";
import { invokeInfraTool } from "./tools/delegation.js";
import { configResolve, projectConfigPath } from "./config.js";

/**
 * E1: the historical hardcoded integration branch. Kept as the default for every
 * integration-branch parameter so unset config = byte-identical prior behavior.
 */
export const DEFAULT_INTEGRATION_BRANCH = "origin/main";

/**
 * E6 — run `git <args>` in `cwd` SYNCHRONOUSLY, returning trimmed stdout, or
 * `undefined` on ANY failure (non-zero exit, missing git, not a repo). Used only
 * by the smart-default probes below, which stay synchronous to preserve the
 * resolvers' sync signatures (every caller reads them synchronously). Failure is
 * never fatal — a probe miss simply falls the resolver back to its historical
 * default, so a non-git dir / detached HEAD / old git can only ever DEGRADE to
 * the prior behavior, never break.
 */
function gitProbe(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * E6 — is `projectRoot` in a SUBMODULE CONTEXT? True when EITHER holds:
 *   - it is a submodule SUPERPROJECT — a `.gitmodules` file exists at its root
 *     (it embeds one or more submodules); OR
 *   - it is ITSELF a submodule checkout — `git -C <root> rev-parse
 *     --show-superproject-working-tree` prints a non-empty path (git only emits
 *     that for a working tree nested inside a superproject).
 *
 * A plain repo (no `.gitmodules`, not nested in a superproject) is NEITHER, so
 * the smart defaults never fire for it — the zero-regression guarantee. Detection
 * is git-native and failure-tolerant (a missing git / non-repo returns false).
 */
function inSubmoduleContext(projectRoot: string): boolean {
  if (existsSync(join(projectRoot, ".gitmodules"))) return true;
  const superWorkingTree = gitProbe(projectRoot, [
    "rev-parse",
    "--show-superproject-working-tree",
  ]);
  return superWorkingTree !== undefined && superWorkingTree !== "";
}

/**
 * E6 — the current branch of `projectRoot`, or `undefined` when it is DETACHED
 * (git prints the literal `HEAD`) or the probe fails. `--abbrev-ref HEAD` is the
 * same query {@link currentBranch} uses; the detached sentinel `HEAD` is mapped
 * to `undefined` so the caller falls back rather than adopting a bogus ref.
 */
function currentBranchSync(projectRoot: string): string | undefined {
  const branch = gitProbe(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch !== undefined && branch !== "" && branch !== "HEAD" ? branch : undefined;
}

/**
 * E1: resolve the loop's integration branch — the ref cycles rebase/merge/reset
 * onto. Reads the project-scope `integration_branch` config key (default
 * `origin/main`). The registry key is relative-path-based
 * ({@link projectConfigPath} → `.roll/local.yaml`); pass `projectRoot` to read a
 * specific project tree's config, mirroring how repo-visibility joins its
 * `projectCwd` with the local config path. A missing key / file falls back to
 * {@link DEFAULT_INTEGRATION_BRANCH}, so callers never observe an empty ref.
 *
 * E6 — SMART SUBMODULE DEFAULT: when `integration_branch` is UNSET (the config
 * resolves from the `default` layer) AND `projectRoot` is in a submodule context
 * ({@link inSubmoduleContext}) AND it is on a branch (not detached), the default
 * becomes that CURRENT branch instead of `origin/main`. This makes a submodule
 * superproject (e.g. contractor-2.0 on `contractor2.0`) and each of its submodules
 * (each on its own working branch) self-configure their integration branch with
 * ZERO config — the runner already calls this with the submodule path (E2/E4/E5).
 * An EXPLICIT config value still wins (precedence unbroken), and a plain repo is
 * untouched (falls straight through to `origin/main`). Detection is pure resolver
 * logic — it writes NO files.
 *
 * @param projectRoot absolute path to the project tree whose `.roll/local.yaml`
 *                    should be read. Omitted → the cwd-relative default path
 *                    (matches the other cwd-relative config readers).
 */
export function resolveIntegrationBranch(projectRoot?: string): string {
  const project =
    projectRoot === undefined ? projectConfigPath() : join(projectRoot, projectConfigPath());
  const resolved = configResolve("integration_branch", { project });
  const value = resolved?.[0]?.trim();
  const source = resolved?.[1];
  // Explicit config (any layer other than the registry default) always wins.
  if (source !== undefined && source !== "default" && value !== undefined && value !== "") {
    return value;
  }
  // Unset → try the submodule smart default before the historical fallback.
  const root = projectRoot ?? process.cwd();
  if (inSubmoduleContext(root)) {
    const branch = currentBranchSync(root);
    if (branch !== undefined) return branch;
  }
  return value !== undefined && value !== "" ? value : DEFAULT_INTEGRATION_BRANCH;
}

/** E3: the delivery publish mode vocabulary. `remote` (default) = push→PR→CI→
 *  merge; `local` = land on the local integration branch, no remote at all. */
export type PublishMode = "remote" | "local";

/** E3: the default publish mode — `remote`, so an unset config observes the
 *  existing push/PR/merge delivery byte-for-byte (zero regression). */
export const DEFAULT_PUBLISH_MODE: PublishMode = "remote";

/**
 * E3: resolve the project's delivery publish mode from the project-scope
 * `publish_mode` config key (default `remote`). Mirrors
 * {@link resolveIntegrationBranch}'s project-root handling. Any value other than
 * the exact `local` (the only non-default the validator admits) resolves to
 * `remote` — a corrupt/hand-edited file can never silently disable remote
 * delivery; it can only fall back to the safe default.
 *
 * E6 — SMART SUBMODULE DEFAULT: when `publish_mode` is UNSET (resolved from the
 * `default` layer) AND `projectRoot` is in a submodule context
 * ({@link inSubmoduleContext}), the default becomes `local`. Remote submodule
 * delivery (push→PR→CI against a submodule) is not implemented, so `local` (land
 * the cycle on the submodule's local integration branch) is the ONLY working mode
 * there — defaulting to it makes a submodule superproject deliver with zero config.
 * An EXPLICIT `remote` still wins, and a plain repo is untouched (defaults to
 * `remote`, byte-identical). Writes NO files.
 *
 * @param projectRoot absolute path to the project tree whose `.roll/local.yaml`
 *                    should be read. Omitted → the cwd-relative default path.
 */
export function resolvePublishMode(projectRoot?: string): PublishMode {
  const project =
    projectRoot === undefined ? projectConfigPath() : join(projectRoot, projectConfigPath());
  const resolved = configResolve("publish_mode", { project });
  const value = resolved?.[0]?.trim();
  const source = resolved?.[1];
  // Explicit config always wins (any value other than `local` → `remote`).
  if (source !== undefined && source !== "default") {
    return value === "local" ? "local" : DEFAULT_PUBLISH_MODE;
  }
  // Unset → a submodule superproject / submodule checkout defaults to local.
  const root = projectRoot ?? process.cwd();
  if (inSubmoduleContext(root)) return "local";
  return DEFAULT_PUBLISH_MODE;
}

/** Result of a raw git invocation. */
export interface GitResult {
  /** Process exit code (0 = success). */
  code: number;
  stdout: string;
  stderr: string;
  /** Present when Node terminated the process after the configured timeout. */
  readonly timedOut?: boolean;
  /** PID of a timed-out Git child, retained for termination evidence. */
  readonly pid?: number;
  /** Termination signal reported by Node for a failed Git child. */
  readonly signal?: string;
}

/** Result of an argv-only raw Git invocation whose stdout must remain byte exact. */
export interface GitBinaryResult {
  /** Process exit code (0 = success). */
  code: number;
  stdout: Uint8Array;
  stderr: string;
  /** Present when Node terminated the process after the configured timeout. */
  readonly timedOut?: boolean;
  /** PID of a timed-out Git child, retained for termination evidence. */
  readonly pid?: number;
  /** Termination signal reported by Node for a failed Git child. */
  readonly signal?: string;
}

export interface GitExecutionOptions {
  /** Maximum wall-clock time before the Git child is terminated. */
  readonly timeoutMs?: number;
  /** Narrow environment overrides for one Git invocation. */
  readonly env?: Readonly<Record<string, string>>;
}

/** True only for a full, lowercase-hex Git object id — NEVER a ref name, a
 *  short/abbreviated SHA, or any other rev-parse-able expression. This is the
 *  ONE shared gate for every "immutable baseSha" this codebase persists or
 *  trusts from a prior run: `git cat-file -e <value>^{commit}` alone is NOT
 *  sufficient, because git happily RESOLVES a ref-like string (`HEAD`,
 *  `refs/remotes/origin/main`, a branch name, even a short SHA) to a real
 *  commit and reports success — it does not distinguish "you gave me an
 *  immutable id" from "you gave me something I resolved for you". A pinned
 *  base recorded as `HEAD` or a branch ref would silently drift out from
 *  under an Issue every time that ref moves, defeating the entire pinning
 *  contract. Checking the STRING shape first, independent of and prior to any
 *  git call, is what actually enforces immutability. */
export { isImmutableGitObjectId } from "@roll/spec";

/**
 * Run `git <args>` in `cwd`. Never throws on non-zero exit — returns the code
 * + captured streams so callers can mirror bash's explicit exit-code handling
 * (`if git ...; then` / `|| true`). A spawn failure is also represented as
 * code 1, preserving the existing adapter contract for missing cwd/binary cases.
 */
export async function rawGit(
  args: readonly string[],
  cwd?: string,
  options: GitExecutionOptions = {},
): Promise<GitResult> {
  return new Promise<GitResult>((resolveGit) => {
    let pid: number | undefined;
    const child = execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveGit({ code: 0, stdout, stderr });
        return;
      }
      const err = error as NodeJS.ErrnoException & {
        readonly killed?: boolean;
        readonly signal?: string;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      const timedOut = err.killed === true && err.signal === "SIGTERM";
      const detail = {
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(timedOut && pid !== undefined ? { pid } : {}),
        ...(err.signal === undefined ? {} : { signal: err.signal }),
      };
      resolveGit({
        code: typeof err.code === "number" ? err.code : 1,
        stdout,
        stderr,
        ...detail,
      });
    });
    pid = child.pid;
  });
}

/**
 * Run `git <args>` without a shell and preserve stdout as the exact bytes Git
 * emitted. This is intentionally separate from {@link rawGit}: blob consumers
 * must validate UTF-8 before any decoding or digest/byte accounting occurs.
 */
export async function rawGitBinary(
  args: readonly string[],
  cwd?: string,
  options: GitExecutionOptions = {},
): Promise<GitBinaryResult> {
  return new Promise<GitBinaryResult>((resolveGit) => {
    let pid: number | undefined;
    const child = execFile("git", [...args], {
      cwd,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    }, (error, stdout, stderr) => {
      const stdoutBytes = new Uint8Array(stdout);
      const stderrText = stderr.toString("utf8");
      if (error === null) {
        resolveGit({ code: 0, stdout: stdoutBytes, stderr: stderrText });
        return;
      }
      const err = error as NodeJS.ErrnoException & {
        readonly killed?: boolean;
        readonly signal?: string;
      };
      const timedOut = err.killed === true && err.signal === "SIGTERM";
      const detail = {
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(timedOut && pid !== undefined ? { pid } : {}),
        ...(err.signal === undefined ? {} : { signal: err.signal }),
      };
      resolveGit({
        code: typeof err.code === "number" ? err.code : 1,
        stdout: stdoutBytes,
        stderr: stderrText,
        ...detail,
      });
    });
    pid = child.pid;
  });
}

const GIT_RAW_DECLARATION: ToolDeclaration = {
  id: "git.raw" as ToolDeclaration["id"],
  kind: "git",
  title: "Git Raw",
  description: "Run arbitrary git argv through the infra tool delegation seam.",
  defaults: { enabled: true, timeoutMs: 60_000 },
  requirements: [{ kind: "executable", name: "git", optional: false }],
};

const GIT_COMMIT_DECLARATION: ToolDeclaration = {
  id: "git.commit" as ToolDeclaration["id"],
  kind: "git",
  title: "Git Commit",
  description: "Commit staged changes through the infra tool delegation seam.",
  emitsEvents: true,
  defaults: { enabled: true, timeoutMs: 60_000 },
  requirements: [{ kind: "executable", name: "git", optional: false }],
};

const GIT_PUSH_DECLARATION: ToolDeclaration = {
  id: "git.push" as ToolDeclaration["id"],
  kind: "git",
  title: "Git Push",
  description: "Push a branch through the infra tool delegation seam.",
  emitsEvents: true,
  defaults: { enabled: true, timeoutMs: 60_000 },
  requirements: [{ kind: "executable", name: "git", optional: false }],
};

/**
 * Run `git <args>` through the infra tool delegation seam. This preserves the
 * old return shape while adding tool events for callers that set
 * ROLL_TOOL_EVENTS_PATH or ROLL_PROJECT_RUNTIME_DIR.
 */
export async function git(
  args: readonly string[],
  cwd?: string,
  options: GitExecutionOptions = {},
): Promise<GitResult> {
  const result = await invokeInfraTool<GitRawInput, GitResult>({
    declaration: GIT_RAW_DECLARATION,
    input: { args: [...args], cwd },
    // Legacy repository lifecycle helper; Agent-facing GitTool is repository-scoped.
    scope: "machine_only",
    ...(options.timeoutMs === undefined ? {} : { policy: { timeoutMs: options.timeoutMs } }),
    run: async (invocation) => ok(
      invocation,
      await rawGit(invocation.input.args, invocation.input.cwd, {
        timeoutMs: invocation.policy.timeoutMs,
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
    ),
  });
  if (result.ok) return result.output;
  throw new Error(result.error.message);
}

// ─── worktree lifecycle ──────────────────────────────────────────────────────

/**
 * Create the cycle worktree DETACHED (US-LOOP-094).
 *
 * Steps:
 *   1. `mkdir -p $(dirname path)`.
 *   2. if `path` exists on disk → `git worktree remove --force path` (lenient)
 *      then `rm -rf path` (lenient).
 *   3. `git worktree add --detach <path> <base>` — STRICT: the one step whose
 *      failure the caller propagates. NO local branch is created.
 *
 * Why detached: a named local `loop/cycle-*` branch used to be created here
 * (`-b <branch>`), and it only ever got deleted on the clean worktree-teardown
 * path — so every crashed/timed-out cycle leaked one (retro audit: 289 local
 * branches accumulated). The cycle now commits on a detached HEAD and publishes
 * by pushing HEAD to the remote ref `refs/heads/<branch>` (see terminal-handlers
 * `publish_pr` / `push_orphan`), so `<branch>` exists ONLY on origin. The
 * former FIX-114 same-branch pre-clean is gone with the branch it guarded.
 *
 * @param repoCwd  the main tree to run git in (worktree commands are tree-rel).
 * @param branch   retained as the intended REMOTE ref name for callers; not
 *                 used to create any local branch here.
 */
export async function worktreeAdd(
  repoCwd: string,
  path: string,
  branch: string,
  base: string,
  exists: (p: string) => boolean = defaultExists,
): Promise<GitResult> {
  mkdirSync(dirname(path), { recursive: true });
  // US-LOOP-096: clear stale worktree admin metadata a crashed prior cycle left
  // behind (git's default prune expiry is 3 months) BEFORE creating this one.
  await git(["worktree", "prune", "--expire", "now"], repoCwd); // lenient
  if (exists(path)) {
    await git(["worktree", "remove", "--force", path], repoCwd); // lenient
    rmSyncQuiet(path);
  }
  const result = await git(["worktree", "add", "--detach", path, base], repoCwd);
  // FIX-1231: enable extensions.worktreeConfig on the new worktree so
  // `git config core.worktree` writes land in the worktree-specific config
  // file, not the shared .git/config. Best-effort: failures here must never
  // topple the worktree creation — the agent-spawn layer also isolates codex.
  if (result.code === 0) {
    try {
      await git(["config", "extensions.worktreeConfig", "true"], path);
    } catch {
      /* best-effort defense-in-depth */
    }
  }
  return result;
}

/**
 * Mirror `_worktree_cleanup path branch` (bin/roll 12779-12785). Tolerant of a
 * missing worktree / branch (every step `|| true`); always reports success.
 * Returns the streams of the `worktree remove` for diagnostics, but `code` is
 * forced to 0 to match the oracle's `return 0`.
 */
/**
 * US-LOOP-095/097: the absolute path of a quarantine bundle for a leaked/unpushed
 * ref, under the repo's loop-gc retention dir (`.roll/loop/quarantine`). `stem`
 * is sanitized to a safe filename. Single source of truth for the quarantine
 * location + name convention (shared by worktreeRemove and rescueLeakedMain).
 */
export function quarantineBundlePath(repoCwd: string, stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(repoCwd, ".roll", "loop", "quarantine", `${safe}.bundle`);
}

export async function worktreeRemove(
  repoCwd: string,
  path: string,
  branch: string,
  bundleUnpushed = true,
): Promise<GitResult> {
  // US-LOOP-095: the cycle worktree is DETACHED (US-LOOP-094) — its commits are
  // pinned ONLY by the worktree HEAD, so removing the worktree would make any
  // UNPUSHED work unreachable (no branch holds it). Before removing, if HEAD has
  // commits not on any remote-tracking ref, save them to a quarantine bundle so
  // "push failed / crashed / swept" never loses work. Recover with
  // `git bundle unbundle <f>` / `git fetch <f> <sha>`. The bundle lives under the
  // existing file-retention dir (loop_gc) — no branch pollution. Callers pass
  // bundleUnpushed=false on paths where the work is already on the remote
  // (published/orphan) to avoid noise (AC3).
  if (bundleUnpushed) {
    const unpushed = await git(["rev-list", "HEAD", "--not", "--remotes"], path); // in-worktree
    if (unpushed.code === 0 && unpushed.stdout.trim() !== "") {
      const bundlePath = quarantineBundlePath(repoCwd, `leaked-${branch}`);
      mkdirSync(dirname(bundlePath), { recursive: true });
      await git(["bundle", "create", bundlePath, "HEAD"], path); // absolute path — cwd is about to be removed
    }
  }
  const r = await git(["worktree", "remove", "--force", path], repoCwd); // lenient
  rmSyncQuiet(path);
  // US-LOOP-095: reclaim the worktree admin metadata immediately (git's default
  // prune expiry is 3 months). No `git branch -D` — detached, there is no branch.
  await git(["worktree", "prune", "--expire", "now"], repoCwd); // lenient
  return { code: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Mirror `_worktree_fetch_origin branch` (bin/roll 12791-12798).
 * `git fetch origin <branch> --quiet`. LENIENT: returns 0 even on failure (a
 * missing remote / network blip must not derail the loop). The `fetched` flag
 * reports the underlying outcome without changing the lenient return.
 */
export async function worktreeFetchOrigin(
  repoCwd: string,
  branch: string,
): Promise<{ code: 0; fetched: boolean }> {
  const r = await git(["fetch", "origin", branch, "--quiet"], repoCwd);
  return { code: 0, fetched: r.code === 0 };
}

/**
 * Mirror `_worktree_submodule_init path` (bin/roll 12806-12809):
 * `( cd <path> && git submodule update --init --recursive --quiet )`. Returns
 * submodule update's exit code (the oracle propagates it).
 */
export async function worktreeSubmoduleInit(worktreePath: string): Promise<GitResult> {
  return git(["submodule", "update", "--init", "--recursive", "--quiet"], worktreePath);
}

// ─── E2: submodule-aware worktree (worktree OF a git submodule) ───────────────

/**
 * E2 — the on-disk path of the submodule cycle worktree. The runner hands the
 * worktree layer ONE canonical cycle path (`.roll/loop/cycle-<id>`); a submodule
 * cycle checks the SUBMODULE out in a SIBLING directory of that cycle path:
 * `<dirname(cycle)>/<basename(cycle)>.submodules/<submoduleName>` (e.g.
 * `.roll/loop/worktrees/cycle-XXX.submodules/dukang-service-online`).
 *
 * Three consumers derive the SAME path from the SAME two inputs — create
 * (`worktreeAddInSubmodule` / `create_worktree`), land (E3 local-publish
 * `resolveLandingTarget`) and execute (E4 `resolveExecutionCwd`) — so no site
 * ever has to guess where the submodule worktree lives; changing this ONE formula
 * moves all three in lock-step.
 *
 * E5 (real-pilot fix) — this used to be `join(cycleWorktreePath, submoduleName)`,
 * a SUBDIRECTORY of the cycle worktree. But when the cycle worktree is itself a
 * checkout of the SUPERPROJECT, `<cycle>/<submoduleName>` is exactly the
 * superproject worktree's OWN submodule mount point — so `git worktree add` to
 * that path collides with the already-present (gitlink) mount. Moving to a
 * sibling `*.submodules/` dir keeps the submodule checkout entirely OUTSIDE the
 * superproject worktree tree, so the superproject-linked scaffolding (the `.roll`
 * symlink at the cycle path, the superproject's own submodule mounts) and the
 * cycle's submodule worktree never collide.
 */
export function submoduleWorktreePath(cycleWorktreePath: string, submoduleName: string): string {
  return join(dirname(cycleWorktreePath), `${basename(cycleWorktreePath)}.submodules`, submoduleName);
}

/**
 * E2 — create the cycle worktree ON a git SUBMODULE of the superproject, not on
 * the superproject itself. This is decision #1 of the submodule-aware delivery
 * design: a `git worktree add` on the submodule's OWN repo shares the submodule's
 * object store and refs, so when the local-delivery landing (E3
 * {@link landLocalDelivery}) `update-ref`s the submodule's local integration
 * branch, the user's REAL submodule checkout sees the branch advance — a
 * sibling-clone could never do that.
 *
 * Steps (all run against the SUBMODULE repo `<superprojectCwd>/<submoduleName>`):
 *   1. Validate `<submoduleName>` is a declared submodule in the superproject's
 *      `.gitmodules` (`git config --file .gitmodules --get submodule.<name>.path`
 *      / `--get-regexp` — matches by declared PATH, which is how the runner names
 *      it). A missing declaration is fail-loud (code≠0, stderr names the miss) —
 *      never silently fall back to the superproject.
 *   2. Validate the submodule is INITIALIZED: `git -C <sub> rev-parse --git-dir`
 *      resolves. A declared-but-de-inited submodule (no gitdir) is fail-loud so
 *      the caller surfaces an honest "submodule not initialized" terminal rather
 *      than checking a worktree out of thin air.
 *   3. `git -C <sub> worktree add --detach <submoduleWorktreePath> <base>` — the
 *      SAME detached-worktree contract as {@link worktreeAdd} (US-LOOP-094: no
 *      local branch is created; the cycle commits on a detached HEAD).
 *
 * @param superprojectCwd     the outer super-repo that embeds the submodule.
 * @param submoduleName       the submodule's declared path in `.gitmodules`
 *                            (e.g. `dukang-service-online`).
 * @param cycleWorktreePath   the runner's canonical cycle worktree path; the
 *                            submodule worktree lands at
 *                            {@link submoduleWorktreePath}`(cycleWorktreePath, submoduleName)`.
 * @param base                the worktree base ref (the submodule's integration
 *                            branch, e.g. `feat/contractor2.0`).
 */
export async function worktreeAddInSubmodule(
  superprojectCwd: string,
  submoduleName: string,
  cycleWorktreePath: string,
  base: string,
  exists: (p: string) => boolean = defaultExists,
): Promise<GitResult> {
  // (1) The submodule must be declared in .gitmodules — match by declared path
  // (the name the runner uses). `--get-regexp submodule\..*\.path` lists every
  // declared submodule PATH; we require an exact match on `submoduleName`.
  const declared = await git(
    ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    superprojectCwd,
  );
  const declaredPaths = declared.code === 0
    ? declared.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/).slice(1).join(" ").trim())
        .filter((p) => p !== "")
    : [];
  if (!declaredPaths.includes(submoduleName)) {
    return {
      code: 1,
      stdout: "",
      stderr: `submodule '${submoduleName}' is not declared in ${superprojectCwd}/.gitmodules (declared: ${declaredPaths.join(", ") || "none"})`,
    };
  }

  // (2) The submodule must be initialized — its own git dir must resolve.
  const submoduleCwd = join(superprojectCwd, submoduleName);
  const gitDir = await git(["rev-parse", "--git-dir"], submoduleCwd);
  if (gitDir.code !== 0) {
    return {
      code: gitDir.code === 0 ? 1 : gitDir.code,
      stdout: "",
      stderr: `submodule '${submoduleName}' is declared but not initialized (no git dir at ${submoduleCwd}); run 'git submodule update --init ${submoduleName}' — ${gitDir.stderr.trim()}`,
    };
  }

  // (3) Detached worktree on the SUBMODULE repo (same contract as worktreeAdd).
  const path = submoduleWorktreePath(cycleWorktreePath, submoduleName);
  mkdirSync(dirname(path), { recursive: true });
  await git(["worktree", "prune", "--expire", "now"], submoduleCwd); // lenient
  if (exists(path)) {
    await git(["worktree", "remove", "--force", path], submoduleCwd); // lenient
    rmSyncQuiet(path);
  }
  const result = await git(["worktree", "add", "--detach", path, base], submoduleCwd);
  if (result.code === 0) {
    try {
      await git(["config", "extensions.worktreeConfig", "true"], path);
    } catch {
      /* best-effort defense-in-depth (mirrors worktreeAdd) */
    }
  }
  return result;
}

/**
 * E5 — remove the SUBMODULE cycle worktree created by {@link worktreeAddInSubmodule}.
 * The submodule worktree is registered against the SUBMODULE repo
 * (`<superprojectCwd>/<submoduleName>`), so its admin metadata + `git worktree
 * remove` must run there — removing it via the superproject would not find the
 * registration. Mirrors {@link worktreeRemove}'s tolerant teardown:
 *   1. `git -C <sub> worktree remove --force <submoduleWorktreePath>` (lenient),
 *   2. `rm -rf <submoduleWorktreePath>` (lenient),
 *   3. `git -C <sub> worktree prune --expire now` (reclaim admin metadata).
 * ALWAYS returns code 0 — terminal cleanup is best-effort and must never topple a
 * cycle. (No unpushed-bundle step: E3 local-delivery already advanced the
 * submodule's local integration branch to the cycle HEAD before cleanup, so the
 * work is reachable; the superproject-side {@link worktreeRemove} still bundles
 * for the remote-publish path.)
 *
 * @param superprojectCwd       the outer super-repo embedding the submodule.
 * @param submoduleName         the submodule's declared `.gitmodules` path.
 * @param submoduleWorktreePath the sibling worktree dir to remove
 *                              ({@link submoduleWorktreePath}).
 */
export async function worktreeRemoveInSubmodule(
  superprojectCwd: string,
  submoduleName: string,
  submoduleWorktreePath: string,
): Promise<GitResult> {
  const submoduleCwd = join(superprojectCwd, submoduleName);
  const r = await git(["worktree", "remove", "--force", submoduleWorktreePath], submoduleCwd); // lenient
  rmSyncQuiet(submoduleWorktreePath);
  await git(["worktree", "prune", "--expire", "now"], submoduleCwd); // lenient
  return { code: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * RESUME-PRIOR-WORK: re-point an ALREADY-created cycle worktree's TRACKED tree to
 * a resume ref. The worktree was created on `origin/main` (the fresh-context
 * default) BEFORE the story was picked; once the picker has named the story, the
 * runner discovers a resumable prior-cycle branch and calls this to move the
 * worktree onto it so the agent RESUMES the prior product code rather than redoes
 * it.
 *
 * Two steps in the worktree:
 *   1. `git fetch origin <branch> --quiet` — make `origin/<branch>` resolvable in
 *      THIS worktree's object store (the resume probes fetched in the MAIN tree).
 *   2. `git reset --hard <ref>` — move the worktree branch + working tree to the
 *      resume tip.
 *
 * STRICT in shape (returns git's code) but the caller treats a non-zero as
 * "stay on origin/main" — the resume optimization must never topple a cycle. The
 * symlinked `.roll` (FIX-204C) and the picker's 🔨 backlog mark live OUTSIDE the
 * worktree's tracked git content, so the hard reset leaves them untouched.
 */
export async function worktreeResetHard(
  worktreePath: string,
  ref: string,
  branch?: string,
): Promise<GitResult> {
  if (branch !== undefined && branch.trim() !== "") {
    const f = await git(["fetch", "origin", branch, "--quiet"], worktreePath);
    if (f.code !== 0) return f;
  }
  return git(["reset", "--hard", ref], worktreePath);
}

// ─── RESUME-PRIOR-WORK probes (un-merged audit-branch reuse) ──────────────────

/**
 * Fetch a candidate prior-cycle branch from origin so its ref is resolvable
 * locally before the resume probes run. LENIENT (mirrors `_worktree_fetch_origin`):
 * `fetched:false` on a missing branch / network blip — the caller treats an
 * unfetchable candidate as "not resumable" and falls back to origin/main.
 */
export async function fetchRemoteBranch(
  repoCwd: string,
  branch: string,
): Promise<{ fetched: boolean }> {
  const r = await git(["fetch", "origin", branch, "--quiet"], repoCwd);
  return { fetched: r.code === 0 };
}

/**
 * Is `origin/<branch>` ALREADY merged into `origin/main`? Uses
 * `git merge-base --is-ancestor origin/<branch> origin/main` (exit 0 = the branch
 * tip is an ancestor of main = merged). A non-zero / errored probe (unknown ref)
 * returns `false` so the caller treats an unresolvable branch as un-merged and
 * lets the conflict probe arbitrate; only a definite 0 reports "merged".
 *
 * RESUME-PRIOR-WORK condition (a): a branch already on main has nothing to
 * resume — it must be skipped.
 */
export async function branchMergedIntoMain(
  repoCwd: string,
  branch: string,
  integrationBranch: string = DEFAULT_INTEGRATION_BRANCH,
): Promise<boolean> {
  const r = await git(
    ["merge-base", "--is-ancestor", `origin/${branch}`, integrationBranch],
    repoCwd,
  );
  return r.code === 0;
}

/**
 * Does `origin/<branch>` cleanly merge with `origin/main` (no conflicts)? Uses
 * `git merge-tree --write-tree origin/main origin/<branch>` — a NON-MUTATING
 * 3-way merge dry-run (git ≥ 2.38): exit 0 = clean, exit 1 = conflict. A clean
 * merge proves the branch's commits can be replayed onto current main without
 * a conflicted tree, so the resumed worktree is workable rather than a manual
 * merge-conflict mess. Any other exit (bad ref / old git) returns `false` so the
 * caller falls back to origin/main rather than risk spawning into a broken tree.
 *
 * RESUME-PRIOR-WORK condition (b): only a branch that cleanly rebases onto
 * origin/main is resumed; otherwise fresh-context (origin/main) + an ALERT.
 */
export async function branchCleanlyRebasesOntoMain(
  repoCwd: string,
  branch: string,
  integrationBranch: string = DEFAULT_INTEGRATION_BRANCH,
): Promise<boolean> {
  const r = await git(
    ["merge-tree", "--write-tree", integrationBranch, `origin/${branch}`],
    repoCwd,
  );
  return r.code === 0;
}

// ─── E3: local-only delivery landing ─────────────────────────────────────────

/** How {@link landLocalDelivery} moved the local integration branch. */
export type LocalLandingMethod = "created" | "fast_forward" | "merge";

/** Result of a local-only landing. `code !== 0` ⇒ the landing failed (the SHA
 *  or a git step errored) and the ref was NOT moved. */
export interface LocalLandingResult {
  code: number;
  /** The cycle worktree HEAD SHA that was landed (empty when it could not be resolved). */
  sha: string;
  /** The LOCAL branch the delivery landed on (integration branch minus any `origin/`). */
  landedBranch: string;
  /** How the ref moved. */
  method: LocalLandingMethod;
  /** git stderr on failure (diagnostics). */
  stderr: string;
}

/**
 * E3 — land a cycle's work onto the LOCAL integration branch WITHOUT any remote
 * interaction (no push / no PR / no CI). This is the local-only delivery
 * primitive: the config `publish_mode: local` path calls it INSTEAD of the
 * push→PR ladder.
 *
 * Semantics (the plan's "落到整合分支" — chosen for maximum safety):
 *   - The landing branch is the integration branch with any leading `origin/`
 *     stripped: you cannot move a remote-tracking ref locally, and a local-only
 *     repo's integration branch is a LOCAL branch (`origin/main` → `main`).
 *   - The cycle HEAD SHA is read from the DETACHED worktree (`rev-parse HEAD`).
 *   - If the local branch does not exist yet → create it at the SHA (`created`).
 *   - Else if the local branch is an ANCESTOR of the SHA → fast-forward the ref
 *     to the SHA (`fast_forward`). This is the normal case: the worktree was
 *     branched off the integration branch, so the cycle HEAD is a descendant.
 *   - Else (the local branch moved on independently) → build a real merge commit
 *     with `merge-tree --write-tree` + `commit-tree` and point the ref at it
 *     (`merge`). The cycle HEAD and the diverged branch are both parents.
 *
 * ALL ref moves use `update-ref` (never a checkout), so NO working tree — not
 * the main checkout, not any sibling worktree — is ever touched or dirtied. A
 * conflicting merge (merge-tree exit ≠ 0) returns a non-zero code and leaves the
 * ref unmoved (fail-loud; the caller keeps the worktree for recovery).
 *
 * @param repoCwd        the MAIN checkout (owns the local integration branch ref).
 * @param worktreeCwd    the cycle's detached worktree (its HEAD is the delivery).
 * @param integrationBranch the configured integration branch (E1); default origin/main.
 */
export async function landLocalDelivery(
  repoCwd: string,
  worktreeCwd: string,
  integrationBranch: string = DEFAULT_INTEGRATION_BRANCH,
): Promise<LocalLandingResult> {
  const landedBranch = integrationBranch.replace(/^origin\//, "");
  const fail = (code: number, stderr: string, method: LocalLandingMethod = "fast_forward"): LocalLandingResult => ({
    code,
    sha: "",
    landedBranch,
    method,
    stderr,
  });

  const head = await git(["rev-parse", "HEAD"], worktreeCwd);
  if (head.code !== 0) return fail(head.code === 0 ? 1 : head.code, head.stderr);
  const sha = head.stdout.trim();
  if (sha === "") return fail(1, "empty HEAD sha");

  // Does the local landing branch exist yet?
  const localRef = `refs/heads/${landedBranch}`;
  const exists = await git(["rev-parse", "--verify", "--quiet", localRef], repoCwd);
  if (exists.code !== 0 || exists.stdout.trim() === "") {
    // Create it directly at the cycle SHA (no checkout).
    const created = await git(["update-ref", localRef, sha], repoCwd);
    if (created.code !== 0) return { code: created.code, sha, landedBranch, method: "created", stderr: created.stderr };
    return { code: 0, sha, landedBranch, method: "created", stderr: "" };
  }
  const localSha = exists.stdout.trim();

  // Fast-forward when the local branch is an ancestor of the cycle HEAD.
  const anc = await git(["merge-base", "--is-ancestor", localSha, sha], repoCwd);
  if (anc.code === 0) {
    const ff = await git(["update-ref", localRef, sha, localSha], repoCwd);
    if (ff.code !== 0) return { code: ff.code, sha, landedBranch, method: "fast_forward", stderr: ff.stderr };
    return { code: 0, sha, landedBranch, method: "fast_forward", stderr: "" };
  }

  // Diverged → real merge commit built at ref level (no checkout / no index).
  const mergeTree = await git(["merge-tree", "--write-tree", localSha, sha], repoCwd);
  if (mergeTree.code !== 0) {
    // Conflict (exit 1) or old-git error → fail-loud, leave the ref unmoved.
    return { code: mergeTree.code === 0 ? 1 : mergeTree.code, sha, landedBranch, method: "merge", stderr: mergeTree.stdout + mergeTree.stderr };
  }
  const treeSha = mergeTree.stdout.trim().split("\n")[0] ?? "";
  if (treeSha === "") return { code: 1, sha, landedBranch, method: "merge", stderr: "merge-tree produced no tree" };
  const msg = `merge: local delivery of ${sha.slice(0, 12)} onto ${landedBranch}`;
  const commitTree = await git(
    ["commit-tree", treeSha, "-p", localSha, "-p", sha, "-m", msg],
    repoCwd,
  );
  if (commitTree.code !== 0) return { code: commitTree.code, sha, landedBranch, method: "merge", stderr: commitTree.stderr };
  const mergeSha = commitTree.stdout.trim();
  const move = await git(["update-ref", localRef, mergeSha, localSha], repoCwd);
  if (move.code !== 0) return { code: move.code, sha, landedBranch, method: "merge", stderr: move.stderr };
  return { code: 0, sha, landedBranch, method: "merge", stderr: "" };
}

// ─── branch / commit / push / queries ────────────────────────────────────────

/** `git branch -D <branch>` (lenient; mirrors the oracle's tolerant deletes). */
export async function branchDelete(repoCwd: string, branch: string): Promise<GitResult> {
  return git(["branch", "-D", branch], repoCwd);
}

/**
 * Create a new branch. With `base`: `git branch <branch> <base>`; without:
 * `git branch <branch>` (off current HEAD). Mirrors plain `git branch` creation
 * — STRICT (returns git's code).
 */
export async function branchCreate(repoCwd: string, branch: string, base?: string): Promise<GitResult> {
  const args = base === undefined ? ["branch", branch] : ["branch", branch, base];
  return git(args, repoCwd);
}

/**
 * `git commit -m <message>` (optionally `--allow-empty`). The oracle commits
 * via the agent; this is the direct wrapper for v3 callers. Caller stages first.
 */
export async function commit(
  repoCwd: string,
  message: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<GitResult> {
  const result = await invokeInfraTool<GitCommitInput, GitResult>({
    declaration: GIT_COMMIT_DECLARATION,
    input: { cwd: repoCwd, message, allowEmpty: opts.allowEmpty },
    // Legacy repository lifecycle helper; Agent-facing GitTool is repository-scoped.
    scope: "machine_only",
    run: async (invocation) => {
      const args = ["commit", "-m", invocation.input.message];
      if (invocation.input.allowEmpty === true) args.splice(1, 0, "--allow-empty");
      return ok(invocation, await rawGit(args, invocation.input.cwd));
    },
  });
  if (result.ok) return result.output;
  return { code: 1, stdout: "", stderr: result.error.message };
}

/**
 * `git push origin <branch>` (mirrors `_worktree_merge_back`'s final push and
 * the loop's branch publishes). With `setUpstream`, prepends `-u`. STRICT.
 */
export async function push(
  repoCwd: string,
  branch: string,
  opts: { setUpstream?: boolean; remote?: string } = {},
): Promise<GitResult> {
  const result = await invokeInfraTool<GitPushInput, GitResult>({
    declaration: GIT_PUSH_DECLARATION,
    input: { cwd: repoCwd, branch, remote: opts.remote, setUpstream: opts.setUpstream },
    // Legacy repository lifecycle helper; Agent-facing GitTool is repository-scoped.
    scope: "machine_only",
    run: async (invocation) => {
      const remote = invocation.input.remote ?? "origin";
      const args = invocation.input.setUpstream === true
        ? ["push", "-u", remote, invocation.input.branch]
        : ["push", remote, invocation.input.branch];
      return ok(invocation, await rawGit(args, invocation.input.cwd));
    },
  });
  if (result.ok) return result.output;
  return { code: 1, stdout: "", stderr: result.error.message };
}

/**
 * `git rev-parse --abbrev-ref HEAD` → current branch name (trimmed). Returns
 * `undefined` on failure (detached HEAD edge / non-repo). Detached HEAD prints
 * `HEAD`, returned verbatim as the oracle would observe it.
 */
export async function currentBranch(repoCwd: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoCwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * `git merge-base <a> <b>` → the common-ancestor sha (trimmed), or `undefined`
 * when there is none / on error.
 */
export async function mergeBase(repoCwd: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(["merge-base", a, b], repoCwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * `git merge-base --is-ancestor <ancestor> <descendant>`: true iff `ancestor`
 * is an ancestor of `descendant` (git exit 0); false on exit 1; `undefined` on
 * any other code (error). Mirrors the ff-only ancestry the loop relies on.
 */
export async function isAncestor(
  repoCwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | undefined> {
  const r = await git(["merge-base", "--is-ancestor", ancestor, descendant], repoCwd);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return undefined;
}

/**
 * Proves that one immutable merge commit is contained by the configured
 * integration branch. Ref-like or unsafe inputs fail closed without invoking
 * Git, so diagnostics can report only the typed repo/SHA identity supplied by
 * the caller and never echo remote URLs or credentials.
 */
export async function isCommitReachableFromIntegrationBranch(
  repoCwd: string,
  mergeCommit: string,
  integrationBranch: string,
): Promise<boolean | undefined> {
  if (!isImmutableGitObjectId(mergeCommit) || !isSafeGitRef(integrationBranch)) return undefined;
  return isAncestor(repoCwd, mergeCommit, integrationBranch);
}

/** A remote ref row from `git ls-remote`. */
export interface LsRemoteRef {
  sha: string;
  ref: string;
}

/**
 * `git ls-remote [<remote>] [<ref>...]` parsed into `{ sha, ref }` rows
 * (tab-separated, as git prints). Empty list on failure (lenient — callers gate
 * on emptiness like the bash probes do). `remote` defaults to `origin`.
 */
export async function lsRemote(
  repoCwd: string,
  remote = "origin",
  refs: readonly string[] = [],
): Promise<LsRemoteRef[]> {
  const r = await git(["ls-remote", remote, ...refs], repoCwd);
  if (r.code !== 0) return [];
  const out: LsRemoteRef[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    out.push({ sha: line.slice(0, tab), ref: line.slice(tab + 1) });
  }
  return out;
}

// ─── project path canonicalization + identity ────────────────────────────────

/**
 * The I/O half of project identity — mirrors the canonicalization PREAMBLE of
 * `_project_slug` (bin/roll 6957-6973). @roll/spec's `projectSlug` is the pure
 * algorithm; this performs the realpath + worktree resolution it documented as
 * "infra's duty".
 *
 * Steps, exactly as the oracle:
 *   1. FIX-056: on Darwin only, `realpath <path>`; on success replace `path`
 *      (case-normalize + symlink-resolve). Non-Darwin leaves the path as given,
 *      matching the bash `[[ Darwin ]]` guard. Failure leaves `path` unchanged.
 *   2. FIX-034: `git -C <path> rev-parse --git-common-dir`; if the result ends
 *      in `/.git`, the canonical project is `${common%/.git}` (a worktree
 *      resolves to its main tree).
 *
 * @param path        starting path (caller's cwd or an explicit dir).
 * @param platform    override of `process.platform` (tests).
 */
export async function canonicalProjectPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  let p = path;
  if (platform === "darwin") {
    const real = await realpathQuiet(p);
    if (real !== undefined) p = real;
  }
  // FIX-201: resolve to the CURRENT worktree's toplevel, never the main
  // worktree. `--git-common-dir` drags every linked worktree back to the
  // primary checkout — correct for cycle worktrees only by accident, and
  // catastrophically wrong for sibling dev worktrees (the loop baked
  // ~/Workspace/roll — the FROZEN v2 checkout — as the project path and
  // idled there forever while roll-v3's backlog sat untouched).
  const top = await git(["-C", p, "rev-parse", "--show-toplevel"]);
  if (top.code === 0) {
    const t = top.stdout.trim();
    if (t !== "") p = t;
  }
  return p;
}

/**
 * Resolve the remote URL the slug derives from — mirrors the bash fallback
 * chain (bin/roll 6975-6982): `origin`, else the FIRST remote, else undefined.
 */
export async function remoteUrl(repoCwd: string): Promise<string | undefined> {
  const origin = await git(["-C", repoCwd, "remote", "get-url", "origin"]);
  if (origin.code === 0 && origin.stdout.trim() !== "") return origin.stdout.trim();
  const list = await git(["-C", repoCwd, "remote"]);
  if (list.code === 0) {
    const first = list.stdout.split("\n").find((l) => l.trim() !== "")?.trim();
    if (first !== undefined) {
      const u = await git(["-C", repoCwd, "remote", "get-url", first]);
      if (u.code === 0 && u.stdout.trim() !== "") return u.stdout.trim();
    }
  }
  return undefined;
}

/** Project identity: the canonical path + the @roll/spec slug derived from it. */
export interface ProjectIdentity {
  path: string;
  slug: string;
}

/**
 * Convenience composite: canonicalize `path`, read its remote, and compute the
 * slug via @roll/spec `projectSlug`. Honors `ROLL_MAIN_SLUG` exactly as the
 * oracle (US-LOOP-006: the override short-circuits before any path/remote I/O).
 *
 * @param path     starting path; defaults to `process.cwd()` (bash `pwd`).
 */
export async function projectIdentity(
  path: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): Promise<ProjectIdentity> {
  const override = process.env["ROLL_MAIN_SLUG"];
  if (override !== undefined && override !== "") {
    // Oracle returns the override before touching the filesystem; we still
    // report a canonical path for callers that want one.
    const canon = await canonicalProjectPath(path, platform);
    return { path: canon, slug: override };
  }
  const canon = await canonicalProjectPath(path, platform);
  const url = await remoteUrl(canon);
  const inputs: ProjectIdentityInputs = { path: canon, remoteUrl: url };
  return { path: canon, slug: projectSlug(inputs) };
}

// ─── small lenient fs helpers (mirror bash `rm -rf ... || true`) ──────────────

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function rmSyncQuiet(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* lenient: mirrors `rm -rf ... 2>/dev/null || true` */
  }
}

async function realpathQuiet(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

interface GitRawInput {
  args: string[];
  cwd?: string;
}

interface GitCommitInput {
  cwd: string;
  message: string;
  allowEmpty?: boolean;
}

interface GitPushInput {
  cwd: string;
  branch: string;
  remote?: string;
  setUpstream?: boolean;
}

function ok<I>(invocation: ToolInvocation<I>, output: GitResult): ToolResult<GitResult> {
  const now = Date.now();
  return {
    ok: true,
    output,
    meta: {
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      caller: invocation.caller,
      startedAt: invocation.ts,
      endedAt: now,
      durationMs: Math.max(0, now - invocation.ts),
    },
  };
}
