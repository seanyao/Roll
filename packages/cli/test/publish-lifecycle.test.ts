/**
 * US-RULE-004b — the publish-gate doc-drift check in publish-lifecycle.ts.
 *
 * What these tests guard (the observable contract, not the internals):
 *   - the gate's baseline is the cycle's INTEGRATION BASE (a `base...HEAD`
 *     three-dot delivery diff), never `HEAD~1` — a multi-commit cycle would
 *     silently under-report against HEAD~1;
 *   - in `gates.doc_drift: soft` a hit records the shared stable
 *     `doc_drift_soft_hit` fact exactly once, prints the bilingual
 *     catalogued diagnostic, and NEVER blocks the publish (blocked is always
 *     false; the terminal publish_pr path continues with exit 0);
 *   - registry parse failure / missing integration base / diff acquisition
 *     failure is FAIL-LOUD (mode "unresolved" + ALERT) — an unknown drift
 *     state is never collapsed into a green "no drift";
 *   - retry/re-entry of the same publish attempt is idempotent (one record).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEventLine, parseRulesRegistry, type Lang, type Result, type RulesParseError, type RulesRegistry } from "@roll/spec";
import type { CycleContext, EventStore } from "@roll/core";
import type { Ports } from "../src/runner/ports.js";
import { executeCommand } from "../src/runner/executor.js";
import {
  defaultChangedPathsAgainstBase,
  runPublishDocDriftGate,
  type ChangedPathsResult,
  type PublishDocDriftGateResult,
} from "../src/runner/publish-lifecycle.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const REGISTRY_SOFT = `version: 1
gates:
  doc_drift: soft
rules:
  - id: RL-TEST-001
    kind: redline
    statement: test redline
    enforcement:
      - point: packages/cli/src/runner/test-gate.ts
        marker: "RL-TEST-001"
    verification:
      test: packages/cli/test/test-gate.test.ts
      marker: "RL-TEST-001"
    trigger_report: ALERT
doc_surfaces:
  - id: DS-ATTEST
    paths:
      - "packages/core/src/attest/**"
      - "packages/cli/src/runner/attest-gate.ts"
    docs:
      - "docs/verification.md"
      - "guide/en/acceptance-evidence.md"
      - "guide/zh/acceptance-evidence.md"
`;

/** In-memory EventStore fake — observe append discipline without touching disk. */
function memStore(initial?: Record<string, string>): EventStore & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    files,
    exists: (p) => files.has(p),
    ensureFile: (p) => {
      if (!files.has(p)) files.set(p, "");
    },
    readText: (p) => files.get(p) ?? "",
    appendLine: (p, line) => files.set(p, (files.get(p) ?? "") + line),
    writeText: (p, data) => files.set(p, data),
    size: (p) => (files.get(p) ?? "").length,
  };
}

function fakePorts(over: Partial<Ports> = {}): { ports: Ports; alerts: string[] } {
  const alerts: string[] = [];
  const ports = {
    repoCwd: "/repo",
    paths: {
      eventsPath: "/rt/events.ndjson",
      runsPath: "/rt/runs.jsonl",
      alertsPath: "/rt/alerts.log",
      lockPath: "/rt/inner.lock",
      heartbeatPath: "/rt/heartbeat",
      worktreePath: "/rt/wt",
    },
    skillBody: "work",
    clock: () => 42,
    events: {
      ensureEventFiles: vi.fn(),
      appendEvent: vi.fn(),
      upsertRun: vi.fn(),
      appendAlert: vi.fn((_path: string, msg: string) => alerts.push(msg)),
    },
    ...over,
  } as unknown as Ports;
  return { ports, alerts };
}

function makeCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  return {
    cycleId: "cycle-20260801-000000-1",
    branch: "loop/cycle-20260801-000000-1",
    loop: "ci" as never,
    storyId: "US-RULE-004b",
    agent: "test-agent",
    model: "",
    startSec: 1,
    ...overrides,
  } as CycleContext;
}

