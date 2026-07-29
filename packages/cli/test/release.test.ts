/**
 * US-REL-007 — `roll release` is the ONLY release command: the transaction's
 * step order, every gate's abort, the removed routes' rejection, and the
 * no-stray-surface cleanup guard.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReleaseStep } from "@roll/core";
import type { ReleaseVerifySeams } from "@roll/core";
import {
  commitPushWithGate,
  enableAutoMergeResilient,
  openPrResilient,
  releaseCommand,
  runReleaseFlow,
  runReleaseVerify,
  type ReleaseFlowDeps,
} from "../src/commands/release.js";

describe("runReleaseVerify (FIX-1480 two-phase promote)", () => {
  const seams = (over: Partial<ReleaseVerifySeams> = {}): ReleaseVerifySeams => ({
    tagExists: () => true,
    npmHasVersion: () => true,
    npmLatest: () => "4.724.1",
    getRelease: () => ({ isDraft: true }),
    promoteRelease: () => {},
    ...over,
  });
  function capture(args: string[], s: ReleaseVerifySeams): { code: number; out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const code = runReleaseVerify(args, { out: (x) => out.push(x), err: (x) => err.push(x) }, s, process.cwd());
    return { code, out: out.join(""), err: err.join("") };
  }

  it("promotes and exits 0 when npm+tag+latest+draft all agree", () => {
    let promoted = "";
    const r = capture(["4.724.1"], seams({ promoteRelease: (t) => { promoted = t; } }));
    expect(r.code).toBe(0);
    expect(promoted).toBe("v4.724.1");
    expect(r.out).toContain("promoted to latest");
  });

  it("exits 1 and does NOT promote when npm lacks the version", () => {
    let called = false;
    const r = capture(["4.724.1"], seams({ npmHasVersion: () => false, promoteRelease: () => { called = true; } }));
    expect(r.code).toBe(1);
    expect(called).toBe(false);
    expect(r.err).toContain("npm has no");
    expect(r.err).toContain("NOT promoted");
  });

  it("--no-latest skips the dist-tags check", () => {
    const r = capture(["4.724.1", "--no-latest"], seams({ npmLatest: () => "9.9.9" }));
    expect(r.code).toBe(0);
  });
});

function uniqueInOrder(steps: ReleaseStep[]): ReleaseStep[] {
  const seen = new Set<ReleaseStep>();
  const out: ReleaseStep[] = [];
  for (const s of steps) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function fakeDeps(over: Partial<ReleaseFlowDeps> = {}): { deps: ReleaseFlowDeps; steps: ReleaseStep[]; writes: string[] } {
  const steps: ReleaseStep[] = [];
  const writes: string[] = [];
  const deps: ReleaseFlowDeps = {
    version: () => "3.612.2",
    // Default to roll's own package so the base fixture stays on the calver path
    // (FIX-1247); target-project cases override packageName to exercise semver.
    packageName: () => "@seanyao/roll",
    branch: () => "main",
    clean: () => true,
    synced: () => true,
    tagExists: () => false,
    readChangelog: () => "# C\n\n## Unreleased\n\n- thing one\n\n## v3.612.2 — 2026-06-12\n\n- old\n",
    writeChangelog: (_c, text) => void writes.push(`changelog:${text.length}`),
    bumpVersion: (_c, v) => void writes.push(`bump:${v}`),
    packageGate: () => true,
    commitPush: (_c, b) => void writes.push(`push:${b}`),
    openPr: () => "https://github.com/x/y/pull/1",
    enableAutoMerge: (_c, pr) => void writes.push(`automerge:${pr}`),
    nudgePr: (_c, b) => void writes.push(`nudge:${b}`),
    waitMerged: () => true,
    syncMain: () => true,
    consistencyGate: () => true,
    tag: (_c, t2) => void writes.push(`tag:${t2}`),
    pushTag: (_c, t2) => void writes.push(`pushTag:${t2}`),
    confirm: () => true,
    now: () => new Date("2026-06-13T08:00:00Z"),
    onStep: (s) => void steps.push(s),
  };
  return { deps: { ...deps, ...over }, steps, writes };
}

describe("runReleaseFlow — the one transaction", () => {
  it("happy path executes every step in the gated order and ends at tag-push", async () => {
    const { deps, steps, writes } = fakeDeps();
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("released");
    expect(res.tag).toBe("v3.613.1");
    // FIX-288: consistency-gate moved BEFORE open-pr. Each ReleaseStep appears
    // once in this order (the wait-merge poll feedback can repeat the step, but
    // the happy path's stub merges on the first poll → one wait-merge mark).
    expect(uniqueInOrder(steps)).toEqual([
      "plan",
      "fold-changelog",
      "bump-version",
      "package-gate",
      "commit-push",
      "consistency-gate",
      "open-pr",
      "wait-merge",
      "sync-main",
      "tag-push",
    ]);
    expect(writes.at(-1)).toBe("pushTag:v3.613.1");
  });

  it("FIX-1247: a target project's release anchors to ITS semver, not roll's build number", async () => {
    // intel-radar with a real semver lineage, released on the same day roll's
    // own build number is 4.713.x. Before the fix the planner mangled the mid
    // segment to today's MMDD → 1.713.1. It must bump the project's own patch.
    const { deps, writes } = fakeDeps({
      packageName: () => "intel-radar",
      version: () => "1.2.3",
      readChangelog: () => "# C\n\n## Unreleased\n\n- thing one\n",
      now: () => new Date("2026-07-13T08:00:00Z"),
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("released");
    expect(res.tag).toBe("v1.2.4");
    expect(res.tag).not.toContain("713");
    expect(writes).toContain("bump:1.2.4");
  });

  it("FIX-1247: a target project's FIRST release gets 0.1.0 (no roll build number)", async () => {
    const { deps, writes } = fakeDeps({
      packageName: () => "intel-radar",
      version: () => "0.0.0",
      readChangelog: () => "# C\n\n## Unreleased\n\n- initial\n",
      now: () => new Date("2026-07-13T08:00:00Z"),
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("released");
    expect(res.tag).toBe("v0.1.0");
    expect(writes).toContain("bump:0.1.0");
  });

  it("FIX-288 AC4: a drifting consistency gate aborts BEFORE the PR/merge — nothing lands on main", async () => {
    const { deps, writes } = fakeDeps({ consistencyGate: () => false });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("aborted");
    expect(res.step).toBe("consistency-gate");
    // The bump+changelog are committed on the release branch, but NO PR is
    // opened, NO auto-merge armed, NO tag pushed → no merged-but-untagged half.
    expect(writes.some((w) => w.startsWith("automerge:"))).toBe(false);
    expect(writes.some((w) => w.startsWith("tag:") || w.startsWith("pushTag:"))).toBe(false);
  });

  it("FIX-288 AC1: open-pr arms GitHub auto-merge before the wait", async () => {
    const { deps, writes } = fakeDeps();
    await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    const prIdx = writes.findIndex((w) => w.startsWith("automerge:"));
    expect(prIdx).toBeGreaterThan(-1);
    expect(writes[prIdx]).toContain("/pull/1");
  });

  it("FIX-288 AC5: a repo without auto-merge aborts cleanly at open-pr (no tag)", async () => {
    const { deps, writes } = fakeDeps({
      enableAutoMerge: () => {
        throw new Error('auto-merge is not enabled on this repo. Enable "Allow auto-merge"');
      },
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("aborted");
    expect(res.step).toBe("open-pr");
    expect(res.reason).toContain("Allow auto-merge");
    expect(writes.some((w) => w.startsWith("tag:") || w.startsWith("pushTag:"))).toBe(false);
  });

  it("FIX-288 AC2/AC3: the wait loop prints per-poll feedback and can nudge CI", async () => {
    const feedback: string[] = [];
    let nudges = 0;
    const { deps } = fakeDeps({
      waitMerged: (_c, _pr, _b, hooks) => {
        hooks.onWait("waited 1m"); // AC2
        hooks.onWait("waited 2m");
        hooks.nudge(); // AC3
        return true;
      },
      onStep: () => {},
    });
    deps.onStep = (s, d) => {
      if (s === "wait-merge") feedback.push(d);
    };
    deps.nudgePr = () => void nudges++;
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("released");
    expect(feedback).toContain("waited 1m");
    expect(feedback).toContain("waited 2m");
    expect(feedback).toContain("merged");
    expect(nudges).toBe(1);
  });

  it("same-day rerun bumps the sequence (calver third segment)", async () => {
    const { deps } = fakeDeps({ version: () => "3.613.1", readChangelog: () => "## Unreleased\n\n- more\n" });
    const res = await runReleaseFlow("/repo", deps, { dryRun: true, yes: true });
    expect(res.tag).toBe("v3.613.2");
  });

  const aborts: Array<[string, Partial<ReleaseFlowDeps>, ReleaseStep, RegExp]> = [
    ["dirty tree", { clean: () => false }, "plan", /dirty/],
    ["not on main", { branch: () => "feat/x" }, "plan", /not on main/],
    ["stale main", { synced: () => false }, "plan", /behind origin/],
    ["existing tag", { tagExists: () => true }, "plan", /already exists/],
    ["empty changelog", { readChangelog: () => "# C\n\n## Unreleased\n\n## v1 — d\n\n- old\n" }, "fold-changelog", /empty/],
    ["package gate", { packageGate: () => false }, "package-gate", /pack/],
    ["pr not merged", { waitMerged: () => false }, "wait-merge", /not merged/],
    ["ff failure", { syncMain: () => false }, "sync-main", /fast-forward/],
    ["consistency gate", { consistencyGate: () => false }, "consistency-gate", /no waiver path/],
  ];
  for (const [name, over, atStep, reason] of aborts) {
    it(`aborts fail-loud at ${name} with no partial release`, async () => {
      const { deps, writes } = fakeDeps(over);
      const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
      expect(res.status).toBe("aborted");
      expect(res.step).toBe(atStep);
      expect(res.reason).toMatch(reason);
      expect(writes.some((w) => w.startsWith("tag:") || w.startsWith("pushTag:"))).toBe(false); // never a stray tag
    });
  }

  it("tag race after the gate still aborts before pushing", async () => {
    let calls = 0;
    const { deps, writes } = fakeDeps({ tagExists: () => calls++ > 0 }); // free at plan, taken at tag-push
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("aborted");
    expect(res.step).toBe("tag-push");
    expect(writes.some((w) => w.startsWith("pushTag:"))).toBe(false);
  });

  // FIX-368 — Part 2: the release records itself as a fact AFTER the irreversible
  // tag-push, append-only + best-effort, never blocking/altering the release.
  it("FIX-368: records a release fact strictly AFTER pushing the tag", async () => {
    const order: string[] = [];
    const { deps } = fakeDeps({
      pushTag: (_c, t2) => void order.push(`pushTag:${t2}`),
      recordReleaseFact: (_c, t2) => void order.push(`recordReleaseFact:${t2}`),
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("released");
    // The fact is recorded only after the tag is pushed, and for the same tag.
    expect(order).toEqual(["pushTag:v3.613.1", "recordReleaseFact:v3.613.1"]);
  });

  it("FIX-368: a throwing release-fact recorder NEVER turns a completed release into an abort", async () => {
    let recorded = false;
    const { deps } = fakeDeps({
      recordReleaseFact: () => {
        recorded = true;
        throw new Error("disk full — events.ndjson append failed");
      },
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(recorded).toBe(true); // it was attempted
    expect(res.status).toBe("released"); // …and the release still completed
    expect(res.tag).toBe("v3.613.1");
  });

  it("FIX-368: the release-fact recorder is NOT called when the flow aborts before tag-push", async () => {
    let called = false;
    const { deps } = fakeDeps({
      consistencyGate: () => false,
      recordReleaseFact: () => void (called = true),
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("aborted");
    expect(called).toBe(false);
  });

  it("dry-run computes the plan and mutates NOTHING", async () => {
    const { deps, writes } = fakeDeps();
    const res = await runReleaseFlow("/repo", deps, { dryRun: true, yes: true });
    expect(res.status).toBe("dry-run");
    expect(writes).toEqual([]);
  });

  it("declined confirm aborts before any mutation", async () => {
    const { deps, writes } = fakeDeps({ confirm: () => false });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: false });
    expect(res.status).toBe("aborted");
    expect(writes).toEqual([]);
  });
});

describe("removed routes — AC2: the old surface is gone, not redirected", () => {
  // US-DOSSIER-036: `consistency` is RESTORED as a public sub-route (the
  // verdict-first six-dim table), so it is no longer in the removed set; the
  // others (ship/waiver/changelog/tag) still die through the unknown-route error.
  for (const route of ["ship", "waiver", "changelog", "tag"]) {
    it(`roll release ${route} exits non-zero through the unknown-route error`, async () => {
      let err = "";
      const se = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
      try {
        expect(await releaseCommand([route])).toBe(1);
      } finally {
        process.stderr.write = se;
      }
      expect(err).toContain("removed");
      expect(err).toContain("roll release");
    });
  }
});

describe("US-SHOW-001 — release offers the golden-path showcase (recommended, non-blocking)", () => {
  it("a successful dry-run prints the showcase pointer (no --showcase flag → just a pointer)", async () => {
    const { deps } = fakeDeps();
    let out = "";
    const so = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      // depsOverride goes via runReleaseFlow inside releaseCommand; dry-run keeps it side-effect free.
      const code = await releaseCommand(["--dry-run", "--yes"], deps);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = so;
    }
    expect(out.toLowerCase()).toContain("roll showcase");
  });

  it("--showcase is advertised in the release usage", async () => {
    let out = "";
    const so = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      await releaseCommand(["--help"]);
    } finally {
      process.stdout.write = so;
    }
    expect(out).toContain("--showcase");
  });
});

describe("cleanup guard — AC8: no active source re-advertises the removed surface", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  // US-DOSSIER-036: `roll release consistency check` is a RESTORED public
  // command (it lands the design's six-dim gate chip), so it is intentionally
  // NOT banned — the removed surfaces are ship/waiver/changelog only.
  const BANNED = [/roll release ship/, /roll release waiver/, /roll release changelog/, /releaseShipCommand/, /releaseWaiverCommand/];
  const scan = (dir: string, hits: string[]): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === "node_modules" || e === "dist" || e === ".git" || e === ".roll" || e === "skills") continue;
      const st = statSync(p);
      if (st.isDirectory()) scan(p, hits);
      else if (/\.(ts|md|yml)$/.test(e) && !p.includes(join("cli", "test")) && e !== "catalog.generated.json") {
        const text = readFileSync(p, "utf8");
        for (const re of BANNED) if (re.test(text)) hits.push(`${p}: ${re}`);
      }
    }
  };
  it("source, docs, workflows are clean of the removed command strings", () => {
    const hits: string[] = [];
    for (const sub of ["packages/cli/src", "packages/core/src", "packages/spec/src", "guide", ".github", "docs"]) {
      scan(join(ROOT, sub), hits);
    }
    const readme = readFileSync(join(ROOT, "README.md"), "utf8") + readFileSync(join(ROOT, "README_CN.md"), "utf8");
    for (const re of BANNED) expect(readme).not.toMatch(re);
    expect(hits).toEqual([]);
  });
});

describe("FIX-277 — throwing dependencies become orderly aborts", () => {
  it("a hook-blocked commit aborts at commit-push with the hook's reason, no raw throw", async () => {
    const { deps, writes } = fakeDeps({
      commitPush: () => {
        throw new Error("✗ Commit blocked: tests not verified on current code.");
      },
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("aborted");
    expect(res.step).toBe("commit-push");
    expect(res.reason).toContain("Commit blocked");
    expect(writes.some((w) => w.startsWith("tag:"))).toBe(false);
  });

  it("a throwing tag push still reports tag-push, never an unhandled rejection", async () => {
    const { deps } = fakeDeps({
      pushTag: () => {
        throw new Error("network down");
      },
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("aborted");
    expect(res.step).toBe("tag-push");
    expect(res.reason).toContain("network down");
  });
});

describe("FIX-277 review fixes — gate-aware commitPush helper and step marks", () => {
  function fakeExec() {
    const calls = [];
    const cwd = join(tmpdir(), `roll-release-test-${randomUUID()}`);
    const tree = "deadbeef1234567890abcdef1234567890abcdef";
    return {
      calls,
      cwd,
      tree,
      exec: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${cwd}\n`;
        if (cmd === "git" && args[0] === "write-tree") return `${tree}\n`;
        if (cmd === "git" && args[0] === "rev-parse") return "main\n";
        return "";
      },
      cleanup: () => {
        try {
          rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* ignore cleanup failures */
        }
      },
    };
  }

  it("roll-managed repo refreshes the test proof BEFORE committing — no error-message sniffing", () => {
    const { calls, exec, cleanup } = fakeExec();
    try {
      commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec });
      const testIdx = calls.findIndex((c) => c === "roll test");
      const commitIdx = calls.findIndex((c) => c.startsWith("git commit"));
      expect(testIdx).toBeGreaterThan(-1);
      expect(commitIdx).toBeGreaterThan(testIdx);
    } finally {
      cleanup();
    }
  });

  it("non-roll repo never runs roll test", () => {
    const { calls, exec, cleanup } = fakeExec();
    try {
      commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: false, exec });
      expect(calls.some((c) => c.startsWith("roll "))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("a failing commit rolls the release branch back (no stray local branch) and rethrows", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (cmd === "git" && args[0] === "rev-parse") throw new Error("fatal: Needed a single revision");
      if (cmd === "git" && args[0] === "commit") throw new Error("✗ Commit blocked by hook");
      return "";
    };
    expect(() => commitPushWithGate({ branch: "release/v1", message: "m", rollManaged: false, exec })).toThrow(
      "Commit blocked",
    );
    expect(calls).toContain("git checkout main");
    expect(calls).toContain("git branch -D release/v1");
    expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
  });

  it("throwing waitMerged / syncMain / consistencyGate abort at their OWN step", async () => {
    for (const [key, expectedStep] of [
      ["waitMerged", "wait-merge"],
      ["syncMain", "sync-main"],
      ["consistencyGate", "consistency-gate"],
    ]) {
      const { deps } = fakeDeps({
        [key]: () => {
          throw new Error(`${key} exploded`);
        },
      });
      const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
      expect(res.status).toBe("aborted");
      expect(res.step).toBe(expectedStep);
      expect(res.reason).toContain("exploded");
    }
  });
});

