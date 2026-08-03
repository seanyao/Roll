/**
 * US-PORT-019 — pure GitHub-issues→backlog mapping core (port of
 * lib/github_sync.py's pure functions). No network, no fs.
 */
import { describe, expect, it } from "vitest";
import {
  appendRowsToTable,
  dryRunPreview,
  existingStoryIdForIssue,
  extractAcItems,
  filterIssuesByLabel,
  ghId,
  ghIdPresent,
  issueHasLabel,
  issueToRow,
  mapLabelToType,
  mapStateToStatus,
  parseLabelsFilter,
  parseLinkHeader,
  readSyncConfig,
  renderAcSection,
  renderSyncBlock,
  storyIdFromIssue,
  syncToBacklog,
  writeSyncBlock,
  type GhIssue,
} from "../src/backlog/github-sync.js";

const issue = (o: Partial<GhIssue>): GhIssue => o;

describe("label/state/id/row mapping", () => {
  it("mapLabelToType: first known label wins, else US", () => {
    expect(mapLabelToType([{ name: "bug" }])).toBe("FIX");
    expect(mapLabelToType([{ name: "P1" }, { name: "refactor" }])).toBe("REFACTOR");
    expect(mapLabelToType([{ name: "enhancement" }])).toBe("US");
    expect(mapLabelToType([{ name: "feature" }])).toBe("US");
    expect(mapLabelToType(["us"])).toBe("US");
    expect(mapLabelToType([])).toBe("US");
    expect(mapLabelToType([{ name: "wontfix" }])).toBe("US");
  });
  it("mapStateToStatus: external state never decides planning completion", () => {
    expect(mapStateToStatus("open")).toBe("📋 Todo");
    expect(mapStateToStatus("closed")).toBe("📋 Todo");
    expect(mapStateToStatus("weird")).toBe("📋 Todo");
  });
  it("uses one canonical Story identity across id, link, and status projection", () => {
    expect(ghId(issue({ number: 13 }))).toBe("GH-13");
    expect(storyIdFromIssue(issue({ number: 13, labels: [{ name: "bug" }] }))).toBe("FIX-GH-13");
    expect(issueToRow(issue({ number: 13, title: "do a thing", state: "open", labels: [{ name: "bug" }] }))).toBe(
      "| [FIX-GH-13](backlog-lifecycle/FIX-GH-13/spec.md) | do a thing | 📋 Todo |",
    );
  });
});

describe("ghIdPresent boundary", () => {
  it("GH-1 does not match GH-13 (and vice versa)", () => {
    const content = "| US-GH-13 | x | 📋 Todo |";
    expect(ghIdPresent(content, "GH-13")).toBe(true);
    expect(ghIdPresent(content, "GH-1")).toBe(false);
    expect(ghIdPresent(content, "GH-3")).toBe(false);
  });
  it("recovers the durable Story ID when labels change", () => {
    const content =
      "| [US-GH-8](backlog-lifecycle/US-GH-8/spec.md) | mentions GH-7 in prose | 📋 Todo |\n" +
      "| [US-GH-7](backlog-lifecycle/US-GH-7/spec.md) | imported | 📋 Todo |\n";
    const relabeled = issue({ number: 7, labels: [{ name: "bug" }] });
    expect(existingStoryIdForIssue(content, relabeled)).toBe("US-GH-7");
    expect(dryRunPreview([relabeled], content).lines).toEqual(["= US-GH-7 [US] (skipped, already exists)"]);
    expect(syncToBacklog([relabeled], content).skippedIds).toEqual(["US-GH-7"]);
  });
});

describe("appendRowsToTable", () => {
  it("inserts after the last body row of the first table", () => {
    const content = "| ID | D | S |\n|----|---|---|\n| A-1 | a | x |\n\n## notes\nfoo\n";
    const out = appendRowsToTable(content, ["| B-2 | b | y |"]);
    const lines = out.split("\n");
    expect(lines[2]).toBe("| A-1 | a | x |");
    expect(lines[3]).toBe("| B-2 | b | y |"); // appended after last body row
    expect(out).toContain("## notes"); // trailing content preserved
  });
  it("no table → appends at end", () => {
    expect(appendRowsToTable("prose\n", ["| X-1 | x | t |"])).toBe("prose\n| X-1 | x | t |\n");
  });
  it("no rows → content unchanged", () => {
    expect(appendRowsToTable("anything", [])).toBe("anything");
  });
});

