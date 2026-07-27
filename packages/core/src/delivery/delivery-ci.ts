/**
 * US-EVID-033 — card-level delivery-time CI truth (PURE classification).
 *
 * The legacy `ci` lane in an evidence manifest is `gh run list --limit 1` — the
 * repository's most recent workflow run, related to the card only by accident.
 * That made a card's CI evidence unownable: a card whose attest never ran (a
 * supervised/manual delivery, or an attest bug like FIX-1483) had NO honest way
 * to ever earn evidence, because re-running the test command later proves
 * nothing about the delivery (with an unchanged tree `roll test --affected`
 * matches zero tests and "passes" in seconds).
 *
 * The delivery-time truth is already recorded: THIS card's PR ran the required
 * checks at a specific head sha before it merged. This module classifies that
 * fact and nothing else. Three honest states, no fourth:
 *   - `verified` — the PR is MERGED, its merge sha agrees with the ledger, the
 *     check list is COMPLETE, and every check concluded `success`;
 *   - `red`      — at least one check failed (terminal: never downgraded, never
 *                  hidden behind a still-running or missing check);
 *   - `unknown`  — anything else, always with a recorded reason.
 * Nothing is ever synthesized, and every doubt resolves to `unknown` — the one
 * state that cannot be mistaken for acceptance.
 *
 * Codex review r1 closed five ways a `verified` could have been wrong: an
 * unpaginated check list hiding a red beyond page 1, an open/other PR, `neutral`
 * and `skipped` counted as green executions, a defeatable post-hoc label, and an
 * unvalidated API target able to misattribute another repo's checks. Review r2
 * closed two more: the checks endpoint reports the CURRENT run per name, so a
 * post-merge rerun could replace a delivery-time red with a green (a green must
 * now demonstrably predate the merge); and verifying only the visible checks let a
 * merged PR pass on one optional green while the REQUIRED check was absent.
 * Review r3 closed three more: an observed red hidden behind an incomplete list,
 * an app-pinned required context satisfied by another App's same-named check, and
 * repository/org RULESETS ignored when branch protection reports "not protected".
 *
 * TWO LIMITATIONS ARE RECORDED RATHER THAN HIDDEN (codex r3):
 *   - GitHub exposes only the CURRENT requirement configuration, so a requirement
 *     relaxed after the merge cannot be detected; the fact records WHICH surface
 *     was consulted (`requiredChecksSource`) and never claims it is historical.
 *   - Merge-queue repositories run required checks on the synthetic merge-group
 *     sha, not the PR head sha. Such deliveries are DETECTED (the queue bot is the
 *     merger) and resolve to `unknown:merge_queue_delivery` — the safe direction;
 *     reading merge-group checks is not built speculatively.
 */

/** One check run's conclusion as reported by the forge (check-runs + statuses). */
export interface DeliveryCheckRun {
  name: string;
  /** `success` | `failure` | `neutral` | `cancelled` | `skipped` | `timed_out` | `action_required` | `startup_failure` | "" (still running). */
  conclusion: string;
  /**
   * The GitHub App that produced this check, when reported. Codex review r3: an
   * app-pinned required context is only satisfied by a check from THAT app — a
   * same-named check from another app must not stand in for it.
   */
  appId?: number | undefined;
  /**
   * Epoch ms the check finished, when the forge reported it. Codex review r2: the
   * checks endpoint returns the CURRENT run per name, so a post-merge rerun can
   * replace a delivery-time red with a green. A success only counts as
   * delivery-time evidence when it demonstrably finished BEFORE the merge.
   */
  completedAtMs?: number | undefined;
}

/** The card's delivery record, projected from the delivery ledger. */
export interface DeliveryCiRecord {
  prNumber?: number | undefined;
  /** The merge commit the LEDGER claims for this card (short or full sha). */
  mergeCommit?: string | undefined;
  headSha?: string | undefined;
  /** Epoch ms the PR merged, when known. */
  mergedAtMs?: number | undefined;
}

/** PR-level facts read from the forge. `undefined` ⇒ never successfully read. */
export interface DeliveryPrFacts {
  merged: boolean;
  /** The forge's merge commit sha — must agree with the ledger's claim. */
  mergeCommitSha?: string | undefined;
  headSha?: string | undefined;
  mergedAtMs?: number | undefined;
}

