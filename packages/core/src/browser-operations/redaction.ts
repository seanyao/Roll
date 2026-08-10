/**
 * @responsibility Redacts untrusted diagnostic artifacts before they enter the ledger.
 * US-BROW-005 — diagnostic artifacts are untrusted and secret-free before
 * they can enter the Browser Operations ledger.
 */
import { createHash } from "node:crypto";
import type { DiagnosticArtifactKind, DiagnosticArtifactRef } from "@roll/spec";

export const MAX_DIAGNOSTIC_TEXT_BYTES = 4 * 1024;

/** A diagnostic is inert text, never executable/trusted/evidence-bearing. */
export const DIAGNOSTIC_PRESENTATION = {
  contentType: "text/plain",
  executable: false,
  trustedHtml: false,
  acceptanceEvidence: false,
} as const;

export interface DiagnosticInput {
  artifactId: string;
  kind: DiagnosticArtifactKind;
  text: string;
}

export type PersistDiagnosticResult =
  | { kind: "stored"; artifact: DiagnosticArtifactRef; text: string; untrusted: true; presentation: typeof DIAGNOSTIC_PRESENTATION }
  | { kind: "dropped"; failure: "redaction_failed" };

export type DiagnosticRedactor = (text: string) => string;

/** Redact credentials and bearer-like values from untrusted browser output. */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/"(cookie|set-cookie|authorization|password|passwd|token|access_token|refresh_token|api[_-]?key)"\s*:\s*"(?:\\.|[^"\\])*"/gim, '"$1":"[REDACTED]"')
    .replace(/^(cookie|set-cookie)\s*:\s*[^\r\n]*/gim, "$1: [REDACTED]")
    .replace(/^(authorization)\s*:\s*[^\r\n]*/gim, "$1: [REDACTED]")
    .replace(/\b(password|passwd|token|access_token|refresh_token|api[_-]?key)\s*([:=])\s*[^\s&;,\r\n]*/gim, "$1$2[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:eyJ|e30)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

/**
 * Redact and bound a diagnostic before persistence. A redactor exception (or
 * invalid output) is fail-closed: no artifact survives the failed path.
 */
export function persistDiagnostic(
  input: DiagnosticInput,
  redactor: DiagnosticRedactor = redactDiagnostic,
): PersistDiagnosticResult {
  try {
    const redacted = redactor(input.text);
    if (typeof redacted !== "string") return { kind: "dropped", failure: "redaction_failed" };
    const text = truncateUtf8(redacted, MAX_DIAGNOSTIC_TEXT_BYTES);
    const bytes = Buffer.byteLength(text, "utf8");
    return {
      kind: "stored",
      artifact: {
        artifactId: input.artifactId,
        kind: input.kind,
        digest: createHash("sha256").update(text, "utf8").digest("hex"),
        bytes,
        untrusted: true,
        diagnosticOnly: true,
      },
      text,
      untrusted: true,
      presentation: DIAGNOSTIC_PRESENTATION,
    };
  } catch {
    return { kind: "dropped", failure: "redaction_failed" };
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}
