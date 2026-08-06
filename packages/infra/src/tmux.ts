/**
 * @responsibility Controls tmux sessions for the loop windows.
 */
/**
 * Tmux module — TS port of the v2 loop's tmux session control (US-INFRA-005).
 *
 * ─── v2 oracle (frozen bash, bin/roll) — tmux invocation inventory ───────────
 *   session naming (pure):
 *     - loop cycle session  `roll-loop-<slug>`   9483/9513/9465/10039/10471.
 *         (the runner derives slug from `basename run-<slug>.sh`; callers here
 *          pass the slug directly — see `loopSessionName`.)
 *     - peer session        `roll-peer-<from>-<to>`                       4204.
 *   invocations + EXACT flags:
 *     - has-session   `tmux has-session -t <name>`        4011/4205/9506/9571/
 *                                                          10039/10478.
 *     - new-session   `tmux new-session -d -s <name> -x 200 -y 50 [<cmd>]`
 *                       loop 9533 (with cmd) / peer 4206 (no cmd).
 *     - send-keys     `tmux send-keys -t <name>:0 <keys> Enter`           3974,
 *                       `tmux send-keys -t <name>:0 C-c`                  3987.
 *     - kill-session  `tmux kill-session -t <name>`            4299/9514/9575.
 *     - list-sessions `tmux list-sessions -F "#{session_name}"`           9513.
 *     - list-clients  `tmux list-clients -t <name>`                       4208.
 *     - pipe-pane     `tmux pipe-pane -t <name> "<shell-cmd>"`            9537.
 *     - attach        `tmux attach -t <name>`           3951/9564/10484 (exec).
 *   NOTE: the oracle never calls `tmux capture-pane`; it captures live pane
 *   output via `pipe-pane` into a raw log file (9537). We mirror what is THERE
 *   (no capture-pane wrapper), per the BEHAVIORAL-FIDELITY rule.
 *
 * ─── Lib choice: raw `tmux` via execFile, NOT a tmux client lib ──────────────
 * Same rationale as git.ts/github.ts/schedule.ts: the oracle is literal `tmux`
 * CLI invocations with an exact flag set (`new-session -d -s … -x 200 -y 50`,
 * `send-keys … Enter`, `pipe-pane`). We mirror them with `execFile`, keeping the
 * flag sets auditable and adding ZERO runtime deps. The pure session-name
 * derivations are diff-tested; the exec layer is fake-`tmux`-shim tested.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Fixed pane geometry the oracle creates every session with (bin/roll
 *  9533/4206): `-x 200 -y 50`. */
export const TMUX_WIDTH = 200;
export const TMUX_HEIGHT = 50;

// ─── session-name derivation (pure — mirrors 9483/4204) ───────────────────────

/** `roll-loop-<slug>` — the loop cycle session name (bin/roll 9483/10471). */
export function loopSessionName(slug: string): string {
  return `roll-loop-${slug}`;
}

/** `roll-peer-<from>-<to>` — the peer-review session name (bin/roll 4204). */
export function peerSessionName(fromTool: string, toTool: string): string {
  return `roll-peer-${fromTool}-${toTool}`;
}

/** Recover the slug from a `run-<slug>.sh` runner basename, mirroring the
 *  runner's `basename "$0" .sh | sed 's/^run-//'` (bin/roll 9465/9483). Given a
 *  path or basename, strips a `.sh` suffix and a leading `run-`. */
export function slugFromRunnerScript(scriptPathOrName: string): string {
  const base = scriptPathOrName.split("/").pop() ?? scriptPathOrName;
  const noExt = base.endsWith(".sh") ? base.slice(0, -".sh".length) : base;
  return noExt.startsWith("run-") ? noExt.slice("run-".length) : noExt;
}

// ─── tmux exec wrappers (thin — exact flags from the inventory above) ─────────

/** Result of a `tmux` invocation. */
export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `tmux <args>`; never throws on a non-zero exit (every oracle tmux call is
 *  lenient — `2>/dev/null` and/or `|| true`). Throws only on a spawn failure
 *  (tmux binary missing), which the oracle gates with `command -v tmux`. */
