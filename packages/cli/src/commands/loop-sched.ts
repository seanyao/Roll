/**
 * `roll loop on|off|pause|resume` — US-LOOP-009: the TS scheduling surface that
 * swaps the loop's runtime heart from the v2 bash inner to `roll loop run-once`.
 *
 * DELIBERATE v2 DIVERGENCE (whitelisted in the AGENTS.md bridge table):
 *   - The generated loop runner is a SELF-CONTAINED wrapper: PATH bootstrap,
 *     PAUSE marker, active window, caffeinate, then `roll loop run-once`. The
 *     v2 outer/inner pair (tmux popup, baked agent argv, `source bin/roll`,
 *     formatter/usage/eval side-cars) is retired — run-once owns the cycle
 *     (lock, heartbeat, watchdog, events/runs/cycle-logs) natively.
 *   - No bash-engine function is referenced by the generated script. The v2
 *     outer template called `_loop_migrate_legacy_paths` & co. without sourcing
 *     them — `command not found` on every manual run (FIX-197).
 *   - The dream service IS regenerated here as of US-PORT-008: its v3 runner is
 *     the same self-contained shape (PATH bootstrap, PAUSE marker, then `roll
 *     dream run-once`), retiring the v2 zombie runner that bare-called unsourced
 *     engine funcs. Daily schedule (infra scheduleXml daily path). `loop off`
 *     still boots it out and removes its plist alongside loop + pr.
 *
 * KEPT contracts (so status/dashboard/brief keep reading the same world):
 *   - runner path  : <shared>/loop/run-<slug>.sh   (pr: <shared>/pr/run-<slug>.sh)
 *   - plist        : ~/Library/LaunchAgents/com.roll.<svc>.<slug>.plist via
 *                    infra plistContent (byte-shape of _write_launchd_plist)
 *   - machine log  : <project>/.roll/loop/cron.log  (pr: pr.log)
 *   - PAUSE marker : <project>/.roll/loop/PAUSE-<slug>
 *   - launchctl    : enable/bootstrap + bootout pairs (FIX-027/FIX-098 dance)
 *   - loop period  : .roll/local.yaml `loop_schedule.period_minutes` (default 30)
 */
import {
  type Scheduler,
  createScheduler,
  configResolve,
  launchdLabel,
  launchdPlistPath,
  plistContent,
  projectIdentity,
} from "@roll/infra";
import { EventBus } from "@roll/core";
import { GOAL_SCHEMA_VERSION, parseGoalYaml, renderGoalYaml, resolveLang, t, transitionGoal, v3Catalog } from "@roll/spec";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentSecretEnvNames } from "../runner/agent-spawn.js";
import { clearRootCauseFailure } from "../runner/failure-attribution.js";
import { loopControlRunnerReadout, staleLoopRunnerMessage } from "./loop-runner-readout.js";

// ─── injectable deps (tests fake launchd + identity + paths) ─────────────────
export interface LoopSchedDeps {
  identity: () => Promise<{ path: string; slug: string }>;
  uid: () => number;
  sharedRoot: () => string;
  launchdDir: () => string;
  /** US-LOOP-079f1: Scheduler seam — replaces raw launchd ops. */
  scheduler: Scheduler;
  /** Run the generated loop runner once, FORCE env set (loop now). */
  execRunner?: (runnerPath: string, opts?: { allowedCards?: string[] }) => Promise<number>;
  /** FIX-204E: is tmux available? Decides the `loop now` UX branch. */
  hasTmux?: () => boolean;
  /** FIX-204E: inline observation — tail live.log for the cycle's duration. */
  observe?: (runtimeDir: string) => Promise<void>;
  /** FIX-1225: terminate repo-scoped loop helper processes when the owner disables the loop. */
  cleanupHelpers?: (projectPath: string, slug: string) => Promise<LoopHelperCleanupResult> | LoopHelperCleanupResult;
}

export interface LoopHelperProcess {
  pid: number;
  command: string;
  cwd?: string;
}

export interface LoopHelperCleanupResult {
  processCount: number;
  tmuxSessionKilled: boolean;
}

