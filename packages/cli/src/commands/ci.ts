/**
 * @responsibility Runs the `ci` subcommand, reporting GitHub Actions run status for the current HEAD.
 */
/**
 * `roll ci` — TS port of bin/roll cmd_ci (14390-14416) plus the `_gh_available`
 * probe (10987). Reports the GitHub Actions run status for the current HEAD
 * commit.
 *
 * PORTED (the full read surface, no flags / `--timeout=N` without `--wait`):
 *   - gh-not-installed → warn + exit 0
 *   - not-a-git-repo (git rev-parse HEAD fails) → err + exit 1
 *   - `gh run list` failure → warn "gh run list failed" + exit 0
 *   - empty / "[]" runs → "No CI runs for <short-sha>" + exit 0
 *   - otherwise one line per run: "<name>: <status>/<conclusion>" (the bash
 *     `jq -r '.[] | "\(.name): \(.status)/\(.conclusion)"'`, with a null
 *     conclusion rendered literally as `null`, matching jq's string interp).
 *   - unknown argument → usage err + exit 1.
 *
 * `--wait` (the CI gate, US-PORT-015): ported as {@link ciWaitCommand} — a
 * 15s-interval poll loop with open-PR detection + repo-slug resolution, the
 * per-poll verdict delegated to core {@link ciWaitTick}. All git/gh/clock
 * touches are injectable seams so the loop is unit-tested without real sleeps
 * or a live run lifecycle. No bash fallback remains for `roll ci`.
 */
import { spawnSync } from "node:child_process";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";
import { ciWaitTick, type CiRunRow } from "@roll/core";
import { ghRepoSlug, prList, runList } from "@roll/infra";
import { onPath } from "./setup-shared.js";

// ─── bash UI helpers (bin/roll:41-56) ────────────────────────────────────────
function pal(): { YELLOW: string; RED: string; NC: string } {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { YELLOW: "", RED: "", NC: "" }
    : { YELLOW: "\x1b[0;33m", RED: "\x1b[0;31m", NC: "\x1b[0m" };
}
/** warn(): YELLOW [roll] line to STDOUT (echo, no redirect). */
function warn(line: string): void {
  const { YELLOW, NC } = pal();
  process.stdout.write(`${YELLOW}[roll]${NC} ${line}\n`);
}
/** err(): RED [roll] line to STDERR. */
function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function m(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, msgLang(), key, ...args);
}

// ─── _gh_available (10987) ────────────────────────────────────────────────────
function ghAvailable(): boolean {
  return onPath("gh");
}

interface CiRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

/** jq's `\(.x)` string interpolation: null → "null", strings verbatim. */
function jqInterp(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return String(v);
}

/**
 * cmd_ci (14390). Returns the exit code, or `null` to signal the caller to fall
 * back to bash (the `--wait` CI-gate path is bash-owned).
 */
export function ciCommand(args: string[]): number | null {
  // Arg parse mirrors the bash `while` loop: --wait / --timeout=N / else error.
  let waitMode = false;
  for (const a of args) {
    if (a === "--wait") {
      waitMode = true;
    } else if (a.startsWith("--timeout=")) {
      // accepted; only consulted by the (bash-owned) --wait path.
    } else {
      err(m("ci.usage_roll_ci_wait_timeout_n"));
      return 1;
    }
  }

  if (waitMode) return null; // _ci_wait stays on bash (see header).

  if (!ghAvailable()) {
    warn(m("ci.gh_not_installed_gh"));
    return 0;
  }

  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) {
    err(m("ci.not_a_git_repo"));
    return 1;
  }
  const commit = (head.stdout ?? "").trim();

  const run = spawnSync(
    "gh",
    ["run", "list", "--commit", commit, "--json", "status,conclusion,name"],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    warn("gh run list failed");
    return 0;
  }
  const runs = (run.stdout ?? "").trim();
  if (runs === "" || runs === "[]") {
    process.stdout.write(m("ci.no_ci_runs_for_git_rev", commit.slice(0, 7)) + "\n");
    return 0;
  }

  let parsed: CiRun[];
  try {
    parsed = JSON.parse(runs) as CiRun[];
  } catch {
    // Malformed JSON would crash jq too; the oracle never reaches here for a
    // status-0 gh, so treat it as the empty case (defensive, no observed path).
    process.stdout.write(m("ci.no_ci_runs_for_git_rev", commit.slice(0, 7)) + "\n");
    return 0;
  }
  for (const r of parsed) {
    process.stdout.write(`${jqInterp(r.name)}: ${jqInterp(r.status)}/${jqInterp(r.conclusion)}\n`);
  }
  return 0;
}

