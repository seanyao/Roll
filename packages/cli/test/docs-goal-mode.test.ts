import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

function doc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("FIX-256 — goal mode docs and site wording", () => {
  // US-LOOP-113: there is no scheduled mode to contrast goal mode WITH. What the
  // guides must still document is the go lock (two sessions cannot race) and the
  // pause/resume path.
  it("English and Chinese loop guides document the go lock and pause/resume", () => {
    const en = doc("guide/en/loop.md");
    expect(en).toContain("### The go lock");
    expect(en).toContain("go.lock");
    expect(en).toMatch(/paused[\s\S]{0,200}resume/i);
    expect(en).not.toMatch(/scheduled tick/i);

    const zh = doc("guide/zh/loop.md");
    expect(zh).toContain("### go 锁");
    expect(zh).toContain("go.lock");
    expect(zh).toMatch(/paused|已暂停/);
    expect(zh).toContain("resume");
    expect(zh).not.toContain("定时 tick");
  });

  // US-LOOP-113: there is no "scheduler is off" state to distinguish from paused —
  // resident scheduling is retired. What the READMEs must still explain is that the
  // session drives, and that pause/resume gate autonomous progress.
  it("READMEs explain session-driven delivery and the pause/resume gate", () => {
    for (const f of ["README.md", "README_CN.md"]) {
      const d = doc(f);
      expect(d, f).toMatch(/roll loop go/);
      expect(d, f).toMatch(/roll loop pause[\s\S]{0,400}roll loop resume/);
      // And no longer advertises the removed scheduler verbs.
      expect(d, f).not.toMatch(/roll loop on\b/);
      expect(d, f).not.toMatch(/roll loop off\b/);
      expect(d, f).not.toMatch(/roll loop fallback\b/);
    }
  });

  /**
   * US-LOOP-120: this used to assert the site said "goal mode" and listed
   * "loop / pr / dream" service status. Both were framings against a scheduler:
   * "goal mode" only meant something as the opposite of scheduled ticks, and the
   * three-service snapshot described lanes that no longer exist. What the site
   * must show now is the command and the two run states.
   */
  it("site presents roll loop go and the two run states, not scheduler lanes", () => {
    const site = doc("site/roll-data.js");
    expect(site).toContain("roll loop go");
    expect(site).toMatch(/ACTIVE ?\/ ?PAUSED|ACTIVE \/ PAUSED/);
    // No lane inventory, in either language.
    expect(site).not.toContain("loop / dream / brief");
    expect(site).not.toContain("loop, dream and brief");
    expect(site).not.toContain("loop / pr / dream");
    expect(site).not.toContain("scheduled tick");
    expect(site).not.toContain("定时 tick");
  });
});
