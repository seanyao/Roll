/** US-LOOP-127 — explicit parent-owned Skill dispatch command. */
import { resolveLang } from "@roll/spec";
import { allocateSkillDispatchRun, integrateSkillDispatchChild, releaseSkillDispatchReservation, type SkillDispatchRunInput } from "../runner/skill-dispatch-workspace.js";

const USAGE =
  "Usage: roll worktree dispatch allocate <story-id> <dispatch-run-id> --actions <json>\n" +
  "       roll worktree dispatch integrate <story-id> <dispatch-run-id> <action-id> <commit>\n" +
  "       roll worktree dispatch release <story-id> <dispatch-run-id>\n" +
  "  Allocate one parent Skill DeliveryRun and detached child workspaces below .roll/loop/worktrees.\n" +
  "  <json> is an array of { actionId, declaredFileScope }. Only the parent run may publish, attest, close, or release.\n";

export function skillDispatchUsage(): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  return zh
    ? "用法：roll worktree dispatch allocate <story-id> <dispatch-run-id> --actions <json>\n       roll worktree dispatch integrate <story-id> <dispatch-run-id> <action-id> <commit>\n       roll worktree dispatch release <story-id> <dispatch-run-id>\n  分配一个由父 Skill DeliveryRun 持有、位于 .roll/loop/worktrees 下的受管 WorkspaceSet。\n  <json> 为 { actionId, declaredFileScope } 数组；只有父运行可发布、验收、关闭或释放。\n"
    : USAGE;
}

function actionsArg(args: readonly string[]): string | undefined {
  const index = args.indexOf("--actions");
  return index < 0 ? undefined : args[index + 1];
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
