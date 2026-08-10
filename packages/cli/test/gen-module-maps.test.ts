import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(ROOT, "scripts/gen-module-maps.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Inventory yaml for a fixture: one responsibility set over the whole core tree. */
function inventoryYaml(exclude: string[] = [], allowOverlapWith: string[] = []): string {
  const excludeBlock =
    exclude.length === 0
      ? "      []"
      : exclude.map((path) => `      - path: ${path}\n        reason: fixture exclusion\n        owner: core\n        review_by: US-RULE-011`).join("\n");
  const overlap = allowOverlapWith.length === 0 ? "[]" : `[${allowOverlapWith.join(", ")}]`;
  return `version: 1
coverage_sets:
  - id: maps-core
    purpose: responsibility
    roots:
      - packages/core/src
    include:
      - "**/*.ts"
    allow_overlap_with: ${overlap}
    exclude:
${excludeBlock}
candidates: []
`;
}

function fixtureRoot(exclude: string[] = [], allowOverlapWith: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "roll-module-maps-"));
  dirs.push(root);
  mkdirSync(join(root, "policy"), { recursive: true });
  writeFileSync(join(root, "policy/rules-inventory.yaml"), inventoryYaml(exclude, allowOverlapWith));
  for (const domain of ["attest", "reconcile", "evals", "policy", "backlog"]) {
    const dir = join(root, "packages/core/src", domain);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sample.ts"), `/**\n * @responsibility ${domain} sample responsibility.\n */\nexport {};\n`);
  }
  return root;
}

/** US-RULE-012 — legacy maps-core set + a labeled maps-cli set (map_label cli)
 * with a root-level file, a commands/ file, and a lib/ file. */
function labeledFixture(exclude: string[] = [], allowOverlapWith: string[] = [], extraSets = ""): string {
  const root = mkdtempSync(join(tmpdir(), "roll-module-maps-"));
  dirs.push(root);
  mkdirSync(join(root, "policy"), { recursive: true });
  const excludeBlock =
    exclude.length === 0
      ? "      []"
      : exclude.map((path) => `      - path: ${path}\n        reason: fixture exclusion\n        owner: cli\n        review_by: US-RULE-012`).join("\n");
  const overlap = allowOverlapWith.length === 0 ? "[]" : `[${allowOverlapWith.join(", ")}]`;
  const yaml = `version: 1
coverage_sets:
  - id: maps-core
    purpose: responsibility
    roots:
      - packages/core/src
    include:
      - "**/*.ts"
    allow_overlap_with: []
    exclude: []
  - id: maps-cli
    purpose: responsibility
    map_label: cli
    roots:
      - packages/cli/src
    include:
      - "**/*.ts"
    allow_overlap_with: ${overlap}
    exclude:
${excludeBlock}
${extraSets}candidates: []
`;
  writeFileSync(join(root, "policy/rules-inventory.yaml"), yaml);
  for (const domain of ["attest", "reconcile"]) {
    const dir = join(root, "packages/core/src", domain);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sample.ts"), `/**\n * @responsibility ${domain} sample responsibility.\n */\nexport {};\n`);
  }
  mkdirSync(join(root, "packages/cli/src/commands"), { recursive: true });
  mkdirSync(join(root, "packages/cli/src/lib"), { recursive: true });
  writeFileSync(join(root, "packages/cli/src/bridge.ts"), declaredSource("bridges the cli root responsibility."));
  writeFileSync(join(root, "packages/cli/src/commands/b.ts"), declaredSource("runs the b subcommand."));
  writeFileSync(join(root, "packages/cli/src/lib/l.ts"), declaredSource("provides the l library."));
  return root;
}

function declaredSource(text: string): string {
  return `/**\n * @responsibility ${text}\n */\nexport {};\n`;
}

