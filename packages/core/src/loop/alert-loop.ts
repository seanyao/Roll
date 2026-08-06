/**
 * @responsibility Decides alert file mechanics: append, dedup, consume and notify.
 * Alert Loop — pure decision layer for ALERT file mechanics: append, dedup,
 * consume, and the notify push (US-LOOP-005 / v2 US-AUTO-046, US-LOOP-062a,
 * FIX-065/151).
 *
 * ─── v2 archaeology (verify, don't assume) ──────────────────────────────────
 * v2 retired the standalone alert loop (FIX-195): ALERT is a FILE + a `_notify`
 * mechanism, not a scheduled agent loop. Two file shapes coexist TODAY in
 * bin/roll, and this module mirrors the current consumption of BOTH:
 *
 *   (1) the ACTIVE alert file `$_LOOP_ALERT` (= `<rt_dir>/ALERT-<slug>.md`,
 *       bin/roll 7316 / 8808). Failure paths WRITE it two ways:
 *         - whole-file `cat > $_LOOP_ALERT <<EOF` blocks for fatal cycle errors
 *           (precheck red 11281, CI gate 11427, TCR fail 11612, rebase circuit
 *           11809) — these REPLACE the file with a markdown report;
 *         - APPEND lines `printf … >> $_LOOP_ALERT` for the streaming, dedup-aware
 *           cases (`_worktree_alert` 12748, `_loop_pr_ci_red_alert` 11456,
 *           fork-PR 11894, self-downgrade 12357). The dedup-aware appenders grep
 *           the file for a stable key FIRST and skip if present (US-LOOP-062a,
 *           bin/roll 11455). {@link alertAppendDecision} ports that.
 *       It is CONSUMED by `cmd_alert` (bin/roll 14056-14104): `list` reads it,
 *       `ack` appends an acknowledgement footer, `resolve`/`clear` removes it.
 *       {@link alertConsumeAction} ports the subcommand decision.
 *
 *   (2) the consumption HISTORY `alert-log.jsonl` (= `.roll/state/alert-log.jsonl`,
 *       bin/roll 12246-12249). The Alert Loop dispatcher records one JSON line
 *       per processed alert with `{recorded_at|ts, notified, level, category,
 *       message}` (the fields `_alert_log` reads, bin/roll 14139-14146).
 *       `notified` is the ●/○ glyph driver: ● = pushed via the notify channel,
 *       ○ = throttled/deduped. The DISPATCHER that writes these rows (and runs
 *       `_notify`) lives in the PRIVATE roll-meta ops layer — NOT in this bash
 *       checkout — so, like the push-script transport, the record-WRITE
 *       transport is out of scope; what IS here, and what this module ports, is
 *       the DECISION layer: the dedup key, the notify-vs-throttle verdict, the
 *       record shape, and the `_notify` gate ladder.
 *
 *   `_notify` (bin/roll 10870-10877): the macOS push channel — Darwin only,
 *   suppressed by the mute file, requires `osascript`. {@link notifyVerdict}.
 *
 * ─── D3 (the documented v3 evolution path — read-only reference) ─────────────
 * The v3 invariants doc D3 ("完成信号 ≠ 健康信号；状态分三层") notes that TODAY's
 * ALERT is "一物三用" — overloaded as protocol carrier + health gate + outward
 * signal (the FIX-065 self-eating-cycle root cause: a test could write the prod
 * ALERT file and scare the running cycle into stopping). The v3 target SPLITS
 * these into three layers: ① protocol carrier (signed, on-disk) ② health gate
 * (never persisted, untouchable by tests) ③ outward signal (written only by the
 * cycle controller). This module implements consumption decisions per the
 * CURRENT (overloaded) file shape — the contract the v2 oracle defines — and
 * leaves the three-layer split as the documented evolution path. See
 * /Users/seanyao/Workspace/roll/.roll/v3/build/invariants.md D3 (frozen ref).
 *
 * Purity: no spawn, no clock, no fs. Timestamps + Darwin/mute/osascript facts
 * are injected.
 */

// ── alert file path (mirrors $_LOOP_ALERT derivation, bin/roll 7316 / 8808) ──

/**
 * The active-alert file name for a slug — `ALERT-<slug>.md` (bin/roll 8808).
 * The directory (rt_dir vs shared root) is the adapter's; this is the pure
 * basename the path-builder appends. Exposed so a caller derives the same name
 * the oracle's `_LOOP_ALERT` resolves to.
 */
export function alertFileName(slug: string): string {
  return `ALERT-${slug}.md`;
}

/** The consumption-history file path (relative) — bin/roll 12247-12249. */
export const ALERT_LOG_RELATIVE_PATH = ".roll/state/alert-log.jsonl";

// ── dedup-aware append (mirrors _loop_pr_ci_red_alert grep gate, 11455) ──────

