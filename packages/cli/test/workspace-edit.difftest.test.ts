import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeWorkspaceManifest } from "@roll/core";
import { WorkspaceRegistry } from "@roll/infra";
import { repositoryIdFromRemote, type WorkspaceManifest } from "@roll/spec";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }

const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "NO_COLOR", "LC_ALL", "LANG"] as const;

function digest(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function snapshot(root: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const stat = lstatSync(path);
      result.set(relative, JSON.stringify({
        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        digest: stat.isFile() ? digest(readFileSync(path)) : "",
      }));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relative);
    }
  };
  walk(root, "");
  return result;
}

function snapshotState(f: Pick<ReturnType<typeof fixture>, "workspace" | "rollHome">) {
  return {
    workspace: snapshot(f.workspace),
    rollHome: snapshot(f.rollHome),
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-edit-cli-"));
  roots.push(home);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  const remote = "https://example.test/owner/product";
  const repoId = repositoryIdFromRemote(remote);
  if (!repoId.ok) throw new Error("fixture remote must normalize");
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
  write(join(workspace, "workspace.yaml"), manifest);
  mkdirSync(join(workspace, "issues"), { recursive: true });
  mkdirSync(join(workspace, "requirements"), { recursive: true });
  new WorkspaceRegistry({ rollHome, now: () => 1 }).register({ workspaceId: "ws-demo", root: workspace });
  const config = join(home, "workspace-edit.json");
  const configValue = (overrides: Record<string, unknown> = {}) => ({
    schema: "roll.workspace-edit/v1",
    workspace_id: "ws-demo",
    expected_manifest_sha256: digest(serializeWorkspaceManifest(manifest)),
    display_name: "Renamed Demo",
    requirements: [{ provider: "jira", ref: "sot-15499" }],
    repositories: [{
      alias: "product",
      remote: `${remote}.git`,
      provider: "github",
      integration_branch: "main",
      branch_pattern: "roll/{workspace_id}/{story_id}",
      required_checks: ["test"],
    }],
    ...overrides,
  });
  write(config, configValue());
  return { home, rollHome, workspace, config, configValue, manifest, repoId: repoId.value };
}

async function run(args: string[], f: ReturnType<typeof fixture>, lang: "en" | "zh" = "en"): Promise<Run> {
  const saved: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) saved[key] = value;
    delete process.env[key];
  }
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = lang;
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

