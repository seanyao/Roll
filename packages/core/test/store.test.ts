/**
 * Unit tests for BacklogStore: parse model, exact (ID-token-anchored) marking
 * incl. the FIX-106 substring traps, optimistic-concurrency conflict path, and
 * atomic tmp+rename observed through an in-memory FileStore fake.
 */
import { describe, expect, it } from "vitest";
import {
  BacklogStore,
  ConflictError,
  type FileStore,
  extractAnnotation,
  idMatchesPattern,
  markStatus,
  markStatusExact,
  parseBacklog,
} from "../src/index.js";

/**
 * In-memory FileStore that records the write protocol so tests can prove the
 * tmp-file + rename (atomic) discipline without real I/O.
 */
class FakeFileStore implements FileStore {
  files = new Map<string, string>();
  /** Ordered log of low-level operations. */
  log: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }

  readText(path: string): string {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  writeFileAtomic(path: string, data: string): void {
    // Model the real node impl: write a sibling tmp, then rename over dest.
    const tmp = `${path}.tmp`;
    this.files.set(tmp, data);
    this.log.push(`write:${tmp}`);
    this.files.delete(tmp);
    this.files.set(path, data);
    this.log.push(`rename:${tmp}->${path}`);
  }
}

const TODO = "📋 Todo";
const DONE = "✅ Done";

describe("parseBacklog", () => {
  it("parses bare and linked ids, the family filter, and the status cell", () => {
    const content = [
      "| ID | Description | Status |",
      "|----|----|----|",
      "| FIX-101 | a bug | 📋 Todo |",
      "| [US-AUTH-001](.roll/features/auth/US-AUTH-001.md) | login | ✅ Done |",
      "| REFACTOR-9 | tidy `depends-on:US-AUTH-001` | 🔒 Blocked [waiting] |",
      "| NOTE-1 | not a story family | 📋 Todo |",
      "plain text line",
    ].join("\n");
    const items = parseBacklog(content);
    expect(items.map((i) => i.id)).toEqual(["FIX-101", "US-AUTH-001", "REFACTOR-9"]);
    expect(items[1]?.status).toBe(DONE);
    expect(items[2]?.status).toBe("🔒 Blocked [waiting]");
    expect(items[0]?.desc).toBe("a bug");
  });
});

describe("idMatchesPattern (FIX-106 anchoring)", () => {
  it("matches an exact id, case-insensitively", () => {
    expect(idMatchesPattern("US-LOOP-01", "us-loop-01")).toBe(true);
  });
  it("matches a family prefix at a '-' boundary", () => {
    expect(idMatchesPattern("US-AUTH-002", "US-AUTH")).toBe(true);
  });
  it("does NOT match a longer numeric sibling (the FIX-106 trap)", () => {
    expect(idMatchesPattern("US-LOOP-019", "US-LOOP-01")).toBe(false);
  });
});

describe("markStatus", () => {
  it("marks exactly the matching row and reports count=1", () => {
    const content = [
      "| US-LOOP-01 | first | 📋 Todo |",
      "| US-LOOP-019 | nineteen | 📋 Todo |",
    ].join("\n");
    const r = markStatus(content, "US-LOOP-01", DONE);
    expect(r.count).toBe(1);
    // Status is the last data cell (parts[-2]); only US-LOOP-01's flips.
    expect(r.content).toBe(
      ["| US-LOOP-01 | first | ✅ Done |", "| US-LOOP-019 | nineteen | 📋 Todo |"].join("\n"),
    );
  });

  it("never re-marks a depends-on token sitting in the Description cell", () => {
    const content = [
      "| US-A | base | 📋 Todo |",
      "| US-B | needs `depends-on:US-A` | 📋 Todo |",
    ].join("\n");
    const r = markStatus(content, "US-A", "🔒 Blocked");
    // Only the US-A row (id cell) flips; US-B's description mention is untouched.
    expect(r.count).toBe(1);
    expect(r.content).toContain("| US-A | base | 🔒 Blocked |");
    expect(r.content).toContain("| US-B | needs `depends-on:US-A` | 📋 Todo |");
  });

  it("marks a whole family by prefix and reports the multi count", () => {
    const content = [
      "| US-AUTH-001 | a | 📋 Todo |",
      "| US-AUTH-002 | b | 📋 Todo |",
      "| US-AUTHZ-001 | c | 📋 Todo |",
    ].join("\n");
    const r = markStatus(content, "US-AUTH", DONE);
    // US-AUTH-001/002 match; US-AUTHZ-001 does not (no '-' boundary after AUTH).
    expect(r.count).toBe(2);
    expect(r.content).toContain("| US-AUTHZ-001 | c | 📋 Todo |");
  });

  it("reports count=0 when nothing matches and leaves content byte-identical", () => {
    const content = "| US-X | x | 📋 Todo |\n";
    const r = markStatus(content, "FIX-999", DONE);
    expect(r.count).toBe(0);
    expect(r.content).toBe(content);
  });

  it("preserves trailing newline and CRLF line endings", () => {
    const content = "| US-X | x | 📋 Todo |\r\n| US-Y | y | 📋 Todo |\r\n";
    const r = markStatus(content, "US-X", DONE);
    expect(r.content).toBe("| US-X | x | ✅ Done |\r\n| US-Y | y | 📋 Todo |\r\n");
  });

  describe("extractAnnotation (FIX-1219)", () => {
    it("extracts parenthesized annotation", () => {
      expect(extractAnnotation("✅ Done (PR#1238 · merged abc1234 · description)")).toBe(
        "(PR#1238 · merged abc1234 · description)",
      );
    });
    it("extracts evidence_debt annotation", () => {
      expect(extractAnnotation("✅ Done · evidence_debt")).toBe("· evidence_debt");
    });
    it("returns undefined for bare Done", () => {
      expect(extractAnnotation("✅ Done")).toBeUndefined();
    });
    it("returns undefined for non-Done status", () => {
      expect(extractAnnotation("🔨 In Progress")).toBeUndefined();
      expect(extractAnnotation("📋 Todo")).toBeUndefined();
    });
    it("handles legacy Done marker", () => {
      expect(extractAnnotation("✔️ Done (PR#42 · merged deadbeef)")).toBe(
        "(PR#42 · merged deadbeef)",
      );
    });
  });

  describe("markStatus annotation preservation (FIX-1219)", () => {
    it("preserves existing annotation when rewriting Done status", () => {
      const content = [
        "| FIX-101 | a bug | ✅ Done (PR#100 · merged abc123) |",
        "| FIX-102 | another | 📋 Todo |",
      ].join("\n");
      const r = markStatus(content, "FIX-101", DONE);
      expect(r.count).toBe(1);
      expect(r.content).toContain(
        "| FIX-101 | a bug | ✅ Done (PR#100 · merged abc123) |",
      );
    });
    it("bare Done (no annotation) stays bare when rewriting", () => {
      const content = [
        "| FIX-103 | simple | ✅ Done |",
        "| FIX-104 | todo | 📋 Todo |",
      ].join("\n");
      const r = markStatus(content, "FIX-103", DONE);
      expect(r.count).toBe(1);
      expect(r.content).toContain("| FIX-103 | simple | ✅ Done |");
    });
    it("annotation preserved even when flipping an already-annotated row", () => {
      // Simulates a second call to markStatus on the same row — the
      // annotation from the current cell carries forward.
      const content = [
        "| US-X | task | ✅ Done (PR#1 · merged a1b2c3) |",
      ].join("\n");
      const r = markStatus(content, "US-X", "✅ Done");
      expect(r.count).toBe(1);
      expect(r.content).toContain(
        "| US-X | task | ✅ Done (PR#1 · merged a1b2c3) |",
      );
    });
    it("new Done status with its own annotation is not clobbered when current cell is non-Done", () => {
      // When the new status already carries annotation (e.g. evidence_debt)
      // and the current cell has no annotation, the new status is used as-is.
      const content = [
        "| US-Y | task | 🔨 In Progress |",
      ].join("\n");
      const r = markStatus(content, "US-Y", "✅ Done · evidence_debt");
      expect(r.count).toBe(1);
      expect(r.content).toContain(
        "| US-Y | task | ✅ Done · evidence_debt |",
      );
    });
  });
});

