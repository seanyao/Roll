/**
 * @responsibility Exposes a closed diagnostic action facade for chrome-devtools-mcp.
 */
/**
 * US-BROW-017 — closed diagnostic action facade for chrome-devtools-mcp.
 *
 * Callers select a BrowserAction, never an MCP tool. The facade resolves that
 * action against the pinned manifest, minimizes the returned diagnostic, then
 * redacts and bounds it before the artifact writer ever receives bytes.
 */
import {
  approveBrowserAction,
  persistDiagnostic,
  type DevToolsMcpToolName,
  type DiagnosticRedactor,
} from "@roll/core";
import type { BrowserDenialReason, DiagnosticArtifactKind, DiagnosticArtifactRef } from "@roll/spec";

export interface McpDiagnosticToolCaller {
  call(tool: DevToolsMcpToolName, input: Record<string, unknown>): Promise<unknown>;
}

export interface DiagnosticArtifactWriter {
  write(input: {
    artifactId: string;
    kind: DiagnosticArtifactKind;
    bytes: Buffer;
  }): Promise<void>;
}

export interface McpDiagnosticFacadeDeps {
  caller: McpDiagnosticToolCaller;
  writer: DiagnosticArtifactWriter;
  randomId: () => string;
  redactor?: DiagnosticRedactor;
}

export interface McpDiagnosticFacadeInput {
  /** Runtime input is checked against the manifest before the caller is invoked. */
  action: string;
  payload: Record<string, string | number | boolean>;
}

export interface McpDiagnosticFacadeResult {
  status: "ok" | "denied" | "failed";
  diagnosticRefs: DiagnosticArtifactRef[];
  summary: string;
  denial?: BrowserDenialReason;
  failure?: "redaction_failed" | "artifact_write_failed" | "mcp_response_invalid";
  finalUrl?: string;
}

const ARTIFACT_KIND: Partial<Record<string, DiagnosticArtifactKind>> = {
  snapshot: "dom-snapshot",
  console: "console-summary",
  network: "network-summary",
  screenshot: "devtools-screenshot",
};

/** A bounded, one-way facade over the exact MCP tool manifest. */
export class McpDiagnosticFacade {
  constructor(private readonly deps: McpDiagnosticFacadeDeps) {}

  async execute(input: McpDiagnosticFacadeInput): Promise<McpDiagnosticFacadeResult> {
    const approved = approveBrowserAction(input.action);
    if (!("tool" in approved)) {
      return { status: "denied", diagnosticRefs: [], summary: approved.message, denial: approved };
    }

    let raw: unknown;
    try {
      raw = await this.deps.caller.call(approved.tool, toolInput(approved.kind, input.payload));
    } catch (error) {
      return {
        status: "failed",
        diagnosticRefs: [],
        summary: error instanceof Error ? error.message : "MCP diagnostic call failed",
        failure: "mcp_response_invalid",
      };
    }

    const finalUrl = extractFinalUrl(raw);
    const kind = ARTIFACT_KIND[approved.kind];
    if (kind === undefined) {
      return { status: "ok", diagnosticRefs: [], summary: `${approved.kind} completed`, ...(finalUrl === undefined ? {} : { finalUrl }) };
    }

    const bytes = normalizeArtifactBytes(approved.kind, raw);
    if (bytes === undefined) {
      return { status: "failed", diagnosticRefs: [], summary: "MCP diagnostic response was invalid", failure: "mcp_response_invalid" };
    }

    if (approved.kind === "screenshot") {
      return this.writeBinary(kind, bytes, "diagnostic screenshot recorded", finalUrl);
    }
    return this.writeText(kind, bytes.toString("utf8"), `${approved.kind} diagnostic recorded`, finalUrl);
  }

  private async writeText(
    kind: DiagnosticArtifactKind,
    raw: string,
    summary: string, finalUrl?: string,
  ): Promise<McpDiagnosticFacadeResult> {
    const artifactId = this.deps.randomId();
    const persisted = persistDiagnostic({ artifactId, kind, text: raw }, this.deps.redactor);
    if (persisted.kind === "dropped") {
      return { status: "failed", diagnosticRefs: [], summary: "Diagnostic redaction failed; artifact dropped", failure: persisted.failure };
    }
    try {
      await this.deps.writer.write({ artifactId, kind, bytes: Buffer.from(persisted.text, "utf8") });
      return { status: "ok", diagnosticRefs: [persisted.artifact], summary, ...(finalUrl === undefined ? {} : { finalUrl }) };
    } catch {
      return { status: "failed", diagnosticRefs: [], summary: "Diagnostic artifact write failed; artifact dropped", failure: "artifact_write_failed" };
    }
  }

  private async writeBinary(
    kind: DiagnosticArtifactKind,
    bytes: Buffer,
    summary: string, finalUrl?: string,
  ): Promise<McpDiagnosticFacadeResult> {
    const artifactId = this.deps.randomId();
    try {
      await this.deps.writer.write({ artifactId, kind, bytes });
    } catch {
      return { status: "failed", diagnosticRefs: [], summary: "Diagnostic artifact write failed; artifact dropped", failure: "artifact_write_failed" };
    }
    const crypto = await import("node:crypto");
    return {
      status: "ok",
      diagnosticRefs: [{
        artifactId,
        kind,
        digest: crypto.createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        untrusted: true,
        diagnosticOnly: true,
      }],
      summary, ...(finalUrl === undefined ? {} : { finalUrl }),
    };
  }
}

