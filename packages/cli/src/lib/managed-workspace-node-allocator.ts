/**
 * Node/Git adapter for the common managed-workspace allocation state machine.
 *
 * Cycle uses the same state vocabulary through injected async runner ports;
 * host-guided Delta uses this synchronous adapter because `delta prepare` is a
 * CLI command.  Neither path owns a second path convention or recovery model.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventBus } from "@roll/core";
import { MANAGED_WORKSPACE_SCHEMA, normalizeManagedWorkspaceSet, type ManagedWorkspaceSet, type RollEvent } from "@roll/spec";
import { hasManagedWorkspaceAllocation, managedWorkspaceAllocationState } from "./managed-workspace-operation.js";
import { reconcileManagedWorkspaceAllocation } from "../runner/managed-workspace-allocator.js";
import { bootstrapManagedWorkspaceEffects } from "./managed-workspace-bootstrap-effects.js";

export class ManagedWorkspaceNodeAllocationError extends Error {}

/**
 * Host-guided Delta's adapter-facing planning seam.  Keeping the process/Git
 * probes here means the protocol layer owns neither checkout paths nor a
 * second interpretation of repository identity.  Cycle planning has the same
 * result shape through its injected GitPort facts.
 */
export async function planHostManagedWorkspace(
  projectPath: string,
  input: { storyId: string; topology: ManagedWorkspaceSet["topology"] },
  delegationId: string,
  runId: string,
  targetSubmodule?: string,
): Promise<ManagedWorkspaceSet> {
  const git = (args: string[], cwd = projectPath): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("not a Git worktree");
    const repositoryIdentity = (cwd: string): string => {
      let repositoryId = "";
      try { repositoryId = git(["config", "--get", "remote.origin.url"], cwd); } catch { /* local identity below */ }
      return repositoryId === ""
        ? git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).replace(/[^A-Za-z0-9._/-]/g, "_")
        : repositoryId;
    };
    const workspaceKey = runId;
    const publishRef = `refs/heads/roll/${input.storyId.toLowerCase()}-${delegationId}`;
    const primary = {
      repositoryId: repositoryIdentity(projectPath), workspaceKey, relativeLocator: workspaceKey,
      checkoutRef: { kind: "detached" as const, head: git(["rev-parse", "HEAD"]) },
      publishRef,
    };
    // A Delta workspace has the same target-member rule as a Cycle.  Do not
    // enumerate .gitmodules: unrelated/uninitialised members are not part of
    // this Story and must not alter allocation or recovery semantics.
    const members = [primary, ...(targetSubmodule === undefined ? [] : [targetSubmodule].map((path) => {
      const submoduleCwd = join(projectPath, path);
      if (git(["rev-parse", "--is-inside-work-tree"], submoduleCwd) !== "true") throw new Error(`declared submodule is not initialized: ${path}`);
      return {
        repositoryId: repositoryIdentity(submoduleCwd),
        workspaceKey,
        relativeLocator: `${workspaceKey}.submodules/${path}`,
        checkoutRef: { kind: "detached" as const, head: git(["rev-parse", "HEAD"], submoduleCwd) },
        // The same ref spelling is safe because this member has its own Git
        // namespace.  Persist it on the member, never borrow the superproject
        // ref when proving a submodule delivery.
        publishRef,
      };
    }))];
    const workspace: ManagedWorkspaceSet = { schema: MANAGED_WORKSPACE_SCHEMA, runId, storyId: input.storyId, kind: "host_delta", topology: input.topology, delegationId, members: members as unknown as ManagedWorkspaceSet["members"] };
    if (!normalizeManagedWorkspaceSet(workspace).ok) throw new Error("invalid managed WorkspaceSet");
    return workspace;
  } catch (error) {
    throw new ManagedWorkspaceNodeAllocationError(`Host Delta prepare requires a real Git workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function lifecycleEvents(eventsPath: string): RollEvent[] {
  try {
    return readFileSync(eventsPath, "utf8").split("\n").flatMap((line) => {
      try { return line === "" ? [] : [JSON.parse(line) as RollEvent]; } catch { return []; }
    });
  } catch { return []; }
}

function canonicalPath(projectPath: string, relativeLocator: string): string {
  return join(projectPath, ".roll", "loop", "worktrees", relativeLocator);
}

/**
 * The host adapter performs the same mandatory workspace bootstrap boundary as
 * a Cycle before publishing `worktree:allocated`: shared Roll metadata is
 * visible and declared submodules are initialized.  A real checked-in `.roll`
 * directory is preserved; a missing one becomes the canonical metadata link.
 */
async function bootstrapManagedWorkspace(projectPath: string, target: string): Promise<void> {
  const sourceRoll = join(projectPath, ".roll");
  // Host Delta and Cycle deliberately invoke the *same concrete effects*.
  // This preserves fossil repair, populated-skills verification, diagnostic
  // policy, and best-effort prebuild semantics instead of merely sharing an
  // ordering helper with a second implementation hidden behind it.
  try {
    await bootstrapManagedWorkspaceEffects({
      repoCwd: projectPath,
      worktreePath: target,
      alert: (message) => {
        // Host prepare has no Cycle alert port; persist the equivalent durable
        // diagnostic while preserving the shared effect result.
        try { new EventBus().appendEvent(join(sourceRoll, "loop", "events.ndjson"), { type: "loop:error", loop: "main", error: message, ts: Date.now() }); } catch { /* outer boundary fails loud */ }
      },
      run: async (command, args, options) => {
        try {
          execFileSync(command, args, { cwd: options.cwd, stdio: "ignore", timeout: options.timeout });
          return { code: 0 };
        } catch (error) { return { code: 1, error: error instanceof Error ? error.message : String(error) }; }
      },
    });
  } catch (error) {
    throw new ManagedWorkspaceNodeAllocationError(`managed workspace bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Record allocation_started before the first Git mutation. */
export function ensureManagedWorkspaceRecovery(
  eventsPath: string,
  workspace: ManagedWorkspaceSet,
  operationId: string,
): void {
  const primary = workspace.members[0];
  if (primary === undefined) throw new ManagedWorkspaceNodeAllocationError("managed workspace has no primary member");
  if (managedWorkspaceAllocationState(lifecycleEvents(eventsPath), workspace, operationId) !== "unstarted") return;
  try {
    new EventBus().appendEvent(eventsPath, {
      type: "worktree:recovery_required",
      runId: workspace.runId,
      relativeLocator: primary.relativeLocator,
      reason: "allocation_started",
      workspace,
      operationId,
      ts: Date.now(),
    });
  } catch {
    throw new ManagedWorkspaceNodeAllocationError("managed workspace allocation operation could not be recorded");
  }
}

/**
 * Materialise/reconcile exactly the member recorded in `workspace`.  It never
 * prunes a target: a foreign or partially unverifiable target stays preserved
 * for explicit recovery.
 */
export async function allocateManagedWorkspaceWithNodePort(
  projectPath: string,
  eventsPath: string,
  workspace: ManagedWorkspaceSet,
  operationId: string,
): Promise<void> {
  const primary = workspace.members[0];
  if (primary === undefined) throw new ManagedWorkspaceNodeAllocationError("managed workspace has no primary member");
  const git = (args: string[], cwd = projectPath): string => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const submodulePath = (relativeLocator: string): string | undefined => {
    const prefix = `${primary.workspaceKey}.submodules/`;
    return relativeLocator.startsWith(prefix) ? relativeLocator.slice(prefix.length) : undefined;
  };
  const repositoryIdentity = (cwd: string): string => {
    let repositoryId = "";
    try { repositoryId = git(["config", "--get", "remote.origin.url"], cwd); } catch { /* local fallback */ }
    return repositoryId === ""
      ? git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).replace(/[^A-Za-z0-9._/-]/g, "_")
      : repositoryId;
  };
  const identityMatches = (member: ManagedWorkspaceSet["members"][number]): boolean => {
    const target = canonicalPath(projectPath, member.relativeLocator);
    const repoCwd = submodulePath(member.relativeLocator) === undefined
      ? projectPath
      : join(projectPath, submodulePath(member.relativeLocator)!);
    try {
      const root = realpathSync(join(projectPath, ".roll", "loop", "worktrees"));
      const checkout = realpathSync(target);
      if (!checkout.startsWith(`${root}/`)) return false;
      const registered = git(["worktree", "list", "--porcelain"], repoCwd).split("\n\n").some((entry) => entry.split("\n").some((line) => {
        if (!line.startsWith("worktree ")) return false;
        try { return realpathSync(line.slice("worktree ".length)) === checkout; } catch { return false; }
      }));
      if (!registered || git(["rev-parse", "HEAD"], target) !== member.checkoutRef.head) return false;
      try { if (git(["symbolic-ref", "-q", "HEAD"], target) !== "") return false; } catch { /* detached checkout */ }
      return repositoryIdentity(repoCwd) === member.repositoryId;
    } catch { return false; }
  };

  try {
    await reconcileManagedWorkspaceAllocation(workspace, operationId, {
      events: () => lifecycleEvents(eventsPath),
      recordRecovery: () => ensureManagedWorkspaceRecovery(eventsPath, workspace, operationId),
      inspect: () => workspace.members.every((member) => existsSync(canonicalPath(projectPath, member.relativeLocator)) && identityMatches(member))
        ? "present"
        : "absent",
      materialize: () => {
        for (const member of workspace.members) {
          const target = canonicalPath(projectPath, member.relativeLocator);
          const submodule = submodulePath(member.relativeLocator);
          const repoCwd = submodule === undefined ? projectPath : join(projectPath, submodule);
          if (existsSync(target) && !identityMatches(member)) {
            throw new ManagedWorkspaceNodeAllocationError(`managed workspace target has foreign identity: ${member.relativeLocator}`);
          }
          if (!existsSync(target)) {
            mkdirSync(dirname(target), { recursive: true });
            try { execFileSync("git", ["worktree", "add", "--detach", target, member.checkoutRef.head], { cwd: repoCwd, stdio: "ignore" }); }
            catch { throw new ManagedWorkspaceNodeAllocationError(`unable to allocate managed workspace: ${member.relativeLocator}`); }
          }
        }
      },
      bootstrap: () => bootstrapManagedWorkspace(projectPath, canonicalPath(projectPath, primary.relativeLocator)),
      appendAllocated: () => {
        if (hasManagedWorkspaceAllocation(lifecycleEvents(eventsPath), workspace, operationId)) return;
        try { new EventBus().appendEvent(eventsPath, { type: "worktree:allocated", workspace, operationId, ts: Date.now() }); }
        catch { throw new ManagedWorkspaceNodeAllocationError("managed workspace was created but its durable allocation fact could not be written"); }
      },
    });
  } catch (error) {
    if (error instanceof ManagedWorkspaceNodeAllocationError) throw error;
    throw new ManagedWorkspaceNodeAllocationError(error instanceof Error ? error.message : String(error));
  }
}
