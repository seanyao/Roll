/**
 * @responsibility Provides the opt-in policy-gated performance diagnostic profile.
 * US-BROW-012 — Optional DevTools performance diagnostic profile.
 *
 * A single, opt-in, policy-gated performance diagnostic profile. It collects a
 * bounded allowlist of numeric local DevTools performance metrics and produces a
 * redacted summary. Two invariants define this surface:
 *
 *  1. Data minimization — only metric names in the profile allowlist survive.
 *     No URL, resource name, or trace is ever retained, so nothing here can be
 *     turned into an analytics or evidence channel.
 *  2. Opt-in — the profile is disabled unless the lane policy explicitly enables
 *     `performanceDiagnostics` AND a known profile name is selected.
 *
 * Domain invariant: this is a narrow local diagnostic profile. Lighthouse, CrUX
 * upload, and a generic DevTools command surface are explicitly out of scope —
 * they require a separately designed, consent-gated proposal.
 */
import type {
  BrowserDenialReason,
  PerformanceDiagnosticSummary,
  PerformanceProfile,
  PerformanceProfileName,
} from "@roll/spec";

// ── Allowlist ────────────────────────────────────────────────────────────────

/**
 * The policy-controlled performance profile catalog.
 *
 * `web-vitals-lite` collects a small set of numeric counters/durations from
 * `Performance.getMetrics`. Every metric name is a fixed DevTools counter —
 * none can carry a URL or free-form string.
 */
export const PERFORMANCE_PROFILES: Readonly<Record<PerformanceProfileName, PerformanceProfile>> = {
  "web-vitals-lite": {
    name: "web-vitals-lite",
    metrics: [
      "Timestamp",
      "Documents",
      "Frames",
      "JSEventListeners",
      "Nodes",
      "LayoutCount",
      "RecalcStyleCount",
      "LayoutDuration",
      "RecalcStyleDuration",
      "ScriptDuration",
      "TaskDuration",
      "JSHeapUsedSize",
    ],
    maxEntries: 12,
  },
};

/** The set of known profile names (derived from the allowlist, single source). */
export const KNOWN_PERFORMANCE_PROFILE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(PERFORMANCE_PROFILES) as PerformanceProfileName[],
);

/** Decimal places retained for a summarized metric value (defensive bound). */
const METRIC_VALUE_PRECISION = 3;

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Validate and normalize a performance profile name (case-insensitive, trimmed).
 *
 * Returns the resolved {@link PerformanceProfile} or a structured
 * {@link BrowserDenialReason} (`unknown_performance_profile`) when the name is
 * not in the allowlist. This is the single point where caller-supplied names are
 * checked — arbitrary DevTools parameters cannot be smuggled through it.
 */
export function resolvePerformanceProfile(
  raw: string,
): PerformanceProfile | BrowserDenialReason {
  const trimmed = raw.trim();
  const match = (Object.keys(PERFORMANCE_PROFILES) as PerformanceProfileName[]).find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match === undefined) {
    return {
      code: "unknown_performance_profile",
      message: `Unknown performance profile "${trimmed}". Known profiles: ${Object.keys(PERFORMANCE_PROFILES).join(", ")}`,
      detail: { requested: trimmed, known: Object.keys(PERFORMANCE_PROFILES) },
    };
  }
  return PERFORMANCE_PROFILES[match];
}

/** Type guard: true when the raw name resolves to a known profile. */
export function isKnownPerformanceProfile(raw: string): raw is PerformanceProfileName {
  const trimmed = raw.trim();
  return (Object.keys(PERFORMANCE_PROFILES) as PerformanceProfileName[]).some(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
}

// ── Authorization (opt-in policy gate) ───────────────────────────────────────

/**
 * Authorize a performance profile against the lane policy.
 *
 * The profile is disabled unless `policy.performanceDiagnostics === true`. When
 * disabled, returns `performance_profile_denied` WITHOUT resolving the name, so a
 * caller cannot probe the allowlist through a disabled lane. When enabled, the
 * name is resolved through {@link resolvePerformanceProfile}.
 */
export function authorizePerformanceProfile(
  raw: string,
  policy: { performanceDiagnostics?: boolean },
): PerformanceProfile | BrowserDenialReason {
  if (policy.performanceDiagnostics !== true) {
    return {
      code: "performance_profile_denied",
      message:
        "Performance diagnostic profile is disabled. Enable performanceDiagnostics in the managed lane policy to opt in.",
      detail: { requested: raw.trim() },
    };
  }
  return resolvePerformanceProfile(raw);
}

// ── Summarization (bounds + redaction) ───────────────────────────────────────

/**
 * Build a bounded, redacted {@link PerformanceDiagnosticSummary} from raw CDP
 * metrics.
 *
 * Redaction and bounds, in order:
 *  - keep only metric names in the profile allowlist (drops everything else,
 *    including any name that could carry a URL);
 *  - drop non-finite / non-numeric values;
 *  - round values to a fixed precision;
 *  - cap the number of entries at `profile.maxEntries`.
 *
 * The output never contains a string other than an allowlisted metric name.
 */
export function summarizePerformanceMetrics(
  rawMetrics: ReadonlyArray<{ name?: unknown; value?: unknown }>,
  profile: PerformanceProfile,
): PerformanceDiagnosticSummary {
  const allow = new Set(profile.metrics);
  const seen = new Set<string>();
  const metrics: { name: string; value: number }[] = [];

  for (const entry of rawMetrics) {
    if (metrics.length >= profile.maxEntries) break;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    const value = typeof entry.value === "number" ? entry.value : undefined;
    if (name === undefined || value === undefined) continue;
    if (!allow.has(name) || seen.has(name)) continue;
    if (!Number.isFinite(value)) continue;
    seen.add(name);
    metrics.push({ name, value: roundTo(value, METRIC_VALUE_PRECISION) });
  }

  return { profile: profile.name, metrics, degraded: false };
}

/** A degraded summary — collection failed; no signal, but never fatal. */
export function degradedPerformanceSummary(
  profile: PerformanceProfileName,
): PerformanceDiagnosticSummary {
  return { profile, metrics: [], degraded: true };
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
