/**
 * @responsibility Installs and manages the repository git hooks.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface GitHookRow {
  name: string;
  descEn: string;
  descZh: string;
  path: string;
}

export interface GitHooksVM {
  hooksPath: string;
  configured: boolean;
  rows: GitHookRow[];
}

export interface GitHooksDeps {
  /** Display path from git config/core hooks resolution. */
  hooksPath: string;
  listHookFiles: () => string[];
  hookPath: (name: string) => string;
}

const HOOK_DESCRIPTIONS: Record<string, { en: string; zh: string }> = {
  "pre-commit": {
    en: "TCR proof gate before commit",
    zh: "提交前 TCR 测试证明闸",
  },
  "prepare-commit-msg": {
    en: "append AI co-author trailer",
    zh: "追加 AI 协作者 trailer",
  },
  "pre-push": {
    en: "local CI gate before push",
    zh: "push 前本地 CI 闸",
  },
  "post-commit": {
    en: "append tcr:committed observation fact",
    zh: "追加 tcr:committed 观测事实",
  },
  "commit-msg": {
    en: "commit message validation",
    zh: "提交信息校验",
  },
};

function activeHookName(name: string): boolean {
  return name !== "" && !name.startsWith(".") && !name.endsWith(".sample");
}

function hookDescription(name: string): { en: string; zh: string } {
  return HOOK_DESCRIPTIONS[name] ?? { en: "custom git hook", zh: "自定义 git 钩子" };
}

export function collectGitHooks(deps: GitHooksDeps): GitHooksVM {
  let names: string[];
  try {
    names = deps.listHookFiles().filter(activeHookName).sort((a, b) => a.localeCompare(b));
  } catch {
    names = [];
  }

  const rows = names.map((name) => {
    const desc = hookDescription(name);
    return {
      name,
      descEn: desc.en,
      descZh: desc.zh,
      path: deps.hookPath(name),
    };
  });

  return {
    hooksPath: deps.hooksPath,
    configured: rows.length > 0,
    rows,
  };
}

function gitOutput(projectPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveHooksPath(projectPath: string): { displayPath: string; fsPath: string } {
  const configured = gitOutput(projectPath, ["config", "core.hooksPath"]);
  if (configured !== "" && configured !== ".git/hooks") {
    return {
      displayPath: configured,
      fsPath: isAbsolute(configured) ? configured : resolve(projectPath, configured),
    };
  }

  const gitPath = gitOutput(projectPath, ["rev-parse", "--git-path", "hooks"]);
  const fsPath = gitPath === "" ? join(projectPath, ".git", "hooks") : isAbsolute(gitPath) ? gitPath : resolve(projectPath, gitPath);
  return {
    displayPath: configured === "" ? ".git/hooks" : configured,
    fsPath,
  };
}

export function defaultGitHooksDeps(projectPath: string): GitHooksDeps {
  const resolved = resolveHooksPath(projectPath);
  return {
    hooksPath: resolved.displayPath,
    listHookFiles: () => readdirSync(resolved.fsPath, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name),
    hookPath: (name) => join(resolved.displayPath, name),
  };
}