function spawn(root: string, args: string[], env: Record<string, string> = {}): { ok: boolean; status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, "--root", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { ok: true, status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function run(root: string): { ok: boolean; output: string } {
  const result = spawn(root, []);
  return { ok: result.ok, output: result.output };
}

function runCheck(root: string): { ok: boolean; output: string } {
  const result = spawn(root, ["--check"]);
  return { ok: result.ok, output: result.output };
}

function mtimes(root: string): Record<string, number> {
  const mapsDir = join(root, "docs/maps");
  if (!existsSync(mapsDir)) return {};
  const out: Record<string, number> = {};
  for (const name of readdirSync(mapsDir)) out[name] = statSync(join(mapsDir, name)).mtimeMs;
  return out;
}

function bytes(root: string): Record<string, string> {
  const mapsDir = join(root, "docs/maps");
  if (!existsSync(mapsDir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(mapsDir)) out[name] = readFileSync(join(mapsDir, name), "utf8");
  return out;
}

describe("US-RULE-005 / US-RULE-011 — generated module maps", () => {
  it("generates stable maps from complete declarations across existing and new contexts", () => {
    const root = fixtureRoot();

    const result = run(root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("generated 5 module maps");

    const first = readFileSync(join(root, "docs/maps/attest.md"), "utf8");
    expect(first).toContain("<!-- GENERATED by scripts/gen-module-maps.mjs; DO NOT EDIT. -->");
    expect(first).toContain("| `sample.ts` | attest sample responsibility. |");

    // New context emits its own map, contexts are derived from the tree.
    const backlog = readFileSync(join(root, "docs/maps/backlog.md"), "utf8");
    expect(backlog).toContain("# backlog module responsibility map");
    expect(backlog).toContain("| `sample.ts` | backlog sample responsibility. |");

    // Contexts sorted alphabetically: attest, backlog, evals, policy, reconcile.
    const json = JSON.parse(spawn(root, ["--json"]).output) as { maps: Array<{ context: string }> };
    expect(json.maps.map((map) => map.context)).toEqual(["attest", "backlog", "evals", "policy", "reconcile"]);
  });

  it("sorts rows within a map deterministically (alpha before sample before zeta)", () => {
    const root = fixtureRoot();

    expect(run(root).ok).toBe(true);
    writeFileSync(join(root, "packages/core/src/attest/zeta.ts"), declaredSource("zeta responsibility."));
    writeFileSync(join(root, "packages/core/src/attest/alpha.ts"), declaredSource("alpha responsibility."));
    expect(run(root).ok).toBe(true);
    const sorted = readFileSync(join(root, "docs/maps/attest.md"), "utf8");
    expect(sorted.indexOf("`alpha.ts`")).toBeLessThan(sorted.indexOf("`sample.ts`"));
    expect(sorted.indexOf("`sample.ts`")).toBeLessThan(sorted.indexOf("`zeta.ts`"));

    // Hand-editing a map is repaired byte-exact by write mode.
    writeFileSync(join(root, "docs/maps/attest.md"), "hand edit\n");
    expect(run(root).ok).toBe(true);
    expect(readFileSync(join(root, "docs/maps/attest.md"), "utf8")).toBe(sorted);
  });

  it.each([
    ["missing", "/** no declaration */\nexport {};\n", "missing @responsibility declaration"],
    ["duplicate", "/**\n * @responsibility first.\n * @responsibility second.\n */\nexport {};\n", "duplicate @responsibility declaration"],
    ["malformed", "/**\n * @responsibility\n */\nexport {};\n", "malformed @responsibility declaration"],
  ])("fails loud for a %s declaration (inventory-driven discovery)", (_kind, source, expected) => {
    const root = fixtureRoot();
    writeFileSync(join(root, "packages/core/src/attest/sample.ts"), source);

    const result = run(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("packages/core/src/attest/sample.ts");
    expect(result.output).toContain(expected);
  });

  it("honors an exclusion entry: no row, check ok; a stale exclusion path is a missing-inventory finding", () => {
    const root = fixtureRoot(["packages/core/src/attest/excluded.ts"]);
    writeFileSync(join(root, "packages/core/src/attest/excluded.ts"), "export {};\n");

    expect(run(root).ok).toBe(true);
    const attest = readFileSync(join(root, "docs/maps/attest.md"), "utf8");
    expect(attest).not.toContain("excluded.ts");
    expect(runCheck(root).ok).toBe(true);

    // Exclusion references a file that does not exist on disk → stale exclusion.
    const stale = fixtureRoot(["packages/core/src/attest/ghost.ts"]);
    expect(runCheck(stale).ok).toBe(false);
    expect(runCheck(stale).output).toContain("missing inventory: exclusion path does not exist: packages/core/src/attest/ghost.ts");
  });

  it("fails with the missing-inventory class when the yaml is absent, has no responsibility set, or the root is gone", () => {
    const noYaml = mkdtempSync(join(tmpdir(), "roll-module-maps-"));
    dirs.push(noYaml);
    expect(runCheck(noYaml).output).toContain("missing inventory: policy/rules-inventory.yaml not found");

    const noSet = fixtureRoot();
    writeFileSync(join(noSet, "policy/rules-inventory.yaml"), "version: 1\ncoverage_sets: []\ncandidates: []\n");
    expect(runCheck(noSet).output).toContain("missing inventory: no responsibility coverage set declared");

    const noRoot = fixtureRoot();
    rmSync(join(noRoot, "packages/core/src"), { recursive: true, force: true });
    expect(runCheck(noRoot).output).toContain("missing inventory: declared responsibility root does not exist: packages/core/src");
  });

  it("flags a hand-edited map as stale under --check and never writes in check mode", () => {
    const root = fixtureRoot();
    expect(run(root).ok).toBe(true);
    writeFileSync(join(root, "docs/maps/attest.md"), "hand edit\n");
    const beforeMtimes = mtimes(root);
    const beforeBytes = bytes(root);

    const result = runCheck(root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("stale map: map out of date: docs/maps/attest.md");
    expect(mtimes(root)).toEqual(beforeMtimes);
    expect(bytes(root)).toEqual(beforeBytes);
  });

  it("flags an orphan map under --check and prunes it in write mode", () => {
    const root = fixtureRoot();
    expect(run(root).ok).toBe(true);
    mkdirSync(join(root, "docs/maps"), { recursive: true });
    writeFileSync(join(root, "docs/maps/hand.md"), "# hand-maintained\n");

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("stale map: orphan map output: docs/maps/hand.md");

    expect(run(root).ok).toBe(true);
    expect(existsSync(join(root, "docs/maps/hand.md"))).toBe(false);
    expect(existsSync(join(root, "docs/maps/attest.md"))).toBe(true);
  });

  it("detects same-file overlap between two responsibility sets unless mutually allowed", () => {
    // Second set roots at the attest context: it covers the same file while
    // producing a distinct map name (core.md) — the overlap is about the FILE.
    const twoSets = (mutual: boolean) => `version: 1
coverage_sets:
  - id: maps-core
    purpose: responsibility
    roots: [packages/core/src]
    include: ["**/*.ts"]
    allow_overlap_with: ${mutual ? "[maps-attest]" : "[]"}
    exclude: []
  - id: maps-attest
    purpose: responsibility
    roots: [packages/core/src/attest]
    include: ["**/*.ts"]
    allow_overlap_with: ${mutual ? "[maps-core]" : "[]"}
    exclude: []
candidates: []
`;
    const overlapped = fixtureRoot();
    writeFileSync(join(overlapped, "policy/rules-inventory.yaml"), twoSets(false));
    const check = runCheck(overlapped);
    expect(check.ok).toBe(false);
    expect(check.output).toContain(
      "overlap: packages/core/src/attest/sample.ts covered by maps-core and maps-attest without allow_overlap_with",
    );

    const allowed = fixtureRoot();
    writeFileSync(join(allowed, "policy/rules-inventory.yaml"), twoSets(true));
    // Write mode produces 6 maps: the 5 core contexts plus `core.md` from the
    // attest-rooted second set; overlap is allowed so it stays green.
    expect(run(allowed).ok).toBe(true);
    const checkAllowed = runCheck(allowed);
    expect(checkAllowed.ok).toBe(true);
    expect(checkAllowed.output).toContain("module maps ok: 6 maps fresh");
  });

  it("emits the deterministic --json shape and identical bytes across runs", () => {
    const root = fixtureRoot();
    expect(run(root).ok).toBe(true);

    const first = spawn(root, ["--check", "--json"]);
    const second = spawn(root, ["--check", "--json"]);
    expect(first.ok).toBe(true);
    expect(first.output).toBe(second.output);

    const json = JSON.parse(first.output) as { ok: boolean; findings: Array<{ kind: string; message: string }>; maps: Array<{ context: string; file: string; rows: Array<{ file: string; text: string }> }> };
    expect(json.ok).toBe(true);
    expect(json.findings).toEqual([]);
    expect(json.maps.length).toBe(5);
    expect(json.maps[0]).toMatchObject({ context: "attest", file: "docs/maps/attest.md" });
    expect(json.maps[0].rows).toEqual([{ file: "sample.ts", text: "attest sample responsibility." }]);
  });

  it("fails with the build-first message when @roll/spec is not built", () => {
    const root = fixtureRoot();
    const result = spawn(root, ["--check"], { ROLL_SPEC_DIST: join(root, "packages/spec/dist/index.js") });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("@roll/spec not built — run `pnpm -r build` first");
  });

  // ── US-RULE-012 — package-aware labeled sets (map_label) ──────────────────

  it("emits labeled maps (cli.md / cli-commands.md / cli-lib.md) with row-relative paths, core maps unchanged, and disjoint contexts", () => {
    const root = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(root, "packages/cli/src/index.ts"), "export {};\n");

    const result = run(root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("generated 5 module maps");

    // Root files map to docs/maps/cli.md; subdirectories get prefixed stems.
    const cli = readFileSync(join(root, "docs/maps/cli.md"), "utf8");
    expect(cli).toContain("# cli module responsibility map");
    expect(cli).toContain("| `bridge.ts` | bridges the cli root responsibility. |");

    const commands = readFileSync(join(root, "docs/maps/cli-commands.md"), "utf8");
    expect(commands).toContain("| `b.ts` | runs the b subcommand. |");
    expect(commands).not.toContain("../commands/b.ts");

    const lib = readFileSync(join(root, "docs/maps/cli-lib.md"), "utf8");
    expect(lib).toContain("| `l.ts` | provides the l library. |");

    // Legacy core maps are byte-identical (attest.md / reconcile.md untouched).
    const attest = readFileSync(join(root, "docs/maps/attest.md"), "utf8");
    expect(attest).toContain("| `sample.ts` | attest sample responsibility. |");
    expect(attest).not.toContain("cli");

    expect(runCheck(root).ok).toBe(true);
    expect(runCheck(root).output).toContain("module maps ok: 5 maps fresh");

    // --json deterministic and labeled stems disjoint from bare core contexts.
    const json = JSON.parse(spawn(root, ["--check", "--json"]).output) as { maps: Array<{ context: string }> };
    expect(json.maps.map((map) => map.context)).toEqual(["attest", "cli", "cli-commands", "cli-lib", "reconcile"]);
  });

  it("fails loud when a new .ts under a labeled root lacks a header; write ok after the header is added", () => {
    const root = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(root, "packages/cli/src/index.ts"), "export {};\n");
    writeFileSync(join(root, "packages/cli/src/commands/newcmd.ts"), "export {};\n");

    const failing = run(root);
    expect(failing.ok).toBe(false);
    expect(failing.output).toContain("packages/cli/src/commands/newcmd.ts");
    expect(failing.output).toContain("missing source header with @responsibility declaration");

    writeFileSync(join(root, "packages/cli/src/commands/newcmd.ts"), declaredSource("runs the newcmd subcommand."));
    expect(run(root).ok).toBe(true);
    const map = readFileSync(join(root, "docs/maps/cli-commands.md"), "utf8");
    expect(map).toContain("| `newcmd.ts` | runs the newcmd subcommand. |");
    expect(runCheck(root).ok).toBe(true);
  });

  it("flags a deleted exclusion target as missing inventory; removing a declared file regenerates clean", () => {
    const stale = labeledFixture(["packages/cli/src/index.ts", "packages/cli/src/commands/ghost.ts"]);
    writeFileSync(join(stale, "packages/cli/src/index.ts"), "export {};\n");
    const check = runCheck(stale);
    expect(check.ok).toBe(false);
    expect(check.output).toContain("missing inventory: exclusion path does not exist: packages/cli/src/commands/ghost.ts");

    const removed = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(removed, "packages/cli/src/index.ts"), "export {};\n");
    expect(run(removed).ok).toBe(true);
    expect(existsSync(join(removed, "docs/maps/cli-commands.md"))).toBe(true);
    rmSync(join(removed, "packages/cli/src/commands/b.ts"));
    // Removing a declared file simply drops its row — regenerates clean, and
    // the now-empty context emits no map (never a failure).
    expect(run(removed).ok).toBe(true);
    expect(existsSync(join(removed, "docs/maps/cli-commands.md"))).toBe(false);
    expect(runCheck(removed).ok).toBe(true);
  });

  it("fails on an unsupported include glob in a labeled set via failed-to-parse", () => {
    const root = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(root, "packages/cli/src/index.ts"), "export {};\n");
    const yaml = readFileSync(join(root, "policy/rules-inventory.yaml"), "utf8").replaceAll('"**/*.ts"', '"**/*.{ts,tsx}"');
    writeFileSync(join(root, "policy/rules-inventory.yaml"), yaml);

    const result = runCheck(root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("failed to parse");
    expect(result.output).toContain("unsupported include pattern");
  });

  it("rejects a duplicate @responsibility declaration inside a labeled set", () => {
    const root = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(root, "packages/cli/src/index.ts"), "export {};\n");
    writeFileSync(join(root, "packages/cli/src/bridge.ts"), "/**\n * @responsibility first.\n * @responsibility second.\n */\nexport {};\n");

    const result = run(root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("packages/cli/src/bridge.ts");
    expect(result.output).toContain("duplicate @responsibility declaration");
  });

  it("fails via parse for an escaping root or an exclusion outside the declared root", () => {
    const escaped = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(escaped, "packages/cli/src/index.ts"), "export {};\n");
    const yaml = readFileSync(join(escaped, "policy/rules-inventory.yaml"), "utf8").replace("      - packages/cli/src", "      - ../outside");
    writeFileSync(join(escaped, "policy/rules-inventory.yaml"), yaml);
    expect(runCheck(escaped).output).toContain("failed to parse");

    const outside = labeledFixture(["packages/other/src/outside.ts"]);
    expect(runCheck(outside).output).toContain("failed to parse");
  });

  it("detects overlap between a legacy and a labeled set unless mutually allowed", () => {
    const build = (mutual: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "roll-module-maps-"));
      dirs.push(root);
      mkdirSync(join(root, "policy"), { recursive: true });
      mkdirSync(join(root, "packages/core/src/attest"), { recursive: true });
      writeFileSync(join(root, "packages/core/src/attest/sample.ts"), declaredSource("attest sample responsibility."));
      const yaml = `version: 1
coverage_sets:
  - id: maps-core
    purpose: responsibility
    roots: [packages/core/src/attest]
    include: ["**/*.ts"]
    allow_overlap_with: ${mutual ? "[maps-cli]" : "[]"}
    exclude: []
  - id: maps-cli
    purpose: responsibility
    map_label: cli
    roots: [packages/core/src/attest]
    include: ["**/*.ts"]
    allow_overlap_with: ${mutual ? "[maps-core]" : "[]"}
    exclude: []
candidates: []
`;
      writeFileSync(join(root, "policy/rules-inventory.yaml"), yaml);
      return root;
    };

    const overlapped = build(false);
    const check = runCheck(overlapped);
    expect(check.ok).toBe(false);
    expect(check.output).toContain(
      "overlap: packages/core/src/attest/sample.ts covered by maps-core and maps-cli without allow_overlap_with",
    );

    const allowed = build(true);
    expect(run(allowed).ok).toBe(true);
    expect(runCheck(allowed).ok).toBe(true);
    expect(runCheck(allowed).output).toContain("module maps ok: 2 maps fresh");
    // Labeled + legacy contexts both emitted for the shared root file: the
    // legacy set maps root files to core.md, the labeled set to cli.md.
    expect(readFileSync(join(allowed, "docs/maps/core.md"), "utf8")).toContain("| `sample.ts` |");
    expect(readFileSync(join(allowed, "docs/maps/cli.md"), "utf8")).toContain("| `sample.ts` |");
  });

  it.skipIf(process.platform === "win32")("fails loud on a symlinked .ts under a labeled root and never renders it", () => {
    const root = labeledFixture(["packages/cli/src/index.ts"]);
    writeFileSync(join(root, "packages/cli/src/index.ts"), "export {};\n");
    expect(run(root).ok).toBe(true);
    symlinkSync(join(root, "packages/cli/src/commands/b.ts"), join(root, "packages/cli/src/commands/link.ts"));

    const check = runCheck(root);
    expect(check.ok).toBe(false);
    expect(check.output).toContain(
      "missing inventory: symlink under declared responsibility root: packages/cli/src/commands/link.ts",
    );
    const map = readFileSync(join(root, "docs/maps/cli-commands.md"), "utf8");
    expect(map).not.toContain("link.ts");
  });
});
