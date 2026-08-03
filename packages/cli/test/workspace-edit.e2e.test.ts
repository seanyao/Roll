import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeWorkspaceManifest } from "@roll/core";
import { WorkspaceRegistry, workspaceEditJournalPath } from "@roll/infra";
import { repositoryIdFromRemote, type WorkspaceManifest } from "@roll/spec";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }

const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"] as const;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-edit-e2e-"));
  roots.push(home);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  const manifestPath = join(workspace, "workspace.yaml");
  const remote = "https://example.test/owner/product";
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture repository must normalize");
  const manifest: WorkspaceManifest = {
    schema: "roll.workspace/v1",
    workspaceId: "ws-demo",
    displayName: "Demo",
    createdAt: "2026-07-20T00:00:00.000Z",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: repoId.value,
      alias: "product",
      remote,
      integrationBranch: "main",
      provider: "github",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
    }],
  };
  write(manifestPath, manifest);
  mkdirSync(join(workspace, "issues"), { recursive: true });
  mkdirSync(join(workspace, "requirements"), { recursive: true });
  new WorkspaceRegistry({ rollHome, now: () => 1 }).register({ workspaceId: "ws-demo", root: workspace });
  const config = join(home, "workspace-edit.json");
  write(config, {
    schema: "roll.workspace-edit/v1",
    workspace_id: "ws-demo",
    expected_manifest_sha256: digest(serializeWorkspaceManifest(manifest)),
    display_name: "Renamed Demo",
    requirements: [{ provider: "jira", ref: "SOT-15499" }],
    repositories: [{
      alias: "product",
      remote,
      provider: "github",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: ["test"],
    }],
  });
  return { home, rollHome, workspace, manifestPath, manifest, config };
}

async function run(args: string[], f: ReturnType<typeof fixture>): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = "en";
  process.env["NO_COLOR"] = "1";
  let stdout = "";
  let stderr = "";
  const output = process.stdout.write.bind(process.stdout);
  const error = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  try {
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = output;
    process.stderr.write = error;
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

beforeEach(() => registerAll());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-026 roll workspace edit apply", () => {
  it("previews, applies, and returns idempotent success through the public command route", async () => {
    const f = fixture();
    const preview = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--check", "--json"], f);
    const applied = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--json"], f);
    const retried = await run(["workspace", "edit", f.workspace, "--config", f.config, "--json"], f);

    expect(preview.status).toBe(0);
    expect(applied).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(applied.stdout)).toMatchObject({
      schema: "roll.workspace-edit-result/v1",
      outcome: "applied",
      workspaceId: "ws-demo",
      manifestPath: f.manifestPath,
    });
    expect(JSON.parse(retried.stdout)).toMatchObject({
      schema: "roll.workspace-edit-result/v1",
      outcome: "reused",
      workspaceId: "ws-demo",
    });
    expect(JSON.parse(readFileSync(f.manifestPath, "utf8"))).toMatchObject({ displayName: "Renamed Demo" });
  });

  it("rejects a stale preview without overwriting the concurrent manifest", async () => {
    const f = fixture();
    write(f.manifestPath, { ...f.manifest, displayName: "Concurrent edit" });
    const concurrentBytes = readFileSync(f.manifestPath);

    const result = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--json"], f);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: "roll.workspace-edit-error/v1",
      error: { code: "manifest_changed" },
    });
    expect(readFileSync(f.manifestPath)).toEqual(concurrentBytes);
  });

  it("reconciles a crash after manifest rename as a public idempotent retry", async () => {
    const f = fixture();
    const previewResult = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--check", "--json"], f);
    const preview = JSON.parse(previewResult.stdout) as Record<string, unknown>;
    writeFileSync(f.manifestPath, serializeWorkspaceManifest(preview["afterManifest"] as WorkspaceManifest), "utf8");
    write(workspaceEditJournalPath(f.rollHome, "ws-demo"), {
      schema: "roll.workspace-edit-journal/v1",
      status: "prepared",
      transactionId: randomUUID(),
      workspaceId: "ws-demo",
      manifestPath: f.manifestPath,
      beforeSha256: preview["beforeSha256"],
      afterSha256: preview["afterSha256"],
      referenceIndexSha256: preview["referenceIndexSha256"],
      afterManifest: preview["afterManifest"],
    });

    const retry = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--json"], f);

    expect(retry).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(retry.stdout)).toMatchObject({ outcome: "reused" });
  });
});
