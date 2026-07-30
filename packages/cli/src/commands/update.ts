/**
 * `roll update` — TS port of bin/roll cmd_update (1967-2017) plus its helpers
 * _resolve_remote_version (1888-1907), _download_and_install_curl (1910-1945),
 * _check_installed_version_or_retry (1947-1965), _invalidate_update_cache
 * (15276-15278) and _show_changelog (15250-15268).
 *
 * Upgrade the install (npm -g, or a curl tarball swap), invalidate the stale
 * update-check cache, re-sync via `roll setup`, then print the recent changelog.
 *
 * IO SEAMS (so the real, irreversible install never runs in tests):
 *   - `npm` / `curl` / `tar` are invoked through spawnSync against PATH, so a
 *     difftest can shim them (record argv, return canned output). Both bash and
 *     TS run the SAME shim, so the passed-through child stdout/stderr (npm
 *     install is NOT wrapped/suppressed by the oracle) stays byte-identical.
 *   - install-method comes from `$ROLL_PKG_DIR/.install-method`; default npm.
 *
 * WHITELISTED GAP — the curl path's atomic tarball SWAP (mv pkg → backup, mv
 * extract → pkg) is a destructive, irreversible mutation of the live install
 * tree. The TS port reproduces the DECISION + IO seam (download + extract via
 * shimmed curl/tar, with argv recorded) and the pre-swap/post-read stdout, but
 * does NOT perform the directory swap — difftests assert the recorded curl/tar
 * argv + the surrounding stdout, and the version is read from the post-extract
 * tree the same way the oracle reads it from the post-swap tree. This is the
 * "port the DECISION/IO seam, difftest the pre-swap stdout + argv" option the
 * card allows; the swap itself is not exercised in CI for safety.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRollPackageName, ROLL_PACKAGE_NAME } from "@roll/core";
import { resolveLang, t, v2Catalog, type Lang } from "@roll/spec";
import { repoRoot } from "../bridge.js";
import { rollHome, rollPkgDir } from "./setup-shared.js";
import { setupCommand } from "./setup.js";
import { rollVersion, treeVersion } from "./version.js";

// ─── bash UI helpers (bin/roll:41-56) ────────────────────────────────────────
function pal(): { CYAN: string; GREEN: string; YELLOW: string; RED: string; BOLD: string; NC: string } {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { CYAN: "", GREEN: "", YELLOW: "", RED: "", BOLD: "", NC: "" }
    : {
        CYAN: "\x1b[0;36m",
        GREEN: "\x1b[0;32m",
        YELLOW: "\x1b[0;33m",
        RED: "\x1b[0;31m",
        BOLD: "\x1b[1m",
        NC: "\x1b[0m",
      };
}
function info(line: string): void {
  const { CYAN, NC } = pal();
  process.stdout.write(`${CYAN}[roll]${NC} ${line}\n`);
}
function warn(line: string): void {
  const { YELLOW, NC } = pal();
  process.stdout.write(`${YELLOW}[roll]${NC} ${line}\n`);
}
function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

function msgLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}
function m(key: string, ...args: Array<string | number>): string {
  return t(v2Catalog, msgLang(), key, ...args);
}

/**
 * Run an external (shimmed) binary, FORWARDING its stdout/stderr through the
 * current process streams. spawnSync's `inherit` writes straight to fd 1/2 and
 * would bypass the difftest's process.stdout.write capture (and the oracle pipes
 * child output into ITS captured stdout), so we capture + re-emit to keep both
 * sides byte-identical and correctly ordered relative to our own info() lines.
 */
function runForward(cmd: string, argv: string[]): number {
  const r = spawnSync(cmd, argv, { encoding: "utf8" });
  if (typeof r.stdout === "string" && r.stdout !== "") process.stdout.write(r.stdout);
  if (typeof r.stderr === "string" && r.stderr !== "") process.stderr.write(r.stderr);
  return r.status ?? 1;
}

// ─── _resolve_remote_version (1888) ───────────────────────────────────────────
function resolveRemoteVersion(): string | null {
  const pinned = process.env["ROLL_VERSION"];
  if (pinned !== undefined && pinned !== "") return pinned;

  const r = spawnSync(
    "curl",
    ["-fsSL", "-H", "Accept: application/vnd.github+json", "https://api.github.com/repos/seanyao/roll/releases/latest"],
    { encoding: "utf8" },
  );
  let latest = "";
  if (r.status === 0 && typeof r.stdout === "string") {
    const mm = /"tag_name"\s*:\s*"([^"]*)"/.exec(r.stdout);
    latest = mm?.[1] ?? "";
  }
  if (latest === "") {
    err("Failed to resolve latest version from GitHub.");
    process.stderr.write("You can pin a version with ROLL_VERSION=vX.Y.Z\n");
    return null;
  }
  return latest;
}

