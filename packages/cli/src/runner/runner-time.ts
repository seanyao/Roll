/**
 * @responsibility Provides runner time and cycle timing helpers.
 */
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Ports } from "./ports.js";

export function epochMs(ts: number): number {
  return ts >= 1_000_000_000_000 ? ts : ts * 1000;
}

export function eventTs(ports: Ports): number {
  return epochMs(ports.clock());
}

export function guardRuntimeDir(ports: Ports): string {
  const primary = dirname(ports.paths.eventsPath);
  try {
    mkdirSync(primary, { recursive: true });
    return primary;
  } catch {
    return join(ports.repoCwd, ".roll", "loop");
  }
}
