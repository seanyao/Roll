/**
 * FIX-298 — the shared network guard (first-checkpoint connectivity + ACTIVE
 * recovery). Tests cover the owner-design flow:
 *   - blocked + no hook configured            → HALT with an actionable reason.
 *   - blocked + configured hook that reconnects → run it, re-check, CONTINUE.
 *   - blocked + configured hook that does NOT  → HALT (still down after the hook).
 *   - reachable                                → proceed, no hook run.
 * plus the probe semantics, the policy-hook reader, the `networkNeeds` model,
 * and the bridge wiring (a non-network command — `roll status` — is NOT gated).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  networkNeeds,
  networkReachable,
  parseProbeTarget,
  readLoopSafetyNet,
  readProxyEnableCmd,
  requireNetwork,
} from "../src/lib/require-network.js";

function tmpRepo(tag: string, policy?: string): string {
  const d = mkdtempSync(join(tmpdir(), `roll-net-${tag}-`));
  if (policy !== undefined) {
    mkdirSync(join(d, ".roll"), { recursive: true });
    writeFileSync(join(d, ".roll", "policy.yaml"), policy, "utf8");
  }
  return d;
}

describe("FIX-298 networkReachable — the single connectivity probe", () => {
  it("DNS ok + TCP ok → reachable", async () => {
    expect(
      await networkReachable({
        resolve: () => Promise.resolve([{ address: "140.82.113.4" }]),
        tcpProbe: () => Promise.resolve(),
      }),
    ).toBe(true);
  });

  it("DNS ok + TCP fails (proxy-poison signature) → unreachable", async () => {
    expect(
      await networkReachable({
        resolve: () => Promise.resolve([{ address: "140.82.113.4" }]),
        tcpProbe: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    ).toBe(false);
  });

  it("DNS fails (offline) → unreachable", async () => {
    expect(
      await networkReachable({
        resolve: () => Promise.reject(new Error("ENOTFOUND")),
        tcpProbe: () => Promise.resolve(),
      }),
    ).toBe(false);
  });

  it("hung resolver → DNS timeout → unreachable, and the probe never stalls", async () => {
    const start = Date.now();
    expect(
      await networkReachable({
        resolve: () => new Promise(() => {}),
        tcpProbe: () => Promise.resolve(),
      }),
    ).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("FIX-298 readProxyEnableCmd — the configurable, NON-hardcoded hook", () => {
  it("reads loop_safety.proxy_enable_cmd from .roll/policy.yaml", () => {
    const repo = tmpRepo("hook", "loop_safety:\n  proxy_enable_cmd: proxy rule\n");
    expect(readProxyEnableCmd(repo)).toBe("proxy rule");
  });

  it("no policy file / no key → undefined (nothing hardcoded)", () => {
    expect(readProxyEnableCmd(tmpRepo("nohook"))).toBeUndefined();
    expect(readProxyEnableCmd(tmpRepo("emptysafety", "loop_safety:\n  peer_gate: soft\n"))).toBeUndefined();
  });
});

describe("FIX-298 requireNetwork — first checkpoint + active recovery", () => {
  it("reachable → proceeds, no hook run, no halt lines", async () => {
    const emitted: string[] = [];
    let ran = false;
    const r = await requireNetwork("roll loop go", "/tmp/repo", {
      reachable: () => Promise.resolve(true),
      proxyEnableCmd: () => "proxy rule",
      runProxyEnable: () => ((ran = true), true),
      emit: (l) => emitted.push(l),
      lang: "en",
    });
    expect(r.ok).toBe(true);
    expect(r.recovered).toBe(false);
    expect(ran).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("blocked + NO hook configured → HALT with an actionable bilingual reason", async () => {
    const emitted: string[] = [];
    const r = await requireNetwork("roll loop go", "/tmp/repo", {
      reachable: () => Promise.resolve(false),
      proxyEnableCmd: () => undefined, // nothing configured
      emit: (l) => emitted.push(l),
      lang: "en",
    });
    expect(r.ok).toBe(false);
    expect(r.recovered).toBe(false);
    // names the command, tells the user how to configure a proxy-enable command.
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toContain("roll loop go");
    expect(emitted[0]).toContain("loop_safety.proxy_enable_cmd");
  });

  it("blocked + configured hook that makes the network reachable → run it, re-check, CONTINUE", async () => {
    const emitted: string[] = [];
    const calls: string[] = [];
    let reachableCalls = 0;
    const r = await requireNetwork("roll loop go", "/tmp/repo", {
      // first probe: down; after the hook runs: up.
      reachable: () => Promise.resolve(reachableCalls++ > 0),
      proxyEnableCmd: () => "proxy rule",
      runProxyEnable: (cmd) => (calls.push(cmd), true),
      emit: (l) => emitted.push(l),
      lang: "en",
    });
    expect(r.ok).toBe(true);
    expect(r.recovered).toBe(true);
    expect(calls).toEqual(["proxy rule"]); // ran exactly the CONFIGURED command
    expect(reachableCalls).toBe(2); // probed, then RE-probed after recovery
    // announces recovery start + success; no halt line.
    expect(emitted.join("\n")).toContain("running the configured proxy-enable command");
    expect(emitted.join("\n")).toContain("network restored");
  });

  it("blocked + configured hook that does NOT reconnect → HALT (still down after the hook)", async () => {
    const emitted: string[] = [];
    const r = await requireNetwork("roll update", "/tmp/repo", {
      reachable: () => Promise.resolve(false), // never comes back
      proxyEnableCmd: () => "proxy rule",
      runProxyEnable: () => true,
      emit: (l) => emitted.push(l),
      lang: "en",
    });
    expect(r.ok).toBe(false);
    expect(r.recovered).toBe(true);
    const joined = emitted.join("\n");
    expect(joined).toContain("running the configured proxy-enable command");
    expect(joined).toContain("STILL failed");
    expect(joined).toContain("roll update");
  });

  it("emits zh lines when lang is zh (single-language, never inline-mixed)", async () => {
    const emitted: string[] = [];
    await requireNetwork("roll loop go", "/tmp/repo", {
      reachable: () => Promise.resolve(false),
      proxyEnableCmd: () => undefined,
      emit: (l) => emitted.push(l),
      lang: "zh",
    });
    expect(emitted[0]).toContain("需要网络");
    expect(emitted[0]).not.toMatch(/[A-Za-z]{4,} needs the network/); // not the EN line
  });

  it("reads the hook from the given repo's policy by default (end-to-end, no injected hook)", async () => {
    const repo = tmpRepo("e2e", "loop_safety:\n  proxy_enable_cmd: my-proxy-on\n");
    const calls: string[] = [];
    let reachableCalls = 0;
    const r = await requireNetwork("roll showcase", repo, {
      reachable: () => Promise.resolve(reachableCalls++ > 0),
      runProxyEnable: (cmd) => (calls.push(cmd), true),
      emit: () => {},
      lang: "en",
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["my-proxy-on"]); // pulled from policy.yaml, not hardcoded
  });
});

describe("FIX-298 networkNeeds — the ONE declarative model of which commands need network", () => {
  it("gates the agent-spawning / PR commands", () => {
    expect(networkNeeds("context", ["read", "--workspace", "roll", "--stage", "qa"])).toBe("roll context read");
    expect(networkNeeds("update", [])).toBe("roll update");
    expect(networkNeeds("showcase", [])).toBe("roll showcase");
    expect(networkNeeds("showcase", ["--json"])).toBe("roll showcase");
    expect(networkNeeds("loop", ["go"])).toBe("roll loop go");
    expect(networkNeeds("loop", ["now"])).toBe("roll loop now");
    expect(networkNeeds("release", [])).toBe("roll release");
  });

  it("does NOT gate a non-network command (roll status)", () => {
    expect(networkNeeds("context", ["status", "--workspace", "roll"])).toBeNull();
    expect(networkNeeds("status", [])).toBeNull();
    expect(networkNeeds("backlog", [])).toBeNull();
    expect(networkNeeds("config", ["loop_safety.proxy_enable_cmd"])).toBeNull();
  });

  it("never gates a cry for help", () => {
    expect(networkNeeds("context", ["read", "--help"])).toBeNull();
    expect(networkNeeds("update", ["--help"])).toBeNull();
    expect(networkNeeds("update", ["-h"])).toBeNull();
    expect(networkNeeds("showcase", ["help"])).toBeNull();
    expect(networkNeeds("loop", ["go", "--help"])).toBeNull();
  });

  it("does NOT gate read-only / local loop subcommands", () => {
    for (const sub of ["status", "alert", "log", "events", "runs", "signals", "story", "eval", "reset", "mute"]) {
      expect(networkNeeds("loop", [sub])).toBeNull();
    }
  });

  it("US-LOOP-074: `loop watch` is local-only (tails live.log) → NOT network-gated", () => {
    expect(networkNeeds("loop", ["watch"])).toBeNull();
    expect(networkNeeds("loop", ["watch", "-n", "all"])).toBeNull();
    expect(networkNeeds("loop", ["watch", "--attach"])).toBeNull();
    expect(networkNeeds("loop", ["watch", "--verbose"])).toBeNull();
  });

  it("does NOT gate the release read-only / local routes", () => {
    expect(networkNeeds("release", ["--json"])).toBeNull();
    expect(networkNeeds("release", ["--gate-check"])).toBeNull();
    expect(networkNeeds("release", ["--dry-run"])).toBeNull();
    expect(networkNeeds("release", ["consistency"])).toBeNull();
    expect(networkNeeds("release", ["consistency", "check"])).toBeNull();
    // removed sub-routes (ship/waiver/changelog) exit with an error — not gated.
    for (const route of ["ship", "waiver", "changelog", "tag", "publish"]) {
      expect(networkNeeds("release", [route])).toBeNull();
    }
  });

  it("`loop run-once` is NOT centrally gated (it runs its own per-cycle guard)", () => {
    expect(networkNeeds("loop", ["run-once"])).toBeNull();
  });
});

describe("FIX-1025 parseProbeTarget — configurable probe destination", () => {
  it("parses bare host (defaults to 443)", () => {
    expect(parseProbeTarget("dashscope.aliyuncs.com")).toEqual({ host: "dashscope.aliyuncs.com", port: 443 });
  });
  it("parses host:port", () => {
    expect(parseProbeTarget("api.deepseek.com:8443")).toEqual({ host: "api.deepseek.com", port: 8443 });
  });
  it("parses a full https URL (drops scheme + path)", () => {
    expect(parseProbeTarget("https://api.deepseek.com/v1/chat")).toEqual({ host: "api.deepseek.com", port: 443 });
  });
  it("http:// URL defaults to port 80", () => {
    expect(parseProbeTarget("http://localhost")).toEqual({ host: "localhost", port: 80 });
  });
  it("empty / unparseable → undefined (caller falls back to default)", () => {
    expect(parseProbeTarget("")).toBeUndefined();
    expect(parseProbeTarget("  ")).toBeUndefined();
    expect(parseProbeTarget("host:abc")).toBeUndefined();
    expect(parseProbeTarget("host:0")).toBeUndefined();
  });
});

describe("FIX-1025 networkReachable — probe target honors probe_url", () => {
  it("resolves the CONFIGURED host (not the fixed default) when probe_url is set", async () => {
    const seen: string[] = [];
    const ok = await networkReachable({
      probeUrl: "api.deepseek.com",
      resolve: (h) => (seen.push(h), Promise.resolve([{ address: "1.2.3.4" }])),
      tcpProbe: () => Promise.resolve(),
    });
    expect(ok).toBe(true);
    expect(seen).toEqual(["api.deepseek.com"]); // probed the configured host
  });
});

describe("FIX-1025 readLoopSafetyNet — probe_url + skip_network_check", () => {
  it("reads probe_url and skip_network_check from policy.yaml", () => {
    const repo = tmpRepo(
      "ls",
      "loop_safety:\n  probe_url: api.deepseek.com:443\n  skip_network_check: true\n",
    );
    const ls = readLoopSafetyNet(repo);
    expect(ls.probeUrl).toBe("api.deepseek.com:443");
    expect(ls.skipNetworkCheck).toBe(true);
  });
  it("absent file / keys → empty (skip off)", () => {
    const ls = readLoopSafetyNet(tmpRepo("ls-none"));
    expect(ls.probeUrl).toBeUndefined();
    expect(ls.skipNetworkCheck).toBe(false);
  });
});

describe("FIX-1025 requireNetwork — opt-out + configured-target probing", () => {
  it("skip_network_check: true → proceeds WITHOUT probing, no halt", async () => {
    let probed = false;
    const emitted: string[] = [];
    const r = await requireNetwork("roll release", "/tmp/repo", {
      loopSafetyNet: () => ({ skipNetworkCheck: true }),
      reachable: () => ((probed = true), Promise.resolve(false)),
      emit: (l) => emitted.push(l),
      lang: "en",
    });
    expect(r.ok).toBe(true);
    expect(probed).toBe(false); // the probe was never run
    expect(emitted.join("\n")).toContain("network precheck skipped");
  });

  it("probe_url is threaded to the reachability probe (configured target reachable → continue)", async () => {
    const probeArgs: Array<string | undefined> = [];
    const r = await requireNetwork("roll loop go", "/tmp/repo", {
      loopSafetyNet: () => ({ probeUrl: "api.deepseek.com", skipNetworkCheck: false }),
      reachable: (probes) => (probeArgs.push(probes?.probeUrl), Promise.resolve(true)),
      emit: () => {},
      lang: "en",
    });
    expect(r.ok).toBe(true);
    expect(probeArgs).toEqual(["api.deepseek.com"]); // probed the CONFIGURED target
  });

  it("blocked + no hook → halt message names probe_url AND skip_network_check escape hatches", async () => {
    const emitted: string[] = [];
    const r = await requireNetwork("roll loop go", "/tmp/repo", {
      loopSafetyNet: () => ({ skipNetworkCheck: false }),
      reachable: () => Promise.resolve(false),
      emit: (l) => emitted.push(l),
      lang: "en",
    });
    expect(r.ok).toBe(false);
    expect(emitted[0]).toContain("loop_safety.probe_url");
    expect(emitted[0]).toContain("loop_safety.skip_network_check");
  });

  it("end-to-end: reads probe_url + skip from the repo's policy.yaml (no injected safety)", async () => {
    const repo = tmpRepo("e2e-skip", "loop_safety:\n  skip_network_check: true\n");
    let probed = false;
    const r = await requireNetwork("roll loop go", repo, {
      reachable: () => ((probed = true), Promise.resolve(false)),
      emit: () => {},
      lang: "en",
    });
    expect(r.ok).toBe(true);
    expect(probed).toBe(false);
  });
});
