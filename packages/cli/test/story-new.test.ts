/**
 * US-META-009 — `roll story new`: the single channel for minting card folders.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { storyNewCommand } from "../src/commands/story-new.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});

function project(): string {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "roll-storynew-")));
  dirs.push(p);
  mkdirSync(join(p, ".roll", "features"), { recursive: true });
  writeFileSync(join(p, ".roll", "backlog.md"), "| US-NEW-1 | x | 📋 Todo |\n");
  return p;
}

function inProj(p: string, args: string[]): { code: number; out: string; err: string } {
  const save = process.cwd();
  process.chdir(p);
  let out = "";
  let err = "";
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture
  process.stdout.write = (s: string): boolean => ((out += String(s)), true);
  // @ts-expect-error capture
  process.stderr.write = (s: string): boolean => ((err += String(s)), true);
  try {
    return { code: storyNewCommand(args), out, err };
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
    process.chdir(save);
  }
}

// FIX-250 — the ONE minting entry completes the chain: card + backlog row;
// --no-index defers the linear-cost refresh for batch minting.
describe("roll story new — FIX-250", () => {
  it("appends the backlog row (📋 Todo) under the same epic", () => {
    const p = project();
    writeFileSync(
      join(p, ".roll", "backlog.md"),
      "| ID | D | S |\n|--|--|--|\n| [FIX-1](.roll/features/pay/FIX-1/spec.md) | x | ✅ Done |\n",
    );
    const r = inProj(p, ["US-PAY-009", "--title", "refund flow", "--epic", "pay"]);
    expect(r.code).toBe(0);
    const backlog = readFileSync(join(p, ".roll", "backlog.md"), "utf8");
    expect(backlog).toContain("| [US-PAY-009](.roll/features/pay/US-PAY-009/spec.md) | refund flow | 📋 Todo |");
    expect(r.out).toContain("backlog row appended");
  });

  it("an already-present row stays untouched (idempotent)", () => {
    const p = project();
    writeFileSync(
      join(p, ".roll", "backlog.md"),
      "| ID | D | S |\n|--|--|--|\n| [US-DUP-1](.roll/features/e/US-DUP-1/spec.md) | already | 🔨 In Progress |\n",
    );
    const r = inProj(p, ["US-DUP-1", "--title", "already", "--epic", "e2"]);
    expect(r.code).toBe(0);
    const backlog = readFileSync(join(p, ".roll", "backlog.md"), "utf8");
    expect(backlog).toContain("🔨 In Progress"); // not duplicated, not flipped
    expect((backlog.match(/\| \[US-DUP-1\]/g) ?? []).length).toBe(1); // one ROW (the link path repeats the id)
  });

  it("--no-index defers index.json + aggregate refresh (batch mode)", () => {
    const p = project();
    const r = inProj(p, ["US-BATCH-1", "--title", "t", "--epic", "e", "--no-index"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(p, ".roll", "features", "e", "US-BATCH-1", "spec.md"))).toBe(true);
    expect(existsSync(join(p, ".roll", "index.json"))).toBe(false); // deferred
  });
});

// FIX-1251 — the help text must describe the REAL CLI surface: `roll story new`
// refreshes the lightweight `.roll/index.json` cache only (NOT the dossier — see
// US-V4-001 test below), and bare `roll index` was retired (b6278c54, only
// `roll index --rebuild` survives). Stale hints pointing at a dossier refresh or
// a bare `roll index` command must not creep back in.
describe("roll story new — FIX-1251 help matches real CLI surface", () => {
  it("help advertises the index.json cache, not a phantom dossier refresh", () => {
    const p = project();
    const help = inProj(p, ["--help"]).out;
    expect(help).toContain("index.json");
    expect(help).not.toMatch(/dossier/i);
  });

  it("help does not hint at the retired bare `roll index` command", () => {
    const p = project();
    const help = inProj(p, ["--help"]).out;
    // Any `roll index` reference must carry the surviving `--rebuild` form.
    expect(help).not.toMatch(/roll index(?!\s+--rebuild)/);
  });
});

describe("roll story new — US-META-009", () => {
  it("mints spec.md (frontmatter) + story page + refreshes index.json", () => {
    const p = project();
    const r = inProj(p, ["US-NEW-1", "--title", "一条新故事", "--epic", "alpha"]);
    expect(r.code).toBe(0);
    const spec = readFileSync(join(p, ".roll", "features", "alpha", "US-NEW-1", "spec.md"), "utf8");
    expect(spec).toContain("id: US-NEW-1");
    expect(spec).toContain("title: 一条新故事");
    expect(spec).toContain("epic: alpha");
    expect(existsSync(join(p, ".roll", "features", "alpha", "US-NEW-1", "index.html"))).toBe(true);
    const idx = JSON.parse(readFileSync(join(p, ".roll", "index.json"), "utf8")) as { stories: Record<string, string> };
    expect(idx.stories["US-NEW-1"]).toBe("alpha");
  });

  it("refuses to overwrite an existing card (born once)", () => {
    const p = project();
    expect(inProj(p, ["FIX-7", "--title", "first"]).code).toBe(0);
    const r = inProj(p, ["FIX-7", "--title", "second"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("不可覆盖");
  });

  it("rejects a non-story id and a missing title (exit 2)", () => {
    const p = project();
    expect(inProj(p, ["not-an-id", "--title", "x"]).code).toBe(2);
    expect(inProj(p, ["US-OK-1"]).code).toBe(2);
  });

  it("defaults epic to uncategorized", () => {
    const p = project();
    expect(inProj(p, ["IDEA-9", "--title", "想法"]).code).toBe(0);
    expect(existsSync(join(p, ".roll", "features", "uncategorized", "IDEA-9", "spec.md"))).toBe(true);
  });

  it("US-V4-001: minting does NOT refresh the global dossier front page (no delivery side effect)", () => {
    const p = project();
    expect(inProj(p, ["US-NEW-1", "--title", "一条新故事", "--epic", "alpha"]).code).toBe(0);
    // The global front page is rendered ON DEMAND by `roll index`, never as a
    // side effect of minting a card. Card creation only writes the story's own
    // spec + skeleton page + the lightweight index.json cache.
    expect(existsSync(join(p, ".roll", "features", "index.html"))).toBe(false);
    // The story's own skeleton page is still written at creation (renderStoryPage).
    expect(existsSync(join(p, ".roll", "features", "alpha", "US-NEW-1", "index.html"))).toBe(true);
    // The index.json cache records the new card's epic for live-walk-free lookups.
    const idx = JSON.parse(readFileSync(join(p, ".roll", "index.json"), "utf8")) as { stories: Record<string, string> };
    expect(idx.stories["US-NEW-1"]).toBe("alpha");
  });
});
