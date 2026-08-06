/**
 * @responsibility Freezes the acceptance contract at cycle start and detects drift.
 */
/**
 * US-EVID-021 — freeze the acceptance contract at cycle start; detect drift.
 *
 * The attest gate reads the contract (AC set + evidence frontmatter) from the
 * builder-writable worktree spec, so a builder can inject `screenshot_exempt` or
 * weaken an AC mid-cycle and the gate honours it. This module freezes the
 * contract from DESIGN TRUTH (the persistent `.roll`, not the worktree) at cycle
 * start, and lets the gate detect when the worktree contract drifted from it.
 *
 * Ownership by TOPOLOGY, not per-agent tool permissions: the snapshot is written
 * from `projectPath` (persistent) and the drift check compares the worktree spec
 * to it. Drift is ALERT-ONLY — never a block — so a false positive can never
 * stall the loop (owner red line). The pure projection/hash lives in @roll/core
 * (US-EVID-020); this is the thin cycle-start I/O + drift wrapper around it.
 *
 * RL-EVID-005: registered redline in policy/rules.yaml — freeze the contract
 * from design truth at cycle start; mid-cycle drift is detected and surfaced
 * alert-only, never silently honored.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildContractSnapshot, contractMatchesSnapshot, type ContractSnapshot } from "@roll/core";
import { cardArchiveDir } from "../lib/archive.js";

// NOTE: this module intentionally imports ONLY from @roll/core and the leaf
// lib/archive — never from attest-gate. The caller passes the design-truth
// `specText` in (rather than us resolving it via attest-gate's storySpecPath),
// which both keeps attest-gate free to `import { contractDrift }` from here with
// no cycle, and lets the caller reuse a spec it already read (no double read).

const SNAPSHOT_FILE = "contract-snapshot.json";

function snapshotPath(projectPath: string, storyId: string): string {
  return join(cardArchiveDir(projectPath, storyId), SNAPSHOT_FILE);
}

/**
 * Freeze the contract at cycle start from the DESIGN-TRUTH `specText` the caller
 * read (persistent project, not a builder worktree) and persist the snapshot.
 * Returns the snapshot (also written to `<card>/contract-snapshot.json`), or
 * null when the spec is empty. Best-effort write — a persist blip never throws
 * into the cycle.
 */
export function freezeContractSnapshot(
  projectPath: string,
  storyId: string,
  specText: string,
  frozenAtMs: number,
): ContractSnapshot | null {
  if (storyId === "" || specText === "") return null;
  const snap = buildContractSnapshot(specText, storyId, frozenAtMs);
  try {
    const path = snapshotPath(projectPath, storyId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort: the freeze must never topple the cycle */
  }
  return snap;
}

/** Read the frozen snapshot, or null when absent/corrupt. */
export function readContractSnapshot(projectPath: string, storyId: string): ContractSnapshot | null {
  try {
    const obj = JSON.parse(readFileSync(snapshotPath(projectPath, storyId), "utf8")) as ContractSnapshot;
    if (typeof obj.hash === "string" && obj.hash !== "" && typeof obj.storyId === "string") return obj;
  } catch {
    /* absent / unparseable */
  }
  return null;
}

/**
 * Non-blocking drift check for the attest gate. Returns a human-readable reason
 * when the worktree spec's contract no longer matches the cycle-start snapshot
 * (the builder changed the AC set or evidence surface after freeze), else null.
 * No snapshot on disk ⇒ null (nothing to compare — never a false alarm).
 */
export function contractDrift(projectPath: string, storyId: string, worktreeSpecText: string): string | null {
  const snap = readContractSnapshot(projectPath, storyId);
  if (snap === null) return null;
  if (contractMatchesSnapshot(snap, worktreeSpecText)) return null;
  return (
    `contract drift for ${storyId}: worktree spec's contract no longer matches the cycle-start frozen ` +
    `snapshot (frozen hash ${snap.hash.slice(0, 12)}…) — DETECTION ONLY (verdict unchanged); flags a ` +
    `mid-cycle AC/screenshot_exempt edit for review`
  );
}
