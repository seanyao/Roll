/**
 * US-CYCLE-013 — CLI readout surface: the old-reader `upgrade_required` gate and
 * the §8 truth-projection text (matrix #16, #17). Fixture event files only.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus, projectHandoffCapacity } from "@roll/core";
import type { HandoffIdentity, ManagedWorkspaceSet, RollEvent } from "@roll/spec";
import {
  handoffUpgradeMessage,
  handoffUpgradeRequired,
  projectHasCycleHandoffEvents,
  renderHandoffStatus,
} from "../src/commands/loop-runner-readout.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      import("node:fs").then((fs) => fs.rmSync(d, { recursive: true, force: true }));
    } catch {
      /* best effort */
    }
  }
});

function tmpProject(tag: string): { projectPath: string; eventsPath: string } {
  const d = mkdtempSync(join(tmpdir(), `roll-readout-${tag}-`));
  dirs.push(d);
  const loopDir = join(d, ".roll", "loop");
  mkdirSync(loopDir, { recursive: true });
  return { projectPath: d, eventsPath: join(loopDir, "events.ndjson") };
}

function workspaceFor(cycleId: string, storyId: string): ManagedWorkspaceSet {
  return {
    schema: 1,
    runId: cycleId,
    storyId,
    kind: "cycle",
    topology: "solo",
    members: [{
      repositoryId: "repo-id",
      workspaceKey: `cycle-${cycleId}`,
      relativeLocator: `cycle-${cycleId}`,
      checkoutRef: { kind: "detached", head: "base-sha" },
      publishRef: `refs/heads/loop/cycle-${cycleId}`,
    }],
  };
}

function identityFor(cycleId: string, storyId: string, fence = "fence"): HandoffIdentity {
  return {
    schema: "cycle-handoff/v1",
    cycleId,
    storyId,
    workspace: workspaceFor(cycleId, storyId),
    branch: `loop/cycle-${cycleId}`,
    builderHead: "head-sha",
    baseSha: "base-sha",
    builderEvidenceRefs: [],
    builderValidationRef: `builder-validation:${cycleId}:1`,
    profile: "standard",
    attempt: 1,
    fence,
  };
}

function writeEvents(eventsPath: string, events: RollEvent[]): void {
  const bus = new EventBus();
  for (const ev of events) bus.appendEvent(eventsPath, ev);
}

