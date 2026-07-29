/**
 * US-PORT-022 (part 2) — `roll loop reset | mute | unmute` TS ports.
 * Behavior aligned with bin/roll `_loop_reset` / `_loop_mute` / `_loop_unmute`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSmokeCmd,
  healDir,
  loopGcCommand,
  type LoopGcDeps,
  loopMuteCommand,
  loopResetCommand,
  loopUnmuteCommand,
  muteFile,
  stateFile,
} from "../src/commands/loop-maint.js";
import { stripAnsi } from "../src/render.js";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

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

/** Point the runtime dir + slug + heal dir at a throwaway sandbox. */
function sandbox(): { rt: string; slug: string; heal: string } {
  const rt = tmp("roll-loopmaint-rt-");
  const loopDir = tmp("roll-loopmaint-shared-");
  setEnv("ROLL_PROJECT_RUNTIME_DIR", rt);
  setEnv("ROLL_LOOP_DIR", loopDir);
  setEnv("ROLL_MAIN_SLUG", "sandbox-aaa111");
  setEnv("ROLL_LANG", "en");
  setEnv("NO_COLOR", "1");
  return { rt, slug: "sandbox-aaa111", heal: join(loopDir, "heal") };
}

describe("loop reset — US-PORT-022", () => {
  it("clears an existing state file + reports the cleared message, exit 0", () => {
    const { slug } = sandbox();
    const state = stateFile(slug);
    mkdirSync(join(state, ".."), { recursive: true });
    writeFileSync(state, "head_ci_heal: 3\n");
    const r = capture(() => loopResetCommand([]));
    expect(r.status).toBe(0);
    expect(existsSync(state)).toBe(false);
    expect(r.out).toContain("Loop state cleared");
    expect(r.err).toBe("");
  });

  it("no state file → 'no loop state to clear', exit 0", () => {
    sandbox();
    const r = capture(() => loopResetCommand([]));
    expect(r.status).toBe(0);
    expect(r.out).toContain("No loop state to clear");
  });

  it("removes the heal dir unconditionally", () => {
    const { heal } = sandbox();
    mkdirSync(heal, { recursive: true });
    writeFileSync(join(heal, "counter"), "1");
    const r = capture(() => loopResetCommand([]));
    expect(r.status).toBe(0);
    expect(existsSync(heal)).toBe(false);
  });
});

describe("loop mute / unmute — US-PORT-022", () => {
  it("mute creates the marker (auto-creating its parent), exit 0", () => {
    const { slug } = sandbox();
    const r = capture(() => loopMuteCommand([]));
    expect(r.status).toBe(0);
    expect(existsSync(muteFile(slug))).toBe(true);
    expect(readFileSync(muteFile(slug), "utf8")).toBe("");
    expect(r.out).toContain("muted");
  });

  it("unmute removes the marker, exit 0", () => {
    const { slug } = sandbox();
    capture(() => loopMuteCommand([]));
    expect(existsSync(muteFile(slug))).toBe(true);
    const r = capture(() => loopUnmuteCommand([]));
    expect(r.status).toBe(0);
    expect(existsSync(muteFile(slug))).toBe(false);
    expect(r.out).toContain("unmuted");
  });

  it("unmute when not muted is a no-op, exit 0", () => {
    sandbox();
    const r = capture(() => loopUnmuteCommand([]));
    expect(r.status).toBe(0);
  });

  it("heal dir honors ROLL_LOOP_DIR override", () => {
    const { heal } = sandbox();
    expect(healDir()).toBe(heal);
  });
});

