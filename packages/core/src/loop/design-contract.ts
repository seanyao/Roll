/**
 * @responsibility Declares the designer contract a designed story must write before execution.
 * US-V4-006 — the Designer contract for `designed` execution.
 *
 * A `designed` Story writes a design artifact before execute/evaluate. The designer
 * step (`roll-design` capability, in a FRESH session before the Builder) writes
 * `design-contract.md` + `artifact-manifest.json`. The Builder consumes the
 * contract via artifact refs; the Evaluator maps design-contract-vs-delivered against it.
 *
 * This module owns the pure render/parse/validate logic + the design-contract-vs-delivered
 * mapping. A missing or malformed designer contract FAILS CLOSED before the Builder
 * starts (the runner gate). The Designer stays a skill; TS validates its artifact.
 */
import type { DesignContractDeliveryRow, DesignerContract } from "@roll/spec";
import { validateArtifactManifest, type ArtifactValidation } from "./evaluator-artifact.js";

const H = {
  scope: "## Scope boundary",
  acceptance: "## Acceptance contract",
  evidence: "## Expected evidence",
  risks: "## Risks",
  outOfScope: "## Out of scope",
  resize: "## Resize / split guidance",
} as const;

function bullets(items: readonly string[]): string {
  return items.length === 0 ? "- (none)\n" : items.map((i) => `- ${i}`).join("\n") + "\n";
}

/** Render a {@link DesignerContract} to `design-contract.md` (round-trips). */
export function renderDesignContract(c: DesignerContract): string {
  const parts = [
    `# Designer contract — ${c.storyId}`,
    "",
    H.scope,
    bullets(c.scopeBoundary),
    H.acceptance,
    bullets(c.acceptanceContract),
    H.evidence,
    bullets(c.expectedEvidence),
    H.risks,
    bullets(c.risks),
    H.outOfScope,
    bullets(c.outOfScope),
  ];
  if (c.resizeGuidance !== undefined && c.resizeGuidance !== "") {
    parts.push(H.resize, `${c.resizeGuidance}\n`);
  }
  return parts.join("\n");
}

function section(md: string, heading: string): string | null {
  const idx = md.indexOf(heading);
  if (idx < 0) return null;
  const after = md.slice(idx + heading.length);
  const next = after.search(/\n## /);
  return (next < 0 ? after : after.slice(0, next)).trim();
}

function parseBullets(body: string | null): string[] {
  if (body === null) return [];
  return body
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l !== "" && l.toLowerCase() !== "(none)");
}

/**
 * Parse `design-contract.md` back into a {@link DesignerContract}. Returns null
 * (fail-closed) when the REQUIRED sections — scope boundary, acceptance contract,
 * and out-of-scope — are absent. The renderer's output always round-trips.
 */
export function parseDesignContract(md: string, storyId: string): DesignerContract | null {
  if (typeof md !== "string" || md.trim() === "") return null;
  if (md.indexOf(H.scope) < 0 || md.indexOf(H.acceptance) < 0 || md.indexOf(H.outOfScope) < 0) return null;
  const resize = section(md, H.resize);
  return {
    storyId,
    scopeBoundary: parseBullets(section(md, H.scope)),
    acceptanceContract: parseBullets(section(md, H.acceptance)),
    expectedEvidence: parseBullets(section(md, H.evidence)),
    risks: parseBullets(section(md, H.risks)),
    outOfScope: parseBullets(section(md, H.outOfScope)),
    ...(resize !== null && resize !== "" ? { resizeGuidance: resize } : {}),
  };
}

/**
 * US-V4-006 — validate the DESIGNER artifact pair (manifest + design-contract).
 * Fail-closed BEFORE the Builder runs: the manifest must be a well-formed designer
 * manifest and the contract must parse (required sections present) AND carry at
 * least one acceptance item (an empty contract is not a contract).
 */
export function validateDesignArtifact(opts: {
  manifest: unknown;
  contractMd: string | null;
  storyId: string;
}): ArtifactValidation {
  const reasons: string[] = [];
  const man = validateArtifactManifest(opts.manifest, "designer");
  reasons.push(...man.reasons);
  const contract = opts.contractMd === null ? null : parseDesignContract(opts.contractMd, opts.storyId);
  if (contract === null) {
    reasons.push("design-contract.md missing or malformed");
  } else if (contract.acceptanceContract.length === 0) {
    reasons.push("designer contract has no acceptance items (empty contract)");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * US-V4-006 — map the designer's acceptance contract against what was delivered.
 * `deliveredItems` is the set of acceptance items the delivery covered (e.g. the
 * ac-map AC texts/ids the Evaluator confirmed). An exact match → satisfied; a
 * fuzzy (substring) match → changed; no match → missing.
 */
export function designContractVsDelivered(
  contract: DesignerContract,
  deliveredItems: readonly string[],
): DesignContractDeliveryRow[] {
  const delivered = deliveredItems.map((d) => d.trim().toLowerCase());
  return contract.acceptanceContract.map((item) => {
    const key = item.trim().toLowerCase();
    if (delivered.includes(key)) return { item, status: "satisfied" as const };
    if (delivered.some((d) => d.includes(key) || key.includes(d))) return { item, status: "changed" as const };
    return { item, status: "missing" as const };
  });
}

/** A one-line human summary of a design-contract-vs-delivered mapping (for the eval report). */
export function summarizeDesignContractVsDelivered(rows: readonly DesignContractDeliveryRow[]): string {
  if (rows.length === 0) return "";
  const counts = { satisfied: 0, changed: 0, missing: 0 };
  for (const r of rows) counts[r.status] += 1;
  return `design contract ACs: ${counts.satisfied} satisfied, ${counts.changed} changed, ${counts.missing} missing`;
}
