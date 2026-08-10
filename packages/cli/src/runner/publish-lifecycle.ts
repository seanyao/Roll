/**
 * @responsibility Walks the publish lifecycle state machine for remote delivery.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  buildPendingDeliveryEvidenceManifest,
  parseBacklog,
  writePendingDeliveryEvidenceManifest,
  type CycleContext,
  type EventStore,
  type ManifestFileKind,
} from "@roll/core";
import { checkImageEvidenceAllowed, imageEvidencePathsInWorkingTree, resolveIntegrationBranch } from "@roll/infra";
import { parseRulesRegistry, type Lang, type Result, type RulesParseError, type RulesRegistry } from "@roll/spec";
import { cardArchiveDir } from "../lib/archive.js";
import { runDocDriftSoftCheck } from "../lib/doc-drift.js";
import { validateStoryVisualEvidence } from "../lib/design-visual-evidence.js";
import { acMapPath } from "./attest-remediation.js";
import { declaresAnySurface, screenshotExemption } from "./attest-gate.js";
import { ingestGateMode, ingestSurfaceReadiness, recordIngestHold } from "./ingest-gate.js";
import type { Ports } from "./ports.js";
import { eventTs } from "./runner-time.js";
import { resolveExecutionCwd, resolveExecutionRepoCwd } from "./submodule-worktree.js";

/**
 * FIX-311b — the BUILD-PREFLIGHT visual-evidence gate, run inside `pick_story`
 * AFTER the spec-truth reset and BEFORE the agent spawns. It is the shift-left
 * of the FIX-309 attest gate: catch a spec that can NEVER satisfy the runtime
 * screenshot floor at the cheapest possible moment (before a whole build cycle
 * honest-skips) rather than at delivery.
 *
 * CONSERVATIVE BY CONTRACT (owner red line: 误杀 CLI/后端卡 = 阻断 loop, 绝不可):
 *   - It NEVER alters control flow — the caller's `story_picked` still returns
 *     regardless. A false positive can therefore NOT topple a CLI/back-end card.
 *   - It fails-loud ONLY when CONFIDENT (the verdict's `ok` is false): a clear
 *     WEB-surface card with no declared `deliverable_url`
 *     (`web-surface-without-deliverable-url`), or a card with NO visual-evidence
 *     AC and NO recorded `screenshot_exempt` (`missing-visual-evidence-ac`). A
 *     TERMINAL deliverable, an AMBIGUOUS surface, an exempt card, or an
 *     unreadable/absent spec is LEFT ALONE — the surface-aware validator never
 *     forces a web url onto those, and FIX-309 remains the hard backstop at
 *     delivery for anything that slips.
 * Best-effort throughout: any read/parse blip is swallowed (a preflight signal
 * must never fail the cycle).
 */
