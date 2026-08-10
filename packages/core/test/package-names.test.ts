/**
 * FIX-1493 — this repo publishes exactly ONE npm name.
 *
 * The dual-scope arrangement (US-INSTALL-007) is retired: `seanyao/roll` and
 * `BIPOSVC/ape-roll` are separate repositories that each publish their own name.
 * Mirroring one repo's artifact under the other's name would ship this codebase
 * out under the other project's identity.
 *
 * The alias MECHANISM stays (an empty list) so version planning, self-update and
 * the release gate keep treating every published name identically — adding a name
 * later is one edit and the gate's "every name carries this version" guarantee
 * comes along for free.
 */
import { describe, expect, it } from "vitest";

import { ROLL_PACKAGE_ALIASES, ROLL_PACKAGE_NAME, ROLL_PACKAGE_NAMES, resolveVersionScheme } from "../src/release/plan.js";

describe("FIX-1493 — this repo publishes exactly one name", () => {
  it("publishes only @bipo-ape/roll, with no aliases", () => {
    expect(ROLL_PACKAGE_NAME).toBe("@bipo-ape/roll");
    expect(ROLL_PACKAGE_ALIASES).toEqual([]);
    expect(ROLL_PACKAGE_NAMES).toEqual(["@bipo-ape/roll"]);
  });

  it("does NOT treat the other repo's name as a release target", () => {
    // Re-adding it would make `roll release` publish this codebase under the old
    // repo's identity, and would block `release verify` on a name this repo does
    // not own.
    expect(ROLL_PACKAGE_NAMES).not.toContain("@seanyao/roll");
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
