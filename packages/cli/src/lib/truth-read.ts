/**
 * @responsibility Reads the one TruthSnapshot for the CLI surfaces.
 */
/**
 * US-DOSSIER-035 — the CLI's reader for the ONE TruthSnapshot the static archive
 * reads (US-DOSSIER-010/021). `roll index` writes `.roll/features/truth.json`
 * and embeds the SAME object in index.html; the CLI front door + `roll status`
 * consume *that* file rather than recomputing, so a number can never differ
 * between the CLI and the web Now tab (the spec's one-number-everywhere rule).
 *
 * Pure derivations only — read the snapshot, then select. No git/GitHub/clock
 * access in the selectors (the render path stays byte-stable for snapshots);
 * "now" for the staleness probe is injected (ROLL_RENDER_NOW), never read here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TruthSnapshot, TruthSnapshotVerdict } from "@roll/spec";

/** The shared snapshot path under a project root. */
export function truthJsonPath(cwd: string): string {
  return join(cwd, ".roll", "features", "truth.json");
}

/**
 * Load the snapshot the web reads. Returns `undefined` when the file is absent
 * or unparseable — callers fall back honestly (AC2), never fabricate a verdict.
 */
export function loadTruthSnapshot(cwd: string): TruthSnapshot | undefined {
  const p = truthJsonPath(cwd);
  if (!existsSync(p)) return undefined;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8")) as TruthSnapshot;
    if (typeof obj !== "object" || obj === null || obj.story === undefined) return undefined;
    return obj;
  } catch {
    return undefined;
  }
}

/** Snapshots older than this are reported as stale (mirrors the web banner's 6h). */
export const TRUTH_STALE_MS = 6 * 3600 * 1000;

/** True when the snapshot's `generatedAt` is older than the stale window. */
export function isSnapshotStale(s: TruthSnapshot, nowMs: number): boolean {
  const gen = Date.parse(s.generatedAt);
  if (Number.isNaN(gen)) return false;
  return nowMs - gen > TRUTH_STALE_MS;
}

/**
 * The verdict word, derived from the snapshot with the SAME table the web
 * Now tab uses (`consoleVerdict` in truth-console.ts): fail > 0 → fail,
 * warn > 0 → warn, no audit → unknown, else pass. Returns the lowercase
 * vocabulary that maps to exit codes 0/1/2 (pass/warn|unknown/fail).
 */
export function snapshotVerdict(s: TruthSnapshot): TruthSnapshotVerdict {
  const a = s.audit;
  if (a === undefined) return "unknown";
  if (a.fail > 0) return "fail";
  if (a.warn > 0) return "warn";
  return "pass";
}

/**
 * Attest coverage from the per-story ladder (US-DOSSIER-021): the share of
 * stories that reached the `attested` rung. This is the SAME registry the web
 * Skills/Now surfaces read — no independently recomputed figure (AC4).
 * Returns 0 when the snapshot predates the `stories[]` registry.
 */
export function attestCoverage(s: TruthSnapshot): { pct: number; attested: number; total: number } {
  const rows = s.stories ?? [];
  const total = rows.length;
  if (total === 0) return { pct: 0, attested: 0, total: 0 };
  const attested = rows.filter((r) => r.ladder === "attested").length;
  return { pct: Math.round((attested / total) * 100), attested, total };
}

/** Test-only pinnable clock (mirrors index-gen/dashboard renderNow). */
export function renderNowMs(): number {
  const v = process.env["ROLL_RENDER_NOW"] ?? "";
  if (v !== "") {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}
