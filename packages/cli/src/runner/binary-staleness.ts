/**
 * FIX-366 (part 2, optional/low-cost) — binary-too-old SOFT warning for the loop.
 *
 * When the globally-installed `roll` running the loop falls behind the published
 * release, fixes the owner already shipped never reach the unattended loop. This
 * is a pure observability nudge: it writes ONE actionable ALERT and NEVER blocks
 * or fails the cycle.
 *
 * Cost discipline (the same KISS bar the rest of FIX-366 holds): this is NOT a
 * per-tick probe. The remote latest is cached on disk and refreshed AT MOST once
 * per {@link STALE_CHECK_TTL_MS} (24h) per machine, so a hot loop adds zero
 * network calls after the first check of the day. A miss (offline, curl absent,
 * unparseable) is a SILENT no-op — never an error, never a block. This is a
 * RELEASE-version cache (changes ~daily), categorically different from the
 * per-agent auth-state TTL cache the spec's red line forbids (a stale positive
 * there would mask a just-logged-out agent; a stale version here at worst delays
 * a cosmetic "you're one release behind" hint by a day).
 */
import { execFile } from "node:child_process";
import { ROLL_PACKAGE_NAME } from "@roll/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Refresh the cached remote-latest at most once per 24h (per machine). */
export const STALE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

interface VersionCache {
  latest: string;
  fetchedAtMs: number;
}

/** Parse a `vX.Y.Z` / `X.Y.Z` tag into numeric components (extra parts ignored). */
function parseSemverish(v: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `running` is strictly behind `latest` (both `X.Y.Z`-ish). Any parse
 *  miss returns false — we only ever warn on a CONFIDENT "you are older". */
export function isOlderThan(running: string, latest: string): boolean {
  const a = parseSemverish(running);
  const b = parseSemverish(latest);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
}

/** Read the daily cache; null when absent/stale/unparseable. */
function readCache(cachePath: string, nowMs: number): VersionCache | null {
  try {
    if (!existsSync(cachePath)) return null;
    const c = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<VersionCache>;
    if (typeof c.latest !== "string" || typeof c.fetchedAtMs !== "number") return null;
    if (nowMs - c.fetchedAtMs >= STALE_CHECK_TTL_MS) return null;
    return { latest: c.latest, fetchedAtMs: c.fetchedAtMs };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: VersionCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    /* cache write is best-effort */
  }
}

/** One cheap GitHub releases probe (≤5s). Returns "" on any failure. */
async function fetchRemoteLatest(): Promise<string> {
  const pinned = (process.env["ROLL_VERSION"] ?? "").trim();
  if (pinned !== "") return pinned;
  try {
    // US-INSTALL-008: ask npm, not GitHub. The product repo is private now, so
    // an anonymous Releases lookup 404s — and a probe that can only fail is a
    // staleness check that silently never fires.
    const { stdout } = await execFileAsync("npm", ["view", ROLL_PACKAGE_NAME, "version"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return "";
  }
}

export interface StalenessDeps {
  runningVersion: string;
  cachePath: string;
  nowMs: number;
  fetchLatest: () => Promise<string>;
  /** Append a soft ALERT line. */
  alert: (msg: string) => void;
}

/**
 * Resolve the remote latest (daily-cached) and, when the running binary is
 * CONFIDENTLY older, emit ONE soft ALERT. Pure: all I/O is injected so the
 * behaviour is unit-testable. Never throws.
 */
export async function checkBinaryStaleness(deps: StalenessDeps): Promise<{ stale: boolean; latest: string }> {
  try {
    let latest = readCache(deps.cachePath, deps.nowMs)?.latest ?? "";
    if (latest === "") {
      latest = await deps.fetchLatest();
      if (latest !== "") writeCache(deps.cachePath, { latest, fetchedAtMs: deps.nowMs });
    }
    if (latest === "") return { stale: false, latest: "" };
    if (isOlderThan(deps.runningVersion, latest)) {
      deps.alert(
        `[WARN] loop binary is out of date — running v${deps.runningVersion}, latest ${latest}. ` +
          `Run \`roll update\` to pick up shipped fixes (the loop keeps running; this is a soft warning, not a block).\n` +
          `[WARN] loop 运行的 roll 已过旧——当前 v${deps.runningVersion}，最新 ${latest}。` +
          `跑 \`roll update\` 升级（loop 照常运行，仅软提示，不阻断）。`,
      );
      return { stale: true, latest };
    }
    return { stale: false, latest };
  } catch {
    return { stale: false, latest: "" };
  }
}

/** Wire {@link checkBinaryStaleness} to the real install tree + ~/.roll cache.
 *  `runningVersion` is injected (the caller already knows it) to avoid a second
 *  package.json read. Best-effort: never throws, never blocks the cycle. */
export async function warnIfBinaryStale(
  rollHomeDir: string,
  runningVersion: string,
  appendAlert: (msg: string) => void,
): Promise<void> {
  await checkBinaryStaleness({
    runningVersion,
    cachePath: join(rollHomeDir, ".loop-version-check"),
    nowMs: Date.now(),
    fetchLatest: fetchRemoteLatest,
    alert: appendAlert,
  });
}

/** Pure read-out of the cached staleness state, suitable for observation surfaces
 *  like `roll doctor`. NEVER fetches the network and NEVER writes the cache — it
 *  only reflects whatever the loop run-once pre-check (or a prior run) already
 *  deposited. Returns `latest: ""` when no fresh cache exists. */
export function resolveBinaryStalenessReadout(
  rollHomeDir: string,
  runningVersion: string,
): { stale: boolean; latest: string; current: string; checkedAtMs: number | null } {
  const cachePath = join(rollHomeDir, ".loop-version-check");
  const cache = readCache(cachePath, Date.now());
  if (cache === null) {
    return { stale: false, latest: "", current: runningVersion, checkedAtMs: null };
  }
  return {
    stale: isOlderThan(runningVersion, cache.latest),
    latest: cache.latest,
    current: runningVersion,
    checkedAtMs: cache.fetchedAtMs,
  };
}
