import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "@roll/infra";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
const roots: string[] = [];
const ENV_KEYS = ["HOME", "ROLL_HOME", "ROLL_LANG", "ROLL_WORKSPACE", "NO_COLOR"] as const;

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-requirement-cli-"));
  roots.push(home);
  const rollHome = join(home, ".roll");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  write(join(workspace, "workspace.yaml"), `${JSON.stringify({
    schema: "roll.workspace/v1",
    workspaceId: "ws-demo",
    displayName: "Demo",
    requirements: [{ provider: "JIRA", ref: "sot-15499" }],
    repositories: [{
      schema: "roll.repository-binding/v1",
      repoId: "repo-ff7a87ddbb2b",
      alias: "product",
      remote: "https://example.test/owner/product",
      integrationBranch: "main",
      provider: "generic",
      workflow: { branchPattern: "roll/{workspace_id}/{story_id}", requiredChecks: [] },
    }],
  }, null, 2)}\n`);
  for (const storyId of ["US-WS-007", "US-WS-008"]) {
    write(join(workspace, "backlog", "epic", storyId, "spec.md"), `# ${storyId}\n`);
  }
  const body = join(home, "jira.md");
  write(body, "# SOT-15499\n\nWorkspace requirement source.\n");
  const contextRoot = join(home, "context");
  write(join(contextRoot, "brief.md"), "brief context\n");
  const registry = new WorkspaceRegistry({ rollHome, now: () => 1 });
  registry.register({ workspaceId: "ws-demo", root: workspace });
  registry.activate("ws-demo");
  return { home, rollHome, workspace, body, contextRoot };
}