export function runVisualEvidencePreflight(ports: Ports, storyId: string, cycleId: string): void {
  try {
    const specPath = join(cardArchiveDir(ports.repoCwd, storyId), "spec.md");
    if (!existsSync(specPath)) return; // no spec to judge → leave alone (FIX-309 backstops)
    const specText = readFileSync(specPath, "utf8");
    const v = validateStoryVisualEvidence(specText);
    if (v.ok) {
      // Record the pass too (audit: the card was checked and can satisfy the floor).
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "visual:gate",
        cycleId,
        storyId,
        verdict: "ok",
        surface: v.surface,
        reasons: v.exemptReason !== undefined ? [`exempt: ${v.exemptReason}`] : [],
        ts: eventTs(ports),
      });
      // FIX-339 (AC6) / REFACTOR-076 — must-declare STRUCTURAL check.
      // Fires ONLY on a card that the surface-aware validator already passed
      // (`ok`) yet declares NONE of {deliverable_url, deliverable_cmd,
      // screenshot_exempt} — i.e. a previously-SILENT card (a terminal/ambiguous
      // visual AC with no concrete capturable surface) that will honest-skip
      // forever. It is a SUPPLEMENTARY diagnostic, never a duplicate of an
      // existing validate flag, and NEVER blocks or alerts during runtime.
      // FIX-339 (复核 #5) — declaresAnySurface is PURE (specText only): it sees a
      // per-card `screenshot_exempt:` but NOT the policy epic deny-list
      // (acceptance.screenshot_exempt_epics). A card whose EPIC is recorded as
      // non-visual is legitimately exempt and declares no surface ON PURPOSE —
      // flagging it no-surface-declared误杀 a back-end card (owner red line). So
      // treat an epic-exempt card as already declaring a (null) surface here.
      const epicExempt = screenshotExemption(ports.repoCwd, storyId).reason !== undefined;
      if (!epicExempt && !declaresAnySurface(specText)) {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "visual:gate",
          cycleId,
          storyId,
          verdict: "diagnostic",
          code: "no-surface-declared",
          surface: v.surface,
          reasons: ["spec declares no deliverable_url, deliverable_cmd, or screenshot_exempt — no surface to capture"],
          ts: eventTs(ports),
        });
        // US-EVID-022: phased ingest SOFT gate. The diagnostic above is
        // observe-only (metric). In `alert`/`block` mode, also record the card
        // to the ingest hold list and raise a visible alert. Still NON-blocking —
        // control flow returns below regardless (owner red line: a false
        // positive must never stall the loop); `block` means "held for an
        // authoring fix", never "crash ingest".
        // Check mode FIRST and short-circuit: in the default `metric` mode the
        // hold is discarded, so skip the ingestSurfaceReadiness parse (acForStory)
        // on that common path. The readiness call also applies the AC-block guard
        // (a placeholder with no AC block is NOT held), unlike the raw
        // declaresAnySurface check above which the pre-existing diagnostic uses.
        const ingestMode = ingestGateMode(ports.repoCwd);
        if (ingestMode !== "metric" && ingestSurfaceReadiness(specText, storyId).needsHold) {
          recordIngestHold(
            dirname(ports.paths.eventsPath),
            storyId,
            "AC block but no declared capture surface (deliverable_url/cmd/physical) or screenshot_exempt",
            eventTs(ports),
          );
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `[${ingestMode === "block" ? "HOLD" : "WARN"}] ingest gate (${storyId}): AC block declares no ` +
              `capture surface or screenshot_exempt — recorded to ingest-hold for an authoring fix; NOT ` +
              `blocking the cycle — cycle ${cycleId}`,
          );
        }
      }
      return;
    }
    // CONFIDENT problem → fail loud (ALERT + event), but DO NOT block the cycle.
    const reason = v.reason ?? "visual-evidence contract not satisfied";
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "visual:gate",
      cycleId,
      storyId,
      verdict: "flagged",
      ...(v.code !== undefined ? { code: v.code } : {}),
      surface: v.surface,
      reasons: [reason],
      ts: eventTs(ports),
    });
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `[WARN] visual-evidence preflight (${storyId}): ${v.code ?? "flagged"} — ${reason} — cycle ${cycleId}. ` +
        `Add a visual-evidence AC` +
        (v.code === "web-surface-without-deliverable-url"
          ? ` AND declare \`deliverable_url:\` (alias \`screenshot_url:\`) for the web surface`
          : ` or a recorded \`screenshot_exempt: <reason>\``) +
        `. NOT blocked — FIX-309 enforces at delivery; this is the cheap early warning.`,
    );
  } catch {
    /* best-effort: a spec read/parse blip must never fail the cycle */
  }
}

/** Compose the gh pr-create body (commit-count-style; kept simple + pure). */
function publishBody(ctx: CycleContext): string {
  return `loop cycle ${ctx.cycleId}${ctx.storyId !== undefined ? ` — ${ctx.storyId}` : ""}`;
}

function rollMetaShaReachableOnOrigin(rollDir: string, sha: string): boolean {
  try {
    const out = execFileSync("git", ["-C", rollDir, "ls-remote", "origin"], { encoding: "utf8" });
    return out.split(/\r?\n/).some((line) => line.startsWith(`${sha}\t`));
  } catch {
    return false;
  }
}

type RollEvidenceLayout = "missing" | "nested" | "in-repo";

