import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  serializeWorkspaceManifest,
  type WorkspaceMetadataReferenceIndex,
} from "@roll/core";
import {
  parseWorkspaceManifest,
  type WorkspaceEditPlan,
  type WorkspaceManifest,
} from "@roll/spec";
import {
  withWorkspaceAuthorityLock,
  WorkspaceAuthorityLockError,
} from "./workspace-authority-lock.js";

const WORKSPACE_EDIT_JOURNAL_V1 = "roll.workspace-edit-journal/v1" as const;

export type WorkspaceEditTransactionErrorCode =
  | "concurrent_edit"
  | "manifest_changed"
  | "edit_plan_changed"
  | "metadata_referenced"
  | "reference_index_invalid"
  | "partial_apply_recovered"
  | "io_failure";

export class WorkspaceEditTransactionError extends Error {
  constructor(
    readonly code: WorkspaceEditTransactionErrorCode,
    message: string,
    readonly action?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceEditTransactionError";
  }
}

export type WorkspaceEditTransactionPhase =
  | "journal_prepared"
  | "manifest_temp_fsynced"
  | "manifest_renamed"
  | "manifest_verified"
  | "journal_committed"
  | "journal_removed";

export interface WorkspaceEditTransactionFacts {
  readonly manifest: WorkspaceManifest;
  readonly references: WorkspaceMetadataReferenceIndex;
}

export interface ApplyWorkspaceEditPlanInput {
  readonly rollHome: string;
  readonly plan: WorkspaceEditPlan;
  readonly reloadCurrent: () => WorkspaceEditTransactionFacts;
  readonly rebuildPlan: (facts: WorkspaceEditTransactionFacts) => WorkspaceEditPlan;
}

export interface WorkspaceEditTransactionDeps {
  readonly onAuthorityLockAcquired?: () => void;
  readonly afterPhase?: (phase: WorkspaceEditTransactionPhase) => void;
  readonly crashPoint?: (phase: WorkspaceEditTransactionPhase) => void;
  readonly fsyncFile?: (descriptor: number, path: string) => void;
  readonly renameFile?: (from: string, to: string) => void;
}

export interface WorkspaceEditTransactionResult {
  readonly outcome: "applied" | "reused";
  readonly workspaceId: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly referenceIndexSha256: string;
}

interface WorkspaceEditJournal {
  readonly schema: typeof WORKSPACE_EDIT_JOURNAL_V1;
  readonly status: "prepared" | "committed";
  readonly transactionId: string;
  readonly workspaceId: string;
  readonly manifestPath: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly referenceIndexSha256: string;
  readonly afterManifest: WorkspaceManifest;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function emitPhase(deps: WorkspaceEditTransactionDeps, phase: WorkspaceEditTransactionPhase): void {
  deps.afterPhase?.(phase);
  deps.crashPoint?.(phase);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function durableAtomicWrite(path: string, content: string, deps: WorkspaceEditTransactionDeps): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, content, "utf8");
    (deps.fsyncFile ?? ((fd: number) => fsyncSync(fd)))(descriptor, temporary);
    closeSync(descriptor);
    descriptor = undefined;
    (deps.renameFile ?? renameSync)(temporary, path);
    syncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function removeDurably(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
  syncDirectory(dirname(path));
}

export function workspaceEditJournalPath(rollHome: string, workspaceId: string): string {
  if (!isAbsolute(rollHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(workspaceId)) {
    throw new WorkspaceEditTransactionError("io_failure", "Workspace edit journal identity is invalid");
  }
  return join(resolve(rollHome), "workspace-edit", `${workspaceId}.pending.json`);
}

function parseJournal(path: string): WorkspaceEditJournal | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new WorkspaceEditTransactionError("partial_apply_recovered", "Workspace edit journal is unreadable", undefined, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceEditTransactionError("partial_apply_recovered", "Workspace edit journal has an invalid shape");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "afterManifest", "afterSha256", "beforeSha256", "manifestPath", "referenceIndexSha256",
    "schema", "status", "transactionId", "workspaceId",
  ].sort();
  const parsedManifest = parseWorkspaceManifest(record["afterManifest"]);
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) ||
    record["schema"] !== WORKSPACE_EDIT_JOURNAL_V1 ||
    (record["status"] !== "prepared" && record["status"] !== "committed") ||
    typeof record["transactionId"] !== "string" || record["transactionId"] === "" ||
    typeof record["workspaceId"] !== "string" ||
    typeof record["manifestPath"] !== "string" || !isAbsolute(record["manifestPath"]) ||
    !validDigest(record["beforeSha256"]) || !validDigest(record["afterSha256"]) ||
    !validDigest(record["referenceIndexSha256"]) || !parsedManifest.ok ||
    sha256(serializeWorkspaceManifest(parsedManifest.ok ? parsedManifest.value : ({} as WorkspaceManifest))) !== record["afterSha256"]
  ) {
    throw new WorkspaceEditTransactionError("partial_apply_recovered", "Workspace edit journal cannot be proven safe");
  }
  return {
    schema: WORKSPACE_EDIT_JOURNAL_V1,
    status: record["status"],
    transactionId: record["transactionId"],
    workspaceId: record["workspaceId"],
    manifestPath: record["manifestPath"],
    beforeSha256: record["beforeSha256"],
    afterSha256: record["afterSha256"],
    referenceIndexSha256: record["referenceIndexSha256"],
    afterManifest: parsedManifest.value,
  };
}

