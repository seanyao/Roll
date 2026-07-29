/**
 * GitHub module — TS I/O adapters that drive the `gh` CLI exactly as the v2 loop
 * does (US-INFRA-003).
 *
 * ─── DIVERGENCE FROM THE CARD (octokit → gh) ────────────────────────────────
 * The card text suggests an HTTP GitHub client (octokit). REJECTED for
 * BEHAVIORAL FIDELITY: v2 drives GitHub EXCLUSIVELY through the `gh` CLI
 * (`gh pr …`, `gh api …`, `gh run …`, `gh issue …`). Two reasons this is not
 * negotiable:
 *   1. Credential surface. `gh` resolves auth from the user's `gh auth` keyring
 *      / GH_TOKEN env the same way for every call; octokit would introduce a
 *      SECOND credential path (a PAT we'd have to source + store), changing the
 *      observable auth/permission boundary the user already trusts. v3 must keep
 *      the credential surface byte-identical to v2.
 *   2. Behavioral parity. The oracle's `--json <fields>` selections, `-q`/`--jq`
 *      filters, `--auto`/`--admin` merge modes, and exit-code handling are all
 *      `gh` semantics. Re-deriving them over REST risks silent drift (auto-merge
 *      is a GraphQL mutation; `pr checks` aggregates the checks API + statuses).
 * We therefore wrap `gh` via `execFile`, mirroring each invocation's exact argv,
 * `--json` field set, and output parsing. ZERO new runtime deps. Deliberate.
 *
 * ─── v2 oracle (frozen bash, bin/roll) — gh invocation inventory ─────────────
 *   helpers:
 *     - `_gh_repo_slug`            10971-10984  origin url → `owner/repo`
 *         (strips git@/ssh:///https:///http:// prefixes + trailing `.git`).
 *     - `_gh_available`            10987         `command -v gh`.
 *     - `_gh_resolve <out>`        10992-10998   available && slug, else fail.
 *   PR view (all `gh -R <slug> pr view <ref> --json <f> [-q <jq>]`):
 *     - 13529/13569/13669  `--json url -q .url`            → PR url (reuse probe).
 *     - 13570/13597/8871   `--json state -q .state`        → MERGED/CLOSED/OPEN.
 *     - 12114              `--json headRefName -q .headRefName`.
 *     - 12151              `--json autoMergeRequest -q .autoMergeRequest`.
 *     - 13744              `--json state,mergedAt,mergeCommit` (backfill).
 *     - 11895              `--json headRepository,headRepositoryOwner,isCrossRepository`.
 *     - 12040              `--json mergeStateStatus,statusCheckRollup`.
 *     - 6231               `--json title,body`              (PR review fetch).
 *   PR list (all `gh -R <slug> pr list …`):
 *     - 11034  `--head <b> --state open --json number`.
 *     - 11371  `--base main --state open --json number,title,headRefName`.
 *     - 11974  `--state open --json <self-merge field set>`.
 *     - 12543  `--state open --json headRefName --jq <startswith loop/>`.
 *     - 13139  `--state open --json title --jq '.[].title'`.
 *   PR create   13534/13673  `pr create --base main --head <b> --title --body`.
 *   PR merge    13541  `--auto --squash --delete-branch`,
 *               13680  `--admin --squash --delete-branch`,
 *               11587/11963/12015  `--squash --delete-branch` (plain).
 *   PR diff     12099  `pr diff <pr>`,  11381  `pr diff <pr> --name-only`.
 *   PR close    12082  `pr close <pr> --comment <reason>`.
 *   PR checks   11549  `pr checks <num>`,
 *               11551  `pr checks <num> --json link --jq '.[]|select(.state=="FAILURE")|.link'`.
 *   PR review   6240/6302  `pr review <num> --approve -b <body>`,
 *               6306       `pr review <num> --request-changes -b <body>`.
 *   run list    11024  `run list --commit <c> --json status,conclusion`,
 *               11238  `run list --commit <c> --json conclusion,status`,
 *               11326  `run list --commit <c> --json databaseId,conclusion,headBranch …`,
 *               11349  `run list --json databaseId,conclusion,headBranch -L 20`,
 *               11386/11388  `run list --branch <b> --json databaseId,conclusion`,
 *               14410  `run list --commit <c> --json status,conclusion,name`.
 *   run view    11330/11355/11555  `run view --log-failed <id>`,
 *               11396  `run view <id> --log-failed`.
 *   api         12553  `api repos/<slug>/contents/.roll/backlog.md?ref=<b>
 *                       -H "Accept: application/vnd.github.raw"` (raw file),
 *               1845   `api repos/<slug>/branches/main/protection --jq …`.
 *   issue       14334  `issue create --repo <r> --title --body --label`.
 *   repo        1841   `repo view --json owner,name --jq '.owner.login+"/"+.name'`.
 *
 * Where core/delivery/pr.ts already PLANS the publish sequence (planPublishPr /
 * planPublishDocPr emit {@link PublishStep}[]), THIS module is the EXECUTOR: it
 * provides {@link ExecGh}-compatible runners. `runPublishPlan` accepts a plan +
 * the reuse short-circuit the adapter owns (view → skip create) so the two
 * halves compose without core ever spawning a process.
 *
 * All wrappers are thin: they shell out and surface gh's exit status + parsed
 * stdout. Lenient wrappers (mirroring bash `|| true` / `|| echo ""`) swallow
 * failures exactly where the oracle does, and say so.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { matchHeadCommitSha } from "@roll/core";
import type { OpenPrReference, PrMergeableState } from "@roll/core";
import type { ToolDeclaration, ToolInvocation, ToolResult } from "@roll/spec";
import { invokeInfraTool } from "./tools/delegation.js";

const execFileAsync = promisify(execFile);

/** Result of a raw `gh` invocation. Mirrors {@link GitResult} shape in git.ts. */
export interface GhResult {
  /** Process exit code (0 = success). */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `gh <args>`. Never throws on a non-zero exit — returns the code + captured
 * streams so callers mirror bash's explicit `|| …` handling. Throws only on a
 * spawn failure (gh binary missing), which callers gate with {@link ghAvailable}
 * exactly as the oracle's `_gh_available` precondition does.
 */
export async function rawGh(args: readonly string[]): Promise<GhResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", [...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    if (typeof err.code === "number") {
      return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    if (err.stdout !== undefined || err.stderr !== undefined) {
      return { code: 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw e; // gh binary not found / unspawnable
  }
}

const GH_RAW_DECLARATION: ToolDeclaration = {
  id: "github.raw" as ToolDeclaration["id"],
  kind: "github",
  title: "GitHub Raw",
  description: "Run arbitrary gh argv through the infra tool delegation seam.",
  defaults: { enabled: true, timeoutMs: 60_000 },
  requirements: [{ kind: "executable", name: "gh", optional: false }],
};

const GITHUB_PR_DECLARATION: ToolDeclaration = {
  id: "github.pr" as ToolDeclaration["id"],
  kind: "github",
  title: "GitHub PR",
  description: "Run governed GitHub PR operations through the infra tool delegation seam.",
  emitsEvents: true,
  defaults: { enabled: true, timeoutMs: 60_000 },
  requirements: [{ kind: "executable", name: "gh", optional: false }],
};

const GITHUB_CI_DECLARATION: ToolDeclaration = {
  id: "github.ci" as ToolDeclaration["id"],
  kind: "github",
  title: "GitHub CI",
  description: "Run governed GitHub CI operations through the infra tool delegation seam.",
  emitsEvents: true,
  defaults: { enabled: true, timeoutMs: 60_000 },
  requirements: [{ kind: "executable", name: "gh", optional: false }],
};

export async function gh(args: readonly string[]): Promise<GhResult> {
  const result = await invokeInfraTool<GhRawInput, GhResult>({
    declaration: GH_RAW_DECLARATION,
    input: { args: [...args] },
    run: async (invocation) => ok(invocation, await rawGh(invocation.input.args)),
  });
  if (result.ok) return result.output;
  throw new Error(result.error.message);
}

// ─── FIX-353: transient gh GraphQL EOF resilience ────────────────────────────
//
// On this machine `gh pr create` / `gh pr merge` (both GitHub GraphQL calls)
// intermittently fail with `Post "https://api.github.com/graphql": EOF` — a
// known local network hiccup, NOT a real error. Observed repeatedly: releases
// v3.617.1 / v3.617.2 aborted at open-pr and had to be finished by hand; loop
// cycles FIX-313 / FIX-328 failed-to-publish for the same reason. The proven
// workaround is to (1) retry a couple of times, then (2) fall back to the REST
// API, which keeps working when GraphQL EOFs. REST honours branch protection
// exactly like the GraphQL merge (required checks still gate a merge), and we
// keep sha-pinning, so a non-green PR still won't merge.

/**
 * True iff a `gh` failure looks TRANSIENT (worth a retry / REST fallback) rather
 * than a real, terminal error. Matches the observed GraphQL EOF, generic
 * connection resets / timeouts, and 5xx server errors. A 4xx (validation /
 * permission / "already exists") is NOT transient — the caller must surface it.
 */
export function isTransientGhError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  // GraphQL/HTTP EOF — the headline FIX-353 symptom.
  if (/\beof\b/.test(s)) return true;
  // Connection-level hiccups.
  if (/connection reset|connection refused|broken pipe|i\/o timeout|\btimeout\b|timed out|tls handshake|temporary failure|network is unreachable|no such host|unexpected eof/.test(s)) {
    return true;
  }
  // 5xx server errors (502/503/504 …). A 4xx is a real client error.
  if (/\bhttp 5\d\d\b/.test(s) || /\b5\d\d\b.*(bad gateway|service unavailable|gateway timeout|server error)/.test(s)) {
    return true;
  }
  if (/bad gateway|service unavailable|gateway timeout|internal server error/.test(s)) return true;
  return false;
}