function rollEvidenceLayout(repoCwd: string): RollEvidenceLayout {
  const rollDir = join(repoCwd, ".roll");
  if (!existsSync(rollDir)) return "missing";
  try {
    const top = execFileSync("git", ["-C", rollDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    if (top === "") return "missing";
    return realpathSync(top) === realpathSync(rollDir) ? "nested" : "in-repo";
  } catch {
    return "missing";
  }
}

/** Classify an evidence file into a manifest kind by name/location. */
function evidenceKindFor(relPath: string): ManifestFileKind {
  const lower = relPath.toLowerCase();
  if (lower.includes("/screenshots/") || /\.(png|jpe?g|gif|webp)$/.test(lower)) return "screenshot";
  if (lower.endsWith("-review.html") || lower.endsWith("-report.html") || lower.endsWith("report.html") || lower.endsWith("review.html")) {
    return "report";
  }
  if (lower.endsWith(".html") || lower.endsWith(".md")) return "dossier";
  return "evidence";
}

/** Recursively enumerate every regular file under `dir` (absolute paths). */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * FIX-1272: record an immutable per-cycle manifest of the exact pending-delivery
 * evidence (path + SHA-256) the runner just committed to the delivery branch.
 * The in-repo evidence physically lives in the MAIN checkout's working tree but
 * is committed only to the PR branch, so it stays dirty on `main` while the PR
 * is open. The manifest lets the loop's bootstrap gate confirm these files are
 * runner-owned and NOT pause an unrelated eligible card. Best-effort: a failed
 * manifest write must never block delivery (the gate simply fails closed).
 */
function recordPendingDeliveryManifest(ports: Ports, ctx: CycleContext, storyId: string, runDir: string, acMap: string): void {
  try {
    // A schema-valid manifest requires a non-empty cycle id, branch, and story.
    if (ctx.cycleId === "" || (ctx.branch ?? "") === "" || storyId === "" || !existsSync(runDir)) return;
    const candidates: Array<{ path: string; kind: ManifestFileKind }> = [];
    const toRel = (abs: string): string => relative(ports.repoCwd, abs).split("\\").join("/");
    if (existsSync(acMap)) candidates.push({ path: toRel(acMap), kind: "evidence" });
    for (const abs of listFilesRecursive(runDir)) {
      const rel = toRel(abs);
      candidates.push({ path: rel, kind: evidenceKindFor(rel) });
    }
    // FIX-1272: the in-repo layout also stages the cycle's status-flip writeback
    // (backlog/features/spec) onto the PR branch, leaving those tracked files
    // modified on main. Record them so a legitimate status flip is verified and
    // does not trip the bootstrap gate on the next cycle.
    for (const writeback of [
      join(ports.repoCwd, ".roll", "backlog.md"),
      join(ports.repoCwd, ".roll", "features.md"),
      join(cardArchiveDir(ports.repoCwd, storyId), "spec.md"),
    ]) {
      if (existsSync(writeback)) candidates.push({ path: toRel(writeback), kind: "dossier" });
    }
    if (candidates.length === 0) return;
    const manifest = buildPendingDeliveryEvidenceManifest({
      cycleId: ctx.cycleId,
      storyId,
      branch: ctx.branch,
      repositoryRoot: ports.repoCwd,
      files: candidates,
    });
    if (manifest.files.length === 0) return;
    writePendingDeliveryEvidenceManifest(ports.repoCwd, manifest);
  } catch {
    /* best-effort: the gate fails closed if the manifest is missing */
  }
}

async function commitInRepoEvidence(ports: Ports, ctx: CycleContext, storyId: string): Promise<boolean> {
  const cardDir = cardArchiveDir(ports.repoCwd, storyId);
  const acMap = acMapPath(ports.repoCwd, storyId);
  const runDir = ctx.cycleId !== "" ? join(cardDir, ctx.cycleId) : "";
  if (!existsSync(acMap)) {
    ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: ac-map.json missing after remediation`);
    return false;
  }
  if (runDir === "" || !existsSync(runDir)) {
    ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: cycle run-dir missing for ${ctx.cycleId}`);
    return false;
  }
  const relAcMap = relative(ports.repoCwd, acMap);
  const relRunDir = relative(ports.repoCwd, runDir);
  if (relAcMap === "" || relRunDir === "" || relAcMap.startsWith("..") || relRunDir.startsWith("..")) {
    ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: evidence path escapes repo`);
    return false;
  }
  // US-PHYSICAL-008: for in-repo .roll layouts, the main repo remote governs
  // visibility. Block image evidence on public/unknown remotes unless waived.
  const imagePaths = imageEvidencePathsInWorkingTree(ports.repoCwd);
  if (imagePaths.length > 0) {
    const check = await checkImageEvidenceAllowed(ports.repoCwd, ports.repoCwd);
    if (!check.allowed) {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `Roll-Evidence publish blocked for ${storyId}: ${check.reason}`,
      );
      return false;
    }
  }
  try {
    // FIX-1238: target the WORKTREE git (delivery branch), not the main checkout.
    const evidenceCwd = ports.paths?.worktreePath ?? ports.repoCwd;
    // FIX-1238: only use --git-dir targeting when .git is a FILE (worktree)
    // not a directory (bare/main checkout). readFileSync on a dir would throw.
    const worktreeGitFile = join(evidenceCwd, ".git");
    let worktreeGitDir: string | undefined;
    let isWorktreeTarget = false;
    if (ports.paths?.worktreePath !== undefined && existsSync(worktreeGitFile) && lstatSync(worktreeGitFile).isFile()) {
      const gitContent = readFileSync(worktreeGitFile, "utf8").trim();
      const m = gitContent.match(/^gitdir:\s*(.+)$/m);
      if (m && m[1]) {
        const parsedGitDir = m[1].trim();
        worktreeGitDir = resolve(evidenceCwd, parsedGitDir);
        isWorktreeTarget = true;
      }
    }
    const gitTarget = worktreeGitDir !== undefined && isWorktreeTarget
      ? ["--git-dir", worktreeGitDir, "--work-tree", ports.paths.worktreePath]
      : [];
    // FIX-1238: also include backlog.md so the status flip rides the PR branch.
    const backlogPath = join(ports.repoCwd, ".roll", "backlog.md");
    const trackedPaths = [relAcMap, relRunDir];
    if (existsSync(backlogPath)) {
      trackedPaths.push(relative(ports.repoCwd, backlogPath));
    }
    execFileSync("git", [...gitTarget, "add", "-A", "-f", "--", ...trackedPaths], { cwd: ports.repoCwd, stdio: "ignore" });
    const dirty = execFileSync("git", [...gitTarget, "status", "--porcelain", "--", ...trackedPaths], {
      cwd: ports.repoCwd,
      encoding: "utf8",
    }).trim();
    if (dirty === "") {
      recordPendingDeliveryManifest(ports, ctx, storyId, runDir, acMap);
      return true;
    }
    execFileSync("git", [...gitTarget, "commit", "-m", `chore: attach acceptance evidence for ${storyId}`], {
      cwd: ports.repoCwd,
      stdio: "ignore",
    });
    recordPendingDeliveryManifest(ports, ctx, storyId, runDir, acMap);
    return true;
  } catch (e) {
    ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: in-repo evidence commit failed — ${String(e)}`);
    return false;
  }
}