function realDeps(): LoopSchedDeps {
  return {
    identity: () => projectIdentity(),
    uid: () => process.getuid?.() ?? 501,
    sharedRoot: () => process.env["ROLL_SHARED_ROOT"] || join(homedir(), ".shared", "roll"),
    launchdDir: () => join(homedir(), "Library", "LaunchAgents"),
    scheduler: createScheduler(process.platform, { uid: process.getuid?.() ?? 501 }),
    execRunner: (runner, opts) =>
      new Promise((resolve) => {
        // FIX-204E: run the GENERATED runner — it self-wraps the cycle into
        // the tmux session and returns immediately (fallback: direct run).
        // The cycle must never be a child of the invoking session again.
        const child = spawn("bash", [runner], {
          stdio: "inherit",
          env: {
            ...process.env,
            ROLL_LOOP_FORCE: "1",
            ...(opts?.allowedCards !== undefined ? { ROLL_LOOP_GO_ALLOWED_CARDS: opts.allowedCards.join(",") } : {}),
          },
        });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      }),
    hasTmux: () => {
      try {
        return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    },
    // The `loop now` inline observation: tail live.log while the cycle holds
    // the inner lock; Ctrl-C stops the TAIL only (the cycle lives in tmux).
    observe: (rt) =>
      new Promise((resolve) => {
        const lock = join(rt, "inner.lock");
        const tail = spawn("tail", ["-n", "+1", "-F", join(rt, "live.log")], { stdio: "inherit" });
        let sawLock = false;
        const t0 = Date.now();
        const finish = (): void => {
          try {
            tail.kill("SIGTERM");
          } catch {
            /* gone */
          }
          process.removeListener("SIGINT", finish);
          resolve();
        };
        const timer = setInterval(() => {
          if (existsSync(lock)) sawLock = true;
          const done = sawLock ? !existsSync(lock) : Date.now() - t0 > 30_000;
          if (done) {
            clearInterval(timer);
            finish();
          }
        }, 500);
        process.on("SIGINT", () => {
          clearInterval(timer);
          finish();
        });
      }),
    cleanupHelpers: cleanupLoopHelpers,
  };
}

function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isSameOrInsidePath(candidate: string, root: string): boolean {
  const c = normalizePath(candidate).replace(/\/+$/, "");
  const r = normalizePath(root).replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}

function isLoopHelperCommand(command: string): boolean {
  return /\bloop\s+(?:go|watch|run-once)\b/.test(command);
}

export function loopHelperPidsToTerminate(
  projectPath: string,
  slug: string,
  processes: readonly LoopHelperProcess[],
  currentPid = process.pid,
): number[] {
  const session = `roll-loop-${slug}`;
  return processes
    .filter((proc) => proc.pid !== currentPid)
    .filter((proc) => isLoopHelperCommand(proc.command))
    .filter((proc) => {
      if (proc.cwd !== undefined && isSameOrInsidePath(proc.cwd, projectPath)) return true;
      if (proc.command.includes(projectPath)) return true;
      return proc.command.includes(session);
    })
    .map((proc) => proc.pid)
    .sort((a, b) => a - b);
}

function listSystemProcesses(): LoopHelperProcess[] {
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (out.status !== 0) return [];
  return out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const m = /^(\d+)\s+(.+)$/.exec(line);
      if (m === null) return undefined;
      const pid = Number(m[1]);
      const command = m[2] ?? "";
      if (!Number.isFinite(pid) || !isLoopHelperCommand(command)) return undefined;
      const cwd = processCwd(pid);
      return cwd === undefined ? { pid, command } : { pid, command, cwd };
    })
    .filter((proc): proc is LoopHelperProcess => proc !== undefined);
}

function processCwd(pid: number): string | undefined {
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {
    /* macOS has no /proc cwd link. */
  }
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (out.status !== 0) return undefined;
  const pathLine = out.stdout.split(/\r?\n/).find((line) => line.startsWith("n"));
  return pathLine === undefined ? undefined : pathLine.slice(1);
}

function killTmuxSession(slug: string): boolean {
  const session = `roll-loop-${slug}`;
  try {
    return spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function cleanupLoopHelpers(projectPath: string, slug: string): LoopHelperCleanupResult {
  const tmuxSessionKilled = killTmuxSession(slug);
  const pids = loopHelperPidsToTerminate(projectPath, slug, listSystemProcesses());
  let processCount = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      processCount += 1;
    } catch {
      /* already gone or not owned by us */
    }
  }
  return { processCount, tmuxSessionKilled };
}

// ─── templates ────────────────────────────────────────────────────────────────

export interface LoopRunnerInput {
  projectPath: string;
  slug: string;
  /** Optional generation-time roll binary override (dev installs). */
  rollBin?: string;
  /** Active window [start, end) in hours; full window = 0..24. */
  activeStart: number;
  activeEnd: number;
}

/**
 * FIX-230: a long-lived tmux session freezes the environment it was created
 * under — a cycle window opened into it inherits THAT snapshot, not the
 * caller's. When a proxy is later turned off (HTTP(S)_PROXY/ALL_PROXY now
 * point at a dead port), every agent in every cycle times out with
 * "Connection error" until someone kills the session. The new-window command
 * therefore inlines the caller's proxy family at window-creation time
 * (`VAR='${VAR:-}'` expands in the runner's shell, OUTSIDE tmux): the cycle's
 * network env always mirrors the invoker — empty when the caller has none,
 * which HTTP clients treat as unset. Trade-off (recorded on the card): only
 * the proxy family is synced — it is the network-reaching class that rots;
 * PATH is already bootstrapped above. FIX-403 extends the same safe by-name
 * forwarding to agent API-key env vars because some agents support env-only
 * credentials in addition to their $HOME dotfile fallbacks.
 */
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const TMUX_PASSTHROUGH_VARS = [...PROXY_VARS, ...agentSecretEnvNames()] as const;
const tmuxEnvPassthrough = TMUX_PASSTHROUGH_VARS.map((v) => `${v}='\${${v}:-}'`).join(" ");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The v3 loop runner: a thin, self-contained launchd wrapper around
 * `roll loop run-once`. Everything cycle-shaped (lock, heartbeat, watchdog,
 * worktree, agent, publish, events/runs) lives in run-once — NOT here.
 */