function runGate(over: {
  ports?: Ports;
  ctx?: Partial<CycleContext>;
  changedPaths?: ChangedPathsResult;
  registry?: Result<RulesRegistry, RulesParseError> | undefined;
  lang?: Lang;
  eventsPath?: string;
  store?: EventStore;
  ts?: number;
  stdout?: (s: string) => void;
}): { result: PublishDocDriftGateResult; alerts: string[]; store: EventStore; printed: string[] } {
  const printed: string[] = [];
  const { ports, alerts } = fakePorts(over.ports);
  const store = over.store ?? memStore();
  const stdout = over.stdout ?? ((s: string) => printed.push(s));
  const result = runPublishDocDriftGate(ports, makeCtx(over.ctx), {
    ...(over.lang !== undefined ? { lang: over.lang } : {}),
    eventsPath: over.eventsPath ?? "/ev.ndjson",
    store, // always in-memory — never touch the real event store in tests
    ...(over.ts !== undefined ? { ts: over.ts } : {}),
    stdout,
    ...(over.changedPaths !== undefined
      ? { changedPaths: () => over.changedPaths as ChangedPathsResult }
      : {}),
    ...(over.registry !== undefined
      ? { registry: () => over.registry as Result<RulesRegistry, RulesParseError> | undefined }
      : {}),
  });
  return { result, alerts, store, printed };
}

// ── gate-level: clean / hit / documented / failure / retry ───────────────────

describe("runPublishDocDriftGate — clean verdict", () => {
  it("reports clean when no changed path matches a declared source surface", () => {
    const { result, alerts, store } = runGate({
      changedPaths: { ok: true, paths: ["site/index.html", "README.md"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
    });
    expect(result.mode).toBe("clean");
    expect(result.blocked).toBe(false);
    expect(result.appended).toBe(false);
    expect(result.output).toBe("");
    expect(result.baseline).toBe("origin/main"); // integration base, not HEAD~1
    expect(result.changedPaths).toEqual(["site/index.html", "README.md"]);
    expect(alerts).toEqual([]);
    expect(store.files.get("/ev.ndjson") ?? "").toBe("");
  });
});

describe("runPublishDocDriftGate — soft hit (never blocks)", () => {
  it("records exactly one stable soft-hit event and prints the diagnostic (en)", () => {
    const { result, store, printed } = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
      lang: "en",
    });
    expect(result.mode).toBe("hit");
    expect(result.blocked).toBe(false); // soft NEVER blocks delivery
    expect(result.appended).toBe(true);
    expect(result.hitId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.output).toMatchSnapshot();
    expect(printed).toEqual([result.output]); // the diagnostic was printed
    const lines = (store.files.get("/ev.ndjson") ?? "").trim().split("\n");
    expect(lines).toHaveLength(1);
    const ev = parseEventLine(lines[0] ?? "");
    expect(ev).toMatchObject({
      type: "doc_drift_soft_hit",
      hitId: result.hitId,
      cycleId: "cycle-20260801-000000-1",
      storyId: "US-RULE-004b",
      baseline: "origin/main",
      surfaces: ["DS-ATTEST"],
    });
  });

  it("prints the same diagnostic in zh (bilingual catalog, single language)", () => {
    const { result } = runGate({
      changedPaths: { ok: true, paths: ["packages/cli/src/runner/attest-gate.ts"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
      lang: "zh",
    });
    expect(result.mode).toBe("hit");
    expect(result.blocked).toBe(false);
    expect(result.output).toMatchSnapshot();
  });
});

describe("runPublishDocDriftGate — documented clears the hit", () => {
  it("changing any declared doc path clears the surface hit (no drift)", () => {
    const { result, store } = runGate({
      changedPaths: {
        ok: true,
        paths: ["packages/core/src/attest/report.ts", "docs/verification.md"],
      },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
    });
    expect(result.mode).toBe("clean");
    expect(result.output).toBe("");
    expect(result.appended).toBe(false);
    expect(store.files.get("/ev.ndjson") ?? "").toBe("");
  });
});

describe("runPublishDocDriftGate — fail-loud unknown, never 'no drift'", () => {
  it("registry parse failure is fail-loud and non-blocking", () => {
    const { result, alerts, store } = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: { ok: false, error: { message: "registry.gates.doc_drift: must be \"soft\" or \"hard\"" } },
      eventsPath: "/ev.ndjson",
    });
    expect(result.mode).toBe("unresolved");
    expect(result.reason).toBe("registry-unresolved");
    expect(result.blocked).toBe(false);
    expect(result.output).toBe("");
    expect(result.changedPaths).toEqual([]);
    expect(alerts.some((a) => a.includes("doc-drift gate") && a.includes("registry-unresolved") && a.includes("UNKNOWN"))).toBe(true);
    expect(alerts.some((a) => a.includes('"no drift"'))).toBe(true);
    expect(store.files.get("/ev.ndjson") ?? "").toBe(""); // no soft-hit fact for an unknown
  });

  it("missing integration base is fail-loud and non-blocking", () => {
    const { result, alerts } = runGate({
      changedPaths: { ok: false, reason: "base-unresolved" },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
    });
    expect(result.mode).toBe("unresolved");
    expect(result.reason).toBe("base-unresolved");
    expect(result.blocked).toBe(false);
    expect(alerts.some((a) => a.includes("base-unresolved"))).toBe(true);
  });

  it("diff acquisition failure is fail-loud and non-blocking", () => {
    const { result, alerts } = runGate({
      changedPaths: { ok: false, reason: "diff-failed" },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
    });
    expect(result.mode).toBe("unresolved");
    expect(result.reason).toBe("diff-failed");
    expect(result.blocked).toBe(false);
    expect(alerts.some((a) => a.includes("diff-failed"))).toBe(true);
  });

  it("a missing/unreadable registry file is fail-loud (default loader returns undefined)", () => {
    const { result, alerts } = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: undefined, // default loader cannot read <worktree>/policy/rules.yaml
      eventsPath: "/ev.ndjson",
    });
    expect(result.mode).toBe("unresolved");
    expect(result.reason).toBe("registry-unresolved");
    expect(alerts.length).toBeGreaterThan(0);
  });
});

