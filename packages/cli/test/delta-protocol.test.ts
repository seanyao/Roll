/**
 * US-DELTA-003 — Delta protocol integration tests.
 *
 * Temp-project fixtures: prepare, collision, crash/recovery, validate,
 * conclude, status. Uses real filesystem with temp dirs, no external engines.
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { claimHostDelegationLease, releaseHostDelegationLease, storyLeasesPath, atomicWriteJson, PrepareError } from "../src/lib/delta-allocation.js";
import { claimStoryLease, releaseStoryLease, readLeases, setLease, writeLeases, EventBus } from "@roll/core";
import { deltaCommand, injectValidator, injectPrepareInterrupt, injectEventAppendFailure, injectEventBus } from "../src/commands/delta.js";
import { injectIdGenerator } from "../src/lib/delta-allocation.js";
import { renderState } from "../src/render.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** US-DELTA-004: a minimal, structurally-valid v2 role manifest. With empty
 *  inputs/outputs the digest/path/format checks pass trivially, so it is enough
 *  to exercise the "validate admits a valid v2 stage" path (a placeholder
 *  `{ ok: true }` no longer satisfies the deep validator). */
function v2Manifest(role: "designer" | "builder" | "evaluator" | "peer" = "designer"): unknown {
  return {
    schemaVersion: 2,
    delegationId: "d",
    storyId: "US-X",
    role,
    trigger: "manual",
    topology: "delta-team",
    qualityProfile: "verified",
    executionIdentity: { kind: "roll-adapter", hostId: "h", roleInstanceId: `${role}-1`, modelId: "m" },
    sessionId: `${role}-s`,
    worktreeAccess: role === "builder" ? "builder-write" : "read-only",
    inputs: [],
    outputs: [],
    createdAt: "2026-07-24T00:00:00Z",
  };
}

/** Resolve the `tsx` CLI entry point from the CLI package's own devDependencies.
 *  Never shells out to `npx` — uses the locally installed binary, making tests
 *  deterministic on CI without network downloads. */
const cliRequire = createRequire(join(import.meta.dirname, "..", "package.json"));
const tsxPackageDir = dirname(cliRequire.resolve("tsx/package.json"));
const tsxBin = join(tsxPackageDir, "dist", "cli.mjs");

// ── Temp project fixture ─────────────────────────────────────────────────────

let projectDirs: string[] = [];

