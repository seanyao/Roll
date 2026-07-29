/**
 * `roll test` — TS port of bin/roll cmd_test (6849-6942) plus the isolation
 * dispatcher it drives: `_cmd_test_where` (6821-6847), `_isolation_get_type`
 * (6552-6577), `_isolation_dispatch` (6582-6617), the `none` adapter
 * (6623-6633), and the reset-lock helpers (6640-6661).
 *
 * Mirrored byte-for-byte: arg parse (`--help`/`-h` anywhere before `--` wins;
 * `--` forwards verbatim; `--where`; `--reset`), the `--where` routing tokens
 * (`host`, `unknown:<type>`), the reset-lock fast-fail messages, the
 * unknown-isolation-type error, and the dispatcher's "no config → falling back
 * to type=none" stderr INFO line.
 *
 * COMPAT-AWARE GATE (FIX-1274): with no explicit `-- <args>`, the default exec
 * path no longer blindly appends roll's `--affected` token (which a plain Vitest
 * project rejects). It resolves a version-compatible command from the TARGET
 * project via {@link resolveGateCommand}: the roll wrapper keeps `--affected`;
 * a raw Vitest project uses the supported `--changed` mode (or the full suite as
 * the conservative fallback, incl. when `--changed` matches 0 tests). The
 * `.roll/last-test-pass` proof is written ONLY after a supported command really
 * ran and returned zero. Explicit `-- <args>` still forwards verbatim.
 *
 * ISOLATION SURFACE (REFACTOR-046): only `type: none` is supported. The tart
 * VM lane was REMOVED — its real-VM path was never CI-exercised and the v3
 * suite is hermetic by construction. Any other configured type (incl. a stale
 * `tart`) fails loud: explicit error + exit 1, never a silent host fallback.
 * The `--where` token format (`<type>:<detail>`) survives as the extension
 * point for future adapters (e.g. `docker:running`).
 *
 * IO SEAM (so a difftest never runs the real suite): `npm` is invoked through
 * spawnSync against PATH, so a difftest shims it (records argv, returns canned
 * output). Both bash and TS run the SAME shim; the child stdout/stderr is
 * captured + re-emitted so the env-swap harness sees byte-identical output
 * (mirrors update.ts's runForward).
 *
 * WHITELISTED divergences:
 *   - `_isolation_get_type` shells python3+yaml to read .roll/local.yaml's
 *     nested `test_isolation.type`. The TS port parses that one scalar key
 *     natively; malformed YAML and a missing file both resolve to `none`,
 *     matching the bash fail-soft.
 *   - The frozen v2 oracle still carries its tart adapter; the TS side treats
 *     `tart` as an unknown type (fail-loud). The unknown-type ERROR path lists
 *     only `none` and intentionally differs from the oracle's list — covered
 *     by a TS-only test, while the `--where` unknown TOKEN stays difftested.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isNoTestsFoundOutput, resolveGateCommand, type GateMode } from "@roll/core";
import { rollPkgDir } from "./setup-shared.js";

// ─── bash UI helpers (bin/roll:41-56) ────────────────────────────────────────
function pal(): { CYAN: string; GREEN: string; YELLOW: string; RED: string; NC: string } {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return noColor
    ? { CYAN: "", GREEN: "", YELLOW: "", RED: "", NC: "" }
    : { CYAN: "\x1b[0;36m", GREEN: "\x1b[0;32m", YELLOW: "\x1b[0;33m", RED: "\x1b[0;31m", NC: "\x1b[0m" };
}
/** `info ... >&2`: CYAN-prefixed [roll] line written to STDERR (dispatcher). */
function infoErr(line: string): void {
  const { CYAN, NC } = pal();
  process.stderr.write(`${CYAN}[roll]${NC} ${line}\n`);
}
function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

const SUPPORTED_TYPES = ["none"] as const;

interface EvidenceFrameEnv {
  runDir: string;
  evidenceDir: string;
  screenshotsDir: string;
}

