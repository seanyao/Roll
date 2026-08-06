import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { parseDeliveryArgs, readFeatureDelivery, renderFeatureDelivery } from "../src/lib/feature-delivery-supervisor.js";

// ESM namespace exports are not configurable, so spying goes through the
// underlying CJS module objects (same live bindings the adapter resolves).
const require = createRequire(import.meta.url);
const fsCjs = require("node:fs") as typeof import("node:fs");
const childProcessCjs = require("node:child_process") as typeof import("node:child_process");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "roll-delivery-")); dirs.push(dir); mkdirSync(join(dir, ".roll", "loop"), { recursive: true });
  writeFileSync(join(dir, ".roll", "backlog.md"), "| ID | Description | Status |\n| --- | --- | --- |\n| US-X | fixture card | ✅ Done |\n");
  writeFileSync(join(dir, ".roll", "index.json"), JSON.stringify({ stories: { "US-X": "fixture" } }));
  writeFileSync(join(dir, ".roll", "events.ndjson"), [
    JSON.stringify({ type: "cycle:start", cycleId: "c1", storyId: "US-X", agent: "codex", model: "m", ts: 10 }),
    JSON.stringify({ type: "delivery:merge_confirmed", cycleId: "c1", storyId: "US-X", branch: "x", signal: "ancestor", ts: 20 }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, ".roll", "loop", "events.ndjson"), ""); return dir;
}

describe("supervisor delivery", () => {
  it("strictly rejects bad windows before an adapter can read", () => {
    expect(parseDeliveryArgs(["delivery", "US-X", "--from", "not-a-date"])).toEqual({ error: "invalid_from" });
    expect(parseDeliveryArgs(["delivery", "US-X", "--from", "2026-01-02T00:00:00Z", "--to", "2026-01-01T00:00:00Z"])).toEqual({ error: "reversed_window" });
  });

  it("renders one unified, read-only current-truth view", () => {
    const dir = fixture(); const before = readFileSync(join(dir, ".roll", "events.ndjson"), "utf8");
    const args = parseDeliveryArgs(["delivery", "US-X"]); if ("error" in args) throw new Error(args.error);
    const result = readFeatureDelivery(dir, args); if (!result.ok) throw new Error(result.message);
    // The contract exposes provenance.  Only the fixture's randomized temp root
    // is volatile; line numbers, digests and duration values remain frozen.
    expect(JSON.parse(JSON.stringify(result.view).replaceAll(dir, "<fixture>"))).toMatchSnapshot("json");
    expect(renderFeatureDelivery(result.view)).toMatchSnapshot("en");
    expect(readFileSync(join(dir, ".roll", "events.ndjson"), "utf8")).toBe(before);
  });

  it("renders Chinese and exposes a malformed ledger diagnostic without throwing", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".roll", "events.ndjson"), readFileSync(join(dir, ".roll", "events.ndjson"), "utf8") + "\nnot-json\n");
    const args = parseDeliveryArgs(["delivery", "US-X"]); if ("error" in args) throw new Error(args.error);
    const result = readFeatureDelivery(dir, args); if (!result.ok) throw new Error(result.message);
    expect(result.view.diagnostics.map((d) => d.code)).toContain("malformed_json");
    process.env["ROLL_LANG"] = "zh";
    try {
      expect(renderFeatureDelivery(result.view)).toMatchSnapshot("zh");
    } finally {
      delete process.env["ROLL_LANG"];
    }
  });
});

describe("US-DELTA-021 delivery help contract", () => {
  let out: string;
  let err: string;
  let ow: typeof process.stdout.write;
  let oe: typeof process.stderr.write;
  beforeEach(() => {
    registerAll();
    out = "";
    err = "";
    ow = process.stdout.write.bind(process.stdout);
    oe = process.stderr.write.bind(process.stderr);
    // @ts-expect-error capture-only
    process.stdout.write = (s: string): boolean => ((out += String(s)), true);
    // @ts-expect-error capture-only
    process.stderr.write = (s: string): boolean => ((err += String(s)), true);
  });
  afterEach(() => {
    process.stdout.write = ow;
    process.stderr.write = oe;
  });

  it("routes --help to the unified delivery view help on stdout, exit 0, no project needed", async () => {
    const r = await dispatch(["supervisor", "delivery", "--help"]);
    expect(r.status).toBe(0);
    expect(out).toContain("Usage: roll supervisor delivery");
    expect(out).not.toContain("unknown_argument");
    expect(out).not.toContain("missing_subject");
    expect(err).toBe("");
  });

  it("-h behaves identically", async () => {
    const r = await dispatch(["supervisor", "delivery", "-h"]);
    expect(r.status).toBe(0);
    expect(out).toContain("Usage: roll supervisor delivery");
    expect(err).toBe("");
  });

  it("renders the ZH help under ROLL_LANG=zh", async () => {
    process.env["ROLL_LANG"] = "zh";
    try {
      const r = await dispatch(["supervisor", "delivery", "--help"]);
      expect(r.status).toBe(0);
      expect(out).toContain("用法：roll supervisor delivery");
      expect(err).toBe("");
    } finally {
      delete process.env["ROLL_LANG"];
    }
  });
});

