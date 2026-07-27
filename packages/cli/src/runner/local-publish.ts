/**
 * E3 — local-only delivery (`publish_mode: local`) + the shared push-time
 * evidence gate.
 *
 * Split out of terminal-handlers.ts (REFACTOR-060 module-size guard) so the
 * local-delivery ladder has its own testable home. Two exports:
 *
 *   - {@link evaluateEvidenceGate}: the US-DELIV-004 push-time evidence gate,
 *     shared by BOTH the remote publish path (terminal-handlers `publish_pr`)
 *     and the local landing path here. Extracting it is what lets local mode run
 *     the SAME gate with the SAME fail-loud semantics — the E3 constraint that
 *     "not publishing" must never mean "skip the evidence gate".
 *   - {@link executeLocalPublish}: the local landing path — gate, then land the
 *     cycle HEAD onto the LOCAL integration branch (no push / PR / CI), then
 *     record `delivery:reconciled{delivered_local}` + a done DeliveryRecord.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  acBlockPresentInSpec,
  appendDelivery,
  BrowserOperationLedger,
  captureLinksFromBrowserEvents,
  evaluateFullVerify,
  evidenceGateBeforePush,
  nodeDeliveryStore,
  type CycleCommand,
  type CycleContext,
  type PublishResult,
} from "@roll/core";
import { absent, present, type EvidenceClassifierInput } from "@roll/spec";
import { resolveIntegrationBranch, submoduleWorktreePath } from "@roll/infra";
import { acMapCandidates, storySpecPath, verificationReportFresh } from "./attest-gate.js";
import type { ExecuteResult, Ports } from "./ports.js";
import { eventTs } from "./runner-time.js";

/**
 * US-DELIV-004 — the push-time evidence gate, shared by the REMOTE publish path
 * and the E3 LOCAL landing path. Verifies the acceptance evidence (attest report
 * + ac-map) was produced BEFORE the work leaves the cycle; appends the
 * `delivery:evidence_gate` event (earned/blocked) and, on a block, the fail-loud
 * ALERT. Returns `true` when the gate is EARNED (proceed), `false` when BLOCKED.
 */
