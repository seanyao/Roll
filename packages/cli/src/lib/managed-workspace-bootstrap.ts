/**
 * @responsibility Defines the caller-neutral managed-workspace bootstrap effect boundary.
 */
import type { ManagedWorkspaceBootstrapPlan } from "./target-submodule.js";

/**
 * One caller-neutral bootstrap effect boundary.  Allocation transports supply
 * the effects, but they cannot silently choose a different ordering or omit a
 * readiness phase.  The service is intentionally small: filesystem/process
 * details remain at the Node/runner edge.
 */
export interface ManagedWorkspaceBootstrapEffects {
  readonly linkRoll: () => void | Promise<void>;
  readonly initializeSkills: () => boolean | Promise<boolean>;
  readonly installDependencies: () => boolean | Promise<boolean>;
  /** Best effort by contract; failures are observed by the transport. */
  readonly policyPrebuild: () => void | Promise<void>;
}

export async function runManagedWorkspaceBootstrap(
  plan: ManagedWorkspaceBootstrapPlan,
  effects: ManagedWorkspaceBootstrapEffects,
): Promise<void> {
  if (plan.linkRoll) await effects.linkRoll();
  if (plan.initializeSkills && !await effects.initializeSkills()) throw new Error("skills_bootstrap_failed");
  if (plan.installDependencies && !await effects.installDependencies()) throw new Error("dependency_bootstrap_failed");
  if (plan.policyPrebuild) await effects.policyPrebuild();
}
