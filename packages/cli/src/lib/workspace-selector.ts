export const CANONICAL_WORKSPACE_SELECTOR = "--workspace" as const;

export function isCanonicalWorkspaceSelectorToken(value: string | undefined): value is typeof CANONICAL_WORKSPACE_SELECTOR {
  return value === CANONICAL_WORKSPACE_SELECTOR;
}

export function containsCanonicalWorkspaceSelector(args: readonly string[]): boolean {
  return args.includes(CANONICAL_WORKSPACE_SELECTOR);
}

export function canonicalWorkspaceSelectorIndex(args: readonly string[]): number {
  return args.indexOf(CANONICAL_WORKSPACE_SELECTOR);
}

export function canonicalWorkspaceSelectorValue(args: readonly string[]): string | undefined {
  const index = canonicalWorkspaceSelectorIndex(args);
  return index < 0 ? undefined : args[index + 1];
}

export function workspaceSelectorArgs(value: string): [typeof CANONICAL_WORKSPACE_SELECTOR, string] {
  return [CANONICAL_WORKSPACE_SELECTOR, value];
}

export function withWorkspaceSelector(
  prefix: readonly string[],
  value: string,
  suffix: readonly string[] = [],
): string[] {
  return [...prefix, CANONICAL_WORKSPACE_SELECTOR, value, ...suffix];
}

export function hasCanonicalWorkspaceSelectorBeforeSentinel(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (isCanonicalWorkspaceSelectorToken(arg)) return true;
  }
  return false;
}
