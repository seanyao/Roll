/**
 * @responsibility Orchestrates the golden-path showcase as a pure testable core.
 */
/**
 * US-SHOW-001 — the golden-path showcase orchestration core (pure + testable).
 *
 * `roll showcase` is roll's canonical end-to-end self-proof: against a throwaway
 * sandbox it resets the target card (US-DEMO-001) to Todo, casts a HETEROGENEOUS
 * trio of REAL agents (builder=kimi, reviewer=claude, scorer=pi), runs ONE
 * standard TCR loop via `roll loop go --cards US-DEMO-001`, captures fresh
 * per-AC CLI + web screenshots, assembles the full evidence chain, and emits a
 * single pass/fail verdict.
 *
 * This module is the DETERMINISTIC heart: casting validation, the agents.yaml
 * casting override text, evidence-chain assembly from a run-result, and the
 * verdict function are all pure (no clock / fs / process / network) so the unit
 * suite proves them with mocked run-results. The non-deterministic real-agent
 * step lives entirely behind `roll loop go`, which the command delegates to.
 *
 * Design discipline (mirrors the rest of the v3 core): no silent fallback. A
 * collapsed casting (reviewer==builder / scorer==builder, or a vendor clash)
 * fails LOUDLY; a missing evidence-chain link makes the verdict FAIL with the
 * exact reason — never a faked chain.
 */
import { heterogeneousByModel, isHeterogeneous } from "@roll/core";

/** The three real-agent roles the showcase casts (all distinct, heterogeneous). */
export interface ShowcaseCasting {
  /** Builds US-DEMO-001 via the standard TCR loop. */
  builder: string;
  /** Code review / adversarial spar in explicit strict-diversity showcase mode. */
  reviewer: string;
  /** Pairs the delivery score in explicit strict-diversity showcase mode. */
  scorer: string;
}

/** The default golden-path casting from the spec: all domestic agents. */
export const DEFAULT_SHOWCASE_CASTING: ShowcaseCasting = {
  builder: "kimi",
  reviewer: "reasonix",
  scorer: "pi",
};

/** The target card the showcase repeatedly re-delivers. */
export const SHOWCASE_TARGET_CARD = "US-DEMO-001";

/** A single failure reason in the casting / verdict checks. */
export interface CastingViolation {
  code: "reviewer-equals-builder" | "scorer-equals-builder" | "reviewer-not-hetero" | "scorer-not-hetero" | "empty-slot";
  message: string;
}

export interface CastingCheck {
  ok: boolean;
  violations: CastingViolation[];
}

/**
 * Validate that the casting is a genuine heterogeneous trio. Fails loudly (a
 * collapsed casting where the reviewer or scorer IS the builder, or shares the
 * builder's vendor, defeats the whole point of cross-agent verification). Pure:
 * names → check, no I/O. The command turns `ok:false` into a hard exit.
 */
