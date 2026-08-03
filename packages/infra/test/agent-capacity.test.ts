import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentCapacityAcquireRequest, NormalizedAgentCapacityPolicy } from "@roll/spec";
import { NodeAgentCapacityBroker } from "../src/agent-capacity.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `roll-${label}-`));
}

const POLICY: NormalizedAgentCapacityPolicy = {
  global: 2,
  perAgent: { codex: 1, claude: 1 },
  heartbeatSeconds: 10,
  staleAfterSeconds: 30,
};

function request(
  cycleId: string,
  agent: "codex" | "claude" = "codex",
  overrides: Partial<AgentCapacityAcquireRequest["owner"]> = {},
): AgentCapacityAcquireRequest {
  return {
    key: { agent, model: `${agent}-model`, contextKey: `${agent}-account` },
    owner: {
      leaseId: `lease-${cycleId}`,
      ownerToken: `token-${cycleId}`,
      workspaceId: `workspace-${cycleId}`,
      storyId: `US-${cycleId}`,
      cycleId,
      spawnId: `spawn-${cycleId}`,
      host: hostname(),
      pid: 1000,
      processStartedAtMs: 500,
      ...overrides,
    },
  };
}

function broker(root: string, now = 1_000) {
  return new NodeAgentCapacityBroker({
    root,
    policy: POLICY,
    clockMs: () => now,
    host: hostname(),
    processIdentity: (pid) => pid === 1000 ? { alive: true, startedAtMs: 500 } : { alive: false },
  });
}

function writeBrokerLock(root: string, owner: {
  readonly host: string;
  readonly pid: number;
  readonly processStartedAtMs: number;
}): void {
  const lock = join(root, "broker.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    schema: "roll-agent-capacity-broker-lock/v1",
    ownerToken: "stale-owner",
    acquiredAtMs: 1,
    ...owner,
  }));
}

function writeBrokerReclaimMarker(root: string, token: string, owner: {
  readonly host: string;
  readonly pid: number;
  readonly processStartedAtMs: number;
}): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `.broker-reclaim.${token}.json`), JSON.stringify({
    schema: "roll-agent-capacity-broker-lock/v1",
    ownerToken: token,
    acquiredAtMs: 1,
    ...owner,
  }));
}

