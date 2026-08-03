import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");
const evidenceDir = join(here, "fixtures", "workspace", "us-ws-024-terminal-evidence");
const roots: string[] = [];

interface CreateResult {
  readonly mode: "check" | "apply";
  readonly outcome: "created" | "reused" | "repaired" | "rejected";
  readonly workspaceId: string;
  readonly root: string;
  readonly configSha256: string;
  readonly planSha256: string;
  readonly authorizationSource?: "direct_cli_apply" | "owner_after_preview";
  readonly recovery?: { readonly kind: string; readonly journalPath: string };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function tree(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const rows: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (entry.name === ".git") continue;
      const target = join(path, entry.name);
      const rel = relative(root, target);
      if (entry.isDirectory()) {
        rows.push(`d:${rel}`);
        visit(target);
      } else {
        rows.push(`f:${rel}:${statSync(target).mode}:${sha256(readFileSync(target, "utf8"))}`);
      }
    }
  };
  visit(root);
  return rows;
}

function fixture(options: { readonly materializeRemote?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "roll-us-ws-024-e2e-"));
  roots.push(home);
  const source = join(home, "source");
  const remote = join(home, "product.git");
  const workspace = join(home, "workspace");
  const rollHome = join(home, ".roll");
  const config = join(home, "workspace-create.yaml");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "product.txt"), "fixture\n", "utf8");
  git(source, ["add", "product.txt"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  if (options.materializeRemote !== false) git(home, ["clone", "-q", "--bare", source, remote]);
  writeFileSync(config, `schema: roll.workspace-create/v1\nid: ws-e2e\nroot: ${workspace}\ndisplay_name: Recovery E2E\nrepositories:\n  - alias: product\n    source: file://${remote}\n    integration_branch: main\n`, "utf8");
  return { home, source, remote, workspace, rollHome, config };
}

function run(f: ReturnType<typeof fixture>, extra: readonly string[]) {
  return spawnSync(process.execPath, [rollBin, "workspace", "create", "ws-e2e", "--config", f.config, "--json", ...extra], {
    cwd: repoRoot,
    env: { ...process.env, HOME: f.home, ROLL_HOME: f.rollHome, ROLL_LANG: "en", NO_COLOR: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function configDigest(f: ReturnType<typeof fixture>): string {
  const manifest = JSON.parse(readFileSync(join(f.workspace, "workspace.yaml"), "utf8")) as unknown;
  return sha256(JSON.stringify({ workspaceId: "ws-e2e", root: f.workspace, manifest }));
}

function writeLegacyJournal(f: ReturnType<typeof fixture>): string {
  const path = join(f.rollHome, "workspace-init", "ws-e2e.pending.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: "roll.workspace-init-journal/v1",
    transactionId: "legacy-completed",
    workspaceId: "ws-e2e",
    root: f.workspace,
    configDigest: configDigest(f),
    status: "repair_required",
    created: [],
    preserved: [],
    preservedCaches: [],
  }, null, 2)}\n`, "utf8");
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("US-WS-024 Workspace create authorization and recovery E2E", () => {
  it("keeps create_new at preview and applies only an exact owner-approved digest", () => {
    const f = fixture();
    const preview = run(f, ["--check"]);
    expect(preview.status, preview.stderr).toBe(0);
    const plan = JSON.parse(preview.stdout) as CreateResult;
    expect(plan).toMatchObject({
      mode: "check",
      outcome: "created",
      workspaceId: "ws-e2e",
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      planSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(existsSync(f.workspace)).toBe(false);

    const authorization = join(f.home, "authorization.json");
    writeFileSync(authorization, `${JSON.stringify({
      schema: "roll.workspace-create-apply-authorization/v1",
      workspaceId: plan.workspaceId,
      configSha256: plan.configSha256,
      planSha256: plan.planSha256,
      source: "create_new",
    })}\n`, "utf8");
    const beforeRefusal = tree(f.home);
    const refused = run(f, ["--authorization", authorization]);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: { code: "invalid_apply_authorization" } });
    expect(tree(f.home)).toEqual(beforeRefusal);
    expect(existsSync(f.workspace)).toBe(false);

    writeFileSync(authorization, `${JSON.stringify({
      schema: "roll.workspace-create-apply-authorization/v1",
      workspaceId: plan.workspaceId,
      configSha256: plan.configSha256,
      planSha256: plan.planSha256,
      source: "owner_after_preview",
    })}\n`, "utf8");
    const applied = run(f, ["--authorization", authorization]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      outcome: "created",
      authorizationSource: "owner_after_preview",
    });

    const transcript = readFileSync(join(evidenceDir, "transcript.txt"), "utf8");
    expect(transcript).toContain(JSON.stringify({
      mode: plan.mode,
      outcome: plan.outcome,
      workspaceId: plan.workspaceId,
      configSha256: "<CONFIG_SHA256>",
      planSha256: "<PLAN_SHA256>",
    }, null, 2));
    expect(transcript).toContain(JSON.stringify({ error: { code: "invalid_apply_authorization" } }, null, 2));
    expect(transcript).toContain(JSON.stringify({
      mode: "apply",
      outcome: "created",
      authorizationSource: "owner_after_preview",
    }, null, 2));
    const evidence = JSON.parse(readFileSync(join(evidenceDir, "evidence.json"), "utf8")) as Record<string, unknown>;
    expect(evidence).toMatchObject({ physical: false, taken: false, reason: "headless_terminal_capture_unavailable" });
    expect(readFileSync(join(evidenceDir, "capture-skip.txt"), "utf8")).toContain("No PNG was generated");
  });

  it("reconciles a completed legacy journal and fails closed when both journal generations exist", () => {
    const completed = fixture();
    const created = run(completed, []);
    expect(created.status, created.stderr).toBe(0);
    const authorityBefore = tree(completed.workspace);
    const legacyPath = writeLegacyJournal(completed);

    const preview = run(completed, ["--check"]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      outcome: "repaired",
      recovery: { kind: "legacy_completed", journalPath: legacyPath },
    });
    const recovered = run(completed, []);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ outcome: "repaired", recovery: { kind: "legacy_completed" } });
    expect(existsSync(legacyPath)).toBe(false);
    expect(tree(completed.workspace)).toEqual(authorityBefore);
    const reused = run(completed, []);
    expect(reused.status, reused.stderr).toBe(0);
    expect(JSON.parse(reused.stdout)).toMatchObject({ outcome: "reused" });
    const transcript = readFileSync(join(evidenceDir, "transcript.txt"), "utf8");
    expect(transcript).toContain(JSON.stringify({
      outcome: "repaired",
      recovery: { kind: "legacy_completed", journalPath: "<ROLL_HOME>/workspace-init/ws-e2e.pending.json" },
    }, null, 2));

    const conflict = fixture();
    const first = run(conflict, []);
    expect(first.status, first.stderr).toBe(0);
    writeLegacyJournal(conflict);
    const createJournal = join(conflict.rollHome, "workspace-create", "ws-e2e.pending.json");
    mkdirSync(dirname(createJournal), { recursive: true });
    writeFileSync(createJournal, "{}\n", "utf8");
    const beforeConflict = tree(conflict.home);
    const blocked = run(conflict, []);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr)).toMatchObject({
      error: {
        code: "legacy_create_recovery_required",
        nextAction: "roll workspace doctor ws-e2e --json",
      },
    });
    expect(tree(conflict.home)).toEqual(beforeConflict);
  });

  it("retries an interrupted new create journal without changing its crash contract", () => {
    const f = fixture({ materializeRemote: false });
    const failed = run(f, []);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ error: { code: "apply_failed" } });
    const journal = join(f.rollHome, "workspace-create", "ws-e2e.pending.json");
    expect(JSON.parse(readFileSync(journal, "utf8"))).toMatchObject({
      schema: "roll.workspace-create-journal/v1",
      status: "repair_required",
    });

    git(f.home, ["clone", "-q", "--bare", f.source, f.remote]);
    const retried = run(f, []);
    expect(retried.status, retried.stderr).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({ outcome: "repaired" });
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(f.workspace, "workspace.yaml"))).toBe(true);
  });
});
