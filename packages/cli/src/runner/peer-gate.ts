/**
 * FIX-150b / FIX-293 — the peer HARD-trigger gate.
 *
 * v2's peer review was a skill-text suggestion: nothing enforced it, non-claude
 * cycle agents never saw it, and skips left zero trace (owner audit 2026-05-31:
 * memory said 3-4+ consults, disk had 2). This module turns the trigger into a
 * RUNTIME MECHANISM that runs inside every cycle's capture step, agent-agnostic:
 *
 *   high-complexity delivery  AND  no peer evidence
 *     ⇒ ALERT + a `peer:gate` event in events.ndjson (auditable forever).
 *
 * FIX-293 — the gate now has TEETH. It used to be SOFT (record, don't block) and
 * its verdict was DISCARDED by the executor, so a high-complexity cycle with NO
 * peer review still silently fell back to a self-grade and flipped the card Done —
 * degrading the standard exactly when peer review matters most (FIX-284). The
 * owner decision: a high-complexity delivery with no peer evidence MUST NOT
 * self-grade. The gate is now HARD by default — it BLOCKS the delivery and the
 * executor RE-ATTEMPTS the peer consultation ONCE (bounded; the existing peer
 * 30s hard timeout is respected so a flaky peer like pi can't death-spiral the
 * cycle). If the retry produces evidence → proceed; if it still yields none →
 * stay blocked, escalate via ALERT, and the cycle ends NOT-Done.
 *
 * `loop_safety.peer_gate: soft` in policy.yaml keeps the old record-only
 * behaviour for an explicit migration window; absent ⇒ hard (the owner default).
 *
 * FIX-312 — the gate is now HETERO-AVAILABILITY-aware (owner ruling 2026-06-15:
 * "hetero available → must use it; self only when hetero is truly impossible").
 * When a heterogeneous (different-vendor) peer is GENUINELY available, the hard
 * enforcement extends to ALL substantive deliveries — not just high-complexity:
 * any non-empty cycle that ships with NO peer evidence (it self-reviewed while
 * hetero was available) is a VIOLATION and is BLOCKED (ALERT, not-Done). When
 * hetero is genuinely UNAVAILABLE (single-agent / single-vendor setup),
 * self-review is an ALLOWED, RECORDED fallback — the gate records a
 * `self_review_fallback` verdict with a reason and NEVER blocks (the self path is
 * preserved for future single-agent users, never hard-removed). `heteroAvailable`
 * is computed uniformly by vendor through the standard model — NO per-agent
 * hardcoding (roll core thesis).
 *
 * Complexity is deterministic and cheap — `git diff --name-only` of the cycle
 * branch vs origin/main in the worktree:
 *   - more than 3 files changed, or
 *   - 2+ distinct `packages/<name>` touched (cross-module), or
 *   - any high-risk path (CI workflows, infra git/github/process seams).
 * Complexity still drives the *reason* detail; FIX-312 makes hetero-availability
 * (not complexity alone) the switch that turns the hard block on for EVERY
 * substantive delivery.
 *
 * Peer evidence contract (FIX-150a alignment): a per-cycle evidence file at
 * `<rt>/peer/cycle-<cycleId>.*` (md/json), written by the roll-peer skill, the
 * pairing gate, or any consult wrapper. Presence = consulted; absence on a
 * gated delivery = "skipped" verdict.
 */
import { parsePolicy } from "@roll/core";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ComplexityVerdict {
  high: boolean;
  /** Human-readable reasons (empty when not high). */
  reasons: string[];
  files: string[];
}

/** High-risk paths: changes here always warrant a second pair of eyes. */
const HIGH_RISK = [/^\.github\/workflows\//, /^packages\/infra\/src\/(git|github|process)\.ts$/];

/** Pure classifier — exported for table-driven tests. */
export function assessComplexity(files: string[]): ComplexityVerdict {
  const reasons: string[] = [];
  if (files.length > 3) reasons.push(`${files.length} files (>3)`);
  const pkgs = new Set<string>();
  for (const f of files) {
    const m = /^packages\/([^/]+)\//.exec(f);
    if (m?.[1] !== undefined) pkgs.add(m[1]);
  }
  if (pkgs.size >= 2) reasons.push(`cross-module: ${[...pkgs].sort().join(",")}`);
  const risky = files.filter((f) => HIGH_RISK.some((re) => re.test(f)));
  if (risky.length > 0) reasons.push(`high-risk: ${risky.join(",")}`);
  return { high: reasons.length > 0, reasons, files };
}

/** Changed files of the cycle branch vs origin/main (worktree cwd). */
export async function cycleChangedFiles(worktreeCwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "origin/main...HEAD"],
      { cwd: worktreeCwd, encoding: "utf8" },
    );
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  } catch {
    return []; // no refs / not a repo → gate stays silent (never fails a cycle)
  }
}

