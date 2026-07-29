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
    // The daemon signature is: detached AND abandoned (unref) AND re-entering Roll's
    // own runner, so the process outlives the command that started it. That is what
    // US-LOOP-107's fallback did.
    //
    // codex review r1: scan the WHOLE file per spawn rather than a fixed window (an
    // unref can sit far from the spawn), and match `unref` in any call shape
    // (`child.unref()`, `child.unref?.()`, `.unref!()`).
    const offenders: string[] = [];
    for (const f of ALL_SRC) {
      const src = readFileSync(f, "utf8");
      if (!/detached:\s*true/.test(src)) continue;
      const abandonedAnywhere = /\.unref\s*[?!]?\s*(?:\.\s*call\s*)?\(/.test(src);
      if (!abandonedAnywhere) continue;
      // Re-entry is judged from the spawned ARGV, never from prose or a filename
      // (the first version self-incriminated via `loop-run-once.ts`).
      const reenters = /["'`]loop["'`]\s*,\s*["'`]run-once["'`]/.test(src);
      if (reenters) offenders.push(f.replace(PKG, ""));
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
