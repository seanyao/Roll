/**
 * CLI bridge — US-SCAF-004 / US-PORT-021.
 *
 * Commands route TS-first: a subcommand registered in the ported table runs its
 * TypeScript handler. Every command is now TS-native, so the bash `bin/roll`
 * fallback is retired — an unregistered command prints the usage (no bash spawn).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLang } from "@roll/spec";
import { networkNeeds, requireNetwork } from "./lib/require-network.js";
import { publicCommands } from "./lib/command-surface.js";
import { renderFrontDoor } from "./lib/front-door.js";
import { isSnapshotStale, loadTruthSnapshot, renderNowMs } from "./lib/truth-read.js";
import { renderState } from "./render.js";
import { treeVersion } from "./commands/version.js";

/** A ported subcommand: receives args after the subcommand, returns exit code. */
export type Handler = (args: string[]) => number | Promise<number>;

const ported = new Map<string, Handler>();
// REFACTOR-049: commands that stay callable (aliases / emergency manual entry
// points) but are hidden from the main usage list to keep the surface lean.
const hidden = new Set<string>();
// FIX-239: per-command usage text. When registered, the bridge enforces the
// ONE help contract centrally — `roll <cmd> --help|-h` prints this to stdout
// and exits 0 BEFORE the handler runs (so a cry for help can never trigger
// side effects, the FIX-238 `update --help` upgrade incident). Commands with
// richer internal help simply don't register a string and keep handling it.
//
// US-DOSSIER-035: help may also be a `() => string` PROVIDER — the bridge calls
// it (read-only, side-effect-free by contract) at `--help` time so a command can
// render locale-resolved / grouped help (e.g. `roll loop --help`) while still
// going through the central read-only enforcement.
type HelpSpec = string | (() => string);
const helpText = new Map<string, HelpSpec>();

export function registerPorted(command: string, handler: Handler, opts?: { hidden?: boolean; help?: HelpSpec }): void {
  ported.set(command, handler);
  if (opts?.hidden === true) hidden.add(command);
  if (opts?.help !== undefined) helpText.set(command, opts.help);
}

/** Commands with bridge-enforced help (FIX-239 AC3's table). */
export function registeredHelp(): string[] {
  return [...helpText.keys()].sort();
}

export function isPorted(command: string): boolean {
  return ported.has(command);
}

export function portedCommands(): string[] {
  return [...ported.keys()].sort();
}

/**
 * Walk up from this module to the package root. US-PORT-021 prep: the root
 * marker is the shipped `conventions/` directory (present in both the dev repo
 * and the published npm package's `files`) — the bash engine (`bin/roll`) is
 * retired (US-PORT-021).
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "conventions"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("bridge: cannot locate package root (no conventions/ marker)");
}

export interface RunResult {
  status: number;
}

/** Top-level usage — TS-native (no bash). REFACTOR-056: the command list is
 *  projected from the ONE command-surface truth source (the approved public
 *  top-level commands), NOT from ad hoc ported-command enumeration. Nested,
 *  internal, and removed surfaces stay callable as registered but are never
 *  listed here. */
export function usage(): string {
  const cmds = publicCommands().join(", ");
  return (
    `roll <command> [args]\n\n` +
    `Commands: ${cmds}\n\n` +
    `Run \`roll <command> --help\` for command-specific help.\n`
  );
}

/**
 * US-DOSSIER-035 — the bare-`roll` front door (design frame 0). Read-only,
 * exits 0: one identity line (version + injected slogan), one verdict line read
 * from the ONE TruthSnapshot the web reads, and a three-row command map. When
 * the snapshot is missing/stale the verdict falls back honestly (AC2). `roll
 * help`/`--help`/`-h` keep the usage contract below — this fires only on no args.
 */
export function frontDoor(): string {
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  if (!process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "") renderState.useColor = false;
  let snapshot: ReturnType<typeof loadTruthSnapshot>;
  let stale = false;
  try {
    snapshot = loadTruthSnapshot(process.cwd());
    if (snapshot !== undefined) stale = isSnapshotStale(snapshot, renderNowMs());
  } catch {
    snapshot = undefined;
  }
  return renderFrontDoor({
    version: treeVersion(repoRoot()),
    slogan: process.env["ROLL_BRAND_SLOGAN"] ?? "It just works.",
    snapshot,
    stale,
    lang,
  });
}

/**
 * TS-first dispatch (US-PORT-021: no bash fallback). A registered command runs
 * its handler; `help`/`--help`/`-h` prints the usage (exit 0); no command at all
 * prints the front door (US-DOSSIER-035, exit 0); any other unknown command
 * prints "unknown command" + usage (exit 1).
 */
export async function dispatch(
  argv: string[],
  // FIX-298: the network guard is injectable so the wiring is unit-testable
  // without real network IO. Production passes nothing → the real guard runs.
  gate: (commandName: string) => Promise<{ ok: boolean }> = (name) => requireNetwork(name, process.cwd()),
): Promise<RunResult> {
  const [command, ...rest] = argv;
  if (command !== undefined) {
    const handler = ported.get(command);
    if (handler !== undefined) {
      // FIX-238/239: the contract half the bridge owns — help is read-only.
      const help = helpText.get(command);
      if (help !== undefined && (rest[0] === "--help" || rest[0] === "-h")) {
        const text = typeof help === "function" ? help() : help;
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
        return { status: 0 };
      }
      // FIX-298: the network guard is the FIRST checkpoint for any command that
      // needs the network. ONE declarative model (networkNeeds) + ONE shared
      // guard (requireNetwork); downstream handlers stay agnostic. On a dead
      // network with no recovery the guard halts here — the handler never runs,
      // never spins, never silently degrades. `roll run-once` runs its own
      // per-cycle guard, so networkNeeds returns null for it (no double check).
      const gateName = networkNeeds(command, rest);
      if (gateName !== null) {
        const net = await gate(gateName);
        if (!net.ok) return { status: 1 };
      }
      return { status: await handler(rest) };
    }
  }
  if (command === undefined || command === "") {
    process.stdout.write(frontDoor());
    return { status: 0 };
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return { status: 0 };
  }
  process.stderr.write(`roll: unknown command '${command}'\n\n${usage()}`);
  return { status: 1 };
}
