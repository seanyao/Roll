/**
 * @responsibility Pins the Playwright version for deterministic headless Chromium.
 */
/**
 * FIX-394 — pinned Playwright version for deterministic headless Chromium.
 *
 * `@latest` drifts across releases; a pinned version keeps the browser version,
 * install command, and cache key aligned. Bump this constant deliberately as
 * part of a release rather than letting it float.
 *
 * Detecting whether the pinned Chromium is installed avoids repeated downloads
 * and surfaces an actionable message when the host is offline.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The single pinned Playwright version used by every headless-Chromium path. */
export const PLAYWRIGHT_VERSION = "1.52.0";

/** npx-ready package reference for screenshot / install commands. */
export const PLAYWRIGHT_PIN = `playwright@${PLAYWRIGHT_VERSION}`;

/** `playwright install chromium` for self-heal and external-tool repair. */
export const PLAYWRIGHT_INSTALL_CHROMIUM = `npx -y ${PLAYWRIGHT_PIN} install chromium`;

/**
 * Default Playwright browser cache directory. Mirrors the same logic as
 * `external-tools.ts:defaultPlaywrightBrowsersPath` so the pin file does not
 * take a dependency on `cli`.
 */
export function playwrightBrowsersPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return join(env["HOME"] ?? homedir(), "Library", "Caches", "ms-playwright");
  if (platform === "win32") return join(env["LOCALAPPDATA"] ?? join(env["HOME"] ?? homedir(), "AppData", "Local"), "ms-playwright");
  return join(env["HOME"] ?? homedir(), ".cache", "ms-playwright");
}

/**
 * True when a Chromium browser (headless or headed) is present in the
 * Playwright cache so we can tell pre-install / self-heal to skip.
 */
export function chromiumInstalled(cacheDir?: string): boolean {
  const cache = cacheDir ?? playwrightBrowsersPath();
  try {
    const entries = readdirSync(cache);
    return entries.some(
      (name) => /^chromium(-|_headless_shell-|$)/.test(name) || /^chromium_headless_shell-/.test(name),
    ) || existsSync(join(cache, "chromium"));
  } catch {
    return false;
  }
}
