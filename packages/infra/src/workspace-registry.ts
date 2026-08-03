import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  decideWorkspaceTransition,
  foldWorkspaceLifecycles,
  nodeEventStore,
  type EventStore,
  type WorkspaceLifecycleState,
} from "@roll/core";
import {
  WORKSPACE_EVENT_V1,
  parseWorkspaceManifest,
  type WorkspaceLifecycleEvent,
} from "@roll/spec";

export const WORKSPACE_REGISTRY_V1 = "roll.workspace-registry/v1" as const;

export type WorkspaceRegistryErrorCode =
  | "invalid_registry"
  | "invalid_path"
  | "identity_mismatch"
  | "path_conflict"
  | "path_change_requires_move"
  | "stale_path"
  | "not_found"
  | "io_failure"
  | "concurrent_write"
  | "archived_requires_activation"
  | "already_archived";

export class WorkspaceRegistryError extends Error {
  constructor(readonly code: WorkspaceRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceRegistryError";
  }
}

export interface WorkspaceRegistryEntry {
  readonly workspaceId: string;
  readonly root: string;
  readonly canonicalRoot: string;
  readonly pathState: "valid" | "stale";
}

export interface WorkspaceRegistrySnapshot {
  readonly schema: typeof WORKSPACE_REGISTRY_V1;
  readonly revision: number;
  readonly entries: readonly WorkspaceRegistryEntry[];
}

export interface WorkspaceRegistryOptions {
  readonly rollHome: string;
  readonly now?: () => number;
  readonly eventStore?: Pick<EventStore, "readText" | "appendLine">;
  readonly beforeRegistryRename?: () => void;
  readonly renameFile?: (from: string, to: string) => void;
}

export interface ListedWorkspace extends WorkspaceRegistryEntry, WorkspaceLifecycleState {}

export type WorkspaceManifestConsistency =
  | "consistent"
  | "stale_path"
  | "identity_mismatch"
  | "invalid_manifest";

export interface InspectedWorkspace extends WorkspaceRegistryEntry, WorkspaceLifecycleState {
  readonly manifestWorkspaceId: string | null;
  readonly consistency: WorkspaceManifestConsistency;
}

export interface WorkspaceMoveInput {
  readonly workspaceId: string;
  readonly oldRoot: string;
  readonly newRoot: string;
}

type WorkspaceTransitionEventType = Exclude<
  WorkspaceLifecycleEvent["type"],
  "workspace:registered" | "workspace:path_updated"
>;

const WORKSPACE_TRANSITION_EVENT_TYPES = [
  "workspace:registered",
  "workspace:activated",
  "workspace:paused",
  "workspace:archived",
] as const;

function isWorkspaceTransitionOrRegistrationType(
  value: unknown,
): value is typeof WORKSPACE_TRANSITION_EVENT_TYPES[number] {
  return typeof value === "string" && WORKSPACE_TRANSITION_EVENT_TYPES.some((type) => type === value);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalid(message: string): never {
  throw new WorkspaceRegistryError("invalid_registry", message);
}

function parseEntry(value: unknown): WorkspaceRegistryEntry {
  if (!isRecord(value) || !exactKeys(value, ["workspaceId", "root", "canonicalRoot", "pathState"])) {
    return invalid("Workspace registry entry has an invalid or open shape");
  }
  const workspaceId = value["workspaceId"];
  const root = value["root"];
  const canonicalRoot = value["canonicalRoot"];
  const pathState = value["pathState"];
  if (
    typeof workspaceId !== "string" || workspaceId === "" ||
    typeof root !== "string" || !isAbsolute(root) ||
    typeof canonicalRoot !== "string" || !isAbsolute(canonicalRoot) ||
    (pathState !== "valid" && pathState !== "stale")
  ) {
    return invalid("Workspace registry entry contains invalid values");
  }
  return { workspaceId, root, canonicalRoot, pathState };
}

export function parseWorkspaceRegistry(text: string): WorkspaceRegistrySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("Workspace registry is not valid JSON");
  }
  if (!isRecord(value) || !exactKeys(value, ["schema", "revision", "entries"])) {
    return invalid("Workspace registry has an invalid or open shape");
  }
  if (value["schema"] !== WORKSPACE_REGISTRY_V1) return invalid("Unsupported Workspace registry schema");
  if (!Number.isSafeInteger(value["revision"]) || (value["revision"] as number) < 0) {
    return invalid("Workspace registry revision must be a non-negative safe integer");
  }
  if (!Array.isArray(value["entries"])) return invalid("Workspace registry entries must be an array");
  const entries = value["entries"].map(parseEntry)
    .sort((left, right) => compareCodeUnits(left.workspaceId, right.workspaceId));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.workspaceId) || paths.has(entry.canonicalRoot)) {
      return invalid("Workspace registry contains duplicate identity or path entries");
    }
    ids.add(entry.workspaceId);
    paths.add(entry.canonicalRoot);
  }
  return { schema: WORKSPACE_REGISTRY_V1, revision: value["revision"] as number, entries };
}