export async function tmux(args: readonly string[]): Promise<TmuxResult> {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", [...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    if (typeof err.code === "number") {
      return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    if (err.stdout !== undefined || err.stderr !== undefined) {
      return { code: 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw e; // tmux binary not found
  }
}

/** `command -v tmux` — true iff a runnable `tmux` is on PATH (the oracle's
 *  universal precondition, e.g. bin/roll 4203/9512/10473). */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { encoding: "utf8" });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** `tmux has-session -t <name>` — true iff the session exists (exit 0)
 *  (bin/roll 4205/9506/10478). */
export async function hasSession(name: string): Promise<boolean> {
  const r = await tmux(["has-session", "-t", name]);
  return r.code === 0;
}

/**
 * `tmux new-session -d -s <name> -x 200 -y 50 [<command>]`
 * (bin/roll 9533 with a command / 4206 without). Detached (`-d`), fixed geometry.
 * When `command` is given it is appended as the session's initial command,
 * exactly as the loop runner spawns `bash "$INNER_SCRIPT"`.
 */
export async function newSession(name: string, command?: string): Promise<TmuxResult> {
  const args = ["new-session", "-d", "-s", name, "-x", String(TMUX_WIDTH), "-y", String(TMUX_HEIGHT)];
  if (command !== undefined) args.push(command);
  return tmux(args);
}

/**
 * `tmux send-keys -t <name>:0 <keys> Enter` (bin/roll 3974). Sends a literal key
 * string to window 0 followed by the Enter key — the oracle's command-dispatch
 * idiom. `keys` is passed as one argv element (the shell command string).
 */
export async function sendKeysEnter(name: string, keys: string): Promise<TmuxResult> {
  return tmux(["send-keys", "-t", `${name}:0`, keys, "Enter"]);
}

/** `tmux send-keys -t <name>:0 C-c` (bin/roll 3987) — interrupt the running
 *  command in window 0 (the peer-timeout Ctrl-C). */
export async function sendInterrupt(name: string): Promise<TmuxResult> {
  return tmux(["send-keys", "-t", `${name}:0`, "C-c"]);
}

/** `tmux kill-session -t <name>` (bin/roll 4299/9514/9575). */
export async function killSession(name: string): Promise<TmuxResult> {
  return tmux(["kill-session", "-t", name]);
}

/**
 * `tmux list-sessions -F "#{session_name}"` (bin/roll 9513) → the session names,
 * one per line (blanks dropped). [] when tmux has no server / no sessions.
 */
export async function listSessions(): Promise<string[]> {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l !== "");
}

/**
 * `tmux list-clients -t <name>` (bin/roll 4208). Returns true iff any client is
 * attached — mirroring the oracle's `[ -z "$(tmux list-clients …)" ]` test
 * (non-empty output ⇒ a client is attached). [] / empty ⇒ no client.
 */
export async function hasClients(name: string): Promise<boolean> {
  const r = await tmux(["list-clients", "-t", name]);
  if (r.code !== 0) return false;
  return r.stdout.split("\n").some((l) => l !== "");
}

/**
 * `tmux pipe-pane -t <name> "<shell-cmd>"` (bin/roll 9537). Streams the pane's
 * live output through the given shell command (the oracle uses
 * `cat >> "$ROLL_CYCLE_LOG_RAW"`). `shellCmd` is one argv element.
 */
export async function pipePane(name: string, shellCmd: string): Promise<TmuxResult> {
  return tmux(["pipe-pane", "-t", name, shellCmd]);
}

/**
 * Build the `tmux attach -t <name>` argv (bin/roll 3951/9564/10484). The oracle
 * uses this with `exec` to hand the terminal to tmux (`_loop_attach` 10484), so
 * the v3 CLI caller likewise `exec`s / spawns it inheriting stdio rather than
 * capturing — hence this returns the argv instead of running it. Pure.
 */
export function attachArgv(name: string): string[] {
  return ["attach", "-t", name];
}
