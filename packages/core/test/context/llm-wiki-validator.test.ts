import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LLM_WIKI_MAX_FILE_BYTES,
  LLM_WIKI_MAX_PAGES,
  LLM_WIKI_MAX_PROVIDER_BYTES,
  planLlmWikiRevisionPaths,
  validateLlmWikiRevision,
  type FixedRevisionBlobFact,
} from "../../src/context/llm-wiki-validator.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(testDirectory, "..", "fixtures", "context", "llm-wiki-compatible");

function blob(path: string, content: string | Uint8Array, mode: FixedRevisionBlobFact["mode"] = "100644"): FixedRevisionBlobFact {
  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
  return { path, objectType: "blob", mode, bytes, content };
}

function page(overrides: readonly string[] = [], body = "# Axis\n\nApproved operational context.\n"): string {
  const lines = [
    "---",
    "schema: roll.context-page/v1",
    "title: Axis system",
    "page_type: system_runbook",
    "status: active",
    "confidence: approved",
    "updated_at: 2026-07-24",
    "scope:",
    "  workspace_ids:",
    "    - roll",
    "  repository_ids: []",
    "  environment_ids:",
    "    - sit",
    "  story_ids: []",
    "  stages:",
    "    - build",
    "sources:",
    "  - raw/sources/axis.md",
    "sensitivity: internal",
    "---",
    body,
  ];
  for (const override of overrides) {
    const separator = override.indexOf(":");
    const key = separator < 0 ? override : override.slice(0, separator + 1);
    const index = lines.findIndex((line) => line.startsWith(key));
    if (index >= 0) lines[index] = override;
    else lines.splice(-2, 0, override);
  }
  return lines.join("\n");
}

function minimumFiles(extra: readonly FixedRevisionBlobFact[] = []): FixedRevisionBlobFact[] {
  return [
    blob("purpose.md", "# Purpose\n"),
    blob("schema.md", "# Schema\n\npage_type is repository-defined.\n"),
    blob("wiki/index.md", "# Index\n\n- [[systems/axis|Axis]] — system context\n"),
    blob("wiki/log.md", "# Log\n"),
    ...extra,
  ];
}

function diagnosticCodes(result: ReturnType<typeof validateLlmWikiRevision>): string[] {
  return result.diagnostics.map((entry) => entry.code);
}

function fixtureFiles(): FixedRevisionBlobFact[] {
  const files: FixedRevisionBlobFact[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(blob(relative(fixtureRoot, absolute).replaceAll("\\", "/"), readFileSync(absolute)));
    }
  };
  visit(fixtureRoot);
  return files;
}

