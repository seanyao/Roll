import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { git as gitRun, commit as gitCommit, push as gitPush, checkImageEvidenceAllowed, imageEvidencePathsInWorkingTree } from "@roll/infra";
import { parsePolicy } from "@roll/core";
import type { DepsExec, EventsPort, MetadataCommitResult } from "./ports.js";
import type { CycleRepositoryExecutionContext } from "@roll/spec";

const execFileAsync = promisify(execFile);

/**
 * The filesystem roots a cycle's WORK needs to write — consumed by agents that
 * run under an explicit workspace sandbox (codex `--sandbox workspace-write`
 * splices these as `--add-dir`; non-sandboxing agents like claude/pi ignore
 * them). This is an agent-AGNOSTIC fact-about-the-work, not a per-agent special
 * case (the sandbox/test/acceptance behaviours that DO differ per agent belong
 * behind the agent factory — FIX-313/US-LOOP-…). The per-agent decision of
 * WHETHER and HOW to apply these roots lives in agent-spawn.
 */
export function agentWritableRoots(repoCwd: string, alertsPath: string): string[] {
  const roots: string[] = [];
  const add = (p: string): void => {
    if (p.trim() === "") return;
    const real = existsSync(p) ? realpathSync(p) : p;
    if (!roots.includes(real)) roots.push(real);
  };
  const rollDir = join(repoCwd, ".roll");
  if (existsSync(rollDir)) add(rollDir);
  add(dirname(alertsPath));
  // FIX-326: the cycle worktree's git-internal dir (the shared object store +
  // the worktree's own gitdir under <common>/worktrees/<cycle>) lives OUTSIDE
  // the worktree — under the repo's git-common-dir. Without write access there,
  // a sandboxed agent's `git write-tree` / `git commit` silently fail: no
  // test-pass proof is written and no TCR commit can be created, so a cycle that
  // produced complete, green work is discarded as gave_up (observed: FIX-285,
  // 3× $4-7 cycles, 0 commits). `git commit` needs the same dir, so granting the
  // common dir is what makes the agent's own-branch TCR commits work at all.
  try {
    const common = execFileSync("git", ["-C", repoCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
    if (common !== "") add(common);
  } catch {
    /* best-effort: if the git probe fails the agent's commits will fail loudly
       (no silent proof), surfacing the issue rather than masking it. */
  }
  return roots;
}

/**
 * E4 — the submodule-aware writable roots. A submodule cycle's agent commits its
 * TCR work into the SUBMODULE's object store (`<super>/.git/modules/<sub>`),
 * which is a DIFFERENT git-common-dir than the superproject's (`<super>/.git`).
 * FIX-326's grant must therefore cover the submodule's common dir too — without
 * it a sandboxed agent's `git write-tree`/`git commit` in the submodule worktree
 * silently fails (the very failure FIX-326 fixed, now re-armed for submodules).
 *
 * Returns the superproject roots (`.roll` for evidence/backlog writes + alert dir
 * + superproject git-common-dir) UNION the execution repo's own git-common-dir.
 * When `execRepoCwd === repoCwd` (no submodule) this is byte-identical to
 * {@link agentWritableRoots} (the union adds nothing new), so the existing path
 * is unchanged.
 */
export function submoduleAgentWritableRoots(repoCwd: string, execRepoCwd: string, alertsPath: string): string[] {
  const roots = agentWritableRoots(repoCwd, alertsPath);
  if (execRepoCwd === repoCwd) return roots;
  try {
    const common = execFileSync(
      "git",
      ["-C", execRepoCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim();
    if (common !== "") {
      const real = existsSync(common) ? realpathSync(common) : common;
      if (!roots.includes(real)) roots.push(real);
    }
  } catch {
    /* best-effort: same fail-loud posture as agentWritableRoots — a probe miss
       lets the agent's submodule commit fail visibly rather than masking it. */
  }
  return roots;
}

/** Workspace Builder sandbox boundary. The Issue root itself is deliberately
 * not writable: only write-access repository worktrees, the git common dirs
 * needed for their commits, and the three Issue-owned output directories are
 * granted. Read-only repository legs remain visible through the Issue cwd but
 * are excluded from writable roots. */
export function repositoryAgentWritableRoots(execution: CycleRepositoryExecutionContext): string[] {
  const roots: string[] = [];
  const add = (path: string): void => {
    const canonical = realpathSync(path);
    if (!roots.includes(canonical)) roots.push(canonical);
  };
  const issueRoot = realpathSync(execution.issueRoot);
  for (const name of ["artifacts", "evidence", "runtime"] as const) {
    const path = join(issueRoot, name);
    mkdirSync(path, { recursive: true });
    const canonical = realpathSync(path);
    const rel = relative(issueRoot, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`issue_writable_root_escape: ${name}`);
    }
    add(canonical);
  }
  for (const repository of Object.values(execution.repositories)) {
    if (repository.access !== "write") continue;
    add(repository.worktreePath);
    const common = execFileSync(
      "git",
      ["-C", repository.worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim();
    if (common === "") throw new Error(`missing_git_common_dir: ${repository.alias}`);
    add(common);
  }
  return roots;
}

export function persistWorktreeAlerts(worktreePath: string, alertsPath: string, events: EventsPort): void {
  let names: string[];
  try {
    names = readdirSync(worktreePath).filter((n) => /^ALERT.*\.md$/i.test(n));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const path = join(worktreePath, name);
      if (!lstatSync(path).isFile()) continue;
      const body = readFileSync(path, "utf8").trim();
      if (body === "") continue;
      events.appendAlert(
        alertsPath,
        `# worktree alert persisted: ${name}\n\n${body}`,
      );
    } catch {
      /* alert salvage is best-effort */
    }
  }
}

/**
 * FIX-204C — make the MAIN checkout's `.roll` visible inside a cycle worktree.
 *
 * Two moves, both idempotent and best-effort (a failure here must never kill
 * the cycle — the FIX-198 main-anchored reads still work without it):
 *   1. `<wt>/.roll` → symlink to `<repo>/.roll` (only when the worktree did
 *      not check one out — projects that TRACK their whole .roll keep their
 *      real dir). FIX-206: a PARTIAL checkout — a handful of fossil paths
 *      force-committed past a `.roll/` ignore rule (e.g. a leaked
 *      `.roll/ops/release.sh`) — materializes a real `.roll` that shadows the
 *      gitignored, main-only backlog. That incomplete dir is detected (main
 *      has a backlog the worktree's dir lacks) and replaced with the link.
 *   2. one `.roll` line in the repo-common `info/exclude`: the usual
 *      `.gitignore` pattern `.roll/` is DIRECTORY-only and does NOT match a
 *      symlink, so without this the agent's `git add -A` would commit the
 *      link into the delivery PR. info/exclude is repo-local (never pushed)
 *      and covers the main checkout + every worktree.
 */
export async function linkRollIntoWorktree(repoCwd: string, worktreePath: string): Promise<void> {
  try {
    const src = join(repoCwd, ".roll");
    const dst = join(worktreePath, ".roll");
    if (!existsSync(src)) return;
    const dstStat = lstatSync(dst, { throwIfNoEntry: false });
    if (dstStat) {
      // Already linked → idempotent re-entry, nothing to do.
      if (dstStat.isSymbolicLink()) return;
      // A real dir at dst is either a project that genuinely TRACKS its whole
      // .roll (keep it) or a PARTIAL fossil materialization (FIX-206). The
      // backlog is the discriminator: if the main .roll carries one and the
      // worktree's checked-out dir does NOT, the dir is an incomplete fossil
      // shadowing the source of truth → drop it and link. A fully-tracked
      // .roll carries its own backlog and is left untouched.
      const incompleteFossil = existsSync(join(src, "backlog.md")) && !existsSync(join(dst, "backlog.md"));
      if (!incompleteFossil) return;
      rmSync(dst, { recursive: true, force: true });
    }
    symlinkSync(src, dst);
    const common = (
      await execFileAsync("git", ["-C", repoCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
    if (common === "") return;
    const exclude = join(common, "info", "exclude");
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!/^\.roll$/m.test(cur)) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${cur === "" || cur.endsWith("\n") ? "" : "\n"}.roll\n`, "utf8");
    }
  } catch {
    /* best-effort: the cycle must not die on an observation/layout nicety */
  }
}

/**
 * FIX-306 — stage, commit, and push the project's `.roll` metadata repo. This is
 * the RUNNER's job (it runs unsandboxed, with full FS + network access), NOT the
 * agent's: a sandboxed codex agent can write `.roll` files but cannot
 * `git -C .roll commit` (its git-internal dir is outside the sandbox writable
 * roots → meta-commit-blocked). The behaviour is uniform for every agent.
 *
 * Contract (mirrors {@link MetadataPort.commit}):
 *   - `.roll` absent, not a git repo, or part of the MAIN repo (a project that
 *     TRACKS `.roll` inside its own checkout) → clean no-op (`nothingToCommit`):
 *     for those projects the `.roll` content rides the delivery PR, not a
 *     separate metadata commit. Only the nested roll-meta layout is committed.
 *   - `git add -A` then a clean tree → clean no-op (`nothingToCommit`).
 *   - staged changes → commit; on commit failure report `{committed:false, error}`.
 *   - committed → push; a push failure reports `{committed:true, pushed:false,
 *     error}` so the caller can ALERT rather than claim a silent false-success.
 */
export async function commitRollMetadataRepo(
  projectCwd: string,
  message: string,
): Promise<MetadataCommitResult> {
  const rollDir = join(projectCwd, ".roll");
  if (!existsSync(rollDir)) return { committed: false, pushed: false, nothingToCommit: true };
  // `.roll` must be its OWN git repo (the nested roll-meta), NOT a `.roll` dir
  // that the MAIN repo tracks. The discriminator: `.roll`'s git toplevel must BE
  // the `.roll` dir itself. If it resolves to a parent (the main checkout), the
  // `.roll` content is delivered by the PR — committing it here would stage the
  // whole main repo. Resolve both sides through symlinks (the cycle worktree's
  // `.roll` is a symlink to the main one; FIX-204C) before comparing.
  const top = await gitRun(["rev-parse", "--show-toplevel"], rollDir);
  if (top.code !== 0) return { committed: false, pushed: false, nothingToCommit: true };
  let topReal: string;
  let rollReal: string;
  try {
    topReal = realpathSync(top.stdout.trim());
    rollReal = realpathSync(rollDir);
  } catch {
    return { committed: false, pushed: false, nothingToCommit: true };
  }
  if (topReal !== rollReal) return { committed: false, pushed: false, nothingToCommit: true };
  // US-PHYSICAL-008: before staging image evidence, verify the roll-meta remote
  // is private. Public or undetermined remotes block images (conservative). The
  // owner can waive this with `evidence_public_waiver: true` in `.roll/local.yaml`.
  const imagePaths = imageEvidencePathsInWorkingTree(rollDir);
  if (imagePaths.length > 0) {
    const check = await checkImageEvidenceAllowed(projectCwd, rollDir);
    if (!check.allowed) {
      return {
        committed: false,
        pushed: false,
        nothingToCommit: false,
        error: `image evidence blocked: ${check.reason}`,
      };
    }
  }
  // Stage everything the agent + runner wrote (reports, evidence, ac-map, backlog
  // marks, dossier aggregates). `add -A` is the runner's privilege — the failing
  // step inside the sandboxed agent.
  const staged = await gitRun(["add", "-A"], rollDir);
  if (staged.code !== 0) {
    return { committed: false, pushed: false, nothingToCommit: false, error: `git add -A failed: ${staged.stderr.trim()}` };
  }
  const status = await gitRun(["status", "--porcelain"], rollDir);
  if (status.code === 0 && status.stdout.trim() === "") {
    return { committed: false, pushed: false, nothingToCommit: true };
  }
  const committed = await gitCommit(rollDir, message);
  if (committed.code !== 0) {
    return { committed: false, pushed: false, nothingToCommit: false, error: `git commit failed: ${committed.stderr.trim()}` };
  }
  const branch = (await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], rollDir)).stdout.trim() || "main";
  // FIX-367: rebase-safe push. A cycle's metadata commit is built on the local
  // `.roll` HEAD captured at pick time — which is STALE the moment another actor
  // (the PR-lane's merge-time Done flip, a prior cycle's reconcile, a manual
  // rescue) pushes a backlog status change to the roll-meta remote between this
  // cycle's start and finalize. Pushing this stale commit straight to `origin
  // main` either (a) fails non-fast-forward — surfaced as an ALERT, the Done
  // landing lost from this cycle — or (b), after the loop wrapper re-syncs the
  // local `.roll`, CLOBBERS the concurrently-pushed `✅ Done` back to the pick-time
  // `📋 Todo`, re-arming the picker → the re-pick storm FIX-367 closes (FIX-364
  // re-done 3 cycles). Integrate the remote FIRST (fetch + rebase --autostash),
  // so a concurrent Done flip is preserved on top of and merged with this cycle's
  // metadata, and the subsequent push fast-forwards instead of overwriting.
  await rebaseRollMetaOntoUpstream(rollDir, branch);
  const pushed = await gitPush(rollDir, branch);
  if (pushed.code !== 0) {
    return { committed: true, pushed: false, nothingToCommit: false, error: `git push failed: ${pushed.stderr.trim()}` };
  }
  return { committed: true, pushed: true, nothingToCommit: false };
}

/**
 * FIX-367 — integrate the roll-meta remote into the local `.roll` BEFORE pushing
 * the cycle's metadata commit, so a concurrent backlog status flip (the PR-lane's
 * merge-time Done, a reconcile, a manual rescue) is never clobbered by this
 * cycle's stale pick-time snapshot.
 *
 * Best-effort + non-fatal by design: the caller already created the local commit
 * and will push next. We fetch the branch's upstream and `rebase --autostash`
 * the local commit on top of it. On a fetch failure (offline / no remote
 * tracking) or a rebase conflict we ABORT the rebase and leave the local commit
 * untouched — the push then either fast-forwards (nothing concurrent landed) or
 * fails non-fast-forward (surfaced as the existing committed-not-pushed ALERT).
 * The rebase never throws out of here: a rebase blip must not topple the cycle.
 */
async function rebaseRollMetaOntoUpstream(rollDir: string, branch: string): Promise<void> {
  try {
    const fetched = await gitRun(["fetch", "origin", branch], rollDir);
    if (fetched.code !== 0) return; // offline / no remote → push decides fast-forward.
    const upstream = `origin/${branch}`;
    // Nothing to integrate when the remote has not advanced past our local base.
    const behind = await gitRun(["rev-list", "--count", `HEAD..${upstream}`], rollDir);
    if (behind.code === 0 && behind.stdout.trim() === "0") return;
    const rebased = await gitRun(["rebase", "--autostash", upstream], rollDir);
    if (rebased.code !== 0) {
      // A conflict (e.g. the SAME backlog row edited both sides) — abort cleanly
      // and leave the local commit as-is; the push surfaces the non-fast-forward.
      await gitRun(["rebase", "--abort"], rollDir);
    }
  } catch {
    /* rebase is a safety integration — never topple the cycle on a git blip */
  }
}

/** Ceiling for the worktree dependency install (cold pnpm store on first run). */
export const DEPS_BOOTSTRAP_TIMEOUT_MS = 600_000;

/**
 * Install dependencies into a fresh cycle worktree BEFORE the agent spawns.
 *
 * The agent sandbox (codex `--sandbox workspace-write`) has no network, so a
 * worktree without node_modules is a worktree where tests can never run —
 * every `pnpm install` inside the cycle dies on ENOTFOUND. The runner runs
 * outside the sandbox with network and a warm package-manager store, so the
 * install belongs here. Skips non-Node projects (no package.json) and projects
 * without a recognized lockfile. Strict on install failure: a loud ALERT and a
 * false return let the caller stop before agent spawn with a failed terminal.
 */
export async function bootstrapWorktreeDeps(
  worktreePath: string,
  alertsPath: string,
  events: EventsPort,
  exec: DepsExec = execFileAsync as unknown as DepsExec,
): Promise<boolean> {
  if (!existsSync(join(worktreePath, "package.json"))) return true;
  if (existsSync(join(worktreePath, "node_modules"))) return true;
  const plan = existsSync(join(worktreePath, "pnpm-lock.yaml"))
    ? { cmd: "pnpm", args: ["install", "--prefer-offline"] }
    : existsSync(join(worktreePath, "package-lock.json"))
      ? { cmd: "npm", args: ["ci", "--prefer-offline"] }
      : undefined;
  if (plan === undefined) return true;
  try {
    await exec(plan.cmd, plan.args, {
      cwd: worktreePath,
      timeout: DEPS_BOOTSTRAP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    events.appendAlert(
      alertsPath,
      `[FAIL] worktree deps bootstrap failed (${plan.cmd} ${plan.args.join(" ")}): ${msg} — stopping before agent spawn`,
    );
    return false;
  }
}

/** Incremental `pnpm -r build` is ~2.8s warm; give it generous head-room for a
 *  cold worktree (no prior tsc output) before it is treated as a non-fatal slip. */
export const PREBUILD_TIMEOUT_MS = 600_000;

/**
 * Read the FIX-338 `loop_safety.prebuild_dist` flag from
 * `<repoCwd>/.roll/policy.yaml`. DEFAULT-OFF (稳字纪律): an absent / unreadable /
 * `false` policy ⇒ `false`, so deploy is a NO-OP until `prebuild_dist: true` is
 * explicitly flipped on. Mirrors {@link readAttestGateMode} / readPeerGateMode.
 */
export function readPrebuildDistEnabled(repoCwd: string): boolean {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return false;
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.prebuildDist === true;
  } catch {
    return false; // unreadable / unparseable policy → default OFF (no-op)
  }
}

/**
 * FIX-338 (Phase B 杠杆1) — PREBUILD the workspace `dist/` into a fresh cycle
 * worktree, right after deps install and BEFORE the agent spawns, so the working
 * agent already finds `dist/roll.mjs` instead of burning cold round-trips to
 * locate and build the entry point.
 *
 * Agent-AGNOSTIC: a plain `pnpm -r build` benefits any engine (codex/pi/kimi) —
 * NO per-agent hardcode. Does NOT break cycle isolation: the worktree is still
 * based on fresh origin/main (create_worktree) and `dist/` is a gitignored
 * artifact, not tracked content.
 *
 * BEST-EFFORT (red line): a build failure must NEVER topple the cycle — it logs a
 * WARN alert and returns, so the agent still spawns (and can build itself the old
 * way). Gated by {@link readPrebuildDistEnabled}; DEFAULT-OFF ⇒ this is a no-op
 * until explicitly enabled. Skips non-Node projects (no package.json) and
 * projects with no pnpm lockfile (the build command is pnpm-specific).
 */
export async function bootstrapWorktreePrebuild(
  worktreePath: string,
  alertsPath: string,
  events: EventsPort,
  enabled: boolean,
  exec: DepsExec = execFileAsync as unknown as DepsExec,
): Promise<void> {
  if (!enabled) return; // DEFAULT-OFF: deploy no-op until flipped on.
  if (!existsSync(join(worktreePath, "package.json"))) return;
  // The build command is `pnpm -r build`; without a pnpm lockfile this is not a
  // pnpm workspace, so there is nothing to prebuild here.
  if (!existsSync(join(worktreePath, "pnpm-lock.yaml"))) return;
  try {
    await exec("pnpm", ["-r", "build"], {
      cwd: worktreePath,
      timeout: PREBUILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    // BEST-EFFORT: a prebuild slip is NON-FATAL — log + continue so the cycle
    // proceeds and the agent can still build the entry point itself.
    events.appendAlert(
      alertsPath,
      `[WARN] worktree dist prebuild failed (pnpm -r build): ${msg} — continuing; agent will build on demand`,
    );
  }
}

/** Submodule update can clone over the network (cold) — give it the same room. */
export const SKILLS_BOOTSTRAP_TIMEOUT_MS = 600_000;

/** Count immediate entries under `<worktree>/skills` (0 ⇒ unpopulated). */
function skillsEntryCount(worktreePath: string): number {
  const dir = join(worktreePath, "skills");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * E5 — does `<worktree>/.gitmodules` declare a submodule whose PATH is `skills`?
 * This is the discriminator that identifies roll's OWN self-host worktree (roll
 * embeds `skills/` as a submodule; its self-test reads each `skills/<name>`
 * SKILL.md). Any OTHER superproject (e.g. contractor-2.0, which declares only
 * `dukang-service-online`) returns false — its submodules must NOT be bootstrapped
 * by the skills path.
 *
 * The `.gitmodules` grammar is git-config INI: each submodule is a
 * `[submodule "<name>"]` section carrying a `path = <p>` key. We match on the
 * declared PATH being exactly `skills` (the tracked gitlink location roll's test
 * reads), tolerating whitespace and quoted values. A missing / unreadable file ⇒
 * false (no skills submodule ⇒ no bootstrap).
 */
function declaresSkillsSubmodule(worktreePath: string): boolean {
  const gm = join(worktreePath, ".gitmodules");
  if (!existsSync(gm)) return false;
  try {
    const text = readFileSync(gm, "utf8");
    // A `path = skills` line anywhere in .gitmodules — the value may be bare or
    // quoted, with arbitrary surrounding whitespace. git treats the last-wins
    // value per section, but ANY declared `skills` path means this is the roll
    // self-host layout, which is all this guard needs to decide.
    return /^\s*path\s*=\s*"?skills"?\s*$/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Populate the worktree's git SUBMODULES (notably `skills/`) BEFORE the agent
 * spawns. FIX-302 root cause: a fresh `git worktree` carries none of a parent
 * repo's submodule contents — `skills/` lands EMPTY (0 files; main has 28). The
 * full `roll test` / `pnpm -r test` reads `skills/`, so on an empty worktree the
 * suite can never run and AC4 stays "partial" forever — the cycle can never
 * honestly close a card.
 *
 * Approach: `git submodule update --init --recursive` (v2's
 * `_worktree_submodule_init`). A symlink was rejected empirically: `skills/` is a
 * TRACKED submodule path (gitlink), and git refuses a symlink there — `git
 * status` errors out (`expected submodule path 'skills' not to be a symbolic
 * link`), which would topple the whole TCR gate. The submodule init is
 * git-native, leaves `git status` clean, and pins the same SHA as main.
 *
 * Runs in the runner (network + warm caches), like {@link bootstrapWorktreeDeps}.
 * Idempotent: skips when `skills/` is already populated. Skips non-submodule
 * projects (no `.gitmodules`). STRICT on failure: a loud ALERT and a false
 * return let the caller stop before agent spawn with an honest terminal — never
 * an empty `skills/` where AC4 silently goes partial.
 *
 * E5 (real-pilot fix) — this bootstrap serves roll's OWN self-host worktree ONLY.
 * The trigger is now "the worktree declares a `skills` submodule", NOT "any
 * `.gitmodules` exists with an empty `skills/`". A submodule superproject that
 * embeds OTHER submodules (e.g. contractor-2.0's `dukang-service-online`) has no
 * `skills` submodule, so `skillsEntryCount` was permanently 0 and the old logic
 * fired `git submodule update --init --recursive` on EVERY cycle — recursively
 * materializing dukang against a superproject gitlink pointing at an orphan commit
 * that neither the local nor the remote holds (`fatal: upload-pack: not our ref`),
 * hanging create_worktree before pick_story ever ran. The declaration guard makes
 * this a clean no-op for every non-roll project while leaving roll's self-test
 * behavior (populate `skills/`, STRICT on failure) byte-identical.
 */
export async function bootstrapWorktreeSkills(
  worktreePath: string,
  alertsPath: string,
  events: EventsPort,
  submoduleInit: (worktreePath: string) => Promise<{ code: number }>,
): Promise<boolean> {
  // E5: bootstrap ONLY roll's own self-host worktree (a declared `skills`
  // submodule). Any other project — including a submodule superproject with no
  // `skills` submodule — is a clean no-op: never recursively init foreign
  // submodules (the real-pilot create_worktree hang).
  if (!declaresSkillsSubmodule(worktreePath)) return true;
  // Already populated (idempotent re-entry) → skip the network round-trip.
  if (skillsEntryCount(worktreePath) > 0) return true;
  try {
    const r = await submoduleInit(worktreePath);
    if (r.code !== 0) {
      events.appendAlert(
        alertsPath,
        `[FAIL] worktree submodule init failed (git submodule update --init --recursive, code ${r.code}): skills/ would be empty → the full test cannot run; stopping before agent spawn`,
      );
      return false;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    events.appendAlert(
      alertsPath,
      `[FAIL] worktree submodule init failed (git submodule update --init --recursive): ${msg} — stopping before agent spawn`,
    );
    return false;
  }
  // Defensive verification: init reported success but skills/ is still empty
  // (e.g. a partial clone) → fail honestly rather than spawn into a broken env.
  if (skillsEntryCount(worktreePath) === 0) {
    events.appendAlert(
      alertsPath,
      `[FAIL] worktree submodule init reported success but skills/ is still empty — stopping before agent spawn`,
    );
    return false;
  }
  return true;
}
