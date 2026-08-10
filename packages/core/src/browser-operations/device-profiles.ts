/**
 * @responsibility Provides the policy-controlled allowlist of device emulation profiles.
 * US-BROW-014 — Device emulation diagnostic profiles.
 *
 * A finite, policy-controlled allowlist of Chrome device/viewport profiles.
 * Callers cannot submit arbitrary DevTools emulation parameters — only the
 * named profiles listed here are valid. This is a diagnostic-only surface
 * bounded to the managed isolated lane.
 *
 * Domain invariant: this is Chrome DevTools emulation only. A true multi-browser
 * matrix requires a separately designed Playwright-oriented proposal.
 */
import type { BrowserDenialReason, DeviceProfile, DeviceProfileName } from "@roll/spec";

// ── Allowlist ────────────────────────────────────────────────────────────────

/** The policy-controlled device profile catalog. */
export const DEVICE_PROFILES: Readonly<Record<DeviceProfileName, DeviceProfile>> = {
  "Pixel 7": {
    name: "Pixel 7",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  },
  "iPhone 14": {
    name: "iPhone 14",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
  "iPad Pro": {
    name: "iPad Pro",
    width: 1024,
    height: 1366,
    deviceScaleFactor: 2,
    mobile: false,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
};

/** The set of known profile names (derived from the allowlist, single source). */
export const KNOWN_DEVICE_PROFILE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(DEVICE_PROFILES) as DeviceProfileName[],
);

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Validate and normalize a device profile name.
 *
 * Returns the resolved {@link DeviceProfile} on success, or a structured
 * {@link BrowserDenialReason} when the name is unknown.
 *
 * Normalization: trims whitespace and matches case-insensitively against the
 * allowlist. This is the single point where caller-supplied profile names are
 * checked.
 */
export function resolveDeviceProfile(
  raw: string,
): DeviceProfile | BrowserDenialReason {
  const trimmed = raw.trim();
  // Case-insensitive match against known names.
  const match = (Object.keys(DEVICE_PROFILES) as DeviceProfileName[]).find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match === undefined) {
    return {
      code: "unknown_device_profile",
      message: `Unknown device profile "${trimmed}". Known profiles: ${Object.keys(DEVICE_PROFILES).join(", ")}`,
      detail: { requested: trimmed, known: Object.keys(DEVICE_PROFILES) },
    };
  }
  return DEVICE_PROFILES[match];
}

/**
 * Type guard: returns true when the raw name resolves to a known profile.
 */
export function isKnownDeviceProfile(raw: string): raw is DeviceProfileName {
  const trimmed = raw.trim();
  return (Object.keys(DEVICE_PROFILES) as DeviceProfileName[]).some(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
}
