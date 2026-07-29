/**
 * US-LOOP-112 — how Roll describes the way this project is being driven.
 *
 * This module used to answer a BINARY question: `guided` or `autonomous`. Its one
 * and only judge was whether a launchd plist existed and was loaded:
 *
 *   launchdLabel("loop", slug) → ~/Library/LaunchAgents/<label>.plist exists?
 *                              → launchctl print says enabled?
 *                              → autonomous, else guided
 *
 * So "autonomous" never meant "Roll is driving itself" — it meant "a timer is
 * installed". With the daemon lanes retired there is no second judge to swap in,
 * because there is no second mode: every delivery runs inside a host agent
 * session, and that session is the Supervisor.
 *
 * What survives is the part that was always real: whether the owner has PAUSED
 * autonomous progress. So the view keeps its output slots (`reason`,
 * `ownerAction`, `schedulerAction` — consumed by `roll supervisor next/why/advise`)
 * and drops the mode binary along with the install-state axis.
 */
import { projectSlug as deriveProjectSlug } from "@roll/spec";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * The single way Roll is driven. Kept as a one-value union (rather than deleted)
 * so the `mode` slot in `roll supervisor --json` stays present and self-describing
 * for downstream readers.
 */
export type RollOperatingMode = "session-driven";

/** Whether the owner has paused autonomous progress in this project. */
type RunState = "active" | "paused";

export interface OperatingModeView {
  readonly mode: RollOperatingMode;
  readonly runState: RunState;
  readonly slug: string;
  readonly reason: string;
  readonly ownerAction: string;
  readonly schedulerAction: string;
}

export interface OperatingModeDeps {
  /** Path-existence probe, injectable so tests never touch a real home dir. */
  readonly probe?: (path: string) => boolean;
}

function gitOutput(projectPath: string, argv: readonly string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", projectPath, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function canonicalProjectPath(projectPath: string): string {
  let path = projectPath;
  if (process.platform === "darwin") {
    try {
      path = realpathSync(path);
    } catch {
      /* keep caller path */
    }
  }
  const top = gitOutput(path, ["rev-parse", "--show-toplevel"]);
  return top !== undefined && top !== "" ? top : path;
}

function remoteUrl(projectPath: string): string | undefined {
  const origin = gitOutput(projectPath, ["remote", "get-url", "origin"]);
  if (origin !== undefined && origin !== "") return origin;
  const remotes = gitOutput(projectPath, ["remote"]);
  const first = remotes?.split("\n").find((r) => r.trim() !== "")?.trim();
  return first === undefined ? undefined : gitOutput(projectPath, ["remote", "get-url", first]);
}

export function projectOperatingSlug(projectPath: string = process.cwd()): string {
  // ROLL_MAIN_SLUG wins outright (US-LOOP-006) — unrelated to the mode collapse,
  // so it stays exactly as it was.
  const override = process.env["ROLL_MAIN_SLUG"];
  if (override !== undefined && override !== "") return override;
  const path = canonicalProjectPath(projectPath);
  return deriveProjectSlug({ path, remoteUrl: remoteUrl(path) });
}

function runState(projectPath: string, slug: string, probe: (p: string) => boolean): RunState {
  // PAUSE is the one real state left: it stops autonomous progress. A guided
  // one-shot (`roll loop go --cards <id>`) still runs while paused (FIX-1472).
  return probe(join(projectPath, ".roll", "loop", `PAUSE-${slug}`)) ? "paused" : "active";
}

function nextAction(run: RunState): string {
  if (run === "paused") {
    return "autonomous progress is paused — resume it, or drive one card now with `roll loop go --cards <id>`";
  }
  return "run `roll supervisor next`, then start work with `roll loop go` in this session";
}

export function resolveOperatingMode(
  projectPath: string = process.cwd(),
  deps: OperatingModeDeps = {},
): OperatingModeView {
  const probe = deps.probe ?? existsSync;
  const slug = projectOperatingSlug(projectPath);
  const state = runState(projectPath, slug, probe);
  return {
    mode: "session-driven",
    runState: state,
    slug,
    reason:
      state === "paused"
        ? "pause marker is present; autonomous progress stays stopped until it is cleared"
        : "delivery runs in this agent session — the session is the Supervisor",
    ownerAction: nextAction(state),
    schedulerAction:
      state === "paused"
        ? "no card will be picked autonomously while the pause marker is present"
        : "cards advance only while a session drives them, and still honor budget, route, evidence, Evaluator, and release gates",
  };
}

export function formatOperatingMode(view: OperatingModeView): string {
  return `mode: ${view.mode} (${view.runState}) — ${view.reason}`;
}

export function suggestedGuidedRun(storyId: string | null): string {
  return storyId === null ? "run `roll supervisor why` or add a Todo story" : `run \`roll loop go --cards ${storyId}\``;
}
