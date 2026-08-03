import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AGENT_CAPACITY_BROKER_LOCK_SCHEMA,
  AGENT_CAPACITY_LEASE_SCHEMA,
  type AgentCapacityBrokerLock,
  type AgentCapacityAcquireRequest,
  type AgentCapacityAcquireResult,
  type AgentCapacityLease,
  type AgentCapacityOwnershipResult,
  type AgentName,
  type NormalizedAgentCapacityPolicy,
} from "@roll/spec";

export interface ProcessIdentity {
  readonly alive: boolean;
  readonly startedAtMs?: number;
}

export interface NodeAgentCapacityBrokerOptions {
  readonly root: string;
  readonly policy: NormalizedAgentCapacityPolicy;
  readonly clockMs: () => number;
  readonly host: string;
  readonly processIdentity: (pid: number) => ProcessIdentity;
  readonly processStartedAtMs?: number;
  /** Bounded real-time wait for another broker transaction to finish. */
  readonly lockWaitMs?: number;
  /** Poll cadence while the machine broker lock is held elsewhere. */
  readonly lockPollMs?: number;
}

export type AgentCapacityCleanupResult =
  | { readonly kind: "cleaned" }
  | { readonly kind: "already_clean" }
  | {
      readonly kind: "blocked";
      readonly reason: "lease_unreadable_or_unknown_schema" | "lease_active" | "foreign_owner" | "owner_process_alive";
    };

export type AgentCapacityBrokerLockCleanupResult =
  | { readonly kind: "cleaned" }
  | { readonly kind: "already_clean" }
  | {
      readonly kind: "blocked";
      readonly reason: "lock_unreadable_or_unknown_schema" | "lock_active" | "foreign_owner";
    };

export type AgentCapacityBrokerLockInspection =
  | { readonly state: "absent" }
  | { readonly state: "unreadable" }
  | {
      readonly state: "active" | "stale_owned_dead" | "stale_live_or_foreign";
      readonly owner: AgentCapacityBrokerLock;
    };

