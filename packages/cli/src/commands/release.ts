/**
 * US-REL-007 — `roll release`: the ONLY release command.
 *
 * The default flow owns the whole release transaction, in order, every
 * irreversible step behind an earlier gate:
 *
 *   plan → fold-changelog → bump-version → package-gate → commit-push →
 *   consistency-gate → open-pr → wait-merge → sync-main → tag-push
 *
 * The old sub-surfaces (`ship`, `waiver`, `changelog`, `consistency`) are
 * GONE — not hidden, not redirected: they exit through the normal
 * unknown-route error. There is no public waiver path: shipping over a known
 * fail-level drift is blocked; fix the drift.
 *
 * FIX-288: the release drives the merge itself via GitHub-native auto-merge
 * (`gh pr merge <pr> --auto --squash`) instead of outsourcing it to the
 * `com.roll.pr.<slug>` watch lane — so a release never sits silent for 20
 * minutes waiting for a lane that may be off, and it still completes even if
 * the process is interrupted (GitHub finishes the merge). The wait loop prints
 * one feedback line per poll and nudges the PR (an empty commit) if checks
 * never schedule. The consistency gate moved BEFORE open-pr/merge: it now runs
 * on the release branch, so a drifting release aborts before the bump+changelog
 * can land on main (no merged-but-untagged half-product).
 *
 * It stops at the tag push (release.yml runs the remote gate + GitHub
 * Release); `npm publish` stays the owner's separate, 2FA-authenticated step.
 *
 * Machine entries (CI, not advertised):
 *   --gate-check   run the consistency gate only (release.yml's job)
 *   --json         print the computed plan as JSON
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventBus, EVENTS_FILE, foldUnreleased, isChangelogReady, planRelease, releaseTagForVersion, resolveVersionScheme, verifyRelease, type ReleaseDate, type ReleaseStep, type ReleaseVerifySeams } from "@roll/core";
import { isTransientGhError } from "@roll/infra";
import { type Lang, resolveLang, t, v2Catalog, v3Catalog } from "@roll/spec";
import { c, renderState } from "../render.js";
import { runConsistencyCheck } from "../lib/release-consistency.js";
import { readConfirmLine } from "../lib/tty-confirm.js";

function label(lang: Lang, key: string, ...args: ReadonlyArray<string | number>): string {
  if (v3Catalog[key] !== undefined) return t(v3Catalog, lang, key, ...args);
  return t(v2Catalog, lang, key, ...args);
}

// US-DOSSIER-036: `consistency` is RESTORED as a public sub-route of `roll
// release` — `roll release consistency check [--json]` prints the verdict-first
// seven-dimension table (the web gate panel's twin). The other old sub-surfaces
// (ship/waiver/changelog/tag/publish) stay removed: the release transaction is
// one command. `consistency` is intentionally NOT in this set.
const REMOVED_ROUTES = new Set(["ship", "waiver", "changelog", "tag", "publish"]);

/** Injectable seams — the transaction is unit-tested without git/gh/npm. */
export interface ReleaseFlowDeps {
  version: (cwd: string) => string;
  /**
   * FIX-1247: the released project's package name, used to pick the version
   * scheme — only roll's own package uses calver; every target project uses
   * semver so its version anchors to its own lineage, not roll's build number.
   * Empty string when unreadable (→ semver, the safe default for targets).
   */
  packageName: (cwd: string) => string;
  branch: (cwd: string) => string;
  clean: (cwd: string) => boolean;
  synced: (cwd: string) => boolean;
  tagExists: (cwd: string, tag: string) => boolean;
  readChangelog: (cwd: string) => string;
  writeChangelog: (cwd: string, text: string) => void;
  bumpVersion: (cwd: string, version: string) => void;
  packageGate: (cwd: string) => boolean;
  commitPush: (cwd: string, branch: string, message: string) => void;
  openPr: (cwd: string, branch: string, title: string) => string;
  /**
   * FIX-288 AC1: arm GitHub-native auto-merge on the freshly opened PR
   * (`gh pr merge <pr> --auto --squash`). Once armed, GitHub completes the
   * merge when checks go green — even if this process is Ctrl-C'd. AC5: if the
   * repo has "Allow auto-merge" disabled, this THROWS an honest, actionable
   * error rather than silently hanging.
   */
  enableAutoMerge: (cwd: string, prRef: string, branch: string) => void;
  /**
   * FIX-288 AC3: nudge the release PR — an empty commit pushed to its branch
   * fires a `synchronize` event, which reliably schedules `pull_request` CI when
   * a fresh PR's checks never triggered (a known GitHub flake). Best-effort.
   */
  nudgePr: (cwd: string, branch: string) => void;
  /**
   * FIX-288 AC2/AC3: polls until the PR is merged. GitHub auto-merge does the
   * merging; this loop only watches and gives feedback. `onWait` is called once
   * per poll with a human waited-so-far line (AC2). After a stretch with no
   * checks scheduled it NUDGES the PR via `nudge` to fire a `synchronize` event
   * (AC3). Returns false on close/timeout.
   */
  waitMerged: (
    cwd: string,
    prRef: string,
    branch: string,
    hooks: { onWait: (line: string) => void; nudge: () => void },
  ) => boolean;
  syncMain: (cwd: string) => boolean;
  consistencyGate: (cwd: string) => Promise<boolean> | boolean;
  tag: (cwd: string, tag: string, version: string) => void;
  pushTag: (cwd: string, tag: string) => void;
  /**
   * FIX-368: record the just-pushed release as a `release:gate` FACT in the
   * event stream so the dossier's prevTag/history + waiver audit stay current
   * automatically (no manual `roll index`). CRITICAL CONTRACT: this runs AFTER
   * the irreversible tag-push, is APPEND-ONLY + BEST-EFFORT, and must NEVER
   * throw or block — a `v*` tag push triggers a real publish (release.yml), so
   * the release transaction is already complete and must not be destabilised by
   * a bookkeeping append. The default impl swallows every error. Optional so a
   * test can omit it; the flow guards the call regardless.
   */
  recordReleaseFact?: (cwd: string, tag: string) => void;
  confirm: (tag: string) => boolean;
  now: () => Date;
  /** Step progress sink (stdout in production; recorded in tests). */
  onStep?: (step: ReleaseStep, detail: string) => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run `gh <args>` synchronously, returning {code, stdout, stderr} — never
 *  throws on a non-zero exit (mirrors the infra `gh` wrapper, sync flavour for
 *  the release deps). */
function ghSync(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout: String(stdout), stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout != null ? String(err.stdout) : "",
      stderr: err.stderr != null ? String(err.stderr) : "",
    };
  }
}

