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
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** Named bindings in `import { a, type B, c as d } from "spec"` blocks. */
function namedImports(src: string): Array<{ names: string[]; spec: string }> {
  const out: Array<{ names: string[]; spec: string }> = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
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
    // `export { a, b as name }` / `export type { ... }`, incl. named re-export
    // from another module. The `type` keyword is why several real exports first
    // read as phantoms while I was building this.
    new RegExp(`export\\s+(type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`),
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
  ];
  if (direct.some((re) => re.test(src))) return true;
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

  it("sees through a barrel — the blind spot codex r2 found", () => {
    // A real barrel in this repo, reached the way tests reach it.
    const barrel = resolveSpec(join(TEST_DIR, "x.test.ts"), "../src/lib/index.js");
    if (barrel === undefined) return; // no such barrel: nothing to prove here
    expect(exportsName(barrel, "definitelyNotExportedAnywhere")).toBe(false);
  });
});
