/**
 * @responsibility Enforces tool-call policy, retry and sandbox defaults.
 */
import { readFile } from "node:fs/promises";
import type { ToolDefaults, ToolId, ToolPolicy, ToolRetry, ToolSandbox } from "@roll/spec";

export interface ToolPolicyEngineOptions {
  policyPath?: string;
  readFile?: (path: string) => Promise<string>;
  warn?: (message: string) => void;
}

interface Line {
  indent: number;
  text: string;
}

type FieldMap = Map<string, { value?: string; children: Line[] }>;

const TOOL_FIELDS = new Set(["enabled", "timeoutMs", "retry", "sandbox", "maxInvocationsPerCycle"]);
const RETRY_FIELDS = new Set(["attempts", "backoffMs"]);
const SANDBOX_FIELDS = new Set([
  "allowedPaths",
  "blockedCommands",
  "hardTimeoutSec",
  "maxOutputBytes",
  "allowedOrigins",
  "headlessOnly",
  "network",
]);

function stripComment(line: string): string {
  const match = /(^|\s)#/.exec(line);
  if (match === null) return line;
  return line.slice(0, match.index + (match[1]?.length ?? 0));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function linesOf(yaml: string): Line[] {
  const out: Line[] = [];
  for (const raw of yaml.split("\n")) {
    const line = stripComment(raw.replace(/\r$/, ""));
    if (line.trim() === "") continue;
    out.push({ indent: indentOf(line), text: line.trim() });
  }
  return out;
}

function splitField(text: string): { key: string; value?: string } | undefined {
  const idx = text.indexOf(":");
  if (idx < 0) return undefined;
  const key = text.slice(0, idx).trim();
  const rawValue = text.slice(idx + 1).trim();
  if (key === "") return undefined;
  return rawValue === "" ? { key } : { key, value: rawValue };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseInlineList(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((item) => unquote(item.trim()));
}

function parseList(value: string | undefined, children: readonly Line[]): string[] | undefined {
  if (value !== undefined) {
    const inline = parseInlineList(value);
    if (inline !== undefined) return inline;
    return [unquote(value)];
  }
  const out: string[] = [];
  for (const child of children) {
    if (!child.text.startsWith("- ")) continue;
    out.push(unquote(child.text.slice(2).trim()));
  }
  return out.length > 0 ? out : undefined;
}

function fieldsFrom(block: readonly Line[], baseIndent: number): FieldMap {
  const fields: FieldMap = new Map();
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (line === undefined || line.indent !== baseIndent || line.text.startsWith("- ")) continue;
    const field = splitField(line.text);
    if (field === undefined) continue;
    const children: Line[] = [];
    for (let j = i + 1; j < block.length; j++) {
      const child = block[j];
      if (child === undefined || child.indent <= line.indent) break;
      children.push(child);
    }
    fields.set(field.key, { value: field.value, children });
  }
  return fields;
}

function toolsSection(lines: readonly Line[]): Line[] {
  const start = lines.findIndex((line) => line.indent === 0 && line.text === "tools:");
  if (start < 0) return [];
  const out: Line[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.indent === 0) break;
    out.push(line);
  }
  return out;
}

function toolBlock(lines: readonly Line[], toolId: ToolId): Line[] {
  const id = String(toolId);
  const start = lines.findIndex((line) => line.indent === 2 && line.text === `${id}:`);
  if (start < 0) return [];
  const out: Line[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.indent <= 2) break;
    out.push(line);
  }
  return out;
}

function cloneSandbox(sandbox: ToolSandbox | undefined): ToolSandbox | undefined {
  if (sandbox === undefined) return undefined;
  return {
    ...sandbox,
    allowedPaths: sandbox.allowedPaths === undefined ? undefined : [...sandbox.allowedPaths],
    blockedCommands: sandbox.blockedCommands === undefined ? undefined : [...sandbox.blockedCommands],
    allowedOrigins: sandbox.allowedOrigins === undefined ? undefined : [...sandbox.allowedOrigins],
  };
}

function cloneRetry(retry: ToolRetry | undefined): ToolRetry | undefined {
  return retry === undefined ? undefined : { ...retry };
}

function defaultsToPolicy(defaults: ToolDefaults | undefined): ToolPolicy {
  return {
    enabled: defaults?.enabled ?? true,
    timeoutMs: defaults?.timeoutMs,
    retry: cloneRetry(defaults?.retry),
    sandbox: cloneSandbox(defaults?.sandbox),
    maxInvocationsPerCycle: defaults?.maxInvocationsPerCycle,
  };
}

