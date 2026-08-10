import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // US-BROW-020 — the live managed-lane gate spawns a real chrome-devtools-mcp
    // process + real Chrome. It must NEVER run inside the default `roll test` /
    // `npm test` suite (those must be green with no Chrome). It runs only in the
    // declared Chrome-capable CI lane via `pnpm test:browser-live`, or fails
    // loud when invoked in a non-Chrome-capable environment. Excluding it here
    // is not a silent skip: the file itself fails loud when the environment
    // cannot host it, and it is never counted as verifying the lane by default.
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
    // Several suites spawn a `node` CLI leg + git/gh shims per case — solo
    // that's fast, but under the full suite's parallel load any of them can
    // blow vitest's 5s default. The generous ceiling is contention headroom,
    // not the expected cost; a real hang (e.g. a stray credential prompt)
    // still fails, just slower.
    testTimeout: 30_000,
    // Several files here are subprocess-bound (they spawn `node` CLI legs
    // and git/gh shims), so a worker per core oversubscribes the box
    // several-fold and starves those heavier harnesses. Cap the file-level
    // parallelism instead of letting it float.
    maxWorkers: 6,
    minWorkers: 1,
  },
});
