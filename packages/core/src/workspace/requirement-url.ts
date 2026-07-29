import { type NormalizedRequirementSourceReference, normalizeRequirementSourceReference } from "./requirement-source.js";

export type RequirementSourceUrlFindingCode =
  | "invalid_type"
  | "invalid_url"
  | "unsupported_provider_host"
  | "invalid_requirement_url";

export interface RequirementSourceUrlFinding {
  readonly code: RequirementSourceUrlFindingCode;
  readonly path: "url";
  readonly detail: string;
}

export type RequirementSourceUrlResult =
  | { readonly ok: true; readonly value: NormalizedRequirementSourceReference }
  | { readonly ok: false; readonly findings: readonly RequirementSourceUrlFinding[] };

function failure(code: RequirementSourceUrlFindingCode, detail: string): RequirementSourceUrlResult {
  return { ok: false, findings: [{ code, path: "url", detail }] };
}

function parsedUrl(value: unknown): URL | RequirementSourceUrlResult {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || value.length > 2_048 || /[\x00-\x1f\x7f]/u.test(value)) {
    return failure("invalid_type", "Requirement source URL must be a bounded non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return failure("invalid_url", "Requirement source URL is malformed");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    return failure("invalid_url", "Requirement source URL must use credential-free default-port HTTPS");
  }
  return parsed;
}

function jiraRequirement(parsed: URL): RequirementSourceUrlResult {
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 2 || segments[0] !== "browse" || segments[1] === undefined) {
    return failure("invalid_requirement_url", "Atlassian URL must be /browse/<jira-key>");
  }
  const normalized = normalizeRequirementSourceReference("jira", segments[1]);
  return normalized.ok
    ? normalized
    : failure("invalid_requirement_url", "Atlassian URL does not contain a complete Jira key");
}

function githubRequirement(parsed: URL): RequirementSourceUrlResult {
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 4 || segments[0] === undefined || segments[1] === undefined || segments[2] !== "issues" || segments[3] === undefined) {
    return failure("invalid_requirement_url", "GitHub URL must be /<owner>/<repo>/issues/<number>");
  }
  const normalized = normalizeRequirementSourceReference("github_issue", `${segments[0]}/${segments[1]}#${segments[3]}`);
  return normalized.ok
    ? normalized
    : failure("invalid_requirement_url", "GitHub URL does not contain a complete Issue reference");
}

/** Pure host helper: extract a closed provider ref, then delegate identity normalization. */
export function parseRequirementSourceUrl(value: unknown): RequirementSourceUrlResult {
  const parsed = parsedUrl(value);
  if (!(parsed instanceof URL)) return parsed;
  const host = parsed.hostname.toLowerCase();
  if (host === "github.com") return githubRequirement(parsed);
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/u.test(host)) return jiraRequirement(parsed);
  return failure("unsupported_provider_host", "Requirement source URL host is unsupported");
}
