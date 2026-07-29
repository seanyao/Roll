/**
 * FIX-1480 — verifyRelease: npm is the truth source; promote the draft GitHub
 * Release only when git tag + npm version + npm dist-tags.latest + draft release
 * ALL agree. Any gap fails loud and never promotes.
 */
import { describe, expect, it, vi } from "vitest";
import { releaseTagForVersion, verifyRelease, type ReleaseVerifySeams } from "../src/index.js";

const PKG = "@seanyao/roll";
const VERSION = "4.724.1";
const TAG = "v4.724.1";

/** All-green seams; override per test. `promoteRelease` is a spy. */
function seams(over: Partial<ReleaseVerifySeams> = {}): ReleaseVerifySeams {
  return {
    tagExists: () => true,
    npmHasVersion: () => true,
    npmLatest: () => VERSION,
    getRelease: () => ({ isDraft: true }),
    promoteRelease: vi.fn(),
    ...over,
  };
}

describe("verifyRelease (FIX-1480)", () => {
  it("promotes the draft when tag + npm version + latest + draft all agree", () => {
    const s = seams();
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(true);
    expect(r.promoted).toBe(true);
    expect(r.gaps).toEqual([]);
    expect(s.promoteRelease).toHaveBeenCalledWith(TAG);
  });

  it("fails loud and does NOT promote when npm lacks the version", () => {
    const s = seams({ npmHasVersion: () => false, promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(false);
    expect(r.promoted).toBe(false);
    expect(r.gaps.join(" ")).toContain("npm has no");
    expect(s.promoteRelease).not.toHaveBeenCalled();
  });

  it("fails loud when npm dist-tags.latest is behind the version", () => {
    const s = seams({ npmLatest: () => "4.700.0", promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(false);
    expect(r.gaps.join(" ")).toContain("dist-tags.latest");
    expect(s.promoteRelease).not.toHaveBeenCalled();
  });

  it("fails loud when the git tag is missing", () => {
    const s = seams({ tagExists: () => false, promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(false);
    expect(r.gaps.join(" ")).toContain(`git tag ${TAG}`);
    expect(s.promoteRelease).not.toHaveBeenCalled();
  });

  it("fails loud when no draft GitHub Release exists", () => {
    const s = seams({ getRelease: () => undefined, promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(false);
    expect(r.gaps.join(" ")).toContain("no GitHub Release");
    expect(s.promoteRelease).not.toHaveBeenCalled();
  });

  it("ordering invariant: multiple gaps → all reported, promote never called", () => {
    const s = seams({ tagExists: () => false, npmHasVersion: () => false, promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(false);
    expect(r.gaps.length).toBeGreaterThanOrEqual(2);
    expect(s.promoteRelease).not.toHaveBeenCalled();
  });

  it("idempotent: an already-promoted (non-draft) release is ok with promoted:false", () => {
    const s = seams({ getRelease: () => ({ isDraft: false }), promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s);
    expect(r.ok).toBe(true);
    expect(r.promoted).toBe(false);
    expect(s.promoteRelease).not.toHaveBeenCalled();
  });

  it("requireLatest:false skips the dist-tags check (non-latest publish)", () => {
    const s = seams({ npmLatest: () => "9.9.9", promoteRelease: vi.fn() });
    const r = verifyRelease(PKG, VERSION, TAG, s, { requireLatest: false });
    expect(r.ok).toBe(true);
    expect(r.promoted).toBe(true);
  });

  it("releaseTagForVersion prefixes v once", () => {
    expect(releaseTagForVersion("4.724.1")).toBe("v4.724.1");
    expect(releaseTagForVersion("v4.724.1")).toBe("v4.724.1");
  });
});
