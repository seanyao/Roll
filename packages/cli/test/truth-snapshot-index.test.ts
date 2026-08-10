/**
 * US-DOSSIER-010 — `roll index` writes truth.json next to index.html, embeds
 * the SAME serialized snapshot in the page, and never swallows failures in the
 * cycle aggregate (the FIX-248 regression pinned for good).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexCommand } from "../src/commands/index-gen.js";
import { reconciledLedger, cyclesLedgerJson } from "../src/commands/cycles.js";

// FIX-283: a project root OUTSIDE the OS temp dir — the unconditional tmp-skip
// (AC3) means a cwd under tmpdir() is NEVER self-registered, even with ROLL_HOME
// set. The repo (worktree) root is not under tmpdir(), so a fixture under it is a
// "real" path for the skip rule's purposes. Cleaned up like the tmp fixtures.
const REPO_ROOT = resolve(__dirname, "../../..");

const dirs: string[] = [];
// FIX-281: redirect the cross-project registry into a tmp ROLL_HOME so the
// US-DOSSIER-028 self-register `roll index` performs can never write the real
// ~/.roll/projects.json during the suite.
let savedRollHome: string | undefined;
beforeEach(() => {
  savedRollHome = process.env["ROLL_HOME"];
  const h = mkdtempSync(join(tmpdir(), "roll-truthsnap-home-"));
  dirs.push(h);
  process.env["ROLL_HOME"] = h;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env["ROLL_RENDER_NOW"];
  delete process.env["ROLL_BRAND_NAME"];
  if (savedRollHome === undefined) delete process.env["ROLL_HOME"];
  else process.env["ROLL_HOME"] = savedRollHome;
});

function project(root: string = tmpdir()): string {
  const p = mkdtempSync(join(root, "roll-truthsnap-"));
  dirs.push(p);
  mkdirSync(join(p, ".roll", "loop"), { recursive: true });
  writeFileSync(
    join(p, ".roll", "backlog.md"),
    [
      "| Story | Description | Status |",
      "|---|---|---|",
      "| US-T-1 | a | ✅ Done |",
      "| US-T-2 | b | 📋 Todo |",
      "| US-T-3 | c | 🔨 In Progress |",
      "| US-T-4 | d | 🚫 Hold |",
    ].join("\n") + "\n",
  );
  for (const id of ["US-T-1", "US-T-2", "US-T-3", "US-T-4"]) {
    mkdirSync(join(p, ".roll", "features", "alpha", id), { recursive: true });
    writeFileSync(join(p, ".roll", "features", "alpha", id, "spec.md"), `---\nid: ${id}\ntitle: t\n---\n# ${id}\n`);
  }
  // Cycle rows inside the 72h window: one delivered + failed/reverted/blocked.
  const rows = [
    { cycle_id: "c1", status: "done", outcome: "delivered", story_id: "US-T-1", merge_commit: "abc", cost_usd: 0.5, ts: "2026-06-12T20:00:00Z" },
    { cycle_id: "c2", status: "failed", ts: "2026-06-12T21:00:00Z", cost_usd: 0.1 },
    { cycle_id: "c3", status: "reverted", ts: "2026-06-12T22:00:00Z", cost_usd: 0.1 },
    { cycle_id: "c4", status: "blocked", ts: "2026-06-12T23:00:00Z", cost_usd: 0.1 },
  ];
  writeFileSync(join(p, ".roll", "loop", "runs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(
    join(p, ".roll", "loop", "events.ndjson"),
    [
      { type: "cycle:start", cycleId: "c1", storyId: "US-T-1", agent: "codex", ts: 1_000 },
      { type: "cycle:phase", cycleId: "c1", phase: "execute", ts: 2_000 },
      { type: "cycle:tcr", cycleId: "c1", commitHash: "abcdef123", message: "tcr: one", ts: 3_000 },
      { type: "pr:merge", prNumber: 91, storyId: "US-T-1", ts: 4_000 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return p;
}

async function runIndex(p: string): Promise<void> {
  const save = process.cwd();
  process.chdir(p);
  const o = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    expect(indexCommand([])).toBe(0);
  } finally {
    process.stdout.write = o;
    process.chdir(save);
  }
}

describe("US-DOSSIER-010 — truth.json next to index.html", () => {
  it("writes the snapshot file with story/cycle aggregates and a generated stamp", async () => {
    const p = project();
    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);
    const path = join(p, ".roll", "features", "truth.json");
    expect(existsSync(path)).toBe(true);
    const snap = JSON.parse(readFileSync(path, "utf8"));
    expect(snap.generatedAt).toBe("2026-06-13T00:00:00Z");
    expect(snap.story.total).toBe(4);
    expect(Object.values(snap.story.spectrum).reduce((a: number, b) => a + (b as number), 0)).toBe(4);
    expect(snap.cycle.cycles3d).toBe(4);
  });

  it("AC3: the page embed and truth.json come from the same serialization", async () => {
    const p = project();
    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);
    const file = readFileSync(join(p, ".roll", "features", "truth.json"), "utf8");
    const html = readFileSync(join(p, ".roll", "features", "index.html"), "utf8");
    const m = /<script id="roll-truth" type="application\/json">\n([\s\S]*?)<\/script>/.exec(html);
    expect(m?.[1]).toBeDefined();
    const embedded = (m?.[1] ?? "").replace(/<\\\//g, "</");
    expect(embedded).toBe(file); // byte-equal: same object, same serialization
    expect(JSON.parse(embedded)).toEqual(JSON.parse(file));
  });

  it("AC4 (FIX-248 regression): failed3d counts failed + reverted + blocked, equals the row-by-row sum", async () => {
    const p = project();
    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);
    const snap = JSON.parse(readFileSync(join(p, ".roll", "features", "truth.json"), "utf8"));
    expect(snap.cycle.failed3d).toBe(3); // c2 failed + c3 reverted + c4 blocked; c1 delivered not counted
  });

  it("US-LOOP-078: roll index materializes per-cycle ActivitySignal jsonl for replay", async () => {
    const p = project();
    await runIndex(p);
    const path = join(p, ".roll", "loop", "cycle-c1.signals.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((s) => [s.seg, s.kind, s.signalKind, s.summary])).toEqual([
      ["cycle", "lifecycle", undefined, "周期开始 · cycle start · US-T-1"],
      ["build", "lifecycle", undefined, "阶段 · phase · execute"],
      ["build", "tcr", "tcr", "TCR abcdef123 · tcr: one"],
      ["pr", "pr", "pr", "PR #91 合并 · merged"],
    ]);
  });

  // FIX-337 (AC1): the truth.json `cycle` aggregate is derived from the SAME
  // canonical reconciled ledger `roll cycles` renders — so `roll status` (reads
  // truth.json) and `roll cycles --since 3d` can never show divergent numbers.
  it("FIX-337 (AC1): truth.json cycle counts/cost == `roll cycles` (reconciledLedger), byte-identical口径", async () => {
    const p = project();
    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    const nowSec = Math.floor(Date.parse("2026-06-13T00:00:00Z") / 1000);
    await runIndex(p);
    const snap = JSON.parse(readFileSync(join(p, ".roll", "features", "truth.json"), "utf8"));
    // What `roll cycles --since 3d` (the canonical CLI source) would compute:
    const cli = cyclesLedgerJson(reconciledLedger(p), "3d", nowSec) as {
      cycles: number; failed: number; costByCurrency: Record<string, number>;
    };
    expect(snap.cycle.cycles3d).toBe(cli.cycles); // same total
    expect(snap.cycle.failed3d).toBe(cli.failed); // same failed cluster
    // same cost口径 (USD scalar mirrors the per-currency USD total).
    expect(snap.cycle.costUsd3d).toBeCloseTo(cli.costByCurrency["USD"] ?? 0, 4);
  });

  // FIX-337 (AC1+AC3): a FAILED cycle whose story is backlog-Done is reconciled to
  // `superseded` (the card landed elsewhere), so it must NOT inflate failed3d —
  // and the SAME reconcile shows on `roll cycles`, proving the single source.
  it("FIX-337 (AC1/AC3): a failed cycle for a Done card is `superseded` on BOTH surfaces (not counted failed)", async () => {
    const p = mkdtempSync(join(tmpdir(), "roll-truthsnap-sup-"));
    dirs.push(p);
    mkdirSync(join(p, ".roll", "loop"), { recursive: true });
    writeFileSync(
      join(p, ".roll", "backlog.md"),
      ["| Story | Description | Status |", "|---|---|---|", "| FIX-900 | landed manually | ✅ Done |"].join("\n") + "\n",
    );
    mkdirSync(join(p, ".roll", "features", "alpha", "FIX-900"), { recursive: true });
    writeFileSync(join(p, ".roll", "features", "alpha", "FIX-900", "spec.md"), `---\nid: FIX-900\ntitle: t\n---\n# FIX-900\n`);
    // One delivered + one FAILED cycle, both inside 3d. The failed cycle's story
    // FIX-900 is backlog-Done → it is SUPERSEDED, not a live failure.
    const rows = [
      { cycle_id: "d1", status: "merged", outcome: "delivered", story_id: "US-OK", merge_commit: "abc", cost_usd: 0.5, ts: "2026-06-12T20:00:00Z" },
      { cycle_id: "f1", status: "failed", outcome: "failed", story_id: "FIX-900", cost_usd: 0.1, ts: "2026-06-12T21:00:00Z" },
    ];
    writeFileSync(join(p, ".roll", "loop", "runs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    const nowSec = Math.floor(Date.parse("2026-06-13T00:00:00Z") / 1000);
    await runIndex(p);

    // CLI source: the failed cycle reconciles to `superseded`, so failed === 0.
    const rec = reconciledLedger(p);
    expect(rec.find((r) => r.cycleId === "f1")?.verdict).toBe("superseded");
    const cli = cyclesLedgerJson(rec, "3d", nowSec) as { failed: number; buckets: Record<string, number> };
    expect(cli.failed).toBe(0);
    expect(cli.buckets["superseded"]).toBe(1);

    // truth.json (what `roll status` reads) agrees — failed3d is 0, not 1.
    const snap = JSON.parse(readFileSync(join(p, ".roll", "features", "truth.json"), "utf8"));
    expect(snap.cycle.failed3d).toBe(0);
    expect(snap.cycle.cycles3d).toBe(2);
  });

  // US-DOSSIER-021 — the per-story ladder + evidence registry rides the ONE snapshot.
  it("US-DOSSIER-021: truth.json carries stories[] with ladder + evidence; aggregate unchanged; embed === file", async () => {
    const p = project();
    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);
    const file = readFileSync(join(p, ".roll", "features", "truth.json"), "utf8");
    const snap = JSON.parse(file);
    // aggregate is unchanged: still 4 stories, sums to total.
    expect(snap.story.total).toBe(4);
    expect(Object.values(snap.story.spectrum).reduce((a: number, b) => a + (b as number), 0)).toBe(4);
    // the registry has one row per story, deterministic epic→id order.
    expect(Array.isArray(snap.stories)).toBe(true);
    expect(snap.stories.map((s: { id: string }) => s.id)).toEqual(["US-T-1", "US-T-2", "US-T-3", "US-T-4"]);
    for (const row of snap.stories) {
      expect(row).toHaveProperty("epic", "alpha");
      expect(["claimed", "merged", "attested", "none"]).toContain(row.ladder);
      expect(row.evidence).toHaveProperty("report");
      expect(row.evidence).toHaveProperty("acMap");
      expect(row.evidence).toHaveProperty("visualEvidence");
      expect(typeof row.legacy).toBe("boolean");
    }
    // the spectrum aggregate equals folding the registry's truthState column.
    const folded: Record<string, number> = { done: 0, wip: 0, hold: 0, todo: 0, fail: 0, unknown: 0 };
    for (const row of snap.stories) folded[row.truthState] += 1;
    expect(folded).toEqual(snap.story.spectrum);
    // AC3 still holds with the larger payload: the page embed === truth.json bytes.
    const html = readFileSync(join(p, ".roll", "features", "index.html"), "utf8");
    const m = /<script id="roll-truth" type="application\/json">\n([\s\S]*?)<\/script>/.exec(html);
    const embedded = (m?.[1] ?? "").replace(/<\\\//g, "</");
    expect(embedded).toBe(file);
  });

  it("US-OBS-029: truth.json carries dossier panel slots collected by collectDossierState", async () => {
    const p = project();
    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);

    const snap = JSON.parse(readFileSync(join(p, ".roll", "features", "truth.json"), "utf8"));

    expect(snap.panels.casting.status).toBe("ready");
    expect(snap.panels.casting.data).toHaveProperty("configured");
    expect(snap.panels.charter.status).toBe("ready");
    expect(snap.panels.charter.data).toHaveProperty("groups");
    expect(snap.panels.skills.status).toBe("ready");
    expect(snap.panels.skills.data).toHaveProperty("summary");
    expect(snap.panels.gitHooks.status).toBe("ready");
    expect(snap.panels.gitHooks.data).toHaveProperty("hooksPath");
    expect(snap.panels.liveFeed.status).toBe("ready");
    expect(snap.panels.liveFeed.data).toHaveProperty("status");
  });

  // FIX-283 — a REAL (non-tmp) project with ROLL_HOME set writes the cross-project
  // row ONLY to <ROLL_HOME>/.roll/projects.json, and the real ~/.roll/projects.json
  // is never touched. (Replaces the FIX-281 case that used a tmp project: under
  // FIX-283 a tmp cwd is now skipped unconditionally — covered below.)
  it("FIX-283: self-register honors ROLL_HOME — real project → sandbox registry only, real home untouched", async () => {
    const p = project(REPO_ROOT); // OUTSIDE tmpdir → a "real" path for the skip rule
    const sandbox = process.env["ROLL_HOME"]!; // set in beforeEach
    const realRegistry = join(homedir(), ".roll", "projects.json");
    const realBefore = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;

    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);

    // the row landed in the tmp ROLL_HOME registry, pointing at this project.
    const sandboxRegistry = join(sandbox, ".roll", "projects.json");
    expect(existsSync(sandboxRegistry)).toBe(true);
    const rows = JSON.parse(readFileSync(sandboxRegistry, "utf8")) as Array<{ path: string }>;
    expect(rows.length).toBe(1);
    // index-gen records process.cwd(), which is the resolved realpath on macOS
    // (/var → /private/var); compare against the same resolution, not raw `p`.
    expect(rows[0]?.path).toBe(realpathSync(p));

    // the real ~/.roll/projects.json is byte-for-byte unchanged (and uncreated if
    // it never existed) — the whole point of the fix.
    const realAfter = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;
    expect(realAfter).toBe(realBefore);
    // US-INSTALL-008: 45s, not 15s. This case copies a tree and runs a full
    // `roll index`; it asserts BEHAVIOUR, never speed. The product repo moved to
    // a private repo on the Free plan, whose Actions runners are ~2.4x slower
    // than the public-repo runners it used to get (measured: same suite 2.5-3min
    // → 6-7.5min), and 15s stopped being enough. A timeout that fails on a
    // slower machine is testing the machine.
  }, 45_000);

  it("FIX-307: self-register and page chrome use the derived git remote project name", async () => {
    const p = project(REPO_ROOT);
    const remoteRoot = mkdtempSync(join(tmpdir(), "roll-truthsnap-remote-"));
    dirs.push(remoteRoot);
    const remote = join(remoteRoot, "APE-PR.git");
    execFileSync("git", ["init", "--bare", "-q", remote]);
    execFileSync("git", ["init", "-q"], { cwd: p });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: p });

    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);

    const sandboxRegistry = join(process.env["ROLL_HOME"]!, ".roll", "projects.json");
    const rows = JSON.parse(readFileSync(sandboxRegistry, "utf8")) as Array<{ name: string; slug: string; path: string }>;
    expect(rows[0]).toMatchObject({
      name: "APE-PR",
      slug: expect.stringContaining("ape-pr-"),
      path: realpathSync(p),
    });
    const html = readFileSync(join(p, ".roll", "features", "index.html"), "utf8");
    expect(html).toContain("APE-PR");
  }, 15_000);

  it("US-OBS-019: roll index writes reachable-only project rows into truth.json", async () => {
    const p = project(REPO_ROOT);
    const tempRow = mkdtempSync(join(tmpdir(), "roll-truthsnap-project-row-"));
    dirs.push(tempRow);
    const sandboxRegistry = join(process.env["ROLL_HOME"]!, ".roll", "projects.json");
    mkdirSync(dirname(sandboxRegistry), { recursive: true });
    writeFileSync(
      sandboxRegistry,
      JSON.stringify([
        { name: "real", slug: "real", path: realpathSync(p), releaseTag: "v1.0.0", verdict: "pass" },
        { name: "deleted", slug: "deleted", path: join(p, "deleted-project") },
        { name: "tmp", slug: "tmp", path: tempRow },
      ], null, 2) + "\n",
    );

    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p);

    const snap = JSON.parse(readFileSync(join(p, ".roll", "features", "truth.json"), "utf8")) as {
      projects?: Array<{ slug: string; path: string }>;
    };
    const projects = snap.projects ?? [];
    expect(projects.map((row) => row.slug)).toContain("real");
    expect(projects.map((row) => row.slug)).not.toContain("deleted");
    expect(projects.map((row) => row.slug)).not.toContain("tmp");
    expect(projects.map((row) => row.path)).toContain(realpathSync(p));
  }, 15_000);

  // FIX-283 (AC3) — robust tmp-skip: a tmp fixture cwd is skipped REGARDLESS of
  // whether ROLL_HOME is set. Even with ROLL_HOME pointing at a sandbox, a tmp
  // cwd is never self-registered (belt-and-suspenders beyond FIX-281), so a test
  // fixture can never leak even when a test forgot to sandbox ROLL_HOME.
  it("FIX-283: ROLL_HOME set + tmp cwd → self-register still skipped (sandbox stays empty)", async () => {
    const p = project(); // under tmpdir()
    const sandbox = process.env["ROLL_HOME"]!; // set in beforeEach
    const realRegistry = join(homedir(), ".roll", "projects.json");
    const realBefore = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;

    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p); // index still succeeds and renders the board

    expect(existsSync(join(p, ".roll", "features", "index.html"))).toBe(true);
    // tmp cwd → no row written, even to the sandbox registry.
    const sandboxRegistry = join(sandbox, ".roll", "projects.json");
    expect(existsSync(sandboxRegistry)).toBe(false);
    const realAfter = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;
    expect(realAfter).toBe(realBefore); // real registry untouched
  });

  // FIX-281/FIX-283 belt-and-braces — with ROLL_HOME UNSET, a tmp fixture cwd is
  // skipped: the self-register never persists a throwaway row into the real registry.
  it("FIX-283: ROLL_HOME unset + tmp cwd → self-register skipped, real home untouched", async () => {
    const p = project();
    delete process.env["ROLL_HOME"]; // resolve to the REAL ~/.roll
    const realRegistry = join(homedir(), ".roll", "projects.json");
    const realBefore = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;

    process.env["ROLL_RENDER_NOW"] = "2026-06-13T00:00:00Z";
    await runIndex(p); // index still succeeds and renders the board

    expect(existsSync(join(p, ".roll", "features", "index.html"))).toBe(true);
    const realAfter = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;
    expect(realAfter).toBe(realBefore); // tmp fixture row was NOT persisted
  });
});