describe("US-CYCLE-013 — upgrade_required gate (matrix #16)", () => {
  it("a stream WITHOUT v1 events is safe for the serial reader (no upgrade)", () => {
    const { projectPath, eventsPath } = tmpProject("clean");
    writeEvents(eventsPath, [
      { type: "cycle:start", cycleId: "c1", storyId: "US-1", agent: "a", model: "m", ts: 1 },
    ]);
    expect(projectHasCycleHandoffEvents(projectPath)).toBe(false);
    expect(handoffUpgradeRequired(projectPath)).toEqual({ required: false, cycleIds: [] });
  });

  it("a stream WITH v1 events is reported upgrade_required with the affected cycle ids", () => {
    const { projectPath, eventsPath } = tmpProject("v1");
    const A = identityFor("cA", "US-A");
    writeEvents(eventsPath, [
      { type: "worktree:allocated", workspace: workspaceFor("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
    ]);
    expect(projectHasCycleHandoffEvents(projectPath)).toBe(true);
    const gate = handoffUpgradeRequired(projectPath);
    expect(gate.required).toBe(true);
    expect(gate.cycleIds).toEqual(["cA"]);
  });

  it("the upgrade line is bilingual via the v3 catalog", () => {
    expect(handoffUpgradeMessage("en")).toContain("upgrade_required");
    expect(handoffUpgradeMessage("en")).toContain("install the current roll");
    expect(handoffUpgradeMessage("zh")).toContain("需要升级");
  });
});

describe("US-CYCLE-013 — CLI truth projection text (matrix #17)", () => {
  it("renders the literal states: one tail + one ready holder + a FIFO queue row", () => {
    const { eventsPath } = tmpProject("status");
    const A = identityFor("cA", "US-A");
    const B = identityFor("cB", "US-B");
    writeEvents(eventsPath, [
      { type: "worktree:allocated", workspace: workspaceFor("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:tail_started", eventId: "e4", idempotencyKey: "tail_started:cA:1:fence", cycleId: "cA", attempt: 1, fence: "fence", ts: 5 },
      { type: "worktree:allocated", workspace: workspaceFor("cB", "US-B"), ts: 6 },
      { type: "cycle:admitted", eventId: "e5", idempotencyKey: "admit:cB:1", identity: B, queueSequence: 2, ts: 7 },
      { type: "cycle:builder_ready", eventId: "e6", idempotencyKey: "ready:US-B:1:fence", identity: B, reason: "tail_capacity_full", ts: 8 },
      { type: "cycle:queued", eventId: "e7", idempotencyKey: "queue:US-C:3", storyId: "US-C", requestedByCycleId: "cC", queueSequence: 3, reason: "build_slot_full", ts: 9 },
    ]);
    const lines = renderHandoffStatus(eventsPath, "en");
    const joined = lines.join("\n");
    expect(joined).toContain("waiting for evaluation/test");
    expect(joined).toContain("builder complete — tail capacity full");
    expect(joined).toContain("cycle-cA");
    expect(joined).toContain("queued — awaiting build/tail capacity");
    expect(joined).toContain("US-C");
    expect(joined).toContain("seq=3");
    expect(joined).toContain("queue[1]");
    // A ready holder is NEVER rendered inside the queue.
    const queueLine = lines.find((l) => l.startsWith("queue[")) ?? "";
    expect(queueLine).not.toContain("US-B");
    // The capacity graph agrees with the rendered text.
    const cap = projectHandoffCapacity(projectHandoffEvents(eventsPath));
    expect(cap.tailCycleId).toBe("cA");
    expect(cap.readyHolderCycleId).toBe("cB");
    expect(cap.queue.length).toBe(1);
  });

  it("renders serial recovery with the readable reason (no automatic deletion)", () => {
    const { eventsPath } = tmpProject("recovery");
    const A = identityFor("cA", "US-A");
    writeEvents(eventsPath, [
      { type: "worktree:allocated", workspace: workspaceFor("cA", "US-A"), ts: 1 },
      { type: "cycle:admitted", eventId: "e1", idempotencyKey: "admit:cA:1", identity: A, queueSequence: 1, ts: 2 },
      { type: "cycle:builder_ready", eventId: "e2", idempotencyKey: "ready:US-A:1:fence", identity: A, reason: "promotion_pending", ts: 3 },
      { type: "cycle:builder_handoff", eventId: "e3", idempotencyKey: "handoff:US-A:1:fence", identity: A, previousReadyKey: "ready:US-A:1:fence", next: "evaluate_or_test", ts: 4 },
      { type: "cycle:serial_recovery", eventId: "e4", idempotencyKey: "recovery:cA:1:fence:repair", cycleId: "cA", attempt: 1, fence: "fence", reason: "repair_required", ts: 5 },
    ]);
    const joined = renderHandoffStatus(eventsPath, "en").join("\n");
    expect(joined).toContain("serial recovery required");
    expect(joined).toContain("repair_required");
    expect(joined).toContain("no automatic deletion");
  });

  it("matrix #11: renderHandoffStatus is EMPTY on a serial-only stream (flag-off byte-identical guard)", () => {
    const { eventsPath } = tmpProject("serial-only");
    writeEvents(eventsPath, [
      { type: "cycle:start", cycleId: "c1", storyId: "US-1", agent: "a", model: "m", ts: 1 },
      { type: "cycle:end", cycleId: "c1", outcome: "done", cost: { usd: 0, tokensIn: 0, tokensOut: 0 }, ts: 2 },
    ]);
    // No cycle-handoff/v1 facts ⇒ no projection lines ⇒ the dashboard section
    // stays hidden and the flag-off serial render is byte-identical.
    expect(renderHandoffStatus(eventsPath, "en")).toEqual([]);
    expect(renderHandoffStatus(eventsPath, "zh")).toEqual([]);
  });
});

/** Local helper: read the fixture events the same way the renderer does. */
function projectHandoffEvents(eventsPath: string): RollEvent[] {
  return new EventBus().readEvents(eventsPath);
}