function result(outcome: "applied" | "reused", journal: Pick<WorkspaceEditJournal, "workspaceId" | "beforeSha256" | "afterSha256" | "referenceIndexSha256">): WorkspaceEditTransactionResult {
  return {
    outcome,
    workspaceId: journal.workspaceId,
    beforeSha256: journal.beforeSha256,
    afterSha256: journal.afterSha256,
    referenceIndexSha256: journal.referenceIndexSha256,
  };
}

function partial(workspaceId: string, message: string): WorkspaceEditTransactionError {
  return new WorkspaceEditTransactionError("partial_apply_recovered", message, `roll workspace doctor ${workspaceId}`);
}

function blockerError(plan: WorkspaceEditPlan): WorkspaceEditTransactionError {
  if (plan.blockers.some((blocker) => blocker.code === "metadata_referenced")) {
    return new WorkspaceEditTransactionError("metadata_referenced", "Workspace metadata gained a durable reference after preview");
  }
  if (plan.blockers.some((blocker) => blocker.code === "manifest_changed")) {
    return new WorkspaceEditTransactionError("manifest_changed", "Workspace manifest changed after preview");
  }
  return new WorkspaceEditTransactionError("reference_index_invalid", "Workspace edit plan could not be rebuilt from trusted authority facts");
}