async function run(args: string[], f: ReturnType<typeof fixture>, options: { readonly lang?: string; readonly workspaceEnv?: string; readonly cwd?: string } = {}): Promise<Run> {
  const savedEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
  const savedCwd = process.cwd();
  process.env["HOME"] = f.home;
  process.env["ROLL_HOME"] = f.rollHome;
  process.env["ROLL_LANG"] = options.lang ?? "en";
  process.env["NO_COLOR"] = "1";
  if (options.workspaceEnv === undefined) delete process.env["ROLL_WORKSPACE"];
  else process.env["ROLL_WORKSPACE"] = options.workspaceEnv;
  if (options.cwd !== undefined) process.chdir(options.cwd);
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout += String(chunk); return true; };
  // @ts-expect-error capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; };
  try {
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.chdir(savedCwd);
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function addArgs(f: ReturnType<typeof fixture>): string[] {
  return [
    "workspace", "requirement", "add",
    "--workspace", "ws-demo",
    "--provider", "jira",
    "--ref", "SOT-15499",
    "--revision", "42",
    "--body-file", f.body,
    "--context-root", f.contextRoot,
    "--context", "brief.md",
    "--story", "US-WS-007",
    "--story", "US-WS-008",
  ];
}

function activateDecoyWorkspace(f: ReturnType<typeof fixture>): string {
  const decoy = join(f.home, "decoy-workspace");
  mkdirSync(decoy);
  const manifest = JSON.parse(readFileSync(join(f.workspace, "workspace.yaml"), "utf8")) as Record<string, unknown>;
  write(join(decoy, "workspace.yaml"), `${JSON.stringify({ ...manifest, workspaceId: "ws-decoy", displayName: "Decoy" }, null, 2)}\n`);
  for (const storyId of ["US-WS-007", "US-WS-008"]) {
    write(join(decoy, "backlog", "epic", storyId, "spec.md"), `# ${storyId}\n`);
  }
  const registry = new WorkspaceRegistry({ rollHome: f.rollHome, now: () => 2 });
  registry.register({ workspaceId: "ws-decoy", root: decoy });
  registry.activate("ws-decoy");
  return decoy;
}

function scrub(text: string, f: ReturnType<typeof fixture>): string {
  return text.replaceAll(realpathSync(f.home), "<HOME>").replaceAll(f.home, "<HOME>");
}

beforeEach(() => registerAll());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-007 roll workspace requirement add", () => {
  it("captures, repeats and updates a Jira-shaped local fixture through stable JSON", async () => {
    const f = fixture();
    const first = await run([...addArgs(f), "--json"], f);
    expect(first).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(first.stdout, f)).toMatchSnapshot("created-json");
    const repeated = await run([...addArgs(f), "--json"], f);
    expect(repeated).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(repeated.stdout, f)).toMatchSnapshot("reused-json");

    writeFileSync(f.body, "# SOT-15499\n\nRevision 43.\n", "utf8");
    const updatedArgs = addArgs(f).map((arg) => arg === "42" ? "43" : arg);
    const updated = await run([...updatedArgs, "--json"], f);
    expect(updated).toMatchObject({ status: 0, stderr: "" });
    expect(scrub(updated.stdout, f)).toMatchSnapshot("updated-json");
    const requirementPath = join(f.workspace, "requirements", "jira", "req-c78ccf14ea21");
    expect(existsSync(join(requirementPath, "source.yaml"))).toBe(true);
    expect(readFileSync(join(requirementPath, "requirement.md"), "utf8")).toContain("Revision 43");
  });

  it("persists an explicit campaign terminal while keeping main merge forbidden", async () => {
    const f = fixture();
    expect((await run([...addArgs(f), "--json"], f)).status).toBe(0);
    const campaignArgs = [
      ...addArgs(f),
      "--campaign-branch", "idea-074-workspace",
      "--main-merge", "forbidden",
      "--json",
    ];
    const captured = await run(campaignArgs, f);
    expect(captured).toMatchObject({ status: 0, stderr: "" });
    const source = JSON.parse(readFileSync(
      join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"),
      "utf8",
    )) as Record<string, unknown>;
    expect(source["deliveryTarget"]).toEqual({
      terminal: "campaign_branch",
      branch: "idea-074-workspace",
      mainMerge: "forbidden",
    });

    const repeatedWithoutFlags = await run([...addArgs(f), "--json"], f);
    expect(repeatedWithoutFlags.status).toBe(0);
    const preserved = JSON.parse(readFileSync(
      join(f.workspace, "requirements", "jira", "req-c78ccf14ea21", "source.yaml"),
      "utf8",
    )) as Record<string, unknown>;
    expect(preserved["deliveryTarget"]).toEqual(source["deliveryTarget"]);
  });

  it("rejects partial or non-forbidden campaign target arguments before writing", async () => {
    const f = fixture();
    const partial = await run([...addArgs(f), "--campaign-branch", "idea-074-workspace", "--json"], f);
    expect(partial.status).toBe(1);
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);

    const unsafe = await run([
      ...addArgs(f),
      "--campaign-branch", "idea-074-workspace",
      "--main-merge", "allowed",
      "--json",
    ], f);
    expect(unsafe.status).toBe(1);
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("resolves explicit, environment and cwd Workspace selectors ahead of a different active Workspace", async () => {
    const explicitFixture = fixture();
    const explicitDecoy = activateDecoyWorkspace(explicitFixture);
    const explicit = await run([...addArgs(explicitFixture), "--json"], explicitFixture);
    expect(explicit).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(explicit.stdout)).toMatchObject({ workspaceId: "ws-demo", path: expect.stringContaining(explicitFixture.workspace) });
    expect(existsSync(join(explicitDecoy, "requirements"))).toBe(false);

    const f = fixture();
    const decoy = activateDecoyWorkspace(f);
    const envArgs = addArgs(f).filter((_arg, index, all) => all[index - 1] !== "--workspace" && _arg !== "--workspace");
    const fromEnv = await run(envArgs, f, { workspaceEnv: "ws-demo" });
    expect(fromEnv).toMatchObject({ status: 0, stderr: "" });
    const envOutput = scrub(fromEnv.stdout, f);
    expect(envOutput).toMatchSnapshot("terminal-en");
    expect(envOutput).toContain("Requirement jira:SOT-15499 revision 42");
    expect(envOutput).toContain("Context files: 1");
    expect(envOutput).toContain("Path: <HOME>/workspace/requirements/jira/req-c78ccf14ea21");

    const fromCwd = await run(envArgs, f, { cwd: join(f.workspace, "backlog", "epic") });
    expect(fromCwd).toMatchObject({ status: 0, stderr: "" });
    const cwdOutput = scrub(fromCwd.stdout, f);
    expect(cwdOutput).toMatchSnapshot("terminal-cwd-reused");
    expect(cwdOutput).toContain("Requirement jira:SOT-15499 revision 42");
    expect(cwdOutput).toContain("Context files: 1");
    expect(cwdOutput).toContain("Path: <HOME>/workspace/requirements/jira/req-c78ccf14ea21");
    expect(existsSync(join(decoy, "requirements"))).toBe(false);
  });

  it("rejects credential-shaped refs and unsafe paths without echoing input or writing evidence", async () => {
    const f = fixture();
    const secret = "https://token:credential-sentinel@example.test/issue/1";
    const credentialArgs = addArgs(f).map((arg) => arg === "SOT-15499" ? secret : arg);
    const credential = await run([...credentialArgs, "--json"], f);
    expect(credential.status).toBe(1);
    expect(credential.stdout).not.toContain(secret);
    expect(credential.stdout).not.toContain("credential-sentinel");
    expect(credential.stderr).not.toContain(secret);
    expect(credential.stderr).not.toContain("credential-sentinel");
    expect(credential.stdout).toBe("");
    expect(JSON.parse(credential.stderr)).toMatchObject({ error: { code: "source_not_declared" } });
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);

    const escapeArgs = addArgs(f).map((arg) => arg === "brief.md" ? "../jira.md" : arg);
    const escape = await run([...escapeArgs, "--json"], f);
    expect(escape.status).toBe(1);
    expect(JSON.parse(escape.stderr)).toMatchObject({ error: { code: "unsafe_context" } });
    expect(existsSync(join(f.workspace, "requirements"))).toBe(false);
  });

  it("never leaks a credential sentinel embedded in the body or context content through stdout or stderr on success", async () => {
    const f = fixture();
    writeFileSync(f.body, "# SOT-15499\n\ncredential-sentinel-in-body access_token=body-secret-value\n", "utf8");
    writeFileSync(join(f.contextRoot, "brief.md"), "credential-sentinel-in-context api_key=context-secret-value\n", "utf8");

    const captured = await run([...addArgs(f), "--json"], f);
    expect(captured).toMatchObject({ status: 0, stderr: "" });
    expect(captured.stdout).not.toContain("credential-sentinel-in-body");
    expect(captured.stdout).not.toContain("body-secret-value");
    expect(captured.stdout).not.toContain("credential-sentinel-in-context");
    expect(captured.stdout).not.toContain("context-secret-value");

    const terminal = await run(addArgs(f), f);
    expect(terminal).toMatchObject({ status: 0, stderr: "" });
    expect(terminal.stdout).toContain("Requirement jira:SOT-15499 revision 42");
    expect(terminal.stdout).not.toContain("credential-sentinel-in-body");
    expect(terminal.stdout).not.toContain("body-secret-value");
    expect(terminal.stdout).not.toContain("credential-sentinel-in-context");
    expect(terminal.stdout).not.toContain("context-secret-value");

    const requirementPath = join(f.workspace, "requirements", "jira", "req-c78ccf14ea21");
    expect(readFileSync(join(requirementPath, "requirement.md"), "utf8")).toContain("body-secret-value");
    expect(readFileSync(join(requirementPath, "context", "brief.md"), "utf8")).toContain("context-secret-value");
  });

  it("reports projection drift as a non-repairing capture failure", async () => {
    const f = fixture();
    expect((await run([...addArgs(f), "--json"], f)).status).toBe(0);
    const requirementPath = join(f.workspace, "requirements", "jira", "req-c78ccf14ea21");
    writeFileSync(join(requirementPath, "attest.md"), "corrupted projection\n", "utf8");

    const repeated = await run([...addArgs(f), "--json"], f);

    expect(repeated.status).toBe(1);
    expect(repeated.stdout).toBe("");
    expect(JSON.parse(repeated.stderr)).toMatchObject({
      error: {
        code: "projection_repair_required",
        message: "Current Requirement projection is inconsistent; capture stopped without repair",
      },
    });
    expect(readFileSync(join(requirementPath, "attest.md"), "utf8")).toBe("corrupted projection\n");
  });

  it("exposes locale-specific nested help and includes requirement in Workspace help", async () => {
    const f = fixture();
    const workspace = await run(["workspace", "--help"], f, { lang: "en" });
    const en = await run(["workspace", "requirement", "--help"], f, { lang: "en" });
    const zh = await run(["workspace", "requirement", "--help"], f, { lang: "zh" });
    expect(workspace.stdout).toContain("requirement add");
    expect(en).toMatchObject({ status: 0, stderr: "" });
    expect(en.stdout).toContain("Usage: roll workspace requirement add");
    expect(en.stdout).toContain("Projection drift stops capture without repair");
    expect(zh).toMatchObject({ status: 0, stderr: "" });
    expect(zh.stdout).toContain("用法：roll workspace requirement add");
    expect(zh.stdout).toContain("投影漂移会中止采集，不会自动修复");
  });
});
