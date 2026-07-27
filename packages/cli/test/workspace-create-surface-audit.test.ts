import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const textExtensions = new Set([".json", ".md", ".mjs", ".sh", ".ts", ".txt", ".yaml", ".yml"]);
const publicRoots = [
  "README.md",
  "README_CN.md",
  "docs",
  "guide",
  "template",
  "packages/spec/src/i18n/catalog-v3.ts",
  "packages/cli/test/fixtures",
] as const;
const runtimeSurfaceRoots = [
  "README.md",
  "README_CN.md",
  "docs",
  "guide",
  "template",
  "skills",
  "packages/cli/src",
  "packages/core/src",
  "packages/infra/src",
  "packages/spec/src",
] as const;
function files(path: string): readonly string[] {
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [path];
  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}

function textFiles(paths: readonly string[]): readonly string[] {
  return paths.flatMap(files).filter((path) => textExtensions.has(extname(path)));
}

describe("US-WS-023 public create-only surface audit", () => {
  it("keeps help, docs, fixtures and templates free of the retired create-entry init language", () => {
    const offenders = textFiles(publicRoots).flatMap((path) => {
      const text = readFileSync(join(repoRoot, path), "utf8");
      return /roll workspace init|roll\.workspace-init\/v1/u.test(text) ? [path] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("records that this repository has no shell-completion source to migrate", () => {
    const completionRoots = ["scripts", "packages/cli/src", "template", "conventions"] as const;
    const completionSources = textFiles(completionRoots).filter((path) => {
      const name = path.split("/").at(-1) ?? "";
      return /^(?:_?roll|completion|completions)\.(?:bash|fish|zsh)$/u.test(name) || /^(?:completion|completions)$/u.test(name);
    });

    expect(completionSources, "No completion generator/source is shipped; help and command registries are the canonical discoverability surfaces.")
      .toEqual([]);
  });

  it("blocks retired init symbols, routes, i18n keys, plan modules and skill identifiers", () => {
    const paths = textFiles(runtimeSurfaceRoots);
    const forbidden = paths.flatMap((path) => {
      const text = readFileSync(join(repoRoot, path), "utf8");
      const reasons = [
        /roll ws init/u.test(text) ? "roll ws init" : null,
        /\bWorkspaceInit[A-Za-z0-9_]*/u.test(text) ? "WorkspaceInit*" : null,
        /\bworkspaceInit[A-Za-z0-9_]*/u.test(text) ? "workspaceInit*" : null,
        /\bWORKSPACE_INIT[A-Za-z0-9_]*/u.test(text) ? "WORKSPACE_INIT*" : null,
        /["'`]workspace\.init\./u.test(text) ? "workspace.init.* i18n key" : null,
        /roll-ws-init/u.test(text) ? "roll-ws-init" : null,
        /workspace\/init-plan|workspace-init\.js/u.test(text) ? "workspace init module" : null,
      ].filter((reason): reason is string => reason !== null);
      return reasons.map((reason) => `${path}: ${reason}`);
    });
    const retiredFiles = paths.filter((path) => path.endsWith("/workspace-init.ts") || path.endsWith("/workspace/init-plan.ts"));
    const router = readFileSync(join(repoRoot, "packages", "cli", "src", "commands", "workspace.ts"), "utf8");

    expect(forbidden).toEqual([]);
    expect(retiredFiles).toEqual([]);
    expect(router).not.toMatch(/subcommand === "init"/u);
    expect(router).not.toContain("legacy_init_subcommand");
  });

  it("keeps legacy schema recognition and correction copy on one narrow allowlist", () => {
    const legacyLines = textFiles(runtimeSurfaceRoots).flatMap((path) => readFileSync(join(repoRoot, path), "utf8")
      .split(/\r?\n/u)
      .map((line, index) => ({ path, line: index + 1, text: line.trim() }))
      .filter((entry) => /roll\.workspace-init\/v1|Legacy Workspace init config|legacy_init_subcommand/u.test(entry.text))
      .map((entry) => `${entry.path}:${entry.text}`));

    expect(legacyLines).toEqual([
      "packages/core/src/workspace/create-plan.ts:if (raw.schema === \"roll.workspace-init/v1\") {",
      "packages/core/src/workspace/create-plan.ts:message: \"Legacy Workspace init config must be converted before create\",",
      "packages/core/src/workspace/create-plan.ts:conversions: [{ path: \"schema\", from: \"roll.workspace-init/v1\", to: WORKSPACE_CREATE_CONFIG_V1 }],",
      "packages/spec/src/i18n/catalog-v3.ts:\"workspace.create.error.legacy_create_config\": { en: \"Legacy Workspace init config must be converted before create\", zh: \"旧版工作区 init 配置必须转换后才能创建\" },",
    ]);
  });

  it("keeps the installed skill gitlink on a create-only route manifest", () => {
    const skillsRoot = join(repoRoot, "skills");
    const routes = JSON.parse(readFileSync(join(skillsRoot, "route-cases", "skills.json"), "utf8")) as {
      readonly skills: Readonly<Record<string, unknown>>;
    };
    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("roll-ws-"))
      .map((entry) => entry.name)
      .sort();

    expect(relative(repoRoot, skillsRoot)).toBe("skills");
    expect(skillNames).toEqual(["roll-ws-create"]);
    expect(routes.skills).toHaveProperty("roll-ws-create");
    expect(routes.skills).not.toHaveProperty("roll-ws-init");
  });
});
