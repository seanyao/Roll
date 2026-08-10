/**
 * FIX-1493 — this repo publishes exactly ONE npm name.
 *
 * `@seanyao/roll` is the only published npm name for this repo.
 *
 * The alias MECHANISM stays (an empty list) so version planning, self-update and
 * the release gate keep treating every published name identically — adding a name
 * later is one edit and the gate's "every name carries this version" guarantee
 * comes along for free.
 */
import { describe, expect, it } from "vitest";

import { ROLL_PACKAGE_ALIASES, ROLL_PACKAGE_NAME, ROLL_PACKAGE_NAMES, resolveVersionScheme } from "../src/release/plan.js";

describe("FIX-1493 — this repo publishes exactly one name", () => {
  it("publishes only @seanyao/roll, with no aliases", () => {
    expect(ROLL_PACKAGE_NAME).toBe("@seanyao/roll");
    expect(ROLL_PACKAGE_ALIASES).toEqual([]);
    expect(ROLL_PACKAGE_NAMES).toEqual(["@seanyao/roll"]);
  });

  it("does NOT treat unrelated package names as release targets", () => {
    expect(ROLL_PACKAGE_NAMES).not.toContain("@example/roll");
  });

  it("resolves calver for every published name", () => {
    // The regression this pins: an alias falling through to semver would make
    // `roll release` plan a completely different version for the same product.
    for (const name of ROLL_PACKAGE_NAMES) {
      expect(resolveVersionScheme(name), `${name} must be calver`).toBe("calver");
    }
    expect(resolveVersionScheme("some-other-package")).toBe("semver");
  });
});
