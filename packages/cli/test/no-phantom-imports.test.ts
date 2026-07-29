/**
 * US-LOOP-117 — tests must not import symbols that no longer exist.
 *
 * Vitest transpiles without typechecking, so `import { gone } from "../src/x.js"`
 * silently yields `undefined` and the suite keeps passing. This epic hit that trap
 * three times (US-LOOP-110, 116, 117): a deleted export stayed "covered" by a test
 * that could no longer fail. `tsc` does not catch it either, because tsconfig
 * excludes `test/`.
 *
 * So check it directly: every named import a test takes from our own source must
 * actually be exported there.
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

/** Does `file` export `name`? Deliberately loose — false NEGATIVES are fine. */
function exportsName(src: string, name: string): boolean {
  const patterns = [
    new RegExp(`export\\s+(async\\s+)?(function|class)\\s+${name}\\b`),
    new RegExp(`export\\s+(const|let|var)\\s+${name}\\b`),
    new RegExp(`export\\s+(interface|type|enum)\\s+${name}\\b`),
    // `export { a, b as name }` and re-export barrels.
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
    new RegExp(`export\\s+\\*`), // a barrel may forward it; do not flag
  ];
  return patterns.some((re) => re.test(src));
}

describe("US-LOOP-117 — no test imports a phantom export", () => {
  it("every named import from our own src resolves to a real export", () => {
    const phantom: string[] = [];
    for (const f of testFiles()) {
      const src = readFileSync(f, "utf8");
      // Strip comments first: this file's own doc comment contains an `import { gone }
    // from "../src/x.js"` example, which the scanner dutifully flagged on first run.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const { names, spec } of namedImports(code)) {
        // Only our own relative source files — packages resolve via node.
        if (!spec.startsWith(".") || !spec.includes("/src/")) continue;
        const target = resolve(dirname(f), spec.replace(/\.js$/, ".ts"));
        let targetSrc: string;
        try {
          targetSrc = readFileSync(target, "utf8");
        } catch {
          phantom.push(`${f.replace(TEST_DIR, "")}: cannot read ${spec}`);
          continue;
        }
        for (const name of names) {
          if (!exportsName(targetSrc, name)) {
            phantom.push(`${f.replace(TEST_DIR, "")}: ${spec} does not export ${name}`);
          }
        }
      }
    }
    expect(phantom).toEqual([]);
  });
});
