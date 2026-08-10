import { describe, expect, it } from "vitest";
import {
  computeNextSemver,
  computeNextVersion,
  INITIAL_SEMVER,
  parseSemver,
  parseVersion,
  planRelease,
  resolveVersionScheme,
} from "../src/release/plan.js";

describe("parseVersion", () => {
  it("parses the 3.<MMDD>.<seq> calver shape", () => {
    expect(parseVersion("3.606.2")).toEqual({ major: 3, mid: 606, seq: 2 });
    expect(parseVersion("3.1205.1")).toEqual({ major: 3, mid: 1205, seq: 1 });
  });

  it("returns null for a non-conforming version", () => {
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("3.606")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("computeNextVersion", () => {
  it("bumps the seq when releasing again the same day", () => {
    expect(computeNextVersion("3.606.2", { year: 2026, month: 6, day: 6 })).toBe("3.606.3");
  });

  it("resets the seq to 1 on a new day", () => {
    expect(computeNextVersion("3.605.4", { year: 2026, month: 6, day: 6 })).toBe("3.606.1");
  });

  it("zero-pads the day into the middle segment (MMDD)", () => {
    expect(computeNextVersion("3.605.1", { year: 2026, month: 12, day: 5 })).toBe("3.1205.1");
    expect(computeNextVersion("3.605.1", { year: 2026, month: 6, day: 9 })).toBe("3.609.1");
  });

  it("preserves the current major when bumping", () => {
    expect(computeNextVersion("4.101.7", { year: 2026, month: 1, day: 1 })).toBe("4.101.8");
  });

  it("falls back to seq 1 on today when the current version is malformed", () => {
    expect(computeNextVersion("garbage", { year: 2026, month: 6, day: 6 })).toBe("3.606.1");
  });
});

describe("planRelease", () => {
  it("derives the tag, echoes current, and reflects changelog readiness", () => {
    const plan = planRelease({
      currentVersion: "3.606.2",
      date: { year: 2026, month: 6, day: 6 },
      changelogReady: true,
    });
    expect(plan.currentVersion).toBe("3.606.2");
    expect(plan.nextVersion).toBe("3.606.3");
    expect(plan.tag).toBe("v3.606.3");
    expect(plan.changelogReady).toBe(true);
  });

  it("marks changelog not ready when there is nothing under Unreleased", () => {
    const plan = planRelease({
      currentVersion: "3.606.2",
      date: { year: 2026, month: 6, day: 6 },
      changelogReady: false,
    });
    expect(plan.changelogReady).toBe(false);
  });
});

// FIX-1247: version must anchor to the target project's own semver lineage, not
// roll's calver build number. Only roll's own package uses calver.
describe("resolveVersionScheme", () => {
  it("uses calver ONLY for roll's own package", () => {
    // FIX-1493: @seanyao/roll is this repo's only own package.
    expect(resolveVersionScheme("@seanyao/roll")).toBe("calver");
    expect(resolveVersionScheme("@example/roll")).toBe("semver");
  });

  it("uses semver for every other (target/user) project", () => {
    expect(resolveVersionScheme("intel-radar")).toBe("semver");
    expect(resolveVersionScheme("@acme/widget")).toBe("semver");
    expect(resolveVersionScheme("")).toBe("semver");
    expect(resolveVersionScheme(null)).toBe("semver");
    expect(resolveVersionScheme(undefined)).toBe("semver");
  });
});

describe("parseSemver", () => {
  it("parses a <major>.<minor>.<patch> triple", () => {
    expect(parseSemver("1.4.2")).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(parseSemver("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
  });

  it("returns null for a non-conforming version", () => {
    expect(parseSemver("1.4")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("computeNextSemver", () => {
  it("bumps the patch of the project's own lineage", () => {
    expect(computeNextSemver("0.1.0")).toBe("0.1.1");
    expect(computeNextSemver("1.4.2")).toBe("1.4.3");
    expect(computeNextSemver("2.0.9")).toBe("2.0.10");
  });

  it("gives the sensible initial value on first release (no lineage)", () => {
    expect(computeNextSemver("0.0.0")).toBe(INITIAL_SEMVER); // npm-init default
    expect(computeNextSemver("")).toBe(INITIAL_SEMVER);
    expect(computeNextSemver("garbage")).toBe(INITIAL_SEMVER);
  });

  it("never leaks roll's calendar into a target version", () => {
    // The whole point of FIX-1247: no MMDD, no roll build number.
    expect(computeNextSemver("0.1.0")).not.toContain("713");
  });
});

describe("computeNextVersion — scheme aware", () => {
  it("defaults to calver (roll's own path) for back-compat", () => {
    expect(computeNextVersion("3.606.2", { year: 2026, month: 6, day: 6 })).toBe("3.606.3");
  });

  it("under semver ignores the date and bumps the project's lineage", () => {
    // A target project released on July 13 must NOT become 0.713.1.
    expect(computeNextVersion("0.1.0", { year: 2026, month: 7, day: 13 }, "semver")).toBe("0.1.1");
    expect(computeNextVersion("0.0.0", { year: 2026, month: 7, day: 13 }, "semver")).toBe("0.1.0");
  });
});

describe("planRelease — target project (semver) vs roll (calver)", () => {
  it("REPRO FIX-1247: a target project's first release anchors to 0.1.0, not roll's build number", () => {
    // intel-radar, fresh package.json (0.0.0), released the same day roll's own
    // build number is 4.713.x. Before the fix this produced 0.713.1 / 4.713.1.
    const plan = planRelease({
      currentVersion: "0.0.0",
      date: { year: 2026, month: 7, day: 13 },
      changelogReady: true,
      scheme: "semver",
    });
    expect(plan.nextVersion).toBe("0.1.0");
    expect(plan.tag).toBe("v0.1.0");
    expect(plan.nextVersion).not.toContain("713");
    expect(plan.nextVersion).not.toBe("4.713.1");
  });

  it("a target project with a version lineage bumps its own patch", () => {
    const plan = planRelease({
      currentVersion: "1.2.3",
      date: { year: 2026, month: 7, day: 13 },
      changelogReady: true,
      scheme: "semver",
    });
    expect(plan.nextVersion).toBe("1.2.4");
    expect(plan.tag).toBe("v1.2.4");
  });

  it("roll's own release path is unaffected — still calver", () => {
    const plan = planRelease({
      currentVersion: "4.713.1",
      date: { year: 2026, month: 7, day: 13 },
      changelogReady: true,
      scheme: "calver",
    });
    expect(plan.nextVersion).toBe("4.713.2");
    expect(plan.tag).toBe("v4.713.2");
  });
});