/**
 * US-CYCLE-009 — true iff a `gh pr merge --auto` failure means the REPOSITORY
 * does not have auto-merge enabled (a durable configuration fact, NOT a
 * transient hiccup). The runner degrades gracefully on this: it does not crash;
 * it leaves the PR open and lets the reconcile path self-merge it once CI is
 * green. Matches the messages `gh` surfaces from the GraphQL
 * `enablePullRequestAutoMerge` mutation when the repo/branch forbids auto-merge.
 */
export function isAutoMergeUnavailable(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    /auto-?merge is not allowed/.test(s) ||
    /auto-?merge is not enabled/.test(s) ||
    /does not (?:allow|have) auto-?merge/.test(s) ||
    /auto-?merge.*not.*(?:allowed|enabled|available)/.test(s) ||
    /pull request( is)? not in the correct state to enable auto-?merge/.test(s)
  );
}

/**
 * Run a `gh` invocation with bounded retries on a transient error. Returns the
 * final {@link GhResult} (success, or the last failure — transient or not). The
 * sleep is injected so tests run instantly; production backs off briefly.
 *
 * @param run        the runner (defaults to {@link gh}; injectable for tests).
 * @param retries    extra attempts after the first (default 2 → 3 tries total).
 * @param sleepMs    backoff between attempts (injected; default real setTimeout).
 */