export async function publishBodyWithEvidenceTrailer(ports: Ports, ctx: CycleContext): Promise<string | null> {
  const base = publishBody(ctx);
  const storyId = ctx.storyId ?? "";
  if (storyId === "") return base;
  if (rollEvidenceLayout(ports.repoCwd) === "in-repo") {
    return (await commitInRepoEvidence(ports, ctx, storyId)) ? base : null;
  }
  const message = `chore: loop cycle ${ctx.cycleId}${storyId !== "" ? ` ${storyId}` : ""} evidence`;
  try {
    const committed = await ports.metadata.commit(ports.repoCwd, message);
    if (!committed.nothingToCommit && !committed.pushed) {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `.roll evidence push FAILED before publish for cycle ${ctx.cycleId}${committed.committed ? " (committed locally, not pushed)" : ""} — ${committed.error ?? "unknown error"}`,
      );
      return null;
    }
    const rollDir = join(ports.repoCwd, ".roll");
    if (!existsSync(rollDir)) {
      ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: .roll git repo missing`);
      return null;
    }
    const rollReal = realpathSync(rollDir);
    const sha = execFileSync("git", ["-C", rollReal, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const map = relative(rollReal, acMapPath(ports.repoCwd, storyId));
    if (sha === "" || map === "" || map.startsWith("..")) {
      ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: ac-map path is not inside roll-meta`);
      return null;
    }
    if (!rollMetaShaReachableOnOrigin(rollReal, sha)) {
      ports.events.appendAlert(ports.paths.alertsPath, `Roll-Evidence publish blocked for ${storyId}: roll-meta sha ${sha} is not reachable from origin`);
      return null;
    }
    return `${base}\n\nRoll-Evidence: ${storyId} roll-meta@${sha} ${map}`;
  } catch (e) {
    ports.events.appendAlert(ports.paths.alertsPath, `.roll evidence trailer failed for cycle ${ctx.cycleId} — ${String(e)}`);
    return null;
  }
}

