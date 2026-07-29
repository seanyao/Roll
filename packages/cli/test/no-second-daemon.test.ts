/**
 * US-LOOP-116 — there is no second resident scheduler.
 *
 * US-LOOP-107 added a `detached` self-running process as a fallback for when
 * launchd bootstrap failed. Deleting only the plist layer would have left that
 * running under a different name — the daemon would survive the "daemonless"
 * refactor. This is the tripwire: no source file may spawn a detached scheduler,
 * and none of the fallback API may exist.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every .ts under a package's src/, recursively. */
function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(p);
    }
  };
  walk(root);
  return out;
}

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const ALL_SRC = ["cli", "core", "infra", "spec"].flatMap((p) => sources(join(PKG, p, "src")));

describe("US-LOOP-116 — the fallback scheduler is gone", () => {
  it("no source leaves a self-re-running process unattended", () => {
    // A detached spawn is not per se wrong: Roll legitimately detaches a tmux
    // session, a peer agent, `open`, and an MCP browser. `roll loop go` also spawns
    // `run-once` detached — but it AWAITS the child's exit, so it is a foreground
    // step of the session, not a daemon.
    //
    // The daemon signature is different: detached AND abandoned (`unref()`), so the
    // process outlives the command that started it. That is what US-LOOP-107's
    // fallback did, and it is what must never come back.
    const offenders: string[] = [];
    for (const f of ALL_SRC) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/detached:\s*true/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 14), i + 10).join("\n");
        const abandoned = /\.unref\(\)/.test(window);
        // Match the spawned ARGV, not prose: a self-re-entry passes "loop" plus
        // "run-once" as arguments. (An earlier version matched the words anywhere in
        // the window, so `spawn("open", …)` inside loop-run-once.ts self-incriminated
        // via its own filename.)
        const reentersRoll = /["'`]loop["'`]\s*,\s*["'`]run-once["'`]/.test(window) || /fallbackRunner/.test(window);
        if (abandoned && reentersRoll) offenders.push(`${f.replace(PKG, "")}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("none of the fallback API survives", () => {
    const banned = [
      "ProcessFallbackScheduler",
      "fallbackLeasePath",
      "fallbackHeartbeatPath",
      "evaluateFallbackLiveness",
      "computeFallbackCommandDigest",
      "readFallbackLease",
      "resolveFallbackConfig",
      "readFallbackHealthSync",
      "readFallbackHealthForProject",
      "decideBackend",
      "SchedulerBackendName",
      "FallbackRunnerConfig",
      "FallbackHealth",
    ];
    const hits: string[] = [];
    for (const f of ALL_SRC) {
      const src = readFileSync(f, "utf8");
      for (const name of banned) {
        // Skip the explanatory comments in this epic's own annotations.
        const re = new RegExp(`\\b${name}\\b`);
        // Only CODE counts — this epic's own comments explain what was removed.
        const codeHit = src
          .split("\n")
          .some((l) => re.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
        if (codeHit) hits.push(`${f.replace(PKG, "")}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("roll loop fallback is not a command", () => {
    const index = readFileSync(join(PKG, "cli", "src", "commands", "index.ts"), "utf8");
    expect(index).not.toMatch(/loopFallbackCommand/);
    expect(index).not.toMatch(/args\[0\] === "fallback"/);
  });
});
