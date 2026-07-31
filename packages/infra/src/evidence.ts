/**
 * US-ATTEST-003 — evidence collector: sweep the HARD, machine-checkable facts
 * a finished story left behind and freeze them into `evidence.json`.
 *
 * roll philosophy split (design D7): the AI writes INTENT (which evidence backs
 * which AC — that's the attest skill's job); this module grabs FACTS only:
 *   - TCR commits naming the story (`git log --grep`, subject filter)
 *   - the latest CI run (`gh run list`, absent-gh tolerated → available:false)
 *   - an optional deploy URL HEAD probe (status code only, 5s budget, no body)
 *   - the `.roll/last-test-pass` proof (presence + age)
 *   - already-captured artifacts in the run dir (screenshots/*.png,
 *     evidence/*.txt — produced by the 004 dispatcher / Gate session)
 *
 * Every external touch goes through an injectable {@link EvidenceRun} so tests
 * fake git/gh/curl with recorders — no network, no real repo needed. The
 * collector NEVER throws: a failed probe degrades to its empty/absent shape
 * (the report renders what exists; missing evidence downgrades the AC to
 * Claimed — that's the report's red line, not an exception path).
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { CaptureIntentV2, CaptureReceiptV2 } from "@roll/spec";
import type {
  DeliveryCheckRun,
  DeliveryCiFact,
  DeliveryCiRecord,
  DeliveryPrFacts,
  EvidenceHealthFact,
  RequiredCheck,
  RequiredChecksSource,
} from "@roll/core";
import { isValidCiTarget, resolveDeliveryCi } from "@roll/core";
import { gh, ghAvailable } from "./github.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Result shape every runner returns (mirrors GitResult/GhResult). */
export interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process seam: tool ∈ git|gh|curl. */
export type EvidenceRun = (tool: "git" | "gh" | "curl", argv: readonly string[], cwd?: string) => Promise<RunOut>;

