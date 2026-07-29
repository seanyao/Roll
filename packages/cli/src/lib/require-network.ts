/**
 * FIX-298 — the shared network guard.
 *
 * Owner design: any roll command that needs the network MUST, as its FIRST
 * checkpoint, verify connectivity (including a poisoned proxy env). The recovery
 * path is ACTIVE: on not-connected, run a CONFIGURED proxy-enable command and
 * re-check; only if it is STILL down (or nothing is configured) do we HALT
 * immediately with a clear, actionable, bilingual reason. Never proceed on a
 * dead network, never spin, never silently degrade.
 *
 * THESIS — one standard model, one normalization layer, no scattered special-
 * casing. There is exactly ONE connectivity probe ({@link networkReachable}) and
 * ONE guard ({@link requireNetwork}); every network-needing command calls the
 * SAME guard as its first checkpoint and declares its own name. The loop's
 * per-cycle egress pre-check (FIX-232) is now this same guard, so the behaviour
 * is defined in one place.
 *
 * PORTABILITY — no personal proxy tool is hardcoded. The proxy-enable command is
 * a user-set hook (`loop_safety.proxy_enable_cmd` in .roll/policy.yaml). roll
 * runs whatever is configured; nothing configured ⇒ halt-and-tell, no auto-enable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { parsePolicy } from "@roll/core";
import { resolveLang, t, v3Catalog, type Lang } from "@roll/spec";

/** Default probe target — the well-known endpoint roll's foreign network paths
 *  use (PRs, the registry). FIX-1025: this is only a DEFAULT — a domestic-only
 *  workflow can override it with `loop_safety.probe_url` so the precheck targets
 *  a host the work actually needs, instead of a fixed GFW-blocked host. */
const PROBE_HOST = "github.com";
const PROBE_PORT = 443;
const DNS_TIMEOUT_MS = 1500;
const TCP_TIMEOUT_MS = 3000;

/** Parse a configured probe target into { host, port }. Accepts a bare
 *  `host`, `host:port`, or a full `scheme://host[:port][/path]` URL. Defaults to
 *  port 443 (https) when none is given; `http://` defaults to 80. Returns
 *  undefined for unparseable / empty input (caller falls back to the default). */
export function parseProbeTarget(raw: string): { host: string; port: number } | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let scheme = "";
  let rest = trimmed;
  const schemeIdx = rest.indexOf("://");
  if (schemeIdx !== -1) {
    scheme = rest.slice(0, schemeIdx).toLowerCase();
    rest = rest.slice(schemeIdx + 3);
  }
  // Drop any path / query so only authority remains.
  const slashIdx = rest.indexOf("/");
  if (slashIdx !== -1) rest = rest.slice(0, slashIdx);
  if (rest === "") return undefined;
  const colonIdx = rest.lastIndexOf(":");
  let host = rest;
  let port = scheme === "http" ? 80 : 443;
  if (colonIdx !== -1) {
    const p = Number(rest.slice(colonIdx + 1));
    if (!Number.isFinite(p) || p < 1 || p > 65535) return undefined;
    host = rest.slice(0, colonIdx);
    port = p;
  }
  if (host === "") return undefined;
  return { host, port };
}

/**
 * The standard model of WHICH commands need the network, declared in ONE place
 * (the thesis: one model, no scattered per-command special-casing). The bridge
 * dispatch consults this as its FIRST checkpoint; downstream commands stay
 * agnostic.
 *
 * A command needs the network when it spawns agents, opens/merges PRs, or pulls
 * from the registry / network: `loop go`, `loop run-once`, `loop now`, `update`,
 * `showcase`, and the real `release` flow. A `--help`/`-h`/`help` call never
 * needs the network (a cry for help must stay side-effect-free), and the
 * read-only / dry-run sub-routes are excluded (e.g. `release --json`, the
 * dry-run preview, `release consistency`).
 *
 * Returns the user-facing command name to gate (for the halt message), or
 * `null` when this invocation does NOT need the network.
 */
export function networkNeeds(command: string, args: readonly string[]): string | null {
  // A request for help never touches the network.
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") return null;

  switch (command) {
    case "context":
      return args[0] === "read" ? "roll context read" : null;
    case "update":
      return "roll update";
    case "showcase":
      // `--json` still runs the real (network) showcase; only help is exempt.
      return "roll showcase";
    case "release": {
      // Only the REAL release transaction (`roll release` with at most flags)
      // pushes/PRs and needs the network. Everything else is read-only or local:
      // the `consistency` sub-route, the removed sub-routes (ship/waiver/…) that
      // exit with an error, the `--json` plan, and the `--gate-check` CI verdict.
      // The transaction has NO positional subcommand and none of those flags.
      const hasSubcommand = args.some((a) => !a.startsWith("-"));
      if (hasSubcommand) return null;
      if (args.includes("--json") || args.includes("--gate-check") || args.includes("--dry-run")) return null;
      return "roll release";
    }
    case "loop": {
      // Only the agent-spawning / PR sub-routes need the network. Everything
      // else under `loop` is a read-only viewer or local maintenance — e.g.
      // `loop watch` (US-LOOP-074) just tails the local .roll/loop/live.log, so
      // it must NOT be gated by the connectivity check.
      const sub = args[0];
      if (sub === "go") return "roll loop go";
      if (sub === "now") return "roll loop now";
      // `run-once` runs its OWN per-cycle guard (it needs the project path +
      // ALERT mirroring), so the central gate skips it to avoid a double check.
      return null;
    }
    default:
      return null;
  }
}