/**
 * FIX-1480: production seams for `roll release verify` — git tag, npm registry,
 * and gh release. npm is the truth source; promoteRelease flips the draft to a
 * normal (latest) release only after the pure `verifyRelease` gate agrees.
 */
function realVerifySeams(cwd: string): ReleaseVerifySeams {
  return {
    tagExists: (tag) => {
      try {
        execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
          cwd,
          stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
      } catch {
        return false;
      }
    },
    npmHasVersion: (pkg, version) => {
      try {
        const out = execFileSync("npm", ["view", `${pkg}@${version}`, "version"], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 60_000,
        }).trim();
        return out !== "";
      } catch {
        return false;
      }
    },
    npmLatest: (pkg) => {
      try {
        const out = execFileSync("npm", ["view", pkg, "dist-tags.latest"], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 60_000,
        }).trim();
        return out === "" ? undefined : out;
      } catch {
        return undefined;
      }
    },
    getRelease: (tag) => {
      const r = ghSync(cwd, ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"]);
      if (r.code !== 0) return undefined;
      return { isDraft: r.stdout.trim() === "true" };
    },
    promoteRelease: (tag) => {
      const r = ghSync(cwd, ["release", "edit", tag, "--draft=false", "--latest"]);
      if (r.code !== 0) throw new Error(`gh release edit ${tag} failed: ${r.stderr.trim()}`);
    },
  };
}

/**
 * `roll release verify [version]` (FIX-1480) — the second phase of the two-phase
 * release. After the maintainer's manual 2FA `npm publish`, confirm npm has the
 * version (npm is the truth source), the git tag and draft GitHub Release exist,
 * and npm's `dist-tags.latest` matches, then promote the draft to a normal
 * release. Any gap exits non-zero and leaves the draft untouched. Never runs
 * `npm publish`. `seamsOverride` is the unit-test seam.
 */
export function runReleaseVerify(
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
  seamsOverride?: ReleaseVerifySeams,
  cwd: string = process.cwd(),
): number {
  const versionArg = args.find((a) => !a.startsWith("-"));
  let version = versionArg;
  if (version === undefined || version === "") {
    try {
      version = String(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version ?? "").trim();
    } catch {
      version = "";
    }
  }
  if (version === undefined || version === "") {
    io.err("[roll] release verify: no version given and package.json version unreadable\n");
    return 1;
  }
  let pkg = "";
  try {
    pkg = String(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name ?? "").trim();
  } catch {
    pkg = "";
  }
  if (pkg === "") {
    io.err("[roll] release verify: package.json name unreadable\n");
    return 1;
  }
  const requireLatest = !args.includes("--no-latest");
  const tag = releaseTagForVersion(version);
  const seams = seamsOverride ?? realVerifySeams(cwd);
  const result = verifyRelease(pkg, version, tag, seams, { requireLatest });
  if (!result.ok) {
    io.err(`[roll] release verify FAILED for ${pkg}@${version} — GitHub Release NOT promoted:\n`);
    for (const gap of result.gaps) io.err(`  ✗ ${gap}\n`);
    io.err("  fix the gap (publish npm first if needed) and re-run — draft left untouched.\n");
    return 1;
  }
  io.out(
    result.promoted
      ? `✓ ${pkg}@${version} verified on npm — GitHub Release ${tag} promoted to latest\n`
      : `✓ ${pkg}@${version} already verified and promoted (${tag}) — no change\n`,
  );
  return 0;
}

/** The `owner/repo` slug from the cwd's git remote (gh resolves it the same way;
 *  we ask gh so the REST fallback uses the exact repo gh would). */