/** Default proof read: `<worktree>/.roll/last-test-pass`; unreadable ⇒ undefined (fail-closed). */
function defaultReadProofBody(worktreePath: string): string | undefined {
  try {
    return readFileSync(join(worktreePath, ".roll", "last-test-pass"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Default delivered-tree hash: `git write-tree` in the worktree — the SAME
 * computation the proof-writer (`roll test` / test-ts.sh) records, so a clean,
 * fully-committed cycle reproduces the proof's tree exactly. Any git error ⇒ `""`
 * ⇒ {@link evaluateFullVerify} fails closed (never a fabricated match).
 */
function defaultReadHeadTree(worktreePath: string): string {
  try {
    const r = spawnSync("git", ["write-tree"], { cwd: worktreePath, encoding: "utf8" });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

export function evaluateEvidenceGate(ports: Ports, ctx: CycleContext, gateStoryId: string): boolean {
  // FIX-1256: share the "does this story owe an acceptance report?" decision
  // with the attest gate. A card without an `**AC:**` block owes neither report
  // nor ac-map, so the evidence gate aligns with the attest gate's verdict.
  let acceptanceReportRequired = true;
  const specPath = storySpecPath(ports.paths.worktreePath, gateStoryId);
  if (specPath !== null) {
    try {
      acceptanceReportRequired = acBlockPresentInSpec(readFileSync(specPath, "utf8"), gateStoryId);
    } catch {
      /* unreadable spec → fail-closed: require evidence */
    }
  }
  const evidenceGate = evidenceGateBeforePush({
    attestReportPresent: verificationReportFresh(ports.paths.worktreePath, gateStoryId, undefined, ports.repoCwd),
    acMapPresent: acMapCandidates(ports.paths.worktreePath, gateStoryId, ports.repoCwd).some((p) => existsSync(p)),
    acceptanceReportRequired,
    visualEvidence: captureBridgeArtifacts(ports.paths.worktreePath, gateStoryId),
  });
  const unverified = acceptanceReportRequired
    ? unverifiedAcceptanceCriteria(acMapCandidates(ports.paths.worktreePath, gateStoryId, ports.repoCwd))
    : [];
  // US-CYCLE-011 — round-tail / pre-PR full-verify gate, layered ON TOP of the
  // acceptance-evidence checks and INDEPENDENT of acceptanceReportRequired: even a
  // no-AC code change must carry a FRESH full-suite proof (`mode:"full"`) whose
  // tree equals the delivered tree before a PR/publish is allowed. Doc-only and
  // story-less publishes never reach here (both call sites guard docOnly / empty
  // storyId), so the per-commit --changed gate stays untouched and honest doc PRs
  // are unaffected. FAIL-CLOSED: a missing / malformed / changed-mode / stale /
  // tree-mismatched proof BLOCKS — the AC4 backstop no `--changed` selection can
  // bypass (a wrongly-empty affected set never mints a full-mode proof).
  const readProofBody = ports.fullVerify?.proofBody ?? defaultReadProofBody;
  const readHeadTree = ports.fullVerify?.deliveredTree ?? defaultReadHeadTree;
  const fullVerify = evaluateFullVerify(
    readProofBody(ports.paths.worktreePath),
    readHeadTree(ports.paths.worktreePath),
    ports.clock(),
  );
  const evidenceReasons = [
    ...(evidenceGate.ok ? [] : evidenceGate.reasons),
    ...unverified,
    ...(fullVerify.ok ? [] : [`full-verify (US-CYCLE-011): ${fullVerify.reason}`]),
  ];
  const gate = evidenceReasons.length === 0
    ? ({ ok: true as const })
    : { ok: false as const, reasons: evidenceReasons };
  // Best-effort like every other appendEvent in this handler: an events-file
  // write blip is observability loss, never a publish block.
  try {
    ports.events.appendEvent(ports.paths.eventsPath, {
      type: "delivery:evidence_gate",
      cycleId: ctx.cycleId ?? "",
      storyId: gateStoryId,
      verdict: gate.ok ? "earned" : "blocked",
      reasons: gate.ok ? [] : [...gate.reasons],
      ts: eventTs(ports),
    });
  } catch {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `US-DELIV-004: delivery:evidence_gate append failed for ${gateStoryId} (cycle ${ctx.cycleId ?? "?"})`,
    );
  }
  if (!gate.ok) {
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `evidence gate (US-DELIV-004): publish BLOCKED for ${gateStoryId} (cycle ${ctx.cycleId ?? "?"}) — ${gate.reasons.join("; ")} — branch NOT pushed, no PR opened (blocked_no_evidence; fail-loud, zero-TCR class)`,
    );
    return false;
  }
  return true;
}

function unverifiedAcceptanceCriteria(candidates: readonly string[]): string[] {
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) return [];

  try {
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0) {
      return ["ac-map has no verified acceptance criteria"];
    }
    const unresolved = rows.flatMap((row) => {
      if (typeof row !== "object" || row === null) return ["ac-map contains an invalid acceptance row"];
      const record = row as { ac?: unknown; status?: unknown };
      const status = typeof record.status === "string" ? record.status : "missing status";
      if (status === "pass" || status === "pass-with-evidence" || status === "readonly") return [];
      const ac = typeof record.ac === "string" && record.ac.trim() !== "" ? record.ac : "unknown AC";
      return [`unverified acceptance criteria: ${ac} (${status})`];
    });
    return unresolved;
  } catch {
    return ["ac-map is unreadable"];
  }
}

/**
 * E3 — the LOCAL-only delivery path (`publish_mode: local`). Runs the SAME
 * evidence gate as remote (fail-loud); on a gate-block it returns the identical
 * `gateBlocked` PublishResult the remote path returns (→ blocked_no_evidence,
 * needs_review terminal). On an EARNED gate it lands the cycle worktree HEAD
 * onto the LOCAL integration branch (no push / no PR / no CI — see
 * `landLocalDelivery`), then records the delivery as done:
 *   - `delivery:reconciled{state:"delivered_local", mergeCommit:<local sha>}` —
 *     the authoritative delivery fact (projection → terminal `delivered_local`).
 *   - a `DeliveryRecord{lifecycleState:"done", prNumber/prUrl absent, mergeCommit}`
 *     best-effort cache warm (same pattern as the remote publish path).
 * Returns a status-0 PublishResult (cycle success → classifyPublish → `done`).
 *
 * A landing FAILURE (conflict / git error) is fail-loud: it returns a status-1
 * result (→ `local`/unpublished terminal, worktree preserved for recovery) and
 * alerts — it NEVER pretends a failed landing delivered.
 */
export async function executeLocalPublish(
  cmd: Extract<CycleCommand, { kind: "publish_pr" }>,
  ports: Ports,
  ctx: CycleContext,
  manualMerge: boolean,
): Promise<ExecuteResult> {
  // Evidence gate FIRST — not publishing does NOT mean skipping the gate.
  const gateStoryId = ctx.storyId ?? "";
  if (gateStoryId !== "" && cmd.docOnly !== true) {
    if (!evaluateEvidenceGate(ports, ctx, gateStoryId)) {
      const pub: PublishResult = {
        status: 1,
        manualMerge,
        gateBlocked: true,
        ...(cmd.draft === true ? { draft: true } : {}),
      };
      return { event: { type: "published", result: pub } };
    }
  }

  // Resolve WHERE the landing happens. E2 (submodule-aware delivery): when the
  // story declares a target_submodule, the delivery targets the SUBMODULE's own
  // repo + integration branch, not the superproject — so the user's real
  // submodule checkout sees the local integration branch advance (decision #1).
  // No target_submodule → the superproject path (E3), byte-identical.
  const target = resolveLandingTarget(ports, ctx);
  // Land the cycle HEAD onto the LOCAL integration branch (E1's configured
  // branch, minus any origin/ prefix). No remote interaction whatsoever.
  const integrationBranch = resolveIntegrationBranch(target.repoCwd);
  const landing = await ports.git.landLocalDelivery(target.repoCwd, target.worktreeCwd, integrationBranch);
  if (landing.code !== 0) {
    // Fail-loud: the landing did not complete → treat as an unpublished local
    // cycle (worktree preserved for recovery), never a false delivery.
    ports.events.appendAlert(
      ports.paths.alertsPath,
      `publish_mode=local: landing onto ${landing.landedBranch} FAILED for ${gateStoryId} (cycle ${ctx.cycleId ?? "?"}) — ${landing.stderr.trim()} — work committed in worktree, NOT delivered`,
    );
    const pub: PublishResult = { status: 1, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
    return { event: { type: "published", result: pub } };
  }

  // The local delivery fact — the authoritative event (projection →
  // delivered_local). No delivery:published: that is the REMOTE awaiting_merge
  // fact and there is no PR here.
  if (ctx.storyId !== undefined && ctx.cycleId !== undefined) {
    try {
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "delivery:reconciled",
        cycleId: ctx.cycleId,
        storyId: ctx.storyId,
        state: "delivered_local",
        mergedBy: "runner",
        mergeCommit: landing.sha,
        signal: "patch_id",
        ts: eventTs(ports),
      });
    } catch {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `E3: delivery:reconciled{delivered_local} append failed for ${ctx.storyId} (cycle ${ctx.cycleId})`,
      );
    }
    // Best-effort DeliveryRecord cache warm (same as the remote path). The PR
    // fields are ABSENT with a `local_only` reason — there is no PR.
    try {
      appendDelivery(nodeDeliveryStore, ports.repoCwd, {
        storyId: ctx.storyId,
        cycleId: ctx.cycleId,
        lifecycleState: "done",
        prNumber: absent("local_only"),
        prUrl: absent("local_only"),
        mergedAt: present(ports.clock()),
        mergeCommit: present(landing.sha),
        recordedAt: ports.clock(),
      });
    } catch {
      ports.events.appendAlert(
        ports.paths.alertsPath,
        `E3: appendDelivery(delivered_local) failed for ${ctx.storyId} (cycle ${ctx.cycleId})`,
      );
    }
  }

  // status 0 → classifyPublish → done (cycle success). No manualMerge draft
  // path applies locally; carry it through for parity but it never changes the
  // status-0 done classification.
  const pub: PublishResult = { status: 0, manualMerge, ...(cmd.draft === true ? { draft: true } : {}) };
  return { event: { type: "published", result: pub } };
}