describe("US-DELTA-021 worked example", () => {
  /** Design contract §3.4 fixture: feature `delta-team`, US-A repaired after an
   *  earlier attempt, US-B handoff-ready.  Frozen core projection means the
   *  delta attempt outcome is its terminal (d2 `handoff_ready`), the card final
   *  state is main-truth (`delivered`), and the abandoned d1 leaves delivery
   *  evidence codes so US-A renders incomplete-excluded in first-pass. */
  function workedFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "roll-delivery021-")); dirs.push(dir);
    mkdirSync(join(dir, ".roll", "loop"), { recursive: true });
    writeFileSync(join(dir, ".roll", "backlog.md"), [
      "| ID | Description | Status |",
      "| --- | --- | --- |",
      "| US-A | repair after earlier attempt | ✅ Done |",
      "| US-B | handoff-ready card | — |",
    ].join("\n") + "\n");
    writeFileSync(join(dir, ".roll", "index.json"), JSON.stringify({ stories: { "US-A": "delta-team", "US-B": "delta-team" } }));
    const ev = (o: object): string => JSON.stringify(o);
    const events = [
      // US-A attempt d1 — abandoned (line 1-4)
      ev({ type: "delta:prepared", delegationId: "d1", runId: "r1", storyId: "US-A", cycleId: "c1", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "preset", presetSha256: "sha", hostId: "host", ts: 1000 }),
      ev({ type: "delta:role_started", delegationId: "d1", storyId: "US-A", role: "builder", sessionId: "s1", roleInstanceId: "ri1", hostId: "host", modelId: "model", identityProvenance: { kind: "host-native", hostId: "host", roleInstanceId: "ri1" }, worktreeAccess: "builder-write", ts: 1100 }),
      ev({ type: "delta:artifact_published", delegationId: "d1", storyId: "US-A", role: "builder", path: ".roll/artifacts/d1.json", ts: 1500 }),
      ev({ type: "delta:terminal", delegationId: "d1", storyId: "US-A", outcome: "abandoned", terminalBinding: "handoff_only", ts: 2000 }),
      // US-A attempt d2 — handoff then owner merge (line 5-10)
      ev({ type: "delta:prepared", delegationId: "d2", runId: "r2", storyId: "US-A", cycleId: "c2", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "preset", presetSha256: "sha", hostId: "host", ts: 3000 }),
      ev({ type: "delta:role_started", delegationId: "d2", storyId: "US-A", role: "builder", sessionId: "s2", roleInstanceId: "ri2", hostId: "host", modelId: "model", identityProvenance: { kind: "host-native", hostId: "host", roleInstanceId: "ri2" }, worktreeAccess: "builder-write", ts: 3100 }),
      ev({ type: "delta:artifact_published", delegationId: "d2", storyId: "US-A", role: "builder", path: ".roll/artifacts/d2.json", ts: 3600 }),
      ev({ type: "delta:terminal", delegationId: "d2", storyId: "US-A", outcome: "handoff_ready", terminalBinding: "handoff_only", ts: 4000 }),
      ev({ type: "delivery:published", cycleId: "c2", storyId: "US-A", branch: "delta/d2", prNumber: 42, prUrl: "https://example.test/pr/42", ts: 4100 }),
      ev({ type: "delivery:merge_confirmed", cycleId: "c2", storyId: "US-A", branch: "delta/d2", prNumber: 42, signal: "ancestor", ts: 4500 }),
      // US-B attempt d3 — handoff only, never merged (line 11-14)
      ev({ type: "delta:prepared", delegationId: "d3", runId: "r3", storyId: "US-B", cycleId: "c3", trigger: "host-guided", topology: "delta-team", qualityProfile: "designed", presetId: "preset", presetSha256: "sha", hostId: "host", ts: 5000 }),
      ev({ type: "delta:role_started", delegationId: "d3", storyId: "US-B", role: "builder", sessionId: "s3", roleInstanceId: "ri3", hostId: "host", modelId: "model", identityProvenance: { kind: "host-native", hostId: "host", roleInstanceId: "ri3" }, worktreeAccess: "builder-write", ts: 5100 }),
      ev({ type: "delta:artifact_published", delegationId: "d3", storyId: "US-B", role: "builder", path: ".roll/artifacts/d3.json", ts: 5500 }),
      ev({ type: "delta:terminal", delegationId: "d3", storyId: "US-B", outcome: "handoff_ready", terminalBinding: "handoff_only", ts: 6000 }),
    ];
    writeFileSync(join(dir, ".roll", "events.ndjson"), events.join("\n") + "\n");
    writeFileSync(join(dir, ".roll", "loop", "events.ndjson"), "");
    return dir;
  }

  it("freezes the worked example as one EN/ZH/JSON view with feature totals", () => {
    const dir = workedFixture();
    const args = parseDeliveryArgs(["delivery", "delta-team"]); if ("error" in args) throw new Error(args.error);
    const result = readFeatureDelivery(dir, args); if (!result.ok) throw new Error(result.message);
    const view = result.view;
    const usA = view.cards.find((c) => c.id === "US-A");
    const usB = view.cards.find((c) => c.id === "US-B");
    expect(usA?.finalState).toBe("delivered");
    expect(usA?.attempts.map((a) => a.attemptId)).toEqual(["delta:d1", "delta:d2"]);
    expect(usA?.attempts.map((a) => a.outcome)).toEqual(["failed", "handoff_ready"]);
    expect(usB?.finalState).toBe("handoff_ready");
    expect(usB?.attempts.map((a) => a.attemptId)).toEqual(["delta:d3"]);
    expect(usB?.attempts.map((a) => a.outcome)).toEqual(["handoff_ready"]);
    expect(view.summary.cards).toBe(2);
    expect(view.summary.attempts).toBe(3);
    expect(view.summary.states.delivered).toBe(1);
    expect(view.summary.states.handoff_ready).toBe(1);
    expect(view.summary.firstPassDeliveryRate).toMatchObject({ numerator: 0, denominator: 0, value: null, excludedIncomplete: 1 });
    expect(view.summary.rework.attemptsAfterFirst).toBe(1);
    expect(view.summary.elapsed.sampleSize).toBe(3);
    // JSON scrubbed only of the randomized temp root (existing convention).
    expect(JSON.parse(JSON.stringify(view).replaceAll(dir, "<fixture>"))).toMatchSnapshot("worked-example-json");
    expect(renderFeatureDelivery(view)).toMatchSnapshot("worked-example-en");
    process.env["ROLL_LANG"] = "zh";
    try {
      expect(renderFeatureDelivery(view)).toMatchSnapshot("worked-example-zh");
    } finally {
      delete process.env["ROLL_LANG"];
    }
  });

  it("reads .roll fact files only — digests unchanged, no writes, no subprocess", () => {
    const dir = workedFixture();
    const digest = (p: string): string => createHash("sha256").update(readFileSync(p, "utf8")).digest("hex");
    const factFiles = [".roll/backlog.md", ".roll/index.json", ".roll/events.ndjson", ".roll/loop/events.ndjson"].map((rel) => join(dir, rel));
    const before = factFiles.map((p) => digest(p));
    const args = parseDeliveryArgs(["delivery", "delta-team"]); if ("error" in args) throw new Error(args.error);
    const writeSpy = vi.spyOn(fsCjs, "writeFileSync");
    const execSpy = vi.spyOn(childProcessCjs, "execFileSync");
    const readSpy = vi.spyOn(fsCjs, "readFileSync");
    const existsSpy = vi.spyOn(fsCjs, "existsSync");
    writeSpy.mockClear(); execSpy.mockClear(); readSpy.mockClear(); existsSpy.mockClear();
    try {
      const result = readFeatureDelivery(dir, args); if (!result.ok) throw new Error(result.message);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
      const allowedReads = [".roll/backlog.md", ".roll/index.json", ".roll/events.ndjson", ".roll/loop/events.ndjson"].map((rel) => join(dir, rel));
      for (const call of readSpy.mock.calls) {
        const p = String(call[0]);
        expect(allowedReads, `adapter must only read fact files, not ${p}`).toContain(p);
      }
      for (const call of existsSpy.mock.calls) {
        const p = String(call[0]);
        expect(p.startsWith(join(dir, ".roll")), `adapter must only stat .roll paths, not ${p}`).toBe(true);
      }
    } finally {
      writeSpy.mockRestore(); execSpy.mockRestore(); readSpy.mockRestore(); existsSpy.mockRestore();
    }
    const after = factFiles.map((p) => digest(p));
    expect(after).toEqual(before);
  });
});
