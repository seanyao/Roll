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
import { resolveLang, t, v3Catalog } from "@roll/spec";
import { networkNeeds, requireNetwork } from "./lib/require-network.js";
import {
  aliasHelpDecision,
  canonicalTopLevelCommand,
  cliOperationForArgs,
  isWorkspaceSelectorAlias,
  publicCommands,
  WORKSPACE_SELECTOR_ALIAS,
  type WorkspaceSelectorOperationDecision,
  type CliCommandOperationRegistration,
} from "./lib/command-surface.js";
import { renderFrontDoor } from "./lib/front-door.js";
import {
  hasCanonicalWorkspaceSelectorBeforeSentinel,
  isCanonicalWorkspaceSelectorToken,
} from "./lib/workspace-selector.js";
import { isSnapshotStale, loadTruthSnapshot, renderNowMs } from "./lib/truth-read.js";
import { renderState } from "./render.js";
import { treeVersion } from "./commands/version.js";
import { resolveCurrent } from "./commands/lang.js";
import { type WakeDeps, tryWakeOnRoll, buildProductionWakeDeps, createProductionWakeDeps } from "./lib/wake-hook.js";
export { buildProductionWakeDeps, createProductionWakeDeps };

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
export interface RejectedCliRoute {
  readonly route: readonly string[];
  readonly message: string;
}
const helpText = new Map<string, HelpSpec>();
const commandOperations = new Map<string, readonly CliCommandOperationRegistration[]>();
const rejectedCommandRoutes = new Map<string, readonly RejectedCliRoute[]>();

export function registerPorted(command: string, handler: Handler, opts?: {
  hidden?: boolean;
  help?: HelpSpec;
  operations?: readonly CliCommandOperationRegistration[];
  rejectedRoutes?: readonly RejectedCliRoute[];
}): void {
  ported.set(command, handler);
  if (opts?.hidden === true) hidden.add(command);
  if (opts?.help !== undefined) helpText.set(command, opts.help);
  if (opts?.operations !== undefined) commandOperations.set(command, [...opts.operations]);
  if (opts?.rejectedRoutes !== undefined) rejectedCommandRoutes.set(command, [...opts.rejectedRoutes]);
}

/** Actual operation metadata attached to live bridge registrations. */
export function registeredCliOperations(): CliCommandOperationRegistration[] {
  return [...commandOperations.values()].flat().sort((left, right) =>
    `${left.command}:${left.operation}`.localeCompare(`${right.command}:${right.operation}`));
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

export interface CanonicalWorkspaceAliasTokens {
  readonly args: readonly string[];
  readonly aliasUsed: boolean;
}

export type ParsedWorkspaceSelectorArgs =
  | { readonly ok: true; readonly selector?: string; readonly remaining: readonly string[] }
  | { readonly ok: false; readonly code: "duplicate_workspace_selector" | "workspace_selector_missing_value" };

/** Rewrite only exact pre-sentinel alias tokens; order and all other bytes stay stable. */
export function canonicalizeWorkspaceAliasTokens(args: readonly string[]): CanonicalWorkspaceAliasTokens {
  let aliasUsed = false;
  let optionsEnded = false;
  const canonical = args.map((arg) => {
    if (optionsEnded) return arg;
    if (arg === "--") {
      optionsEnded = true;
      return arg;
    }
    if (isWorkspaceSelectorAlias(arg)) {
      aliasUsed = true;
      return WORKSPACE_SELECTOR_ALIAS.canonical;
    }
    return arg;
  });
  return { args: canonical, aliasUsed };
}

/** Validate and remove the canonical selector while preserving post-sentinel literals. */
export function parseCanonicalWorkspaceSelectorArgs(args: readonly string[]): ParsedWorkspaceSelectorArgs {
  const selectorIndices: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (isCanonicalWorkspaceSelectorToken(arg)) selectorIndices.push(index);
  }
  if (selectorIndices.length > 1) return { ok: false, code: "duplicate_workspace_selector" };
  const index = selectorIndices[0];
  if (index === undefined) return { ok: true, remaining: [...args] };
  const selector = args[index + 1];
  if (selector === undefined || selector.startsWith("-")) {
    return { ok: false, code: "workspace_selector_missing_value" };
  }
  return {
    ok: true,
    selector,
    remaining: [...args.slice(0, index), ...args.slice(index + 2)],
  };
}

function jsonFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--json") return true;
  }
  return false;
}