describe("NodeAgentCapacityBroker", () => {
  it("uses the inspected process start identity for broker lock ownership", () => {
    let inspected = false;
    new NodeAgentCapacityBroker({
      root: tempDir("capacity-broker-process-identity"),
      policy: POLICY,
      clockMs: () => 1_000,
      host: hostname(),
      processStartedAtMs: 999.75,
      processIdentity: (pid) => {
        if (pid === process.pid) inspected = true;
        return { alive: true, startedAtMs: 500 };
      },
    });

    expect(inspected).toBe(true);
  });

  it("reclaims a stale same-host dead broker transaction lock", () => {
    const root = tempDir("capacity-stale-broker-lock");
    writeBrokerLock(root, { host: hostname(), pid: 2000, processStartedAtMs: 500 });

    const result = new NodeAgentCapacityBroker({
      root,
      policy: POLICY,
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: false }),
      lockWaitMs: 0,
    }).acquire(request("after-crash"));

    expect(result.kind).toBe("acquired");
    expect(existsSync(join(root, "broker.lock"))).toBe(false);
  });

  it("reclaims a broker lock after PID reuse but preserves the live exact owner", () => {
    const reusedRoot = tempDir("capacity-reused-broker-lock");
    writeBrokerLock(reusedRoot, { host: hostname(), pid: 2000, processStartedAtMs: 500 });
    const reclaimed = new NodeAgentCapacityBroker({
      root: reusedRoot,
      policy: POLICY,
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: true, startedAtMs: 999 }),
      lockWaitMs: 0,
    }).acquire(request("after-pid-reuse"));
    expect(reclaimed.kind).toBe("acquired");

    const liveRoot = tempDir("capacity-live-broker-lock");
    writeBrokerLock(liveRoot, { host: hostname(), pid: 2000, processStartedAtMs: 500 });
    expect(() => new NodeAgentCapacityBroker({
      root: liveRoot,
      policy: POLICY,
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: true, startedAtMs: 500 }),
      lockWaitMs: 0,
    }).acquire(request("blocked"))).toThrow("agent_capacity_broker_lock_busy");
    expect(existsSync(join(liveRoot, "broker.lock"))).toBe(true);
  });

  it("does not replace a stale broker lock while another live reclaimer owns the recovery guard", () => {
    const root = tempDir("capacity-live-reclaimer");
    writeBrokerLock(root, { host: hostname(), pid: 2000, processStartedAtMs: 500 });
    writeBrokerReclaimMarker(root, "live-reclaimer", {
      host: hostname(),
      pid: 3000,
      processStartedAtMs: 700,
    });

    expect(() => new NodeAgentCapacityBroker({
      root,
      policy: POLICY,
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: (pid) => pid === 3000
        ? { alive: true, startedAtMs: 700 }
        : { alive: false },
      lockWaitMs: 0,
    }).acquire(request("guarded"))).toThrow("agent_capacity_broker_lock_busy");
    expect(existsSync(join(root, "broker.lock"))).toBe(true);
  });

  it("serializes a real concurrent broker transaction before claiming", async () => {
    const root = tempDir("capacity-lock-contention");
    const child = spawn(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const root = process.argv[1];",
        "fs.mkdirSync(root, { recursive: true });",
        "const lock = path.join(root, 'broker.lock');",
        "fs.writeFileSync(lock, 'held');",
        "process.stdout.write('ready\\n');",
        "setTimeout(() => fs.unlinkSync(lock), 100);",
      ].join(""),
      root,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    await once(child.stdout!, "data");

    const result = new NodeAgentCapacityBroker({
      root,
      policy: POLICY,
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: true, startedAtMs: 500 }),
      lockWaitMs: 1_000,
      lockPollMs: 5,
    }).acquire(request("contended"));

    expect(result.kind).toBe("acquired");
    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
  });

  it("enforces per-agent aggregation across model and context while distinct slots run", () => {
    const root = tempDir("capacity-limits");
    const first = broker(root).acquire(request("one"));
    const sameAgent = broker(root).acquire({
      ...request("two"),
      key: { agent: "codex", model: "other-model", contextKey: "other-account" },
    });
    const distinct = broker(root).acquire(request("three", "claude"));

    expect(first.kind).toBe("acquired");
    expect(sameAgent).toMatchObject({ kind: "waiting", suspect: false });
    expect(distinct.kind).toBe("acquired");
  });

  it("enforces the global limit under the same broker lock", () => {
    const root = tempDir("capacity-global");
    const limited = new NodeAgentCapacityBroker({
      root,
      policy: { ...POLICY, global: 1 },
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: true, startedAtMs: 500 }),
    });
    expect(limited.acquire(request("one")).kind).toBe("acquired");
    expect(limited.acquire(request("two", "claude"))).toMatchObject({ kind: "waiting", suspect: false });
  });

  it("requires exact ownership for heartbeat and release and makes repeated release idempotent", () => {
    const root = tempDir("capacity-owner");
    const acquired = broker(root).acquire(request("one"));
    expect(acquired.kind).toBe("acquired");
    expect(broker(root, 2_000).heartbeat("lease-one", "wrong-token")).toEqual({
      kind: "ownership_lost",
      reason: "owner_token_mismatch",
    });
    expect(broker(root, 2_000).heartbeat("lease-one", "token-one")).toEqual({ kind: "updated" });
    expect(broker(root).release("lease-one", "wrong-token")).toEqual({
      kind: "ownership_lost",
      reason: "owner_token_mismatch",
    });
    expect(broker(root).release("lease-one", "token-one")).toEqual({ kind: "released" });
    expect(broker(root).release("lease-one", "token-one")).toEqual({ kind: "already_released" });
  });

  it("reclaims only stale same-host dead owners", () => {
    const root = tempDir("capacity-dead");
    const first = new NodeAgentCapacityBroker({
      root,
      policy: { ...POLICY, global: 1 },
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: true, startedAtMs: 500 }),
    });
    expect(first.acquire(request("dead", "codex", { pid: 2000 })).kind).toBe("acquired");
    const reclaim = new NodeAgentCapacityBroker({
      root,
      policy: { ...POLICY, global: 1 },
      clockMs: () => 40_000,
      host: hostname(),
      processIdentity: () => ({ alive: false }),
    });
    expect(reclaim.acquire(request("next", "claude"))).toMatchObject({ kind: "acquired" });
  });

  it("cleans exactly one stale same-host dead lease and repeats idempotently", () => {
    const root = tempDir("capacity-doctor-cleanup");
    expect(broker(root).acquire(request("dead", "codex", { pid: 2000 })).kind).toBe("acquired");
    const doctor = new NodeAgentCapacityBroker({
      root,
      policy: POLICY,
      clockMs: () => 40_000,
      host: hostname(),
      processIdentity: () => ({ alive: false }),
    });

    expect(doctor.cleanupStaleOwned("lease-dead")).toEqual({ kind: "cleaned" });
    expect(doctor.cleanupStaleOwned("lease-dead")).toEqual({ kind: "already_clean" });
  });

  it.each([
    ["active", 2_000, hostname(), { alive: false }, "lease_active"],
    ["foreign", 40_000, "remote-host", { alive: false }, "foreign_owner"],
    ["live", 40_000, hostname(), { alive: true, startedAtMs: 500 }, "owner_process_alive"],
  ] as const)("blocks %s lease cleanup without deleting it", (_label, now, leaseHost, identity, reason) => {
    const root = tempDir("capacity-doctor-blocked");
    expect(broker(root).acquire(request("held", "codex", { host: leaseHost })).kind).toBe("acquired");
    const doctor = new NodeAgentCapacityBroker({
      root,
      policy: POLICY,
      clockMs: () => now,
      host: hostname(),
      processIdentity: () => identity,
    });

    expect(doctor.cleanupStaleOwned("lease-held")).toEqual({ kind: "blocked", reason });
    expect(readdirSync(join(root, "leases"))).toHaveLength(1);
  });

  it.each([
    ["live stale", hostname(), { alive: true, startedAtMs: 500 }],
    ["pid reuse", hostname(), { alive: true, startedAtMs: 999 }],
    ["cross host", "remote-host", { alive: false }],
  ] as const)("keeps %s leases suspect instead of stealing them", (_label, leaseHost, identity) => {
    const root = tempDir("capacity-suspect");
    const initial = new NodeAgentCapacityBroker({
      root,
      policy: { ...POLICY, global: 1 },
      clockMs: () => 1_000,
      host: hostname(),
      processIdentity: () => ({ alive: true, startedAtMs: 500 }),
    });
    expect(initial.acquire(request("old", "codex", { host: leaseHost })).kind).toBe("acquired");
    const later = new NodeAgentCapacityBroker({
      root,
      policy: { ...POLICY, global: 1 },
      clockMs: () => 40_000,
      host: hostname(),
      processIdentity: () => identity,
    });
    expect(later.acquire(request("next", "claude"))).toMatchObject({ kind: "waiting", suspect: true });
  });

  it("keeps unknown-schema files suspect and never deletes them", () => {
    const root = tempDir("capacity-unknown");
    const leases = join(root, "leases");
    mkdirSync(leases, { recursive: true });
    const path = join(leases, "future.json");
    writeFileSync(path, JSON.stringify({ schema: "roll-agent-capacity-lease/v2", private: "keep" }));

    expect(broker(root, 40_000).acquire(request("next"))).toMatchObject({ kind: "waiting", suspect: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schema: "roll-agent-capacity-lease/v2",
      private: "keep",
    });
  });
});