function repoSlugSync(cwd: string): string | undefined {
  const r = ghSync(cwd, ["repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name']);
  const v = r.code === 0 ? r.stdout.trim() : "";
  return v === "" ? undefined : v;
}

/**
 * FIX-353 — `gh pr create` resilient to the transient GraphQL EOF: retry a few
 * times, then fall back to the REST `gh api POST …/pulls` (which keeps working
 * when GraphQL EOFs). v3.617.1 / v3.617.2 BOTH aborted at open-pr on this EOF
 * and had to be finished by hand; this removes that abort. Returns the new PR
 * url; throws only on a genuine (non-transient) failure or an exhausted retry
 * with no usable REST fallback.
 */
export function openPrResilient(opts: {
  cwd: string;
  branch: string;
  title: string;
  body: string;
  base?: string;
  retries?: number;
  gh: (args: string[]) => { code: number; stdout: string; stderr: string };
  slug?: () => string | undefined;
}): string {
  const { cwd, branch, title, body } = opts;
  const base = opts.base ?? "main";
  const retries = opts.retries ?? 2;

  // FIX-330 AC1: if a PR already exists for this release branch (left over from
  // a previous interrupted run), reuse it instead of failing on "already exists".
  const viewArgs = ["pr", "view", branch, "--json", "url", "-q", ".url"];
  const existing = opts.gh(viewArgs);
  if (existing.code === 0 && existing.stdout.trim() !== "") {
    return existing.stdout.trim().split("\n").at(-1) ?? branch;
  }

  const createArgs = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body];
  let last = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = opts.gh(createArgs);
    if (last.code === 0) return last.stdout.trim().split("\n").at(-1) ?? branch;
    if (!isTransientGhError(last.stderr)) break; // real error → stop retrying
  }
  // Transient-exhausted (or first transient): try the REST fallback.
  if (isTransientGhError(last.stderr)) {
    const slug = (opts.slug ?? (() => repoSlugSync(cwd)))();
    if (slug !== undefined) {
      const rest = opts.gh([
        "api", "--method", "POST", `repos/${slug}/pulls`,
        "-f", `title=${title}`, "-f", `head=${branch}`, "-f", `base=${base}`, "-f", `body=${body}`,
        "--jq", ".html_url",
      ]);
      if (rest.code === 0) return rest.stdout.trim().split("\n").at(-1) ?? branch;
      last = rest;
    }
  }
  // FIX-330 AC1: a concurrent or eventual-consistency "already exists" is not a
  // real failure — re-probe for the PR and return it.
  if (/already exists|a pull request already exists/i.test(last.stderr)) {
    const reprobe = opts.gh(viewArgs);
    if (reprobe.code === 0 && reprobe.stdout.trim() !== "") {
      return reprobe.stdout.trim().split("\n").at(-1) ?? branch;
    }
  }
  throw new Error(`gh pr create failed: ${(last.stderr || last.stdout).split("\n").find((l) => l.trim() !== "")?.trim() ?? "unknown"}`);
}

/**
 * FIX-353 — arm auto-merge resilient to the transient GraphQL EOF. Retry
 * `gh pr merge --auto --squash`; on a persistent EOF fall back to an immediate
 * REST squash merge (`gh api PUT …/pulls/N/merge`). The REST merge STILL honours
 * required checks (GitHub returns 405 until the PR is green), so a non-green
 * release PR is never force-merged — identical branch-protection semantics to
 * auto-merge. A real "auto-merge not allowed" error surfaces the actionable
 * hint exactly as before.
 */
export function enableAutoMergeResilient(opts: {
  cwd: string;
  prRef: string;
  retries?: number;
  gh: (args: string[]) => { code: number; stdout: string; stderr: string };
  slug?: () => string | undefined;
}): void {
  const { cwd, prRef } = opts;
  const retries = opts.retries ?? 2;

  // FIX-330 AC2: if auto-merge is already armed (or the PR already merged),
  // there is nothing to do — the release can resume from the next step.
  const armed = opts.gh(["pr", "view", prRef, "--json", "autoMergeRequest", "-q", ".autoMergeRequest"]);
  if (armed.code === 0) {
    const am = armed.stdout.trim();
    if (am !== "" && am !== "null") return;
  }

  let last = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = opts.gh(["pr", "merge", prRef, "--auto", "--squash"]);
    if (last.code === 0) return;
    if (!isTransientGhError(last.stderr)) break;
  }
  if (isTransientGhError(last.stderr)) {
    // REST fallback: immediate squash merge by PR number. Branch protection still
    // gates it (405 until green) — so this never bypasses required checks.
    const num = /\/pull\/(\d+)/.exec(prRef)?.[1] ?? (/^\d+$/.test(prRef.trim()) ? prRef.trim() : undefined);
    const slug = (opts.slug ?? (() => repoSlugSync(cwd)))();
    if (num !== undefined && slug !== undefined) {
      const rest = opts.gh([
        "api", "--method", "PUT", `repos/${slug}/pulls/${num}/merge`,
        "-f", "merge_method=squash", "--jq", ".merged",
      ]);
      // A 405 (checks not green yet) is EXPECTED for a fresh PR — the wait loop
      // then watches GitHub finish the merge once checks pass. Only a hard,
      // non-transient REST error is worth surfacing.
      if (rest.code === 0) return;
      if (!isTransientGhError(rest.stderr) && /not allowed|disabled|method not allowed|405/i.test(rest.stderr)) {
        // checks-not-green / auto-merge-disabled → leave the PR for the wait loop
        // (the wait loop + GitHub finish it; never a silent hang here).
        return;
      }
      last = rest;
    }
  }
  // FIX-330 AC2: a PR that merged while we were retrying is not a failure.
  if (/already merged|pull request is already merged/i.test(last.stderr)) return;
  const out = last.stderr || last.stdout;
  const enabledHint = /auto.?merge.*(not allowed|disabled|enabled)|allow auto-?merge/i.test(out);
  const detail = out.split("\n").find((l) => l.trim() !== "")?.trim() ?? "unknown";
  throw new Error(
    enabledHint
      ? `auto-merge is not enabled on this repo. Enable "Allow auto-merge" in Settings → General → Pull Requests, or merge PR ${prRef} manually. (${detail})`
      : `could not arm auto-merge on PR ${prRef}: ${detail}`,
  );
}


