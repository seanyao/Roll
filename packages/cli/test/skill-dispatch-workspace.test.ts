import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventBus, claimStoryLease, readLeases, setLease } from "@roll/core";
import { managedWorktreeRelease, projectIdentity } from "@roll/infra";
import { allocateSkillDispatchRun, confirmSkillDispatchDelivery, integrateSkillDispatchChild, releaseSkillDispatchReservation, skillDispatchActorForCwd, skillDispatchChangedPaths, skillDispatchScopeAllows, stopSkillDispatchRun } from "../src/runner/skill-dispatch-workspace.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "roll-dispatch-project-"));
  return root;
}

async function stopFixture(runId: string) {
  const root = project();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const repositoryId = (await projectIdentity(root)).slug;
  const worktrees = join(root, ".roll", "loop", "worktrees");
  const parent = join(worktrees, runId);
  const child = join(worktrees, `${runId}.children`, "docs");
  execFileSync("git", ["worktree", "add", "--detach", parent, base], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "--detach", child, base], { cwd: root, stdio: "ignore" });
  const workspace = {
    schema: 1 as const, runId, storyId: "FIX-1498", kind: "skill_dispatch" as const, topology: "solo" as const,
    members: [
      { repositoryId, workspaceKey: runId, relativeLocator: runId, checkoutRef: { kind: "detached" as const, head: base }, publishRef: `refs/heads/${runId}` },
      { repositoryId, workspaceKey: runId, relativeLocator: `${runId}.children/docs`, actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head: base } },
    ] as const,
  };
  const eventsPath = join(root, ".roll", "loop", "events.ndjson");
  new EventBus().appendEvent(eventsPath, { type: "worktree:allocated", workspace, operationId: `${runId}:allocate`, ts: 1 });
  claimStoryLease(join(root, ".roll", "loop", "leases"), "FIX-1498", { source: "skill-dispatch", runId, claimedAt: 1 });
  return { root, base, parent, child, workspace, eventsPath, leases: join(root, ".roll", "loop", "leases") };
}

