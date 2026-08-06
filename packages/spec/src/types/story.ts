/**
 * @responsibility Declares the backlog and story contract types.
 */
/** Backlog contracts (BC1, I9). */
export type StoryId = string;

export type TaskLevel = "epic" | "feature" | "story" | "action";

export type StoryStatus = "todo" | "in_progress" | "done" | "hold" | "cut";

/**
 * The single canonical markdown marker for each {@link StoryStatus}. This is the
 * ONE source of truth every writer (picker/reconcile/executor) and renderer
 * consumes — no consumer may hardcode a status literal of its own (REFACTOR-047).
 */
export const STATUS_MARKER: Record<StoryStatus, string> = {
  todo: "📋 Todo",
  in_progress: "🔨 In Progress",
  done: "✅ Done",
  hold: "🚫 Hold",
  cut: "🗑️ Cut",
};

/** FIX-909: visible awaiting-review marker. It is intentionally re-pickable. */
export const AWAITING_REVIEW_STATUS_MARKER = "⏳ 待复评";

/**
 * Legacy / alias markers that older backlog rows (and the divergent showcase
 * reset) wrote, mapped onto their canonical {@link StoryStatus}. This is the ONE
 * tolerance table: every reader recognizes these, every writer emits the
 * canonical {@link STATUS_MARKER} instead (FIX-300). They are NOT canonical — the
 * enum has only `todo | in_progress | done | hold` — but they must not vanish
 * silently from a backlog row.
 *
 * `🚧 WIP` and `🔄 In Progress` both meant "work underway" → `in_progress`;
 * `⏳ Hold` was the old hourglass hold → `hold`; `✔️ Done` was an alternate
 * checkmark → `done`. `🔒 Blocked` / `⏸ Deferred` are historical triage markers
 * that fold into `hold` (no separate deferred state; all three mean "parked").
 */
export const LEGACY_STATUS_MARKERS: ReadonlyArray<{ marker: string; status: StoryStatus }> = [
  { marker: "✔️ Done", status: "done" },
  { marker: "🚧 WIP", status: "in_progress" },
  { marker: "🔄 In Progress", status: "in_progress" },
  { marker: "⏳ Hold", status: "hold" },
  { marker: "🔒 Blocked", status: "hold" },
  { marker: "⏸ Deferred", status: "hold" },
];

/**
 * One regex matching every status marker token — canonical and legacy alike —
 * built from the single-source {@link STATUS_MARKER} + {@link LEGACY_STATUS_MARKERS}
 * tables (FIX-300). Each alternative tolerates any inter-glyph whitespace
 * (`✅  Done` vs `✅ Done`). Use {@link findStatusMarker} to extract the token
 * from a backlog row, or {@link STATUS_MARKER_RE} directly to test/replace.
 *
 * Order matters: terminal/longer markers (`✅ Done`, `✔️ Done`, `🔄 In Progress`)
 * precede shorter ones so the alternation never matches a prefix of a longer
 * token. A fresh, non-global instance is returned to avoid shared `lastIndex`.
 */
const STATUS_MARKER_ALTERNATIVES: ReadonlyArray<{ marker: string; status: StoryStatus }> = [
  // Canonical first (these are what writers emit), then legacy aliases.
  { marker: STATUS_MARKER.done, status: "done" },
  { marker: STATUS_MARKER.in_progress, status: "in_progress" },
  { marker: STATUS_MARKER.hold, status: "hold" },
  { marker: STATUS_MARKER.cut, status: "cut" },
  { marker: STATUS_MARKER.todo, status: "todo" },
  { marker: AWAITING_REVIEW_STATUS_MARKER, status: "todo" },
  ...LEGACY_STATUS_MARKERS,
];

/** Turn a marker like `📋 Todo` into a regex source tolerant of inter-glyph spaces. */
function markerToPattern(marker: string): string {
  return marker
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(" *");
}

const STATUS_MARKER_RE_SOURCE = `(${STATUS_MARKER_ALTERNATIVES.map((a) => markerToPattern(a.marker)).join("|")})`;

/** Build a fresh, non-global regex (callers that need `g` should pass true). */
export function statusMarkerRe(global = false): RegExp {
  return new RegExp(STATUS_MARKER_RE_SOURCE, global ? "g" : undefined);
}