// FIX-277: repos with a test-proof commit gate (roll itself) reject a commit
// whose proof is stale. In a roll-managed repo the proof is refreshed up front
// — no error-message sniffing. Any failure rolls the release branch back so an
// orderly abort leaves no stray branch behind.
//
// FIX-1207: the release commit must carry a fresh, matching test-pass proof
// without manual intervention. After `roll test` succeeds we explicitly write
// the proof against the staged tree, then verify it, so a stale prior proof or
// a partial test-run can never leave the gate blocking the release commit.
// The gate semantics are preserved: the proof is only written after a green
// test run, and it is checked against the exact tree being committed.
//
// FIX-330: the release transaction must be re-runnable. If the release branch
// already exists (locally or on origin from a previous interrupted run), reuse
// it instead of failing with `git checkout -b`. If the release commit already
// exists on the branch, skip the commit/push (push is a noop when up to date).

/** Write a fresh `.roll/last-test-pass` proof for the staged tree. Mirrors
 *  scripts/test-ts.sh's JSON shape; `mode: release` marks it as written by the
 *  release flow so a reader can distinguish it from an ordinary TCR proof.
 *  Only call this after the test suite has actually passed on this tree. */
function writeReleaseTestProof(exec: (cmd: string, args: string[]) => string): void {
  const cwd = exec("git", ["rev-parse", "--show-toplevel"]).trim();
  const tree = exec("git", ["write-tree"]).trim();
  const ts = Math.floor(Date.now() / 1000);
  const proofPath = join(cwd, ".roll", "last-test-pass");
  mkdirSync(dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, JSON.stringify({ ts, tree, mode: "release", scope: "affected" }), "utf8");
}

/** Verify a fresh, matching proof exists for the staged tree. Throws an
 *  actionable error if the gate would block the upcoming commit. */
function assertTestProofFresh(exec: (cmd: string, args: string[]) => string): void {
  const cwd = exec("git", ["rev-parse", "--show-toplevel"]).trim();
  const proofPath = join(cwd, ".roll", "last-test-pass");
  if (!existsSync(proofPath)) {
    throw new Error("test-pass proof missing — run `roll test` before committing");
  }
  const body = readFileSync(proofPath, "utf8");
  const tsMatch = /"ts":(\d+)/.exec(body);
  const treeMatch = /"tree":"([^"]*)"/.exec(body);
  const ts = tsMatch ? Number(tsMatch[1]) : NaN;
  const proofTree = treeMatch ? (treeMatch[1] ?? "") : "";
  if (!Number.isFinite(ts) || proofTree === "") {
    throw new Error("test-pass proof is malformed — run `roll test` to regenerate it");
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > 60) {
    throw new Error("test-pass proof is stale (>60s) — run `roll test` to refresh it");
  }
  const currentTree = exec("git", ["write-tree"]).trim();
  if (proofTree !== currentTree) {
    throw new Error("code changed since last test run — run `roll test` on the current staged tree");
  }
}

function hasOnlyPreparedReleaseChanges(exec: (cmd: string, args: string[]) => string): boolean {
  const status = exec("git", ["status", "--porcelain", "--untracked-files=all"]).trim();
  if (status === "") return false;

  const allowed = new Set(["package.json", "CHANGELOG.md"]);
  const unexpected = status
    .split("\n")
    .map((line) => line.slice(2).trim())
    .filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`unexpected worktree changes during release recovery: ${unexpected.join(", ")}`);
  }
  return true;
}

export function commitPushWithGate(opts: {
  branch: string;
  message: string;
  rollManaged: boolean;
  exec: (cmd: string, args: string[]) => string;
}): void {
  const { branch, message, rollManaged, exec } = opts;
  const original = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const preparedChanges = hasOnlyPreparedReleaseChanges(exec);

  let createdLocal = false;
  const checkoutExistingBranch = (): void => {
    if (preparedChanges) {
      // Preserve only the transaction's known preparation changes. Git's
      // three-way checkout fails on conflicts rather than discarding them.
      exec("git", ["checkout", "--merge", branch]);
      return;
    }
    exec("git", ["checkout", branch]);
  };
  const checkoutBranch = (): void => {
    // Local branch already present → reuse.
    let localSha = "";
    try {
      localSha = exec("git", ["rev-parse", "--verify", `refs/heads/${branch}`]).trim();
    } catch {
      // fall through to remote / create-new path
    }
    if (localSha !== "") {
      checkoutExistingBranch();
      return;
    }
    // Remote branch exists (e.g., previous run pushed it) → fetch and reuse.
    let remote = "";
    try {
      remote = exec("git", ["ls-remote", "--heads", "origin", branch]).trim();
    } catch {
      // fall through to create-new path
    }
    if (remote !== "") {
      exec("git", ["fetch", "origin", `${branch}:${branch}`]);
      checkoutExistingBranch();
      return;
    }
    createdLocal = true;
    exec("git", ["checkout", "-b", branch]);
  };
  checkoutBranch();

  try {
    exec("git", ["add", "package.json", "CHANGELOG.md"]);

    // Has this release commit already landed on the branch? Then the staged
    // changes are empty and we only need to ensure the branch is pushed.
    let alreadyCommitted = false;
    try {
      const log = exec("git", ["log", branch, "--grep", message, "--oneline", "-n", "1"]).trim();
      alreadyCommitted = log !== "";
    } catch {
      alreadyCommitted = false;
    }

    if (alreadyCommitted) {
      exec("git", ["push", "-u", "origin", branch]);
    } else {
      if (rollManaged) {
        // FIX-1207: run tests, then explicitly re-write the proof against the
        // staged tree and verify it. This guarantees the upcoming commit passes
        // the 60s freshness gate without a manual `roll test && git commit` step.
        exec("roll", ["test"]);
        writeReleaseTestProof(exec);
        assertTestProofFresh(exec);
      }
      exec("git", ["commit", "-m", message]);
      exec("git", ["push", "-u", "origin", branch]);
    }
  } catch (e) {
    try {
      exec("git", ["checkout", original]);
      if (createdLocal) exec("git", ["branch", "-D", branch]);
    } catch {
      // best-effort rollback; the original failure is the one worth reporting
    }
    throw e;
  }
}

