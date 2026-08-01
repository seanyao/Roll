import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventBus, readLeases } from "@roll/core";
import { allocateSkillDispatchRun, integrateSkillDispatchChild, releaseSkillDispatchReservation, skillDispatchActorForCwd, skillDispatchChangedPaths, skillDispatchScopeAllows } from "../src/runner/skill-dispatch-workspace.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-dispatch-project-"));
  return root;
}

function allocator(root: string) {
  const registered = new Set<string>();
  const add = vi.fn(async (_repo: string, path: string) => {
    registered.add(path);
    return { code: 0 };
  });
  return {
    add,
    deps: {
      now: () => 123,
      base: () => "origin/main",
      facts: async () => ({ baseSha: "b".repeat(40), repositoryId: "github.com/acme/roll" }),
      inspect: async (_repo: string, path: string) => registered.has(path)
        ? { head: "b".repeat(40), repositoryId: "github.com/acme/roll", registered: true }
        : undefined,
      add,
      bootstrap: async () => true,
    },
  };
}

describe("US-LOOP-127 — managed Skill parent/child allocator", () => {
  it("uses the shared atomic Story lease and persists parent plus children in one workspace event", async () => {
    const root = project();
    const fake = allocator(root);
    const result = await allocateSkillDispatchRun({
      projectRoot: root,
      storyId: "US-LOOP-127",
      runId: "dispatch-run-127",
      actions: [
        { actionId: "docs", declaredFileScope: ["docs"] },
        { actionId: "runtime", declaredFileScope: ["packages/cli"] },
      ],
    }, fake.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.members).toEqual([
      expect.objectContaining({ relativeLocator: "dispatch-run-127" }),
      expect.objectContaining({ actionId: "docs", relativeLocator: "dispatch-run-127.children/docs", declaredFileScope: ["docs"] }),
      expect.objectContaining({ actionId: "runtime", relativeLocator: "dispatch-run-127.children/runtime", declaredFileScope: ["packages/cli"] }),
    ]);
    expect(fake.add).toHaveBeenCalledTimes(3);
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toMatchObject({
      source: "skill-dispatch",
      runId: "dispatch-run-127",
    });
    const events = readFileSync(join(root, ".roll", "loop", "events.ndjson"), "utf8");
    expect(events).toContain('"type":"worktree:allocated"');
    expect(events).toContain('"actionId":"docs"');
  });

  it("atomically refuses a competing parent for the same Story before any checkout is added", async () => {
    const root = project();
    const first = allocator(root);
    expect((await allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-first", actions: [{ actionId: "one", declaredFileScope: ["docs"] }],
    }, first.deps)).ok).toBe(true);
    const second = allocator(root);
    await expect(allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-second", actions: [{ actionId: "two", declaredFileScope: ["packages/core"] }],
    }, second.deps)).resolves.toEqual({ ok: false, reason: "parent_reservation_held" });
    expect(second.add).not.toHaveBeenCalled();
  });

  it("fails loud with zero Git effects when the write-ahead lifecycle event cannot be appended", async () => {
    const root = project();
    const fake = allocator(root);
    await expect(allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-event-failure", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    }, {
      ...fake.deps,
      append: () => { throw new Error("events unavailable"); },
    })).resolves.toEqual({ ok: false, reason: "event_write_failed" });
    expect(fake.add).not.toHaveBeenCalled();
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toBeUndefined();
  });

  it("resumes a matching post-Git allocation marker without reclaiming its own Story lease", async () => {
    const root = project();
    const fake = allocator(root);
    let failAllocation = true;
    const append = (path: string, event: Parameters<EventBus["appendEvent"]>[1]): void => {
      if (event.type === "worktree:allocated" && failAllocation) {
        failAllocation = false;
        throw new Error("simulated final event failure");
      }
      new EventBus().appendEvent(path, event);
    };
    const input = {
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-resume", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    };
    await expect(allocateSkillDispatchRun(input, { ...fake.deps, append })).resolves.toEqual({ ok: false, reason: "event_write_failed" });
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toMatchObject({ runId: "dispatch-resume" });
    const addCalls = fake.add.mock.calls.length;
    await expect(allocateSkillDispatchRun(input, { ...fake.deps, append })).resolves.toMatchObject({ ok: true });
    expect(fake.add).toHaveBeenCalledTimes(addCalls);
    expect(readFileSync(join(root, ".roll", "loop", "events.ndjson"), "utf8")).toContain('"type":"worktree:allocated"');
  });

  it("resumes the durable allocation workspace after the integration base advances", async () => {
    const root = project();
    const registered = new Map<string, string>();
    const firstHead = "a".repeat(40);
    const secondHead = "c".repeat(40);
    let movingBase = "origin/main";
    let failAllocation = true;
    const deps = {
      now: () => 123,
      base: () => movingBase,
      facts: async (_root: string, base: string) => ({
        baseSha: base === "origin/main" || base === firstHead ? firstHead : secondHead,
        repositoryId: "github.com/acme/roll",
      }),
      inspect: async (_root: string, path: string) => {
        const head = registered.get(path);
        return head === undefined ? undefined : { head, repositoryId: "github.com/acme/roll", registered: true };
      },
      add: async (_root: string, path: string, _publishRef: string, base: string) => {
        registered.set(path, base === "origin/main" || base === firstHead ? firstHead : secondHead);
        return { code: 0 };
      },
      bootstrap: async () => true,
      append: (path: string, event: Parameters<EventBus["appendEvent"]>[1]): void => {
        if (event.type === "worktree:allocated" && failAllocation) {
          failAllocation = false;
          throw new Error("simulated final event failure");
        }
        new EventBus().appendEvent(path, event);
      },
    };
    const input = {
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-moving-base", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    };
    await expect(allocateSkillDispatchRun(input, deps)).resolves.toEqual({ ok: false, reason: "event_write_failed" });
    movingBase = "origin/new-main";
    await expect(allocateSkillDispatchRun(input, deps)).resolves.toMatchObject({ ok: true });
    const allocation = JSON.parse(readFileSync(join(root, ".roll", "loop", "events.ndjson"), "utf8").trim().split("\n").at(-1)!);
    expect(allocation.workspace.members.map((member: { checkoutRef: { head: string } }) => member.checkoutRef.head)).toEqual([firstHead, firstHead]);
  });

  it("derives the canonical root and refuses a foreign repository identity after Git allocation", async () => {
    const root = project();
    const fake = allocator(root);
    fake.deps.inspect = async (_repo: string, path: string) => fake.add.mock.calls.some((call) => call[1] === path)
      ? { head: "b".repeat(40), repositoryId: "github.com/foreign/repo", registered: true }
      : undefined;
    await expect(allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-foreign", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    }, fake.deps)).resolves.toEqual({ ok: false, reason: "workspace_identity_mismatch" });
    expect(existsSync(join(root, ".roll", "loop", "worktrees", "dispatch-foreign"))).toBe(false);
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toMatchObject({ source: "skill-dispatch" });
  });

  it("denies a child at the actual reservation-release boundary", async () => {
    const root = project();
    const fake = allocator(root);
    const result = await allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-release", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    }, fake.deps);
    if (!result.ok) return;
    const { mkdirSync } = await import("node:fs");
    const parent = result.value.paths["dispatch-release"]!;
    const child = result.value.paths["dispatch-release.children/docs"]!;
    mkdirSync(parent, { recursive: true });
    mkdirSync(child, { recursive: true });
    expect(releaseSkillDispatchReservation(root, "US-LOOP-127", "dispatch-release", child)).toEqual({ ok: false, reason: "parent_required" });
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toBeDefined();
    expect(releaseSkillDispatchReservation(root, "US-LOOP-127", "dispatch-release", parent)).toEqual({ ok: false, reason: "workspace_release_required" });
    rmSync(parent, { recursive: true });
    rmSync(child, { recursive: true });
    // A delivered child normally advances its detached HEAD. Cleanup freezes
    // these fresh audit facts; release must not compare them to allocation base.
    const expectedHeads = result.value.workspace.members.map((member, index) => ({
      relativeLocator: member.relativeLocator,
      head: `${index + 1}`.repeat(40),
    }));
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), {
      type: "worktree:release_requested",
      runId: "dispatch-release",
      reason: "delivered",
      operationId: "dispatch-release:allocate:release",
      expectedHeads,
      ts: 123,
    });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), {
      type: "worktree:released",
      runId: "dispatch-release",
      operationId: "dispatch-release:allocate:release",
      expectedHeads,
      ts: 124,
    });
    expect(releaseSkillDispatchReservation(root, "US-LOOP-127", "dispatch-release", root)).toEqual({ ok: true });
    // A second control-plane retry observes the same durable closure and does
    // not recreate or reject an already released parent reservation.
    expect(releaseSkillDispatchReservation(root, "US-LOOP-127", "dispatch-release", root)).toEqual({ ok: true });
  });

  it("replays the allocation-paired release completion when Git paths are already gone", async () => {
    const root = project();
    const fake = allocator(root);
    const result = await allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-release-retry", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    }, fake.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { mkdirSync } = await import("node:fs");
    for (const path of Object.values(result.value.paths)) mkdirSync(path, { recursive: true });
    for (const path of Object.values(result.value.paths)) rmSync(path, { recursive: true });
    const expectedHeads = result.value.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), {
      type: "worktree:release_requested",
      runId: "dispatch-release-retry",
      reason: "delivered",
      operationId: "dispatch-release-retry:allocate:release",
      expectedHeads,
      ts: 123,
    });
    expect(releaseSkillDispatchReservation(root, "US-LOOP-127", "dispatch-release-retry", root)).toEqual({ ok: true });
    expect(readFileSync(join(root, ".roll", "loop", "events.ndjson"), "utf8")).toContain('"operationId":"dispatch-release-retry:allocate:release"');
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toBeUndefined();
  });

  it("refuses a release completion recorded before its matching write-ahead request", async () => {
    const root = project();
    const fake = allocator(root);
    const result = await allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-reversed-release", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    }, fake.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedHeads = result.value.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
    const eventsPath = join(root, ".roll", "loop", "events.ndjson");
    new EventBus().appendEvent(eventsPath, {
      type: "worktree:released", runId: "dispatch-reversed-release", operationId: "dispatch-reversed-release:allocate:release", expectedHeads, ts: 123,
    });
    new EventBus().appendEvent(eventsPath, {
      type: "worktree:release_requested", runId: "dispatch-reversed-release", reason: "delivered", operationId: "dispatch-reversed-release:allocate:release", expectedHeads, ts: 124,
    });
    expect(releaseSkillDispatchReservation(root, "US-LOOP-127", "dispatch-reversed-release", root)).toEqual({ ok: false, reason: "workspace_release_required" });
    expect(readLeases(join(root, ".roll", "loop", "leases"))["US-LOOP-127"]).toBeDefined();
  });

  it("recognizes a child from the durable allocation event instead of a caller-supplied actor", async () => {
    const root = project();
    const fake = allocator(root);
    const result = await allocateSkillDispatchRun({
      projectRoot: root, storyId: "US-LOOP-127", runId: "dispatch-actor", actions: [{ actionId: "docs", declaredFileScope: ["docs"] }],
    }, fake.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const child = result.value.paths["dispatch-actor.children/docs"]!;
    const parent = result.value.paths["dispatch-actor"]!;
    // The fake Git port has no filesystem side effect; create only the path
    // shape needed to exercise command-boundary actor resolution.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(child, { recursive: true });
    mkdirSync(parent, { recursive: true });
    expect(skillDispatchActorForCwd(child)).toBe("child");
    expect(skillDispatchActorForCwd(parent)).toBe("parent");
  });

  it("enforces declared file scopes before the parent can integrate a child commit", () => {
    expect(skillDispatchScopeAllows(["docs", "packages/core"], ["docs/guide.md", "packages/core/src/a.ts"])).toBe(true);
    expect(skillDispatchScopeAllows(["docs"], ["packages/cli/src/escape.ts"])).toBe(false);
  });

  it("keeps both sides of a NUL-delimited rename in the child scope check", () => {
    expect(skillDispatchChangedPaths("R100\0out/secret.txt\0docs/secret.txt\0")).toEqual(["out/secret.txt", "docs/secret.txt"]);
    expect(skillDispatchScopeAllows(["docs"], skillDispatchChangedPaths("R100\0out/secret.txt\0docs/secret.txt\0")!)).toBe(false);
  });

  it("rejects an out-of-scope child commit at the executable parent integration boundary", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-integrate", storyId: "US-LOOP-127", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId: "repo", workspaceKey: "dispatch-integrate", relativeLocator: "dispatch-integrate", checkoutRef: { kind: "detached" as const, head } },
        { repositoryId: "repo", workspaceKey: "dispatch-integrate", relativeLocator: "dispatch-integrate.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head } },
      ] as const,
    };
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-integrate");
    const child = join(worktrees, "dispatch-integrate.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, head], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, head], { cwd: root, stdio: "ignore" });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-integrate:allocate", ts: 1 });
    writeFileSync(join(child, "README.md"), "escape\n");
    execFileSync("git", ["add", "README.md"], { cwd: child });
    execFileSync("git", ["commit", "-m", "escape"], { cwd: child, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-integrate", "docs", commit, root)).toEqual({ ok: false, reason: "scope_violation" });
    execFileSync("git", ["reset", "--hard", head], { cwd: child, stdio: "ignore" });
    mkdirSync(join(child, "docs"), { recursive: true });
    writeFileSync(join(child, "docs", "guide.md"), "scoped\n");
    execFileSync("git", ["add", "docs/guide.md"], { cwd: child });
    execFileSync("git", ["commit", "-m", "scoped"], { cwd: child, stdio: "ignore" });
    const scopedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-integrate", "docs", scopedCommit, root)).toEqual({ ok: true });
    expect(readFileSync(join(parent, "docs", "guide.md"), "utf8")).toBe("scoped\n");
    rmSync(root, { recursive: true, force: true });
  });

  it("integrates every in-scope child TCR commit exactly once from allocation base through the submitted tip", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-two-commits", storyId: "US-LOOP-127", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId: "repo", workspaceKey: "dispatch-two-commits", relativeLocator: "dispatch-two-commits", checkoutRef: { kind: "detached" as const, head } },
        { repositoryId: "repo", workspaceKey: "dispatch-two-commits", relativeLocator: "dispatch-two-commits.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head } },
      ] as const,
    };
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-two-commits");
    const child = join(worktrees, "dispatch-two-commits.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, head], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, head], { cwd: root, stdio: "ignore" });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-two-commits:allocate", ts: 1 });
    mkdirSync(join(child, "docs"), { recursive: true });
    writeFileSync(join(child, "docs", "first.md"), "first\n");
    execFileSync("git", ["add", "docs/first.md"], { cwd: child });
    execFileSync("git", ["commit", "-m", "first scoped TCR"], { cwd: child, stdio: "ignore" });
    writeFileSync(join(child, "docs", "second.md"), "second\n");
    execFileSync("git", ["add", "docs/second.md"], { cwd: child });
    execFileSync("git", ["commit", "-m", "second scoped TCR"], { cwd: child, stdio: "ignore" });
    const tip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-two-commits", "docs", tip, root)).toEqual({ ok: true });
    expect(readFileSync(join(parent, "docs", "first.md"), "utf8")).toBe("first\n");
    expect(readFileSync(join(parent, "docs", "second.md"), "utf8")).toBe("second\n");
    expect(execFileSync("git", ["log", "--format=%s", `${head}..HEAD`], { cwd: parent, encoding: "utf8" }).trim().split("\n"))
      .toEqual(["second scoped TCR", "first scoped TCR"]);
    // The exact repeated child tip is already patch-equivalent in the parent:
    // it must neither duplicate a commit nor silently skip a range member.
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-two-commits", "docs", tip, root)).toEqual({ ok: true });
    expect(execFileSync("git", ["log", "--format=%s", `${head}..HEAD`], { cwd: parent, encoding: "utf8" }).trim().split("\n"))
      .toEqual(["second scoped TCR", "first scoped TCR"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed before cherry-pick when an intermediate child commit cancels an out-of-scope write", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "protected.txt"), "base\n");
    execFileSync("git", ["add", "outside/protected.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-cancelled-escape", storyId: "US-LOOP-127", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId: "repo", workspaceKey: "dispatch-cancelled-escape", relativeLocator: "dispatch-cancelled-escape", checkoutRef: { kind: "detached" as const, head } },
        { repositoryId: "repo", workspaceKey: "dispatch-cancelled-escape", relativeLocator: "dispatch-cancelled-escape.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head } },
      ] as const,
    };
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-cancelled-escape");
    const child = join(worktrees, "dispatch-cancelled-escape.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, head], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, head], { cwd: root, stdio: "ignore" });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-cancelled-escape:allocate", ts: 1 });
    writeFileSync(join(child, "outside", "protected.txt"), "escaped\n");
    execFileSync("git", ["add", "outside/protected.txt"], { cwd: child });
    execFileSync("git", ["commit", "-m", "out of scope"], { cwd: child, stdio: "ignore" });
    writeFileSync(join(child, "outside", "protected.txt"), "base\n");
    mkdirSync(join(child, "docs"), { recursive: true });
    writeFileSync(join(child, "docs", "result.md"), "safe-looking tip\n");
    execFileSync("git", ["add", "outside/protected.txt", "docs/result.md"], { cwd: child });
    execFileSync("git", ["commit", "-m", "cancel escape and add result"], { cwd: child, stdio: "ignore" });
    const tip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-cancelled-escape", "docs", tip, root)).toEqual({ ok: false, reason: "scope_violation" });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf8" }).trim()).toBe(head);
    expect(readFileSync(join(parent, "outside", "protected.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(parent, "docs", "result.md"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a real-Git rename whose source escapes the child declaration", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(join(root, "out", "secret.txt"), "base\n");
    execFileSync("git", ["add", "out/secret.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-rename", storyId: "US-LOOP-127", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId: "repo", workspaceKey: "dispatch-rename", relativeLocator: "dispatch-rename", checkoutRef: { kind: "detached" as const, head } },
        { repositoryId: "repo", workspaceKey: "dispatch-rename", relativeLocator: "dispatch-rename.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head } },
      ] as const,
    };
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-rename");
    const child = join(worktrees, "dispatch-rename.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, head], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, head], { cwd: root, stdio: "ignore" });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-rename:allocate", ts: 1 });
    mkdirSync(join(child, "docs"), { recursive: true });
    execFileSync("git", ["mv", "out/secret.txt", "docs/secret.txt"], { cwd: child });
    execFileSync("git", ["commit", "-am", "rename escape"], { cwd: child, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-rename", "docs", commit, root)).toEqual({ ok: false, reason: "scope_violation" });
    expect(existsSync(join(parent, "docs", "secret.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a real-Git copy from an unchanged out-of-scope source before parent mutation", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "secret.txt"), "unchanged secret\n");
    execFileSync("git", ["add", "outside/secret.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-copy-escape", storyId: "US-LOOP-127", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId: "repo", workspaceKey: "dispatch-copy-escape", relativeLocator: "dispatch-copy-escape", checkoutRef: { kind: "detached" as const, head } },
        { repositoryId: "repo", workspaceKey: "dispatch-copy-escape", relativeLocator: "dispatch-copy-escape.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head } },
      ] as const,
    };
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-copy-escape");
    const child = join(worktrees, "dispatch-copy-escape.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, head], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, head], { cwd: root, stdio: "ignore" });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-copy-escape:allocate", ts: 1 });
    mkdirSync(join(child, "docs"), { recursive: true });
    execFileSync("cp", ["outside/secret.txt", "docs/secret-copy.txt"], { cwd: child });
    execFileSync("git", ["add", "docs/secret-copy.txt"], { cwd: child });
    execFileSync("git", ["commit", "-m", "copy unchanged escape"], { cwd: child, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-copy-escape", "docs", commit, root)).toEqual({ ok: false, reason: "scope_violation" });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf8" }).trim()).toBe(head);
    expect(readFileSync(join(parent, "outside", "secret.txt"), "utf8")).toBe("unchanged secret\n");
    expect(existsSync(join(parent, "docs", "secret-copy.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("integrates a real-Git copy when both source and destination are in the child scope", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "source.md"), "scoped source\n");
    execFileSync("git", ["add", "docs/source.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-scoped-copy", storyId: "US-LOOP-127", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId: "repo", workspaceKey: "dispatch-scoped-copy", relativeLocator: "dispatch-scoped-copy", checkoutRef: { kind: "detached" as const, head } },
        { repositoryId: "repo", workspaceKey: "dispatch-scoped-copy", relativeLocator: "dispatch-scoped-copy.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head } },
      ] as const,
    };
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-scoped-copy");
    const child = join(worktrees, "dispatch-scoped-copy.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, head], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, head], { cwd: root, stdio: "ignore" });
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-scoped-copy:allocate", ts: 1 });
    execFileSync("cp", ["docs/source.md", "docs/copy.md"], { cwd: child });
    execFileSync("git", ["add", "docs/copy.md"], { cwd: child });
    execFileSync("git", ["commit", "-m", "scoped copy"], { cwd: child, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    expect(integrateSkillDispatchChild(root, "US-LOOP-127", "dispatch-scoped-copy", "docs", commit, root)).toEqual({ ok: true });
    expect(readFileSync(join(parent, "docs", "copy.md"), "utf8")).toBe("scoped source\n");
    rmSync(root, { recursive: true, force: true });
  });
});