async function applyUnderLock(
  input: ApplyWorkspaceEditPlanInput,
  deps: WorkspaceEditTransactionDeps,
): Promise<WorkspaceEditTransactionResult> {
  const preview = input.plan;
  const journalPath = workspaceEditJournalPath(input.rollHome, preview.workspaceId);
  const existing = parseJournal(journalPath);
  let facts: WorkspaceEditTransactionFacts;
  try {
    facts = input.reloadCurrent();
  } catch (error) {
    throw new WorkspaceEditTransactionError(
      "reference_index_invalid",
      "Workspace metadata reference authority could not be reloaded safely",
      `roll workspace doctor ${preview.workspaceId}`,
      { cause: error },
    );
  }
  const currentSha256 = sha256(serializeWorkspaceManifest(facts.manifest));

  if (existing !== null) {
    if (
      existing.workspaceId !== preview.workspaceId || existing.manifestPath !== preview.manifestPath ||
      existing.afterSha256 !== preview.afterSha256
    ) throw partial(preview.workspaceId, "Workspace edit journal belongs to a different transaction");
    if (currentSha256 === existing.afterSha256) {
      removeDurably(journalPath);
      emitPhase(deps, "journal_removed");
      return result("reused", existing);
    }
    if (currentSha256 !== existing.beforeSha256) {
      throw partial(preview.workspaceId, "Workspace manifest matches neither the journal before nor after digest");
    }
    if (existing.beforeSha256 !== preview.beforeSha256) {
      throw partial(preview.workspaceId, "Workspace edit preview does not match the pending transaction before digest");
    }
    if (existing.status === "committed") {
      throw partial(preview.workspaceId, "Committed Workspace edit journal conflicts with a restored before manifest");
    }
  } else if (currentSha256 === preview.afterSha256) {
    return result("reused", preview);
  }

  if (currentSha256 !== preview.beforeSha256) {
    throw new WorkspaceEditTransactionError("manifest_changed", "Workspace manifest changed after preview");
  }
  const rebuilt = input.rebuildPlan(facts);
  if (rebuilt.outcome !== "ready") {
    if (existing !== null) removeDurably(journalPath);
    throw blockerError(rebuilt);
  }
  if (rebuilt.afterSha256 !== preview.afterSha256) {
    if (existing !== null) removeDurably(journalPath);
    throw new WorkspaceEditTransactionError("edit_plan_changed", "Workspace edit result changed after preview");
  }

  const journal: WorkspaceEditJournal = {
    schema: WORKSPACE_EDIT_JOURNAL_V1,
    status: "prepared",
    transactionId: existing?.transactionId ?? randomUUID(),
    workspaceId: preview.workspaceId,
    manifestPath: preview.manifestPath,
    beforeSha256: preview.beforeSha256,
    afterSha256: preview.afterSha256,
    referenceIndexSha256: rebuilt.referenceIndexSha256,
    afterManifest: preview.afterManifest,
  };
  durableAtomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`, deps);
  emitPhase(deps, "journal_prepared");

  const content = serializeWorkspaceManifest(journal.afterManifest);
  const parent = dirname(journal.manifestPath);
  const temporary = join(parent, `.workspace.yaml.${journal.transactionId}.tmp`);
  let descriptor: number | undefined;
  let temporaryDurable = false;
  let manifestPublished = false;
  try {
    if (existsSync(temporary)) {
      let temporaryDigest: string;
      try {
        temporaryDigest = sha256(readFileSync(temporary));
      } catch (error) {
        throw partial(preview.workspaceId, `Workspace edit temporary manifest cannot be inspected: ${(error as Error).message}`);
      }
      if (temporaryDigest !== journal.afterSha256) {
        throw partial(preview.workspaceId, "Workspace edit temporary manifest does not match the journal after digest");
      }
      rmSync(temporary, { force: true });
    }
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, content, "utf8");
    (deps.fsyncFile ?? ((fd: number) => fsyncSync(fd)))(descriptor, temporary);
    temporaryDurable = true;
    closeSync(descriptor);
    descriptor = undefined;
    emitPhase(deps, "manifest_temp_fsynced");
    (deps.renameFile ?? renameSync)(temporary, journal.manifestPath);
    manifestPublished = true;
    syncDirectory(parent);
    emitPhase(deps, "manifest_renamed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!temporaryDurable || manifestPublished) rmSync(temporary, { force: true });
  }

  let verified: WorkspaceManifest;
  try {
    verified = input.reloadCurrent().manifest;
  } catch (error) {
    throw new WorkspaceEditTransactionError(
      "partial_apply_recovered",
      "Workspace manifest could not be parsed and verified after atomic replacement",
      `roll workspace doctor ${preview.workspaceId}`,
      { cause: error },
    );
  }
  if (sha256(serializeWorkspaceManifest(verified)) !== journal.afterSha256) {
    throw partial(preview.workspaceId, "Workspace manifest did not verify after atomic replacement");
  }
  emitPhase(deps, "manifest_verified");
  durableAtomicWrite(journalPath, `${JSON.stringify({ ...journal, status: "committed" }, null, 2)}\n`, deps);
  emitPhase(deps, "journal_committed");
  removeDurably(journalPath);
  emitPhase(deps, "journal_removed");
  return result("applied", journal);
}

export async function applyWorkspaceEditPlan(
  input: ApplyWorkspaceEditPlanInput,
  deps: WorkspaceEditTransactionDeps = {},
): Promise<WorkspaceEditTransactionResult> {
  try {
    return await withWorkspaceAuthorityLock({
      rollHome: input.rollHome,
      workspaceId: input.plan.workspaceId,
      operation: "metadata-edit",
      onAcquired: deps.onAuthorityLockAcquired,
    }, () => applyUnderLock(input, deps));
  } catch (error) {
    if (error instanceof WorkspaceEditTransactionError) {
      if (error.code === "partial_apply_recovered" && error.action === undefined) {
        throw partial(input.plan.workspaceId, error.message);
      }
      throw error;
    }
    if (error instanceof WorkspaceAuthorityLockError) {
      throw new WorkspaceEditTransactionError("concurrent_edit", error.message, undefined, { cause: error });
    }
    throw new WorkspaceEditTransactionError("io_failure", "Workspace edit transaction failed", undefined, { cause: error });
  }
}
