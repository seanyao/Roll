import {
  BacklogStore,
  ConflictError,
  appendIdea,
  decideCorrectionAction,
  nextIdeaId,
  parsePolicy,
  type CorrectionActuatorMode,
  type CorrectionDecision,
} from "@roll/core";
import { classifyStatus, parseEventLine, STATUS_MARKER, type RollEvent } from "@roll/spec";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyCorrectionFailure } from "./failure-attribution.js";

export interface ApplyCorrectionInput {
  projectPath: string;
  eventsPath: string;
  alertsPath: string;
  storyId: string;
  cycleId?: string;
  reasons: readonly string[];
  nowSec?: number;
}

export type CorrectionMutation =
  | "none"
  | "alert_only"
  | "created_fix"
  | "existing_fix"
  | "returned_story"
  | "human_override";

export interface ApplyCorrectionResult extends CorrectionDecision {
  mutation: CorrectionMutation;
  fixId?: string;
}

interface CorrectionConsensus {
  allowed: boolean;
  reason: string;
}

type PairVerdictEvent = Extract<RollEvent, { type: "pair:verdict" }>;

function readMode(projectPath: string): CorrectionActuatorMode {
  try {
    const path = join(projectPath, ".roll", "policy.yaml");
    if (!existsSync(path)) return "conservative";
    return parsePolicy(readFileSync(path, "utf8")).loopSafety.correctionActuator;
  } catch {
    return "conservative";
  }
}

function readEvents(eventsPath: string): RollEvent[] {
  try {
    return readFileSync(eventsPath, "utf8")
      .split("\n")
      .map(parseEventLine)
      .filter((ev): ev is RollEvent => ev !== null);
  } catch {
    return [];
  }
}

function reviewConsensus(events: readonly RollEvent[], cycleId: string | undefined): CorrectionConsensus {
  if (cycleId === undefined || cycleId === "") {
    return { allowed: false, reason: "missing cycle id" };
  }
  const verdicts = events.filter((ev): ev is PairVerdictEvent => {
    if (ev.type !== "pair:verdict") return false;
    if (ev.cycleId !== cycleId) return false;
    return ev.stage === undefined || ev.stage === "review";
  });
  if (verdicts.length === 0) return { allowed: false, reason: "no review consensus" };
  const peers = Array.from(new Set(verdicts.map((ev) => ev.peer)));
  if (peers.length < 2) {
    return { allowed: false, reason: `insufficient heterogeneous review peers: ${peers.join(", ")}` };
  }
  const nonAgree = verdicts.filter((ev) => ev.verdict !== "agree");
  if (nonAgree.length > 0) {
    return { allowed: false, reason: `review disagreement: ${nonAgree.map((ev) => `${ev.peer}:${ev.verdict}`).join(", ")}` };
  }
  return { allowed: true, reason: `all review peers agree: ${peers.join(", ")}` };
}

function appendEvent(eventsPath: string, event: RollEvent): void {
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* best-effort trace; the cycle terminal result still owns fail-loud state */
  }
}

function appendAlert(alertsPath: string, msg: string): void {
  try {
    mkdirSync(dirname(alertsPath), { recursive: true });
    appendFileSync(alertsPath, `${msg}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

function markStoryTodo(projectPath: string, storyId: string): CorrectionMutation {
  try {
    const path = join(projectPath, ".roll", "backlog.md");
    const store = new BacklogStore();
    const snap = store.readBacklog(path);
    const row = snap.items.find((it) => it.id === storyId);
    if (row === undefined) return "alert_only";
    if (classifyStatus(row.status) === "hold") return "human_override";
    store.markExact(path, snap.hash, storyId, STATUS_MARKER.todo);
    return "returned_story";
  } catch {
    return "alert_only";
  }
}

function storyEpic(projectPath: string, storyId: string): string {
  try {
    const idx = JSON.parse(readFileSync(join(projectPath, ".roll", "index.json"), "utf8")) as Record<string, unknown>;
    const epic = idx[storyId];
    if (typeof epic === "string" && epic.trim() !== "") return epic;
  } catch {
    /* fall through to directory scan */
  }
  try {
    const features = join(projectPath, ".roll", "features");
    for (const d of readdirSync(features, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (existsSync(join(features, d.name, storyId))) return d.name;
    }
  } catch {
    /* absent */
  }
  return "uncategorized";
}

function existingFixId(projectPath: string, storyId: string, signal: string): string | undefined {
  try {
    const snap = new BacklogStore().readBacklog(join(projectPath, ".roll", "backlog.md"));
    return snap.items.find((it) => {
      const desc = it.desc.toLowerCase();
      if (!it.id.startsWith("FIX-")) return false;
      if (!desc.includes("autofix")) return false;
      if (!desc.includes(`fixes:${storyId.toLowerCase()}`)) return false;
      if (!desc.includes(`signal:${signal.toLowerCase()}`)) return false;
      return classifyStatus(it.status) !== "done";
    })?.id;
  } catch {
    return undefined;
  }
}

function fixDescription(storyId: string, signal: string): string {
  return `autofix [roll:manual-merge] fixes:${storyId} signal:${signal} evidence correction`;
}

function writeFixSpec(projectPath: string, epic: string, fixId: string, decision: CorrectionDecision): void {
  try {
    const dir = join(projectPath, ".roll", "features", epic, fixId);
    mkdirSync(dir, { recursive: true });
    const body = [
      "---",
      `id: ${fixId}`,
      `title: Auto-fix ${decision.storyId} ${decision.signal}`,
      "type: fix",
      `epic: ${epic}`,
      `created: ${new Date(Date.now()).toISOString().slice(0, 10)}`,
      "---",
      "",
      `# ${fixId} - Auto-fix ${decision.storyId}`,
      "",
      "**Source:**",
      `- fixes: ${decision.storyId}`,
      `- signal: ${decision.signal}`,
      "- autofix",
      "- [roll:manual-merge]",
      "",
      "**Attribution:**",
      `- source: ${decision.source}`,
      `- layer: ${decision.attribution.layer}`,
      `- reason: ${decision.reason}`,
      ...decision.attribution.evidence.map((e) => `- evidence: ${e}`),
      "",
      "**AC:**",
      `- [ ] Reproduce and fix ${decision.signal} for ${decision.storyId}`,
      "- [ ] Produce fresh acceptance evidence before marking Done",
      "- [ ] Leave the PR open for human merge approval",
      "",
    ].join("\n");
    writeFileSync(join(dir, "spec.md"), body, "utf8");
  } catch {
    /* card folder is best-effort; backlog row + event remain the source */
  }
}

