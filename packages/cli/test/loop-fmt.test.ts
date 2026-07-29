/**
 * US-LOOP-077 — CLI render + `roll loop fmt` stdin→stdout glue.
 *
 * The core (activity-signal.ts) decides WHAT each stream line means (the standard
 * ActivitySignal); this layer decides how it LOOKS (category column, color by
 * kind, tier gating) and pipes a whole stream through the agent's normalizer.
 * Color is asserted off for determinism — the structure (visible text by tier)
 * is what matters. Key claim: codex/generic streams are NOT blank, claude stays
 * equivalent, and --verbose reveals tier C.
 */
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cycleRow, fmtModel, renderState } from "../src/render.js";
import { formatStream, renderSignal, streamThroughRenderer, tierVisible } from "../src/commands/loop-fmt.js";

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "roll.js");

renderState.useColor = false; // deterministic, plain-text assertions

/** FIX-1269: poll for an observable condition instead of sleeping a guessed
 *  wall-clock amount — fixed sleeps flake on loaded CI runners. */
async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("renderSignal", () => {
  it("renders a tcr signal with category + summary + detail", () => {
    const s = renderSignal({ ts: 0, cycleId: "c", seg: "build", kind: "tcr", tier: "A", summary: "abc1234", detail: "add thing", result: "pass" });
    expect(s).toContain("tcr");
    expect(s).toContain("abc1234");
    expect(s).toContain("add thing");
  });
  it("renders a muted edit line carrying the basename", () => {
    const s = renderSignal({ ts: 0, cycleId: "c", seg: "build", kind: "edit", tier: "B", summary: "loop-fmt.ts" });
    expect(s).toContain("loop-fmt.ts");
  });
  it("renders a lifecycle banner carrying the summary", () => {
    const s = renderSignal({ ts: 0, cycleId: "c", seg: "end", kind: "lifecycle", tier: "A", summary: "cycle done", detail: "3 tcr · 42s" });
    expect(s).toContain("cycle done");
    expect(s).toContain("3 tcr");
  });
  it("an alert (result=fail) still renders its summary + detail", () => {
    const s = renderSignal({ ts: 0, cycleId: "c", seg: "build", kind: "alert", tier: "A", summary: "tool", detail: "boom", result: "fail" });
    expect(s).toContain("error");
    expect(s).toContain("boom");
  });
  it("a heartbeat renders its still-alive summary", () => {
    const s = renderSignal({ ts: 0, cycleId: "c", seg: "ci", kind: "heartbeat", tier: "A", summary: "…still in ci · 50s · last: roll ci" });
    expect(s).toContain("still in ci");
    expect(s).toContain("last: roll ci");
  });
});

describe("streamThroughRenderer — status heartbeat", () => {
  it("renders event-backed status heartbeats and suppresses unchanged duplicates", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));

    let calls = 0;
    const done = streamThroughRenderer(input, output, {
      agent: "claude",
      verbose: false,
      gapMs: 10,
      status: () => {
        calls += 1;
        return calls < 3
          ? "status  phase execute · quiet 5m · US-LOOP-046 · codex · cycle c1 · 1 TCR · last building"
          : "status  phase execute · quiet 6m · US-LOOP-046 · codex · cycle c1 · 1 TCR · last building";
      },
    });

    // FIX-1269: a fixed 45ms sleep assumed ≥3 interval ticks — loaded CI runners
    // deliver fewer and the second heartbeat never rendered. Wait for the
    // observable outcome instead of a wall-clock guess.
    await waitUntil(() => chunks.join("").includes("quiet 6m"));
    input.end();
    await done;

    const lines = chunks.join("").trim().split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("quiet 5m");
    expect(lines[1]).toContain("quiet 6m");
  });

  it("emits a multi-line status block with only the final status line timestamped (US-OBS-044)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));

    let calls = 0;
    const done = streamThroughRenderer(input, output, {
      agent: "claude",
      verbose: false,
      gapMs: 10,
      status: () => {
        calls += 1;
        if (calls === 1) return "status  phase execute · quiet 5m · FIX-1049 · claude · cycle c1 · 1 TCR";
        return [
          "────────────────────────────────────────────────────────",
          "↳ story transition",
          "  previous: FIX-1049 · published_pending_merge · 1 TCR · builder claude",
          "  next:     FIX-1050 · next story brief",
          "  builder:  kimi · selected by route policy",
          "  plan:     pending",
          "────────────────────────────────────────────────────────",
          "status  phase execute · quiet <1m · FIX-1050 · kimi · cycle c2 · 0 TCR",
        ].join("\n");
      },
    });

    // FIX-1269: wait for the transition block to render, not a fixed sleep.
    await waitUntil(() => chunks.join("").includes("quiet <1m · FIX-1050"));
    input.end();
    await done;

    const lines = chunks.join("").trim().split("\n").filter((line) => line !== "");
    // Transition framing lines are emitted without a leading timestamp.
    const transitionStart = lines.findIndex((l) => l.includes("↳ story transition"));
    expect(transitionStart).toBeGreaterThan(0);
    expect(lines[transitionStart - 1]).toMatch(/^─+$/);
    // The status line that follows the transition block carries the wall-clock timestamp.
    const statusAfter = lines.slice(transitionStart).find((l) => l.includes("status  phase execute · quiet <1m · FIX-1050"));
    expect(statusAfter).toBeDefined();
    expect(statusAfter).toMatch(/^\d{2}:\d{2}:\d{2}  status  phase execute · quiet <1m · FIX-1050 · kimi · cycle c2 · 0 TCR/);
    // The earlier status for FIX-1049 also has a timestamp.
    const firstStatus = lines.find((l) => l.includes("status  phase execute · quiet 5m · FIX-1049"));
    expect(firstStatus).toMatch(/^\d{2}:\d{2}:\d{2}  status  phase execute · quiet 5m · FIX-1049 · claude · cycle c1 · 1 TCR/);
  });
});