export function buildLoopRunnerScript(input: LoopRunnerInput): string {
  const rt = `${input.projectPath}/.roll/loop`;
  const project = shellQuote(input.projectPath);
  return `#!/bin/bash -l
# roll v3 loop runner — generated by \`roll loop on\` (US-LOOP-009).
# Self-contained wrapper: the cycle heart is \`roll loop run-once\` (TS).
# Portable PATH: launchd delivers a bare PATH missing brew/local tools. Idempotent.
for _d in /opt/homebrew/bin /usr/local/bin /opt/local/bin "$HOME/.local/bin" "$HOME/.kimi-code/bin"; do
  case ":$PATH:" in *":$_d:"*) ;; *) [ -d "$_d" ] && PATH="$_d:$PATH" ;; esac
done
export PATH
RT="${rt}"
LOG="$RT/cron.log"
mkdir -p "$RT"
# Pause marker — written by \`roll loop pause\`, removed by \`roll loop resume\`.
if [ -f "$RT/PAUSE-${input.slug}" ]; then exit 0; fi
# Active window [${input.activeStart},${input.activeEnd}) — ROLL_LOOP_FORCE (manual \`roll loop now\`) bypasses.
# 10# forces base-10: \`date +%H\` yields "08"/"09" which printf %d rejects as octal (v2 latent bug, fixed here).
if [ -z "$ROLL_LOOP_FORCE" ]; then
  h=$((10#$(date +%H)))
  if [ "$h" -lt ${input.activeStart} ] || [ "$h" -ge ${input.activeEnd} ]; then exit 0; fi
fi
# Goal go session lock — while \`roll loop go\` is chaining cycles, scheduled
# launchd ticks yield instead of racing the next card between two run-once calls.
GO_LOCK="$RT/go.lock"
if [ -d "$GO_LOCK" ]; then
  _gp="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$GO_LOCK/meta.json" 2>/dev/null)"
  _gt="$(sed -n 's/.*"startedAt"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$GO_LOCK/meta.json" 2>/dev/null)"
  _now=$(date -u +%s)
  if [ -n "$_gp" ] && [ -n "$_gt" ] && kill -0 "$_gp" 2>/dev/null && [ "$((_now - _gt))" -lt 21600 ]; then
    printf '{"type":"goal:tick_skipped","reason":"go_session_lock","heldByPid":%s,"ts":%s}\\n' "$_gp" "$_now" >> "$RT/events.ndjson"
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] goal go session lock held by pid $_gp; tick skipped" >> "$LOG"
    exit 0
  fi
  rm -rf "$GO_LOCK"
elif [ -f "$GO_LOCK" ]; then
  _gp=""; _gt=""
  IFS=: read -r _gp _gt < "$GO_LOCK" 2>/dev/null || true
  _now=$(date -u +%s)
  if [ -n "$_gp" ] && [ -n "$_gt" ] && kill -0 "$_gp" 2>/dev/null && [ "$((_now - _gt))" -lt 21600 ]; then
    printf '{"type":"goal:tick_skipped","reason":"go_session_lock","heldByPid":%s,"ts":%s}\\n' "$_gp" "$_now" >> "$RT/events.ndjson"
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] goal go session lock held by pid $_gp; tick skipped" >> "$LOG"
    exit 0
  fi
  rm -f "$GO_LOCK"
fi
# Cycle inflight guard (FIX-393) — while the previous scheduled cycle is still
# running, the next launchd tick yields instead of piling on concurrent cycles.
# 90-min (5400s) staleness: a crashed/hung cycle self-heals on the next tick.
CYCLE_LOCK="$RT/cycle-inflight.lock"
if [ -f "$CYCLE_LOCK" ]; then
  _cp=""; _ct=""
  IFS=: read -r _cp _ct < "$CYCLE_LOCK" 2>/dev/null || true
  _now=$(date -u +%s)
  if [ -n "$_cp" ] && [ -n "$_ct" ] && kill -0 "$_cp" 2>/dev/null && [ "$((_now - _ct))" -lt 5400 ]; then
    printf '{"type":"cycle:tick_skipped","reason":"cycle_inflight","heldByPid":%s,"ts":%s}\\n' "$_cp" "$_now" >> "$RT/events.ndjson"
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] cycle inflight lock held by pid $_cp; tick skipped" >> "$LOG"
    exit 0
  fi
  rm -f "$CYCLE_LOCK"
fi
ROLL_BIN="\${ROLL_BIN:-${input.rollBin ?? '$(command -v roll || echo /opt/homebrew/bin/roll)'}}"
# FIX-204E + US-LOOP-047 observation window: every cycle runs inside tmux session
# roll-loop-${input.slug} (v2's session model around the TS heart): window 0
# runs the unified read-only \`roll loop watch\` entrypoint, so manual and tmux
# observation share the same status/events/live.log renderer. Each cycle gets
# its own window, and the cycle SURVIVES whoever invoked it — a dying terminal
# or agent session can no longer TERM a half-done cycle.
# ROLL_LOOP_NO_TMUX=1 or no tmux on PATH → direct run (previous contract).
# ROLL_TMUX_BIN: test seam (the PATH bootstrap above outranks any shim dir).
TMUX_BIN="\${ROLL_TMUX_BIN:-tmux}"
if [ -z "$ROLL_TMUX_WRAPPED" ] && [ -z "$ROLL_LOOP_NO_TMUX" ] && command -v "$TMUX_BIN" >/dev/null 2>&1; then
  _sess="roll-loop-${input.slug}"
  "$TMUX_BIN" has-session -t "$_sess" 2>/dev/null || \\
    "$TMUX_BIN" new-session -d -s "$_sess" -x 200 -y 50 -n watch "cd ${project} && '$ROLL_BIN' loop watch --since all" 2>/dev/null || true
  if "$TMUX_BIN" new-window -d -t "$_sess" -n "c$(date +%H%M%S)" "ROLL_TMUX_WRAPPED=1 ROLL_LOOP_FORCE='\${ROLL_LOOP_FORCE:-}' ${tmuxEnvPassthrough} ROLL_BIN='$ROLL_BIN' exec bash '$0'" 2>/dev/null; then
    exit 0
  fi
fi
# Physical screenshot defaults for unattended loop (FIX-393/FIX-927/FIX-1022) —
# prevents macOS Screen Recording TCC dialogs from blocking launchd cycles. Attest
# screenshot evidence no longer falls back to headless/browser-rendered captures:
# without a real physical Terminal.app or browser-window screencapture it records
# an honest skip. isTTY is unreliable here because the loop wraps agents in a
# script(1)+tmux PTY (isTTY===true), so the explicit kill-switch is required.
export ROLL_ATTEST_NO_TERMINAL="\${ROLL_ATTEST_NO_TERMINAL:-1}"
export ROLL_NO_SCREENCAP="\${ROLL_NO_SCREENCAP:-1}"
# FIX-1209: fuse — pin the expected slug so run-once can detect identity drift.
export ROLL_MAIN_SLUG="${input.slug}"
# Acquire the cycle inflight lock so the next launchd tick yields (FIX-393).
printf '%s:%s\\n' "$$" "$(date -u +%s)" > "$CYCLE_LOCK"
trap 'rm -f "$CYCLE_LOCK"' EXIT
# Keep the box awake for the duration of the cycle.
caffeinate -i -w $$ 2>/dev/null &
cd "${input.projectPath}" || exit 0
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] cycle start (v3 run-once)" >> "$LOG"
# FIX-230 observability: the effective proxy env, so an env-drift failure is
# readable straight from the log instead of needing a session autopsy.
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] env: HTTP_PROXY='\${HTTP_PROXY:-}' HTTPS_PROXY='\${HTTPS_PROXY:-}' ALL_PROXY='\${ALL_PROXY:-}' NO_PROXY='\${NO_PROXY:-}'" >> "$LOG"
"$ROLL_BIN" loop run-once >> "$LOG" 2>&1
rc=$?
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] cycle end rc=$rc" >> "$LOG"
exit 0
`;
}

