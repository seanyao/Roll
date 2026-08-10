/**
 * FIX-1475 — the supervised loop path must NEVER move the shared `main` ref.
 *
 * Root cause: `quarantineAhead` (main-checkout-guard) and `rescueLeakedMain`
 * (sandbox-boundary) isolated local ahead commits by `git reset --hard
 * origin/main` on the SHARED main checkout — breaking that checkout and any
 * concurrent dispatch that depends on it. The cycle worktree (created from
 * `origin/main` by create_worktree) is already the isolation boundary, so the
 * shared checkout never needs to be touched: pre-existing local ahead commits
 * are preserved byte-identically, and the cycle never sees them as its base.
 *
 * These are real-git regression tests (fixture style mirrors
 * us-qa-016-fault-matrix.test.ts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RouteDeps } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import {
  type AgentSpawn,
  type AgentSpawnResult,
  type Ports,
  type RunnerPaths,
  nodePorts,
  runCycleOnce,
} from "../src/runner/index.js";
import { rescueLeakedMain } from "../src/runner/sandbox-boundary.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `roll-fix1475-${tag}-`)));
  dirs.push(d);
  return d;
}

const GIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readEvents(path: string): RollEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RollEvent);
}

const BACKLOG = [
  "| ID | Description | Status |",
  "|----|-------------|--------|",
  "| US-RUN-001 | FIX-1475 fixture story est_min:5 | 📋 Todo |",
  "",
].join("\n");

function writePeerScore(root: string, storyId: string, cycleId: string): void {
  const dir = join(root, ".roll", "features", "uncategorized", storyId, "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `2026-07-20-roll-build-${storyId}-score.md`),
    [
      "---",
      "skill: roll-build",
      `story: ${storyId}`,
      "score: 8",
      "verdict: good",
      "ts: 2026-07-20T00:00:00Z",
      "scoring: pair",
      "scored-by: pi",
      `session-id: ${cycleId}:score:pi:a1:1780000000`,
      "---",
      "",
      "Peer score for the FIX-1475 fixture.",
    ].join("\n"),
    "utf8",
  );
}

function seedFeatureCard(root: string, storyId: string, cycleId: string): void {
  const storyDir = join(root, ".roll", "features", "uncategorized", storyId);
  mkdirSync(join(storyDir, "latest"), { recursive: true });
  mkdirSync(join(storyDir, "screenshots"), { recursive: true });
  writeFileSync(
    join(storyDir, "spec.md"),
    [
      "---",
      `id: ${storyId}`,
      "screenshot_exempt: QA fixture uses file evidence; no rendered UI surface",
      "---",
      `# ${storyId} — FIX-1475 fixture`,
      "",
      "**AC:**",
      "- [ ] cycle delivers with evidence",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(storyDir, "screenshots", "proof.png"), "png\n", "utf8");
  writeFileSync(
    join(storyDir, "ac-map.json"),
    JSON.stringify([{ ac: `${storyId}:AC1`, status: "pass", evidence: [{ kind: "screenshot", href: "screenshots/proof.png" }] }], null, 2) + "\n",
    "utf8",
  );
  writeFileSync(join(storyDir, "latest", `${storyId}-report.html`), `<html><body>${storyId} report</body></html>\n`, "utf8");
  writePeerScore(root, storyId, cycleId);
}

function makeFixture(tag: string, cycleId: string): { repo: string; remote: string } {
  const remote = tmp(`${tag}-remote`);
  git(remote, ["init", "-q", "--bare", "-b", "main"]);

  const seed = tmp(`${tag}-seed`);
  git(seed, ["clone", "-q", remote, "."]);
  writeFileSync(join(seed, "app.txt"), "base\n", "utf8");
  mkdirSync(join(seed, ".roll"), { recursive: true });
  writeFileSync(join(seed, ".roll", "backlog.md"), BACKLOG, "utf8");
  seedFeatureCard(seed, "US-RUN-001", cycleId);
  git(seed, [...GIT_ID, "add", "-A"]);
  git(seed, [...GIT_ID, "commit", "-q", "-m", "seed fix1475 fixture"]);
  git(seed, ["push", "-q", "origin", "main"]);

  const repo = tmp(`${tag}-repo`);
  git(repo, ["clone", "-q", remote, "."]);
  git(repo, ["fetch", "-q", "origin"]);
  return { repo, remote };
}

function paths(rt: string, cycleId: string): RunnerPaths {
  return {
    eventsPath: join(rt, "events.ndjson"),
    runsPath: join(rt, "runs.jsonl"),
    alertsPath: join(rt, "alerts.log"),
    lockPath: join(rt, "inner.lock"),
    heartbeatPath: join(rt, "heartbeat"),
    worktreePath: join(rt, "worktrees", `cycle-${cycleId}`),
  };
}

const routeDeps: RouteDeps = {
  readSlot: () => "claude-stream",
  firstInstalled: () => "claude-stream",
};

const CLAUDE_STREAM_JSON = [
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 } } }),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 1000 }),
].join("\n");

function fakeGithub(): Ports["github"] {
  return {
    async repoSlug() {
      return "fixture/fix1475";
    },
    async runPublishPlan() {
      return { status: 0, prUrl: "https://example.test/pr/1475", ok: true };
    },
    async prState() {
      return "MERGED";
    },
    async prMergeInfo() {
      return { state: "MERGED", mergedAt: "2026-07-20T00:00:00Z", mergeCommit: "abc123def456" };
    },
    async openPrTitles() {
      return [];
    },
  };
}

describe("FIX-1475 — the supervised path never moves the shared main ref", () => {
  it("AC1/AC2/AC3: a shared checkout with local ahead commits survives a supervised cycle byte-identically, and the cycle runs isolated off origin/main", async () => {
    const cycleId = "20260720-010101-f1475";
    const { repo, remote } = makeFixture("ahead", cycleId);
    const originHead = git(repo, ["rev-parse", "origin/main"]);

    // Pre-existing LOCAL ahead commit on the shared main checkout (unpushed owner WIP).
    writeFileSync(join(repo, "owner-wip.txt"), "owner work in progress\n", "utf8");
    git(repo, [...GIT_ID, "add", "owner-wip.txt"]);
    git(repo, [...GIT_ID, "commit", "-q", "-m", "owner local WIP (unpushed)"]);
    const aheadHead = git(repo, ["rev-parse", "HEAD"]);
    expect(aheadHead).not.toBe(originHead);

    // The shim builder observes its OWN base inside the cycle worktree: it must
    // branch off origin/main and must NOT see the ahead commit as an ancestor.
    // Captured on the FIRST spawn only — later spawns (scorer/peer) run after
    // the builder's own tcr commit, so their HEAD is no longer the base.
    let builderBaseHead = "";
    let builderSawAheadCommit = true;
    const shimAgent: AgentSpawn = async (_agent, opts): Promise<AgentSpawnResult> => {
      if (builderBaseHead === "") {
        builderBaseHead = git(opts.cwd, ["rev-parse", "HEAD"]);
        builderSawAheadCommit =
          spawnSync("git", ["merge-base", "--is-ancestor", aheadHead, "HEAD"], { cwd: opts.cwd }).status === 0;
      }
      const storyId = opts.storyId ?? "US-RUN-001";
      writePeerScore(opts.cwd, storyId, opts.cycleId);
      writeFileSync(join(opts.cwd, "delivered.txt"), `delivered ${storyId}\n`, "utf8");
      git(opts.cwd, [...GIT_ID, "add", "-A"]);
      git(opts.cwd, [...GIT_ID, "commit", "-q", "--no-verify", "-m", `tcr: deliver ${storyId}`]);
      return { stdout: CLAUDE_STREAM_JSON, stderr: "", exitCode: 0, timedOut: false };
    };

    const rt = tmp("ahead-rt");
    const p = paths(rt, cycleId);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const result = await runCycleOnce({
      ports: { ...base, agentSpawn: shimAgent, github: fakeGithub() },
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    // The cycle still ran (and delivered) — isolation did not break dispatch.
    expect(result.ran).toBe(true);
    expect(result.terminal).toBe("published");

    // Isolation: the builder's worktree was based on origin/main and never saw
    // the ahead commit as its own base.
    expect(builderBaseHead).toBe(originHead);
    expect(builderSawAheadCommit).toBe(false);

    // AC1/AC2: the shared main ref and its working tree are byte-identical.
    expect(git(repo, ["rev-parse", "main"])).toBe(aheadHead);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(aheadHead);
    expect(readFileSync(join(repo, "owner-wip.txt"), "utf8")).toBe("owner work in progress\n");
    // The owner's non-`.roll` work is byte-clean. `.roll` is excluded because the
    // loop legitimately tracks status in the tracked working-tree backlog
    // (setup marks In Progress, terminal marks Done) in the in-repo layout — that
    // is by design, not a FIX-1475 leak. The FIX-1475 guarantee is that the main
    // ref never moves and owner work is untouched (asserted above), and that Done
    // lands durably on the REMOTE without moving local main (asserted below).
    expect(git(repo, ["status", "--porcelain", "--", ".", ":(exclude).roll"])).toBe("");

    // No quarantine ref was created for the ahead commits (nothing was moved).
    expect(git(repo, ["branch", "--list", "rescue/*"])).toBe("");
    const events = readEvents(p.eventsPath);
    expect(events.some((e) => e.type === "sandbox:quarantined" && e.reason === "ahead")).toBe(false);

    // FIX-1238 durability (evaluator gap): the flip landed on the REMOTE as a
    // single commit parented on the pre-cycle origin/main tip, whose backlog
    // marks the story Done — and it is NOT on local main (which stayed at the
    // owner's WIP). Read the bare remote directly so we see the pushed object.
    const remoteMain = git(remote, ["rev-parse", "refs/heads/main"]);
    expect(remoteMain).not.toBe(originHead);
    expect(git(remote, ["rev-parse", `${remoteMain}^`])).toBe(originHead);
    const remoteBacklog = git(remote, ["show", `${remoteMain}:.roll/backlog.md`]);
    expect(remoteBacklog).toMatch(/US-RUN-001[^\n]*✅ Done/);
    // The flip is remote-only: local main carries the owner's WIP, not the flip.
    expect(git(repo, ["show", "main:.roll/backlog.md"])).toMatch(/US-RUN-001[^\n]*📋 Todo/);
  });

  it("AC3: a dirty AND ahead main checkout keeps its ahead commits byte-identically; only the dirt is quarantined (US-LOOP-089 semantics preserved)", async () => {
    const cycleId = "20260720-020202-f1475";
    const { repo } = makeFixture("dirtyahead", cycleId);

    writeFileSync(join(repo, "owner-wip.txt"), "owner work in progress\n", "utf8");
    git(repo, [...GIT_ID, "add", "owner-wip.txt"]);
    git(repo, [...GIT_ID, "commit", "-q", "-m", "owner local WIP (unpushed)"]);
    const aheadHead = git(repo, ["rev-parse", "HEAD"]);

    // Pre-existing dirt on the shared checkout (separate from the ahead commit).
    writeFileSync(join(repo, "app.txt"), "dirty owner edit\n", "utf8");

    const shimAgent: AgentSpawn = async (_agent, opts): Promise<AgentSpawnResult> => {
      const storyId = opts.storyId ?? "US-RUN-001";
      writePeerScore(opts.cwd, storyId, opts.cycleId);
      writeFileSync(join(opts.cwd, "delivered.txt"), `delivered ${storyId}\n`, "utf8");
      git(opts.cwd, [...GIT_ID, "add", "-A"]);
      git(opts.cwd, [...GIT_ID, "commit", "-q", "--no-verify", "-m", `tcr: deliver ${storyId}`]);
      return { stdout: CLAUDE_STREAM_JSON, stderr: "", exitCode: 0, timedOut: false };
    };

    const rt = tmp("dirtyahead-rt");
    const p = paths(rt, cycleId);
    const base = nodePorts({ repoCwd: repo, paths: p, skillBody: "deliver", routeDeps });
    const result = await runCycleOnce({
      ports: { ...base, agentSpawn: shimAgent, github: fakeGithub() },
      ctx: { cycleId, branch: `loop/cycle-${cycleId}`, loop: "ci" as never },
    });

    expect(result.terminal).toBe("published");

    // The ahead commit survived the cycle byte-identically (ref + tree).
    expect(git(repo, ["rev-parse", "main"])).toBe(aheadHead);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(aheadHead);
    expect(readFileSync(join(repo, "owner-wip.txt"), "utf8")).toBe("owner work in progress\n");

    // Dirty-quarantine protection semantics are preserved: the dirt did NOT
    // silently leak through the cycle — it was quarantined to a rescue ref.
    const events = readEvents(p.eventsPath);
    const quarantined = events.find((e) => e.type === "sandbox:quarantined");
    expect(quarantined).toMatchObject({ type: "sandbox:quarantined", phase: "pre-spawn", reason: "dirty", files: ["app.txt"] });
    expect(git(repo, ["status", "--porcelain", "--", "app.txt"])).toBe("");
    // The ONLY rescue ref is the dirty quarantine's; nothing reset main.
    const rescueRefs = git(repo, ["branch", "--list", "rescue/*"]);
    expect(rescueRefs).not.toBe("");
  });

  it("rescueLeakedMain bundles the leaked HEAD for audit but never resets the shared main ref", async () => {
    const { repo } = makeFixture("rescue", "c-rescue");
    const originHead = git(repo, ["rev-parse", "origin/main"]);

    writeFileSync(join(repo, "owner-wip.txt"), "owner work in progress\n", "utf8");
    git(repo, [...GIT_ID, "add", "owner-wip.txt"]);
    git(repo, [...GIT_ID, "commit", "-q", "-m", "owner local WIP (unpushed)"]);
    const aheadHead = git(repo, ["rev-parse", "HEAD"]);

    const res = await rescueLeakedMain(repo, "rescue/leaked-FIX-1475");

    expect(res.code).toBe(0);
    expect(res.rescuedSha).toBe(aheadHead);
    // The shared main ref did NOT move — before/after byte-identical.
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(aheadHead);
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(originHead);
    expect(readFileSync(join(repo, "owner-wip.txt"), "utf8")).toBe("owner work in progress\n");
    expect(git(repo, ["status", "--porcelain", "--", ".", ":(exclude).roll"])).toBe("");
    // US-LOOP-095 audit bundle still holds the ahead SHA (recoverable evidence).
    const bundlePath = join(repo, ".roll", "loop", "quarantine", "rescue-leaked-FIX-1475.bundle");
    expect(existsSync(bundlePath)).toBe(true);
    expect(git(repo, ["bundle", "list-heads", bundlePath])).toContain(aheadHead);
    expect(git(repo, ["branch", "--list", "rescue/*"])).toBe("");
  });
});
