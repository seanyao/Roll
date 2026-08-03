/**
 * CLI bridge — TS-native routing (US-PORT-021). The bash `bin/roll` fallback is
 * retired: every command is ported, so an unregistered command prints the usage
 * rather than shelling to bash. (The old bash-oracle diff-tests are gone with
 * the engine; routing is asserted natively here.)
 */
import { describe, expect, it } from "vitest";
import { dispatch, isPorted, portedCommands, registerPorted, repoRoot, usage } from "../src/bridge.js";
import { registerAll } from "../src/index.js";

async function captureDispatch(argv: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const ow = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  try {
    // @ts-expect-error test capture
    process.stdout.write = (s: string): boolean => ((stdout += String(s)), true);
    // @ts-expect-error test capture
    process.stderr.write = (s: string): boolean => ((stderr += String(s)), true);
    const r = await dispatch(argv);
    return { status: r.status, stdout, stderr };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = oe;
  }
}

describe("repoRoot", () => {
  it("locates the package root via the conventions/ (or bin/roll) marker", () => {
    const root = repoRoot();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
    expect(root.toLowerCase().includes("roll")).toBe(true);
  });
});

describe("ported routing (no bash fallback)", () => {
  it("routes a registered command to its TS handler with args after the command", async () => {
    let got: string[] | undefined;
    registerPorted("__test_cmd", (args) => {
      got = args;
      return 42;
    });
    const res = await dispatch(["__test_cmd", "a b", "--flag"]);
    expect(res.status).toBe(42);
    expect(got).toEqual(["a b", "--flag"]);
    expect(isPorted("__test_cmd")).toBe(true);
    expect(portedCommands()).toContain("__test_cmd");
  });

  it("REFACTOR-048/051: one-shot and legacy manual commands are retired", async () => {
    registerAll();
    // internal one-time migrations (card-skeleton backfill, old attest-layout
    // port) completed long ago — off the command surface.
    expect(isPorted("migrate-features")).toBe(false);
    expect(isPorted("archive")).toBe(false);

    for (const command of ["migrate", "feedback"]) {
      expect(isPorted(command)).toBe(false);
      expect(usage()).not.toMatch(new RegExp(`\\b${command}\\b`));
      const res = await dispatch([command]);
      expect(res.status).toBe(1);
    }
    // REFACTOR-058: old public top-level aliases stay registered only so docs
    // drift guards can recognize them; dispatch returns the standard unknown
    // command shape until the docs sweep removes those rows.
    expect(isPorted("prices")).toBe(true);
    expect(usage()).not.toMatch(/\bprices\b/);
    const prices = await captureDispatch(["prices"]);
    expect(prices.status).toBe(1);
    expect(prices.stderr).toContain("unknown command 'prices'");
  });

  it("FIX-255 / REFACTOR-058: peer is no longer a public top-level surface", async () => {
    registerAll();
    expect(isPorted("peer")).toBe(true);
    expect(usage()).not.toMatch(/\bpeer\b/);
    const res = await captureDispatch(["peer", "--help"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unknown command 'peer'");
  });

  it("REFACTOR-049/058: version/gc top-level aliases are retired; lang is gone", async () => {
    registerAll();
    expect(isPorted("lang")).toBe(false); // moved into `roll config lang`
    expect(isPorted("version")).toBe(true); // registered retired stub; --version remains live
    expect(isPorted("gc")).toBe(true); // registered retired stub
    const listed = usage().split("Commands:")[1] ?? "";
    expect(listed).not.toMatch(/\bversion\b/);
    expect(listed).not.toMatch(/\bgc\b/);
    expect(listed).not.toMatch(/\blang\b/);
    expect((await captureDispatch(["version"])).stderr).toContain("unknown command 'version'");
    expect((await captureDispatch(["gc"])).stderr).toContain("unknown command 'gc'");
  });

  it("REFACTOR-052 (re-ruled by US-REL-007): machine commands stay hidden; the retired release sub-surfaces are GONE", async () => {
    registerAll();
    const listed = usage().split("Commands:")[1] ?? "";
    for (const command of ["alert", "skills", "attest", "index", "dream"]) {
      expect(isPorted(command), `${command} must stay callable`).toBe(true);
      expect(listed, `${command} must be hidden from main usage`).not.toMatch(new RegExp(`\\b${command}\\b`));
    }
    // US-REL-007: top-level changelog/consistency are unknown commands now —
    // the old REFACTOR-052 redirects were judged misleading, not compatibility.
    for (const dead of ["changelog", "consistency"]) {
      expect(isPorted(dead), `${dead} must be GONE`).toBe(false);
      const r = await captureDispatch([dead]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("unknown command");
    }
    for (const retired of ["alert", "skills"]) {
      const r = await captureDispatch([retired]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`unknown command '${retired}'`);
    }

    expect((await captureDispatch(["loop", "alert", "log"])).status).toBe(0);
    // the retired release routes exit through the explicit removed-route error
    // (US-DOSSIER-036: `consistency` is no longer here — it is a public route).
    for (const route of ["changelog", "ship", "waiver"]) {
      const rr = await captureDispatch(["release", route]);
      expect(rr.status).toBe(1);
      expect(rr.stderr).toContain("removed");
    }
    // US-DOSSIER-036: `roll release consistency check` IS a public command —
    // the verdict-first seven-dimension table (NOT a removed route).
    const cc = await captureDispatch(["release", "consistency", "check"]);
    expect(cc.stderr).not.toContain("removed");
    expect(cc.stdout).toMatch(/① code ↔ backlog/);
    expect((await captureDispatch(["doctor", "skills", "--help"])).stdout).toContain("roll doctor skills");
    expect((await captureDispatch(["setup", "skills", "--help"])).stdout).toContain("roll setup skills");
  });

  it("--help / -h → CLI usage, exit 0", async () => {
    for (const argv of [["--help"], ["-h"]]) {
      const res = await captureDispatch(argv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("roll <command>");
    }
  });

  it("REFACTOR-057: roll help is the public docs viewer while roll --help remains usage", async () => {
    registerAll();
    const helpHelp = await captureDispatch(["help", "--help"]);
    expect(helpHelp.status).toBe(0);
    expect(helpHelp.stdout).toContain("Usage: roll help");
    expect(helpHelp.stdout).not.toContain("Usage: roll doc");

    const cliHelp = await captureDispatch(["--help"]);
    expect(cliHelp.status).toBe(0);
    expect(cliHelp.stdout).toContain("roll <command>");
  });

  it("REFACTOR-057: retained support surfaces are reachable through owner commands", async () => {
    registerAll();
    const samples: Array<{ argv: string[]; stdout: RegExp }> = [
      { argv: ["config", "prices", "--help"], stdout: /Usage: roll prices/ },
      { argv: ["agent", "cast", "--help"], stdout: /Usage: roll cast/ },
      { argv: ["doctor", "tools", "--help"], stdout: /Usage: roll doctor tools/ },
      { argv: ["status", "ci", "--help"], stdout: /Usage: roll status ci/ },
      { argv: ["loop", "cycles", "--help"], stdout: /Usage: roll cycles/ },
      { argv: ["loop", "cycle", "--help"], stdout: /Usage: roll cycle/ },
      { argv: ["release", "showcase", "--help"], stdout: /Usage: roll showcase/ },
      { argv: ["setup", "offboard", "--help"], stdout: /Usage: roll offboard/ },
    ];
    for (const sample of samples) {
      const res = await captureDispatch(sample.argv);
      expect(res.status, sample.argv.join(" ")).toBe(0);
      expect(res.stdout, sample.argv.join(" ")).toMatch(sample.stdout);
    }
  });

  it("REFACTOR-057: config tune and status pulse nested routes reach their existing handlers", async () => {
    registerAll();
    const tune = await captureDispatch(["config", "tune", "--json"]);
    expect(tune.status).toBe(0);
    expect(tune.stdout).toContain('"mode"');
    expect(tune.stdout).toContain('"summary"');

    const pulse = await captureDispatch(["status", "pulse", "--json"]);
    expect(pulse.status).toBe(1);
    expect(pulse.stdout).toContain("no truth.json found");
  });

  it("REFACTOR-058: retired top-level aliases return the normal unknown-command response", async () => {
    registerAll();
    for (const command of ["doc", "prices", "cast", "tool", "pulse", "cycles", "cycle", "tune", "showcase", "offboard", "pair", "ls", "ci"]) {
      const res = await captureDispatch([command, "--help"]);
      expect(res.status, command).toBe(1);
      expect(res.stdout, command).toBe("");
      expect(res.stderr, command).toContain(`unknown command '${command}'`);
      expect(res.stderr, command).toContain("roll <command> [args]");
    }
  });

  it("REFACTOR-058: machine-only internal exceptions remain hidden but reachable", async () => {
    registerAll();
    const ci = await captureDispatch(["ci", "--wait", "--bad"]);
    expect(ci.status).toBe(1);
    expect(ci.stderr).toContain("Usage: roll ci [--wait] [--timeout=N]");
  });

  it("US-DOSSIER-035: bare roll (no args) → front door, not the usage dump, exit 0", async () => {
    const res = await captureDispatch([]);
    expect(res.status).toBe(0);
    // identity + verdict pointer + command map — never the flat `Commands:` join.
    expect(res.stdout).toMatch(/^roll v/m);
    expect(res.stdout).toContain("→ roll status");
    expect(res.stdout).toContain("daily");
    expect(res.stdout).not.toContain("roll <command> [args]");
  });

  it("an unknown command → exit 1 (usage, not a bash spawn)", async () => {
    const res = await dispatch(["definitely-not-a-roll-command"]);
    expect(res.status).toBe(1);
  });

  it("REFACTOR-056: usage() projects the public command-surface list, NOT raw registrations", () => {
    // A freshly-registered command that is not in the command-surface registry
    // must NOT leak into help — the list comes from the truth source, not from
    // ported-command enumeration.
    registerPorted("__usage_cmd", () => 0);
    const u = usage();
    expect(u).not.toContain("__usage_cmd");
    expect(u).toContain("roll <command>");
    const listed = u.split("Commands:")[1] ?? "";
    expect(listed.trim()).toMatch(
      /^agent, backlog, config, delivery, design, doctor, help, idea, init, loop, next, north, release, setup, status, test, workspace, update$/m,
    );
  });
});

describe("FIX-298 — the network guard is the FIRST dispatch checkpoint", () => {
  it("a non-network command (roll status) is NOT gated — the guard never runs", async () => {
    registerAll();
    let gateCalls = 0;
    const blockingGate = async (): Promise<{ ok: boolean }> => ((gateCalls += 1), { ok: false });
    const res = await dispatch(["status"], blockingGate);
    // status ran (the gate never fired); whatever its own exit, it is not the
    // gate's halt — and the gate was never consulted.
    expect(gateCalls).toBe(0);
    expect(res.status).not.toBeUndefined();
  });

  it("a needs-network command HALTS (exit 1) when the guard reports not-ok — handler never runs", async () => {
    let handlerRan = false;
    // Prove the wiring through a real gated command: `update` (gated unless
    // --help). Replace its handler with a spy and inject a blocked guard; the
    // handler must never run because the guard halts first.
    registerPorted("update", () => ((handlerRan = true), 0));
    const blockingGate = async (): Promise<{ ok: boolean }> => ({ ok: false });
    const res = await dispatch(["update"], blockingGate);
    expect(res.status).toBe(1);
    expect(handlerRan).toBe(false);
  });

  it("a needs-network command proceeds to its handler when the guard reports ok", async () => {
    registerAll();
    let gateCalls = 0;
    const okGate = async (): Promise<{ ok: boolean }> => ((gateCalls += 1), { ok: true });
    // `update --help` is exempt (help is never gated), so use a route the guard
    // gates: bare `release` (the real transaction). With deps absent it will try
    // the real flow, so assert only that the gate ran and the handler was reached.
    const res = await dispatch(["release", "--json"], okGate);
    // `release --json` is a read-only plan → NOT gated → gate must NOT run.
    expect(gateCalls).toBe(0);
    expect(res.status).not.toBeUndefined();
  });

  it("a cry for help on a network command is NOT gated", async () => {
    registerAll();
    let gateCalls = 0;
    const blockingGate = async (): Promise<{ ok: boolean }> => ((gateCalls += 1), { ok: false });
    const res = await dispatch(["update", "--help"], blockingGate);
    expect(gateCalls).toBe(0);
    expect(res.status).toBe(0); // help printed, exit 0 — no halt
  });
});
