/**
 * @responsibility Validates generated acceptance reports with deterministic smoke assertions.
 * US-ATTEST-012 — acceptance-report render smoke test.
 *
 * "存在性"过闸不等于"有内容/能打开": a report file can exist yet be broken — an
 * <img> pointing at a screenshot that was never written, or an external CDN
 * asset that won't load offline (the whole point of the single-file report is
 * that it opens with no network). This pure checker is run right after the
 * report is written; any problem makes the caller exit non-zero.
 *
 * Scope (deliberately narrow, regex over the emitted HTML — the renderer is the
 * single producer so the surface is known):
 *   - parseable: non-empty AND carries the document scaffold (<html> + <body>)
 *   - <img src> must be RELATIVE and resolve to an existing file (via the
 *     injected `fileExists`, so this stays pure / fs-free / unit-testable)
 *   - NO external asset loads: <img src=http…>, <script src=http…>,
 *     <link … href=http…>. External <a href> (CI/deploy links) is fine.
 */

export interface SmokeResult {
  ok: boolean;
  /** Human-readable problems; empty ⇒ ok. */
  problems: string[];
}

const IMG_SRC = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi;
const VIDEO_SRC = /<(?:video|source)\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi;
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*"(https?:[^"]*)"/gi;
const LINK_HREF = /<link\b[^>]*\bhref\s*=\s*"(https?:[^"]*)"/gi;

function isExternal(url: string): boolean {
  return /^(https?:)?\/\//i.test(url);
}

/**
 * @param html        the rendered report
 * @param fileExists  resolver for a relative asset path (run-dir relative,
 *                    leading `./` stripped) → true when the file is on disk
 */
export function smokeCheckReport(html: string, fileExists: (relPath: string) => boolean): SmokeResult {
  const problems: string[] = [];

  if (html.trim() === "" || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    problems.push("unparseable report: missing <html>/<body> scaffold");
    return { ok: false, problems }; // nothing else is meaningful on a broken doc
  }

  for (const m of html.matchAll(IMG_SRC)) {
    const src = m[1] ?? "";
    if (isExternal(src)) {
      problems.push(`external img (CDN, breaks offline): ${src}`);
      continue;
    }
    const rel = src.replace(/^\.\//, "");
    if (!fileExists(rel)) problems.push(`broken img reference: ${src}`);
  }
  for (const m of html.matchAll(VIDEO_SRC)) {
    const src = m[1] ?? "";
    if (isExternal(src)) {
      problems.push(`external video (CDN, breaks offline): ${src}`);
      continue;
    }
    const rel = src.replace(/^\.\//, "");
    if (!fileExists(rel)) problems.push(`broken video reference: ${src}`);
  }
  for (const m of html.matchAll(SCRIPT_SRC)) problems.push(`external script (CDN): ${m[1] ?? ""}`);
  for (const m of html.matchAll(LINK_HREF)) problems.push(`external link asset (CDN): ${m[1] ?? ""}`);

  return { ok: problems.length === 0, problems };
}
