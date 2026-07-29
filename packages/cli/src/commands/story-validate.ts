/**
 * `roll story validate <ID>` — FIX-339 (AC7). The COMMAND-SIDE of the must-declare
 * contract: a read-only self-check that runs the SAME structural rules the runtime
 * attest gate enforces (FIX-339 AC6), so roll-design can prefill it as a closing
 * self-check and catch a spec that can never satisfy the screenshot floor BEFORE
 * it reaches the loop.
 *
 * Two checks, both surfaced with their reason:
 *   1. MUST-DECLARE (epic-aware {@link screenshotExemption} + {@link declaresAnySurface}):
 *      a non-exempt card SHOULD declare at least one deliverable surface
 *      (`deliverable_url` / `deliverable_cmd`) OR a recorded
 *      `screenshot_exempt: <reason>`. None ⇒ WARN (shift-left only; no control-flow block).
 *   2. VISUAL-EVIDENCE AC ({@link validateStoryVisualEvidence}): the spec carries
 *      an AC that captures a user-visible surface (web/CLI/TUI), and a WEB-surface
 *      AC declares its `deliverable_url`. Missing ⇒ FAIL.
 *
 * Exit code: 0 when the card passes the visual-evidence contract (or is exempt),
 * non-zero otherwise — so a skill / CI step can gate on objective evidence only.
 * Must-declare is a soft warning. A spec that cannot be found ⇒ exit 2 (caller error).
 */
import { readFileSync } from "node:fs";
import { c, renderState } from "../render.js";
import { STORY_ID_RE } from "../lib/story-page.js";
import { DuplicateStoryIdError, declaresAnySurface, screenshotExemption, storySpecPath } from "../runner/attest-gate.js";
import { validateStoryVisualEvidence } from "../lib/design-visual-evidence.js";
import { isNewRegimeCard, lintCardGranularity } from "../lib/card-granularity.js";

const green = (s: string): string => c("green", s);
const red = (s: string): string => c("red", s);
const amber = (s: string): string => c("amber", s);

export const STORY_VALIDATE_USAGE =
  "Usage: roll story validate <ID>\n" +
  "  Self-check a card's spec against the visual-evidence contract (FIX-339):\n" +
  "  warn when no deliverable surface is declared (deliverable_url /\n" +
  "  deliverable_cmd / screenshot_exempt) and require a visual-evidence AC.\n" +
  "  Exit 0 = ok or warning-only, non-zero = not ok.\n" +
  "  自检卡片是否满足可视证据契约:缺交付面只警告;缺可视证据 AC 才非 0。\n";