describe("runPublishDocDriftGate — retry is idempotent", () => {
  it("re-entering the same publish attempt records no second soft-hit fact", () => {
    const store = memStore();
    const first = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
      store,
    });
    const second = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
      store,
    });
    expect(first.result.appended).toBe(true);
    expect(second.result.hitId).toBe(first.result.hitId);
    expect(second.result.appended).toBe(false); // no duplicate fact
    expect((store.files.get("/ev.ndjson") ?? "").trim().split("\n")).toHaveLength(1);
  });

  it("a pre-existing soft-hit fact for the same hitId is never duplicated", () => {
    const store = memStore();
    const probe = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
      store,
    });
    // second run: same store, same attempt identity → appended false, still one line
    const again = runGate({
      changedPaths: { ok: true, paths: ["packages/core/src/attest/report.ts"] },
      registry: { ok: true, value: parseRegistry(REGISTRY_SOFT) },
      eventsPath: "/ev.ndjson",
      store,
    });
    expect(again.result.appended).toBe(false);
    expect(again.result.hitId).toBe(probe.result.hitId);
    expect((store.files.get("/ev.ndjson") ?? "").trim().split("\n")).toHaveLength(1);
  });
});

// ── baseline proof: integration base, NOT HEAD~1 (real git) ──────────────────

