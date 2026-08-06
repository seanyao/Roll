/**
 * @responsibility Provides the one command-surface truth source for the CLI.
 */
/**
 * REFACTOR-056 — the ONE command-surface truth source.
 *
 * Roll's public CLI is a short list of product nouns and actions. A command is
 * public only when a human owner should remember it as part of the main
 * workflow; everything else is nested under an owner, kept internal/machine-only,
 * or removed (historical compatibility is not a retention reason). This registry
 * records that decision once, typed, so help, docs, site, and release-consistency
 * checks can stop drifting from each other.
 *
 * Plan: .roll/features/cli-simplification/command-surface-consolidation-plan.md
 *
 * Scope of THIS card: declare the typed registry and project the public
 * top-level list into `roll --help`. Later cards (REFACTOR-057..059) consume the
 * `target`/`owner` fields to actually move routes, drop retired aliases, and
 * refresh docs — no command behavior is migrated here.
 */

/** Who a command surface is for. */
export type CommandAudience = "human" | "internal" | "hidden";

/** What should happen to a command surface. */
export type CommandDisposition = "public" | "nested" | "internal" | "remove";

/**
 * The sixteen approved public top-level commands. Every decision's `owner` is
 * one of these — a nested/internal/removed surface names the public command it
 * belongs under; a public surface owns itself.
 */
export type CommandOwner =
  | "agent"
  | "backlog"
  | "config"
  | "design"
  | "doctor"
  | "help"
  | "idea"
  | "init"
  | "loop"
  | "next"
  | "north"
  | "release"
  | "setup"
  | "status"
  | "test"
  | "update";

export interface CommandSurfaceDecision {
  /** The current command surface as a user types it today (e.g. `prices` or `loop monitor`). */
  readonly current: string;
  /** Where it should live (only meaningful for nested/internal moves); omitted for public commands that own themselves. */
  readonly target?: string;
  /** The public top-level command this surface belongs under. */
  readonly owner: CommandOwner;
  readonly audience: CommandAudience;
  readonly disposition: CommandDisposition;
  readonly rationale: string;
}

/**
 * The decision set for the REFACTOR-055 command surface. Registry order is the
 * display order for `roll --help`, so the public block is listed first in the
 * approved order. Nested/internal/removed decisions follow as recorded truth —
 * they are NOT projected into help, but later cards mechanically consume them.
 */
