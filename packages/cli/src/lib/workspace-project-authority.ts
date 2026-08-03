import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceAuthorityRequirement {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** Validate canonical mutation authorities without creating or repairing them. */
export function requireWorkspaceAuthorities(
  command: string,
  requirements: readonly WorkspaceAuthorityRequirement[],
): boolean {
  const invalid = requirements.filter(({ path, kind }) => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return true;
      return kind === "file" ? !stat.isFile() : !stat.isDirectory();
    } catch {
      return true;
    }
  });
  if (invalid.length === 0) return true;
  process.stderr.write(
    `${command}: authority_missing: ${invalid.map(({ path, kind }) => `${path} (${kind})`).join(", ")}\n`,
  );
  return false;
}

/** Reject lexical escapes and every existing symlink between a canonical
 * Workspace authority root and one mutation target. Missing descendants are
 * allowed because the caller may create them after this preflight. */
export function requireWorkspaceMutationPath(
  command: string,
  authorityRoot: string,
  targetPath: string,
  targetKind: "file" | "directory",
): boolean {
  const root = resolve(authorityRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    process.stderr.write(`${command}: authority_outside: ${target}\n`);
    return false;
  }

  const candidates = [root];
  let current = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    current = join(current, segment);
    candidates.push(current);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      if (index === 0) {
        process.stderr.write(`${command}: authority_missing: ${candidate} (directory)\n`);
        return false;
      }
      return true;
    }
    if (stat.isSymbolicLink()) {
      process.stderr.write(`${command}: authority_symlink: ${candidate}\n`);
      return false;
    }
    const isTarget = index === candidates.length - 1;
    const valid = isTarget
      ? targetKind === "file" ? stat.isFile() : stat.isDirectory()
      : stat.isDirectory();
    if (!valid) {
      process.stderr.write(`${command}: authority_missing: ${candidate} (${isTarget ? targetKind : "directory"})\n`);
      return false;
    }
  }
  return true;
}
