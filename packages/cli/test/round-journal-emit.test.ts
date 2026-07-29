/**
 * US-CYCLE-004 — the runner emit hook (recordSpawnRound) and the readout CLI
 * (roll cycle journal). recordSpawnRound auto-writes a role turn into the card's
 * round-journal (no manual step) and is guaranteed non-blocking.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CycleContext } from "@roll/core";
import { deriveRounds, readRoundEntries } from "@roll/core";
import { afterEach, describe, expect, it } from "vitest";
import { recordSpawnRound } from "../src/runner/round-journal-emit.js";
import { cycleCommand } from "../src/commands/cycle.js";
import type { Ports } from "../src/runner/ports.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function proj(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-rj-emit-"));
  dirs.push(d);
  return d;
}
// cardArchiveDir(proj, id) with no index.json → .roll/features/uncategorized/<id>
function cardDirOf(project: string, id: string): string {
  return join(project, ".roll", "features", "uncategorized", id);
}
/** recordSpawnRound fires an async (fire-and-forget) write — let it settle. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

describe("recordSpawnRound (US-CYCLE-004 auto-write)", () => {
  it("writes a builder turn per cycle; the readout derives round from cycleId", async () => {
    const project = proj();
    const ports = { repoCwd: project } as unknown as Ports;
    // Two separate cycles (c1, c2) for the same card = two rounds.
    recordSpawnRound(ports, { storyId: "US-X-1", model: "glm-5.2", cycleId: "c1" } as unknown as CycleContext, { role: "builder", start: 1_000, durMs: 60_000, outcome: "delivered" });
    await flush();
    recordSpawnRound(ports, { storyId: "US-X-1", model: "glm-5.2", cycleId: "c2" } as unknown as CycleContext, { role: "builder", start: 70_000, durMs: 30_000, outcome: "failed", gateTimeMs: 5_000 });
    await flush();
    const { entries } = readRoundEntries(cardDirOf(project, "US-X-1"));
    expect(entries).toHaveLength(2);
    // No racy round stored on the hot path; derived from cycleId ordering.
    expect(deriveRounds(entries).map((e) => e.round)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ role: "builder", model: "glm-5.2", cycleId: "c1", outcome: "delivered" });
    expect(entries[1]).toMatchObject({ outcome: "failed", gateTimeMs: 5_000, cycleId: "c2" });
    // Two builder turns in the SAME cycle share one round.
    expect(deriveRounds([...entries, { ...entries[0]!, cycleId: "c2", role: "evaluator" }]).map((e) => e.round)).toEqual([1, 2, 2]);
  });

  it("US-CYCLE-006 auto-trigger: crossing the repair-round threshold auto-writes split-advice.md + a split:advice event", async () => {
    const project = proj();
    const ports = { repoCwd: project } as unknown as Ports;
    const rec = (cyc: string, outcome: string): void =>
      recordSpawnRound(ports, { storyId: "US-BIG", model: "glm-5.2", cycleId: cyc } as unknown as CycleContext, { role: "builder", start: 1, durMs: 1, outcome });
    // Two rounds → still under threshold → no advice yet.
    rec("c1", "failed");
    await flush();
    rec("c2", "refuted");
    await flush();
    const advicePath = join(cardDirOf(project, "US-BIG"), "split-advice.md");
    expect(existsSync(advicePath)).toBe(false);
    // Third round crosses the threshold → advice auto-generated + event emitted.
    rec("c3", "delivered");
    await flush();
    expect(existsSync(advicePath)).toBe(true);
    expect(readFileSync(advicePath, "utf8")).toContain("ran **3 rounds**");
    const eventsPath = join(project, ".roll", "loop", "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const evLine = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.includes('"split:advice"'));
    expect(evLine.length).toBe(1);
    expect(evLine[0]).toContain('"card":"US-BIG"');
    expect(evLine[0]).toContain('"rounds":3');
    // (Idempotency of the write itself — same journal ⇒ no rewrite/re-emit — is
    // pinned directly in split-advice.test.ts; here recordSpawnRound always
    // appends, so any further call is a genuinely new journal state.)
  });

  it("US-CYCLE-012 auto-trigger: 2 consecutive rig failures auto-write a model-swap candidate + event", async () => {
    const project = proj();
    const ports = { repoCwd: project } as unknown as Ports;
    const rec = (cyc: string, outcome: string): void =>
      recordSpawnRound(ports, { storyId: "US-FAIL", model: "glm-5.2", cycleId: cyc } as unknown as CycleContext, { role: "builder", start: 1, durMs: 1, outcome });
    const candPath = join(cardDirOf(project, "US-FAIL"), "model-swap-candidate.md");
    rec("c1", "failed");
    await flush();
    expect(existsSync(candPath)).toBe(false); // one failure — under threshold
    rec("c2", "kill:no-state-change");
    await flush();
    expect(existsSync(candPath)).toBe(true);
    expect(readFileSync(candPath, "utf8")).toContain("builder × glm-5.2");
    const eventsPath = join(project, ".roll", "loop", "events.ndjson");
    const evs = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.includes('"model:swap_candidate"'));
    expect(evs.length).toBe(1);
    expect(evs[0]).toContain('"role":"builder"');
    expect(evs[0]).toContain('"streak":2');
  });

  it("returns synchronously (non-blocking) — the write is deferred off the hot path", () => {
    const project = proj();
    const ports = { repoCwd: project } as unknown as Ports;
    const ctx = { storyId: "US-X-3", cycleId: "c1" } as unknown as CycleContext;
    recordSpawnRound(ports, ctx, { role: "builder", start: 1, durMs: 1, outcome: "delivered" });
    // Nothing written yet in the same tick — proves the caller isn't blocked on I/O.
    expect(existsSync(join(cardDirOf(project, "US-X-3"), "round-journal.jsonl"))).toBe(false);
  });

  it("is a no-op for a story-less cycle (nothing to journal into)", async () => {
    const project = proj();
    const ports = { repoCwd: project } as unknown as Ports;
    const ctx = { storyId: "", cycleId: "c1" } as unknown as CycleContext;
    recordSpawnRound(ports, ctx, { role: "builder", start: 1, durMs: 1, outcome: "delivered" });
    await flush();
    expect(existsSync(join(project, ".roll", "features"))).toBe(false);
  });

  it("never throws even if the repo path is unusable (best-effort, non-blocking)", async () => {
    const ports = { repoCwd: "/nonexistent/\0bad" } as unknown as Ports;
    const ctx = { storyId: "US-X-9" } as unknown as CycleContext;
    expect(() => recordSpawnRound(ports, ctx, { role: "builder", start: 1, durMs: 1, outcome: "delivered" })).not.toThrow();
    await flush();
  });
});

describe("roll cycle journal (US-CYCLE-004 readout)", () => {
  function runJournal(project: string, args: string[]): { code: number; out: string } {
    const save = { cwd: process.cwd(), NC: process.env["NO_COLOR"], LG: process.env["ROLL_LANG"] };
    process.chdir(project);
    process.env["NO_COLOR"] = "1";
    process.env["ROLL_LANG"] = "en";
    const out: string[] = [];
    const rOut = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (x: string | Uint8Array): boolean => (out.push(String(x)), true);
    let code: number | Promise<number>;
    try {
      code = cycleCommand(args);
    } finally {
      process.stdout.write = rOut;
      process.chdir(save.cwd);
      if (save.NC === undefined) delete process.env["NO_COLOR"]; else process.env["NO_COLOR"] = save.NC;
      if (save.LG === undefined) delete process.env["ROLL_LANG"]; else process.env["ROLL_LANG"] = save.LG;
    }
    return { code: code as number, out: out.join("") };
  }

  it("prints the aggregate readout for a card with entries", async () => {
    const project = proj();
    const ports = { repoCwd: project } as unknown as Ports;
    const ctx = { storyId: "US-X-2", model: "glm", cycleId: "c1" } as unknown as CycleContext;
    recordSpawnRound(ports, ctx, { role: "builder", start: 1_000, durMs: 60_000, outcome: "delivered", gateTimeMs: 6_000 });
    await flush();
    const r = runJournal(project, ["journal", "US-X-2"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("US-X-2 round-journal");
    expect(r.out).toContain("overall:");
    expect(r.out).toContain("median=60.0s");
  });

  it("reports empty for a card with no journal, and errors with no card id", () => {
    const project = proj();
    expect(runJournal(project, ["journal", "US-NONE"]).out).toContain("no round-journal entries");
    expect(runJournal(project, ["journal"]).code).toBe(1);
  });
});
