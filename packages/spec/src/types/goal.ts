/**
 * @responsibility Declares the goal schema and status types.
 */
export const GOAL_SCHEMA_VERSION = "goal.v1" as const;
export const GOAL_STATUSES = ["active", "paused", "complete"] as const;
export const GOAL_REVIEW_MODES = ["auto", "hetero", "self", "off"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type GoalReviewMode = (typeof GOAL_REVIEW_MODES)[number];
export type GoalScope = { kind: "all" } | { kind: "epic"; epic: string } | { kind: "cards"; cards: string[] };
export type GoalTransitionActor = "owner" | "system" | "adjudicator" | "worker" | "agent";

export interface GoalLimits {
  maxCycles?: number;
  maxHours?: number;
}

export interface GoalUsage {
  cycles: number;
  costUsd: number;
}

export interface GoalReviewConfig {
  mode: GoalReviewMode;
}

/** The safety gate that last fired. Budget/usage cost gates are removed (the
 *  loop now stops on NO PROGRESS, not cost); the surviving gates are the
 *  cross-session no-progress breaker (`progress`) and the wall-clock `timebox`. */
export type GoalSafetyGate = "progress" | "timebox";

export interface GoalSafetySnapshot {
  lastGate: GoalSafetyGate;
  lastReason: string;
  lastAt: string;
  lastReading: string;
}

/**
 * Cross-session progress accounting — the deterministic dead-loop breaker that
 * REPLACES the removed budget ceiling as the global backstop. A `gave_up` or
 * zero-delivery terminal increments the per-card streak AND the whole-goal
 * no-progress streak; any delivery resets both. When a card's streak reaches the
 * skip threshold the card is skipped; when the whole-goal streak reaches the
 * hard breaker threshold the goal is STOPPED. Persisted on the goal so the count
 * survives resume (an unmergeable card can never spin indefinitely across
 * sessions).
 */
export interface GoalProgress {
  /** Per-card consecutive no-progress cycle count (cleared on delivery). */
  zeroStreaks?: Record<string, number>;
  /** Cards skipped after exhausting their per-card streak. */
  skippedCards?: string[];
  /** Consecutive whole-goal no-progress cycles (no card delivered). */
  noProgressCycles?: number;
}

export interface RollGoal {
  schema: typeof GOAL_SCHEMA_VERSION;
  scope: GoalScope;
  review: GoalReviewConfig;
  limits: GoalLimits;
  status: GoalStatus;
  usage: GoalUsage;
  progress?: GoalProgress;
  safety?: GoalSafetySnapshot;
  createdAt: string;
  updatedAt: string;
  lastDecisionReason?: string;
}

export interface GoalTransitionContext {
  actor: GoalTransitionActor;
  reason: string;
  at: string;
}

interface Line {
  indent: number;
  key: string;
  value: string;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const noComment = raw.replace(/\s+#.*$/, "");
    if (noComment.trim() === "") continue;
    const m = /^(\s*)([^:]+):(.*)$/.exec(noComment);
    if (m === null) continue;
    out.push({ indent: m[1]!.length, key: m[2]!.trim(), value: m[3]!.trim() });
  }
  return out;
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readTop(all: readonly Line[], key: string): string | undefined {
  return all.find((line) => line.indent === 0 && line.key === key)?.value;
}

function readNested(all: readonly Line[], parent: string, child: string): string | undefined {
  const start = all.findIndex((line) => line.indent === 0 && line.key === parent);
  if (start < 0) return undefined;
  for (let i = start + 1; i < all.length; i += 1) {
    const line = all[i]!;
    if (line.indent === 0) break;
    if (line.indent === 2 && line.key === child) return line.value;
  }
  return undefined;
}

function required(value: string | undefined, key: string): string {
  const cleaned = cleanScalar(value ?? "");
  if (cleaned === "") throw new Error(`goal.yaml invalid: missing ${key}`);
  return cleaned;
}

function optionalNumber(value: string | undefined, key: string): number | undefined {
  const cleaned = cleanScalar(value ?? "");
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) throw new Error(`goal.yaml invalid: ${key} must be a non-negative number`);
  return n;
}

function requiredNumber(value: string | undefined, key: string): number {
  const n = optionalNumber(value, key);
  if (n === undefined) throw new Error(`goal.yaml invalid: missing ${key}`);
  return n;
}

function parseList(value: string): string[] {
  const cleaned = cleanScalar(value);
  if (!cleaned.startsWith("[") || !cleaned.endsWith("]")) throw new Error("goal.yaml invalid: scope.cards must be a flow list");
  const inner = cleaned.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => cleanScalar(s.trim())).filter((s) => s !== "");
}