export function serializeWorkspaceRegistry(snapshot: WorkspaceRegistrySnapshot): string {
  const entries = [...snapshot.entries]
    .sort((left, right) => compareCodeUnits(left.workspaceId, right.workspaceId))
    .map((entry) => ({
      workspaceId: entry.workspaceId,
      root: entry.root,
      canonicalRoot: entry.canonicalRoot,
      pathState: entry.pathState,
    }));
  return `${JSON.stringify({ schema: WORKSPACE_REGISTRY_V1, revision: snapshot.revision, entries }, null, 2)}\n`;
}

export function workspaceRegistryPath(rollHome: string): string {
  return join(rollHome, "workspaces.json");
}

export function workspaceEventsPath(rollHome: string): string {
  return join(rollHome, "workspace-events.ndjson");
}

export function workspaceRegistryTransactionPath(rollHome: string): string {
  return join(rollHome, "workspaces.pending.json");
}

const WORKSPACE_REGISTRY_TRANSACTION_V1 = "roll.workspace-registry-transaction/v1" as const;

interface WorkspaceRegistryTransaction {
  readonly schema: typeof WORKSPACE_REGISTRY_TRANSACTION_V1;
  readonly beforeRevision: number;
  readonly next: WorkspaceRegistrySnapshot;
  readonly event: WorkspaceLifecycleEvent;
}

function readManifestWorkspaceId(root: string): string {
  let text: string;
  try {
    text = readFileSync(join(root, "workspace.yaml"), "utf8");
  } catch {
    throw new WorkspaceRegistryError("invalid_path", "Workspace root must contain workspace.yaml");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkspaceRegistryError(
      "identity_mismatch",
      "workspace.yaml must contain a valid roll.workspace/v1 manifest",
    );
  }
  const parsed = parseWorkspaceManifest(value);
  if (!parsed.ok) {
    throw new WorkspaceRegistryError(
      "identity_mismatch",
      "workspace.yaml must contain a valid roll.workspace/v1 manifest",
    );
  }
  return parsed.value.workspaceId;
}

function validatedCanonicalRoot(root: string, workspaceId: string): string {
  let before: string;
  try {
    before = realpathSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new WorkspaceRegistryError("stale_path", "Workspace root does not exist");
    }
    throw new WorkspaceRegistryError("io_failure", "Workspace root could not be resolved", { cause: error });
  }
  const manifestWorkspaceId = readManifestWorkspaceId(before);
  let after: string;
  try {
    after = realpathSync(root);
  } catch {
    throw new WorkspaceRegistryError("invalid_path", "Workspace root changed during validation");
  }
  if (before !== after) {
    throw new WorkspaceRegistryError("invalid_path", "Workspace root changed during validation");
  }
  if (manifestWorkspaceId !== workspaceId) {
    throw new WorkspaceRegistryError("identity_mismatch", "workspace.yaml ID does not match the requested Workspace ID");
  }
  return before;
}

function entryIsCurrent(entry: WorkspaceRegistryEntry): boolean {
  if (entry.pathState === "stale" || !existsSync(entry.root)) return false;
  try {
    return validatedCanonicalRoot(entry.root, entry.workspaceId) === entry.canonicalRoot;
  } catch (error) {
    if (
      error instanceof WorkspaceRegistryError &&
      (error.code === "stale_path" || error.code === "identity_mismatch" || error.code === "invalid_path")
    ) return false;
    throw error;
  }
}