// ─── _ci_wait (bin/roll 11003-11071) — the CI gate (US-PORT-015) ─────────────
/**
 * Injectable seams for {@link ciWaitCommand}: every git/gh/clock touch is a
 * dep so the poll loop is unit-testable without a live run lifecycle or real
 * sleeps. The real factory ({@link realCiWaitDeps}) wires spawnSync git +
 * infra gh helpers + setTimeout.
 */
export interface CiWaitDeps {
  ghAvailable(): boolean;
  headCommit(): string | null; // git rev-parse HEAD, null on non-repo
  shortCommit(): string; // git rev-parse --short HEAD
  branch(): string; // git rev-parse --abbrev-ref HEAD
  repoSlug(): string | undefined; // ghRepoSlug(origin url)
  fetchRuns(slug: string, commit: string): Promise<CiRunRow[]>;
  openPrCount(slug: string, branch: string): Promise<number>;
  sleep(seconds: number): Promise<void>;
  now(): number; // epoch seconds
}

function gitOut(args: string[]): string | null {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

/** Production deps: real git/gh/clock. */
export function realCiWaitDeps(): CiWaitDeps {
  return {
    ghAvailable: () => onPath("gh"),
    headCommit: () => gitOut(["rev-parse", "HEAD"]),
    shortCommit: () => gitOut(["rev-parse", "--short", "HEAD"]) ?? "",
    branch: () => gitOut(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "",
    repoSlug: () => ghRepoSlug(gitOut(["remote", "get-url", "origin"]) ?? undefined),
    fetchRuns: (slug, commit) =>
      runList(slug, "status,conclusion", { commit }) as Promise<CiRunRow[]>,
    openPrCount: (slug, branch) => prList(slug, "number", { head: branch }).then((a) => a.length),
    sleep: (s) => new Promise((res) => setTimeout(res, s * 1000)),
    now: () => Math.floor(Date.now() / 1000),
  };
}

/**
 * `roll ci --wait [--timeout=N]` — the sanctioned CI gate (roll-loop skill).
 * Mirrors `_ci_wait`: poll the HEAD-commit runs every 15s until they pass
 * (exit 0), one is red (exit 1), there is no open PR so CI will never fire
 * (lenient exit 0, FIX-046), or the timeout elapses (exit 1). Decision per
 * poll is delegated to core {@link ciWaitTick}.
 */
export async function ciWaitCommand(args: string[], deps: CiWaitDeps = realCiWaitDeps()): Promise<number> {
  let timeout = 300;
  for (const a of args) {
    if (a === "--wait") continue;
    if (a.startsWith("--timeout=")) {
      const n = parseInt(a.slice("--timeout=".length), 10);
      if (!Number.isNaN(n) && n > 0) timeout = n;
    } else {
      err(m("ci.usage_roll_ci_wait_timeout_n"));
      return 1;
    }
  }
  const interval = 15;

  if (!deps.ghAvailable()) {
    warn(m("loop.gh_not_installed_skipping_ci_gate"));
    return 0;
  }
  const commit = deps.headCommit();
  if (commit === null) {
    err(m("loop.not_a_git_repo"));
    return 1;
  }
  const short = deps.shortCommit();
  const slug = deps.repoSlug();
  if (slug === undefined || slug === "") {
    err(m("loop.cannot_determine_github_repo_from_origin"));
    return 1;
  }
  ok(m("loop.waiting_for_ci_on", short, slug));

  const start = deps.now();
  let first = true;
  while (deps.now() - start < timeout) {
    const runs = await deps.fetchRuns(slug, commit);
    const tick = ciWaitTick(runs);
    if (tick === "no-runs") {
      const branch = deps.branch();
      if (branch !== "" && (await deps.openPrCount(slug, branch)) === 0) {
        warn(m("loop.no_open_pr_for_ci_not", branch));
        return 0; // FIX-046: no PR ⇒ CI never fires ⇒ skip the gate.
      }
      if (first) process.stdout.write(m("loop.no_ci_runs_found_yet_waiting") + "\n");
      first = false;
      await deps.sleep(interval);
      continue;
    }
    if (tick === "pending") {
      const elapsed = deps.now() - start;
      process.stdout.write(m("loop.ci_running_ds_ci", elapsed, elapsed) + "\n");
      await deps.sleep(interval);
      continue;
    }
    if (tick === "failed") {
      err(m("loop.ci_failed_for_ci", short));
      return 1;
    }
    ok(m("loop.ci_passed_ci"));
    return 0;
  }
  warn(m("loop.ci_timed_out_after_s_ci", timeout));
  return 1;
}

/** ok(): GREEN [roll] line to STDOUT (mirrors bin/roll ok()). */
function ok(line: string): void {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const GREEN = noColor ? "" : "\x1b[0;32m";
  const NC = noColor ? "" : "\x1b[0m";
  process.stdout.write(`${GREEN}[roll]${NC} ${line}\n`);
}