function parseStatus(value: string | undefined): GoalStatus {
  const status = required(value, "status");
  // Backward-compat: a goal persisted before the budget gate was removed may
  // still carry the retired `budget_limited` status. Map it to `paused` on read
  // (a stopped goal stays stopped) rather than throwing — never brick a resume.
  if (status === "budget_limited") return "paused";
  if (!GOAL_STATUSES.includes(status as GoalStatus)) throw new Error(`goal.yaml invalid: status '${status}' is not one of ${GOAL_STATUSES.join(", ")}`);
  return status as GoalStatus;
}

function parseReviewMode(value: string | undefined): GoalReviewMode {
  const mode = cleanScalar(value ?? "auto");
  if (!GOAL_REVIEW_MODES.includes(mode as GoalReviewMode)) throw new Error(`goal.yaml invalid: review '${mode}' is not one of ${GOAL_REVIEW_MODES.join(", ")}`);
  return mode as GoalReviewMode;
}

function parseScope(all: readonly Line[]): GoalScope {
  const kind = required(readNested(all, "scope", "kind"), "scope.kind");
  if (kind === "all") return { kind: "all" };
  if (kind === "epic") return { kind: "epic", epic: required(readNested(all, "scope", "epic"), "scope.epic") };
  if (kind === "cards") {
    const cards = parseList(required(readNested(all, "scope", "cards"), "scope.cards"));
    if (cards.length === 0) throw new Error("goal.yaml invalid: scope.cards must not be empty");
    return { kind: "cards", cards };
  }
  throw new Error(`goal.yaml invalid: scope.kind '${kind}' is not one of all, epic, cards`);
}

export function parseGoalYaml(text: string): RollGoal {
  const all = lines(text);
  const schema = required(readTop(all, "schema"), "schema");
  if (schema !== GOAL_SCHEMA_VERSION) throw new Error(`goal.yaml invalid: schema must be ${GOAL_SCHEMA_VERSION}`);
  const maxCycles = optionalNumber(readNested(all, "limits", "maxCycles"), "limits.maxCycles");
  const maxHours = optionalNumber(readNested(all, "limits", "maxHours"), "limits.maxHours");
  const safety = parseSafety(all);
  const progress = parseProgress(all);
  const lastDecisionReason = cleanScalar(readTop(all, "lastDecisionReason") ?? "");
  return {
    schema: GOAL_SCHEMA_VERSION,
    scope: parseScope(all),
    review: { mode: parseReviewMode(readTop(all, "review")) },
    limits: {
      ...(maxCycles !== undefined ? { maxCycles } : {}),
      ...(maxHours !== undefined ? { maxHours } : {}),
    },
    status: parseStatus(readTop(all, "status")),
    usage: {
      cycles: requiredNumber(readNested(all, "usage", "cycles"), "usage.cycles"),
      costUsd: requiredNumber(readNested(all, "usage", "costUsd"), "usage.costUsd"),
    },
    ...(progress !== undefined ? { progress } : {}),
    ...(safety !== undefined ? { safety } : {}),
    createdAt: required(readTop(all, "createdAt"), "createdAt"),
    updatedAt: required(readTop(all, "updatedAt"), "updatedAt"),
    ...(lastDecisionReason !== "" ? { lastDecisionReason } : {}),
  };
}

/**
 * Parse the optional `progress:` block (the cross-session breaker counter).
 * Tolerant of an absent block (returns undefined) and of partial fields. The
 * `zeroStreaks` child is a one-level map (`<id>: <n>` lines indented under
 * `progress: \n  zeroStreaks:`); `skippedCards` is a flow list; `noProgressCycles`
 * is a scalar.
 */
function parseProgress(all: readonly Line[]): GoalProgress | undefined {
  const start = all.findIndex((line) => line.indent === 0 && line.key === "progress");
  if (start < 0) return undefined;
  const noProgressCycles = optionalNumber(readNested(all, "progress", "noProgressCycles"), "progress.noProgressCycles");
  const skippedRaw = readNested(all, "progress", "skippedCards");
  const skippedCards = skippedRaw !== undefined && skippedRaw.trim() !== "" ? parseList(skippedRaw) : [];
  const zeroStreaks: Record<string, number> = {};
  // zeroStreaks is a nested map: find its header (indent 2 under progress), then
  // read indent-4 `<id>: <n>` lines until the block ends.
  let inZero = false;
  for (let i = start + 1; i < all.length; i += 1) {
    const line = all[i]!;
    if (line.indent === 0) break;
    if (line.indent === 2 && line.key === "zeroStreaks") {
      inZero = true;
      continue;
    }
    if (line.indent <= 2) {
      inZero = false;
      continue;
    }
    if (inZero && line.indent === 4) {
      const n = Number(cleanScalar(line.value));
      if (Number.isFinite(n) && n >= 0) zeroStreaks[line.key] = n;
    }
  }
  const hasZero = Object.keys(zeroStreaks).length > 0;
  if (!hasZero && skippedCards.length === 0 && noProgressCycles === undefined) return undefined;
  return {
    ...(hasZero ? { zeroStreaks } : {}),
    ...(skippedCards.length > 0 ? { skippedCards } : {}),
    ...(noProgressCycles !== undefined ? { noProgressCycles } : {}),
  };
}