describe("US-WS-025 roll workspace edit --check", () => {
  it("emits a complete safe JSON plan through the public route with zero Workspace writes", async () => {
    const f = fixture();
    const before = snapshotState(f);

    const first = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--check", "--json"], f);
    const second = await run(["workspace", "edit", f.workspace, "--config", f.config, "--check", "--json"], f);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 0, stderr: "" });
    const plan = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(Object.keys(plan).sort()).toEqual([
      "afterManifest",
      "afterSha256",
      "beforeManifest",
      "beforeSha256",
      "blockers",
      "changes",
      "manifestPath",
      "nextAction",
      "outcome",
      "referenceIndexSha256",
      "schema",
      "warnings",
      "workspaceId",
    ]);
    expect(plan).toEqual({
      schema: "roll.workspace-edit-plan/v1",
      outcome: "ready",
      workspaceId: "ws-demo",
      manifestPath: join(f.workspace, "workspace.yaml"),
      beforeSha256: digest(serializeWorkspaceManifest(f.manifest)),
      afterSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      referenceIndexSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      beforeManifest: f.manifest,
      afterManifest: { ...f.manifest, displayName: "Renamed Demo" },
      changes: [{
        kind: "display_name",
        path: "displayName",
        operation: "updated",
        before: "Demo",
        after: "Renamed Demo",
        safety: "safe",
      }],
      blockers: [],
      warnings: [],
      nextAction: {
        kind: "apply",
        command: `roll workspace edit ws-demo --config ${f.config} --json`,
      },
    });
    expect(plan["afterSha256"]).toBe(digest(serializeWorkspaceManifest(plan["afterManifest"] as WorkspaceManifest)));
    expect(snapshotState(f)).toEqual(before);
  });

  it("returns a blocked referenced-repository preview and preserves the Issue and Workspace bytes", async () => {
    const f = fixture();
    write(join(f.workspace, "issues", "US-EXISTING-1", "manifest.json"), {
      schema: "roll.issue/v1",
      workspaceId: "ws-demo",
      storyId: "US-EXISTING-1",
      requirements: [{ provider: "jira", ref: "SOT-15499" }],
      repositories: [{
        repoId: f.repoId,
        alias: "product",
        access: "write",
        requiredDelivery: true,
        noChangePolicy: "changes_required",
      }],
    });
    write(f.config, f.configValue({
      repositories: [{
        alias: "product",
        remote: "https://example.test/owner/product",
        provider: "github",
        integration_branch: "release",
        branch_pattern: "feature/{workspace_id}/{story_id}",
        required_checks: ["lint"],
      }],
    }));
    const before = snapshotState(f);

    const result = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--check", "--json"], f);

    expect(result).toMatchObject({ status: 2, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "blocked",
      beforeManifest: {
        repositories: [expect.objectContaining({
          integrationBranch: "main",
          workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: ["test"] },
        })],
      },
      afterManifest: {
        repositories: [expect.objectContaining({
          integrationBranch: "release",
          workflow: { branchPattern: "feature/{workspace_id}/{story_id}", requiredChecks: ["lint"] },
        })],
      },
      blockers: expect.arrayContaining([expect.objectContaining({
        code: "metadata_referenced",
        path: `repositories[${f.repoId}].branchPattern`,
        references: [expect.objectContaining({ storyId: "US-EXISTING-1" })],
      })]),
      nextAction: {
        kind: "blocked",
        command: `roll workspace edit ws-demo --config ${f.config} --check --json`,
      },
    });
    expect(snapshotState(f)).toEqual(before);
  });

  it("blocks Requirement deletion referenced by its archive and writes neither root", async () => {
    const f = fixture();
    write(join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"), {
      schema: "roll.requirement-source/v1",
      requirementId: "req-c78ccf14ea21",
      provider: "jira",
      ref: "SOT-15499",
      revision: "7",
      capturedAt: "2026-07-24T00:00:00.000Z",
      previousRevisions: [],
      requirement: { bytes: 4, sha256: digest("body") },
      context: [],
      stories: [],
      attest: {
        schema: "roll.requirement-attest-projection/v1",
        mode: "generated_aggregate",
        evidenceAuthority: "issue",
      },
    });
    write(f.config, f.configValue({ requirements: [] }));
    const before = snapshotState(f);

    const result = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--check", "--json"], f);

    expect(result).toMatchObject({ status: 2, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "blocked",
      beforeManifest: { requirements: [{ provider: "jira", ref: "SOT-15499" }] },
      afterManifest: { requirements: [] },
      blockers: [expect.objectContaining({
        code: "metadata_referenced",
        path: "requirements[jira:SOT-15499]",
        references: [expect.objectContaining({
          kind: "requirement_archive",
          requirementId: "req-c78ccf14ea21",
        })],
      })],
      nextAction: {
        kind: "blocked",
        command: `roll workspace edit ws-demo --config ${f.config} --check --json`,
      },
    });
    expect(snapshotState(f)).toEqual(before);
  });

  it.each([
    ["unknown config field", ["workspace", "edit", "ws-demo", "--config", "<CONFIG>", "--check", "--json"], "unknown_field"],
    ["unknown config version", ["workspace", "edit", "ws-demo", "--config", "<CONFIG>", "--check", "--json"], "unknown_version"],
  ])("fails without writes when %s", async (name, rawArgs, code) => {
    const f = fixture();
    if (name === "unknown config field") write(f.config, f.configValue({ root: "/escape" }));
    if (name === "unknown config version") write(f.config, f.configValue({ schema: "roll.workspace-edit/v2" }));
    const args = rawArgs.map((arg) => arg === "<CONFIG>" ? f.config : arg);
    const before = snapshotState(f);

    const result = await run(args, f);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: "roll.workspace-edit-error/v1",
      error: { code },
    });
    expect(snapshotState(f)).toEqual(before);
  });

  it("fails closed when a reference authority is corrupt", async () => {
    const f = fixture();
    mkdirSync(join(f.workspace, "issues", "US-BROKEN"), { recursive: true });
    const before = snapshotState(f);

    const result = await run(["workspace", "edit", "ws-demo", "--config", f.config, "--check", "--json"], f);

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: "roll.workspace-edit-error/v1",
      error: { code: "reference_index_invalid" },
    });
    expect(snapshotState(f)).toEqual(before);
  });
});