function advance(path: string, filename: string): string {
  writeFileSync(join(path, filename), "abandoned\n");
  execFileSync("git", ["add", filename], { cwd: path });
  execFileSync("git", ["commit", "-m", `abandoned ${filename}`], { cwd: path, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
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
  it("confirms an independently merged and accepted parent plus child through the existing release lifecycle", async () => {
    const fixture = await stopFixture("dispatch-confirm-delivered");
    const result = await confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-delivered", fixture.root, {
      merged: async () => true,
      attested: () => true,
    });
    expect(result).toEqual({ ok: true, finalized: true });
    expect(existsSync(fixture.child)).toBe(false);
    expect(existsSync(fixture.parent)).toBe(false);
    expect(readLeases(fixture.leases)["FIX-1498"]).toBeUndefined();
    const events = readFileSync(fixture.eventsPath, "utf8");
    expect(events).toContain('"reason":"delivered"');
    expect(events.indexOf('"type":"worktree:release_requested"')).toBeLessThan(events.indexOf('"type":"worktree:released"'));
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("admits a real final-tree squash proof through the PR lookup boundary", async () => {
    const fixture = await stopFixture("dispatch-confirm-final-tree");
    execFileSync("git", ["branch", "-M", "main"], { cwd: fixture.root });
    const side = execFileSync("git", ["commit-tree", `${fixture.base}^{tree}`, "-p", fixture.base], { cwd: fixture.root, input: "side\n", encoding: "utf8" }).trim();
    const merge = execFileSync("git", ["commit-tree", `${fixture.base}^{tree}`, "-p", fixture.base, "-p", side], { cwd: fixture.root, input: "merge\n", encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", merge], { cwd: fixture.root });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", merge], { cwd: fixture.root });
    for (const path of [fixture.parent, fixture.child]) execFileSync("git", ["commit", "--allow-empty", "-m", "squashed tip"], { cwd: path, stdio: "ignore" });
    const review = join(fixture.root, ".roll", "features", "test", "FIX-1498", "latest");
    mkdirSync(review, { recursive: true });
    writeFileSync(join(review, "FIX-1498-review.html"), 'Gate: PASS <div class="ac s-pass"></div>');
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", fixture.workspace.runId, fixture.root, { mergedPrCommit: () => merge, integrationBranch: () => "main" })).resolves.toEqual({ ok: true, finalized: true });
    expect(readLeases(fixture.leases)["FIX-1498"]).toBeUndefined();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("uses production gh parsing for ancestor proof and rejects bad PR or attest facts", async () => {
    const oldPath = process.env.PATH ?? "";
    const run = async (name: string, response: string, review?: string) => {
      const fixture = await stopFixture(`dispatch-confirm-gh-${name}`);
      execFileSync("git", ["branch", "-M", "main"], { cwd: fixture.root });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", fixture.base], { cwd: fixture.root });
      const bin = join(fixture.root, "bin"); mkdirSync(bin);
      const gh = join(bin, "gh"); writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${response.replaceAll("PLACEHOLDER", fixture.base)}'\n`); chmodSync(gh, 0o755);
      if (review !== undefined) { const latest = join(fixture.root, ".roll", "features", "test", "FIX-1498", "latest"); mkdirSync(latest, { recursive: true }); writeFileSync(join(latest, "FIX-1498-review.html"), review); }
      process.env.PATH = `${bin}${delimiter}${oldPath}`;
      const before = readFileSync(fixture.eventsPath, "utf8"); const release = vi.fn(async (...args: Parameters<typeof managedWorktreeRelease>) => managedWorktreeRelease(...args));
      return { fixture, before, release, result: await confirmSkillDispatchDelivery(fixture.root, "FIX-1498", fixture.workspace.runId, fixture.root, { release }) };
    };
    const ok = (runId: string, oid: string) => JSON.stringify({ state: "MERGED", mergedAt: "2026-08-03T00:00:00Z", mergeCommit: { oid }, headRefName: runId });
    try {
      const success = await run("ancestor", ok("dispatch-confirm-gh-ancestor", "PLACEHOLDER"), 'Gate: PASS <div class="ac s-pass"></div>');
      rmSync(success.fixture.root, { recursive: true, force: true });
      const passing = await run("ancestor-pass", ok("dispatch-confirm-gh-ancestor-pass", "PLACEHOLDER"), 'Gate: PASS <div class="ac s-pass"></div>');
      expect(passing.result).toEqual({ ok: true, finalized: true }); rmSync(passing.fixture.root, { recursive: true, force: true });
      for (const [name, response, review, reason] of [["unmerged", JSON.stringify({ state: "OPEN" }), 'Gate: PASS <div class="ac s-pass"></div>', "merged_or_unverifiable"], ["malformed", "{", 'Gate: PASS <div class="ac s-pass"></div>', "merged_or_unverifiable"], ["wrong-head", ok("other", "PLACEHOLDER"), 'Gate: PASS <div class="ac s-pass"></div>', "merged_or_unverifiable"], ["absent-attest", ok("dispatch-confirm-gh-absent-attest", "PLACEHOLDER"), undefined, "attest_not_accepted"], ["rejected-attest", ok("dispatch-confirm-gh-rejected-attest", "PLACEHOLDER"), 'Gate: FAIL <div class="ac s-fail"></div>', "attest_not_accepted"]] as const) {
        const item = await run(name, response, review); expect(item.result).toEqual({ ok: false, reason }); expect(item.release).not.toHaveBeenCalled(); expect(readFileSync(item.fixture.eventsPath, "utf8")).toBe(item.before); expect(readLeases(item.fixture.leases)["FIX-1498"]).toMatchObject({ runId: item.fixture.workspace.runId }); rmSync(item.fixture.root, { recursive: true, force: true });
      }
    } finally { process.env.PATH = oldPath; }
  });

  it("refuses missing delivery proof, evidence, dirt, identity drift, and a child caller without writing a release request", async () => {
    const missingMerge = await stopFixture("dispatch-confirm-missing-merge");
    await expect(confirmSkillDispatchDelivery(missingMerge.root, "FIX-1498", "dispatch-confirm-missing-merge", missingMerge.root, {
      merged: () => false, attested: () => true,
    })).resolves.toEqual({ ok: false, reason: "merged_or_unverifiable" });
    expect(readFileSync(missingMerge.eventsPath, "utf8")).not.toContain('"type":"worktree:release_requested"');
    expect(existsSync(missingMerge.parent)).toBe(true);
    rmSync(missingMerge.root, { recursive: true, force: true });

    const missingAttest = await stopFixture("dispatch-confirm-missing-attest");
    await expect(confirmSkillDispatchDelivery(missingAttest.root, "FIX-1498", "dispatch-confirm-missing-attest", missingAttest.root, {
      merged: () => true, attested: () => false,
    })).resolves.toEqual({ ok: false, reason: "attest_not_accepted" });
    expect(readFileSync(missingAttest.eventsPath, "utf8")).not.toContain('"type":"worktree:release_requested"');
    rmSync(missingAttest.root, { recursive: true, force: true });

    const dirty = await stopFixture("dispatch-confirm-dirty");
    writeFileSync(join(dirty.child, "untracked.txt"), "dirty\n");
    await expect(confirmSkillDispatchDelivery(dirty.root, "FIX-1498", "dispatch-confirm-dirty", dirty.root, {
      merged: () => true, attested: () => true,
    })).resolves.toEqual({ ok: false, reason: "workspace_dirty" });
    expect(readFileSync(dirty.eventsPath, "utf8")).not.toContain('"type":"worktree:release_requested"');
    rmSync(dirty.root, { recursive: true, force: true });

    const identity = await stopFixture("dispatch-confirm-identity");
    await expect(confirmSkillDispatchDelivery(identity.root, "FIX-1498", "dispatch-confirm-identity", identity.root, {
      merged: () => true, attested: () => true,
      inspect: async () => ({ head: identity.base, repositoryId: "foreign", registered: true, clean: true }),
    })).resolves.toEqual({ ok: false, reason: "workspace_identity_mismatch" });
    expect(readFileSync(identity.eventsPath, "utf8")).not.toContain('"type":"worktree:release_requested"');
    rmSync(identity.root, { recursive: true, force: true });

    const child = await stopFixture("dispatch-confirm-child");
    await expect(confirmSkillDispatchDelivery(child.root, "FIX-1498", "dispatch-confirm-child", child.child, {
      merged: () => true, attested: () => true,
    })).resolves.toEqual({ ok: false, reason: "parent_required" });
    expect(readFileSync(child.eventsPath, "utf8")).not.toContain('"type":"worktree:release_requested"');
    rmSync(child.root, { recursive: true, force: true });
  });

  it("keeps the delivered request and lease after an interrupted child-first removal, then retries only the frozen heads", async () => {
    const fixture = await stopFixture("dispatch-confirm-retry");
    let calls = 0;
    const release = vi.fn(async (...args: Parameters<typeof managedWorktreeRelease>) => {
      calls += 1;
      return calls === 2 ? { code: 1, reason: "injected" } : managedWorktreeRelease(...args);
    });
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-retry", fixture.root, {
      merged: () => true, attested: () => true, release,
    })).resolves.toEqual({
      ok: false,
      reason: "release_incomplete",
      releaseFailure: { relativeLocator: "dispatch-confirm-retry", reason: "injected" },
    });
    expect(existsSync(fixture.child)).toBe(false);
    expect(existsSync(fixture.parent)).toBe(true);
    expect(readLeases(fixture.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-confirm-retry" });
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-retry", fixture.root)).resolves.toEqual({ ok: true, finalized: true });
    expect(existsSync(fixture.parent)).toBe(false);
    expect(readLeases(fixture.leases)["FIX-1498"]).toBeUndefined();
    const events = readFileSync(fixture.eventsPath, "utf8");
    expect((events.match(/"type":"worktree:release_requested"/g) ?? [])).toHaveLength(1);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("retries one frozen delivered request without re-admitting merge or attest", async () => {
    const fixture = await stopFixture("dispatch-confirm-first-failure");
    const release = vi.fn(async (...args: Parameters<typeof managedWorktreeRelease>) =>
      release.mock.calls.length === 1 ? { code: 1, reason: "injected_first" } : managedWorktreeRelease(...args),
    );
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-first-failure", fixture.root, {
      merged: () => true, attested: () => true, release,
    })).resolves.toEqual({
      ok: false,
      reason: "release_incomplete",
      releaseFailure: { relativeLocator: "dispatch-confirm-first-failure.children/docs", reason: "injected_first" },
    });
    expect(existsSync(fixture.child)).toBe(true);
    expect(existsSync(fixture.parent)).toBe(true);
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-first-failure", fixture.root, {
      merged: () => { throw new Error("retry must use the durable request"); },
      attested: () => { throw new Error("retry must use the durable request"); },
    })).resolves.toEqual({ ok: true, finalized: true });
    const events = readFileSync(fixture.eventsPath, "utf8");
    expect((events.match(/"type":"worktree:release_requested"/g) ?? [])).toHaveLength(1);
    expect((events.match(/"type":"worktree:released"/g) ?? [])).toHaveLength(1);
    expect(readLeases(fixture.leases)["FIX-1498"]).toBeUndefined();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("preserves a frozen request when a surviving member moves", async () => {
    const fixture = await stopFixture("dispatch-confirm-frozen-safety");
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-frozen-safety", fixture.root, {
      merged: () => true,
      attested: () => true,
      release: async () => ({ code: 1, reason: "injected" }),
    })).resolves.toMatchObject({ ok: false, reason: "release_incomplete" });
    advance(fixture.parent, "moved.md");
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-frozen-safety", fixture.root)).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
    expect(existsSync(fixture.child)).toBe(true);
    expect(existsSync(fixture.parent)).toBe(true);
    expect(readLeases(fixture.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-confirm-frozen-safety" });
    expect((readFileSync(fixture.eventsPath, "utf8").match(/"type":"worktree:release_requested"/g) ?? [])).toHaveLength(1);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("completes an already-removed delivered workspace exactly once", async () => {
    const fixture = await stopFixture("dispatch-confirm-completion-only");
    const heads = fixture.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
    new EventBus().appendEvent(fixture.eventsPath, {
      type: "worktree:release_requested", runId: "dispatch-confirm-completion-only", reason: "delivered", operationId: "dispatch-confirm-completion-only:allocate:release", expectedHeads: heads, ts: 2,
    });
    const absent = vi.fn(async () => true);
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-completion-only", fixture.root, { absent })).resolves.toEqual({ ok: true, finalized: true });
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-completion-only", fixture.root, { absent })).resolves.toEqual({ ok: true, finalized: true });
    const events = readFileSync(fixture.eventsPath, "utf8");
    expect((events.match(/"type":"worktree:release_requested"/g) ?? [])).toHaveLength(1);
    expect((events.match(/"type":"worktree:released"/g) ?? [])).toHaveLength(1);
    expect(readLeases(fixture.leases)["FIX-1498"]).toBeUndefined();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("refuses duplicate or malformed delivered requests before release", async () => {
    const fixture = await stopFixture("dispatch-confirm-conflict");
    const heads = fixture.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
    new EventBus().appendEvent(fixture.eventsPath, {
      type: "worktree:release_requested", runId: "dispatch-confirm-conflict", reason: "delivered", operationId: "dispatch-confirm-conflict:allocate:release", expectedHeads: heads, ts: 2,
    });
    new EventBus().appendEvent(fixture.eventsPath, {
      type: "worktree:release_requested", runId: "dispatch-confirm-conflict", reason: "delivered", operationId: "dispatch-confirm-conflict:allocate:release", expectedHeads: heads, ts: 3,
    });
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-conflict", fixture.root)).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
    expect(existsSync(fixture.child)).toBe(true);
    expect(existsSync(fixture.parent)).toBe(true);
    expect(readLeases(fixture.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-confirm-conflict" });
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("refuses corrupt delivered lifecycle records and foreign leases without release effects", async () => {
    const cases = [
      { name: "incomplete", request: (heads: readonly { relativeLocator: string; head: string }[]) => heads.slice(0, 1) },
      { name: "foreign-operation", request: (heads: readonly { relativeLocator: string; head: string }[]) => heads, operationId: "other:release" },
      { name: "wrong-reason", request: (heads: readonly { relativeLocator: string; head: string }[]) => heads, reason: "abandoned" as const },
    ];
    for (const entry of cases) {
      const fixture = await stopFixture(`dispatch-confirm-corrupt-${entry.name}`);
      const heads = fixture.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
      new EventBus().appendEvent(fixture.eventsPath, {
        type: "worktree:release_requested", runId: fixture.workspace.runId, reason: entry.reason ?? "delivered", operationId: entry.operationId ?? `${fixture.workspace.runId}:allocate:release`, expectedHeads: entry.request(heads), ts: 2,
      });
      const before = readFileSync(fixture.eventsPath, "utf8");
      const release = vi.fn(async () => ({ code: 0 }));
      await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", fixture.workspace.runId, fixture.root, { release })).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
      expect(release).not.toHaveBeenCalled();
      expect(readFileSync(fixture.eventsPath, "utf8")).toBe(before);
      expect(existsSync(fixture.child)).toBe(true);
      expect(readLeases(fixture.leases)["FIX-1498"]).toMatchObject({ runId: fixture.workspace.runId });
      rmSync(fixture.root, { recursive: true, force: true });
    }
    const foreign = await stopFixture("dispatch-confirm-foreign-lease");
    setLease(foreign.leases, "FIX-1498", { source: "host-delegation", delegationId: "other", claimedAt: 2 });
    const release = vi.fn(async () => ({ code: 0 }));
    await expect(confirmSkillDispatchDelivery(foreign.root, "FIX-1498", foreign.workspace.runId, foreign.root, { release })).resolves.toEqual({ ok: false, reason: "reservation_held_by_other" });
    expect(release).not.toHaveBeenCalled();
    rmSync(foreign.root, { recursive: true, force: true });
  });

  it("refuses reversed and incompatible completion records without effects", async () => {
    for (const kind of ["reversed", "incompatible"] as const) {
      const fixture = await stopFixture(`dispatch-confirm-${kind}-completion`);
      const heads = fixture.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
      const operationId = `${fixture.workspace.runId}:allocate:release`;
      if (kind === "incompatible") new EventBus().appendEvent(fixture.eventsPath, { type: "worktree:release_requested", runId: fixture.workspace.runId, reason: "delivered", operationId, expectedHeads: heads, ts: 2 });
      new EventBus().appendEvent(fixture.eventsPath, { type: "worktree:released", runId: fixture.workspace.runId, operationId, expectedHeads: kind === "incompatible" ? [{ ...heads[0]!, head: "f".repeat(40) }, heads[1]!] : heads, ts: 3 });
      const before = readFileSync(fixture.eventsPath, "utf8");
      const release = vi.fn(async () => ({ code: 0 }));
      await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", fixture.workspace.runId, fixture.root, { release })).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
      expect(release).not.toHaveBeenCalled();
      expect(readFileSync(fixture.eventsPath, "utf8")).toBe(before);
      expect(readLeases(fixture.leases)["FIX-1498"]).toMatchObject({ runId: fixture.workspace.runId });
      expect(existsSync(fixture.parent)).toBe(true); expect(existsSync(fixture.child)).toBe(true);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses dirty and unavailable survivors of a frozen delivered request", async () => {
    const dirty = await stopFixture("dispatch-confirm-retry-dirty");
    await confirmSkillDispatchDelivery(dirty.root, "FIX-1498", dirty.workspace.runId, dirty.root, { merged: () => true, attested: () => true, release: async () => ({ code: 1, reason: "injected" }) });
    writeFileSync(join(dirty.child, "untracked.txt"), "dirty\n");
    const dirtyRelease = vi.fn(async () => ({ code: 0 }));
    await expect(confirmSkillDispatchDelivery(dirty.root, "FIX-1498", dirty.workspace.runId, dirty.root, { release: dirtyRelease })).resolves.toEqual({ ok: false, reason: "workspace_dirty" });
    expect(dirtyRelease).not.toHaveBeenCalled();
    expect(readLeases(dirty.leases)["FIX-1498"]).toMatchObject({ runId: dirty.workspace.runId });
    rmSync(dirty.root, { recursive: true, force: true });

    const unavailable = await stopFixture("dispatch-confirm-retry-unavailable");
    await confirmSkillDispatchDelivery(unavailable.root, "FIX-1498", unavailable.workspace.runId, unavailable.root, { merged: () => true, attested: () => true, release: async () => ({ code: 1, reason: "injected" }) });
    const unavailableRelease = vi.fn(async () => ({ code: 0 }));
    await expect(confirmSkillDispatchDelivery(unavailable.root, "FIX-1498", unavailable.workspace.runId, unavailable.root, { inspect: async () => undefined, release: unavailableRelease })).resolves.toEqual({ ok: false, reason: "workspace_unavailable" });
    expect(unavailableRelease).not.toHaveBeenCalled();
    expect(readLeases(unavailable.leases)["FIX-1498"]).toMatchObject({ runId: unavailable.workspace.runId });
    rmSync(unavailable.root, { recursive: true, force: true });
  });

  it("never deletes a reappeared member after a durable delivered completion", async () => {
    const fixture = await stopFixture("dispatch-confirm-reappeared");
    const heads = fixture.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
    new EventBus().appendEvent(fixture.eventsPath, {
      type: "worktree:release_requested", runId: "dispatch-confirm-reappeared", reason: "delivered", operationId: "dispatch-confirm-reappeared:allocate:release", expectedHeads: heads, ts: 2,
    });
    new EventBus().appendEvent(fixture.eventsPath, {
      type: "worktree:released", runId: "dispatch-confirm-reappeared", operationId: "dispatch-confirm-reappeared:allocate:release", expectedHeads: heads, ts: 3,
    });
    await expect(confirmSkillDispatchDelivery(fixture.root, "FIX-1498", "dispatch-confirm-reappeared", fixture.root)).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
    expect(existsSync(fixture.parent)).toBe(true);
    expect(existsSync(fixture.child)).toBe(true);
    expect(readLeases(fixture.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-confirm-reappeared" });
    rmSync(fixture.root, { recursive: true, force: true });
  });
  it("accepts an advanced but unmerged managed parent head as abandoned work", async () => {
    const fixture = await stopFixture("dispatch-stop-parent-advance");
    const parentHead = advance(fixture.parent, "abandoned-parent.md");
    await expect(stopSkillDispatchRun(fixture.root, "FIX-1498", "dispatch-stop-parent-advance", "scope was incomplete", "FIX-1498", fixture.root)).resolves.toMatchObject({ ok: true });
    expect(execFileSync("git", ["rev-parse", "refs/roll-retained/dispatch-stop-parent-advance/dispatch-stop-parent-advance"], { cwd: fixture.root, encoding: "utf8" }).trim()).toBe(parentHead);
    expect(existsSync(fixture.parent)).toBe(false);
    expect(existsSync(fixture.child)).toBe(false);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("refuses stop admission failures without events, directory removal, or lease release", async () => {
    const missing = await stopFixture("dispatch-stop-missing-reason");
    await expect(stopSkillDispatchRun(missing.root, "FIX-1498", "dispatch-stop-missing-reason", "", "FIX-1498", missing.root)).resolves.toEqual({ ok: false, reason: "missing_reason" });
    expect(readFileSync(missing.eventsPath, "utf8").match(/worktree:release_requested/g)).toBeNull();
    expect(existsSync(missing.parent)).toBe(true);
    expect(readLeases(missing.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-stop-missing-reason" });
    rmSync(missing.root, { recursive: true, force: true });

    const inside = await stopFixture("dispatch-stop-inside");
    await expect(stopSkillDispatchRun(inside.root, "FIX-1498", "dispatch-stop-inside", "scope was incomplete", "FIX-1498", inside.parent)).resolves.toEqual({ ok: false, reason: "execution_inside_workspace" });
    expect(readFileSync(inside.eventsPath, "utf8").match(/worktree:release_requested/g)).toBeNull();
    expect(existsSync(inside.parent)).toBe(true);
    expect(readLeases(inside.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-stop-inside" });
    rmSync(inside.root, { recursive: true, force: true });

    const foreign = await stopFixture("dispatch-stop-foreign-lease");
    setLease(foreign.leases, "FIX-1498", { source: "host-delegation", delegationId: "other-delegation", claimedAt: 2 });
    await expect(stopSkillDispatchRun(foreign.root, "FIX-1498", "dispatch-stop-foreign-lease", "scope was incomplete", "FIX-1498", foreign.root)).resolves.toEqual({ ok: false, reason: "reservation_held_by_other" });
    expect(readFileSync(foreign.eventsPath, "utf8").match(/worktree:release_requested/g)).toBeNull();
    expect(existsSync(foreign.child)).toBe(true);
    expect(readLeases(foreign.leases)["FIX-1498"]).toMatchObject({ delegationId: "other-delegation" });
    rmSync(foreign.root, { recursive: true, force: true });

    const identity = await stopFixture("dispatch-stop-identity");
    await expect(stopSkillDispatchRun(identity.root, "FIX-1498", "dispatch-stop-identity", "scope was incomplete", "FIX-1498", identity.root, {
      inspect: async () => ({ head: identity.base, repositoryId: "github.com/acme/foreign", registered: true, clean: true }),
    })).resolves.toEqual({ ok: false, reason: "workspace_identity_mismatch" });
    expect(readFileSync(identity.eventsPath, "utf8").match(/worktree:release_requested/g)).toBeNull();
    expect(existsSync(identity.child)).toBe(true);
    expect(readLeases(identity.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-stop-identity" });
    rmSync(identity.root, { recursive: true, force: true });

    const conflicting = await stopFixture("dispatch-stop-conflict");
    const expectedHeads = conflicting.workspace.members.map((member) => ({ relativeLocator: member.relativeLocator, head: member.checkoutRef.head }));
    new EventBus().appendEvent(conflicting.eventsPath, { type: "worktree:release_requested", runId: "dispatch-stop-conflict", reason: "abandoned", note: "other reason", operationId: "different-stop", expectedHeads, ts: 2 });
    await expect(stopSkillDispatchRun(conflicting.root, "FIX-1498", "dispatch-stop-conflict", "scope was incomplete", "FIX-1498", conflicting.root)).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
    expect(existsSync(conflicting.parent)).toBe(true);
    expect(readLeases(conflicting.leases)["FIX-1498"]).toMatchObject({ runId: "dispatch-stop-conflict" });
    rmSync(conflicting.root, { recursive: true, force: true });
  });

  it("refuses merged and unavailable Git facts before it asks to release", async () => {
    const merged = await stopFixture("dispatch-stop-merged");
    const childHead = advance(merged.child, "abandoned.md");
    execFileSync("git", ["cherry-pick", childHead], { cwd: merged.root, stdio: "ignore" });
    await expect(stopSkillDispatchRun(merged.root, "FIX-1498", "dispatch-stop-merged", "scope was incomplete", "FIX-1498", merged.root)).resolves.toEqual({ ok: false, reason: "merged_or_unverifiable" });
    expect(readFileSync(merged.eventsPath, "utf8").match(/worktree:release_requested/g)).toBeNull();
    expect(existsSync(merged.child)).toBe(true);
    rmSync(merged.root, { recursive: true, force: true });

    const unavailable = await stopFixture("dispatch-stop-unavailable");
    advance(unavailable.child, "abandoned.md");
    await expect(stopSkillDispatchRun(unavailable.root, "FIX-1498", "dispatch-stop-unavailable", "scope was incomplete", "FIX-1498", unavailable.root, { remoteContains: async () => undefined })).resolves.toEqual({ ok: false, reason: "published_or_unverifiable" });
    expect(readFileSync(unavailable.eventsPath, "utf8").match(/worktree:release_requested/g)).toBeNull();
    expect(existsSync(unavailable.child)).toBe(true);
    rmSync(unavailable.root, { recursive: true, force: true });
  });

  it("stops a clean unmerged two-member run through the paired release lifecycle while retaining abandoned heads", async () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const repositoryId = (await projectIdentity(root)).slug;
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-stop");
    const child = join(worktrees, "dispatch-stop.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, base], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, base], { cwd: root, stdio: "ignore" });
    mkdirSync(join(child, "docs"), { recursive: true });
    writeFileSync(join(child, "docs", "abandoned.md"), "retained\n");
    execFileSync("git", ["add", "."], { cwd: child });
    execFileSync("git", ["commit", "-m", "abandoned child work"], { cwd: child, stdio: "ignore" });
    const childHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: child, encoding: "utf8" }).trim();
    const workspace = {
      schema: 1 as const, runId: "dispatch-stop", storyId: "FIX-1498", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId, workspaceKey: "dispatch-stop", relativeLocator: "dispatch-stop", checkoutRef: { kind: "detached" as const, head: base } },
        { repositoryId, workspaceKey: "dispatch-stop", relativeLocator: "dispatch-stop.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head: base } },
      ] as const,
    };
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-stop:allocate", ts: 1 });
    claimStoryLease(join(root, ".roll", "loop", "leases"), "FIX-1498", { source: "skill-dispatch", runId: "dispatch-stop", claimedAt: 1 });

    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop", "scope was incomplete", "FIX-1498", child)).resolves.toEqual({ ok: false, reason: "parent_required" });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop", "", "FIX-1498", root)).resolves.toEqual({ ok: false, reason: "missing_reason" });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop", "scope was incomplete", "OTHER", root)).resolves.toEqual({ ok: false, reason: "confirmation_mismatch" });
    writeFileSync(join(child, "untracked.txt"), "dirty\n");
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop", "scope was incomplete", "FIX-1498", root)).resolves.toEqual({ ok: false, reason: "workspace_dirty" });
    rmSync(join(child, "untracked.txt"));
    execFileSync("git", ["update-ref", "refs/remotes/origin/published", childHead], { cwd: root });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop", "scope was incomplete", "FIX-1498", root)).resolves.toEqual({ ok: false, reason: "published_or_unverifiable" });
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/published"], { cwd: root });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop", "scope was incomplete", "FIX-1498", root)).resolves.toMatchObject({ ok: true });
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(child)).toBe(false);
    expect(execFileSync("git", ["rev-parse", "refs/roll-retained/dispatch-stop/dispatch-stop.children-docs"], { cwd: root, encoding: "utf8" }).trim()).toBe(childHead);
    expect(readLeases(join(root, ".roll", "loop", "leases"))["FIX-1498"]).toBeUndefined();
    const events = readFileSync(join(root, ".roll", "loop", "events.ndjson"), "utf8");
    expect(events.indexOf('"type":"worktree:release_requested"')).toBeLessThan(events.indexOf('"type":"worktree:released"'));
    expect(events).toContain('"note":"scope was incomplete"');
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the request and lease after a partial removal, then accepts only the identical frozen retry", async () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Roll Test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const repositoryId = (await projectIdentity(root)).slug;
    const worktrees = join(root, ".roll", "loop", "worktrees");
    const parent = join(worktrees, "dispatch-stop-retry");
    const child = join(worktrees, "dispatch-stop-retry.children", "docs");
    execFileSync("git", ["worktree", "add", "--detach", parent, base], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "--detach", child, base], { cwd: root, stdio: "ignore" });
    mkdirSync(join(child, "docs"), { recursive: true });
    writeFileSync(join(child, "docs", "abandoned.md"), "retained\n");
    execFileSync("git", ["add", "."], { cwd: child });
    execFileSync("git", ["commit", "-m", "abandoned child work"], { cwd: child, stdio: "ignore" });
    const workspace = {
      schema: 1 as const, runId: "dispatch-stop-retry", storyId: "FIX-1498", kind: "skill_dispatch" as const, topology: "solo" as const,
      members: [
        { repositoryId, workspaceKey: "dispatch-stop-retry", relativeLocator: "dispatch-stop-retry", checkoutRef: { kind: "detached" as const, head: base } },
        { repositoryId, workspaceKey: "dispatch-stop-retry", relativeLocator: "dispatch-stop-retry.children/docs", actionId: "docs", declaredFileScope: ["docs"], checkoutRef: { kind: "detached" as const, head: base } },
      ] as const,
    };
    new EventBus().appendEvent(join(root, ".roll", "loop", "events.ndjson"), { type: "worktree:allocated", workspace, operationId: "dispatch-stop-retry:allocate", ts: 1 });
    claimStoryLease(join(root, ".roll", "loop", "leases"), "FIX-1498", { source: "skill-dispatch", runId: "dispatch-stop-retry", claimedAt: 1 });
    let calls = 0;
    const release = vi.fn(async (...args: Parameters<typeof managedWorktreeRelease>) => {
      calls += 1;
      return calls === 2 ? { code: 1, reason: "injected" } : managedWorktreeRelease(...args);
    });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop-retry", "scope was incomplete", "FIX-1498", root, { release })).resolves.toEqual({ ok: false, reason: "release_incomplete" });
    expect(existsSync(child)).toBe(false);
    expect(existsSync(parent)).toBe(true);
    expect(readLeases(join(root, ".roll", "loop", "leases"))["FIX-1498"]).toMatchObject({ runId: "dispatch-stop-retry" });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop-retry", "changed reason", "FIX-1498", root)).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
    advance(parent, "survivor-moved.md");
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop-retry", "scope was incomplete", "FIX-1498", root)).resolves.toEqual({ ok: false, reason: "conflicting_release_request" });
    expect(existsSync(parent)).toBe(true);
    expect(readLeases(join(root, ".roll", "loop", "leases"))["FIX-1498"]).toMatchObject({ runId: "dispatch-stop-retry" });
    execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: parent, stdio: "ignore" });
    await expect(stopSkillDispatchRun(root, "FIX-1498", "dispatch-stop-retry", "scope was incomplete", "FIX-1498", root)).resolves.toMatchObject({ ok: true });
    expect(existsSync(parent)).toBe(false);
    expect(readLeases(join(root, ".roll", "loop", "leases"))["FIX-1498"]).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

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
