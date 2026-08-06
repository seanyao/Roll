/**
 * @responsibility Declares the browser live-gate regression evidence contract.
 */
/**
 * US-BROW-020 — Live managed-lane regression gate evidence contract.
 *
 * This is the structured-evidence vocabulary for the real local Chrome +
 * chrome-devtools-mcp integration suite. The suite must be impossible to
 * satisfy with a fixture: the gate verdict is only ever `verified` when a
 * REAL pinned MCP transport initialized, its tool manifest was verified, and
 * every scenario cleaned up its MCP, Chrome and temporary profile.
 *
 * The contrast this contract enforces:
 *   - `transportInitialized` — a real stdio MCP process completed `initialize`.
 *   - `manifestVerified`      — real `tools/list` matched the pinned manifest.
 *   - artifact `kind`s        — which diagnostic artifacts the real lane produced.
 *   - `cleanup`               — MCP / Chrome / temp-profile teardown state.
 *
 * A `fixture` source can populate the same shape, but a fixture source can
 * never produce a `verified` verdict (see `LiveGateResult`). "No assertion may
 * pass solely because a fixture returned the expected shape" (AC4).
 */

// ── Environment capability ───────────────────────────────────────────────────

/**
 * Whether the current environment can host the real live suite.
 *
 * The suite needs a real Chrome/Chromium binary and the ability to spawn the
 * pinned `chrome-devtools-mcp` package (npx present). When it cannot, the gate
 * fails LOUD as an explicitly-unavailable environment gate — it must never be
 * silently skipped while reporting the feature verified (AC5).
 */
export interface LiveGateEnvironment {
  /** A real Chrome/Chromium binary is present. */
  chromePresent: boolean;
  /** `npx` is available to launch the pinned MCP package. */
  npxPresent: boolean;
  /** Owner explicitly opted into the live, side-effecting lane. */
  liveOptIn: boolean;
  /** Human-readable detail for each missing capability (empty when capable). */
  missing: readonly string[];
}

// ── Per-scenario evidence ────────────────────────────────────────────────────

/**
 * The scenarios the live suite must exercise through the public managed path.
 *
 * The happy actions prove real navigation/DOM/console/network/screenshot and
 * opt-in profiles; the guard/failure scenarios prove final-origin denial and
 * that timeout / Chrome crash / MCP protocol error / redaction failure each
 * clean up completely (AC2, AC3).
 */
export type LiveScenarioKind =
  | "navigate"
  | "snapshot"
  | "console-summary"
  | "network-summary"
  | "diagnostic-screenshot"
  | "performance-profile"
  | "device-profile"
  | "redirect-denied"
  | "timeout-cleanup"
  | "chrome-crash-cleanup"
  | "mcp-protocol-error-cleanup"
  | "redaction-failure-cleanup";

/** Which teardown obligations a scenario discharged. */
export interface LiveCleanupState {
  /** The MCP session was closed. */
  mcpClosed: boolean;
  /** Chrome exited. */
  chromeExited: boolean;
  /** The temporary Chrome profile reached its terminal removed state. */
  tempProfileRemoved: boolean;
}

/** The outcome of one live scenario. */
export interface LiveScenarioOutcome {
  kind: LiveScenarioKind;
  /**
   * `pass` for happy actions that produced real diagnostics; `denied` for the
   * final-origin guard; `handled` for failure scenarios whose categorized
   * failure was raised AND cleaned up. `errored` means the scenario itself
   * broke the invariant (e.g. a failure was not cleaned up).
   */
  status: "pass" | "denied" | "handled" | "errored";
  /** Diagnostic artifact kinds this scenario produced (bounded, redacted). */
  artifactKinds: readonly string[];
  /** Teardown state — every scenario must reach full cleanup. */
  cleanup: LiveCleanupState;
  /** Categorized failure/denial detail, when the scenario expected one. */
  detail?: string;
}

// ── Aggregate ────────────────────────────────────────────────────────────────

/**
 * `RealManagedRunReport` — the aggregate the live suite emits.
 *
 * Records transport initialization, manifest verification, artifact facts and
 * terminal cleanup across all scenarios. `source` distinguishes a real run
 * from a fixture-shaped one so the gate can refuse to verify a fixture.
 */
export interface RealManagedRunReport {
  /** `real` = produced by a real MCP process + real Chrome. `fixture` = seam test only. */
  source: "real" | "fixture";
  /** Pinned MCP package identifier, e.g. `chrome-devtools-mcp@1.5.0`. */
  mcpPackage: string;
  /** A real stdio MCP process completed `initialize`. */
  transportInitialized: boolean;
  /** Real `tools/list` matched the pinned manifest. */
  manifestVerified: boolean;
  /** The local HTTP target origin the suite drove (never an external site). */
  targetOrigin: string;
  /** Every scenario outcome. */
  scenarios: readonly LiveScenarioOutcome[];
}

// ── Gate verdict ─────────────────────────────────────────────────────────────

/**
 * The gate verdict.
 *
 *   - `verified`    — a REAL report with transport+manifest+all scenarios clean.
 *   - `unavailable` — environment is not Chrome-capable / not opted in; the
 *                     suite did not run. This is NOT a pass and NOT a skip that
 *                     claims verification (AC5).
 *   - `failed`      — the suite ran but a scenario broke an invariant, or a
 *                     fixture-shaped report was submitted as if it were real.
 */
export type LiveGateVerdictKind = "verified" | "unavailable" | "failed";

export interface LiveGateResult {
  verdict: LiveGateVerdictKind;
  /** Human-readable reason (always populated). */
  reason: string;
  /** The report evaluated, when the suite ran. */
  report?: RealManagedRunReport;
  /** Missing capabilities when `unavailable`. */
  missing?: readonly string[];
  /** Scenario invariant violations when `failed`. */
  violations?: readonly string[];
}