const defaultRun: EvidenceRun = async (tool, argv, cwd) => {
  if (tool === "gh") return gh(argv);
  try {
    const { stdout, stderr } = await execFileAsync(tool, [...argv], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

export interface TcrCommit {
  hash: string;
  subject: string;
}

export interface EvidenceManifest {
  story_id: string;
  collected_at: string;
  tcr_commits: TcrCommit[];
  /**
   * LEGACY lane: the repository's most recent workflow run (`gh run list`). It is
   * NOT this card's CI evidence — kept for back-compat only. US-EVID-033: read
   * `delivery_ci` for the card-level truth.
   */
  ci: { available: boolean; url: string; conclusion: string };
  /**
   * US-EVID-033 — THIS card's delivery-time CI truth: the checks that ran on its
   * own PR's head sha before it merged. Additive: legacy readers ignore the key.
   * Absent only when the collector was given no delivery record to resolve.
   */
  delivery_ci?: DeliveryCiFact;
  deploy: { url: string; status: number; ok: boolean } | null;
  test_pass: { present: boolean; age_seconds: number };
  screenshots: string[];
  texts: string[];
  captures: CaptureFact[];
  capture_command: CaptureCommandFact | null;
  /**
   * US-PHYSICAL-009 — accepted Capture Gateway v2 receipts. Additive: legacy
   * readers ignore this key. Each fact preserves the receipt identity, source
   * class, PNG digest, and surface/AC binding across the package boundary.
   */
  capture_receipts: CaptureReceiptFact[];
  /**
   * US-EVID-031 — resolved visual-evidence health per declared surface, kept
   * SEPARATE from the delivery verdict so a broken capture machine cannot force a
   * completed story to be rebuilt (AC5, machine-readable). Additive: legacy
   * readers ignore this key; absent when no v2 surface was declared.
   */
  evidence_health?: EvidenceHealthFact[];
}

/**
 * US-PHYSICAL-009 — a v2 receipt frozen into the run manifest. `screenshotPath`
 * is stored relative to the run dir so the report attachment path resolves the
 * same PNG the receipt digested.
 */
export interface CaptureReceiptFact {
  protocol: string;
  requestId: string;
  storyId: string;
  runId: string;
  surfaceId: string;
  source: string;
  captureClass: string;
  state: string;
  screenshotPath?: string;
  sha256?: string;
  finalUrl?: string;
  expectedAcIds: string[];
  captureSetId?: string;
  accepted: boolean;
}

export interface CaptureFact {
  kind: string;
  out: string;
  taken: boolean;
  skipped?: string;
  failed?: boolean;
  error?: string;
}

export interface CaptureCommandFact {
  command: string;
  wrappedCommand: string;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  /** FIX-1484: on failure, full redacted streams persisted under the run dir
   *  (paths relative to it); the capped tails above stay display-only. */
  outputDump?: { stdout?: string; stderr?: string };
}

export interface CollectOptions {
  storyId: string;
  /** Project root (git cwd + .roll/last-test-pass location). */
  projectPath: string;
  /** This attest run's dir — `screenshots/` + `evidence/` live under it. */
  runDir: string;
  /** Optional deploy URL → one HEAD probe. */
  deployUrl?: string;
  /** Clock (ISO string), injected so manifests are reproducible in tests. */
  now: () => string;
  run?: EvidenceRun;
  ghProbe?: () => Promise<boolean>;
  captures?: readonly CaptureFact[];
  captureCommand?: CaptureCommandFact | null;
  /** US-PHYSICAL-009 — accepted v2 receipt facts to freeze into the manifest. */
  captureReceipts?: readonly CaptureReceiptFact[];
  /** US-EVID-031 — resolved visual-evidence health per declared surface. */
  evidenceHealth?: readonly EvidenceHealthFact[];
  /**
   * US-EVID-033 — this card's delivery record (PR number + merge sha), projected
   * from the delivery ledger by the caller. Given a PR number, the collector
   * queries that PR's head-sha checks and freezes the resulting `delivery_ci`
   * fact. Absent ⇒ the lane is omitted (never faked).
   */
  deliveryRecord?: DeliveryCiRecord;
  /** Owner/repo slug for the checks query; resolved from the remote when absent. */
  repoSlug?: string;
}

/**
 * US-PHYSICAL-009 — build a manifest fact from a v2 receipt + its intent,
 * preserving source class, digest, and surface/AC binding. `runDir` (when
 * given) rewrites an accepted screenshot to a run-relative attachment path.
 */
export function captureReceiptFact(
  receipt: CaptureReceiptV2,
  intent: CaptureIntentV2,
  opts: { runDir?: string; accepted: boolean; captureSetId?: string },
): CaptureReceiptFact {
  const screenshotPath =
    receipt.screenshotPath !== undefined
      ? opts.runDir !== undefined && isAbsolute(receipt.screenshotPath)
        ? relative(opts.runDir, receipt.screenshotPath)
        : receipt.screenshotPath
      : undefined;
  return {
    protocol: receipt.protocol,
    requestId: receipt.requestId,
    storyId: receipt.storyId,
    runId: receipt.runId,
    surfaceId: receipt.surfaceId,
    source: receipt.source,
    captureClass: receipt.captureClass,
    state: receipt.state,
    ...(screenshotPath !== undefined ? { screenshotPath } : {}),
    ...(receipt.sha256 !== undefined ? { sha256: receipt.sha256 } : {}),
    ...(receipt.finalUrl !== undefined ? { finalUrl: receipt.finalUrl } : {}),
    expectedAcIds: [...intent.surface.expectedAcIds],
    ...(opts.captureSetId !== undefined ? { captureSetId: opts.captureSetId } : {}),
    accepted: opts.accepted,
  };
}

export interface EvidenceFrame {
  runDir: string;
  evidenceDir: string;
  screenshotsDir: string;
}

export interface OpenEvidenceFrameOptions {
  /** Absolute or project-relative story run dir, e.g. `.roll/features/<epic>/<ID>/<run-id>`. */
  runDir: string;
}

/**
 * US-EVID-001 — open the cycle evidence frame before the agent runs.
 * Idempotent by design: resuming a PAUSEd/crashed cycle reuses the same frame
 * and never clears evidence already deposited by earlier phases.
 */
export function openEvidenceFrame(opts: OpenEvidenceFrameOptions): EvidenceFrame {
  const frame = {
    runDir: opts.runDir,
    evidenceDir: join(opts.runDir, "evidence"),
    screenshotsDir: join(opts.runDir, "screenshots"),
  };
  mkdirSync(frame.evidenceDir, { recursive: true });
  mkdirSync(frame.screenshotsDir, { recursive: true });
  return frame;
}

/**
 * US-EVID-033 — owner/repo slug from the git remote, so the checks query targets
 * the card's own repository. Returns "" when it cannot be determined (→ the lane
 * degrades to `unknown`, never to a pass).
 */
async function resolveRepoSlug(run: EvidenceRun, cwd: string): Promise<string> {
  const r = await run("git", ["remote", "get-url", "origin"], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (r.code !== 0) return "";
  const m = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m?.[1] ?? "";
}

/** Sweep all sources; never throws — failures degrade to absent shapes. */
export async function collectEvidence(opts: CollectOptions): Promise<EvidenceManifest> {
  const run = opts.run ?? defaultRun;
  const ghOk = await (opts.ghProbe ?? ghAvailable)().catch(() => false);

  // 1. TCR commits naming the story (subject filter on top of the tcr: grep —
  //    --grep matches either pattern, so the storyId filter is done here).
  const tcr: TcrCommit[] = [];
  const log = await run(
    "git",
    ["log", "--format=%H%x09%s", "--grep=^tcr:", "-n", "200"],
    opts.projectPath,
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (log.code === 0) {
    for (const line of log.stdout.split("\n")) {
      const [hash, subject = ""] = line.split("\t");
      if (hash !== undefined && hash !== "" && subject.includes(opts.storyId)) {
        tcr.push({ hash, subject });
      }
    }
  }

  // 2. Latest CI run (best-effort; gh-missing is a first-class shape).
  let ci = { available: false, url: "", conclusion: "" };
  if (ghOk) {
    const r = await run("gh", ["run", "list", "--limit", "1", "--json", "url,conclusion"], opts.projectPath).catch(
      () => ({ code: 1, stdout: "", stderr: "" }),
    );
    if (r.code === 0) {
      try {
        const arr = JSON.parse(r.stdout) as Array<{ url?: string; conclusion?: string }>;
        const first = arr[0];
        if (first !== undefined) {
          ci = { available: true, url: first.url ?? "", conclusion: first.conclusion ?? "" };
        }
      } catch {
        /* malformed → stays unavailable */
      }
    }
  }

  // 2b. US-EVID-033 — THIS card's delivery-time CI truth. Only attempted when the
  //     caller resolved a delivery record; the classification (verified/red/
  //     unknown+reason) is the pure core resolver's, so a probe failure can never
  //     be mistaken for a pass.
  let deliveryCi: DeliveryCiFact | undefined;
  if (opts.deliveryRecord !== undefined) {
    let checks: DeliveryCheckRun[] | undefined;
    // Completeness is EARNED: every page of check-runs plus the legacy commit
    // statuses must read cleanly. Anything short of that and the fact degrades to
    // unknown, because a red could be hiding outside the window (codex r1).
    let checksComplete: boolean | undefined;
    let prFacts: DeliveryPrFacts | undefined;
    let baseRef: string | undefined;
    let requiredChecks: RequiredCheck[] | undefined;
    let requiredChecksKnown: boolean | undefined;
    let requiredChecksSource: RequiredChecksSource | undefined;
    let mergedByQueue = false;
    const pr = opts.deliveryRecord.prNumber;
    const slug = ghOk && pr !== undefined ? (opts.repoSlug ?? (await resolveRepoSlug(run, opts.projectPath))) : "";
    const targetValid =
      slug !== "" && isValidCiTarget({ repoSlug: slug, ...(pr !== undefined ? { prNumber: pr } : {}) });
    if (ghOk && pr !== undefined && targetValid) {
      // The PR carries the authoritative head sha the checks ran on, whether it
      // merged, which merge commit it produced, and when — all four are needed
      // before any check can be attributed to this card.
      const prRes = await run(
        "gh",
        [
          "api",
          `repos/${slug}/pulls/${pr}`,
          "--jq",
          "{head:.head.sha,merged:.merged,merge_commit_sha:.merge_commit_sha,merged_at:.merged_at,base:.base.ref,merged_by:(.merged_by.login // \"\")}",
        ],
        opts.projectPath,
      ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      if (prRes.code === 0) {
        try {
          const parsed = JSON.parse(prRes.stdout) as {
            head?: string;
            merged?: boolean;
            merge_commit_sha?: string | null;
            merged_at?: string | null;
            base?: string | null;
            merged_by?: string | null;
          };
          if (typeof parsed.base === "string" && parsed.base !== "") baseRef = parsed.base;
          // Codex r4: a merge-queue delivery ran its required checks on the
          // synthetic merge-group sha, NOT this PR's head — so the head's checks
          // are not the delivery's required checks. Detected (not merely
          // documented) and refused.
          mergedByQueue = typeof parsed.merged_by === "string" && /^github-merge-queue/i.test(parsed.merged_by);
          const mergedAt =
            typeof parsed.merged_at === "string" && parsed.merged_at !== "" ? Date.parse(parsed.merged_at) : NaN;
          prFacts = {
            merged: parsed.merged === true,
            ...(typeof parsed.head === "string" && parsed.head !== "" ? { headSha: parsed.head } : {}),
            ...(typeof parsed.merge_commit_sha === "string" && parsed.merge_commit_sha !== ""
              ? { mergeCommitSha: parsed.merge_commit_sha }
              : {}),
            ...(Number.isFinite(mergedAt) ? { mergedAtMs: mergedAt } : {}),
          };
        } catch {
          /* malformed → prFacts stays undefined → unknown:pr_unavailable */
        }
      }
      const sha = prFacts?.headSha ?? opts.deliveryRecord.headSha;
      if (sha !== undefined && sha !== "" && isValidCiTarget({ sha })) {
        const collected: DeliveryCheckRun[] = [];
        // `--paginate` exhausts every page: a red beyond the default 30-item page
        // can no longer be missed.
        const chRes = await run(
          "gh",
          [
            "api",
            "--paginate",
            `repos/${slug}/commits/${sha}/check-runs`,
            "--jq",
            '.check_runs[] | [.name, .conclusion // "", .completed_at // "", ((.app.id // "") | tostring)] | @tsv',
          ],
          opts.projectPath,
        ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        // Legacy commit statuses are a SEPARATE surface from check-runs; a red
        // status would otherwise be invisible here.
        const stRes = await run(
          "gh",
          [
            "api",
            "--paginate",
            `repos/${slug}/commits/${sha}/statuses`,
            "--jq",
            '.[] | [.context, .state, .updated_at // ""] | @tsv',
          ],
          opts.projectPath,
        ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        const parseTsv = (stdout: string, mapState: (s: string) => string): void => {
          for (const line of stdout.split("\n")) {
            if (line.trim() === "") continue;
            const [name = "", raw = "", finishedAt = "", appId = ""] = line.split("\t");
            if (name === "") continue;
            const app = appId !== "" ? Number(appId) : NaN;
            // US-EVID-033 (codex r2): the finish time decides whether a green is
            // delivery-time evidence or a post-merge rerun. Unparseable ⇒ omitted,
            // and the resolver then refuses to verify.
            const t = finishedAt !== "" ? Date.parse(finishedAt) : NaN;
            collected.push({
              name,
              conclusion: mapState(raw),
              ...(Number.isFinite(t) ? { completedAtMs: t } : {}),
              ...(Number.isFinite(app) ? { appId: app } : {}),
            });
          }
        };
        if (chRes.code === 0) parseTsv(chRes.stdout, (s) => s);
        if (stRes.code === 0) {
          // Commit-status states → check conclusions: error/failure are red,
          // success is success, pending stays "" (unproven).
          parseTsv(stRes.stdout, (s) =>
            s === "success" ? "success" : s === "failure" || s === "error" ? "failure" : "",
          );
        }
        if (chRes.code === 0 || stRes.code === 0) checks = collected;
        checksComplete = chRes.code === 0 && stRes.code === 0;
      }
      // The BRANCH decides what green means (codex r2). A 404 "Branch not
      // protected" is a real answer (no required checks); any other failure leaves
      // the required set unknown, and the resolver refuses to verify.
      if (baseRef !== undefined && /^[A-Za-z0-9._\/-]+$/.test(baseRef)) {
        const parseRequired = (stdout: string): RequiredCheck[] => {
          const out: RequiredCheck[] = [];
          for (const line of stdout.split("\n")) {
            if (line.trim() === "") continue;
            const [context = "", appId = ""] = line.split("\t");
            if (context === "") continue;
            const app = appId !== "" ? Number(appId) : NaN;
            out.push({ context, ...(Number.isFinite(app) ? { appId: app } : {}) });
          }
          // GitHub reports the same requirement in BOTH shapes (`.contexts` without
          // an app, `.checks[]` with one). Keep one entry per context, preferring the
          // App-pinned form — the stricter of the two.
          const byContext = new Map<string, RequiredCheck>();
          for (const req of out) {
            const seen = byContext.get(req.context);
            if (seen === undefined || (seen.appId === undefined && req.appId !== undefined)) {
              byContext.set(req.context, req);
            }
          }
          return [...byContext.values()];
        };
        const reqRes = await run(
          "gh",
          [
            "api",
            `repos/${slug}/branches/${baseRef}/protection/required_status_checks`,
            "--jq",
            // Both shapes: the legacy `.contexts` string list and `.checks[]`, whose
            // `app_id` PINS which App must produce the check (codex r3).
            '[((.contexts // [])[] | {context: ., app_id: null}), ((.checks // [])[])] | .[] | [.context, ((.app_id // "") | tostring)] | @tsv',
          ],
          opts.projectPath,
        ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        // Rulesets LAYER on top of branch protection (codex r4) — they are not an
        // either/or. Both surfaces are read every time and the requirement sets are
        // UNIONed; if either read fails for a reason other than "not protected",
        // the requirement set is unknown.
        const ruleRes = await run(
          "gh",
          [
            "api",
            "--paginate",
            `repos/${slug}/rules/branches/${baseRef}`,
            "--jq",
            '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]? | [.context, ((.integration_id // "") | tostring)] | @tsv',
          ],
          opts.projectPath,
        ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        const protectionOk = reqRes.code === 0;
        const notProtected = reqRes.code !== 0 && /not protected/i.test(reqRes.stderr);
        const rulesOk = ruleRes.code === 0;
        if ((protectionOk || notProtected) && rulesOk) {
          const fromProtection = protectionOk ? parseRequired(reqRes.stdout) : [];
          const fromRules = parseRequired(ruleRes.stdout);
          requiredChecks = parseRequired(
            [...fromProtection, ...fromRules]
              .map((r) => `${r.context}\t${r.appId ?? ""}`)
              .join("\n"),
          );
          requiredChecksKnown = true;
          requiredChecksSource =
            requiredChecks.length === 0
              ? "none_declared"
              : fromProtection.length > 0 && fromRules.length > 0
                ? "protection+ruleset"
                : fromRules.length > 0
                  ? "ruleset"
                  : "protection";
        } else {
          requiredChecksKnown = false;
          requiredChecksSource = "unknown";
        }
      }
    }
    deliveryCi = resolveDeliveryCi({
      record: opts.deliveryRecord,
      ...(prFacts !== undefined ? { pr: prFacts } : {}),
      checks,
      checksComplete,
      mergedByQueue,
      ...(requiredChecks !== undefined ? { requiredChecks } : {}),
      requiredChecksKnown,
      ...(requiredChecksSource !== undefined ? { requiredChecksSource } : {}),
      ghAvailable: ghOk,
      targetValid: ghOk && pr !== undefined ? targetValid : undefined,
      collectedAt: opts.now(),
    });
  }

  // 3. Deploy URL HEAD probe (status code only; 5s budget; never throws).
  let deploy: EvidenceManifest["deploy"] = null;
  if (opts.deployUrl !== undefined && opts.deployUrl !== "") {
    const r = await run(
      "curl",
      ["-sI", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", opts.deployUrl],
      opts.projectPath,
    ).catch(() => ({ code: 1, stdout: "000", stderr: "" }));
    const status = Number((r.stdout || "0").trim()) || 0;
    deploy = { url: opts.deployUrl, status, ok: r.code === 0 && status >= 200 && status < 400 };
  }

  // 4. Commit-gate proof.
  let testPass = { present: false, age_seconds: -1 };
  const proof = join(opts.projectPath, ".roll", "last-test-pass");
  if (existsSync(proof)) {
    try {
      const age = Math.max(0, Math.round((Date.parse(opts.now()) - statSync(proof).mtimeMs) / 1000));
      testPass = { present: true, age_seconds: age };
    } catch {
      testPass = { present: true, age_seconds: -1 };
    }
  }

  // 5. Already-captured artifacts in this run dir.
  const listDir = (sub: string, ext: RegExp): string[] => {
    const dir = join(opts.runDir, sub);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => ext.test(f))
        .sort()
        .map((f) => `${sub}/${f}`);
    } catch {
      return [];
    }
  };

  return {
    story_id: opts.storyId,
    collected_at: opts.now(),
    tcr_commits: tcr,
    ci,
    ...(deliveryCi !== undefined ? { delivery_ci: deliveryCi } : {}),
    deploy,
    test_pass: testPass,
    screenshots: listDir("screenshots", /\.png$/i),
    texts: listDir("evidence", /\.(txt|log)$/i),
    captures: [...(opts.captures ?? [])],
    capture_command: opts.captureCommand ?? null,
    capture_receipts: [...(opts.captureReceipts ?? [])],
    ...(opts.evidenceHealth !== undefined && opts.evidenceHealth.length > 0
      ? { evidence_health: [...opts.evidenceHealth] }
      : {}),
  };
}

/** Write `evidence.json` (stable 2-space layout) into the run dir. */
export function writeEvidenceJson(manifest: EvidenceManifest, runDir: string): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "evidence.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}