function inspectManifest(entry: WorkspaceRegistryEntry): {
  readonly manifestWorkspaceId: string | null;
  readonly consistency: WorkspaceManifestConsistency;
} {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(entry.root);
  } catch {
    return { manifestWorkspaceId: null, consistency: "stale_path" };
  }
  if (canonicalRoot !== entry.canonicalRoot) {
    return { manifestWorkspaceId: null, consistency: "stale_path" };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(canonicalRoot, "workspace.yaml"), "utf8"));
  } catch {
    return { manifestWorkspaceId: null, consistency: "invalid_manifest" };
  }
  const parsed = parseWorkspaceManifest(value);
  if (!parsed.ok) return { manifestWorkspaceId: null, consistency: "invalid_manifest" };
  if (parsed.value.workspaceId !== entry.workspaceId) {
    return { manifestWorkspaceId: parsed.value.workspaceId, consistency: "identity_mismatch" };
  }
  return { manifestWorkspaceId: parsed.value.workspaceId, consistency: "consistent" };
}

export class WorkspaceRegistry {
  private readonly now: () => number;
  private readonly eventStore: Pick<EventStore, "readText" | "appendLine">;
  private tempCounter = 0;

  constructor(private readonly options: WorkspaceRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.eventStore = options.eventStore ?? nodeEventStore;
  }

  read(): WorkspaceRegistrySnapshot {
    try {
      return parseWorkspaceRegistry(readFileSync(workspaceRegistryPath(this.options.rollHome), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema: WORKSPACE_REGISTRY_V1, revision: 0, entries: [] };
      }
      if (error instanceof WorkspaceRegistryError) throw error;
      throw new WorkspaceRegistryError("io_failure", "Workspace registry could not be read", { cause: error });
    }
  }

  readEvents(): readonly WorkspaceLifecycleEvent[] {
    let text: string;
    try {
      text = this.eventStore.readText(workspaceEventsPath(this.options.rollHome));
    } catch (error) {
      if (error instanceof WorkspaceRegistryError) throw error;
      throw new WorkspaceRegistryError("io_failure", "Workspace event stream could not be read", { cause: error });
    }
    return text.split("\n").filter((line) => line !== "").map((line) => this.parseEvent(line));
  }

  list(): readonly ListedWorkspace[] {
    if (this.readPendingTransaction() !== undefined) {
      throw new WorkspaceRegistryError("concurrent_write", "Workspace registry has an incomplete transaction pending recovery");
    }
    const snapshot = this.read();
    const lifecycles = new Map(foldWorkspaceLifecycles(this.readEvents()).map((state) => [state.workspaceId, state]));
    return snapshot.entries.map((entry) => {
      const lifecycle = lifecycles.get(entry.workspaceId);
      if (lifecycle === undefined) {
        throw new WorkspaceRegistryError("invalid_registry", `Workspace ${entry.workspaceId} has no registration event`);
      }
      return {
        ...entry,
        pathState: entryIsCurrent(entry) ? "valid" : "stale",
        ...lifecycle,
      };
    });
  }

  inspect(): readonly InspectedWorkspace[] {
    if (this.readPendingTransaction() !== undefined) {
      throw new WorkspaceRegistryError("concurrent_write", "Workspace registry has an incomplete transaction pending recovery");
    }
    const snapshot = this.read();
    const lifecycles = new Map(foldWorkspaceLifecycles(this.readEvents()).map((state) => [state.workspaceId, state]));
    return snapshot.entries.map((entry) => {
      const lifecycle = lifecycles.get(entry.workspaceId);
      if (lifecycle === undefined) {
        throw new WorkspaceRegistryError("invalid_registry", `Workspace ${entry.workspaceId} has no registration event`);
      }
      const manifest = inspectManifest(entry);
      return {
        ...entry,
        pathState: manifest.consistency === "stale_path" ? "stale" : "valid",
        ...lifecycle,
        ...manifest,
      };
    });
  }