export function realReleaseDeps(): ReleaseFlowDeps {
  return {
    version: (cwd) => {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : "";
      } catch {
        return "";
      }
    },
    packageName: (cwd) => {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
        return typeof pkg.name === "string" ? pkg.name : "";
      } catch {
        return "";
      }
    },
    branch: (cwd) => {
      try {
        return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      } catch {
        return "";
      }
    },
    clean: (cwd) => {
      try {
        return git(cwd, ["status", "--porcelain"]) === "";
      } catch {
        return false;
      }
    },
    synced: (cwd) => {
      try {
        git(cwd, ["fetch", "origin", "main"]);
        return git(cwd, ["rev-list", "--count", "HEAD..origin/main"]) === "0";
      } catch {
        return false;
      }
    },
    tagExists: (cwd, tagName) => {
      try {
        return git(cwd, ["tag", "-l", tagName]) !== "";
      } catch {
        return true; // unknowable → treat as a collision, never overwrite
      }
    },
    readChangelog: (cwd) => readFileSync(join(cwd, "CHANGELOG.md"), "utf8"),
    writeChangelog: (cwd, text) => writeFileSync(join(cwd, "CHANGELOG.md"), text, "utf8"),
    bumpVersion: (cwd, version) => {
      const path = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      pkg["version"] = version;
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    },
    packageGate: (cwd) => {
      try {
        execFileSync("npm", ["pack", "--dry-run"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
        return true;
      } catch {
        return false;
      }
    },
    commitPush: (cwd, branch, message) => {
      commitPushWithGate({
        branch,
        message,
        rollManaged: existsSync(join(cwd, ".roll")),
        exec: (cmd, args) =>
          execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 }),
      });
    },
    // FIX-353: resilient to the transient GraphQL EOF — retry, then REST POST
    // …/pulls fallback. v3.617.1 / v3.617.2 both aborted at open-pr on this EOF.
    openPr: (cwd, branch, title) =>
      openPrResilient({
        cwd,
        branch,
        title,
        body: "Release PR — generated by `roll release` (US-REL-007).",
        gh: (args) => ghSync(cwd, args),
      }),
    // FIX-288 AC1: arm GitHub-native auto-merge so the release drives its own
    // merge (no dependency on the com.roll.pr.<slug> lane) and finishes even if
    // this process is interrupted. AC5: a repo without "Allow auto-merge" makes
    // `gh pr merge --auto` fail — surface that as an honest, actionable error
    // instead of silently waiting forever. FIX-353: now resilient to the
    // transient GraphQL EOF — retry, then REST PUT …/pulls/N/merge fallback
    // (branch protection still gates it; a non-green PR is never force-merged).
    enableAutoMerge: (cwd, prRef) =>
      enableAutoMergeResilient({ cwd, prRef, gh: (args) => ghSync(cwd, args) }),
    // FIX-288 AC3: an empty commit pushed to the release branch fires a
    // `synchronize` event so a fresh PR's pull_request CI gets scheduled. The
    // empty commit is harmless: it squash-merges away into the single release
    // commit on main. Best-effort — a failed nudge never aborts the release.
    nudgePr: (cwd, branch) => {
      const run = (args: string[]): void =>
        void execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run(["commit", "--allow-empty", "-m", "chore: nudge CI (roll release)", "--no-verify"]);
      run(["push", "origin", branch]);
    },
    // FIX-288 AC2/AC3: GitHub auto-merge does the merging; this only watches.
    // Each poll prints one feedback line (AC2). After NUDGE_AFTER quiet polls
    // with no scheduled checks, fire a `synchronize` (AC3) — a fresh PR's CI
    // sometimes never schedules. Returns false on close/timeout.
    waitMerged: (cwd, prRef, _branch, hooks) => {
      const start = Date.now();
      const deadline = start + 20 * 60_000;
      const NUDGE_AFTER = 4; // ~80s of no checks before we kick the PR once
      let quietPolls = 0;
      let nudged = false;
      while (Date.now() < deadline) {
        const waitedMin = Math.max(1, Math.round((Date.now() - start) / 60_000));
        try {
          const state = execFileSync("gh", ["pr", "view", prRef, "--json", "state", "--jq", ".state"], { cwd, encoding: "utf8" }).trim();
          if (state === "MERGED") return true;
          if (state === "CLOSED") return false;
          // AC3: no checks scheduled? count quiet polls; nudge once.
          let checks = "";
          try {
            checks = execFileSync("gh", ["pr", "checks", prRef], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
          } catch {
            checks = ""; // `gh pr checks` exits non-zero when there are no checks yet
          }
          if (checks === "") {
            quietPolls += 1;
            if (!nudged && quietPolls >= NUDGE_AFTER) {
              hooks.nudge();
              nudged = true;
              quietPolls = 0;
            }
          } else {
            quietPolls = 0;
          }
        } catch {
          /* transient gh error — keep polling */
        }
        hooks.onWait(`#${prRef} — waited ${waitedMin}m, waiting for auto-merge / CI`);
        execFileSync("sleep", ["20"]);
      }
      return false;
    },
    syncMain: (cwd) => {
      try {
        git(cwd, ["checkout", "main"]);
        git(cwd, ["pull", "--ff-only", "origin", "main"]);
        return true;
      } catch {
        return false;
      }
    },
    consistencyGate: async () => {
      const code = await runConsistencyCheck(["check"], "roll release");
      return code === 0;
    },
    tag: (cwd, tagName, version) => {
      git(cwd, ["tag", "-a", tagName, "-m", `release v${version}`]);
    },
    pushTag: (cwd, tagName) => {
      git(cwd, ["push", "origin", tagName]);
    },
    recordReleaseFact: (cwd, tagName) => {
      // FIX-368: append a `release:gate` fact for the freshly-pushed tag so the
      // dossier reconciles prevTag/history without a manual step. BEST-EFFORT
      // by contract — wrapped so a bookkeeping failure NEVER affects the
      // already-completed (irreversible) release. verdict=pass: the release
      // transaction only reaches tag-push after every gate passed.
      try {
        const runtimeDir = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
        const eventsPath = runtimeDir !== "" ? join(runtimeDir, EVENTS_FILE) : join(cwd, ".roll", "loop", EVENTS_FILE);
        new EventBus().appendEvent(eventsPath, {
          type: "release:gate",
          tag: tagName,
          verdict: "pass",
          failCount: 0,
          waivedRules: [],
          ts: Math.floor(Date.now() / 1000),
        });
      } catch {
        /* append-only + best-effort: never destabilise the release */
      }
    },
    confirm: (tagName) => {
      process.stdout.write(`release ${tagName}? [y/N] `);
      const line = readConfirmLine();
      return line !== null && /^y(es)?$/i.test(line.trim());
    },
    now: () => new Date(),
  };
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface ReleaseRunResult {
  status: "released" | "aborted" | "dry-run";
  step?: ReleaseStep;
  reason?: string;
  tag?: string;
}

