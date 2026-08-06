/**
 * @responsibility Formats tool cost and status for display.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolCost } from "@roll/spec";

export interface ToolTimelineRow {
  toolId: string;
  label: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  exitCode?: number;
  retryCount?: number;
  stdout?: string;
  stderr?: string;
  dumpPath?: string;
  screenshotPath?: string;
  ts: number;
}

type ToolInvokeRecord = {
  toolId: string;
  input: unknown;
  ts: number;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toolIdFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function clip(value: string, max = 72): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clipBlock(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function inputLabel(toolId: string, input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return toolId;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "url", "path", "file_path", "query", "name"]) {
    const value = o[key];
    if (typeof value === "string" && value.trim() !== "") return `${toolId} "${clip(value)}"`;
  }
  return toolId;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}

function aggregateToolCosts(costs: readonly ToolCost[]): ToolCost[] {
  const out = new Map<string, ToolCost>();
  for (const row of costs) {
    const key = String(row.toolId);
    const prev = out.get(key);
    if (prev === undefined) {
      out.set(key, { ...row, toolId: key as ToolCost["toolId"] });
      continue;
    }
    out.set(key, {
      ...prev,
      invocations: prev.invocations + row.invocations,
      durationMs: (prev.durationMs ?? 0) + (row.durationMs ?? 0),
      failures: (prev.failures ?? 0) + (row.failures ?? 0),
      estimatedCost: prev.estimatedCost + row.estimatedCost,
      inputBytes: (prev.inputBytes ?? 0) + (row.inputBytes ?? 0),
      outputBytes: (prev.outputBytes ?? 0) + (row.outputBytes ?? 0),
      currency: prev.currency === row.currency ? prev.currency : `${prev.currency}+${row.currency}`,
    });
  }
  return [...out.values()];
}

export function formatToolCostSummary(costs: readonly ToolCost[] | undefined, separator = "·"): string {
  if (costs === undefined || costs.length === 0) return "";
  return aggregateToolCosts(costs)
    .map((row) => `${String(row.toolId)}×${row.invocations}(${duration(row.durationMs ?? 0)})`)
    .join(separator);
}

export function formatToolTimelineRow(row: ToolTimelineRow): string {
  const prefix = row.ok ? "" : "✗ ";
  const suffix = row.ok ? "" : ` ${row.errorCode ?? "unknown"}`;
  return `${prefix}${row.label} ${duration(row.durationMs)}${suffix}`;
}

function parseToolCosts(value: unknown): ToolCost[] {
  if (!Array.isArray(value)) return [];
  const rows: ToolCost[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const toolId = toolIdFrom(o["toolId"]);
    const invocations = finiteNumber(o["invocations"]);
    const estimatedCost = finiteNumber(o["estimatedCost"]);
    const currency = typeof o["currency"] === "string" && o["currency"] !== "" ? o["currency"] : "USD";
    if (toolId === undefined || invocations === undefined || estimatedCost === undefined) continue;
    rows.push({
      toolId: toolId as ToolCost["toolId"],
      invocations,
      estimatedCost,
      currency,
      ...(finiteNumber(o["durationMs"]) !== undefined ? { durationMs: finiteNumber(o["durationMs"]) } : {}),
      ...(finiteNumber(o["failures"]) !== undefined ? { failures: finiteNumber(o["failures"]) } : {}),
      ...(finiteNumber(o["inputBytes"]) !== undefined ? { inputBytes: finiteNumber(o["inputBytes"]) } : {}),
      ...(finiteNumber(o["outputBytes"]) !== undefined ? { outputBytes: finiteNumber(o["outputBytes"]) } : {}),
    });
  }
  return rows;
}

export function collectToolEvidence(projectPath: string): { timelineByCycle: Map<string, ToolTimelineRow[]>; costsByCycle: Map<string, ToolCost[]> } {
  return collectToolEvidenceFromEventsPath(join(projectPath, ".roll", "loop", "events.ndjson"));
}

export function collectToolEvidenceFromEventsPath(path: string): { timelineByCycle: Map<string, ToolTimelineRow[]>; costsByCycle: Map<string, ToolCost[]> } {
  const timelineByCycle = new Map<string, ToolTimelineRow[]>();
  const costsByCycle = new Map<string, ToolCost[]>();
  const invokes = new Map<string, ToolInvokeRecord>();
  const rollDir = dirname(dirname(path));
  if (!existsSync(path)) return { timelineByCycle, costsByCycle };
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { timelineByCycle, costsByCycle };
  }
  for (const raw of content.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    const type = event["type"];
    const cycleId = typeof event["cycleId"] === "string" ? event["cycleId"] : "";
    if (cycleId === "") continue;
    if (type === "tool:invoke") {
      const invocation = event["invocation"];
      if (invocation === null || typeof invocation !== "object" || Array.isArray(invocation)) continue;
      const inv = invocation as Record<string, unknown>;
      const invocationId = typeof inv["invocationId"] === "string" ? inv["invocationId"] : "";
      const toolId = toolIdFrom(inv["toolId"]);
      if (invocationId === "" || toolId === undefined) continue;
      invokes.set(invocationId, { toolId, input: inv["input"], ts: finiteNumber(event["ts"]) ?? 0 });
      continue;
    }
    if (type === "tool:result") {
      const invocationId = typeof event["invocationId"] === "string" ? event["invocationId"] : "";
      const result = event["result"];
      if (invocationId === "" || result === null || typeof result !== "object" || Array.isArray(result)) continue;
      const resultObj = result as Record<string, unknown>;
      const meta = resultObj["meta"];
      const metaObj = meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
      const output = resultObj["output"];
      const outputObj = output !== null && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
      const toolId = toolIdFrom(event["toolId"]) ?? toolIdFrom(metaObj["toolId"]) ?? invokes.get(invocationId)?.toolId;
      if (toolId === undefined) continue;
      const ok = resultObj["ok"] === true;
      const errorObj = resultObj["error"];
      const nestedCode = errorObj !== null && typeof errorObj === "object" && !Array.isArray(errorObj) ? (errorObj as Record<string, unknown>)["code"] : undefined;
      const errorCode = typeof resultObj["errorCode"] === "string" ? resultObj["errorCode"] : typeof nestedCode === "string" ? nestedCode : undefined;
      const start = finiteNumber(metaObj["startedAt"]);
      const end = finiteNumber(metaObj["endedAt"]);
      const attempt = finiteNumber(metaObj["attempt"]);
      const stdout = typeof outputObj["stdout"] === "string" ? clipBlock(outputObj["stdout"]) : undefined;
      const stderr = typeof outputObj["stderr"] === "string" ? clipBlock(outputObj["stderr"]) : undefined;
      const screenshotPath = typeof outputObj["screenshotPath"] === "string" && outputObj["screenshotPath"] !== "" ? outputObj["screenshotPath"] : undefined;
      const row: ToolTimelineRow = {
        toolId,
        label: inputLabel(toolId, invokes.get(invocationId)?.input),
        durationMs: finiteNumber(metaObj["durationMs"]) ?? (start !== undefined && end !== undefined ? Math.max(0, end - start) : 0),
        ok,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(finiteNumber(outputObj["exitCode"]) !== undefined ? { exitCode: finiteNumber(outputObj["exitCode"]) } : {}),
        ...(attempt !== undefined && attempt > 1 ? { retryCount: attempt - 1 } : {}),
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(toolId === "bash" ? { dumpPath: join(rollDir, "tool-dumps", `${invocationId}.log`) } : {}),
        ...(screenshotPath !== undefined ? { screenshotPath } : {}),
        ts: finiteNumber(event["ts"]) ?? finiteNumber(metaObj["endedAt"]) ?? invokes.get(invocationId)?.ts ?? 0,
      };
      const list = timelineByCycle.get(cycleId) ?? [];
      list.push(row);
      timelineByCycle.set(cycleId, list);
      continue;
    }
    if (type === "cycle:end") {
      const cost = event["cost"];
      const costObj = cost !== null && typeof cost === "object" && !Array.isArray(cost) ? (cost as Record<string, unknown>) : {};
      const rows = parseToolCosts(costObj["toolCosts"]);
      if (rows.length > 0) costsByCycle.set(cycleId, rows);
    }
  }
  for (const rows of timelineByCycle.values()) rows.sort((a, b) => a.ts - b.ts);
  return { timelineByCycle, costsByCycle };
}
