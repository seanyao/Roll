/**
 * TCRPipeline — TS port of the v2 TCR (Test && Commit || Revert) enforcement
 * path: the per-cycle hard validation that a story produced ≥1 `tcr:` commit,
 * and the git pre-commit freshness gate that keeps every commit backed by a
 * fresh, matching test-pass proof.
 *
 * Card AC (US-CORE-006): TCR step sequencing green-or-revert; 0 TCR commits in a
 * cycle → failure verdict + ALERT signal (invariant I12).
 *
 * v2 oracle (frozen, read fully before any change):
 *   - `_loop_enforce_tcr <story_id> [started_at]`   (bin/roll:11594-11629): the
 *     hard validation. Empty `started_at` ⇒ pass (no gate). Else count `tcr:`
 *     commits since `started_at` (via `_loop_tcr_count`); zero ⇒ revert the
 *     story's backlog row `✅ Done`→`📋 Todo`, write the ALERT file, notify, and
 *     return 1 (failure). {@link enforceTcr}.
 *   - `_loop_tcr_count <started_at>`                (bin/roll:10885-10889):
 *     `git log --all --oneline --since=<started_at>` piped to an awk that counts
 *     lines whose message begins `tcr:`. The git call is injected (a count); the
 *     verdict math is pure. {@link tcrVerdict}.
 *   - git pre-commit freshness gate (hooks/pre-commit, FIX-024): the 60s gate.
 *     A commit is allowed iff EITHER the staged set is docs-only OR a
 *     `.roll/last-test-pass` proof exists, is well-formed, was written ≤60s ago,
 *     and its recorded tree hash equals the current `git write-tree`.
 *     {@link freshnessVerdict} + {@link isDocsOnlyCommit}.
 *
 * Invariant I12 (zero-TCR ⇒ failure + ALERT): {@link tcrVerdict} returns
 * `{ ok:false, alert:... }` exactly when the count is zero AND a gate is active
 * (non-empty started_at). The caller performs the revert + ALERT write + notify
 * I/O; this module emits the verdict + the ALERT body string only (pure).
 *
 * Purity: no git spawn, no clock, no filesystem. The commit count, the current
 * tree hash, the proof body, the staged file list, and `now` are all injected.
 */

// ── Zero-TCR hard validation (mirrors _loop_enforce_tcr / _loop_tcr_count) ────

/** Does a oneline `git log` message count as a TCR commit? Mirrors the awk
 *  `/^[a-f0-9]+ tcr:/` after the sha: the message body starts with `tcr:`. */
export function isTcrCommitMessage(message: string): boolean {
  return message.startsWith("tcr:");
}

/**
 * Count `tcr:` commits among a list of commit messages (the bodies, sans sha),
 * mirroring `_loop_tcr_count`'s awk. The caller supplies the messages from
 * `git log --all --oneline --since=<started_at>` (sha already stripped, or via
 * {@link countTcrFromOneline} for raw oneline output).
 */
export function countTcrCommits(messages: readonly string[]): number {
  return messages.reduce((n, m) => n + (isTcrCommitMessage(m) ? 1 : 0), 0);
}

/**
 * Count `tcr:` commits from raw `git log --oneline` lines (`<sha> <message>`),
 * mirroring the awk regex `/^[a-f0-9]+ tcr:/` which anchors a hex sha, a single
 * space, then `tcr:`. Lines not matching that shape contribute 0.
 */
export function countTcrFromOneline(lines: readonly string[]): number {
  return lines.reduce((n, l) => n + (/^[a-f0-9]+ tcr:/.test(l) ? 1 : 0), 0);
}

/** The verdict of the zero-TCR enforcement. `ok:false` carries the planned
 *  revert target + the ALERT body the caller writes (invariant I12). */
export type TcrVerdict =
  | { ok: true; reason: "no-gate" | "tcr-present"; count: number }
  | {
      ok: false;
      reason: "zero-tcr";
      count: 0;
      /** The backlog row id to revert `✅ Done` → `📋 Todo`. */
      revertStoryId: string;
      /** The ALERT file body (rendered, ready to write). */
      alertBody: string;
      /** The desktop-notification title/message pair (bash `_notify`). */
      notify: { title: string; message: string };
    };

/** Inputs for {@link tcrVerdict}: the gated story + its commit count + the
 *  fields the ALERT body interpolates (injected so the body is byte-stable). */
export interface TcrInput {
  storyId: string;
  /** `started_at` the loop recorded; empty/undefined ⇒ gate disabled (pass). */
  startedAt?: string;
  /** The `tcr:` commit count since `startedAt` (from {@link countTcrCommits}). */
  count: number;
  /** `date '+%Y-%m-%d %H:%M'` for the ALERT header (injected). */
  nowStamp: string;
  /** Path of the ALERT file, used only inside the body's retry hints (the bash
   *  hardcodes the commands, not the path; supplied for parity with future use). */
  alertPath?: string;
}