function parseSafety(all: readonly Line[]): GoalSafetySnapshot | undefined {
  const lastGate = cleanScalar(readNested(all, "safety", "lastGate") ?? "");
  if (lastGate === "") return undefined;
  // Backward-compat: a legacy snapshot may carry a retired cost gate
  // (`budget`/`usage`). Map it to the surviving `progress` gate on read rather
  // than throwing — a stale lastGate must never brick a resume.
  const gate: GoalSafetyGate = lastGate === "timebox" ? "timebox" : "progress";
  return {
    lastGate: gate,
    lastReason: required(readNested(all, "safety", "lastReason"), "safety.lastReason"),
    lastAt: required(readNested(all, "safety", "lastAt"), "safety.lastAt"),
    lastReading: required(readNested(all, "safety", "lastReading"), "safety.lastReading"),
  };
}

function renderProgress(progress: GoalProgress | undefined): string[] {
  if (progress === undefined) return [];
  const zeroEntries = Object.entries(progress.zeroStreaks ?? {}).filter(([, n]) => n > 0);
  const skipped = progress.skippedCards ?? [];
  const noProgress = progress.noProgressCycles ?? 0;
  if (zeroEntries.length === 0 && skipped.length === 0 && noProgress === 0) return [];
  const out = ["progress:"];
  if (zeroEntries.length > 0) {
    out.push("  zeroStreaks:");
    for (const [id, n] of zeroEntries) out.push(`    ${id}: ${n}`);
  }
  if (skipped.length > 0) out.push(`  skippedCards: [${skipped.join(", ")}]`);
  if (noProgress > 0) out.push(`  noProgressCycles: ${noProgress}`);
  return out;
}

function renderScope(scope: GoalScope): string[] {
  if (scope.kind === "all") return ["scope:", "  kind: all"];
  if (scope.kind === "epic") return ["scope:", "  kind: epic", `  epic: ${scope.epic}`];
  return ["scope:", "  kind: cards", `  cards: [${scope.cards.join(", ")}]`];
}

export function renderGoalYaml(goal: RollGoal): string {
  const out = [
    `schema: ${goal.schema}`,
    ...renderScope(goal.scope),
    `review: ${goal.review.mode}`,
    "limits:",
    ...(goal.limits.maxCycles !== undefined ? [`  maxCycles: ${goal.limits.maxCycles}`] : []),
    ...(goal.limits.maxHours !== undefined ? [`  maxHours: ${goal.limits.maxHours}`] : []),
    `status: ${goal.status}`,
    "usage:",
    `  cycles: ${goal.usage.cycles}`,
    `  costUsd: ${goal.usage.costUsd}`,
    ...renderProgress(goal.progress),
    ...(goal.safety !== undefined
      ? [
          "safety:",
          `  lastGate: ${goal.safety.lastGate}`,
          `  lastReason: ${goal.safety.lastReason}`,
          `  lastAt: ${goal.safety.lastAt}`,
          `  lastReading: ${goal.safety.lastReading}`,
        ]
      : []),
    `createdAt: ${goal.createdAt}`,
    `updatedAt: ${goal.updatedAt}`,
    ...(goal.lastDecisionReason !== undefined ? [`lastDecisionReason: ${goal.lastDecisionReason}`] : []),
  ];
  return `${out.join("\n")}\n`;
}

const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "complete"],
  paused: ["active", "complete"],
  complete: [],
};

export function transitionGoal(goal: RollGoal, next: GoalStatus, ctx: GoalTransitionContext): RollGoal {
  if (goal.status === "complete") throw new Error("goal state machine: complete is terminal");
  if (!TRANSITIONS[goal.status].includes(next)) throw new Error(`goal state machine: illegal ${goal.status} -> ${next}`);
  if (next === "complete" && ctx.actor !== "adjudicator") throw new Error("goal state machine: only adjudicator may complete a goal");
  return { ...goal, status: next, updatedAt: ctx.at, lastDecisionReason: ctx.reason };
}