/** The append decision for a dedup-aware ALERT line. */
export type AlertAppendDecision =
  | { kind: "append"; line: string } // key absent → append this line.
  | { kind: "skip"; reason: "duplicate" }; // key already present → no-op.

/**
 * Decide whether to append a dedup-aware ALERT line — mirrors the
 * `grep -qF "<key>" && return 0` gate the streaming appenders use (US-LOOP-062a,
 * bin/roll 11455). If `dedupKey` already occurs in the current file contents,
 * skip (one line per key until the file is consumed — "never silently drops" is
 * satisfied because the key persists until `resolve`); otherwise append `line`.
 *
 * @param currentContents the active alert file's full text ("" when absent).
 * @param dedupKey the stable substring that identifies this alert (e.g.
 *   `[TYPE:loop-pr-ci-red] PR #123 ` from ci-loop.ts {@link ciRedAlertDedupKey}).
 * @param line the fully-formatted line to append when not a duplicate.
 */
export function alertAppendDecision(
  currentContents: string,
  dedupKey: string,
  line: string,
): AlertAppendDecision {
  if (currentContents.includes(dedupKey)) {
    return { kind: "skip", reason: "duplicate" };
  }
  return { kind: "append", line };
}

/**
 * Format a `_worktree_alert`-style timestamped append line — mirrors
 * bin/roll 12748 `printf '[%s] worktree: %s\n'`. `ts` is the injected
 * `date -u +%FT%TZ`.
 */
export function worktreeAlertLine(ts: string, message: string): string {
  return `[${ts}] worktree: ${message}`;
}

// ── consume (mirrors cmd_alert list/ack/resolve, bin/roll 14056-14104) ───────

/** The `roll alert` subcommand the consumer dispatches on. */
export type AlertSubcommand = "list" | "ack" | "resolve" | "clear" | "log" | string;

/** The consumption action — what `cmd_alert` does for a subcommand. */
export type AlertConsumeAction =
  | { kind: "show_none" } // file absent (list/resolve) → "no active alerts".
  | { kind: "show"; contents: string } // list with a present file → print it.
  | { kind: "ack_append"; footer: string } // ack → append acknowledgement footer.
  | { kind: "ack_none" } // ack with no file → "nothing to acknowledge".
  | { kind: "remove" } // resolve/clear with a present file → rm the file.
  | { kind: "log"; n: number } // log → show last N history rows.
  | { kind: "unknown"; subcommand: string }; // unrecognised subcommand.

/**
 * Decide the consumption action — mirrors `cmd_alert` (bin/roll 14060-14104):
 *   - list/"" : file present → show ; absent → show_none (14062-14072).
 *   - ack     : file present → append "**Acknowledged**: <ts>" footer ; absent
 *               → ack_none (14073-14084). `ts` is the injected `date '+%Y-%m-%d
 *               %H:%M:%S'`.
 *   - resolve/clear : file present → remove ; absent → show_none (14085-14092).
 *   - log     : show last N rows (default 10; non-numeric → 10) (14093-14096).
 *   - other   : unknown (14098-14102).
 *
 * @param fileExists whether `$_LOOP_ALERT` is present.
 * @param contents the file contents (only read for the `list` show case).
 * @param ts injected timestamp for the ack footer.
 * @param logArg the raw `log` count arg (parsed leniently).
 */
export function alertConsumeAction(
  subcommand: AlertSubcommand,
  fileExists: boolean,
  contents: string,
  ts: string,
  logArg?: string,
): AlertConsumeAction {
  switch (subcommand) {
    case "list":
    case "":
      return fileExists ? { kind: "show", contents } : { kind: "show_none" };
    case "ack":
      return fileExists ? { kind: "ack_append", footer: `\n**Acknowledged**: ${ts}` } : { kind: "ack_none" };
    case "resolve":
    case "clear":
      return fileExists ? { kind: "remove" } : { kind: "show_none" };
    case "log":
      return { kind: "log", n: parseLogCount(logArg) };
    default:
      return { kind: "unknown", subcommand };
  }
}

/** Parse the `roll alert log [N]` count — non-numeric/absent → 10 (bin/roll 14113-14114). */
export function parseLogCount(arg: string | undefined): number {
  if (arg !== undefined && /^\d+$/.test(arg.trim())) return Number(arg.trim());
  return 10;
}

// ── alert-log.jsonl record shape + render (mirrors _alert_log reader, 14139) ─

/**
 * One consumption-history record — the fields `_alert_log` reads (bin/roll
 * 14139-14146). `notified` drives the ●/○ glyph (pushed vs throttled/deduped).
 */
