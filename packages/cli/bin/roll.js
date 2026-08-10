#!/usr/bin/env node
// Roll v3 CLI entry — TS-first (US-SCAF-004).
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");
const buildRoot = join(packageRoot, "dist");

/**
 * The published package contains `dist/` but not TypeScript source. A checkout
 * contains both, so only there can the launcher detect that it would execute an
 * older build than the source a contributor has just changed.
 */
function staleDevelopmentBuild() {
  if (!existsSync(sourceRoot) || !existsSync(buildRoot)) return false;
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(sourcePath);
        continue;
      }
      if (!entry.isFile() || !sourcePath.endsWith(".ts")) continue;
      const compiledPath = join(buildRoot, relative(sourceRoot, sourcePath).replace(/\.ts$/, ".js"));
      if (!existsSync(compiledPath) || statSync(sourcePath).mtimeMs > statSync(compiledPath).mtimeMs) return true;
    }
  }
  return false;
}

if (staleDevelopmentBuild()) {
  process.stderr.write("[roll] Local CLI build is out of date. Run `pnpm -r build` before using this repository command.\n");
  process.exit(1);
}

const { dispatch, registerAll } = await import("../dist/index.js");

registerAll();

// US-LOOP-114: no wake hook. Nothing in a roll command arms a scheduler, because
// there is no scheduler — the session that runs `roll loop go` drives delivery.
const { status } = await dispatch(process.argv.slice(2));
process.exit(status);
