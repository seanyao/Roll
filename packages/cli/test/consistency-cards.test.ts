/**
 * US-CONSIST-006 — cards dimension: the card-folder contract, reverse-derived
 * from the features/ layout (2026-06-08 audit). Live rows must own a card
 * folder; evidence links must not dangle; pre-card-era Done rows are counted,
 * never failed; card-era Done rows with ACs need an attest report.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runConsistencyCheck as consistencyCommand } from "../src/lib/release-consistency.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});

function project(
  backlogRows: string[],
  cards: Array<[string, string, boolean, boolean?]> = [],
  opts: { baselineRows?: string[] } = {},
): string {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-cards-")));
  dirs.push(p);
  mkdirSync(join(p, ".roll", "features"), { recursive: true });
  const baseline = ["| ID | D | S |", "|---|---|---|", ...(opts.baselineRows ?? backlogRows), ""].join("\n");
  const backlog = ["| ID | D | S |", "|---|---|---|", ...backlogRows, ""].join("\n");
  const meta = join(p, ".roll");
  const git = (...args: string[]): string => execFileSync("git", ["-C", meta, ...args], { encoding: "utf8" });
  writeFileSync(join(meta, "backlog.md"), baseline);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "backlog.md");
  git("commit", "-q", "-m", "manual Done policy baseline");
  const baselineMetaCommit = git("rev-parse", "HEAD").trim();
  writeFileSync(join(meta, "backlog.md"), backlog);
  mkdirSync(join(meta, "policy"), { recursive: true });
  writeFileSync(
    join(meta, "policy", "manual-done-epoch.json"),
    `${JSON.stringify({ schemaVersion: 1, baselineMetaCommit, backlogPath: "backlog.md" }, null, 2)}\n`,
  );
  for (const [epic, id, withReport, withAc = true] of cards) {
    const dir = join(p, ".roll", "features", epic, id);
    mkdirSync(join(dir, "latest"), { recursive: true });
    writeFileSync(join(dir, "spec.md"), withAc ? `# ${id}\n\n**AC:**\n- [ ] must be verified\n` : `# ${id}\n`);
    if (withReport) writeFileSync(join(dir, "latest", `${id}-report.html`), "<html></html>");
  }
  return p;
}

function replaceEpoch(p: string, record: unknown): void {
  writeFileSync(join(p, ".roll", "policy", "manual-done-epoch.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function baselineCommit(p: string): string {
  return execFileSync("git", ["-C", join(p, ".roll"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function setCurrentBacklog(p: string, rows: string[]): void {
  writeFileSync(join(p, ".roll", "backlog.md"), ["| ID | D | S |", "|---|---|---|", ...rows, ""].join("\n"));
}

function commitCurrentBacklog(p: string, message: string): void {
  const meta = join(p, ".roll");
  execFileSync("git", ["-C", meta, "add", "backlog.md"]);
  execFileSync("git", ["-C", meta, "commit", "-q", "-m", message]);
}

function runJson(p: string): { overall: string; dimensions: Record<string, { status: string; gaps: string[]; note?: string }> } {
  let out = "";
  const w = process.stdout.write.bind(process.stdout);
  // @ts-expect-error capture-only
  process.stdout.write = (s: string): boolean => ((out += String(s)), true);
  try {
    consistencyCommand(["check", "--json", "--project-dir", p]);
  } finally {
    process.stdout.write = w;
  }
  return JSON.parse(out);
}

describe("consistency cards dimension", () => {
  it("clean project: live card with folder + Done with report → pass, no notes", () => {
    const p = project(
      ["| [US-A-1](.roll/features/e/US-A-1/spec.md) | x | 📋 Todo |", "| FIX-2 | y | ✅ Done |"],
      [["e", "US-A-1", false], ["e", "FIX-2", true]],
    );
    const r = runJson(p);
    expect(r.dimensions["cards"]).toMatchObject({ status: "pass", gaps: [] });
  });

  it("LIVE row without a card folder → fail (the DOSSIER-split failure shape)", () => {
    const p = project(["| US-GHOST-1 | split wrote no card | 📋 Todo |"]);
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("US-GHOST-1");
    expect(r.overall).toBe("fail");
  });

  it("broken evidence link on a Done row → fail (the SoloGo failure shape)", () => {
    const p = project(
      ["| [US-A-1](x) | y | ✅ Done · [evidence](.roll/features/e/US-A-1/latest/report.html) |"],
      [["e", "US-A-1", false]],
    );
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("evidence link is broken");
  });

  it("pre-policy Done rows without a card folder: counted as historical, never failed", () => {
    const p = project(["| US-OLD-1 | shipped before card folders | ✅ Done |"]);
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("pass");
    expect(r.dimensions["cards"]?.note).toContain("1 historical Done rows");
  });

  it("Done with folder + ACs but no report: fail", () => {
    const p = project(["| FIX-9 | z | ✅ Done |"], [["e", "FIX-9", false]]);
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("has ACs but no attest report");
    expect(r.overall).toBe("fail");
  });

  it("FIX-1513: Done with folder but no AC block and no manual explanation → fail", () => {
    const p = project(
      ["| FIX-10 | z | ✅ Done |"],
      [["e", "FIX-10", false, false]],
      { baselineRows: ["| FIX-10 | z | 📋 Todo |"] },
    );
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("add a non-empty `manual:` explanation");
    expect(r.overall).toBe("fail");
  });

  it("FIX-1513: a blank manual explanation does not open the exception", () => {
    const p = project(
      ["| FIX-10 | z | ✅ Done · manual:    |"],
      [["e", "FIX-10", false, false]],
      { baselineRows: ["| FIX-10 | z | 📋 Todo |"] },
    );
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("add a non-empty `manual:` explanation");
  });

  it("FIX-1513: a manual note outside the Done status does not open the exception", () => {
    const p = project(
      ["| FIX-10 | manual: catalog cleanup | ✅ Done |"],
      [["e", "FIX-10", false, false]],
      { baselineRows: ["| FIX-10 | z | 📋 Todo |"] },
    );
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
  });

  it("FIX-1513: Done with folder but no AC block and a manual explanation → pass", () => {
    const p = project(
      ["| FIX-10 | z | ✅ Done · manual: This was a catalog-only cleanup with no product behavior |"],
      [["e", "FIX-10", false, false]],
      { baselineRows: ["| FIX-10 | z | 📋 Todo |"] },
    );
    const r = runJson(p);
    expect(r.dimensions["cards"]).toMatchObject({ status: "pass", gaps: [] });
    expect(r.dimensions["cards"]?.note).toContain("manual explanation");
  });

  it("FIX-1516: a Done row already present at the epoch passes without a manual explanation", () => {
    const p = project(["| FIX-1516-OLD | z | ✅ Done |"], [["e", "FIX-1516-OLD", false, false]]);
    const r = runJson(p);
    expect(r.dimensions["cards"]).toMatchObject({ status: "pass", gaps: [] });
    expect(r.dimensions["cards"]?.note).toContain("historical Done rows");
  });

  it("FIX-1516: a card completed after the epoch still needs a manual explanation", () => {
    const p = project(["| FIX-1516-NEW | z | 📋 Todo |"], [["e", "FIX-1516-NEW", false, false]]);
    setCurrentBacklog(p, ["| FIX-1516-NEW | z | ✅ Done |"]);
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("add a non-empty `manual:` explanation");
  });

  it("FIX-1516: a baseline Done card that later returns to Todo must explain a new Done", () => {
    const p = project(["| FIX-1516-RETURN | z | ✅ Done |"], [["e", "FIX-1516-RETURN", false, false]]);
    setCurrentBacklog(p, ["| FIX-1516-RETURN | z | 📋 Todo |"]);
    commitCurrentBacklog(p, "return card to Todo");
    setCurrentBacklog(p, ["| FIX-1516-RETURN | z | ✅ Done |"]);
    commitCurrentBacklog(p, "complete card again");

    const withoutReason = runJson(p);
    expect(withoutReason.dimensions["cards"]?.status).toBe("fail");
    expect(withoutReason.dimensions["cards"]?.gaps[0]).toContain("add a non-empty `manual:` explanation");

    setCurrentBacklog(p, ["| FIX-1516-RETURN | z | ✅ Done · manual: catalog-only completion after reopening |"]);
    expect(runJson(p).dimensions["cards"]).toMatchObject({ status: "pass", gaps: [] });
  });

  it("FIX-1516: a post-epoch Done row without a card folder cannot use manual:", () => {
    const p = project(["| FIX-1516-NO-CARD | z | 📋 Todo |"]);
    setCurrentBacklog(p, ["| FIX-1516-NO-CARD | z | ✅ Done · manual: no product behavior |"]);
    const r = runJson(p);
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("cannot use `manual:`");
  });

  it("FIX-1516: a missing, malformed, unreachable, or non-ancestor epoch fails loud", () => {
    const p = project(["| FIX-1516-POLICY | z | ✅ Done |"]);
    const policy = join(p, ".roll", "policy", "manual-done-epoch.json");
    unlinkSync(policy);
    expect(runJson(p).dimensions["cards"]?.gaps[0]).toContain("missing");
    writeFileSync(policy, "{not json\n");
    expect(runJson(p).dimensions["cards"]?.gaps[0]).toContain("invalid");

    replaceEpoch(p, { schemaVersion: 1, baselineMetaCommit: "0".repeat(40), backlogPath: "backlog.md" });
    expect(runJson(p).dimensions["cards"]?.gaps[0]).toContain("cannot be resolved");

    const meta = join(p, ".roll");
    const emptyTree = execFileSync("git", ["-C", meta, "mktree"], { input: "", encoding: "utf8" }).trim();
    const orphan = execFileSync("git", ["-C", meta, "commit-tree", emptyTree, "-m", "orphan"], { encoding: "utf8" }).trim();
    replaceEpoch(p, { schemaVersion: 1, baselineMetaCommit: orphan, backlogPath: "backlog.md" });
    expect(runJson(p).dimensions["cards"]?.gaps[0]).toContain("not an ancestor");

    replaceEpoch(p, { schemaVersion: 1, baselineMetaCommit: baselineCommit(p), backlogPath: "wrong.md" });
    expect(runJson(p).dimensions["cards"]?.gaps[0]).toContain("backlogPath");
  });

  it("FIX-1216: Done with folder + `## AC` format (modern) still detected as having ACs", () => {
    const p = project(["| FIX-1217 | z | ✅ Done |"], [["e", "FIX-1217", false]]);
    writeFileSync(join(p, ".roll", "features", "e", "FIX-1217", "spec.md"), `# FIX-1217\n\n## AC\n\n- [ ] Modern AC format is recognized\n`);
    writeFileSync(join(p, ".roll", "backlog.md"), ["| ID | D | S |", "|---|---|---|", "| FIX-1217 | z | ✅ Done |", ""].join("\n"));
    const r = runJson(p);
    // has AC block but no report → fail
    expect(r.dimensions["cards"]?.status).toBe("fail");
    expect(r.dimensions["cards"]?.gaps[0]).toContain("has ACs but no attest report");
  });
});
