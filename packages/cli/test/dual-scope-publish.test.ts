/**
 * US-INSTALL-007 — one artifact, two npm names, no drift.
 *
 * npm has no notion that `@bipo-ape/roll` and `@seanyao/roll` are the same
 * product. Two things therefore have to be enforced here, not by the registry:
 *
 *   1. Self-update must follow the name the owner ACTUALLY installed. Hard-
 *      coding one name silently migrates users of the other scope onto it —
 *      they would keep believing they run the package they chose.
 *   2. `release verify` must require EVERY name to carry the version before it
 *      promotes the GitHub Release. A forgotten mirror publish otherwise leaves
 *      half the users on the old version while the release reads "shipped".
 */
import { describe, expect, it } from "vitest";

import { ROLL_PACKAGE_NAMES, verifyRelease, type ReleaseVerifySeams } from "@roll/core";
import { installedPackageName } from "../src/commands/update.js";

describe("US-INSTALL-007 — self-update follows the installed scope", () => {
  it("stays on the alias when that is what is installed", () => {
    expect(installedPackageName("@seanyao/roll")).toBe("@seanyao/roll");
  });

  it("stays on the primary when that is what is installed", () => {
    expect(installedPackageName("@bipo-ape/roll")).toBe("@bipo-ape/roll");
  });

  it("falls back to the primary for a dev checkout or unreadable tree", () => {
    for (const notRoll of [null, undefined, "", "some-fork"]) {
      expect(installedPackageName(notRoll)).toBe("@bipo-ape/roll");
    }
  });
});

describe("US-INSTALL-007 — release verify covers every published name", () => {
  /** Seams where `published` lists the names that actually have the version. */
  function seams(published: string[], promoted: { called: boolean }): ReleaseVerifySeams {
    return {
      tagExists: () => true,
      npmHasVersion: (pkg) => published.includes(pkg),
      npmLatest: (pkg) => (published.includes(pkg) ? "9.9.9" : undefined),
      getRelease: () => ({ isDraft: true }),
      promoteRelease: () => {
        promoted.called = true;
      },
    };
  }

  it("promotes only when ALL names are published", () => {
    const promoted = { called: false };
    const res = verifyRelease(ROLL_PACKAGE_NAMES, "9.9.9", "v9.9.9", seams([...ROLL_PACKAGE_NAMES], promoted));
    expect(res.ok).toBe(true);
    expect(promoted.called).toBe(true);
  });

  it("fails and leaves the draft alone when a mirror was not published", () => {
    const promoted = { called: false };
    const res = verifyRelease(ROLL_PACKAGE_NAMES, "9.9.9", "v9.9.9", seams(["@bipo-ape/roll"], promoted));
    expect(res.ok).toBe(false);
    expect(promoted.called).toBe(false);
    // Names the missing package — a gap the owner cannot act on is not a gap.
    expect(res.gaps.join("\n")).toContain("@seanyao/roll");
  });
});
