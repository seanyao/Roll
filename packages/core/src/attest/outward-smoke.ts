/**
 * @responsibility Defines pure external smoke-run policy, redaction, and report logic.
 * US-ATTEST-016 — Isolated external smoke runner: pure logic.
 *
 * This module contains the type definitions, environment gate, output
 * redaction, command digest, and report builder for the external smoke
 * runner. The actual process spawning and filesystem I/O live in the
 * CLI adapter (`packages/cli/src/attest/outward-smoke-runner.ts`).
 *
 * Pure functions only — no filesystem, no child_process, no side effects.
 */
import { createHash } from "node:crypto";
import type { OutwardSmokeDeclaration } from "@roll/spec";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Injectable spawn signature — the CLI adapter supplies the real spawn. */
export interface SmokeSpawnOptions {
  /** The command to run (shell). */
  command: string;
  /** Environment variables for the child process. */
  env: Record<string, string>;
  /** Working directory for the child process. */
  cwd: string;
  /** Maximum execution time in milliseconds. */
  timeoutMs: number;
}

/** Result of a single smoke spawn. */
export interface SmokeSpawnResult {
  /** Process exit code, or null if killed by a signal. */
  exitCode: number | null;
  /** Captured stdout (may be truncated). */
  stdout: string;
  /** Captured stderr (may be truncated). */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the process was killed due to timeout. */
  timedOut: boolean;
}

/** A single smoke run entry — persisted as an artifact. */
export interface SmokeRunEntry {
  /** The AC id this smoke verifies. */
  ac: string;
  /** The exact command that was executed. */
  command: string;
  /** The declared environment (ci/nightly/release). */
  environment: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
  /** Human-readable one-line summary of the result. */
  summary: string;
  /** SHA-256 hex digest of the normalized command. */
  commandDigest: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Relative path to the artifact file (stdout/stderr capture). */
  artifactPath: string;
  /** ISO-8601 timestamp when execution started. */
  startedAt: string;
  /** Whether the process timed out. */
  timedOut: boolean;
}

/** Aggregate report produced by a smoke run. */
export interface SmokeRunReport {
  /** Unique run identifier (timestamp-based). */
  runId: string;
  /** The environment this run executed in. */
  environment: string;
  /** ISO-8601 timestamp when the run started. */
  startedAt: string;
  /** Results for each matching declaration that was executed. */
  results: SmokeRunEntry[];
  /** ACs whose declared environment did not match the current environment. */
  unverified: { ac: string; reason: string }[];
}

/** Injectable spawn function type — callers supply the real implementation. */
export type SmokeSpawnFn = (options: SmokeSpawnOptions) => Promise<SmokeSpawnResult>;

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

/** Maximum bytes of stdout/stderr to retain in the artifact. */
const MAX_OUTPUT_BYTES = 64_000;

/** Patterns that may indicate credentials in output — defense in depth. */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  // Specific token formats first (before the catch-all credential patterns)
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, "[REDACTED: GitHub token]"],
  [/(?:npm)_[A-Za-z0-9]{32,}/g, "[REDACTED: npm token]"],
  [/(?:sk|pk)_[A-Za-z0-9]{32,}/g, "[REDACTED: API key]"],
  // Bearer tokens in output
  [/(?:Bearer|Authorization:|x-api-key:)\s*[A-Za-z0-9\-_=+./]{20,}/gi, "[REDACTED: auth header]"],
  // Generic credential-like patterns in env-var form (case-insensitive)
  [/(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIALS?)\s*=\s*\S+/gi, "[REDACTED: credential in output]"],
];

// ════════════════════════════════════════════════════════════════════════════
// Command digest
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute a stable SHA-256 hex digest of a command string.
 * Whitespace is normalized before hashing so trivial formatting
 * differences don't change the digest.
 */