export const COMMAND_SURFACE: readonly CommandSurfaceDecision[] = [
  // ── Public top-level (human memory objects; the only names `roll --help` lists) ──
  { current: "agent", owner: "agent", audience: "human", disposition: "public", rationale: "Agent Scope roles and installed-agent management." },
  { current: "backlog", owner: "backlog", audience: "human", disposition: "public", rationale: "The product noun for the work queue." },
  { current: "config", owner: "config", audience: "human", disposition: "public", rationale: "Project + tool configuration root." },
  { current: "design", owner: "design", audience: "human", disposition: "public", rationale: "Launches $roll-design; a core workflow verb." },
  { current: "doctor", owner: "doctor", audience: "human", disposition: "public", rationale: "Toolchain + install diagnosis root." },
  { current: "help", owner: "help", audience: "human", disposition: "public", rationale: "Built-in documentation and command usage." },
  { current: "idea", owner: "idea", audience: "human", disposition: "public", rationale: "Capture-and-classify entry into the backlog." },
  { current: "init", owner: "init", audience: "human", disposition: "public", rationale: "Diagnose-and-route project bootstrap." },
  { current: "loop", owner: "loop", audience: "human", disposition: "public", rationale: "Autonomous backlog execution domain root." },
  { current: "next", owner: "next", audience: "human", disposition: "public", rationale: "What to work on next; a core workflow verb." },
  { current: "north", owner: "north", audience: "human", disposition: "public", rationale: "North-star terminal metrics panel for loop observability." },
  { current: "release", owner: "release", audience: "human", disposition: "public", rationale: "Release cut + consistency domain root." },
  { current: "setup", owner: "setup", audience: "human", disposition: "public", rationale: "Project/tooling setup lifecycle root." },
  { current: "status", owner: "status", audience: "human", disposition: "public", rationale: "Project health snapshot." },
  { current: "test", owner: "test", audience: "human", disposition: "public", rationale: "Run the project's tests; a core workflow verb." },
  { current: "update", owner: "update", audience: "human", disposition: "public", rationale: "Upgrade the global roll." },

  // ── Nested: useful capabilities that move under their owning command ──
  { current: "doc", target: "help", owner: "help", audience: "human", disposition: "nested", rationale: "Built-in docs belong to help, not a product noun named doc." },
  { current: "prices", target: "config prices", owner: "config", audience: "human", disposition: "nested", rationale: "Model prices are cost-accounting configuration data." },
  { current: "cast", target: "agent cast", owner: "agent", audience: "human", disposition: "nested", rationale: "Casting is an Agent Scope / role-resolution view." },
  { current: "tool", target: "doctor tools", owner: "doctor", audience: "human", disposition: "nested", rationale: "Tool readiness is a diagnosis surface." },
  { current: "pulse", target: "status pulse", owner: "status", audience: "human", disposition: "nested", rationale: "Pulse is a status projection, not an action." },
  { current: "ci", target: "status ci", owner: "status", audience: "human", disposition: "nested", rationale: "Current-commit CI state is a status projection." },
  { current: "cycles", target: "loop cycles", owner: "loop", audience: "human", disposition: "nested", rationale: "Cycle ledger belongs to the loop domain." },
  { current: "cycle", target: "loop cycle", owner: "loop", audience: "human", disposition: "nested", rationale: "Cycle trace belongs to the loop domain." },
  { current: "tune", target: "config tune", owner: "config", audience: "human", disposition: "nested", rationale: "Tuning is suggest-only policy/config advice." },
  { current: "showcase", target: "release showcase", owner: "release", audience: "human", disposition: "nested", rationale: "Golden-path E2E is release validation support." },
  { current: "offboard", target: "setup offboard", owner: "setup", audience: "human", disposition: "nested", rationale: "Offboarding is reverse setup lifecycle." },

  // ── Internal/machine: callable only while an external process boundary needs them; never advertised ──
  { current: "story", owner: "backlog", audience: "internal", disposition: "internal", rationale: "story new/validate are machine entry points under backlog." },
  { current: "attest", owner: "release", audience: "internal", disposition: "internal", rationale: "Acceptance attestation is a release-gate machine surface." },
  { current: "truth", owner: "status", audience: "internal", disposition: "internal", rationale: "truth query/audit are internal snapshot surfaces." },
  { current: "supervisor", owner: "loop", audience: "internal", disposition: "internal", rationale: "Observations surface through status/next/loop; internals stay hidden." },

  // ── Remove: redirect-only, retired, duplicate, or historical entry points ──
  { current: "alert", target: "loop alert", owner: "loop", audience: "hidden", disposition: "remove", rationale: "Redirect-only top-level alias; lives under loop." },
  { current: "version", target: "--version", owner: "update", audience: "hidden", disposition: "remove", rationale: "Alias for roll --version; not a product noun." },
  { current: "gc", target: "loop gc", owner: "loop", audience: "hidden", disposition: "remove", rationale: "Auto-runs per cycle; not a human top-level command." },
  { current: "index", owner: "status", audience: "hidden", disposition: "remove", rationale: "Machine rebuild entry point, not a human command." },
  { current: "ls", owner: "backlog", audience: "hidden", disposition: "remove", rationale: "Duplicate of backlog listing." },
  { current: "dream", owner: "loop", audience: "hidden", disposition: "remove", rationale: "Nightly self-scan runs on schedule, not as a public verb." },
  { current: "pair", owner: "loop", audience: "hidden", disposition: "remove", rationale: "Review/scoring belongs to loop/evaluator internals." },
  { current: "peer", owner: "loop", audience: "hidden", disposition: "remove", rationale: "Review/scoring belongs to loop/evaluator internals." },
];

/**
 * Validate the registry and fail LOUD on a malformed decision set — the AC's
 * "unknown or unimplemented decisions must fail loud rather than silently
 * falling back to ported-command enumeration." Runs once at module load so a bad
 * edit breaks tests immediately instead of corrupting the help projection.
 */
export function validateCommandSurface(decisions: readonly CommandSurfaceDecision[]): void {
  const seen = new Set<string>();
  for (const d of decisions) {
    if (seen.has(d.current)) {
      throw new Error(`command-surface: duplicate decision for '${d.current}'`);
    }
    seen.add(d.current);
    if (d.disposition === "public") {
      if (d.owner !== d.current) {
        throw new Error(`command-surface: public '${d.current}' must own itself (owner='${d.owner}')`);
      }
      if (d.audience !== "human") {
        throw new Error(`command-surface: public '${d.current}' must be audience 'human' (got '${d.audience}')`);
      }
    }
    if (d.disposition === "nested") {
      if (d.target === undefined || d.target.length === 0) {
        throw new Error(`command-surface: nested '${d.current}' must declare a target`);
      }
      if (d.owner === d.current) {
        throw new Error(`command-surface: nested '${d.current}' must name a different owner`);
      }
    }
  }
}

validateCommandSurface(COMMAND_SURFACE);

/**
 * The approved public top-level commands, in display order — the ONLY names
 * `roll --help` lists. Derived mechanically from the registry, never from
 * ported-command enumeration.
 */
export function publicCommands(): string[] {
  return COMMAND_SURFACE.filter((d) => d.disposition === "public").map((d) => d.current);
}

/** Look up a single decision by its current surface name. */
export function commandDecision(current: string): CommandSurfaceDecision | undefined {
  return COMMAND_SURFACE.find((d) => d.current === current);
}
