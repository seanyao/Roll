/**
 * US-PORT-019 — `roll backlog` write/maintenance arms (TS port off bin/roll).
 * Covers block/defer/unblock/promote (set-status) + lint.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backlogClaimCommand,
  backlogLintCommand,
  backlogSetStatusCommand,
  backlogUnstickCommand,
  type UnstickDeps,
  lintBacklogContent,
  statusFor,
} from "../src/commands/backlog-mgmt.js";
import type { ResolvedBacklogTarget } from "../src/commands/backlog-target.js";
import { stripAnsi } from "../src/render.js";

let cwd0: string;
let dir: string;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  cwd0 = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "backlog-mgmt-"));
  process.chdir(dir);
  mkdirSync("backlog", { recursive: true });
  setEnv("ROLL_LANG", "en");
  setEnv("NO_COLOR", "1");
});
afterEach(() => {
  process.chdir(cwd0);
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

function capture(fn: () => number): { status: number; out: string; err: string } {
  const o: string[] = [];
  const e: string[] = [];
  const wo = process.stdout.write.bind(process.stdout);
  const we = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((x: string | Uint8Array) => (o.push(String(x)), true)) as typeof process.stdout.write;
  process.stderr.write = ((x: string | Uint8Array) => (e.push(String(x)), true)) as typeof process.stderr.write;
  try {
    const status = fn();
    return { status, out: stripAnsi(o.join("")), err: stripAnsi(e.join("")) };
  } finally {
    process.stdout.write = wo;
    process.stderr.write = we;
  }
}

const HEADER = "| ID | Description | Status |\n|----|----|----|\n";
function seedBacklog(rows: string): void {
  writeFileSync(join("backlog", "index.md"), HEADER + rows);
}
function statusOf(id: string): string {
  for (const line of readFileSync(join("backlog", "index.md"), "utf8").split("\n")) {
    if (line.startsWith("|") && line.includes(id)) {
      const parts = line.split("|");
      return (parts[parts.length - 2] ?? "").trim();
    }
  }
  return "";
}

function target(): ResolvedBacklogTarget {
  return {
    ok: true,
    workspaceId: "ws-test",
    workspaceRoot: dir,
    canonicalRoot: dir,
    backlogPath: join(dir, "backlog", "index.md"),
    storyRoot: join(dir, "backlog"),
    runtimeRoot: join(dir, "runtime"),
    configPath: join(dir, "runtime", "backlog-sync.yaml"),
  };
}

const resolveTarget = (): ResolvedBacklogTarget => target();

function setStatus(subcmd: string, args: string[]): number {
  return backlogSetStatusCommand(subcmd, args, undefined, { resolveTarget });
}

function claim(args: string[], nowMs = 1_700_000_000_000): number {
  return backlogClaimCommand(args, { nowMs: () => nowMs, resolveTarget });
}

function lint(args: string[]): number {
  return backlogLintCommand(args, { resolveTarget });
}

describe("statusFor — US-PORT-019", () => {
  it("maps each set-status subcommand", () => {
    expect(statusFor("block", "")).toBe("🔒 Blocked");
    expect(statusFor("block", "waiting api")).toBe("🔒 Blocked [waiting api]");
    expect(statusFor("defer", "later")).toBe("⏸ Deferred [later]");
    expect(statusFor("unblock", "x")).toBe("📋 Todo");
    expect(statusFor("promote", "")).toBe("📋 Todo");
    expect(statusFor("nope", "")).toBeNull();
  });
});

describe("backlog block/defer/unblock/promote — US-PORT-019", () => {
  it("block sets 🔒 Blocked [reason] and reports the count", () => {
    seedBacklog("| [FIX-001](x) | fix a thing | 📋 Todo |\n");
    const r = capture(() => setStatus("block", ["FIX-001", "waiting upstream"]));
    expect(r.status).toBe(0);
    expect(statusOf("FIX-001")).toBe("🔒 Blocked [waiting upstream]");
    expect(r.out).toContain("Updated 1 item");
  });

  it("defer then unblock round-trips a row back to Todo", () => {
    seedBacklog("| [US-002](x) | a story | 📋 Todo |\n");
    capture(() => setStatus("defer", ["US-002", "next quarter"]));
    expect(statusOf("US-002")).toBe("⏸ Deferred [next quarter]");
    capture(() => setStatus("unblock", ["US-002"]));
    expect(statusOf("US-002")).toBe("📋 Todo");
  });

  it("US-V4-001: a status flip is backlog-only and does NOT refresh the global dossier front page", () => {
    seedBacklog("| [FIX-001](x) | fix a thing | 📋 Todo |\n");
    mkdirSync(join("backlog", "alpha", "FIX-001"), { recursive: true });
    writeFileSync(join("backlog", "alpha", "FIX-001", "spec.md"), "# FIX-001 — fix a thing\n");
    capture(() => setStatus("block", ["FIX-001", "waiting"]));
    // The status change lands in backlog.md; the global dossier page is NOT a
    // delivery side effect — it is rendered on demand by `roll index`.
    expect(statusOf("FIX-001")).toContain("🔒 Blocked");
    expect(existsSync(join("backlog", "index.html"))).toBe(false);
  });

  it("no match → 'No items matched', exit 0, file unchanged", () => {
    seedBacklog("| [FIX-001](x) | fix a thing | 📋 Todo |\n");
    const before = readFileSync(join("backlog", "index.md"), "utf8");
    const r = capture(() => setStatus("block", ["NOPE-999"]));
    expect(r.status).toBe(0);
    expect(r.out).toContain("No items matched: NOPE-999");
    expect(readFileSync(join("backlog", "index.md"), "utf8")).toBe(before);
  });

  it("missing pattern → usage on stderr, exit 1", () => {
    seedBacklog("| [FIX-001](x) | x | 📋 Todo |\n");
    const r = capture(() => setStatus("block", []));
    expect(r.status).toBe(1);
    expect(r.err).toContain("Usage: roll backlog block");
  });
});

describe("backlog claim — FIX-1211", () => {
  it("marks the card In Progress and writes a human lease by default", () => {
    seedBacklog("| [FIX-1211](x) | lease aware | 📋 Todo |\n");
    const r = capture(() => claim(["FIX-1211"]));
    expect(r.status).toBe(0);
    expect(statusOf("FIX-1211")).toBe("🔨 In Progress");
    expect(r.out).toContain("claimed FIX-1211");
    const leaseDir = join("runtime", "locks", "leases");
    const lease = JSON.parse(readFileSync(join(leaseDir, "FIX-1211.lease"), "utf8"));
    expect(lease).toEqual({ source: "human", claimedAt: 1_700_000_000_000 });
  });

  it("can write a supervisor lease", () => {
    seedBacklog("| [FIX-1211](x) | lease aware | 📋 Todo |\n");
    const r = capture(() => claim(["FIX-1211", "--source", "supervisor"]));
    expect(r.status).toBe(0);
    const leaseDir = join("runtime", "locks", "leases");
    expect(JSON.parse(readFileSync(join(leaseDir, "FIX-1211.lease"), "utf8"))).toEqual({
      source: "supervisor",
      claimedAt: 1_700_000_000_000,
    });
  });
});

describe("backlog lint — US-PORT-019", () => {
  it("flags length>120, code-fence, filename, path, function violations", () => {
    const longDesc = "x".repeat(130);
    const content =
      HEADER +
      `| [US-010](x) | ${longDesc} | 📋 Todo |\n` +
      "| [US-011](x) | run `roll loop on` to start | 📋 Todo |\n" +
      "| [US-012](x) | edit config.yaml then retry | 📋 Todo |\n" +
      "| [US-013](x) | touch src/foo/bar then build | 📋 Todo |\n" +
      "| [US-014](x) | call _helper() before exit | 📋 Todo |\n" +
      "| [US-015](x) | a perfectly clean human sentence | 📋 Todo |\n";
    const findings = lintBacklogContent(content);
    const byId = Object.fromEntries(findings.map((f) => [f.sid, f.issues]));
    expect(byId["US-010"]).toContain("length>130");
    expect(byId["US-011"]).toContain("code-fence");
    expect(byId["US-012"]).toContain("filename");
    expect(byId["US-013"]).toContain("path");
    expect(byId["US-014"]).toContain("function");
    expect(byId["US-015"]).toBeUndefined(); // clean row not flagged
  });

  it("clean backlog → no violations, exit 0", () => {
    seedBacklog("| [US-001](x) | a clean one line human description | 📋 Todo |\n");
    const r = capture(() => lint([]));
    expect(r.status).toBe(0);
    expect(r.out).toContain("No violations");
  });

  it("--gate flips a violation to exit 1", () => {
    seedBacklog("| [US-002](x) | uses `code` in the description | 📋 Todo |\n");
    const warn = capture(() => lint([]));
    expect(warn.status).toBe(0);
    expect(warn.out).toContain("warn-only");
    const gated = capture(() => lint(["--gate"]));
    expect(gated.status).toBe(1);
    expect(gated.out).toContain("exiting 1");
  });
});

describe("backlog unstick — US-PORT-019 (FIX-112)", () => {
  const NOW = Date.parse("2026-06-09T12:00:00Z");
  let alertPath: string;

  function ev(stage: string, extra: Record<string, unknown>): string {
    return JSON.stringify({ stage, ...extra });
  }
  /** Seed events ndjson + return deps pointing the shared root at the sandbox. */
  function setup(events: string[]): UnstickDeps {
    const runtime = join(dir, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "events.ndjson"), events.join("\n") + "\n");
    alertPath = join(runtime, "alerts", "unstick.md");
    return { nowMs: () => NOW, resolveTarget };
  }
  function iso(hoursAgo: number): string {
    return new Date(NOW - hoursAgo * 3600_000).toISOString();
  }

  it("reverts a story whose failed cycle is older than the TTL", () => {
    const deps = setup([
      ev("pick_todo", { detail: "US-100", label: "c1", ts: iso(6) }),
      ev("cycle_end", { label: "c1", outcome: "failed", ts: iso(5) }), // 5h ago > 4h TTL
      ev("pick_todo", { detail: "US-101", label: "c2", ts: iso(2) }),
      ev("cycle_end", { label: "c2", outcome: "failed", ts: iso(1) }), // 1h ago < 4h → keep
      ev("pick_todo", { detail: "US-102", label: "c3", ts: iso(3) }), // still running → keep
    ]);
    seedBacklog(
      "| [US-100](x) | one | 🔨 In Progress |\n" +
        "| [US-101](x) | two | 🔨 In Progress |\n" +
        "| [US-102](x) | three | 🔨 In Progress |\n",
    );
    const r = capture(() => backlogUnstickCommand([], deps));
    expect(r.status).toBe(0);
    expect(r.out).toContain("reverted US-100 (cycle ended failed 5.0h ago)");
    expect(statusOf("US-100")).toBe("📋 Todo");
    expect(statusOf("US-101")).toBe("🔨 In Progress");
    expect(statusOf("US-102")).toBe("🔨 In Progress");
    // ALERT note appended
    const alert = readFileSync(alertPath, "utf8");
    expect(alert).toContain("unstick: reverted US-100");
  });

  it("--dry-run reports but writes nothing", () => {
    const deps = setup([
      ev("pick_todo", { detail: "US-100", label: "c1", ts: iso(6) }),
      ev("cycle_end", { label: "c1", outcome: "aborted", ts: iso(5) }),
    ]);
    seedBacklog("| [US-100](x) | one | 🔨 In Progress |\n");
    const r = capture(() => backlogUnstickCommand(["--dry-run"], deps));
    expect(r.status).toBe(0);
    expect(r.out).toContain("would-revert US-100 (cycle ended aborted 5.0h ago)");
    expect(statusOf("US-100")).toBe("🔨 In Progress"); // untouched
  });

  it("nothing stuck → exit 0, no output", () => {
    const deps = setup([ev("pick_todo", { detail: "US-200", label: "c9", ts: iso(3) })]);
    seedBacklog("| [US-200](x) | running | 🔨 In Progress |\n");
    const r = capture(() => backlogUnstickCommand([], deps));
    expect(r.status).toBe(0);
    expect(r.out).toContain("Backlog ws-test");
  });
});
