/**
 * US-PORT-008 — `roll dream run-once` is the v3-native heart of the dream
 * service. These tests pin: fail-loud on a missing skill (no blind agent), the
 * agent is spawned in the PROJECT dir with the roll-.dream body, the machine log
 * captures start/end + streamed output, and the agent exit code propagates.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentSpawn, AgentSpawnOptions } from "../src/runner/agent-spawn.js";
import { type DreamRunOnceDeps, dreamRunOnceCommand } from "../src/commands/dream-run-once.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "roll-dream-")));
  dirs.push(d);
  return d;
}

function captureErr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture-only
  process.stderr.write = (c: string | Uint8Array): boolean => (chunks.push(String(c)), true);
  return fn()
    .then((code) => ({ code, err: chunks.join("") }))
    .finally(() => {
      process.stderr.write = real;
    });
}

interface Spy {
  spawn: AgentSpawn;
  calls: Array<{ agent: string; opts: AgentSpawnOptions }>;
}
function spySpawn(exitCode: number, emit = ""): Spy {
  const calls: Array<{ agent: string; opts: AgentSpawnOptions }> = [];
  return {
    calls,
    spawn: (agent, opts) => {
      calls.push({ agent, opts });
      if (emit !== "") opts.onChunk?.(Buffer.from(emit));
      return Promise.resolve({ stdout: emit, stderr: "", exitCode, timedOut: false });
    },
  };
}

function deps(proj: string, spawn: AgentSpawn, body: string | null): DreamRunOnceDeps {
  return {
    identity: () => Promise.resolve({ path: proj, slug: "proj-abc123" }),
    agent: () => "claude",
    skillBody: () => body,
    spawn,
    now: () => new Date("2026-06-06T03:12:00Z"),
    dreamReArm: () => Promise.resolve({ rearmed: false }),
    structureScan: () => Promise.resolve({
      json: {
        schema: "dream-structure.v1",
        generatedAt: "2026-06-06T03:12:00.000Z",
        projectRoot: proj,
        graphStats: { files: 1, symbols: 1, imports: 0, references: 0 },
        findings: [],
        suppressed: [],
        errors: [],
      },
      log: "## Code structure static analysis\n\nschema: dream-structure.v1\nfindings: 0\n",
    }),
  };
}

describe("roll dream run-once", () => {
  it("fails loud (exit 1, no spawn) when the roll-.dream skill body is missing", async () => {
    const proj = tmp();
    const spy = spySpawn(0);
    const { code, err } = await captureErr(() => dreamRunOnceCommand([], deps(proj, spy.spawn, null)));
    expect(code).toBe(1);
    expect(spy.calls).toHaveLength(0);
    expect(err).toContain("roll-.dream SKILL.md not found");
    expect(err).toContain("找不到 roll-.dream SKILL.md");
  });

  it("spawns the agent in the PROJECT dir with the dream body + logs start/end/output", async () => {
    const proj = tmp();
    const spy = spySpawn(0, "scanning...\n");
    const code = await dreamRunOnceCommand([], deps(proj, spy.spawn, "# Dream\n\nScan the code."));
    expect(code).toBe(0);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.agent).toBe("claude");
    expect(spy.calls[0]?.opts.cwd).toBe(proj); // in place — NOT a worktree
    expect(spy.calls[0]?.opts.skillBody).toContain("# Dream\n\nScan the code.");
    expect(spy.calls[0]?.opts.skillBody).toContain("Dream deterministic structure pre-scan");
    expect(spy.calls[0]?.opts.skillBody).toContain(".roll/dream/structure-scan.json");
    const log = readFileSync(join(proj, ".roll", "dream", "cron.log"), "utf8");
    expect(log).toContain("dream scan start (v3 run-once, agent=claude)");
    expect(log).toContain("dream structure pre-scan start");
    expect(log).toContain("schema: dream-structure.v1");
    expect(log).toContain("scanning...");
    expect(log).toContain("dream scan end rc=0");
    const artifact = JSON.parse(readFileSync(join(proj, ".roll", "dream", "structure-scan.json"), "utf8")) as {
      schema: string;
    };
    expect(artifact.schema).toBe("dream-structure.v1");
  });

  it("propagates the agent's non-zero exit code", async () => {
    const proj = tmp();
    const spy = spySpawn(2);
    const code = await dreamRunOnceCommand([], deps(proj, spy.spawn, "body"));
    expect(code).toBe(2);
    const log = readFileSync(join(proj, ".roll", "dream", "cron.log"), "utf8");
    expect(log).toContain("dream scan end rc=2");
  });

  it("returns 1 (no crash) when the spawn itself throws (e.g. unported agent)", async () => {
    const proj = tmp();
    const throwing: AgentSpawn = () => {
      throw new Error("agent 'kimi' argv not yet ported");
    };
    const { code, err } = await captureErr(() => dreamRunOnceCommand([], deps(proj, throwing, "body")));
    expect(code).toBe(1);
    expect(err).toContain("not yet ported");
  });

  it("does not run the structure pre-scan when the skill body is missing", async () => {
    const proj = tmp();
    const spy = spySpawn(0);
    const { code } = await captureErr(() => dreamRunOnceCommand([], deps(proj, spy.spawn, null)));

    expect(code).toBe(1);
    expect(existsSync(join(proj, ".roll", "dream", "structure-scan.json"))).toBe(false);
  });

  // US-LOOP-113 (codex review r5): the post-scan re-arm is DISARMED. It created and
  // loaded `com.roll.loop.<slug>`; with `roll loop off` removed, a dream scan that
  // arms a timer nobody can disarm is a one-way trap. These three tests asserted the
  // re-arm HAPPENS, so they are replaced by the inverse guarantee.
  it("US-LOOP-113: a successful dream scan never re-arms a scheduler", async () => {
    const proj = tmp();
    let rearmCalled = false;
    const spy = spySpawn(0, "scanning...\n");
    const testDeps = deps(proj, spy.spawn, "# Dream\n\nScan the code.");
    testDeps.dreamReArm = async () => {
      rearmCalled = true;
      return { rearmed: true, picked: "REFACTOR-DREAM-20260625-001" };
    };

    const code = await dreamRunOnceCommand([], testDeps);

    expect(code).toBe(0);
    expect(rearmCalled).toBe(false);
    const log = readFileSync(join(proj, ".roll", "dream", "cron.log"), "utf8");
    expect(log).not.toContain("dream re-arm");
  });

});
