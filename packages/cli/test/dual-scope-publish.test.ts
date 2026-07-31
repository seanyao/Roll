/**
 * FIX-1493 — this repo publishes ONE npm name, and the multi-name gate stays.
 *
 * The dual-scope arrangement (US-INSTALL-007) is retired: `seanyao/roll` and
 * `BIPOSVC/ape-roll` are separate repositories that each publish their own name.
 * Publishing this artifact under the other repo's name would ship this codebase
 * out under that project's identity — and it made `release verify` block forever
 * on a name this repo does not own.
 *
 * Two things are still enforced here, not by the registry:
 *
 *   1. Self-update must follow the name the owner ACTUALLY installed. Someone who
 *      installed the old name keeps running the old name — roll never silently
 *      migrates them onto a different package.
 *   2. `release verify` must require EVERY published name to carry the version
 *      before promoting the GitHub Release. That list is one name today; the
 *      guarantee is kept so re-adding a name later needs no new gate.
 */
import { describe, expect, it } from "vitest";

import { ROLL_PACKAGE_NAMES, verifyRelease, type ReleaseVerifySeams } from "@roll/core";
import { installedPackageName } from "../src/commands/update.js";

describe("FIX-1493 — self-update follows the installed name", () => {
  it("stays on the primary when that is what is installed", () => {
    expect(installedPackageName("@bipo-ape/roll")).toBe("@bipo-ape/roll");
  });

  it("does not migrate a user off a name this repo no longer publishes", () => {
    // Someone who installed the old name still runs the old name. Rewriting it to
    // the primary would move them onto a different package behind their back.
    expect(installedPackageName("@seanyao/roll")).toBe("@seanyao/roll");
  });

  it("falls back to the primary for a dev checkout or unreadable tree", () => {
    for (const notRoll of [null, undefined, "", "some-fork"]) {
      expect(installedPackageName(notRoll)).toBe("@bipo-ape/roll");
    }
  });
});

describe("FIX-1493 — release verify covers every published name", () => {
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

  it("the published-name list is exactly the one name this repo owns", () => {
    expect(ROLL_PACKAGE_NAMES).toEqual(["@bipo-ape/roll"]);
  });

  it("promotes once that one name carries the version", () => {
    // The concrete unblock: verify used to fail forever on @seanyao/roll, a name
    // this repo cannot publish.
    const promoted = { called: false };
    const res = verifyRelease(ROLL_PACKAGE_NAMES, "9.9.9", "v9.9.9", seams(["@bipo-ape/roll"], promoted));
    expect(res.ok, res.gaps.join("; ")).toBe(true);
    expect(promoted.called).toBe(true);
  });

  it("still refuses — and names the gap — when the published name lacks the version", () => {
    const promoted = { called: false };
    const res = verifyRelease(ROLL_PACKAGE_NAMES, "9.9.9", "v9.9.9", seams([], promoted));
    expect(res.ok).toBe(false);
    expect(promoted.called).toBe(false);
    expect(res.gaps.join("\n")).toContain("@bipo-ape/roll");
  });

  it("keeps the every-name guarantee for a future added name", () => {
    // The mechanism is retained deliberately: adding a name later must not need a
    // new gate. A second name missing its publish still blocks promotion.
    const promoted = { called: false };
    const twoNames = ["@bipo-ape/roll", "@example/roll"];
    const res = verifyRelease(twoNames, "9.9.9", "v9.9.9", seams(["@bipo-ape/roll"], promoted));
    expect(res.ok).toBe(false);
    expect(promoted.called).toBe(false);
    expect(res.gaps.join("\n")).toContain("@example/roll");
  });
});
