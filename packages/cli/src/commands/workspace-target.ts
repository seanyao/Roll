import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceContextCandidate, WorkspaceRegistryCandidate, WorkspaceTargetSelector } from "@roll/core";
import type { InspectedWorkspace } from "@roll/infra";
import { parseWorkspaceManifest } from "@roll/spec";

export interface LegacyWorkspaceProject {
  readonly repositoryRoot: string;
  readonly backlogPath: string;
}

export interface WorkspaceCwdInspection {
  readonly cwdManifest?: WorkspaceContextCandidate;
  readonly hasReachableWorkspaceManifest: boolean;
  readonly legacyProject?: LegacyWorkspaceProject;
}

export function workspaceRollHome(): string {
  return process.env["ROLL_HOME"] ?? resolve(homedir(), ".roll");
}

export function workspaceRegistryCandidates(entries: readonly InspectedWorkspace[]): readonly WorkspaceRegistryCandidate[] {
  return entries.map((entry) => ({
    workspaceId: entry.workspaceId,
    root: entry.root,
    canonicalRoot: entry.canonicalRoot,
    manifestWorkspaceId: entry.manifestWorkspaceId ?? "<invalid-manifest>",
    pathState: entry.consistency === "stale_path" ? "stale" : "valid",
    lifecycle: entry.lifecycle,
  }));
}

export function workspaceTargetSelector(value: string): WorkspaceTargetSelector {
  if (!isAbsolute(value) && !value.startsWith(".") && !value.includes("/")) {
    return { kind: "id", workspaceId: value };
  }
  const absolutePath = resolve(value);
  let canonicalPath = absolutePath;
  try {
    canonicalPath = realpathSync(absolutePath);
  } catch {
    // The pure target resolver reports an actionable missing or stale target.
  }
  return { kind: "path", absolutePath, canonicalPath };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function inspectWorkspaceCwd(
  cwd: string,
  entries: readonly InspectedWorkspace[],
): WorkspaceCwdInspection {
  const canonicalCwd = realpathSync(cwd);
  let cursor = resolve(cwd);
  let legacyProject: LegacyWorkspaceProject | undefined;

  for (;;) {
    const manifestPath = join(cursor, "workspace.yaml");
    if (existsSync(manifestPath)) {
      try {
        const parsed = parseWorkspaceManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
        if (!parsed.ok) return { hasReachableWorkspaceManifest: true };
        const entry = entries.find((candidate) => candidate.workspaceId === parsed.value.workspaceId);
        if (entry === undefined) return { hasReachableWorkspaceManifest: true };
        return {
          cwdManifest: {
            workspaceId: entry.workspaceId,
            root: entry.root,
            canonicalRoot: entry.canonicalRoot,
            containment: contained(entry.canonicalRoot, canonicalCwd) ? "safe" : "symlink_escape",
          },
          hasReachableWorkspaceManifest: true,
        };
      } catch {
        return { hasReachableWorkspaceManifest: true };
      }
    }

    if (legacyProject === undefined) {
      const backlogPath = join(cursor, ".roll", "backlog.md");
      const gitPath = join(cursor, ".git");
      if (existsSync(backlogPath) && existsSync(gitPath)) {
        legacyProject = {
          repositoryRoot: realpathSync(cursor),
          backlogPath: realpathSync(backlogPath),
        };
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return {
    hasReachableWorkspaceManifest: false,
    ...(legacyProject === undefined ? {} : { legacyProject }),
  };
}

export function resolveCwdWorkspaceContext(
  cwd: string,
  entries: readonly InspectedWorkspace[],
): WorkspaceContextCandidate | undefined {
  return inspectWorkspaceCwd(cwd, entries).cwdManifest;
}