function emitWorkspaceSelectorError(
  code: Extract<ParsedWorkspaceSelectorArgs, { readonly ok: false }>["code"],
  operation: WorkspaceSelectorOperationDecision,
  args: readonly string[],
): RunResult {
  const lang = resolveCurrent();
  const message = t(v3Catalog, lang, `workspace.selector.error.${code}`);
  const nextAction = t(v3Catalog, lang, `workspace.selector.next.${code}`);
  if (jsonFlag(args)) {
    process.stderr.write(`${JSON.stringify({
      schema: "roll.workspace-selector-error/v1",
      error: { code, message, command: operation.canonicalCommand, nextAction },
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`${t(v3Catalog, lang, "workspace.selector.error.line", operation.canonicalCommand, code, message)}\n`);
    process.stderr.write(`${nextAction}\n`);
  }
  return { status: 1 };
}

function renderHelp(command: string, help: HelpSpec): string {
  const text = typeof help === "function" ? help() : help;
  const aliases = aliasHelpDecision(command, commandOperations.get(command) ?? []);
  if (aliases === undefined) return text;
  const lang = resolveCurrent();
  const lines: string[] = [];
  for (const alias of aliases.commandAliases) {
    lines.push(t(v3Catalog, lang, "workspace.alias.help.command", alias, aliases.canonicalCommand));
  }
  for (const alias of aliases.workspaceSelectorAliases) {
    lines.push(t(v3Catalog, lang, "workspace.alias.help.selector", alias, WORKSPACE_SELECTOR_ALIAS.canonical));
  }
  return lines.length === 0 ? text : `${text.trimEnd()}\n\n${lines.join("\n")}`;
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
  // US-LOOP-079i: wake-on-roll hook deps — injectable for testing.
  // Production passes real deps from bin/roll.js; tests omit to skip wake.
  wakeDeps?: WakeDeps,
): Promise<RunResult> {
  const [rawCommand, ...rawRest] = argv;
  const command = rawCommand === undefined ? undefined : canonicalTopLevelCommand(rawCommand);
  const normalized = canonicalizeWorkspaceAliasTokens(rawRest);
  const rest = [...normalized.args];
  if (command !== undefined) {
    const handler = ported.get(command);
    if (handler !== undefined) {
      // FIX-238/239: the contract half the bridge owns — help is read-only.
      const help = helpText.get(command);
      if (help !== undefined && (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h")) {
        const text = renderHelp(command, help);
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
        return { status: 0 };
      }
      const operations = commandOperations.get(command) ?? [];
      const rejected = (rejectedCommandRoutes.get(command) ?? [])
        .filter((entry) => entry.route.every((token, index) => rest[index] === token))
        .sort((left, right) => right.route.length - left.route.length)[0];
      if (rejected !== undefined) {
        process.stderr.write(rejected.message.endsWith("\n") ? rejected.message : `${rejected.message}\n`);
        return { status: 1 };
      }
      const operation = cliOperationForArgs(command, rest, operations);
      if (operations.length > 0 && operation === undefined) {
        const route = rest.slice(0, 2).join(" ") || "<root>";
        process.stderr.write(`roll ${command}: unknown or unregistered route '${route}'\n`);
        return { status: 1 };
      }
      const hasWorkspaceSelector = hasCanonicalWorkspaceSelectorBeforeSentinel(rest);
      if (hasWorkspaceSelector && operation !== undefined && !operation.supportsWorkspaceSelector) {
        process.stderr.write(`roll ${command}: operation '${operation.operation}' does not accept --workspace\n`);
        return { status: 1 };
      }
      if (operation?.supportsWorkspaceSelector === true) {
        const selectorOperation: WorkspaceSelectorOperationDecision = {
          id: `${operation.command}.${operation.operation}`,
          operation: operation.operation,
          command: operation.command,
          route: operation.route,
          canonicalCommand: operation.canonicalCommand,
          exampleArgs: operation.exampleArgs ?? [],
          acceptsWorkspaceSelector: true,
        };
        const parsed = parseCanonicalWorkspaceSelectorArgs(rest);
        if (!parsed.ok) return emitWorkspaceSelectorError(parsed.code, selectorOperation, rest);
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
      // US-LOOP-079i: wake-on-roll-command hook — after help short-circuit
      // (FIX-238) but before the handler runs. Only fires when production
      // deps are wired (tests skip).
      if (wakeDeps) await tryWakeOnRoll([command, ...rest], wakeDeps);
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
