/**
 * FIX-1486 — doctor must not report environment facts it cannot establish.
 *
 * Two independent misreads, both of which made `roll doctor` state something
 * untrue about a working machine:
 *
 *   1. The proxy probe shelled out to `timeout` — a binary macOS does not ship.
 *      Every probe exited 127, so EVERY set proxy variable was reported
 *      "unreachable" and the owner was told to `launchctl unsetenv` a proxy
 *      that was in fact serving traffic. A diagnostic that talks people into
 *      breaking their network is worse than no diagnostic.
 *   2. Agent detection printed one row per `ai_*` config key rather than per
 *      agent, so alias pairs (`ai_gemini`/`ai_agy` → agy, `ai_pi`/`ai_deepseek`
 *      → pi) each appeared twice.
 *
 * Both are asserted by SHAPE (probe verdict against a real socket, row set
 * against duplicate input) so a rewrite of either implementation stays covered.
 */
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { agentDetectionRows, tcpProbe } from "../src/commands/doctor.js";

const ROOT = resolve(__dirname, "../../..");

describe("FIX-1486 — tcpProbe reports real reachability", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  /** Bind an ephemeral listener and return its port. */
  async function listening(): Promise<number> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    return addr.port;
  }

  it("returns true for a port that is actually listening (AC1)", async () => {
    const port = await listening();
    // The regression: on macOS this returned false for EVERY port, because the
    // probe's `timeout` wrapper does not exist and the shell exited 127.
    expect(tcpProbe("127.0.0.1", port)).toBe(true);
  });

  it("returns false for a closed port, without hanging (AC2)", async () => {
    // Bind then immediately release, so the port is known-free rather than guessed.
    const server = createServer();
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const port = addr.port;
    await new Promise<void>((res) => server.close(() => res()));

    const started = Date.now();
    expect(tcpProbe("127.0.0.1", port, 2000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("does not depend on an external `timeout` binary (AC3)", () => {
    // Pinned at the source level: the probe's own timeout must come from the
    // spawn call, not from a coreutils binary that macOS lacks.
    const src = readFileSync(join(ROOT, "packages/cli/src/commands/doctor.ts"), "utf8");
    const probe = src.slice(src.indexOf("function tcpProbe"), src.indexOf("function parseProxyTarget"));
    expect(probe).not.toMatch(/(^|[^a-zA-Z_])timeout\s+\$?\{?[0-9A-Za-z.]/);
  });
});

describe("FIX-1486 — agent detection lists each agent once", () => {
  /** A config where two key pairs alias onto one canonical agent each. */
  const CONFIG = [
    "ai_claude: ~/.claude|CLAUDE.md|CLAUDE.md",
    "ai_gemini: ~/.gemini|GEMINI.md|GEMINI.md",
    "ai_kimi: ~/.kimi|AGENTS.md|AGENTS.md",
    "ai_codex: ~/.codex|AGENTS.md|AGENTS.md",
    "ai_pi: ~/.pi/agent|AGENTS.md|AGENTS.md",
    "ai_deepseek: ~/.deepseek|AGENTS.md|AGENTS.md",
    "ai_agy: ~/.gemini|GEMINI.md|GEMINI.md",
    "ai_reasonix: ~/.reasonix|AGENTS.md|AGENTS.md",
  ].join("\n");

  it("collapses alias keys onto one row per agent (AC4)", () => {
    const rows = agentDetectionRows(CONFIG, "/home/x", () => false, () => false);
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toContain("agy");
    expect(names).toContain("pi");
  });

  it("keeps the row whose config dir exists when keys collide (AC4)", () => {
    // `ai_pi` → ~/.pi/agent (present) and `ai_deepseek` → ~/.deepseek (absent):
    // the surviving row must be the one describing a directory that is there.
    const dirExists = (dir: string): boolean => dir.endsWith("/.pi/agent");
    const rows = agentDetectionRows(CONFIG, "/home/x", () => false, dirExists);
    const pi = rows.filter((r) => r.name === "pi");
    expect(pi).toHaveLength(1);
    expect(pi[0]?.dirExists).toBe(true);
  });
});

describe("FIX-1486 — agent runtime dirs are ignored", () => {
  it("gitignore covers every agent that writes into the repo (AC5)", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const dir of [".codex/", ".pi/", ".kimi/", ".kimi-code/", ".reasonix/"]) {
      expect(ignore, `.gitignore is missing ${dir}`).toMatch(new RegExp(`^${dir.replace(".", "\\.")}`, "m"));
    }
  });
});
