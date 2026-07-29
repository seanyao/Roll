/**
 * FIX-238/239/240 — the ONE help contract.
 *
 * Smoke audit 2026-06-11 found the contract in pieces: `roll update --help`
 * EXECUTED the upgrade (network + global writes on a cry for help), init/setup
 * swallowed the flag name from their errors, five commands ignored --help and
 * ran their normal logic, agent/alert errored politely but exited 0, dream
 * called itself an unknown command, and `roll loop` advertised retired
 * monitor/attach subcommands.
 *
 * Contract: `roll <cmd> --help|-h` → usage on STDOUT, exit 0, NO side effects.
 * Unknown subcommand → stderr + non-zero. The bridge enforces the help half
 * centrally (table-driven below); commands keep richer internal help for
 * deeper flags.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { dispatch, registeredHelp } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";
import { loopUnknownSubcommand } from "../src/commands/loop-cycle-gates.js";

let out = "";
let err = "";
let ow: typeof process.stdout.write;
let oe: typeof process.stderr.write;
beforeEach(() => {
  registerAll();
  out = "";
  err = "";
  ow = process.stdout.write.bind(process.stdout);
  oe = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture
  process.stdout.write = (s: string): boolean => ((out += String(s)), true);
  // @ts-expect-error capture
  process.stderr.write = (s: string): boolean => ((err += String(s)), true);
});
afterEach(() => {
  process.stdout.write = ow;
  process.stderr.write = oe;
});

/** FIX-239 AC3 — table-driven: every command with registered help honors the contract. */
describe("help contract — table-driven across registered commands", () => {
  it("registers help for every smoke-audit offender", () => {
    const helped = registeredHelp();
    for (const cmd of ["update", "init", "setup", "backlog", "status", "doctor", "agent", "dream", "loop"]) {
      expect(helped, `${cmd} must register bridge help`).toContain(cmd);
    }
  });

  it("`roll <cmd> --help` → usage on stdout, exit 0, stderr silent — for EVERY helped command", async () => {
    for (const cmd of registeredHelp()) {
      out = "";
      err = "";
      const r = await dispatch([cmd, "--help"]);
      expect(r.status, `${cmd} --help must exit 0`).toBe(0);
      expect(out, `${cmd} --help must print usage to stdout`).toMatch(/usage|Usage|用法/);
      expect(err, `${cmd} --help must not write stderr`).toBe("");
    }
  });

  it("-h behaves identically", async () => {
    const r = await dispatch(["update", "-h"]);
    expect(r.status).toBe(0);
    expect(out).toMatch(/Usage/i);
  });

  it("setup help documents the accepted force/reselect surface", async () => {
    const r = await dispatch(["setup", "--help"]);
    expect(r.status).toBe(0);
    expect(out).toContain("roll setup [-f|--force] [--reselect]");
    expect(out).not.toContain("roll setup [skills|offboard]");
  });
});

describe("FIX-238 — update never upgrades on a cry for help; init/setup name the bad flag", () => {
  it("update --help prints usage and performs NO upgrade", async () => {
    const r = await dispatch(["update", "--help"]);
    expect(r.status).toBe(0);
    expect(out).toContain("update");
    expect(out).not.toMatch(/npm install|Current version/i); // no side-effect path entered
  });

  it("init reports the offending flag BY NAME", async () => {
    const r = await dispatch(["init", "--bogus"]);
    expect(r.status).toBe(1);
    expect(err).toContain("--bogus");
  });

  it("setup reports the offending argument BY NAME", async () => {
    const r = await dispatch(["setup", "--wat"]);
    expect(r.status).toBe(1);
    expect(err).toContain("--wat");
  });
});

describe("FIX-239 — unknown subcommands are errors (stderr + non-zero)", () => {
  it("agent unknown subcommand → exit 1", async () => {
    const r = await dispatch(["agent", "frobnicate"]);
    expect(r.status).toBe(1);
    expect(err).toContain("frobnicate");
  });

  it("loop alert unknown subcommand → exit 1", async () => {
    const r = await dispatch(["loop", "alert", "frobnicate"]);
    expect(r.status).toBe(1);
  });

  it("dream unknown subcommand names the SUBCOMMAND, not itself", async () => {
    const r = await dispatch(["dream", "frobnicate"]);
    expect(r.status).toBe(1);
    expect(err).not.toContain("Unknown command: dream");
    expect(err).toContain("frobnicate");
  });
});

describe("FIX-240 — loop usage advertises only live subcommands", () => {
  // US-LOOP-113 (codex review r3): the usage line used to inline a second verb
  // list, which drifted AND advertised removed verbs (`on|off|now`) to a user who
  // had just typed one. It now points at the grouped help — the single source.
  it("usage points at the grouped help and advertises no removed verb", () => {
    let captured = "";
    const real = process.stderr.write.bind(process.stderr);
    // @ts-expect-error capture
    process.stderr.write = (s: string): boolean => ((captured += String(s)), true);
    try {
      loopUnknownSubcommand("bogus");
    } finally {
      process.stderr.write = real;
    }
    expect(captured).toContain("roll loop --help");
    // No second verb list to drift, and nothing removed is named.
    for (const gone of ["monitor", "attach", "on|off", "|now|", "fallback"]) {
      expect(captured, `usage must not name ${gone}`).not.toContain(gone);
    }
  });
});
