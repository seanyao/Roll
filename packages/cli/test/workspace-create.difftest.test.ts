import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../src/bridge.js";
import { registerAll } from "../src/commands/index.js";

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
const roots: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rollBin = join(repoRoot, "packages", "cli", "bin", "roll.js");

interface CreateFixture {
  readonly home: string;
  readonly rollHome: string;
  readonly workspace: string;
  readonly config: string;
  readonly legacyConfig: string;
  readonly unknownConfig: string;
  readonly missingConfig: string;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

function createFixture(): CreateFixture {
  const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-parity-"));
  roots.push(home);
  const source = join(home, "source");
  const remote = join(home, "product.git");
  const workspace = join(home, "workspace");
  const config = join(home, "workspace-create.yaml");
  const legacyConfig = join(home, "workspace-legacy.yaml");
  const unknownConfig = join(home, "workspace-unknown.yaml");
  const missingConfig = join(home, "missing.yaml");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "user.email", "roll@example.test"]);
  git(source, ["config", "user.name", "Roll Test"]);
  writeFileSync(join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-q", "-m", "fixture"]);
  git(home, ["clone", "-q", "--bare", source, remote]);
  const body = `id: ws-demo\nroot: ${workspace}\nrepositories:\n  - alias: product\n    source: file://${remote}\n    integration_branch: main\n`;
  writeFileSync(config, `schema: roll.workspace-create/v1\n${body}`, "utf8");
  writeFileSync(legacyConfig, `schema: roll.workspace-init/v1\n${body}`, "utf8");
  writeFileSync(unknownConfig, `schema: roll.workspace-create/v2\n${body}`, "utf8");
  return { home, rollHome: join(home, ".roll"), workspace, config, legacyConfig, unknownConfig, missingConfig };
}

function resetCreateState(fixture: CreateFixture): void {
  rmSync(fixture.rollHome, { recursive: true, force: true });
  rmSync(fixture.workspace, { recursive: true, force: true });
}

function collectNextActions(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectNextActions);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => key === "nextAction" && typeof entry === "string"
    ? [entry]
    : collectNextActions(entry));
}

function tree(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const rows: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const target = join(path, entry.name);
      const relative = target.slice(root.length + 1);
      const stat = statSync(target);
      rows.push(`${entry.isDirectory() ? "d" : "f"}:${relative}:${stat.mode}:${stat.size}`);
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(root);
  return rows;
}