export interface AlertLogRecord {
  /** ISO timestamp; the reader prefers `recorded_at`, falls back to `ts`. */
  recorded_at: string;
  /** True iff this alert was pushed via the notify channel (● glyph). */
  notified: boolean;
  /** error | warn | info — colors the bracketed level. */
  level: "error" | "warn" | "info" | string;
  /** The alert category (e.g. "loop-pr-ci-red"). */
  category: string;
  /** The human message. */
  message: string;
}

/**
 * Render one history row exactly as `_alert_log`'s python printer does
 * (bin/roll 14138-14147), MINUS the ANSI color codes (those are presentation,
 * injected by the CLI): `HH:MM  <glyph> [level] category — message`.
 *   - glyph: ● when notified, ○ when throttled/deduped (14142).
 *   - HH:MM: chars 11..16 of the timestamp, or the whole ts if shorter (14140).
 * This is the diff-testable shape; the CLI wraps the glyph/level in color.
 */
export function renderAlertLogRow(rec: AlertLogRecord): string {
  const ts = rec.recorded_at;
  const hhmm = ts.length >= 16 ? ts.slice(11, 16) : ts;
  const glyph = rec.notified ? "●" : "○";
  return `${hhmm}  ${glyph} [${rec.level}] ${rec.category} — ${rec.message}`;
}

/**
 * Parse the last N records from an `alert-log.jsonl` body, newest-first —
 * mirrors `_alert_log`'s python (bin/roll 14131-14138): drop blank/unparseable
 * lines, take the last N, then REVERSE (so the printed order is newest-first).
 */
export function parseAlertLogTail(body: string, n: number): AlertLogRecord[] {
  const rows: AlertLogRecord[] = [];
  for (const raw of body.split("\n")) {
    const ln = raw.trim();
    if (ln === "") continue;
    try {
      const j = JSON.parse(ln) as Partial<AlertLogRecord> & { ts?: string };
      rows.push({
        recorded_at: j.recorded_at ?? j.ts ?? "",
        notified: j.notified === true || (j as { notified?: unknown }).notified === "true" || (j as { notified?: unknown }).notified === 1,
        level: j.level ?? "",
        category: j.category ?? "",
        message: j.message ?? "",
      });
    } catch {
      continue; // unparseable → skip (bin/roll 14137).
    }
  }
  const tail = n >= rows.length ? rows : rows.slice(rows.length - n);
  return tail.reverse();
}

// ── notify push gate (mirrors _notify, bin/roll 10870-10877) ─────────────────

/** The notify-channel facts the adapter gathers (the `_notify` preconditions). */
export interface NotifyEnv {
  /** `uname` == "Darwin" (bin/roll 10873) — notify is macOS-only. */
  isDarwin: boolean;
  /** True iff the mute file `$_LOOP_MUTE_FILE` exists (bin/roll 10874). */
  muted: boolean;
  /** `command -v osascript` succeeds (bin/roll 10875). */
  osascriptPresent: boolean;
}

/** Why a notify push was skipped (mirrors the three `_notify` guards). */
export type NotifySkipReason = "not_darwin" | "muted" | "no_osascript";

/** The notify decision. */
export type NotifyVerdict =
  | { push: true } // all gates clear → osascript display notification.
  | { push: false; reason: NotifySkipReason };

/**
 * Decide whether to push a desktop notification — mirrors `_notify`'s gate
 * ladder (bin/roll 10873-10875) IN ORDER:
 *   1. non-Darwin     → skip not_darwin (10873).
 *   2. mute file      → skip muted (10874).
 *   3. no osascript   → skip no_osascript (10875).
 *   4. else           → push (the `osascript -e 'display notification …'`).
 * This is the `notified` flag's source: a `push:true` verdict that the adapter
 * executes records `notified:true` (● glyph) in the history; any skip records
 * `notified:false` (○).
 */
export function notifyVerdict(env: NotifyEnv): NotifyVerdict {
  if (!env.isDarwin) return { push: false, reason: "not_darwin" };
  if (env.muted) return { push: false, reason: "muted" };
  if (!env.osascriptPresent) return { push: false, reason: "no_osascript" };
  return { push: true };
}

// ── alert-loop tick state (mirrors _loop_write_tick "alert", bin/roll 8008) ──

/** An alert-loop tick outcome label. The alert loop runs at 1-min cadence
 *  (bin/roll 8028 gives it a 1000-line tick-file rotation vs ci/pr's 500). */
export type AlertTickOutcome = "idle" | "acted";

/** An alert-loop tick row (sans ts), serialized by the adapter. */
export interface AlertTick {
  loop: "alert";
  outcome: AlertTickOutcome;
  note: string;
}

/** Build an alert-loop tick row. */
export function alertTick(outcome: AlertTickOutcome, note: string): AlertTick {
  return { loop: "alert", outcome, note };
}

/** The tick-file rotation line cap per loop type (bin/roll 8027-8028). */
export const ALERT_TICK_MAX_LINES = 1000;
export const DEFAULT_TICK_MAX_LINES = 500;
