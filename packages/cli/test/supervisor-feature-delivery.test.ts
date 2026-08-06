import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeliveryArgs, readFeatureDelivery, renderFeatureDelivery } from "../src/lib/feature-delivery-supervisor.js";

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
