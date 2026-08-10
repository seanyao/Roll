/**
 * @responsibility Plans the `roll archive migrate` layout migration without mutating the filesystem.
 */
/**
 * US-META-002a — `roll archive migrate` planner (pure-ish: reads FS, mutates nothing).
 *
 * Migrates the legacy run-store (`.roll/verification/<ID>/`) into the card-folder
 * layout (`.roll/features/<epic>/<ID>/`) introduced by US-META-001. The epic is
 * resolved from the authoritative `.roll/index.json` (then a live walk, then the
 * `uncategorized` fallback — never blocks). Per the migration manifest §2:
 *   - each kept run dir   → git mv into the card folder (history preserved)
 *   - `report.html`       → renamed to `<ID>-report.html` (reportFileName)
 *   - card-level files    → ac-map.json / evidence/ / screenshots/ moved as-is
 *   - `latest` symlink    → dropped from the old tree, rebuilt in the card folder
 *   - GC pre-clean        → old surplus runs are deleted (not moved) before the move
 *
 * Non-card entries under `verification/` (e.g. `loop-autorun-verification.md`) are
 * EXEMPT — left in place and reported, never treated as a card (manifest §1).
 *
 * The planner inspects current on-disk state and emits ONLY the ops that still
 * need doing, so a re-run after a partial/interrupted migration converges (the
 * plan shrinks to empty once everything has landed) — this is the re-entrancy
 * guarantee. The command (archive-migrate.ts) executes the ops via `git mv`.
 */
import { archiveGcVerdict, type ArchiveRun } from "@roll/core";
import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { UNCATEGORIZED, epicForStory, reportFileName } from "./archive.js";

/** run-id dir name: `YYYY-MM-DDThh-mm-ss` (attest's run lifecycle). */
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

/** A single migration step. Paths are relative to the project root (for git mv
 *  from the project cwd + clean dry-run display); symlink target is a run-id. */
export type MigrateOp =
  | { kind: "mv"; src: string; dst: string }
  | { kind: "gc-rm"; path: string }
  | { kind: "symlink"; link: string; target: string }
  | { kind: "rmdir"; path: string };

export interface CardMigratePlan {
  storyId: string;
  epic: string;
  legacyDir: string; // .roll/verification/<ID>
  cardDir: string; // .roll/features/<epic>/<ID>
  ops: MigrateOp[];
}

/** A legacy item whose destination ALREADY exists — never overwritten or
 *  silently dropped; surfaced so the operator can reconcile it by hand
 *  (manifest §0: dry-run-first + human review). */
export interface MigrateConflict {
  storyId: string;
  /** The legacy path left in place (relative to project root). */
  path: string;
  reason: string;
}

export interface ArchiveMigratePlan {
  cards: CardMigratePlan[];
  /** Non-card entries under verification/ left untouched (manifest §1). */
  exempt: string[];
  /** Collisions where the destination already exists; left for manual review. */
  conflicts: MigrateConflict[];
}

export interface MigratePlanOptions {
  keepLatest: number;
  keepDays: number;
  nowSec: number;
}

/** Run dirs directly under a legacy story dir (skips `latest` + non-run files). */
function runsInDir(absDir: string): ArchiveRun[] {
  const out: ArchiveRun[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !RUN_ID_RE.test(e.name)) continue;
    try {
      out.push({ runId: e.name, mtimeSec: Math.floor(statSync(join(absDir, e.name)).mtimeMs / 1000) });
    } catch {
      /* unreadable run: skip */
    }
  }
  return out;
}

/** Entries under a legacy story dir that are neither run dirs nor `latest` —
 *  the card-level deliverables (ac-map.json, evidence/, screenshots/, …). */
