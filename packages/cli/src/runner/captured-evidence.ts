/**
 * @responsibility Binds CAPTURED evidence into the harness-owned evidence set.
 */
/**
 * US-EVID-023 — harness-owned binding for CAPTURED evidence.
 *
 * The empty-shell discard (55/116 blocked attestations) is dominated by an
 * ac-map that points at paths the builder TYPED but never created, while the
 * real captured artifact (evidence.json / screenshots/) sits elsewhere. Fix: the
 * harness — which KNOWS what it captured — owns the binding for captured
 * artifacts; the builder never types or confirms those paths (its ac-map only
 * covers NON-captured evidence: named test-pass, manual notes).
 *
 * This module reads the harness's own capture manifest (`evidence.json`, the
 * same `taken`/`skipped` shape consistency-audit and the attest gate already
 * read) and the run-dir `screenshots/`, and returns:
 *   - the REAL captured refs to bind into the ac-map, and
 *   - the capture FAILURES to surface (a declared capture that produced nothing),
 *     so a roll-capture failure / headless timeout / non-zero cmd is a visible
 *     signal instead of a silent empty shell.
 * Pure read: run-dir path → values. No writes, no network.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A real captured artifact the harness produced — bound into the ac-map by the harness. */
export interface CapturedRef {
  kind: "screenshot" | "text" | "cast" | "capture";
  ref: string;
  label?: string;
}

export interface CaptureFailure {
  label?: string;
  error: string;
  kind?: string;
}

interface Manifest {
  captures?: unknown;
  screenshots?: unknown;
  texts?: unknown;
  capture_receipts?: unknown;
  evidence_health?: unknown;
}

/**
 * US-EVID-031 — one surface's resolved visual-evidence health, read back from the
 * run manifest's `evidence_health`. Delivery correctness and visual health are
 * SEPARATE facts: `blocksGate` marks the loud evidence/contract failures
 * (invalid-target / absent-contract); `markedDegraded` is a broken machine that
 * publishes without a rebuild.
 */
export interface EvidenceHealthReadout {
  surfaceId: string | null;
  visual: string;
  delivery: string;
  category: string;
  blocksGate: boolean;
  reschedulesBuild: boolean;
  markedDegraded: boolean;
  reason: string;
}

function readManifest(runDir: string): Manifest | null {
  const p = join(runDir, "evidence.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Manifest) : null;
  } catch {
    return null;
  }
}

function rowStr(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

const IMG = /\.(png|jpe?g|webp|gif)$/i;

/**
 * The real captured artifacts the harness produced in this run dir. Only
 * genuinely-present captures count: a `captures[]` row with `taken === true`, an
 * image file physically under `screenshots/`, and any `texts[]` file ref. These
 * are the refs the harness binds into the ac-map — never a builder-typed path.
 */
export function capturedEvidenceRefs(runDir: string): CapturedRef[] {
  const out: CapturedRef[] = [];
  const seen = new Set<string>();
  const push = (kind: CapturedRef["kind"], ref: string, label?: string): void => {
    if (ref === "" || seen.has(`${kind}:${ref}`)) return;
    seen.add(`${kind}:${ref}`);
    out.push(label !== undefined ? { kind, ref, label } : { kind, ref });
  };

  const m = readManifest(runDir);
  if (m !== null && Array.isArray(m.captures)) {
    for (const raw of m.captures) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as Record<string, unknown>;
      if (row["taken"] !== true) continue;
      const ref = rowStr(row, "href") ?? rowStr(row, "path");
      if (ref !== undefined) push("capture", ref, rowStr(row, "label"));
    }
  }
  if (m !== null && Array.isArray(m.texts)) {
    for (const raw of m.texts) {
      if (typeof raw === "string") push("text", raw);
      else if (typeof raw === "object" && raw !== null) {
        const ref = rowStr(raw as Record<string, unknown>, "textFile") ?? rowStr(raw as Record<string, unknown>, "path");
        if (ref !== undefined) push("text", ref, rowStr(raw as Record<string, unknown>, "label"));
      }
    }
  }
  try {
    for (const f of readdirSync(join(runDir, "screenshots"))) {
      if (IMG.test(f)) push("screenshot", join("screenshots", f));
    }
  } catch {
    /* no screenshots dir */
  }
  return out;
}

/**
 * US-EVID-030 — the harness-owned refs for accepted Capture Gateway v2 receipts
 * the planner recorded into this run's CaptureSet (folded into `evidence.json`'s
 * `capture_receipts`). Only genuinely-taken receipts with a screenshot path count;
 * both physical AND rendered images are surfaced, each labelled by source. Pure
 * read of the run dir — no writes, no network (the read-only binding invariant).
 */
export function capturedReceiptRefs(runDir: string): CapturedRef[] {
  const m = readManifest(runDir);
  if (m === null || !Array.isArray(m.capture_receipts)) return [];
  const out: CapturedRef[] = [];
  const seen = new Set<string>();
  for (const raw of m.capture_receipts) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["state"] !== "taken") continue;
    const ref = rowStr(row, "screenshotPath");
    if (ref === undefined || seen.has(ref)) continue;
    seen.add(ref);
    const source = rowStr(row, "source");
    const surface = rowStr(row, "surfaceId");
    const label =
      source === "roll-capture-window"
        ? `Roll Capture · physical${surface !== undefined ? ` · ${surface}` : ""}`
        : source === "playwright-rendered"
          ? `Playwright · rendered${surface !== undefined ? ` · ${surface}` : ""}`
          : (surface ?? "capture");
    out.push({ kind: "screenshot", ref, label });
  }
  return out;
}

/**
 * US-EVID-031 — read the resolved per-surface visual-evidence health from the run
 * manifest. Pure read; empty when no v2 surface was declared (legacy stories).
 */
export function evidenceHealthReadouts(runDir: string): EvidenceHealthReadout[] {
  const m = readManifest(runDir);
  if (m === null || !Array.isArray(m.evidence_health)) return [];
  const out: EvidenceHealthReadout[] = [];
  for (const raw of m.evidence_health) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const visual = rowStr(row, "visual");
    if (visual === undefined) continue;
    out.push({
      surfaceId: rowStr(row, "surfaceId") ?? null,
      visual,
      delivery: rowStr(row, "delivery") ?? "passed",
      category: rowStr(row, "category") ?? "",
      blocksGate: row["blocksGate"] === true,
      reschedulesBuild: row["reschedulesBuild"] === true,
      markedDegraded: row["markedDegraded"] === true,
      reason: rowStr(row, "reason") ?? "",
    });
  }
  return out;
}

export function captureFailures(runDir: string): CaptureFailure[] {
  const m = readManifest(runDir);
  if (m === null || !Array.isArray(m.captures)) return [];

  const out: CaptureFailure[] = [];
  for (const raw of m.captures) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["taken"] === true || row["failed"] !== true) continue;

    const label = rowStr(row, "label");
    const kind = rowStr(row, "kind");
    const error = rowStr(row, "error") ?? rowStr(row, "skipped") ?? "capture failed";
    out.push({ ...(label !== undefined ? { label } : {}), error, ...(kind !== undefined ? { kind } : {}) });
  }
  return out;
}
