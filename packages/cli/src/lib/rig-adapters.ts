/**
 * @responsibility Maps machine-local configured-model rig adapters.
 */
/** US-DELTA-017 — machine-local, versioned configured-model adapter mapping. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RIG_ADAPTERS_SCHEMA } from "@roll/spec";
import type { RigAdapterMapping } from "@roll/spec";
import { validateRigAdapterMappings } from "@roll/core";

/** Provider vocabulary belongs at the CLI boundary, never in @roll/core. */
export const SUPPORTED_RIG_ADAPTERS = ["claude", "codex", "pi", "kimi", "reasonix", "cursor"] as const;

export function rigAdaptersPath(root = process.env["ROLL_HOME"] ?? join(homedir(), ".roll")): string {
  return join(root, "delta-team", "rig-adapters.yaml");
}

export function loadRigAdapterMappings(root?: string): RigAdapterMapping[] {
  const path = rigAdaptersPath(root);
  if (!existsSync(path)) return [];
  return parseRigAdapterMappings(readFileSync(path, "utf8"), path);
}

/** Parse the deliberately small YAML shape accepted for rig-adapters.yaml. */
export function parseRigAdapterMappings(text: string, filePath = "rig-adapters.yaml"): RigAdapterMapping[] {
  const lines = text.split("\n");
  const significant = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (significant < 0 || lines[significant]!.trim() !== `schema: ${RIG_ADAPTERS_SCHEMA}`) {
    throw new Error(`${filePath}:${significant < 0 ? 1 : significant + 1}: expected schema: ${RIG_ADAPTERS_SCHEMA}`);
  }
  const mappings: RigAdapterMapping[] = [];
  let current: MappingDraft | undefined;
  let sawMappings = false;
  const finish = (line: number): void => {
    if (current === undefined) return;
    if (current.configuredModelId === undefined || current.adapter === undefined || current.cliModelId === undefined) {
      throw new Error(`${filePath}:${line}: mapping requires configuredModelId, adapter, and cliModelId`);
    }
    mappings.push(current as RigAdapterMapping);
    current = undefined;
  };
  for (let index = significant + 1; index < lines.length; index++) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === "mappings:" || trimmed === "mappings: []") {
      sawMappings = true;
      continue;
    }
    const match = /^(\s*)-\s*([^:]+):\s*(.*)$/.exec(raw);
    if (match !== null) {
      finish(index + 1);
      current = { [match[2]!.trim()]: parseScalar(match[3]!) };
      continue;
    }
    const field = /^\s+([^:]+):\s*(.*)$/.exec(raw);
    if (field !== null && current !== undefined) {
      const key = field[1]!.trim();
      if (key === "configuredModelId" || key === "adapter" || key === "cliModelId") current[key] = parseScalar(field[2]!);
      continue;
    }
    throw new Error(`${filePath}:${index + 1}: invalid rig-adapters.yaml syntax`);
  }
  finish(lines.length);
  if (!sawMappings) throw new Error(`${filePath}: missing mappings field`);
  const validation = validateRigAdapterMappings(mappings, SUPPORTED_RIG_ADAPTERS);
  if (!validation.ok) throw new Error(`${validation.detail}`);
  return [...validation.mappings];
}

interface MappingDraft {
  configuredModelId?: string;
  adapter?: string;
  cliModelId?: string;
}

function parseScalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