describe("loop gc — US-PORT-022", () => {
  const NOW_MS = 1_780_000_000_000; // frozen clock
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  /** A throwaway plistDir + loopDir + frozen clock. */
  function gcSandbox(): { plistDir: string; loopDir: string; deps: LoopGcDeps } {
    const plistDir = tmp("roll-gc-plists-");
    const loopDir = tmp("roll-gc-loop-");
    delete process.env["ROLL_LOOP_GC_RETENTION_DAYS"];
    const deps: LoopGcDeps = {
      plistDir: () => plistDir,
      loopDir: () => loopDir,
      nowMs: () => NOW_MS,
    };
    return { plistDir, loopDir, deps };
  }

  function plist(dir: string, slug: string, workdir: string): void {
    writeFileSync(
      join(dir, `com.roll.loop.${slug}.plist`),
      `<plist><dict>\n<key>WorkingDirectory</key>\n<string>${workdir}</string>\n</dict></plist>\n`,
    );
  }
  /** Touch a file with an mtime `daysAgo` before the frozen clock. */
  function aged(path: string, daysAgo: number, body = "x"): void {
    writeFileSync(path, body);
    const sec = NOW_SEC - daysAgo * 86400;
    utimesSync(path, sec, sec);
  }

  it("refuses inside a loop cycle (FIX-125), exit 1", () => {
    const { deps } = gcSandbox();
    setEnv("ROLL_LOOP_AGENT", "claude");
    const r = capture(() => loopGcCommand([], deps));
    expect(r.status).toBe(1);
    expect(r.err).toContain("FIX-125");
    expect(r.out).toBe("");
  });

  it("dry-run flags an orphan slug but touches nothing", () => {
    const { plistDir, deps } = gcSandbox();
    plist(plistDir, "gone-abc123", "/no/such/project/path/xyz");
    const r = capture(() => loopGcCommand(["--dry-run"], deps));
    expect(r.status).toBe(0);
    expect(r.out).toContain("[DRY-RUN] orphan slug: gone-abc123");
    expect(r.out).toContain("dry-run complete (1 items would be cleaned)");
    expect(existsSync(join(plistDir, "com.roll.loop.gone-abc123.plist"))).toBe(true);
  });

  it("archives an orphan slug: moves plist+runners, removes data files", () => {
    const { plistDir, loopDir, deps } = gcSandbox();
    plist(plistDir, "gone-abc123", "/no/such/project/path/xyz");
    writeFileSync(join(loopDir, "run-gone-abc123.sh"), "#!/bin/bash\n");
    writeFileSync(join(loopDir, "state-gone-abc123.yaml"), "k: v\n");
    const r = capture(() => loopGcCommand([], deps));
    expect(r.status).toBe(0);
    expect(r.out).toContain("gc: archiving orphan slug gone-abc123");
    expect(existsSync(join(plistDir, "com.roll.loop.gone-abc123.plist"))).toBe(false);
    expect(existsSync(join(loopDir, "state-gone-abc123.yaml"))).toBe(false);
    // archived under <loop>/archived/<slug>-<ts>/
    const archived = join(loopDir, "archived");
    expect(existsSync(archived)).toBe(true);
  });

  it("keeps a slug whose project directory still exists", () => {
    const { plistDir, deps } = gcSandbox();
    const live = tmp("roll-gc-liveproj-");
    plist(plistDir, "live-def456", live);
    const r = capture(() => loopGcCommand([], deps));
    expect(r.status).toBe(0);
    expect(existsSync(join(plistDir, "com.roll.loop.live-def456.plist"))).toBe(true);
    expect(r.out).toContain("gc: 0 items cleaned, keep-days=30");
  });

  it("sweeps tmp debris always, and ages out backup/migrated/.bak by cutoff", () => {
    const { loopDir, deps } = gcSandbox();
    writeFileSync(join(loopDir, "runs.jsonl.tmp.9999"), "{}");
    aged(join(loopDir, "backup-before-merge-old.tgz"), 6); // >5d → gone
    aged(join(loopDir, "backup-before-merge-new.tgz"), 1); // <5d → kept
    aged(join(loopDir, "events.migrated-1234"), 8); // >7d → gone
    aged(join(loopDir, "runs.jsonl.bak"), 40); // >30d default → gone
    aged(join(loopDir, "fresh.bak"), 5); // <30d → kept
    const r = capture(() => loopGcCommand([], deps));
    expect(r.status).toBe(0);
    expect(existsSync(join(loopDir, "runs.jsonl.tmp.9999"))).toBe(false);
    expect(existsSync(join(loopDir, "backup-before-merge-old.tgz"))).toBe(false);
    expect(existsSync(join(loopDir, "backup-before-merge-new.tgz"))).toBe(true);
    expect(existsSync(join(loopDir, "events.migrated-1234"))).toBe(false);
    expect(existsSync(join(loopDir, "runs.jsonl.bak"))).toBe(false);
    expect(existsSync(join(loopDir, "fresh.bak"))).toBe(true);
    expect(r.out).toContain("4 items cleaned, keep-days=30");
  });

  it("ROLL_LOOP_GC_RETENTION_DAYS env overrides keep-days", () => {
    const { loopDir, deps } = gcSandbox();
    aged(join(loopDir, "a.bak"), 10);
    setEnv("ROLL_LOOP_GC_RETENTION_DAYS", "7"); // 10d > 7d → gone
    const r = capture(() => loopGcCommand(["--keep-days", "30"], deps));
    expect(r.status).toBe(0);
    expect(existsSync(join(loopDir, "a.bak"))).toBe(false);
    expect(r.out).toContain("keep-days=7");
  });
});

// US-LOOP-117: `roll loop test` is gone. It smoke-tested the GENERATED launchd
// runner and hard-required it ("Run 'roll loop on' first") — a runner nothing can
// generate any more. `roll loop go --max-cycles 1` is the honest equivalent.

