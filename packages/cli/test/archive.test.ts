/**
 * US-META-001 — archive-layout helpers: ID→epic index (pure build + deterministic
 * serialize), live epic resolution + uncategorized fallback, card-dir write path,
 * and the old-layout read compat resolver.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { indexCommand } from "../src/commands/index-gen.js";
import { buildDossierRunCache, collectGitDossierFacts, collectStoryDossierInput } from "../src/lib/story-dossier.js";
import {
  buildStoryIndex,
  cardArchiveDir,
  epicForStory,
  bulkLiveEpics,
  findFeatureFile,
  findFeatureFiles,
  generateIndex,
  isRunArtifactDir,
  liveEpicOf,
  mountExecutionAtPublish,
  readIndex,
  reviewFileName,
  reportFileName,
  serializeIndex,
} from "../src/lib/archive.js";

const dirs: string[] = [];
// FIX-281: the two `roll index command` cases below run indexCommand() in tmp
// projects; pin ROLL_HOME to a tmp dir so the US-DOSSIER-028 self-register can
// never write the real ~/.roll/projects.json.
let savedRollHome: string | undefined;
let rollHomeSandbox: string;
beforeAll(() => {
  savedRollHome = process.env["ROLL_HOME"];
  rollHomeSandbox = mkdtempSync(join(tmpdir(), "roll-archive-home-"));
  dirs.push(rollHomeSandbox);
  process.env["ROLL_HOME"] = rollHomeSandbox;
});
afterAll(() => {
  for (const d of dirs) execSync(`rm -rf '${d}'`);
  if (savedRollHome === undefined) delete process.env["ROLL_HOME"];
  else process.env["ROLL_HOME"] = savedRollHome;
});

function project(rows: string[], features: Array<[string, string]> = []): string {
  const proj = mkdtempSync(join(tmpdir(), "roll-archive-"));
  dirs.push(proj);
  mkdirSync(join(proj, ".roll"), { recursive: true });
  const head = ["| Story | Description | Status |", "|---|---|---|"];
  writeFileSync(join(proj, ".roll", "backlog.md"), [...head, ...rows].join("\n") + "\n");
  for (const [rel, body] of features) {
    const p = join(proj, ".roll", "features", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return proj;
}

describe("buildStoryIndex", () => {
  it("records only stories the resolver can place; omits the rest", () => {
    const epicOf = (id: string): string | null => (id === "US-A-1" ? "alpha" : id === "FIX-B-2" ? "beta" : null);
    const idx = buildStoryIndex(["US-A-1", "FIX-B-2", "US-C-3"], epicOf);
    expect(idx).toEqual({ "US-A-1": "alpha", "FIX-B-2": "beta" });
    expect(idx["US-C-3"]).toBeUndefined();
  });
});

describe("serializeIndex", () => {
  it("is deterministic: sorted keys, byte-identical regardless of insertion order", () => {
    const a = serializeIndex({ "US-Z-9": "z", "US-A-1": "a" });
    const b = serializeIndex({ "US-A-1": "a", "US-Z-9": "z" });
    expect(a).toBe(b);
    expect(a.indexOf("US-A-1")).toBeLessThan(a.indexOf("US-Z-9"));
    expect(a.endsWith("\n")).toBe(true);
    expect(JSON.parse(a)).toEqual({ stories: { "US-A-1": "a", "US-Z-9": "z" } });
  });
});

describe("reportFileName", () => {
  it("keeps the legacy report alias for one release cycle", () => {
    expect(reportFileName("US-META-001")).toBe("US-META-001-report.html");
  });
});

describe("reviewFileName", () => {
  it("is the primary Acceptance Review Page filename", () => {
    expect(reviewFileName("US-REVIEW-001")).toBe("US-REVIEW-001-review.html");
  });
});

describe("liveEpicOf", () => {
  it("resolves the epic from the feature file's directory", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"], [["alpha/US-A-1.md", "# US-A-1\n"]]);
    expect(liveEpicOf(proj, "US-A-1")).toBe("alpha");
  });
  it("resolves the epic from a live card directory even when spec/index are absent", () => {
    const proj = project(["| US-OBS-035 | x | 📋 Todo |"]);
    const cardDir = join(proj, ".roll", "features", "loop-observability", "US-OBS-035");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "ac-map.json"), "[]\n");
    expect(liveEpicOf(proj, "US-OBS-035")).toBe("loop-observability");
  });
  it("returns null when no feature file exists (→ uncategorized at call site)", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"]);
    expect(liveEpicOf(proj, "US-A-1")).toBeNull();
  });
});

// FIX-1483 — the run-artifact heuristic used to run at EVERY depth, so an epic
// whose own name starts with `cycle-` was skipped whole: every card of the real
// `cycle-efficiency` epic was invisible to `roll attest` ("story not found") and
// could never earn an acceptance report. Epics live at depth 0; run artifacts
// only ever live inside a card folder.
describe("FIX-1483 — a cycle-* epic is not mistaken for a cycle run directory", () => {
  it("resolves a card under an epic named cycle-efficiency", () => {
    const proj = project(
      ["| US-CYCLE-001 | x | ✅ Done |"],
      [["cycle-efficiency/US-CYCLE-001/spec.md", "# US-CYCLE-001\n"]],
    );
    expect(findFeatureFile(proj, "US-CYCLE-001")).toBe(
      join(proj, ".roll", "features", "cycle-efficiency", "US-CYCLE-001", "spec.md"),
    );
    expect(liveEpicOf(proj, "US-CYCLE-001")).toBe("cycle-efficiency");
    expect(bulkLiveEpics(proj, ["US-CYCLE-001"]).get("US-CYCLE-001")).toBe("cycle-efficiency");
  });

  it("still skips run artifacts INSIDE a card folder (cycle-<id>, latest, timestamped)", () => {
    const proj = project(["| US-A-1 | x | ✅ Done |"], [["alpha/US-A-1/spec.md", "# US-A-1\n"]]);
    for (const run of ["cycle-42", "latest", "2026-07-27T10-00-00", "evidence", "pre-evidence-backfill"]) {
      const dir = join(proj, ".roll", "features", "alpha", "US-A-1", run);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "spec.md"), "# US-A-1 stale run copy\n");
    }
    expect(findFeatureFiles(proj, "US-A-1")).toEqual([
      join(proj, ".roll", "features", "alpha", "US-A-1", "spec.md"),
    ]);
  });

  // Depth boundary (codex review): epics sit at depth 0, card folders at depth 1,
  // run artifacts at depth 2+. Gating at depth ≥ 1 would still swallow a legacy
  // feature-slug folder like `cycle-meta-sync/` that legitimately owns specs.
  it("isRunArtifactDir: run artifacts only from depth 2 (epic 0, card 1)", () => {
    const runNames = [
      "cycle-42",
      "latest",
      "notes",
      "evidence",
      "screenshots",
      "pre-evidence-backfill",
      "2026-07-27T10-00-00",
    ];
    for (const name of ["cycle-efficiency", ...runNames]) {
      expect(isRunArtifactDir(name, 0), `epic level: ${name}`).toBe(false);
      expect(isRunArtifactDir(name, 1), `card level: ${name}`).toBe(false);
    }
    for (const name of runNames) {
      expect(isRunArtifactDir(name, 2), `run level: ${name}`).toBe(true);
      expect(isRunArtifactDir(name, 3), `nested run level: ${name}`).toBe(true);
    }
    expect(isRunArtifactDir("US-CYCLE-001", 2)).toBe(false);
  });

  it("resolves a card under a legacy feature-slug folder named cycle-*", () => {
    const proj = project(
      ["| FIX-9001 | x | ✅ Done |"],
      [["autonomous-evolution/cycle-meta-sync/FIX-9001.md", "# FIX-9001\n"]],
    );
    expect(findFeatureFile(proj, "FIX-9001")).toBe(
      join(proj, ".roll", "features", "autonomous-evolution", "cycle-meta-sync", "FIX-9001.md"),
    );
  });
});

describe("bulkLiveEpics — FIX-1059 symlinked feature files", () => {
  it("resolves a story whose flat <ID>.md is a symlink to the real spec", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-archive-symlink-"));
    dirs.push(proj);
    // The real spec lives OUTSIDE the features tree (the main checkout); the only
    // in-tree reference is a symlinked flat <ID>.md under an epic. No card
    // subdirectory, so the directory-owner pass cannot resolve it — only the
    // symlink-aware file pass can place the story under its epic.
    const realSpec = join(proj, "persistent-FIX-1057.md");
    writeFileSync(realSpec, "# FIX-1057\n");
    const linkDir = join(proj, ".roll", "features", "beta");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(realSpec, join(linkDir, "FIX-1057.md"));
    expect(bulkLiveEpics(proj, ["FIX-1057"]).get("FIX-1057")).toBe("beta");
  });
  it("ignores a broken symlinked feature file (story → null)", () => {
    const proj = mkdtempSync(join(tmpdir(), "roll-archive-broken-"));
    dirs.push(proj);
    const epicDir = join(proj, ".roll", "features", "alpha");
    mkdirSync(epicDir, { recursive: true });
    symlinkSync(join(proj, ".roll", "features", "gone.md"), join(epicDir, "FIX-1058.md"));
    expect(bulkLiveEpics(proj, ["FIX-1058"]).get("FIX-1058")).toBeNull();
  });
});

describe("generateIndex", () => {
  it("writes .roll/index.json from backlog, idempotent (byte-identical re-run)", () => {
    const proj = project(
      ["| US-A-1 | x | 📋 Todo |", "| FIX-B-2 | y | ✅ Done |", "| US-C-3 | z | 📋 Todo |"],
      [["alpha/US-A-1.md", "# US-A-1\n"], ["beta/FIX-B-2.md", "# FIX-B-2\n"]],
    );
    const first = generateIndex(proj);
    expect(first).toEqual({ "US-A-1": "alpha", "FIX-B-2": "beta" }); // US-C-3 unplaceable → omitted
    const onDisk1 = readFileSync(join(proj, ".roll", "index.json"), "utf8");
    generateIndex(proj);
    const onDisk2 = readFileSync(join(proj, ".roll", "index.json"), "utf8");
    expect(onDisk2).toBe(onDisk1); // idempotent
    expect(readIndex(proj)).toEqual({ "US-A-1": "alpha", "FIX-B-2": "beta" });
  });

  it("records a backlog story whose live card directory exists without spec.md", () => {
    const proj = project(["| US-OBS-035 | x | 📋 Todo |"]);
    mkdirSync(join(proj, ".roll", "features", "loop-observability", "US-OBS-035"), { recursive: true });
    expect(generateIndex(proj)).toEqual({ "US-OBS-035": "loop-observability" });
  });
});

describe("epicForStory", () => {
  // US-V4-001: the live filesystem is authoritative; a stale index entry must NOT
  // override the story's real on-disk home. (Inverts the v3 index-first order so
  // attest no longer depends on a freshly regenerated .roll/index.json.)
  it("prefers the live walk over a (possibly stale) index entry", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"], [["alpha/US-A-1.md", "# US-A-1\n"]]);
    writeFileSync(join(proj, ".roll", "index.json"), serializeIndex({ "US-A-1": "stale-pin" }));
    expect(epicForStory(proj, "US-A-1")).toBe("alpha");
  });
  it("falls back to the index cache only when the live walk finds nothing", () => {
    // No feature markdown on disk → live walk returns null → index cache resolves.
    const proj = project(["| US-A-1 | x | 📋 Todo |"]);
    writeFileSync(join(proj, ".roll", "index.json"), serializeIndex({ "US-A-1": "cached" }));
    expect(epicForStory(proj, "US-A-1")).toBe("cached");
  });
  it("resolves a story from its live feature file with no index at all", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"], [["alpha/US-A-1.md", "# US-A-1\n"]]);
    expect(epicForStory(proj, "US-A-1")).toBe("alpha");
  });
});

describe("cardArchiveDir", () => {
  it("places a resolved story under features/<epic>/<ID>", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"], [["alpha/US-A-1.md", "# US-A-1\n"]]);
    expect(cardArchiveDir(proj, "US-A-1")).toBe(join(proj, ".roll", "features", "alpha", "US-A-1"));
  });
  it("uses the live card directory as the write/read home when spec.md is absent", () => {
    const proj = project(["| US-OBS-035 | x | 📋 Todo |"]);
    mkdirSync(join(proj, ".roll", "features", "loop-observability", "US-OBS-035"), { recursive: true });
    expect(cardArchiveDir(proj, "US-OBS-035")).toBe(
      join(proj, ".roll", "features", "loop-observability", "US-OBS-035"),
    );
  });
  it("falls back to features/uncategorized/<ID> when no epic resolves (never blocks)", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"]);
    expect(cardArchiveDir(proj, "US-NOPE-9")).toBe(join(proj, ".roll", "features", "uncategorized", "US-NOPE-9"));
  });
});

describe("roll index command", () => {
  it("regenerates .roll/index.json from the cwd project", () => {
    const proj = project(["| US-A-1 | x | 📋 Todo |"], [["alpha/US-A-1.md", "# US-A-1\n"]]);
    const save = process.cwd();
    process.chdir(proj);
    const o = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (): boolean => true;
    try {
      expect(indexCommand([])).toBe(0);
    } finally {
      process.stdout.write = o;
      process.chdir(save);
    }
    expect(existsSync(join(proj, ".roll", "index.json"))).toBe(true);
    expect(readIndex(proj)).toEqual({ "US-A-1": "alpha" });
  });

  it("US-DOSSIER-007: default index preserves an existing story page (mount board); --rebuild re-renders it", () => {
    const proj = project(
      ["| US-A-1 | x | ✅ Done |"],
      [["alpha/US-A-1/spec.md", "---\nid: US-A-1\ntitle: A\n---\n# US-A-1\n"]],
    );
    const storyIdx = join(proj, ".roll", "features", "alpha", "US-A-1", "index.html");
    // a live page carrying content the source can't reconstruct (squash-removed PR).
    writeFileSync(storyIdx, "<html>MOUNTED-PR-999</html>");
    const save = process.cwd();
    process.chdir(proj);
    const o = process.stdout.write.bind(process.stdout);
    // @ts-expect-error capture-only
    process.stdout.write = (): boolean => true;
    try {
      // default: never clobber an existing story page.
      expect(indexCommand([])).toBe(0);
      expect(readFileSync(storyIdx, "utf8")).toContain("MOUNTED-PR-999");
      // --rebuild: explicit reconciliation re-renders from source.
      expect(indexCommand(["--rebuild"])).toBe(0);
      const after = readFileSync(storyIdx, "utf8");
      expect(after).not.toContain("MOUNTED-PR-999");
      expect(after).toContain("Story Dossier");
    } finally {
      process.stdout.write = o;
      process.chdir(save);
    }
  });
});

describe("mountExecutionAtPublish — US-DOSSIER-007 AC2", () => {
  it("mounts PR# onto the execution section of an existing story page; no-op when the anchor is absent", () => {
    const proj = project(["| US-A-1 | x | ✅ Done |"], [["alpha/US-A-1.md", "# US-A-1\n"]]);
    const dir = join(proj, ".roll", "features", "alpha", "US-A-1");
    mkdirSync(dir, { recursive: true });
    const idx = join(dir, "index.html");
    writeFileSync(
      idx,
      '<html><section class="phase phase-pending" data-phase="execution"><h2>x</h2><p class="empty">e</p></section></html>',
    );
    expect(mountExecutionAtPublish(proj, "US-A-1", "https://github.com/o/r/pull/777")).toBe(true);
    const out = readFileSync(idx, "utf8");
    expect(out).toContain('class="phase phase-done" data-phase="execution"');
    expect(out).toContain("PR #777");
    expect(out).toContain('href="https://github.com/o/r/pull/777"');
    // no execution anchor on the page → best-effort no-op, returns false.
    writeFileSync(idx, "<html>no anchor here</html>");
    expect(mountExecutionAtPublish(proj, "US-A-1", "https://github.com/o/r/pull/777")).toBe(false);
    // missing page → false, never throws.
    expect(mountExecutionAtPublish(proj, "US-NOPE-9", "https://github.com/o/r/pull/1")).toBe(false);
  });
});

// US-META-002c: resolveReadArchiveDir retired with the legacy verification/ tree.

// FIX-275: the bulk one-walk resolver must produce EXACTLY what the per-ID
// liveEpicOf walk produced — same owner priority (ID-owned, later-in-walk
// wins), same content-mention fallback (first in walk order), same null.
describe("FIX-275 — bulkLiveEpics equivalence", () => {
  it("matches per-ID liveEpicOf across owner kinds, multi-owner, content mentions, misses", () => {
    const proj = project(
      [
        "| US-A-1 | id-owned flat | 📋 Todo |",
        "| US-B-2 | id-owned card folder | 📋 Todo |",
        "| US-C-3 | content mention only | 📋 Todo |",
        "| US-D-4 | multiple owners | 📋 Todo |",
        "| US-E-5 | no trace anywhere | 📋 Todo |",
        "| US-F-6 | directory-only owner | 📋 Todo |",
        "| US-C-30 | id prefix sibling | 📋 Todo |",
      ],
      [
        ["alpha/US-A-1.md", "# US-A-1\n"],
        ["beta/US-B-2/spec.md", "# US-B-2\n"],
        ["alpha/notes-page.md", "mentions US-C-3 and US-C-30 in prose\n"],
        ["alpha/US-D-4.md", "# US-D-4 first owner\n"],
        ["zeta/US-D-4/spec.md", "# US-D-4 second owner\n"],
      ],
    );
    mkdirSync(join(proj, ".roll", "features", "omega", "US-F-6"), { recursive: true });
    const ids = ["US-A-1", "US-B-2", "US-C-3", "US-D-4", "US-E-5", "US-C-30"];
    ids.push("US-F-6");
    const bulk = bulkLiveEpics(proj, ids);
    for (const id of ids) {
      expect(bulk.get(id) ?? null, id).toBe(liveEpicOf(proj, id));
    }
  });

  it("generateIndex output is byte-identical to the per-ID construction", () => {
    const proj = project(
      ["| US-A-1 | x | 📋 Todo |", "| FIX-B-2 | y | ✅ Done |", "| US-C-3 | z | 📋 Todo |"],
      [["alpha/US-A-1.md", "# US-A-1\n"], ["beta/FIX-B-2.md", "# FIX-B-2\n"]],
    );
    const viaBulk = generateIndex(proj);
    const viaPerId = buildStoryIndex(["US-A-1", "FIX-B-2", "US-C-3"], (id) => liveEpicOf(proj, id));
    expect(viaBulk).toEqual(viaPerId);
    expect(readFileSync(join(proj, ".roll", "index.json"), "utf8")).toBe(serializeIndex(viaPerId));
  });
});

// FIX-275 (root cause, profiled): `roll index` spent 55% of wall-clock in
// per-card `git log --grep` spawns (~3 per card). One snapshot spawn must
// reproduce the per-card semantics exactly.
describe("FIX-275 — git dossier facts snapshot equivalence", () => {
  it("snapshot-backed input equals the per-card execGit input", () => {
    const proj = project(
      ["| US-G-1 | a | ✅ Done |", "| US-G-2 | b | 📋 Todo |"],
      [["alpha/US-G-1/spec.md", "# US-G-1\n"], ["alpha/US-G-2/spec.md", "# US-G-2\n"]],
    );
    const git = (args: string) => execSync(`git ${args}`, { cwd: proj, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init -q");
    writeFileSync(join(proj, "a.ts"), "1");
    git("add -A && git -C . commit -qm 'tcr: US-G-1 first step'");
    writeFileSync(join(proj, "b.ts"), "2");
    git("add -A && git -C . commit -qm 'Story US-G-1: shipped (#123)'");
    writeFileSync(join(proj, "c.ts"), "3");
    git("add -A && git -C . commit -qm 'unrelated change\n\nbody mentions US-G-2 only'");

    const story1 = { id: "US-G-1", epic: "alpha", title: "a", status: "done" } as never;
    const story2 = { id: "US-G-2", epic: "alpha", title: "b", status: "todo" } as never;
    expect(collectGitDossierFacts(proj)).not.toBeNull();
    const cache = buildDossierRunCache(proj);
    expect(cache.git).not.toBeNull();
    const savedRenderNow = process.env["ROLL_RENDER_NOW"];
    process.env["ROLL_RENDER_NOW"] = "2026-07-15T00:00:00.000Z";
    try {
      for (const story of [story1, story2]) {
        const legacy = collectStoryDossierInput(proj, story);
        const snap = collectStoryDossierInput(proj, story, cache);
        expect(snap).toEqual(legacy);
      }
    } finally {
      if (savedRenderNow === undefined) delete process.env["ROLL_RENDER_NOW"];
      else process.env["ROLL_RENDER_NOW"] = savedRenderNow;
    }
    // body-only mention still counts (git --grep matches the full message)
    const viaSnap = collectStoryDossierInput(proj, story2, cache);
    expect(viaSnap.commits?.some((c) => c.includes("unrelated change"))).toBe(true);
  });

  it("non-git directory yields null facts and a git-free input", () => {
    const proj = project(["| US-G-1 | a | 📋 Todo |"], [["alpha/US-G-1/spec.md", "# US-G-1\n"]]);
    expect(collectGitDossierFacts(proj)).toBeNull();
  });
});