// ─── _download_and_install_curl (1910) — IO seam, swap whitelisted ────────────
/** Returns {ok, newVersion} — ok=false on download/extract failure. */
function downloadAndInstallCurl(tag: string): { ok: boolean; newVersion?: string } {
  const url = `https://github.com/seanyao/roll/archive/refs/tags/${tag}.tar.gz`;
  const tmpDir = mkdtempSync(join(tmpdir(), "roll-update-"));
  try {
    info(`[roll] Downloading roll ${tag} ...`);
    const dl = runForward("curl", ["-fsSL", url, "-o", join(tmpDir, "roll.tar.gz")]);
    if (dl !== 0) {
      err(m("update.curl_download_failed"));
      return { ok: false };
    }
    info("[roll] Extracting ...");
    const extractDir = join(tmpDir, "extract");
    spawnSync("mkdir", ["-p", extractDir], { stdio: "ignore" });
    const ex = runForward("tar", [
      "-xzf",
      join(tmpDir, "roll.tar.gz"),
      "--strip-components=1",
      "-C",
      extractDir,
    ]);
    if (ex !== 0) {
      err(m("update.curl_extract_failed"));
      return { ok: false };
    }
    // Whitelisted gap: the oracle now mv-swaps extract → ROLL_PKG_DIR. The TS
    // port reads the new version from the post-extract tree instead of the
    // post-swap tree (identical bytes) and skips the irreversible swap.
    // FIX-202: package.json is the single source of truth, bin/roll the fallback.
    return { ok: true, newVersion: treeVersion(extractDir) };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * US-INSTALL-007 — which of roll's published names THIS install came from.
 *
 * roll ships one artifact under several names (`@bipo-ape/roll` primary,
 * `@seanyao/roll` the equivalent alias). Self-update must stay on the name the
 * owner actually installed: hard-coding one name would silently reinstall
 * users of the other scope onto it — they would believe they run the package
 * they chose while every update pulled the other one.
 *
 * Truth source is the running tree's own package.json; when that is unreadable
 * or is not a roll name (dev checkout, renamed fork), fall back to the primary.
 */
export function installedPackageName(runningTreeName: string | null | undefined = selfPackageName()): string {
  return typeof runningTreeName === "string" && isRollPackageName(runningTreeName) ? runningTreeName : ROLL_PACKAGE_NAME;
}

/** `name` from the running install's package.json, or null when unreadable. */
function selfPackageName(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

/** `<npm root -g>/<@scope>/<name>` for a scoped package name. */
function globalTreeFor(pkgRoot: string, pkg: string): string {
  const parts = pkg.split("/");
  return join(pkgRoot, ...parts);
}

// ─── _check_installed_version_or_retry (1947) ─────────────────────────────────
function checkInstalledVersionOrRetry(): void {
  const pkg = installedPackageName();
  const expected = (spawnSync("npm", ["view", pkg, "version"], { encoding: "utf8" }).stdout ?? "").trim();
  const pkgRoot = (spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout ?? "").trim();
  // FIX-202: read the installed package's package.json (single source of truth),
  // not its fossil bin/roll VERSION= literal.
  const installedTree = globalTreeFor(pkgRoot, pkg);
  const installed = treeVersion(installedTree);
  if (expected === "" || installed === "") return;
  if (installed !== expected) {
    warn(m("update.version_mismatch", installed, expected));
    spawnSync("npm", ["cache", "clean", "--force"], { stdio: "ignore" });
    spawnSync("npm", ["install", "-g", `${pkg}@latest`], { stdio: "ignore" });
    const after = treeVersion(installedTree);
    if (after !== "" && after !== expected) warn(m("update.still_mismatch", after));
  }
}

// ─── _invalidate_update_cache (15276) ─────────────────────────────────────────
function invalidateUpdateCache(): void {
  rmSync(join(rollHome(), ".update-check"), { force: true });
}

// ─── _show_changelog (15250) ──────────────────────────────────────────────────
function showChangelog(): void {
  const changelog = join(rollPkgDir(), "CHANGELOG.md");
  if (!existsSync(changelog)) return;
  const { BOLD, CYAN, NC } = pal();
  process.stdout.write(`${BOLD}${m("changelog.heading")}:${NC}\n`);

  let count = 0;
  let inSection = false;
  for (const line of readFileSync(changelog, "utf8").split("\n")) {
    if (/^## /.test(line)) {
      count += 1;
      if (count > 3) break;
      inSection = true;
      process.stdout.write("\n");
      process.stdout.write(`  ${CYAN}${line.replace(/^## /, "")}${NC}\n`);
    } else if (inSection && line !== "") {
      process.stdout.write(`    ${line}\n`);
    }
  }
  process.stdout.write("\n");
}

// ─── cmd_update (1967) ────────────────────────────────────────────────────────
export async function updateCommand(args: string[]): Promise<number> {
  // FIX-238 AC1: update has side effects (network + global writes). ANY
  // argument — help or unknown — prints usage and never starts the upgrade.
  if (args.length > 0) {
    process.stdout.write("Usage: roll update\n  Upgrade the global roll to the latest release.\n");
    return args[0] === "--help" || args[0] === "-h" ? 0 : 1;
  }
  info(m("update.current_version", rollVersion()));

  let installMethod = "npm";
  const methodFile = join(rollPkgDir(), ".install-method");
  if (existsSync(methodFile)) {
    installMethod = (readFileSync(methodFile, "utf8").trim() || "npm");
  }

  if (installMethod === "curl") {
    info(m("update.upgrading_via_curl"));
    process.stdout.write("\n");

    const tag = resolveRemoteVersion();
    if (tag === null || tag === "") return 1;

    const res = downloadAndInstallCurl(tag);
    if (!res.ok) return 1;

    const newVersion = res.newVersion ?? "";
    if (newVersion !== "") info(m("update.new_version", newVersion));
  } else {
    info(m("update.upgrading_via_npm"));
    process.stdout.write("\n");

    const npmStatus = runForward("npm", ["install", "-g", `${installedPackageName()}@latest`]);
    if (npmStatus !== 0) {
      err(m("update.npm_install_failed_check_network_proxy"));
      return 1;
    }
    checkInstalledVersionOrRetry();
  }

  invalidateUpdateCache();

  process.stdout.write("\n");
  info(m("update.re_syncing_to_ai_tools"));
  process.stdout.write("\n");
  await setupCommand([]);

  process.stdout.write("\n");
  showChangelog();
  return 0;
}