export interface LoopTestRunnerInput {
  projectPath: string;
  slug: string;
  /** The smoke command to run in place of `roll loop run-once` (--cmd / agent default). */
  cmd: string;
}

/**
 * `roll loop test`'s SMOKE runner (US-PORT-022). Same self-contained, tmux
 * self-wrapping shape as {@link buildLoopRunnerScript} — PATH bootstrap, tmux
 * session `roll-loop-<slug>` with the unified `roll loop watch` window,
 * caffeinate — but the cycle heart is REPLACED by the injected `cmd` (a fake
 * agent line, default `claude -p hello` / a mock echo). This exercises the
 * exact PATH → tmux → terminal → stream chain a loop runner change must keep
 * working, WITHOUT running a real cycle (no git/gh, no `loop run-once`). The
 * command's output flows to `$RT/live.log` so the watch window renders it,
 * mirroring the v2 `_loop_test` smoke (which likewise ran the injected agent
 * command, not a real cycle). ROLL_LOOP_FORCE=1 (set by the command) bypasses
 * the active-window guard.
 */
export function buildLoopTestRunnerScript(input: LoopTestRunnerInput): string {
  const rt = `${input.projectPath}/.roll/loop`;
  const project = shellQuote(input.projectPath);
  return `#!/bin/bash -l
# roll v3 loop SMOKE-TEST runner — generated by \`roll loop test\` (US-PORT-022).
# Same tmux self-wrap as the live runner, but runs the injected smoke command
# instead of a real cycle — verifies the PATH/tmux/terminal/stream chain.
for _d in /opt/homebrew/bin /usr/local/bin /opt/local/bin "$HOME/.local/bin" "$HOME/.kimi-code/bin"; do
  case ":$PATH:" in *":$_d:"*) ;; *) [ -d "$_d" ] && PATH="$_d:$PATH" ;; esac
done
export PATH
RT="${rt}"
LOG="$RT/cron.log"
mkdir -p "$RT"
ROLL_BIN="\${ROLL_BIN:-$(command -v roll || echo /opt/homebrew/bin/roll)}"
TMUX_BIN="\${ROLL_TMUX_BIN:-tmux}"
if [ -z "$ROLL_TMUX_WRAPPED" ] && [ -z "$ROLL_LOOP_NO_TMUX" ] && command -v "$TMUX_BIN" >/dev/null 2>&1; then
  _sess="roll-loop-${input.slug}"
  "$TMUX_BIN" has-session -t "$_sess" 2>/dev/null || \\
    "$TMUX_BIN" new-session -d -s "$_sess" -x 200 -y 50 -n watch "cd ${project} && '$ROLL_BIN' loop watch --since all" 2>/dev/null || true
  if "$TMUX_BIN" new-window -d -t "$_sess" -n "test$(date +%H%M%S)" "ROLL_TMUX_WRAPPED=1 ROLL_LOOP_FORCE='\${ROLL_LOOP_FORCE:-}' ${tmuxEnvPassthrough} ROLL_BIN='$ROLL_BIN' exec bash '$0'" 2>/dev/null; then
    exit 0
  fi
fi
caffeinate -i -w $$ 2>/dev/null &
cd "${input.projectPath}" || exit 0
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] smoke start" >> "$LOG"
{ ${input.cmd} ; } >> "$RT/live.log" 2>&1
rc=$?
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] smoke end rc=$rc" >> "$LOG"
exit $rc
`;
}