/**
 * The transaction. Fail-loud and partial-release-free: every abort happens
 * BEFORE the next irreversible step; nothing is tagged unless every gate
 * passed and the release PR is on main.
 */
export async function runReleaseFlow(cwd: string, deps: ReleaseFlowDeps, opts: { dryRun: boolean; yes: boolean }): Promise<ReleaseRunResult> {
  const step = (s: ReleaseStep, detail: string): void => deps.onStep?.(s, detail);
  const abort = (s: ReleaseStep, reason: string): ReleaseRunResult => ({ status: "aborted", step: s, reason });
  let current_step: ReleaseStep = "plan";
  try {
    return await runReleaseFlowInner(cwd, deps, opts, (s) => {
      current_step = s;
      return s;
    });
  } catch (e) {
    // FIX-277: a throwing dependency (hook-blocked commit, network failure…)
    // is an ORDERLY abort at the step it bit — never a raw stack mid-release.
    const msg = e instanceof Error ? e.message.split("\n").find((l) => l.trim() !== "") ?? "unknown failure" : String(e);
    return abort(current_step, `step dependency failed: ${msg.trim()}`);
  }
}

async function runReleaseFlowInner(
  cwd: string,
  deps: ReleaseFlowDeps,
  opts: { dryRun: boolean; yes: boolean },
  mark: (s: ReleaseStep) => ReleaseStep,
): Promise<ReleaseRunResult> {
  const step = (s: ReleaseStep, detail: string): void => deps.onStep?.(mark(s), detail);
  const abort = (s: ReleaseStep, reason: string): ReleaseRunResult => ({ status: "aborted", step: s, reason });

  // plan
  const current = deps.version(cwd);
  if (current === "") return abort("plan", "package.json version unreadable");
  if (deps.branch(cwd) !== "main") return abort("plan", "not on main");
  if (!deps.clean(cwd)) return abort("plan", "working tree dirty");
  if (!deps.synced(cwd)) return abort("plan", "main is behind origin — pull first");
  const d = deps.now();
  const date: ReleaseDate = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  // FIX-1247: anchor the version to THIS project's scheme — only roll itself
  // uses calver; a target project uses semver and never inherits roll's build number.
  const scheme = resolveVersionScheme(deps.packageName(cwd));
  const plan = planRelease({ currentVersion: current, date, changelogReady: true, scheme });
  if (deps.tagExists(cwd, plan.tag)) return abort("plan", `tag ${plan.tag} already exists`);
  step("plan", `${current} → ${plan.nextVersion} (${plan.tag})`);

  // fold-changelog (computed before any mutation)
  let changelog: string;
  try {
    changelog = deps.readChangelog(cwd);
  } catch {
    return abort("fold-changelog", "CHANGELOG.md unreadable");
  }
  const folded = foldUnreleased(changelog, plan.nextVersion, fmtDate(d));
  if (folded === null) return abort("fold-changelog", "Unreleased is empty — nothing to release");
  step("fold-changelog", `${folded.notes.split("\n").filter((l) => l.trim().startsWith("-")).length} entries`);

  if (opts.dryRun) return { status: "dry-run", tag: plan.tag };
  if (!opts.yes && !deps.confirm(plan.tag)) return abort("plan", "not confirmed");

  // mutations begin — still nothing irreversible until tag-push
  deps.writeChangelog(cwd, folded.text);
  deps.bumpVersion(cwd, plan.nextVersion);
  step("bump-version", plan.nextVersion);

  if (!deps.packageGate(cwd)) return abort("package-gate", "npm pack --dry-run failed");
  step("package-gate", "pack dry-run clean");

  const branch = `release/${plan.tag}`;
  mark("commit-push");
  deps.commitPush(cwd, branch, `Release: ${plan.tag}`);
  step("commit-push", branch);

  // FIX-288 AC4: the consistency gate runs HERE — on the release branch, with
  // the bump+changelog committed but NOT yet merged. A drifting release aborts
  // cleanly before any PR is opened or merged, so the bump+changelog never land
  // on main untagged (no merged-but-untagged half-product). US-REL-007 stands:
  // no waiver path; fix the drift, then release.
  mark("consistency-gate");
  if (!(await deps.consistencyGate(cwd))) return abort("consistency-gate", "a consistency dimension is failing — fix the drift (no waiver path)");
  step("consistency-gate", "all dimensions pass");

  mark("open-pr");
  const prRef = deps.openPr(cwd, branch, `Release: ${plan.tag}`);
  step("open-pr", prRef);

  // FIX-288 AC1: drive the merge ourselves via GitHub-native auto-merge. The
  // release no longer waits on the com.roll.pr.<slug> lane, and GitHub finishes
  // the merge even if this process is interrupted. AC5: a repo without "Allow
  // auto-merge" throws here with an actionable error — never a silent hang.
  deps.enableAutoMerge(cwd, prRef, branch);
  step("open-pr", `auto-merge armed on ${prRef}`);

  mark("wait-merge");
  const merged = deps.waitMerged(cwd, prRef, branch, {
    onWait: (line) => step("wait-merge", line),
    nudge: () => deps.nudgePr(cwd, branch),
  });
  if (!merged) return abort("wait-merge", "release PR not merged (checks failed or timeout)");
  step("wait-merge", "merged");

  mark("sync-main");
  if (!deps.syncMain(cwd)) return abort("sync-main", "fast-forward to origin/main failed");
  step("sync-main", "main up to date");

  if (deps.tagExists(cwd, plan.tag)) return abort("tag-push", `tag ${plan.tag} appeared concurrently`);
  mark("tag-push");
  deps.tag(cwd, plan.tag, plan.nextVersion);
  deps.pushTag(cwd, plan.tag);
  step("tag-push", plan.tag);
  // FIX-368: the release is now IRREVERSIBLE (the v* tag is pushed → publish).
  // Record it as a fact for the dossier — strictly AFTER the push, APPEND-ONLY,
  // and guarded so a bookkeeping failure can never turn a completed release into
  // an abort. (The default dep already swallows; this double-guards a custom dep.)
  try {
    deps.recordReleaseFact?.(cwd, plan.tag);
  } catch {
    /* never let release-fact bookkeeping affect the completed release */
  }
  return { status: "released", tag: plan.tag };
}