describe("markStatusExact (FIX-1475)", () => {
  it("marks only the exact-id row, never a `<id>-` descendant sibling", () => {
    const content = [
      "| ID | Description | Status |",
      "|----|-------------|--------|",
      "| FIX-1475 | never reset shared main | 📋 Todo |",
      "| FIX-1475-followup | later cleanup | 📋 Todo |",
    ].join("\n");
    const r = markStatusExact(content, "FIX-1475", DONE);
    // Exactly one row flips — the descendant must remain Todo (markStatus, by
    // contrast, would flip BOTH via idMatchesPattern prefix rules).
    expect(r.count).toBe(1);
    expect(r.content).toContain("| FIX-1475 | never reset shared main | ✅ Done |");
    expect(r.content).toContain("| FIX-1475-followup | later cleanup | 📋 Todo |");
    // Contrast: prefix markStatus flips both (proves the divergence is real).
    expect(markStatus(content, "FIX-1475", DONE).count).toBe(2);
  });

  it("is case-insensitive on the id and a no-op when the row is absent", () => {
    const content = "| FIX-1475 | x | 📋 Todo |";
    expect(markStatusExact(content, "fix-1475", DONE).count).toBe(1);
    expect(markStatusExact(content, "FIX-9999", DONE).count).toBe(0);
  });
});

describe("BacklogStore optimistic concurrency", () => {
  const PATH = "/proj/.roll/backlog.md";
  const seed = `| US-X | x | ${TODO} |\n`;

  it("readBacklog returns content + sha256 + parsed items", () => {
    const store = new BacklogStore(new FakeFileStore({ [PATH]: seed }));
    const snap = store.readBacklog(PATH);
    expect(snap.content).toBe(seed);
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.items).toHaveLength(1);
  });

  it("writeBacklog commits when the hash still matches", () => {
    const fs = new FakeFileStore({ [PATH]: seed });
    const store = new BacklogStore(fs);
    const { hash } = store.readBacklog(PATH);
    const r = store.mark(PATH, hash, "US-X", DONE);
    expect(r.count).toBe(1);
    expect(fs.files.get(PATH)).toBe(`| US-X | x | ${DONE} |\n`);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws ConflictError when the file changed underfoot", () => {
    const fs = new FakeFileStore({ [PATH]: seed });
    const store = new BacklogStore(fs);
    const { hash } = store.readBacklog(PATH);
    // Simulate a concurrent writer mutating the file after our read.
    fs.files.set(PATH, `| US-X | x | ${DONE} |\n`);
    expect(() => store.mark(PATH, hash, "US-X", "🔒 Blocked")).toThrow(ConflictError);
    // Nothing was written on the conflict path.
    expect(fs.files.get(PATH)).toBe(`| US-X | x | ${DONE} |\n`);
  });

  it("writes via tmp-file + rename (atomic protocol observable)", () => {
    const fs = new FakeFileStore({ [PATH]: seed });
    const store = new BacklogStore(fs);
    const { hash } = store.readBacklog(PATH);
    store.mark(PATH, hash, "US-X", DONE);
    expect(fs.log).toEqual([`write:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`]);
  });
});