  register(input: { readonly workspaceId: string; readonly root: string }): WorkspaceRegistryEntry {
    return this.withLock(() => {
      if (!isAbsolute(input.root)) throw new WorkspaceRegistryError("invalid_path", "Workspace root must be absolute");
      const root = resolve(input.root);
      let canonicalRoot: string;
      try {
        canonicalRoot = validatedCanonicalRoot(root, input.workspaceId);
      } catch (error) {
        if (error instanceof WorkspaceRegistryError && error.code === "stale_path") {
          throw new WorkspaceRegistryError("invalid_path", "Workspace root does not exist", { cause: error });
        }
        throw error;
      }
      const snapshot = this.read();
      const existing = snapshot.entries.find((entry) => entry.workspaceId === input.workspaceId);
      if (existing !== undefined) {
        if (existing.root !== root || existing.canonicalRoot !== canonicalRoot) {
          throw new WorkspaceRegistryError("path_change_requires_move", "Workspace path changes require an explicit move");
        }
        if (!this.readEvents().some((event) => event.type === "workspace:registered" && event.workspaceId === input.workspaceId)) {
          this.appendEvent({ schema: WORKSPACE_EVENT_V1, type: "workspace:registered", workspaceId: input.workspaceId, ts: this.now() });
        }
        return existing;
      }
      if (snapshot.entries.some((entry) => entry.canonicalRoot === canonicalRoot)) {
        throw new WorkspaceRegistryError("path_conflict", "Canonical Workspace path is already registered");
      }
      const entry: WorkspaceRegistryEntry = { workspaceId: input.workspaceId, root, canonicalRoot, pathState: "valid" };
      const next = { ...snapshot, revision: snapshot.revision + 1, entries: [...snapshot.entries, entry] };
      this.commitTransaction(next, {
        schema: WORKSPACE_EVENT_V1,
        type: "workspace:registered",
        workspaceId: input.workspaceId,
        ts: this.now(),
      });
      return entry;
    });
  }

  activate(workspaceId: string): void {
    this.transition(workspaceId, "workspace:activated");
  }

  pause(workspaceId: string): void {
    this.transition(workspaceId, "workspace:paused");
  }

  archive(workspaceId: string): void {
    this.transition(workspaceId, "workspace:archived");
  }

  move(input: WorkspaceMoveInput): WorkspaceRegistryEntry {
    return this.updatePath(input, "move");
  }

  repair(input: WorkspaceMoveInput): WorkspaceRegistryEntry {
    return this.updatePath(input, "repair");
  }

  private transition(
    workspaceId: string,
    type: WorkspaceTransitionEventType,
  ): void {
    this.withLock(() => {
      const current = this.list().find((entry) => entry.workspaceId === workspaceId);
      if (current === undefined) {
        throw new WorkspaceRegistryError("not_found", `Workspace ${workspaceId} is not registered`);
      }
      const mutation = type === "workspace:activated" ? "activate" : type === "workspace:paused" ? "pause" : "archive";
      const decision = decideWorkspaceTransition(current.lifecycle, mutation);
      if (!decision.ok) throw new WorkspaceRegistryError(decision.code, decision.code);
      if (decision.eventType === null) return;
      this.appendEvent({ schema: WORKSPACE_EVENT_V1, type: decision.eventType, workspaceId, ts: this.now() });
    });
  }

