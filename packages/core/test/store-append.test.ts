/**
 * FIX-250 — appendBacklogRow: a card is born WITH its row.
 */
import { describe, expect, it } from "vitest";
import { appendBacklogRow } from "../src/index.js";

const BASE = [
  "## Epic: payments",
  "",
  "| ID | Description | Status |",
  "|----|----|----|",
  "| [US-PAY-001](.roll/features/payments/US-PAY-001/spec.md) | refunds | ✅ Done |",
  "",
  "## Epic: loop-engine",
  "",
  "| ID | Description | Status |",
  "|----|----|----|",
  "| [FIX-1](.roll/features/loop-engine/FIX-1/spec.md) | x | 📋 Todo |",
  "",
].join("\n");

describe("appendBacklogRow", () => {
  it("inserts after the LAST sibling row of the same epic", () => {
    const r = appendBacklogRow(BASE, { id: "US-PAY-002", title: "chargebacks", epic: "payments" });
    expect(r.appended).toBe(true);
    const lines = r.content.split("\n");
    const idx = lines.findIndex((l) => l.includes("US-PAY-002"));
    expect(lines[idx - 1]).toContain("US-PAY-001"); // right under its sibling
    expect(lines[idx]).toBe("| [US-PAY-002](.roll/features/payments/US-PAY-002/spec.md) | chargebacks | 📋 Todo |");
  });

  it("epic with no rows yet → after the last table row in the file", () => {
    const r = appendBacklogRow(BASE, { id: "FIX-9", title: "new epic card", epic: "brand-new" });
    const lines = r.content.split("\n");
    const idx = lines.findIndex((l) => l.includes("FIX-9"));
    expect(lines[idx - 1]).toContain("FIX-1");
  });

  it("an existing row is a no-op (idempotent re-runs)", () => {
    const r = appendBacklogRow(BASE, { id: "FIX-1", title: "dup", epic: "loop-engine" });
    expect(r.appended).toBe(false);
    expect(r.content).toBe(BASE);
  });

  it("FIX-1475: de-dup is by EXACT id-cell — a row whose DESCRIPTION links to [id] does NOT block the append", () => {
    const withLinkInDesc = [
      "## Epic: loop-engine",
      "",
      "| ID | Description | Status |",
      "|----|----|----|",
      "| [US-9](.roll/features/loop-engine/US-9/spec.md) | supersedes [FIX-300](.roll/features/loop-engine/FIX-300/spec.md) | 📋 Todo |",
      "",
    ].join("\n");
    const r = appendBacklogRow(withLinkInDesc, { id: "FIX-300", title: "the real card", epic: "loop-engine" });
    // The substring guard would have seen "| [FIX-300]" inside US-9's description
    // and wrongly reported the card as already present.
    expect(r.appended).toBe(true);
    expect(r.content).toContain("| [FIX-300](.roll/features/loop-engine/FIX-300/spec.md) | the real card | 📋 Todo |");
  });

  it("a backlog with no tables grows a minimal section", () => {
    const r = appendBacklogRow("# Backlog\n", { id: "US-A-1", title: "t", epic: "e" });
    expect(r.appended).toBe(true);
    expect(r.content).toContain("| [US-A-1](.roll/features/e/US-A-1/spec.md) | t | 📋 Todo |");
  });

  // US-AGENT-042 — self-downgrade children carry depends-on + chain_depth tags.
  it("appends chain_depth + depends-on tags to the Description cell when given", () => {
    const r = appendBacklogRow(BASE, {
      id: "US-PAY-002",
      title: "chargebacks",
      epic: "payments",
      dependsOn: ["US-PAY-001", "US-1"],
      chainDepth: 1,
    });
    const lines = r.content.split("\n");
    const idx = lines.findIndex((l) => l.includes("US-PAY-002"));
    expect(lines[idx]).toBe(
      "| [US-PAY-002](.roll/features/payments/US-PAY-002/spec.md) | chargebacks chain_depth:1 depends-on:US-PAY-001,US-1 | 📋 Todo |",
    );
  });

  it("omits the tags (byte-identical to a bare row) when absent / empty / zero", () => {
    const a = appendBacklogRow(BASE, { id: "US-PAY-003", title: "x", epic: "payments" });
    const b = appendBacklogRow(BASE, { id: "US-PAY-003", title: "x", epic: "payments", dependsOn: [], chainDepth: 0 });
    expect(a.content).toBe(b.content);
    expect(a.content).toContain("| [US-PAY-003](.roll/features/payments/US-PAY-003/spec.md) | x | 📋 Todo |");
  });
});