/** Evidence: any `<rt>/peer/cycle-<cycleId>.*` file. */
export function peerEvidencePresent(runtimeDir: string, cycleId: string): boolean {
  const dir = join(runtimeDir, "peer");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.startsWith(`cycle-${cycleId}.`));
  } catch {
    return false;
  }
}

export type PeerGateMode = "soft" | "hard";

export interface PeerGateResult {
  /** FIX-312 adds `self-review-allowed` — a substantive delivery that shipped
   *  with no peer evidence BUT no heterogeneous peer was available, so self-review
   *  is the recorded (non-blocking) fallback. */
  verdict: "consulted" | "skipped" | "not-required" | "self-review-allowed";
  mode: PeerGateMode;
  reasons: string[];
  /** true ONLY when mode==="hard" && verdict==="skipped" — the delivery is
   *  blocked (a substantive delivery shipped with no peer review while a
   *  heterogeneous peer WAS available). The executor consumes this: it
   *  re-attempts the consult once and, if still blocked, fails the capture so the
   *  story is NOT marked Done. Never set when hetero is unavailable. */
  blocked: boolean;
  /** FIX-312 — was a heterogeneous (different-vendor) peer available for this
   *  cycle's builder? Drives the decision: true ⇒ self-review is a violation
   *  (block); false ⇒ self-review is an allowed recorded fallback. undefined when
   *  the caller did not supply availability (legacy/complexity-only path). */
  heteroAvailable?: boolean;
}

export interface PeerGateSinks {
  alert: (message: string) => void;
  event: (payload: { cycleId: string; verdict: string; reasons: string[] }) => void;
}

/** FIX-312 — optional hetero-availability input to {@link runPeerGate}. */
export interface PeerGateOptions {
  /** Is a heterogeneous (different-vendor) peer GENUINELY available for the
   *  builder? Compute via `heteroAvailable(installed, workingAgent)` from
   *  @roll/core (vendor-based, agent-agnostic). When omitted the gate keeps the
   *  legacy complexity-only behaviour (high-complexity + no evidence ⇒ block). */
  heteroAvailable?: boolean;
  /** Workspace cycles aggregate changed files across repository legs. */
  changedFiles?: (worktreeCwd: string) => Promise<string[]>;
}

/** Read `loop_safety.peer_gate` from `<repoCwd>/.roll/policy.yaml`; default hard.
 *  FIX-293: the owner default is hard (block + retry); an explicit `soft` keeps
 *  the legacy record-only behaviour. Mirrors {@link readAttestGateMode}. */
export function readPeerGateMode(repoCwd: string): PeerGateMode {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return "hard";
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.peerGate === "soft" ? "soft" : "hard";
  } catch {
    return "hard"; // unreadable / unparseable policy → fail closed (block)
  }
}

/** FIX-1234 — `loop_safety.peer_on_pool_timeout` from `<repoCwd>/.roll/policy.yaml`.
 *  Default `block` (FIX-312 owner ruling: hetero available + no evidence ⇒
 *  NOT-Done). `degrade` is the explicit per-project opt-in for small/flaky
 *  pools where a timeout-class pool failure would otherwise deadlock every
 *  delivery: the cycle records `peer_unavailable` evidence and falls back to
 *  the recorded self-review verdict. Fail-closed on unreadable policy. */
export function readPeerOnPoolTimeout(repoCwd: string): "block" | "degrade" {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return "block";
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.peerOnPoolTimeout === "degrade" ? "degrade" : "block";
  } catch {
    return "block";
  }
}