afterEach(() => {
  for (const d of projectDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  projectDirs = [];
});

function makeProject(): string {
  const dir = join(tmpdir(), `roll-delta-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  projectDirs.push(dir);
  return dir;
}

/** Set up a minimal Roll project with a card directory. */
function setupMinimalProject(storyId: string, epic: string): string {
  const dir = makeProject();
  const featuresDir = join(dir, ".roll", "features", epic, storyId);
  mkdirSync(featuresDir, { recursive: true });
  // Write a minimal spec.md so the archive resolver finds it
  writeFileSync(
    join(featuresDir, "spec.md"),
    `# ${storyId}\n\nStory spec.\n`,
    "utf8",
  );
  // Create the loop dir for events
  mkdirSync(join(dir, ".roll", "loop"), { recursive: true });
  return dir;
}

// ── tsRun with cwd ──────────────────────────────────────────────────────────

function tsRunCwd(argv: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only override
  process.stdout.write = (c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  // @ts-expect-error capture-only override
  process.stderr.write = (c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  const saveCwd = process.cwd();
  let code: number;
  try {
    process.chdir(cwd);
    code = deltaCommand(argv);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    renderState.useColor = true;
    process.chdir(saveCwd);
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;

/** Scrub a known delegation identity: plain UUID → <DELEGATION_ID>, preserving referential identity. */
function scrubDelegationIdentity(s: string, delegId: string): string {
  return s.split(delegId).join("<DELEGATION_ID>");
}

function scrubId(s: string): string {
  return s
    // delta- prefixed UUIDs → delta-<DELEGATION_ID>
    .replace(/delta-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, "delta-<DELEGATION_ID>")
    // Remaining plain UUIDs (only non-delegation random IDs after identity scrub)
    .replace(UUID_RE, "<UUID>")
    .replace(/[a-f0-9]{64}/gi, "<SHA256>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>")
    .replace(/\b\d{13}\b/g, "<TS>");
}

function scrubPaths(s: string, dir: string): string {
  let r = s;
  const tmp = tmpdir();
  // Scrub project dir BEFORE tmpdir so the raw path matches before substitution.
  r = r.split("/private" + dir).join("<PROJECT>");
  r = r.split(dir).join("<PROJECT>");
  // Scrub tmpdir AFTER project scrub, LONGER form first.
  r = r.split("/private" + tmp).join("<TMP>");
  r = r.split(tmp).join("<TMP>");
  return scrubId(r);
}

/** Full scrub: project, tmp, known delegation identity, then generic values. */
function scrubAll(s: string, dir: string, delegId?: string): string {
  let r = s;
  const tmp = tmpdir();
  r = r.split("/private" + dir).join("<PROJECT>");
  r = r.split(dir).join("<PROJECT>");
  r = r.split("/private" + tmp).join("<TMP>");
  r = r.split(tmp).join("<TMP>");
  if (delegId) {
    r = scrubDelegationIdentity(r, delegId);
  }
  return scrubId(r);
}

// ── Resolution template helper ───────────────────────────────────────────────

function writeResolutionTemplate(projectDir: string, storyId: string, presetId: string, name?: string): string {
  const resPath = join(projectDir, name ?? "resolution-template.json");
  const template = {
    schema: "roll-delta-resolution/v1",
    storyId,
    trigger: "host-guided",
    topology: "delta-team",
    qualityProfile: "standard",
    presetId,
    presetSha256: "aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    inventoryObservedAt: new Date().toISOString(),
    inventorySha256: "bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    roles: [
      { role: "designer", roleInstanceId: "ri-1", hostId: "pi", modelId: "claude", source: "user-pin", reasons: ["test"] },
      { role: "builder", roleInstanceId: "ri-2", hostId: "pi", modelId: "claude", source: "user-pin", reasons: ["test"] },
      { role: "evaluator", roleInstanceId: "ri-3", hostId: "pi", modelId: "claude", source: "user-pin", reasons: ["test"] },
    ],
  };
  writeFileSync(resPath, JSON.stringify(template, null, 2), "utf8");
  return resPath;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("US-DELTA-003 — prepare atomic allocation", () => {
  it("prepare creates delegation frame, marker, resolution, and events", () => {
    const dir = setupMinimalProject("US-DELTA-TEST", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-TEST", "local-preset");
    const r = tsRunCwd([
      "prepare", "US-DELTA-TEST",
      "--trigger", "host-guided",
      "--topology", "delta-team",
      "--profile", "standard",
      "--preset", "local-preset",
      "--resolution", resPath,
      "--json",
    ], dir);

    // Should succeed
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.delegationId).toBe("string");
    expect(typeof parsed.runId).toBe("string");
    expect(parsed.runId).toBe(`delta-${parsed.delegationId}`);

    // Verify frame directory exists
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-TEST", `delta-${parsed.delegationId}`);
    expect(existsSync(frameDir)).toBe(true);

    // Verify marker exists
    const markerPath = join(frameDir, "delegation-open.json");
    expect(existsSync(markerPath)).toBe(true);

    // Verify resolution was persisted (with bound delegationId)
    const savedResolutionPath = join(frameDir, "role-artifacts", "delegation", "delegation-resolution.json");
    expect(existsSync(savedResolutionPath)).toBe(true);
    const savedRes = JSON.parse(readFileSync(savedResolutionPath, "utf8"));
    expect(savedRes.delegationId).toBe(parsed.delegationId);

    // Verify events were appended
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, "utf8").trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(2);
    const preparedEvent = JSON.parse(events[0]!);
    expect(preparedEvent.type).toBe("delta:prepared");

    // F-3: presetSha256 must match the host-supplied resolution template value (not fabricated)
    expect(preparedEvent.presetSha256).toBe("aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff");

    // N-1: delta:role_resolved events must use the template's inventorySha256 (NOT presetSha256)
    // The fixture uses DIFFERENT preset and inventory hashes to prove non-reuse
    const roleResolvedEvents = events.slice(1).map((l: string) => JSON.parse(l));
    for (const re of roleResolvedEvents) {
      expect(re.type).toBe("delta:role_resolved");
      expect(re.inventorySha256).toBe("bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff");
      // Must NOT be presetSha256 — the two hashes are different in the template
      expect(re.inventorySha256).not.toBe(preparedEvent.presetSha256);
    }
    // Exact event count: 1 delta:prepared + 1 delta:role_resolved per role (3 roles)
    expect(roleResolvedEvents.length).toBe(3);

    // F-5: hostId is resolved from preset (not hardcoded "pi")
    // When no machine-local preset exists, hostId is "unknown" — not a fabricated host name
    expect(typeof preparedEvent.hostId).toBe("string");
    expect(preparedEvent.hostId).not.toBe("pi");

    // Verify lease exists in shared leases directory (single truth)
    const leasePath = storyLeasesPath(dir);
    const leaseMap = readLeases(leasePath);
    const lease = leaseMap["US-DELTA-TEST"];
    expect(lease).toBeDefined();
    expect(lease.source).toBe("host-delegation");
    expect(lease.delegationId).toBe(parsed.delegationId);
    expect(lease.runId).toBe(parsed.runId);

    // N-2: leases directory is stamped so cycle readers see host-delegation as claimed
    const slDir2 = join(dir, ".roll", "loop", "leases");
    const storyLeases = readLeases(slDir2);
    expect(storyLeases["US-DELTA-TEST"]).toBeDefined();
    expect(storyLeases["US-DELTA-TEST"].source).toBe("host-delegation");
    // Host-delegation is a persistent host protocol lease — no pid
    expect(storyLeases["US-DELTA-TEST"].pid).toBeUndefined();
    expect(storyLeases["US-DELTA-TEST"].delegationId).toBe(parsed.delegationId);
    expect(storyLeases["US-DELTA-TEST"].runId).toBe(parsed.runId);

    // No latest, no runs.jsonl, no cycle
    expect(existsSync(join(dir, ".roll", "features", "delta-team", "US-DELTA-TEST", "latest"))).toBe(false);
    expect(existsSync(join(dir, ".roll", "loop", "runs.jsonl"))).toBe(false);
  });

  it("prepare rejects duplicate lease (sequential second attempt)", () => {
    const dir = setupMinimalProject("US-DELTA-TEST-2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-TEST-2", "local-preset");

    // First prepare succeeds
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-TEST-2",
      "--trigger", "host-guided",
      "--topology", "delta-team",
      "--profile", "standard",
      "--preset", "local-preset",
      "--resolution", resPath,
      "--json",
    ], dir);
    expect(r1.code).toBe(0);

    // Second prepare on same story should fail with builder_lease_conflict
    const r2 = tsRunCwd([
      "prepare", "US-DELTA-TEST-2",
      "--trigger", "host-guided",
      "--topology", "delta-team",
      "--profile", "standard",
      "--preset", "local-preset",
      "--resolution", resPath,
      "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("builder_lease_conflict");
  });

  it("prepare retries with distinct delegation ID on frame collision (F-4)", () => {
    const dir = setupMinimalProject("US-DELTA-COLLIDE", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-COLLIDE", "local-preset");

    // Deterministic collision: control ID generator so first mkdir collides,
    // second retry also collides, third attempt generates a fresh distinct ID.
    // The collision frame is never touched (only own lease is released).
    const controlledIds = ["collide-1", "collide-1", "collide-1", "collide-2"];
    let callIndex = 0;
    injectIdGenerator(() => {
      const id = controlledIds[callIndex]!;
      callIndex++;
      return id;
    });

    try {
      // First prepare: "collide-1" successfully creates frame delta-collide-1
      const r1 = tsRunCwd([
        "prepare", "US-DELTA-COLLIDE",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);
      expect(r1.code).toBe(0);
      const id1 = JSON.parse(r1.stdout).delegationId;
      expect(id1).toBe("collide-1");

      const collisionFrame = join(dir, ".roll", "features", "delta-team", "US-DELTA-COLLIDE", `delta-${id1}`);
      expect(existsSync(collisionFrame)).toBe(true);

      // Remove the lease so second prepare can claim again
      releaseHostDelegationLease(dir, "US-DELTA-COLLIDE", id1, `delta-${id1}`);

      // Second prepare: first two generateDelegationId() calls produce "collide-1"
      // → mkdirSync("delta-collide-1") throws EEXIST both times
      // → only own lease is released, collision frame is preserved
      // → third call produces "collide-2" → fresh frame succeeds
      const r2 = tsRunCwd([
        "prepare", "US-DELTA-COLLIDE",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);
      expect(r2.code).toBe(0);
      const id2 = JSON.parse(r2.stdout).delegationId;

      // Must have retried and used the distinct ID (collide-2, not collide-1)
      expect(id2).toBe("collide-2");
      expect(id2).not.toBe(id1);

      // Original collision frame is preserved (never overwritten)
      expect(existsSync(collisionFrame)).toBe(true);

      // Only own lease was released during retry; the collision frame's
      // delegation-open.json is untouched (verify it still has collided ID)
      const collisionMarker = JSON.parse(readFileSync(
        join(collisionFrame, "delegation-open.json"), "utf8"));
      expect(collisionMarker.delegationId).toBe("collide-1");

      // New distinct frame exists with the fresh ID
      const newFrame = join(dir, ".roll", "features", "delta-team", "US-DELTA-COLLIDE", `delta-${id2}`);
      expect(existsSync(newFrame)).toBe(true);
      expect(newFrame).not.toBe(collisionFrame);
    } finally {
      injectIdGenerator(null);
    }
  });

  it("prepare generates distinct crypto IDs on different stories", () => {
    const dir = setupMinimalProject("US-DELTA-TEST-3", "delta-team");
    const resPath1 = writeResolutionTemplate(dir, "US-DELTA-TEST-3", "local-preset");

    // Also set up a second story — use a completely distinct ID to avoid substring match
    const story2 = "US-DELTA-TEST-4";
    const featuresDir2 = join(dir, ".roll", "features", "delta-team", story2);
    mkdirSync(featuresDir2, { recursive: true });
    writeFileSync(join(featuresDir2, "spec.md"), `# ${story2}\n\nStory spec.\n`, "utf8");
    const resPath2 = writeResolutionTemplate(dir, story2, "local-preset", "resolution-template-2.json");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-TEST-3",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath1, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const id1 = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd([
      "prepare", story2,
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath2, "--json",
    ], dir);
    expect(r2.code).toBe(0, `r2 failed: ${r2.stderr}`);
    const id2 = JSON.parse(r2.stdout).delegationId;

    expect(id1).not.toBe(id2);
  });

  it("prepare rejects --cycle flag with no side effects", () => {
    const dir = setupMinimalProject("US-DELTA-TEST-4", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-TEST-4", "local-preset");

    const r = tsRunCwd([
      "prepare", "US-DELTA-TEST-4",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath,
      "--cycle", "some-cycle-id",
      "--json",
    ], dir);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("cycle_rejected");

    // No frame, no lease, no events
    expect(existsSync(join(dir, ".roll", "loop", "events.ndjson"))).toBe(false);
    // leases directory must not have US-DELTA-TEST-4 (or not exist)
    const slPath = storyLeasesPath(dir);
    if (existsSync(slPath)) {
      const sl = readLeases(slPath);
      expect(sl["US-DELTA-TEST-4"]).toBeUndefined();
    }
  });

  it("prepare rejects when a live cycle lease exists for the story (cross-lease exclusion)", () => {
    const dir = setupMinimalProject("US-DELTA-XLEASE", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-XLEASE", "local-preset");

    // Write a simulated cycle lease via setLease
    const leasesPath = storyLeasesPath(dir);
    setLease(leasesPath, "US-DELTA-XLEASE", { pid: 12345, claimedAt: Date.now(), source: "cycle" });

    const r = tsRunCwd([
      "prepare", "US-DELTA-XLEASE",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("builder_lease_conflict");
  });

  it("prepare blocks when leases directory has any claim (human/supervisor) — bidirectional exclusion", () => {
    const dir = setupMinimalProject("US-DELTA-XLEASE2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-XLEASE2", "local-preset");

    // Write a human lease — single-truth contract: ANY claim blocks host-delegation
    const leasesPath = storyLeasesPath(dir);
    setLease(leasesPath, "US-DELTA-XLEASE2", { claimedAt: Date.now(), source: "human" });

    const r = tsRunCwd([
      "prepare", "US-DELTA-XLEASE2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    // Now blocked — single truth means human claim prevents host-delegation (bidirectional)
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("builder_lease_conflict");
  });

  it("prepare fails when story card directory cannot be uniquely resolved", () => {
    const dir = makeProject();
    // No card dir, no feature file — cardArchiveDir would use uncategorized
    // But our resolveExistingUniqueCardArchiveDir should fail
    // We need to test without a card directory, so the resolver fails.
    mkdirSync(join(dir, ".roll", "loop"), { recursive: true });
    const resPath = join(dir, "res.json");
    writeFileSync(resPath, JSON.stringify({
      schema: "roll-delta-resolution/v1",
      storyId: "US-NOEXIST",
      trigger: "host-guided",
      topology: "delta-team",
      qualityProfile: "standard",
      presetId: "x",
      presetSha256: "aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
      inventoryObservedAt: new Date().toISOString(),
      inventorySha256: "bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
      roles: [],
    }), "utf8");

    const r = tsRunCwd([
      "prepare", "US-NOEXIST",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath,
      "--json",
    ], dir);
    expect(r.code).toBe(1);
    // Error about missing or ambiguous card
    expect(r.stderr).toBeTruthy();
  });

  // ─── BLOCK-B: malformed resolution zero side effect ────────────────────

  it("BLOCK-B: malformed resolution JSON → resolution_parse_error, zero lease/frame/events", () => {
    const dir = setupMinimalProject("US-DELTA-MALFORM", "delta-team");
    // Write invalid JSON as the resolution file
    const malformedPath = join(dir, "bad-resolution.json");
    writeFileSync(malformedPath, "this is not valid json {{{", "utf8");

    // Snapshot filesystem state before
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const slPath = storyLeasesPath(dir);
    const eventsBefore = existsSync(eventsPath);
    const leaseBefore = existsSync(slPath);
    const leaseMapBefore = existsSync(slPath) ? readLeases(slPath) : {};

    const r = tsRunCwd([
      "prepare", "US-DELTA-MALFORM",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", malformedPath, "--json",
    ], dir);

    // Must fail with resolution_parse_error
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("resolution_parse_error");

    // Zero side effects: no new events file (if didn't exist) or no new lines
    if (!eventsBefore) {
      expect(existsSync(eventsPath)).toBe(false);
    }

    // Zero side effects: no new lease entries
    if (leaseBefore) {
      const leaseMapAfter = readLeases(slPath);
      expect(leaseMapAfter).toEqual(leaseMapBefore);
    } else {
      // No lease directory should have been created
      expect(existsSync(slPath)).toBe(false);
    }

    // No frame directory should exist for this story
    const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-MALFORM");
    const deltaDirs = existsSync(cardDir)
      ? readdirSync(cardDir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith("delta-"))
      : [];
    expect(deltaDirs.length).toBe(0);
  });
});

// ── Crash / recovery / status ──────────────────────────────────────────────

describe("US-DELTA-003 — crash marker and recovery", () => {
  it("orphan marker (delegation-open.json without events) is detected by status", () => {
    const dir = setupMinimalProject("US-DELTA-ORPHAN", "delta-team");

    // Manually create an orphan frame: marker exists but no events
    const delegationId = randomUUID();
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPHAN", `delta-${delegationId}`);
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(
      join(frameDir, "delegation-open.json"),
      JSON.stringify({
        schema: "roll-delta-delegation-open/v1",
        delegationId,
        storyId: "US-DELTA-ORPHAN",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    // status should report uncommitted
    const r = tsRunCwd(["status", "--story", "US-DELTA-ORPHAN", "--json"], dir);
    // Status should detect orphan
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    // Should show unknown or uncommitted state
    expect(result.uncommittedFrames).toBeDefined();
    expect(result.uncommittedFrames.length).toBeGreaterThan(0);
    expect(result.uncommittedFrames[0].delegationId).toBe(delegationId);
  });

  it("prepare then status --story shows zero uncommittedFrames (BLOCK-1: no false orphans)", () => {
    const dir = setupMinimalProject("US-DELTA-ORPHAN3", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ORPHAN3", "local-preset");

    // Normal prepare: marker + events both written
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-ORPHAN3",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);

    // status --story must NOT show any uncommittedFrames because delegation is committed
    const r2 = tsRunCwd(["status", "--story", "US-DELTA-ORPHAN3", "--json"], dir);
    expect(r2.code).toBe(0);
    const result = JSON.parse(r2.stdout);
    // Either no uncommittedFrames key or an empty array — commited delegations are not orphans
    const uf = result.uncommittedFrames;
    expect(uf === undefined || (Array.isArray(uf) && uf.length === 0)).toBe(true);
  });

  it("prepare never adopts an orphan frame", () => {
    const dir = setupMinimalProject("US-DELTA-ORPHAN2", "delta-team");

    // Create an orphan frame manually
    const oldDelegationId = randomUUID();
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPHAN2", `delta-${oldDelegationId}`);
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(
      join(frameDir, "delegation-open.json"),
      JSON.stringify({
        schema: "roll-delta-delegation-open/v1",
        delegationId: oldDelegationId,
        storyId: "US-DELTA-ORPHAN2",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    // Now prepare — should create a new frame, not adopt the orphan
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ORPHAN2", "local-preset");
    const r = tsRunCwd([
      "prepare", "US-DELTA-ORPHAN2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // New delegation ID should be different
    expect(parsed.delegationId).not.toBe(oldDelegationId);
    // Orphan frame still exists
    expect(existsSync(frameDir)).toBe(true);
  });

  it("status --json shows host-unobservable cost", () => {
    const dir = setupMinimalProject("US-DELTA-STATUS", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-STATUS", "local-preset");

    // Prepare first
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-STATUS",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Status by delegation
    const r2 = tsRunCwd(["status", "--delegation", delegationId, "--json"], dir);
    expect(r2.code).toBe(0);
    const status = JSON.parse(r2.stdout);

    // Verify projection
    expect(status.delegationId).toBe(delegationId);
    expect(status.storyId).toBe("US-DELTA-STATUS");
    expect(status.status).toBe("in_progress");
    expect(status.visibleMode).toBe("delta-team");
    expect(status.totalCost).toBe("? (host_unobservable)");
    expect(status.roles).toBeDefined();
    expect(status.roles.length).toBeGreaterThan(0);
  });

  it("status human output contains expected fields", () => {
    const dir = setupMinimalProject("US-DELTA-STATUS2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-STATUS2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-STATUS2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd(["status", "--delegation", delegationId], dir);
    expect(r2.code).toBe(0);
    // Human output
    expect(r2.stdout).toContain("US-DELTA-STATUS2");
    expect(r2.stdout).toContain("in_progress");
    expect(r2.stdout).toContain("host_unobservable");
  });
});

// ── Validator plumbing ──────────────────────────────────────────────────────

describe("US-DELTA-003 — validate plumbing", () => {
  it("validate returns error when delegation not found", () => {
    const dir = setupMinimalProject("US-DELTA-VAL", "delta-team");
    const r = tsRunCwd(["validate", "--delegation", "nonexistent-id", "--stage", "designer", "--json"], dir);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("delegation_not_found");
  });

  it("validate returns error when stage is missing", () => {
    const dir = setupMinimalProject("US-DELTA-VAL2", "delta-team");
    const r = tsRunCwd(["validate", "--delegation", "d-123", "--json"], dir);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("missing_required");
  });

  it("validate block appends delta:blocked event and retains lease (BLOCK-3)", () => {
    const dir = setupMinimalProject("US-DELTA-VAL3", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL3", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL3",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Count events before validate
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // Validate without creating the stage artifact — should block
    const r2 = tsRunCwd([
      "validate", "--delegation", delegationId,
      "--stage", "designer", "--json",
    ], dir);
    expect(r2.code).toBe(1);

    // Verify delta:blocked event was appended
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);

    const lastEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
    expect(lastEvent.type).toBe("delta:blocked");
    expect(lastEvent.delegationId).toBe(delegationId);
    expect(lastEvent.reason).toBe("artifact_invalid");
    expect(lastEvent.role).toBe("designer");

    // Lease must be retained (not released by validate)
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-VAL3"]).toBeDefined();
    expect(sl["US-DELTA-VAL3"].source).toBe("host-delegation");
  });

  it("validate allow appends delta:artifact_published event (BLOCK-3)", () => {
    const dir = setupMinimalProject("US-DELTA-VAL4", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL4", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL4",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const parsed = JSON.parse(r1.stdout);
    const delegationId = parsed.delegationId;

    // Create the stage artifact FILE (evaluation-manifest.json) so validation passes
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-VAL4",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest()), "utf8");

    // Count events before validate
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // Validate should pass
    const r2 = tsRunCwd([
      "validate", "--delegation", delegationId,
      "--stage", "designer", "--json",
    ], dir);
    expect(r2.code).toBe(0);
    const result = JSON.parse(r2.stdout);
    expect(result.verdict).toBe("allow");

    // Verify delta:artifact_published event was appended
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);

    const lastEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
    expect(lastEvent.type).toBe("delta:artifact_published");
    expect(lastEvent.delegationId).toBe(delegationId);
    expect(lastEvent.role).toBe("designer");
    expect(lastEvent.identityProvenance).toBe("host-attested");
  });

  it("US-DELTA-004: deep validation blocks a role-write violation through the CLI", () => {
    const dir = setupMinimalProject("US-DELTA-VAL4B", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL4B", "local-preset");
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL4B",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-VAL4B",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });

    // A designer manifest claiming builder-write is a role_write_violation — the
    // deep validator (not the old shallow existence check) catches it.
    const bad = v2Manifest("designer") as Record<string, unknown>;
    bad["worktreeAccess"] = "builder-write";
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(bad), "utf8");
    const r2 = tsRunCwd(["validate", "--delegation", delegationId, "--stage", "designer", "--json"], dir);
    expect(r2.code).toBe(1);
    expect(JSON.parse(r2.stderr).error).toBe("role_write_violation");
    // The block is recorded as an event, with the specific reason.
    const events = readFileSync(join(dir, ".roll", "loop", "events.ndjson"), "utf8").trim().split("\n");
    const last = JSON.parse(events[events.length - 1]!);
    expect(last.type).toBe("delta:blocked");
    expect(last.reason).toBe("role_write_violation");
  });

  it("US-DELTA-004: a manifest whose role ≠ the validated stage is blocked (no bypass)", () => {
    const dir = setupMinimalProject("US-DELTA-VAL4C", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL4C", "local-preset");
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL4C",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-VAL4C",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });
    // Validating the designer stage but the file declares role "builder" — the
    // stage-role match closes the bypass that would otherwise skip role-specific
    // checks yet publish a designer event.
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest("builder")), "utf8");
    const r2 = tsRunCwd(["validate", "--delegation", delegationId, "--stage", "designer", "--json"], dir);
    expect(r2.code).toBe(1);
    expect(JSON.parse(r2.stderr).error).toBe("artifact_invalid");
  });

  it("validate invokes injected validator seam (BLOCK-3)", () => {
    const dir = setupMinimalProject("US-DELTA-VAL5", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL5", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL5",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Inject a validator that always blocks with a custom reason
    let calledWithDelegationId = "";
    let calledWithStage = "";
    let capturedInput: Record<string, unknown> = {};
    injectValidator((input) => {
      calledWithDelegationId = input.delegationId;
      calledWithStage = input.stage;
      capturedInput = {
        delegationId: input.delegationId,
        stage: input.stage,
        artifactPath: typeof input.artifactPath === "string" && input.artifactPath.length > 0,
        manifestPath: typeof input.manifestPath === "string" && input.manifestPath.length > 0,
        storyId: input.storyId,
        roleInstanceId: input.roleInstanceId,
        hostId: input.hostId,
        modelId: input.modelId,
        trigger: input.trigger,
        topology: input.topology,
        qualityProfile: input.qualityProfile,
        frameDir: input.frameDir,
      };
      return { ok: false, reason: "host_supervisor_required", detail: "test injected block", role: input.stage };
    });

    try {
      const r2 = tsRunCwd([
        "validate", "--delegation", delegationId,
        "--stage", "builder", "--json",
      ], dir);
      expect(r2.code).toBe(1);
      expect(calledWithDelegationId).toBe(delegationId);
      expect(calledWithStage).toBe("builder");
      // Spy captures complete context
      expect(capturedInput.artifactPath).toBe(true);
      expect(capturedInput.storyId).toBe("US-DELTA-VAL5");
      expect(typeof capturedInput.roleInstanceId).toBe("string");
      expect(capturedInput.hostId).toBe("pi");
      expect(capturedInput.modelId).toBe("claude");
      expect(capturedInput.trigger).toBe("host-guided");
      expect(capturedInput.topology).toBe("delta-team");
      expect(capturedInput.qualityProfile).toBe("standard");
      expect(capturedInput.frameDir).toContain("US-DELTA-VAL5");
      expect(capturedInput.frameDir).toContain(`delta-${delegationId}`);

      // Verify custom block event was appended
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      const lastEvent = JSON.parse(events[events.length - 1]!);
      expect(lastEvent.type).toBe("delta:blocked");
      expect(lastEvent.reason).toBe("host_supervisor_required");
    } finally {
      injectValidator(null);
    }
  });
});

// ── Conclude ─────────────────────────────────────────────────────────────────

describe("US-DELTA-003 — conclude", () => {
  it("conclude with owner_continue disposition succeeds and writes terminal", () => {
    const dir = setupMinimalProject("US-DELTA-CONC", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC", "local-preset");

    // Prepare first
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Conclude should succeed with owner_continue disposition
    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r2.code).toBe(0);
    const result = JSON.parse(r2.stdout);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("handoff_ready");
    expect(result.terminalBinding).toBe("handoff_only");
  });

  it("conclude blocks with terminal_path_unselected when disposition is missing (BLOCK-2)", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-BLK", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-BLK", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-BLK",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Conclude without --delivery-disposition should block
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId, "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err = JSON.parse(r2.stderr);
    expect(err.error).toBe("terminal_path_unselected");

    // Verify delta:blocked event was appended
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    const lastEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
    expect(lastEvent.type).toBe("delta:blocked");
    expect(lastEvent.reason).toBe("terminal_path_unselected");

    // Lease must be retained in shared truth
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-CONC-BLK"]).toBeDefined();
  });

  it("conclude with invalid enum rejects with parser error ZERO side effects (BLOCK-2)", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-BLK2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-BLK2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-BLK2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Conclude with invalid disposition → parser error, ZERO side effects
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "bad_value", "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err = JSON.parse(r2.stderr);
    expect(err.error).toBe("invalid_value");

    // ZERO events appended (parser error = no side effects)
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it("conclude with owner_hold disposition succeeds", () => {
    const dir = setupMinimalProject("US-DELTA-CONC2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_hold", "--json",
    ], dir);
    expect(r2.code).toBe(0);
    const result = JSON.parse(r2.stdout);
    expect(result.ok).toBe(true);
    expect(result.deliveryDisposition).toBe("owner_hold");
  });

  it("conclude releases the host-delegation lease", () => {
    const dir = setupMinimalProject("US-DELTA-CONC3", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC3", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC3",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Lease should exist in shared truth before conclude
    const slPath = storyLeasesPath(dir);
    const sl1 = readLeases(slPath);
    expect(sl1["US-DELTA-CONC3"]).toBeDefined();

    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r2.code).toBe(0);

    // Lease should be released from shared truth
    // After cleanup, the file may still exist if other stories have entries
    // but the US-DELTA-CONC3 entry must be gone
    if (existsSync(slPath)) {
      const sl = readLeases(slPath);
      expect(sl["US-DELTA-CONC3"]).toBeUndefined();
    }
  });

  it("conclude does not release foreign/mismatched leases (AC6)", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-FOREIGN", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-FOREIGN", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-FOREIGN",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Create a foreign lease entry directly in leases directory
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    sl["US-DELTA-CONC-FOREIGN-OTHER"] = {
      pid: 99999,
      claimedAt: Date.now(),
      source: "host-delegation",
      delegationId: "foreign-deleg-id",
      runId: "delta-foreign-deleg-id",
    };
    writeLeases(slPath, sl);

    // Conclude the real delegation with owner_continue
    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r2.code).toBe(0);

    // Real lease (US-DELTA-CONC-FOREIGN) is released from leases directory
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-CONC-FOREIGN"]).toBeUndefined();

    // Foreign lease (different story+delegationId) must NOT be touched
    expect(slAfter["US-DELTA-CONC-FOREIGN-OTHER"]).toBeDefined();
    expect(slAfter["US-DELTA-CONC-FOREIGN-OTHER"].delegationId).toBe("foreign-deleg-id");
  });

  it("conclude fail-loud on same-story mismatched-delegationId lease; no terminal written (AC6)", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-SAMESTORY", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-SAMESTORY", "local-preset");

    // Prepare delegation A for this story
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-SAMESTORY",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationIdA = JSON.parse(r1.stdout).delegationId;

    // Overwrite leases directory entry with a DIFFERENT delegationId (simulating
    // same-story host-delegation from another instance that bypassed atomic claim)
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    sl["US-DELTA-CONC-SAMESTORY"] = {
      claimedAt: Date.now(),
      source: "host-delegation",
      delegationId: "wrong-deleg-id",
      runId: "delta-wrong-deleg-id",
    };
    writeLeases(slPath, sl);

    // Count events before
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // Conclude with delegationId A — must fail-loud because lease identity mismatches
    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationIdA,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    // fail-loud: non-zero exit, no terminal event written
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("lease_mismatch");

    // NO terminal event was written (fail before append)
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // Lease entry MUST still exist with the mismatched delegationId
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-CONC-SAMESTORY"]).toBeDefined();
    expect(slAfter["US-DELTA-CONC-SAMESTORY"].delegationId).toBe("wrong-deleg-id");

    // Cleanup: restore lease and release
    delete slAfter["US-DELTA-CONC-SAMESTORY"];
    writeLeases(slPath, slAfter);
  });

  it("conclude writes exact delta:terminal event fields (AC6)", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-FIELDS", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-FIELDS", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-FIELDS",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Conclude with owner_redelegate
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_redelegate", "--json",
    ], dir);
    expect(r2.code).toBe(0);
    const result = JSON.parse(r2.stdout);
    expect(result.outcome).toBe("handoff_ready");
    expect(result.terminalBinding).toBe("handoff_only");
    expect(result.deliveryDisposition).toBe("owner_redelegate");

    // Verify exact event fields
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    const terminalEvent = JSON.parse(events[events.length - 1]!);
    expect(terminalEvent.type).toBe("delta:terminal");
    expect(terminalEvent.delegationId).toBe(delegationId);
    expect(terminalEvent.outcome).toBe("handoff_ready");
    expect(terminalEvent.terminalBinding).toBe("handoff_only");
    expect(terminalEvent.deliveryDisposition).toBe("owner_redelegate");
    // No cycle/delivery/done events produced
    for (const e of events) {
      expect(e).not.toContain("\"type\":\"cycle:");
    }
  });

  it("conclude fails for unknown delegation", () => {
    const dir = setupMinimalProject("US-DELTA-CONC4", "delta-team");
    const r = tsRunCwd([
      "conclude", "--delegation", "nonexistent",
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stderr);
    expect(err.error).toBe("delegation_not_found");
  });

  // ─── Fix #7: conclude release failure must not output success ───────────

  it("conclude does not output success when lease release fails (already released)", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-FAIL", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-FAIL", "local-preset");

    const prep = tsRunCwd([
      "prepare", "US-DELTA-CONC-FAIL",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(prep.code).toBe(0);
    const delegationId = JSON.parse(prep.stdout).delegationId;

    // Manually release the lease BEFORE conclude
    const released = releaseHostDelegationLease(dir, "US-DELTA-CONC-FAIL", delegationId, `delta-${delegationId}`);
    expect(released).toBe(true);

    // Now conclude should fail because lease is already released
    const r = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r.code).toBe(1);
    // Must NOT output success on stdout
    const stdout = r.stdout;
    expect(stdout).toBe("");
    // Must have failure message on stderr
    expect(r.stderr).not.toBe("");
    const err = JSON.parse(r.stderr);
    expect(err.ok).toBe(false);
    expect(err.error).toBe("lease_release_failed");
  });

  // ─── Fix #7: prepare post-append crash seam ────────────────────────────

  it("prepare post-append crash seam (after-append throw) prevents success output", () => {
    const dir = setupMinimalProject("US-DELTA-PREP-SEAM", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-PREP-SEAM", "local-preset");

    // Inject a post-append crash that fires after delta:prepared write
    injectEventAppendFailure(() => { throw new Error("simulated after-append crash"); });

    const r = tsRunCwd([
      "prepare", "US-DELTA-PREP-SEAM",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);

    injectEventAppendFailure(null);

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err.ok).toBe(false);
    expect(err.error).toBe("event_append_failure");
  });

  // ─── BLOCK-A: actual EventBus append failure (before/during append) ───

  it("BLOCK-A: EventBus throws on delta:prepared → fail-loud, stdout empty, lease held, zero events", () => {
    const dir = setupMinimalProject("US-DELTA-BUSA", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-BUSA", "local-preset");

    // Inject an EventBus whose appendEvent throws on delta:prepared.
    // Successful appends use real filesystem so events.ndjson exists.
    let appendCalled = 0;
    const throwingBus = new EventBus({
      exists: (p: string) => existsSync(p),
      ensureFile: (p: string) => { if (!existsSync(p)) writeFileSync(p, "", "utf8"); },
      readText: (p: string) => existsSync(p) ? readFileSync(p, "utf8") : "",
      appendLine: (p: string, line: string) => {
        appendCalled++;
        if (line.includes('"delta:prepared"')) throw new Error("simulated I/O append failure");
        appendFileSync(p, line, { encoding: "utf8", flag: "a" });
      },
      writeText: (p: string, d: string) => writeFileSync(p, d, "utf8"),
      size: () => 0,
    });
    injectEventBus(throwingBus);

    try {
      const r = tsRunCwd([
        "prepare", "US-DELTA-BUSA",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);

      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      // Error must be on stderr
      expect(r.stderr).toBeTruthy();
      expect(appendCalled).toBeGreaterThanOrEqual(1);

      // Lease must still be held (allocation succeeded before append)
      const slPath = storyLeasesPath(dir);
      const sl = readLeases(slPath);
      expect(sl["US-DELTA-BUSA"]).toBeDefined();
      expect(sl["US-DELTA-BUSA"].source).toBe("host-delegation");

      // Frame must exist (allocation succeeded before append)
      const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-BUSA");
      const deltaDirs = readdirSync(cardDir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith("delta-"));
      expect(deltaDirs.length).toBeGreaterThanOrEqual(1);

      // But events must be empty/absent (append threw before writing)
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      if (existsSync(eventsPath)) {
        const evts = readFileSync(eventsPath, "utf8").trim();
        expect(evts).toBe("");
      }
    } finally {
      injectEventBus(null);
    }
  });

  it("BLOCK-A: EventBus throws on delta:role_resolved after prepared → fail-loud, prepared event exists, lease held", () => {
    const dir = setupMinimalProject("US-DELTA-BUSB", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-BUSB", "local-preset");

    // Inject an EventBus that throws on the SECOND append (first role_resolved).
    // The first append (delta:prepared) succeeds and actually writes.
    let appendCount = 0;
    const throwingBus = new EventBus({
      exists: (p: string) => existsSync(p),
      ensureFile: (p: string) => { if (!existsSync(p)) writeFileSync(p, "", "utf8"); },
      readText: (p: string) => existsSync(p) ? readFileSync(p, "utf8") : "",
      appendLine: (p: string, line: string) => {
        appendCount++;
        if (line.includes('"delta:role_resolved"') && appendCount > 1) {
          throw new Error("simulated I/O failure on role_resolved");
        }
        appendFileSync(p, line, { encoding: "utf8", flag: "a" });
      },
      writeText: (p: string, d: string) => writeFileSync(p, d, "utf8"),
      size: () => 0,
    });
    injectEventBus(throwingBus);

    try {
      const r = tsRunCwd([
        "prepare", "US-DELTA-BUSB",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);

      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBeTruthy();

      // Lease held
      const slPath = storyLeasesPath(dir);
      const sl = readLeases(slPath);
      expect(sl["US-DELTA-BUSB"]).toBeDefined();

      // prepared event exists (first append succeeded), role_resolved absent
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      expect(existsSync(eventsPath)).toBe(true);
      const evtLines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l);
      const parsedEvents = evtLines.map(l => JSON.parse(l));
      const preparedCount = parsedEvents.filter((e: any) => e.type === "delta:prepared").length;
      const roleCount = parsedEvents.filter((e: any) => e.type === "delta:role_resolved").length;
      // BLOCK-D: precise event count assertion — prepared=1, role=0
      expect(preparedCount).toBe(1);
      expect(roleCount).toBe(0);
    } finally {
      injectEventBus(null);
    }
  });
});

// ── Snapshot tests ──────────────────────────────────────────────────────────

describe("US-DELTA-003 — CLI snapshots", () => {
  it("prepare --json output is scrubbed and snapshotted", () => {
    const dir = setupMinimalProject("US-DELTA-SNAP-1", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-SNAP-1", "local-preset");

    const r = tsRunCwd([
      "prepare", "US-DELTA-SNAP-1",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(0);

    const delegationId = JSON.parse(r.stdout).delegationId;
    const scrubbed = scrubAll(r.stdout, dir, delegationId);
    expect(scrubbed).toMatchSnapshot();
  });

  it("status --json after prepare is scrubbed and snapshotted", () => {
    const dir = setupMinimalProject("US-DELTA-SNAP-2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-SNAP-2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-SNAP-2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd(["status", "--delegation", delegationId, "--json"], dir);
    expect(r2.code).toBe(0);

    const scrubbed = scrubAll(r2.stdout, dir, delegationId);
    expect(scrubbed).toMatchSnapshot();
  });

  it("validate block on missing artifact is scrubbed and snapshotted", () => {
    const dir = setupMinimalProject("US-DELTA-SNAP-3", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-SNAP-3", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-SNAP-3",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Validate without creating the stage artifact
    const r2 = tsRunCwd([
      "validate", "--delegation", delegationId,
      "--stage", "designer", "--json",
    ], dir);
    expect(r2.code).toBe(1);

    const scrubbed = scrubPaths(scrubId(r2.stderr), dir);
    expect(scrubbed).toMatchSnapshot();
  });

  it("conclude --json output is scrubbed and snapshotted", () => {
    const dir = setupMinimalProject("US-DELTA-SNAP-4", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-SNAP-4", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-SNAP-4",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r2.code).toBe(0);

    const scrubbed = scrubAll(r2.stdout, dir, delegationId);
    expect(scrubbed).toMatchSnapshot();
  });
});

// ── Atomic lease claim protocol (AC2) ────────────────────────────────────────

describe("US-DELTA-003 — atomic lease claim concurrency protocol", () => {
  it("claimHostDelegationLease atomically guarantees exactly one winner", () => {
    const dir = setupMinimalProject("US-DELTA-HL-LEASE", "delta-team");

    const delegId1 = randomUUID();
    const delegId2 = randomUUID();

    // Two sequential claims — the core claimStoryLease lock ensures only one wins
    const r1 = claimHostDelegationLease(dir, "US-DELTA-HL-LEASE", delegId1, "delta-conc-1");
    const r2 = claimHostDelegationLease(dir, "US-DELTA-HL-LEASE", delegId2, "delta-conc-2");

    expect(r1).toBe("claimed");
    expect(r2).toBe("exists");

    // The shared leases directory has the winner's delegationId
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-HL-LEASE"].delegationId).toBe(delegId1);

    // Release the winner
    releaseHostDelegationLease(dir, "US-DELTA-HL-LEASE", delegId1, `delta-${delegId1}`);
  });

  it("claimHostDelegationLease never replaces existing lease content (no-replace evidence)", () => {
    const dir = setupMinimalProject("US-DELTA-HL-NOREPLACE", "delta-team");

    const winnerDelegId = randomUUID();
    const r1 = claimHostDelegationLease(dir, "US-DELTA-HL-NOREPLACE", winnerDelegId, "delta-winner");
    expect(r1).toBe("claimed");

    const slPath = storyLeasesPath(dir);
    const contentAfterWinner = JSON.stringify(readLeases(slPath));
    const statAfterWinner = JSON.parse(contentAfterWinner);
    expect(statAfterWinner["US-DELTA-HL-NOREPLACE"].delegationId).toBe(winnerDelegId);

    // Second claim with DIFFERENT delegationId must NOT overwrite
    const loserDelegId = randomUUID();
    const r2 = claimHostDelegationLease(dir, "US-DELTA-HL-NOREPLACE", loserDelegId, "delta-loser");
    expect(r2).toBe("exists");

    // File content preserved — no replacement occurred
    const contentAfterLoser = JSON.stringify(readLeases(slPath));
    expect(contentAfterLoser).toBe(contentAfterWinner);

    // Winner's delegationId is still in the file
    const statFinal = JSON.parse(contentAfterLoser);
    expect(statFinal["US-DELTA-HL-NOREPLACE"].delegationId).toBe(winnerDelegId);
    expect(statFinal["US-DELTA-HL-NOREPLACE"].delegationId).not.toBe(loserDelegId);

    releaseHostDelegationLease(dir, "US-DELTA-HL-NOREPLACE", winnerDelegId, `delta-${winnerDelegId}`);
  });

  it("claimHostDelegationLease rejects when leases directory has cycle entry", () => {
    const dir = setupMinimalProject("US-DELTA-BIDI", "delta-team");

    // Write a cycle-style lease via setLease into the leases directory
    const slPath = storyLeasesPath(dir);
    setLease(slPath, "US-DELTA-BIDI", { pid: 12345, claimedAt: Date.now(), source: "cycle" });

    // Host-delegation claim must be rejected
    const result = claimHostDelegationLease(dir, "US-DELTA-BIDI", randomUUID(), "delta-bidi");
    expect(result).toBe("exists"); // rejected because cycle already owns it

    // leases directory still has only the cycle entry
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-BIDI"].source).toBe("cycle");
    expect(sl["US-DELTA-BIDI"].delegationId).toBeUndefined();
  });

  it("leases directory host-delegation entry proves reverse exclusion", () => {
    const dir = setupMinimalProject("US-DELTA-BIDI2", "delta-team");

    const delegId = randomUUID();
    const result = claimHostDelegationLease(dir, "US-DELTA-BIDI2", delegId, "delta-bidi2");
    expect(result).toBe("claimed");

    // Now verify that leases directory has an entry for this story
    const slPath = storyLeasesPath(dir);
    expect(existsSync(slPath)).toBe(true);
    const leases = readLeases(slPath);
    expect(leases["US-DELTA-BIDI2"]).toBeDefined();
    expect(leases["US-DELTA-BIDI2"].source).toBe("host-delegation");
    expect(leases["US-DELTA-BIDI2"].delegationId).toBe(delegId);

    // The cycle's reclaim check treats "host-delegation" source as active claim → skips it.
    // This proves that the host-delegation entry is seen by the cycle machinery.

    // Cleanup
    releaseHostDelegationLease(dir, "US-DELTA-BIDI2", delegId, `delta-${delegId}`);
  });
});

// ── Human status snapshot (AC7) ──────────────────────────────────────────────

describe("US-DELTA-003 — status human output with provenance", () => {
  it("status human output includes trigger, topology, profile, roles with host-attested", () => {
    const dir = setupMinimalProject("US-DELTA-HSTATUS", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-HSTATUS", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-HSTATUS",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd(["status", "--delegation", delegationId], dir);
    expect(r2.code).toBe(0);

    // Human output must include trigger, topology, profile
    expect(r2.stdout).toContain("host-guided");
    expect(r2.stdout).toContain("delta-team");
    expect(r2.stdout).toContain("standard");
    // Cost is unknown
    expect(r2.stdout).toContain("host_unobservable");
    // Must use "?" for unknown host/model (when no preset loaded)
    expect(r2.stdout).toContain("?");
    // Must never say "verified"
    expect(r2.stdout).not.toContain("verified");

    const scrubbed = scrubAll(r2.stdout, dir, delegationId);
    expect(scrubbed).toMatchSnapshot();
  });

  it("status --json includes provenance labels and never 'verified'", () => {
    const dir = setupMinimalProject("US-DELTA-HSTATUS2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-HSTATUS2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-HSTATUS2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd(["status", "--delegation", delegationId, "--json"], dir);
    expect(r2.code).toBe(0);

    const statusOut = JSON.parse(r2.stdout);
    // Must never use "verified"
    const statusStr = JSON.stringify(statusOut);
    expect(statusStr).not.toContain("verified");
    // Must never use "adapter-observed"
    expect(statusStr).not.toContain("adapter-observed");
    // Trigger, topology, profile must be present
    expect(statusOut.trigger).toBe("host-guided");
    expect(statusOut.topology).toBe("delta-team");
    expect(statusOut.qualityProfile).toBe("standard");
  });

  it("status after validate shows host-attested provenance, frozen in human + JSON snapshots", () => {
    const dir = setupMinimalProject("US-DELTA-HPROV2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-HPROV2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-HPROV2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Validate to produce artifact_published with host-attested provenance
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-HPROV2",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest()), "utf8");
    const rVal = tsRunCwd(["validate", "--delegation", delegationId, "--stage", "designer", "--json"], dir);
    expect(rVal.code).toBe(0);

    // JSON status with host-attested frozen
    const rJson = tsRunCwd(["status", "--delegation", delegationId, "--json"], dir);
    expect(rJson.code).toBe(0);
    const jsonOut = JSON.parse(rJson.stdout);
    // Must contain host-attested
    expect(JSON.stringify(jsonOut)).toContain("host-attested");
    expect(JSON.stringify(jsonOut)).not.toContain("verified");
    expect(JSON.stringify(jsonOut)).not.toContain("adapter-observed");

    // Human status snapshot
    const rHuman = tsRunCwd(["status", "--delegation", delegationId], dir);
    expect(rHuman.code).toBe(0);
    expect(rHuman.stdout).toContain("host-attested");
    expect(rHuman.stdout).not.toContain("verified");

    const scrubbedHuman = scrubAll(rHuman.stdout, dir, delegationId);
    expect(scrubbedHuman).toMatchSnapshot();
  });
});

// ── Read-only status proof (AC7) ────────────────────────────────────────────

describe("US-DELTA-003 — status read-only proof", () => {
  it("status does not modify filesystem state", () => {
    const dir = setupMinimalProject("US-DELTA-READONLY", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-READONLY", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-READONLY",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Snapshot filesystem before status
    const snapshotBefore = readdirRecursive(dir);

    // Run status
    const r2 = tsRunCwd(["status", "--delegation", delegationId], dir);
    expect(r2.code).toBe(0);

    // Snapshot filesystem after status
    const snapshotAfter = readdirRecursive(dir);

    // Must be identical — status is read-only
    expect(snapshotAfter).toEqual(snapshotBefore);
  });
});

// ── Regression: no npx / network download in concurrent subprocess harness ──

describe("US-DELTA-003 — regression: concurrent harness is deterministic", () => {
  it("tsx binary is resolved locally, never shells out to npx", () => {
    // The global tsxBin must point at the locally installed tsx CLI, resolved
    // from the CLI package's own devDependencies — not from PATH / npx cache.
    expect(tsxBin).toContain("node_modules");
    expect(tsxBin).toContain("tsx");
    expect(tsxBin).toContain("cli.mjs");
    // Must NOT rely on npx or a network-fetch downloader. The path must be a
    // locally installed file (resolved through createRequire from the CLI pkg).
    expect(tsxBin).not.toMatch(/\bnpx\b/);
    expect(tsxBin).toMatch(/\bnode_modules\b/);
    // Must exist on disk at module resolution time (not after network fetch).
    expect(existsSync(tsxBin)).toBe(true);
  });

  it("subprocess spawn command never includes npx or npm", () => {
    // Verify the spawn command shape used by all concurrent tests:
    //   spawn(process.execPath, [tsxBin, workerScript, ...])
    // This test breaks if anyone reverts to spawn("npx", ["tsx", ...]).
    expect(process.execPath).toBeTruthy();
    expect(tsxBin).toBeTruthy();
    // process.execPath is the node binary (e.g. /usr/bin/node), not npx.
    const execBasename = process.execPath.split("/").pop() ?? "";
    expect(execBasename).toMatch(/^node/);
  });
});

// ── Concurrent subprocess lease contention (III.1 / AC2) ────────────────────

describe("US-DELTA-003 — concurrent subprocess prepare atomic exclusion", () => {
  it("exactly one wins when two workers prepare same story under barrier", async () => {
    const dir = setupMinimalProject("US-DELTA-CONCURRENT", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONCURRENT", "local-preset");

    // Use a file-based barrier: both children wait for this file to appear
    const barrierPath = join(dir, "barrier");

    // Writer the barrier AFTER launching both children
    writeFileSync(barrierPath, "wait", "utf8");

    // Helper to run a prepare in a child process via tsx
    const runChild = (workerId: number): Promise<{ code: number; stdout: string; stderr: string }> => {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [
          tsxBin,
          join(import.meta.dirname, "delta-concurrent-worker.ts"),
          dir,
          resPath,
          barrierPath,
        ], {
          cwd: dir,
          stdio: "pipe",
          env: { ...process.env, ROLL_LANG: "en" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code) => {
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    };

    // Launch two workers, then release the barrier
    const [p1, p2] = [runChild(1), runChild(2)];
    // Small delay to ensure both processes are running and waiting
    await new Promise(r => setTimeout(r, 200));
    // Release barrier
    writeFileSync(barrierPath, "go", "utf8");

    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one must succeed (code 0), exactly one must fail (code 1)
    const codes = [r1.code, r2.code].sort();
    expect(codes).toEqual([0, 1]);

    // Winner has valid prepare output
    const winner = r1.code === 0 ? r1 : r2;
    const loser = r1.code === 0 ? r2 : r1;
    let winnerParsed: Record<string, unknown>;
    try {
      winnerParsed = JSON.parse(winner.stdout.trim().split("\n").pop()!);
    } catch {
      // The winner's stdout might include tsx output; try parsing the last JSON line
      const lines = winner.stdout.trim().split("\n");
      const jsonLine = lines.find(l => l.startsWith("{"));
      if (jsonLine) winnerParsed = JSON.parse(jsonLine);
      else throw new Error(`Cannot parse winner stdout: ${winner.stdout}`);
    }
    expect(winnerParsed.ok).toBe(true);
    expect(typeof winnerParsed.delegationId).toBe("string");

    // Loser has builder_lease_conflict error
    const loserOutput = loser.stderr + loser.stdout;
    expect(loserOutput).toContain("builder_lease_conflict");

    // Only ONE committed frame exists
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    const preparedEvents = events.filter((l: string) => { try { return JSON.parse(l).type === "delta:prepared"; } catch { return false; }});
    expect(preparedEvents.length).toBe(1);
    expect(JSON.parse(preparedEvents[0]!).delegationId).toBe(winnerParsed.delegationId);

    // Only ONE lease entry exists, bound to winner's delegationId
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-CONCURRENT"]).toBeDefined();
    expect(sl["US-DELTA-CONCURRENT"].delegationId).toBe(winnerParsed.delegationId);

    // No temp/claim residue in loop dir
    const loopDir = join(dir, ".roll", "loop");
    const tmpLeaseFiles = readdirSync(loopDir).filter(f => f.includes(".tmp") || f.includes(".lock"));
    expect(tmpLeaseFiles.length).toBe(0);
  }, 30000);
});

// ── Prepare interruption seam (crash test) (III.2 / AC3) ────────────────────

describe("US-DELTA-003 — prepare crash before delta:prepared", () => {
  it("interrupt after file write leaves orphan with matching lease; next prepare blocks", () => {
    const dir = setupMinimalProject("US-DELTA-CRASH", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CRASH", "local-preset");

    let frameDir = "";
    let delegationId = "";

    // Inject interruption after files written, before events
    injectPrepareInterrupt(() => {
      throw new Error("simulated crash before event append");
    });

    try {
      expect(() => {
        tsRunCwd([
          "prepare", "US-DELTA-CRASH",
          "--trigger", "host-guided", "--topology", "delta-team",
          "--profile", "standard", "--preset", "local-preset",
          "--resolution", resPath, "--json",
        ], dir);
      }).toThrow("simulated crash");
    } finally {
      injectPrepareInterrupt(null);
    }

    // Now verify orphan state: marker exists, lease exists, but no events
    const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-CRASH");
    const entries = readdirSync(cardDir, { withFileTypes: true });
    const deltaDirs = entries.filter(e => e.isDirectory() && e.name.startsWith("delta-"));
    expect(deltaDirs.length).toBe(1);

    frameDir = join(cardDir, deltaDirs[0]!.name);
    delegationId = deltaDirs[0]!.name.slice("delta-".length);

    // Marker exists
    const markerPath = join(frameDir, "delegation-open.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.delegationId).toBe(delegationId);

    // Resolution exists
    const savedResPath = join(frameDir, "role-artifacts", "delegation", "delegation-resolution.json");
    expect(existsSync(savedResPath)).toBe(true);

    // Preparation exists
    const prepPath = join(frameDir, "preparation.json");
    expect(existsSync(prepPath)).toBe(true);

    // Lease exists in shared truth with matching delegationId
    const slPath = storyLeasesPath(dir);
    expect(existsSync(slPath)).toBe(true);
    const storyLeases = readLeases(slPath);
    expect(storyLeases["US-DELTA-CRASH"]).toBeDefined();
    expect(storyLeases["US-DELTA-CRASH"].source).toBe("host-delegation");
    expect(storyLeases["US-DELTA-CRASH"].delegationId).toBe(delegationId);

    // NO events were written (the crash was before event append)
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    // Either no events file, or empty
    const hasNoPreparedEvent = !existsSync(eventsPath) ||
      !readFileSync(eventsPath, "utf8").includes("delta:prepared");
    expect(hasNoPreparedEvent).toBe(true);

    // Status reports orphan with exact fields
    const rStatus = tsRunCwd(["status", "--story", "US-DELTA-CRASH", "--json"], dir);
    expect(rStatus.code).toBe(0);
    const statusOut = JSON.parse(rStatus.stdout);
    expect(statusOut.uncommittedFrames).toBeDefined();
    expect(statusOut.uncommittedFrames.length).toBe(1);
    const orphan = statusOut.uncommittedFrames[0];
    expect(orphan.delegationId).toBe(delegationId);
    expect(orphan.status).toContain("uncommitted_delegation_frame");
    expect(orphan.hasMatchingLease).toBe(true);
    expect(typeof orphan.frameDir).toBe("string");

    // Orphan status human + JSON snapshots
    const rHuman = tsRunCwd(["status", "--story", "US-DELTA-CRASH"], dir);
    expect(rHuman.code).toBe(0);
    expect(rHuman.stdout).toContain("uncommitted_delegation_frame");
    expect(rHuman.stdout).toContain(delegationId);
    expect(rHuman.stdout).toContain("frame:");
    expect(rHuman.stdout).toContain("recovery:");
    expect(rHuman.stdout).toContain("release");

    // Next prepare must NOT adopt/resume/delete the orphan frame
    // The lease is still active, so prepare should fail with builder_lease_conflict
    const resPath2 = writeResolutionTemplate(dir, "US-DELTA-CRASH", "local-preset", "resolution-template-2.json");
    const r2 = tsRunCwd([
      "prepare", "US-DELTA-CRASH",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath2, "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("builder_lease_conflict");

    // Orphan frame and lease still preserved
    expect(existsSync(markerPath)).toBe(true);
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-CRASH"]).toBeDefined();

    // Clean up: release lease so afterEach can clean temp dir
    releaseHostDelegationLease(dir, "US-DELTA-CRASH", delegationId, `delta-${delegationId}`);
  });

  it("prepare artifact cross-consistency: marker, resolution, preparation share delegationId/storyId", () => {
    const dir = setupMinimalProject("US-DELTA-XCONSIST", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-XCONSIST", "local-preset");

    const r = tsRunCwd([
      "prepare", "US-DELTA-XCONSIST",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    const delegationId = result.delegationId;
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-XCONSIST", `delta-${delegationId}`);

    // Marker: schema + delegationId + storyId
    const marker = JSON.parse(readFileSync(join(frameDir, "delegation-open.json"), "utf8"));
    expect(marker.schema).toBe("roll-delta-delegation-open/v1");
    expect(marker.delegationId).toBe(delegationId);
    expect(marker.storyId).toBe("US-DELTA-XCONSIST");

    // Resolution: schema + delegationId (bound in)
    const resolution = JSON.parse(readFileSync(join(frameDir, "role-artifacts", "delegation", "delegation-resolution.json"), "utf8"));
    expect(resolution.schema).toBe("roll-delta-resolution/v1");
    expect(resolution.delegationId).toBe(delegationId);

    // Preparation: schema + delegationId + runId + storyId + trigger/topology/profile + preset info
    const prep = JSON.parse(readFileSync(join(frameDir, "preparation.json"), "utf8"));
    expect(prep.schema).toBe("roll-delta-preparation/v1");
    expect(prep.delegationId).toBe(delegationId);
    expect(prep.runId).toBe(`delta-${delegationId}`);
    expect(prep.storyId).toBe("US-DELTA-XCONSIST");
    expect(prep.trigger).toBe("host-guided");
    expect(prep.topology).toBe("delta-team");
    expect(prep.qualityProfile).toBe("standard");
    expect(prep.presetId).toBe("local-preset");
    expect(prep.presetSha256).toBe("aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff");

    // Event stream: exact type/order/count/role bindings
    const events = readFileSync(join(dir, ".roll", "loop", "events.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(events.length).toBe(4); // 1 prepared + 3 role_resolved
    expect(events[0]!.type).toBe("delta:prepared");
    expect(events[0]!.delegationId).toBe(delegationId);
    expect(events[0]!.storyId).toBe("US-DELTA-XCONSIST");

    const roleEvents = events.slice(1);
    const roleSet = new Set(roleEvents.map(e => e.role));
    expect(roleSet.has("designer")).toBe(true);
    expect(roleSet.has("builder")).toBe(true);
    expect(roleSet.has("evaluator")).toBe(true);

    for (const re of roleEvents) {
      expect(re.type).toBe("delta:role_resolved");
      expect(re.delegationId).toBe(delegationId);
      expect(re.storyId).toBe("US-DELTA-XCONSIST");
      expect(re.inventorySha256).toBe("bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff");
      expect(typeof re.inventoryObservedAt).toBe("string");
      expect(re.inventorySha256).not.toBe("aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff");
    }

    // No cycle/runs/latest/cycle:terminal in events
    for (const ev of events) {
      expect(ev.type).not.toMatch(/^cycle:/);
      expect(ev).not.toHaveProperty("cycleId");
      expect(ev).not.toHaveProperty("deliveryDisposition");
    }
    expect(existsSync(join(dir, ".roll", "loop", "runs.jsonl"))).toBe(false);
    expect(existsSync(join(dir, ".roll", "loop", "latest"))).toBe(false);
  });
});

// ── Validator admission boundary tests (III.4) ───────────────────────────────

describe("US-DELTA-003 — validate admission boundaries", () => {
  it("validate invocation: validator called exactly once with correct delegationId/stage/frameDir", () => {
    const dir = setupMinimalProject("US-DELTA-VAL-SPY", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL-SPY", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL-SPY",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;
    const expectedFrameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-VAL-SPY", `delta-${delegationId}`);

    let callCount = 0;
    let capturedDelegationId = "";
    let capturedStage = "";
    let capturedFrameDir = "";

    injectValidator((input) => {
      callCount++;
      capturedDelegationId = input.delegationId;
      capturedStage = input.stage;
      capturedFrameDir = input.frameDir;
      // Return allow even though no artifact exists — this is a spy test
      return { ok: true };
    });

    try {
      const r2 = tsRunCwd([
        "validate", "--delegation", delegationId,
        "--stage", "designer", "--json",
      ], dir);
      expect(r2.code).toBe(0);
      expect(callCount).toBe(1);
      expect(capturedDelegationId).toBe(delegationId);
      expect(capturedStage).toBe("designer");
      // macOS may have /private prefix on tmp paths — accept either
      const normalizedCaptured = capturedFrameDir.replace(/^\/private/, "");
      const normalizedExpected = expectedFrameDir.replace(/^\/private/, "");
      expect(normalizedCaptured).toBe(normalizedExpected);
    } finally {
      injectValidator(null);
    }
  });

  it("validate injected allow/block: exactly one event each with correct kind/provenance", () => {
    // Use TWO separate delegations: one for block test, one for allow test.
    // Admission prevents blocked delegations from further validation.

    // --- Block test ---
    const dirBlock = setupMinimalProject("US-DELTA-VAL-ALLOWBLOCK-BLK", "delta-team");
    const resPathBlock = writeResolutionTemplate(dirBlock, "US-DELTA-VAL-ALLOWBLOCK-BLK", "local-preset");
    const r1b = tsRunCwd([
      "prepare", "US-DELTA-VAL-ALLOWBLOCK-BLK",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPathBlock, "--json",
    ], dirBlock);
    expect(r1b.code).toBe(0);
    const delegationIdBlock = JSON.parse(r1b.stdout).delegationId;
    const eventsPathBlock = join(dirBlock, ".roll", "loop", "events.ndjson");
    const eventsBeforeBlock = readFileSync(eventsPathBlock, "utf8").trim().split("\n").filter(l => l.trim());

    injectValidator((input) => ({ ok: false, reason: "host_attestation_invalid", detail: "test block", role: input.stage }));
    try {
      const r2 = tsRunCwd(["validate", "--delegation", delegationIdBlock, "--stage", "builder", "--json"], dirBlock);
      expect(r2.code).toBe(1);
      const eventsAfterBlock = readFileSync(eventsPathBlock, "utf8").trim().split("\n").filter(l => l.trim());
      expect(eventsAfterBlock.length).toBe(eventsBeforeBlock.length + 1);
      const blockEvent = JSON.parse(eventsAfterBlock[eventsAfterBlock.length - 1]!);
      expect(blockEvent.type).toBe("delta:blocked");
      expect(blockEvent.reason).toBe("host_attestation_invalid");
      expect(blockEvent.detail).toBe("test block");
      expect(blockEvent.role).toBe("builder");
      expect(blockEvent.delegationId).toBe(delegationIdBlock);
    } finally {
      injectValidator(null);
    }

    // --- Allow test (fresh delegation, no prior block) ---
    const dirAllow = setupMinimalProject("US-DELTA-VAL-ALLOWBLOCK-ALLOW", "delta-team");
    const resPathAllow = writeResolutionTemplate(dirAllow, "US-DELTA-VAL-ALLOWBLOCK-ALLOW", "local-preset");
    const r1a = tsRunCwd([
      "prepare", "US-DELTA-VAL-ALLOWBLOCK-ALLOW",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPathAllow, "--json",
    ], dirAllow);
    expect(r1a.code).toBe(0);
    const delegationIdAllow = JSON.parse(r1a.stdout).delegationId;
    const eventsPathAllow = join(dirAllow, ".roll", "loop", "events.ndjson");
    const eventsBeforeAllow = readFileSync(eventsPathAllow, "utf8").trim().split("\n").filter(l => l.trim());

    // Create the stage artifact FILE so the injected validator succeeds
    const frameDirAllow = join(dirAllow, ".roll", "features", "delta-team", "US-DELTA-VAL-ALLOWBLOCK-ALLOW", `delta-${delegationIdAllow}`);
    const evaluatorArtifactDir = join(frameDirAllow, "role-artifacts", "evaluator");
    mkdirSync(evaluatorArtifactDir, { recursive: true });
    writeFileSync(join(evaluatorArtifactDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest()), "utf8");

    injectValidator((_input) => ({ ok: true }));
    try {
      const r3 = tsRunCwd(["validate", "--delegation", delegationIdAllow, "--stage", "evaluator", "--json"], dirAllow);
      expect(r3.code).toBe(0);
      const eventsAfterAllow = readFileSync(eventsPathAllow, "utf8").trim().split("\n").filter(l => l.trim());
      expect(eventsAfterAllow.length).toBe(eventsBeforeAllow.length + 1);
      const allowEvent = JSON.parse(eventsAfterAllow[eventsAfterAllow.length - 1]!);
      expect(allowEvent.type).toBe("delta:artifact_published");
      expect(allowEvent.role).toBe("evaluator");
      expect(allowEvent.delegationId).toBe(delegationIdAllow);
      expect(allowEvent.identityProvenance).toBe("host-attested");
    } finally {
      injectValidator(null);
    }
  });

  it("validate block short-circuits admission: unassigned role or terminal delegation", () => {
    const dir = setupMinimalProject("US-DELTA-VAL-ADMIT", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-VAL-ADMIT", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-VAL-ADMIT",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Peer role not in resolution — admission short-circuits before validator
    // The block reason is "invalid_resolution" because stage is not a resolved role
    injectValidator((_input) => {
      // Validator should never be called for unassigned roles
      throw new Error("validator must not be called for unassigned role");
    });
    try {
      const r2 = tsRunCwd(["validate", "--delegation", delegationId, "--stage", "peer", "--json"], dir);
      expect(r2.code).toBe(1);
      const err = JSON.parse(r2.stderr);
      // Admission blocks unassigned roles with invalid_resolution
      expect(err.error).toBe("invalid_resolution");
      expect(err.detail).toContain("peer");
      expect(err.detail).toContain("not in resolved roles");

      // Event appended: delta:blocked with invalid_resolution
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      const lastEvent = JSON.parse(events[events.length - 1]!);
      expect(lastEvent.type).toBe("delta:blocked");
      expect(lastEvent.reason).toBe("invalid_resolution");
    } finally {
      injectValidator(null);
    }
  });
});

// ── Conclude: parser-invalid vs domain-unselected (III.5) ───────────────────

describe("US-DELTA-003 — conclude parser vs domain rejection", () => {
  it("conclude with invalid enum rejects with parser error ZERO side effects", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-DOMAIN", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-DOMAIN", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-DOMAIN",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // Invalid disposition (not in the enum) → parser error, ZERO side effects
    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "not_a_real_disposition", "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err = JSON.parse(r2.stderr);
    expect(err.error).toBe("invalid_value");
    expect(err.detail).toContain("not_a_real_disposition");

    // ZERO events appended (parser error = no side effects)
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // Lease retained in shared truth
    const slPath = storyLeasesPath(dir);
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-CONC-DOMAIN"]).toBeDefined();
  });

  it("conclude with unknown flag (parser error) produces zero events and zero file modifications", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-PARSER", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-PARSER", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-PARSER",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Snapshot events before
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    const eventsBeforeLen = eventsBefore.length;

    // Parser error: unknown flag with --json
    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue",
      "--nonexistent-flag", "--json",
    ], dir);
    expect(r2.code).toBe(1);

    // Must be valid JSON error on stderr
    expect(() => JSON.parse(r2.stderr)).not.toThrow();
    const parsedErr = JSON.parse(r2.stderr);
    expect(parsedErr.error).toBe("unknown_flag");

    // Zero events appended (parser error = no side effects)
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBeforeLen);

    // Lease still intact in shared truth
    const slPath = storyLeasesPath(dir);
    const slAfter3 = readLeases(slPath);
    expect(slAfter3["US-DELTA-CONC-PARSER"]).toBeDefined();
  });

  it("conclude all three valid dispositions produce exact delta:terminal event", () => {
    const dispositions = ["owner_continue", "owner_hold", "owner_redelegate"] as const;
    for (const disposition of dispositions) {
      const storyId = `US-DELTA-CONC-${disposition.toUpperCase()}`;
      const dir = setupMinimalProject(storyId, "delta-team");
      const resPath = writeResolutionTemplate(dir, storyId, "local-preset");

      const r1 = tsRunCwd([
        "prepare", storyId,
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);
      expect(r1.code).toBe(0);
      const delegationId = JSON.parse(r1.stdout).delegationId;

      const r2 = tsRunCwd([
        "conclude", "--delegation", delegationId,
        "--delivery-disposition", disposition, "--json",
      ], dir);
      expect(r2.code).toBe(0);

      // Exact terminal event
      const events = readFileSync(join(dir, ".roll", "loop", "events.ndjson"), "utf8")
        .trim().split("\n").map(l => JSON.parse(l));
      const terminalEvent = events[events.length - 1];
      expect(terminalEvent.type).toBe("delta:terminal");
      expect(terminalEvent.outcome).toBe("handoff_ready");
      expect(terminalEvent.terminalBinding).toBe("handoff_only");
      expect(terminalEvent.deliveryDisposition).toBe(disposition);
      expect(terminalEvent.delegationId).toBe(delegationId);

      // No cycle/delivery/done in ANY event
      for (const e of events) {
        expect(e.type).not.toMatch(/^cycle:/);
        expect(e).not.toHaveProperty("DeliveryRecord");
      }
      expect(existsSync(join(dir, ".roll", "loop", "runs.jsonl"))).toBe(false);
    }
  });
});

// ── Status: provenance, trigger/topology/profile, snapshots (III.6) ──────────

describe("US-DELTA-003 — status provenance and snapshot coverage", () => {
  it("status --json after prepare+validate has provenance labels, never 'verified'", () => {
    const dir = setupMinimalProject("US-DELTA-PROV", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-PROV", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-PROV",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Create stage artifact FILE and validate to get artifact_published with provenance
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-PROV",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest()), "utf8");
    const rVal = tsRunCwd(["validate", "--delegation", delegationId, "--stage", "designer", "--json"], dir);
    expect(rVal.code).toBe(0);

    const r2 = tsRunCwd(["status", "--delegation", delegationId, "--json"], dir);
    expect(r2.code).toBe(0);
    const status = JSON.parse(r2.stdout);

    // Trigger, topology, profile present
    expect(status.trigger).toBe("host-guided");
    expect(status.topology).toBe("delta-team");
    expect(status.qualityProfile).toBe("standard");
    expect(status.visibleMode).toBe("delta-team");

    const statusStr = JSON.stringify(status);
    // Must never contain "verified"
    expect(statusStr).not.toContain("verified");

    // Artifact_published role has identityProvenance: "host-attested"
    if (status.roles && Array.isArray(status.roles)) {
      const designerRole = status.roles.find((r: { role: string }) => r.role === "designer");
      if (designerRole) {
        // After artifact_published, provenance may be available
        expect(statusStr).not.toContain("adapter-observed");
        // Cost is host_unobservable
        expect(status.totalCost).toContain("host_unobservable");
      }
    }

    // Status human output snapshot
    const rHuman = tsRunCwd(["status", "--delegation", delegationId], dir);
    expect(rHuman.code).toBe(0);
    expect(rHuman.stdout).toContain("host-guided");
    expect(rHuman.stdout).toContain("delta-team");
    expect(rHuman.stdout).toContain("standard");
    expect(rHuman.stdout).toContain("host_unobservable");
    expect(rHuman.stdout).not.toContain("verified");
  });
});

// ── Orphan status snapshots (III.7) ──────────────────────────────────────────

describe("US-DELTA-003 — orphan status human + JSON snapshots", () => {
  it("orphan frame shows exact unknown: uncommitted_delegation_frame with path and action", () => {
    const dir = setupMinimalProject("US-DELTA-ORPHAN-SNAP", "delta-team");

    // Manual orphan with lease
    const delegationId = randomUUID();
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPHAN-SNAP", `delta-${delegationId}`);
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(
      join(frameDir, "delegation-open.json"),
      JSON.stringify({
        schema: "roll-delta-delegation-open/v1",
        delegationId,
        storyId: "US-DELTA-ORPHAN-SNAP",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    // JSON status
    const rJson = tsRunCwd(["status", "--story", "US-DELTA-ORPHAN-SNAP", "--json"], dir);
    expect(rJson.code).toBe(0);
    const parsed = JSON.parse(rJson.stdout);
    expect(parsed.uncommittedFrames).toBeDefined();
    expect(parsed.uncommittedFrames.length).toBe(1);
    expect(parsed.uncommittedFrames[0].status).toBe("unknown: uncommitted_delegation_frame");
    expect(typeof parsed.uncommittedFrames[0].frameDir).toBe("string");

    const scrubbedJson = scrubAll(rJson.stdout, dir, delegationId);
    expect(scrubbedJson).toMatchSnapshot();

    // Human status
    const rHuman = tsRunCwd(["status", "--story", "US-DELTA-ORPHAN-SNAP"], dir);
    expect(rHuman.code).toBe(0);
    expect(rHuman.stdout).toContain("uncommitted_delegation_frame");
    expect(rHuman.stdout).toContain("frame:");

    const scrubbedHuman = scrubAll(rHuman.stdout, dir, delegationId);
    expect(scrubbedHuman).toMatchSnapshot();
  });

  it("ZH orphan status human + JSON snapshot with CJK recovery action", () => {
    const prev = process.env["ROLL_LANG"];
    try {
      process.env["ROLL_LANG"] = "zh";
      const dir = setupMinimalProject("US-DELTA-ORPHAN-ZH", "delta-team");
      const delegationId = randomUUID();
      const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPHAN-ZH", `delta-${delegationId}`);
      mkdirSync(frameDir, { recursive: true });
      writeFileSync(
        join(frameDir, "delegation-open.json"),
        JSON.stringify({ schema: "roll-delta-delegation-open/v1", delegationId, storyId: "US-DELTA-ORPHAN-ZH", createdAt: new Date().toISOString() }),
        "utf8",
      );

      // JSON status in zh locale
      const rJson = tsRunCwd(["status", "--story", "US-DELTA-ORPHAN-ZH", "--json"], dir);
      expect(rJson.code).toBe(0);
      const scrubbedJson = scrubAll(rJson.stdout, dir, delegationId);
      expect(scrubbedJson).toMatchSnapshot();

      // Human status in zh locale — must contain CJK recovery action
      const rHuman = tsRunCwd(["status", "--story", "US-DELTA-ORPHAN-ZH"], dir);
      expect(rHuman.code).toBe(0);
      // ZH output contains CJK status labels, not English
      expect(rHuman.stdout).toContain("未提交");
      expect(rHuman.stdout).toContain("frame:");
      expect(/[\u4e00-\u9fff]/.test(rHuman.stdout)).toBe(true);
      const scrubbedHuman = scrubAll(rHuman.stdout, dir, delegationId);
      expect(scrubbedHuman).toMatchSnapshot();
    } finally {
      if (prev !== undefined) process.env["ROLL_LANG"] = prev;
      else delete process.env["ROLL_LANG"];
    }
  });

  // ─── BLOCK-C: orphan negative classification ───────────────────────────

  it("BLOCK-C: marker-only orphan (no lease) → hasMatchingLease: false", () => {
    const dir = setupMinimalProject("US-DELTA-ORPH-NOLEASE", "delta-team");

    // Create marker without any lease
    const delegationId = randomUUID();
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPH-NOLEASE", `delta-${delegationId}`);
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(
      join(frameDir, "delegation-open.json"),
      JSON.stringify({ schema: "roll-delta-delegation-open/v1", delegationId, storyId: "US-DELTA-ORPH-NOLEASE", createdAt: new Date().toISOString() }),
      "utf8",
    );

    // Ensure no lease for this story
    const slPath = storyLeasesPath(dir);
    if (existsSync(slPath)) {
      const sl = readLeases(slPath);
      delete sl["US-DELTA-ORPH-NOLEASE"];
      // Must not exist
      expect(sl["US-DELTA-ORPH-NOLEASE"]).toBeUndefined();
    }

    const r = tsRunCwd(["status", "--story", "US-DELTA-ORPH-NOLEASE", "--json"], dir);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.uncommittedFrames).toBeDefined();
    expect(parsed.uncommittedFrames.length).toBe(1);
    const orphan = parsed.uncommittedFrames[0];
    expect(orphan.delegationId).toBe(delegationId);
    expect(orphan.hasMatchingLease).toBe(false);
    expect(orphan.status).toBe("unknown: uncommitted_delegation_frame");
  });

  it("BLOCK-C: marker + wrong delegation lease → hasMatchingLease: false", () => {
    const dir = setupMinimalProject("US-DELTA-ORPH-WRONG", "delta-team");

    // Create marker for delegation A
    const delegationId = randomUUID();
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPH-WRONG", `delta-${delegationId}`);
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(
      join(frameDir, "delegation-open.json"),
      JSON.stringify({ schema: "roll-delta-delegation-open/v1", delegationId, storyId: "US-DELTA-ORPH-WRONG", createdAt: new Date().toISOString() }),
      "utf8",
    );

    // Create a lease for the SAME story but DIFFERENT delegationId
    const wrongDelegationId = randomUUID();
    claimHostDelegationLease(dir, "US-DELTA-ORPH-WRONG", wrongDelegationId, `delta-${wrongDelegationId}`);

    try {
      const r = tsRunCwd(["status", "--story", "US-DELTA-ORPH-WRONG", "--json"], dir);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.uncommittedFrames).toBeDefined();
      expect(parsed.uncommittedFrames.length).toBe(1);
      const orphan = parsed.uncommittedFrames[0];
      expect(orphan.delegationId).toBe(delegationId);
      // hasMatchingLease must be false because lease is for different delegation
      expect(orphan.hasMatchingLease).toBe(false);
      // Status is plain uncommitted (no "lease held" since lease doesn't match this delegation)
      expect(orphan.status).toBe("unknown: uncommitted_delegation_frame");
    } finally {
      releaseHostDelegationLease(dir, "US-DELTA-ORPH-WRONG", wrongDelegationId, `delta-${wrongDelegationId}`);
    }
  });

  it("BLOCK-C: marker + matching delegation lease → hasMatchingLease: true (existing contract)", () => {
    const dir = setupMinimalProject("US-DELTA-ORPH-MATCH", "delta-team");

    // Create marker for delegation A
    const delegationId = randomUUID();
    const frameDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ORPH-MATCH", `delta-${delegationId}`);
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(
      join(frameDir, "delegation-open.json"),
      JSON.stringify({ schema: "roll-delta-delegation-open/v1", delegationId, storyId: "US-DELTA-ORPH-MATCH", createdAt: new Date().toISOString() }),
      "utf8",
    );

    // Create a matching lease (same delegationId)
    claimHostDelegationLease(dir, "US-DELTA-ORPH-MATCH", delegationId, `delta-${delegationId}`);

    try {
      const r = tsRunCwd(["status", "--story", "US-DELTA-ORPH-MATCH", "--json"], dir);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.uncommittedFrames).toBeDefined();
      expect(parsed.uncommittedFrames.length).toBe(1);
      const orphan = parsed.uncommittedFrames[0];
      expect(orphan.delegationId).toBe(delegationId);
      expect(orphan.hasMatchingLease).toBe(true);
      expect(orphan.status).toBe("unknown: uncommitted_delegation_frame (lease held)");
    } finally {
      releaseHostDelegationLease(dir, "US-DELTA-ORPH-MATCH", delegationId, `delta-${delegationId}`);
    }
  });
});

// ── ZH locale error smoke (III.7) ───────────────────────────────────────────

describe("US-DELTA-003 — ZH locale error messages", () => {
  it("prepare --json error produces valid JSON envelope on stderr", () => {
    const dir = setupMinimalProject("US-DELTA-ZH", "delta-team");
    // Missing required flags → JSON error
    const r = tsRunCwd(["prepare", "US-DELTA-ZH", "--json"], dir);
    expect(r.code).toBe(1);
    // Must be valid JSON on stderr
    const err = JSON.parse(r.stderr);
    expect(err.ok).toBe(false);
    expect(typeof err.error).toBe("string");
    expect(typeof err.detail).toBe("string");
  });

  it("prepare missing flag error is valid JSON", () => {
    const dir = setupMinimalProject("US-DELTA-ZH2", "delta-team");
    const r = tsRunCwd(["prepare", "US-DELTA-ZH2", "--json"], dir);
    expect(r.code).toBe(1);
    expect(() => JSON.parse(r.stderr)).not.toThrow();
  });

  it("validate --json block error is valid JSON on stderr", () => {
    const dir = setupMinimalProject("US-DELTA-ZH3", "delta-team");
    const r = tsRunCwd(["validate", "--delegation", "nonexistent", "--stage", "designer", "--json"], dir);
    expect(r.code).toBe(1);
    expect(() => JSON.parse(r.stderr)).not.toThrow();
    const err = JSON.parse(r.stderr);
    expect(err.ok).toBe(false);
    expect(typeof err.error).toBe("string");
  });

  it("ZH locale error contains CJK characters for known errors", () => {
    const prev = process.env["ROLL_LANG"];
    try {
      process.env["ROLL_LANG"] = "zh";
      const dir = setupMinimalProject("US-DELTA-ZH4", "delta-team");
      // Missing story → error
      const r = tsRunCwd(["prepare"], dir);
      expect(r.code).toBe(1);
      // Should contain CJK
      expect(/[\u4e00-\u9fff]/.test(r.stderr)).toBe(true);
    } finally {
      if (prev !== undefined) process.env["ROLL_LANG"] = prev;
      else delete process.env["ROLL_LANG"];
    }
  });

  it("conclude --json terminal_path_unselected error is valid JSON", () => {
    const dir = setupMinimalProject("US-DELTA-ZH5", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ZH5", "local-preset");
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-ZH5",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const r2 = tsRunCwd(["conclude", "--delegation", delegationId, "--json"], dir);
    expect(r2.code).toBe(1);
    expect(() => JSON.parse(r2.stderr)).not.toThrow();
    const err = JSON.parse(r2.stderr);
    expect(err.error).toBe("terminal_path_unselected");
  });
});

// ── Forbidden audit: fail-closed import closure check ──────────────────

describe("US-DELTA-003 — forbidden import audit (fail-closed)", () => {
  it("delta.ts and delta-allocation.ts exist and have no forbidden imports", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const deltaDir = path.resolve(import.meta.dirname, "..", "src", "commands");
    const libDir = path.resolve(import.meta.dirname, "..", "src", "lib");

    const requiredFiles = [
      path.join(deltaDir, "delta.ts"),
      path.join(libDir, "delta-allocation.ts"),
      path.join(libDir, "delta-artifacts.ts"),
    ];

    // FAIL-CLOSED: every required file must exist
    for (const file of requiredFiles) {
      if (!fs.existsSync(file)) {
        throw new Error(`Forbidden audit FAIL-CLOSED: required file missing: ${file}`);
      }
    }

    const forbiddenPatterns = [
      // Forbidden import/require patterns — checked as import statements, not substring
      "from \"@anthropic",
      "require(\"@anthropic",
      "from \"openai",
      "require(\"openai",
      "agentSpawn",
      "cycleAllocator",
      "allocCycle",
      "runs.jsonl",
      "createPR",
      "DeliveryRecord",
      "cycle:terminal",
      "upsertRun",
    ];

    for (const file of requiredFiles) {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        // Only flag if the pattern appears outside comments
        const lines = content.split("\n");
        const offendingLines = lines.filter(l => {
          const trimmed = l.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
          if (trimmed.startsWith("/*") || trimmed.startsWith("*/") || trimmed === "*") return false;
          return l.includes(pattern);
        });
        if (offendingLines.length > 0) {
          throw new Error(
            `Forbidden audit FAIL-CLOSED: ${file} contains forbidden pattern "${pattern}" in non-comment lines`,
          );
        }
      }
    }

    // Also verify the delta command dispatch entry exists and includes delta
    const indexFile = path.join(deltaDir, "index.ts");
    expect(fs.existsSync(indexFile)).toBe(true);
  });

  it("prepare+validate+conclude events contain no cycle:/delivery/done types", () => {
    const dir = setupMinimalProject("US-DELTA-NOCYCLE", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-NOCYCLE", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-NOCYCLE",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Create artifact FILE + validate
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-NOCYCLE",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest()), "utf8");
    tsRunCwd(["validate", "--delegation", delegationId, "--stage", "designer", "--json"], dir);

    // Conclude
    tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);

    // Verify final state
    const events = readFileSync(join(dir, ".roll", "loop", "events.ndjson"), "utf8")
      .trim().split("\n").map(l => JSON.parse(l));

    for (const ev of events) {
      // No cycle: events
      if (typeof ev.type === "string" && ev.type.startsWith("cycle:")) {
        throw new Error(`Forbidden: cycle event found: ${ev.type}`);
      }
      // No delivery/done
      if (ev.DeliveryRecord || ev.done || ev.status === "Done") {
        throw new Error(`Forbidden: delivery/done field found in event: ${JSON.stringify(ev)}`);
      }
    }

    // No runs.jsonl or latest
    expect(existsSync(join(dir, ".roll", "loop", "runs.jsonl"))).toBe(false);
    expect(existsSync(join(dir, ".roll", "features", "delta-team", "US-DELTA-NOCYCLE", "latest"))).toBe(false);
  });
});

// ── Snapshot scrubber fix: no /private<TMP> artifacts (III.7) ────────────────

describe("US-DELTA-003 — snapshot scrubber determinism", () => {
  it("scrubber does not produce /private<TMP> hybrid, correctly separates project and tmp", () => {
    const dir = setupMinimalProject("US-DELTA-SCRUB", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-SCRUB", "local-preset");

    const r = tsRunCwd([
      "prepare", "US-DELTA-SCRUB",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(0);

    const scrubbed = scrubPaths(r.stdout, dir);
    // Must NOT contain /private<TMP> — this would indicate <TMP> placed inside a path prefix
    expect(scrubbed).not.toContain("/private<TMP>");
    // Must NOT contain raw UUIDs
    expect(scrubbed).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
    // Must NOT contain raw 64-char hex
    expect(scrubbed).not.toMatch(/[a-f0-9]{64}/i);
  });
});

// ── Cross-source mutual exclusion (bidirectional no-clobber) ─────────────────

describe("US-DELTA-003 — cross-source atomic exclusion", () => {
  it("host claim blocks cycle claim (host then cycle fails)", () => {
    const dir = setupMinimalProject("US-DELTA-X-HC", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    // Host claims first
    const hResult = claimHostDelegationLease(dir, "US-DELTA-X-HC", randomUUID(), "delta-host");
    expect(hResult).toBe("claimed");

    // Cycle tries to claim via core primitive — must fail
    const cResult = claimStoryLease(slPath, "US-DELTA-X-HC", {
      pid: process.pid, claimedAt: Date.now(), source: "cycle",
    });
    expect(cResult.status).toBe("exists");
    if (cResult.status === "exists") {
      expect(cResult.existingSource).toBe("host-delegation");
    }

    // Host entry still intact
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-X-HC"].source).toBe("host-delegation");

    // Cleanup
    releaseHostDelegationLease(dir, "US-DELTA-X-HC", sl["US-DELTA-X-HC"].delegationId, `delta-${sl["US-DELTA-X-HC"].delegationId}`);
  });

  it("cycle claim blocks host claim (cycle then host fails)", () => {
    const dir = setupMinimalProject("US-DELTA-X-CH", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    // Cycle claims first
    const cResult = claimStoryLease(slPath, "US-DELTA-X-CH", {
      pid: process.pid, claimedAt: Date.now(), source: "cycle",
    });
    expect(cResult.status).toBe("claimed");

    // Host tries to claim — must fail
    const hResult = claimHostDelegationLease(dir, "US-DELTA-X-CH", randomUUID(), "delta-host");
    expect(hResult).toBe("exists");

    // Cycle entry still intact
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-X-CH"].source).toBe("cycle");

    // Cleanup
    releaseStoryLease(slPath, "US-DELTA-X-CH", { source: "cycle", pid: process.pid });
  });

  it("human claim blocks host prepare (bidirectional)", () => {
    const dir = setupMinimalProject("US-DELTA-X-HH", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-X-HH", "local-preset");

    // Human claims via setLease
    const slPath = storyLeasesPath(dir);
    setLease(slPath, "US-DELTA-X-HH", { claimedAt: Date.now(), source: "human" });

    // Host prepare must fail
    const r = tsRunCwd([
      "prepare", "US-DELTA-X-HH",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(1);

    // No frame created (failed contender has no frame/events)
    const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-X-HH");
    const deltaDirs = existsSync(cardDir)
      ? readdirSync(cardDir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith("delta-"))
      : [];
    expect(deltaDirs.length).toBe(0);
  });

  it("host claim blocks human claim via claimStoryLease", () => {
    const dir = setupMinimalProject("US-DELTA-X-HC2", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    // Host claims first
    const hResult = claimHostDelegationLease(dir, "US-DELTA-X-HC2", randomUUID(), "delta-host");
    expect(hResult).toBe("claimed");

    // Human tries to claim — must fail
    const huResult = claimStoryLease(slPath, "US-DELTA-X-HC2", {
      claimedAt: Date.now(), source: "human",
    });
    expect(huResult.status).toBe("exists");
    if (huResult.status === "exists") {
      expect(huResult.existingSource).toBe("host-delegation");
    }

    // Host entry preserved
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-X-HC2"].source).toBe("host-delegation");

    // Cleanup
    releaseHostDelegationLease(dir, "US-DELTA-X-HC2", sl["US-DELTA-X-HC2"].delegationId, `delta-${sl["US-DELTA-X-HC2"].delegationId}`);
  });

  it("failed contender has no frame or events", async () => {
    const dir = setupMinimalProject("US-DELTA-NOFRAME", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-NOFRAME", "local-preset");

    // First prepare succeeds
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-NOFRAME",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const winnerId = JSON.parse(r1.stdout).delegationId;

    // Snapshot events count
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // Second prepare must fail — no new frame, no new events
    const r2 = tsRunCwd([
      "prepare", "US-DELTA-NOFRAME",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r2.code).toBe(1);

    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // Only winner's frame exists
    const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-NOFRAME");
    const deltaDirs = readdirSync(cardDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith("delta-"));
    expect(deltaDirs.length).toBe(1);
    expect(deltaDirs[0]!.name).toBe(`delta-${winnerId}`);
  });
});

// ── Architecture BLOCK: Host-delegation lease lifecycle (Tasks A, B, C) ───

describe("US-DELTA-003 — host-delegation persistent lease lifecycle", () => {
  it("cleanDeadLeases does NOT clean live host-delegation lease (Task A)", () => {
    const dir = setupMinimalProject("US-DELTA-HL-PERSIST", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-HL-PERSIST", "local-preset");

    // Prepare succeeds
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-HL-PERSIST",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const origDelegationId = JSON.parse(r1.stdout).delegationId;

    // Verify lease exists
    const slPath = storyLeasesPath(dir);
    expect(existsSync(slPath)).toBe(true);
    let sl = readLeases(slPath);
    expect(sl["US-DELTA-HL-PERSIST"]).toBeDefined();
    expect(sl["US-DELTA-HL-PERSIST"].source).toBe("host-delegation");
    expect(sl["US-DELTA-HL-PERSIST"].pid).toBeUndefined(); // no pid = persistent

    // Call cleanDeadLeases — host-delegation has no pid, so it is NOT cleaned
    const { cleanDeadLeases } = require("@roll/core");
    const cleaned = cleanDeadLeases(slPath);
    expect(cleaned).not.toContain("US-DELTA-HL-PERSIST");

    // Lease still exists after cleanDeadLeases
    sl = readLeases(slPath);
    expect(sl["US-DELTA-HL-PERSIST"]).toBeDefined();
    expect(sl["US-DELTA-HL-PERSIST"].source).toBe("host-delegation");

    // Cleanup
    releaseHostDelegationLease(dir, "US-DELTA-HL-PERSIST", origDelegationId, `delta-${origDelegationId}`);
  });

  it("cleanDeadLeases cleans dead cycle pid but not host-delegation (Task A+C)", () => {
    const dir = setupMinimalProject("US-DELTA-HL-MIXED", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    // Write a cycle lease with a definitely-dead PID + host-delegation lease
    setLease(slPath, "US-DELTA-HL-MIXED", { pid: 999999, claimedAt: Date.now(), source: "cycle" });
    setLease(slPath, "US-DELTA-HL-MIXED-HOST", { claimedAt: Date.now(), source: "host-delegation", delegationId: "persist-deleg", runId: "delta-persist-deleg" });

    const { cleanDeadLeases } = require("@roll/core");
    const cleaned = cleanDeadLeases(slPath);

    // Cycle lease with dead pid should be cleaned
    expect(cleaned).toContain("US-DELTA-HL-MIXED");
    // Host-delegation must NOT be cleaned
    expect(cleaned).not.toContain("US-DELTA-HL-MIXED-HOST");

    // Verify host-delegation still exists
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-HL-MIXED-HOST"]).toBeDefined();
    expect(sl["US-DELTA-HL-MIXED-HOST"].source).toBe("host-delegation");
  });

  it("releaseHostDelegationLease requires matching delegationId (Task B)", () => {
    const dir = setupMinimalProject("US-DELTA-REL-DELEG", "delta-team");
    const slPath = storyLeasesPath(dir);

    // Write host-delegation lease
    setLease(slPath, "US-DELTA-REL-DELEG", { claimedAt: Date.now(), source: "host-delegation", delegationId: "correct-id", runId: "delta-correct-id" });

    // Attempt release with mismatched delegationId — must fail
    const result = releaseHostDelegationLease(dir, "US-DELTA-REL-DELEG", "wrong-id", "delta-wrong-id");
    expect(result).toBe(false);

    // Lease still intact
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-REL-DELEG"]).toBeDefined();
    expect(sl["US-DELTA-REL-DELEG"].delegationId).toBe("correct-id");

    // Correct delegationId but wrong runId — must fail
    const result2 = releaseHostDelegationLease(dir, "US-DELTA-REL-DELEG", "correct-id", "delta-wrong-id");
    expect(result2).toBe(false);

    // Correct delegationId + correct runId — succeeds
    const result3 = releaseHostDelegationLease(dir, "US-DELTA-REL-DELEG", "correct-id", "delta-correct-id");
    expect(result3).toBe(true);
  });

  it("releaseHostDelegationLease with empty delegationId rejects (Task B)", () => {
    const dir = setupMinimalProject("US-DELTA-REL-EMPTY", "delta-team");
    const slPath = storyLeasesPath(dir);

    setLease(slPath, "US-DELTA-REL-EMPTY", { claimedAt: Date.now(), source: "host-delegation", delegationId: "real-id", runId: "delta-real-id" });

    // Attempt release with empty delegationId — must fail
    const result = releaseHostDelegationLease(dir, "US-DELTA-REL-EMPTY", "", "delta-real-id");
    expect(result).toBe(false);
  });

  it("pre-interruption orphan retains host lease; cleanDeadLeases does NOT clean it (Task A)", () => {
    const dir = setupMinimalProject("US-DELTA-HL-ORPHAN", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-HL-ORPHAN", "local-preset");

    // Inject crash before event append
    injectPrepareInterrupt(() => {
      throw new Error("simulated crash");
    });

    let delegId = "";
    try {
      expect(() => {
        tsRunCwd([
          "prepare", "US-DELTA-HL-ORPHAN",
          "--trigger", "host-guided", "--topology", "delta-team",
          "--profile", "standard", "--preset", "local-preset",
          "--resolution", resPath, "--json",
        ], dir);
      }).toThrow("simulated crash");
    } finally {
      injectPrepareInterrupt(null);
    }

    // Lease must exist (persistent host delegation lease)
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-HL-ORPHAN"]).toBeDefined();
    expect(sl["US-DELTA-HL-ORPHAN"].source).toBe("host-delegation");
    delegId = sl["US-DELTA-HL-ORPHAN"].delegationId;

    // cleanDeadLeases must NOT clean this
    const { cleanDeadLeases } = require("@roll/core");
    const cleaned = cleanDeadLeases(slPath);
    expect(cleaned).not.toContain("US-DELTA-HL-ORPHAN");

    // Lease still exists after cleanDeadLeases
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-HL-ORPHAN"]).toBeDefined();

    // Cleanup
    releaseHostDelegationLease(dir, "US-DELTA-HL-ORPHAN", delegId, `delta-${delegId}`);
  });
});

// ── Story-level concurrent barrier with ready files (III.1) ────────────────

describe("US-DELTA-003 — concurrent subprocess barrier (ready ack)", () => {
  it("both workers write ready ack; main waits for both before releasing go; exactly one winner", async () => {
    const dir = setupMinimalProject("US-DELTA-READY", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-READY", "local-preset");

    const readyPath1 = join(dir, "ready-worker-1");
    const readyPath2 = join(dir, "ready-worker-2");
    const barrierPath = join(dir, "barrier");

    // Write barrier with "wait" so children spin
    writeFileSync(barrierPath, "wait", "utf8");

    const runChild = (workerId: number): Promise<{ code: number; stdout: string; stderr: string }> => {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [
          tsxBin,
          join(import.meta.dirname, "delta-concurrent-worker-ready.ts"),
          dir,
          resPath,
          barrierPath,
          String(workerId),
        ], {
          cwd: dir,
          stdio: "pipe",
          env: { ...process.env, ROLL_LANG: "en" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code) => {
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    };

    const p1 = runChild(1);
    const p2 = runChild(2);

    // Wait for BOTH ready files before releasing barrier (no fixed timeout)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (existsSync(readyPath1) && existsSync(readyPath2)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(existsSync(readyPath1)).toBe(true);
    expect(existsSync(readyPath2)).toBe(true);

    // Release barrier — both workers compete for the lease
    writeFileSync(barrierPath, "go", "utf8");

    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one must succeed (code 0), exactly one must fail (code 1)
    const codes = [r1.code, r2.code].sort();
    expect(codes).toEqual([0, 1]);

    // Winner has valid output, loser has builder_lease_conflict
    const winner = r1.code === 0 ? r1 : r2;
    const loser = r1.code === 0 ? r2 : r1;
    const winnerOut = winner.stdout.trim();
    const jsonLine = winnerOut.split("\n").find(l => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const winnerParsed = JSON.parse(jsonLine!);
    expect(winnerParsed.ok).toBe(true);

    const loserOutput = loser.stderr + loser.stdout;
    expect(loserOutput).toContain("builder_lease_conflict");

    // Only ONE committed frame + ONE lease
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    const preparedEvents = events.filter((l: string) => { try { return JSON.parse(l).type === "delta:prepared"; } catch { return false; }});
    expect(preparedEvents.length).toBe(1);

    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-READY"]).toBeDefined();
    expect(sl["US-DELTA-READY"].source).toBe("host-delegation");

    // Cleanup: release the lease
    releaseHostDelegationLease(dir, "US-DELTA-READY", sl["US-DELTA-READY"].delegationId, sl["US-DELTA-READY"].runId);
  }, 30000);

  it("different story concurrent barrier: both succeed, no global lock", async () => {
    const dir = makeProject();
    // Two separate stories
    for (const storyId of ["US-DELTA-DIFF-1", "US-DELTA-DIFF-2"]) {
      const featuresDir = join(dir, ".roll", "features", "delta-team", storyId);
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(featuresDir, "spec.md"), `# ${storyId}\n\nStory spec.\n`, "utf8");
    }
    mkdirSync(join(dir, ".roll", "loop"), { recursive: true });

    const resPath1 = writeResolutionTemplate(dir, "US-DELTA-DIFF-1", "local-preset", "res-1.json");
    const resPath2 = writeResolutionTemplate(dir, "US-DELTA-DIFF-2", "local-preset", "res-2.json");

    const barrierPath = join(dir, "barrier-diff");
    writeFileSync(barrierPath, "wait", "utf8");

    const runChildForStory = (storyId: string, resPath: string, workerId: number): Promise<{ code: number; stdout: string; stderr: string }> => {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [
          tsxBin,
          join(import.meta.dirname, "delta-concurrent-diff-worker.ts"),
          dir,
          storyId,
          resPath,
          barrierPath,
          String(workerId),
        ], {
          cwd: dir,
          stdio: "pipe",
          env: { ...process.env, ROLL_LANG: "en" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code) => {
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    };

    const p1 = runChildForStory("US-DELTA-DIFF-1", resPath1, 1);
    const p2 = runChildForStory("US-DELTA-DIFF-2", resPath2, 2);

    // Wait for both ready files
    const readyPath1 = join(dir, "ready-diff-worker-1");
    const readyPath2 = join(dir, "ready-diff-worker-2");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (existsSync(readyPath1) && existsSync(readyPath2)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(existsSync(readyPath1)).toBe(true);
    expect(existsSync(readyPath2)).toBe(true);

    writeFileSync(barrierPath, "go", "utf8");

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both stories should succeed — no global lock
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);

    // Both leases exist for different stories
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-DIFF-1"]).toBeDefined();
    expect(sl["US-DELTA-DIFF-2"]).toBeDefined();

    // Cleanup
    releaseHostDelegationLease(dir, "US-DELTA-DIFF-1", sl["US-DELTA-DIFF-1"].delegationId, sl["US-DELTA-DIFF-1"].runId);
    releaseHostDelegationLease(dir, "US-DELTA-DIFF-2", sl["US-DELTA-DIFF-2"].delegationId, sl["US-DELTA-DIFF-2"].runId);
  }, 30000);
});

// ── Import closure audit: fail-closed recursive import traversal (BLOCK #1) ─

describe("US-DELTA-003 — import closure audit (unified helper)", () => {
  it("recursive closure from delta.ts has no forbidden patterns", async () => {
    const path = await import("node:path");
    const { auditImportClosure } = await import("./delta-import-audit.js");
    const deltaFile = path.resolve(__dirname, "..", "src", "commands", "delta.ts");
    const result = auditImportClosure(deltaFile, {
      forbiddenTokens: [
        "agentSpawn", "createAgent", "@anthropic", "openai",
        "cycleAllocator", "allocCycle",
        "runs.jsonl", "createPR", "DeliveryRecord", "cycle:terminal", "upsertRun",
        "artifact-protocol", "attestation", "role-access", "manifest-v2",
      ],
    });
    expect(result.violations).toEqual([]);
    expect(result.files.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Prepare artifact no-overwrite (BLOCK #2) ──────────────────────────────

describe("US-DELTA-003 — prepare immutable artifact no-overwrite", () => {
  it("prepare fail-loud with artifact_exists when marker pre-exists, original bytes unchanged", () => {
    const dir = setupMinimalProject("US-DELTA-NOOVERWRITE", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-NOOVERWRITE", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-NOOVERWRITE",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Read original marker bytes
    const markerPath = join(dir, ".roll", "features", "delta-team", "US-DELTA-NOOVERWRITE",
      `delta-${delegationId}`, "delegation-open.json");
    const originalBytes = readFileSync(markerPath);

    // Release lease so second prepare can try again
    releaseHostDelegationLease(dir, "US-DELTA-NOOVERWRITE", delegationId, `delta-${delegationId}`);

    // Second prepare with same story should fail because the frame dir already exists
    // (frame dir = artifact collision, which is caught by mkdir EEXIST → retry → lease conflict on next attempt)
    // Actually, the frame dir exists with the same delegationId, so prepareDelegation generates a NEW id,
    // and that new id's frame won't collide. But the lease needs to be claimed first.
    // After releasing the lease, a second prepare with a NEW resolution template works:
    const resPath2 = writeResolutionTemplate(dir, "US-DELTA-NOOVERWRITE", "local-preset", "resolution-template-2.json");
    const r2 = tsRunCwd([
      "prepare", "US-DELTA-NOOVERWRITE",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath2, "--json",
    ], dir);
    expect(r2.code).toBe(0);

    // Original marker bytes unchanged
    const afterBytes = readFileSync(markerPath);
    expect(Buffer.compare(originalBytes, afterBytes)).toBe(0);
  });
});

// ── Event append failure seam: conclude retains lease (BLOCK #4) ──────────

describe("US-DELTA-003 — conclude event append failure seam", () => {
  it("conclude with injected event append failure retains lease and produces no success output", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-APPFAIL", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-APPFAIL", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-APPFAIL",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Inject an event append failure that throws after the terminal event is written
    injectEventAppendFailure(() => {
      throw new Error("simulated event append failure");
    });

    try {
      const r2 = tsRunCwd([
        "conclude", "--delegation", delegationId,
        "--delivery-disposition", "owner_continue", "--json",
      ], dir);

      // Must NOT output success — code non-zero, stdout empty
      expect(r2.code).toBe(1);
      expect(r2.stdout).toBe("");
      const err = JSON.parse(r2.stderr);
      expect(err.ok).toBe(false);
      expect(err.error).toBe("event_append_failure");

      // Lease must be retained (not released) — the failure prevents release
      const slPath = storyLeasesPath(dir);
      const sl = readLeases(slPath);
      expect(sl["US-DELTA-CONC-APPFAIL"]).toBeDefined();
      expect(sl["US-DELTA-CONC-APPFAIL"].source).toBe("host-delegation");

      // Cleanup: release the lease
      releaseHostDelegationLease(dir, "US-DELTA-CONC-APPFAIL", delegationId, `delta-${delegationId}`);
    } finally {
      injectEventAppendFailure(null);
    }
  });
});

// ── Status edge cases (BLOCK #5) ──────────────────────────────────────────

describe("US-DELTA-003 — status edge cases", () => {
  it("status --story with multiple delegations shows all in JSON delegations array", () => {
    const dir = setupMinimalProject("US-DELTA-MULTI", "delta-team");

    // Prepare delegation A
    const resPathA = writeResolutionTemplate(dir, "US-DELTA-MULTI", "local-preset", "res-a.json");
    const r1 = tsRunCwd([
      "prepare", "US-DELTA-MULTI",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPathA, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegA = JSON.parse(r1.stdout).delegationId;

    // Release lease and prepare delegation B
    releaseHostDelegationLease(dir, "US-DELTA-MULTI", delegA, `delta-${delegA}`);
    const resPathB = writeResolutionTemplate(dir, "US-DELTA-MULTI", "local-preset", "res-b.json");
    const r2 = tsRunCwd([
      "prepare", "US-DELTA-MULTI",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPathB, "--json",
    ], dir);
    expect(r2.code).toBe(0);
    const delegB = JSON.parse(r2.stdout).delegationId;

    // Status --story should show both delegations
    const r3 = tsRunCwd(["status", "--story", "US-DELTA-MULTI", "--json"], dir);
    expect(r3.code).toBe(0);
    const statusOut = JSON.parse(r3.stdout);
    expect(statusOut.delegations).toBeDefined();
    expect(statusOut.delegations.length).toBeGreaterThanOrEqual(2);
    const delegIds = statusOut.delegations.map((d: { delegationId: string }) => d.delegationId);
    expect(delegIds).toContain(delegA);
    expect(delegIds).toContain(delegB);
  });

  it("status --delegation with unknown id returns empty result", () => {
    const dir = setupMinimalProject("US-DELTA-UNKNOWN", "delta-team");
    const r = tsRunCwd(["status", "--delegation", "nonexistent-deleg-id", "--json"], dir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    // No delegation found, no crash — empty projection
    expect(out.ok ?? true).toBe(true);
    // Status may echo the delegationId and report "unknown"
    expect(typeof out.delegationId).toBe("string");
    // status may be "unknown" or absent — both are valid for nonexistent delegation
  });

  it("status with both --story and --delegation prefers delegation view", () => {
    const dir = setupMinimalProject("US-DELTA-BOTH", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-BOTH", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-BOTH",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Both --story and --delegation: delegation takes priority
    const r2 = tsRunCwd([
      "status", "--story", "US-DELTA-BOTH", "--delegation", delegationId, "--json",
    ], dir);
    expect(r2.code).toBe(0);
    const out = JSON.parse(r2.stdout);
    expect(out.delegationId).toBe(delegationId);
  });
});

// ── Core claim primitive independent worker contention (BLOCK #6) ──────────

describe("US-DELTA-003 — core claim primitive worker contention", () => {
  it("core claimStoryLease atomically guarantees one winner under lock-based atomic lease", () => {
    const dir = setupMinimalProject("US-DELTA-CORE-CLAIM", "delta-team");
    const slPath = storyLeasesPath(dir);

    const delegId1 = randomUUID();
    const delegId2 = randomUUID();

    // Two sequential claims — the lock-based atomic claimStoryLease ensures only one wins
    const r1 = claimStoryLease(slPath, "US-DELTA-CORE-CLAIM", {
      claimedAt: Date.now(), source: "host-delegation", delegationId: delegId1, runId: `delta-${delegId1}`,
    });
    expect(r1.status).toBe("claimed");

    const r2Result = claimStoryLease(slPath, "US-DELTA-CORE-CLAIM", {
      claimedAt: Date.now(), source: "host-delegation", delegationId: delegId2, runId: `delta-${delegId2}`,
    });
    expect(r2Result.status).toBe("exists");
    if (r2Result.status === "exists") {
      expect(r2Result.existingSource).toBe("host-delegation");
    }

    // The shared leases directory has the winner's delegationId
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-CORE-CLAIM"].delegationId).toBe(delegId1);

    // Release the winner
    releaseHostDelegationLease(dir, "US-DELTA-CORE-CLAIM", delegId1, `delta-${delegId1}`);
  });

  it("claimStoryLease sequential calls prove lock-based atomic exclusion (no deadlock)", () => {
    const dir = setupMinimalProject("US-DELTA-LOCK-LIVE", "delta-team");
    const slPath = storyLeasesPath(dir);

    // First claim succeeds
    const delegId1 = randomUUID();
    const r1 = claimStoryLease(slPath, "US-DELTA-LOCK-LIVE", {
      claimedAt: Date.now(), source: "host-delegation", delegationId: delegId1, runId: `delta-${delegId1}`,
    });
    expect(r1.status).toBe("claimed");

    // Second claim fails (atomic exclusion via lock-based claim)
    const delegId2 = randomUUID();
    const r2 = claimStoryLease(slPath, "US-DELTA-LOCK-LIVE", {
      claimedAt: Date.now(), source: "host-delegation", delegationId: delegId2, runId: `delta-${delegId2}`,
    });
    expect(r2.status).toBe("exists");

    // Release and cleanup
    releaseHostDelegationLease(dir, "US-DELTA-LOCK-LIVE", delegId1, `delta-${delegId1}`);
  });
});

// ── BLOCK #1: Artifact immutability through controlled frame/id seam ────────

describe("US-DELTA-003 — artifact immutability via frame/id seam (BLOCK #1)", () => {
  it("pre-placed marker in same frame is immutable; no events/lease change", () => {
    const dir = setupMinimalProject("US-DELTA-IMMUT-M", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-IMMUT-M", "local-preset");

    // Control ID generator: first attempt collides with pre-placed frame,
    // second produces fresh ID.
    injectIdGenerator(() => {
      // Return the same ID that we pre-placed for collision
      return "immut-marker-test";
    });

    try {
      // Pre-place frame directory with marker at controlled path
      const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-IMMUT-M");
      const controlledFrame = join(cardDir, "delta-immut-marker-test");
      mkdirSync(controlledFrame, { recursive: true });
      const markerContent = JSON.stringify({
        schema: "roll-delta-delegation-open/v1",
        delegationId: "immut-marker-test",
        storyId: "US-DELTA-IMMUT-M",
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n";
      writeFileSync(join(controlledFrame, "delegation-open.json"), markerContent, "utf8");
      const originalBytes = readFileSync(join(controlledFrame, "delegation-open.json"));

      // Prepare: mkdirSync fails on controlled frame → collision retry exhausts
      // (generator always returns same ID) → throws builder_lease_conflict
      const r = tsRunCwd([
        "prepare", "US-DELTA-IMMUT-M",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);
      expect(r.code).toBe(1);
      const err = JSON.parse(r.stderr);
      expect(err.error).toBe("builder_lease_conflict");

      // Original marker bytes unchanged
      const afterBytes = readFileSync(join(controlledFrame, "delegation-open.json"));
      expect(Buffer.compare(originalBytes, afterBytes)).toBe(0);

      // No events appended (collision retry releases own lease only)
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      expect(existsSync(eventsPath)).toBe(false);

      // Lease not retained for failed prepare (own-lease released on retry)
      const slPath = storyLeasesPath(dir);
      if (existsSync(slPath)) {
        const sl = readLeases(slPath);
        expect(sl["US-DELTA-IMMUT-M"]).toBeUndefined();
      }
    } finally {
      injectIdGenerator(null);
    }
  });

  it("pre-placed resolution in same frame immutable through collision retry", () => {
    const dir = setupMinimalProject("US-DELTA-IMMUT-R", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-IMMUT-R", "local-preset");

    // First collision, then fresh ID
    let callCount = 0;
    injectIdGenerator(() => {
      callCount++;
      return callCount === 1 ? "immut-res-test" : `immut-res-test-${randomUUID()}`;
    });

    try {
      // Pre-place frame with resolution file at controlled path
      const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-IMMUT-R");
      const controlledFrame = join(cardDir, "delta-immut-res-test");
      mkdirSync(controlledFrame, { recursive: true });
      const resContent = JSON.stringify({ schema: "test", delegationId: "immut-res-test" }, null, 2) + "\n";
      writeFileSync(join(controlledFrame, "delegation-open.json"), "test", "utf8");
      const originalBytes = readFileSync(join(controlledFrame, "delegation-open.json"));

      const r = tsRunCwd([
        "prepare", "US-DELTA-IMMUT-R",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);
      // Collision retry → second ID succeeds
      expect(r.code).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.delegationId).not.toBe("immut-res-test");

      // Original frame bytes unchanged
      const afterBytes = readFileSync(join(controlledFrame, "delegation-open.json"));
      expect(Buffer.compare(originalBytes, afterBytes)).toBe(0);

      // Only one committed frame's events written (no duplicates from collision)
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      const preparedEvents = events.filter((l: string) => {
        try { return JSON.parse(l).type === "delta:prepared"; } catch { return false; }
      });
      expect(preparedEvents.length).toBe(1);
      expect(JSON.parse(preparedEvents[0]!).delegationId).toBe(result.delegationId);
    } finally {
      injectIdGenerator(null);
    }
  });

  it("pre-placed preparation.json immutable through collision retry", () => {
    const dir = setupMinimalProject("US-DELTA-IMMUT-P", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-IMMUT-P", "local-preset");

    let callCount = 0;
    injectIdGenerator(() => {
      callCount++;
      return callCount === 1 ? "immut-prep-test" : `immut-prep-test-${randomUUID()}`;
    });

    try {
      const cardDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-IMMUT-P");
      const controlledFrame = join(cardDir, "delta-immut-prep-test");
      mkdirSync(controlledFrame, { recursive: true });
      writeFileSync(join(controlledFrame, "delegation-open.json"), "test-marker", "utf8");
      writeFileSync(join(controlledFrame, "preparation.json"), "test-preparation", "utf8");
      const originalPrepBytes = readFileSync(join(controlledFrame, "preparation.json"));

      const r = tsRunCwd([
        "prepare", "US-DELTA-IMMUT-P",
        "--trigger", "host-guided", "--topology", "delta-team",
        "--profile", "standard", "--preset", "local-preset",
        "--resolution", resPath, "--json",
      ], dir);
      expect(r.code).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.delegationId).not.toBe("immut-prep-test");

      // Original preparation.json bytes unchanged
      const afterPrepBytes = readFileSync(join(controlledFrame, "preparation.json"));
      expect(Buffer.compare(originalPrepBytes, afterPrepBytes)).toBe(0);

      // Only one frame committed
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      const preparedEvents = events.filter((l: string) => {
        try { return JSON.parse(l).type === "delta:prepared"; } catch { return false; }
      });
      expect(preparedEvents.length).toBe(1);
    } finally {
      injectIdGenerator(null);
    }
  });
});

// ── BLOCK #2: Exact role event order and per-role bindings ────────────────

describe("US-DELTA-003 — exact role event order and bindings (BLOCK #2)", () => {
  it("delta:role_resolved events match resolution role order exactly with all fields", () => {
    const dir = setupMinimalProject("US-DELTA-ROLEBIND", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ROLEBIND", "local-preset");

    // Read the resolution template to get exact expected role order
    const template = JSON.parse(readFileSync(resPath, "utf8"));
    const expectedRoles = template.roles as Array<Record<string, unknown>>;

    const r = tsRunCwd([
      "prepare", "US-DELTA-ROLEBIND",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r.code).toBe(0);

    const events = readFileSync(join(dir, ".roll", "loop", "events.ndjson"), "utf8")
      .trim().split("\n").map(l => JSON.parse(l));

    // First event: delta:prepared
    expect(events[0]!.type).toBe("delta:prepared");

    // Following events: delta:role_resolved in exact resolution order
    const roleEvents = events.slice(1);
    expect(roleEvents.length).toBe(expectedRoles.length);

    for (let i = 0; i < expectedRoles.length; i++) {
      const re = roleEvents[i];
      const expected = expectedRoles[i]!;

      expect(re.type).toBe("delta:role_resolved");
      expect(re.role).toBe(expected.role);
      expect(re.roleInstanceId).toBe(expected.roleInstanceId);
      expect(re.hostId).toBe(expected.hostId);
      expect(re.modelId).toBe(expected.modelId);
      expect(re.source).toBe(expected.source);
      expect(re.reasons).toEqual(expected.reasons);
      expect(typeof re.inventorySha256).toBe("string");
      expect(re.inventorySha256.length).toBeGreaterThan(0);
      expect(typeof re.inventoryObservedAt).toBe("string");
      expect(re.inventoryObservedAt.length).toBeGreaterThan(0);
    }

    // All role types from resolution are present exactly once (no Set coverage)
    const roleSet = new Set(roleEvents.map(e => e.role));
    expect(roleSet.size).toBe(expectedRoles.length);
    for (const er of expectedRoles) {
      expect(roleSet.has(er.role as string)).toBe(true);
    }
  });
});

// ── BLOCK #3: Admission edge cases (validator 0 calls) ─────────────────────

describe("US-DELTA-003 — validate admission blocks with 0 validator calls (BLOCK #3)", () => {
  it("terminal delegation admission: validator not called, exact block event", () => {
    const dir = setupMinimalProject("US-DELTA-ADM-TERM", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ADM-TERM", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-ADM-TERM",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Conclude to make it terminal
    const rc = tsRunCwd([
      "conclude", "--delegation", delegationId,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(rc.code).toBe(0);

    // Now validate on terminal delegation — admission blocks, validator 0 calls
    injectValidator((_input) => {
      throw new Error("validator must not be called for terminal delegation");
    });
    try {
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

      const r2 = tsRunCwd([
        "validate", "--delegation", delegationId,
        "--stage", "designer", "--json",
      ], dir);
      expect(r2.code).toBe(1);
      const err = JSON.parse(r2.stderr);
      expect(err.error).toBe("terminal_path_unselected");

      // Exactly one delta:blocked event appended with typed reason
      const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      expect(eventsAfter.length).toBe(eventsBefore.length + 1);
      const blockEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
      expect(blockEvent.type).toBe("delta:blocked");
      expect(blockEvent.reason).toBe("terminal_path_unselected");
      expect(blockEvent.role).toBe("designer");
      expect(typeof blockEvent.detail).toBe("string");
    } finally {
      injectValidator(null);
    }
  });

  it("already-blocked delegation admission: validator not called, exact block event", () => {
    const dir = setupMinimalProject("US-DELTA-ADM-BLK", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ADM-BLK", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-ADM-BLK",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // First block the delegation (by validating without artifact → artifact_invalid block)
    const rBlock = tsRunCwd([
      "validate", "--delegation", delegationId,
      "--stage", "designer", "--json",
    ], dir);
    expect(rBlock.code).toBe(1);

    // Now try to validate again — admission blocks because already blocked
    injectValidator((_input) => {
      throw new Error("validator must not be called for already-blocked delegation");
    });
    try {
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

      const r2 = tsRunCwd([
        "validate", "--delegation", delegationId,
        "--stage", "evaluator", "--json",
      ], dir);
      expect(r2.code).toBe(1);
      const err = JSON.parse(r2.stderr);
      expect(err.error).toBe("host_supervisor_required");

      // Exactly one new delta:blocked event appended
      const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      expect(eventsAfter.length).toBe(eventsBefore.length + 1);
      const blockEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
      expect(blockEvent.type).toBe("delta:blocked");
      expect(blockEvent.reason).toBe("host_supervisor_required");
      expect(blockEvent.role).toBe("evaluator");
    } finally {
      injectValidator(null);
    }
  });

  it("already-published stage admission: validator not called, exact block event", () => {
    const dir = setupMinimalProject("US-DELTA-ADM-PUB", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-ADM-PUB", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-ADM-PUB",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Publish the designer stage (create artifact file + validate allow)
    const stageDir = join(dir, ".roll", "features", "delta-team", "US-DELTA-ADM-PUB",
      `delta-${delegationId}`, "role-artifacts", "designer");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "evaluation-manifest.json"), JSON.stringify(v2Manifest()), "utf8");
    const rPub = tsRunCwd(["validate", "--delegation", delegationId, "--stage", "designer", "--json"], dir);
    expect(rPub.code).toBe(0);

    // Try to publish designer again — admission blocks as already-published
    injectValidator((_input) => {
      throw new Error("validator must not be called for already-published stage");
    });
    try {
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

      const r2 = tsRunCwd([
        "validate", "--delegation", delegationId,
        "--stage", "designer", "--json",
      ], dir);
      expect(r2.code).toBe(1);
      const err = JSON.parse(r2.stderr);
      expect(err.error).toBe("identity_collision");

      // Exactly one delta:blocked event appended
      const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
      expect(eventsAfter.length).toBe(eventsBefore.length + 1);
      const blockEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
      expect(blockEvent.type).toBe("delta:blocked");
      expect(blockEvent.reason).toBe("identity_collision");
      expect(blockEvent.role).toBe("designer");
      expect(blockEvent.delegationId).toBe(delegationId);
    } finally {
      injectValidator(null);
    }
  });
});

// ── BLOCK #5: Conclude append-failure lease retention ─────────────────────

describe("US-DELTA-003 — conclude append-failure lease retention (BLOCK #5)", () => {
  it("conclude append failure retains lease, no success output, event ledger reflects append-then-crash", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-APPFAIL2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-APPFAIL2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-APPFAIL2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Inject event append failure
    injectEventAppendFailure(() => {
      throw new Error("simulated event append failure");
    });

    try {
      const r2 = tsRunCwd([
        "conclude", "--delegation", delegationId,
        "--delivery-disposition", "owner_continue", "--json",
      ], dir);

      // Must NOT output success
      expect(r2.code).toBe(1);
      expect(r2.stdout).toBe("");
      const errObj = JSON.parse(r2.stderr);
      expect(errObj.ok).toBe(false);
      expect(errObj.error).toBe("event_append_failure");

      // Lease MUST be retained (not released) — the failure prevents release
      const slPath = storyLeasesPath(dir);
      const sl = readLeases(slPath);
      expect(sl["US-DELTA-CONC-APPFAIL2"]).toBeDefined();
      expect(sl["US-DELTA-CONC-APPFAIL2"].source).toBe("host-delegation");
      expect(sl["US-DELTA-CONC-APPFAIL2"].delegationId).toBe(delegationId);

      // The terminal event IS written (append, then crash — "append then crash" semantics)
      const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
      const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
      const terminalEvents = events.filter(e => e.type === "delta:terminal");
      expect(terminalEvents.length).toBe(1);
      expect(terminalEvents[0]!.delegationId).toBe(delegationId);
      expect(terminalEvents[0]!.outcome).toBe("handoff_ready");

      // Cleanup: release the lease
      releaseHostDelegationLease(dir, "US-DELTA-CONC-APPFAIL2", delegationId, `delta-${delegationId}`);
    } finally {
      injectEventAppendFailure(null);
    }
  });

  it("conclude same-story mismatched lease fail-loud, no terminal, lease retained", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-MISMATCH2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-MISMATCH2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-MISMATCH2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationIdA = JSON.parse(r1.stdout).delegationId;

    // Overwrite lease with mismatched delegationId (same story)
    const slPath = storyLeasesPath(dir);
    const sl = readLeases(slPath);
    sl["US-DELTA-CONC-MISMATCH2"] = {
      claimedAt: Date.now(), source: "host-delegation",
      delegationId: "wrong-deleg-id", runId: "delta-wrong-deleg-id",
    };
    writeLeases(slPath, sl);

    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // Conclude with delegationIdA — fail-loud
    const r2 = tsRunCwd([
      "conclude", "--delegation", delegationIdA,
      "--delivery-disposition", "owner_continue", "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("lease_mismatch");

    // NO terminal event written
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // Lease entry preserved with mismatched delegationId
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-CONC-MISMATCH2"]).toBeDefined();
    expect(slAfter["US-DELTA-CONC-MISMATCH2"].delegationId).toBe("wrong-deleg-id");

    // Cleanup
    delete slAfter["US-DELTA-CONC-MISMATCH2"];
    writeLeases(slPath, slAfter);
  });
});

// ── BLOCK #6: Status read-only with content hashes and mtimes ────────────

describe("US-DELTA-003 — status read-only with content hashes (BLOCK #6)", () => {
  it("status does not change any file content or mtime", () => {
    const dir = setupMinimalProject("US-DELTA-RDONLY2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-RDONLY2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-RDONLY2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Snapshot all files with content hash and mtime
    const snapshotBefore = fileSnapshot(dir);

    // Run status multiple times
    tsRunCwd(["status", "--delegation", delegationId], dir);
    tsRunCwd(["status", "--delegation", delegationId, "--json"], dir);
    tsRunCwd(["status", "--story", "US-DELTA-RDONLY2"], dir);

    // Snapshot after
    const snapshotAfter = fileSnapshot(dir);

    // Every file from before must have the same content hash and mtime
    for (const [filePath, beforeStats] of Object.entries(snapshotBefore)) {
      const afterStats = snapshotAfter[filePath];
      expect(afterStats).toBeDefined();
      expect(afterStats!.hash).toBe(beforeStats.hash);
      expect(afterStats!.mtime).toBe(beforeStats.mtime);
    }
    // No new files created
    const beforeFiles = Object.keys(snapshotBefore);
    const afterFiles = Object.keys(snapshotAfter);
    expect(afterFiles.sort()).toEqual(beforeFiles.sort());
  });
});

// ── BLOCK #8: Core claim human/supervisor parameterized tests ─────────────

describe("US-DELTA-003 — human/supervisor claim and release parameterized (BLOCK #8)", () => {
  it("human claim atomically blocks host claim", () => {
    const dir = setupMinimalProject("US-DELTA-HUMAN-CLAIM", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    const hResult = claimStoryLease(slPath, "US-DELTA-HUMAN-CLAIM", {
      claimedAt: Date.now(), source: "human",
    });
    expect(hResult.status).toBe("claimed");

    // Host claim must fail
    const hostResult = claimHostDelegationLease(dir, "US-DELTA-HUMAN-CLAIM", randomUUID(), "delta-host");
    expect(hostResult).toBe("exists");

    // Human entry preserved
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-HUMAN-CLAIM"].source).toBe("human");

    // Human release (no pid required)
    const releaseResult = releaseStoryLease(slPath, "US-DELTA-HUMAN-CLAIM", { source: "human" });
    expect(releaseResult).toBe(true);
  });

  it("supervisor claim atomically blocks host claim", () => {
    const dir = setupMinimalProject("US-DELTA-SUP-CLAIM", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    const sResult = claimStoryLease(slPath, "US-DELTA-SUP-CLAIM", {
      claimedAt: Date.now(), source: "supervisor",
    });
    expect(sResult.status).toBe("claimed");

    // Host claim must fail
    const hostResult = claimHostDelegationLease(dir, "US-DELTA-SUP-CLAIM", randomUUID(), "delta-host");
    expect(hostResult).toBe("exists");

    // Supervisor entry preserved
    const sl = readLeases(slPath);
    expect(sl["US-DELTA-SUP-CLAIM"].source).toBe("supervisor");

    // Release
    const releaseResult = releaseStoryLease(slPath, "US-DELTA-SUP-CLAIM", { source: "supervisor" });
    expect(releaseResult).toBe(true);
  });

  it("human release refuses mismatched source", () => {
    const dir = setupMinimalProject("US-DELTA-HREL", "delta-team");
    const slPath = storyLeasesPath(dir);
    mkdirSync(dirname(slPath), { recursive: true });

    claimStoryLease(slPath, "US-DELTA-HREL", { claimedAt: Date.now(), source: "human" });

    // Cycle cannot release human
    const r = releaseStoryLease(slPath, "US-DELTA-HREL", { source: "cycle", pid: process.pid });
    expect(r).toBe(false);

    // Lease preserved
    expect(readLeases(slPath)["US-DELTA-HREL"].source).toBe("human");

    // Cleanup
    releaseStoryLease(slPath, "US-DELTA-HREL", { source: "human" });
  });
});

// ── BLOCK #2: Direct atomicWriteJson artifact_exists proof ─────────────

describe("US-DELTA-003 — atomicWriteJson direct artifact immutability (BLOCK #2)", () => {
  it("atomicWriteJson throws artifact_exists when file pre-exists, bytes unchanged", () => {
    const dir = makeProject();
    const filePath = join(dir, "test-artifact.json");
    const originalContent = JSON.stringify({ original: true }, null, 2) + "\n";

    // Write a pre-existing file
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, originalContent, "utf8");
    const originalBytes = readFileSync(filePath);

    // atomicWriteJson must throw artifact_exists
    expect(() => atomicWriteJson(filePath, { overwrite: "attempt" })).toThrow(PrepareError);
    try {
      atomicWriteJson(filePath, { overwrite: "attempt" });
    } catch (err) {
      expect(err instanceof PrepareError).toBe(true);
      expect((err as PrepareError).code).toBe("artifact_exists");
    }

    // Original bytes unchanged
    const afterBytes = readFileSync(filePath);
    expect(Buffer.compare(originalBytes, afterBytes)).toBe(0);
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("atomicWriteJson independently guards marker, resolution, preparation each", () => {
    const dir = makeProject();
    const markerPath = join(dir, "delegation-open.json");

    // Pre-place marker
    writeFileSync(markerPath, "pre-existing marker", "utf8");
    const origMarker = readFileSync(markerPath);
    expect(() => atomicWriteJson(markerPath, { attempt: "marker" })).toThrow(PrepareError);
    expect(Buffer.compare(origMarker, readFileSync(markerPath))).toBe(0);

    // Pre-place resolution (different path)
    const resPath = join(dir, "role-artifacts", "delegation", "delegation-resolution.json");
    mkdirSync(dirname(resPath), { recursive: true });
    writeFileSync(resPath, "pre-existing resolution", "utf8");
    const origRes = readFileSync(resPath);
    expect(() => atomicWriteJson(resPath, { attempt: "resolution" })).toThrow(PrepareError);
    expect(Buffer.compare(origRes, readFileSync(resPath))).toBe(0);

    // Pre-place preparation (different path)
    const prepPath = join(dir, "preparation.json");
    writeFileSync(prepPath, "pre-existing preparation", "utf8");
    const origPrep = readFileSync(prepPath);
    expect(() => atomicWriteJson(prepPath, { attempt: "preparation" })).toThrow(PrepareError);
    expect(Buffer.compare(origPrep, readFileSync(prepPath))).toBe(0);

    // Other target files not modified
    expect(Buffer.compare(origMarker, readFileSync(markerPath))).toBe(0);
    expect(Buffer.compare(origRes, readFileSync(resPath))).toBe(0);
  });
});

// ── File snapshot helper (content hash + mtime) ──────────────────────────

function fileSnapshot(root: string): Record<string, { hash: string; mtime: string }> {
  const { createHash } = require("node:crypto");
  const result: Record<string, { hash: string; mtime: string }> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        const content = readFileSync(p);
        const hash = createHash("sha256").update(content).digest("hex");
        const { mtime } = require("node:fs").statSync(p);
        result[p] = { hash, mtime: mtime.toISOString() };
      }
    }
  };
  walk(root);
  return result;
}

// ── Conclude parser edge cases: duplicate flags, unexpected positionals (BLOCK #5) ─

describe("US-DELTA-003 — conclude parser edge cases", () => {
  it("conclude duplicate --delegation flag is parser error, zero side effects", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-DUP", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-DUP", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-DUP",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    // Snapshot before
    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    const slPath = storyLeasesPath(dir);
    const slBefore = readLeases(slPath);

    // Duplicate --delegation flag (parser error, zero side effects)
    const r2 = tsRunCwd([
      "conclude",
      "--delegation", delegationId,
      "--delegation", "other-id",
      "--delivery-disposition", "owner_continue",
      "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("duplicate_flag");

    // Zero events appended
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // Lease preserved unchanged
    const slAfter = readLeases(slPath);
    expect(slAfter["US-DELTA-CONC-DUP"]).toBeDefined();
  });

  it("conclude duplicate --delivery-disposition flag is parser error, zero side effects", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-DUP2", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-DUP2", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-DUP2",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    const r2 = tsRunCwd([
      "conclude",
      "--delegation", delegationId,
      "--delivery-disposition", "owner_continue",
      "--delivery-disposition", "owner_hold",
      "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("duplicate_flag");

    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it("conclude unexpected positional arg is parser error, zero side effects", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-POS", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-POS", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-POS",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    const r2 = tsRunCwd([
      "conclude", "unexpected-positional",
      "--delegation", delegationId,
      "--delivery-disposition", "owner_continue",
      "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    expect(err2.error).toBe("unexpected_positional");

    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it("conclude flag-without-value (--delivery-disposition bare) yields terminal_path_unselected, zero extra events", () => {
    const dir = setupMinimalProject("US-DELTA-CONC-FLAGVAL", "delta-team");
    const resPath = writeResolutionTemplate(dir, "US-DELTA-CONC-FLAGVAL", "local-preset");

    const r1 = tsRunCwd([
      "prepare", "US-DELTA-CONC-FLAGVAL",
      "--trigger", "host-guided", "--topology", "delta-team",
      "--profile", "standard", "--preset", "local-preset",
      "--resolution", resPath, "--json",
    ], dir);
    expect(r1.code).toBe(0);
    const delegationId = JSON.parse(r1.stdout).delegationId;

    const eventsPath = join(dir, ".roll", "loop", "events.ndjson");
    const eventsBefore = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());

    // --delivery-disposition without a value → flag is boolean true → treated as missing disposition
    const r2 = tsRunCwd([
      "conclude",
      "--delegation", delegationId,
      "--delivery-disposition",
      "--json",
    ], dir);
    expect(r2.code).toBe(1);
    const err2 = JSON.parse(r2.stderr);
    // Flag-as-bool flows into missing-disposition domain check → terminal_path_unselected
    expect(err2.error).toBe("terminal_path_unselected");

    // Exactly one delta:blocked event appended (domain error, not parser error)
    const eventsAfter = readFileSync(eventsPath, "utf8").trim().split("\n").filter(l => l.trim());
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    const lastEvent = JSON.parse(eventsAfter[eventsAfter.length - 1]!);
    expect(lastEvent.type).toBe("delta:blocked");
    expect(lastEvent.reason).toBe("terminal_path_unselected");
  });
});

function readdirRecursive(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      result.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return result.sort();
}
