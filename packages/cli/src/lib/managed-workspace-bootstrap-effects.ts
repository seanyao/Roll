/**
 * @responsibility Applies concrete caller-neutral managed-workspace bootstrap effects.
 */
/**
 * Concrete, caller-neutral managed-workspace bootstrap effects.
 *
 * Cycle and host Delta both enter here.  The caller supplies only process and
 * alert ports; fossil repair, skills verification, dependency installation and
 * optional prebuild are one production implementation, not parallel lookalikes.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePolicy } from "@roll/core";
import { planManagedWorkspaceBootstrap } from "./target-submodule.js";
import { runManagedWorkspaceBootstrap } from "./managed-workspace-bootstrap.js";

export interface ManagedWorkspaceBootstrapRuntime {
  readonly repoCwd: string;
  readonly worktreePath: string;
  readonly alert: (message: string) => void;
  readonly run: (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ code: number; error?: string }>;
}

function skillsDeclared(worktreePath: string): boolean {
  const gitmodules = join(worktreePath, ".gitmodules");
  return existsSync(gitmodules) && /^\s*path\s*=\s*"?skills"?\s*$/m.test(readFileSync(gitmodules, "utf8"));
}

function skillsPopulated(worktreePath: string): boolean {
  try { return readdirSync(join(worktreePath, "skills")).length > 0; } catch { return false; }
}

async function linkRoll(runtime: ManagedWorkspaceBootstrapRuntime): Promise<void> {
  try {
    const source = join(runtime.repoCwd, ".roll");
    const target = join(runtime.worktreePath, ".roll");
    if (!existsSync(source)) return;
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return;
    if (stat !== undefined) {
      const incompleteFossil = existsSync(join(source, "backlog.md")) && !existsSync(join(target, "backlog.md"));
      if (!incompleteFossil) return;
      rmSync(target, { recursive: true, force: true });
    }
    symlinkSync(source, target);
    const common = execFileSync("git", ["-C", runtime.repoCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    if (common === "") return;
    const exclude = join(common, "info", "exclude");
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!/^\.roll$/m.test(current)) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}.roll\n`, "utf8");
    }
  } catch { /* link remains best-effort exactly as Cycle historically required */ }
}

function prebuildEnabled(repoCwd: string): boolean {
  try {
    const policy = join(repoCwd, ".roll", "policy.yaml");
    return existsSync(policy) && parsePolicy(readFileSync(policy, "utf8")).loopSafety.prebuildDist === true;
  } catch { return false; }
}

/** Execute the shared observable sequence: link → skills → dependencies → prebuild. */
export async function bootstrapManagedWorkspaceEffects(runtime: ManagedWorkspaceBootstrapRuntime): Promise<void> {
  const plan = planManagedWorkspaceBootstrap({});
  await runManagedWorkspaceBootstrap(plan, {
    linkRoll: () => linkRoll(runtime),
    initializeSkills: async () => {
      if (!skillsDeclared(runtime.worktreePath) || skillsPopulated(runtime.worktreePath)) return true;
      const result = await runtime.run("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "skills"], { cwd: runtime.worktreePath, timeout: 600_000 });
      if (result.code !== 0 || !skillsPopulated(runtime.worktreePath)) {
        runtime.alert(`[FAIL] worktree submodule init failed: ${result.error ?? "skills/ would be empty"}`);
        return false;
      }
      return true;
    },
    installDependencies: async () => {
      if (!existsSync(join(runtime.worktreePath, "package.json")) || existsSync(join(runtime.worktreePath, "node_modules"))) return true;
      const command = existsSync(join(runtime.worktreePath, "pnpm-lock.yaml"))
        ? ["pnpm", ["install", "--prefer-offline"]] as const
        : existsSync(join(runtime.worktreePath, "package-lock.json"))
          ? ["npm", ["ci", "--prefer-offline"]] as const
          : undefined;
      if (command === undefined) return true;
      const result = await runtime.run(command[0], [...command[1]], { cwd: runtime.worktreePath, timeout: 600_000 });
      if (result.code !== 0) runtime.alert(`[FAIL] worktree deps bootstrap failed (${command[0]} ${command[1].join(" ")}): ${result.error ?? `exit ${result.code}`}`);
      return result.code === 0;
    },
    policyPrebuild: async () => {
      if (!prebuildEnabled(runtime.repoCwd) || !existsSync(join(runtime.worktreePath, "package.json")) || !existsSync(join(runtime.worktreePath, "pnpm-lock.yaml"))) return;
      const result = await runtime.run("pnpm", ["-r", "build"], { cwd: runtime.worktreePath, timeout: 600_000 });
      if (result.code !== 0) runtime.alert(`[WARN] worktree dist prebuild failed: ${result.error ?? `exit ${result.code}`} — continuing; agent will build on demand`);
    },
  });
}
