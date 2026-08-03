/**
 * FIX-207 — the acceptance-report (attest) gate.
 *
 * Skill 10.6 ("write the verification report") was a TEXT instruction: a cycle
 * could ship a high-quality delivery and silently skip the acceptance report
 * (observed 2026-06-06, cycle 20260606-033442 — FIX-199 merged with no ac-map,
 * no report, no review-score). Same failure mode FIX-150b fixed for peer review:
 * text has no teeth. This turns the requirement into a RUNTIME MECHANISM that
 * runs in every cycle's capture step, agent-agnostic:
 *
 *   actual delivery (commits ahead, real story)  AND  no fresh acceptance report
 *     ⇒ ALERT + an `attest:gate` event in events.ndjson (auditable forever).
 *
 * HARD by default: a delivery without dense, fresh acceptance evidence is
 * BLOCKED (the capture fails so the story is not marked Done). The temporary
 * migration hook is `loop_safety.attest_gate: soft` in policy.yaml.
 *
 * Freshness contract: the report at `.roll/verification/<storyId>/latest/report.html`
 * must have been written THIS cycle (mtime ≥ cycle start). A stale report left by
 * a previous delivery of the same story does not count as evidence.
 *
 * Content floor (US-ATTEST-012): freshness alone is mere "存在性". A fresh report
 * that is an EMPTY SHELL — parseable but with zero AC sections / no ac-map (the
 * FIX-214 case, where a heading naming another card stole all the AC) — is also
 * "skipped", not "produced". A real delivery's report carries ≥1 AC + an ac-map.
 *
 * Red-assertion floor (FIX-295): a `fail` AC — a check that EXECUTED AND went
 * red — blocks the delivery unconditionally. `main` is PR-protected and always
 * green, so a red check on a cycle branch is a regression the cycle introduced,
 * never an "environmental" quirk; it cannot be waived. The honest non-execution
 * exceptions (a `blocked` AC, a machine capture skip) are NOT failures and stay
 * waivable as before.
 */
import { acForStory, parsePolicy } from "@roll/core";
import { contractDrift } from "./contract-snapshot.js";
import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cardArchiveDir, projectDataPath, reportFileName } from "../lib/archive.js";
import { hasVisualEvidenceAc } from "../lib/design-visual-evidence.js";
import { evidenceDeltaSummary, evidenceModeExemptsScreenshot, evidenceModeForSpec, parseEvaluationContract } from "../lib/evaluation-contract.js";
import { physicalTerminalFromSpecText } from "../lib/physical-terminal.js";
import { evaluateReviewScoreGate } from "../lib/review-score.js";
import { captureFailures, evidenceHealthReadouts } from "./captured-evidence.js";

export type AttestMode = "soft" | "hard";

/**
 * FIX-400 — find the newest timestamped run directory under the card archive.
 * Run dirs are named by cycleId (`YYYYMMDD-HHMMSS-<suffix>`) or ISO-ish
 * (`YYYY-MM-DDTHH…`); the `cycle-` prefix is also a known pattern. Returns
 * null when no run dirs exist (the card only has a `latest/` symlink).
 */
function findNewestRunDir(cardDir: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(cardDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { name: string; mtimeMs: number } | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^\d{8}-\d{6}-/.test(e.name) && !/^\d{4}-\d{2}-\d{2}T/.test(e.name) && !e.name.startsWith("cycle-")) continue;
    try {
      const st = statSync(join(cardDir, e.name));
      if (best === null || st.mtimeMs > best.mtimeMs) {
        best = { name: e.name, mtimeMs: st.mtimeMs };
      }
    } catch {
      /* unreadable entry — skip */
    }
  }
  return best?.name ?? null;
}

/**
 * Report path candidates — PRIMARY is the card folder's latest/ symlink
 * (`features/<epic>/<ID>/latest/<ID>-report.html`); FALLBACK is the newest
 * timestamped run directory (the executor writes the report there FIRST, and
 * the latest/ symlink is a best-effort post-write step that can silently fail).
 * The legacy `verification/<ID>/` read-compat window closed with US-META-002c.
 */
function reportCandidates(worktreeCwd: string, storyId: string, persistentCwd?: string): string[] {
  const candidates: string[] = [];
  for (const root of evidenceRoots(worktreeCwd, persistentCwd)) {
    const cardDir = cardArchiveDir(root, storyId);
    candidates.push(join(cardDir, "latest", reportFileName(storyId)));
    const newest = findNewestRunDir(cardDir);
    if (newest !== null) candidates.push(join(cardDir, newest, reportFileName(storyId)));
  }
  return candidates;
}

/**
 * FIX-1233 — the evidence roots a gate reader must consider, worktree first.
 * For in-repo .roll layouts the cycle worktree carries a PHYSICALLY SEPARATE
 * .roll checkout while attest-remediation (FIX-1230) archives the ac-map and
 * the render writes the report into the PERSISTENT tree (repoCwd) — a gate
 * that reads only the worktree tree false-negatives every such delivery as an
 * "empty shell" (intel-radar 2026-07-07: zero autonomous publishes, cycles
 * looped blocked→quarantine forever). Readers accept BOTH roots; the worktree
 * stays first so cycle-local truth wins when both exist.
 */
function evidenceRoots(worktreeCwd: string, persistentCwd?: string): string[] {
  if (persistentCwd === undefined || persistentCwd === "" || persistentCwd === worktreeCwd) return [worktreeCwd];
  return [worktreeCwd, persistentCwd];
}

/**
 * ac-map candidates — PRIMARY is the card root (`ac-map.json`); FALLBACK is
 * the newest timestamped run directory (same rationale as reportCandidates).
 */
export function acMapCandidates(worktreeCwd: string, storyId: string, persistentCwd?: string): string[] {
  const candidates: string[] = [];
  for (const root of evidenceRoots(worktreeCwd, persistentCwd)) {
    const cardDir = cardArchiveDir(root, storyId);
    candidates.push(join(cardDir, "ac-map.json"));
    const newest = findNewestRunDir(cardDir);
    if (newest !== null) candidates.push(join(cardDir, newest, "ac-map.json"));
  }
  return candidates;
}

/**
 * FIX-340 — collect EVERY epic that defines this story id, one resolved spec
 * path per epic. Within a single epic the new card layout
 * (`features/<epic>/<ID>/spec.md`) deterministically supersedes the legacy flat
 * file (`features/<epic>/<ID>.md`) — that is a migration shadow, not a conflict,
 * so it counts as ONE home. A story id that lands in TWO DIFFERENT epics is a
 * genuine collision (the US-AGENT-001 case: legacy autonomous-evolution vs the
 * active loop-engine card) — every such home is returned so the caller can
 * fail-loud instead of silently picking the alphabetical-first.
 */
export function storySpecMatches(worktreeCwd: string, storyId: string): string[] {
  const featuresDir = projectDataPath(worktreeCwd, "features");
  const matches: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(featuresDir, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const epic of entries) {
    if (!epic.isDirectory()) continue;
    const spec = join(featuresDir, epic.name, storyId, "spec.md");
    if (existsSync(spec)) {
      matches.push(spec); // card layout wins over its own legacy sibling
      continue;
    }
    const legacy = join(featuresDir, epic.name, `${storyId}.md`);
    if (existsSync(legacy)) matches.push(legacy);
  }
  return matches;
}

/**
 * FIX-340 — a story id thrown when one id resolves to MORE THAN ONE epic. roll's
 * own iron rule is "一个概念一个名": a story id must resolve to exactly ONE spec.
 * Surfacing every colliding home (not the silent alphabetical-first) is the
 * fail-loud the spec demands — the wrong-spec attest misfire becomes a clear,
 * actionable error instead of a latent data bug.
 */
export class DuplicateStoryIdError extends Error {
  constructor(
    readonly storyId: string,
    readonly matches: string[],
  ) {
    super(
      `duplicate story id ${storyId}: resolves to ${matches.length} specs — a story id MUST resolve uniquely (一个 ID 一份 spec). Disambiguate (rename/archive) one of:\n` +
        matches.map((m) => `  - ${m}`).join("\n"),
    );
    this.name = "DuplicateStoryIdError";
  }
}

/** Resolve a story's defining spec markdown — the new card layout
 *  `features/<epic>/<ID>/spec.md` first, then the legacy `features/<epic>/<ID>.md`.
 *  Exported so `roll story validate` (FIX-339 AC7) shares the EXACT spec the
 *  runtime gate reads — design self-check and the闸 then never disagree.
 *
 *  FIX-340 — FAIL-LOUD on a DUPLICATE id: when an id resolves to two different
 *  epics this THROWS {@link DuplicateStoryIdError} rather than silently returning
 *  the alphabetical-first epic's spec (the US-AGENT-001 collision that misfired
 *  the active card's attest gate). No-duplicate behavior is unchanged: a single
 *  match is returned, no match returns null. */
export function storySpecPath(worktreeCwd: string, storyId: string): string | null {
  const matches = storySpecMatches(worktreeCwd, storyId);
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new DuplicateStoryIdError(storyId, matches);
  return matches[0] ?? null;
}

/** A story id that owns more than one spec home across `.roll/features`. */
export interface DuplicateStoryId {
  id: string;
  specs: string[];
}

/** Story id syntax: US-/FIX-/REFACTOR-/IDEA-/BUG- prefix (matches STORY_ID_RE
 *  in lib/story-page, kept local so this module has no command-layer dep). */
const STORY_ID_DIR_RE = /^(US-[A-Z]+-\d+[a-z]?|FIX-\d+[a-z]?|REFACTOR-\d+[a-z]?|IDEA-\d+[a-z]?|BUG-\d+[a-z]?)$/;

/**
 * FIX-340 — the CORPUS lint: scan all of `.roll/features/**` and report every
 * story id that resolves to MORE THAN ONE spec home (the same condition
 * {@link storySpecPath} throws on, but for the WHOLE tree at once). The CI
 * check script (`scripts/lint-story-ids.mjs`) reds on a non-empty result, the
 * same drift-guard discipline as README-vs-registry / truth-field-registry.
 *
 * A story id is a card directory `features/<epic>/<ID>/` containing `spec.md`,
 * OR a legacy flat `features/<epic>/<ID>.md` whose name is a story id. The
 * card layout supersedes its OWN legacy sibling in the same epic (a migration
 * shadow, not a duplicate); only DISTINCT epic homes count as a collision.
 */
