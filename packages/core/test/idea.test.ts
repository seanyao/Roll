import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../src/backlog/store.js";
import {
  appendIdea,
  classifyIdea,
  inferEpic,
  lintIdeaDescription,
  nextIdeaId,
  planIdea,
  prefixForKind,
} from "../src/backlog/idea.js";

function item(id: string, status = "📋 Todo", desc = "d"): BacklogItem {
  return { id, desc, status };
}

describe("classifyIdea", () => {
  it("flags English defect vocabulary as bug", () => {
    expect(classifyIdea("the export button is broken")).toBe("bug");
    expect(classifyIdea("CI crash on push")).toBe("bug");
    expect(classifyIdea("login fails for SSO users")).toBe("bug");
  });

  it("flags Chinese defect vocabulary as bug", () => {
    expect(classifyIdea("导出按钮点了报错")).toBe("bug");
    expect(classifyIdea("loop 偶尔崩溃")).toBe("bug");
  });

  it("treats forward-looking requests as idea", () => {
    expect(classifyIdea("add a dark mode toggle")).toBe("idea");
    expect(classifyIdea("支持批量导出报表")).toBe("idea");
  });

  it("empty text defaults to idea", () => {
    expect(classifyIdea("")).toBe("idea");
  });

  it("English signals match on word boundaries (no substring false positives)", () => {
    expect(classifyIdea("add a terror-alert banner")).toBe("idea"); // not "error"
    expect(classifyIdea("ship the unbroken streak widget")).toBe("idea"); // not "broken"
    expect(classifyIdea("a memory leak in the cache")).toBe("bug"); // whole word still fires
  });
});

describe("prefixForKind", () => {
  it("maps bug→FIX, idea→IDEA", () => {
    expect(prefixForKind("bug")).toBe("FIX");
    expect(prefixForKind("idea")).toBe("IDEA");
  });
});

describe("nextIdeaId", () => {
  it("starts at 001 when the family is empty", () => {
    expect(nextIdeaId([], "FIX")).toBe("FIX-001");
    expect(nextIdeaId([item("US-A-001")], "IDEA")).toBe("IDEA-001");
  });

  it("is max numeric suffix + 1, zero-padded, family-scoped", () => {
    const items = [item("FIX-204"), item("FIX-215"), item("IDEA-007"), item("US-PORT-003")];
    expect(nextIdeaId(items, "FIX")).toBe("FIX-216");
    expect(nextIdeaId(items, "IDEA")).toBe("IDEA-008");
  });

  it("reads the leading integer of a lettered suffix (FIX-150b)", () => {
    expect(nextIdeaId([item("FIX-150b")], "FIX")).toBe("FIX-151");
  });
});

describe("lintIdeaDescription", () => {
  it("passes a plain one-sentence description", () => {
    expect(lintIdeaDescription("make the dashboard load faster on first paint")).toEqual([]);
  });

  it("flags over-length descriptions", () => {
    expect(lintIdeaDescription("x".repeat(121))).toEqual(["length"]);
  });

  it("flags code fences, filenames, paths, and function names", () => {
    expect(lintIdeaDescription("use the `helper` here")).toEqual(["code-fence"]);
    expect(lintIdeaDescription("update config.yaml defaults")).toEqual(["filename"]);
    expect(lintIdeaDescription("look inside src/foo for it")).toEqual(["path"]);
    expect(lintIdeaDescription("call _helper to refresh")).toEqual(["function"]);
  });

  it("strips a leading bare ID before linting prose", () => {
    expect(lintIdeaDescription("US-1 add a plain feature")).toEqual([]);
  });
});

describe("planIdea", () => {
  it("composes classify + next-id + lint", () => {
    const items = [item("FIX-009"), item("IDEA-002")];
    const bug = planIdea(items, "the picker crash needs a fix");
    expect(bug.kind).toBe("bug");
    expect(bug.prefix).toBe("FIX");
    expect(bug.id).toBe("FIX-010");
    expect(bug.violations).toEqual([]);

    const idea = planIdea(items, "add an offline mode");
    expect(idea.id).toBe("IDEA-003");
  });

  it("surfaces lint violations in the plan", () => {
    const p = planIdea([], "wire up the `module` properly");
    expect(p.violations).toContain("code-fence");
  });
});

