/**
 * @responsibility Derives screen-lock events from the event stream.
 */
import { parseEventLine, type RollEvent } from "@roll/spec";
import { existsSync, readFileSync } from "node:fs";

type ScreenLockEvent = Extract<RollEvent, { type: "loop:screen_locked" }>;

function screenLockEvents(eventsPath: string): ScreenLockEvent[] {
  try {
    if (!existsSync(eventsPath)) return [];
    const events: ScreenLockEvent[] = [];
    for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
      const event = parseEventLine(line);
      if (event?.type === "loop:screen_locked") events.push(event);
    }
    return events;
  } catch {
    return [];
  }
}

/** Latest durable screen-lock state. The event stream is the sole state store. */
export function latestScreenLockEvent(eventsPath: string): ScreenLockEvent | null {
  const events = screenLockEvents(eventsPath);
  return events.at(-1) ?? null;
}

/** Localized status copy; event reasons remain diagnostic-only and unlocalized. */
export function screenLockWaitReason(eventsPath: string, lang: "en" | "zh"): string | null {
  const latest = latestScreenLockEvent(eventsPath);
  if (latest?.locked !== true) return null;
  return lang === "zh" ? "等待屏幕解锁" : "waiting for screen unlock";
}

/** True only when this exact cycle recorded a physical-surface lock wait. */
export function cycleWasScreenLocked(eventsPath: string, cycleId: string | undefined): boolean {
  if (cycleId === undefined || cycleId === "") return false;
  return screenLockedCycleIds(eventsPath).has(cycleId);
}

/** Cycle ids that are wait states, projected once from the append-only ledger. */
export function screenLockedCycleIds(eventsPath: string): ReadonlySet<string> {
  return new Set(
    screenLockEvents(eventsPath)
      .filter((event) => event.locked)
      .map((event) => event.cycleId),
  );
}
