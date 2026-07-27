import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const poison = vi.hoisted(() => ({
  configPath: "",
  createHandler: vi.fn(async (): Promise<number> => { throw new Error("workspace create handler poison"); }),
  targetFsCall: vi.fn(),
  childProcessCall: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const poisonTarget = (operation: string, args: readonly unknown[]): unknown => {
    if (String(args[0]) === poison.configPath) {
      poison.targetFsCall(operation);
      throw new Error(`${operation} target config poison`);
    }
    return Reflect.apply(actual[operation as keyof typeof actual] as (...values: unknown[]) => unknown, actual, args);
  };
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => poisonTarget("readFileSync", args),
    openSync: (...args: unknown[]) => poisonTarget("openSync", args),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const poisoned = (operation: string) => (..._args: unknown[]): never => {
    poison.childProcessCall(operation);
    throw new Error(`${operation} child process poison`);
  };
  return {
    ...actual,
    exec: poisoned("exec"),
    execFile: poisoned("execFile"),
    execFileSync: poisoned("execFileSync"),
    execSync: poisoned("execSync"),
    spawn: poisoned("spawn"),
    spawnSync: poisoned("spawnSync"),
  };
});

vi.mock("../src/commands/workspace-create.js", () => ({ workspaceCreateCommand: poison.createHandler }));

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }
let dispatch: (args: string[], fallback: () => Promise<{ readonly ok: true }>) => Promise<{ readonly status: number }>;
let registerAll: () => void;
let home: string;
const savedEnvironment = {
  HOME: process.env["HOME"],
  ROLL_HOME: process.env["ROLL_HOME"],
  ROLL_LANG: process.env["ROLL_LANG"],
};

async function capture(args: string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error capture seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => (stdout += String(chunk), true);
  // @ts-expect-error capture seam
  process.stderr.write = (chunk: string | Uint8Array): boolean => (stderr += String(chunk), true);
  try {
    const result = await dispatch(args, async () => ({ ok: true }));
    return { status: result.status, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "roll-workspace-init-router-boundary-"));
  poison.configPath = join(home, "poison.yaml");
  writeFileSync(poison.configPath, "must never be opened\n", "utf8");
  process.env["HOME"] = home;
  process.env["ROLL_HOME"] = join(home, ".roll");
  process.env["ROLL_LANG"] = "en";
  ({ dispatch } = await import("../src/bridge.js"));
  ({ registerAll } = await import("../src/commands/index.js"));
});

beforeEach(() => {
  poison.createHandler.mockClear();
  poison.targetFsCall.mockClear();
  poison.childProcessCall.mockClear();
  registerAll();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("US-WS-023 removed init router boundary", () => {
  it.each(["workspace", "ws"] as const)("does not register %s init and stops before every execution seam", async (command) => {
    const result = await capture([command, "init", "ws-demo", "--config", poison.configPath]);

    expect(result).toEqual({
      status: 1,
      stdout: "",
      stderr: "roll workspace: unknown or unregistered route 'init ws-demo'\n",
    });
    expect(poison.createHandler).toHaveBeenCalledTimes(0);
    expect(poison.targetFsCall).toHaveBeenCalledTimes(0);
    expect(poison.childProcessCall).toHaveBeenCalledTimes(0);
  });
});