export function storyRequiresManualMerge(repoCwd: string, storyId: string | undefined): boolean {
  if (storyId === undefined || storyId.trim() === "") return false;
  const needles = ["manual_merge", "manual-merge", "[roll:manual-merge]", "autofix"];
  const containsMarker = (text: string): boolean => {
    const lower = text.toLowerCase();
    return needles.some((n) => lower.includes(n));
  };
  try {
    const backlog = readFileSync(join(repoCwd, ".roll", "backlog.md"), "utf8");
    const row = parseBacklog(backlog).find((it) => it.id === storyId);
    if (row !== undefined && containsMarker(row.desc)) return true;
  } catch {
    /* absent backlog */
  }
  try {
    return containsMarker(readFileSync(join(cardArchiveDir(repoCwd, storyId), "spec.md"), "utf8"));
  } catch {
    return false;
  }
}

// ── US-RULE-004b — publish-gate doc-drift check ──────────────────────────────

/** Result of acquiring the cycle's changed-path set against its integration base. */
export type ChangedPathsResult =
  | { ok: true; paths: readonly string[] }
  | { ok: false; reason: "base-unresolved" | "diff-failed" };

/** Injectable seams for the publish-gate check (tests; production uses defaults). */
export interface PublishDocDriftGateSeam {
  /** Diagnostic locale (default en — the catalog carries both en and zh). */
  lang?: Lang;
  /** Where the soft-hit fact is appended (default `ports.paths.eventsPath`). */
  eventsPath?: string;
  /** Event store override (tests inject an in-memory store). */
  store?: EventStore;
  /** Wall-clock override for the recorded event. */
  ts?: number;
  /** Diagnostic sink (default: guarded process.stdout write). */
  stdout?: (s: string) => void;
  /** Changed-path acquisition override (default: real git vs integration base). */
  changedPaths?: () => ChangedPathsResult;
  /** Registry load + strict parse override (default: read tracked policy/rules.yaml). */
  registry?: () => Result<RulesRegistry, RulesParseError> | undefined;
}

/** The publish-gate doc-drift outcome. */
export interface PublishDocDriftGateResult {
  /** clean = no surface hit; hit = ≥1 surface changed without its docs; unresolved = unknown (fail-loud). */
  readonly mode: "clean" | "hit" | "unresolved";
  /** The registry's `gates.doc_drift` at publish time (absent when unresolved). */
  readonly gateMode?: "soft" | "hard";
  /** The integration base the changed-path set was computed against. */
  readonly baseline: string;
  readonly changedPaths: readonly string[];
  /** Stable hit identity ("" when clean/unresolved). */
  readonly hitId: string;
  /** true only when THIS attempt appended a new soft-hit fact (retries report false). */
  readonly appended: boolean;
  /** The locale-rendered bilingual diagnostic ("" when clean/unresolved). */
  readonly output: string;
  /** Fail-loud reason when mode === "unresolved". */
  readonly reason?: "registry-unresolved" | "base-unresolved" | "diff-failed";
  /** US-RULE-004b contract: soft NEVER blocks delivery — always false. */
  readonly blocked: false;
}

/**
 * Default changed-path acquisition: the cycle's delivery diff RELATIVE TO ITS
 * INTEGRATION BASE (`git diff --name-only -z <base>...HEAD` in the execution
 * worktree), never `HEAD~1` — a multi-commit cycle against HEAD~1 would see
 * only its last commit, and a base-only advance would be mis-blamed on the
 * cycle. The three-dot merge-base form is the PR's own diff, so the judge
 * sees exactly what the delivery will ship. Fail-loud: a missing base ref is
 * `base-unresolved`, any other git failure is `diff-failed` — callers must
 * never collapse either into an empty diff.
 */
export function defaultChangedPathsAgainstBase(worktreeCwd: string, baseRef: string): ChangedPathsResult {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: worktreeCwd,
      stdio: "pipe",
    });
  } catch {
    return { ok: false, reason: "base-unresolved" };
  }
  try {
    const out = execFileSync("git", ["diff", "--name-only", "-z", `${baseRef}...HEAD`], {
      cwd: worktreeCwd,
      encoding: "utf8",
    });
    const paths = (typeof out === "string" ? out : "")
      .split("\0")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    return { ok: true, paths };
  } catch {
    return { ok: false, reason: "diff-failed" };
  }
}

/**
 * Default registry load: the TRACKED `policy/rules.yaml` in the cycle worktree,
 * strictly parsed by the shared US-RULE-001 parser. `undefined` on an unreadable
 * file; `{ok:false}` on a strict-parse rejection — both are fail-loud for the
 * caller, never a silently-empty registry.
 */