interface LeaseRead {
  readonly path: string;
  readonly lease?: AgentCapacityLease;
  readonly suspect: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLease(value: unknown): value is AgentCapacityLease {
  if (!isRecord(value) || value["schema"] !== AGENT_CAPACITY_LEASE_SCHEMA) return false;
  const key = value["key"];
  const owner = value["owner"];
  return isRecord(key) &&
    typeof key["agent"] === "string" &&
    typeof key["model"] === "string" &&
    typeof key["contextKey"] === "string" &&
    isRecord(owner) &&
    typeof owner["leaseId"] === "string" &&
    typeof owner["ownerToken"] === "string" &&
    typeof owner["workspaceId"] === "string" &&
    typeof owner["storyId"] === "string" &&
    typeof owner["cycleId"] === "string" &&
    typeof owner["spawnId"] === "string" &&
    typeof owner["host"] === "string" &&
    typeof owner["pid"] === "number" &&
    typeof owner["processStartedAtMs"] === "number" &&
    typeof value["acquiredAtMs"] === "number" &&
    typeof value["heartbeatAtMs"] === "number";
}

function leaseFileName(leaseId: string): string {
  return `${createHash("sha256").update(leaseId).digest("hex")}.json`;
}

const BROKER_LOCK_OWNER_FILE = "owner.json";
const BROKER_RECLAIM_PREFIX = ".broker-reclaim.";

function brokerLockPath(root: string): string {
  return join(root, "broker.lock");
}

function isBrokerLock(value: unknown): value is AgentCapacityBrokerLock {
  return isRecord(value) &&
    value["schema"] === AGENT_CAPACITY_BROKER_LOCK_SCHEMA &&
    typeof value["ownerToken"] === "string" && value["ownerToken"] !== "" &&
    typeof value["host"] === "string" && value["host"] !== "" &&
    typeof value["pid"] === "number" && Number.isInteger(value["pid"]) && value["pid"] > 0 &&
    typeof value["processStartedAtMs"] === "number" && Number.isFinite(value["processStartedAtMs"]) &&
    typeof value["acquiredAtMs"] === "number" && Number.isFinite(value["acquiredAtMs"]);
}

function readBrokerLock(root: string): AgentCapacityBrokerLock | undefined {
  try {
    const value = JSON.parse(readFileSync(join(brokerLockPath(root), BROKER_LOCK_OWNER_FILE), "utf8")) as unknown;
    return isBrokerLock(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readBrokerOwnerFile(path: string): AgentCapacityBrokerLock | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isBrokerLock(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function inspectAgentCapacityBrokerLock(options: {
  readonly root: string;
  readonly host: string;
  readonly processIdentity: (pid: number) => ProcessIdentity;
}): AgentCapacityBrokerLockInspection {
  const path = brokerLockPath(options.root);
  if (!existsSync(path)) return { state: "absent" };
  const owner = readBrokerLock(options.root);
  if (owner === undefined) return { state: "unreadable" };
  if (owner.host !== options.host) return { state: "stale_live_or_foreign", owner };
  const identity = options.processIdentity(owner.pid);
  if (!identity.alive || (identity.startedAtMs !== undefined && identity.startedAtMs !== owner.processStartedAtMs)) {
    return { state: "stale_owned_dead", owner };
  }
  return { state: "active", owner };
}

/** Filesystem-backed machine broker. The broker lock covers the entire
 * read/prune/count/claim transaction and is never held while an agent runs. */
export class NodeAgentCapacityBroker {
  readonly #root: string;
  readonly #leasesDir: string;
  readonly #lockPath: string;
  readonly #policy: NormalizedAgentCapacityPolicy;
  readonly #clockMs: () => number;
  readonly #host: string;
  readonly #processIdentity: (pid: number) => ProcessIdentity;
  readonly #processStartedAtMs: number;
  readonly #lockWaitMs: number;
  readonly #lockPollMs: number;

  constructor(options: NodeAgentCapacityBrokerOptions) {
    this.#root = options.root;
    this.#leasesDir = join(options.root, "leases");
    this.#lockPath = join(options.root, "broker.lock");
    this.#policy = options.policy;
    this.#clockMs = options.clockMs;
    this.#host = options.host;
    this.#processIdentity = options.processIdentity;
    this.#processStartedAtMs = options.processIdentity(process.pid).startedAtMs ??
      options.processStartedAtMs ??
      Date.now() - process.uptime() * 1_000;
    this.#lockWaitMs = options.lockWaitMs ?? 2_000;
    this.#lockPollMs = options.lockPollMs ?? 10;
  }

  acquire(request: AgentCapacityAcquireRequest): AgentCapacityAcquireResult {
    return this.#withLock(() => {
      const now = this.#clockMs();
      const reads = this.#readAndPrune(now);
      const suspect = reads.some((read) => read.suspect);
      const active = reads.flatMap((read) => read.lease === undefined ? [] : [read.lease]);
      const perAgentLimit = this.#policy.perAgent[request.key.agent as AgentName] ?? 0;
      const agentActive = active.filter((lease) => lease.key.agent === request.key.agent).length;
      const exhausted = suspect || active.length >= this.#policy.global || agentActive >= perAgentLimit;
      if (exhausted) {
        return {
          kind: "waiting",
          retryAtMs: now + this.#policy.heartbeatSeconds * 1_000,
          contenders: active.map((lease) => ({
            agent: lease.key.agent,
            cycleId: lease.owner.cycleId,
          })),
          suspect,
        };
      }
      const lease: AgentCapacityLease = {
        schema: AGENT_CAPACITY_LEASE_SCHEMA,
        key: request.key,
        owner: request.owner,
        acquiredAtMs: now,
        heartbeatAtMs: now,
      };
      this.#writeLease(lease);
      return { kind: "acquired", lease };
    });
  }

  heartbeat(leaseId: string, ownerToken: string): AgentCapacityOwnershipResult {
    return this.#withLock(() => {
      const read = this.#readExact(leaseId);
      if (read === undefined || read.lease === undefined) {
        return { kind: "ownership_lost", reason: "lease_missing_or_unreadable" };
      }
      if (read.lease.owner.ownerToken !== ownerToken) {
        return { kind: "ownership_lost", reason: "owner_token_mismatch" };
      }
      this.#writeLease({ ...read.lease, heartbeatAtMs: this.#clockMs() });
      return { kind: "updated" };
    });
  }

  release(leaseId: string, ownerToken: string): AgentCapacityOwnershipResult {
    return this.#withLock(() => {
      const read = this.#readExact(leaseId);
      if (read === undefined) return { kind: "already_released" };
      if (read.lease === undefined) {
        return { kind: "ownership_lost", reason: "lease_unreadable_or_unknown_schema" };
      }
      if (read.lease.owner.ownerToken !== ownerToken) {
        return { kind: "ownership_lost", reason: "owner_token_mismatch" };
      }
      unlinkSync(read.path);
      return { kind: "released" };
    });
  }

  /** Remove exactly one stale lease only when the persisted owner belongs to
   * this host and its process is provably dead. No owner token is required:
   * this is an operator repair guarded by stronger persisted identity facts,
   * and it never guesses across hosts or live/PID-reused processes. */
  cleanupStaleOwned(leaseId: string): AgentCapacityCleanupResult {
    return this.#withLock(() => {
      const read = this.#readExact(leaseId);
      if (read === undefined) return { kind: "already_clean" };
      if (read.lease === undefined) {
        return { kind: "blocked", reason: "lease_unreadable_or_unknown_schema" };
      }
      const now = this.#clockMs();
      const stale = now - read.lease.heartbeatAtMs > this.#policy.staleAfterSeconds * 1_000;
      if (!stale) return { kind: "blocked", reason: "lease_active" };
      if (read.lease.owner.host !== this.#host) return { kind: "blocked", reason: "foreign_owner" };
      const identity = this.#processIdentity(read.lease.owner.pid);
      if (identity.alive) return { kind: "blocked", reason: "owner_process_alive" };
      unlinkSync(read.path);
      return { kind: "cleaned" };
    });
  }

  cleanupStaleBrokerLock(): AgentCapacityBrokerLockCleanupResult {
    const inspection = inspectAgentCapacityBrokerLock({
      root: this.#root,
      host: this.#host,
      processIdentity: this.#processIdentity,
    });
    if (inspection.state === "absent") return { kind: "already_clean" };
    if (inspection.state === "unreadable") {
      return { kind: "blocked", reason: "lock_unreadable_or_unknown_schema" };
    }
    if (inspection.state === "active") return { kind: "blocked", reason: "lock_active" };
    if (inspection.state === "stale_live_or_foreign") return { kind: "blocked", reason: "foreign_owner" };
    return this.#reclaimStaleBrokerLock(inspection.owner.ownerToken)
      ? { kind: "cleaned" }
      : { kind: "blocked", reason: "lock_unreadable_or_unknown_schema" };
  }

  #withLock<T>(operation: () => T): T {
    mkdirSync(this.#leasesDir, { recursive: true });
    const deadline = Date.now() + this.#lockWaitMs;
    let ownerToken: string | undefined;
    while (ownerToken === undefined) {
      ownerToken = this.#tryAcquireBrokerLock();
      if (ownerToken !== undefined) break;
      if (this.cleanupStaleBrokerLock().kind === "cleaned") continue;
      if (Date.now() >= deadline) throw new Error("agent_capacity_broker_lock_busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.#lockPollMs);
    }
    try {
      return operation();
    } finally {
      this.#releaseBrokerLock(ownerToken);
    }
  }

  #tryAcquireBrokerLock(): string | undefined {
    if (this.#reclaimGuardBlocked()) return undefined;
    const ownerToken = randomUUID();
    const temporary = join(this.#root, `.broker-lock.${process.pid}.${ownerToken}.tmp`);
    mkdirSync(temporary);
    try {
      const owner: AgentCapacityBrokerLock = {
        schema: AGENT_CAPACITY_BROKER_LOCK_SCHEMA,
        ownerToken,
        host: this.#host,
        pid: process.pid,
        processStartedAtMs: this.#processStartedAtMs,
        acquiredAtMs: this.#clockMs(),
      };
      writeFileSync(join(temporary, BROKER_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        renameSync(temporary, this.#lockPath);
        return ownerToken;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
        if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(code)) return undefined;
        throw new Error(`agent_capacity_broker_lock_failed:${code || "unknown"}`, { cause: error });
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  #releaseBrokerLock(ownerToken: string): void {
    const owner = readBrokerLock(this.#root);
    if (owner?.ownerToken !== ownerToken) return;
    rmSync(this.#lockPath, { recursive: true, force: true });
  }

  #reclaimMarkerPath(ownerToken: string): string {
    return join(this.#root, `${BROKER_RECLAIM_PREFIX}${ownerToken}.json`);
  }

  #writeReclaimMarker(ownerToken: string): string {
    const path = this.#reclaimMarkerPath(ownerToken);
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    const owner: AgentCapacityBrokerLock = {
      schema: AGENT_CAPACITY_BROKER_LOCK_SCHEMA,
      ownerToken,
      host: this.#host,
      pid: process.pid,
      processStartedAtMs: this.#processStartedAtMs,
      acquiredAtMs: this.#clockMs(),
    };
    try {
      writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
      return path;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Reclaim markers are unique immutable paths. Removing a proven-dead marker
   * cannot delete a replacement owner, which makes stale-guard cleanup safe. */
  #liveReclaimMarkers(): readonly AgentCapacityBrokerLock[] | undefined {
    const live: AgentCapacityBrokerLock[] = [];
    let names: string[];
    try {
      names = readdirSync(this.#root)
        .filter((name) => name.startsWith(BROKER_RECLAIM_PREFIX) && name.endsWith(".json"))
        .sort();
    } catch {
      return [];
    }
    for (const name of names) {
      const path = join(this.#root, name);
      const owner = readBrokerOwnerFile(path);
      if (owner === undefined || owner.host !== this.#host) return undefined;
      if (owner.pid === process.pid && owner.processStartedAtMs === this.#processStartedAtMs) {
        live.push(owner);
        continue;
      }
      const identity = this.#processIdentity(owner.pid);
      if (!identity.alive || (identity.startedAtMs !== undefined && identity.startedAtMs !== owner.processStartedAtMs)) {
        try {
          unlinkSync(path);
        } catch {
          return undefined;
        }
        continue;
      }
      live.push(owner);
    }
    return live;
  }

  #reclaimGuardBlocked(ownerToken?: string): boolean {
    const live = this.#liveReclaimMarkers();
    if (live === undefined) return true;
    if (live.length === 0) return false;
    if (ownerToken === undefined) return true;
    return live.length !== 1 || live[0]?.ownerToken !== ownerToken;
  }

  #reclaimStaleBrokerLock(staleOwnerToken: string): boolean {
    const reclaimerToken = randomUUID();
    let marker: string;
    try {
      marker = this.#writeReclaimMarker(reclaimerToken);
    } catch {
      return false;
    }
    try {
      if (this.#reclaimGuardBlocked(reclaimerToken)) return false;
      const inspection = inspectAgentCapacityBrokerLock({
        root: this.#root,
        host: this.#host,
        processIdentity: this.#processIdentity,
      });
      if (inspection.state !== "stale_owned_dead" || inspection.owner.ownerToken !== staleOwnerToken) return false;
      return this.#isolateStaleBrokerLock(staleOwnerToken);
    } finally {
      try {
        unlinkSync(marker);
      } catch {
        /* a missing own marker only delays contenders until their stale scan */
      }
    }
  }

  #isolateStaleBrokerLock(ownerToken: string): boolean {
    const isolated = join(this.#root, `.broker-lock.stale.${ownerToken}.${randomUUID()}`);
    try {
      renameSync(this.#lockPath, isolated);
    } catch {
      return false;
    }
    const isolatedOwner = (() => {
      try {
        const value = JSON.parse(readFileSync(join(isolated, BROKER_LOCK_OWNER_FILE), "utf8")) as unknown;
        return isBrokerLock(value) ? value : undefined;
      } catch {
        return undefined;
      }
    })();
    if (isolatedOwner?.ownerToken !== ownerToken) {
      if (!existsSync(this.#lockPath)) renameSync(isolated, this.#lockPath);
      return false;
    }
    rmSync(isolated, { recursive: true, force: true });
    return true;
  }

  #readAndPrune(now: number): LeaseRead[] {
    const out: LeaseRead[] = [];
    for (const name of readdirSync(this.#leasesDir).filter((entry) => entry.endsWith(".json")).sort()) {
      const path = join(this.#leasesDir, name);
      const read = this.#readPath(path);
      if (read.lease === undefined) {
        out.push(read);
        continue;
      }
      const stale = now - read.lease.heartbeatAtMs > this.#policy.staleAfterSeconds * 1_000;
      if (!stale) {
        out.push(read);
        continue;
      }
      if (read.lease.owner.host !== this.#host) {
        out.push({ ...read, suspect: true });
        continue;
      }
      const identity = this.#processIdentity(read.lease.owner.pid);
      if (!identity.alive) {
        unlinkSync(path);
        continue;
      }
      const exactProcess = identity.startedAtMs === read.lease.owner.processStartedAtMs;
      out.push({ ...read, suspect: !exactProcess || stale });
    }
    return out;
  }

  #readExact(leaseId: string): LeaseRead | undefined {
    const path = join(this.#leasesDir, leaseFileName(leaseId));
    return existsSync(path) ? this.#readPath(path) : undefined;
  }

  #readPath(path: string): LeaseRead {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isLease(value) ? { path, lease: value, suspect: false } : { path, suspect: true };
    } catch {
      return { path, suspect: true };
    }
  }

  #writeLease(lease: AgentCapacityLease): void {
    const destination = join(this.#leasesDir, leaseFileName(lease.owner.leaseId));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  }
}
