import { createHash } from "node:crypto";
import type { ContextDiagnosticV1, ContextReadFileV1 } from "@roll/spec";
import {
  isReadableLlmWikiPath,
  LLM_WIKI_REQUIRED_PATHS,
  planLlmWikiRevisionPaths,
} from "./context-ref.js";
import { parseContextPageMetadata } from "./page-metadata.js";

export { LLM_WIKI_REQUIRED_PATHS, planLlmWikiRevisionPaths } from "./context-ref.js";

export const LLM_WIKI_MAX_FILE_BYTES = 256 * 1024;
export const LLM_WIKI_MAX_PAGES = 32;
export const LLM_WIKI_MAX_PROVIDER_BYTES = 2 * 1024 * 1024;

export interface FixedRevisionBlobFact {
  readonly path: string;
  readonly objectType: "blob";
  readonly mode: "100644" | "100755" | "120000";
  readonly bytes: number;
  readonly content: string | Uint8Array;
}

export interface ValidateLlmWikiRevisionInput {
  readonly providerId: string;
  readonly entrypoints?: readonly string[];
  readonly refs?: readonly string[];
  readonly files: readonly FixedRevisionBlobFact[];
}

export interface LlmWikiRevisionValidationV1 {
  readonly valid: boolean;
  readonly paths: readonly string[];
  readonly files: readonly ContextReadFileV1[];
  readonly diagnostics: readonly ContextDiagnosticV1[];
}

const SPECIAL_PAGES = new Set<string>(LLM_WIKI_REQUIRED_PATHS);
const decoder = new TextDecoder("utf-8", { fatal: true });

function diagnostic(
  input: ValidateLlmWikiRevisionInput,
  code: ContextDiagnosticV1["code"],
  message: string,
  path?: string,
): LlmWikiRevisionValidationV1 {
  return {
    valid: false,
    paths: [],
    files: [],
    diagnostics: [{
      code,
      severity: "blocking",
      providerId: input.providerId,
      ...(path === undefined ? {} : { ref: `context://${input.providerId}/${path}` }),
      message,
    }],
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function decode(content: string | Uint8Array): string | undefined {
  try {
    if (typeof content === "string") return hasUnpairedSurrogate(content) ? undefined : content;
    return decoder.decode(content);
  } catch {
    return undefined;
  }
}

function normalizedText(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function orderedFiles(paths: readonly string[], files: readonly FixedRevisionBlobFact[]): readonly FixedRevisionBlobFact[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return paths.flatMap((path) => {
    const file = byPath.get(path);
    return file === undefined ? [] : [file];
  });
}

/**
 * Validate already-read blob facts from exactly one resolved Git revision.
 * This pure function never resolves paths, reads a working tree, or executes Git.
 */
export function validateLlmWikiRevision(input: ValidateLlmWikiRevisionInput): LlmWikiRevisionValidationV1 {
  const paths = planLlmWikiRevisionPaths(input.entrypoints, input.refs);
  if (paths.some((path) => !isReadableLlmWikiPath(path))) {
    return diagnostic(input, "invalid_context_ref", "Context path is not readable by the LLM Wiki provider");
  }
  if (input.files.length > LLM_WIKI_MAX_PAGES) {
    return diagnostic(input, "context_budget_exceeded", "Context Provider page budget exceeded");
  }

  const seen = new Set<string>();
  let declaredTotal = 0;
  for (const file of input.files) {
    if (!isReadableLlmWikiPath(file.path) || seen.has(file.path)) {
      return diagnostic(input, "invalid_context_ref", "Context path is not readable by the LLM Wiki provider");
    }
    seen.add(file.path);
    if (file.mode === "120000") {
      return diagnostic(input, "context_symlink_rejected", "Git symlink is not readable Context content", file.path);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LLM_WIKI_MAX_FILE_BYTES) {
      return diagnostic(input, "context_file_too_large", "Context file exceeds the per-file byte limit", file.path);
    }
    declaredTotal += file.bytes;
    if (declaredTotal > LLM_WIKI_MAX_PROVIDER_BYTES) {
      return diagnostic(input, "context_budget_exceeded", "Context Provider byte budget exceeded");
    }
  }

  const missingLayout = LLM_WIKI_REQUIRED_PATHS.find((path) => !seen.has(path));
  if (missingLayout !== undefined) {
    return diagnostic(input, "invalid_wiki_layout", "LLM Wiki required layout is incomplete");
  }
  const missingRequested = paths.find((path) => !seen.has(path));
  if (missingRequested !== undefined) {
    return diagnostic(input, "context_file_missing", "Context file is missing at the resolved revision", missingRequested);
  }
  const planned = new Set(paths);
  if (input.files.some((file) => !planned.has(file.path))) {
    return diagnostic(input, "invalid_context_ref", "Fixed-revision blob set contains an unplanned Context path");
  }

  const output: ContextReadFileV1[] = [];
  let actualTotal = 0;
  for (const file of orderedFiles(paths, input.files)) {
    const decoded = decode(file.content);
    if (decoded === undefined) {
      return diagnostic(input, "invalid_page_frontmatter", "Context page is not valid UTF-8", file.path);
    }
    const content = normalizedText(decoded);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > LLM_WIKI_MAX_FILE_BYTES) {
      return diagnostic(input, "context_file_too_large", "Context file exceeds the per-file byte limit", file.path);
    }
    actualTotal += bytes;
    if (actualTotal > LLM_WIKI_MAX_PROVIDER_BYTES) {
      return diagnostic(input, "context_budget_exceeded", "Context Provider byte budget exceeded");
    }

    if (SPECIAL_PAGES.has(file.path)) {
      output.push({
        ref: `context://${input.providerId}/${file.path}`,
        path: file.path,
        sha256: sha256(content),
        bytes,
        content,
      });
      continue;
    }

    const parsed = parseContextPageMetadata(content);
    if (!parsed.valid || parsed.metadata === undefined) {
      const message = parsed.reason === "restricted_reference"
        ? "Restricted Context page must contain opaque references only"
        : "Context page frontmatter is invalid";
      return diagnostic(input, "invalid_page_frontmatter", message, file.path);
    }
    output.push({
      ref: `context://${input.providerId}/${file.path}`,
      path: file.path,
      sha256: sha256(content),
      bytes,
      page: parsed.metadata,
      content,
    });
  }

  return { valid: true, paths, files: output, diagnostics: [] };
}
