import { dreamRunOnceCommand } from "./dream-run-once.js";
import { ROLL_REPO_SLUG } from "@roll/core";
import { rollVersion } from "./version.js";

export type DreamRunOnce = (args: string[]) => number | Promise<number>;

const WIDTH = 100;
const HR = "─".repeat(WIDTH);

const AUTONOMY: ReadonlyArray<readonly [string, string, string, string, boolean]> = [
  ["loop", "<on|off|now|status|…>", "manage the autonomous BACKLOG executor", "管理自主执行循环", true],
  ["brief", "", "show latest owner brief", "查看最新简报", true],
  ["backlog", "[block|defer|…]", "view and manage pending tasks", "查看和管理待处理任务", true],
  ["peer", "", "cross-agent negotiation & review", "跨 Agent 协商对审", false],
  ["alert", "", "view and clear loop alerts", "查看 / 清除 loop 告警", false],
];

const PROJECT: ReadonlyArray<readonly [string, string, string, string, boolean]> = [
  ["init", "", "create AGENTS.md + .roll/backlog.md + .roll/features/", "初始化项目工作流文件", false],
  ["status", "", "show current state and drift", "显示当前状态和漂移项", false],
  ["agent", "[use <name>]", "per-project agent selection", "切换项目 agent", false],
  ["ci", "[--wait]", "show or wait for current commit's CI status", "查看 / 等待 CI 状态", false],
  ["release", "", "run the release script (human-only)", "执行发版脚本（仅人工）", false],
  ["review-pr", "<number>", "AI-powered code review for a PR", "AI 代码评审", false],
  // REFACTOR-049: `lang` moved to `roll config lang <x>`; kept as config sub-command.
  ["config", "[<key> [<value>]]", "read or write roll config keys", "读取或写入配置项", false],
];

const MACHINE: ReadonlyArray<readonly [string, string, string, string, boolean]> = [
  ["setup", "[-f]", "first-time install or re-sync", "首次安装或重新同步", false],
  ["update", "", "upgrade to latest + re-sync", "升级到最新版并重新同步", false],
  // REFACTOR-049: `version` downgraded to `roll --version` / `-v` flag.
];

const EXAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["roll --version", "显示已安装版本"],
  ["roll loop go", "在本会话里推进 backlog"],
  ["roll backlog defer US-DOC '过早引入'", "推迟一类任务"],
  ["roll agent migrate --dry-run", "预览 legacy agent 配置迁移"],
  ["roll config lang zh", "设置语言为中文 (REFACTOR-049: `roll lang` 已移入 config)"],
];

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    width += code !== undefined && isWide(code) ? 2 : 1;
  }
  return width;
}

function row(left: string, right: string): string {
  const gap = Math.max(1, WIDTH - displayWidth(left) - displayWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function sectionHead(en: string, zh: string, hint: string): string {
  return row(`  ${en}  ·  ${zh}`, hint);
}

function cmdBlock(entries: ReadonlyArray<readonly [string, string, string, string, boolean]>): string[] {
  const out: string[] = [];
  for (const [name, args, enDesc, zhDesc, star] of entries) {
    const starMark = star ? " ★" : "  ";
    out.push(`  ${name}${starMark}  ${args === "" ? "    " : `${args}  `}${enDesc}`);
    out.push(`  ${" ".repeat(displayWidth(name) + 4)}${zhDesc}`);
  }
  return out;
}

function legacyHelpVersion(): string {
  // US-PORT-021: the version comes from the TS source (package.json, FIX-202),
  // not the bash bin/roll VERSION= literal — the bash engine is being retired.
  return rollVersion() || "—";
}

export function renderMainHelp(version: string = legacyHelpVersion()): string {
  return [
    "",
    row("  roll · autonomous delivery for software teams", `v${version}  `),
    "  自主交付，人只做三件事：提需求、审核、发版",
    "",
    "  usage  roll <command> [options]",
    "",
    HR,
    "",
    sectionHead("AUTONOMY", "日常使用", "★ = most used"),
    "",
    ...cmdBlock(AUTONOMY),
    "",
    HR,
    "",
    sectionHead("PROJECT", "项目内", "per-repo setup and CI"),
    "",
    ...cmdBlock(PROJECT),
    "",
    HR,
    "",
    sectionHead("MACHINE", "全局", "install, upgrade, version"),
    "",
    ...cmdBlock(MACHINE),
    "",
    HR,
    "",
    "  examples",
    "",
    ...EXAMPLES.map(([cmd, zh]) => `  ${cmd}  ${zh}`),
    "",
    `  docs: github.com/${ROLL_REPO_SLUG}  ·  issues: github.com/${ROLL_REPO_SLUG}/issues`,
    "  version: roll --version  ·  gc auto-runs per cycle (manual: roll loop gc)",
    "",
  ].join("\n");
}

export function dreamCommand(args: string[], runOnce: DreamRunOnce = dreamRunOnceCommand): number | Promise<number> {
  if (args[0] === "run-once") return runOnce(args.slice(1));
  // FIX-239: bare `dream` gets real usage; an unknown subcommand is named —
  // the old "Unknown command: dream" blamed the command itself.
  if (args[0] === undefined || args[0] === "") {
    process.stderr.write("Usage: roll dream run-once\n");
    return 1;
  }
  process.stderr.write(`[roll] unknown dream subcommand: ${args[0]}\nUsage: roll dream run-once\n`);
  return 1;
}