export class ToolPolicyEngine {
  private readonly policyPath: string;
  private readonly readPolicyFile: (path: string) => Promise<string>;
  private readonly warn: (message: string) => void;

  constructor(options: ToolPolicyEngineOptions = {}) {
    this.policyPath = options.policyPath ?? ".roll/policy.yaml";
    this.readPolicyFile = options.readFile ?? ((path) => readFile(path, "utf8"));
    this.warn = options.warn ?? (() => undefined);
  }

  async resolve(toolId: ToolId, defaults: ToolDefaults | undefined): Promise<ToolPolicy> {
    const base = defaultsToPolicy(defaults);
    const yaml = await this.readPolicy();
    const tools = toolsSection(linesOf(yaml));
    if (tools.length === 0) return base;
    const block = toolBlock(tools, toolId);
    if (block.length === 0) return base;

    const fields = fieldsFrom(block, 4);
    this.warnUnknown(`tools.${String(toolId)}`, fields, TOOL_FIELDS);
    return this.mergeTool(base, fields, toolId);
  }

  private async readPolicy(): Promise<string> {
    try {
      return await this.readPolicyFile(this.policyPath);
    } catch {
      return "";
    }
  }

  private mergeTool(base: ToolPolicy, fields: FieldMap, toolId: ToolId): ToolPolicy {
    const enabled = parseBool(fields.get("enabled")?.value);
    const timeoutMs = parseInteger(fields.get("timeoutMs")?.value);
    const maxInvocationsPerCycle = parseInteger(fields.get("maxInvocationsPerCycle")?.value);
    return {
      enabled: enabled ?? base.enabled,
      timeoutMs: timeoutMs ?? base.timeoutMs,
      retry: this.mergeRetry(base.retry, fields.get("retry")?.children, toolId),
      sandbox: this.mergeSandbox(base.sandbox, fields.get("sandbox")?.children, toolId),
      maxInvocationsPerCycle: maxInvocationsPerCycle ?? base.maxInvocationsPerCycle,
    };
  }

  private mergeRetry(base: ToolRetry | undefined, lines: readonly Line[] | undefined, toolId: ToolId): ToolRetry | undefined {
    if (lines === undefined) return base;
    const fields = fieldsFrom(lines, 6);
    this.warnUnknown(`tools.${String(toolId)}.retry`, fields, RETRY_FIELDS);
    return {
      attempts: parseInteger(fields.get("attempts")?.value) ?? base?.attempts ?? 1,
      backoffMs: parseInteger(fields.get("backoffMs")?.value) ?? base?.backoffMs ?? 0,
    };
  }

  private mergeSandbox(base: ToolSandbox | undefined, lines: readonly Line[] | undefined, toolId: ToolId): ToolSandbox | undefined {
    if (lines === undefined) return base;
    const fields = fieldsFrom(lines, 6);
    this.warnUnknown(`tools.${String(toolId)}.sandbox`, fields, SANDBOX_FIELDS);
    return {
      allowedPaths: parseList(fields.get("allowedPaths")?.value, fields.get("allowedPaths")?.children ?? []) ?? base?.allowedPaths,
      blockedCommands: parseList(fields.get("blockedCommands")?.value, fields.get("blockedCommands")?.children ?? []) ?? base?.blockedCommands,
      hardTimeoutSec: parseInteger(fields.get("hardTimeoutSec")?.value) ?? base?.hardTimeoutSec,
      maxOutputBytes: parseInteger(fields.get("maxOutputBytes")?.value) ?? base?.maxOutputBytes,
      allowedOrigins: parseList(fields.get("allowedOrigins")?.value, fields.get("allowedOrigins")?.children ?? []) ?? base?.allowedOrigins,
      headlessOnly: parseBool(fields.get("headlessOnly")?.value) ?? base?.headlessOnly,
      network: fields.get("network")?.value === undefined ? base?.network : unquote(fields.get("network")?.value ?? "") as ToolSandbox["network"],
    };
  }

  private warnUnknown(scope: string, fields: FieldMap, known: ReadonlySet<string>): void {
    for (const key of fields.keys()) {
      if (!known.has(key)) this.warn(`unknown ${scope} field: ${key}`);
    }
  }
}
