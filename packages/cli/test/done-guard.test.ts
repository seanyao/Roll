/**
 * RL-EVID-004: verification anchor for the registered redline
 * (policy/rules.yaml) — the markDoneGuarded describes below prove the
 * done/evidence guard (merge confirmed on main + complete acceptance evidence,
 * else the Done transition is rejected) is still alive.
 */
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markDoneGuarded } from "../src/runner/done-guard.js";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "roll-done-guard-")));
}

function writeEvidence(project: string, id: string, acMap: unknown): void {
  const cardDir = join(project, ".roll", "features", "uncategorized", id);
  const latest = join(cardDir, "latest");
  mkdirSync(join(cardDir, "screenshots"), { recursive: true });
  mkdirSync(latest, { recursive: true });
  writeFileSync(join(cardDir, "screenshots", "proof.png"), "png\n");
  writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify(acMap, null, 2) + "\n");
  writeFileSync(join(latest, `${id}-report.html`), "<html>report</html>\n");
}

describe("markDoneGuarded", () => {
  it("US-EVID-019 R2: legacy merged cards with no evidence directory mark Done with evidence_debt", () => {
    const project = tmp();
    const calls: string[][] = [];
    const alerts: string[] = [];
    const result = markDoneGuarded(project, "US-LEGACY-1", { mergedToMain: true }, {
      markStatus: (...args) => calls.push(args),
      alert: (msg) => alerts.push(msg),
    });
    expect(result).toEqual({ ok: true, missing: [], debt: true });
    expect(calls).toEqual([[project, "US-LEGACY-1", "✅ Done · evidence_debt"]]);
    expect(alerts.join("\n")).toContain("evidence_debt");
  });

  it("US-EVID-019 R2: new delivery cards with an evidence directory still reject missing evidence", () => {
    const project = tmp();
    mkdirSync(join(project, ".roll", "features", "uncategorized", "US-NEW-1", "latest"), { recursive: true });
    const calls: string[][] = [];
    const result = markDoneGuarded(project, "US-NEW-1", { mergedToMain: true }, {
      markStatus: (...args) => calls.push(args),
    });
    expect(result.ok).toBe(false);
    expect(result.missing.join("\n")).toContain("ac-map.json");
    expect(calls).toEqual([]);
  });

  it("rejects Done when merge is not confirmed", () => {
    const project = tmp();
    writeEvidence(project, "US-DONE-1", [
      { ac: "US-DONE-1:AC1", status: "pass", evidence: [{ kind: "screenshot", href: "screenshots/proof.png" }] },
    ]);
    const calls: string[][] = [];
    const alerts: string[] = [];
    const result = markDoneGuarded(project, "US-DONE-1", { mergedToMain: false }, {
      markStatus: (...args) => calls.push(args),
      alert: (msg) => alerts.push(msg),
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("merge not confirmed on main");
    expect(calls).toEqual([]);
    expect(alerts[0]).toContain("merge not confirmed");
  });

  it("rejects Done with a missing evidence path and reports the missing ref", () => {
    const project = tmp();
    const cardDir = join(project, ".roll", "features", "uncategorized", "US-DONE-2");
    mkdirSync(join(cardDir, "latest"), { recursive: true });
    writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([
      { ac: "US-DONE-2:AC1", status: "pass", evidence: [{ kind: "screenshot", href: "screenshots/missing.png" }] },
    ]));
    writeFileSync(join(cardDir, "latest", "US-DONE-2-report.html"), "<html>report</html>\n");

    const calls: string[][] = [];
    const result = markDoneGuarded(project, "US-DONE-2", { mergedToMain: true }, {
      markStatus: (...args) => calls.push(args),
    });
    expect(result.ok).toBe(false);
    expect(result.missing.join("\n")).toContain("screenshots/missing.png");
    expect(calls).toEqual([]);
  });

  it("US-EVID-019 R2: rejects Done when any AC is fail", () => {
    const project = tmp();
    writeEvidence(project, "US-DONE-FAIL", [
      { ac: "US-DONE-FAIL:AC1", status: "fail", evidence: [{ kind: "screenshot", href: "screenshots/proof.png" }] },
    ]);
    const calls: string[][] = [];
    const result = markDoneGuarded(project, "US-DONE-FAIL", { mergedToMain: true }, {
      markStatus: (...args) => calls.push(args),
    });
    expect(result.ok).toBe(false);
    expect(result.missing.join("\n")).toContain("failed evidence status");
    expect(calls).toEqual([]);
  });

  it("US-EVID-019 R2: rejects Done when the report exists but fails the content floor", () => {
    const project = tmp();
    const cardDir = join(project, ".roll", "features", "uncategorized", "US-DONE-EMPTY");
    mkdirSync(join(cardDir, "latest"), { recursive: true });
    writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([{ ac: "US-DONE-EMPTY:AC1", status: "claimed" }]));
    writeFileSync(join(cardDir, "latest", "US-DONE-EMPTY-report.html"), "<html>empty</html>\n");
    const result = markDoneGuarded(project, "US-DONE-EMPTY", { mergedToMain: true }, {
      markStatus: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.missing.join("\n")).toContain("report content floor failed");
  });

  it("marks Done when merge and evidence are both resolvable", () => {
    const project = tmp();
    writeEvidence(project, "US-DONE-3", [
      { ac: "US-DONE-3:AC1", status: "pass", evidence: [{ kind: "screenshot", href: "screenshots/proof.png" }] },
    ]);
    const calls: string[][] = [];
    const result = markDoneGuarded(project, "US-DONE-3", { mergedToMain: true }, {
      markStatus: (...args) => calls.push(args),
    });
    expect(result).toEqual({ ok: true, missing: [] });
    expect(calls).toEqual([[project, "US-DONE-3", "✅ Done"]]);
  });
});
