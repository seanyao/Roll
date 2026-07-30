/**
 * diff-test: TS `roll update` == bash `bin/roll update` (frozen v2 oracle).
 *
 * cmd_update upgrades the install then chains `roll setup` + `_show_changelog`.
 * The REAL install is never run: `npm` and `curl` are PATH-shimmed (recording
 * argv, returning canned output), so both bash and TS drive the identical fake
 * binaries and the passed-through child stdout/stderr stays byte-identical.
 *
 * Three paths are covered:
 *   - npm happy path: shimmed `npm install` succeeds; `npm view` returns empty
 *     so `_check_installed_version_or_retry` is a clean no-op. Full stdout
 *     (current-version → upgrading → setup UI → changelog) compared, en+zh.
 *   - curl happy path: install-method=curl, ROLL_VERSION pinned (so
 *     `_resolve_remote_version` skips the network), shimmed `curl` copies a
 *     canned tarball whose contents are IDENTICAL to the fabricated ROLL_PKG_DIR.
 *     The oracle's atomic swap therefore lands an identical tree, so its
 *     post-swap setup+changelog match the TS port (which reads the new VERSION
 *     from the post-extract tree and skips the irreversible swap — the
 *     whitelisted gap). curl argv recording is asserted identical.
 *   - version-resolve failure: install-method=curl, no ROLL_VERSION, shimmed
 *     curl fails the releases fetch → resolve-fail err + exit 1, en+zh.
 *
 * CI portability: fabricated HOME/ROLL_HOME (seeded update-check cache) +
 * fabricated ROLL_PKG_DIR (conventions/lib/skills/bin/roll/CHANGELOG, NO
 * .git/.gitmodules). PATH shims for npm/curl/tmux; real tar. cwd = non-git proj
 * (deterministic hooks-path skip). No network, no launchd. Locale pinned.
 */
import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateCommand } from "../src/commands/update.js";
import { binRollVersion } from "./helpers.js";

const REPO = resolve(__dirname, "../../..");
const dirs: string[] = [];
let fakeBin = "";
let pkgDir = "";
let tarball = "";
let curlLog = "";

function writeShim(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

beforeAll(() => {
  fakeBin = realpathSync(mkdtempSync(join(tmpdir(), "roll-up-bin-")));
  dirs.push(fakeBin);
  curlLog = join(fakeBin, "curl-argv.log");

  // tmux: present → setup step 6 skip.
  writeShim(fakeBin, "tmux", "exit 0");

  // npm shim: install/cache exit 0 (silent); view → empty; root → empty.
  writeShim(
    fakeBin,
    "npm",
    [
      'case "$1" in',
      "  view) exit 0 ;;",
      "  root) exit 0 ;;",
      "  install) exit 0 ;;",
      "  cache) exit 0 ;;",
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
  );

  // Fabricated ROLL_PKG_DIR (full enough for the chained `roll setup`).
  pkgDir = realpathSync(mkdtempSync(join(tmpdir(), "roll-up-pkg-")));
  dirs.push(pkgDir);
  cpSync(join(REPO, "conventions"), join(pkgDir, "conventions"), { recursive: true });
  cpSync(join(REPO, "lib"), join(pkgDir, "lib"), { recursive: true });
  // US-PORT-021b: a FIXED fixture changelog — the update flow echoes it, so
  // copying the live CHANGELOG.md would re-couple the snapshot to every release
  // bump. The content is deterministic; only the flow is under test.
  writeFileSync(join(pkgDir, "CHANGELOG.md"), "# Changelog\n\n## v0.0.0 — fixture\n\n- fixture changelog entry\n");
  // US-PORT-021: bin/roll is retired — a fabricated install tree no longer carries it.
  for (const s of ["roll-alpha", "roll-beta"]) {
    mkdirSync(join(pkgDir, "skills", s), { recursive: true });
    writeFileSync(join(pkgDir, "skills", s, "SKILL.md"), `# ${s}\n`);
  }

  // Canned tarball whose extracted tree (strip-components=1) is IDENTICAL to
  // pkgDir: tar a parent dir "roll-pkg/<pkg contents>".
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "roll-up-stage-")));
  dirs.push(stage);
  cpSync(pkgDir, join(stage, "roll-pkg"), { recursive: true });
  tarball = join(fakeBin, "canned.tar.gz");
  const tr = spawnSync("tar", ["-czf", tarball, "-C", stage, "roll-pkg"], { encoding: "utf8" });
  if (tr.status !== 0) throw new Error(`tar pack failed: ${tr.stderr}`);

  // curl shim: record argv; if a release-JSON fetch is requested AND
  // ROLL_FAIL_CURL is set, exit 1 (resolve failure); else if downloading
  // (-o present) copy the canned tarball to the target; releases fetch prints
  // canned JSON. Records every argv line for argv-equality assertions.
  writeShim(
    fakeBin,
    "curl",
    [
      `: > '${curlLog}'`,
      'for a in "$@"; do printf "%s\\n" "$a" >> ' + `'${curlLog}'; done`,
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
      'case "$*" in',
      "  *releases/latest*)",
      '    if [ -n "$ROLL_FAIL_CURL" ]; then exit 1; fi',
      '    printf \'{"tag_name": "v9.9.9"}\\n\'',
      "    exit 0 ;;",
      "esac",
      'if [ -n "$out" ]; then cp ' + `'${tarball}'` + ' "$out"; exit 0; fi',
      "exit 0",
    ].join("\n"),
  );
});

afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

interface Fixture {
  home: string;
  proj: string;
  installMethod: "npm" | "curl";
}

function buildFixture(installMethod: "npm" | "curl"): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "roll-up-home-")));
  dirs.push(home);
  mkdirSync(join(home, ".roll"), { recursive: true });
  writeFileSync(
    join(home, ".roll", "config.yaml"),
    "# Roll config\nlang: en\n",
  );
  const v = binRollVersion();
  writeFileSync(join(home, ".roll", ".update-check"), `${Math.floor(Date.now() / 1000)} ${v} ${v}\n`);
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-up-proj-")));
  dirs.push(proj);
  return { home, proj, installMethod };
}

/** Set/clear the per-pkgDir install-method marker (shared pkgDir). */
function setInstallMethod(method: "npm" | "curl"): void {
  const f = join(pkgDir, ".install-method");
  if (method === "npm") rmSync(f, { force: true });
  else writeFileSync(f, "curl\n");
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function envBase(fx: Fixture, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: fakeBin,
    HOME: fx.home,
    ROLL_HOME: join(fx.home, ".roll"),
    ROLL_PKG_DIR: pkgDir,
    NO_COLOR: "1",
    ROLL_LANG: "en",
    PWD: fx.proj,
    ...extra,
  };
}

function readCurlLog(): string {
  let s = "";
  try {
    s = readFileSync(curlLog, "utf8");
  } catch {
    s = "";
  }
  rmSync(curlLog, { force: true });
  return s;
}

// US-PORT-021b: bash oracle retired → freeze the proven-correct TS output as a
// snapshot. Scrub per-run temp paths (incl. macOS /private prefix) so it is
// stable across machines; CI is the cross-platform gate.
function scrub(r: Run): Run {
  const n = (s: string): string =>
    s
      .replace(/(?:\/private)?\/(?:var\/folders|tmp)\/[^\s"':)]*/g, "<TMP>")
      // the running version is read from package.json — scrub it so the snapshot
      // survives every release bump (US-PORT-021b: the version-coupling trap).
      .replace(/v\d+\.\d+\.\d+/g, "v<VER>")
      // "command not found" wording is shell-version-specific: dash emits
      // `<script>: 12: cp: not found`, bash emits `<script>: line 12: cp:
      // command not found`. The snapshot would false-fail on whichever shell
      // didn't freeze it (macOS bash vs CI dash). Canonicalize both forms so
      // the difftest is portable — we assert the SHAPE (which command was not
      // found), not the host shell's phrasing. (FIX-1023)
      .replace(/:\s*(?:line\s+)?\d+:\s*(\S+):\s*(?:command\s+)?not found/g, ": <SH-NOTFOUND:$1>");
  return { status: r.status, stdout: n(r.stdout), stderr: n(r.stderr) };
}

const ENV_KEYS = [
  "PATH", "HOME", "ROLL_HOME", "ROLL_PKG_DIR", "NO_COLOR", "ROLL_LANG", "LC_ALL", "LANG",
  "PWD", "ROLL_VERSION", "ROLL_FAIL_CURL",
];

async function tsUp(fx: Fixture, extra: Record<string, string>): Promise<Run> {
  setInstallMethod(fx.installMethod);
  const target = { ...envBase(fx, extra), PWD: fx.proj };
  const save: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) save[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(target)) process.env[k] = v;
  const saveCwd = process.cwd();
  process.chdir(fx.proj);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (cnk: string | Uint8Array): boolean => (outChunks.push(String(cnk)), true);
  // @ts-expect-error capture-only
  process.stderr.write = (cnk: string | Uint8Array): boolean => (errChunks.push(String(cnk)), true);
  let status: number;
  try {
    status = await updateCommand([]);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.chdir(saveCwd);
    for (const k of ENV_KEYS) {
      const v = save[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { status, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

describe("diff-test: roll update == bash oracle", () => {
  for (const lang of ["en", "zh"]) {
    it(`npm happy path → upgrade + setup + changelog (${lang})`, async () => {
      const tf = buildFixture("npm");
      expect(scrub(await tsUp(tf, { ROLL_LANG: lang }))).toMatchSnapshot();
    });

    // US-INSTALL-008: the curl upgrade cases are retired with the curl path
    // itself. They froze the behaviour of downloading a source tarball from the
    // product repo's GitHub Releases — now private, so that fetch can only
    // 404. A frozen snapshot of a path the product no longer has is not
    // coverage; `roll update` is npm-only and the npm case above is the whole
    // surface. The retired-marker warning is covered by unit test, not here.
  }
});
