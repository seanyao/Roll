/** US-DELTA-018 — pure, human-only localized Delta rig readiness projection. */
import { projectRigReadiness, type RigCacheStatus } from "@roll/core";
import { t, v3Catalog, type Lang } from "@roll/spec";
import type { RigReadinessCandidate, RigReadinessSnapshot } from "@roll/spec";

export interface RenderRigReadinessInput {
  readonly candidates: readonly RigReadinessCandidate[];
  readonly snapshot: RigReadinessSnapshot | null;
  readonly cache: RigCacheStatus;
  readonly lang: Lang;
}

type RenderedState = "ready" | "blocked" | "unknown";

/** Render an entirely one-locale diagnostic; it has no JSON or lifecycle API. */
export function renderRigReadiness(input: RenderRigReadinessInput): string {
  const T = (key: string, ...args: Array<string | number>): string => t(v3Catalog, input.lang, key, ...args);
  if (input.candidates.length === 0) {
    return `${T("delta.rigs.title_empty")}\n\n${T("delta.rigs.no_candidates")}\n${T("delta.rigs.disclaimer")}\n`;
  }

  const observedAt = input.cache.kind === "current" && input.snapshot !== null ? input.snapshot.observedAt : undefined;
  const lines = [observedAt === undefined ? T("delta.rigs.title_cache", cacheTitle(T, input.cache)) : T("delta.rigs.title_observed", observedAt)];
  if (input.cache.kind !== "current") lines.push(T(`delta.rigs.cache.${input.cache.kind}`, ...(input.cache.kind === "stale" ? [formatAge(input.cache.ageMs)] : [])));

  const groups = new Map<RenderedState, Array<ReturnType<typeof projectRigReadiness>[number]>>([
    ["ready", []], ["blocked", []], ["unknown", []],
  ]);
  for (const view of projectRigReadiness(input.candidates, input.snapshot, input.cache)) {
    const state: RenderedState = input.cache.kind === "current" && view.observation !== null ? view.observation.outcome : "unknown";
    groups.get(state)!.push(view);
  }
  for (const state of ["ready", "blocked", "unknown"] as const) {
    const views = groups.get(state)!;
    if (views.length === 0) continue;
    lines.push("", T(`delta.rigs.group.${state}`));
    for (const view of views) {
      lines.push(`  ${view.candidate.adapter} / ${view.candidate.configuredModelId}`);
      lines.push(`    ${T("delta.rigs.roles")}: ${view.candidate.roles.map((role) => T(`delta.rigs.role.${role}`)).join(", ")}`);
      const observation = view.observation;
      if (state === "ready" && observation !== null) {
        const probeDetail = T(`delta.rigs.reason.${observation.reasonCode}`);
        const decoratedProbeDetail = input.lang === "zh" ? `（${probeDetail}）` : ` (${probeDetail})`;
        lines.push(`    ${T("delta.rigs.probe")}: ${T("delta.rigs.state.ready")}${decoratedProbeDetail}`);
        lines.push(`    ${T("delta.rigs.observed")}: ${input.snapshot!.observedAt}${observation.latencyMs === undefined ? "" : ` · ${observation.latencyMs}ms`}`);
      } else {
        const reason = view.reasonCode;
        lines.push(`    ${T("delta.rigs.reason")}: ${T(`delta.rigs.reason.${reason}`)}`);
        if (observation !== null) lines.push(`    ${T("delta.rigs.observed")}: ${input.snapshot!.observedAt}`);
      }
    }
  }
  lines.push("", T("delta.rigs.disclaimer"));
  return `${lines.join("\n")}\n`;
}

function cacheTitle(T: (key: string, ...args: Array<string | number>) => string, cache: RigCacheStatus): string {
  switch (cache.kind) {
    case "missing": return T("delta.rigs.state.unknown");
    case "stale": return T("delta.rigs.state.unknown");
    case "incompatible": return T("delta.rigs.state.unknown");
    case "current": return T("delta.rigs.state.ready");
  }
}

function formatAge(ageMs: number): string {
  return `${Math.max(0, Math.floor(ageMs / 1000))}s`;
}
