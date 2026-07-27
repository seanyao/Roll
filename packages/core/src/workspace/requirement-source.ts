import { createHash } from "node:crypto";
import {
  REQUIREMENT_ATTEST_PROJECTION_V1,
  REQUIREMENT_SOURCE_V1,
  isSafeGitRef,
  type RequirementContextDescriptor,
  type CampaignDeliveryTarget,
  type RequirementEvidenceDescriptor,
  type RequirementPreviousRevision,
  type RequirementProvider,
  type RequirementSourceManifest,
} from "@roll/spec";

export const MAX_REQUIREMENT_CONTEXT_FILES = 64;
export const MAX_REQUIREMENT_CONTEXT_BYTES = 1024 * 1024;
export const MAX_REQUIREMENT_BODY_BYTES = 4 * 1024 * 1024;

export interface RequirementCaptureFacts {
  readonly provider: string;
  readonly ref: string;
  readonly revision: string;
  readonly capturedAt: string;
  readonly requirement: RequirementEvidenceDescriptor;
  readonly context: readonly RequirementContextDescriptor[];
  readonly stories: readonly string[];
  readonly deliveryTarget?: CampaignDeliveryTarget;
}

export type RequirementCaptureOutcome = "created" | "reused" | "linked" | "updated";

export interface RequirementCapturePlan {
  readonly outcome: RequirementCaptureOutcome;
  readonly historyRevision: string | null;
  readonly manifest: RequirementSourceManifest;
}

export type RequirementCaptureErrorCode =
  | "invalid_provider"
  | "unsafe_reference"
  | "invalid_value"
  | "unsafe_path"
  | "duplicate_context"
  | "context_limit"
  | "identity_mismatch"
  | "revision_conflict";

export interface RequirementCaptureError {
  readonly code: RequirementCaptureErrorCode;
  readonly path: string;
  readonly message: string;
}

export type RequirementCaptureResult =
  | { readonly ok: true; readonly value: RequirementCapturePlan }
  | { readonly ok: false; readonly errors: readonly RequirementCaptureError[] };

export interface NormalizedRequirementSourceReference {
  readonly provider: RequirementProvider;
  readonly ref: string;
  readonly requirementId: string;
}

export type RequirementSourceReferenceResult =
  | { readonly ok: true; readonly value: NormalizedRequirementSourceReference }
  | { readonly ok: false; readonly errors: readonly RequirementCaptureError[] };

const PROVIDERS: Readonly<Record<string, RequirementProvider>> = {
  jira: "jira",
  github: "github_issue",
  "github-issue": "github_issue",
  github_issue: "github_issue",
  file: "local_file",
  "local-file": "local_file",
  local_file: "local_file",
  user: "user_input",
  "user-input": "user_input",
  user_input: "user_input",
};

function normalizedProvider(value: string): RequirementProvider | undefined {
  return PROVIDERS[value.trim().toLowerCase()];
}

function isSafeOpaqueValue(value: string): boolean {
  return value === value.trim() && value !== "" && !/[\x00-\x1f\x7f]/u.test(value);
}