// ─── FIX-1207: release --yes must not self-hit the 60s test-proof gate ───────

describe("FIX-1207 — release commit refreshes the test-pass proof", () => {
  function proofExec(staleProof?: { ts: number; tree: string }) {
    const calls: string[][] = [];
    const cwd = join(tmpdir(), `roll-release-test-${randomUUID()}`);
    const tree = "deadbeef1234567890abcdef1234567890abcdef";
    mkdirSync(join(cwd, ".roll"), { recursive: true });
    if (staleProof !== undefined) {
      writeFileSync(
        join(cwd, ".roll", "last-test-pass"),
        JSON.stringify({ ...staleProof, mode: "vitest", scope: "affected" }),
        "utf8",
      );
    }
    const exec = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${cwd}\n`;
      if (cmd === "git" && args[0] === "write-tree") return `${tree}\n`;
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (cmd === "git" && args[0] === "rev-parse") return "main\n";
      return "";
    };
    return {
      calls,
      exec,
      cwd,
      tree,
      cleanup: () => {
        try {
          rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* ignore cleanup failures */
        }
      },
    };
  }

  it("writes a fresh proof after roll test so the commit gate passes", () => {
    const { exec, cwd, tree, cleanup } = proofExec({
      ts: Math.floor(Date.now() / 1000) - 3600,
      tree: "staletree1234567890abcdef1234567890abcdef",
    });
    try {
      commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec });
      const proof = JSON.parse(readFileSync(join(cwd, ".roll", "last-test-pass"), "utf8"));
      expect(proof.tree).toBe(tree);
      expect(proof.mode).toBe("release");
      expect(Math.floor(Date.now() / 1000) - proof.ts).toBeLessThanOrEqual(5);
    } finally {
      cleanup();
    }
  });

  it("aborts cleanly when the staged tree changes after the test (malicious scenario)", () => {
    const { exec, cleanup } = proofExec();
    let writeTreeCalls = 0;
    const execWithTreeFlip = (cmd: string, args: string[]): string => {
      const out = exec(cmd, args);
      if (cmd === "git" && args[0] === "write-tree") {
        writeTreeCalls += 1;
        // First call writes the proof; second call verifies it. Simulate a
        // change between proof-write and commit by returning a different tree.
        return writeTreeCalls === 1 ? "prooftree1234567890abcdef1234567890abc\n" : "differenttree1234567890abcdef1234567890abc\n";
      }
      return out;
    };
    try {
      expect(() =>
        commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec: execWithTreeFlip }),
      ).toThrow("code changed since last test run");
    } finally {
      cleanup();
    }
  });

  it("aborts cleanly when roll test fails before the proof can be refreshed", () => {
    const { exec, cleanup } = proofExec({
      ts: Math.floor(Date.now() / 1000) - 3600,
      tree: "staletree1234567890abcdef1234567890abcdef",
    });
    const execFailingTest = (cmd: string, args: string[]): string => {
      if (cmd === "roll" && args[0] === "test") {
        throw new Error("roll test failed: some suite is red");
      }
      return exec(cmd, args);
    };
    try {
      expect(() =>
        commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec: execFailingTest }),
      ).toThrow("roll test failed");
    } finally {
      cleanup();
    }
  });
});

// ─── FIX-353: open-pr / arm-auto-merge resilient to the transient GraphQL EOF ─
//
// v3.617.1 / v3.617.2 BOTH aborted at open-pr on `Post ".../graphql": EOF` and
// had to be finished by hand via the REST API. These cover the retry+REST path.

/** A fake `gh` runner scripted by argv shape, recording every call. */
function fakeGh(
  script: (args: string[], n: number) => { code: number; stdout: string; stderr: string },
): { gh: (args: string[]) => { code: number; stdout: string; stderr: string }; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args) => {
      calls.push(args);
      return script(args, calls.length);
    },
  };
}

describe("openPrResilient — FIX-353 transient EOF → retry → REST POST fallback", () => {
  const EOF = `Post "https://api.github.com/graphql": EOF`;

  it("gh pr create succeeds first try → returns the PR url (no REST)", () => {
    const { gh, calls } = fakeGh((args) =>
      args.includes("view")
        ? { code: 0, stdout: "", stderr: "" } // no existing PR
        : args.includes("create")
          ? { code: 0, stdout: "https://github.com/o/r/pull/10\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "unexpected" },
    );
    const url = openPrResilient({ cwd: "/repo", branch: "release/v1", title: "Release: v1", body: "b", gh, slug: () => "o/r" });
    expect(url).toBe("https://github.com/o/r/pull/10");
    expect(calls.filter((c) => c.includes("view")).length).toBe(1);
    expect(calls.filter((c) => c.includes("create")).length).toBe(1);
    expect(calls.find((c) => c[0] === "api")).toBeUndefined();
  });

  it("FIX-330 AC1: an existing open PR is reused instead of creating a duplicate", () => {
    const { gh, calls } = fakeGh((args) =>
      args.includes("view")
        ? { code: 0, stdout: "https://github.com/o/r/pull/7\n", stderr: "" }
        : { code: 0, stdout: "https://github.com/o/r/pull/99\n", stderr: "" },
    );
    const url = openPrResilient({ cwd: "/repo", branch: "release/v1", title: "Release: v1", body: "b", gh, slug: () => "o/r" });
    expect(url).toBe("https://github.com/o/r/pull/7");
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("gh pr create EOFs every attempt → REST POST creates the PR", () => {
    const { gh, calls } = fakeGh((args) => {
      if (args.includes("view")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("create") && !args.includes("api")) return { code: 1, stdout: "", stderr: EOF };
      if (args[0] === "api") return { code: 0, stdout: "https://github.com/o/r/pull/20\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "?" };
    });
    const url = openPrResilient({ cwd: "/repo", branch: "release/v1", title: "Release: v1", body: "b", gh, slug: () => "o/r" });
    expect(url).toBe("https://github.com/o/r/pull/20");
    // 3 gh-create attempts (first + 2 retries) + 1 REST POST.
    expect(calls.filter((c) => c.includes("create") && c[0] !== "api").length).toBe(3);
    const rest = calls.find((c) => c[0] === "api");
    expect(rest).toEqual([
      "api", "--method", "POST", "repos/o/r/pulls",
      "-f", "title=Release: v1", "-f", "head=release/v1", "-f", "base=main", "-f", "body=b",
      "--jq", ".html_url",
    ]);
  });

  it("a REAL 4xx create error → throws, NO retry, NO REST fallback", () => {
    const { gh, calls } = fakeGh((args) =>
      args.includes("view")
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "HTTP 422: Validation Failed" },
    );
    expect(() => openPrResilient({ cwd: "/repo", branch: "b", title: "t", body: "x", gh, slug: () => "o/r" })).toThrow(/gh pr create failed/);
    expect(calls.filter((c) => c.includes("view")).length).toBe(1);
    expect(calls.filter((c) => c.includes("create")).length).toBe(1);
    expect(calls.find((c) => c[0] === "api")).toBeUndefined();
  });
});

describe("enableAutoMergeResilient — FIX-353 transient EOF → retry → REST PUT merge", () => {
  const EOF = `Post "https://api.github.com/graphql": EOF`;

  it("gh pr merge --auto succeeds first try → no REST", () => {
    const { gh, calls } = fakeGh((args) =>
      args.includes("autoMergeRequest")
        ? { code: 0, stdout: "null\n", stderr: "" } // not yet armed
        : { code: 0, stdout: "", stderr: "" },
    );
    expect(() => enableAutoMergeResilient({ cwd: "/repo", prRef: "https://github.com/o/r/pull/5", gh, slug: () => "o/r" })).not.toThrow();
    expect(calls.filter((c) => c.includes("autoMergeRequest")).length).toBe(1);
    expect(calls.filter((c) => c.includes("merge") && c[0] !== "api").length).toBe(1);
  });

  it("FIX-330 AC2: already armed → no merge call (idempotent)", () => {
    const { gh, calls } = fakeGh((args) =>
      args.includes("autoMergeRequest")
        ? { code: 0, stdout: "SCHEDULED\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    expect(() => enableAutoMergeResilient({ cwd: "/repo", prRef: "https://github.com/o/r/pull/5", gh, slug: () => "o/r" })).not.toThrow();
    expect(calls.some((c) => c.includes("merge"))).toBe(false);
  });

  it("gh pr merge EOFs → REST PUT …/pulls/N/merge fallback (sha not pinned here)", () => {
    const { gh, calls } = fakeGh((args) => {
      if (args.includes("autoMergeRequest")) return { code: 0, stdout: "null\n", stderr: "" };
      if (args.includes("merge") && args[0] !== "api") return { code: 1, stdout: "", stderr: EOF };
      if (args[0] === "api") return { code: 0, stdout: "true\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "?" };
    });
    expect(() => enableAutoMergeResilient({ cwd: "/repo", prRef: "https://github.com/o/r/pull/42", gh, slug: () => "o/r" })).not.toThrow();
    expect(calls.filter((c) => c.includes("merge") && c[0] !== "api").length).toBe(3);
    expect(calls.find((c) => c[0] === "api")).toEqual([
      "api", "--method", "PUT", "repos/o/r/pulls/42/merge",
      "-f", "merge_method=squash", "--jq", ".merged",
    ]);
  });

  it("REST 405 (checks not green) → does NOT throw (wait loop + GitHub finish it)", () => {
    const { gh } = fakeGh((args) => {
      if (args.includes("autoMergeRequest")) return { code: 0, stdout: "null\n", stderr: "" };
      if (args.includes("merge") && args[0] !== "api") return { code: 1, stdout: "", stderr: EOF };
      if (args[0] === "api") return { code: 1, stdout: "", stderr: "HTTP 405: Method Not Allowed (required status checks pending)" };
      return { code: 1, stdout: "", stderr: "?" };
    });
    // Branch protection still gates: REST returns 405 until green; we leave the PR
    // for the wait loop instead of force-merging or hanging.
    expect(() => enableAutoMergeResilient({ cwd: "/repo", prRef: "https://github.com/o/r/pull/9", gh, slug: () => "o/r" })).not.toThrow();
  });

  it("auto-merge genuinely disabled (non-transient) → actionable throw", () => {
    const { gh, calls } = fakeGh((args) =>
      args.includes("autoMergeRequest")
        ? { code: 0, stdout: "null\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "auto-merge is not allowed for this repository" },
    );
    expect(() => enableAutoMergeResilient({ cwd: "/repo", prRef: "https://github.com/o/r/pull/3", gh, slug: () => "o/r" })).toThrow(/Allow auto-?merge/i);
    expect(calls.filter((c) => c.includes("autoMergeRequest")).length).toBe(1);
    expect(calls.filter((c) => c.includes("merge")).length).toBe(1); // not transient → no retry
  });
});

describe("FIX-330 — release transaction is re-runnable and self-healing", () => {
  function withRealReleaseRepository(
    run: (repo: string, git: (args: string[]) => string) => void,
  ): void {
    const root = join(tmpdir(), `roll-release-retry-${randomUUID()}`);
    const repo = join(root, "repo");
    const remote = join(root, "origin.git");
    const git = (args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    mkdirSync(repo, { recursive: true });
    try {
      git(["init", "-b", "main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Roll test"]);
      writeFileSync(join(repo, "package.json"), '{"version":"1.0.0"}\n');
      writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- release note\n");
      git(["add", "package.json", "CHANGELOG.md"]);
      git(["commit", "-m", "base"]);
      execFileSync("git", ["init", "--bare", remote], { encoding: "utf8" });
      git(["remote", "add", "origin", remote]);
      git(["push", "-u", "origin", "main"]);

      git(["checkout", "-b", "release/v1"]);
      writeFileSync(join(repo, "package.json"), '{"version":"1.0.1"}\n');
      writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## v1.0.1\n\n- release note\n");
      git(["add", "package.json", "CHANGELOG.md"]);
      git(["commit", "-m", "Release: v1"]);
      git(["push", "-u", "origin", "release/v1"]);
      git(["checkout", "main"]);

      writeFileSync(join(repo, "package.json"), '{"version":"1.0.1"}\n');
      writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## v1.0.1\n\n- release note\n");
      run(repo, git);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function realGitExec(repo: string): (cmd: string, args: string[]) => string {
    return (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  }

  it("FIX-1472 reuses an existing local release branch after release preparation in a real Git worktree", () => {
    withRealReleaseRepository((repo, git) => {
      expect(() =>
        commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: false, exec: realGitExec(repo) }),
      ).not.toThrow();
      expect(git(["branch", "--show-current"]).trim()).toBe("release/v1");
      expect(git(["status", "--porcelain"])).toBe("");
    });
  });

  it("FIX-1472 fetches and reuses an existing remote release branch after release preparation in a real Git worktree", () => {
    withRealReleaseRepository((repo, git) => {
      git(["branch", "-D", "release/v1"]);
      expect(() =>
        commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: false, exec: realGitExec(repo) }),
      ).not.toThrow();
      expect(git(["branch", "--show-current"]).trim()).toBe("release/v1");
      expect(git(["status", "--porcelain"])).toBe("");
    });
  });

  it("FIX-1472 rejects unrelated worktree changes without switching or hiding them", () => {
    withRealReleaseRepository((repo, git) => {
      writeFileSync(join(repo, "notes.txt"), "keep me\n");
      expect(() =>
        commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: false, exec: realGitExec(repo) }),
      ).toThrow(/unexpected worktree changes/i);
      expect(git(["branch", "--show-current"]).trim()).toBe("main");
      expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("keep me\n");
      expect(git(["status", "--porcelain"])).toContain("?? notes.txt");
    });
  });

  /** A scriptable synchronous exec for testing commitPushWithGate. */
  function scriptExec(responses: Record<string, { stdout?: string; throw?: string }>) {
    const calls: string[][] = [];
    const cwd = join(tmpdir(), `roll-release-test-${randomUUID()}`);
    const tree = "deadbeef1234567890abcdef1234567890abcdef";
    const baseResponses: Record<string, { stdout?: string; throw?: string }> = {
      "git rev-parse --show-toplevel": { stdout: `${cwd}\n` },
      "git write-tree": { stdout: `${tree}\n` },
    };
    const exec = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      const key = [cmd, ...args].join(" ");
      const r = responses[key] ?? baseResponses[key];
      if (r?.throw !== undefined) throw new Error(r.throw);
      return r?.stdout ?? "";
    };
    return {
      calls,
      exec,
      cleanup: () => {
        try {
          rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* ignore cleanup failures */
        }
      },
    };
  }

  it("commitPushWithGate reuses an existing local release branch", () => {
    const { calls, exec, cleanup } = scriptExec({
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "git rev-parse --verify refs/heads/release/v1": { stdout: "abc123\n" },
      "git checkout release/v1": { stdout: "" },
      "git add package.json CHANGELOG.md": { stdout: "" },
      "git log release/v1 --grep Release: v1 --oneline -n 1": { stdout: "" },
      "roll test": { stdout: "" },
      "git commit -m Release: v1": { stdout: "" },
      "git push -u origin release/v1": { stdout: "" },
    });
    try {
      commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec });
      expect(calls.some((c) => c.join(" ") === "git checkout -b release/v1")).toBe(false);
      expect(calls.some((c) => c.join(" ") === "git checkout release/v1")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("commitPushWithGate skips commit when the release commit already exists", () => {
    const { calls, exec, cleanup } = scriptExec({
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "git rev-parse --verify refs/heads/release/v1": { stdout: "abc123\n" },
      "git checkout release/v1": { stdout: "" },
      "git add package.json CHANGELOG.md": { stdout: "" },
      "git log release/v1 --grep Release: v1 --oneline -n 1": { stdout: "abc123 Release: v1\n" },
      "git push -u origin release/v1": { stdout: "" },
    });
    try {
      commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec });
      expect(calls.some((c) => c[0] === "roll" && c[1] === "test")).toBe(false);
      expect(calls.some((c) => c[0] === "git" && c[1] === "commit")).toBe(false);
      expect(calls.some((c) => c.join(" ") === "git push -u origin release/v1")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("commitPushWithGate fetches and reuses an existing remote release branch", () => {
    const { calls, exec, cleanup } = scriptExec({
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "git rev-parse --verify refs/heads/release/v1": { throw: "fatal: Needed a single revision" },
      "git ls-remote --heads origin release/v1": { stdout: "abc123\trefs/heads/release/v1\n" },
      "git fetch origin release/v1:release/v1": { stdout: "" },
      "git checkout release/v1": { stdout: "" },
      "git add package.json CHANGELOG.md": { stdout: "" },
      "git log release/v1 --grep Release: v1 --oneline -n 1": { stdout: "" },
      "roll test": { stdout: "" },
      "git commit -m Release: v1": { stdout: "" },
      "git push -u origin release/v1": { stdout: "" },
    });
    try {
      commitPushWithGate({ branch: "release/v1", message: "Release: v1", rollManaged: true, exec });
      expect(calls.some((c) => c.join(" ") === "git checkout -b release/v1")).toBe(false);
      expect(calls.some((c) => c.join(" ") === "git fetch origin release/v1:release/v1")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("runReleaseFlow reaches released even when the branch/PR are reused leftovers", async () => {
    // Simulate a resumed transaction: the bump+changelog are already committed
    // and pushed, the PR is already open and armed, and GitHub has merged it.
    const { deps, steps } = fakeDeps({
      commitPush: (_c, b) => {
        // no-op idempotent reuse
      },
      openPr: () => "https://github.com/x/y/pull/1",
      enableAutoMerge: (_c, pr) => {
        // no-op: already armed / merged while resuming
      },
      waitMerged: () => true,
    });
    const res = await runReleaseFlow("/repo", deps, { dryRun: false, yes: true });
    expect(res.status).toBe("released");
    expect(steps.at(-1)).toBe("tag-push");
  });
});

describe("FIX-1030 — roll release --json reports real changelog readiness", () => {
  it("reports changelogReady=true when Unreleased has bullet entries", async () => {
    const { deps } = fakeDeps({ readChangelog: () => "# C\n\n## Unreleased\n\n- thing one\n" });
    let out = "";
    const so = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      const code = await releaseCommand(["--json"], deps);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = so;
    }
    const parsed = JSON.parse(out);
    expect(parsed.changelogReady).toBe(true);
  });

  it("reports changelogReady=true when the next-version section is already folded", async () => {
    const { deps } = fakeDeps({ readChangelog: () => "# C\n\n## v3.613.1 — 2026-06-13\n\n- prewritten\n" });
    let out = "";
    const so = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      const code = await releaseCommand(["--json"], deps);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = so;
    }
    const parsed = JSON.parse(out);
    expect(parsed.nextVersion).toBe("3.613.1");
    expect(parsed.changelogReady).toBe(true);
  });

  it("reports changelogReady=false when Unreleased is empty", async () => {
    const { deps } = fakeDeps({ readChangelog: () => "# C\n\n## Unreleased\n\n## v1 — d\n\n- old\n" });
    let out = "";
    const so = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      const code = await releaseCommand(["--json"], deps);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = so;
    }
    const parsed = JSON.parse(out);
    expect(parsed.changelogReady).toBe(false);
  });

  it("reports changelogReady=false when changelog is unreadable", async () => {
    const { deps } = fakeDeps({ readChangelog: () => { throw new Error("ENOENT"); } });
    let out = "";
    const so = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      const code = await releaseCommand(["--json"], deps);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = so;
    }
    const parsed = JSON.parse(out);
    expect(parsed.changelogReady).toBe(false);
  });
});
