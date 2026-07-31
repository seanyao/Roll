/**
 * @responsibility Projects and hashes frozen acceptance contracts from story specifications.
 * US-EVID-020 — the acceptance-contract PROJECTION + frozen hash.
 *
 * The attest gate today reads the acceptance contract (AC text + evidence
 * frontmatter) from the builder-writable worktree spec, so a builder can add
 * `screenshot_exempt` or weaken an AC mid-cycle and the gate honours it. The fix
 * (US-EVID-021) is to judge against a snapshot frozen at cycle start; THIS module
 * is the pure projection + deterministic hash that snapshot is built from.
 *
 * The projection is deliberately NARROW — it is the contract the designer owns:
 *   - the evidence-surface frontmatter (`deliverable_url` / `deliverable_cmd` /
 *     `screenshot_exempt`), and
 *   - the SET of AC criteria TEXTS (order-independent).
 *
 * Everything that is a "completion CLAIM" rather than the contract is EXCLUDED,
 * so the existing stale-claim reset (`resetSpecTruthText`, which flips `[x]→[ ]`
 * and strips ✅/Status/Delivery/narrative) never registers as contract drift:
 *   - checkbox STATE — `AcItem.checked` is never read here (only `.text`);
 *   - the `**Status**` line, the H1 `✅` tick, Delivery/Fixed sections, and the
 *     Problem/Root Cause/Solution narrative — none live in the frontmatter or an
 *     AC criterion text, so they are structurally outside the projection.
 *
 * Pure: string(s) → value. No filesystem, no clock. Unit-tested directly.
 */
import { createHash } from "node:crypto";
import { acForStory } from "./ac-parser.js";

export interface ContractProjection {
  /** `deliverable_url:` (alias `screenshot_url:`) value, or null when absent. */
  deliverableUrl: string | null;
  /** `deliverable_cmd:` value, or null when absent. */
  deliverableCmd: string | null;
  /** `screenshot_exempt:` reason value, or null when absent. */
  screenshotExempt: string | null;
  /** AC criteria texts, trimmed and SORTED so ordering is not part of identity. */
  acTexts: readonly string[];
}

/** Normalize line endings so a CRLF spec parses identically to an LF one. */
function normalizeText(specText: string): string {
  return specText.replace(/\r\n?/g, "\n");
}

/** The spec frontmatter block body (between the leading `---` fences), or null. */
function frontmatterBlock(normalizedSpec: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(normalizedSpec);
  return m === null ? null : (m[1] ?? "");
}

/**
 * A single frontmatter scalar value, normalized to match how a YAML reader (and
 * the attest gate) sees it, or null when absent/empty. Handles the quirks a
 * naive `.*` capture gets wrong:
 *   - strips a trailing YAML comment — but ONLY a whitespace-preceded `#`, since
 *     an unspaced `#` is a value char (e.g. a URL fragment `index.html#loop`);
 *   - unwraps matching surrounding single/double quotes;
 *   - NFC-normalizes so encoding differences are not false drift.
 * `normalizedSpec` must already be line-ending normalized.
 */
function frontmatterValue(normalizedSpec: string, key: string): string | null {
  const fm = frontmatterBlock(normalizedSpec);
  if (fm === null) return null;
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fm);
  if (m === null) return null;
  let value = (m[1] ?? "").replace(/\s+#.*$/, "").trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  value = value.normalize("NFC");
  return value === "" ? null : value;
}

/**
 * Project a story spec down to its design-owned acceptance contract. `storyId`
 * scopes which AC block is read; `fileOwned` mirrors the attest gate so a
 * one-card FIX/US file with a file-level AC block is read the same way.
 */
export function contractProjection(specText: string, storyId: string): ContractProjection {
  const text = normalizeText(specText);
  // A true SET (deduped) of NFC-normalized AC texts, sorted so identity is
  // order-independent. Uses only AcItem.text — never `.checked` — so a checkbox
  // flip is not part of the contract.
  const acTexts = [
    ...new Set(
      acForStory(text, storyId, { fileOwned: true })
        .map((it) => it.text.trim().normalize("NFC"))
        .filter((t) => t !== ""),
    ),
  ].sort();
  return {
    deliverableUrl: frontmatterValue(text, "deliverable_url") ?? frontmatterValue(text, "screenshot_url"),
    deliverableCmd: frontmatterValue(text, "deliverable_cmd"),
    screenshotExempt: frontmatterValue(text, "screenshot_exempt"),
    acTexts,
  };
}

/**
 * Canonical string form of a projection — stable key order so the hash is
 * deterministic for a given contract regardless of how the fields were built.
 */
export function canonicalizeProjection(projection: ContractProjection): string {
  return JSON.stringify({
    deliverableUrl: projection.deliverableUrl,
    deliverableCmd: projection.deliverableCmd,
    screenshotExempt: projection.screenshotExempt,
    acTexts: projection.acTexts,
  });
}

/** SHA-256 of the canonical projection — the frozen contract hash. */
export function contractProjectionHash(specText: string, storyId: string): string {
  return createHash("sha256")
    .update(canonicalizeProjection(contractProjection(specText, storyId)), "utf8")
    .digest("hex");
}

/**
 * The frozen contract snapshot taken at cycle start. `hash` is the identity the
 * attest gate (US-EVID-021) judges against; `projection` is the readable content
 * behind that hash; `frozenAt` is the cycle-start clock (ms) the caller stamps.
 */
export interface ContractSnapshot {
  storyId: string;
  hash: string;
  projection: ContractProjection;
  frozenAt: number;
}

/**
 * Freeze a story's contract into a snapshot. PURE — the caller supplies the
 * spec text (read from design truth, NOT a builder-mutable worktree copy) and
 * the cycle-start timestamp. The snapshot is what downstream freezes against;
 * a later worktree/HEAD projection that hashes differently is contract drift.
 */
export function buildContractSnapshot(
  specText: string,
  storyId: string,
  frozenAtMs: number,
): ContractSnapshot {
  const projection = contractProjection(specText, storyId);
  return {
    storyId,
    hash: createHash("sha256").update(canonicalizeProjection(projection), "utf8").digest("hex"),
    projection,
    frozenAt: frozenAtMs,
  };
}

/**
 * Does a (possibly later) spec still match the frozen snapshot's contract?
 * `true` ⇒ no drift; `false` ⇒ the AC set or evidence surface was changed after
 * the freeze (the builder-self-exempt / AC-weakening hole US-EVID-021 closes).
 */
export function contractMatchesSnapshot(snapshot: ContractSnapshot, specText: string): boolean {
  return contractProjectionHash(specText, snapshot.storyId) === snapshot.hash;
}