export function loadTrackedRulesRegistry(worktreeCwd: string): Result<RulesRegistry, RulesParseError> | undefined {
  try {
    return parseRulesRegistry(readFileSync(join(worktreeCwd, "policy", "rules.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * US-RULE-004b — the publish-gate doc-drift check, run ONCE per publish attempt
 * from the `publish_pr` terminal handler. It:
 *   1. acquires the cycle worktree's delivery diff RELATIVE TO ITS INTEGRATION
 *      BASE (never `HEAD~1`), submodule-aware (E4: the execution worktree/repo);
 *   2. loads + strictly parses the tracked registry `policy/rules.yaml`;
 *   3. calls the SHARED 004a verdict (`runDocDriftSoftCheck`) exactly once.
 *
 * SOFT NEVER BLOCKS: a hit records the stable `doc_drift_soft_hit` fact and
 * prints the bilingual-catalogued diagnostic, but `blocked` is always false —
 * publish continues with exit 0 (hard blocking semantics arrive with
 * US-RULE-006). UNKNOWN IS FAIL-LOUD: registry parse failure, a missing
 * integration base, or diff acquisition failure returns mode "unresolved" and
 * appends an ALERT — the unknown is never silently treated as "no drift", and
 * the shared verdict is never called on fabricated inputs.
 */
export function runPublishDocDriftGate(
  ports: Ports,
  ctx: CycleContext,
  seam?: PublishDocDriftGateSeam,
): PublishDocDriftGateResult {
  const worktreeCwd = resolveExecutionCwd(ports, ctx);
  const repoCwd = resolveExecutionRepoCwd(ports, ctx);
  const baseline = resolveIntegrationBranch(repoCwd);
  const lang = seam?.lang ?? "en";
  const emit = seam?.stdout ?? ((s: string): void => {
    try {
      process.stdout.write(s);
    } catch {
      /* a broken stdout must never block publish */
    }
  });

  const unresolved = (reason: "registry-unresolved" | "base-unresolved" | "diff-failed", detail: string): PublishDocDriftGateResult => {
    try {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `doc-drift gate (US-RULE-004b): ${reason} — ${detail} — publish NOT blocked, but the drift state is UNKNOWN and must not be read as "no drift" ` +
          `(cycle ${ctx.cycleId ?? "?"}${ctx.storyId !== undefined ? `, story ${ctx.storyId}` : ""})`,
      );
    } catch {
      /* alert write blip is observability loss, never a publish block */
    }
    return { mode: "unresolved", baseline, changedPaths: [], hitId: "", appended: false, output: "", reason, blocked: false };
  };

  // 1) delivery diff vs integration base — NOT HEAD~1.
  let changed: ChangedPathsResult;
  try {
    changed = (seam?.changedPaths ?? (() => defaultChangedPathsAgainstBase(worktreeCwd, baseline)))();
  } catch {
    changed = { ok: false, reason: "diff-failed" };
  }
  if (!changed.ok) {
    return unresolved(changed.reason, `could not determine the cycle's delivery diff against integration base "${baseline}" (worktree ${worktreeCwd})`);
  }

  // 2) the tracked registry (strictly parsed; unknown registry is fail-loud).
  let registry: Result<RulesRegistry, RulesParseError> | undefined;
  try {
    registry = (seam?.registry ?? (() => loadTrackedRulesRegistry(worktreeCwd)))();
  } catch {
    registry = undefined;
  }
  if (registry === undefined || !registry.ok) {
    return unresolved(
      "registry-unresolved",
      registry === undefined
        ? `policy/rules.yaml unreadable in ${worktreeCwd}`
        : `policy/rules.yaml rejected: ${registry.error.message}`,
    );
  }
  const { docSurfaces, gates } = registry.value;

  // 3) the SHARED 004a verdict — exactly once per publish attempt.
  const check = runDocDriftSoftCheck({
    changedPaths: changed.paths,
    surfaces: docSurfaces,
    cycleId: ctx.cycleId,
    storyId: ctx.storyId ?? "",
    baseline,
    lang,
    ts: seam?.ts ?? eventTs(ports),
    eventsPath: seam?.eventsPath ?? ports.paths.eventsPath,
    ...(seam?.store !== undefined ? { store: seam.store } : {}),
  });
  if (check.output !== "") emit(check.output);
  return {
    mode: check.verdict.hits.length > 0 ? "hit" : "clean",
    gateMode: gates.docDrift,
    baseline,
    changedPaths: check.verdict.changedPaths,
    hitId: check.hitId,
    appended: check.appended,
    output: check.output,
    blocked: false,
  };
}
