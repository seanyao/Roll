/**
 * @responsibility Builds the skills surface from the strict audit and real invocations.
 */
/**
 * US-DOSSIER-017 / US-DOSSIER-032 — the Skills surface: the contract says how
 * work should be done; the strict audit + real invocations say how it actually
 * is. One row per skill READ FROM THE REPO DIRECTORY (no drifting hand-kept
 * catalog), grouped delivery / quality / observe / lifecycle, with usage counts
 * from review-score notes and an expandable anatomy (real file tree + audit
 * essentials + the SKILL.md hub inline; references stay pointers, never embedded).
 *
 * US-DOSSIER-032: the audit yardstick is the in-process TS port
 * (`skills-audit.ts`) — the SAME computation `roll skills audit` and the
 * canonical `scripts/audit-skills.mjs` use, so the numbers match everywhere.
 * The directory is the catalog: every skill on disk gets a row. When the audit
 * cannot run, the affected rows render an explicit `unknown` violation state
 * (and `summary.auditRan === false`); the surface never silently shows `0`
 * violations as if the audit had passed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditSkills, type SkillAuditEntry, type SkillAuditReport } from "./skills-audit.js";
import { readAllReviewScores } from "./review-score.js";

export type SkillGroup = "delivery" | "quality" | "observe" | "lifecycle";

export interface SkillFileEntry {
  path: string;
  lines: number;
  dir: boolean;
}

export interface SkillPanelRow {
  name: string;
  group: SkillGroup;
  hubLines: number;
  description: string;
  /** Audited violations; empty `[]` when the audit didn't run (see `auditKnown`). */
  violations: string[];
  /** AC4 — false when the audit could not run for this skill → render `unknown`. */
  auditKnown: boolean;
  hasGotchas: boolean;
  hasLoadTrigger: boolean;
  routeCases: { positive: number; negative: number };
  usage: number;
  files: SkillFileEntry[];
  dirPath: string;
  hubText: string;
}

export interface SkillsPanelVM {
  /** AC4 — `auditRan` false ⇒ `violations` is the string "unknown", never 0. */
  summary: { skills: number; violations: number | "unknown"; hubLines: number; auditRan: boolean };
  groups: Array<{ key: SkillGroup; rows: SkillPanelRow[] }>;
}

export interface SkillsPanelDeps {
  /** The strict-audit report (the SAME `auditSkills()` the CLI + script run);
   *  `null` ⇒ the audit could not run → rows render `unknown` (AC4). */
  audit: () => SkillAuditReport | null;
  usageCounts: () => Record<string, number>;
}

export function defaultSkillsPanelDeps(projectPath: string): SkillsPanelDeps {
  return {
    audit: () => {
      const skillsDir = join(projectPath, "skills");
      if (!existsSync(skillsDir)) return null;
      try {
        // In-process TS port — deterministic, no spawn, the ONE yardstick.
        return auditSkills({ skillsDir });
      } catch {
        return null; // audit could not run → AC4 `unknown`, never a silent 0
      }
    },
    usageCounts: () => {
      const counts: Record<string, number> = {};
      try {
        for (const e of readAllReviewScores(projectPath)) {
          if (e.skill !== "") counts[e.skill] = (counts[e.skill] ?? 0) + 1;
        }
      } catch {
        /* usage is best-effort */
      }
      return counts;
    },
  };
}

const GROUP_OF: Record<string, SkillGroup> = {
  "roll-build": "delivery",
  "roll-browse": "delivery",
  "roll-fix": "delivery",
  "roll-design": "delivery",
  "roll-idea": "delivery",
  "roll-.changelog": "delivery",
  "roll-.clarify": "delivery",
  "roll-.qa": "quality",
  "roll-.review": "quality",
  "roll-spar": "quality",
  "roll-peer": "quality",
  "roll-review-pr": "quality",
  "roll-notes": "observe",
  "roll-doctor": "observe",
  "roll-.dream": "observe",
  "roll-.echo": "observe",
  "roll-loop": "lifecycle",
  "roll-onboard": "lifecycle",
  "roll-doc-audit": "observe",
  "roll-propose": "lifecycle",
};

export function skillGroupOf(name: string): SkillGroup {
  return GROUP_OF[name] ?? "lifecycle";
}

function lineCount(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function skillFiles(dir: string): SkillFileEntry[] {
  const out: SkillFileEntry[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        const sub = join(dir, e.name);
        out.push({ path: `${e.name}/`, lines: 0, dir: true });
        try {
          for (const f of readdirSync(sub).sort()) {
            const p = join(sub, f);
            if (statSync(p).isFile()) out.push({ path: `${e.name}/${f}`, lines: lineCount(p), dir: false });
          }
        } catch {
          /* unreadable subdir */
        }
      } else if (e.isFile()) {
        out.push({ path: e.name, lines: lineCount(join(dir, e.name)), dir: false });
      }
    }
  } catch {
    /* skill dir unreadable */
  }
  return out;
}

const GROUP_ORDER: readonly SkillGroup[] = ["delivery", "quality", "observe", "lifecycle"];

/** Skill directories on disk (the catalog): a `<name>/SKILL.md` must be present. */
function skillsOnDisk(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  try {
    return readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(skillsRoot, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function collectSkillsPanel(
  projectPath: string,
  deps: SkillsPanelDeps = defaultSkillsPanelDeps(projectPath),
): SkillsPanelVM {
  const audit = deps.audit();
  const auditRan = audit !== null;
  const usage = deps.usageCounts();
  const skillsRoot = join(projectPath, "skills");
  // The directory is the catalog: iterate skills ON DISK, not the audit's list.
  // A skill the box does not carry never appears; a skill the audit skipped is
  // shown as `unknown` (auditKnown=false), never as `0` (AC1 + AC4).
  const byName = new Map<string, SkillAuditEntry>();
  for (const a of audit?.skills ?? []) byName.set(a.name, a);

  const rows: SkillPanelRow[] = skillsOnDisk(skillsRoot).map((name) => {
    const dir = join(skillsRoot, name);
    const hubPath = join(dir, "SKILL.md");
    const a = byName.get(name);
    const known = auditRan && a !== undefined;
    return {
      name,
      group: skillGroupOf(name),
      hubLines: a?.lines ?? lineCount(hubPath),
      description: a?.description ?? "",
      violations: a?.violations ?? [],
      auditKnown: known,
      hasGotchas: a?.hasGotchas === true,
      hasLoadTrigger: a?.descriptionLoadTrigger === true,
      routeCases: { positive: a?.routeCoverage.positiveCount ?? 0, negative: a?.routeCoverage.negativeCount ?? 0 },
      usage: usage[name] ?? 0,
      files: skillFiles(dir),
      dirPath: dir,
      hubText: existsSync(hubPath) ? readFileSync(hubPath, "utf8") : "",
    };
  });

  const hubLines = rows.reduce((acc, r) => acc + r.hubLines, 0);
  return {
    summary: {
      skills: rows.length,
      // AC4 — never imply a passing audit when none ran.
      violations: auditRan ? audit.summary.violations : "unknown",
      hubLines,
      auditRan,
    },
    groups: GROUP_ORDER.map((key) => ({
      key,
      rows: rows.filter((r) => r.group === key).sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name)),
    })),
  };
}