  private updatePath(input: WorkspaceMoveInput, mode: "move" | "repair"): WorkspaceRegistryEntry {
    return this.withLock((recovered) => {
      if (!isAbsolute(input.oldRoot) || !isAbsolute(input.newRoot)) {
        throw new WorkspaceRegistryError("invalid_path", "Workspace move paths must be absolute");
      }
      const oldRoot = resolve(input.oldRoot);
      const newRoot = resolve(input.newRoot);
      const snapshot = this.read();
      const index = snapshot.entries.findIndex((entry) => entry.workspaceId === input.workspaceId);
      const existing = snapshot.entries[index];
      if (existing === undefined) {
        throw new WorkspaceRegistryError("not_found", `Workspace ${input.workspaceId} is not registered`);
      }
      if (existing.root !== oldRoot) {
        if (
          recovered?.event.type === "workspace:path_updated" &&
          recovered.event.workspaceId === input.workspaceId &&
          recovered.event.oldRoot === oldRoot &&
          recovered.event.newRoot === newRoot &&
          existing.root === newRoot
        ) return existing;
        throw new WorkspaceRegistryError("identity_mismatch", "Explicit old path does not match the registry entry");
      }

      if (mode === "move") {
        try {
          if (validatedCanonicalRoot(oldRoot, input.workspaceId) !== existing.canonicalRoot) {
            throw new WorkspaceRegistryError("identity_mismatch", "Old path does not match the registered Workspace identity");
          }
        } catch (error) {
          if (!(error instanceof WorkspaceRegistryError) || error.code !== "stale_path") throw error;
          if (existing.pathState !== "stale") {
            const stale: WorkspaceRegistryEntry = { ...existing, pathState: "stale" };
            const entries = snapshot.entries.map((entry, entryIndex) => entryIndex === index ? stale : entry);
            this.write({ ...snapshot, revision: snapshot.revision + 1, entries });
          }
          throw new WorkspaceRegistryError("stale_path", "Registered Workspace path is missing; explicit repair is required");
        }
      } else if (entryIsCurrent(existing)) {
        throw new WorkspaceRegistryError("invalid_path", "Workspace repair requires a stale registry path");
      }

      let canonicalRoot: string;
      try {
        canonicalRoot = validatedCanonicalRoot(newRoot, input.workspaceId);
      } catch (error) {
        if (error instanceof WorkspaceRegistryError && error.code === "stale_path") {
          throw new WorkspaceRegistryError("invalid_path", "New Workspace root does not exist", { cause: error });
        }
        throw error;
      }
      if (snapshot.entries.some((entry) => entry.workspaceId !== input.workspaceId && entry.canonicalRoot === canonicalRoot)) {
        throw new WorkspaceRegistryError("path_conflict", "New canonical Workspace path is already registered");
      }
      const moved: WorkspaceRegistryEntry = {
        workspaceId: input.workspaceId,
        root: newRoot,
        canonicalRoot,
        pathState: "valid",
      };
      const entries = snapshot.entries.map((entry, entryIndex) => entryIndex === index ? moved : entry);
      const next = { ...snapshot, revision: snapshot.revision + 1, entries };
      this.commitTransaction(next, {
        schema: WORKSPACE_EVENT_V1,
        type: "workspace:path_updated",
        workspaceId: input.workspaceId,
        ts: this.now(),
        oldRoot,
        newRoot,
      });
      return moved;
    });
  }

  private write(snapshot: WorkspaceRegistrySnapshot): void {
    this.writeAtomic(workspaceRegistryPath(this.options.rollHome), serializeWorkspaceRegistry(snapshot), this.options.beforeRegistryRename);
  }

