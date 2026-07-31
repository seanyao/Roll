/**
 * US-INSTALL-007 — roll ships under two npm names that must never drift.
 *
 * `@bipo-ape/roll` is what the docs teach; `@seanyao/roll` is the equivalent
 * alias kept alive for everyone already installed from it. npm cannot re-scope
 * a published package, so "the same thing under both names" is not something
 * the registry enforces — only the release flow and these assertions do.
 */
import { describe, expect, it } from "vitest";

import { ROLL_PACKAGE_ALIASES, ROLL_PACKAGE_NAME, ROLL_PACKAGE_NAMES, resolveVersionScheme } from "../src/release/plan.js";

describe("US-INSTALL-007 — both published names are first-class", () => {
  it("names the new scope as primary and keeps the old one as an alias", () => {
    expect(ROLL_PACKAGE_NAME).toBe("@bipo-ape/roll");
    expect(ROLL_PACKAGE_ALIASES).toContain("@seanyao/roll");
    expect(ROLL_PACKAGE_NAMES).toEqual([ROLL_PACKAGE_NAME, ...ROLL_PACKAGE_ALIASES]);
  });

  it("resolves calver for EVERY published name, not just the primary", () => {
    // The regression this pins: an alias falling through to semver would make
    // `roll release` plan a completely different version for the same product.
    for (const name of ROLL_PACKAGE_NAMES) {
      expect(resolveVersionScheme(name), `${name} must be calver`).toBe("calver");
    }
    expect(resolveVersionScheme("some-other-package")).toBe("semver");
  });
});