describe("appendIdea", () => {
  it("creates the section when absent and appends a parseable row", () => {
    const content = "# Backlog\n\nsome intro\n";
    const r = appendIdea(content, "IDEA-001", "idea", "add dark mode");
    expect(r.section).toBe("## 💡 Ideas");
    expect(r.content).toContain("## 💡 Ideas");
    expect(r.content).toContain("| IDEA-001 | add dark mode | 📋 Todo |");
    // original content preserved
    expect(r.content).toContain("some intro");
  });

  it("appends after the last table row of an existing section", () => {
    const content = [
      "## 🐛 Bug Fixes",
      "",
      "| ID | Description | Status |",
      "|----|-------------|--------|",
      "| FIX-001 | first bug | 📋 Todo |",
      "",
      "## 💡 Ideas",
      "",
      "| ID | Description | Status |",
      "|----|-------------|--------|",
      "| IDEA-001 | an idea | 📋 Todo |",
      "",
    ].join("\n");
    const r = appendIdea(content, "FIX-002", "bug", "second bug");
    const lines = r.content.split("\n");
    const fix1 = lines.indexOf("| FIX-001 | first bug | 📋 Todo |");
    const fix2 = lines.indexOf("| FIX-002 | second bug | 📋 Todo |");
    // FIX-002 lands immediately after FIX-001, inside the Bug Fixes section,
    // not in the Ideas section below.
    expect(fix2).toBe(fix1 + 1);
    // Ideas section untouched.
    expect(r.content).toContain("| IDEA-001 | an idea | 📋 Todo |");
  });

  it("adds a table when the heading exists but has no rows yet", () => {
    const content = "## 💡 Ideas\n\nno table here yet\n";
    const r = appendIdea(content, "IDEA-001", "idea", "first idea");
    expect(r.content).toContain("| ID | Description | Status |");
    expect(r.content).toContain("| IDEA-001 | first idea | 📋 Todo |");
  });

  it("writes a canonical linked row when the Workspace authority is explicit", () => {
    const r = appendIdea("# Backlog\n", "IDEA-001", "idea", "linked idea", {
      epic: "planning",
      linkPrefix: "../features",
    });
    expect(r.content).toContain(
      "| [IDEA-001](../features/planning/IDEA-001/spec.md) | linked idea | 📋 Todo |",
    );
  });
});

// REFACTOR-050: epic inference from natural-language description.
describe("inferEpic", () => {
  it("matches CLI-related terms to cli-simplification", () => {
    expect(inferEpic("the CLI usage is broken")).toBe("cli-simplification");
    expect(inferEpic("add a command flag for debug")).toBe("cli-simplification");
  });

  it("matches loop/cycle/runner terms to loop-engine", () => {
    expect(inferEpic("loop runner needs a health check")).toBe("loop-engine");
    expect(inferEpic("auto dispatch is broken")).toBe("loop-engine");
  });

  it("matches doc/guide terms to documentation", () => {
    expect(inferEpic("write a getting-started guide")).toBe("documentation");
    expect(inferEpic("update README with new tutorial")).toBe("documentation");
  });

  it("matches release/deploy terms to release-management", () => {
    expect(inferEpic("ship a release workflow")).toBe("release-management");
    expect(inferEpic("publish the new version")).toBe("release-management");
  });

  it("matches pair/review terms to cross-agent-pairing", () => {
    expect(inferEpic("pair review with another agent")).toBe("cross-agent-pairing");
    expect(inferEpic("cross-agent peer check")).toBe("cross-agent-pairing");
  });

  it("matches backlog/card/story terms to backlog-lifecycle", () => {
    expect(inferEpic("improve backlog card lifecycle")).toBe("backlog-lifecycle");
  });

  it("matches evidence/attest terms to acceptance-evidence", () => {
    expect(inferEpic("attest evidence missing")).toBe("acceptance-evidence");
  });

  it("matches skill terms to skill-ecosystem", () => {
    expect(inferEpic("agent skill reload is slow")).toBe("skill-ecosystem");
  });

  it("matches dossier/index terms to delivery-dossier", () => {
    expect(inferEpic("index page shows stale data")).toBe("delivery-dossier");
    expect(inferEpic("delivery dossier report")).toBe("delivery-dossier");
  });

  it("returns undefined when no keyword matches", () => {
    expect(inferEpic("do something completely generic")).toBeUndefined();
    expect(inferEpic("make it better")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(inferEpic("Fix the CLI USAGE")).toBe("cli-simplification");
    expect(inferEpic("PAIR REVIEW needed")).toBe("cross-agent-pairing");
  });
});
