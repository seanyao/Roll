/**
 * @responsibility Appends terminal and delivery facts atomically to the immutable event stream.
 * EventBus (write side) — TS port of the v2 loop's event-append + runs.jsonl
 * upsert primitives. The published language (BC7, I8): every loop appends
 * RollEvents to events.ndjson; all state rebuilds from this stream, no cache.
 *
 * v2 oracle (frozen bash, bin/roll):
 *   - `_loop_event <stage> <label> <detail> <outcome>` (bin/roll:7902-7989):
 *     resolves the events file under the project-local `.roll/loop/` runtime dir
 *     (env `ROLL_PROJECT_RUNTIME_DIR` honoured by the dashboard resolver), falls
 *     back to the shared root for transient slugs; `mkdir -p` + `touch` the file
 *     (FIX-157 ensure-exists self-heal) before a single `>> "$evfile"` append.
 *     FIX-067: NO flock — a write() of one ndjson line (well under PIPE_BUF) to an
 *     O_APPEND fd is atomic across concurrent writers. {@link appendEvent}.
 *   - `_loop_event_rotate <f>` (bin/roll:7991-8004): at >10 MiB, rotate
 *     `.4→rm, .3→.4, .2→.3, .1→.2, current→.1`, keeping the last 5 segments.
 *     Here we expose the awareness — {@link ROTATE_LIMIT_BYTES} +
 *     {@link rotationNeeded} + {@link rotationPlan} — so a caller can mirror it.
 *   - `_runs_append` dedupe (bin/roll:8538-8556): `grep -qF '"run_id":"<rid>"'`
 *     and RETURN EARLY if the row already exists — an idempotent upsert keyed by
 *     `run_id` (derived from the cycle id). The v3 contract refines the key to
 *     (storyId + cycleId) per the card. {@link upsertRun}.
 *   - cycle-start ensure-both-files-exist (FIX-157): {@link ensureEventFiles}.
 *
 * Invariant I8 (append atomic; exit writes final state unconditionally): this
 * module provides the `appendEvent` / `upsertRun` / `ensureEventFiles`
 * PRIMITIVES; the trap discipline that calls them on every exit path lives in
 * the loop runner. The atomicity guarantee is documented above and realised by
 * the injected {@link EventStore.appendLine} (single O_APPEND write).
 *
 * Typing uses @roll/spec {@link RollEvent} + {@link parseEventLine}: appended
 * events are serialized RollEvents; the upsert reads runs.jsonl rows as opaque
 * JSON objects (the runs schema is bash-defined and wider than RollEvent).
 *
 * Purity: the bus holds no clock and no filesystem of its own — `now`/`ts` live
 * inside the events the caller builds, and all I/O flows through the injected
 * {@link EventStore} so the append + dedupe semantics are unit-testable.
 */
import { type RollEvent, eventTsMs, parseEventLine } from "@roll/spec";
import { type EventStore, nodeEventStore } from "./infra-default.js";

/** Rotation threshold — 10 MiB, mirroring `_loop_event_rotate` (>10485760). */
export const ROTATE_LIMIT_BYTES = 10 * 1024 * 1024;

/** Number of rotated segments kept (`.1`..`.4` plus the live file). */
export const ROTATE_KEEP = 5;

/** Standard runtime file names under `<project>/.roll/loop/`. */
export const EVENTS_FILE = "events.ndjson";
export const RUNS_FILE = "runs.jsonl";

/** Serialize one {@link RollEvent} to its ndjson line (newline-terminated). */
export function serializeEvent(event: RollEvent): string {
  return `${JSON.stringify(normalizeEventTs(event))}\n`;
}

// FIX-1490: one definition of the ms contract, shared with the read side
// (`parseEventLine`). The private copy that used to live here is gone — two
// copies is how the two sides drifted in the first place.
const epochMs = eventTsMs;

/**
 * Normalize an event's timestamps onto the epoch-ms contract. Exported (FIX-1490)
 * so writers that cannot go through {@link EventBus} still share ONE
 * implementation instead of hand-rolling `appendFileSync` with a raw seconds
 * clock — which is exactly how 5,483 historical events ended up in seconds.
 */
export function normalizeEventTs(event: RollEvent): RollEvent {
  if (event.type === "cycle:terminal") {
    return {
      ...event,
      startedAt: epochMs(event.startedAt),
      endedAt: epochMs(event.endedAt),
      ts: epochMs(event.ts),
    };
  }
  return { ...event, ts: epochMs(event.ts) } as RollEvent;
}

/** Is `f` over the rotation threshold? (size injected — pure). */
export function rotationNeeded(sizeBytes: number): boolean {
  return sizeBytes > ROTATE_LIMIT_BYTES;
}

/**
 * The rename plan mirroring `_loop_event_rotate`, oldest-first so a caller can
 * apply it sequentially without clobbering: `[rm .4]`, then `.3→.4, .2→.3,
 * .1→.2`, then `current→.1`, then re-create `current`. Returned as explicit
 * steps for the (impure) caller to execute via its FS port.
 */
export type RotationStep =
  | { op: "remove"; path: string }
  | { op: "rename"; from: string; to: string }
  | { op: "create"; path: string };