/** A non-global instance for tests/callers that only need `.test()` / `.exec()`. */
export const STATUS_MARKER_RE: RegExp = statusMarkerRe(false);

/**
 * Find the (canonical or legacy) status marker token in a backlog row, normalized
 * to single inter-glyph spaces (e.g. `✅  Done` → `✅ Done`). Returns `undefined`
 * when no recognized marker is present. This is the ONE extractor the showcase
 * reset and status readers share so they can never diverge again (FIX-300).
 */
export function findStatusMarker(line: string): string | undefined {
  const m = statusMarkerRe(false).exec(line);
  if (m === null || m[1] === undefined) return undefined;
  return m[1].replace(/\s+/g, " ").trim();
}

/**
 * The ONE parser from a raw backlog status cell to the typed {@link StoryStatus}.
 *
 * Keys on the LEADING marker glyph — the status emoji appears only as the marker,
 * never in the human reason text, so a hold whose reason reads "…全 Done 后…" is
 * not misread as done (the loose-substring bug). Canonical markers
 * ({@link STATUS_MARKER}) and legacy aliases ({@link LEGACY_STATUS_MARKERS}) are
 * recognized identically — `✔️ Done` is as much done as `✅ Done`, `🚧 WIP` /
 * `🔄 In Progress` are in_progress, `⏳ Hold` / `🔒 Blocked` / `⏸ Deferred` fold
 * into `hold`. Falls back to the status WORD (terminal states first) only for
 * emoji-less cells. Returns `null` for an unrecognized cell so callers fail loud
 * rather than silently dropping a row (the v2 renderer's blindness to `🚫 Hold`
 * bug).
 */
export function classifyStatus(cell: string): StoryStatus | null {
  if (cell.includes(AWAITING_REVIEW_STATUS_MARKER)) return "todo";
  if (cell.includes("✅") || cell.includes("✔️") || cell.includes("✔")) return "done";
  if (cell.includes("🔨") || cell.includes("🔄") || cell.includes("🚧")) return "in_progress";
  if (cell.includes("🗑️") || cell.includes("🗑")) return "cut";
  if (
    cell.includes("🚫") ||
    cell.includes("🔒") ||
    cell.includes("⏸") ||
    cell.includes("⏳")
  )
    return "hold";
  if (cell.includes("📋")) return "todo";
  // Emoji-less fallback: match the status word, most-specific terminal first.
  if (cell.includes("Done")) return "done";
  if (cell.includes("In Progress") || cell.includes("WIP")) return "in_progress";
  if (cell.includes("Cut")) return "cut";
  if (cell.includes("Hold") || cell.includes("Blocked") || cell.includes("Deferred")) return "hold";
  if (cell.includes("Todo")) return "todo";
  return null;
}

export type StoryType = "US" | "FIX" | "REFACTOR" | "IDEA";

/**
 * The reason a backlog has (or lacks) pickable work — derived from a full
 * status histogram, not just the eligibility gate (US-LOOP-079b).
 * Priority order (first match wins) is the declaration order below.
 */
export type BacklogReason =
  | "has_work" // ≥1 row passes all 5 eligibility gates
  | "all_blocked_by_deps" // Todo rows exist, but all fail on depends-on
  | "all_awaiting_merge" // Todo rows exist, but all have an open PR
  | "all_merged_pending" // Todo rows exist, but all have a merged delivery
  | "all_skip_listed" // Todo rows exist, but all are on the runtime skip-list
  | "all_pending_publish" // Todo rows exist, but all have unpublished local work
  | "all_leased" // Todo rows exist, but all are held by an active delivery lease (US-DELIV-005)
  | "screen_locked" // Todo rows exist, but all require a physical surface while the screen is locked (FIX-1268)
  | "all_in_progress" // No Todo rows, but in_progress/hold rows exist
  | "all_done" // No Todo/in_progress/hold rows; all remaining are Done
  | "backlog_empty"; // No rows at all

export interface Story {
  id: StoryId;
  description: string;
  status: StoryStatus;
  /** IDs that must be done before this story may be picked. */
  dependsOn: StoryId[];
  /** Picker must skip these outright (human-reserved). */
  manualOnly?: boolean;
}
