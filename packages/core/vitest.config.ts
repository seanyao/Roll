import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * US-DELTA-003: test-only import-boundary repair for hermetic lease suite.
 * Resolves @roll/spec to its TypeScript source so the test can import
 * reconcileExpiredClaims from its narrow tracked source module without
 * requiring dist to be prebuilt.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@roll/spec": resolve(__dirname, "../spec/src/index.ts"),
    },
  },
});
