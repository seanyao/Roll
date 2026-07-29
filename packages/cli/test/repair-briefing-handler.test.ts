/**
 * US-CYCLE-007 (codex round-1 finding #2) — the repair-briefing runner glue must
 * only return a lead text when the briefing + its v2 manifest are RECORDED on disk.
 * A briefing used as context is valid ONLY together with its recorded manifest, so:
 *   - success: a real evidence dir → lead text returned + briefing.md + manifest.json
 *     persisted, and the on-disk manifest validates under the v2 protocol;
 *   - no evidence dir → null (caller falls back to the plain fix-forward prompt);
 *   - persistence failure → null (never an unrecorded inline briefing).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDeltaManifest, type DeltaArtifactManifest } from "@roll/core";
import { describe, expect, it } from "vitest";
import { buildRepairRoundBriefing } from "../src/runner/repair-briefing-handler.js";
import type { CycleContext } from "@roll/core";
import type { Ports } from "../src/runner/ports.js";

const STORY = "US-CYCLE-007";
const EVAL_FINDINGS = [
  "## Inputs checked",
  "- eval-report.md",
  "",
  "## Rationale",
  "AC2 lacks a regression test; the truncation path is unverified.",
].join("\n");

function fakePorts(repoCwd: string): Ports {
  return { repoCwd, clock: () => 1000 } as unknown as Ports;
}

function fakeCtx(evidenceRunDir?: string): CycleContext {
  return {
    cycleId: "cycle-1",
    branch: "us/US-CYCLE-007",
    loop: "main",
    storyId: STORY,
    agent: "pi",
    model: "glm-5.2",
    selectedProfile: "verified",
    ...(evidenceRunDir !== undefined ? { evidenceRunDir } : {}),
  } as unknown as CycleContext;
}

function plantEvalReport(evidenceRunDir: string): void {
  const dir = join(evidenceRunDir, "role-artifacts", "evaluator");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "eval-report.md"), EVAL_FINDINGS, "utf8");
}

describe("buildRepairRoundBriefing — recorded-manifest contract", () => {
  it("records the briefing + a valid v2 manifest and returns the lead text", async () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "rb-repo-"));
    const evidence = mkdtempSync(join(tmpdir(), "rb-evi-"));
    plantEvalReport(evidence);

    const res = await buildRepairRoundBriefing(fakePorts(repoCwd), fakeCtx(evidence), evidence, evidence);
    expect(res).not.toBeNull();
    expect(res?.leadText).toContain("AC2 lacks a regression test");
    expect(res?.leadText.toLowerCase()).toContain("do not re-explore");

    // Both artifacts are on disk.
    const briefingPath = join(evidence, "role-artifacts", "repair-briefing", "briefing.md");
    const manifestPath = join(evidence, "role-artifacts", "repair-briefing", "artifact-manifest.json");
    expect(existsSync(briefingPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    // The recorded manifest validates under the v2 protocol against the recorded file.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DeltaArtifactManifest;
    expect(manifest.schemaVersion).toBe(2);
    const check = validateDeltaManifest(manifest, {
      contains: () => true,
      readBytes: (p) => (p === res?.artifactPath ? readFileSync(briefingPath, "utf8") : null),
    });
    expect(check.ok).toBe(true);
    // The recorded briefing IS the lead text (no unrecorded divergence).
    expect(readFileSync(briefingPath, "utf8")).toBe(res?.leadText);
  });

  it("returns null (no inline briefing) when there is NO evidence dir to record the manifest", async () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "rb-repo-"));
    const res = await buildRepairRoundBriefing(fakePorts(repoCwd), fakeCtx(undefined), repoCwd, repoCwd);
    expect(res).toBeNull();
  });

  it("returns null (no inline briefing) when persisting the briefing/manifest FAILS", async () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "rb-repo-"));
    const evidence = mkdtempSync(join(tmpdir(), "rb-evi-"));
    plantEvalReport(evidence);
    // Force the persist to throw: make the briefing target dir path already exist
    // as a FILE, so mkdirSync(...,{recursive:true}) on it errors.
    mkdirSync(join(evidence, "role-artifacts"), { recursive: true });
    writeFileSync(join(evidence, "role-artifacts", "repair-briefing"), "not a dir", "utf8");

    const res = await buildRepairRoundBriefing(fakePorts(repoCwd), fakeCtx(evidence), evidence, evidence);
    expect(res).toBeNull();
    // No briefing.md was written (the path is a file, and we did not fall through).
    expect(existsSync(join(evidence, "role-artifacts", "repair-briefing", "briefing.md"))).toBe(false);
  });

  it("returns null when there is no story", async () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "rb-repo-"));
    const evidence = mkdtempSync(join(tmpdir(), "rb-evi-"));
    const ctx = { ...fakeCtx(evidence), storyId: "" } as unknown as CycleContext;
    const res = await buildRepairRoundBriefing(fakePorts(repoCwd), ctx, evidence, evidence);
    expect(res).toBeNull();
  });
});
