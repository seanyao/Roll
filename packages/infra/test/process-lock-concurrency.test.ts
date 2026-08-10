/**
 * FIX-365 — deterministic reproduction + fix verification for the inner-lock
 * TOCTOU race.
 *
 * Root cause (pre-fix): `acquireLock` was read-check-then-write NON-atomic.
 * Two concurrent run-once could BOTH pass the `existsSync`/`isLockHeld` check
 * (the file did not yet exist) and BOTH `writeFileSync` their own pid:ts → two
 * cycles ran on the same card (observed 2026-06-19: cycles 96943 + 42451 both
 * doing FIX-364).
 *
 * Fix: acquire is a single atomic action — `mkdir(lockDir)`. The first `mkdir`
 * wins; the second gets `EEXIST` and yields. There is no read-check-then-write
 * window to interleave through.
 *
 * These tests inject clock + pid + a liveness probe so the verdicts are
 * deterministic (no reliance on real wall-clock or real pids beyond the
 * spawned dead-pid helper).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock, INNER_LOCK_STALE_SEC, readLockOwner, releaseLock } from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) spawnSync("rm", ["-rf", d]);
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-fix365-"));
  dirs.push(d);
  return d;
}
/** A pid that is guaranteed dead (a child spawned then exited). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return r.pid ?? 999999999;
}

describe("FIX-365 atomic inner-lock — concurrency", () => {
  it("two concurrent acquires on the SAME lock: exactly one acquires, the other yields to the live holder", () => {
    const d = tmp();
    const lock = join(d, "loop", "inner.lock");
    const liveAlways = () => true; // both pids modeled alive

    // Both racers evaluate their "is it held?" decision against the SAME initial
    // empty state (the TOCTOU window). With the non-atomic implementation BOTH
    // would have proceeded to write. The atomic mkdir makes the second EEXIST.
    const first = acquireLock(lock, 1001, {
      now: () => 1000,
      staleSec: INNER_LOCK_STALE_SEC,
      pidAlive: liveAlways,
      cycleId: "cycleA",
    });
    const second = acquireLock(lock, 2002, {
      now: () => 1000,
      staleSec: INNER_LOCK_STALE_SEC,
      pidAlive: liveAlways,
      cycleId: "cycleB",
    });

    const acquiredCount = [first, second].filter((r) => r.acquired).length;
    expect(acquiredCount).toBe(1); // never both — this is the bug the fix kills
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.heldByPid).toBe(1001); // the later one yields to the live holder

    // The on-disk owner is the FIRST winner.
    const owner = readLockOwner(lock);
    expect(owner?.pid).toBe(1001);
    expect(owner?.cycleId).toBe("cycleA");
  });

  it("a live holder makes EVERY later acquire yield (single-flight)", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    const liveAlways = () => true;
    expect(acquireLock(lock, 1, { now: () => 1, pidAlive: liveAlways }).acquired).toBe(true);
    for (let i = 2; i <= 5; i++) {
      const r = acquireLock(lock, i, { now: () => 1 + i, pidAlive: liveAlways });
      expect(r.acquired).toBe(false);
      expect(r.heldByPid).toBe(1);
    }
  });

  it("lock is a DIRECTORY (atomic mkdir), not a plain file", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    acquireLock(lock, 42, { now: () => 1, pidAlive: () => true });
    expect(statSync(lock).isDirectory()).toBe(true);
    // metadata carries pid/hostname/startedAt/cycleId
    const owner = readLockOwner(lock);
    expect(owner?.pid).toBe(42);
    expect(owner?.hostname).toBe(hostname());
    expect(typeof owner?.startedAt).toBe("number");
  });
});

describe("FIX-365 atomic inner-lock — conservative stale cleanup", () => {
  it("same-host dead pid → auto-clears and is re-acquired", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    const dead = deadPid();
    // Holder: this host, a dead pid.
    acquireLock(lock, dead, { now: () => 1000, pidAlive: () => false });
    const r = acquireLock(lock, 7777, { now: () => 1050, pidAlive: () => false });
    expect(r.acquired).toBe(true);
    expect(readLockOwner(lock)?.pid).toBe(7777);
  });

  it("cross-host holder → fail-loud, NEVER force-stolen (even if its pid looks dead locally)", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    // Plant a holder claiming a DIFFERENT host. A local kill -0 of its pid is
    // meaningless across hosts, so we must NOT clear it.
    acquireLock(lock, 4242, {
      now: () => 1000,
      pidAlive: () => true,
      hostname: "other-box.example.com",
    });
    const r = acquireLock(lock, 8888, {
      now: () => 1000,
      pidAlive: () => false, // local probe says "dead" — but it's another host!
      hostname: hostname(),
    });
    expect(r.acquired).toBe(false); // fail-loud, do not steal
    expect(r.heldByPid).toBe(4242);
    expect(readLockOwner(lock)?.pid).toBe(4242); // untouched
  });

  it("same-host LIVE pid → held (not stolen)", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    acquireLock(lock, process.pid, { now: () => 1000, pidAlive: () => true });
    const r = acquireLock(lock, 9999, { now: () => 1100, pidAlive: () => true });
    expect(r.acquired).toBe(false);
    expect(r.heldByPid).toBe(process.pid);
  });

  it("releaseLock removes the directory idempotently (finally-safe, decoupled from outcome)", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    acquireLock(lock, 1, { now: () => 1, pidAlive: () => true });
    expect(existsSync(lock)).toBe(true);
    releaseLock(lock);
    expect(existsSync(lock)).toBe(false);
    releaseLock(lock); // no throw when already absent
    expect(existsSync(lock)).toBe(false);
  });

  it("long cycle (>30min) is still serialized: a fresh, live, same-host holder is NEVER stolen within the stale window", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    acquireLock(lock, process.pid, { now: () => 0, pidAlive: () => true, cycleId: "long" });
    // 31 minutes later, a scheduled tick tries to acquire — must yield.
    const r = acquireLock(lock, 5555, {
      now: () => 31 * 60,
      staleSec: INNER_LOCK_STALE_SEC,
      pidAlive: () => true,
    });
    expect(r.acquired).toBe(false);
    expect(r.heldByPid).toBe(process.pid);
  });
});

describe("FIX-365 — legacy pid:ts file lock honored across upgrade", () => {
  it("a live legacy file lock is NOT taken over (in-flight v2/old-v3 cycle keeps the floor)", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    writeFileSync(lock, `${process.pid}:1000\n`, "utf8"); // legacy shape, alive
    const r = acquireLock(lock, 7777, { now: () => 1100, staleSec: INNER_LOCK_STALE_SEC, pidAlive: () => true });
    expect(r.acquired).toBe(false);
    expect(r.heldByPid).toBe(process.pid);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}:1000\n`); // untouched
  });

  it("a stale legacy file lock (dead pid) is cleared and re-acquired as a directory", () => {
    const d = tmp();
    const lock = join(d, "inner.lock");
    writeFileSync(lock, `${deadPid()}:1000\n`, "utf8");
    const r = acquireLock(lock, 4242, { now: () => 1050, pidAlive: () => false });
    expect(r.acquired).toBe(true);
    expect(statSync(lock).isDirectory()).toBe(true);
    expect(readLockOwner(lock)?.pid).toBe(4242);
  });
});