function isCredentialShaped(value: string): boolean {
  return /:\/\//u.test(value) ||
    /(?:^|[?&;#\s_-])(?:access|api)?[_-]?(?:token|key)=/iu.test(value) ||
    /(?:^|[?&;#\s_-])(?:authorization|credential|password|secret)=?/iu.test(value);
}

function isSafeRelativePath(value: string): boolean {
  if (!isSafeOpaqueValue(value) || value.startsWith("/") || value.startsWith("~") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function isSafeStoryId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requirementId(provider: RequirementProvider, ref: string): string {
  const digest = createHash("sha256").update(`${provider}\0${ref}`).digest("hex").slice(0, 12);
  return `req-${digest}`;
}

function normalizedReference(provider: RequirementProvider, value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (provider === "jira") return normalized.toUpperCase();
  if (provider === "github_issue") return normalized.toLowerCase();
  return normalized;
}

export function normalizeRequirementSourceReference(
  providerInput: string,
  refInput: string,
): RequirementSourceReferenceResult {
  const errors: RequirementCaptureError[] = [];
  const provider = normalizedProvider(providerInput);
  if (provider === undefined) {
    errors.push({ code: "invalid_provider", path: "provider", message: "Requirement source provider is unsupported" });
  }
  if (!isSafeOpaqueValue(refInput) || isCredentialShaped(refInput)) {
    errors.push({ code: "unsafe_reference", path: "ref", message: "Requirement source reference is unsafe" });
  }
  if (provider === undefined || errors.length > 0) return { ok: false, errors };
  const ref = normalizedReference(provider, refInput);
  if (provider === "jira" && !/^[A-Z][A-Z0-9]+-[0-9]+$/u.test(ref)) {
    return { ok: false, errors: [{ code: "unsafe_reference", path: "ref", message: "Jira source reference is invalid" }] };
  }
  if (provider === "github_issue" && !/^[^/#\s]+\/[^/#\s]+#[0-9]+$/u.test(ref)) {
    return { ok: false, errors: [{ code: "unsafe_reference", path: "ref", message: "GitHub Issue source reference is invalid" }] };
  }
  return { ok: true, value: { provider, ref, requirementId: requirementId(provider, ref) } };
}

export function requirementRevisionKey(revision: string): string {
  return `rev-${createHash("sha256").update(revision.normalize("NFC")).digest("hex")}`;
}

function normalizeContext(
  entries: readonly RequirementContextDescriptor[],
  errors: RequirementCaptureError[],
): readonly RequirementContextDescriptor[] {
  if (entries.length > MAX_REQUIREMENT_CONTEXT_FILES) {
    errors.push({ code: "context_limit", path: "context", message: "Requirement context exceeds the file-count limit" });
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized = entries.map((entry, index) => {
    if (!isSafeRelativePath(entry.path)) {
      errors.push({ code: "unsafe_path", path: `context[${index}].path`, message: "Requirement context path must be safe and relative" });
    }
    if (seen.has(entry.path)) {
      errors.push({ code: "duplicate_context", path: `context[${index}].path`, message: "Requirement context paths must be unique" });
    }
    seen.add(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      errors.push({ code: "invalid_value", path: `context[${index}].bytes`, message: "Requirement context bytes must be non-negative" });
    } else {
      totalBytes += entry.bytes;
    }
    if (!isDigest(entry.sha256)) {
      errors.push({ code: "invalid_value", path: `context[${index}].sha256`, message: "Requirement context digest must be lowercase SHA-256" });
    }
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
  });
  if (totalBytes > MAX_REQUIREMENT_CONTEXT_BYTES) {
    errors.push({ code: "context_limit", path: "context", message: "Requirement context exceeds the total byte limit" });
  }
  return normalized.slice().sort((left, right) => compareText(left.path, right.path));
}

function normalizeStories(stories: readonly string[], errors: RequirementCaptureError[]): readonly string[] {
  for (const [index, storyId] of stories.entries()) {
    if (!isSafeStoryId(storyId)) {
      errors.push({ code: "invalid_value", path: `stories[${index}]`, message: "Story ID contains unsafe characters" });
    }
  }
  return [...new Set(stories)].sort(compareText);
}

function evidenceEqual(left: RequirementSourceManifest, right: RequirementSourceManifest): boolean {
  return left.requirement.bytes === right.requirement.bytes &&
    left.requirement.sha256 === right.requirement.sha256 &&
    JSON.stringify(left.context) === JSON.stringify(right.context);
}

function sameIdentity(left: RequirementSourceManifest, right: RequirementSourceManifest): boolean {
  return left.requirementId === right.requirementId && left.provider === right.provider && left.ref === right.ref;
}

function unionStories(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])].sort(compareText);
}

function previousRevisions(
  existing: RequirementSourceManifest,
): readonly RequirementPreviousRevision[] {
  const revisions = [...existing.previousRevisions, { revision: existing.revision, capturedAt: existing.capturedAt }];
  const seen = new Set<string>();
  return revisions.filter((entry) => {
    if (seen.has(entry.revision)) return false;
    seen.add(entry.revision);
    return true;
  });
}

export function planRequirementCapture(
  facts: RequirementCaptureFacts,
  existing?: RequirementSourceManifest,
): RequirementCaptureResult {
  const errors: RequirementCaptureError[] = [];
  const source = normalizeRequirementSourceReference(facts.provider, facts.ref);
  if (!source.ok) errors.push(...source.errors);
  if (!isSafeOpaqueValue(facts.revision) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(facts.revision)) {
    errors.push({ code: "invalid_value", path: "revision", message: "Requirement source revision is invalid" });
  }
  if (!isSafeOpaqueValue(facts.capturedAt)) {
    errors.push({ code: "invalid_value", path: "capturedAt", message: "Requirement capture time is invalid" });
  }
  if (!Number.isSafeInteger(facts.requirement.bytes) || facts.requirement.bytes < 0) {
    errors.push({ code: "invalid_value", path: "requirement.bytes", message: "Requirement bytes must be non-negative" });
  }
  if (!isDigest(facts.requirement.sha256)) {
    errors.push({ code: "invalid_value", path: "requirement.sha256", message: "Requirement digest must be lowercase SHA-256" });
  }
  const context = normalizeContext(facts.context, errors);
  const stories = normalizeStories(facts.stories, errors);
  if (facts.deliveryTarget !== undefined && (
    facts.deliveryTarget.terminal !== "campaign_branch" ||
    facts.deliveryTarget.mainMerge !== "forbidden" ||
    !isSafeGitRef(facts.deliveryTarget.branch)
  )) {
    errors.push({ code: "invalid_value", path: "deliveryTarget", message: "Campaign delivery target must name a safe branch and forbid main merge" });
  }
  if (!source.ok || errors.length > 0) return { ok: false, errors };

  const deliveryTarget = facts.deliveryTarget ?? existing?.deliveryTarget;
  const manifest: RequirementSourceManifest = {
    schema: REQUIREMENT_SOURCE_V1,
    requirementId: source.value.requirementId,
    provider: source.value.provider,
    ref: source.value.ref,
    revision: facts.revision,
    capturedAt: facts.capturedAt,
    previousRevisions: [],
    requirement: { bytes: facts.requirement.bytes, sha256: facts.requirement.sha256 },
    context,
    stories,
    attest: {
      schema: REQUIREMENT_ATTEST_PROJECTION_V1,
      mode: "generated_aggregate",
      evidenceAuthority: "issue",
    },
    ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
  };
  if (existing === undefined) return { ok: true, value: { outcome: "created", historyRevision: null, manifest } };
  if (!sameIdentity(existing, manifest)) {
    return { ok: false, errors: [{ code: "identity_mismatch", path: "ref", message: "Requirement source identity does not match existing evidence" }] };
  }

  const linkedStories = unionStories(existing.stories, manifest.stories);
  if (existing.revision === manifest.revision) {
    if (!evidenceEqual(existing, manifest)) {
      return { ok: false, errors: [{ code: "revision_conflict", path: "revision", message: "The same revision cannot replace different evidence" }] };
    }
    if (
      existing.deliveryTarget !== undefined && facts.deliveryTarget !== undefined &&
      JSON.stringify(existing.deliveryTarget) !== JSON.stringify(facts.deliveryTarget)
    ) {
      return { ok: false, errors: [{ code: "revision_conflict", path: "deliveryTarget", message: "An existing campaign delivery target cannot be replaced at the same revision" }] };
    }
    const deliveryTargetChanged = JSON.stringify(existing.deliveryTarget) !== JSON.stringify(manifest.deliveryTarget);
    if (JSON.stringify(linkedStories) === JSON.stringify(existing.stories) && !deliveryTargetChanged) {
      return { ok: true, value: { outcome: "reused", historyRevision: null, manifest: existing } };
    }
    return {
      ok: true,
      value: {
        outcome: "linked",
        historyRevision: null,
        manifest: {
          ...existing,
          stories: linkedStories,
          ...(manifest.deliveryTarget === undefined ? {} : { deliveryTarget: manifest.deliveryTarget }),
        },
      },
    };
  }

  return {
    ok: true,
    value: {
      outcome: "updated",
      historyRevision: existing.revision,
      manifest: {
        ...manifest,
        previousRevisions: previousRevisions(existing),
        stories: linkedStories,
      },
    },
  };
}

export function resolveRequirementSourcesForStory(
  manifests: readonly RequirementSourceManifest[],
  storyId: string,
): readonly RequirementSourceManifest[] {
  return manifests
    .filter((manifest) => manifest.stories.includes(storyId))
    .slice()
    .sort((left, right) => compareText(left.provider, right.provider) || compareText(left.ref, right.ref));
}

export function renderRequirementAttestProjection(
  manifest: RequirementSourceManifest,
): string {
  const storyLines = manifest.stories.length === 0
    ? ["- none"]
    : manifest.stories.map((storyId) => `- ${storyId}: no evidence captured yet`);
  return [
    `# Requirement ${manifest.provider}:${manifest.ref} attestation`,
    "",
    "> Generated pending projection. Issue-owned evidence remains authoritative.",
    "",
    `Revision: ${manifest.revision}`,
    "Linked Stories:",
    ...storyLines,
    "",
  ].join("\n");
}