/**
 * The zero-TCR decision, mirroring `_loop_enforce_tcr` (bin/roll:11594-11629):
 *   - empty `startedAt`            → { ok:true, reason:"no-gate" }.
 *   - count > 0                    → { ok:true, reason:"tcr-present" }.
 *   - count === 0 (gate active)    → { ok:false, reason:"zero-tcr", ... } with the
 *     planned backlog revert id, the ALERT body, and the notify strings. The
 *     caller does the sed revert + ALERT write + `_notify` I/O.
 *
 * The ALERT body mirrors the bash heredoc (bin/roll:11612-11623) line-for-line,
 * including the `${started_at}` interpolation and the three retry options.
 */
export function tcrVerdict(input: TcrInput): TcrVerdict {
  const startedAt = input.startedAt ?? "";
  if (startedAt === "") return { ok: true, reason: "no-gate", count: input.count };
  if (input.count > 0) return { ok: true, reason: "tcr-present", count: input.count };

  const alertBody = renderTcrAlert(input.storyId, input.nowStamp, startedAt);
  return {
    ok: false,
    reason: "zero-tcr",
    count: 0,
    revertStoryId: input.storyId,
    alertBody,
    notify: {
      title: "roll ⚠ TCR Failed",
      message: `${input.storyId}: no tcr: commits found`,
    },
  };
}

/** Render the TCR ALERT body, byte-mirroring the bash heredoc
 *  (bin/roll:11612-11623). */
export function renderTcrAlert(storyId: string, nowStamp: string, startedAt: string): string {
  return [
    "# ALERT — TCR check failed",
    "",
    `**Time**: ${nowStamp}`,
    `**Story**: ${storyId}`,
    `**Reason**: zero tcr: commits since story start (${startedAt})`,
    "",
    "**Action required** (choose one):",
    "- Add TCR commits and re-run: `roll loop now`",
    `- Take over manually: \`$roll-build ${storyId}\``,
    "- Reset and retry: `roll loop reset` then `roll loop now`",
    "",
  ].join("\n");
}

// ── Pre-commit freshness gate (mirrors hooks/pre-commit, FIX-024) ─────────────

/** Freshness window in seconds: a test-pass proof older than this blocks the
 *  commit (hooks/pre-commit `ELAPSED -gt 60`). */
export const FRESHNESS_LIMIT_SECONDS = 60;

/** A parsed `.roll/last-test-pass` proof: when tests last passed + the tree they
 *  passed against. */
export interface TestPassProof {
  /** Unix epoch seconds the proof was written (`"ts":<n>`). */
  ts: number;
  /** The `git write-tree` hash tests passed against (`"tree":"<sha>"`). */
  tree: string;
  /**
   * US-CYCLE-011 — which suite scope minted this proof (`"mode":"<v>"`). Canonical
   * values: `"full"` (the WHOLE suite ran → this proof is eligible to satisfy the
   * round-tail / pre-PR full-verify gate) or `"changed"` (only the affected /
   * `--changed` subset ran → a per-commit gate only, NOT a full verify).
   *
   * ADDITIVE + fail-closed: the `ts`/`tree` parse is byte-unchanged; `mode` is
   * optional. Legacy proofs (no `mode`), and ANY value other than `"full"` (e.g.
   * a legacy `"vitest"`, an `"affected"`, or a `"changed"`), are treated by
   * {@link fullVerifyProofValid} as NOT a full verify. `mode` is never consulted
   * by the per-commit {@link freshnessVerdict} — that gate is unchanged.
   */
  mode?: string;
}

/**
 * Parse a `.roll/last-test-pass` proof body, mirroring the hook's `grep -o`
 * extraction: `"ts":<digits>` and `"tree":"<value>"`. Returns `undefined` when
 * either field is absent (the hook's "malformed" branch fails the commit, which
 * the caller maps from this `undefined`). US-CYCLE-011 additively extracts the
 * optional `"mode":"<v>"` scope tag; its absence never changes the ts/tree
 * verdict (a malformed proof is still malformed on ts/tree alone).
 */
export function parseTestPassProof(body: string): TestPassProof | undefined {
  const tsMatch = /"ts":(\d+)/.exec(body);
  const treeMatch = /"tree":"([^"]*)"/.exec(body);
  const modeMatch = /"mode":"([^"]*)"/.exec(body);
  const ts = tsMatch ? Number(tsMatch[1]) : NaN;
  const tree = treeMatch ? (treeMatch[1] ?? "") : "";
  if (!Number.isFinite(ts) || !tsMatch) return undefined;
  if (tree === "" || !treeMatch) return undefined;
  const mode = modeMatch ? (modeMatch[1] ?? "") : undefined;
  return { ts, tree, ...(mode !== undefined && mode !== "" ? { mode } : {}) };
}