describe("fixed-revision LLM Wiki validation", () => {
  it.each(["purpose.md", "schema.md", "wiki/index.md", "wiki/log.md"])(
    "returns invalid_wiki_layout when %s is missing",
    (missing) => {
      const result = validateLlmWikiRevision({
        providerId: "enterprise-wiki",
        files: minimumFiles().filter((file) => file.path !== missing),
      });
      expect(result.valid).toBe(false);
      expect(result.files).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "invalid_wiki_layout", severity: "blocking", providerId: "enterprise-wiki" }),
      ]);
    },
  );

  it.each([
    "/wiki/axis.md",
    "wiki\\axis.md",
    "wiki//axis.md",
    "wiki/./axis.md",
    "wiki/../axis.md",
    "wiki/axis\0.md",
    "wiki/.private/axis.md",
    "wiki/credentials/axis.md",
    ".git/config",
    ".llm-wiki/state.json",
    ".obsidian/workspace.json",
    "raw/sources/axis.md",
    "wiki/systems/axis.json",
    "wiki/systems/axis",
  ])("rejects unsafe or non-readable path %s", (path) => {
    const result = validateLlmWikiRevision({ providerId: "enterprise-wiki", files: minimumFiles([blob(path, page())]) });
    expect(result.valid).toBe(false);
    expect(diagnosticCodes(result)).toContain("invalid_context_ref");
    expect(JSON.stringify(result.diagnostics)).not.toContain(path);
  });

  it("rejects Git symlinks without returning their target", () => {
    const result = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      files: minimumFiles([blob("wiki/systems/axis.md", "../../credentials/token", "120000")]),
    });
    expect(result.valid).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "context_symlink_rejected", message: "Git symlink is not readable Context content" }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("credentials/token");
  });

  it("keeps entrypoints in the same stable read set when explicit refs are requested", () => {
    expect(planLlmWikiRevisionPaths(
      ["wiki/index.md", "wiki/overview.md", "wiki/index.md"],
      ["wiki/systems/axis.md", "wiki/overview.md"],
    )).toEqual([
      "purpose.md",
      "schema.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/overview.md",
      "wiki/systems/axis.md",
    ]);
  });

  it("rejects unsafe requested paths and reports missing custom entrypoints from the fixed revision", () => {
    expect(diagnosticCodes(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["../wiki/systems/axis.md"],
      files: minimumFiles(),
    }))).toEqual(["invalid_context_ref"]);
    expect(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      entrypoints: ["wiki/index.md", "wiki/overview.md"],
      files: minimumFiles(),
    }).diagnostics).toEqual([
      expect.objectContaining({
        code: "context_file_missing",
        ref: "context://enterprise-wiki/wiki/overview.md",
      }),
    ]);
  });

  it("fails closed when the transport supplies a safe but unplanned Wiki page", () => {
    const result = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      files: minimumFiles([blob("wiki/systems/unrequested.md", page())]),
    });
    expect(result).toMatchObject({
      valid: false,
      files: [],
      diagnostics: [expect.objectContaining({ code: "invalid_context_ref" })],
    });
  });

  it("treats purpose, schema, index and log as special pages while parsing ordinary page metadata", () => {
    const result = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      entrypoints: ["wiki/index.md", "wiki/overview.md"],
      refs: ["wiki/systems/axis.md"],
      files: minimumFiles([
        blob("wiki/overview.md", page(["page_type: architecture_landscape"])),
        blob("wiki/systems/axis.md", page()),
      ]),
    });
    expect(result.valid).toBe(true);
    expect(result.paths).toEqual([
      "purpose.md",
      "schema.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/overview.md",
      "wiki/systems/axis.md",
    ]);
    expect(result.files.slice(0, 4).every((file) => file.page === undefined)).toBe(true);
    expect(result.files[4]?.page?.page_type).toBe("architecture_landscape");
    expect(result.files[5]?.page).toMatchObject({
      schema: "roll.context-page/v1",
      title: "Axis system",
      page_type: "system_runbook",
      status: "active",
      confidence: "approved",
      updated_at: "2026-07-24",
      scope: { workspace_ids: ["roll"], environment_ids: ["sit"], stages: ["build"] },
      sources: ["raw/sources/axis.md"],
      sensitivity: "internal",
    });
  });

  it("ignores nashsu editor fields while preserving required Roll metadata and quoted list values", () => {
    const content = page([
      "type: entity",
      "tags: [context, \"Roll, agent harness\"]",
      "related: [\"systems/sample\", 'Runbook, shared']",
      "created: 2026-07-01",
      "updated: 2026-07-24",
    ]).replace(
      "sources:\n  - raw/sources/axis.md",
      "sources: [\"raw/sources/axis.md\", \"wiki/references/Q1, revised.md\"]",
    );
    const result = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["wiki/systems/axis.md"],
      files: minimumFiles([blob("wiki/systems/axis.md", content)]),
    });

    expect(result.valid).toBe(true);
    expect(result.files.at(-1)?.page).toMatchObject({
      schema: "roll.context-page/v1",
      page_type: "system_runbook",
      sources: ["raw/sources/axis.md", "wiki/references/Q1, revised.md"],
    });
  });

  it.each([
    ["missing delimiter", "# no frontmatter"],
    ["missing field", page(["sensitivity:"])],
    ["wrong schema", page(["schema: roll.context-page/v2"])],
    ["invalid status", page(["status: archived"])],
    ["invalid confidence", page(["confidence: certain"])],
    ["invalid date", page(["updated_at: 2026-02-30"])],
    ["sources is not an array", page().replace("sources:\n  - raw/sources/axis.md", "sources:")],
    ["scope is not an object", page().replace(/scope:\n(?: {2,}.*\n)+sources:/u, "scope:\nsources:")],
    ["invalid scope stage", page().replace("    - build", "    - deploy")],
    ["unsafe source", page().replace("  - raw/sources/axis.md", "  - ../credentials/token")],
    ["nashsu fields cannot replace Roll safety metadata", [
      "---",
      "type: entity",
      "title: Axis system",
      "tags: [context]",
      "related: []",
      "created: 2026-07-01",
      "updated: 2026-07-24",
      "---",
      "# Axis",
    ].join("\n")],
  ])("returns stable invalid_page_frontmatter for %s", (_label, content) => {
    const result = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["wiki/systems/axis.md"],
      files: minimumFiles([blob("wiki/systems/axis.md", content)]),
    });
    expect(result.valid).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_page_frontmatter",
        severity: "blocking",
        providerId: "enterprise-wiki",
        ref: "context://enterprise-wiki/wiki/systems/axis.md",
        message: "Context page frontmatter is invalid",
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(content);
  });

  it("allows restricted_reference pages only when their body contains opaque references", () => {
    const allowed = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["wiki/data-surfaces/db-access.md"],
      files: minimumFiles([blob(
        "wiki/data-surfaces/db-access.md",
        page(
          ["sensitivity: restricted_reference"],
          "- vault://team/db/axis-sit\n- secret://team/api/signing-key\n- secret-ref:axis-test-account\n- credential-ref:axis-sit-db\n",
        ),
      )]),
    });
    expect(allowed.valid).toBe(true);

    for (const body of [
      "password=hunter2\n",
      "password:hunter2\n",
      "token:plain-text-token\n",
      "secret:plain-text-secret\n",
      "custom-ref:not-an-approved-reference\n",
      "postgres://axis:plain-text-secret@db.internal/reporting\n",
      "-----BEGIN PRIVATE KEY-----\nvalue\n",
      "Use account alice with token ghp_abcdefghijklmnopqrstuvwxyz123456\n",
    ]) {
      const denied = validateLlmWikiRevision({
        providerId: "enterprise-wiki",
        refs: ["wiki/data-surfaces/db-access.md"],
        files: minimumFiles([blob(
          "wiki/data-surfaces/db-access.md",
          page(["sensitivity: restricted_reference"], body),
        )]),
      });
      expect(denied.valid).toBe(false);
      expect(denied.diagnostics).toEqual([
        expect.objectContaining({ code: "invalid_page_frontmatter", message: "Restricted Context page must contain opaque references only" }),
      ]);
      expect(JSON.stringify(denied.diagnostics)).not.toContain(body.trim());
    }
  });

  it("enforces declared and decoded single-file limits before exposing content", () => {
    const oversizedDeclared = {
      ...blob("wiki/systems/axis.md", page()),
      bytes: LLM_WIKI_MAX_FILE_BYTES + 1,
    } satisfies FixedRevisionBlobFact;
    expect(diagnosticCodes(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: [oversizedDeclared.path],
      files: minimumFiles([oversizedDeclared]),
    }))).toEqual(["context_file_too_large"]);

    const oversizedActual = {
      ...blob("wiki/systems/axis.md", page([], "x".repeat(LLM_WIKI_MAX_FILE_BYTES))),
      bytes: 1,
    } satisfies FixedRevisionBlobFact;
    expect(diagnosticCodes(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: [oversizedActual.path],
      files: minimumFiles([oversizedActual]),
    }))).toEqual(["context_file_too_large"]);
  });

  it("enforces 32-page and 2 MiB Provider budgets using declared and decoded bytes", () => {
    const tooMany = Array.from({ length: LLM_WIKI_MAX_PAGES - 3 }, (_, index) =>
      blob(`wiki/concepts/page-${index}.md`, page([`title: Page ${index}`])),
    );
    expect(minimumFiles(tooMany)).toHaveLength(LLM_WIKI_MAX_PAGES + 1);
    expect(diagnosticCodes(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: tooMany.map((file) => file.path),
      files: minimumFiles(tooMany),
    })))
      .toEqual(["context_budget_exceeded"]);

    const declaredBudget = Array.from({ length: 9 }, (_, index) => ({
      ...blob(`wiki/systems/declared-${index}.md`, page([`title: Declared ${index}`])),
      bytes: LLM_WIKI_MAX_FILE_BYTES,
    } satisfies FixedRevisionBlobFact));
    expect(diagnosticCodes(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: declaredBudget.map((file) => file.path),
      files: minimumFiles(declaredBudget),
    }))).toEqual(["context_budget_exceeded"]);

    const actualBudget = Array.from({ length: 9 }, (_, index) => ({
      ...blob(
        `wiki/systems/actual-${index}.md`,
        page([`title: Actual ${index}`], "x".repeat(240 * 1024)),
      ),
      bytes: 1,
    } satisfies FixedRevisionBlobFact));
    expect(diagnosticCodes(validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: actualBudget.map((file) => file.path),
      files: minimumFiles(actualBudget),
    }))).toEqual(["context_budget_exceeded"]);
  });

  it("rejects invalid UTF-8 and normalizes CRLF/LF before reproducible bytes and SHA-256", () => {
    const invalid = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["wiki/systems/axis.md"],
      files: minimumFiles([blob("wiki/systems/axis.md", new Uint8Array([0xc3, 0x28]))]),
    });
    expect(diagnosticCodes(invalid)).toEqual(["invalid_page_frontmatter"]);

    const lf = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["wiki/systems/axis.md"],
      files: minimumFiles([blob("wiki/systems/axis.md", page())]),
    });
    const crlf = validateLlmWikiRevision({
      providerId: "enterprise-wiki",
      refs: ["wiki/systems/axis.md"],
      files: minimumFiles([blob("wiki/systems/axis.md", page().replaceAll("\n", "\r\n"))]),
    });
    expect(crlf.valid).toBe(true);
    expect(crlf.files.at(-1)).toEqual(lf.files.at(-1));
    expect(crlf.files.at(-1)?.content).not.toContain("\r");
    expect(crlf.files.at(-1)?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(crlf.files.at(-1)?.bytes).toBe(Buffer.byteLength(page(), "utf8"));
  });

  it("accepts an independently-authored nashsu-compatible file protocol fixture", () => {
    const allFixtureFiles = fixtureFiles();
    const readable = allFixtureFiles.filter((file) => file.path === "purpose.md" || file.path === "schema.md" || file.path.startsWith("wiki/"));
    const result = validateLlmWikiRevision({
      providerId: "compatible-wiki",
      entrypoints: ["wiki/index.md", "wiki/overview.md"],
      refs: ["wiki/systems/sample.md"],
      files: readable,
    });
    expect(result.valid).toBe(true);
    expect(result.files.at(-1)?.page).toMatchObject({
      schema: "roll.context-page/v1",
      page_type: "system",
      sources: ["raw/sources/sample-source.md", "wiki/references/Q1, revised.md"],
    });
    expect(allFixtureFiles.map((file) => file.path)).toContain("raw/sources/sample-source.md");
    expect(result.files.map((file) => file.path)).not.toContain("raw/sources/sample-source.md");
  });

  it("is synchronous core logic with no Git, filesystem, cwd, network or process execution boundary", () => {
    const source = ["context-ref.ts", "page-metadata.ts", "llm-wiki-validator.ts"]
      .map((file) => readFileSync(join(testDirectory, "..", "..", "src", "context", file), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/node:(?:fs|child_process|http|https|net)|process\.cwd|\b(?:execFile|execSync|spawn|spawnSync|fetch)\s*\(/u);
    expect(validateLlmWikiRevision({ providerId: "enterprise-wiki", files: minimumFiles() })).not.toBeInstanceOf(Promise);
  });

  it("keeps the compatibility fixture independent and adds no GPL implementation dependency", () => {
    const fixtureText = fixtureFiles().map((file) =>
      typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content)
    ).join("\n");
    const packageText = readFileSync(join(testDirectory, "..", "..", "package.json"), "utf8");
    expect(fixtureText).toContain("Independently authored minimal compatibility fixture");
    expect(fixtureText).not.toMatch(/GNU GENERAL PUBLIC LICENSE|Copyright \(c\).*nashsu/iu);
    expect(packageText).not.toMatch(/llm[_-]wiki|nashsu/iu);
  });
});
