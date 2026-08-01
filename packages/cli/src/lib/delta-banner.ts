/**
 * US-DELTA-009 — Pure Delta Team assembly banner.
 *
 * Callers provide only facts that were already persisted by the delegation
 * allocation boundary. This module performs no I/O and never fills in missing
 * resolution fields.
 */
import type { ResolvedRoleAssignment } from "@roll/spec";

export interface DeltaBannerCopy {
  readonly title: string;
  readonly story: string;
  readonly diversity: string;
  readonly diversityDistinct: string;
  readonly diversityUndeclared: string;
  readonly frame: string;
  readonly leaseHeld: string;
}

export interface DeltaBannerInput {
  readonly storyId: string;
  readonly roles: readonly ResolvedRoleAssignment[];
  readonly frameDir: string;
}

function sourceLabel(source: ResolvedRoleAssignment["source"]): string {
  return source === "availability-fallback" ? `⚠ ${source}` : source;
}

function diversityLine(
  roles: readonly ResolvedRoleAssignment[],
  copy: DeltaBannerCopy,
): string {
  const builder = roles.find((role) => role.role === "builder");
  const evaluator = roles.find((role) => role.role === "evaluator");

  if (!builder || !evaluator || builder.hostId === evaluator.hostId) {
    return `  ${copy.diversity}  ${copy.diversityUndeclared}`;
  }

  return `  ${copy.diversity}  ${copy.diversityDistinct
    .replace("{builder}", builder.hostId)
    .replace("{evaluator}", evaluator.hostId)}`;
}

/** Render a static summary of the persisted model-resolution assignment. */
export function renderDeltaBanner(input: DeltaBannerInput, copy: DeltaBannerCopy): string {
  const roleWidth = Math.max(0, ...input.roles.map((role) => role.role.length));
  const roleLines = input.roles.map((role, index) => {
    const branch = index === input.roles.length - 1 ? "└" : "├";
    return `  ${branch} ${role.role.padEnd(roleWidth)}  ${role.hostId} · ${role.modelId}  ${sourceLabel(role.source)}`;
  });

  return [
    copy.title,
    `  ${copy.story}     ${input.storyId}`,
    ...roleLines,
    diversityLine(input.roles, copy),
    `  ${copy.frame}     ${input.frameDir}  ${copy.leaseHeld}`,
  ].join("\n");
}