// ── Full-verify gate (US-CYCLE-011): round-tail / pre-PR full-suite proof ──────

/**
 * Freshness window (seconds) for the full-verify proof at the PR/publish
 * chokepoint. Deliberately MUCH wider than {@link FRESHNESS_LIMIT_SECONDS} (the
 * 60 s per-commit gate): the round-tail full run is followed by acceptance
 * evidence, capture, and push before the gate reads the proof, so a tight window
 * would false-block honest deliveries. The UNFORGEABLE guard is the tree match
 * (`proof.tree === headTree` ⇒ the full suite ran against EXACTLY the delivered
 * code); freshness is only the secondary anti-replay bound.
 */
export const FULL_VERIFY_LIMIT_SECONDS = 1800;

/** Verdict of the full-verify gate: valid, or blocked with a human reason. */
export type FullVerifyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a `.roll/last-test-pass` proof body constitutes a VALID
 * full-suite verification of the tree being delivered. FAIL-CLOSED at every
 * branch — the only `ok:true` is a proof that PARSES, is `mode:"full"`, whose
 * `tree` equals the delivered `headTree`, and is within `limitSeconds`.
 *
 *   - `proofBody === undefined`      → blocked (no proof: round-tail full never ran)
 *   - proof malformed (ts/tree)      → blocked
 *   - `mode !== "full"`              → blocked (a `--changed` per-commit proof is
 *                                       not a full verify — the backstop AC4 pins)
 *   - `headTree === ""`              → blocked (delivered tree uncomputable ⇒ fail-closed)
 *   - `proof.tree !== headTree`      → blocked (code changed since the full run)
 *   - `now - proof.ts > limit`       → blocked (stale full run)
 *
 * Pure: the proof body, the delivered tree hash, and `now` (epoch seconds) are
 * all injected. `mode` is additive — a legacy proof with no `mode` fails closed.
 */
export function evaluateFullVerify(
  proofBody: string | undefined,
  headTree: string,
  now: number,
  limitSeconds: number = FULL_VERIFY_LIMIT_SECONDS,
): FullVerifyVerdict {
  if (proofBody === undefined) {
    return {
      ok: false,
      reason: "no full-suite test proof (round-tail `roll test` never ran) — a full verify is required before PR",
    };
  }
  // Multi-record guard (does NOT weaken parseTestPassProof / freshnessVerdict):
  // parseTestPassProof runs INDEPENDENT regexes for ts/tree/mode, so a crafted
  // body like `{"mode":"full"}\n{"ts":1000,"tree":"T","mode":"changed"}` would
  // read `mode:"full"` from the first line and ts/tree from the second. The
  // full-verify path demands a SINGLE, clean record — reject any body carrying
  // more than one non-empty line, or a duplicated `"ts":` / `"mode":` field.
  // (This only closes the parse ambiguity; a one-line local proof written by the
  // shell is inherently forgeable — the attest screenshot chain is the real
  // anti-forgery layer, not this file.)
  if (!isSingleRecordProof(proofBody)) {
    return { ok: false, reason: "proof body is not a single well-formed record — refusing an ambiguous full-verify proof" };
  }
  const proof = parseTestPassProof(proofBody);
  if (proof === undefined) {
    return { ok: false, reason: "test-pass proof is malformed — a full verify cannot be confirmed" };
  }
  if (proof.mode !== "full") {
    return {
      ok: false,
      reason: `test-pass proof mode is "${proof.mode ?? "absent"}", not "full" — the per-commit --changed gate is not a full verify; run a full \`roll test\` at round tail`,
    };
  }
  if (headTree === "") {
    return { ok: false, reason: "the delivered tree hash could not be computed — full verify cannot be confirmed (fail-closed)" };
  }
  if (proof.tree !== headTree) {
    return {
      ok: false,
      reason: "full-verify proof tree does not match the delivered tree — code changed since the full run; re-run a full `roll test` at round tail",
    };
  }
  const elapsed = now - proof.ts;
  if (elapsed < 0) {
    return { ok: false, reason: "full-verify proof timestamp is in the future — clock skew or replay; re-run a full `roll test` at round tail" };
  }
  if (elapsed > limitSeconds) {
    return { ok: false, reason: `full-verify proof is stale (${elapsed}s > ${limitSeconds}s) — re-run a full \`roll test\` at round tail` };
  }
  return { ok: true };
}