export function storyValidateCommand(args: string[]): number {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === undefined) {
    process.stdout.write(STORY_VALIDATE_USAGE);
    return args[0] === undefined ? 1 : 0;
  }
  // Color parity with the rest of the read face (NO_COLOR / non-TTY / --no-color).
  if (args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "") {
    renderState.useColor = false;
  }
  const id = args[0];
  if (!STORY_ID_RE.test(id)) {
    process.stderr.write(
      `story validate: '${id}' is not a story id (US-/FIX-/REFACTOR-/IDEA-…)\n` +
        `story validate: '${id}' 不是合法故事 ID\n`,
    );
    return 2;
  }
  const cwd = process.cwd();
  let spec: string | null;
  try {
    spec = storySpecPath(cwd, id);
  } catch (e) {
    // FIX-340 — a duplicate id can't be self-checked: which spec? Fail loud
    // (the runtime attest gate fails the same way) so the data bug is fixed,
    // not silently resolved to the wrong card.
    if (e instanceof DuplicateStoryIdError) {
      process.stderr.write(
        `story validate: ${e.message}\n` +
          `story validate: ${id} 解析到多份 spec — 必须唯一(消除重复 ID 后重试)\n`,
      );
      return 2;
    }
    throw e;
  }
  if (spec === null) {
    process.stderr.write(
      `story validate: no spec found for ${id} (looked for features/<epic>/${id}/spec.md and features/<epic>/${id}.md)\n` +
        `story validate: 找不到 ${id} 的 spec\n`,
    );
    return 2;
  }
  let specText: string;
  try {
    specText = readFileSync(spec, "utf8");
  } catch (e) {
    process.stderr.write(`story validate: cannot read ${spec} (${e instanceof Error ? e.message : "?"})\n`);
    return 2;
  }

  // (1) must-declare — epic-aware exemption so an epic-deny-list card (a recorded
  // non-visual epic) is legitimately exempt even with no per-card frontmatter.
  const exemption = screenshotExemption(cwd, id); // reads policy epic deny-list + per-card frontmatter
  const exempt = exemption.reason !== undefined;
  const declares = declaresAnySurface(specText);
  const mustDeclareOk = exempt || declares;

  // (2) visual-evidence AC (surface-aware; pure spec text).
  const visual = validateStoryVisualEvidence(specText);

  const fails: string[] = [];
  const warnings: string[] = [];
  if (!mustDeclareOk) {
    warnings.push(
      "no deliverable surface declared — must declare `deliverable_url:` / `deliverable_cmd:` or a recorded `screenshot_exempt: <reason>`",
    );
  }
  if (visual.exemptSubstituteMissing === true) {
    fails.push("screenshot_exempt without a substitute capturable evidence (declare deliverable_cmd or name the tests) — 免截图 ≠ 免证据");
  }
  // US-CYCLE-005 — design-time granularity gate. Self-scoping by the card's
  // intrinsic `created:` date (>= the cutover): the 900+ legacy cards are never
  // retroactively failed, and a NEW card cannot bypass the lint by omitting
  // est_min/risk_tier (the created date is not dodgeable). A new-regime card that
  // is too big / missing the contract (incl. risk_tier) is rejected here.
  const granularity = isNewRegimeCard(specText, id) ? lintCardGranularity(specText) : null;
  if (granularity !== null && !granularity.ok) {
    for (const v of granularity.violations) {
      fails.push(`granularity: ${v.message}`);
      fails.push(`  ↳ ${v.fix}`);
    }
  }

  // An exempt card owes no visual-evidence AC (the contract is waived); only a
  // non-exempt card must carry one.
  if (!exempt && !visual.ok) {
    fails.push(visual.reason ?? "visual-evidence contract not satisfied");
    // FIX-383 — surface rejected deliverable_cmd entries with streaming hints.
    if (visual.rejectedDeliverableCmds && visual.rejectedDeliverableCmds.length > 0) {
      for (const cmd of visual.rejectedDeliverableCmds) {
        const isStreaming = visual.streamingDeliverableCmds?.includes(cmd);
        fails.push(
          `  ↳ rejected: \`${cmd}\` — 非白名单(仅限 roll 只读子命令)${isStreaming ? " (流式命令,截图机制会挂)" : ""}`,
        );
      }
    }
  }

  const ok = fails.length === 0;
  const mark = (good: boolean): string => (good ? green("ok") : red("FAIL"));
  const lines: string[] = [];
  lines.push(`${ok ? green("✓") : red("✗")} story validate ${id}  (${spec})`);
  if (exempt) {
    lines.push(`  must-declare:    ${green("ok")} (exempt — ${exemption.reason})`);
    lines.push(
      `  visual-evidence: ${visual.exemptSubstituteMissing === true ? red("FAIL") : green("ok")}${
        visual.exemptSubstituteMissing === true ? " — screenshot_exempt lacks substitute evidence" : " (exempt)"
      }`,
    );
  } else {
    lines.push(`  must-declare:    ${declares ? green("ok") : amber("warning")}${declares ? "" : " — 缺声明面 (deliverable_url/cmd/exempt)"}`);
    lines.push(`  visual-evidence: ${mark(visual.ok)}${visual.ok ? ` (surface: ${visual.surface})` : ` — 缺可视 AC: ${visual.code ?? "flagged"}`}`);
  }
  if (granularity !== null) {
    lines.push(`  granularity:     ${granularity.ok ? green("ok") : red("FAIL")}${granularity.ok ? "" : ` — ${granularity.violations.length} 违规 (卡太大/契约缺失)`}`);
  }
  for (const w of warnings) lines.push(`  • warning: ${w}`);
  for (const f of fails) lines.push(`  • ${f}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}
