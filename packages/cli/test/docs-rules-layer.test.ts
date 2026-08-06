/**
 * US-RULE-015 — the rules-layer documentation refresh lock.
 *
 * Locks the doc surfaces touched by the expanded rules layer: README (EN/ZH),
 * docs/verification, docs/architecture, and the guide testing pages (EN/ZH)
 * must describe the v2 registry (`policy/rules.yaml`), the audited inventory
 * coverage predicate (`policy/rules-inventory.yaml`), and the US-RULE-006
 * trusted-owner Hold — with no dead v1 invariant provenance, no
 * hand-written-I1–I12 provenance, and no keyword-search completeness claim.
 *
 * Content/link test only: reads the real tracked files, no fixtures, no engine
 * spawn (same pattern as readme-commands.test.ts / docs-role-taxonomy.test.ts).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

function doc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Whitespace-normalized prose (collapses line wraps) for phrase matching. */
function prose(path: string): string {
  return doc(path).replace(/\s+/g, " ");
}

describe("US-RULE-015 — rules-layer doc refresh", () => {
  it("no dead v1 invariant provenance in verification/architecture docs", () => {
    const verification = doc("docs/verification.md");
    const architecture = doc("docs/architecture.md");

    expect(verification).not.toContain("01-system");
    expect(architecture).not.toContain("specs/harness-principles");

    expect(verification).toContain("policy/rules.yaml");
    expect(verification).toContain("gen-rule-projections.mjs");
    expect(architecture).toContain("policy/rules.yaml");
    expect(architecture).toContain("gen-rule-projections.mjs");
  });

  it("coverage is the inventory predicate, never keyword-search completeness", () => {
    const surfaces = [
      ["README.md", prose("README.md")],
      ["README_CN.md", prose("README_CN.md")],
      ["guide/en/testing.md", prose("guide/en/testing.md")],
      ["guide/zh/testing.md", prose("guide/zh/testing.md")],
    ] as const;

    for (const [name, body] of surfaces) {
      expect(body, `${name} must name the inventory coverage predicate`).toContain("rules-inventory.yaml");
      // completeness-negation phrase: EN "not/never a keyword-search", ZH 关键字搜索式完备性
      expect(body, `${name} must negate keyword-search completeness`).toMatch(
        /(?:not|never) a keyword-search|关键字搜索式完备性/,
      );
    }
  });

  it("coverage never claims keyword-search completeness on any touched surface", () => {
    const surfaces = [
      ["README.md", prose("README.md"), /(?:not|never)\b/],
      ["README_CN.md", prose("README_CN.md"), /绝非|不是|不等于|并不/],
      ["guide/en/testing.md", prose("guide/en/testing.md"), /(?:not|never)\b/],
      ["guide/zh/testing.md", prose("guide/zh/testing.md"), /绝非|不是|不等于|并不/],
    ] as const;

    for (const [name, body, negator] of surfaces) {
      const mentions = [...body.matchAll(/keyword-search|关键字搜索/g)];
      expect(mentions.length, `${name} must mention keyword-search to negate it`).toBeGreaterThan(0);
      for (const m of mentions) {
        const before = body.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
        expect(before, `${name}: keyword-search mention must be negated`).toMatch(negator);
      }
    }
  });

  it("US-RULE-006 trusted-owner Hold is stated and not presented as enabled", () => {
    const surfaces = [
      ["README.md", doc("README.md"), /trusted owner/, /not enabled/],
      ["README_CN.md", doc("README_CN.md"), /可信 owner/, /尚未启用|未启用/],
      ["guide/en/testing.md", doc("guide/en/testing.md"), /trusted owner/, /not enabled/],
      ["guide/zh/testing.md", doc("guide/zh/testing.md"), /可信 owner/, /尚未启用|未启用/],
    ] as const;

    for (const [name, body, owner, notEnabled] of surfaces) {
      expect(body, `${name} must reference the US-RULE-006 Hold card`).toContain("US-RULE-006");
      expect(body, `${name} must state Hold (or the ZH Hold-equivalent)`).toMatch(/Hold|🚫\s*Hold/);
      expect(body, `${name} must carry trusted-owner phrasing`).toMatch(owner);
      expect(body, `${name} must present hard mode as NOT enabled`).toMatch(notEnabled);
    }
  });

  it("EN/ZH pairs carry the same claim set (inventory + Hold + soft/advisory)", () => {
    const pairs = [
      ["README.md", "README_CN.md"],
      ["guide/en/testing.md", "guide/zh/testing.md"],
    ] as const;

    for (const [enPath, zhPath] of pairs) {
      const en = prose(enPath);
      const zh = prose(zhPath);

      // inventory predicate
      expect(en, `${enPath} names the inventory predicate`).toContain("rules-inventory.yaml");
      expect(zh, `${zhPath} names the inventory predicate`).toContain("rules-inventory.yaml");
      expect(en, `${enPath} negates completeness`).toMatch(/(?:not|never) a keyword-search|keyword-search/);
      expect(zh, `${zhPath} negates completeness`).toMatch(/关键字搜索/);

      // Hold card
      expect(en, `${enPath} states US-RULE-006 Hold`).toMatch(/US-RULE-006[\s\S]{0,200}Hold/);
      expect(zh, `${zhPath} states US-RULE-006 Hold`).toMatch(/US-RULE-006[\s\S]{0,200}Hold/);
      expect(en, `${enPath} states trusted-owner gating`).toMatch(/trusted owner/);
      expect(zh, `${zhPath} states trusted-owner gating`).toMatch(/可信 owner/);

      // soft doc-drift + advisory boundary
      expect(en, `${enPath} states soft doc-drift`).toContain("doc_drift: soft");
      expect(zh, `${zhPath} states soft doc-drift`).toContain("doc_drift: soft");
      expect(en, `${enPath} states the advisory boundary`).toMatch(/advisory/);
      expect(zh, `${zhPath} states the advisory boundary`).toMatch(/advisory/);
    }
  });

  it("generated invariant sentinel regions stay byte-intact", () => {
    const surfaces = [
      ["verification", "docs/verification.md"],
      ["architecture", "docs/architecture.md"],
    ] as const;

    for (const [surface, path] of surfaces) {
      const body = doc(path);
      const start = `<!-- ROLL-INVARIANTS:${surface}:start -->`;
      const end = `<!-- ROLL-INVARIANTS:${surface}:end -->`;
      expect(body, `${path} must contain the ${surface} start sentinel`).toContain(start);
      expect(body, `${path} must contain the ${surface} end sentinel`).toContain(end);
      expect(body.split(start).length - 1, `${path} must have exactly one ${surface} start sentinel`).toBe(1);
      expect(body.split(end).length - 1, `${path} must have exactly one ${surface} end sentinel`).toBe(1);
    }
  });
});
