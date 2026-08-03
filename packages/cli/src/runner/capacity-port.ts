import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_REGISTRY_NAMES,
  normalizeAgentCapacityPolicy,
  normalizeAgentScopeConfig,
} from "@roll/core";
import type { AgentName, NormalizedAgentCapacityPolicy } from "@roll/spec";
import { NodeAgentCapacityBroker } from "@roll/infra";
import type { AgentCapacityPort, ProcessClock, RunnerPaths } from "./ports.js";

function readMachineCapacityPolicy(machineHome: string): NormalizedAgentCapacityPolicy {
  const path = join(machineHome, "agents.yaml");
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    if (text.includes("roll-agents/v1")) {
      const parsed = normalizeAgentScopeConfig(text);
      if (parsed.config === null || parsed.config.scope !== "machine" || parsed.errors.length > 0) {
        throw new Error(`invalid machine agent capacity config: ${parsed.errors.join("; ") || "expected machine scope"}`);
      }
      return normalizeAgentCapacityPolicy(parsed.config);
    }
  }
  const perAgent: Partial<Record<AgentName, number>> = {};
  for (const agent of AGENT_REGISTRY_NAMES as readonly AgentName[]) perAgent[agent] = 1;
  return {
    global: Object.keys(perAgent).length,
    perAgent,
    heartbeatSeconds: 30,
    staleAfterSeconds: 120,
  };
}

function processIdentity(pid: number): { alive: boolean; startedAtMs?: number } {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    return code === "EPERM" ? { alive: true } : { alive: false };
  }
  try {
    const raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? { alive: true, startedAtMs: parsed } : { alive: true };
  } catch {
    return { alive: true };
  }
}

export function createNodeAgentCapacityPort(opts: {
  readonly paths: RunnerPaths;
  readonly clock: ProcessClock;
  readonly capacityRoot?: string;
}): AgentCapacityPort {
  const machineHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  const policy = readMachineCapacityPolicy(machineHome);
  const root = opts.capacityRoot ?? (
    process.env["VITEST"] === "true"
      ? join(dirname(opts.paths.eventsPath), "capacity")
      : join(machineHome, "locks", "capacity")
  );
  const controllerStartedAtMs = Date.now() - process.uptime() * 1_000;
  const host = hostname();
  const broker = new NodeAgentCapacityBroker({
    root,
    policy,
    clockMs: () => opts.clock() * 1_000,
    host,
    processIdentity,
    processStartedAtMs: controllerStartedAtMs,
  });
  let currentLease: import("@roll/spec").AgentCapacityLease | undefined;

  return {
    heartbeatIntervalMs: Math.max(1_000, policy.heartbeatSeconds * 1_000),
    acquire(pending, ctx) {
      const result = broker.acquire({
        key: pending.key,
        owner: {
          leaseId: randomUUID(),
          ownerToken: randomUUID(),
          workspaceId: ctx.repositoryExecution?.workspaceId ?? process.env["ROLL_WORKSPACE"] ?? "legacy-project",
          storyId: ctx.storyId ?? "",
          cycleId: ctx.cycleId,
          spawnId: pending.spawnId,
          host,
          pid: process.pid,
          processStartedAtMs: controllerStartedAtMs,
        },
      });
      if (result.kind === "acquired") currentLease = result.lease;
      return result;
    },
    heartbeat(leaseId, ownerToken) {
      return broker.heartbeat(leaseId, ownerToken);
    },
    release(leaseId, ownerToken) {
      const result = broker.release(leaseId, ownerToken);
      if (
        (result.kind === "released" || result.kind === "already_released") &&
        currentLease?.owner.leaseId === leaseId
      ) currentLease = undefined;
      return result;
    },
    releaseCurrent(cycleId) {
      if (currentLease === undefined || currentLease.owner.cycleId !== cycleId) {
        return { kind: "already_released" };
      }
      const result = broker.release(currentLease.owner.leaseId, currentLease.owner.ownerToken);
      if (result.kind === "released" || result.kind === "already_released") currentLease = undefined;
      return result;
    },
  };
}