function toolInput(action: string, payload: Record<string, string | number | boolean>): Record<string, unknown> {
  switch (action) {
    case "navigate":
      return { url: boundedString(payload["url"], 2_048) };
    case "snapshot":
      // take_snapshot rejects unknown arguments ("selector" included) on the
      // real server — it snapshots the whole page; callers filter afterwards.
      return {};
    case "click":
      return { uid: boundedString(payload["selector"], 512) };
    case "fill":
      return { uid: boundedString(payload["selector"], 512), value: boundedString(payload["value"], 4_096) };
    case "press_key":
      return { key: boundedString(payload["key"], 64) };
    default:
      return {};
  }
}

function boundedString(value: string | number | boolean | undefined, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

/**
 * Extract the final URL from a real chrome-devtools-mcp response.
 *
 * The real server (US-BROW-020, verified live) replies in PROSE, not JSON:
 * navigate returns "Successfully navigated to <url>." plus a "## Pages" section
 * whose selected entry carries the live URL — `1: title (<url>) [selected]`.
 * Structured `finalUrl`/`url` fields are kept for the fixture seam.
 */
export function extractFinalUrl(raw: unknown): string | undefined {
  if (isRecord(raw)) {
    if (typeof raw["finalUrl"] === "string") return raw["finalUrl"];
    if (typeof raw["url"] === "string") return raw["url"];
  }
  const text = typeof raw === "string" ? raw : isRecord(raw) && typeof raw["text"] === "string" ? raw["text"] : undefined;
  if (text === undefined) return undefined;
  const selected = /^\s*\d+:.*\((\S+?)\)\s*\[selected\]\s*$/m.exec(text);
  if (selected?.[1] !== undefined) return selected[1];
  const navigated = /Successfully navigated to (\S+?)\.?\s*$/m.exec(text);
  return navigated?.[1];
}

function normalizeArtifactBytes(action: string, raw: unknown): Buffer | undefined {
  if (action === "screenshot") {
    const data = isRecord(raw) && typeof raw["data"] === "string" ? raw["data"] : undefined;
    return data === undefined ? undefined : Buffer.from(data, "base64");
  }
  if (action === "console") return Buffer.from(JSON.stringify(normalizeConsole(raw)), "utf8");
  if (action === "network") return Buffer.from(JSON.stringify(normalizeNetwork(raw)), "utf8");
  return Buffer.from(JSON.stringify(normalizeSnapshot(raw)), "utf8");
}

function normalizeSnapshot(raw: unknown): { text: string } {
  return { text: textFrom(raw).slice(0, 16 * 1024) };
}

function normalizeConsole(raw: unknown): Array<{ level: string; message: string; source?: string }> {
  const structured = asList(raw).slice(0, 50).map((entry) => {
    const value = isRecord(entry) ? entry : {};
    const source = stringField(value, "source");
    return {
      level: stringField(value, "level") ?? stringField(value, "type") ?? "info",
      message: stringField(value, "message") ?? stringField(value, "text") ?? "",
      ...(source === undefined ? {} : { source }),
    };
  });
  if (structured.length > 0) return structured;
  // Real chrome-devtools-mcp replies in prose: `msgid=1 [log] message (…)`.
  return proseLines(raw)
    .map((line) => /^msgid=\d+\s+\[(\w+)\]\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 50)
    .map((m) => ({ level: m[1] ?? "info", message: m[2] ?? "" }));
}

function normalizeNetwork(raw: unknown): Array<{ method: string; origin?: string; status?: number; duration?: number; failure?: string }> {
  const structured = asList(raw).slice(0, 50).map((entry) => {
    const value = isRecord(entry) ? entry : {};
    const url = stringField(value, "url");
    const status = numberField(value, "status");
    const duration = numberField(value, "duration");
    const failure = stringField(value, "failure");
    return {
      method: stringField(value, "method") ?? "GET",
      ...(url === undefined ? {} : { origin: originOf(url) }),
      ...(status === undefined ? {} : { status }),
      ...(duration === undefined ? {} : { duration }),
      ...(failure === undefined ? {} : { failure }),
    };
  });
  if (structured.length > 0) return structured;
  // Real chrome-devtools-mcp replies in prose: `reqid=1 GET http://… [200]`.
  return proseLines(raw)
    .map((line) => /^reqid=\d+\s+(\w+)\s+(\S+)\s+\[(\d+)\]/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 50)
    .map((m) => ({
      method: m[1] ?? "GET",
      ...(m[2] === undefined ? {} : { origin: originOf(m[2]) }),
      ...(m[3] === undefined ? {} : { status: Number(m[3]) }),
    }));
}

/** Split a prose (text) MCP reply into trimmed lines; [] for non-text replies. */
function proseLines(raw: unknown): string[] {
  const text = typeof raw === "string" ? raw : isRecord(raw) && typeof raw["text"] === "string" ? raw["text"] : undefined;
  return text === undefined ? [] : text.split("\n").map((line) => line.trim());
}

function asList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const key of ["messages", "requests", "items", "result"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  return [];
}

function textFrom(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isRecord(raw) && typeof raw["text"] === "string") return raw["text"];
  return JSON.stringify(raw) ?? "";
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "invalid";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