function currentEvidenceFrame(): EvidenceFrameEnv | null {
  const raw = (process.env["ROLL_RUN_DIR"] ?? "").trim();
  if (raw === "") return null;
  const runDir = resolve(raw);
  if (!existsSync(runDir)) return null;
  const frame = {
    runDir,
    evidenceDir: join(runDir, "evidence"),
    screenshotsDir: join(runDir, "screenshots"),
  };
  try {
    mkdirSync(frame.evidenceDir, { recursive: true });
    mkdirSync(frame.screenshotsDir, { recursive: true });
  } catch {
    return null;
  }
  return frame;
}

function childEnvForEvidence(frame: EvidenceFrameEnv | null): NodeJS.ProcessEnv | undefined {
  const hasEvidenceInput =
    process.env["ROLL_RUN_DIR"] !== undefined ||
    process.env["ROLL_EVIDENCE_DIR"] !== undefined ||
    process.env["ROLL_SCREENSHOTS_DIR"] !== undefined;
  if (frame === null) {
    if (!hasEvidenceInput) return undefined;
    const env = { ...process.env };
    delete env["ROLL_RUN_DIR"];
    delete env["ROLL_EVIDENCE_DIR"];
    delete env["ROLL_SCREENSHOTS_DIR"];
    return env;
  }
  const env = { ...process.env };
  delete env["ROLL_RUN_DIR"];
  env["ROLL_EVIDENCE_DIR"] = frame.evidenceDir;
  env["ROLL_SCREENSHOTS_DIR"] = frame.screenshotsDir;
  return env;
}

function appendRollTestEvidence(
  frame: EvidenceFrameEnv,
  cmd: string,
  argv: readonly string[],
  status: number,
  stdout: string,
  stderr: string,
): void {
  try {
    const ts = new Date().toISOString();
    const command = [cmd, ...argv];
    appendFileSync(
      join(frame.evidenceDir, "roll-test-output.log"),
      [
        `===== roll test ${ts} exit=${status} =====`,
        `$ ${command.join(" ")}`,
        "--- stdout ---",
        stdout,
        "--- stderr ---",
        stderr,
        "",
      ].join("\n"),
      "utf8",
    );
    appendFileSync(
      join(frame.evidenceDir, "roll-test-summary.txt"),
      JSON.stringify({
        ts,
        command,
        exitCode: status,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      }) + "\n",
      "utf8",
    );
  } catch {
    /* evidence deposit is best-effort; roll test result remains authoritative */
  }
}

// ─── _isolation_get_type (6552) ──────────────────────────────────────────────
/**
 * Read test_isolation.type from .roll/local.yaml; "none" when the file or key
 * is missing or the YAML is malformed (bash fail-soft). The bash oracle shells
 * python3+yaml for nested-key parsing; we parse the single scalar natively.
 */
function isolationGetType(): string {
  const file = join(process.cwd(), ".roll", "local.yaml");
  if (!existsSync(file)) return "none";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "none";
  }
  const val = parseTestIsolationType(text);
  return val !== "" ? val : "none";
}

/**
 * Extract `test_isolation.type` from a small YAML doc. Mirrors the python
 * `data.get("test_isolation")` → dict → `.get("type")` → non-empty str path:
 * find the top-level `test_isolation:` mapping, then its indented `type:`
 * scalar. Anything that doesn't shape up that way yields "".
 */