export interface DreamRunnerInput {
  projectPath: string;
  slug: string;
  /** Optional generation-time roll binary override (dev installs). */
  rollBin?: string;
}

/**
 * The v3 dream runner: a thin, self-contained launchd wrapper around
 * `roll dream run-once` (US-PORT-008). It is the dream analogue of
 * {@link buildLoopRunnerScript} but simpler — dream fires once daily, runs in
 * place (no worktree), and is non-interactive (no tmux observation window, no
 * active-window guard). Like the loop runner it references NO bash-engine
 * function (the FIX-197 lesson that made the v2 dream runner a `command not
 * found` zombie), and it honors the same PAUSE-<slug> marker so `roll loop
 * pause` halts the nightly scan too. Machine log: .roll/dream/cron.log (FIX-139
 * project-local, mirroring loop).
 */
export function buildDreamRunnerScript(input: DreamRunnerInput): string {
  const rt = `${input.projectPath}/.roll/dream`;
  const rollBin = input.rollBin ?? "$(command -v roll || echo /opt/homebrew/bin/roll)";
  return `#!/bin/bash -l
# roll v3 dream runner — generated by \`roll loop on\` (US-PORT-008).
# Self-contained wrapper: the scan heart is \`roll dream run-once\` (TS).
# Portable PATH: launchd delivers a bare PATH missing brew/local tools. Idempotent.
for _d in /opt/homebrew/bin /usr/local/bin /opt/local/bin "$HOME/.local/bin" "$HOME/.kimi-code/bin"; do
  case ":$PATH:" in *":$_d:"*) ;; *) [ -d "$_d" ] && PATH="$_d:$PATH" ;; esac
done
export PATH
RT="${rt}"
LOG="$RT/cron.log"
mkdir -p "$RT"
# Pause marker — written by \`roll loop pause\`, removed by \`roll loop resume\`.
# Shared with the loop runner so one pause halts both the loop and the scan.
if [ -f "${input.projectPath}/.roll/loop/PAUSE-${input.slug}" ]; then exit 0; fi
ROLL_BIN="\${ROLL_BIN:-${rollBin}}"
# FIX-1022: dream run-once also hits the screencapture probe — never prompt in the
# unattended scan (isTTY is unreliable under launchd/PTY; ROLL_NO_SCREENCAP is honored).
export ROLL_NO_SCREENCAP="\${ROLL_NO_SCREENCAP:-1}"
cd "${input.projectPath}" || exit 0
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] dream start (v3 run-once)" >> "$LOG"
"$ROLL_BIN" dream run-once >> "$LOG" 2>&1
rc=$?
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] dream end rc=$rc" >> "$LOG"
exit 0
`;
}

/**
 * Derive a stable per-project minute in [1,55] from md5(projectPath) — ports
 * bin/roll `_loop_derive_minute` (offset default 2 for dream). Spreads each
 * project's daily fire across the hour so multiple machines/projects do not all
 * wake at :00. Only consulted when dream runs in calendar mode (the default
 * launchd daily path is a bare StartInterval=86400 and ignores the minute).
 */
export function deriveMinute(projectPath: string, offset = 2): number {
  const hex = createHash("md5").update(projectPath).digest("hex").slice(0, 6);
  const dec = parseInt(hex, 16);
  return ((dec + offset) % 55) + 1;
}