export async function ghWithRetry(
  args: readonly string[],
  opts: {
    run?: (a: readonly string[]) => Promise<GhResult>;
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<GhResult> {
  const run = opts.run ?? gh;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: GhResult = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await run(args);
    if (last.code === 0) return last;
    if (!isTransientGhError(last.stderr)) return last; // real error → surface now
    if (attempt < retries) await sleep(250 * (attempt + 1)); // 250ms, 500ms …
  }
  return last; // exhausted retries on a still-transient failure
}

/**
 * Translate a `gh pr create` argv into the equivalent `gh api` REST POST that
 * creates the same PR — the proven fallback when GraphQL EOFs. Returns undefined
 * if the argv is not a recognisable `pr create` (defensive — caller keeps the
 * gh error). Mirrors:
 *   gh api --method POST /repos/OWNER/REPO/pulls
 *     -f title=.. -f head=.. -f base=.. -f body=..
 */
export function ghPrCreateRestArgv(argv: readonly string[]): string[] | undefined {
  if (!(argv.includes("pr") && argv.includes("create"))) return undefined;
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const slug = flag("-R");
  const head = flag("--head");
  const base = flag("--base") ?? "main";
  const title = flag("--title");
  const body = flag("--body") ?? "";
  if (slug === undefined || head === undefined || title === undefined) return undefined;
  // `--jq .html_url` so the REST response yields the same PR url shape the gh
  // CLI prints (and runPublishPlan parses).
  return [
    "api", "--method", "POST", `repos/${slug}/pulls`,
    "-f", `title=${title}`,
    "-f", `head=${head}`,
    "-f", `base=${base}`,
    "-f", `body=${body}`,
    "--jq", ".html_url",
  ];
}

/**
 * Translate a `gh pr merge <ref> [--auto|--admin] --squash [--delete-branch]`
 * argv into the equivalent `gh api` REST PUT that merges the PR — the proven
 * fallback when GraphQL EOFs. Requires the PR NUMBER (REST merges by number, not
 * branch ref) and OPTIONALLY a tip sha to PIN (so a moved head is not merged).
 *
 * Branch-protection semantics are preserved: the REST merge endpoint STILL
 * enforces required status checks, so a non-green PR returns 405 and is not
 * merged — exactly like `gh pr merge`. `--auto` cannot be expressed over this
 * REST endpoint (it is a GraphQL mutation), so the fallback performs an
 * IMMEDIATE squash merge; GitHub rejects it (405) until checks are green, which
 * is the same end state the auto-merge would have reached.
 *
 * Returns undefined when the argv is not a recognisable `pr merge` OR no PR
 * number is supplied (caller then keeps the gh error rather than guessing).
 */
export function ghPrMergeRestArgv(
  argv: readonly string[],
  prNumber: string | undefined,
  sha?: string,
): string[] | undefined {
  if (!(argv.includes("pr") && argv.includes("merge"))) return undefined;
  if (prNumber === undefined || prNumber === "") return undefined;
  const rIdx = argv.indexOf("-R");
  const slug = rIdx >= 0 && rIdx + 1 < argv.length ? argv[rIdx + 1] : undefined;
  if (slug === undefined) return undefined;
  const method = argv.includes("--squash")
    ? "squash"
    : argv.includes("--rebase")
      ? "rebase"
      : "merge";
  const rest = [
    "api", "--method", "PUT", `repos/${slug}/pulls/${prNumber}/merge`,
    "-f", `merge_method=${method}`,
  ];
  if (sha !== undefined && sha !== "") rest.push("-f", `sha=${sha}`);
  rest.push("--jq", ".merged");
  return rest;
}

/**
 * Mirror `_gh_available` (bin/roll 10987): `command -v gh`. True iff a `gh`
 * binary is on PATH and runnable. Uses `gh --version` (exit 0) as the probe.
 */
export async function ghAvailable(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"], { encoding: "utf8" });
    return true;
  } catch (e) {
    // A non-ENOENT error means gh ran (exists) — treat as available.
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// ─── slug derivation (pure — mirrors _gh_repo_slug 10971-10984) ───────────────

/** Result of {@link ghRepoSlug}: the `owner/repo` slug, or undefined when the
 *  url is not a github remote (the oracle's `return 1`). */
export function ghRepoSlug(originUrl: string | undefined): string | undefined {
  if (originUrl === undefined) return undefined;
  let url = originUrl;
  if (url.startsWith("git@github.com:")) url = url.slice("git@github.com:".length);
  else if (url.startsWith("ssh://git@github.com/")) url = url.slice("ssh://git@github.com/".length);
  else if (url.startsWith("https://github.com/")) url = url.slice("https://github.com/".length);
  else if (url.startsWith("http://github.com/")) url = url.slice("http://github.com/".length);
  else return undefined; // bash `*) return 1`
  if (url.endsWith(".git")) url = url.slice(0, -".git".length);
  if (url === "") return undefined; // bash `[[ -z "$url" ]] && return 1`
  return url;
}

// ─── typed PR wrappers (gh -R <slug> pr …) ────────────────────────────────────

/** A PR's lifecycle state as `gh pr view --json state -q .state` reports it. */
export type GhPrState = "MERGED" | "CLOSED" | "OPEN" | "UNKNOWN" | string;

/**
 * `gh -R <slug> pr view <ref> --json url -q .url` (bin/roll 13529/13569/13669).
 * Returns the trimmed PR url, or "" on any failure (the oracle's `|| pr_url=""`
 * reuse probe — empty means "no open PR, create one").
 */
export async function prViewUrl(slug: string, ref: string): Promise<string> {
  const r = await gh(["-R", slug, "pr", "view", ref, "--json", "url", "-q", ".url"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * `gh -R <slug> pr view <ref> --json state -q .state` (bin/roll 13570/13597).
 * Returns the trimmed state, or "UNKNOWN" on failure — mirroring the oracle's
 * `|| echo "UNKNOWN"`.
 */
export async function prViewState(slug: string, ref: string): Promise<GhPrState> {
  const r = await gh(["-R", slug, "pr", "view", ref, "--json", "state", "-q", ".state"]);
  const s = r.stdout.trim();
  return r.code === 0 && s !== "" ? s : "UNKNOWN";
}

/**
 * `gh -R <slug> pr view <ref> --json headRefName -q .headRefName`
 * (bin/roll 12114). Returns the trimmed head branch, or undefined on failure
 * (the oracle treats a failed lookup as `return 0` / skip).
 */
export async function prViewHeadRef(slug: string, ref: string): Promise<string | undefined> {
  const r = await gh(["-R", slug, "pr", "view", ref, "--json", "headRefName", "-q", ".headRefName"]);
  if (r.code !== 0) return undefined;
  const v = r.stdout.trim();
  return v === "" ? undefined : v;
}

/**
 * `gh -R <slug> pr view <ref> --json autoMergeRequest -q .autoMergeRequest`
 * (bin/roll 12151). Returns true iff auto-merge is already armed — mirroring the
 * oracle's `[ -n "$am" ] && [ "$am" != "null" ]` test on the raw output.
 */
export async function prAutoMergeArmed(slug: string, ref: string): Promise<boolean> {
  const r = await gh([
    "-R", slug, "pr", "view", ref, "--json", "autoMergeRequest", "-q", ".autoMergeRequest",
  ]);
  if (r.code !== 0) return false;
  const am = r.stdout.trim();
  return am !== "" && am !== "null";
}

/**
 * FIX-1260 — fetch the last BOT/APP review state for a PR.
 * gh -R <slug> pr view <ref> --json reviews
 * Returns the last bot/app review state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
 * or "" when no bot review exists or gh fails.
 */
export async function prViewBotReviewState(slug: string, ref: string): Promise<string> {
  const r = await gh([
    "-R", slug, "pr", "view", ref, "--json", "reviews",
    "-q", "[.reviews[] | select(.authorAssociation == \"BOT\" or .authorAssociation == \"APP\")] | last | .state // \"\"",
  ]);
  if (r.code !== 0) return "";
  const v = r.stdout.trim();
  if (v === "" || v === "null") return "";
  return v;
}

/** Parsed `--json state,mergedAt,mergeCommit,number,url,headRefName` view (bin/roll 13744, backfill).
 *  FIX-389b: extends with prNumber + prUrl so the backfill can stamp these
 *  onto runs rows for the projection engine.
 *  FIX-1052: extends with headRefName so the pending-PR reconciler can probe
 *  the PR's head-branch CI state.
 *  US-DELIV-010: extends with isDraft + mergeable so the reconcile engine can
 *  classify draft / merge-conflict PRs as degraded instead of merging blind.
 *  FIX-1258: extends with headRefOid so CI polling can query runs by the
 *  PR's current head commit SHA, excluding force-pushed old heads. */
export interface PrMergeInfo {
  state: GhPrState;
  mergedAt: string | undefined;
  mergeCommit: string | undefined;
  /** PR number (integer). Absent when gh cannot resolve it. */
  prNumber: number | undefined;
  /** PR URL (e.g. https://github.com/o/r/pull/N). Absent when gh cannot resolve it. */
  prUrl: string | undefined;
  /** Head branch name (e.g. `loop/cycle-…`). Absent when gh cannot resolve it. */
  headRefName: string | undefined;
  /** Head commit SHA (the PR's current tip, e.g. `50f03c32`). Absent when gh cannot resolve it. */
  headRefOid: string | undefined;
  /** Draft PR (not mergeable by policy). Absent when gh cannot resolve it. */
  isDraft: boolean | undefined;
  /** gh mergeable rollup: MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeable: PrMergeableState | undefined;
}

/**
 * `gh -R <slug> pr view <ref> --json state,mergedAt,mergeCommit,number,url,headRefName,headRefOid,isDraft,mergeable`
 * (bin/roll 13744 + FIX-389b prNumber/prUrl extension + FIX-1052 headRefName
 * + US-DELIV-010 isDraft/mergeable + FIX-1258 headRefOid).
 * Returns undefined on failure (the oracle's `|| view_json=""` skip).
 * `mergeCommit` is GitHub's `{ oid }` object — we surface the oid string.
 */
export async function prViewMergeInfo(slug: string, ref: string): Promise<PrMergeInfo | undefined> {
  const r = await gh(["-R", slug, "pr", "view", ref, "--json", "state,mergedAt,mergeCommit,number,url,headRefName,headRefOid,isDraft,mergeable"]);
  if (r.code !== 0 || r.stdout.trim() === "") return undefined;
  try {
    const j = JSON.parse(r.stdout) as {
      state?: string;
      mergedAt?: string | null;
      mergeCommit?: { oid?: string } | null;
      number?: number | null;
      url?: string | null;
      headRefName?: string | null;
      headRefOid?: string | null;
      isDraft?: boolean | null;
      mergeable?: string | null;
    };
    const mergeable =
      j.mergeable === "MERGEABLE" || j.mergeable === "CONFLICTING" || j.mergeable === "UNKNOWN"
        ? j.mergeable
        : undefined;
    return {
      state: j.state ?? "UNKNOWN",
      mergedAt: j.mergedAt == null ? undefined : j.mergedAt,
      mergeCommit: j.mergeCommit?.oid == null ? undefined : j.mergeCommit.oid,
      prNumber: typeof j.number === "number" ? j.number : undefined,
      prUrl: typeof j.url === "string" && j.url !== "" ? j.url : undefined,
      headRefName: typeof j.headRefName === "string" && j.headRefName !== "" ? j.headRefName : undefined,
      headRefOid: typeof j.headRefOid === "string" && j.headRefOid !== "" ? j.headRefOid : undefined,
      isDraft: typeof j.isDraft === "boolean" ? j.isDraft : undefined,
      mergeable,
    };
  } catch {
    return undefined;
  }
}

/**
 * FIX-1248 — one entry of `gh pr view --json statusCheckRollup`, GitHub's
 * authoritative union of BOTH check kinds: check-runs (Checks API — Actions
 * and third-party) and status contexts (Statuses API). `gh run list` only
 * sees Actions workflow runs; projects whose required checks report via the
 * Statuses/Checks API would otherwise be invisible.
 */
export interface StatusCheckRollupEntry {
  __typename: "CheckRun" | "StatusContext" | string;
  /** CheckRun: run status (QUEUED / IN_PROGRESS / COMPLETED / …). */
  status?: string | null;
  /** CheckRun: conclusion once COMPLETED (SUCCESS / FAILURE / SKIPPED / …). */
  conclusion?: string | null;
  /** StatusContext: state (SUCCESS / FAILURE / ERROR / PENDING). */
  state?: string | null;
  /** Names are informational only; the reducer keys on status/conclusion/state. */
  name?: string | null;
  context?: string | null;
}

/**
 * `gh -R <slug> pr view <ref> --json statusCheckRollup` (bin/roll 12040 field,
 * isolated call). Returns the parsed rollup entries, or [] on failure/empty —
 * the same lenient "no checks" treatment every oracle CI probe uses.
 */
export async function prViewStatusCheckRollup(slug: string, ref: string): Promise<StatusCheckRollupEntry[]> {
  const r = await gh(["-R", slug, "pr", "view", ref, "--json", "statusCheckRollup"]);
  if (r.code !== 0 || r.stdout.trim() === "") return [];
  try {
    const j = JSON.parse(r.stdout) as { statusCheckRollup?: StatusCheckRollupEntry[] | null };
    return Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
  } catch {
    return [];
  }
}

/** Inputs for {@link prCreate} — mirrors the oracle's create argv. */
export interface PrCreateInput {
  slug: string;
  head: string;
  title: string;
  body: string;
  /** Base branch; the oracle hardcodes `main`. */
  base?: string;
}

/**
 * `gh -R <slug> pr create --base main --head <head> --title <t> --body <b>`
 * (bin/roll 13534/13673). Returns the new PR url (trimmed stdout), or "" on
 * failure — mirroring the oracle's `|| pr_url=""` then the empty-url fatal gate.
 */
export async function prCreate(input: PrCreateInput): Promise<string> {
  const base = input.base ?? "main";
  const r = await invokeInfraTool<GitHubPrCreateToolInput, GhResult>({
    declaration: GITHUB_PR_DECLARATION,
    input: { action: "create", ...input, base },
    run: async (invocation) => ok(invocation, await rawGh([
      "-R", invocation.input.slug, "pr", "create",
      "--base", invocation.input.base, "--head", invocation.input.head,
      "--title", invocation.input.title, "--body", invocation.input.body,
    ])),
  });
  if (!r.ok) return "";
  const result = r.output;
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Merge mode the oracle arms a PR with. */
export type PrMergeMode = "auto" | "admin" | "plain";

/**
 * `gh -R <slug> pr merge <ref> [--auto|--admin] --squash --delete-branch`
 * (bin/roll 13541 auto / 13680 admin / 11587 plain). Returns the {@link GhResult}
 * so callers mirror the oracle's mode-specific fatality:
 *   - auto  (13541): failure NON-fatal (PR left open for a human).
 *   - admin (13680): failure FATAL (return 1, PR left open).
 *   - plain (11587/11963/12015): failure NON-fatal (next tick retries).
 * The wrapper does not decide fatality — it surfaces the code; callers branch.
 */
export async function prMerge(slug: string, ref: string, mode: PrMergeMode): Promise<GhResult> {
  const flags = mode === "auto" ? ["--auto"] : mode === "admin" ? ["--admin"] : [];
  const result = await invokeInfraTool<GitHubPrMergeToolInput, GhResult>({
    declaration: GITHUB_PR_DECLARATION,
    input: { action: "merge", slug, ref, mode },
    run: async (invocation) => ok(invocation, await rawGh([
      "-R", invocation.input.slug, "pr", "merge", invocation.input.ref, ...flags, "--squash", "--delete-branch",
    ])),
  });
  if (result.ok) return result.output;
  return { code: 1, stdout: "", stderr: result.error.message };
}

/**
 * `gh -R <slug> pr ready <ref>` — mark a draft PR ready for review before the
 * PR loop merges a manual-review draft that has received bot approval.
 */
export async function prReady(slug: string, ref: string): Promise<GhResult> {
  const result = await invokeInfraTool<GitHubPrReadyToolInput, GhResult>({
    declaration: GITHUB_PR_DECLARATION,
    input: { action: "ready", slug, ref },
    run: async (invocation) => ok(invocation, await rawGh([
      "-R", invocation.input.slug, "pr", "ready", invocation.input.ref,
    ])),
  });
  if (result.ok) return result.output;
  return { code: 1, stdout: "", stderr: result.error.message };
}

/**
 * `gh -R <slug> pr close <pr> --comment <reason>` (bin/roll 12082). Lenient:
 * the oracle runs it `|| true`, so we surface the code but callers ignore it.
 */
export async function prClose(slug: string, pr: string, reason: string): Promise<GhResult> {
  return gh(["-R", slug, "pr", "close", pr, "--comment", reason]);
}

/**
 * `gh -R <slug> pr diff <pr>` (bin/roll 12099). Returns the trimmed diff, or
 * undefined on failure — the oracle treats a failed diff as "not empty" (never
 * close a PR it couldn't inspect). Callers test emptiness of the defined value.
 */
export async function prDiff(slug: string, pr: string): Promise<string | undefined> {
  const r = await gh(["-R", slug, "pr", "diff", pr]);
  return r.code === 0 ? r.stdout : undefined;
}

/**
 * `gh -R <slug> pr diff <pr> --name-only` (bin/roll 11381). Returns the changed
 * file paths (one per line, blanks dropped), or undefined on failure (the oracle
 * substitutes `(unable to fetch)`; we report undefined and let the caller label).
 */
export async function prDiffNameOnly(slug: string, pr: string): Promise<string[] | undefined> {
  const r = await gh(["-R", slug, "pr", "diff", pr, "--name-only"]);
  if (r.code !== 0) return undefined;
  return r.stdout.split("\n").filter((l) => l !== "");
}

/** A PR review verdict the oracle posts. */
export type PrReviewVerdict = "approve" | "request-changes";

/**
 * `gh -R <slug> pr review <num> --approve|--request-changes -b <body>`
 * (bin/roll 6240/6302/6306). Lenient in the oracle (`|| true`); surfaced here.
 */
export async function prReview(
  slug: string,
  num: string,
  verdict: PrReviewVerdict,
  body: string,
): Promise<GhResult> {
  const flag = verdict === "approve" ? "--approve" : "--request-changes";
  return gh(["-R", slug, "pr", "review", num, flag, "-b", body]);
}

/**
 * `gh -R <slug> pr checks <num>` (bin/roll 11549) — the human-readable checks
 * table the heal path captures. Returns the {@link GhResult} (lenient `|| true`).
 */
export async function prChecks(slug: string, num: string): Promise<GhResult> {
  return gh(["-R", slug, "pr", "checks", num]);
}

/**
 * `gh -R <slug> pr checks <num> --json link --jq
 *  '.[]|select(.state=="FAILURE")|.link'` (bin/roll 11551). Returns the failing
 * check links (one per line), or [] on failure.
 */
export async function prFailingCheckLinks(slug: string, num: string): Promise<string[]> {
  const r = await gh([
    "-R", slug, "pr", "checks", num,
    "--json", "link", "--jq", '.[]|select(.state=="FAILURE")|.link',
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l !== "");
}

// ─── PR list wrappers (gh -R <slug> pr list …) ────────────────────────────────

/** Common gh pr-list JSON row shapes the oracle selects field subsets of. */
export interface PrListRow {
  number?: number;
  title?: string;
  headRefName?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  autoMergeRequest?: unknown;
}

/**
 * `gh -R <slug> pr list --state open --json <fields> [--head <b>] [--base <b>]`
 * — the generic list executor. Returns the parsed rows, or [] on failure
 * (every oracle list site gates on emptiness / `|| echo "1"` fallbacks).
 *
 * @param fields  the exact `--json` field set (e.g. "number,headRefName,…").
 */
export async function prList(
  slug: string,
  fields: string,
  opts: { head?: string; base?: string } = {},
): Promise<PrListRow[]> {
  const args = ["-R", slug, "pr", "list", "--state", "open"];
  if (opts.head !== undefined) args.push("--head", opts.head);
  if (opts.base !== undefined) args.push("--base", opts.base);
  args.push("--json", fields);
  const r = await gh(args);
  if (r.code !== 0 || r.stdout.trim() === "") return [];
  try {
    const j = JSON.parse(r.stdout) as PrListRow[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/**
 * `gh -R <slug> pr list --state open --json headRefName --jq
 *  '.[] | select(.headRefName | startswith("loop/")) | .headRefName'`
 * (bin/roll 12543). Returns the open `loop/*` branch names (blanks dropped).
 */
export async function prListLoopBranches(slug: string): Promise<string[]> {
  const r = await gh([
    "-R", slug, "pr", "list", "--state", "open",
    "--json", "headRefName",
    "--jq", '.[] | select(.headRefName | startswith("loop/")) | .headRefName',
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l !== "");
}

export type OpenPrListReference = OpenPrReference;

function parseOpenPrReferences(text: string): OpenPrListReference[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: OpenPrListReference[] = [];
    for (const row of parsed) {
      if (typeof row !== "object" || row === null) continue;
      const rec = row as Record<string, unknown>;
      const title = typeof rec["title"] === "string" ? rec["title"] : "";
      if (title === "") continue;
      const number = typeof rec["number"] === "number" ? rec["number"] : undefined;
      const headRefName = typeof rec["headRefName"] === "string" ? rec["headRefName"] : undefined;
      const body = typeof rec["body"] === "string" ? rec["body"] : undefined;
      out.push({
        ...(number !== undefined ? { number } : {}),
        title,
        ...(headRefName !== undefined ? { headRefName } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `gh -R <slug> pr list --state open --json number,title,headRefName,body`.
 * Returns open PR references for picker de-duplication, [] on failure.
 */
export async function prListOpenTitles(slug: string): Promise<OpenPrListReference[]> {
  const r = await gh([
    "-R", slug, "pr", "list", "--state", "open", "--json", "number,title,headRefName,body",
  ]);
  if (r.code !== 0) return [];
  return parseOpenPrReferences(r.stdout);
}

// ─── gh run (CI) wrappers ─────────────────────────────────────────────────────

/** A `gh run list` row (the union of the field sets the oracle selects). */
export interface RunRow {
  databaseId?: number;
  status?: string;
  conclusion?: string | null;
  name?: string;
  headBranch?: string;
}

/**
 * `gh -R <slug> run list [--commit <c>|--branch <b>] --json <fields> [-L <n>]`
 * (bin/roll 11024/11238/11326/11349/11386/14410). Returns the parsed rows, or
 * [] on failure (every oracle CI probe treats a failed/empty list as "no runs").
 *
 * @param fields  the exact `--json` field set the call site uses.
 */
export async function runList(
  slug: string,
  fields: string,
  opts: { commit?: string; branch?: string; limit?: number } = {},
): Promise<RunRow[]> {
  const args = ["-R", slug, "run", "list"];
  if (opts.commit !== undefined) args.push("--commit", opts.commit);
  if (opts.branch !== undefined) args.push("--branch", opts.branch);
  args.push("--json", fields);
  if (opts.limit !== undefined) args.push("-L", String(opts.limit));
  const r = await invokeInfraTool<GitHubCiStatusToolInput, GhResult>({
    declaration: GITHUB_CI_DECLARATION,
    input: { action: "status", slug, fields, commit: opts.commit, branch: opts.branch, limit: opts.limit },
    run: async (invocation) => {
      const argv = ["-R", invocation.input.slug, "run", "list"];
      if (invocation.input.commit !== undefined) argv.push("--commit", invocation.input.commit);
      if (invocation.input.branch !== undefined) argv.push("--branch", invocation.input.branch);
      argv.push("--json", invocation.input.fields);
      if (invocation.input.limit !== undefined) argv.push("-L", String(invocation.input.limit));
      return ok(invocation, await rawGh(argv));
    },
  });
  if (!r.ok || r.output.code !== 0 || r.output.stdout.trim() === "") return [];
  try {
    const j = JSON.parse(r.output.stdout) as RunRow[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/**
 * `gh -R <slug> run view [--log-failed] <id>` (bin/roll 11330/11355/11396/11555).
 * Returns the {@link GhResult}; the oracle pipes stdout through head/tail and is
 * lenient (`|| true`), so we surface streams + code without trimming.
 */
export async function runViewLogFailed(slug: string, runId: string): Promise<GhResult> {
  return gh(["-R", slug, "run", "view", "--log-failed", runId]);
}

// ─── gh api / issue / repo wrappers ───────────────────────────────────────────

/**
 * `gh -R <slug> api repos/<slug>/contents/<path>?ref=<branch>
 *  -H "Accept: application/vnd.github.raw"` (bin/roll 12553). Fetches a file's
 * RAW content at a branch. Returns the content string, or undefined on failure
 * (the oracle `continue`s past a failed/empty fetch).
 */
export async function apiContentsRaw(
  slug: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const r = await gh([
    "-R", slug, "api",
    `repos/${slug}/contents/${path}?ref=${ref}`,
    "-H", "Accept: application/vnd.github.raw",
  ]);
  if (r.code !== 0 || r.stdout === "") return undefined;
  return r.stdout;
}

// ─── FIX-1217: CI blackhole dispatch helpers ──────────────────────────────────

/**
 * Trigger a workflow_dispatch for the CI workflow on a specific branch.
 *
 * Equivalent: `gh workflow run ci.yml -R <slug> --ref <branch>`
 * (the repo has a workflow_dispatch trigger on ci.yml).
 *
 * @returns GhResult — code 0 on success, non-zero on failure.
 */
export async function workflowDispatch(
  slug: string,
  workflowFile: string,
  ref: string,
): Promise<GhResult> {
  return gh(["-R", slug, "workflow", "run", workflowFile, "--ref", ref]);
}

/**
 * Count check-runs on a PR's head commit.
 *
 * Equivalent: `gh api repos/<slug>/pulls/<pr>/commits --jq '.[-1].sha'`
 * then `gh api repos/<slug>/commits/<sha>/check-runs --jq '.total_count'`.
 *
 * Returns the total_count (integer), or -1 on failure.
 */
export async function prHeadCheckRunCount(
  slug: string,
  prNumber: number,
): Promise<number> {
  // Get the head sha via the PR's commits list.
  const commitsR = await gh([
    "-R", slug, "api",
    `repos/${slug}/pulls/${prNumber}/commits`,
    "--jq", ".[-1].sha",
  ]);
  if (commitsR.code !== 0 || commitsR.stdout.trim() === "") return -1;
  const headSha = commitsR.stdout.trim();

  const checksR = await gh([
    "-R", slug, "api",
    `repos/${slug}/commits/${headSha}/check-runs`,
    "--jq", ".total_count",
  ]);
  if (checksR.code !== 0) return -1;
  const n = Number(checksR.stdout.trim());
  return Number.isFinite(n) ? n : -1;
}

/** Inputs for {@link issueCreate} — mirrors `gh issue create` argv. */
export interface IssueCreateInput {
  repo: string;
  title: string;
  body: string;
  labels: string;
}

/**
 * `gh issue create --repo <r> --title <t> --body <b> --label <l>`
 * (bin/roll 14334). NOTE the oracle uses `--repo` (long form), NOT `-R`, for
 * this call — mirrored exactly. Returns the {@link GhResult} (stdout is the new
 * issue url).
 */
export async function issueCreate(input: IssueCreateInput): Promise<GhResult> {
  return gh([
    "issue", "create",
    "--repo", input.repo,
    "--title", input.title,
    "--body", input.body,
    "--label", input.labels,
  ]);
}

/**
 * `gh repo view --json owner,name --jq '.owner.login + "/" + .name'`
 * (bin/roll 1841). Returns the trimmed `owner/repo`, or undefined on failure.
 * Used by the branch-protection inspector; distinct from {@link ghRepoSlug}
 * (which derives the slug from the git remote, gh's auto-detection bypassed).
 */
export async function repoViewSlug(): Promise<string | undefined> {
  const r = await gh(["repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name']);
  if (r.code !== 0) return undefined;
  const v = r.stdout.trim();
  return v === "" ? undefined : v;
}

/**
 * `gh api repos/<slug>/branches/main/protection [--jq <filter>]` (bin/roll 1845).
 * Returns the {@link GhResult}; callers apply the jq filter the oracle uses to
 * read required-check names. Lenient probe (the oracle `2>/dev/null`s it).
 */
export async function apiBranchProtection(slug: string, jq?: string): Promise<GhResult> {
  const args = ["api", `repos/${slug}/branches/main/protection`];
  if (jq !== undefined) args.push("--jq", jq);
  return gh(args);
}

// ─── publish-plan executor (composes with core/delivery/pr.ts) ────────────────

/**
 * A single publish step as core's `planPublishPr` / `planPublishDocPr` emit it
 * (structurally compatible with @roll/core's `PublishStep`). We re-declare the
 * shape here so infra need not depend on core (core already depends on no infra;
 * keeping the arrow one-directional). `tool` is "git" or "gh".
 */
export interface PublishStepLike {
  kind: string;
  tool: "git" | "gh";
  argv: string[];
}

/** Outcome of {@link runPublishPlan}. */
export interface RunPublishResult {
  /** The PR url the plan resolved (from reuse `view` or fresh `create`). "" on
   *  failure to obtain one. */
  prUrl: string;
  /** True iff the publish succeeded enough to hand the PR to the merge path
   *  (push ok AND a PR url exists). Mirrors the oracle's `return 0` gate. */
  ok: boolean;
  /** Exit-class for the caller's tier ladder: 0 ok / 1 push|create fail /
   *  2 gh-missing. Mirrors `_loop_publish_pr`'s documented exit codes. */
  status: 0 | 1 | 2;
  /** FIX-1214: the branch was pushed but a transient GitHub API fault prevented
   *  opening/merging the PR. The cycle is classified `published` and handed to
   *  the PR loop via the pending-pr-create queue instead of failing. */
  degraded?: boolean;
  /** Machine-readable root-cause tag when {@link degraded} is true. */
  rootCauseKey?: string;
  /** US-CYCLE-009: the auto-merge attach failed because the repository does not
   *  have auto-merge enabled (a durable config fact, not a transient fault). The
   *  publish still succeeds (status 0, PR open); the caller alerts and the
   *  reconcile path self-merges the PR once CI is green. */
  autoMergeUnavailable?: boolean;
}

/**
 * Execute a publish PLAN built by core (`planPublishPr` / `planPublishDocPr`),
 * mirroring `_loop_publish_pr` (bin/roll 13516-13548) / `_loop_publish_doc_pr`
 * (13657-13687) control flow — the EXECUTOR side of the plan/execute split:
 *   0. gh missing → status 2 (the oracle's gh-unavailable fallback trigger).
 *   1. run the `git-push` step → non-zero exit ⇒ status 1.
 *   2. run the `gh-pr-view` step → non-empty url ⇒ REUSE (skip create).
 *   3. else run `gh-pr-create` → empty url ⇒ status 1.
 *   4. run the merge step (`gh-pr-merge-auto|admin`):
 *        - auto  : failure NON-fatal (status stays 0).
 *        - admin : failure FATAL → status 1 (oracle returns 1, PR left open).
 *
 * `git` steps run through the injected {@link RunStep} (so callers reuse the
 * git.ts runner); `gh` steps run through {@link gh}. Keeping the runner injected
 * keeps this unit-testable with a fake recording both tools' argv.
 */
export type RunStep = (tool: "git" | "gh", argv: readonly string[]) => Promise<GhResult>;

/** Default {@link RunStep}: git → execFile git, gh → {@link gh}. */
export const defaultRunStep: RunStep = async (tool, argv) => {
  if (tool === "gh") return gh(argv);
  try {
    const { stdout, stderr } = await execFileAsync("git", [...argv], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    if (typeof err.code === "number") {
      return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    return { code: 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

/** Extract the PR number from a PR url (`…/pull/<N>`), or undefined. */
export function prNumberFromUrl(prUrl: string): string | undefined {
  const m = /\/pull\/(\d+)/.exec(prUrl);
  return m?.[1];
}

export async function runPublishPlan(
  plan: readonly PublishStepLike[],
  opts: {
    ghAvailable?: () => Promise<boolean>;
    run?: RunStep;
    /** FIX-1214: injected backoff between retry attempts (instant in tests). */
    sleep?: (ms: number) => Promise<void>;
    /** FIX-1214: retries before the REST fallback (default 4 → 5 gh tries). */
    retries?: number;
  } = {},
): Promise<RunPublishResult> {
  const isAvailable = opts.ghAvailable ?? ghAvailable;
  const run = opts.run ?? defaultRunStep;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 4;

  // FIX-1214: run a `gh` step through bounded retries on a transient EOF/5xx
  // hiccup. Routes through the injected `run` so tests mock the same layer.
  // Backoff: 15s / 30s / 60s / 120s between the five attempts.
  const runGhResilient = async (argv: readonly string[]): Promise<GhResult> => {
    let last: GhResult = { code: 1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt <= retries; attempt++) {
      last = await run("gh", argv);
      if (last.code === 0) return last;
      if (!isTransientGhError(last.stderr)) return last;
      if (attempt < retries) {
        const delayMs = Math.min(15_000 * 2 ** attempt, 120_000);
        await sleep(delayMs);
      }
    }
    return last;
  };

  if (!(await isAvailable())) {
    return { prUrl: "", ok: false, status: 2 }; // gh missing → fallback trigger
  }

  const push = plan.find((s) => s.kind === "git-push");
  const view = plan.find((s) => s.kind === "gh-pr-view");
  const create = plan.find((s) => s.kind === "gh-pr-create");
  const merge = plan.find((s) => s.kind === "gh-pr-merge-auto" || s.kind === "gh-pr-merge-admin");

  if (push !== undefined) {
    const r = await run(push.tool, push.argv);
    if (r.code !== 0) return { prUrl: "", ok: false, status: 1 };
  }

  let prUrl = "";
  if (view !== undefined) {
    const r = await run(view.tool, view.argv);
    if (r.code === 0) prUrl = r.stdout.trim();
  }
  if (prUrl === "" && create !== undefined) {
    // FIX-353: retry the GraphQL `gh pr create` on a transient EOF, then fall
    // back to the REST `gh api POST …/pulls` (which works when GraphQL EOFs).
    let r = await runGhResilient(create.argv);
    if (r.code !== 0 && isTransientGhError(r.stderr)) {
      const restArgv = ghPrCreateRestArgv(create.argv);
      if (restArgv !== undefined) {
        const rest = await run("gh", restArgv);
        if (rest.code === 0) r = rest; // REST html_url == the PR url shape
      }
    }
    prUrl = r.code === 0 ? r.stdout.trim() : "";
    // FIX-214: a non-zero `create` is NOT proof the publish failed — a PR may
    // already exist for this branch (the first `view` probe can miss it under
    // eventual consistency, or it was opened by an earlier tick; `gh pr create`
    // then exits with "a pull request already exists"). Re-probe before
    // declaring a PR-fail, so a real (and later-merged) delivery is never
    // mislabeled `failed`/`built:[]`. Only a genuine no-PR result stays status 1.
    if (prUrl === "" && view !== undefined) {
      const reprobe = await run(view.tool, view.argv);
      if (reprobe.code === 0) prUrl = reprobe.stdout.trim();
    }
    if (prUrl === "") {
      // FIX-1214: if the branch was pushed but `gh pr create` kept failing on a
      // transient API fault (even after retry + REST fallback), degrade instead
      // of failing the cycle. The PR loop will open the PR from the queue.
      if (push !== undefined && isTransientGhError(r.stderr)) {
        return { prUrl: "", ok: false, status: 0, degraded: true, rootCauseKey: "env:gh_api" };
      }
      return { prUrl: "", ok: false, status: 1 };
    }
  }

  if (merge !== undefined) {
    // FIX-353: retry `gh pr merge` on a transient EOF, then fall back to the
    // REST `gh api PUT …/pulls/N/merge` — branch-protection-honoured.
    // US-CYCLE-009: the REST fallback is head-sha-PINNED with the same
    // `--match-head-commit` sha the auto-merge attach carries, so the fallback
    // never merges a moved head (PR-API-head-lag trap).
    let r = await runGhResilient(merge.argv);
    if (r.code !== 0 && isTransientGhError(r.stderr)) {
      const restArgv = ghPrMergeRestArgv(
        merge.argv,
        prNumberFromUrl(prUrl),
        matchHeadCommitSha(merge.argv),
      );
      if (restArgv !== undefined) {
        const rest = await run("gh", restArgv);
        if (rest.code === 0) r = rest;
      }
    }
    // admin-merge failure is fatal (doc-pr) UNLESS it is a transient GitHub API
    // fault — then degrade to `published` and let the PR loop retry the merge.
    if (merge.kind === "gh-pr-merge-admin" && r.code !== 0) {
      if (isTransientGhError(r.stderr)) {
        return { prUrl, ok: false, status: 0, degraded: true, rootCauseKey: "env:gh_api" };
      }
      return { prUrl, ok: false, status: 1 };
    }
    // US-CYCLE-009: an auto-merge attach that failed because the repo has
    // auto-merge disabled is NON-fatal (the PR is open; reconcile self-merges).
    // Surface it so the caller can alert instead of silently degrading.
    if (merge.kind === "gh-pr-merge-auto" && r.code !== 0 && isAutoMergeUnavailable(r.stderr)) {
      return { prUrl, ok: prUrl !== "", status: 0, autoMergeUnavailable: true };
    }
  }

  return { prUrl, ok: prUrl !== "", status: 0 };
}

interface GhRawInput {
  args: string[];
}

interface GitHubPrCreateToolInput extends PrCreateInput {
  action: "create";
  base: string;
}

interface GitHubPrMergeToolInput {
  action: "merge";
  slug: string;
  ref: string;
  mode: PrMergeMode;
}

interface GitHubPrReadyToolInput {
  action: "ready";
  slug: string;
  ref: string;
}

interface GitHubCiStatusToolInput {
  action: "status";
  slug: string;
  fields: string;
  commit?: string;
  branch?: string;
  limit?: number;
}

function ok<I>(invocation: ToolInvocation<I>, output: GhResult): ToolResult<GhResult> {
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
