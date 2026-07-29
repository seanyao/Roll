import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIssueStoryContract, validateStoryId, type IssueStoryContract } from "@roll/core";

export type ResolveStoryContractErrorCode =
  | "invalid_story_id"
  | "story_not_found"
  | "duplicate_story"
  | "invalid_config"
  | "invalid_value"
  | "invalid_type"
  | "unknown_field"
  | "identity_mismatch"
  | "duplicate_identity"
  | "symlink_escape";

export type ResolveStoryContractResult =
  | { readonly ok: true; readonly value: IssueStoryContract }
  | { readonly ok: false; readonly code: ResolveStoryContractErrorCode; readonly matches?: readonly string[] };

export type ResolveStorySpecResult =
  | { readonly ok: true; readonly path: string; readonly text: string }
  | { readonly ok: false; readonly code: ResolveStoryContractErrorCode; readonly matches?: readonly string[] };

/** Bound recursion depth under a Workspace Story tree — generous for any
 *  real epic/sub-epic nesting while refusing to walk unbounded structures. */
const MAX_STORY_TREE_DEPTH = 8;

/** Thrown internally to fail loud the instant a symlink is found anywhere in
 *  the backlog walk that would otherwise resolve outside the Workspace's own
 *  tree — caught by the one call site that converts it to a result code. */
class StoryTreeSymlinkEscapeError extends Error {}

/** True when `path` exists and is ITSELF a symlink (checked with `lstatSync`,
 *  never following it) — the only question this function answers; it does
 *  not care what the symlink points to or whether that target is safe. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every `<story-id>/spec.md` found in the canonical Workspace `features`
 *  authority or the legacy Workspace `backlog` tree. A caller cwd's own
 *  `.roll/features` tree is never consulted here.
 *
 *  FAIL-LOUD ON SYMLINKS: `readdirSync(..., { withFileTypes: true })` reports
 *  a symlinked directory entry's OWN dirent type (a symlink, not a
 *  directory), so `entry.isDirectory()` alone would silently skip it —
 *  invisible rather than refused. Every directory entry named `storyId` and
 *  every `spec.md` leaf is explicitly `lstatSync`'d; a symlink at either
 *  position throws {@link StoryTreeSymlinkEscapeError} immediately rather than
 *  being quietly treated as absent. */
function storySpecMatches(workspaceRoot: string, storyId: string): string[] {
  const matches: string[] = [];
  const walk = (authority: "features" | "backlog", dir: string, depth: number): void => {
    if (depth > MAX_STORY_TREE_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === storyId) {
        if (isSymlink(path)) throw new StoryTreeSymlinkEscapeError(`${authority} story directory is a symlink: ${path}`);
        if (!entry.isDirectory()) continue;
        const spec = join(path, "spec.md");
        if (isSymlink(spec)) throw new StoryTreeSymlinkEscapeError(`Story spec.md is a symlink: ${spec}`);
        if (existsSync(spec)) matches.push(spec);
        walk(authority, path, depth + 1);
        continue;
      }
      if (!entry.isDirectory() || isSymlink(path)) continue;
      walk(authority, path, depth + 1);
    }
  };
  for (const authority of ["features", "backlog"] as const) {
    const root = join(workspaceRoot, authority);
    if (isSymlink(root)) {
      throw new StoryTreeSymlinkEscapeError(`Workspace ${authority} root is a symlink: ${root}`);
    }
    walk(authority, root, 0);
  }
  return matches;
}

/** Resolve the Runtime Story Contract from the selected Workspace's canonical
 * `features/**\/<story-id>/spec.md` authority, with `backlog/**` accepted only
 * for legacy Workspaces. Never consult the caller cwd's `.roll/features`.
 * Fails loud when a story id resolves to more than one spec across both roots. */
export function resolveWorkspaceBacklogStorySpec(
  workspaceRoot: string,
  storyId: string,
): ResolveStorySpecResult {
  const validated = validateStoryId(storyId);
  if (!validated.ok) return { ok: false, code: "invalid_story_id" };
  let matches: string[];
  try {
    matches = storySpecMatches(workspaceRoot, storyId);
  } catch (error) {
    if (error instanceof StoryTreeSymlinkEscapeError) return { ok: false, code: "symlink_escape" };
    throw error;
  }
  if (matches.length === 0) return { ok: false, code: "story_not_found" };
  if (matches.length > 1) return { ok: false, code: "duplicate_story", matches };
  let specText: string;
  try {
    specText = readFileSync(matches[0]!, "utf8");
  } catch {
    return { ok: false, code: "story_not_found" };
  }
  return { ok: true, path: matches[0]!, text: specText };
}

/** Parse the selected Workspace-owned Story spec into its runtime repository
 * contract. Consumers that need the authored acceptance text use
 * {@link resolveWorkspaceBacklogStorySpec} so both paths share identical
 * uniqueness and symlink protections. */
export function resolveWorkspaceBacklogStoryContract(
  workspaceRoot: string,
  storyId: string,
): ResolveStoryContractResult {
  const spec = resolveWorkspaceBacklogStorySpec(workspaceRoot, storyId);
  if (!spec.ok) return spec;
  const specText = spec.text;
  const parsed = parseIssueStoryContract(specText, { storyId });
  if (!parsed.ok) return { ok: false, code: (parsed.errors[0]?.code ?? "invalid_config") as ResolveStoryContractErrorCode };
  return { ok: true, value: parsed.value };
}
