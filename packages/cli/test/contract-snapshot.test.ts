/**
 * US-EVID-021 — cycle-start contract freeze + drift detection.
 * A drifted worktree spec (builder injected screenshot_exempt / weakened an AC
 * after freeze) is detected; a checkbox-flip (stale-claim reset) is NOT drift.
 *
 * RL-EVID-005: verification anchor for the registered redline
 * (policy/rules.yaml) — the freeze/drift describes below prove the contract
 * snapshot guard is still alive.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contractDrift,
  freezeContractSnapshot,
  readContractSnapshot,
} from "../src/runner/contract-snapshot.js";
import { runAttestGate } from "../src/runner/attest-gate.js";

const STORY = "US-EVID-021";
const SPEC = `---
id: US-EVID-021
title: t
deliverable_cmd: roll cycles
---

## Acceptance Criteria

- [ ] AC1 gate judges against the frozen snapshot
- [ ] AC2 drift is alert-only, never a block
`;

function tempProject(specText: string): string {
  const root = mkdtempSync(join(tmpdir(), "roll-evid021-"));
  const cardDir = join(root, ".roll", "features", "uncategorized", STORY);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "spec.md"), specText, "utf8");
  return root;
}

describe("freezeContractSnapshot / readContractSnapshot", () => {
  it("freezes the design-truth contract and round-trips", () => {
    const root = tempProject(SPEC);
    const snap = freezeContractSnapshot(root, STORY, SPEC, 1783580000000);
    expect(snap).not.toBeNull();
    expect(snap?.storyId).toBe(STORY);
    expect(snap?.projection.deliverableCmd).toBe("roll cycles");
    const readBack = readContractSnapshot(root, STORY);
    expect(readBack?.hash).toBe(snap?.hash);
    expect(readBack?.frozenAt).toBe(1783580000000);
  });

  it("returns null on empty spec text", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-evid021-empty-"));
    expect(freezeContractSnapshot(root, STORY, "", 1)).toBeNull();
    expect(readContractSnapshot(root, STORY)).toBeNull();
  });
});

describe("contractDrift", () => {
  it("no snapshot on disk ⇒ null (never a false alarm)", () => {
    const root = tempProject(SPEC);
    expect(contractDrift(root, STORY, SPEC)).toBeNull();
  });

  it("checkbox flip after freeze is NOT drift (stale-claim reset is allowed)", () => {
    const root = tempProject(SPEC);
    freezeContractSnapshot(root, STORY, SPEC, 1);
    const reset = SPEC.replace(/- \[ \]/g, "- [x]");
    expect(contractDrift(root, STORY, reset)).toBeNull();
  });

  it("injecting screenshot_exempt after freeze IS drift (the builder self-exempt hole)", () => {
    const root = tempProject(SPEC);
    freezeContractSnapshot(root, STORY, SPEC, 1);
    const tampered = SPEC.replace("deliverable_cmd: roll cycles", "deliverable_cmd: roll cycles\nscreenshot_exempt: skip");
    const reason = contractDrift(root, STORY, tampered);
    expect(reason).not.toBeNull();
    expect(reason).toContain(STORY);
  });

  it("weakening an AC after freeze IS drift", () => {
    const root = tempProject(SPEC);
    freezeContractSnapshot(root, STORY, SPEC, 1);
    const weakened = SPEC.replace("AC1 gate judges against the frozen snapshot", "AC1 gutted");
    expect(contractDrift(root, STORY, weakened)).not.toBeNull();
  });
});

/**
 * Integration: the full pick_story-freeze → runAttestGate drift-alert path, with
 * scoreRepoCwd passed as the persistent root (the production wiring). Guards the
 * `scoreRepoCwd = worktreeCwd` default footgun — if the gate read the snapshot
 * from the worktree instead of the persistent root, this drift alert never fires.
 */
describe("runAttestGate contract-drift alert (integration, persistent vs worktree roots)", () => {
  function cardSpecDir(root: string): string {
    const dir = join(root, ".roll", "features", "uncategorized", STORY);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function sinks() {
    const alerts: string[] = [];
    return { alerts, s: { alert: (m: string) => alerts.push(m), event: () => {} } };
  }

  it("fires a drift alert when the worktree spec drifted from the persistent frozen snapshot", () => {
    const persistent = mkdtempSync(join(tmpdir(), "roll-evid021-persist-"));
    writeFileSync(join(cardSpecDir(persistent), "spec.md"), SPEC, "utf8");
    freezeContractSnapshot(persistent, STORY, SPEC, 1); // freeze design truth

    const worktree = mkdtempSync(join(tmpdir(), "roll-evid021-wt-"));
    const drifted = SPEC.replace("deliverable_cmd: roll cycles", "deliverable_cmd: roll cycles\nscreenshot_exempt: skip");
    writeFileSync(join(cardSpecDir(worktree), "spec.md"), drifted, "utf8");

    const { alerts, s } = sinks();
    runAttestGate(worktree, STORY, "c-drift", "soft", 1000, s, persistent);
    expect(alerts.some((a) => a.includes("contract drift") && a.includes("DETECTION ONLY"))).toBe(true);
  });

  it("no drift alert when the worktree spec still matches the frozen snapshot", () => {
    const persistent = mkdtempSync(join(tmpdir(), "roll-evid021-persist2-"));
    writeFileSync(join(cardSpecDir(persistent), "spec.md"), SPEC, "utf8");
    freezeContractSnapshot(persistent, STORY, SPEC, 1);

    const worktree = mkdtempSync(join(tmpdir(), "roll-evid021-wt2-"));
    writeFileSync(join(cardSpecDir(worktree), "spec.md"), SPEC.replace(/- \[ \]/g, "- [x]"), "utf8"); // reset flip only

    const { alerts, s } = sinks();
    runAttestGate(worktree, STORY, "c-nodrift", "soft", 1000, s, persistent);
    expect(alerts.some((a) => a.includes("contract drift"))).toBe(false);
  });

  it("fires an alert when the run dir contains a failed capture", () => {
    const root = tempProject(SPEC);
    const runDir = join(root, ".roll", "features", "uncategorized", STORY, "latest");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${STORY}-report.html`), "<section data-ac='US-EVID-021:AC1'>proof</section>", "utf8");
    writeFileSync(
      join(runDir, "evidence.json"),
      JSON.stringify(
        {
          captures: [
            {
              kind: "web",
              out: "screenshots/web.png",
              taken: false,
              skipped: "capture errored: headless timeout",
              failed: true,
              error: "headless timeout",
              label: "web",
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const { alerts, s } = sinks();
    runAttestGate(root, STORY, "c-capture-failed", "soft", 1000, s, root);
    expect(alerts.some((a) => a.includes("capture failure") && a.includes("headless timeout"))).toBe(true);
  });
});
