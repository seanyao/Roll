/**
 * @responsibility Resolves the deterministic per-commit test-gate command for the target project.
 * TestRunnerResolver (FIX-1274) — deterministic, fail-loud selection of the
 * per-commit test-gate command for the TARGET project `roll test` runs in.
 *
 * Problem it fixes: `roll test` historically appended roll's own `--affected`
 * token to `npm test`. Roll's own repo forwards that to `scripts/test-ts.sh`,
 * which understands it. But a plain Vitest project (e.g. APE-PR, pinning
 * Vitest 3.2.x) has `"scripts.test": "vitest run"`, so `npm test -- --affected`
 * becomes `vitest run --affected` — and Vitest's CLI rejects `--affected` as an
 * unknown option, exiting before any test runs. The fresh-proof pre-commit gate
 * then can never be satisfied, so a Roll-mandated TCR commit is impossible and
 * an otherwise-green delivery is stranded.
 *
 * This resolver inspects the target project and chooses a version-compatible
 * command instead of assuming one Vitest-only flag:
 *   - roll's own wrapper (`scripts/test-ts.sh`, or a `roll test` script) keeps
 *     the `--affected` token — the wrapper documents it and writes its own proof;
 *   - a raw Vitest project prefers the version-supported `--changed` changed-test
 *     mode, and NEVER forwards `--affected`;
 *   - when no safe changed mode can be verified (undetectable/too-old Vitest, or
 *     a non-Vitest runner) it runs the project's FULL test command — a strictly
 *     more conservative gate than the intended affected-only run;
 *   - a project with no test command at all is unresolvable → a structured
 *     diagnostic with the attempted command and a safe operator next step,
 *     never a silently-minted proof.
 *
 * Purity: this module reads no filesystem and holds no clock. The caller injects
 * the observed facts ({@link GateResolverInput}); the same facts always yield the
 * same plan, so repeated resolution for the same project/tree is deterministic.
 * The caller executes the plan and mints the proof ONLY on a real zero exit.
 */

/** Which gate mode the resolver selected. */
export type GateMode = "affected" | "changed" | "full";

/** A resolved, executable gate plan. */
export interface GatePlan {
  mode: GateMode;
  /**
   * Arguments to append after `npm test --` (verbatim). Empty means run the
   * project's full test command with no extra flags.
   */
  npmTestArgs: string[];
  /**
   * Whether `roll test` (rather than the invoked child) must write the
   * `.roll/last-test-pass` proof after a zero exit. False for the roll-wrapper
   * and legacy paths, whose child already owns the proof.
   */
  writesProof: boolean;
  /** Human-readable reason for the selection (surfaced in help/diagnostics). */
  reason: string;
}

/** A structured, actionable diagnostic for an unresolvable project runner. */
export interface GateDiagnostic {
  ok: false;
  /** The command that would have been needed but could not be resolved. */
  attempted: string;
  /** Why resolution failed. */
  reason: string;
  /** A safe operator next step. */
  nextStep: string;
}

export type GateResolution = { ok: true; plan: GatePlan } | GateDiagnostic;

/** Observed facts about the target project (all injected — no I/O here). */
export interface GateResolverInput {
  /** Whether a `package.json` exists at the project root. */
  hasPackageJson: boolean;
  /** `package.json` `scripts.test`, if present. */
  testScript?: string;
  /** Installed Vitest version from the target's node_modules, if detectable. */
  vitestVersion?: string;
}

/**
 * Minimum Vitest MAJOR version whose CLI documents the `--changed` changed-test
 * mode. `--changed` has shipped since Vitest 1.0; anything older (0.x) or
 * undetectable is treated as having no verified changed mode → full fallback.
 */
export const MIN_VITEST_CHANGED_MAJOR = 1;

/** Parse the leading major version integer from a semver-ish string. */
export function parseMajor(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const m = /^\D*(\d+)(?:\.|$)/.exec(version.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Does the test script delegate to roll's own wrapper (which owns `--affected`)? */
function isRollWrapper(script: string): boolean {
  return /test-ts\.sh/.test(script) || /\broll\s+test\b/.test(script);
}

/** Does the test script invoke Vitest directly? */
function usesVitest(script: string): boolean {
  return /\bvitest\b/.test(script);
}

/**
 * Resolve the per-commit gate command for the target project. Deterministic:
 * identical inputs always yield an identical resolution.
 */
export function resolveGateCommand(input: GateResolverInput): GateResolution {
  // Legacy / uninitialised cwd: with no package.json we cannot inspect the
  // runner, so preserve the historical `npm test -- --affected` default. The
  // invoked child (roll's shim / wrapper) owns the proof on this path.
  if (!input.hasPackageJson) {
    return {
      ok: true,
      plan: {
        mode: "affected",
        npmTestArgs: ["--affected"],
        writesProof: false,
        reason: "no package.json; legacy affected default (runner owns the proof)",
      },
    };
  }

  const script = (input.testScript ?? "").trim();

  // package.json present but no test command → nothing to run. Fail loud rather
  // than mint an empty green.
  if (script === "") {
    return {
      ok: false,
      attempted: "npm test",
      reason: 'package.json has no "scripts.test" — there is no test command to run',
      nextStep: 'add a "test" script (e.g. "vitest run") or run `roll test -- <your test command>`',
    };
  }

  // Roll's own wrapper documents the `--affected` token and writes its own
  // proof. Preserve it byte-for-byte.
  if (isRollWrapper(script)) {
    return {
      ok: true,
      plan: {
        mode: "affected",
        npmTestArgs: ["--affected"],
        writesProof: false,
        reason: "roll test wrapper understands --affected and writes its own proof",
      },
    };
  }

  // Raw Vitest project (the APE-PR case). Vitest's CLI does NOT accept roll's
  // `--affected` token, so never forward it. Prefer the version-supported
  // `--changed` changed-test mode; otherwise run the full suite (stricter).
  if (usesVitest(script)) {
    const major = parseMajor(input.vitestVersion);
    if (major !== undefined && major >= MIN_VITEST_CHANGED_MAJOR) {
      return {
        ok: true,
        plan: {
          mode: "changed",
          npmTestArgs: ["--changed"],
          writesProof: true,
          reason: `vitest ${input.vitestVersion} supports --changed; running changed-test mode`,
        },
      };
    }
    return {
      ok: true,
      plan: {
        mode: "full",
        npmTestArgs: [],
        writesProof: true,
        reason:
          input.vitestVersion !== undefined
            ? `vitest ${input.vitestVersion} has no verified changed-test mode; running full suite (conservative)`
            : "vitest present but version undetectable; running full suite (conservative)",
      },
    };
  }

  // Some other runner (jest/mocha/custom). We cannot safely inject an
  // affected/changed flag, so run the project's full test command unchanged —
  // strictly more conservative than a partial gate, and never a fabricated green.
  return {
    ok: true,
    plan: {
      mode: "full",
      npmTestArgs: [],
      writesProof: true,
      reason: "non-vitest runner; running the project's full test command (conservative)",
    },
  };
}

/**
 * Does captured runner output indicate that a changed/affected selection matched
 * ZERO test files? Vitest prints this when `--changed` selects nothing and exits
 * non-zero (without `--passWithNoTests`). A zero-test run must NEVER mint a green
 * proof; the caller instead falls back to the full suite. If a future Vitest
 * changes this message the check degrades safely: an unrecognised non-zero exit
 * is treated as a real failure (no proof), never a fabricated pass.
 */
export function isNoTestsFoundOutput(output: string): boolean {
  return /No test files found/i.test(output);
}