function cardLevelEntries(absDir: string): string[] {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.name !== "latest" && !(e.isDirectory() && RUN_ID_RE.test(e.name)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Read a symlink's target (basename form), or null when absent / not a link. */
function symlinkTarget(absLink: string): string | null {
  try {
    return readlinkSync(absLink);
  } catch {
    return null;
  }
}

/**
 * Build the migration plan for a project. Reads `.roll/verification/`, resolves
 * each card's epic, applies the GC verdict, and emits the still-pending ops.
 */
export function buildArchiveMigratePlan(projectPath: string, opts: MigratePlanOptions): ArchiveMigratePlan {
  const verRoot = join(projectPath, ".roll", "verification");
  const cards: CardMigratePlan[] = [];
  const exempt: string[] = [];
  const conflicts: MigrateConflict[] = [];
  if (!existsSync(verRoot)) return { cards, exempt, conflicts };

  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(verRoot, { withFileTypes: true });
  } catch {
    return { cards, exempt, conflicts };
  }

  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) {
      exempt.push(e.name); // e.g. loop-autorun-verification.md
      continue;
    }
    const storyId = e.name;
    const epic = epicForStory(projectPath, storyId) ?? UNCATEGORIZED;
    const legacyRel = join(".roll", "verification", storyId);
    const cardRel = join(".roll", "features", epic, storyId);
    const legacyAbs = join(projectPath, legacyRel);
    const cardAbs = join(projectPath, cardRel);

    const verdict = archiveGcVerdict(runsInDir(legacyAbs), opts);
    const ops: MigrateOp[] = [];

    // GC pre-clean: surplus old runs are deleted in place, never migrated.
    for (const runId of verdict.delete) {
      ops.push({ kind: "gc-rm", path: join(legacyRel, runId) });
    }

    // Move each kept run dir into the card folder + rename its report.
    for (const runId of verdict.keep) {
      const srcRun = join(legacyRel, runId);
      const dstRun = join(cardRel, runId);
      const srcRunAbs = join(projectPath, srcRun);
      const dstRunAbs = join(projectPath, dstRun);
      const srcExists = existsSync(srcRunAbs);
      const dstExists = existsSync(dstRunAbs);
      // Both present → a destination run dir already exists while the legacy copy
      // lingers. Never overwrite or silently drop it: record a conflict and leave
      // both runs in place for the operator (manifest §0 human-review premise).
      if (srcExists && dstExists) {
        conflicts.push({ storyId, path: srcRun, reason: "destination run dir already exists — legacy copy left for manual review" });
        continue;
      }
      // Dir move: only when the source still exists and the destination is free
      // (a prior partial run may have already moved it — then skip, idempotent).
      if (srcExists) {
        ops.push({ kind: "mv", src: srcRun, dst: dstRun });
      }
      // Report rename: report.html → <ID>-report.html (runs AFTER the dir move,
      // so the source is the post-move path). Skip when already renamed.
      const reportNew = reportFileName(storyId);
      const willHaveReport = existsSync(join(srcRunAbs, "report.html")) || existsSync(join(dstRunAbs, "report.html"));
      if (willHaveReport && !existsSync(join(dstRunAbs, reportNew))) {
        ops.push({ kind: "mv", src: join(dstRun, "report.html"), dst: join(dstRun, reportNew) });
      }
    }

    // Card-level deliverables: move only what is not already at the destination.
    for (const name of cardLevelEntries(legacyAbs)) {
      if (existsSync(join(cardAbs, name))) {
        // Destination already has this card-level file — surface, don't orphan.
        conflicts.push({ storyId, path: join(legacyRel, name), reason: "destination already exists — legacy copy left for manual review" });
        continue;
      }
      ops.push({ kind: "mv", src: join(legacyRel, name), dst: join(cardRel, name) });
    }

    // Rebuild `latest` in the card folder → newest kept run (verdict.keep[0] is
    // the freshest). Only emit when missing or pointing at the wrong target.
    if (verdict.keep.length > 0) {
      const newest = verdict.keep[0] as string;
      const cur = symlinkTarget(join(cardAbs, "latest"));
      if (cur !== newest) {
        ops.push({ kind: "symlink", link: join(cardRel, "latest"), target: newest });
      }
    }

    // Retire the legacy dir (drops its stale `latest` symlink, then rmdir if it
    // ends up empty). Only when it still exists.
    if (existsSync(legacyAbs)) {
      ops.push({ kind: "rmdir", path: legacyRel });
    }

    if (ops.length > 0) {
      cards.push({ storyId, epic, legacyDir: legacyRel, cardDir: cardRel, ops });
    }
  }

  return { cards, exempt, conflicts };
}

export interface PlanSummary {
  cards: number;
  runsMoved: number;
  reportsRenamed: number;
  cardFilesMoved: number;
  gcDeleted: number;
  latestRebuilt: number;
  totalOps: number;
}

/** Tally a plan into a one-glance summary (drives the dry-run / execute report). */
export function summarizePlan(plan: ArchiveMigratePlan): PlanSummary {
  const s: PlanSummary = {
    cards: plan.cards.length,
    runsMoved: 0,
    reportsRenamed: 0,
    cardFilesMoved: 0,
    gcDeleted: 0,
    latestRebuilt: 0,
    totalOps: 0,
  };
  for (const c of plan.cards) {
    for (const op of c.ops) {
      s.totalOps += 1;
      if (op.kind === "gc-rm") s.gcDeleted += 1;
      else if (op.kind === "symlink") s.latestRebuilt += 1;
      else if (op.kind === "mv") {
        if (op.dst.endsWith(reportFileName(c.storyId))) s.reportsRenamed += 1;
        else if (RUN_ID_RE.test(basenameOf(op.dst))) s.runsMoved += 1;
        else s.cardFilesMoved += 1;
      }
    }
  }
  return s;
}

function basenameOf(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
