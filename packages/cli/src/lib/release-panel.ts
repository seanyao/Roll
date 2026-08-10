/**
 * @responsibility Builds the release tab gate head and seven-dimension consistency panel.
 */
/**
 * US-DOSSIER-015 / FIX-391 — the release tab's gate head + seven-dimension consistency
 * panel view model. The opaque "gate audit" line becomes a readable table:
 * each dimension carries its f/w/? and drift-card handles; the rows sum
 * STRICTLY to the status line (the same audit summary truth.json carries).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONSISTENCY_DIMENSIONS,
  tallyByDimension,
  type AuditFinding,
  type ConsistencyDimension,
  type DimensionTally,
} from "@roll/core";
import { parseEventLine } from "@roll/spec";
import { reconcileReleaseForProject, type ReleaseFactsReader } from "./release-truth.js";

export interface ReleasePanelDim {
  key: ConsistencyDimension;
  tally: DimensionTally;
}

export interface ReleasePanelVM {
  /** Per-dimension tallies in the ①..⑦ order. */
  dims: ReleasePanelDim[];
  /** The audit status line (excl. grandfathered) — rows sum to exactly this. */
  total: { fail: number; warn: number; unknown: number };
  /** Any failing dimension blocks the release (consistency.md). */
  blocking: boolean;
  generatedAt?: string;
  /** Previous gated tag (the one before the latest), when knowable. */
  prevTag?: string;
}

export function collectReleasePanel(projectPath: string, releaseReader?: ReleaseFactsReader): ReleasePanelVM {
  const dimsEmpty = CONSISTENCY_DIMENSIONS.map((key) => ({
    key,
    tally: { fail: 0, warn: 0, unknown: 0, subjects: [] as string[] },
  }));
  const out: ReleasePanelVM = { dims: dimsEmpty, total: { fail: 0, warn: 0, unknown: 0 }, blocking: false };

  // Latest consistency report → findings → per-dimension tallies.
  const dir = join(projectPath, ".roll", "reports", "consistency");
  try {
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .at(-1);
    if (latest !== undefined) {
      const obj = JSON.parse(readFileSync(join(dir, latest), "utf8")) as {
        generatedAt?: string;
        findings?: AuditFinding[];
      };
      const findings = Array.isArray(obj.findings) ? obj.findings : [];
      const tallies = tallyByDimension(findings);
      out.dims = CONSISTENCY_DIMENSIONS.map((key) => ({ key, tally: tallies[key] }));
      for (const d of out.dims) {
        out.total.fail += d.tally.fail;
        out.total.warn += d.tally.warn;
        out.total.unknown += d.tally.unknown;
      }
      out.blocking = out.total.fail > 0;
      if (typeof obj.generatedAt === "string") out.generatedAt = obj.generatedAt;
    }
  } catch {
    /* no report → empty panel, honest zeros */
  }

  // FIX-368: the previous released tag is RECONCILED from reality (the
  // second-newest v* git tag / CHANGELOG section), not read from the
  // `release:gate` event stream that the current release flow no longer
  // refreshes. The event stream is a last-resort fallback.
  const reconciled = releaseReader !== undefined ? reconcileReleaseForProject(projectPath, releaseReader) : reconcileReleaseForProject(projectPath);
  if (reconciled.prevTag !== undefined) {
    out.prevTag = reconciled.prevTag;
  } else {
    try {
      const path = join(projectPath, ".roll", "loop", "events.ndjson");
      if (existsSync(path)) {
        const tags: string[] = [];
        for (const line of readFileSync(path, "utf8").split("\n")) {
          const e = parseEventLine(line);
          if (e !== null && e.type === "release:gate" && typeof e.tag === "string" && e.tag !== "" && tags.at(-1) !== e.tag) {
            tags.push(e.tag);
          }
        }
        if (tags.length >= 2) out.prevTag = tags.at(-2);
      }
    } catch {
      /* best-effort */
    }
  }
  return out;
}