/**
 * Resolve dream's daily schedule from config (global `loop_dream_hour` /
 * `loop_dream_minute`, mirroring the v2 `_install_launchd_plists` reads). A
 * missing/`-` minute auto-derives from the project path. Calendar mode (precise
 * Hour+Minute in the plist) is opt-in via ROLL_DREAM_CALENDAR=1, exactly as the
 * infra `scheduleXml` daily path documents; otherwise launchd gets the FIX-105
 * default StartInterval=86400.
 */
export function dreamScheduleFor(projectPath: string): {
  hour: number;
  minute: number;
  calendar: boolean;
} {
  const hourRaw = configResolve("loop_dream_hour")?.[0] ?? "3";
  const minRaw = configResolve("loop_dream_minute")?.[0] ?? "-";
  const hour = /^\d+$/.test(hourRaw) ? Number(hourRaw) : 3;
  const minute = /^\d+$/.test(minRaw) ? Number(minRaw) : deriveMinute(projectPath);
  return { hour, minute, calendar: (process.env["ROLL_DREAM_CALENDAR"] ?? "") === "1" };
}

/** Read `loop_schedule.period_minutes` from local.yaml text; 30 when absent. */
export function parseLoopPeriodMinutes(text: string): number {
  const lines = text.split("\n");
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inSection) {
      if (indent === 0 && /^loop_schedule:\s*$/.test(line.trim())) inSection = true;
      continue;
    }
    if (indent === 0) break;
    const m = /^period_minutes:\s*(\d+)\s*(?:#.*)?$/.exec(line.trim());
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  }
  return 30;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function pathValue(): string {
  // The plist EnvironmentVariables PATH — brew/local dirs first, system after
  // (mirrors the live v2-generated plist; the runner self-repairs PATH anyway).
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    `${home}/.local/bin`,
    `${home}/.kimi-code/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
}

function pauseMarkerPath(projectPath: string, slug: string): string {
  return join(projectPath, ".roll", "loop", `PAUSE-${slug}`);
}

// ─── loop run state ─────────────────────────────────────────────────────────

/**
 * The loop's run state resolved from on-disk markers.
 *
 * US-LOOP-115: DORMANT is gone. It meant "the backlog drained, so the launchd lane
 * unloaded itself and stopped writing idle records" — a state that only makes sense
 * for a timer that wakes on its own. A session-driven loop cannot idle-spin, so the
 * only real state left is whether the owner (or a tripped correction breaker) has
 * PAUSED autonomous progress.
 *
 * A leftover `DORMANT-<slug>` file on disk is an inert artifact: never read, never
 * an error, never auto-deleted (`roll loop gc` may clean it).
 */
export type LoopRunState = "PAUSED" | "ACTIVE";

export function resolveLoopRunState(projectPath: string, slug: string): LoopRunState {
  return existsSync(pauseMarkerPath(projectPath, slug)) ? "PAUSED" : "ACTIVE";
}

function syncGoalPaused(projectPath: string, reason: string): void {
  const rt = join(projectPath, ".roll", "loop");
  const path = join(rt, "goal.yaml");
  if (!existsSync(path)) return;
  try {
    const before = parseGoalYaml(readFileSync(path, "utf8"));
    if (before.status === "paused" || before.status === "complete") return;
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const after = transitionGoal(before, "paused", { actor: "system", reason, at });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, renderGoalYaml(after), "utf8");
    renameSync(tmp, path);
    new EventBus().appendEvent(join(rt, "events.ndjson"), {
      type: "goal:state",
      schema: GOAL_SCHEMA_VERSION,
      from: before.status,
      to: after.status,
      actor: "system",
      reason,
      ts: Math.floor(Date.now() / 1000),
    });
  } catch {
    // `roll loop pause` must still pause the scheduler marker even if goal.yaml
    // is temporarily malformed; `roll loop goal` remains the fail-loud reader.
  }
}

// ─── commands ─────────────────────────────────────────────────────────────────

const LOOP_SERVICES = ["loop", "dream"] as const;

/**
 * FIX-212 — (re)install a service plist and PROVE it mounted.
 *
 * The bootout+bootstrap dance (FIX-027/098) races: `launchctl bootstrap` can
 * return non-zero, OR return 0 while the job silently never mounts. Either way
 * the old `loop on` reported success and the scheduler died quietly for hours.
 * So we treat "mounted" as the authoritative signal (`isArmed` via the
 * Scheduler seam), reinstall once more if the first pass did not land it, and
 * surface the launchctl stderr on failure.
 *
 * Returns `{ ok, detail }` — `detail` is "loaded" on success, else the
 * failure reason.
 */
async function mountService(
  deps: LoopSchedDeps,
  label: string,
  plist: string,
): Promise<{ ok: boolean; failure?: ReturnType<NonNullable<Scheduler["lastFailure"]>> }> {
  // Two attempts max: the initial install + a single retry (FIX-212 spec).
  for (let attempt = 0; attempt < 2; attempt++) {
    const reinstalled = await deps.scheduler.wake(label, plist, { refresh: true });
    if (reinstalled) {
      const armed = await deps.scheduler.isArmed(label);
      if (armed) return { ok: true };
    }
  }
  const failure = deps.scheduler.lastFailure?.(label);
  return failure === undefined ? { ok: false } : { ok: false, failure };
}

function mountFailureMessage(
  uid: number,
  failed: ReadonlyArray<{ label: string; plist: string; m: Awaited<ReturnType<typeof mountService>> }>,
): string {
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  const lines = [t(v3Catalog, lang, "loop.sched.mount_failed", failed.length)];
  for (const { label, plist, m } of failed) {
    const raw = m.failure?.stderr.trim() || m.failure?.stdout.trim();
    const cause = m.failure === undefined
      ? t(v3Catalog, lang, "loop.sched.retry_exhausted")
      : `launchctl ${m.failure.operation} exited ${m.failure.code}${raw === undefined || raw === "" ? "" : `: ${raw}`}`;
    lines.push(
      `  ${t(v3Catalog, lang, "loop.sched.domain")}: gui/${uid}`,
      `  ${t(v3Catalog, lang, "loop.sched.label")}: ${label}`,
      `  plist: ${plist}`,
      `  ${t(v3Catalog, lang, "loop.sched.cause")}: ${cause}`,
      `  ${t(v3Catalog, lang, "loop.sched.inspect")}`,
      `    launchctl bootout gui/${uid}/${label}`,
      `    launchctl bootstrap gui/${uid} ${plist}`,
      `    launchctl print gui/${uid}/${label}`,
    );
  }
  lines.push(t(v3Catalog, lang, "loop.sched.retry"));
  // US-LOOP-108 AC1: launchd failure ends UNARMED and offers the owner-confirmed
  // process fallback explicitly — it is never started automatically here.
  lines.push(
    `  ${t(v3Catalog, lang, "loop.sched.unarmed")}`,
    `  ${t(v3Catalog, lang, "loop.sched.fallback_hint")}`,
    `    roll loop fallback start --confirm`,
    "",
  );
  return lines.join("\n");
}

function restoreDormantClaim(waking: string, dormant: string): void {
  try {
    renameSync(waking, dormant);
  } catch {
    // Keep the .waking claim when restoration races; the next `loop on`
    // treats it as an orphan and retries instead of silently losing state.
  }
}

/** `roll loop on` — generate v3 runners + plists, (re)load loop & pr. */
/**
 * The user LaunchAgents dir (test override via `_LAUNCHD_DIR`).
 *
 * US-LOOP-116: Roll no longer WRITES here — it installs no timers. The path is
 * still needed on the READ side, to notice a lane an older install left behind.
 */
export function launchAgentsDir(): string {
  return process.env["_LAUNCHD_DIR"] ?? join(homedir(), "Library", "LaunchAgents");
}

/**
 * Every `com.roll.*` launchd lane label on this machine, optionally scoped to a
 * project slug.
 *
 * US-LOOP-116: Roll installs no lanes, so any hit is a LEFTOVER from an older
 * install. These stay as read-side inventory — `roll doctor` lists them and prints
 * the disarm command; nothing here ever writes to LaunchAgents.
 */
function listRollLaneLabelsByFilter(filter: (name: string) => boolean): string[] {
  try {
    return readdirSync(launchAgentsDir())
      .filter((n) => n.startsWith("com.roll.") && n.endsWith(".plist"))
      .filter(filter)
      .map((n) => n.replace(/\.plist$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Leftover lane labels belonging to one project slug. */
export function listRollLaneLabels(slug: string): string[] {
  return listRollLaneLabelsByFilter((n) => n.endsWith(`.${slug}.plist`));
}

/** Every leftover com.roll.* lane label found on this machine. */
export function listAllRollLaneLabels(): string[] {
  return listRollLaneLabelsByFilter(() => true);
}

// ─── US-LOOP-116: `loop on` / `loop off` are gone ───────────────────────────
// Their entry points were cut in US-LOOP-113 and nothing routes to them, so the
// implementations were dead code. `loop off` in particular still printed
// "verified: no further scheduler tick is possible" — a claim it could no longer
// substantiate once the fallback it also stopped was deleted (codex review r1).

// ─── US-LOOP-116: the process fallback is gone ──────────────────────────────
// US-LOOP-107 added a `detached` self-running process as a fallback for when
// launchd bootstrap failed. It was a SECOND resident scheduler: deleting the plist
// layer alone would have left it running under a different name. With no resident
// scheduling at all there is no backend to choose, so SchedulerBackendName,
// the lease/heartbeat/liveness probes and `roll loop fallback` are all deleted.

export async function loopPauseCommand(_args: string[], deps: LoopSchedDeps = realDeps()): Promise<number> {
  const id = await deps.identity();
  const marker = pauseMarkerPath(id.path, id.slug);
  mkdirSync(dirname(marker), { recursive: true });
  const already = existsSync(marker);
  if (!already) writeFileSync(marker, `${new Date().toISOString()}\n`);
  syncGoalPaused(id.path, "loop_pause");
  process.stdout.write(
    already
      ? `Loop already paused\nLoop 已处于暂停\n`
      : `Loop paused — no card will be picked autonomously\nLoop 已暂停 — 不再自动摘取卡片\n`,
  );
  // US-LOOP-116 (codex review r2): there is no scheduler to describe. Pause stops
  // AUTONOMOUS card selection by the session; it does not stop a session that names
  // its card explicitly (below).
  process.stdout.write(
    "a session driving `roll loop go` will stop at the next cycle boundary until `roll loop resume`\n",
  );
  // FIX-1472: pause stops AUTONOMOUS scheduling only. A supervisor can still run
  // one explicitly-scoped card without resuming (which would re-enable
  // autonomous selection of any eligible Todo).
  process.stdout.write(
    "  supervisor one-shot: `roll loop go --cards <ids> --max-cycles 1` runs exactly those cards while staying paused (no autonomous scheduling).\n",
  );
  return 0;
}

/** `roll loop resume` — remove the PAUSE marker, reset failure/heal counters. */
export async function loopResumeCommand(_args: string[], deps: LoopSchedDeps = realDeps()): Promise<number> {
  const id = await deps.identity();
  const runner = loopControlRunnerReadout(id.path);
  process.stdout.write(`roll loop resume: runner ${runner.bin} v${runner.runningVersion}\n`);
  if (runner.projectNewer) {
    process.stderr.write(staleLoopRunnerMessage("roll loop resume", runner));
    return 1;
  }
  const marker = pauseMarkerPath(id.path, id.slug);
  const existed = existsSync(marker);
  const pauseBody = existed ? readPauseMarker(marker) : "";
  rmSync(marker, { force: true });

  // FIX-251: resume must clear the consecutive-failure counter so the first
  // post-resume cycle failure does not immediately re-trip the auto-pause.
  // US-LOOP-079h1 AC4: also clear the consecutive-idle counter.
  const rt = join(id.path, ".roll", "loop");
  const counterFile = join(rt, "consecutive-fails");
  if (existsSync(counterFile)) {
    try {
      writeFileSync(counterFile, "0", "utf8");
    } catch {
      /* best-effort */
    }
  }
  const idleCounterFile = join(rt, `consecutive-idle-${id.slug}`);
  if (existsSync(idleCounterFile)) {
    try {
      writeFileSync(idleCounterFile, "0", "utf8");
    } catch {
      /* best-effort */
    }
  }

  const rootCauseKey = rootCauseKeyFromPauseMarker(pauseBody);
  if (rootCauseKey !== null) {
    clearRootCauseFailure(rt, rootCauseKey);
  }

  // Clear per-HEAD heal counters from the state file (heal_count_head_*).
  const stateFile = join(rt, `state-${id.slug}.yaml`);
  if (existsSync(stateFile)) {
    try {
      const body = readFileSync(stateFile, "utf8");
      const lines = body.split("\n").filter((l) => /^(?!heal_count_head_)/.test(l));
      writeFileSync(stateFile, lines.join("\n"), "utf8");
    } catch {
      /* best-effort */
    }
  }

  // Clear the heal dir (removes per-HEAD CI heal budget files).
  const healDir = join(
    (process.env["ROLL_LOOP_DIR"] ?? "").trim() || join(homedir(), ".shared", "roll", "loop"),
    "heal",
  );
  try {
    rmSync(healDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }

  // Emit a loop:resumed event so dashboards/monitors see the reset and the
  // correction circuit (events-based) can observe the boundary.
  if (existed) {
    try {
      const eventsPath = join(rt, "events.ndjson");
      mkdirSync(rt, { recursive: true });
      new EventBus().appendEvent(eventsPath, {
        type: "loop:resumed",
        loop: "ci",
        ts: Math.floor(Date.now() / 1000),
      });
    } catch {
      /* event log is best-effort; the counter/file resets above are canonical */
    }
  }

  process.stdout.write(
    existed
      ? `Loop resumed — autonomous card selection re-enabled\nLoop 已恢复 — 重新允许自动摘取卡片\n`
      : `Loop was not paused\nLoop 本就未暂停\n`,
  );
  // US-LOOP-116: nothing starts on its own. Resume only clears the gate; a session
  // still has to drive, and every other gate still applies.
  process.stdout.write(
    "`roll loop go` can now pick eligible Todo within budget/route/evidence/Evaluator/release gates\n",
  );
  return 0;
}

function rootCauseKeyFromPauseMarker(body: string): string | null {
  const match = /^\*\*Root cause\*\*:\s*(\S+)\s*$/m.exec(body);
  return match?.[1] ?? null;
}

function readPauseMarker(marker: string): string {
  try {
    return readFileSync(marker, "utf8");
  } catch {
    return "";
  }
}

// ─── US-LOOP-116: `loop now` and its legacy self-heal are gone ──────────────
// `now` meant "fire what the timer would fire". There is no timer, the entry
// point was cut in US-LOOP-113, and nothing routed here.

