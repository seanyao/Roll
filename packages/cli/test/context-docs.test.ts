import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

function doc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const SURFACES = [
  "guide/en/context.md",
  "guide/zh/context.md",
  "guide/en/context-ape-migration.md",
  "guide/zh/context-ape-migration.md",
  "README.md",
  "README_CN.md",
  "docs/architecture.md",
] as const;

describe("US-CONTEXT-010 Context documentation contract", () => {
  it("documents machine registry, Workspace bindings, enablement, transport, and secret-free configuration", () => {
    for (const path of ["guide/en/context.md", "guide/zh/context.md"] as const) {
      const body = doc(path);
      expect(body, path).toContain("~/.roll/context-providers.yaml");
      expect(body, path).toContain("roll.context-providers/v1");
      expect(body, path).toContain("contexts:");
      expect(body, path).toContain("enabled: true");
      expect(body, path).toContain("required: true");
      expect(body, path).toMatch(/optional|可选/u);
      expect(body, path).toMatch(/HTTPS/);
      expect(body, path).toMatch(/SSH/);
      expect(body, path).toMatch(/password|密码/u);
      expect(body, path).toMatch(/token/u);
    }
  });

  it("pins the LLM Wiki layout, Roll frontmatter, scope algebra, identities, and restricted references", () => {
    for (const path of ["guide/en/context.md", "guide/zh/context.md"] as const) {
      const body = doc(path);
      for (const token of ["purpose.md", "schema.md", "raw/sources/", "wiki/index.md", "wiki/log.md", "roll.context-page/v1"]) {
        expect(body, `${path}: ${token}`).toContain(token);
      }
      expect(body, path).toMatch(/same dimension.*OR|同一维度.*OR/isu);
      expect(body, path).toMatch(/different dimensions.*AND|不同维度.*AND/isu);
      expect(body, path).toMatch(/missing.*fail(?:s|ed)?[- ]closed|缺失.*fail(?:s|ed)?[- ]closed/isu);
      expect(body, path).toContain("ssh://gitee.com/example/platform");
      expect(body, path).toContain("https://gitee.com/example/platform");
      expect(body, path).toContain("restricted_reference");
      expect(body, path).toContain("context://");
    }
  });

  it("distinguishes fresh reads from immutable Snapshot reuse and documents reconciliation authority", () => {
    for (const path of ["guide/en/context.md", "guide/zh/context.md"] as const) {
      const body = doc(path);
      expect(body, path).toMatch(/every fresh read.*fetch|每次 fresh read.*fetch/isu);
      expect(body, path).toMatch(/one fetch.*Provider.*read|一次 read.*Provider.*一次 fetch/isu);
      expect(body, path).toMatch(/same commit|同一 commit/isu);
      expect(body, path).toMatch(/no stale fallback|不.*stale.*fallback/isu);
      expect(body, path).toMatch(/Snapshot reuse.*does not fetch|复用 Snapshot.*不.*fetch/isu);
      expect(body, path).toMatch(/new page.*new fresh read|新页面.*新.*fresh read/isu);
      expect(body, path).toContain("continue_with_handoff_snapshot");
      expect(body, path).toContain("adopt_new_snapshot");
      expect(body, path).toContain("needs_reconciliation");
      expect(body, path).toMatch(/system.*developer.*skill.*owner.*Workspace.*tool/isu);
    }
  });

  it("keeps live systems and credentials behind opaque references and dedicated tools", () => {
    for (const path of ["guide/en/context.md", "guide/zh/context.md"] as const) {
      const body = doc(path);
      expect(body, path).toMatch(/DB/);
      expect(body, path).toMatch(/Kubernetes|K8s/u);
      expect(body, path).toMatch(/test account|测试账号/u);
      expect(body, path).toMatch(/mapping/);
      expect(body, path).toMatch(/policy/);
      expect(body, path).toMatch(/credential[_ ]ref/iu);
      expect(body, path).toMatch(/dedicated tool|专用工具/u);
      expect(body, path).toMatch(/opaque/);
    }
  });

  it("maps both APE context stores to ordinary scoped pages without migrating secrets", () => {
    for (const path of ["guide/en/context-ape-migration.md", "guide/zh/context-ape-migration.md"] as const) {
      const body = doc(path);
      expect(body, path).toContain("ape-context");
      expect(body, path).toContain("ape-shared-execution-context");
      expect(body, path).toContain("shared-execution-context:");
      expect(body, path).toMatch(/ordinary.*page|普通.*页面/isu);
      expect(body, path).toMatch(/scope/);
      expect(body, path).toMatch(/credential value|credential.*值/isu);
      expect(body, path).toMatch(/not.*migrat|不迁移/isu);
    }
  });

  it("defines nashsu/llm_wiki as a compatible editor without a GPL runtime dependency", () => {
    for (const path of ["guide/en/context.md", "guide/zh/context.md"] as const) {
      const body = doc(path);
      expect(body, path).toContain("nashsu/llm_wiki");
      expect(body, path).toMatch(/editor|编辑器/u);
      expect(body, path).toMatch(/ingest/);
      expect(body, path).toMatch(/does not require.*Desktop|不依赖.*Desktop/isu);
      expect(body, path).toMatch(/does not require.*MCP|不依赖.*MCP/isu);
      expect(body, path).toMatch(/does not vendor.*GPL|不.*vendoring.*GPL/isu);
      expect(body, path).toMatch(/future Provider.*not.*v1|未来 Provider.*不属于 v1/isu);
    }
  });

  it("links the guides from README and guide indexes and publishes the architecture language", () => {
    expect(doc("README.md")).toContain("guide/en/context.md");
    expect(doc("README_CN.md")).toContain("guide/zh/context.md");
    expect(doc("guide/en/README.md")).toContain("context.md");
    expect(doc("guide/en/README.md")).toContain("context-ape-migration.md");
    expect(doc("guide/zh/README.md")).toContain("context.md");
    expect(doc("guide/zh/README.md")).toContain("context-ape-migration.md");
    expect(doc("guide/INDEX.md")).toContain("guide/en/context.md");
    expect(doc("guide/INDEX.md")).toContain("guide/zh/context.md");
    const architecture = doc("docs/architecture.md");
    expect(architecture).toContain("Context Engineering");
    expect(architecture).toMatch(/Workspace Coordination/);
    expect(architecture).toMatch(/Execution/);
    expect(architecture).toContain("ContextReadSnapshotV1");
  });

  it("keeps active Context docs free of retired freshness and type claims", () => {
    const corpus = SURFACES.map(doc).join("\n");
    for (const retired of [
      /TTL[- ]based freshness/iu,
      /falls back to (the )?(cached|stale)/iu,
      /uses? stale (content|pages?) after fetch failure/iu,
      /shared Context (runtime )?type/iu,
      /repository-only Context/iu,
    ]) {
      expect(corpus).not.toMatch(retired);
    }
  });

  it("keeps relative links in the new guides resolvable", () => {
    for (const path of [
      "guide/en/context.md",
      "guide/zh/context.md",
      "guide/en/context-ape-migration.md",
      "guide/zh/context-ape-migration.md",
    ] as const) {
      const body = doc(path);
      for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const href = match[1];
        if (href === undefined || href.startsWith("http") || href.startsWith("#")) continue;
        const target = href.split("#", 1)[0];
        expect(existsSync(resolve(ROOT, dirname(path), target)), `${path} -> ${href}`).toBe(true);
      }
    }
  });
});
