/** US-LOOP-127 — explicit parent-owned Skill dispatch command. */
import { resolveLang } from "@roll/spec";
import { allocateSkillDispatchRun, confirmSkillDispatchDelivery, integrateSkillDispatchChild, releaseSkillDispatchReservation, stopSkillDispatchRun, type SkillDispatchRunInput } from "../runner/skill-dispatch-workspace.js";

const USAGE =
  "Usage: roll worktree dispatch allocate <story-id> <dispatch-run-id> --actions <json>\n" +
  "       roll worktree dispatch integrate <story-id> <dispatch-run-id> <action-id> <commit>\n" +
  "       roll worktree dispatch release <story-id> <dispatch-run-id>\n" +
  "       roll worktree dispatch confirm <story-id> <dispatch-run-id> [--json]\n" +
  "       roll worktree dispatch stop <story-id> <dispatch-run-id> --reason <text> --confirm <story-id> [--json]\n" +
  "  Allocate one parent Skill DeliveryRun and detached child workspaces below .roll/loop/worktrees.\n" +
  "  <json> is an array of { actionId, declaredFileScope }. Only the parent run may publish, attest, close, release, or stop.\n" +
  "  confirm only finalizes a run after independent merge, accepted-attest, and clean-workspace checks.\n" +
  "  stop only abandons a clean, unmerged, unpublished run; its branches and retained commits stay available for audit.\n";

export function skillDispatchUsage(): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  return zh
    ? "用法：roll worktree dispatch allocate <story-id> <dispatch-run-id> --actions <json>\n       roll worktree dispatch integrate <story-id> <dispatch-run-id> <action-id> <commit>\n       roll worktree dispatch release <story-id> <dispatch-run-id>\n       roll worktree dispatch confirm <story-id> <dispatch-run-id> [--json]\n       roll worktree dispatch stop <story-id> <dispatch-run-id> --reason <原因> --confirm <story-id> [--json]\n  分配一个由父 Skill DeliveryRun 持有、位于 .roll/loop/worktrees 下的受管 WorkspaceSet。\n  <json> 为 { actionId, declaredFileScope } 数组；只有父运行可发布、验收、关闭、释放或停止。\n  confirm 只会收尾已合入、已验收且所有目录干净的运行。\n  stop 只会停止干净、未合入、未发布的运行；分支和保留提交会留下供核对。\n"
    : USAGE;
}

function actionsArg(args: readonly string[]): string | undefined {
  const index = args.indexOf("--actions");
  return index < 0 ? undefined : args[index + 1];
}

function optionArg(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  const value = index < 0 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** The executable allocator API referenced by the active Build/Fix Skills. */
export async function skillDispatchCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(skillDispatchUsage());
    return 0;
  }
  if (args[0] === "integrate") {
    const [storyId = "", runId = "", actionId = "", commit = ""] = args.slice(1);
    if (storyId === "" || runId === "" || actionId === "" || commit === "") {
      process.stderr.write(USAGE);
      return 1;
    }
    const result = integrateSkillDispatchChild(process.cwd(), storyId, runId, actionId, commit, process.cwd());
    if (!result.ok) {
      process.stderr.write(`roll worktree dispatch: integration refused (${result.reason}).\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, storyId, runId, actionId, commit, next: "Parent integration accepted the child commit after declared scope verification." }, null, 2)}\n`);
    return 0;
  }
  if (args[0] === "release") {
    const [storyId = "", runId = ""] = args.slice(1);
    if (storyId === "" || runId === "") {
      process.stderr.write(USAGE);
      return 1;
    }
    const result = releaseSkillDispatchReservation(process.cwd(), storyId, runId, process.cwd());
    if (!result.ok) {
      process.stderr.write(`roll worktree dispatch: release refused (${result.reason}).\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, storyId, runId, recovered: true }, null, 2)}\n`);
    return 0;
  }
  if (args[0] === "confirm") {
    const [storyId = "", runId = ""] = args.slice(1);
    if (storyId === "" || runId === "") {
      process.stderr.write(USAGE);
      return 1;
    }
    const result = await confirmSkillDispatchDelivery(process.cwd(), storyId, runId, process.cwd());
    if (!result.ok) {
      if (args.includes("--json")) {
        process.stderr.write(`${JSON.stringify({ ok: false, storyId, runId, reason: result.reason, releaseFailure: result.releaseFailure }, null, 2)}\n`);
        return 1;
      }
      process.stderr.write(`roll worktree dispatch: confirmation refused (${result.reason}).\n`);
      return 1;
    }
    const payload = { ok: true, storyId, runId, finalized: true, next: "Recorded delivered release, removed the managed workspaces, and released the Story reservation." };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Confirmed delivered run ${runId}, safely removed its managed workspaces, and released the Story reservation.\n`);
    return 0;
  }
  if (args[0] === "stop") {
    const [storyId = "", runId = ""] = args.slice(1);
    const reason = optionArg(args, "--reason") ?? "";
    const confirm = optionArg(args, "--confirm") ?? "";
    const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
    if (storyId === "" || runId === "" || reason.trim() === "" || confirm === "") {
      process.stderr.write(skillDispatchUsage());
      return 1;
    }
    const result = await stopSkillDispatchRun(process.cwd(), storyId, runId, reason, confirm, process.cwd());
    if (!result.ok) {
      process.stderr.write(zh
        ? `roll worktree dispatch：拒绝停止（${result.reason}）；只能停止干净、未合入、未发布的运行。\n`
        : `roll worktree dispatch: stop refused (${result.reason}); only clean, unmerged, unpublished runs may be stopped.\n`);
      return 1;
    }
    const payload = {
      ok: true,
      stopped: result.stopped,
      storyId,
      runId,
      retained: result.retained,
      next: zh
        ? "已放弃的分支和保留提交仍可核对；重新派发必须使用新的运行编号和完整的登记范围。"
        : "The abandoned branches and retained commits remain auditable. Redispatch only with a new run id and a complete declared scope.",
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(zh
      ? `已停止干净、未合入、未发布的运行 ${runId}。保留提交：${result.retained.map((item) => `${item.ref} (${item.head})`).join("，")}。重新派发请使用新的运行编号和完整登记范围。\n`
      : `Stopped clean, unmerged, unpublished run ${runId}. Retained commits: ${result.retained.map((item) => `${item.ref} (${item.head})`).join(", ")}. Use a new run id with a complete declared scope to redispatch.\n`);
    return 0;
  }
  if (args[0] !== "allocate") {
    process.stdout.write(USAGE);
    return 1;
  }
  const storyId = args[1] ?? "";
  const runId = args[2] ?? "";
  const rawActions = actionsArg(args);
  if (storyId === "" || runId === "" || rawActions === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  let actions: SkillDispatchRunInput["actions"];
  try {
    const parsed: unknown = JSON.parse(rawActions);
    if (!Array.isArray(parsed)) throw new Error("actions must be an array");
    actions = parsed as SkillDispatchRunInput["actions"];
  } catch {
    process.stderr.write("roll worktree dispatch: --actions must be a JSON array.\n");
    return 1;
  }
  const result = await allocateSkillDispatchRun({ projectRoot: process.cwd(), storyId, runId, actions });
  if (!result.ok) {
    process.stderr.write(`roll worktree dispatch: refused (${result.reason}).\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: result.value.workspace.runId,
    workspace: result.value.workspace,
    paths: result.value.paths,
    next: "Start child Builders only in paths named by workspace members; parent integration alone may publish, attest, close, or release.",
  }, null, 2)}\n`);
  return 0;
}

export { USAGE as SKILL_DISPATCH_USAGE };