function parseTestIsolationType(text: string): string {
  const lines = text.split("\n");
  let inSection = false;
  let sectionIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inSection) {
      if (/^test_isolation:\s*$/.test(line.trim() === line ? line : line.trimStart()) && indent === 0) {
        inSection = true;
        sectionIndent = indent;
      }
      continue;
    }
    // Inside the section: a key at <= section indent ends it.
    if (indent <= sectionIndent) break;
    const mm = /^type:\s*(.*)$/.exec(line.trim());
    if (mm) {
      let v = (mm[1] ?? "").trim();
      // strip quotes + inline comment
      v = v.replace(/\s+#.*$/, "").trim();
      v = v.replace(/^["']|["']$/g, "");
      return v;
    }
  }
  return "";
}

// ─── _cmd_test_where (6821) ──────────────────────────────────────────────────
// Routing tokens: `host` for the none adapter; `unknown:<type>` for anything
// else (the `<type>:<detail>` shape is the extension point future adapters
// reuse — REFACTOR-046 removed the only non-none adapter, tart).
function cmdTestWhere(): void {
  const type = isolationGetType();
  if (type === "none") {
    process.stdout.write("host\n");
    return;
  }
  process.stdout.write(`unknown:${type}\n`);
}

// ─── reset-lock helpers (6640-6661) ──────────────────────────────────────────
// bin/roll prints this path verbatim (relative to cwd) in its lock messages;
// keep it relative so the error text matches byte-for-byte.
function resetLockPath(): string {
  return ".roll/.iso-reset.lock";
}
function resetLockHeld(): boolean {
  return existsSync(resetLockPath());
}
function resetAcquireLock(): boolean {
  const lock = resetLockPath();
  if (existsSync(lock)) return false;
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.pid}\n`);
  return true;
}
function resetReleaseLock(): void {
  rmSync(resetLockPath(), { force: true });
}

/**
 * Forward a (shimmed) child's stdout/stderr through our process streams so the
 * env-swap difftest harness captures it byte-identically (mirrors update.ts).
 * Returns the exit status plus the combined child output so the gate can inspect
 * it (e.g. detect a zero-test `--changed` selection — FIX-1274).
 */
function runForward(cmd: string, argv: string[]): { status: number; output: string } {
  const frame = currentEvidenceFrame();
  const r = spawnSync(cmd, argv, { encoding: "utf8", env: childEnvForEvidence(frame) });
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const status = r.status ?? 1;
  if (stdout !== "") process.stdout.write(stdout);
  if (stderr !== "") process.stderr.write(stderr);
  if (frame !== null) appendRollTestEvidence(frame, cmd, argv, status, stdout, stderr);
  return { status, output: stdout + stderr };
}

// ─── target-project runner resolution (FIX-1274) ─────────────────────────────
/** Read `scripts.test` from the target project's package.json (or undefined). */
function readTestScript(cwd: string): string | undefined {
  const p = join(cwd, "package.json");
  if (!existsSync(p)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { scripts?: Record<string, unknown> };
    const t = pkg.scripts?.["test"];
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Detect the installed Vitest version by walking up from cwd to node_modules. */
function detectVitestVersion(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const vp = join(dir, "node_modules", "vitest", "package.json");
    if (existsSync(vp)) {
      try {
        const v = (JSON.parse(readFileSync(vp, "utf8")) as { version?: string }).version;
        if (typeof v === "string") return v;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function gitCapture(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
}

/**
 * Record a fresh `.roll/last-test-pass` proof AFTER a supported command has
 * actually executed and returned zero. The proof binds the exact tested tree
 * hash to the executed command + selected mode + timestamp so the pre-commit
 * freshness/tree-match guard stays effective. Fail-safe: if the tree cannot be
 * computed (not a git worktree) the proof is NOT written — a missing proof
 * blocks the commit loudly rather than fabricating a green (FIX-1274).
 */
function writeTestProof(cwd: string, mode: GateMode, command: string): void {
  const top = gitCapture(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === "") return;
  const tree = gitCapture(cwd, ["write-tree"]);
  if (tree === "") return;
  const ts = Math.floor(Date.now() / 1000);
  const proofPath = join(top, ".roll", "last-test-pass");
  try {
    mkdirSync(dirname(proofPath), { recursive: true });
    writeFileSync(proofPath, JSON.stringify({ ts, tree, mode, command, scope: mode }) + "\n", "utf8");
  } catch {
    /* best-effort write; an absent proof fails the commit loudly, never green */
  }
}

function ensureSkillsSubmoduleReady(): boolean {
  const pkg = rollPkgDir();
  const required = join(pkg, "skills", "roll-onboard", "SKILL.md");
  if (existsSync(required)) return true;
  if (existsSync(join(pkg, ".git")) && existsSync(join(pkg, ".gitmodules"))) {
    spawnSync("git", ["submodule", "update", "--init", "--recursive", "--quiet", "skills"], {
      cwd: pkg,
      stdio: "ignore",
    });
    if (existsSync(required)) return true;
  }
  err("roll test: skills submodule is empty");
  process.stderr.write("  run: git submodule update --init --recursive skills\n");
  return false;
}

// ─── _isolation_dispatch exec / reset (6582) ─────────────────────────────────
/**
 * Emit the no-config INFO line (bash parity) and validate the isolation type.
 * Returns an exit status when the type is unknown (fail-loud, never a silent
 * host fallback), or null when the type is the supported `none` adapter.
 */
function ensureNoneIsolation(): number | null {
  const type = isolationGetType();
  if (type === "none" && !existsSync(join(process.cwd(), ".roll", "local.yaml"))) {
    infoErr("isolation: no test_isolation config, falling back to type=none (host)");
  }
  if (!(SUPPORTED_TYPES as readonly string[]).includes(type)) {
    err(`isolation: unknown type '${type}' in .roll/local.yaml`);
    process.stderr.write(`  supported types: ${SUPPORTED_TYPES.join(", ")}\n`);
    return 1;
  }
  return null;
}

/** Returns the dispatch exit status. Reset lane only (exec is orchestrated by
 *  the gate resolver in {@link testCommand}). */
function isolationDispatch(method: "exec" | "reset", args: string[]): number {
  const guard = ensureNoneIsolation();
  if (guard !== null) return guard;
  // type === "none" (the only supported adapter — REFACTOR-046).
  if (method === "reset") {
    err("isolation type 'none' has nothing to reset (host execution is stateless)");
    return 0;
  }
  // _isolation_none_exec: run the command in the host shell unchanged.
  return runForward(args[0] ?? "", args.slice(1)).status;
}

const HELP = `Usage: roll test [--full | --where | --reset] [--] [<extra-args>...]

Runs the project's test suite through the isolation adapter chosen in
.roll/local.yaml:

  test_isolation:
    type: none   (default)   Direct host execution — same shell as \`npm test\`.

Any other configured type is rejected with an explicit error (exit 1) —
never a silent host fallback. The \`<type>:<detail>\` routing token printed
by --where is the extension point for future adapters.

Runner compatibility (FIX-1274):
  With no extra args, roll test resolves a per-commit gate command from the
  TARGET project instead of assuming one flag:
    - roll's own wrapper keeps its \`--affected\` token;
    - a plain Vitest project uses the version-supported \`--changed\` mode
      (roll never passes \`--affected\` to Vitest, which rejects it);
    - if no safe changed mode exists (or a \`--changed\` run matched 0 tests),
      roll runs the project's FULL test command — a strictly more conservative
      gate, never a partial or empty pass.
  The \`.roll/last-test-pass\` proof is recorded ONLY after a supported command
  actually executes and returns zero, so a proof always represents a real,
  green test run bound to the exact committed tree.

Flags:
  --full         Run the WHOLE suite (round-tail / pre-PR verify), not the
                 per-commit changed/affected subset, and stamp the proof
                 \`mode:"full"\`. The delivery evidence gate requires a fresh
                 full-mode proof matching the delivered tree before a PR opens
                 (US-CYCLE-011). Run this once at round tail, after the last
                 \`tcr:\` commit and before handing off to publish.
  --where        Print where tests will run, then exit (e.g. \`host\`,
                 \`unknown:<type>\`).
  --reset        Reset the isolation environment.
                 type=none: prints a note and exits 0 (host is stateless).
                 Holds a lockfile under .roll/.iso-reset.lock; concurrent
                 \`roll test\` invocations fast-fail with a clear error.
  --help, -h     Show this help.

Examples:
  roll test                    Resolve + run the compatible changed-test gate.
  roll test -- tests/          Forward arguments to npm test verbatim.
  roll test -- --tier=fast     Forward arguments to npm test.
  roll test --where            Don't run; just report routing.
`;

// ─── cmd_test (6849) ─────────────────────────────────────────────────────────
export function testCommand(args: string[]): number {
  // --help/-h anywhere before `--` wins; `--` stops interception.
  let argv = args;
  for (const a of args) {
    if (a === "--") break;
    if (a === "--help" || a === "-h") {
      argv = ["--help"];
      break;
    }
  }

  // US-CYCLE-011: `--full` (before any `--`) forces the ROUND-TAIL FULL suite so
  // the minted proof is `mode:"full"` — the pre-PR full-verify the delivery
  // evidence gate now requires. Extract + strip it so it never leaks into the
  // `-- <args>` passthrough. Ignored once `--help` has been resolved above.
  let fullRequested = false;
  if (!(argv.length === 1 && argv[0] === "--help")) {
    const cleaned: string[] = [];
    let sawSep = false;
    for (const a of argv) {
      if (!sawSep && a === "--full") {
        fullRequested = true;
        continue;
      }
      if (a === "--") sawSep = true;
      cleaned.push(a);
    }
    argv = cleaned;
  }

  const first = argv[0] ?? "";
  if (first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === "--where") {
    cmdTestWhere();
    return 0;
  }
  if (first === "--reset") {
    if (resetLockHeld()) {
      err("roll test --reset: another reset is already in progress");
      process.stderr.write(`  lock: ${resetLockPath()} (delete manually if stale)\n`);
      return 1;
    }
    if (!resetAcquireLock()) {
      err("roll test --reset: failed to acquire reset lock");
      return 1;
    }
    try {
      return isolationDispatch("reset", []);
    } finally {
      resetReleaseLock();
    }
  }
  if (first === "--") {
    argv = argv.slice(1);
  }

  // Test-execution path. Bail if a reset is in progress.
  if (resetLockHeld()) {
    err(`roll test: a reset is in progress (lock: ${resetLockPath()})`);
    process.stderr.write("  re-run once the reset completes, or delete the lockfile if stale\n");
    return 1;
  }

  if (!ensureSkillsSubmoduleReady()) return 1;
  const guard = ensureNoneIsolation();
  if (guard !== null) return guard;

  // US-CYCLE-011 (codex review): `--full` forces the WHOLE suite; combining it
  // with a `-- <args>` passthrough is a footgun — the passthrough below would
  // win and silently mint a NON-full proof (e.g. `roll test --full -- --affected`
  // would run the affected subset yet the operator asked for full). Reject the
  // combination loudly instead.
  if (fullRequested && argv.length > 0) {
    err("roll test --full runs the whole suite and cannot be combined with `-- <args>` passthrough");
    return 1;
  }

  // Explicit passthrough: `roll test -- <args>` forwards verbatim. The caller
  // owns the exact command and its proof; roll does not resolve or mint one.
  if (argv.length > 0) {
    return runForward("npm", ["test", "--", ...argv]).status;
  }

  // Default per-commit gate → resolve a version-compatible runner (FIX-1274).
  // A raw Vitest project rejects roll's `--affected` token; the resolver picks a
  // supported changed-test mode, or the project's full suite as the conservative
  // fallback, and records a proof only after a real zero exit.
  const cwd = process.cwd();
  const resolution = resolveGateCommand({
    hasPackageJson: existsSync(join(cwd, "package.json")),
    testScript: readTestScript(cwd),
    vitestVersion: detectVitestVersion(cwd),
  });
  if (!resolution.ok) {
    err("roll test: no test command could be resolved for this project");
    process.stderr.write(`  reason:    ${resolution.reason}\n`);
    process.stderr.write(`  attempted: ${resolution.attempted}\n`);
    process.stderr.write(`  next step: ${resolution.nextStep}\n`);
    return 1;
  }
  // US-CYCLE-011: `--full` overrides the per-commit changed/affected selection
  // with the WHOLE suite (`npm test`, no changed/affected flag) and stamps the
  // proof `mode:"full"`. Proof OWNERSHIP is unchanged: roll's own wrapper
  // (test-ts.sh, SCOPE=full) writes its own mode:"full" proof; a raw project lets
  // roll mint it (writesProof carried through from the resolution).
  const plan = fullRequested
    ? {
        mode: "full" as GateMode,
        npmTestArgs: [] as string[],
        writesProof: resolution.plan.writesProof,
        reason: "forced full verify (--full) — round-tail proof mode=full",
      }
    : resolution.plan;
  // Surface the compatibility decision for the new (changed/full) paths; the
  // legacy/wrapper `--affected` path stays silent for byte-stable parity.
  if (plan.mode !== "affected") infoErr(`test gate: ${plan.mode} — ${plan.reason}`);

  // Full mode runs the project's own `npm test` with no separator; changed /
  // affected append their flag after `--`.
  const npmArgv = plan.npmTestArgs.length > 0 ? ["test", "--", ...plan.npmTestArgs] : ["test"];
  const primary = runForward("npm", npmArgv);

  // A `--changed` selection that matched ZERO tests is not an honest green — and
  // Vitest exits 0 in that case ("No test files found, exiting with code 0"), so
  // the exit code alone would fabricate a pass. Detect the empty selection from
  // the runner output and fall back to the FULL suite (stricter), regardless of
  // exit code, rather than mint a proof for a run that executed no tests.
  if (plan.mode === "changed" && isNoTestsFoundOutput(primary.output)) {
    infoErr("test gate: changed-test mode matched 0 tests → running full suite (conservative fallback)");
    const full = runForward("npm", ["test"]);
    return finishGate(cwd, "full", "npm test", full, plan.writesProof);
  }

  return finishGate(cwd, plan.mode, ["npm", ...npmArgv].join(" "), primary, plan.writesProof);
}

/**
 * Complete the gate for a run: mint the proof ONLY when the command really
 * executed tests and returned zero. A non-zero exit fails as-is; a run that
 * reported zero test files (even one that exits 0 via `--passWithNoTests`) is
 * NOT an honest green — it verified nothing — so it fails loud instead of
 * minting a fabricated proof (FIX-1274 scorer guarantee).
 */
function finishGate(
  cwd: string,
  mode: GateMode,
  command: string,
  run: { status: number; output: string },
  writesProof: boolean,
): number {
  if (run.status !== 0) return run.status;
  // FIX-1274's zero-test rejection guards the raw-vitest changed/full modes,
  // where "no test files" means nothing was verified (a fabricated green). Roll's
  // OWN `--affected` wrapper (test-ts.sh) is different by design: it runs
  // `vitest --changed --passWithNoTests`, so a change covered by no test — or, in
  // a cycle worktree, a change already committed (nothing in the working tree for
  // `--changed` to match) — is an HONEST green; the wrapper writes its own proof
  // and CI's full `npm test` is the real cross-package gate. Applying the
  // zero-test hard-fail to `affected` broke every loop delivery (the deliverable_cmd
  // `roll test` failed inside every cycle worktree → attest exit 3 → no publish).
  if (mode !== "affected" && isNoTestsFoundOutput(run.output)) {
    err("roll test: the test command reported no test files — nothing was verified");
    process.stderr.write("  a green gate requires at least one executed test; add tests or scope the run\n");
    return 1;
  }
  if (writesProof) writeTestProof(cwd, mode, command);
  return 0;
}
