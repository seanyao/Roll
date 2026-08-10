#!/usr/bin/env node
/**
 * Bundle the v3 TypeScript CLI into a single self-contained ESM file for the
 * published npm package (`@seanyao/roll`).
 *
 * The workspace packages depend on each other via `workspace:*` + bare
 * `@roll/*` imports, which only resolve through the pnpm-linked node_modules.
 * A packed tarball carries no node_modules, so those imports would be dead on
 * an end-user install. esbuild walks the entry's import graph and inlines every
 * `@roll/*` module, emitting `dist/roll.mjs` — the file `bin.roll` points at.
 *
 * Invoked through esbuild's JS API (not its CLI): on most platforms esbuild's
 * `bin/esbuild` is a native binary, and pnpm's generated `.bin` shim wraps it
 * with `node <binary>`, which fails. The JS API spawns the binary as a service
 * itself, so it is portable across platforms and pnpm versions.
 *
 * Runtime note: `dist/roll.mjs` resolves its data dirs (lib/prices snapshots,
 * lib/slides templates, conventions/) by walking up from its own location to
 * the package root, keyed on the shipped `conventions/` directory — see
 * `packages/cli/src/bridge.ts` repoRoot(). The package `files` array ships
 * dist/ + lib/ + conventions/ + template/ so that walk succeeds from the
 * installed location.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const common = {
  bundle: true,
  // Playwright Core executes optional platform-specific code at runtime. Keep
  // it outside the CLI bundle, but ship its complete runtime closure in the
  // npm tarball via root bundledDependencies.
  external: ["chromium-bidi", "playwright-core"],
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: [
      "import { createRequire as __rollCreateRequire } from 'node:module';",
      "import { fileURLToPath as __rollFileURLToPath } from 'node:url';",
      "import { dirname as __rollDirname } from 'node:path';",
      "const require = __rollCreateRequire(import.meta.url);",
      "const __filename = __rollFileURLToPath(import.meta.url);",
      "const __dirname = __rollDirname(__filename);",
    ].join("\n"),
  },
};

await build({
  ...common,
  entryPoints: [join(repoRoot, "packages", "cli", "bin", "roll.js")],
  outfile: join(repoRoot, "dist", "roll.mjs"),
});

await build({
  ...common,
  entryPoints: [join(repoRoot, "packages", "cli", "bin", "postinstall.js")],
  outfile: join(repoRoot, "dist", "postinstall.mjs"),
});

console.log("✓ bundled dist/roll.mjs");
console.log("✓ bundled dist/postinstall.mjs");
