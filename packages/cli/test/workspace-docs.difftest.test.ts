import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { renderMarkdown } from "../src/lib/markdown.js";
import { collectCharter, defaultCharterDeps } from "../src/lib/page-charter.js";
import { stripAnsi } from "../src/render.js";
import { expectNoAdjacentBilingualPairs } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const requiredDocs = [
  "README.md",
  "README_CN.md",
  "guide/en/README.md",
  "guide/zh/README.md",
  "guide/en/workspaces.md",
  "guide/zh/workspaces.md",
  "docs/architecture.md",
  "docs/manifesto.md",
  "docs/verification.md",
] as const;
const helpCommands = ["workspace", "backlog", "loop", "agent", "delivery"] as const;
const envKeys = ["ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"] as const;

function doc(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

async function help(command: typeof helpCommands[number], lang: "en" | "zh"): Promise<string> {
  const saved: Partial<Record<typeof envKeys[number], string>> = {};
  for (const key of envKeys) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["ROLL_LANG"] = lang;
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
  // @ts-expect-error capture-only
  process.stderr.write = (chunk: string | Uint8Array): boolean => (stderr += String(chunk), true);
  try {
    const result = await dispatch([command, "--help"], async () => ({ ok: true }));
    expect(result.status, `${lang} roll ${command} --help`).toBe(0);
    expect(stderr, `${lang} roll ${command} --help stderr`).toBe("");
    return stripAnsi(stdout);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function localLinks(path: string): readonly string[] {
  const links = [...doc(path).matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((target) => target !== "" && !target.startsWith("#") && !/^[a-z]+:/iu.test(target));
  return links.map((target) => target.split("#", 1)[0] ?? "").filter((target) => target !== "");
}

function markdownFiles(path: string): readonly string[] {
  return readdirSync(join(repoRoot, path), { withFileTypes: true }).flatMap((entry) => {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(relative);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  });
}

beforeAll(() => registerAll());

describe("US-WS-021 Workspace-first documentation contract", () => {
  it("publishes paired Workspace guides and reachable navigation", () => {
    for (const path of requiredDocs) expect(existsSync(join(repoRoot, path)), path).toBe(true);

    expect(doc("README.md")).toContain("guide/en/workspaces.md");
    expect(doc("README_CN.md")).toContain("guide/zh/workspaces.md");
    expect(doc("guide/en/README.md")).toContain("workspaces.md");
    expect(doc("guide/zh/README.md")).toContain("workspaces.md");

    for (const path of ["README.md", "README_CN.md", "guide/en/README.md", "guide/zh/README.md", "guide/en/workspaces.md", "guide/zh/workspaces.md"]) {
      for (const target of localLinks(path)) {
        expect(existsSync(resolve(dirname(join(repoRoot, path)), target)), `${path} -> ${target}`).toBe(true);
      }
    }
  });

  it("documents one Workspace-first model without a second delivery entity", () => {
    const en = doc("guide/en/workspaces.md");
    const zh = doc("guide/zh/workspaces.md");

    for (const token of [
      "roll workspace create",
      "--workspace <id|path>",
      "multiple active Workspaces",
      "issues/<storyId>/<repoAlias>/",
      "~/.roll/repos/<repoId>.git",
      "roll delivery",
      "exact merged SHAs",
      "Delivery Set",
      "publish_mode: local",
      "roll workspace migrate",
      ".roll/RELOCATED.json",
      "manual roll-meta handoff",
    ]) expect(en, `guide/en/workspaces.md missing ${token}`).toContain(token);

    for (const token of [
      "roll workspace create",
      "--workspace <ID|路径>",
      "多个 active Workspace",
      "issues/<storyId>/<repoAlias>/",
      "~/.roll/repos/<repoId>.git",
      "roll delivery",
      "精确 merged SHA",
      "Delivery Set",
      "publish_mode: local",
      "roll workspace migrate",
      ".roll/RELOCATED.json",
      "手工 roll-meta 移交",
    ]) expect(zh, `guide/zh/workspaces.md missing ${token}`).toContain(token);

    expect(en).toMatch(/publish_mode: local[\s\S]{0,260}(?:does not|never) (?:push|open).*PR/iu);
    expect(zh).toMatch(/publish_mode: local[\s\S]{0,260}(?:不会|不得).*(?:push|PR)/u);
  });

  it("projects the paired Workspace guide into the generated Charter site view", () => {
    const charter = collectCharter(defaultCharterDeps(repoRoot, renderMarkdown));
    const workspace = charter.groups
      .find((group) => group.key === "guide")
      ?.docs.find((entry) => entry.id === "guide/en/workspaces.md");
    expect(workspace).toBeDefined();
    expect(workspace?.bilingual).toBe(true);
    expect(workspace?.bodyEn).toContain("Workspace-first");
    expect(workspace?.bodyZh).toContain("Workspace");
    expect(workspace?.bodyEn).not.toBe(workspace?.bodyZh);
  });

  it("freezes Workspace-aware command help in one visible language per locale", async () => {
    const captures: Record<string, Record<string, string>> = { en: {}, zh: {} };
    for (const lang of ["en", "zh"] as const) {
      for (const command of helpCommands) {
        const output = await help(command, lang);
        expectNoAdjacentBilingualPairs(output);
        if (lang === "en") expect(output, `roll ${command} --help`).not.toMatch(/[\u3400-\u9fff]/u);
        else expect(output, `roll ${command} --help`).toMatch(/[\u3400-\u9fff]/u);
        captures[lang]![command] = output;
      }
    }
    expect(captures).toMatchSnapshot();
  });

  it("keeps architecture and active invariants aligned with Workspace identity and multi-repo delivery", () => {
    const architecture = doc("docs/architecture.md");
    const manifesto = doc("docs/manifesto.md");
    const verification = doc("docs/verification.md");

    expect(architecture).toContain("10 个 Bounded Context");
    expect(architecture).toContain("Workspace Coordination");
    expect(architecture).toContain("exact-SHA Integration Acceptance");
    expect(architecture).toContain("Repository Cache 是可重建 projection");
    expect(architecture).not.toContain("系统分为 8 个 Bounded Context");
    expect(architecture).not.toContain("同一 Story 至多一个 open PR");
    expect(architecture).not.toContain("路径即身份");

    expect(manifesto).toContain("Workspace ID 是身份");
    expect(manifesto).not.toContain("路径即身份");
    expect(verification).toContain("同一 Issue 的每个 repository target");
    expect(verification).toContain("两个 ID 相近的 Workspace");
    expect(verification).not.toContain("状态互不污染（路径即身份）");
  });

  it("scans active documentation for retired repository-only and singleton assumptions", () => {
    const activeDocs = [
      "README.md",
      "README_CN.md",
      ...markdownFiles("guide/en"),
      ...markdownFiles("guide/zh"),
      ...markdownFiles("docs"),
    ];
    const retiredAssumptions = [
      /one Git repo is a Project/iu,
      /repository is the project/iu,
      /一个 Git repo 就是一个 Project/iu,
      /the global current Workspace is/iu,
      /唯一 current Workspace/iu,
      /同一 Story 至多一个 open PR/iu,
      /路径即身份/iu,
      /系统分为 8 个 Bounded Context/iu,
      /organized into nine Bounded Contexts/iu,
    ];

    for (const path of activeDocs) {
      const content = doc(path);
      for (const pattern of retiredAssumptions) {
        expect(content, `${path} contains retired assumption ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
