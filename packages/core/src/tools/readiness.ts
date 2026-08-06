/**
 * @responsibility Derives tool readiness from declared requirements and resolutions.
 */
import type { ToolDeclaration, ToolReadiness, ToolRequirement, ToolRequirementResolution } from "@roll/spec";

export type ToolRequirementResolver = (requirement: ToolRequirement) => ToolRequirementResolution;

export function deriveToolReadiness(declaration: ToolDeclaration, resolveRequirement: ToolRequirementResolver): ToolReadiness {
  const requirements = (declaration.requirements ?? []).map((requirement) => resolveRequirement(requirement));
  const failingRequired = requirements.filter((resolution) => resolution.requirement.optional !== true && resolution.status !== "ok");
  const failingOptional = requirements.filter((resolution) => resolution.requirement.optional === true && resolution.status !== "ok");
  const failing = failingRequired.length > 0 ? failingRequired : failingOptional;
  const repairCommands = failing.flatMap((resolution) => (resolution.repair?.command === undefined ? [] : [resolution.repair.command]));

  if (failingRequired.length > 0) {
    return {
      toolId: declaration.id,
      status: "unavailable",
      requirements,
      detail: failingRequired.map((resolution) => resolution.detail).join("; "),
      ...(repairCommands.length > 0 ? { repairCommands } : {}),
    };
  }

  if (failingOptional.length > 0) {
    return {
      toolId: declaration.id,
      status: "degraded",
      requirements,
      detail: failingOptional.map((resolution) => resolution.detail).join("; "),
      ...(repairCommands.length > 0 ? { repairCommands } : {}),
    };
  }

  return { toolId: declaration.id, status: "available", requirements };
}
