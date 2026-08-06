/**
 * US-CYCLE-011 AC2 + AC4 / RL-DELIV-010 — the push-time evidence gate (`evaluateEvidenceGate`,
 * the PR-creation chokepoint) BLOCKS a publish that lacks a valid full-mode
 * proof matching the delivered tree, and only lets it through with one. Proven
 * on a NO-AC story so the acceptance-evidence half of the gate passes cleanly
 * and the full-verify half is the sole decider.
 *
 * AC4 backstop: the block is un-bypassable — a missing proof, a `--changed`
 * (per-commit) proof, and a tree-mismatched proof are each rejected, so no path
 * where `--changed` wrongly selected a narrow/empty set can reach "open PR
 * without a full verify".
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RollEvent } from "@roll/spec";
import type { CycleContext } from "@roll/core";
import { evaluateEvidenceGate } from "../src/runner/local-publish.js";
import type { Ports } from "../src/runner/ports.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const TREE = "c".repeat(40);
const STORY = "US-CYCLE-011";

/** A worktree whose story spec has NO **AC:** block → acceptanceReportRequired=false. */
function worktreeWithNoAcSpec(): string {
  const wt = mkdtempSync(join(tmpdir(), "roll-fv-wt-"));
  dirs.push(wt);
  const specDir = join(wt, ".roll", "features", "cycle-efficiency", STORY);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "spec.md"), `---\nid: ${STORY}\n---\n\n# ${STORY}\n\nNo acceptance block here.\n`);
  return wt;
}

interface Harness {
  ports: Ports;
  events: RollEvent[];
  alerts: string[];
}

function harness(worktreePath: string, nowSeconds: number, proofBody: string | undefined, headTree: string): Harness {
  const events: RollEvent[] = [];
  const alerts: string[] = [];
  const ports = {
    repoCwd: worktreePath,
    clock: () => nowSeconds,
    paths: {
      worktreePath,
      eventsPath: join(worktreePath, ".roll", "loop", "events.ndjson"),
      alertsPath: join(worktreePath, ".roll", "loop", "alerts.md"),
    },
    // US-CYCLE-011: inject the full-verify facts (proof body + delivered tree) so
    // the gate is driven without a real git worktree.
    fullVerify: {
      proofBody: () => proofBody,
      deliveredTree: () => headTree,
    },
    events: {
      appendEvent: (_p: string, ev: RollEvent) => {
        events.push(ev);
      },
      appendAlert: (_p: string, msg: string) => {
        alerts.push(msg);
      },
    },
  } as unknown as Ports;
  return { ports, events, alerts };
}

const ctx: CycleContext = { cycleId: "cyc-1", storyId: STORY } as CycleContext;

/** A well-formed proof body. */
function proof(mode: string | undefined, tree = TREE, ts = 1000): string {
  const f = [`"ts":${ts}`, `"tree":"${tree}"`];
  if (mode !== undefined) f.push(`"mode":"${mode}"`);
  return `{${f.join(",")}}\n`;
}

describe("evaluateEvidenceGate — full-verify gate (US-CYCLE-011)", () => {
  it("EARNED: a fresh full-mode proof matching the delivered tree passes the gate", () => {
    const h = harness(worktreeWithNoAcSpec(), 1000, proof("full"), TREE);
    const ok = evaluateEvidenceGate(h.ports, ctx, STORY);
    expect(ok).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ type: "delivery:evidence_gate", verdict: "earned" });
    expect(h.alerts).toEqual([]);
  });

  it("BLOCKED: no proof at all (round-tail full never ran)", () => {
    const h = harness(worktreeWithNoAcSpec(), 1000, undefined, TREE);
    const ok = evaluateEvidenceGate(h.ports, ctx, STORY);
    expect(ok).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: "delivery:evidence_gate", verdict: "blocked" });
    expect(h.alerts.join("\n")).toMatch(/branch NOT pushed/);
    const ev = h.events.at(-1) as RollEvent & { reasons?: string[] };
    expect(ev.reasons?.join(" ")).toMatch(/full-verify/);
  });

  it("BLOCKED: a --changed (per-commit) proof is NOT a full verify (AC4 backstop)", () => {
    const h = harness(worktreeWithNoAcSpec(), 1000, proof("changed"), TREE);
    const ok = evaluateEvidenceGate(h.ports, ctx, STORY);
    expect(ok).toBe(false);
    const ev = h.events.at(-1) as RollEvent & { reasons?: string[] };
    expect(ev.reasons?.join(" ")).toMatch(/not "full"/);
  });

  it("BLOCKED: a full proof whose tree does NOT match the delivered tree", () => {
    const h = harness(worktreeWithNoAcSpec(), 1000, proof("full", "d".repeat(40)), TREE);
    const ok = evaluateEvidenceGate(h.ports, ctx, STORY);
    expect(ok).toBe(false);
    const ev = h.events.at(-1) as RollEvent & { reasons?: string[] };
    expect(ev.reasons?.join(" ")).toMatch(/tree does not match/);
  });

  it("BLOCKED: fail-closed when the delivered tree is uncomputable (empty headTree)", () => {
    const h = harness(worktreeWithNoAcSpec(), 1000, proof("full"), "");
    const ok = evaluateEvidenceGate(h.ports, ctx, STORY);
    expect(ok).toBe(false);
  });

  it("BLOCKED: a stale full proof (beyond the freshness window)", () => {
    const h = harness(worktreeWithNoAcSpec(), 1_000_000_000, proof("full"), TREE); // now ≫ proof ts=1000
    const ok = evaluateEvidenceGate(h.ports, ctx, STORY);
    expect(ok).toBe(false);
    const ev = h.events.at(-1) as RollEvent & { reasons?: string[] };
    expect(ev.reasons?.join(" ")).toMatch(/stale/);
  });
});
