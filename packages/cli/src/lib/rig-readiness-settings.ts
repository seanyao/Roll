/**
 * @responsibility Loads the read-only machine-local rig readiness limits.
 */
/** US-DELTA-017 — read-only machine-local readiness limits loader. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateRigReadinessLimits } from "@roll/core";
import type { RigReadinessLimits } from "@roll/spec";

export function loadRigReadinessLimits(root = process.env["ROLL_HOME"] ?? join(homedir(), ".roll")): RigReadinessLimits {
  const path = join(root, "config.yaml");
  if (!existsSync(path)) return validated(undefined, path);
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s*delta_rig_readiness:\s*(?:#.*)?$/.test(line));
  if (start < 0) return validated(undefined, path);
  const parentIndent = lines[start]!.search(/\S/);
  const block: Record<string, unknown> = {};
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent <= parentIndent) break;
    const match = /^\s*([^:#]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (match === null) throw new Error(`${path}:${index + 1}: invalid delta_rig_readiness field`);
    const field = match[1]!.trim();
    const raw = match[2]!;
    if (raw === "true" || raw === "false" || raw === "null" || raw === "") block[field] = raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : "";
    else if (/^-?\d+$/.test(raw)) block[field] = Number(raw);
    else block[field] = raw;
  }
  return validated(block, path);
}

function validated(value: unknown, path: string): RigReadinessLimits {
  const result = validateRigReadinessLimits(value);
  if (!result.ok) throw new Error(`${path}: delta_rig_readiness.${result.field}: ${result.detail}`);
  return result.limits;
}