function createFix(projectPath: string, decision: CorrectionDecision): { mutation: CorrectionMutation; fixId?: string } {
  const existing = existingFixId(projectPath, decision.storyId, decision.signal);
  if (existing !== undefined) return { mutation: "existing_fix", fixId: existing };
  const path = join(projectPath, ".roll", "backlog.md");
  const store = new BacklogStore();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const snap = store.readBacklog(path);
      const again = snap.items.find((it) => {
        const desc = it.desc.toLowerCase();
        return (
          it.id.startsWith("FIX-") &&
          desc.includes("autofix") &&
          desc.includes(`fixes:${decision.storyId.toLowerCase()}`) &&
          desc.includes(`signal:${decision.signal.toLowerCase()}`) &&
          classifyStatus(it.status) !== "done"
        );
      });
      if (again !== undefined) return { mutation: "existing_fix", fixId: again.id };
      const fixId = nextIdeaId(snap.items, "FIX");
      store.writeBacklog(path, snap.hash, (content) => appendIdea(content, fixId, "bug", fixDescription(decision.storyId, decision.signal)).content);
      writeFixSpec(projectPath, storyEpic(projectPath, decision.storyId), fixId, decision);
      return { mutation: "created_fix", fixId };
    } catch (e) {
      if (e instanceof ConflictError && attempt === 0) continue;
      return { mutation: "alert_only" };
    }
  }
  return { mutation: "alert_only" };
}

/** FIX-386: mark a story Hold when a bounded-retry signal exhausts its budget.
 *  Only applies when retryBudget === 0 (the escalation threshold). */
function markStoryHold(projectPath: string, storyId: string, reason: string): CorrectionMutation {
  try {
    const path = join(projectPath, ".roll", "backlog.md");
    const store = new BacklogStore();
    const snap = store.readBacklog(path);
    const row = snap.items.find((it) => it.id === storyId);
    if (row === undefined) return "alert_only";
    if (classifyStatus(row.status) === "hold") return "human_override";
    store.markExact(path, snap.hash, storyId, `${STATUS_MARKER.hold} [low-review-score: ${reason.slice(0, 80)}]`);
    return "returned_story";
  } catch {
    return "alert_only";
  }
}

function mutationForAction(projectPath: string, decision: CorrectionDecision): { mutation: CorrectionMutation; fixId?: string } {
  if (decision.action === "open_fix") return createFix(projectPath, decision);
  if (decision.action === "return_story") return { mutation: markStoryTodo(projectPath, decision.storyId) };
  // FIX-386: when review_score_regression exhausts its retry budget, mark Hold
  // instead of silently alerting. The story stays parked until a human un-holds.
  if (decision.action === "route_adjust" && decision.signal === "review_score_regression" && decision.retryBudget === 0) {
    return { mutation: markStoryHold(projectPath, decision.storyId, decision.reason) };
  }
  if (decision.action === "route_adjust") return { mutation: "alert_only" };
  return { mutation: decision.plannedAction === "alert_only" ? "none" : "alert_only" };
}

export function applyCorrectionAction(input: ApplyCorrectionInput): ApplyCorrectionResult {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const events = readEvents(input.eventsPath);
  const decision = decideCorrectionAction({
    storyId: input.storyId,
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    reasons: input.reasons,
    mode: readMode(input.projectPath),
    events,
  });
  const consensus = reviewConsensus(events, input.cycleId);
  const effectiveDecision: CorrectionDecision =
    decision.mode === "auto" && decision.action !== "alert_only" && !consensus.allowed
      ? { ...decision, action: "alert_only" }
      : decision;
  const failure = classifyCorrectionFailure(decision.signal);
  const mutation = mutationForAction(input.projectPath, effectiveDecision);
  const targetId = mutation.fixId;
  appendEvent(input.eventsPath, {
    type: "correction:action",
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    storyId: input.storyId,
    action: effectiveDecision.action,
    plannedAction: decision.plannedAction,
    signal: decision.signal,
    reason: decision.reason,
    mode: decision.mode,
    source: decision.source,
    failureClass: failure.failureClass,
    rootCauseKey: failure.rootCauseKey,
    ...(targetId !== undefined ? { targetId } : {}),
    ts: now,
  });
  appendAlert(
    input.alertsPath,
    `correction actuator: ${decision.mode}/${effectiveDecision.action} for ${input.storyId} ` +
      `signal=${decision.signal} mutation=${mutation.mutation}` +
      (targetId !== undefined ? ` target=${targetId}` : "") +
      (decision.mode === "auto" && decision.action !== "alert_only"
        ? ` consensus=${consensus.allowed ? "allowed" : "denied"} (${consensus.reason})`
        : "") +
      ` reason=${decision.reason}`,
  );
  return { ...decision, action: effectiveDecision.action, mutation: mutation.mutation, ...(targetId !== undefined ? { fixId: targetId } : {}) };
}
