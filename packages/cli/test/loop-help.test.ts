/**
 * US-DOSSIER-035 — grouped `roll loop --help` (design frame 4).
 *
 * Four labeled bands in the design order (control / observe / alerts /
 * maintain); every live loop subcommand lands in a band (no verb dropped);
 * EN/中 single-language snapshots.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLoopHelp } from "../src/lib/loop-help.js";
import { stripAnsi } from "../src/render.js";

const help = (lang: "en" | "zh"): string => stripAnsi(renderLoopHelp(lang));

// Every live `roll loop <sub>` arm in commands/index.ts (retired stubs excluded:
// monitor / attach / branches / test-quality-check just print a redirect).
/**
 * US-LOOP-113 (codex review r1): the old hand-maintained list had drifted — it
 * listed verbs that no longer exist and omitted live ones. DERIVE the live set
 * from the dispatch source instead, so the help can never silently fall behind.
 */
const INDEX_SRC = readFileSync(new URL("../src/commands/index.ts", import.meta.url), "utf8");
const LOOP_DISPATCH = INDEX_SRC.slice(INDEX_SRC.indexOf('command === "loop"'));
const DISPATCHED = [...new Set([...LOOP_DISPATCH.matchAll(/args\[0\] === "([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!))];

// Retirement stubs that only print a redirect (US-PORT-007/022) — deliberately
// not advertised as live verbs.
const STUBS = new Set(["monitor", "attach", "branches", "test-quality-check"]);
const LIVE_SUBCOMMANDS = DISPATCHED.filter((s) => !STUBS.has(s));

// US-LOOP-113: these installed, removed, or poked a resident scheduler. They are
// gone with no stub, so the help must NOT advertise them. `pause`/`resume` are NOT
// here — PAUSE is a live gate the correction circuit breaker writes automatically,
// so `resume` is the only supported way out of a paused project.
const RETIRED_SUBCOMMANDS = ["on", "off", "now", "fallback"];

describe("roll loop --help groups — US-DOSSIER-035", () => {
  it("AC5: four labeled bands in the design order, replacing the flat pipe list", () => {
    const out = help("en");
    const iControl = out.indexOf("control");
    const iObserve = out.indexOf("observe");
    const iAlerts = out.indexOf("alerts");
    const iMaintain = out.indexOf("maintain");
    expect(iControl).toBeGreaterThan(-1);
    expect(iControl).toBeLessThan(iObserve);
    expect(iObserve).toBeLessThan(iAlerts);
    expect(iAlerts).toBeLessThan(iMaintain);
    // the flat "on|off|now|…" pipe list is gone
    expect(out).not.toContain("on|off|now");
  });

  it("AC5: the design verbs sit in their assigned band", () => {
    const out = help("en");
    expect(out).toMatch(/control\s+go · goal · pause · resume · reset · recover · reconcile/);
    expect(out).toMatch(/observe\s+watch · status · runs · log · events · signals · eval · cycles · cycle/);
    expect(out).toMatch(/alerts\s+alert list · alert ack · alert resolve · alert log/);
    expect(out).toMatch(/maintain\s+gc · fmt · mute · unmute · reconcile-pending · pardon-skip-list/);
  });

  it("AC5: no live loop subcommand is dropped — each appears somewhere in the help", () => {
    const out = help("en");
    for (const sub of LIVE_SUBCOMMANDS) {
      expect(out, `live subcommand "${sub}" must appear in the grouped help`).toContain(sub);
    }
  });

  it("US-LOOP-113: the retired scheduler verbs are not advertised", () => {
    // Scope the check to the VERB BANDS, not the prose — English sentences legally
    // contain words like "on", so scanning free text would false-positive.
    const bands = help("en")
      .split("\n")
      .filter((l) => /^(control|observe|alerts|maintain|internal)\s/.test(l))
      .map((l) => l.replace(/^\S+\s+/, "").split(" · ").map((v) => v.trim()));
    const advertised = new Set(bands.flat());
    for (const sub of RETIRED_SUBCOMMANDS) {
      expect(advertised.has(sub), `retired verb "${sub}" must be gone from the bands`).toBe(false);
    }
    // Sanity: the check can actually see verbs (guards against an empty scan).
    expect(advertised.has("go")).toBe(true);
    expect(advertised.has("status")).toBe(true);
  });

  it("US-LOOP-113: --help documents the two honest run-states and who drives", () => {
    const en = help("en");
    // Two states. DORMANT described a lane unloading itself; there is no lane.
    expect(en).toMatch(/states\s+ACTIVE.*PAUSED/);
    expect(en).not.toContain("DORMANT");
    // A tripped breaker also pauses, so the way out must be named.
    expect(en).toContain("roll loop resume");
    // And it says plainly that nothing advances without a session.
    expect(en).toMatch(/drive\s+open an agent session and run roll loop go/);
    expect(en).toContain("nothing advances on its own");
    const zh = help("zh");
    expect(zh).toMatch(/状态\s+ACTIVE.*PAUSED/);
    expect(zh).not.toContain("DORMANT");
    expect(zh).toContain("没有任何东西会自行推进");
  });

  it("US-LOOP-079m AC4: EN and 中 each their own block — no inline language mix on the state lines", () => {
    // EN block carries no CJK; 中 block carries the CJK labels.
    expect(/[一-鿿]/.test(help("en"))).toBe(false);
    expect(help("zh")).toContain("已暂停");
  });

  it("AC6: EN/中 snapshots (single-language per locale, color scrubbed)", () => {
    expect(help("en")).toMatchSnapshot();
    expect(help("zh")).toMatchSnapshot();
  });
});