/**
 * Is the proof body a SINGLE well-formed record? Used only by the full-verify
 * path to reject multi-record ambiguity (see {@link evaluateFullVerify}). True
 * iff the trimmed body has exactly one non-empty line AND at most one `"ts":`
 * and one `"mode":` field. Does not validate the record's contents — that is
 * {@link parseTestPassProof}'s job.
 */
function isSingleRecordProof(body: string): boolean {
  const nonEmptyLines = body.split("\n").filter((l) => l.trim() !== "");
  if (nonEmptyLines.length !== 1) return false;
  if ((body.match(/"ts":/g) ?? []).length > 1) return false;
  if ((body.match(/"tree":/g) ?? []).length > 1) return false;
  if ((body.match(/"mode":/g) ?? []).length > 1) return false;
  return true;
}

/**
 * Boolean form of {@link evaluateFullVerify} (US-CYCLE-011 primitive): `true` IFF
 * the proof parses AND `mode === "full"` AND `tree === headTree` AND it is within
 * the freshness limit. Every other case (missing / malformed / changed-mode /
 * tree-mismatch / stale) is `false` — fail-closed.
 */
export function fullVerifyProofValid(
  proofBody: string | undefined,
  headTree: string,
  now: number,
  limitSeconds?: number,
): boolean {
  return evaluateFullVerify(proofBody, headTree, now, limitSeconds).ok;
}

/**
 * Is a staged-file set docs-only (exempt from the TCR gate)? Mirrors the hook's
 * `_docs_only` (hooks/pre-commit):
 *   - `docs/*` and `guide/*`          → exempt (nested narrative docs).
 *   - any OTHER nested path (`*​/​*`)  → NOT docs-only (code/contract).
 *   - root-level `*.md`               → exempt.
 *   - any other root-level file       → NOT docs-only.
 *   - empty staged set                → NOT docs-only (the hook returns 1).
 * A single non-exempt path re-arms the full gate.
 */
export function isDocsOnlyCommit(stagedFiles: readonly string[]): boolean {
  let had = false;
  for (const raw of stagedFiles) {
    const f = raw;
    if (f === "") continue;
    had = true;
    if (f.startsWith("docs/") || f.startsWith("guide/")) continue; // nested docs — exempt
    if (f.includes("/")) return false; // any other nested path — code/contract
    if (/\.md$/.test(f)) continue; // root-level markdown — exempt
    return false; // root-level non-markdown — code
  }
  return had;
}

/** The freshness-gate decision (mirrors the hook's exit codes as reasons). */
export type FreshnessVerdict =
  | { allowed: true; reason: "docs-only" | "fresh" }
  | { allowed: false; reason: "no-proof" | "malformed-proof" | "stale" | "tree-changed"; elapsed?: number };

/** Inputs for the freshness gate decision. */
export interface FreshnessInput {
  /** Staged paths (`git diff --cached --name-only`). */
  stagedFiles: readonly string[];
  /** The proof file body, or `undefined` when `.roll/last-test-pass` is absent. */
  proofBody?: string;
  /** Current unix epoch seconds (`date +%s`). */
  now: number;
  /** Current tree hash (`git write-tree`). */
  currentTree: string;
  /** Freshness window override (default {@link FRESHNESS_LIMIT_SECONDS}). */
  limitSeconds?: number;
}

/**
 * Decide whether the pre-commit gate ALLOWS this commit, mirroring the control
 * flow of hooks/pre-commit:
 *   1. docs-only staged set            → allow ("docs-only").
 *   2. no proof file                   → block ("no-proof").
 *   3. proof malformed (ts/tree absent)→ block ("malformed-proof").
 *   4. `now - ts > limit`              → block ("stale", elapsed).
 *   5. proof.tree !== currentTree      → block ("tree-changed").
 *   6. otherwise                       → allow ("fresh").
 * Pure: `now`, `currentTree`, the proof body, and the staged list are injected.
 */
export function freshnessVerdict(input: FreshnessInput): FreshnessVerdict {
  if (isDocsOnlyCommit(input.stagedFiles)) return { allowed: true, reason: "docs-only" };

  if (input.proofBody === undefined) return { allowed: false, reason: "no-proof" };
  const proof = parseTestPassProof(input.proofBody);
  if (proof === undefined) return { allowed: false, reason: "malformed-proof" };

  const limit = input.limitSeconds ?? FRESHNESS_LIMIT_SECONDS;
  const elapsed = input.now - proof.ts;
  if (elapsed > limit) return { allowed: false, reason: "stale", elapsed };

  if (proof.tree !== input.currentTree) return { allowed: false, reason: "tree-changed" };

  return { allowed: true, reason: "fresh" };
}
