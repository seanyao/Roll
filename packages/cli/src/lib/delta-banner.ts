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

/** A labelled fact rendered within a Delta lifecycle phase banner. */
export interface DeltaPhaseBannerField {
  readonly label: string;
  readonly value: string;
}

/**
 * Render the shared visual shell for every persisted Delta lifecycle phase.
 *
 * This is presentation-only: callers must provide event- or artifact-backed
 * facts, and it never infers a status or a missing field.
 */
export function renderDeltaPhaseBanner(input: {
  readonly title: string;
  readonly fields: readonly DeltaPhaseBannerField[];
}): string {
  const labelWidth = Math.max(0, ...input.fields.map((field) => field.label.length));
  return [
    input.title,
    ...input.fields.map((field) => `  ${field.label.padEnd(labelWidth)}  ${field.value}`),
  ].join("\n");
}

function sourceLabel(source: ResolvedRoleAssignment["source"]): string {
  return source === "availability-fallback" ? `⚠ ${source}` : source;
}

function diversityValue(
  roles: readonly ResolvedRoleAssignment[],
  copy: DeltaBannerCopy,
): string {
  const builder = roles.find((role) => role.role === "builder");
  const evaluator = roles.find((role) => role.role === "evaluator");

  if (!builder || !evaluator || builder.hostId === evaluator.hostId) {
    return copy.diversityUndeclared;
  }

  return copy.diversityDistinct
    .replace("{builder}", builder.hostId)
    .replace("{evaluator}", evaluator.hostId);
}

/** Render a static summary of the persisted model-resolution assignment. */
export function renderDeltaBanner(input: DeltaBannerInput, copy: DeltaBannerCopy): string {
  const roleWidth = Math.max(0, ...input.roles.map((role) => role.role.length));
  const roleFields = input.roles.map((role, index) => {
    const branch = index === input.roles.length - 1 ? "└" : "├";
    return {
      label: `${branch} ${role.role.padEnd(roleWidth)}`,
      value: `${role.hostId} · ${role.modelId}  ${sourceLabel(role.source)}`,
    };
  });

  return renderDeltaPhaseBanner({
    title: copy.title,
    fields: [
      { label: copy.story, value: input.storyId },
      ...roleFields,
      { label: copy.diversity, value: diversityValue(input.roles, copy) },
      { label: copy.frame, value: `${input.frameDir}  ${copy.leaseHeld}` },
    ],
  });
}
