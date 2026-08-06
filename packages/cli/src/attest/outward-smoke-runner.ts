/**
 * @responsibility Runs outward smoke checks in isolated temporary environments with enforced timeouts and captured artifacts.
 */
/**
 * US-ATTEST-016 — CLI adapter for the external smoke runner.
 *
 * Provides the real process-spawning implementation that the pure core
 * module (`outward-smoke.ts`) accepts as an injectable `SmokeSpawnFn`.
 * Creates isolated temporary HOME, PREFIX, and work directories for each
 * smoke command, enforces timeouts, captures stdout/stderr, and writes
 * artifact files.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  computeCommandDigest,
  matchEnvironment,
  buildSmokeRunReport,
  redactOutput,
  toOutwardSmokeResults,
  type SmokeRunEntry,
  type SmokeRunReport,
  type SmokeSpawnFn,
  type SmokeSpawnOptions,
  type SmokeSpawnResult,
  type OutwardSmokeResult,
} from "@roll/core";
import type { OutwardSmokeDeclaration } from "@roll/spec";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface RunOutwardSmokeOptions {
  /** The external-smoke declarations from the evaluation contract. */
  declarations: OutwardSmokeDeclaration[];
  /** Maps command → AC ID (from the evaluation contract's `proves` field).
   *  When omitted, the command string itself is used as the AC identifier. */
  acMap?: Map<string, string>;
  /** The current execution environment (ci / nightly / release / unknown). */
  currentEnvironment: string;
  /** Directory where smoke artifact files will be written. */
  artifactDir: string;
  /** Unique run identifier. */
  runId?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Allow-listed environment variables passed through to smoke commands
// ════════════════════════════════════════════════════════════════════════════

/**
 * Environment variables that are safe to forward to isolated smoke processes.
 * Everything else is stripped — this is the defense-in-depth allowlist.
 */
const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",     // Will be overridden with temp dir
  "TMPDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "USER",
  "NODE_PATH",
  "npm_config_cache",
  "npm_config_prefix", // Will be overridden
]);

// ════════════════════════════════════════════════════════════════════════════
// Real spawn implementation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Spawn a smoke command with real process isolation.
 *
 * Creates temporary HOME and PREFIX directories so that commands like
 * `npm i -g` cannot leak into the caller's environment. Enforces the
 * declared timeout and captures stdout/stderr.
 */