describe("label filter + AC extraction", () => {
  it("parseLabelsFilter lowercases, dedups, drops empty", () => {
    expect(parseLabelsFilter("P1, bug ,bug,")).toEqual(["p1", "bug"]);
    expect(parseLabelsFilter("")).toEqual([]);
  });
  it("issueHasLabel OR semantics; empty wanted matches all", () => {
    const i = issue({ labels: [{ name: "bug" }, { name: "P2" }] });
    expect(issueHasLabel(i, [])).toBe(true);
    expect(issueHasLabel(i, ["p2"])).toBe(true);
    expect(issueHasLabel(i, ["nope"])).toBe(false);
  });
  it("filterIssuesByLabel filters; empty wanted passthrough", () => {
    const a = issue({ number: 1, labels: [{ name: "bug" }] });
    const b = issue({ number: 2, labels: [{ name: "doc" }] });
    expect(filterIssuesByLabel([a, b], ["bug"])).toEqual([a]);
    expect(filterIssuesByLabel([a, b], [])).toEqual([a, b]);
  });
  it("extractAcItems: top-level checkboxes only, nested ignored", () => {
    const body = "- [ ] first\n  - [ ] nested skip\n* [x] second\nplain line\n- [ ] third\n";
    expect(extractAcItems(body)).toEqual(["first", "second", "third"]);
    expect(renderAcSection(issue({ body }))).toBe("- [ ] first\n- [ ] second\n- [ ] third");
  });
});

describe("sync diff (idempotent)", () => {
  const seed = "| ID | D | S |\n|----|---|---|\n| US-GH-1 | existing | 📋 Todo |\n";
  const issues = [
    issue({ number: 1, title: "existing", state: "open", labels: [] }), // already present
    issue({ number: 2, title: "fresh bug", state: "open", labels: [{ name: "bug" }] }),
  ];
  it("dryRunPreview counts add/skip without mutating", () => {
    const p = dryRunPreview(issues, seed);
    expect(p.added).toBe(1);
    expect(p.skipped).toBe(1);
    expect(p.lines).toContain("= US-GH-1 [US] (skipped, already exists)");
    expect(p.lines).toContain("+ FIX-GH-2 [FIX] fresh bug");
  });
  it("syncToBacklog appends only the new row, skips the present id", () => {
    const r = syncToBacklog(issues, seed);
    expect(r.added).toBe(1);
    expect(r.skippedIds).toEqual(["US-GH-1"]);
    expect(r.rows).toEqual(["| [FIX-GH-2](backlog-lifecycle/FIX-GH-2/spec.md) | fresh bug | 📋 Todo |"]);
    expect(r.content).toContain("| [FIX-GH-2](backlog-lifecycle/FIX-GH-2/spec.md) | fresh bug | 📋 Todo |");
  });
  it("keeps an existing planning status when the external Issue is closed", () => {
    const planning = "| ID | D | S |\n|----|---|---|\n| [US-GH-4](backlog-lifecycle/US-GH-4/spec.md) | active plan | 🔨 In Progress |\n";
    const r = syncToBacklog([issue({ number: 4, title: "closed elsewhere", state: "closed" })], planning);
    expect(r.added).toBe(0);
    expect(r.skippedIds).toEqual(["US-GH-4"]);
    expect(r.content).toBe(planning);
  });
});

describe("Link header + sync config rw", () => {
  it("parseLinkHeader extracts next/prev", () => {
    const h =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    const rels = parseLinkHeader(h);
    expect(rels["next"]).toBe("https://api.github.com/x?page=2");
    expect(rels["last"]).toBe("https://api.github.com/x?page=5");
    expect(parseLinkHeader(undefined)["next"]).toBeUndefined();
  });
  it("renderSyncBlock + readSyncConfig round-trip", () => {
    const block = renderSyncBlock("acme/widgets", ["bug", "p1"], "2026-06-09T00:00:00Z");
    const cfg = readSyncConfig(block + "\n");
    expect(cfg.repo).toBe("acme/widgets");
    expect(cfg.direction).toBe("issues-to-backlog");
    expect(cfg.labels).toEqual(["bug", "p1"]);
    expect(cfg.last_sync_at).toBe("2026-06-09T00:00:00Z");
  });
  it("writeSyncBlock replaces an existing block in place, keeps other keys", () => {
    const yaml = "agent: claude\nbacklog_sync:\n  repo: old/repo\n  labels: []\nloop_schedule:\n  period_minutes: 30\n";
    const block = renderSyncBlock("new/repo", ["bug"], "2026-06-09T00:00:00Z");
    const out = writeSyncBlock(yaml, block);
    expect(out).toContain("agent: claude");
    expect(out).toContain("loop_schedule:");
    expect(out).toContain("repo: new/repo");
    expect(out).not.toContain("old/repo");
    expect(readSyncConfig(out).repo).toBe("new/repo");
  });
  it("writeSyncBlock appends when absent", () => {
    const out = writeSyncBlock("agent: claude\n", renderSyncBlock("a/b", [], "2026-06-09T00:00:00Z"));
    expect(out).toContain("agent: claude");
    expect(readSyncConfig(out).repo).toBe("a/b");
  });
});