export async function releaseCommand(args: string[], depsOverride?: ReleaseFlowDeps): Promise<number> {
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;
  const lang = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });

  // US-DOSSIER-036: `roll release consistency check [--json]` — the public
  // verdict-first seven-dimension table, the terminal twin of the web gate panel.
  // Reads the SAME runConsistencyCheck computation the gate runs (renderMode
  // "table"); any f>0 dimension fails → exit non-zero (AC4). Detected BEFORE the
  // top-level --help so `roll release consistency [check] --help` lands on the
  // consistency help, not the release-flow usage. Passes the rest (incl. --help/
  // --json) straight to the runner's own subcommand parser.
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub === "consistency") {
    const idx = args.indexOf("consistency");
    const rest = args.slice(idx + 1);
    // Default to `check` when no subcommand is given (the design chip is
    // `roll release consistency check`, but a bare `roll release consistency`
    // should also land on the table rather than an unknown-subcommand error).
    // A leading `--help`/`-h` routes to the runner's help, not check.
    const runnerArgs =
      rest.length === 0 || (rest[0]?.startsWith("-") && rest[0] !== "--help" && rest[0] !== "-h")
        ? ["check", ...rest]
        : rest;
    return await runConsistencyCheck(runnerArgs, "roll release consistency", { renderMode: "table" });
  }
  if (sub === "verify") {
    // FIX-1480: two-phase release phase 2 — promote the draft only once npm has
    // the version (npm is the truth source). Never publishes.
    const idx = args.indexOf("verify");
    return runReleaseVerify(args.slice(idx + 1));
  }

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${label(lang, "releasev3.usage")}\n`);
    return 0;
  }

  // US-REL-007 AC2: the retired sub-routes die through the normal unknown-route
  // error — no redirect, no hidden logic.
  if (sub !== undefined && REMOVED_ROUTES.has(sub)) {
    process.stderr.write(
      lang === "zh"
        ? `[roll] roll release ${sub} 已移除——发布面只有一条命令：roll release（见 roll release --help）\n`
        : `[roll] roll release ${sub} was removed — the release surface is one command: roll release (see roll release --help)\n`,
    );
    return 1;
  }
  if (sub !== undefined) {
    process.stderr.write(`[roll] unknown release argument: ${sub}\n`);
    return 1;
  }

  // machine entry for CI (release.yml): gate only, exit code is the verdict.
  if (args.includes("--gate-check")) {
    return await runConsistencyCheck(["check"], "roll release");
  }

  const deps = depsOverride ?? realReleaseDeps();
  const cwd = process.cwd();

  if (args.includes("--json")) {
    const d = deps.now();
    const date = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    const currentVersion = deps.version(cwd);
    const scheme = resolveVersionScheme(deps.packageName(cwd));
    let changelogText: string | undefined;
    try {
      changelogText = deps.readChangelog(cwd);
    } catch {
      // Unreadable changelog reports changelogReady: false.
    }
    const next = planRelease({ currentVersion, date, changelogReady: false, scheme });
    const plan = planRelease({
      currentVersion,
      date,
      changelogReady: changelogText !== undefined ? isChangelogReady(changelogText, next.nextVersion) : false,
      scheme,
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  }

  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  // US-SHOW-001: `--showcase` opts into running the golden-path standard E2E
  // after a successful release. It is RECOMMENDED but NON-HARD-BLOCKING — the
  // release transaction's pass/fail never couples to real-agent availability
  // (kimi/claude/pi can be flaky/slow/cost money), so a failed/skipped showcase
  // is reported but never reverts a tagged release. Without the flag, a release
  // just prints a pointer to run it.
  const showcase = args.includes("--showcase");
  deps.onStep = (s, detail) => {
    // FIX-288 AC2: the wait-merge poll emits one progress line per poll (and the
    // armed-auto-merge note) — those are "still working", not "done", so they
    // render with a waiting glyph; the terminal `merged` and all other steps get
    // the completion check. No more 20-minute silence while the PR merges.
    const inProgress = s === "wait-merge" && detail !== "merged";
    const glyph = inProgress ? c("dim", "…") : c("green", "✓");
    process.stdout.write(`${glyph} ${s.padEnd(17)} ${detail}\n`);
  };
  const res = await runReleaseFlow(cwd, deps, { dryRun, yes });
  if (res.status === "released") {
    process.stdout.write(
      lang === "zh"
        ? `\n${c("green", `✓ ${res.tag} 已打 tag 并推送`)} — release.yml 跑远端闸与 GitHub Release；npm publish 仍由你手动执行\n`
        : `\n${c("green", `✓ ${res.tag} tagged and pushed`)} — release.yml runs the remote gate + GitHub Release; npm publish stays yours\n`,
    );
    await offerShowcase(lang, showcase);
    return 0;
  }
  if (res.status === "dry-run") {
    process.stdout.write(lang === "zh" ? `dry-run 通过：将发 ${res.tag}（未做任何改动）\n` : `dry-run clean: would release ${res.tag} (nothing changed)\n`);
    await offerShowcase(lang, showcase);
    return 0;
  }
  process.stderr.write(
    lang === "zh"
      ? `${c("red", `✗ 发版在 ${res.step} 中止`)}：${res.reason}\n`
      : `${c("red", `✗ release aborted at ${res.step}`)}: ${res.reason}\n`,
  );
  return 1;
}

/**
 * US-SHOW-001 — offer the golden-path showcase as a RECOMMENDED, NON-HARD-
 * BLOCKING post-release step. With `--showcase` it runs `roll showcase` now (its
 * own verdict prints, but its exit never changes the release exit — the tag is
 * already pushed); without it, it just prints a pointer so the operator can
 * refresh the demo evidence on their own schedule. Any showcase failure here is
 * swallowed: real-agent flakiness must never appear to have failed a release.
 */
async function offerShowcase(lang: Lang, run: boolean): Promise<void> {
  if (!run) {
    process.stdout.write(
      lang === "zh"
        ? `\n${c("dim", "→ 建议：跑一次黄金路径 showcase 刷新 demo 证据链（真模型，非硬卡）：")}\n  roll showcase\n`
        : `\n${c("dim", "→ Recommended: run the golden-path showcase to refresh the demo evidence chain (real models, non-blocking):")}\n  roll showcase\n`,
    );
    return;
  }
  process.stdout.write(
    lang === "zh"
      ? `\n${c("dim", "→ 跑黄金路径 showcase（真模型；其判定不影响已完成的发版）…")}\n`
      : `\n${c("dim", "→ Running the golden-path showcase (real models; its verdict does NOT affect the completed release)…")}\n`,
  );
  try {
    const { showcaseCommand } = await import("./showcase.js");
    const code = await showcaseCommand([]);
    if (code !== 0) {
      process.stdout.write(
        lang === "zh"
          ? `${c("dim", "（showcase 未通过/被跳过——已记录，但不影响本次发版）")}\n`
          : `${c("dim", "(showcase failed/skipped — recorded, but the release stands)")}\n`,
      );
    }
  } catch (e) {
    // Best-effort: a showcase that cannot even launch must not taint the release.
    process.stdout.write(
      lang === "zh"
        ? `${c("dim", `（showcase 无法启动：${e instanceof Error ? e.message : String(e)}——不影响发版）`)}\n`
        : `${c("dim", `(showcase could not launch: ${e instanceof Error ? e.message : String(e)} — release unaffected)`)}\n`,
    );
  }
}
