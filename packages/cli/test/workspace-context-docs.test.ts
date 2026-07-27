import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

async function captureHelp(args: string[], lang: "en" | "zh") {
  const previous = process.env["ROLL_LANG"];
  process.env["ROLL_LANG"] = lang;
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (text: string): boolean => ((stdout += String(text)), true);
  // @ts-expect-error test capture
  process.stderr.write = (text: string): boolean => ((stderr += String(text)), true);
  try {
    registerAll();
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    if (previous === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = previous;
  }
}

describe("US-WS-041 Workspace context documentation closure", () => {
  it.each([
    ["guide/en/workspaces.md", ["roll ws", "--ws", "metadata edit", "requirement", "roll-.clarify", "machine_only", "legacy_migration_only", "context consumer", "workspace-context-compatibility-matrix"]],
    ["guide/zh/workspaces.md", ["roll ws", "--ws", "metadata edit", "requirement", "roll-.clarify", "machine_only", "legacy_migration_only", "context consumer", "workspace-context-compatibility-matrix"]],
  ])("documents the complete user contract in %s", (path, required) => {
    const text = read(path);
    for (const marker of required) expect(text, marker).toContain(marker);
    expect(text).not.toContain("roll workspace init");
  });

  it("links the guide and generated matrix from README", () => {
    const readme = read("README.md");
    expect(readme).toContain("guide/en/workspaces.md");
    expect(readme).toContain("guide/zh/workspaces.md");
    expect(readme).toContain("docs/generated/workspace-context-compatibility-matrix.json");
    expect(readme).toContain("docs/generated/workspace-context-validation-cases.json");
  });

  it("keeps alias help discoverable while canonical usage stays primary in both locales", async () => {
    for (const lang of ["en", "zh"] as const) {
      const canonical = await captureHelp(["workspace", "--help"], lang);
      const alias = await captureHelp(["ws", "--help"], lang);
      const transcript = read(`packages/cli/test/fixtures/workspace/us-ws-041-terminal-evidence/workspace-help.${lang}.txt`);
      expect(canonical.status).toBe(0);
      expect(alias.status).toBe(0);
      expect(alias).toEqual(canonical);
      expect(canonical.stdout).toBe(transcript);
      expect(alias.stdout).toContain("roll workspace");
      expect(alias.stdout).toContain("roll ws");
      expect(alias.stdout).toContain("--ws");
      expect(alias.stdout).not.toContain("Usage: roll ws create");
    }
  });

  it("keeps adjacent backlog docs free of the retired single-active shortcut", () => {
    expect(read("guide/en/backlog-github-sync.md")).not.toContain("or the single active Workspace");
    expect(read("guide/zh/backlog-github-sync.md")).not.toContain("唯一 active\n工作区解析目标");
    expect(read("README.md")).not.toContain("roll workspace <init");
  });
});
