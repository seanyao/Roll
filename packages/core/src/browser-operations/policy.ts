/**
 * @responsibility Resolves browser role/lane/action policy before any transport is selected.
 * US-BROW-001 AC3 — Browser operation policy resolver.
 *
 * Resolve role/lane/action policy BEFORE any transport is selected.
 * Every denial returns a structured reason and emits no adapter call.
 *
 * See managed-devtools-plan.md §§3, 5.2, 6.1.
 */

import type {
  BrowserActionKind,
  BrowserCaller,
  BrowserDenialReason,
  BrowserLane,
  BrowserLanePolicy,
  BrowserOperationsPolicy,
  BrowserPolicyDecision,
} from "@roll/spec";
import { authorizeOrigin, isActionAllowed, policyFingerprint } from "./origin.js";
import { BrowserTransportRegistry } from "./transport.js";

// ── Policy loading ──────────────────────────────────────────────────────────

/**
 * Default policy: everything disabled. Projects opt in via .roll/policy.yaml.
 */
export const DEFAULT_BROWSER_POLICY: BrowserOperationsPolicy = {
  enabled: false,
  devtoolsServer: "chrome-devtools",
  managed: {
    enabled: false,
    allowedOrigins: [],
    allowedActions: [],
  },
  interactive: {
    enabled: false,
    allowedOrigins: [],
    allowedActions: [],
  },
};

// ── Caller-to-lane restrictions ─────────────────────────────────────────────

/**
 * Only Supervisor can use the interactive lane.
 * Builder and Evaluator are restricted to managed.
 */
const INTERACTIVE_CALLERS: ReadonlySet<BrowserCaller> = new Set(["supervisor"]);

function canUseLane(caller: BrowserCaller, lane: BrowserLane): boolean {
  if (lane === "interactive") return INTERACTIVE_CALLERS.has(caller);
  return true; // all callers can use managed
}

// ── Resolution ──────────────────────────────────────────────────────────────

export interface ResolvePolicyOptions {
  policy: BrowserOperationsPolicy;
  lane: BrowserLane;
  caller: BrowserCaller;
  action: BrowserActionKind;
  targetUrl: string;
  /** If interactive lane, a valid lease must be present. */
  hasLease?: boolean;
  /** If interactive lane, the lease's bound origin. */
  leaseOrigin?: string;
}

/**
 * Resolve the full policy decision: lane access, action allowability,
 * origin validation, and policy fingerprint. Never invokes an adapter.
 *
 * Returns a BrowserPolicyDecision with structured denial reason on failure.
 */
export function resolvePolicy(
  options: ResolvePolicyOptions,
): BrowserPolicyDecision {
  const { policy, lane, caller, action, targetUrl } = options;

  // Gate 1: policy enabled at all?
  if (!policy.enabled) {
    return denied("policy_disabled", "Browser operations are disabled in project policy");
  }

  // The project may select the one registered logical name, never a transport.
  const binding = new BrowserTransportRegistry().resolve(policy.devtoolsServer);
  if (binding.kind === "denied") return { authorized: false, denial: binding.reason, policyFingerprint: "" };

  // Gate 2: lane enabled?
  const lanePolicy = lane === "managed" ? policy.managed : policy.interactive;
  if (!lanePolicy.enabled) {
    return denied("lane_disabled", `Browser lane "${lane}" is disabled`, { lane });
  }

  // Gate 3: caller allowed for this lane?
  if (!canUseLane(caller, lane)) {
    return denied(
      "caller_not_allowed",
      `Caller "${caller}" is not allowed to use lane "${lane}"`,
      { caller, lane },
    );
  }

  // Gate 4: action in the lane's allowed vocabulary?
  if (!isActionAllowed(action, lanePolicy)) {
    return denied(
      "action_not_allowed",
      `Action "${action}" is not allowed on lane "${lane}"`,
      { action, lane, allowedActions: lanePolicy.allowedActions },
    );
  }

  // Gate 5: interactive lane requires a valid lease
  if (lane === "interactive") {
    if (!options.hasLease) {
      return denied(
        "interactive_no_lease",
        "Interactive lane requires an active browser lease",
        { lane },
      );
    }
    if (options.leaseOrigin !== undefined) {
      const originValidation = authorizeOrigin(options.leaseOrigin, lanePolicy);
      if (!originValidation.authorized || !originValidation.normalized) {
        return denied(
          "interactive_lease_origin_mismatch",
          "Interactive lease origin does not match policy allowlist",
          { leaseOrigin: options.leaseOrigin },
        );
      }
    }
  }

  // Gate 6: origin validation (normalize + allowlist)
  const originValidation = authorizeOrigin(targetUrl, lanePolicy);
  if (!originValidation.authorized || !originValidation.normalized) {
    return {
      authorized: false,
      denial: originValidation.denial,
      policyFingerprint: policyFingerprint(lanePolicy),
    };
  }

  // All gates passed
  const fp = policyFingerprint(lanePolicy);
  return {
    authorized: true,
    lanePolicy,
    policyFingerprint: fp,
    normalizedOrigin: originValidation.normalized,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function denied(
  code: BrowserDenialReason["code"],
  message: string,
  detail?: Record<string, unknown>,
): BrowserPolicyDecision {
  return {
    authorized: false,
    denial: { code, message, detail },
    policyFingerprint: "",
  };
}

/**
 * Resolve the lane policy for a given lane from the operations policy.
 * Returns undefined if the lane is disabled.
 */
export function resolveLanePolicy(
  policy: BrowserOperationsPolicy,
  lane: BrowserLane,
): BrowserLanePolicy | undefined {
  if (!policy.enabled) return undefined;
  const lanePolicy = lane === "managed" ? policy.managed : policy.interactive;
  if (!lanePolicy.enabled) return undefined;
  return lanePolicy;
}
