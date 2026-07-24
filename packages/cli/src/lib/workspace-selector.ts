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

export function hasCanonicalWorkspaceSelectorBeforeSentinel(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (isCanonicalWorkspaceSelectorToken(arg)) return true;
  }
  return false;
}
