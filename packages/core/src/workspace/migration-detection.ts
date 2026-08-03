export interface LegacyProjectProbe {
  readonly hasBacklogMd: boolean;
  readonly hasWorkspaceManifest: boolean;
  readonly repositoryRoot: string;
}

export type LegacyProjectDecision =
  | { readonly legacy: false }
  | {
      readonly legacy: true;
      readonly repositoryRoot: string;
      readonly migrationCheckCommand: string;
    };

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function detectLegacyProject(probe: LegacyProjectProbe): LegacyProjectDecision {
  if (!probe.hasBacklogMd || probe.hasWorkspaceManifest) return { legacy: false };
  return {
    legacy: true,
    repositoryRoot: probe.repositoryRoot,
    migrationCheckCommand: `roll workspace migrate --from ${quoteShellArg(probe.repositoryRoot)} --check`,
  };
}
