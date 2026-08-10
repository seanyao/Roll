/**
 * Unit tests for the EventBus write side (US-CORE-009) using an in-memory
 * EventStore fake: append discipline (single line, file ensured first),
 * runs.jsonl upsert dedupe by (storyId+cycleId), ensureEventFiles self-heal,
 * and the rotation-awareness helpers.
 */
import type { RollEvent } from "@roll/spec";
import { absent, present } from "@roll/spec";
import { describe, expect, it } from "vitest";
import {
  EVENTS_FILE,
  EventBus,
  type EventStore,
  ROTATE_LIMIT_BYTES,
  RUNS_FILE,
  rotationNeeded,
  rotationPlan,
  serializeEvent,
} from "../src/index.js";

/** In-memory EventStore recording every operation. */
function fakeStore(): EventStore & { files: Map<string, string>; appendCalls: number } {
  const files = new Map<string, string>();
  return {
    files,
    appendCalls: 0,
    exists(p: string) {
      return files.has(p);
    },
    ensureFile(p: string) {
      if (!files.has(p)) files.set(p, "");
    },
    readText(p: string) {
      return files.get(p) ?? "";
    },
    appendLine(p: string, line: string) {
      this.appendCalls += 1;
      files.set(p, (files.get(p) ?? "") + line);
    },
    writeText(p: string, data: string) {
      files.set(p, data);
    },
    size(p: string) {
      return Buffer.byteLength(files.get(p) ?? "", "utf8");
    },
  };
}

const EVENTS = "/proj/.roll/loop/events.ndjson";
const RUNS = "/proj/.roll/loop/runs.jsonl";

describe("appendEvent", () => {
  it("ensures the file then appends exactly one newline-terminated line", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    // FIX-1490: a REAL epoch-seconds stamp is promoted to ms. This used to be
    // asserted with `ts: 1000` → 1000000, which froze an artifact rather than the
    // contract — 1000 cannot be an epoch-seconds timestamp, and rescaling values
    // that small is what corrupted the relative-duration renderers once the same
    // normalization was applied on the read side.
    const ev: RollEvent = { type: "loop:fire", loop: "main", ts: 1_780_682_826 };
    const line = bus.appendEvent(EVENTS, ev);
    expect(store.appendCalls).toBe(1);
    expect(line).toBe('{"type":"loop:fire","loop":"main","ts":1780682826000}\n');
    expect(store.readText(EVENTS)).toBe(line);
  });

  it("round-trips through readEvents, skipping bad lines (I8)", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    bus.appendEvent(EVENTS, { type: "loop:fire", loop: "main", ts: 1 });
    store.appendLine(EVENTS, "{ not json\n");
    store.appendLine(EVENTS, "\n");
    bus.appendEvent(EVENTS, { type: "loop:idle", loop: "main", nextFire: 5, ts: 2 });
    const evs = bus.readEvents(EVENTS);
    expect(evs.map((e) => e.type)).toEqual(["loop:fire", "loop:idle"]);
  });

  it("FIX-352: normalizes terminal timestamp fields at the write boundary", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    const ev: RollEvent = {
      type: "cycle:terminal",
      schema: 1,
      cycleId: "c1",
      storyId: "FIX-352",
      agent: "codex",
      model: "gpt",
      startedAt: 1_780_000_000,
      endedAt: 1_780_000_100,
      outcome: "failed",
      pr: absent("no_publish_attempted"),
      branch: present("loop/c"),
      commit: absent("not_recorded"),
      tcr: present(1),
      attest: absent("not_rendered"),
      usage: absent("no_parseable_usage"),
      cost: absent("no_parseable_usage"),
      ts: 1_780_000_100,
    };
    const line = bus.appendEvent(EVENTS, ev);
    expect(JSON.parse(line)).toMatchObject({
      startedAt: 1_780_000_000_000,
      endedAt: 1_780_000_100_000,
      ts: 1_780_000_100_000,
    });
  });
});

describe("ensureEventFiles", () => {
  it("creates both runtime files (FIX-157 self-heal), idempotent", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    bus.ensureEventFiles(EVENTS, RUNS);
    expect(store.exists(EVENTS)).toBe(true);
    expect(store.exists(RUNS)).toBe(true);
    store.appendLine(EVENTS, "x\n");
    bus.ensureEventFiles(EVENTS, RUNS); // must not clobber
    expect(store.readText(EVENTS)).toBe("x\n");
  });
});

