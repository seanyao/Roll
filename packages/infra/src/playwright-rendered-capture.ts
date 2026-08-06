/**
 * @responsibility Renders pages with Playwright for in-process capture.
 */
/**
 * US-PHYSICAL-010 — Playwright render port for in-process rendered v2 capture.
 *
 * Headless Chromium navigates a declared surface URL, writes a PNG to `out`,
 * and reports the final URL so the serve entry can reject login / foreign
 * redirects. Non-loopback targets are refused before the browser launches.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { RenderedSurfacePort, RenderedSurfaceRenderResult } from "@roll/core";
import { isLoopbackCaptureUrl } from "./controlled-local-window-capture.js";

export type PlaywrightRenderedSurfaceDeps = {
  launch?: () => Promise<Browser>;
};

/**
 * Create a {@link RenderedSurfacePort} backed by pinned Playwright Chromium.
 * Injectable `launch` keeps unit tests free of a real browser binary.
 */
export function createPlaywrightRenderedSurfacePort(deps: PlaywrightRenderedSurfaceDeps = {}): RenderedSurfacePort {
  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));

  return {
    async render(input: { url: string; out: string; timeoutMs: number }): Promise<RenderedSurfaceRenderResult> {
      if (!isLoopbackCaptureUrl(input.url)) {
        return { status: "skipped", reason: "disallowed target: rendered capture only permits loopback HTTP(S) pages" };
      }

      let browser: Browser | undefined;
      try {
        browser = await launch();
        const page = await browser.newPage();
        page.setDefaultTimeout(Math.max(1, input.timeoutMs));
        const response = await page.goto(input.url, { waitUntil: "domcontentloaded" });
        if (response !== null && response.status() >= 400) {
          return {
            status: "failed",
            reason: `rendered navigation returned HTTP ${response.status()} for "${input.url}"`,
          };
        }
        const finalUrl = page.url();
        await mkdir(dirname(input.out), { recursive: true });
        await page.screenshot({ path: input.out, fullPage: true, type: "png" });
        return { status: "taken", screenshotPath: input.out, finalUrl };
      } catch (error) {
        return {
          status: "failed",
          reason: `playwright render failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        if (browser !== undefined) {
          try {
            await browser.close();
          } catch {
            // Browser already gone — the caller still gets the render outcome.
          }
        }
      }
    },
  };
}