export function validateCasting(
  casting: ShowcaseCasting,
  /** US-PAIR-015: agent → resolved model. Supplied → heterogeneity is judged on the
   *  MODEL's vendor, so a trio whose entries all resolve to one model is correctly
   *  rejected. Omitted → legacy name comparison (can over-count). */
  resolveModel?: (agent: string) => string,
): CastingCheck {
  const violations: CastingViolation[] = [];
  const { builder, reviewer, scorer } = casting;
  const hetero = (a: string, b: string): boolean =>
    resolveModel !== undefined ? heterogeneousByModel(b, a, resolveModel) : isHeterogeneous(a, b);

  for (const [role, name] of [["builder", builder], ["reviewer", reviewer], ["scorer", scorer]] as const) {
    if (name === undefined || name.trim() === "") {
      violations.push({ code: "empty-slot", message: `casting ${role} is empty — every role needs a real agent` });
    }
  }
  // Bail before the heterogeneity checks if any slot is empty (a "—" can't be
  // a vendor); the empty-slot violation already fired.
  if (violations.length > 0) return { ok: false, violations };

  if (reviewer === builder) {
    violations.push({ code: "reviewer-equals-builder", message: `strict-diversity showcase requires reviewer (${reviewer}) to differ from builder (${builder})` });
  } else if (!hetero(reviewer, builder)) {
    violations.push({
      code: "reviewer-not-hetero",
      message: `reviewer (${reviewer}) shares a vendor with builder (${builder}) — cross-agent review needs a different vendor`,
    });
  }
  if (scorer === builder) {
    violations.push({ code: "scorer-equals-builder", message: `strict-diversity showcase requires scorer (${scorer}) to differ from builder (${builder})` });
  } else if (!hetero(scorer, builder)) {
    violations.push({
      code: "scorer-not-hetero",
      message: `scorer (${scorer}) shares a vendor with builder (${builder}) — pair scoring needs a different vendor`,
    });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The agents.yaml the showcase writes into the sandbox so `roll loop go` routes
 * the BUILDER to the cast agent. The loop reads the executor slots (easy /
 * default / hard) from agents.yaml; pinning all three to the builder guarantees
 * the card — whatever complexity tier the picker assigns it — is built by the
 * cast builder, not whatever the operator's real ~/.roll happened to configure.
 *
 * Pure (casting → yaml text); the command writes it atomically into the sandbox.
 * reviewer/scorer are NOT executor slots — they are the heterogeneous peer the
 * loop auto-picks (review) and the pair-score agent; the showcase records them
 * in the report and asserts the trio is distinct, but the loop's own pairing
 * machinery picks the heterogeneous partner at runtime.
 */
export function castingAgentsYaml(casting: ShowcaseCasting): string {
  const b = casting.builder;
  return [
    "# Generated by `roll showcase` (US-SHOW-001) — sandbox casting override.",
    `# builder=${casting.builder} reviewer=${casting.reviewer} scorer=${casting.scorer}`,
    "# Throwaway: this file lives only in the showcase sandbox, never the real repo.",
    "schema: v3",
    `easy: { agent: ${b} }`,
    `default: { agent: ${b} }`,
    `hard: { agent: ${b} }`,
    "",
  ].join("\n");
}

// ── Evidence chain ───────────────────────────────────────────────────────────

/** A captured screenshot reference fed into the showcase report. */
export interface ShowcaseScreenshot {
  /** Surface the shot covers. */
  surface: "cli" | "web";
  /** Absolute path to the .png. */
  path: string;
  /** True iff the file exists and is non-empty (tool exit codes lie). */
  present: boolean;
  /** Honest skip reason when not taken (no GUI / no browser) — never faked. */
  skipped?: string;
}

/**
 * The raw result of the non-deterministic loop run + capture step, handed to the
 * pure assembler. The command fills this from `roll loop go`, the capture
 * subsystem, the attest gate, and the backlog/truth reads; the unit tests build
 * it from fixtures.
 */
export interface ShowcaseRunResult {
  casting: ShowcaseCasting;
  /** `roll loop go` exit status (0 = a cycle completed). */
  loopExit: number;
  /** TCR micro-commits the cycle produced (each carries a test-pass proof). */
  tcrCommits: { sha: string; subject: string; testPass: boolean }[];
  /** The delivery branch the cycle pushed (e.g. story/US-DEMO-001). */
  branch?: string;
  /** PR number/url when one was opened. */
  pr?: { number: number; url: string };
  /** Heterogeneous review record: who reviewed, who scored. */
  reviewRecord?: { reviewer: string; scorer: string; recorded: boolean };
  /** Fresh per-AC screenshots (CLI terminal + web Now badge). */
  screenshots: ShowcaseScreenshot[];
  /** The attest gate verdict for the target card after the run. */
  attest?: { gate: "PASS" | "SKIP" | "FAIL"; reportPath?: string };
  /** The target card's backlog status after merge ("Done" on success). */
  backlogStatus?: string;
  /** The card's delivery ladder rung in truth.json after the run. */
  truthLadder?: "claimed" | "merged" | "attested" | "none";
  /** The card ID as seen across surfaces (backlog / report / truth / branch). */
  sameNumber?: { backlog?: string; report?: string; truth?: string; branch?: string };
}

/** One assembled link in the evidence chain, with a present/absent verdict. */
export interface EvidenceLink {
  key:
    | "casting-heterogeneous"
    | "tcr-commits"
    | "review-record"
    | "cli-screenshot"
    | "web-screenshot"
    | "attest-gate"
    | "backlog-done"
    | "truth-attested"
    | "same-number";
  label: string;
  present: boolean;
  /** Why this link is (not) satisfied — surfaced in the report + verdict. */
  detail: string;
}

export interface EvidenceChain {
  links: EvidenceLink[];
  /** The same card ID, if it agrees across every surface that recorded it. */
  sameNumber: string | undefined;
}

/**
 * Assemble the evidence chain from a run-result — PURE. Each link is satisfied
 * only by REAL evidence (a present, non-empty screenshot; an actual TCR commit
 * carrying a test-pass proof; a Gate PASS; a Done flip; an attested ladder rung;
 * the same number agreeing across surfaces). A missing/zero-evidence input
 * yields `present:false` with the reason — the assembler never invents a link.
 */
export function assembleEvidenceChain(run: ShowcaseRunResult): EvidenceChain {
  const links: EvidenceLink[] = [];

  const cast = validateCasting(run.casting);
  links.push({
    key: "casting-heterogeneous",
    label: "Heterogeneous casting (builder ≠ reviewer ≠ scorer)",
    present: cast.ok,
    detail: cast.ok
      ? `builder=${run.casting.builder} reviewer=${run.casting.reviewer} scorer=${run.casting.scorer}`
      : cast.violations.map((v) => v.message).join("; "),
  });

  const greenTcr = run.tcrCommits.filter((c) => c.testPass);
  links.push({
    key: "tcr-commits",
    label: "TCR commit(s) with test-pass proof",
    present: greenTcr.length > 0,
    detail: greenTcr.length > 0 ? `${greenTcr.length} TCR commit(s) with proof` : "no TCR commit carrying a test-pass proof",
  });

  const review = run.reviewRecord;
  const reviewOk = review !== undefined && review.recorded && review.reviewer !== "" && review.scorer !== "";
  links.push({
    key: "review-record",
    label: "Heterogeneous review record (reviewer + scorer)",
    present: reviewOk,
    detail: reviewOk ? `reviewer=${review.reviewer} scorer=${review.scorer}` : "no recorded heterogeneous review/score",
  });

  const cli = run.screenshots.find((s) => s.surface === "cli");
  links.push({
    key: "cli-screenshot",
    label: "Fresh CLI screenshot (roll pulse terminal)",
    present: cli?.present === true,
    detail:
      cli?.present === true ? cli.path : cli?.skipped !== undefined ? `skipped: ${cli.skipped}` : "no CLI screenshot captured",
  });

  const web = run.screenshots.find((s) => s.surface === "web");
  links.push({
    key: "web-screenshot",
    label: "Fresh web screenshot (Now pulse badge)",
    present: web?.present === true,
    detail:
      web?.present === true ? web.path : web?.skipped !== undefined ? `skipped: ${web.skipped}` : "no web screenshot captured",
  });

  links.push({
    key: "attest-gate",
    label: "Attest report Gate PASS",
    present: run.attest?.gate === "PASS",
    detail: run.attest === undefined ? "no attest gate verdict" : `gate ${run.attest.gate}`,
  });

  const done = (run.backlogStatus ?? "").toLowerCase().includes("done");
  links.push({
    key: "backlog-done",
    label: "Backlog flipped to Done",
    present: done,
    detail: run.backlogStatus !== undefined ? `backlog: ${run.backlogStatus}` : "no backlog status read",
  });

  links.push({
    key: "truth-attested",
    label: "truth.json reflects attested",
    present: run.truthLadder === "attested",
    detail: run.truthLadder !== undefined ? `ladder: ${run.truthLadder}` : "no truth ladder read",
  });

  const sn = run.sameNumber ?? {};
  const seen = [sn.backlog, sn.report, sn.truth, sn.branch].filter((x): x is string => x !== undefined && x !== "");
  const uniq = [...new Set(seen)];
  const sameNumber = seen.length > 0 && uniq.length === 1 ? uniq[0] : undefined;
  links.push({
    key: "same-number",
    label: "Same card number across surfaces",
    present: sameNumber !== undefined && seen.length >= 2,
    detail:
      sameNumber !== undefined && seen.length >= 2
        ? `${sameNumber} agrees across ${seen.length} surfaces`
        : seen.length < 2
          ? "fewer than two surfaces recorded a card number"
          : `surfaces disagree: ${uniq.join(" / ")}`,
  });

  return { links, sameNumber };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export interface ShowcaseVerdict {
  pass: boolean;
  /** Links that failed (empty when pass). */
  missing: EvidenceLink[];
  /** Total links and how many are present (e.g. 9/9). */
  total: number;
  present: number;
  /** A one-line human summary. */
  summary: string;
}

/**
 * The pass/fail verdict over an assembled chain — PURE. The showcase passes iff
 * EVERY evidence link is present (AC6: any missing link is FAIL). The verdict is
 * the command's exit code and the standard E2E test's top-level assertion.
 */
export function showcaseVerdict(chain: EvidenceChain): ShowcaseVerdict {
  const missing = chain.links.filter((l) => !l.present);
  const present = chain.links.length - missing.length;
  const pass = missing.length === 0 && chain.links.length > 0;
  const summary = pass
    ? `PASS — full evidence chain (${present}/${chain.links.length} links)${chain.sameNumber !== undefined ? `, card ${chain.sameNumber}` : ""}`
    : `FAIL — ${missing.length} missing link(s): ${missing.map((m) => m.key).join(", ")}`;
  return { pass, missing, total: chain.links.length, present, summary };
}