/** Tri-state: a timing we cannot establish is stated as `unknown`, never as `no`. */
export type PostHocState = "yes" | "no" | "unknown";

/** A required check context, optionally pinned to the App that must produce it. */
export interface RequiredCheck {
  context: string;
  appId?: number | undefined;
}

/**
 * Where the required-check set came from — recorded so a reader can judge the
 * fact's strength. `protection` / `ruleset` are declared requirements;
 * `none_declared` means neither surface declares any (every observed check must
 * then be green); `unknown` means the requirement set could not be read at all.
 *
 * KNOWN LIMITATION (codex r3, recorded not hidden): GitHub exposes only the
 * CURRENT requirement configuration — there is no API for the configuration as it
 * stood at merge time. A requirement relaxed after the merge is therefore
 * invisible here. The field lets a reader see which surface was consulted; it does
 * not claim the configuration is the historical one.
 */
export type RequiredChecksSource = "protection" | "ruleset" | "protection+ruleset" | "none_declared" | "unknown";

export interface DeliveryCiFact {
  state: "verified" | "red" | "unknown";
  /** Why the state is not `verified` — always present for red/unknown. */
  reason?: string;
  prNumber?: number;
  headSha?: string;
  mergeCommit?: string;
  /** ISO merge time when known. */
  mergedAt?: string;
  /** ISO time this fact was collected. */
  collectedAt: string;
  /**
   * Whether the fact was collected AFTER the card merged — i.e. whether the
   * report is a post-hoc reconstruction of delivery-time truth rather than
   * cycle-time evidence. `unknown` when the merge time could not be established
   * (never silently rendered as cycle-time).
   */
  postHoc: PostHocState;
  checks: DeliveryCheckRun[];
  /** Which surface declared the required checks (see {@link RequiredChecksSource}). */
  requiredChecksSource?: RequiredChecksSource;
  /** The required contexts this verdict was measured against. */
  requiredChecks?: RequiredCheck[];
}

/**
 * ONLY a real successful execution verifies. `neutral` / `skipped` are not green
 * executions (codex r1) — they resolve to `unknown`, never to acceptance.
 */
const PASSING = new Set(["success"]);
/** Conclusions that are unambiguously a failure. */
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** Guard the API target so a malformed ledger value cannot reroute the query. */
export function isValidCiTarget(target: { repoSlug?: string; prNumber?: number; sha?: string }): boolean {
  if (target.repoSlug !== undefined && !SLUG_RE.test(target.repoSlug)) return false;
  if (target.prNumber !== undefined && (!Number.isInteger(target.prNumber) || target.prNumber <= 0)) return false;
  if (target.sha !== undefined && !SHA_RE.test(target.sha)) return false;
  return true;
}

/** Two sha claims agree when one is a prefix of the other (ledger may be short). */
export function shaAgrees(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === "" || b === "") return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export interface ResolveDeliveryCiInput {
  record?: DeliveryCiRecord | undefined;
  /** PR facts from the forge; `undefined` ⇒ the PR could not be read. */
  pr?: DeliveryPrFacts | undefined;
  /** `undefined` ⇒ the checks query itself could not be made (never "no checks"). */
  checks?: readonly DeliveryCheckRun[] | undefined;
  /**
   * Whether the check list is known COMPLETE (every page + the legacy commit
   * statuses read). `false` ⇒ a red could be hiding outside the window, so the
   * fact degrades to `unknown` (codex r1).
   */
  checksComplete?: boolean | undefined;
  ghAvailable: boolean;
  /**
   * The base branch's REQUIRED check contexts (branch protection or a ruleset).
   * Codex review r2: verifying only the checks that happen to be visible lets a
   * merged PR with one optional green check (and the required check absent) read
   * as verified.
   */
  requiredChecks?: readonly RequiredCheck[] | undefined;
  /** Which surface the required set came from, recorded into the fact. */
  requiredChecksSource?: RequiredChecksSource | undefined;
  /**
   * Whether the required-check set is KNOWN. `false` ⇒ the branch protection could
   * not be read, so what "green" even means is unestablished ⇒ unknown. An
   * unprotected branch is `true` with an empty set (a real answer, not a failure).
   */
  requiredChecksKnown?: boolean | undefined;
  /**
   * True when the PR was merged by the merge queue. Codex review r4: a queue
   * delivery runs its required checks on the synthetic merge-group sha, not this
   * PR's head, so the head's checks are NOT the delivery's checks — refuse rather
   * than verify against the wrong sha.
   */
  mergedByQueue?: boolean | undefined;
  /** Caller-side validation of slug/pr/sha; `false` ⇒ refuse to attribute. */
  targetValid?: boolean | undefined;
  /** ISO timestamp of this collection. */
  collectedAt: string;
}