export function findDuplicateStoryIds(worktreeCwd: string): DuplicateStoryId[] {
  const featuresDir = projectDataPath(worktreeCwd, "features");
  const homes = new Map<string, string[]>(); // id -> distinct epic spec homes
  let epics: Dirent[];
  try {
    epics = readdirSync(featuresDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const epic of epics) {
    if (!epic.isDirectory()) continue;
    const epicDir = join(featuresDir, epic.name);
    let inner: Dirent[];
    try {
      inner = readdirSync(epicDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of inner) {
      let id: string | null = null;
      let spec: string | null = null;
      if (entry.isDirectory() && STORY_ID_DIR_RE.test(entry.name)) {
        const card = join(epicDir, entry.name, "spec.md");
        if (existsSync(card)) {
          id = entry.name;
          spec = card;
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const base = entry.name.slice(0, -3);
        if (STORY_ID_DIR_RE.test(base)) {
          // a legacy flat file only counts if its card sibling does NOT exist
          // (the card supersedes it in the same epic — not a collision).
          if (!existsSync(join(epicDir, base, "spec.md"))) {
            id = base;
            spec = join(epicDir, entry.name);
          }
        }
      }
      if (id === null || spec === null) continue;
      const list = homes.get(id) ?? [];
      list.push(spec);
      homes.set(id, list);
    }
  }
  const dups: DuplicateStoryId[] = [];
  for (const [id, specs] of homes) {
    if (specs.length > 1) dups.push({ id, specs: specs.sort() });
  }
  return dups.sort((a, b) => a.id.localeCompare(b.id));
}

/** A story id that appears on MORE THAN ONE backlog table row. */
export interface DuplicateBacklogStoryId {
  id: string;
  /** 1-based line numbers of every backlog row that carries this id. */
  lines: number[];
}

/** The leading-cell story-id link of a backlog table row:
 *  `| [US-FOO-1](path) | … |`. Anchored at the row start; the id must match the
 *  same syntax {@link STORY_ID_DIR_RE} accepts (US-/FIX-/REFACTOR-/IDEA-/BUG-). */
const BACKLOG_ROW_ID_RE =
  /^\|\s*\[(US-[A-Z]+-\d+[a-z]?|FIX-\d+[a-z]?|REFACTOR-\d+[a-z]?|IDEA-\d+[a-z]?|BUG-\d+[a-z]?)\]/;

/**
 * FIX-340 — the BACKLOG half of the corpus lint (the spec's "…and the backlog").
 * `.roll/backlog.md` is the single queue of record: every card is ONE row keyed
 * by its story id (`| [ID](spec) | … | status |`). Two rows sharing an id is the
 * same "一个 ID 一份卡" violation {@link findDuplicateStoryIds} guards in the
 * features tree — a stale row left beside a re-filed one, or two cards racing the
 * same id — and it makes `roll`'s "single queue, one row per id" promise a lie.
 *
 * Returns every id that owns >1 row, each with the 1-based line numbers, so the
 * CI lint (`scripts/lint-story-ids.mjs`) can red and point at the exact rows to
 * reconcile. PURE (takes the backlog text), so it is trivially unit-testable
 * without a real backlog on disk. An id is counted at most ONCE per row line
 * (a row only has one leading id cell).
 */
export function findDuplicateBacklogStoryIds(backlogText: string): DuplicateBacklogStoryId[] {
  const rows = new Map<string, number[]>(); // id -> 1-based row line numbers
  const lines = backlogText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = BACKLOG_ROW_ID_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const id = m[1] as string;
    const seen = rows.get(id) ?? [];
    seen.push(i + 1);
    rows.set(id, seen);
  }
  const dups: DuplicateBacklogStoryId[] = [];
  for (const [id, lineNos] of rows) {
    if (lineNos.length > 1) dups.push({ id, lines: lineNos });
  }
  return dups.sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether the story's spec carries an `**AC:**` checklist; null = spec not
 *  found / unreadable. Exported for the FIX-246 remediation trigger, which must
 *  share the gate's exact notion of "this delivery owes an ac-map". */
export function storyHasAcBlock(worktreeCwd: string, storyId: string): boolean | null {
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return null;
  try {
    return acForStory(readFileSync(spec, "utf8"), storyId, { fileOwned: true }).length > 0;
  } catch {
    return null;
  }
}

/**
 * FIX-309 — a captured screenshot is the BASELINE for EVERY story
 * ("能截则截，应截尽截"): the default is ALWAYS REQUIRED, regardless of surface
 * (Web/CLI/TUI/anything). Keyword/rule matching may NEVER decide whether a
 * screenshot is required — it is always required by default. The ONLY place a
 * rule may run is to identify an EXPLICIT, recorded EXEMPTION.
 *
 * This replaces the FIX-284 leak: the old keyword regex (`(CLI|web|UI|TUI)|界面…`)
 * was used as an ENABLER — a clear UI Casting redesign that happened to lack the
 * literal keywords was judged "no screenshot needed" and slipped the iron rule.
 *
 * Exemption is the ONLY rule path (see {@link screenshotExemption}):
 *   1. spec frontmatter `screenshot_exempt: <reason>` — an explicit, recorded,
 *      per-card exemption, OR
 *   2. an explicit non-visual `evidence_mode` whose spec declares no URL,
 *      terminal command, physical terminal, or visual-evidence AC, OR
 *   3. a configurable deny-list of genuinely-non-visual epics
 *      (`acceptance.screenshot_exempt_epics:` in `.roll/policy.yaml`).
 * An exemption returns false WITH the recorded reason; everything else is
 * REQUIRED. Returns true ⇒ this story owes captured visual evidence; the attest
 * render wiring drives a REAL capture for the appropriate surface (web/dossier →
 * FIX-291 ladder via {@link webCaptureTargetForStory}; CLI/TUI → the terminal
 * capture / honest machine-skip lane).
 */
export function storyRequiresScreenshot(worktreeCwd: string, storyId: string): boolean {
  return screenshotExemption(worktreeCwd, storyId).reason === undefined;
}

/**
 * FIX-309 — resolve a story's screenshot exemption. Returns the recorded
 * `reason` when (and only when) the story is EXPLICITLY exempted; `undefined`
 * reason ⇒ a screenshot is REQUIRED (the default for every story).
 *
 * Recognised exemptions are explicit and recorded:
 *   - spec frontmatter `screenshot_exempt: <reason>` (per-card), or
 *   - a declared non-visual `evidence_mode` with no visual/terminal surface, or
 *   - the story's epic appears in the policy deny-list
 *     `acceptance.screenshot_exempt_epics:` (genuinely-non-visual epics, e.g.
 *     pure data-migration).
 * No keyword/content matching is consulted — matching can only EXEMPT, never
 * enable.
 */
export function screenshotExemption(worktreeCwd: string, storyId: string): { reason?: string } {
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return {};
  let text: string;
  try {
    text = readFileSync(spec, "utf8");
  } catch {
    return {};
  }
  const modeDecision = evidenceModeForSpec(text);
  // (1) per-card explicit exemption: frontmatter `screenshot_exempt: <reason>`.
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm !== null) {
    const m = /^screenshot_exempt:\s*(.+)$/m.exec(fm[1] ?? "");
    if (m !== null) {
      const reason = stripQuotes((m[1] ?? "").trim());
      if (reason !== "" && !/^(false|no|0|true|yes|on|1)$/i.test(reason)) {
        return { reason: `screenshot_exempt (spec): ${reason}; evidence_mode=${modeDecision.mode}` };
      }
    }
  }
  if (evidenceModeExemptsScreenshot(text, modeDecision)) {
    return { reason: `evidence_mode (${modeDecision.source}): ${modeDecision.mode} matrix does not require screenshots` };
  }
  // (2) epic deny-list exemption: this story's epic is recorded as non-visual.
  const epic = epicForSpec(spec);
  if (epic !== null) {
    const denied = screenshotExemptEpics(worktreeCwd);
    if (denied.includes(epic)) {
      return { reason: `screenshot_exempt_epics (policy): epic "${epic}" is a recorded non-visual epic` };
    }
  }
  return {};
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** The epic directory name a spec lives under (`features/<epic>/<ID>/spec.md`). */
function epicForSpec(specPath: string): string | null {
  // …/features/<epic>/<ID>/spec.md  OR  …/features/<epic>/<ID>.md
  const parts = specPath.split(/[\\/]/);
  const fi = parts.lastIndexOf("features");
  if (fi === -1 || fi + 1 >= parts.length) return null;
  return parts[fi + 1] ?? null;
}

/**
 * FIX-309 — the configurable deny-list of genuinely-non-visual epics, read from
 * `.roll/policy.yaml` under `acceptance.screenshot_exempt_epics:` (a YAML list).
 * Absent / unreadable ⇒ empty (nothing exempted by epic). This is the ONLY
 * place a configurable rule influences the screenshot requirement, and it can
 * only EXEMPT, never enable.
 */
export function screenshotExemptEpics(worktreeCwd: string): string[] {
  try {
    const p = projectDataPath(worktreeCwd, "policy.yaml");
    if (!existsSync(p)) return [];
    return parseScreenshotExemptEpics(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

/** Parse `acceptance.screenshot_exempt_epics:` — a block or inline YAML list. */
function parseScreenshotExemptEpics(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let inAcceptance = false;
  let inList = false;
  let listIndent = 0;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (/^acceptance:\s*$/.test(line)) {
      inAcceptance = true;
      inList = false;
      continue;
    }
    if (inAcceptance) {
      // inline form: `  screenshot_exempt_epics: [a, b]`
      const inline = /^\s+screenshot_exempt_epics:\s*\[(.*)\]\s*$/.exec(line);
      if (inline !== null) {
        for (const tok of (inline[1] ?? "").split(",")) {
          const v = stripQuotes(tok.trim());
          if (v !== "") out.push(v);
        }
        inList = false;
        continue;
      }
      // block form: `  screenshot_exempt_epics:` then `    - epic`
      const blockHead = /^(\s+)screenshot_exempt_epics:\s*$/.exec(line);
      if (blockHead !== null) {
        inList = true;
        listIndent = (blockHead[1] ?? "").length;
        continue;
      }
      if (inList) {
        const item = /^(\s+)-\s*(.+?)\s*$/.exec(line);
        if (item !== null && (item[1] ?? "").length > listIndent) {
          out.push(stripQuotes((item[2] ?? "").trim()));
          continue;
        }
        // a non-indented / sibling key ends the list
        if (line.trim() !== "" && !/^\s+-/.test(line)) inList = false;
      }
      // a top-level key (no leading space) ends the acceptance block
      if (/^\S/.test(line) && !/^acceptance:/.test(line)) {
        inAcceptance = false;
        inList = false;
      }
    }
  }
  return out.filter((v) => v !== "");
}

/**
 * FIX-321 — the DELIVERABLE web surface a card's attest should screenshot. The
 * screenshot must prove the thing the card delivers (the Casting page, a rendered
 * product view, …), NEVER the card's own dossier/report page — that is
 * self-referential, identical for every card, and proves nothing (the "screenshot
 * forgery" defect: every card's web.png was byte-identical, a shot of its own
 * STORY DOSSIER page). The dossier fallback is DELETED.
 *
 * Precedence: env override (`ROLL_ATTEST_WEB_URL` / a Gate-set deploy url) >
 * the card's DECLARED `deliverable_url` (frontmatter; alias `screenshot_url`) >
 * NULL. http(s) ⇒ a deployed surface; a relative path ⇒ a built artifact under
 * the worktree (file://); the literal `dossier` is an explicit opt-in for the rare
 * card whose deliverable genuinely IS its dossier page. When nothing is declared,
 * returns null — the caller records an HONEST web-capture skip (taken:false) so
 * the visual floor stays satisfiable (hasMachineCaptureSkip) without a hollow
 * filler; the screenshot baseline is then owed via a declared target, never faked.
 * Returns null too when the story is exempt (no captured evidence owed at all).
 * NOTE: terminal/TUI deliverables ride the separate capture.fromMarker lane —
 * deliverable_url is web-only; never force a web url onto a terminal card.
 */
export function deliverableUrlForStory(worktreeCwd: string, storyId: string): string | null {
  const all = deliverableUrlsForStory(worktreeCwd, storyId);
  return all.length === 0 ? null : (all[0] as string);
}

/**
 * FIX-339 (AC1) — the FULL list of DECLARED deliverable web surfaces. A card may
 * legitimately ship more than one user-visible web view (e.g. a Casting tab AND
 * a Review tab), and the attest must capture EACH. Parses the frontmatter
 * `deliverable_url:` / `screenshot_url:` in three shapes, all backward-compatible:
 *   - single scalar           `deliverable_url: https://app/x`        → ["https://app/x"]
 *   - inline list             `deliverable_url: [a, b]`               → ["a", "b"]
 *   - comma-separated scalar  `deliverable_url: a, b`                 → ["a", "b"]
 *   - YAML block list         `deliverable_url:\n  - a\n  - b`        → ["a", "b"]
 * A single value is returned as a one-element list, so every legacy single-url
 * card behaves EXACTLY as before. Empty / absent ⇒ []. Order is preserved and
 * duplicates are de-duped (stable).
 */
export function deliverableUrlsForStory(worktreeCwd: string, storyId: string): string[] {
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return [];
  let text: string;
  try {
    text = readFileSync(spec, "utf8");
  } catch {
    return [];
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm === null) return [];
  // deliverable_url keeps comma-splitting: a url never contains a comma, so a
  // comma-separated scalar (`a, b`) is an unambiguous two-url list.
  return parseFrontmatterListField(fm[1] ?? "", /^(?:deliverable_url|screenshot_url):/, { commaSplit: true });
}

/**
 * FIX-339 (AC2) — the DECLARED deliverable CLI commands, after the
 * roll-only allowlist filter (see {@link allowedDeliverableCmd}). A card whose
 * deliverable is a command's terminal output (a CLI surface) declares
 * `deliverable_cmd:` in the frontmatter; the attest runs EACH command in the
 * worktree and captures its terminal output. Two parse shapes (NO comma split):
 *   - single scalar     `deliverable_cmd: roll status --fmt a,b`  → one command
 *   - YAML block list    `deliverable_cmd:\n  - roll status\n  - roll cycles`
 * A scalar is the WHOLE line (one command) — never comma-split, because a
 * command line legitimately carries commas (flag lists / JSON args, e.g.
 * `roll status --fmt a,b`). Empty / absent ⇒ [].
 *
 * SECURITY (FIX-339 复核): a spec is written by the autonomous loop's own cycle
 * agent, so an unfiltered `deliverable_cmd` would be agent-controlled ARBITRARY
 * command execution (the whole line runs verbatim under `sh -lc`). This getter
 * therefore returns ONLY commands that pass {@link allowedDeliverableCmd} — the
 * roll read-only allowlist. A rejected command is DROPPED here (it never runs)
 * and surfaced separately by {@link rejectedDeliverableCmdsForStory} so the gate
 * can FAIL loudly rather than silently honest-skip.
 */
export function deliverableCmdsForStory(worktreeCwd: string, storyId: string): string[] {
  return rawDeliverableCmdsForStory(worktreeCwd, storyId).filter(allowedDeliverableCmd);
}

/**
 * FIX-339 (AC2 复核) — the DECLARED deliverable_cmd entries that the roll-only
 * allowlist REJECTS (a non-roll command, or a state-changing/release roll
 * subcommand). Non-empty ⇒ the spec asked the attest to run something it must
 * not; the gate fails loud (these are never silently skipped).
 */
export function rejectedDeliverableCmdsForStory(worktreeCwd: string, storyId: string): string[] {
  return rawDeliverableCmdsForStory(worktreeCwd, storyId).filter((c) => !allowedDeliverableCmd(c));
}

/** Unfiltered deliverable_cmd parse (scalar = whole line, block list = per item; NO comma split). */
function rawDeliverableCmdsForStory(worktreeCwd: string, storyId: string): string[] {
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return [];
  let text: string;
  try {
    text = readFileSync(spec, "utf8");
  } catch {
    return [];
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm === null) return [];
  return parseFrontmatterListField(fm[1] ?? "", /^deliverable_cmd:/, { commaSplit: false });
}

/**
 * FIX-339 (复核 #1) — the deliverable_cmd security policy. A spec is authored by
 * the autonomous loop's own cycle agent, so `deliverable_cmd` is AGENT-CONTROLLED
 * input that the attest lane runs verbatim under `sh -lc`. Without a gate this is
 * arbitrary command execution. Two rules, both must pass:
 *
 *   (1) ALLOWLIST — the command's first token MUST invoke THIS project's own
 *       `roll` CLI: bare `roll`, `./bin/roll.js`, `bin/roll.js`, or a
 *       `node …/roll(.js)` / `node …/bin/roll.js` form. ANY other command
 *       (`rm`, `curl`, `git push`, a bare script, a pipeline, …) is rejected —
 *       deliverable_cmd is for read-only roll demos only, never arbitrary shell.
 *   (2) DENYLIST — even a roll command must be READ-ONLY: the mutating /
 *       releasing subcommands below are rejected (they change state, publish, or
 *       reconfigure the loop, and have no place in an acceptance demo).
 *
 * The allowlist/denylist are deliberately CONSTANTS here; a later card can lift
 * them into `.roll/policy.yaml` (see {@link DELIVERABLE_CMD_DENY_SUBCOMMANDS}).
 * Exported for direct unit testing.
 */
export function allowedDeliverableCmd(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return false;
  // No shell metacharacters that could chain/echo a second command — a single
  // `roll …` invocation only. (`,` is allowed: it appears in flag values.)
  if (/[;&|`$<>(){}]|\|\||&&/.test(command)) return false;
  const first = tokens[0] ?? "";
  // (1) allowlist — the first token must be the roll CLI itself.
  let subIdx: number;
  if (first === "roll" || /^(?:\.\/)?(?:.*\/)?bin\/roll\.js$/.test(first) || /^(?:.*\/)?roll(?:\.js)?$/.test(first)) {
    subIdx = 1;
  } else if (first === "node") {
    // node <…/roll.js | …/bin/roll.js> <subcommand> …
    const target = tokens[1] ?? "";
    if (!/^(?:.*\/)?(?:bin\/)?roll\.js$/.test(target) && !/^(?:.*\/)?roll(?:\.js)?$/.test(target)) return false;
    subIdx = 2;
  } else {
    return false;
  }
  // (2) denylist — reject state-changing / releasing roll subcommands.
  const sub = (tokens[subIdx] ?? "").toLowerCase();
  if (sub === "") return true; // bare `roll` (prints help) — harmless read-only.
  if (sub === "agent" && (tokens[subIdx + 1] ?? "").toLowerCase() === "list") {
    // `roll agent list` is read-only — allowed for acceptance demos.
    return true;
  }
  if (sub === "init") {
    const tail = tokens.slice(subIdx + 1);
    if (tail.join(" ") === "--diagnose --fixture state-matrix") return true;
    return tail.length === 2 && tail[0] === "--attest-smoke" && /^[A-Za-z0-9_.-]+$/.test(tail[1] ?? "");
  }
  if (DELIVERABLE_CMD_DENY_SUBCOMMANDS.has(sub)) return false;
  return true;
}

/**
 * FIX-339 (复核 #1) — roll subcommands a deliverable_cmd may NOT invoke. These
 * change state / publish / reconfigure the loop, so they have no place in an
 * acceptance demo (which should be read-only, e.g. `roll pulse` / `roll status`
 * / `roll cycles`). 后续可挪 policy.yaml.
 */
const DELIVERABLE_CMD_DENY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "release",
  "init",
  "loop", // on/off/go/… — operate the loop
  "story",
  "idea",
  "agent", // write subcommands (disable/enable/use) are state-changing; `agent list` is exempt (read-only)
  "pair",
  "attest", // re-render evidence — never from within an attest demo
  "fix",
  "build",
  "design",
  "propose",
]);

/**
 * Parse a frontmatter field that may be a scalar, an inline `[a, b]` list, or a
 * YAML block list. `keyRe` matches the `key:` prefix on a frontmatter line
 * (anchored at column 0). De-dupes while keeping first-seen order.
 *
 * `commaSplit` controls how a bare scalar is interpreted:
 *   - `true`  (deliverable_url): a scalar may be comma-separated (`a, b` → two
 *             values). Safe for URLs — a url never contains a comma.
 *   - `false` (deliverable_cmd): a scalar is the WHOLE line (one command). A
 *             command line legitimately carries commas (flag lists / JSON args,
 *             e.g. `roll status --fmt a,b`), so splitting on commas would shred
 *             a single command into bogus fragments. Multiple commands use the
 *             YAML block-list form (one `-` per line).
 * The inline `[a, b]` form always splits on commas (it is an explicit list).
 */
function parseFrontmatterListField(fmBody: string, keyRe: RegExp, opts: { commaSplit: boolean }): string[] {
  const lines = fmBody.split(/\r?\n/);
  const out: string[] = [];
  const push = (raw: string): void => {
    const v = stripQuotes(raw.trim());
    if (v !== "" && !out.includes(v)) out.push(v);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const head = keyRe.exec(line);
    if (head === null) continue;
    const rest = line.slice(head[0].length).trim();
    // inline list: key: [a, b] — an explicit list always splits on commas.
    const inline = /^\[(.*)\]$/.exec(rest);
    if (inline !== null) {
      for (const tok of (inline[1] ?? "").split(",")) push(tok);
      continue;
    }
    if (rest !== "") {
      // scalar — comma-split only when the caller opts in (url), else whole line (cmd).
      if (opts.commaSplit) for (const tok of rest.split(",")) push(tok);
      else push(rest);
      continue;
    }
    // block list: key:\n  - a\n  - b  (consume following `-` item lines)
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^(\s+)-\s*(.+?)\s*$/.exec(lines[j] ?? "");
      if (item === null) {
        // a non-list line ends the block (unless it is blank)
        if ((lines[j] ?? "").trim() === "") continue;
        break;
      }
      push(item[2] ?? "");
    }
  }
  return out;
}

/**
 * FIX-339 (AC1) — one web capture target per DECLARED deliverable_url. An env
 * override (a single deploy url) collapses to one target (it points at the live
 * deploy, which is the one surface the deploy proves). With no override, every
 * declared url is resolved through the same FIX-321 rules (http(s)/file as-is,
 * `dossier` opt-in, relative → file:// with #fragment deep-link). Exempt ⇒ [].
 */
export function webCaptureTargetsForStory(worktreeCwd: string, storyId: string, override?: string): string[] {
  if (!storyRequiresScreenshot(worktreeCwd, storyId)) return []; // exempt → no web capture owed
  const trimmed = (override ?? "").trim();
  if (trimmed !== "") return [trimmed]; // env / deploy override wins (single live surface)
  return deliverableUrlsForStory(worktreeCwd, storyId).map((u) => resolveWebTarget(worktreeCwd, storyId, u));
}

/** Back-compat single-target resolver — first declared surface, or null. */
export function webCaptureTargetForStory(worktreeCwd: string, storyId: string, override?: string): string | null {
  const all = webCaptureTargetsForStory(worktreeCwd, storyId, override);
  return all.length === 0 ? null : (all[0] as string);
}

function resolveWebTarget(worktreeCwd: string, storyId: string, declared: string): string {
  if (declared === "dossier") return pathToFileURL(join(cardArchiveDir(worktreeCwd, storyId), "index.html")).href;
  if (/^(?:https?|file):\/\//i.test(declared)) return declared;
  // relative → a built artifact under the worktree. FIX-321b: split a trailing
  // #fragment BEFORE join (else pathToFileURL encodes the "#" into the filename),
  // then re-append it to the file:// URL — so `features/index.html#casting`
  // deep-links the console's Casting tab (the console routes on location.hash),
  // capturing the actual deliverable view, not the default tab.
  const hashIdx = declared.indexOf("#");
  const relPath = hashIdx >= 0 ? declared.slice(0, hashIdx) : declared;
  const fragment = hashIdx >= 0 ? declared.slice(hashIdx) : "";
  return pathToFileURL(join(worktreeCwd, relPath)).href + fragment;
}

/**
 * FIX-339 (AC6) — does the spec DECLARE ANY visual surface? True iff it has a
 * `deliverable_url`/`screenshot_url`, a `deliverable_cmd`, OR a recorded
 * `screenshot_exempt: <reason>`. PURE (takes spec text), agent-agnostic, used by
 * the build preflight to WARN (this round only — no hard block) when a non-exempt
 * card declares none of the three. Mirrors the runtime gate's frontmatter reads.
 */
export function declaresAnySurface(specText: string): boolean {
  const fm = /^---\n([\s\S]*?)\n---/.exec(specText);
  if (fm === null) return false;
  const body = fm[1] ?? "";
  if (parseFrontmatterListField(body, /^(?:deliverable_url|screenshot_url):/, { commaSplit: true }).length > 0) return true;
  // A declared deliverable_cmd counts as a surface even if the allowlist would
  // later reject it — the card DID declare an intent to demo a CLI surface; the
  // reject path fails loud at the gate, not here.
  if (parseFrontmatterListField(body, /^deliverable_cmd:/, { commaSplit: false }).length > 0) return true;
  if (physicalTerminalFromSpecText(specText) !== null) return true;
  const ex = /^screenshot_exempt:\s*(.+)$/m.exec(body);
  if (ex !== null) {
    const reason = stripQuotes((ex[1] ?? "").trim());
    if (reason !== "" && !/^(false|no|0|true|yes|on|1)$/i.test(reason)) return true;
  }
  return false;
}

/**
 * FIX-339 (AC6) / REFACTOR-076 — the must-declare diagnostic predicate. A
 * delivery VIOLATES must-declare iff it is a story that owes acceptance evidence
 * yet declares NO deliverable surface AT ALL:
 *
 *   non-exempt (epic-aware {@link screenshotExemption})  AND
 *   {@link declaresAnySurface}(spec) === false  (no deliverable_url / deliverable_cmd / screenshot_exempt)
 *
 * FIX-933: a card whose ACs carry NO visual-evidence item (no screenshot, no
 * terminal capture, no [visual-evidence] marker) is a pure back-end card — it has
 * nothing to capture visually. By construction it can never owe a deliverable
 * surface declaration; its evidence is text-only by nature. It returns false here
 * so the attest gate never blocks a text-only back-end delivery for lacking a
 * visual surface it could not produce.
 *
 * STRUCTURAL, never a classifier guess: it reads ONLY the recorded frontmatter +
 * the policy epic deny-list, exactly the surfaces the runtime capture lanes read.
 * A card that declared any url/cmd, or that is exempt (per-card OR epic), or that
 * has NO visual-evidence AC (pure back-end), returns false here — the owner red
 * line (误杀 exempt / back-end / declared cards = 阻断 loop) is honoured by
 * construction.
 *
 * Used only as a diagnostic signal after REFACTOR-076; it does not decide attest
 * control flow. Returns false on any read blip. Exported for direct unit testing
 * + `roll story validate`.
 */
export function violatesMustDeclareSurface(worktreeCwd: string, storyId: string): boolean {
  if (screenshotExemption(worktreeCwd, storyId).reason !== undefined) return false; // exempt → owes nothing
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return false;
  let text: string;
  try {
    text = readFileSync(spec, "utf8");
  } catch {
    return false;
  }
  // FIX-933: a card whose ACs carry no visual-evidence item has no surface to
  // capture — it is a pure back-end card and never owes a deliverable surface
  // declaration (deliverable_url / deliverable_cmd / screenshot_exempt).
  if (!hasVisualEvidenceAc(text)) return false;
  return !declaresAnySurface(text);
}

/** FIX-339 (AC6) / REFACTOR-076 — the canonical must-declare diagnostic reason
 *  shared by runtime diagnostics and `roll story validate`. */
export const MUST_DECLARE_FAIL_REASON =
  "no deliverable surface declared — 必须声明 deliverable_url/deliverable_cmd 或 screenshot_exempt";

interface AcMapEvidence {
  kind?: string;
  href?: string;
  textFile?: string;
}

interface AcMapEntry {
  ac?: string;
  status?: string;
  evidence?: AcMapEvidence[];
}

interface EvidenceManifestLike {
  screenshots?: unknown;
  captures?: unknown;
}

function readAcMap(worktreeCwd: string, storyId: string, persistentCwd?: string): { path: string; entries: AcMapEntry[] } | null {
  // US-V4-001: read whichever ac-map.json candidate exists (card root first, then
  // the newest run dir) so the structured-truth gate works regardless of which
  // story-scoped location the skill wrote it to.
  for (const path of acMapCandidates(worktreeCwd, storyId, persistentCwd)) {
    if (path === undefined || !existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed)) return { path, entries: parsed.filter((x) => typeof x === "object" && x !== null) as AcMapEntry[] };
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function readAcMapEntries(worktreeCwd: string, storyId: string, persistentCwd?: string): AcMapEntry[] | null {
  return readAcMap(worktreeCwd, storyId, persistentCwd)?.entries ?? null;
}

function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

function githubSlugFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (https !== null) return `${https[1]}/${https[2]}`;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

function originGithubSlug(worktreeCwd: string): string | null {
  try {
    return githubSlugFromRemoteUrl(execFileSync("git", ["remote", "get-url", "origin"], { cwd: worktreeCwd, encoding: "utf8" }));
  } catch {
    return null;
  }
}

function githubEvidenceUrlAllowed(worktreeCwd: string, ref: string): boolean {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
  const slug = originGithubSlug(worktreeCwd);
  if (slug === null) return false;
  const [owner, repo, kind, tail] = url.pathname.split("/").filter((part) => part !== "");
  if (owner === undefined || repo === undefined || kind === undefined || tail === undefined) return false;
  if (`${owner}/${repo}` !== slug) return false;
  return kind === "pull" || kind === "commit" || kind === "checks";
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function evidenceRefResolves(worktreeCwd: string, storyId: string, ref: string, persistentCwd?: string): boolean {
  if (ref === "") return false;
  if (isHttpUrl(ref)) return githubEvidenceUrlAllowed(worktreeCwd, ref);
  if (/^[a-z]+:/i.test(ref) || isAbsolute(ref)) return false;
  const roots = evidenceRoots(worktreeCwd, persistentCwd);
  const report = existingReport(worktreeCwd, storyId, persistentCwd);
  const bases: string[] = [];
  for (const root of roots) {
    const cardDir = cardArchiveDir(root, storyId);
    if (report === null) bases.push(join(cardDir, "latest"));
    bases.push(cardDir);
  }
  if (report !== null) bases.unshift(dirname(report));
  for (const base of bases) {
    const refs = /^\.\.\/(?:evidence|screenshots)\//.test(ref) ? [ref, ref.slice(3)] : [ref];
    for (const candidateRef of refs) {
      const candidate = resolve(base, candidateRef);
      // FIX-1233: evidence may live in EITHER tree (worktree or persistent .roll).
      if (!roots.some((root) => inside(root, candidate))) continue;
      try {
        if (statSync(candidate).isFile()) return true;
      } catch {
        /* try next base */
      }
    }
  }
  return false;
}

export function evidencePathsUnresolved(worktreeCwd: string, storyId: string, persistentCwd?: string): string[] {
  const acMap = readAcMap(worktreeCwd, storyId, persistentCwd);
  if (acMap === null) return [];
  const missing: string[] = [];
  for (const entry of acMap.entries) {
    for (const ev of entry.evidence ?? []) {
      for (const ref of [ev.textFile, ev.href]) {
        if (typeof ref !== "string") continue;
        if (!evidenceRefResolves(worktreeCwd, storyId, ref, persistentCwd)) missing.push(`${entry.ac ?? "?"} ${ref}`);
      }
    }
  }
  return missing;
}

/**
 * US-V4-001 — whether an ac-map evidence entry would render as REAL evidence in
 * the report. Mirrors the renderer's `toRef` contract (attest.ts) exactly: text
 * needs a `textFile`, cast/video need an `href`, and screenshot/commit/ci/deploy/
 * test-pass are evidence on their own. The gate reads this STRUCTURED fact rather
 * than scanning the rendered HTML for `class="ev"` / `class="shot"`.
 */
function acMapEvidenceIsReal(ev: AcMapEvidence): boolean {
  const kind = ev.kind ?? "";
  if (kind === "text") return typeof ev.textFile === "string" && ev.textFile !== "";
  if (kind === "cast" || kind === "video") return typeof ev.href === "string" && ev.href !== "";
  return ["screenshot", "commit", "ci", "deploy", "test-pass"].includes(kind);
}

/**
 * US-V4-001 — structured visual-evidence signal (replaces scanning the rendered
 * report HTML for `screenshots/` references). The report shows a screenshot iff
 * ANY of these structured sources is present: an ac-map screenshot evidence ref,
 * a real `taken:true` capture in evidence.json, or an actual image file under the
 * report's run-dir `screenshots/`. No HTML is parsed.
 */
function hasRenderedVisualEvidence(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  const entries = readAcMapEntries(worktreeCwd, storyId, persistentCwd) ?? [];
  if (
    entries.some((e) =>
      (e.evidence ?? []).some((ev) => ev.kind === "screenshot" && typeof ev.href === "string" && ev.href !== ""),
    )
  ) {
    return true;
  }
  const manifest = evidenceManifest(worktreeCwd, storyId, persistentCwd);
  if (
    manifest !== null &&
    Array.isArray(manifest.captures) &&
    manifest.captures.some((raw) => typeof raw === "object" && raw !== null && (raw as Record<string, unknown>)["taken"] === true)
  ) {
    return true;
  }
  const report = existingReport(worktreeCwd, storyId, persistentCwd);
  if (report !== null) {
    try {
      if (readdirSync(join(dirname(report), "screenshots")).some((f) => /\.(png|jpe?g|webp)$/i.test(f))) return true;
    } catch {
      /* no screenshots dir under the run dir */
    }
  }
  return false;
}

/**
 * US-SKILL-030 — design-contract-vs-delivered evidence mapping for the attest report.
 * Reads the story's `**Evaluation contract:**` block (if present) and the
 * ac-map entries, then returns a human-readable delta summary showing which
 * design contract evidence items were satisfied, changed, or missing.
 *
 * Returns "" when the story has no evaluation contract (legacy specs — no
 * behavior change).
 */
export function designContractDeliveredEvidence(worktreeCwd: string, storyId: string): string {
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return "";
  let text: string;
  try {
    text = readFileSync(spec, "utf8");
  } catch {
    return "";
  }
  const contract = parseEvaluationContract(text);
  if (contract === null) return "";
  const acMap = readAcMapEntries(worktreeCwd, storyId) ?? [];
  return evidenceDeltaSummary(contract, acMap);
}

function evidenceManifest(worktreeCwd: string, storyId: string, persistentCwd?: string): EvidenceManifestLike | null {
  const report = existingReport(worktreeCwd, storyId, persistentCwd);
  if (report === null) return null;
  const path = join(dirname(report), "evidence.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as EvidenceManifestLike) : null;
  } catch {
    return null;
  }
}

function hasMachineCaptureSkip(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  const manifest = evidenceManifest(worktreeCwd, storyId, persistentCwd);
  if (manifest === null || !Array.isArray(manifest.captures)) return false;
  return manifest.captures.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const row = raw as Record<string, unknown>;
    return row["taken"] === false && typeof row["skipped"] === "string" && row["skipped"] !== "";
  });
}

/**
 * FIX-309 (堵 284 洞①) — whether this delivery OWES a REAL web capture, i.e. an
 * honest machine-skip can NO LONGER satisfy its visual floor. True iff the story
 * is non-exempt (`storyRequiresScreenshot`) AND it DECLARED a `deliverable_url`
 * (alias `screenshot_url`) — a concrete, technically-captureable web surface.
 *
 * The FIX-284 leak this closes: a card that DECLARED a deliverable surface but
 * whose capture errored / was skipped (`{kind:"web",taken:false,skipped}`) used
 * to pass via {@link hasMachineCaptureSkip} — "声明了 url 却从没真截也能过". Once a
 * surface is declared, only a REAL capture (`taken:true`) discharges it; an
 * honest-skip is reserved for "确实无可视面 + 记录化豁免" (an EXEMPT card, or a
 * required card with NO declared web target — e.g. a TUI/terminal deliverable
 * riding the separate terminal-capture lane).
 */
function owesRealWebCapture(worktreeCwd: string, storyId: string): boolean {
  return storyRequiresScreenshot(worktreeCwd, storyId) && deliverableUrlsForStory(worktreeCwd, storyId).length > 0;
}

/**
 * FIX-339 (AC2/AC3) — whether this delivery OWES a REAL terminal capture: a
 * non-exempt card that DECLARED ≥1 `deliverable_cmd`. Each declared command is a
 * concrete CLI surface that must be really run + captured; an honest terminal
 * skip no longer discharges a declared command.
 */
function owesTerminalCapture(worktreeCwd: string, storyId: string): boolean {
  return storyRequiresScreenshot(worktreeCwd, storyId) && deliverableCmdsForStory(worktreeCwd, storyId).length > 0;
}

/** Count the REAL, taken captures of a given kind in the evidence manifest. */
function takenCaptureCount(worktreeCwd: string, storyId: string, kind: string, persistentCwd?: string): number {
  const manifest = evidenceManifest(worktreeCwd, storyId, persistentCwd);
  if (manifest === null || !Array.isArray(manifest.captures)) return 0;
  return manifest.captures.filter((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const row = raw as Record<string, unknown>;
    return row["kind"] === kind && row["taken"] === true;
  }).length;
}

/**
 * FIX-339 (复核 #3) — when a deploy/env override (`ROLL_ATTEST_WEB_URL` or a
 * Gate-set deploy url) is in effect, the web capture lane collapses to ONE
 * target (the single live deploy proves one active surface — see
 * {@link webCaptureTargetsForStory}). So the gate must require only ONE taken
 * web shot, not N. Without this a multi-url card under an override would demand
 * N shots while the lane only ever produced 1 → permanent false FAIL.
 */
function webCaptureNeed(worktreeCwd: string, storyId: string): number {
  const override = (process.env["ROLL_ATTEST_WEB_URL"] ?? "").trim();
  if (override !== "") return 1; // override collapses to a single live-deploy shot
  const declared = deliverableUrlsForStory(worktreeCwd, storyId).length;
  return declared === 0 ? 1 : declared; // owesRealWebCapture guarantees ≥1 when called
}

/**
 * FIX-309 + FIX-339 (AC1) — EVERY declared web surface is REALLY captured.
 * A card that declares N deliverable_urls must carry ≥N taken:true web captures
 * (one per surface); a single real shot no longer discharges a multi-surface
 * card. With a single declared url this is exactly the old "≥1 taken web shot".
 * Under a deploy/env override the need folds to 1 ({@link webCaptureNeed}).
 */
function hasRealWebCapture(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  return takenCaptureCount(worktreeCwd, storyId, "web", persistentCwd) >= webCaptureNeed(worktreeCwd, storyId);
}

/**
 * FIX-339 (AC2) — EVERY declared deliverable_cmd is REALLY captured: ≥N
 * taken:true terminal captures for N declared commands.
 */
function hasRealTerminalCapture(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  const need = deliverableCmdsForStory(worktreeCwd, storyId).length;
  if (need === 0) return false;
  return takenCaptureCount(worktreeCwd, storyId, "terminal", persistentCwd) >= need;
}

/**
 * US-INIT-003b — whether this delivery OWES a REAL physical Terminal.app
 * capture: the story declares `physical_terminal:` frontmatter AND is non-exempt.
 */
export function owesPhysicalTerminalCapture(worktreeCwd: string, storyId: string): boolean {
  if (!storyRequiresScreenshot(worktreeCwd, storyId)) return false;
  const spec = storySpecPath(worktreeCwd, storyId);
  if (spec === null) return false;
  try {
    return physicalTerminalFromSpecText(readFileSync(spec, "utf8")) !== null;
  } catch {
    return false;
  }
}

/**
 * US-INIT-003b — the physical_terminal capture is REAL: ≥1 taken:true capture
 * with kind "physical_terminal" in the evidence manifest.
 */
export function hasPhysicalTerminalCapture(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  return takenCaptureCount(worktreeCwd, storyId, "physical_terminal", persistentCwd) >= 1;
}

/**
 * US-INIT-003b — check if capture facts in the evidence manifest carry a
 * REJECTED terminal fallback for a physical_terminal card (kind: "terminal"
 * instead of kind: "physical_terminal"). A physical_terminal AC cannot be
 * satisfied by a headless terminal capture.
 */
export function hasRejectedTerminalForPhysical(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  if (!owesPhysicalTerminalCapture(worktreeCwd, storyId)) return false;
  const manifest = evidenceManifest(worktreeCwd, storyId, persistentCwd);
  if (manifest === null || !Array.isArray(manifest.captures)) return false;
  // A physical_terminal card has REJECTED evidence if any capture has
  // kind: "terminal" — the card declared physical_terminal: so only
  // kind: "physical_terminal" evidence is valid.
  return manifest.captures.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const row = raw as Record<string, unknown>;
    return row["kind"] === "terminal" && row["taken"] === true;
  });
}

function declaredSurfaceCaptureFloor(worktreeCwd: string, storyId: string, persistentCwd?: string): { ok: boolean; reason?: string } {
  const owesWeb = owesRealWebCapture(worktreeCwd, storyId);
  const owesTerm = owesTerminalCapture(worktreeCwd, storyId);
  const owesPhys = owesPhysicalTerminalCapture(worktreeCwd, storyId);
  if (!owesWeb && !owesTerm && !owesPhys) return { ok: true };
  const gaps: string[] = [];
  if (owesWeb && !hasRealWebCapture(worktreeCwd, storyId, persistentCwd)) {
    gaps.push(`declared deliverable_url(s) not all really captured (need ${webCaptureNeed(worktreeCwd, storyId)} taken web shots)`);
  }
  if (owesTerm && !hasRealTerminalCapture(worktreeCwd, storyId, persistentCwd)) {
    gaps.push(`declared deliverable_cmd(s) not all really captured (need ${deliverableCmdsForStory(worktreeCwd, storyId).length} taken terminal shots)`);
  }
  if (owesPhys && !hasPhysicalTerminalCapture(worktreeCwd, storyId, persistentCwd)) {
    gaps.push(`physical_terminal declared but no kind:"physical_terminal" capture taken — physical Terminal.app evidence required`);
  }
  if (owesPhys && hasRejectedTerminalForPhysical(worktreeCwd, storyId, persistentCwd)) {
    gaps.push(`physical_terminal card carries kind:"terminal" capture — physical evidence must be kind:"physical_terminal", not a headless terminal fallback`);
  }
  if (gaps.length === 0) return { ok: true, reason: "all declared surfaces really captured" };
  return { ok: false, reason: `declared surface capture missing: ${gaps.join("; ")}` };
}

function passAcVisualFloor(worktreeCwd: string, storyId: string, persistentCwd?: string): { ok: boolean; reason?: string } {
  // REFACTOR-076: must-declare is now a diagnostic, not a visual-floor blocker.
  // FIX-345 — a `screenshot_exempt` card owes NO captured visual evidence by
  // definition (per-card frontmatter or the policy non-visual epic deny-list),
  // so its pass ACs legitimately discharge with text-only evidence. The
  // screenshot floor below MUST NOT apply to it. Without this short-circuit a
  // validator/back-end exempt card (e.g. the FIX-341 e2e case: 4 pass ACs each
  // backed by test-log text, no deliverable_url/_cmd, no machine-capture skip)
  // is false-empty-shelled — its complete report reads as content-less only
  // because the visual floor demanded a per-AC screenshot it never owed. This
  // mirrors the storyRequiresScreenshot guard the report-content check (line ~817)
  // already applies; here it must guard the pass-AC screenshot floor too. The
  // empty-shell FLOOR is untouched: a no-AC / no-ac-map report is still caught
  // upstream in verificationReportHasContent (zero sections / no ac-map), and a
  // NON-exempt card still owes its captured evidence (the branches below).
  if (!storyRequiresScreenshot(worktreeCwd, storyId)) return { ok: true, reason: "screenshot-exempt: pass ACs owe no captured visual evidence" };
  const entries = readAcMapEntries(worktreeCwd, storyId, persistentCwd);
  if (entries === null) return { ok: true };
  const pass = entries.filter((e) => e.status === "pass" || e.status === "pass-with-evidence");
  if (pass.length === 0) return { ok: true };
  const missing = pass.filter((e) => !(e.evidence ?? []).some((ev) => ev.kind === "screenshot" && typeof ev.href === "string" && ev.href !== ""));
  if (missing.length === 0) return { ok: true };
  // FIX-339 (AC3): per-surface enforcement. A card may declare web surfaces, CLI
  // commands, or both; EACH declared surface owes a REAL capture and an
  // honest-skip no longer discharges a DECLARED surface.
  const declared = declaredSurfaceCaptureFloor(worktreeCwd, storyId, persistentCwd);
  if (declared.reason !== undefined) {
    if (declared.ok) return declared;
    const ids = missing.map((e) => e.ac ?? "?").join(", ");
    return { ok: false, reason: `pass AC(s) lack screenshot evidence and a declared surface was never really captured (honest-skip does not satisfy a declared surface): ${declared.reason} [${ids}]` };
  }
  if (hasMachineCaptureSkip(worktreeCwd, storyId, persistentCwd)) return { ok: true, reason: "machine capture skip present" };
  const ids = missing.map((e) => e.ac ?? "?").join(", ");
  return { ok: false, reason: `pass AC(s) lack screenshot evidence or machine capture skip: ${ids}` };
}

function visualEvidenceFloor(worktreeCwd: string, storyId: string, persistentCwd?: string): { ok: boolean; reason?: string } {
  const passAc = passAcVisualFloor(worktreeCwd, storyId, persistentCwd);
  if (!passAc.ok) return passAc;
  if (!storyRequiresScreenshot(worktreeCwd, storyId)) return passAc;
  const declared = declaredSurfaceCaptureFloor(worktreeCwd, storyId, persistentCwd);
  if (!declared.ok) return declared;
  if (declared.reason !== undefined) return declared;
  // US-V4-001: judge visual evidence from STRUCTURED truth (ac-map screenshot
  // refs + evidence.json captures + on-disk screenshots), never by scanning the
  // rendered report HTML.
  if (hasRenderedVisualEvidence(worktreeCwd, storyId, persistentCwd)) return { ok: true };
  if (hasMachineCaptureSkip(worktreeCwd, storyId, persistentCwd)) return { ok: true, reason: "machine capture skip present" };
  return { ok: false, reason: "visual evidence missing: no screenshot reference or machine capture skip" };
}

/**
 * FIX-295 — the red-assertion floor (AC-FIX2/AC-FIX3).
 *
 * The acceptance ladder distinguishes a check that EXECUTED AND FAILED (`fail` —
 * "verified AND failed") from a check that COULD NOT RUN (`blocked` — "a
 * precondition blocks verification"). `main` is PR-protected and always green
 * (every merge passed CI), so a `fail` AC on a cycle branch is, by definition, a
 * regression the cycle introduced — NOT an environment quirk. It can never be
 * waived as "environmental"; the only honest exception is a check that could not
 * execute at all (the `blocked` non-execution path / a machine capture skip).
 *
 * Returns the ids of every `fail`-status AC (empty ⇒ no red assertion). A
 * delivery carrying any of these MUST be blocked — a red assertion is a
 * regression, full stop.
 */
function redAcFailures(worktreeCwd: string, storyId: string, persistentCwd?: string): string[] {
  const entries = readAcMapEntries(worktreeCwd, storyId, persistentCwd);
  if (entries === null) return [];
  return entries.filter((e) => e.status === "fail").map((e) => e.ac ?? "?");
}

function claimedAcs(worktreeCwd: string, storyId: string, persistentCwd?: string): string[] {
  const entries = readAcMapEntries(worktreeCwd, storyId, persistentCwd);
  if (entries === null) return [];
  return entries.filter((e) => e.status === "claimed").map((e) => e.ac ?? "?");
}

/** The acceptance report a delivered story must produce (skill step 10.6) —
 *  the existing selected report path when present, otherwise the canonical
 *  NEW-layout path used for messaging. */
export function verificationReportPath(worktreeCwd: string, storyId: string, persistentCwd?: string): string {
  const existing = existingReport(worktreeCwd, storyId, persistentCwd);
  if (existing !== null) return existing;
  return reportCandidates(worktreeCwd, storyId, persistentCwd)[0] as string;
}

/** First candidate report that exists on disk, or null. */
function existingReport(worktreeCwd: string, storyId: string, persistentCwd?: string): string | null {
  for (const p of reportCandidates(worktreeCwd, storyId, persistentCwd)) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Report exists as a file AND — when a cycle-start bound is given — was written
 * this cycle (mtime ≥ `sinceSec`). No bound ⇒ existence alone (graceful: callers
 * that can't determine cycle start still detect a wholly-absent report). Either
 * archive layout counts (US-META-001 read-compat).
 */
export function verificationReportFresh(
  worktreeCwd: string,
  storyId: string,
  sinceSec?: number,
  persistentCwd?: string,
): boolean {
  if (storyId === "") return false;
  const p = existingReport(worktreeCwd, storyId, persistentCwd);
  if (p === null) return false;
  try {
    const st = statSync(p);
    if (sinceSec === undefined) return true;
    return st.mtimeMs / 1000 >= sinceSec;
  } catch {
    return false;
  }
}

/**
 * US-ATTEST-012 content floor: a report can be fresh yet be an EMPTY SHELL —
 * parseable but carrying ZERO acceptance criteria (the FIX-214 case, where a
 * heading mentioning another card id stole all the AC, so attest rendered a
 * report with no AC sections). "存在性"过闸不等于"有内容". A delivery's report must
 * carry ≥1 rendered AC section AND an `ac-map.json` (the AI intent layer the
 * skill writes for every real delivery). Missing either ⇒ no content. Either
 * archive layout counts (US-META-001 read-compat).
 */
export function verificationReportHasContent(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  if (storyId === "") return false;
  // A rendered report must EXIST (existence check — not parsed).
  if (existingReport(worktreeCwd, storyId, persistentCwd) === null) return false;
  return verificationReportHasAcceptanceContent(worktreeCwd, storyId, persistentCwd) && visualEvidenceFloor(worktreeCwd, storyId, persistentCwd).ok;
}

/**
 * US-V4-001 — the content floor reads STRUCTURED truth (the `ac-map.json` the
 * skill writes), never the rendered HTML. A real delivery's report carries an
 * ac-map with ≥1 positive AC (`pass`/`pass-with-evidence`/`partial`/`readonly`) and EVERY positive AC
 * is backed by real evidence (the empty-shell red line: a positive AC with no
 * evidence fails). The rendered report is the same data passed through the pure
 * renderer, so reading the ac-map is faithful to the old HTML-section scan while
 * keeping the gate a machine decision over structured facts (no HTML parsing).
 */
function verificationReportHasAcceptanceContent(worktreeCwd: string, storyId: string, persistentCwd?: string): boolean {
  if (storyId === "") return false;
  if (existingReport(worktreeCwd, storyId, persistentCwd) === null) return false;
  const entries = readAcMapEntries(worktreeCwd, storyId, persistentCwd);
  if (entries === null || entries.length === 0) return false;
  if (evidencePathsUnresolved(worktreeCwd, storyId, persistentCwd).length > 0) return false;
  let positiveWithEvidence = 0;
  for (const e of entries) {
    if (e.status !== "pass" && e.status !== "pass-with-evidence" && e.status !== "partial" && e.status !== "readonly") continue;
    if (!(e.evidence ?? []).some((ev) => acMapEvidenceIsReal(ev))) return false;
    positiveWithEvidence += 1;
  }
  return positiveWithEvidence > 0;
}

/** Read `loop_safety.attest_gate` from `<repoCwd>/.roll/policy.yaml`; default hard. */
export function readAttestGateMode(repoCwd: string): AttestMode {
  try {
    const p = projectDataPath(repoCwd, "policy.yaml");
    if (!existsSync(p)) return "hard";
    return parsePolicy(readFileSync(p, "utf8")).loopSafety.attestGate === "hard" ? "hard" : "soft";
  } catch {
    return "hard"; // unreadable / unparseable policy → fail closed
  }
}

export interface AttestGateResult {
  verdict: "produced" | "skipped";
  mode: AttestMode;
  reasons: string[];
  /** true ONLY when mode==="hard" && verdict==="skipped" — the delivery is blocked. */
  blocked: boolean;
}

export interface AttestGateSinks {
  alert: (message: string) => void;
  event: (payload: { cycleId: string; verdict: "produced" | "skipped"; reasons: string[] }) => void;
}

/**
 * Run the gate for one delivered cycle. Pure decision + sink side-effects; never
 * throws. Returns the verdict so callers/tests can assert without the sinks.
 *
 * Call ONLY on an actual delivery (commits ahead + a real story) — an idle cycle
 * has nothing to attest. `produced` → event only; `skipped` → ALERT + event, and
 * `blocked` iff the policy is hard.
 *
 * FIX-295: a `fail` AC (a check that ran and went red) blocks unconditionally —
 * a red assertion on a cycle branch is a regression (main is always green), not
 * an environment issue, so it is never waivable.
 */
export function runAttestGate(
  worktreeCwd: string,
  storyId: string,
  cycleId: string,
  mode: AttestMode,
  sinceSec: number | undefined,
  sinks: AttestGateSinks,
  // FIX-343 (step ②): the quality score is read from the PERSISTENT .roll
  // (repoCwd-rooted), NOT the ephemeral worktree — the fresh-session peer score
  // note (runScorePairing) lands there. Defaults to worktreeCwd so callers that
  // pre-date the split (and tests staging the note under the worktree) are
  // unaffected. `builderSessionId` (step ①, ctx.builderSessionId) is threaded so
  // the gate honors ONLY an independent fresh-session score whose recorded
  // `sessionId` is NOT the builder's own session — never the vendor name.
  scoreRepoCwd: string = worktreeCwd,
  builderSessionId = "",
  renderExitCode = 0,
  // E9 (PR9): the cwd whose `.roll` holds the DESIGN TRUTH spec. The picker and
  // designer resolve the story spec from the live main checkout
  // (`storySpecPath(ports.repoCwd, id)`); the attest gate must read it from the
  // SAME live tree. Historically the gate read the spec from `worktreeCwd`, the
  // cycle worktree snapshot. For a project that TRACKS `.roll` (a committed
  // backlog.md), `linkRollIntoWorktree` keeps the CHECKED-OUT `.roll` in the
  // worktree instead of symlinking to the live tree, so an as-yet-UNCOMMITTED
  // spec is absent from the snapshot and the gate mis-read the story as "not
  // found". Defaults to `worktreeCwd` for byte-identical back-compat: callers
  // (and every pre-E9 test) that don't pass it keep the prior behaviour, and a
  // NON-tracked-`.roll` project has `worktreePath/.roll` symlinked to the live
  // `.roll` — same bytes either way. This is decoupled from `scoreRepoCwd`
  // (evidence/score truth) on purpose: spec = design truth (repoCwd), evidence =
  // cycle-generated artifacts (worktree-first, repoCwd fallback), unchanged.
  specRepoCwd: string = worktreeCwd,
): AttestGateResult {
  // FIX-343 (step ②): a missing PEER score must surface as a blocking
  // skipped/blocked verdict — the bottom blanket catch below must NOT soft-fail
  // it to `produced`. The peer-score check is therefore evaluated here, where a
  // thrown error in the score read is fail-closed (blocked in hard mode), and
  // its result is reused inside the main path below.
  try {
    // US-EVID-021: alert (never block) when the worktree contract drifted from
    // the cycle-start frozen snapshot — a builder AC/`screenshot_exempt` edit
    // after the freeze. The snapshot is written from design truth under the
    // persistent .roll (scoreRepoCwd, FIX-343's persistent root); the verdict
    // below is judged the same as before — drift is a VISIBLE SIGNAL ONLY, never
    // a block, honouring the owner red line (a false positive must not stall).
    try {
      // E9: resolve the drift-comparison spec from the DESIGN-TRUTH tree
      // (specRepoCwd), the same live `.roll` the picker/designer read — never the
      // committed worktree snapshot (which lacks an uncommitted spec).
      const liveSpec = storySpecPath(specRepoCwd, storyId);
      if (liveSpec !== null) {
        const drift = contractDrift(scoreRepoCwd, storyId, readFileSync(liveSpec, "utf8"));
        if (drift !== null) sinks.alert(`attest: ${drift} — cycle ${cycleId}`);
      }
    } catch {
      /* drift alert is best-effort; it never affects the verdict */
    }
    alertCaptureFailures(worktreeCwd, storyId, cycleId, sinks, scoreRepoCwd);
    // US-EVID-031 — separate delivery correctness from visual-evidence health.
    // A poisoned lane (invalid-target) or a missing/bypassed contract
    // (absent-contract) BLOCKS as a loud evidence/contract failure. A broken
    // capture machine (degraded-infrastructure) is only ALERTED — never blocked,
    // never rescheduled — so a completed story is not repeatedly rebuilt. Additive:
    // fires only when the run manifest carries a v2 `evidence_health` fact.
    {
      const evHealthGate = evidenceHealthGate(worktreeCwd, storyId, scoreRepoCwd);
      for (const degraded of evHealthGate.degraded) {
        sinks.alert(
          `attest gate (${mode}): visual evidence DEGRADED (infrastructure) for ${storyId} — ${degraded.surfaceId ?? "(no surface)"}: ${degraded.reason} — published without rebuild; repair by an evidence-only rerun — cycle ${cycleId}`,
        );
      }
      if (evHealthGate.blocking.length > 0) {
        const reasons = evHealthGate.blocking.map(
          (b) => `visual evidence ${b.visual} for ${storyId} (${b.surfaceId ?? "no surface"}): ${b.reason}`,
        );
        const blocked = mode === "hard";
        sinks.alert(
          `attest gate (${mode}): visual evidence BLOCKED (${storyId}) — ${evHealthGate.blocking.map((b) => `${b.visual}@${b.surfaceId ?? "no-surface"}`).join(", ")}; a login/redirect/wrong-target/corrupt/forged capture or a missing/bypassed capture contract is never promoted to evidence — cycle ${cycleId}` +
            (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
        );
        sinks.event({ cycleId, verdict: "skipped", reasons });
        return { verdict: "skipped", mode, reasons, blocked };
      }
    }
    // FIX-339 (复核 #1) — a deliverable_cmd outside the roll read-only allowlist
    // is rejected BEFORE anything else: the spec asked the attest lane to run a
    // non-roll command or a state-changing roll subcommand (agent-controlled
    // arbitrary execution). The command never ran; the gate FAILS LOUD here (it
    // is never silently honest-skipped). Reported even ahead of the AC-block
    // exemption, since the security problem stands regardless of AC shape.
    // E9: deliverable_cmd is a SPEC-declared field → read it from design truth.
    const rejectedCmds = rejectedDeliverableCmdsForStory(specRepoCwd, storyId);
    if (rejectedCmds.length > 0) {
      const reasons = [
        `deliverable_cmd 非白名单(仅限 roll 只读子命令): ${rejectedCmds.join(", ")} — refused (no arbitrary command execution; no state-changing roll subcommand)`,
      ];
      const blocked = mode === "hard";
      sinks.alert(
        `attest gate (${mode}): deliverable_cmd outside the roll read-only allowlist (${storyId}) — refused: ${rejectedCmds.join(", ")} — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
      return { verdict: "skipped", mode, reasons, blocked };
    }
    // FIX-1476: the no-AC exemption is evaluated BEFORE the render-exit block.
    // Historically it sat below it, so a no-AC card whose attest render exited
    // non-zero ("story not found" under `.roll/features/`) blocked here and the
    // exemption was never reached — exactly the cards it exists for (production:
    // ~40 blocked gate events / 30 days across 3 projects, e.g. roll-capture
    // REFACTOR-001 which could never deliver). E9: the AC block lives in the
    // SPEC (design truth) → read from specRepoCwd, so an uncommitted spec
    // present only in the live checkout is seen. `null` (spec missing or
    // unreadable) deliberately does NOT exempt — that would fail open.
    if (storyHasAcBlock(specRepoCwd, storyId) === false) {
      const reasons = ["story has no AC block; acceptance report not required"];
      sinks.event({ cycleId, verdict: "produced", reasons });
      return { verdict: "produced", mode, reasons, blocked: false };
    }
    if (renderExitCode !== 0) {
      const reasons = [`attest render failed for ${storyId} (exit ${renderExitCode})`];
      const blocked = mode === "hard";
      sinks.alert(
        `attest gate (${mode}): attest render failed (${storyId}) — exit ${renderExitCode} — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
      return { verdict: "skipped", mode, reasons, blocked };
    }
    // E9: must-declare is a SPEC-frontmatter diagnostic → read from design truth.
    const diagnostics = violatesMustDeclareSurface(specRepoCwd, storyId) ? [MUST_DECLARE_FAIL_REASON] : [];
    // FIX-295 (AC-FIX2/AC-FIX3): a red assertion is a regression, never an
    // "environmental" exception. A `fail` AC (a check that ran and went red) on
    // a cycle branch can only be the cycle's own regression — main is always
    // green — so it blocks the delivery and the story is NOT marked Done. The
    // only honest non-pass an env exception covers is a check that COULD NOT RUN
    // (`blocked` / a machine capture skip), which is not a `fail`.
    const redAcs = redAcFailures(worktreeCwd, storyId, scoreRepoCwd);
    if (redAcs.length > 0) {
      const reasons = [
        `acceptance check failed for ${storyId}: ${redAcs.join(", ")} went red — a failing check is a regression, not an environment issue, so it cannot be waived`,
      ];
      const blocked = mode === "hard";
      sinks.alert(
        `attest gate (${mode}): acceptance check failed (${storyId}) — ${redAcs.join(", ")} went red; a red check is a regression and is never waived as environmental — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
      return { verdict: "skipped", mode, reasons, blocked };
    }
    const claimed = claimedAcs(worktreeCwd, storyId, scoreRepoCwd);
    if (claimed.length > 0) {
      const reasons = [`claimed acceptance evidence is not mergeable for ${storyId}: ${claimed.join(", ")}`];
      const blocked = mode === "hard";
      sinks.alert(
        `attest gate (${mode}): claimed acceptance evidence (${storyId}) — ${claimed.join(", ")} must be pass/fail evidence, not claimed — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
      return { verdict: "skipped", mode, reasons, blocked };
    }
    const unresolved = evidencePathsUnresolved(worktreeCwd, storyId, scoreRepoCwd);
    if (unresolved.length > 0) {
      const reasons = [`unresolved acceptance evidence path(s) for ${storyId}: ${unresolved.join(", ")}`];
      const blocked = mode === "hard";
      sinks.alert(
        `attest gate (${mode}): unresolved acceptance evidence (${storyId}) — ${unresolved.join(", ")} — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
      return { verdict: "skipped", mode, reasons, blocked };
    }
    const fresh = verificationReportFresh(worktreeCwd, storyId, sinceSec, scoreRepoCwd);
    // US-ATTEST-012: freshness alone is "存在性" — a fresh empty shell (zero AC /
    // no ac-map, the FIX-214 case) does NOT count as a produced report.
    if (fresh && verificationReportHasAcceptanceContent(worktreeCwd, storyId, scoreRepoCwd)) {
      // FIX-343 (step ③): honor ONLY an INDEPENDENT fresh-session peer score from
      // the PERSISTENT .roll (scoreRepoCwd) — its recorded `sessionId` must be
      // present AND ≠ the builder's session id. A self / legacy / no-sessionId /
      // sessionId===builderSessionId / absent note → status "missing" with
      // "missing peer review score" → block (fail loud, no synthesized pass).
      // FIX-343 (① STRICT cycle-scope): thread THIS cycle's id so only a score
      // minted by this cycle's scorer (`${cycleId}:score:...`) is honored — a
      // prior cycle's peer note on a RESUME (re-picked un-merged same-story
      // branch) no longer soft-passes this cycle's gate.
      const score = evaluateReviewScoreGate(scoreRepoCwd, storyId, builderSessionId, cycleId);
      if (score.status === "pass") {
        const visual = visualEvidenceFloor(worktreeCwd, storyId, scoreRepoCwd);
        if (!visual.ok) {
          const reasons = [visual.reason ?? "visual evidence gate failed"];
          const blocked = mode === "hard";
          sinks.alert(
            `attest gate (${mode}): visual evidence gate failed (${storyId}) — ${reasons[0]} — cycle ${cycleId}` +
              (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
          );
          sinks.event({ cycleId, verdict: "skipped", reasons });
          return { verdict: "skipped", mode, reasons, blocked };
        }
        const reasons = ["fresh acceptance report present", score.reason, ...(visual.reason !== undefined ? [visual.reason] : []), ...diagnostics];
        sinks.event({ cycleId, verdict: "produced", reasons });
        return { verdict: "produced", mode, reasons, blocked: false };
      }
      const reasons = [score.reason];
      const blocked = mode === "hard";
      sinks.alert(
        `attest gate (${mode}): review-score gate failed (${storyId}) — ${score.reason} — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
      return { verdict: "skipped", mode, reasons, blocked };
    }
    const reportPath = verificationReportPath(worktreeCwd, storyId, scoreRepoCwd);
    const reasons = [
      fresh
        ? `acceptance report at ${reportPath} is an empty shell (no AC content / no ac-map)`
        : `no fresh acceptance report for ${storyId} at ${reportPath} (checked card archive paths)`,
    ];
    const blocked = mode === "hard";
    const lead = fresh
      ? `delivery with an empty-shell acceptance report (no AC content / no ac-map)`
      : `delivery without a fresh acceptance report`;
    sinks.alert(
      `attest gate (${mode}): ${lead} (${storyId}) — cycle ${cycleId}` +
        (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
    );
    sinks.event({ cycleId, verdict: "skipped", reasons });
    return { verdict: "skipped", mode, reasons, blocked };
  } catch {
    // FIX-343 (step ②): the blanket catch must NOT soft-fail to `produced` — an
    // exception while resolving the peer score (or any other gate check) would
    // otherwise launder a missing-peer-score delivery into a pass. Fail CLOSED:
    // surface a blocking skipped/blocked verdict in hard mode (the cycle owes a
    // real peer score), non-blocking skipped in soft (migration window). A
    // missing peer score is never synthesized into a pass.
    const reasons = ["attest gate error — failing closed (no peer review score honored)"];
    const blocked = mode === "hard";
    // FIX-343 (③ observability): EVERY other block path emits an ALERT + an
    // `attest:gate` event, but this fail-closed catch returned the skipped verdict
    // SILENTLY — the most safety-critical case (the gate itself errored) was
    // INVISIBLE in the audit ndjson. Emit before returning so a failed-closed
    // delivery is auditable like any other skip. Sink calls are wrapped so a
    // throwing sink can't break this path's "never throws" contract.
    try {
      sinks.alert(
        `attest gate (${mode}): gate error — failing closed (${storyId}) — ${reasons[0]} — cycle ${cycleId}` +
          (blocked ? " — BLOCKED (hard mode); story not marked Done" : ""),
      );
      sinks.event({ cycleId, verdict: "skipped", reasons });
    } catch {
      /* sinks are best-effort here — the fail-closed verdict still returns */
    }
    return { verdict: "skipped", mode, reasons, blocked };
  }
}

/**
 * US-EVID-031 — split the run's per-surface visual-evidence health into the
 * BLOCKING facts (invalid-target / absent-contract) and the non-blocking DEGRADED
 * facts (a broken capture machine). Pure read of the run manifest; empty for a
 * legacy story with no v2 `evidence_health` fact.
 */
function evidenceHealthGate(
  worktreeCwd: string,
  storyId: string,
  persistentCwd?: string,
): { blocking: ReturnType<typeof evidenceHealthReadouts>; degraded: ReturnType<typeof evidenceHealthReadouts> } {
  try {
    const report = existingReport(worktreeCwd, storyId, persistentCwd);
    if (report === null) return { blocking: [], degraded: [] };
    const readouts = evidenceHealthReadouts(dirname(report));
    return {
      blocking: readouts.filter((r) => r.blocksGate),
      degraded: readouts.filter((r) => r.markedDegraded && !r.blocksGate),
    };
  } catch {
    return { blocking: [], degraded: [] };
  }
}

function alertCaptureFailures(
  worktreeCwd: string,
  storyId: string,
  cycleId: string,
  sinks: AttestGateSinks,
  persistentCwd?: string,
): void {
  try {
    const report = existingReport(worktreeCwd, storyId, persistentCwd);
    if (report === null) return;
    const failures = captureFailures(dirname(report));
    for (const failure of failures) {
      const label = failure.label !== undefined ? ` ${failure.label}` : "";
      const kind = failure.kind !== undefined ? `${failure.kind}${label}` : `capture${label}`;
      sinks.alert(`attest capture failure (${storyId}) — ${kind}: ${failure.error} — cycle ${cycleId}`);
    }
  } catch {
    /* capture failure surfacing is alert-only and never affects the verdict */
  }
}
