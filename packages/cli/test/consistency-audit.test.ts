/**
 * US-TRUTH-002 — the cli gatherer + shadow contract.
 *
 * gatherAuditSnapshot assembles the fact-source snapshot read-only (backlog,
 * index, runs, events, attest probes, injected PR evidence); the command
 * writes the dated report under .roll/reports/consistency/ and exits 0 even
 * when drift is present (AC5 — shadow never blocks anything).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_SCHEMA_EPOCH_SEC,
  consistencyAuditCommand,
  gatherAuditSnapshot,
} from "../src/lib/consistency-audit.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
});

const NOW = TERMINAL_SCHEMA_EPOCH_SEC + 2 * 86400;
const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A drifty project: premature Done, phantom-failed run, missing attest. */
function project(): { proj: string; rt: string } {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "roll-002-proj-")));
  dirs.push(proj);
  const rt = join(proj, ".roll", "loop");
  mkdirSync(rt, { recursive: true });
  writeFileSync(
    join(proj, ".roll", "backlog.md"),
    [
      "| ID | Description | Status |",
      "|----|----|----|",
      "| [US-DRIFT-1](.roll/features/e/US-DRIFT-1/spec.md) | premature done | ✅ Done · PR#10 |",
      "| [US-CLEAN-1](.roll/features/e/US-CLEAN-1/spec.md) | merged fine | ✅ Done · PR#11 |",
      "| [US-TODO-1](.roll/features/e/US-TODO-1/spec.md) | not in index | 📋 Todo |",
      "",
    ].join("\n"),
  );
  writeFileSync(join(proj, ".roll", "index.json"), JSON.stringify({ stories: { "US-DRIFT-1": "e", "US-CLEAN-1": "e" } }));
  // card folders: US-CLEAN-1 has report+map; US-DRIFT-1 has a folder but no report
  const clean = join(proj, ".roll", "features", "e", "US-CLEAN-1");
  mkdirSync(join(clean, "latest"), { recursive: true });
  writeFileSync(join(clean, "latest", "US-CLEAN-1-report.html"), "<html/>");
  writeFileSync(join(clean, "ac-map.json"), "[]");
  mkdirSync(join(proj, ".roll", "features", "e", "US-DRIFT-1"), { recursive: true });
  // runs: one phantom-failed (branch PR merged), one post-epoch delivered without cost
  writeFileSync(
    join(rt, "runs.jsonl"),
    [
      JSON.stringify({ run_id: "C1", cycle_id: "C1", status: "failed", outcome: "failed", ts: iso(NOW - 7200) }),
      JSON.stringify({ run_id: "C2", cycle_id: "C2", status: "done", outcome: "delivered", ts: iso(NOW - 7200) }),
    ].join("\n") + "\n",
  );
  // events: one failed cycle:end in window (runs also count 1 → counters agree)
  writeFileSync(
    join(rt, "events.ndjson"),
    JSON.stringify({ type: "cycle:end", cycleId: "C1", outcome: "failed", cost: {}, ts: NOW - 7200 }) + "\n",
  );
  return { proj, rt };
}

const fakeFetch = vi.fn(async (_slug: string, ref: string) => {
  if (ref === "10") return { state: "OPEN", mergedAt: undefined, mergeCommit: undefined };
  if (ref === "11") return { state: "MERGED", mergedAt: iso(NOW - 9000), mergeCommit: "m11" };
  if (ref === "loop/cycle-C1") return { state: "MERGED", mergedAt: iso(NOW - 7000), mergeCommit: "mc1" };
  return undefined;
});

describe("gatherAuditSnapshot — read-only fact assembly", () => {
  it("collects backlog/index/runs/attest and injected PR evidence", async () => {
    const { proj, rt } = project();
    const { snapshot } = await gatherAuditSnapshot(proj, rt, { slug: "o/r", fetchInfo: fakeFetch, nowSec: NOW });
    expect(snapshot.backlog.map((b) => b.id)).toEqual(["US-DRIFT-1", "US-CLEAN-1", "US-TODO-1"]);
    expect(snapshot.prEvidence["US-DRIFT-1"]).toMatchObject({ state: "OPEN" });
    expect(snapshot.prEvidence["US-CLEAN-1"]).toMatchObject({ state: "MERGED" });
    expect(snapshot.cycleBranchEvidence["C1"]).toMatchObject({ state: "MERGED" });
    expect(snapshot.attest["US-CLEAN-1"]).toMatchObject({ report: true, acMap: true, visualEvidence: false, machineSkip: false });
    expect(snapshot.attest["US-DRIFT-1"]).toMatchObject({ report: false, acMap: false, visualEvidence: false, machineSkip: false });
    expect(snapshot.runsFailedCount).toBe(1);
    expect(snapshot.eventFailedCount).toBe(1);
  });

  it("records local main drift from the injected git probe", async () => {
    const { proj, rt } = project();
    const { snapshot } = await gatherAuditSnapshot(proj, rt, {
      slug: "o/r",
      fetchInfo: fakeFetch,
      localMainAhead: async () => 2,
      nowSec: NOW,
    });
    expect(snapshot.localMainAhead).toBe(2);
  });
});

describe("consistencyAuditCommand — shadow contract (AC5/AC6)", () => {
  it("writes the dated report, prints a summary, and exits 0 despite fail-level drift", async () => {
    const { proj } = project();
    const prevCwd = process.cwd();
    const prevRt = process.env["ROLL_PROJECT_RUNTIME_DIR"];
    process.chdir(proj);
    delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    const out: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (c: string | Uint8Array): boolean => (out.push(String(c)), true);
    let rc: number;
    try {
      rc = await consistencyAuditCommand([], { slug: "o/r", fetchInfo: fakeFetch, localMainAhead: async () => 2, nowSec: NOW });
    } finally {
      process.stdout.write = realWrite;
      process.chdir(prevCwd);
      if (prevRt !== undefined) process.env["ROLL_PROJECT_RUNTIME_DIR"] = prevRt;
    }
    expect(rc).toBe(0); // drift present, exit still 0 — shadow mode
    const dateTag = new Date(NOW * 1000).toISOString().slice(0, 10);
    const jsonPath = join(proj, ".roll", "reports", "consistency", `${dateTag}.json`);
    const mdPath = join(proj, ".roll", "reports", "consistency", `${dateTag}.md`);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as { findings: Array<{ rule: string; subject: string; severity: string }> };
    // the three seeded drifts are found
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "done-no-merge", subject: "US-DRIFT-1", severity: "fail" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "merge-not-backfilled", subject: "C1", severity: "fail" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "done-missing-attest", subject: "US-DRIFT-1", severity: "fail" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "local-main-ahead", subject: "main", severity: "fail" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "index-missing-live-card", subject: "US-TODO-1", severity: "warn" }));
    expect(out.join("")).toContain("consistency audit (shadow)");
  });

  it("no slug (gh absent) → all evidence lanes unknown, still exit 0", async () => {
    const { proj } = project();
    const prevCwd = process.cwd();
    process.chdir(proj);
    const realWrite = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (): boolean => true;
    let rc: number;
    try {
      rc = await consistencyAuditCommand(["--json"], { fetchInfo: async () => undefined, slug: undefined, nowSec: NOW });
    } finally {
      process.stdout.write = realWrite;
      process.chdir(prevCwd);
    }
    expect(rc).toBe(0);
  });
});