describe("defaultChangedPathsAgainstBase — the cycle baseline is the integration base", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  function gitRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "roll-drift-base-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "roll-test@example.test");
    git(root, "config", "user.name", "Roll Test");
    git(root, "config", "core.hooksPath", "");
    return root;
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  it("diffs the cycle against its integration base (merge-base), including ALL cycle commits — never HEAD~1", () => {
    const root = gitRepo();
    writeFileSync(join(root, "a.txt"), "a1\n");
    writeFileSync(join(root, "b.txt"), "b1\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "base");
    // cycle branch: TWO commits (HEAD~1 alone would see only the last one)
    git(root, "checkout", "-b", "cycle");
    writeFileSync(join(root, "a.txt"), "a2\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "cycle: change a");
    writeFileSync(join(root, "c.txt"), "c\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "cycle: add c");
    // main advances past the fork point
    git(root, "checkout", "main");
    writeFileSync(join(root, "b.txt"), "b2\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "main: change b");
    git(root, "checkout", "cycle");

    const changed = defaultChangedPathsAgainstBase(root, "main");
    expect(changed).toEqual({ ok: true, paths: ["a.txt", "c.txt"] });
    // b.txt is the BASE's own change — the cycle must NOT be blamed for it.
    expect(changed.ok && changed.paths.includes("b.txt")).toBe(false);
  });

  it("fails loud (base-unresolved) when the integration base ref does not exist", () => {
    const root = gitRepo();
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "base");
    const changed = defaultChangedPathsAgainstBase(root, "origin/main");
    expect(changed).toEqual({ ok: false, reason: "base-unresolved" });
  });
});

// ── terminal level: publish_pr continues with exit 0 in soft mode ────────────

describe("publish_pr — the publish-gate doc-drift check never blocks delivery (soft)", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  /** Real-git fixture: root (main repo, in-repo .roll evidence) + wt (the cycle
   *  worktree git repo with an origin/main integration base and a delivery
   *  commit that changes a declared source surface WITHOUT its docs). `localMode`
   *  declares `publish_mode: local` in the project so publish_pr lands the cycle
   *  on the LOCAL integration branch (no push/PR/CI — E3). */
  function initPublishRepo(brokenRegistry: boolean, localMode = false): { root: string; runtimeDir: string } {
    const root = mkdtempSync(join(tmpdir(), "roll-publish-gate-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "roll-test@example.test");
    git(root, "config", "user.name", "Roll Test");
    git(root, "config", "core.hooksPath", "");
    writeFileSync(join(root, "README.md"), "# test\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "init");

    // in-repo evidence artifacts the US-DELIV-004 evidence gate reads from the
    // persistent root (same fixture shape as publish-degraded.test.ts).
    const cardDir = join(root, ".roll", "features", "uncategorized", "FIX-1214");
    const runDir = join(cardDir, "20260605-000000-1");
    mkdirSync(join(cardDir, "latest"), { recursive: true });
    mkdirSync(join(runDir, "latest"), { recursive: true });
    writeFileSync(join(cardDir, "ac-map.json"), JSON.stringify([{ ac: "FIX-1214:AC1", status: "pass" }]));
    writeFileSync(join(cardDir, "latest", "FIX-1214-report.html"), "<html>report</html>\n");
    writeFileSync(join(runDir, "latest", "evidence.json"), "{}\n");

    // the cycle worktree — a real git repo whose HEAD is the delivery commit
    // and whose origin/main is the integration base.
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    git(wt, "init");
    git(wt, "config", "user.email", "roll-test@example.test");
    git(wt, "config", "user.name", "Roll Test");
    git(wt, "config", "core.hooksPath", "");
    mkdirSync(join(wt, "policy"), { recursive: true });
    writeFileSync(join(wt, "README.md"), "# wt\n");
    writeFileSync(join(wt, "policy", "rules.yaml"), brokenRegistry ? "gates: [broken\n" : REGISTRY_SOFT);
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "base");
    git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(wt, "checkout", "-b", "loop/cycle-20260801-000000-1");
    // delivery commit: declared source surface changed, no declared docs.
    mkdirSync(join(wt, "packages", "cli", "src", "runner"), { recursive: true });
    writeFileSync(join(wt, "packages", "cli", "src", "runner", "attest-gate.ts"), "// changed surface\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feat: change declared surface without docs");

    const runtimeDir = join(root, ".roll", "loop");
    mkdirSync(runtimeDir, { recursive: true });
    // E3: local-only delivery — the project declares `publish_mode: local`, so
    // the publish_pr terminal lands on the LOCAL integration branch instead of
    // push→PR→CI. The doc-drift gate must still run exactly once (US-RULE-004b).
    if (localMode) writeFileSync(join(root, ".roll", "local.yaml"), "publish_mode: local\n");
    return { root, runtimeDir };
  }

  function makeTerminalPorts(runtimeDir: string, repoCwd: string): { ports: Ports; alerts: string[] } {
    const alerts: string[] = [];
    const ports = {
      repoCwd,
      paths: {
        eventsPath: join(runtimeDir, "events.ndjson"),
        runsPath: join(runtimeDir, "runs.jsonl"),
        alertsPath: join(runtimeDir, "ALERT.md"),
        lockPath: join(runtimeDir, "inner.lock"),
        heartbeatPath: join(runtimeDir, "heartbeat"),
        worktreePath: join(repoCwd, "wt"),
      },
      clock: () => 42,
      fullVerify: { proofBody: () => '{"ts":42,"tree":"T","mode":"full"}', deliveredTree: () => "T" },
      skillBody: "work",
      github: {
        repoSlug: vi.fn(async () => "o/r"),
        runPublishPlan: vi.fn(async () => ({ status: 0 as const, prUrl: "https://github.com/o/r/pull/1", ok: true })),
        prState: vi.fn(async () => "UNKNOWN"),
        prMergeInfo: vi.fn(async () => undefined),
        openPrTitles: vi.fn(async () => []),
      },
      git: {
        fetchOrigin: vi.fn(async () => ({ fetched: true })),
        worktreeAdd: vi.fn(async () => ({ code: 0 })),
        worktreeSubmoduleInit: vi.fn(async () => ({ code: 0 })),
        worktreeRemove: vi.fn(async () => ({ code: 0 })),
        push: vi.fn(async () => ({ code: 0 })),
        commitsAhead: vi.fn(async () => 1),
        mainAhead: vi.fn(async () => 0),
        rescueLeaked: vi.fn(async () => ({ code: 0, rescuedSha: "" })),
        tcrCount: vi.fn(async () => 1),
        recentCommits: vi.fn(async () => []),
        fetchRemoteBranch: vi.fn(async () => ({ fetched: true })),
        branchMergedIntoMain: vi.fn(async () => false),
        branchCleanlyRebasesOntoMain: vi.fn(async () => true),
        resetWorktreeHard: vi.fn(async () => ({ code: 0 })),
        remoteBranchTip: vi.fn(async () => "cafebabecafebabecafebabecafebabecafebabe"),
        landLocalDelivery: vi.fn(async () => ({
          code: 0,
          sha: "cafebabecafebabecafebabecafebabecafebabe",
          landedBranch: "main",
          method: "fast_forward" as const,
          stderr: "",
        })),
      },
      events: {
        ensureEventFiles: vi.fn(),
        appendEvent: vi.fn(),
        upsertRun: vi.fn(),
        appendAlert: vi.fn((_path: string, msg: string) => alerts.push(msg)),
      },
      process: {
        acquireLock: vi.fn(() => ({ acquired: true, heldByPid: undefined })),
        releaseLock: vi.fn(),
        writeHeartbeat: vi.fn(),
      },
      backlog: { read: vi.fn(() => []) },
      metadata: {
        commit: vi.fn(async () => ({ committed: false, pushed: false, nothingToCommit: true })),
      },
      route: { resolve: vi.fn(() => ({ agent: "claude", model: "" })) },
      evidence: { openFrame: vi.fn(() => join(repoCwd, ".roll", "features", "uncategorized", "FIX-1214", "20260605-000000-1")) },
      capture: { fromMarker: vi.fn(async () => ({ kind: "web", out: "", taken: false })) },
      attest: { render: vi.fn(async () => 0) },
      agentSpawn: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })),
      installedAgents: () => [],
    } as unknown as Ports;
    return { ports, alerts };
  }

  async function publish(ports: Ports): Promise<{ status: number }> {
    const oldGitDir = process.env["GIT_DIR"];
    const oldGitWorkTree = process.env["GIT_WORK_TREE"];
    delete process.env["GIT_DIR"];
    delete process.env["GIT_WORK_TREE"];
    try {
      const r = await executeCommand(
        { kind: "publish_pr", branch: "loop/cycle-20260801-000000-1", docOnly: false },
        ports,
        makeCtx({ storyId: "FIX-1214", cycleId: "20260605-000000-1", branch: "loop/cycle-20260801-000000-1" }),
      );
      const result = (r.event as { result: { status: number } }).result;
      return { status: result.status };
    } finally {
      if (oldGitDir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = oldGitDir;
      if (oldGitWorkTree === undefined) delete process.env["GIT_WORK_TREE"];
      else process.env["GIT_WORK_TREE"] = oldGitWorkTree;
    }
  }

  it("a soft hit is recorded once and publish continues with exit 0 (never blocked)", async () => {
    const { root, runtimeDir } = initPublishRepo(false);
    const { ports, alerts } = makeTerminalPorts(runtimeDir, root);

    const { status } = await publish(ports);

    expect(status).toBe(0); // soft mode NEVER blocks the delivery
    const eventsPath = join(runtimeDir, "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter((l) => l !== "");
    const hits = lines.map((l) => parseEventLine(l)).filter((ev) => ev !== null && ev.type === "doc_drift_soft_hit");
    expect(hits).toHaveLength(1); // exactly one stable soft-hit fact
    expect(hits[0]).toMatchObject({
      type: "doc_drift_soft_hit",
      cycleId: "20260605-000000-1",
      storyId: "FIX-1214",
      baseline: "origin/main", // the integration base, not HEAD~1
      surfaces: ["DS-ATTEST"],
    });
    expect(alerts.some((a) => a.includes("doc-drift gate"))).toBe(false); // a hit is NOT an unknown
  });

  it("a broken registry is fail-loud (ALERT) yet publish still continues with exit 0", async () => {
    const { root, runtimeDir } = initPublishRepo(true);
    const { ports, alerts } = makeTerminalPorts(runtimeDir, root);

    const { status } = await publish(ports);

    expect(status).toBe(0); // unknown state never blocks soft delivery either
    expect(alerts.some((a) => a.includes("doc-drift gate") && a.includes("registry-unresolved") && a.includes("UNKNOWN"))).toBe(true);
    const eventsPath = join(runtimeDir, "events.ndjson");
    expect(existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes("doc_drift_soft_hit")).toBe(false);
  });

  it("local publish runs the doc-drift gate once, records the soft hit, and lands locally (no push/PR)", async () => {
    const { root, runtimeDir } = initPublishRepo(false, true);
    const { ports, alerts } = makeTerminalPorts(runtimeDir, root);

    const { status } = await publish(ports);

    expect(status).toBe(0); // soft mode NEVER blocks a LOCAL delivery either
    // The shared soft-hit fact was recorded by the gate (exactly once), with the
    // cycle's INTEGRATION BASE as the baseline — a local attempt is judged the
    // same way a remote one is.
    const eventsPath = join(runtimeDir, "events.ndjson");
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter((l) => l !== "");
    const hits = lines.map((l) => parseEventLine(l)).filter((ev) => ev !== null && ev.type === "doc_drift_soft_hit");
    expect(hits).toHaveLength(1); // exactly one stable soft-hit fact
    expect(hits[0]).toMatchObject({
      type: "doc_drift_soft_hit",
      cycleId: "20260605-000000-1",
      storyId: "FIX-1214",
      baseline: "origin/main", // the integration base, not HEAD~1
      surfaces: ["DS-ATTEST"],
    });
    expect(alerts.some((a) => a.includes("doc-drift gate"))).toBe(false); // a hit is NOT an unknown
    // The gate ran BEFORE the local landing, and the local publish CONTINUED:
    // the E3 landing executed (delivered_local) with NO remote interaction —
    // no push, no PR plan, no PR opened.
    expect(ports.git.landLocalDelivery).toHaveBeenCalledTimes(1);
    expect(ports.git.push).not.toHaveBeenCalled();
    expect(ports.github.runPublishPlan).not.toHaveBeenCalled();
    const reconciled = (ports.events.appendEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[1])
      .find((e: { type?: string }) => e?.type === "delivery:reconciled");
    expect(reconciled).toMatchObject({ type: "delivery:reconciled", state: "delivered_local" });
  });

  it("local publish with a broken registry is fail-loud (ALERT) yet still lands locally (no push/PR)", async () => {
    const { root, runtimeDir } = initPublishRepo(true, true);
    const { ports, alerts } = makeTerminalPorts(runtimeDir, root);

    const { status } = await publish(ports);

    expect(status).toBe(0); // an unknown drift state never blocks a LOCAL delivery
    // Fail-loud: the unresolved registry is alerted as UNKNOWN, never read as
    // "no drift" — and no soft-hit fact is fabricated.
    expect(alerts.some((a) => a.includes("doc-drift gate") && a.includes("registry-unresolved") && a.includes("UNKNOWN"))).toBe(true);
    const eventsPath = join(runtimeDir, "events.ndjson");
    expect(existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes("doc_drift_soft_hit")).toBe(false);
    // The fail-loud alert did NOT stop the local landing: delivered_local with
    // no push/PR — local publish always continues.
    expect(ports.git.landLocalDelivery).toHaveBeenCalledTimes(1);
    expect(ports.git.push).not.toHaveBeenCalled();
    expect(ports.github.runPublishPlan).not.toHaveBeenCalled();
    const reconciled = (ports.events.appendEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[1])
      .find((e: { type?: string }) => e?.type === "delivery:reconciled");
    expect(reconciled).toMatchObject({ type: "delivery:reconciled", state: "delivered_local" });
  });
});

/** Parse the fixture registry via the strict shared parser. */
function parseRegistry(text: string): RulesRegistry {
  const parsed = parseRulesRegistry(text);
  if (!parsed.ok) throw new Error(`fixture registry invalid: ${parsed.error.message}`);
  return parsed.value;
}