const realSmokeSpawn: SmokeSpawnFn = async (opts: SmokeSpawnOptions): Promise<SmokeSpawnResult> => {
  const startedAt = Date.now();

  return new Promise<SmokeSpawnResult>((resolve) => {
    const child = execFile(
      "bash",
      ["-lc", opts.command],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024, // 1 MB
        killSignal: "SIGKILL",
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const onStdout = (data: Buffer | string): void => {
      stdout += typeof data === "string" ? data : data.toString("utf8");
    };
    const onStderr = (data: Buffer | string): void => {
      stderr += typeof data === "string" ? data : data.toString("utf8");
    };

    if (child.stdout !== null) {
      child.stdout.on("data", onStdout);
    }
    if (child.stderr !== null) {
      child.stderr.on("data", onStderr);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ETIMEDOUT" || (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true) {
        timedOut = true;
      }
      resolve({
        exitCode: null,
        stdout: redactOutput(stdout),
        stderr: redactOutput(stderr),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on("close", (code: number | null, signal: string | null) => {
      resolve({
        exitCode: code,
        stdout: redactOutput(stdout),
        stderr: redactOutput(stderr),
        durationMs: Date.now() - startedAt,
        timedOut: signal === "SIGKILL" || timedOut,
      });
    });
  });
};

// ════════════════════════════════════════════════════════════════════════════
// Temp directory helpers
// ════════════════════════════════════════════════════════════════════════════

interface SmokeTempDirs {
  home: string;
  prefix: string;
  work: string;
}

function createTempDirs(): SmokeTempDirs {
  const base = mkdtempSync(join(tmpdir(), "roll-smoke-"));
  const home = join(base, "HOME");
  const prefix = join(base, "PREFIX");
  const work = join(base, "WORK");
  mkdirSync(home, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { home, prefix, work };
}

function cleanupTempDirs(dirs: SmokeTempDirs): void {
  // Remove the base directory and all contents
  const base = join(dirs.home, "..");
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — temp dirs will be reclaimed by OS eventually
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Environment builder
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a minimal, isolated environment for a smoke command.
 * Only allow-listed variables from the parent process are forwarded,
 * and HOME/PREFIX are overridden with temp directories.
 */
function buildSmokeEnv(
  tempDirs: SmokeTempDirs,
): Record<string, string> {
  const env: Record<string, string> = {};

  // Forward only allowed vars from parent
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ALLOWED_ENV_VARS.has(key)) {
      env[key] = value;
    }
  }

  // Override with temp directories for isolation
  env["HOME"] = tempDirs.home;
  env["npm_config_prefix"] = tempDirs.prefix;
  // Ensure PATH is set (fallback)
  if (env["PATH"] === undefined) {
    env["PATH"] = "/usr/local/bin:/usr/bin:/bin";
  }

  return env;
}

// ════════════════════════════════════════════════════════════════════════════
// Artifact writer
// ════════════════════════════════════════════════════════════════════════════

/**
 * Write a smoke artifact file (JSON) and return the relative path.
 */
function writeSmokeArtifact(
  artifactDir: string,
  entry: SmokeRunEntry,
  stdout: string,
  stderr: string,
): string {
  // Use a safe filename derived from the digest
  const shortDigest = entry.commandDigest.slice(0, 12);
  const filename = `smoke-${entry.ac.replace(/[^A-Za-z0-9_-]/g, "_")}-${shortDigest}.json`;

  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, filename);

  const artifact = {
    ac: entry.ac,
    command: entry.command,
    environment: entry.environment,
    exitCode: entry.exitCode,
    summary: entry.summary,
    commandDigest: entry.commandDigest,
    durationMs: entry.durationMs,
    startedAt: entry.startedAt,
    timedOut: entry.timedOut,
    stdout,
    stderr,
  };

  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  return relative(artifactDir, artifactPath);
}

// ════════════════════════════════════════════════════════════════════════════
// Main entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run external smoke checks for a set of outward declarations.
 *
 * 1. Environment gate: filter declarations matching the current environment.
 * 2. For each matching declaration: create isolated temp HOME/PREFIX/WORK dirs,
 *    spawn the command with timeout, capture stdout/stderr (redacted),
 *    write artifact JSON.
 * 3. Build and return the SmokeRunReport.
 *
 * Temp directories are cleaned up after each command executes (never shared
 * across commands). The artifact files persist under `artifactDir`.
 *
 * Never persists credentials and never permits undeclared arbitrary command
 * interpolation — only spec-declared `external-smoke` commands are executed.
 */
export async function runOutwardSmoke(options: RunOutwardSmokeOptions): Promise<SmokeRunReport> {
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = new Date().toISOString();

  // Step 1: Environment gate
  const { matching, unmatched } = matchEnvironment(options.declarations, options.currentEnvironment);

  // Fix up unmatched entries: use the caller-supplied AC ID map when available
  const acMap = options.acMap ?? new Map<string, string>();
  for (const entry of unmatched) {
    const acId = acMap.get(entry.ac) ?? entry.ac;
    entry.ac = acId;
  }

  // Step 2: Execute matching declarations in isolated environments
  const spawnResults = new Map<string, SmokeSpawnResult>();
  const stdoutByAc = new Map<string, string>();
  const stderrByAc = new Map<string, string>();

  for (const decl of matching) {
    const tempDirs = createTempDirs();
    const env = buildSmokeEnv(tempDirs);

    try {
      const result = await realSmokeSpawn({
        command: decl.command,
        env,
        cwd: tempDirs.work,
        timeoutMs: decl.timeoutSec * 1000,
      });

      spawnResults.set(decl.command, result);
      stdoutByAc.set(decl.command, result.stdout);
      stderrByAc.set(decl.command, result.stderr);
    } catch {
      // If spawn itself throws (shouldn't happen with our wrapper, but be safe)
      spawnResults.set(decl.command, {
        exitCode: null,
        stdout: "",
        stderr: "spawn infrastructure error",
        durationMs: 0,
        timedOut: false,
      });
      stdoutByAc.set(decl.command, "");
      stderrByAc.set(decl.command, "spawn infrastructure error");
    } finally {
      cleanupTempDirs(tempDirs);
    }
  }

  // Step 3: Build report
  const report = buildSmokeRunReport({
    runId,
    environment: options.currentEnvironment,
    startedAt,
    spawnResults,
    declarations: matching,
    acMap: acMap,
    artifactDir: options.artifactDir,
    unmatched,
  });

  // Step 4: Write artifact files with full stdout/stderr
  for (const entry of report.results) {
    const stdout = stdoutByAc.get(entry.command) ?? "";
    const stderr = stderrByAc.get(entry.command) ?? "";
    const artifactPath = writeSmokeArtifact(options.artifactDir, entry, stdout, stderr);
    entry.artifactPath = artifactPath;
  }

  return report;
}

/**
 * Extract OutwardSmokeResult array from a SmokeRunReport for feeding into
 * the outward verification resolver. Delegates to the core toOutwardSmokeResults.
 */
export function smokeResultsFromReport(report: SmokeRunReport): OutwardSmokeResult[] {
  return toOutwardSmokeResults(report.results);
}