/**
 * Run the gate for one cycle. Pure decision + sink side-effects; never throws.
 * Returns the verdict + `blocked` so callers/tests can assert without the sinks.
 *
 * FIX-293: when `mode === "hard"` (the default), a high-complexity delivery with
 * no peer evidence is `blocked`. The soft mode records the same `skipped` verdict
 * but never blocks (explicit migration window).
 *
 * FIX-312: when `opts.heteroAvailable` is supplied, hetero-availability drives the
 * decision (owner ruling: "hetero available → must use it; self only when hetero
 * is truly impossible"):
 *   - heteroAvailable === true  → the hard block extends to ALL substantive
 *     (non-empty) deliveries, not just high-complexity. No peer evidence here
 *     means the cycle self-reviewed while a hetero peer was available — a
 *     VIOLATION → blocked (hard mode) + ALERT.
 *   - heteroAvailable === false → self-review is an ALLOWED recorded fallback:
 *     verdict `self-review-allowed`, a `peer:gate` event with the reason, and the
 *     gate NEVER blocks (the self path is preserved for single-agent setups).
 * When `opts.heteroAvailable` is undefined the gate keeps the legacy
 * complexity-only behaviour (back-compat for callers/tests that don't pass it).
 */
export async function runPeerGate(
  worktreeCwd: string,
  runtimeDir: string,
  cycleId: string,
  mode: PeerGateMode,
  sinks: PeerGateSinks,
  opts: PeerGateOptions = {},
): Promise<PeerGateResult> {
  try {
    const files = await (opts.changedFiles ?? cycleChangedFiles)(worktreeCwd);
    const cx = assessComplexity(files);
    const { heteroAvailable } = opts;

    // Nothing substantive shipped → never gated.
    if (files.length === 0) return { verdict: "not-required", mode, reasons: [], blocked: false, ...(heteroAvailable !== undefined ? { heteroAvailable } : {}) };

    // FIX-312: when hetero-availability is known, IT is the switch (not complexity
    // alone). A substantive delivery with no peer evidence is gated whenever a
    // hetero peer was available; otherwise (no hetero) self-review is allowed.
    // When availability is unknown, fall back to the legacy complexity-only gate.
    const gated = heteroAvailable === true ? true : heteroAvailable === false ? false : cx.high;

    if (heteroAvailable === false) {
      // No heterogeneous peer to consult → self-review is the ALLOWED fallback.
      // Record it (never silent), but NEVER block and NEVER remove the self path.
      if (peerEvidencePresent(runtimeDir, cycleId)) {
        sinks.event({ cycleId, verdict: "consulted", reasons: cx.reasons });
        return { verdict: "consulted", mode, reasons: cx.reasons, blocked: false, heteroAvailable };
      }
      const reasons = ["self_review_fallback: no heterogeneous (different-vendor) peer available", ...cx.reasons];
      sinks.alert(`peer gate (${mode}): self-review fallback — no heterogeneous peer available; recorded (not blocked) — cycle ${cycleId}`);
      sinks.event({ cycleId, verdict: "self-review-allowed", reasons });
      return { verdict: "self-review-allowed", mode, reasons, blocked: false, heteroAvailable };
    }

    if (!gated) return { verdict: "not-required", mode, reasons: [], blocked: false, ...(heteroAvailable !== undefined ? { heteroAvailable } : {}) };

    if (peerEvidencePresent(runtimeDir, cycleId)) {
      sinks.event({ cycleId, verdict: "consulted", reasons: cx.reasons });
      return { verdict: "consulted", mode, reasons: cx.reasons, blocked: false, ...(heteroAvailable !== undefined ? { heteroAvailable } : {}) };
    }

    // No peer evidence on a gated delivery. With a hetero peer available this is a
    // self-review violation; legacy path keeps the high-complexity framing.
    const blocked = mode === "hard";
    const why = heteroAvailable === true
      ? `substantive delivery self-reviewed while a heterogeneous peer was available${cx.reasons.length > 0 ? ` (${cx.reasons.join("; ")})` : ""}`
      : `high-complexity work without peer review (${cx.reasons.join("; ")})`;
    sinks.alert(
      `peer gate (${mode}): ${why} — cycle ${cycleId}` +
        (blocked ? " — retrying the consult; story not marked Done unless peer evidence is produced" : ""),
    );
    const reasons = heteroAvailable === true ? ["hetero_available_self_review_violation", ...cx.reasons] : cx.reasons;
    sinks.event({ cycleId, verdict: "skipped", reasons });
    return { verdict: "skipped", mode, reasons, blocked, ...(heteroAvailable !== undefined ? { heteroAvailable } : {}) };
  } catch {
    return { verdict: "not-required", mode, reasons: [], blocked: false }; // gate must never fail the cycle by surprise
  }
}
