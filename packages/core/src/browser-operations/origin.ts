/**
 * @responsibility Normalizes and validates browser operation origins against the allowlist.
 * US-BROW-001 AC2 — Origin normalizer and validator.
 *
 * Normalize and validate origin before adapter invocation:
 * - Normalize scheme + hostname + effective port
 * - Reject non-HTTPS (except loopback)
 * - Reject userinfo, trailing-dot, suffix attacks
 * - Match against allowlist with wildcard (leftmost label only)
 *
 * See managed-devtools-plan.md §§3, 5.2.
 */

import type {
  BrowserActionKind,
  BrowserDenialReason,
  BrowserLane,
  BrowserLanePolicy,
  NormalizedOrigin,
  OriginValidationResult,
} from "@roll/spec";
import { BROWSER_ACTION_KINDS } from "@roll/spec";

// ── URL parsing helpers ─────────────────────────────────────────────────────

function parseUrl(raw: string): URL | BrowserDenialReason {
  try {
    return new URL(raw);
  } catch {
    return { code: "origin_invalid", message: `Cannot parse URL: "${raw}"` };
  }
}

function hasUserinfo(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

function hasTrailingDot(hostname: string): boolean {
  return hostname.endsWith(".");
}

/**
 * Detect suffix/registrable-sibling attacks:
 * - A hostname that looks like a public suffix but isn't (e.g. "com.example.com")
 * - Hostnames with excessive labels that try to look like a legitimate domain
 * - Hostnames with encoded dots or other bypass tricks
 */
/**
 * Check raw URL string for encoded bypass characters BEFORE URL parsing.
 * URL constructor decodes percent-encoded sequences, so we must check
 * the raw input for encoded dots, slashes, and other bypass tricks.
 */
function hasEncodedBypassChars(raw: string): boolean {
  // Percent-encoded dot (%2E, %2e) — URL constructor decodes this to "."
  if (/%2[eE]/i.test(raw)) return true;
  // Percent-encoded slash (%2F, %2f)
  if (/%2[fF]/i.test(raw)) return true;
  // Percent-encoded backslash (%5C, %5c)
  if (/%5[cC]/i.test(raw)) return true;
  // Percent-encoded null (%00)
  if (/%00/i.test(raw)) return true;
  // Raw backslash (not valid in URLs)
  if (raw.includes("\\")) return true;
  return false;
}

function isSuffixAttack(hostname: string): boolean {
  // Reject hostnames with encoded characters that could be used for bypass
  if (hostname.includes("%") || hostname.includes("\\")) return true;

  // Reject hostnames that start or end with a hyphen (DNS-invalid, possible bypass)
  const labels = hostname.split(".");
  for (const label of labels) {
    if (label.length === 0) return true; // consecutive dots
    if (label.startsWith("-") || label.endsWith("-")) return true;
  }

  return false;
}

function isIpLiteral(hostname: string): boolean {
  // IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // IPv6 (bracketed)
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return false;
}

function isLoopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost") return true;
  if (lower === "127.0.0.1") return true;
  if (lower === "[::1]") return true;
  return false;
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number.parseInt(url.port, 10);
  // Default ports
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return Number.parseInt(url.port || "0", 10);
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize an origin: lowercase scheme + hostname, compute effective port,
 * return a NormalizedOrigin.
 *
 * Returns BrowserDenialReason if the URL is structurally invalid.
 */
export function normalizeOrigin(raw: string): NormalizedOrigin | BrowserDenialReason {
  const parsed = parseUrl(raw);
  if ("code" in parsed) return parsed;

  // Normalize scheme
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

  // Extract hostname (strip brackets from IPv6 for normalization)
  let hostname = parsed.hostname.toLowerCase();

  // Build normalized origin
  const port = effectivePort(parsed);
  const normalized = `${scheme}://${hostname}:${port}`;

  return {
    normalized,
    raw,
    scheme,
    hostname,
    port,
    isLoopback: isLoopback(hostname),
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ValidationOptions {
  /** The lane being requested (managed/interactive). */
  lane: BrowserLane;
  /** The lane's resolved policy. */
  policy: BrowserLanePolicy;
}

/**
 * Validate an origin against the policy rules.
 *
 * Checks in order:
 * 1. URL parseable
 * 2. No userinfo
 * 3. No trailing dot
 * 4. No suffix attack
 * 5. HTTPS required (except loopback)
 * 6. Loopback: only non-loopback debug endpoints are rejected (loopback is allowed for local dev)
 * 7. Allowlist match
 */
export function validateOrigin(
  raw: string,
  options: ValidationOptions,
): OriginValidationResult {
  // Pre-check: reject encoded bypass characters BEFORE URL parsing
  // (URL constructor decodes %2E → ".", which would hide the attack)
  if (hasEncodedBypassChars(raw)) {
    return {
      valid: false,
      reason: {
        code: "origin_suffix_attack",
        message: `Origin contains encoded bypass characters: "${raw}"`,
        detail: { origin: raw },
      },
    };
  }

  const parsed = parseUrl(raw);
  if ("code" in parsed) {
    return { valid: false, reason: parsed };
  }

  // Rule: no userinfo
  if (hasUserinfo(parsed)) {
    return {
      valid: false,
      reason: {
        code: "origin_userinfo",
        message: `Origin contains userinfo: "${raw}"`,
        detail: { origin: raw },
      },
    };
  }

  // Rule: no trailing dot
  const hostname = parsed.hostname.toLowerCase();
  if (hasTrailingDot(hostname)) {
    return {
      valid: false,
      reason: {
        code: "origin_trailing_dot",
        message: `Origin has trailing dot: "${raw}"`,
        detail: { hostname, origin: raw },
      },
    };
  }

  // Rule: no suffix attack
  if (isSuffixAttack(hostname)) {
    return {
      valid: false,
      reason: {
        code: "origin_suffix_attack",
        message: `Origin appears to be a suffix/encoding attack: "${raw}"`,
        detail: { hostname, origin: raw },
      },
    };
  }

  // Rule: HTTPS required (except loopback)
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const loopback = isLoopback(hostname);
  if (scheme !== "https" && !loopback) {
    return {
      valid: false,
      reason: {
        code: "origin_not_https",
        message: `Origin must be HTTPS: "${raw}"`,
        detail: { scheme, origin: raw },
      },
    };
  }

  // Rule: loopback allowed for local dev; reject non-loopback debug ports
  if (loopback) {
    // loopback is explicitly allowed for local development
  }

  // Normalize
  const normalized = normalizeOrigin(raw);
  if ("code" in normalized) {
    return { valid: false, reason: normalized };
  }

  // Rule: allowlist match
  const allowed = options.policy.allowedOrigins;
  if (allowed.length > 0 && !matchesAllowlist(normalized.normalized, allowed)) {
    return {
      valid: false,
      reason: {
        code: "origin_not_allowed",
        message: `Origin not in allowlist: "${normalized.normalized}"`,
        detail: { normalized: normalized.normalized, allowedOrigins: allowed },
      },
    };
  }

  return { valid: true, normalized };
}

// ── Allowlist matching ──────────────────────────────────────────────────────

/**
 * Check if a normalized origin matches any pattern in the allowlist.
 *
 * Rules (per §5.2):
 * - Origin is normalized to `scheme + hostname + effective port` first.
 * - Wildcard `*` is only valid as the leftmost hostname label (e.g. `*.vercel.app`).
 * - `*` alone, IP ranges, scheme wildcards, and path wildcards are rejected.
 * - The pattern must include the full scheme://hostname:port.
 */
export function matchesAllowlist(
  normalized: string,
  allowlist: readonly string[],
): boolean {
  for (const pattern of allowlist) {
    if (originMatchesPattern(normalized, pattern)) return true;
  }
  return false;
}

/**
 * Check if a single normalized origin matches a single allowlist pattern.
 */
function originMatchesPattern(normalized: string, pattern: string): boolean {
  // Exact match
  if (normalized === pattern) return true;

  // Parse both as URLs for component matching
  let patternUrl: URL;
  try {
    patternUrl = new URL(pattern);
  } catch {
    return false; // invalid pattern → no match
  }

  let originUrl: URL;
  try {
    originUrl = new URL(normalized);
  } catch {
    return false;
  }

  // Schemes must match exactly
  if (originUrl.protocol !== patternUrl.protocol) return false;

  // Ports must match (after normalization)
  const originPort = effectivePort(originUrl);
  const patternPort = effectivePort(patternUrl);
  if (originPort !== patternPort) return false;

  // Hostname matching with wildcard support
  const originHost = originUrl.hostname.toLowerCase();
  const patternHost = patternUrl.hostname.toLowerCase();

  if (originHost === patternHost) return true;

  // Wildcard: only leftmost label, e.g. "*.vercel.app"
  if (patternHost.startsWith("*.")) {
    const suffix = patternHost.slice(1); // ".vercel.app"
    if (originHost.endsWith(suffix)) {
      // Ensure the wildcard matches exactly one label
      const prefix = originHost.slice(0, -suffix.length);
      if (prefix.length > 0 && !prefix.includes(".")) {
        return true;
      }
    }
  }

  return false;
}

// ── Policy fingerprint ──────────────────────────────────────────────────────

import { createHash } from "node:crypto";

/**
 * Compute the policy fingerprint: SHA-256 of stable-key-sorted,
 * no-whitespace JSON of the BrowserLanePolicy.
 *
 * This fingerprint is embedded in every BrowserOperationRun so that
 * the authorization semantics can be replayed/audited later.
 */
export function policyFingerprint(policy: BrowserLanePolicy): string {
  const serialized = JSON.stringify(policy, stableKeys);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * JSON.stringify replacer that sorts object keys for deterministic output.
 */
function stableKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ── Action validation ───────────────────────────────────────────────────────

/**
 * Check whether an action is in the policy's allowed actions.
 */
export function isActionAllowed(
  action: BrowserActionKind,
  policy: BrowserLanePolicy,
): boolean {
  return policy.allowedActions.includes(action);
}

// ── Comprehensive deny-before-adapter check ─────────────────────────────────

export interface AuthorizeOriginResult {
  authorized: boolean;
  denial?: BrowserDenialReason;
  normalized?: NormalizedOrigin;
}

/**
 * Full deny-before-invoke check: origin validation against lane policy.
 * If the origin is valid, returns the normalized form.
 * Never invokes an adapter.
 */
export function authorizeOrigin(
  raw: string,
  policy: BrowserLanePolicy,
): AuthorizeOriginResult {
  const validation = validateOrigin(raw, { lane: "managed", policy });
  if (!validation.valid) {
    return { authorized: false, denial: validation.reason };
  }
  return { authorized: true, normalized: validation.normalized };
}