describe("upsertRun append-only (US-TRUTH-019)", () => {
  it("new key → appended", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    const r = bus.upsertRun(RUNS, { storyId: "US-1", cycleId: "cyc-a" }, { status: "built" });
    expect(r).toBe("appended");
    expect(bus.readRuns(RUNS)).toHaveLength(1);
  });

  it("same story+cycle → appended again (append-only; last-wins on read)", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    bus.upsertRun(RUNS, { storyId: "US-1", cycleId: "cyc-a" }, { status: "built" });
    const r = bus.upsertRun(RUNS, { storyId: "US-1", cycleId: "cyc-a" }, { status: "delivered" });
    expect(r).toBe("appended");
    // raw: both rows present
    expect(bus.readRunsRaw(RUNS)).toHaveLength(2);
    // last-wins: only the last row survives
    const rows = bus.readRuns(RUNS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("delivered");
    expect(rows[0]?.["story_id"]).toBe("US-1");
    expect(rows[0]?.["cycle_id"]).toBe("cyc-a");
  });

  it("distinct cycle of same story → appended (new row; both survive last-wins)", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    bus.upsertRun(RUNS, { storyId: "US-1", cycleId: "cyc-a" }, { status: "built" });
    const r = bus.upsertRun(RUNS, { storyId: "US-1", cycleId: "cyc-b" }, { status: "built" });
    expect(r).toBe("appended");
    // raw + last-wins both show 2 (different cycle_ids)
    expect(bus.readRunsRaw(RUNS)).toHaveLength(2);
    expect(bus.readRuns(RUNS)).toHaveLength(2);
  });

  it("matches rows that carry routed_story/cycleId field aliases (last-wins merges)", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    // seed a row in the bash-ish shape using routed_story.
    store.writeText(RUNS, `${JSON.stringify({ routed_story: "US-9", cycle_id: "z", status: "x" })}\n`);
    const r = bus.upsertRun(RUNS, { storyId: "US-9", cycleId: "z" }, { status: "done" });
    expect(r).toBe("appended");
    // raw: 2 rows; last-wins: 1 (latest wins)
    expect(bus.readRunsRaw(RUNS)).toHaveLength(2);
    const rows = bus.readRuns(RUNS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("done");
  });

  it("AC3: concurrent writers — two distinct cycles appended independently survive", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    // Simulate two concurrent writes to different cycles
    bus.upsertRun(RUNS, { storyId: "US-CONC", cycleId: "cyc-1" }, { status: "ok" });
    bus.upsertRun(RUNS, { storyId: "US-CONC", cycleId: "cyc-2" }, { status: "ok" });
    expect(bus.readRunsRaw(RUNS)).toHaveLength(2);
    expect(bus.readRuns(RUNS)).toHaveLength(2);
  });

  it("AC3: same cycle updated multiple times — last-wins picks latest", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    bus.upsertRun(RUNS, { storyId: "US-LW", cycleId: "cyc-x" }, { status: "built", cost: 1 });
    bus.upsertRun(RUNS, { storyId: "US-LW", cycleId: "cyc-x" }, { status: "failed", cost: 1 });
    bus.upsertRun(RUNS, { storyId: "US-LW", cycleId: "cyc-x" }, { status: "delivered", cost: 3 });
    const rows = bus.readRuns(RUNS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("delivered");
    expect(rows[0]?.["cost"]).toBe(3);
  });

  it("AC4: backward compat — old single-row data reads correctly via last-wins", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    // Pre-seed with old-style data (one row per key, no duplicates)
    store.writeText(RUNS,
      `${JSON.stringify({ story_id: "OLD-1", cycle_id: "cyc-a", status: "done" })}\n` +
      `${JSON.stringify({ story_id: "OLD-2", cycle_id: "cyc-b", status: "failed" })}\n`,
    );
    const rows = bus.readRuns(RUNS);
    expect(rows).toHaveLength(2);
    const done = rows.find((r) => r["story_id"] === "OLD-1");
    expect(done?.["status"]).toBe("done");
  });

  it("AC4: mixed old + new append-only data — last-wins still correct", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    // Old-style seed
    store.writeText(RUNS,
      `${JSON.stringify({ story_id: "MIX-1", cycle_id: "cyc-a", status: "built", v: 1 })}\n`,
    );
    // New append for same key
    bus.upsertRun(RUNS, { storyId: "MIX-1", cycleId: "cyc-a" }, { status: "delivered", v: 2 });
    const rows = bus.readRuns(RUNS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("delivered");
    expect(rows[0]?.["v"]).toBe(2);
  });

  it("unkeyed rows (no story_id/cycle_id) pass through unmerged", () => {
    const store = fakeStore();
    const bus = new EventBus(store);
    store.writeText(RUNS, `${JSON.stringify({ note: "legacy row without keys" })}\n`);
    bus.upsertRun(RUNS, { storyId: "US-K", cycleId: "cyc-k" }, { status: "ok" });
    const rows = bus.readRuns(RUNS);
    // unkeyed row + the keyed one = 2
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r["note"] === "legacy row without keys")).toBe(true);
  });
});

describe("rotation awareness", () => {
  it("rotationNeeded at >10 MiB", () => {
    expect(rotationNeeded(ROTATE_LIMIT_BYTES)).toBe(false);
    expect(rotationNeeded(ROTATE_LIMIT_BYTES + 1)).toBe(true);
  });

  it("rotationPlan mirrors _loop_event_rotate (.4 rm; .3→.4 …; cur→.1; recreate)", () => {
    const plan = rotationPlan("/x/events.ndjson");
    expect(plan).toEqual([
      { op: "remove", path: "/x/events.ndjson.4" },
      { op: "rename", from: "/x/events.ndjson.3", to: "/x/events.ndjson.4" },
      { op: "rename", from: "/x/events.ndjson.2", to: "/x/events.ndjson.3" },
      { op: "rename", from: "/x/events.ndjson.1", to: "/x/events.ndjson.2" },
      { op: "rename", from: "/x/events.ndjson", to: "/x/events.ndjson.1" },
      { op: "create", path: "/x/events.ndjson" },
    ]);
  });

  it("serializeEvent + file-name constants", () => {
    // FIX-1490: real epoch-seconds → ms (see the appendEvent test above for why
    // this no longer uses a toy value).
    expect(serializeEvent({ type: "loop:fire", loop: "main", ts: 1_780_682_826 })).toBe(
      '{"type":"loop:fire","loop":"main","ts":1780682826000}\n',
    );
    expect(EVENTS_FILE).toBe("events.ndjson");
    expect(RUNS_FILE).toBe("runs.jsonl");
  });
});