/** A single TCP connect with a hard wall-clock timeout (no GNU `timeout` on
 *  macOS). Resolves on connect, rejects on error/timeout. */
export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error("tcp timeout")));
    socket.once("connect", () => done());
    socket.once("error", done);
  });
}

/** Injectable probes so the guard is unit-testable without real network IO. */
export interface NetworkProbes {
  /** DNS resolve (default: node dns.lookup). */
  resolve?: (host: string) => Promise<unknown>;
  /** TCP connect to the probe endpoint (default: connect github.com:443). */
  tcpProbe?: () => Promise<void>;
  /** FIX-1025: probe target override (host:port or URL). When set, the default
   *  DNS + TCP probes target this host:port instead of the fixed default. The
   *  explicit `resolve` / `tcpProbe` seams still win (tests inject those). */
  probeUrl?: string;
}

/**
 * The ONE connectivity probe. Two tiers, both with hard timeouts so the check
 * itself can never stall a command:
 *   1. DNS resolve the probe host (cheapest "is there any network" signal).
 *   2. TCP connect to host:443 — catches a proxy-poisoned env where DNS resolves
 *      but the real connection is intercepted by a dead proxy (the FIX-232
 *      127.0.0.1:7897 signature).
 *
 * Returns `true` when the network is reachable, `false` when it is not (DNS
 * failed/offline, or DNS worked but TCP did not). Unlike the old egress check,
 * this treats a plain offline as not-reachable too: the guard's job is "can we
 * actually reach the network", and the active-recovery hook (e.g. a VPN/proxy
 * toggle) is exactly what fixes a plain offline as well as a poisoned proxy.
 */
export async function networkReachable(probes: NetworkProbes = {}): Promise<boolean> {
  // FIX-1025: resolve the probe target from the configured `probe_url` (if any),
  // falling back to the well-known default. The injected seams still take
  // precedence so unit tests stay IO-free.
  const target = (probes.probeUrl !== undefined ? parseProbeTarget(probes.probeUrl) : undefined) ?? {
    host: PROBE_HOST,
    port: PROBE_PORT,
  };
  const resolve = probes.resolve ?? ((h: string) => lookup(h));
  const tcpProbe = probes.tcpProbe ?? (() => tcpConnect(target.host, target.port, TCP_TIMEOUT_MS));

  // Tier 1: DNS. A hung resolver must not hold the command open.
  try {
    await Promise.race([
      resolve(target.host),
      new Promise((_, rej) => {
        const timer = setTimeout(() => rej(new Error("dns timeout")), DNS_TIMEOUT_MS);
        if (typeof timer === "object") timer.unref();
      }),
    ]);
  } catch {
    return false; // DNS failed → offline / unreachable.
  }

  // Tier 2: TCP connect. DNS worked but the connection may be blocked.
  try {
    await tcpProbe();
    return true;
  } catch {
    return false;
  }
}

/** Read the configured proxy-enable hook from `<repoCwd>/.roll/policy.yaml`.
 *  Returns the command string, or undefined when unset/unreadable. Mirrors the
 *  other policy readers (readPeerGateMode / readAttestGateMode). */
export function readProxyEnableCmd(repoCwd: string): string | undefined {
  return readLoopSafetyNet(repoCwd).proxyEnableCmd;
}

/** FIX-1025: the network-guard-relevant slice of loop_safety read from
 *  `<repoCwd>/.roll/policy.yaml`. Returns empty fields when the file is
 *  missing / unparseable (treated as "nothing configured"). */
export interface LoopSafetyNet {
  proxyEnableCmd?: string;
  probeUrl?: string;
  skipNetworkCheck: boolean;
}

export function readLoopSafetyNet(repoCwd: string): LoopSafetyNet {
  try {
    const p = join(repoCwd, ".roll", "policy.yaml");
    if (!existsSync(p)) return { skipNetworkCheck: false };
    const ls = parsePolicy(readFileSync(p, "utf8")).loopSafety;
    return {
      proxyEnableCmd: ls.proxyEnableCmd,
      probeUrl: ls.probeUrl,
      skipNetworkCheck: ls.skipNetworkCheck === true,
    };
  } catch {
    return { skipNetworkCheck: false }; // unreadable / unparseable → nothing configured.
  }
}

