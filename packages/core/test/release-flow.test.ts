/** US-REL-007 — foldUnreleased: deterministic, fail-loud changelog folding. */
import { describe, expect, it } from "vitest";
import { RELEASE_STEPS, foldUnreleased, isChangelogReady } from "../src/release/flow.js";

const CL = `# Changelog

## Unreleased

### 新功能

- shiny thing (US-1)
- another thing (FIX-2)

## v3.612.2 — 2026-06-12

- old item
`;

describe("foldUnreleased", () => {
  it("folds Unreleased into the dated version heading, keeping an empty Unreleased", () => {
    const r = foldUnreleased(CL, "3.613.1", "2026-06-13")!;
    expect(r.text).toContain("## Unreleased\n\n## v3.613.1 — 2026-06-13");
    expect(r.text).toContain("- shiny thing (US-1)");
    expect(r.text).toContain("## v3.612.2 — 2026-06-12"); // history untouched
    expect(r.notes).toContain("shiny thing");
    expect(r.notes).toContain("another thing");
  });

  it("same-day double release: a second fold targets a NEW version and never eats history", () => {
    const first = foldUnreleased(CL, "3.613.1", "2026-06-13")!;
    const withMore = first.text.replace("## Unreleased\n", "## Unreleased\n\n- late fix (FIX-3)\n");
    const second = foldUnreleased(withMore, "3.613.2", "2026-06-13")!;
    expect(second.text).toContain("## v3.613.2 — 2026-06-13");
    expect(second.notes).toContain("late fix");
    expect(second.notes).not.toContain("shiny thing");
  });

  it("empty Unreleased → null (the release must abort, not ship an empty note)", () => {
    expect(foldUnreleased("# C\n\n## Unreleased\n\n## v1.0.0 — 2026-01-01\n\n- x\n", "1.0.1", "2026-06-13")).toBeNull();
    expect(foldUnreleased("# C\n\nno sections\n", "1.0.1", "2026-06-13")).toBeNull();
  });

  it("pre-written next-version section is accepted as already folded", () => {
    const pre = "# C\n\n## v9.9.9 — 2026-06-13\n\n- prewritten\n\n## v1.0.0 — 2026-01-01\n\n- old\n";
    const r = foldUnreleased(pre, "9.9.9", "2026-06-13")!;
    expect(r.text).toBe(pre);
    expect(r.notes).toContain("prewritten");
  });
});

describe("isChangelogReady — FIX-1030: shared changelog readiness predicate", () => {
  it("returns true when Unreleased has bullets", () => {
    expect(isChangelogReady("# C\n\n## Unreleased\n\n- fix one\n")).toBe(true);
    expect(isChangelogReady("# C\n\n## Unreleased\n\n### 新功能\n\n- feature one\n\n## v1 — d\n\n- old\n")).toBe(true);
  });

  it("returns true when the target version section is already pre-written", () => {
    const pre = "# C\n\n## v2.0.0 — 2026-06-29\n\n- prewritten\n\n## v1 — d\n\n- old\n";
    expect(isChangelogReady(pre, "2.0.0")).toBe(true);
  });

  it("ignores pre-written sections for a different target version", () => {
    const pre = "# C\n\n## v1.9.9 — 2026-06-28\n\n- previous\n";
    expect(isChangelogReady(pre, "2.0.0")).toBe(false);
  });

  it("returns false when Unreleased is empty (no bullets)", () => {
    expect(isChangelogReady("# C\n\n## Unreleased\n\n## v1 — d\n\n- old\n")).toBe(false);
  });

  it("returns false when Unreleased section is absent", () => {
    expect(isChangelogReady("# C\n\n## v1 — d\n\n- old\n")).toBe(false);
    expect(isChangelogReady("")).toBe(false);
  });

  it("returns false when Unreleased has only whitespace", () => {
    expect(isChangelogReady("# C\n\n## Unreleased\n  \n")).toBe(false);
  });

  it("matches foldUnreleased's own detection — same input produces same verdict", () => {
    const withBullets = "# C\n\n## Unreleased\n\n- release ready\n\n## v1 — d\n\n- old\n";
    expect(isChangelogReady(withBullets)).toBe(true);
    expect(foldUnreleased(withBullets, "2.0.0", "2026-06-29")).not.toBeNull();

    const emptyUnreleased = "# C\n\n## Unreleased\n\n## v1 — d\n\n- old\n";
    expect(isChangelogReady(emptyUnreleased)).toBe(false);
    expect(foldUnreleased(emptyUnreleased, "2.0.0", "2026-06-29")).toBeNull();

    const alreadyFolded = "# C\n\n## v2.0.0 — 2026-06-29\n\n- prewritten\n\n## v1 — d\n\n- old\n";
    expect(isChangelogReady(alreadyFolded, "2.0.0")).toBe(true);
    expect(foldUnreleased(alreadyFolded, "2.0.0", "2026-06-29")).not.toBeNull();
  });
});

describe("RELEASE_STEPS", () => {
  it("every irreversible step sits behind the gates before it", () => {
    // RL-REL-010: irreversible release steps remain behind package and consistency gates.
    expect(RELEASE_STEPS.indexOf("package-gate")).toBeLessThan(RELEASE_STEPS.indexOf("commit-push"));
    expect(RELEASE_STEPS.indexOf("consistency-gate")).toBeLessThan(RELEASE_STEPS.indexOf("tag-push"));
    expect(RELEASE_STEPS.at(-1)).toBe("tag-push");
  });
});