async function run(args: string[], home: string, language: "en" | "zh" = "en"): Promise<Run> {
  const saved = { HOME: process.env["HOME"], ROLL_HOME: process.env["ROLL_HOME"], ROLL_LANG: process.env["ROLL_LANG"] };
  process.env["HOME"] = home;
  process.env["ROLL_HOME"] = join(home, ".roll");
  process.env["ROLL_LANG"] = language;
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
  // @ts-expect-error capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => (stderr += String(chunk), true);
  try {
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

beforeEach(() => registerAll());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-023 create-only CLI", () => {
  it("keeps every workspace/ws create surface byte-equivalent and canonical", async () => {
    const fixture = createFixture();
    const createArgs = (config: string, extra: readonly string[] = []) => ["create", "ws-demo", "--config", config, ...extra];
    const prepareFresh = (): void => resetCreateState(fixture);
    const prepareReuse = async (): Promise<void> => {
      resetCreateState(fixture);
      const seeded = await run(["workspace", ...createArgs(fixture.config, ["--json"])], fixture.home);
      expect(seeded.status, seeded.stderr).toBe(0);
    };
    const prepareRejected = (): void => {
      resetCreateState(fixture);
      mkdirSync(fixture.workspace, { recursive: true });
      writeFileSync(join(fixture.workspace, "workspace.yaml"), "operator-owned conflict\n", "utf8");
    };
    const cases: readonly {
      readonly name: string;
      readonly args: readonly string[];
      readonly prepare: () => void | Promise<void>;
      readonly expectedStatus: 0 | 1;
      readonly verify: (result: Run) => void;
    }[] = [
      {
        name: "help",
        args: ["create", "--help"],
        prepare: prepareFresh,
        expectedStatus: 0,
        verify: (result) => expect(result).toEqual({ status: 0, stderr: "", stdout: "Usage: roll workspace create <id> --config <file> [--authorization <file>] [--check] [--json]\n" }),
      },
      {
        name: "check",
        args: createArgs(fixture.config, ["--check", "--json"]),
        prepare: prepareFresh,
        expectedStatus: 0,
        verify: (result) => expect(JSON.parse(result.stdout)).toMatchObject({ schema: "roll.workspace-create-result/v1", mode: "check", outcome: "created" }),
      },
      {
        name: "apply",
        args: createArgs(fixture.config, ["--json"]),
        prepare: prepareFresh,
        expectedStatus: 0,
        verify: (result) => expect(JSON.parse(result.stdout)).toMatchObject({ schema: "roll.workspace-create-result/v1", mode: "apply", outcome: "created" }),
      },
      {
        name: "reuse",
        args: createArgs(fixture.config, ["--json"]),
        prepare: prepareReuse,
        expectedStatus: 0,
        verify: (result) => expect(JSON.parse(result.stdout)).toMatchObject({ schema: "roll.workspace-create-result/v1", mode: "apply", outcome: "reused" }),
      },
      {
        name: "rejected plan",
        args: createArgs(fixture.config, ["--check", "--json"]),
        prepare: prepareRejected,
        expectedStatus: 1,
        verify: (result) => expect(JSON.parse(result.stdout)).toMatchObject({
          schema: "roll.workspace-create-result/v1",
          mode: "check",
          outcome: "rejected",
          steps: expect.arrayContaining([expect.objectContaining({ action: "rejected" })]),
        }),
      },
      {
        name: "legacy config",
        args: createArgs(fixture.legacyConfig, ["--json"]),
        prepare: prepareFresh,
        expectedStatus: 1,
        verify: (result) => expect(JSON.parse(result.stderr)).toMatchObject({ schema: "roll.workspace-create-error/v1", error: { code: "legacy_create_config", nextAction: "roll workspace create ws-demo --config <converted-path>" } }),
      },
      {
        name: "invalid arguments",
        args: ["create", "ws-demo", "--unknown", "--json"],
        prepare: prepareFresh,
        expectedStatus: 1,
        verify: (result) => expect(JSON.parse(result.stderr)).toMatchObject({ schema: "roll.workspace-create-error/v1", error: { code: "invalid_arguments" } }),
      },
      {
        name: "unknown schema",
        args: createArgs(fixture.unknownConfig, ["--json"]),
        prepare: prepareFresh,
        expectedStatus: 1,
        verify: (result) => expect(JSON.parse(result.stderr)).toMatchObject({ schema: "roll.workspace-create-error/v1", error: { code: "unknown_version" } }),
      },
      {
        name: "config read error",
        args: createArgs(fixture.missingConfig, ["--json"]),
        prepare: prepareFresh,
        expectedStatus: 1,
        verify: (result) => expect(JSON.parse(result.stderr)).toMatchObject({ schema: "roll.workspace-create-error/v1", error: { code: "config_read_failed" } }),
      },
    ];

    for (const testCase of cases) {
      await testCase.prepare();
      const canonical = await run(["workspace", ...testCase.args], fixture.home);
      await testCase.prepare();
      const alias = await run(["ws", ...testCase.args], fixture.home);

      expect(alias.status, `${testCase.name} status`).toBe(canonical.status);
      expect(alias.stdout, `${testCase.name} stdout`).toBe(canonical.stdout);
      expect(alias.stderr, `${testCase.name} stderr`).toBe(canonical.stderr);
      expect(canonical.status, testCase.name).toBe(testCase.expectedStatus);
      testCase.verify(canonical);
      expect(`${canonical.stdout}${canonical.stderr}`, testCase.name).not.toContain("roll ws create");
      for (const stream of [canonical.stdout, canonical.stderr]) {
        if (!stream.trimStart().startsWith("{")) continue;
        for (const action of collectNextActions(JSON.parse(stream))) {
          expect(action, `${testCase.name} nextAction`).toContain("roll workspace create");
          expect(action, `${testCase.name} nextAction`).not.toContain("roll ws create");
        }
      }
    }
  });

  it("does not register workspace init or ws init and never opens config or changes state", async () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-init-reject-"));
    roots.push(home);
    const marker = join(home, "must-not-read.yaml");
    writeFileSync(marker, "sentinel", "utf8");
    const original = readFileSync(marker, "utf8");
    const environment = { HOME: process.env["HOME"], ROLL_HOME: process.env["ROLL_HOME"], ROLL_LANG: process.env["ROLL_LANG"] };
    chmodSync(marker, 0o000);
    try {
      expect(() => readFileSync(marker, "utf8")).toThrow();
      const before = tree(home);
      for (const command of ["workspace", "ws"] as const) {
        const result = await run([command, "init", "ws-demo", "--config", marker], home);
        expect(result, command).toEqual({
          status: 1,
          stdout: "",
          stderr: "roll workspace: unknown or unregistered route 'init ws-demo'\n",
        });
        expect(result.stderr, command).not.toContain("config_read_failed");
        expect(tree(home), command).toEqual(before);
        expect({ HOME: process.env["HOME"], ROLL_HOME: process.env["ROLL_HOME"], ROLL_LANG: process.env["ROLL_LANG"] }, command)
          .toEqual(environment);
      }
    } finally {
      chmodSync(marker, 0o600);
    }
    expect(readFileSync(marker, "utf8")).toBe(original);
  });

  it("returns a create/v1 conversion error for the legacy config without applying it", async () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-legacy-"));
    roots.push(home);
    const config = join(home, "legacy.yaml");
    writeFileSync(config, `schema: roll.workspace-init/v1\nid: ws-demo\nroot: ${join(home, "workspace")}\nrepositories:\n  - alias: product\n    source: file://${join(home, "product.git")}\n    integration_branch: main\n`, "utf8");

    const result = await run(["workspace", "create", "ws-demo", "--config", config, "--json"], home);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schema: "roll.workspace-create-error/v1",
      error: {
        code: "legacy_create_config",
        message: "Legacy Workspace init config must be converted before create",
        conversions: [{ path: "schema", from: "roll.workspace-init/v1", to: "roll.workspace-create/v1" }],
        nextAction: "roll workspace create ws-demo --config <converted-path>",
      },
    });
  });

  it("keeps the real top-level roll init help byte-identical and read-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "roll-top-level-init-"));
    roots.push(home);
    const before = tree(home);
    const result = await run(["init", "--help"], home);
    const processResult = spawnSync(process.execPath, [rollBin, "init", "--help"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, ROLL_HOME: join(home, ".roll"), ROLL_LANG: "en", NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result).toEqual({ status: 0, stdout: processResult.stdout, stderr: processResult.stderr });
    expect(processResult.status).toBe(0);
    expect(result.stdout).toContain("Usage: roll init [--auto|--repair|--apply] [--yes|--then design]");
    expect(result.stdout).toContain("Diagnose this project and route to scaffold");
    expect(result.stdout).not.toContain("Unknown workspace subcommand");
    expect(tree(home)).toEqual(before);
  });

  it("publishes exact parent Workspace help without a create-entry init alias", async () => {
    const home = mkdtempSync(join(tmpdir(), "roll-workspace-create-parent-help-"));
    roots.push(home);
    const en = await run(["workspace", "--help"], home, "en");
    const zh = await run(["ws", "--help"], home, "zh");

    expect(en.stdout.split("\n", 1)[0]).toBe("Usage: roll workspace <create|edit|handoff|issue|requirement|doctor|migrate|list|show|register|activate|pause|archive> [options]");
    expect(zh.stdout.split("\n", 1)[0]).toBe("用法：roll workspace <create|edit|handoff|issue|requirement|doctor|migrate|list|show|register|activate|pause|archive> [选项]");
    for (const output of [en.stdout, zh.stdout]) {
      expect(output).not.toMatch(/`init <(?:id|ID)> --config/u);
      expect(output).toContain("`issue init <");
    }
  });

  it("records an honest physical-capture skip beside a redacted headless transcript", () => {
    const evidenceRoot = join(repoRoot, "packages", "cli", "test", "fixtures", "workspace", "us-ws-023-terminal-evidence");
    const skip = JSON.parse(readFileSync(join(evidenceRoot, "capture-skip.json"), "utf8")) as {
      readonly captures: readonly { readonly taken: boolean; readonly skipped: string; readonly out: string }[];
      readonly fallback: { readonly path: string; readonly countsAsScreenshot: boolean };
    };
    const transcript = readFileSync(join(evidenceRoot, skip.fallback.path), "utf8");

    expect(skip.captures).toEqual([expect.objectContaining({
      taken: false,
      out: "screenshots/terminal.png",
      skipped: expect.stringContaining("no PNG was fabricated"),
    })]);
    expect(skip.fallback.countsAsScreenshot).toBe(false);
    expect(existsSync(join(evidenceRoot, "screenshots", "terminal.png"))).toBe(false);
    expect(transcript).toContain("Usage: roll workspace create");
    expect(transcript).not.toContain("roll workspace init");
    expect(transcript).not.toContain("/Users/");
  });
});
