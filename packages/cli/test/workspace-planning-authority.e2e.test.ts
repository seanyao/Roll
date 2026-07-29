import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { storyNewCommand } from "../src/commands/story-new.js";
import { ideaCommand } from "../src/commands/idea.js";
import { designCommand } from "../src/commands/design.js";
import { indexCommand } from "../src/commands/index-gen.js";
import type { BacklogTargetDecision } from "../src/commands/backlog-target.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    try {
      process.chdir(tmpdir());
      // Test sandboxes are process-owned and isolated under the OS temp root.
      // Cleanup is intentionally left to the OS so the test never deletes a
      // path selected by production code.
      void dir;
    } catch {
      // best-effort cwd restoration only
    }
  }
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "roll-ws-planning-")));
  dirs.push(base);
  const cwd = join(base, "arbitrary-cwd");
  const workspaceRoot = join(base, "workspace-alpha");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(workspaceRoot, "backlog"), { recursive: true });
  mkdirSync(join(workspaceRoot, "features"), { recursive: true });
  mkdirSync(join(workspaceRoot, "runtime"), { recursive: true });
  writeFileSync(join(workspaceRoot, "backlog", "index.md"), "| ID | Description | Status |\n|----|----|----|\n", "utf8");
  const target: BacklogTargetDecision = {
    ok: true,
    workspaceId: "alpha",
    workspaceRoot,
    canonicalRoot: workspaceRoot,
    backlogPath: join(workspaceRoot, "backlog", "index.md"),
    storyRoot: join(workspaceRoot, "features"),
    runtimeRoot: join(workspaceRoot, "runtime"),
    configPath: join(workspaceRoot, "runtime", "backlog-sync.yaml"),
  };
  return { cwd, workspaceRoot, target };
}

function capture(run: () => number): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (text: string): boolean => ((out += String(text)), true);
  // @ts-expect-error test capture
  process.stderr.write = (text: string): boolean => ((err += String(text)), true);
  try {
    return { code: run(), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe("US-WS-034 planning authority", () => {
  it("mints a Story in canonical Workspace authority from an arbitrary cwd without legacy dual-write", () => {
    const f = fixture();
    const previous = process.cwd();
    process.chdir(f.cwd);
    try {
      const result = capture(() => storyNewCommand(
        ["US-SAME-1", "--title", "canonical card", "--epic", "planning", "--workspace", "alpha"],
        { resolveTarget: () => f.target },
      ));
      expect(result.code).toBe(0);
      expect(existsSync(join(f.workspaceRoot, "features", "planning", "US-SAME-1", "spec.md"))).toBe(true);
      expect(readFileSync(join(f.workspaceRoot, "backlog", "index.md"), "utf8")).toContain(
        "| [US-SAME-1](../features/planning/US-SAME-1/spec.md) | canonical card | 📋 Todo |",
      );
      expect(existsSync(join(f.cwd, ".roll"))).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it("fails closed before writing when a mutation has no selected Workspace", () => {
    const f = fixture();
    const previous = process.cwd();
    process.chdir(f.cwd);
    try {
      const result = capture(() => storyNewCommand(
        ["US-SAME-2", "--title", "must not exist", "--epic", "planning"],
        { resolveTarget: () => ({ ok: false, code: "target_missing", candidates: [] }) },
      ));
      expect(result.code).toBe(1);
      expect(result.err).toContain("target_missing");
      expect(existsSync(join(f.workspaceRoot, "features", "planning", "US-SAME-2"))).toBe(false);
      expect(existsSync(join(f.cwd, ".roll"))).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it("captures an idea only in the selected Workspace and excludes selector tokens from the description", () => {
    const f = fixture();
    const previous = process.cwd();
    process.chdir(f.cwd);
    try {
      const result = capture(() => ideaCommand(
        ["workspace backlog improvement", "--workspace", "alpha", "--no-color"],
        {
          projectPath: f.workspaceRoot,
          backlogPath: join(f.workspaceRoot, "backlog", "index.md"),
          featuresDir: join(f.workspaceRoot, "features"),
          canonical: true,
          remoteBacklogIds: () => [],
        },
      ));
      expect(result.code).toBe(0);
      const backlog = readFileSync(join(f.workspaceRoot, "backlog", "index.md"), "utf8");
      expect(backlog).toContain("workspace backlog improvement");
      expect(backlog).not.toContain("workspace backlog improvement alpha");
      expect(existsSync(join(f.workspaceRoot, "features", "backlog-lifecycle", "IDEA-001", "spec.md"))).toBe(true);
      expect(existsSync(join(f.cwd, ".roll"))).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it("reads the selected Workspace backlog for the bounded bare-design path", () => {
    const f = fixture();
    writeFileSync(
      join(f.workspaceRoot, "backlog", "index.md"),
      "| ID | Description | Status |\n|----|----|----|\n| US-DESIGN-1 | design me | 📋 Todo |\n",
      "utf8",
    );
    const result = capture(() => designCommand([], { cwd: f.workspaceRoot }) as number);
    expect(result.code).toBe(0);
    expect(result.out).toContain("roll design");
    expect(existsSync(join(f.workspaceRoot, ".roll"))).toBe(false);
  });

  it("regenerates the canonical derived index idempotently", () => {
    const f = fixture();
    expect(storyNewCommand(
      ["US-INDEX-1", "--title", "indexed card", "--epic", "planning", "--workspace", "alpha"],
      { resolveTarget: () => f.target },
    )).toBe(0);
    const firstRun = capture(() => indexCommand(["--rebuild"], { projectPath: f.workspaceRoot }));
    expect(firstRun.code).toBe(0);
    expect(firstRun.out).toContain("stories mapped to epics (index.json)");
    expect(firstRun.out).not.toContain(".roll/index.json");
    const path = join(f.workspaceRoot, "index.json");
    const first = readFileSync(path, "utf8");
    expect(indexCommand(["--rebuild"], { projectPath: f.workspaceRoot })).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(JSON.parse(first)).toMatchObject({ stories: { "US-INDEX-1": "planning" } });
    expect(existsSync(join(f.workspaceRoot, ".roll"))).toBe(false);
  });
});
