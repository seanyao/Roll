/**
 * US-LOOP-117 — tests must not import symbols that no longer exist.
 *
 * Vitest transpiles without typechecking, so a named import of a deleted export
 * silently yields `undefined` and the suite keeps passing. This epic hit that trap
 * three times (US-LOOP-110, 116, 117): a deleted export stayed "covered" by a test
 * that could no longer fail. `tsc` does not catch it either, because tsconfig
 * excludes `test/`.
 *
 * So check it directly: every named import a test takes from our own source must
 * actually be exported there — including through barrels, which is where the
 * deleted modules of this epic actually lived (codex r2).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "__snapshots__" || name === "fixtures") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(TEST_DIR);
  return out;
}

/**
 * Drop comments before scanning. Without this the scanner reads the example
 * import inside a doc comment as a real one — which is exactly what happened on
 * this file's own first run.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Named bindings in `import { a, type B, c as d } from "spec"` blocks.
 *
 * codex r3: `import type { … }` was unscanned, so a phantom type-only import
 * slipped through — and type-only imports are the MOST likely to rot, because
 * nothing at runtime ever touches them.
 */
function namedImports(src: string): Array<{ names: string[]; spec: string }> {
  const out: Array<{ names: string[]; spec: string }> = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const names = (m[1] ?? "")
      .split(",")
      .map((raw) => raw.trim())
      .filter((raw) => raw !== "")
      // `type X` is still an export that must exist; `a as b` -> check `a`.
      .map((raw) => raw.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter((n) => n !== "");
    out.push({ names, spec: m[2] ?? "" });
  }
  return out;
}

/** Resolve a relative module spec (`./x.js`) to the .ts file that backs it. */
function resolveSpec(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try next shape */
    }
  }
  return undefined;
}

/**
 * The names an `export { … }` clause actually publishes.
 *
 * In `export { local as published }` only `published` is importable — `local` is
 * not. codex r3 caught the earlier version accepting both, because it tested the
 * whole brace body for the name.
 */
export function exportClauseNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const clause = raw.trim().replace(/^type\s+/, "");
      if (clause === "") continue;
      const parts = clause.split(/\s+as\s+/);
      // `a as b` publishes b; a bare `a` publishes a.
      const published = (parts.length > 1 ? parts[parts.length - 1] : parts[0])!.trim();
      if (published !== "") out.push(published);
    }
  }
  return out;
}

/** `export * from "./x.js"` targets declared in this file. */
function starReexports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec !== undefined && spec.startsWith(".")) out.push(spec);
  }
  return out;
}

/**
 * Does `file` export `name`, directly or through a `export *` barrel?
 *
 * codex r2: the first version treated the mere PRESENCE of `export *` as proof
 * that any name might be forwarded, so every import through a barrel passed
 * unconditionally — preserving the exact blind spot. Now the star targets are
 * followed, and a name that no leaf actually declares is reported.
 *
 * A star target that cannot be resolved (a package re-export, say) still yields
 * `true`: false NEGATIVES are acceptable here, false POSITIVES are not.
 */
function exportsName(file: string, name: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  let src: string;
  try {
    src = code(readFileSync(file, "utf8"));
  } catch {
    return true; // unreadable: do not accuse
  }
  const direct = [
    new RegExp(`export\\s+(async\\s+)?(function|class)\\s+${name}\\b`),
    new RegExp(`export\\s+(const|let|var)\\s+${name}\\b`),
    new RegExp(`export\\s+(interface|type|enum)\\s+${name}\\b`),
  ];
  if (direct.some((re) => re.test(src))) return true;
  // `export { a, b as c }` — only the EXPORTED side counts. codex r3: matching
  // the whole brace body accepted `local as public`, so importing the local name
  // (which is NOT exported) passed.
  if (exportClauseNames(src).includes(name)) return true;
  for (const spec of starReexports(src)) {
    const target = resolveSpec(file, spec);
    if (target === undefined) return true; // unresolvable hop: do not accuse
    if (exportsName(target, name, seen)) return true;
  }
  return false;
}

describe("US-LOOP-117 — no test imports a phantom export", () => {
  it("every named import from our own src resolves to a real export", () => {
    const phantom: string[] = [];
    for (const f of testFiles()) {
      for (const { names, spec } of namedImports(code(readFileSync(f, "utf8")))) {
        // Only our own relative source files — packages resolve via node.
        if (!spec.startsWith(".") || !spec.includes("/src/")) continue;
        const target = resolveSpec(f, spec);
        if (target === undefined) {
          phantom.push(`${f.replace(TEST_DIR, "")}: cannot read ${spec}`);
          continue;
        }
        for (const name of names) {
          if (!exportsName(target, name)) {
            phantom.push(`${f.replace(TEST_DIR, "")}: ${spec} does not export ${name}`);
          }
        }
      }
    }
    expect(phantom).toEqual([]);
  });

  /**
   * codex r3: the first version of this proof pointed at `src/lib/index.js`,
   * which does not exist, and then `return`ed early — so it asserted nothing
   * while reading as if it proved recursion. Build the barrel chain instead, so
   * the traversal is exercised for real.
   */
  it("recurses through a barrel chain: finds a leaf export, rejects a phantom", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-barrel-"));
    try {
      writeFileSync(join(dir, "leaf.ts"), "export function realLeafSymbol(): void {}\n");
      writeFileSync(join(dir, "mid.ts"), 'export * from "./leaf.js";\n');
      writeFileSync(join(dir, "index.ts"), 'export * from "./mid.js";\n');
      const barrel = join(dir, "index.ts");
      // Two hops down to the leaf — this is what `export *` blanket-passing hid.
      expect(exportsName(barrel, "realLeafSymbol")).toBe(true);
      // And a name no leaf declares is still reported, rather than waved through.
      expect(exportsName(barrel, "neverDeclaredAnywhere")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans type-only imports too (codex r3)", () => {
    // The spec here is deliberately NOT of the `./…/src/…` shape the sweep above
    // collects, so this fixture cannot be mistaken for a real import of ours.
    const found = namedImports('import type { Alpha, Beta as B } from "some-package";');
    expect(found).toHaveLength(1);
    expect(found[0]!.names).toEqual(["Alpha", "Beta"]);
    expect(found[0]!.spec).toBe("some-package");
  });

  it("an export alias publishes only the RIGHT-hand name (codex r3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-alias-"));
    try {
      const f = join(dir, "aliased.ts");
      writeFileSync(f, "function localOnly(): void {}\nexport { localOnly as publishedName };\n");
      expect(exportsName(f, "publishedName")).toBe(true);
      // `localOnly` is NOT importable — accepting it was the r3 finding.
      expect(exportsName(f, "localOnly")).toBe(false);
      expect(exportClauseNames("export { a, b as c, type D as E };")).toEqual(["a", "c", "E"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a cyclic barrel pair terminates instead of recursing forever", () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-barrel-cycle-"));
    try {
      writeFileSync(join(dir, "a.ts"), 'export * from "./b.js";\n');
      writeFileSync(join(dir, "b.ts"), 'export * from "./a.js";\n');
      expect(exportsName(join(dir, "a.ts"), "nothingHere")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
