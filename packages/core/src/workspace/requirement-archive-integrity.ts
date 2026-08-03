import {
  REQUIREMENT_ARCHIVE_AUDIT_V1,
  type RequirementArchiveAudit,
  type RequirementArchiveFinding,
  type RequirementArchiveFindingCode,
} from "@roll/spec";

export interface RequirementArchiveIntegrityFacts {
  readonly requirementId: string;
  readonly checkedRevisions: readonly string[];
  readonly findings: readonly RequirementArchiveFinding[];
}

const FINDING_ORDER: Readonly<Record<RequirementArchiveFindingCode, number>> = {
  manifest_invalid: 0,
  unsafe_archive_path: 1,
  archive_changed_during_read: 2,
  revision_missing: 3,
  revision_metadata_mismatch: 4,
  content_digest_mismatch: 5,
  context_digest_mismatch: 6,
};

const UNTRUSTED_FINDINGS = new Set<RequirementArchiveFindingCode>([
  "manifest_invalid",
  "unsafe_archive_path",
  "archive_changed_during_read",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedFindings(
  findings: readonly RequirementArchiveFinding[],
  checkedRevisions: readonly string[],
): readonly RequirementArchiveFinding[] {
  const revisionOrder = new Map(checkedRevisions.map((revision, index) => [revision, index]));
  return findings.slice().sort((left, right) => {
    const leftRevision = left.revision === undefined ? -1 : (revisionOrder.get(left.revision) ?? Number.MAX_SAFE_INTEGER);
    const rightRevision = right.revision === undefined ? -1 : (revisionOrder.get(right.revision) ?? Number.MAX_SAFE_INTEGER);
    return leftRevision - rightRevision ||
      FINDING_ORDER[left.code] - FINDING_ORDER[right.code] ||
      compareText(left.evidencePath, right.evidencePath);
  });
}

export function classifyRequirementArchiveIntegrity(
  facts: RequirementArchiveIntegrityFacts,
): RequirementArchiveAudit {
  const checkedRevisions = [...facts.checkedRevisions];
  const findings = sortedFindings(facts.findings, checkedRevisions);
  const status = findings.some((finding) => UNTRUSTED_FINDINGS.has(finding.code))
    ? "untrusted"
    : findings.length > 0 ? "corrupt" : "healthy";
  return {
    schema: REQUIREMENT_ARCHIVE_AUDIT_V1,
    requirementId: facts.requirementId,
    status,
    checkedRevisions,
    findings,
  };
}