describe("FIX-313 — downstream agent presentation uses AgentSpec", () => {
  it("fmtModel keeps non-claude model names instead of degrading to ?", () => {
    expect(fmtModel("gpt-5.5")).toBe("gpt-5.5");
    expect(fmtModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });

  it("cycle rows render an honest dash when the ledger model is missing (FIX-1262: no source-baked default)", () => {
    const row = cycleRow({
      outcome: "done",
      start_hhmm: "10:00",
      duration_s: 60,
      input_tokens: 0,
      output_tokens: 0,
      model: null,
      story: "FIX-313",
      agent: "kimi",
    });
    // FIX-313 used to backfill specs.ts agentDefaultModel here; FIX-1262 removed
    // that config-in-source fallback — a missing ledger model must show as "—",
    // never a fabricated model name.
    expect(row.join("\n")).not.toContain("kimi-k2");
    expect(row.join("\n")).toContain("—");
  });

  it("cycle rows surface the tool summary without changing the native cost currency", () => {
    const row = cycleRow({
      outcome: "done",
      start_hhmm: "10:00",
      duration_s: 60,
      input_tokens: 0,
      output_tokens: 0,
      cost_currency: "CNY",
      cost_list: 1.25,
      story: "US-TOOL-012",
      agent: "qwen",
      tool_summary: "bash×3(21s)·browser×1(3.0s)",
    });
    const out = row.join("\n");
    expect(out).toContain("¥1.25");
    expect(out).toContain("bash×3(21s)·browser×1(3.0s)");
    expect(out).not.toContain("$1.25");
  });

    // US-LOOP-117: defaultSmokeCmd is gone with `roll loop test`.
});

describe("tierVisible", () => {
  it("default shows A and B, hides C", () => {
    expect(tierVisible("A", false)).toBe(true);
    expect(tierVisible("B", false)).toBe(true);
    expect(tierVisible("C", false)).toBe(false);
  });
  it("verbose shows everything including C", () => {
    expect(tierVisible("C", true)).toBe(true);
  });
});

describe("formatStream — claude routes to the claude stream normalizer", () => {
  it("folds a claude stream into visible activity signals", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/x.ts" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "let me think" }] } }),
    ];
    const out = formatStream(lines, "claude");
    expect(out.length).toBe(1);
    expect(out[0]).toContain("x.ts");
    expect(formatStream(lines, "claude", { verbose: true }).length).toBeGreaterThanOrEqual(1);
  });

  it("text-only claude assistant chunks remain quiet by default", () => {
    const lines = [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "let me think" }] } })];
    expect(formatStream(lines, "claude").length).toBe(0);
    expect(formatStream(lines, "claude", { verbose: true }).length).toBe(1);
  });
});

describe("formatStream — non-claude agents are NOT blank (the US-LOOP-077 fix)", () => {
  it("a generic (kimi/pi) agent passes lines through only with --verbose (tier C)", () => {
    const lines = ["pi: thinking about the task", "pi: done"];
    expect(formatStream(lines, "pi").length).toBe(0); // tier C hidden by default
    const v = formatStream(lines, "pi", { verbose: true });
    expect(v.length).toBe(2);
    expect(v[0]).toContain("thinking about the task");
  });
  it("an unknown agent name routes to generic (no agent-specific branch downstream)", () => {
    const out = formatStream(["something-new agent output line"], "brand-new-agent", { verbose: true });
    expect(out.length).toBe(1);
    expect(out[0]).toContain("agent output line");
  });
});

describe("formatStream — resilience", () => {
  it("a torn JSON line does not break the generic stream", () => {
    const lines = [
      '{"type":"assist', // torn — tolerated
      "── cycle 20260613-3 · FIX-1 · agent kimi ──",
    ];
    const out = formatStream(lines, "claude");
    expect(out.length).toBe(1); // only the tier-A banner is visible by default
    expect(out[0]).toContain("FIX-1");
  });
});

describe("E2E — `roll loop fmt` golden path (spawned binary, stdin→stdout)", () => {
  it("a claude cycle surfaces the banner and hides tier-C noise via the pipe", () => {
    const stream = [
      "── cycle 20260606-1 · US-PORT-012 · agent claude ──",
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "planning" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/loop-fmt.ts" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", duration_ms: 12000, total_cost_usd: 0.05 }),
    ].join("\n") + "\n";

    const out = execFileSync("node", [CLI_BIN, "loop", "fmt"], {
      input: stream,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", ROLL_LOOP_AGENT: "claude" },
    });
    expect(out).toContain("US-PORT-012"); // cycle banner (tier A) is visible
    expect(out).not.toContain("planning"); // thinking body hidden by default
    expect(out).not.toContain('"type"'); // no raw json leaked by default
  });

  it("a generic cycle reveals its tier-C bodies under --verbose via the pipe", () => {
    const stream = [
      "── cycle 20260613-2 · FIX-9 · agent kimi ──",
      "editing src/foo.ts",
      "ran pnpm test",
    ].join("\n") + "\n";

    const out = execFileSync("node", [CLI_BIN, "loop", "fmt", "--verbose"], {
      input: stream,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", ROLL_LOOP_AGENT: "kimi" },
    });
    expect(out).toContain("FIX-9"); // banner
    expect(out).toContain("foo.ts"); // tier-C body now surfaced under --verbose
    expect(out).toContain("pnpm test"); // tier-C body now surfaced under --verbose
    expect(out.trim().split("\n").length).toBeGreaterThanOrEqual(3); // demonstrably not blank
  });
});
