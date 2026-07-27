import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkspaceContextFixture, treeDigest } from "./fixtures/workspace-context/fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const rollBin = join(root, "packages", "cli", "bin", "roll.js");
const fixture = createWorkspaceContextFixture();
const env = {
  ...process.env,
  HOME: fixture.home,
  ROLL_HOME: fixture.rollHome,
  ROLL_LANG: "en",
  NO_COLOR: "1",
  CI: "1",
  GIT_CONFIG_NOSYSTEM: "1",
};

function run(args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [rollBin, ...args], {
    cwd: fixture.outside,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

afterAll(() => rmSync(fixture.home, { recursive: true, force: true }));

describe("US-WS-040 public Workspace context boundary", () => {
  it("keeps full command and selector aliases byte-equivalent from a poisoned arbitrary cwd", () => {
    expect(run(["workspace", "register", "alpha", fixture.alpha]).status).toBe(0);
    expect(run(["workspace", "register", "beta", fixture.beta]).status).toBe(0);
    expect(run(["workspace", "activate", "alpha"]).status).toBe(0);

    const canonical = run(["workspace", "show", "--workspace", "beta", "--json"]);
    const alias = run(["ws", "show", "--ws", "beta", "--json"]);
    expect(alias).toMatchObject({ status: canonical.status, stdout: canonical.stdout, stderr: canonical.stderr });
    expect(JSON.parse(alias.stdout)).toMatchObject({ workspace: { workspaceId: "beta" } });

    const backlogCanonical = run(["backlog", "--workspace", "beta"]);
    const backlogAlias = run(["backlog", "--ws", "beta"]);
    expect(backlogAlias).toMatchObject({ status: backlogCanonical.status, stdout: backlogCanonical.stdout, stderr: backlogCanonical.stderr });
    expect(backlogAlias.stdout).toContain("beta story");
    expect(backlogAlias.stdout).not.toContain("POISON");
  });

  it("fails closed on duplicate/missing selectors and removed init without mutation", () => {
    const before = treeDigest(fixture.home);
    const duplicate = run(["backlog", "--workspace", "alpha", "--ws", "beta", "--json"]);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("duplicate_workspace_selector");
    const missing = run(["backlog", "--ws"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("workspace_selector_missing_value");
    const retired = run(["ws", "init"]);
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain("roll workspace: unknown or unregistered route 'init'");
    expect(treeDigest(fixture.home)).toBe(before);
  });
});