export function computeCommandDigest(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

// ════════════════════════════════════════════════════════════════════════════
// Output redaction
// ════════════════════════════════════════════════════════════════════════════

/**
 * Redact potential credential material from process output and truncate
 * to a bounded size. This is defense-in-depth — the runner never passes
 * credentials in the environment, but if a command echoes a token, this
 * catches it.
 *
 * Returns the redacted and truncated string.
 */
export function redactOutput(text: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > maxBytes) {
    const half = Math.floor(maxBytes / 2);
    const head = out.slice(0, half);
    const tail = out.slice(out.length - half);
    return `${head}\n\n... [${out.length - maxBytes} bytes truncated] ...\n\n${tail}`;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Environment gate
// ════════════════════════════════════════════════════════════════════════════

/**
 * Split declarations into those matching the current environment and
 * those that don't. Unmatched declarations are reported as unverified
 * with an explanatory reason — never silently skipped (AC3).
 */
export function matchEnvironment(
  declarations: OutwardSmokeDeclaration[],
  currentEnvironment: string,
): {
  matching: OutwardSmokeDeclaration[];
  unmatched: { ac: string; reason: string }[];
} {
  const matching: OutwardSmokeDeclaration[] = [];
  const unmatched: { ac: string; reason: string }[] = [];

  for (const decl of declarations) {
    if (decl.environment === currentEnvironment) {
      matching.push(decl);
    } else {
      unmatched.push({
        ac: decl.command, // The command field doubles as the AC identifier from the declaration
        reason: `declared environment "${decl.environment}" does not match current environment "${currentEnvironment}"`,
      });
    }
  }

  return { matching, unmatched };
}

// ════════════════════════════════════════════════════════════════════════════
// Report builder
// ════════════════════════════════════════════════════════════════════════════

/** Parameters for building a smoke run report. */
export interface BuildReportParams {
  runId: string;
  environment: string;
  startedAt: string;
  /** Map of declaration command → spawn result. */
  spawnResults: Map<string, SmokeSpawnResult>;
  /** Declarations that were executed. */
  declarations: OutwardSmokeDeclaration[];
  /** Maps each declaration's command to its AC id. */
  acMap: Map<string, string>;
  /** Artifact directory path for relative artifact references. */
  artifactDir: string;
  /** Unmatched declarations (from environment gate). */
  unmatched: { ac: string; reason: string }[];
}

/**
 * Build a SmokeRunReport from spawn results and declarations.
 * Pure — all filesystem I/O is the caller's responsibility.
 */
export function buildSmokeRunReport(params: BuildReportParams): SmokeRunReport {
  const results: SmokeRunEntry[] = [];
  const unverified = [...params.unmatched];

  for (const decl of params.declarations) {
    const spawnResult = params.spawnResults.get(decl.command);
    const ac = params.acMap.get(decl.command) ?? decl.command;

    if (spawnResult === undefined) {
      // Spawn was never called for this declaration — treat as unverified
      // (should not happen in normal flow, but be defensive).
      unverified.push({
        ac,
        reason: `smoke was not executed for "${decl.command}" — possible infrastructure error`,
      });
      continue;
    }

    const exitCode = spawnResult.exitCode;
    const summary = spawnResult.timedOut
      ? `timed out after ${decl.timeoutSec}s`
      : exitCode === 0
        ? "smoke passed"
        : `exited with code ${exitCode ?? "SIGNAL"}: ${spawnResult.stderr.slice(0, 200).replace(/\n/g, " ")}`;

    results.push({
      ac,
      command: decl.command,
      environment: decl.environment,
      exitCode,
      summary,
      commandDigest: computeCommandDigest(decl.command),
      durationMs: spawnResult.durationMs,
      artifactPath: "", // Filled by caller after writing artifact
      startedAt: params.startedAt,
      timedOut: spawnResult.timedOut,
    });
  }

  return {
    runId: params.runId,
    environment: params.environment,
    startedAt: params.startedAt,
    results,
    unverified,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers for converting SmokeRunEntry → OutwardSmokeResult (resolver input)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert SmokeRunEntry array to the OutwardSmokeResult shape that
 * the outward verification resolver expects.
 */
export function toOutwardSmokeResults(entries: SmokeRunEntry[]): Array<{
  ac: string;
  exitCode: number;
  summary: string;
  command: string;
  environment: string;
}> {
  return entries.map((e) => ({
    ac: e.ac,
    exitCode: e.exitCode ?? 1, // Treat signal-killed as failure
    summary: e.summary,
    command: e.command,
    environment: e.environment,
  }));
}