/** Outcome of the guard. `ok` ⇒ the command may proceed (network reachable,
 *  possibly after recovery). Otherwise the guard already emitted the bilingual
 *  halt lines and the caller should stop with a non-zero exit. */
export interface RequireNetworkResult {
  ok: boolean;
  /** Whether the proxy-enable hook ran (recovery was attempted). */
  recovered: boolean;
}

/** Injectable seams for {@link requireNetwork} so it is fully unit-testable. */
export interface RequireNetworkDeps {
  /** Connectivity probe (default {@link networkReachable}). Re-invoked after the
   *  recovery command runs, so tests can flip the result between calls. The
   *  configured `probe_url` (if any) is threaded through to the default probe. */
  reachable?: (probes?: NetworkProbes) => Promise<boolean>;
  /** FIX-1025: read the network-relevant loop_safety slice (probe_url +
   *  skip_network_check + proxy_enable_cmd). Default {@link readLoopSafetyNet}. */
  loopSafetyNet?: (repoCwd: string) => LoopSafetyNet;
  /** Read the proxy-enable hook (default {@link readProxyEnableCmd}). Kept for
   *  back-compat with existing call sites/tests; when set it overrides the
   *  proxy-enable command read from {@link loopSafetyNet}. */
  proxyEnableCmd?: (repoCwd: string) => string | undefined;
  /** Run the proxy-enable command (default: spawnSync via the shell). Returns
   *  true if the command exited 0. */
  runProxyEnable?: (cmd: string) => boolean;
  /** Sink for the guard's lines (default: stderr). One line per call. */
  emit?: (line: string) => void;
  /** Resolved language (default: from env). */
  lang?: Lang;
}

function defaultRunProxyEnable(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function defaultLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

/**
 * The shared FIRST-checkpoint guard for any network-needing command.
 *
 * Flow (owner design + FIX-1025):
 *   0. `loop_safety.skip_network_check: true` ⇒ skip the probe entirely (the
 *      user's configured providers are reachable directly).
 *   1. probe connectivity — against `loop_safety.probe_url` when configured,
 *      else the well-known default host.
 *   2. reachable ⇒ proceed.
 *   3. not reachable ⇒ if a proxy-enable command is CONFIGURED: announce, run it,
 *      RE-probe. reachable now ⇒ announce + proceed.
 *   4. still not reachable, or nothing configured ⇒ HALT with a clear, actionable
 *      bilingual reason (the caller exits non-zero). Never proceeds on a dead net.
 *
 * @param commandName  user-facing name for the halt message (e.g. "roll loop go").
 * @param repoCwd      project dir whose .roll/policy.yaml holds the hook.
 */
export async function requireNetwork(
  commandName: string,
  repoCwd: string = process.cwd(),
  deps: RequireNetworkDeps = {},
): Promise<RequireNetworkResult> {
  const reachable = deps.reachable ?? networkReachable;
  const readSafety = deps.loopSafetyNet ?? readLoopSafetyNet;
  const runHook = deps.runProxyEnable ?? defaultRunProxyEnable;
  const emit = deps.emit ?? ((line: string) => process.stderr.write(`${line}\n`));
  const lang = deps.lang ?? defaultLang();

  const safety = readSafety(repoCwd);

  // FIX-1025: explicit opt-out. When the user has declared their configured
  // providers reachable directly, skip the precheck entirely so a fixed-host
  // probe (e.g. a dropped VPN to a foreign host the work never needs) cannot
  // halt loop/release.
  if (safety.skipNetworkCheck) {
    emit(t(v3Catalog, lang, "net.skipped"));
    return { ok: true, recovered: false };
  }

  // FIX-1025: probe the CONFIGURED target when set (e.g. the domestic provider
  // base URL), instead of the fixed foreign default.
  const probes: NetworkProbes = safety.probeUrl !== undefined ? { probeUrl: safety.probeUrl } : {};

  // FIRST checkpoint: probe.
  if (await reachable(probes)) return { ok: true, recovered: false };

  // Not reachable — ACTIVE recovery if (and only if) a hook is configured. The
  // explicit proxyEnableCmd dep wins (back-compat), else read from loop_safety.
  const hook = deps.proxyEnableCmd !== undefined ? deps.proxyEnableCmd(repoCwd) : safety.proxyEnableCmd;
  if (hook === undefined || hook === "") {
    emit(t(v3Catalog, lang, "net.blocked_no_hook", commandName));
    return { ok: false, recovered: false };
  }

  emit(t(v3Catalog, lang, "net.recovering"));
  runHook(hook);

  // Re-check after recovery — only a real reconnection lets the command proceed.
  if (await reachable(probes)) {
    emit(t(v3Catalog, lang, "net.recovered"));
    return { ok: true, recovered: true };
  }

  emit(t(v3Catalog, lang, "net.blocked_after_hook", commandName));
  return { ok: false, recovered: true };
}