export function rotationPlan(path: string): RotationStep[] {
  const steps: RotationStep[] = [{ op: "remove", path: `${path}.${ROTATE_KEEP - 1}` }];
  for (let i = ROTATE_KEEP - 2; i >= 1; i--) {
    steps.push({ op: "rename", from: `${path}.${i}`, to: `${path}.${i + 1}` });
  }
  steps.push({ op: "rename", from: path, to: `${path}.1` });
  steps.push({ op: "create", path });
  return steps;
}

/** Key that identifies a run row for the idempotent upsert (FIX-157 self-heal). */
export interface RunKey {
  storyId: string;
  cycleId: string;
}

/** A runs.jsonl row — opaque JSON object (bash-defined schema, wider than RollEvent). */
export type RunRow = Record<string, unknown>;

/** Build the (storyId+cycleId) dedupe token used to match an existing row. */
function runToken(key: RunKey): string {
  return `${key.storyId}\t${key.cycleId}`;
}

function rowToken(row: RunRow): string | null {
  const story = row["story_id"] ?? row["storyId"] ?? row["routed_story"];
  const cycle = row["cycle_id"] ?? row["cycleId"];
  if (typeof story !== "string" || typeof cycle !== "string") return null;
  return `${story}\t${cycle}`;
}

/** The event bus write side, bound to an {@link EventStore} (Node by default). */
export class EventBus {
  constructor(private readonly store: EventStore = nodeEventStore) {}

  /**
   * Ensure both runtime files exist (FIX-157 self-heal at cycle start): a
   * missing target silently drops `>>` appends in launchd+inner contexts, so
   * the runner touches both up front. Idempotent.
   */
  ensureEventFiles(eventsPath: string, runsPath: string): void {
    this.store.ensureFile(eventsPath);
    this.store.ensureFile(runsPath);
  }

  /**
   * Append one {@link RollEvent} to `eventsPath` as a single atomic O_APPEND
   * write (I8). Ensures the file exists first (FIX-157). Returns the serialized
   * line for the caller / tests.
   */
  appendEvent(eventsPath: string, event: RollEvent): string {
    const line = serializeEvent(event);
    this.store.ensureFile(eventsPath);
    this.store.appendLine(eventsPath, line);
    return line;
  }

  /**
   * US-CYCLE-013 — append one {@link RollEvent} with an explicit fsync before
   * returning. Used ONLY for scheduler decision appends (admission, promotion,
   * queueing): the durable append is the linearization point, so a crash must
   * not lose it (all other event writes keep the plain atomic
   * {@link appendEvent}). Fails loud when the injected store cannot fsync.
   */
  appendEventSynced(eventsPath: string, event: RollEvent): string {
    const line = serializeEvent(event);
    this.store.ensureFile(eventsPath);
    if (this.store.appendLineSynced === undefined) {
      throw new Error("EventBus.appendEventSynced: store does not support synced append");
    }
    this.store.appendLineSynced(eventsPath, line);
    return line;
  }

  /** Current size of the events file (0 when absent) — rotation awareness. */
  eventsSize(eventsPath: string): number {
    return this.store.size(eventsPath);
  }

  /**
   * Read + parse all valid {@link RollEvent} lines from `eventsPath`. Bad lines
   * are skipped (parseEventLine returns null), never thrown — readers must
   * always succeed rebuilding from the stream (I8).
   */
  readEvents(eventsPath: string): RollEvent[] {
    const text = this.store.readText(eventsPath);
    const out: RollEvent[] = [];
    for (const line of text.split("\n")) {
      const ev = parseEventLine(line);
      if (ev !== null) out.push(ev);
    }
    return out;
  }

  /**
   * Append a runs.jsonl row keyed by (storyId + cycleId). US-TRUTH-019:
   * append-only — a single atomic O_APPEND write, no read-modify-write.
   * Same (storyId, cycleId) may produce multiple rows; {@link readRuns}
   * resolves last-wins on read.
   *
   * Returns "appended" (always — the caller's port already returns void).
   * The row is serialized with story_id / cycle_id stamped so readers can
   * re-derive the dedupe token.
   */
  upsertRun(runsPath: string, key: RunKey, row: RunRow): "appended" {
    this.store.ensureFile(runsPath);
    const merged: RunRow = { ...row, story_id: key.storyId, cycle_id: key.cycleId };
    const line = `${JSON.stringify(merged)}\n`;
    this.store.appendLine(runsPath, line);
    return "appended";
  }

  /**
   * Read all runs.jsonl rows, last-wins by (story_id, cycle_id).
   * US-TRUTH-019: rows with the same (story_id, cycle_id) dedupe to the
   * LAST occurrence (file order). Rows without a valid (story_id, cycle_id)
   * token pass through unmerged (they can't collide). Blank / unparseable
   * lines are skipped.
   */
  readRuns(runsPath: string): RunRow[] {
    const raw = this.readRunsRaw(runsPath);
    const lastWins = new Map<string, RunRow>();
    const unkeyed: RunRow[] = [];
    for (const row of raw) {
      const token = rowToken(row);
      if (token !== null) {
        lastWins.set(token, row);
      } else {
        unkeyed.push(row);
      }
    }
    return [...unkeyed, ...lastWins.values()];
  }

  /**
   * Read all runs.jsonl rows raw (no dedup). Consumers that need the full
   * append-only history for forensics / migration can use this; most
   * consumers want {@link readRuns} (last-wins).
   */
  readRunsRaw(runsPath: string): RunRow[] {
    const text = this.store.readText(runsPath);
    const out: RunRow[] = [];
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      try {
        out.push(JSON.parse(raw) as RunRow);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  }
}