  private writeAtomic(path: string, text: string, beforeRename?: () => void): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp.${process.pid}.${this.tempCounter++}`;
    try {
      writeFileSync(temp, text, "utf8");
      beforeRename?.();
      (this.options.renameFile ?? renameSync)(temp, path);
    } catch (error) {
      throw new WorkspaceRegistryError("io_failure", "Workspace registry atomic write failed", { cause: error });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  private appendEvent(event: WorkspaceLifecycleEvent): void {
    const path = workspaceEventsPath(this.options.rollHome);
    try {
      this.eventStore.appendLine(path, `${JSON.stringify(event)}\n`);
    } catch (error) {
      throw new WorkspaceRegistryError("io_failure", "Workspace event append failed", { cause: error });
    }
  }

  private commitTransaction(next: WorkspaceRegistrySnapshot, event: WorkspaceLifecycleEvent): void {
    const transaction: WorkspaceRegistryTransaction = {
      schema: WORKSPACE_REGISTRY_TRANSACTION_V1,
      beforeRevision: next.revision - 1,
      next,
      event,
    };
    this.writeAtomic(
      workspaceRegistryTransactionPath(this.options.rollHome),
      `${JSON.stringify(transaction, null, 2)}\n`,
    );
    this.finishTransaction(transaction);
  }

  private finishTransaction(transaction: WorkspaceRegistryTransaction): void {
    const current = this.read();
    const requiresRegistryWrite = current.revision === transaction.beforeRevision;
    if (!requiresRegistryWrite && serializeWorkspaceRegistry(current) !== serializeWorkspaceRegistry(transaction.next)) {
      throw new WorkspaceRegistryError("invalid_registry", "Pending Workspace transaction conflicts with registry revision");
    }
    const eventText = JSON.stringify(transaction.event);
    if (!this.readEvents().some((event) => JSON.stringify(event) === eventText)) {
      this.appendEvent(transaction.event);
    }
    if (requiresRegistryWrite) this.write(transaction.next);
    try {
      rmSync(workspaceRegistryTransactionPath(this.options.rollHome), { force: true });
    } catch (error) {
      throw new WorkspaceRegistryError("io_failure", "Workspace transaction journal could not be cleared", { cause: error });
    }
  }

  private readPendingTransaction(): WorkspaceRegistryTransaction | undefined {
    let raw: string;
    try {
      raw = readFileSync(workspaceRegistryTransactionPath(this.options.rollHome), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new WorkspaceRegistryError("io_failure", "Workspace transaction journal could not be read", { cause: error });
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace transaction journal is invalid JSON");
    }
    if (!isRecord(value) || !exactKeys(value, ["schema", "beforeRevision", "next", "event"])) {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace transaction journal has an invalid shape");
    }
    if (value["schema"] !== WORKSPACE_REGISTRY_TRANSACTION_V1 || !Number.isSafeInteger(value["beforeRevision"])) {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace transaction journal contains invalid values");
    }
    const next = parseWorkspaceRegistry(`${JSON.stringify(value["next"])}\n`);
    const event = this.parseEvent(JSON.stringify(value["event"]));
    return {
      schema: WORKSPACE_REGISTRY_TRANSACTION_V1,
      beforeRevision: value["beforeRevision"] as number,
      next,
      event,
    };
  }

  private parseEvent(line: string): WorkspaceLifecycleEvent {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace event stream contains invalid JSON");
    }
    if (!isRecord(value)) throw new WorkspaceRegistryError("invalid_registry", "Workspace event must be an object");
    const type = value["type"];
    const workspaceId = value["workspaceId"];
    const ts = value["ts"];
    const baseKeys = ["schema", "type", "workspaceId", "ts"];
    const pathUpdate = type === "workspace:path_updated";
    if (!exactKeys(value, pathUpdate ? [...baseKeys, "oldRoot", "newRoot"] : baseKeys)) {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace event has an invalid or open shape");
    }
    if (
      value["schema"] !== WORKSPACE_EVENT_V1 ||
      typeof workspaceId !== "string" || workspaceId === "" ||
      typeof ts !== "number" || !Number.isFinite(ts) ||
      (!pathUpdate && !isWorkspaceTransitionOrRegistrationType(type))
    ) {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace event contains invalid values");
    }
    if (pathUpdate) {
      if (
        typeof value["oldRoot"] !== "string" || !isAbsolute(value["oldRoot"]) ||
        typeof value["newRoot"] !== "string" || !isAbsolute(value["newRoot"])
      ) {
        throw new WorkspaceRegistryError("invalid_registry", "Workspace path update contains invalid paths");
      }
      return {
        schema: WORKSPACE_EVENT_V1,
        type: "workspace:path_updated",
        workspaceId,
        ts,
        oldRoot: value["oldRoot"],
        newRoot: value["newRoot"],
      };
    }
    if (!isWorkspaceTransitionOrRegistrationType(type)) {
      throw new WorkspaceRegistryError("invalid_registry", "Workspace event type is unsupported");
    }
    return {
      schema: WORKSPACE_EVENT_V1,
      type,
      workspaceId,
      ts,
    };
  }

  private withLock<T>(run: (recovered?: WorkspaceRegistryTransaction) => T): T {
    const lock = join(this.options.rollHome, "locks", "workspace-registry.lock");
    mkdirSync(dirname(lock), { recursive: true });
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new WorkspaceRegistryError("concurrent_write", "Workspace registry is locked by another writer");
    }
    try {
      const pending = this.readPendingTransaction();
      if (pending !== undefined) this.finishTransaction(pending);
      return run(pending);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