/**
 * E2 — resolve the local-landing target (which repo owns the integration branch,
 * and which worktree HEAD is the delivery). Default = the superproject
 * (`ports.repoCwd` + `ports.paths.worktreePath`), byte-identical to E3. When the
 * picked story declared a `target_submodule` (threaded via {@link CycleContext}),
 * both are redirected INTO the submodule:
 *   - repoCwd     → `<superproject>/<submodule>` (owns the submodule's local
 *                   integration branch — the ref `landLocalDelivery` moves).
 *   - worktreeCwd → the submodule's cycle worktree
 *                   ({@link submoduleWorktreePath} — the sibling `*.submodules/`
 *                   dir of the canonical cycle path, E5) whose detached HEAD is
 *                   the cycle commit.
 * The integration branch is then resolved from the SUBMODULE's own config
 * (E1 `resolveIntegrationBranch(<submodule path>)`), so a submodule configured
 * with `feat/contractor2.0` lands there while the superproject keeps its own.
 */
function resolveLandingTarget(ports: Ports, ctx: CycleContext): { repoCwd: string; worktreeCwd: string } {
  const sub = ctx.targetSubmodule;
  if (sub === undefined || sub === "") {
    return { repoCwd: ports.repoCwd, worktreeCwd: ports.paths.worktreePath };
  }
  return {
    repoCwd: join(ports.repoCwd, sub),
    worktreeCwd: submoduleWorktreePath(ports.paths.worktreePath, sub),
  };
}

/** Read only the persisted CaptureBridge artifacts offered by this story's attest path. */
function captureBridgeArtifacts(projectPath: string, storyId: string): EvidenceClassifierInput[] {
  const eventsPath = join(projectPath, ".roll", "browser-operations", "events.ndjson");
  if (!existsSync(eventsPath)) return [];
  const links = captureLinksFromBrowserEvents(new BrowserOperationLedger().read(eventsPath));
  return links
    .filter((link) => link.storyId === storyId)
    .map((link) => ({
      artifactId: link.captureRequestId,
      provider: "roll-capture",
      protocol: "roll.capture.v1",
      ...(link.captureResponse !== undefined ? { captureResponse: link.captureResponse } : {}),
      ...(link.captureDigest !== undefined ? { digest: link.captureDigest } : {}),
    }));
}
