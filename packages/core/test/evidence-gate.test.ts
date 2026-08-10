/**
 * US-DELIV-004 / RL-DELIV-010 — attest/ac-map push 前硬闸 (evidenceGateBeforePush, fail-loud).
 *
 * Design .roll/features/delivery-reconciler/delivery-reconciler-design.md
 * §3.2/§4/§8: BEFORE the cycle branch is pushed, the runner checks that the
 * acceptance evidence (attest report + ac-map) was actually produced. Missing
 * evidence → { ok:false, reasons } → the cycle is `blocked_no_evidence` and
 * the branch is NEVER pushed — "pushed a branch but opened no PR" stops being
 * a normal outcome and becomes a fault state (handled like the zero-TCR
 * class). The gate moves the CHECKPOINT earlier; it does not change the
 * attest judgement itself (FIX-329: attest is earned at delivery).
 *
 * AC1 (goal 1): evidence complete → { ok:true } lets the push through.
 * AC2 (goal 1/2): missing attest report and/or ac-map → { ok:false } with a
 *   reason per missing artifact; deterministic order (attest first); the
 *   function is pure + total (any fact combination yields a verdict).
 */
import { describe, expect, it } from "vitest";
import { acBlockPresentInSpec, evidenceGateBeforePush, visualEvidenceGate } from "../src/index.js";
import type { EvidenceClassifierInput, RollCaptureResponseV1 } from "@roll/spec";

const physicalResponse: RollCaptureResponseV1 = {
  protocol: "roll.capture.v1",
  requestId: "capture-1",
  status: "taken",
  screenshotPath: "screenshots/physical.png",
  responsePath: "responses/capture-1.json",
  host: { appName: "Roll Capture.app", bundleId: "com.seanyao.roll.capture", version: "1.0.0" },
  startedAt: "2026-07-15T00:00:00.000Z",
  finishedAt: "2026-07-15T00:00:01.000Z",
};

describe("evidenceGateBeforePush — US-DELIV-004", () => {
  // ── AC1: evidence complete → push allowed ────────────────────────────────
  it("attest report + ac-map both present → { ok: true }", () => {
    expect(evidenceGateBeforePush({ attestReportPresent: true, acMapPresent: true })).toEqual({ ok: true });
  });

  // ── AC2: any missing artifact → fail-loud, one reason per artifact ───────
  it("missing attest report → ok:false with an attest reason", () => {
    const v = evidenceGateBeforePush({ attestReportPresent: false, acMapPresent: true });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reasons).toHaveLength(1);
      expect(v.reasons[0]).toContain("attest report");
    }
  });

  it("missing ac-map → ok:false with an 'ac-map.json missing' reason", () => {
    const v = evidenceGateBeforePush({ attestReportPresent: true, acMapPresent: false });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reasons).toHaveLength(1);
      expect(v.reasons[0]).toContain("ac-map.json missing");
    }
  });

  it("both missing → ok:false with both reasons, attest first (deterministic)", () => {
    const v = evidenceGateBeforePush({ attestReportPresent: false, acMapPresent: false });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reasons).toHaveLength(2);
      expect(v.reasons[0]).toContain("attest report");
      expect(v.reasons[1]).toContain("ac-map.json missing");
    }
  });

  // ── AC2 (purity): same input → same output, no exceptions on any combo ───
  it("is pure + total over the 2×2 fact space", () => {
    const seen = new Set<string>();
    for (const attestReportPresent of [true, false]) {
      for (const acMapPresent of [true, false]) {
        const v = evidenceGateBeforePush({ attestReportPresent, acMapPresent });
        seen.add(JSON.stringify(v));
        expect(v.ok).toBe(attestReportPresent && acMapPresent);
      }
    }
    // 4 distinct verdicts: ok / attest-missing / acmap-missing / both-missing
    expect(seen.size).toBe(4);
  });

  // ── FIX-1256: no-AC cards are exempt from report + ac-map requirements ───
  it("acceptanceReportRequired=false → ok:true even with missing artifacts", () => {
    expect(evidenceGateBeforePush({
      attestReportPresent: false,
      acMapPresent: false,
      acceptanceReportRequired: false,
    })).toEqual({ ok: true });
  });

  it("acceptanceReportRequired=true (default) still requires both artifacts", () => {
    expect(evidenceGateBeforePush({
      attestReportPresent: true,
      acMapPresent: false,
    })).toEqual({ ok: false, reasons: ["ac-map.json missing"] });
  });
});

describe("acBlockPresentInSpec — FIX-1256 shared AC-block decision", () => {
  it("returns true when the spec contains an **AC:** block for the story", () => {
    const text = "# US-FOO-001\n\n**AC:**\n- [ ] something\n";
    expect(acBlockPresentInSpec(text, "US-FOO-001")).toBe(true);
  });

  it("returns false when the spec has no **AC:** block", () => {
    const text = "# FIX-FOO-001\n\nSome description without AC.\n";
    expect(acBlockPresentInSpec(text, "FIX-FOO-001")).toBe(false);
  });
});

describe("visualEvidenceGate — US-BROW-023", () => {
  const physical: EvidenceClassifierInput = {
    artifactId: "capture-1",
    provider: "roll-capture",
    protocol: "roll.capture.v1",
    captureResponse: physicalResponse,
    digest: "sha256:verified",
  };

  it("accepts a verified physical capture as visual AC evidence", () => {
    expect(visualEvidenceGate([physical])).toEqual({ ok: true });
  });

  it("blocks the push-time evidence gate when visual AC evidence is diagnostic-only", () => {
    const verdict = evidenceGateBeforePush({
      attestReportPresent: true,
      acMapPresent: true,
      visualEvidence: [{ artifactId: "devtools-1", provider: "chrome-devtools-mcp", isBrowserDiagnostic: true }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons[0]).toContain("devtools-1");
  });

  it.each([
    ["playwright", { artifactId: "playwright-1", provider: "playwright", protocol: "playwright.v1" }],
    ["DevTools", { artifactId: "devtools-1", provider: "chrome-devtools-mcp", isBrowserDiagnostic: true }],
  ] as const)("rejects %s diagnostics as visual AC evidence", (_kind, artifact) => {
    const verdict = visualEvidenceGate([artifact]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]).toContain(artifact.artifactId);
    }
  });

  it("surfaces a forged physical protocol claim instead of downgrading it to a diagnostic", () => {
    const verdict = visualEvidenceGate([{ artifactId: "forged-1", provider: "chrome-devtools-mcp", protocol: "roll.capture.v1" }]);
    expect(verdict).toEqual(expect.objectContaining({ ok: false, reasons: [expect.stringContaining("forgery")] }));
  });
});