/**
 * Collapse a check list to the LATEST entry per identity (name + App). The commit
 * statuses endpoint returns the full HISTORY per context, newest first (codex r5):
 * without this, an older `success` for a required context could satisfy the
 * requirement while a newer `pending` for the same context is the real state.
 * Later timestamp wins; with no timestamps the FIRST occurrence wins (the forge's
 * newest-first order).
 */
export function collapseLatestChecks(checks: readonly DeliveryCheckRun[]): DeliveryCheckRun[] {
  const latest = new Map<string, DeliveryCheckRun>();
  for (const c of checks) {
    const key = `${c.name}\u0000${c.appId ?? ""}`;
    const seen = latest.get(key);
    if (seen === undefined) {
      latest.set(key, c);
      continue;
    }
    const a = seen.completedAtMs;
    const b = c.completedAtMs;
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) {
      if (b > a) latest.set(key, c);
    } else if (a === undefined && b !== undefined) {
      // A timestamped entry is more informative than an untimed one, but it may be
      // OLDER; keeping the untimed one would claim a state we cannot place in time,
      // so prefer neither — mark the identity untimed by keeping the first.
      latest.set(key, { ...seen, conclusion: seen.conclusion });
    }
  }
  return [...latest.values()];
}

export function resolveDeliveryCi(input: ResolveDeliveryCiInput): DeliveryCiFact {
  const rec = input.record;
  const mergedAtMs = input.pr?.mergedAtMs ?? rec?.mergedAtMs;
  const collectedMs = Date.parse(input.collectedAt);
  const headSha = input.pr?.headSha ?? rec?.headSha;
  const postHoc: PostHocState =
    mergedAtMs !== undefined && Number.isFinite(mergedAtMs) && Number.isFinite(collectedMs)
      ? collectedMs > mergedAtMs
        ? "yes"
        : "no"
      : "unknown";
  const base: DeliveryCiFact = {
    state: "unknown",
    collectedAt: input.collectedAt,
    postHoc,
    checks: [],
    ...(rec?.prNumber !== undefined ? { prNumber: rec.prNumber } : {}),
    ...(headSha !== undefined && headSha !== "" ? { headSha } : {}),
    ...(rec?.mergeCommit !== undefined && rec.mergeCommit !== "" ? { mergeCommit: rec.mergeCommit } : {}),
    ...(mergedAtMs !== undefined && Number.isFinite(mergedAtMs)
      ? { mergedAt: new Date(mergedAtMs).toISOString() }
      : {}),
  };

  if (rec === undefined || rec.prNumber === undefined) return { ...base, reason: "no_delivery_record" };
  // A card that claims delivery without a merge commit has nothing to bind the
  // PR's checks to — refuse rather than trust the PR number alone.
  if (rec.mergeCommit === undefined || rec.mergeCommit === "") return { ...base, reason: "no_merge_commit" };
  if (!input.ghAvailable) return { ...base, reason: "gh_unavailable" };
  if (input.targetValid === false) return { ...base, reason: "invalid_target" };
  if (input.pr === undefined) return { ...base, reason: "pr_unavailable" };
  if (!input.pr.merged) return { ...base, reason: "pr_not_merged" };
  // The forge's merge sha must be the one the ledger credits to this card;
  // otherwise these checks belong to some other delivery.
  if (!shaAgrees(input.pr.mergeCommitSha, rec.mergeCommit)) return { ...base, reason: "merge_sha_mismatch" };
  if (input.mergedByQueue === true) return { ...base, reason: "merge_queue_delivery" };
  if (input.checks === undefined) return { ...base, reason: "checks_unavailable" };

  // Collapse history to the latest state per identity BEFORE any classification
  // (codex r5) — an old success must never satisfy a requirement whose current
  // state is pending.
  const checks = collapseLatestChecks(input.checks);
  // A failure is terminal and is scanned FIRST — before the completeness and
  // requirement gates (codex r3). A red that WAS read must never be swallowed by
  // "the list might be incomplete"; incompleteness can only ever downgrade a
  // would-be pass, never hide an observed failure.
  const failed = checks.filter((c) => FAILING.has(c.conclusion));
  if (failed.length > 0) {
    return { ...base, state: "red", reason: `checks_failed:${failed.map((c) => c.name).join(",")}`, checks };
  }
  if (input.checksComplete === false) return { ...base, reason: "checks_list_incomplete", checks };
  if (checks.length === 0) return { ...base, reason: "no_checks_on_head_sha", checks };

  // Without a merge time there is no boundary between delivery-time evidence and
  // a later rerun, so nothing can be verified (codex r2).
  if (mergedAtMs === undefined || !Number.isFinite(mergedAtMs)) {
    return { ...base, reason: "merge_time_unknown", checks };
  }
  // What counts as green is the BRANCH's required set, not whatever happened to
  // be visible. An unreadable protection config leaves that undefined.
  if (input.requiredChecksKnown !== true) {
    return { ...base, reason: "required_checks_unknown", checks, requiredChecksSource: "unknown" };
  }
  const required = [...(input.requiredChecks ?? [])];
  const provenance = {
    requiredChecksSource: input.requiredChecksSource ?? (required.length > 0 ? "protection" : "none_declared"),
    ...(required.length > 0 ? { requiredChecks: required } : {}),
  } as const;
  // App-pinned identity (codex r3): a required context is satisfied only by a
  // successful check with that name AND, when the requirement pins an App, from
  // that App.
  const satisfies = (req: RequiredCheck): DeliveryCheckRun | undefined =>
    checks.find(
      (c) => c.name === req.context && (req.appId === undefined || c.appId === req.appId) && PASSING.has(c.conclusion),
    );
  const missing = required.filter((req) => satisfies(req) === undefined);
  if (missing.length > 0) {
    return {
      ...base,
      ...provenance,
      reason: `required_missing:${missing.map((r) => (r.appId !== undefined ? `${r.context}@app${r.appId}` : r.context)).join(",")}`,
      checks,
    };
  }

  // Evidence set: the required checks when the branch declares them, otherwise
  // every observed check (nothing declared ⇒ best available truth).
  const evidence = required.length > 0 ? required.map((req) => satisfies(req)!) : checks;
  const unproven = evidence.filter((c) => !PASSING.has(c.conclusion));
  if (unproven.length > 0) {
    return {
      ...base,
      ...provenance,
      reason: `checks_inconclusive:${unproven.map((c) => `${c.name}=${c.conclusion === "" ? "running" : c.conclusion}`).join(",")}`,
      checks,
    };
  }
  // Each green must be a DELIVERY-TIME green: finished, with a known finish time,
  // before the merge. A rerun that turned a red into a green after the merge is
  // not evidence the delivery was ever green.
  const untimed = evidence.filter((c) => c.completedAtMs === undefined || !Number.isFinite(c.completedAtMs));
  if (untimed.length > 0) {
    return { ...base, ...provenance, reason: `check_time_unknown:${untimed.map((c) => c.name).join(",")}`, checks };
  }
  const afterMerge = evidence.filter((c) => (c.completedAtMs as number) > mergedAtMs);
  if (afterMerge.length > 0) {
    return { ...base, ...provenance, reason: `checks_after_merge:${afterMerge.map((c) => c.name).join(",")}`, checks };
  }
  return { ...base, ...provenance, state: "verified", checks };
}

/** One-line human summary for the report/terminal (bilingual callers wrap it). */
export function deliveryCiSummary(fact: DeliveryCiFact): string {
  const pr = fact.prNumber !== undefined ? `#${fact.prNumber}` : "no PR";
  const sha = fact.headSha !== undefined ? fact.headSha.slice(0, 8) : "no sha";
  const names = fact.checks.map((c) => `${c.name}=${c.conclusion || "running"}`).join(" ");
  return `${fact.state} ${pr}@${sha}${fact.reason !== undefined ? ` (${fact.reason})` : ""}${names !== "" ? ` — ${names}` : ""}`;
}
