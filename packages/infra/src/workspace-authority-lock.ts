import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { acquireLock, releaseLock } from "./process.js";

export type WorkspaceAuthorityOperation =
  | "metadata-edit"
  | "issue-init"
  | "requirement-capture"
  | "requirement-repair"
  | "migration";

export type WorkspaceAuthorityLockErrorCode =
  | "invalid_authority"
  | "authority_locked";

export class WorkspaceAuthorityLockError extends Error {
  constructor(readonly code: WorkspaceAuthorityLockErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceAuthorityLockError";
  }
}

export interface WorkspaceAuthorityLockInput {
  readonly rollHome: string;
  readonly workspaceId: string;
  readonly operation: WorkspaceAuthorityOperation;
  readonly onAcquired?: () => void;
}

function validate(input: WorkspaceAuthorityLockInput): void {
  if (!isAbsolute(input.rollHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.workspaceId)) {
    throw new WorkspaceAuthorityLockError("invalid_authority", "Workspace authority identity is invalid");
  }
}

export function workspaceAuthorityLockPath(rollHome: string, workspaceId: string): string {
  const input = { rollHome, workspaceId, operation: "metadata-edit" as const };
  validate(input);
  return join(resolve(rollHome), "locks", "workspace-authority", `${workspaceId}.lock`);
}

interface WorkspaceAuthorityLease {
  readonly path: string;
  readonly cleanupDirectories: readonly string[];
}

function acquire(input: WorkspaceAuthorityLockInput): WorkspaceAuthorityLease {
  validate(input);
  const path = workspaceAuthorityLockPath(input.rollHome, input.workspaceId);
  const rollHome = resolve(input.rollHome);
  const locksRoot = join(rollHome, "locks");
  const authorityRoot = join(locksRoot, "workspace-authority");
  const cleanupDirectories = [authorityRoot, locksRoot, rollHome].filter((directory) => !existsSync(directory));
  mkdirSync(authorityRoot, { recursive: true });
  const lock = acquireLock(path, process.pid, {
    cycleId: `workspace-authority:${input.workspaceId}:${input.operation}`,
    unparseableIsHeld: true,
  });
  if (!lock.acquired) {
    throw new WorkspaceAuthorityLockError("authority_locked", `Workspace ${input.workspaceId} authority is locked by another writer`);
  }
  const lease = { path, cleanupDirectories };
  try {
    input.onAcquired?.();
    return lease;
  } catch (error) {
    release(lease);
    throw error;
  }
}

function release(lease: WorkspaceAuthorityLease): void {
  releaseLock(lease.path);
  for (const directory of lease.cleanupDirectories) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

export function withWorkspaceAuthorityLockSync<T>(
  input: WorkspaceAuthorityLockInput,
  run: () => T,
): T {
  const lease = acquire(input);
  try {
    return run();
  } finally {
    release(lease);
  }
}

export async function withWorkspaceAuthorityLock<T>(
  input: WorkspaceAuthorityLockInput,
  run: () => Promise<T>,
): Promise<T> {
  const lease = acquire(input);
  try {
    return await run();
  } finally {
    release(lease);
  }
}
