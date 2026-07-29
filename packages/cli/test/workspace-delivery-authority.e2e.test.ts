import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attestCommand } from "../src/commands/attest.js";

function workspace(name: string, title: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `roll-ws-delivery-${name}-`)));
  const storyDir = join(root, "features", "delivery", "US-SAME-9");
  mkdirSync(join(root, "backlog"), { recursive: true });
  mkdirSync(storyDir, { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  writeFileSync(join(root, "backlog", "index.md"), [
    "| ID | Description | Status |",
    "|----|----|----|",
    `| [US-SAME-9](../features/delivery/US-SAME-9/spec.md) | ${title} | 🔨 In Progress |`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(storyDir, "spec.md"), [
    "---",
    "id: US-SAME-9",
    `title: ${title}`,
    "epic: delivery",
    "---",
    "",
    `# US-SAME-9 — ${title}`,
    "",
    "**AC:**",
    `- [ ] ${title} evidence remains isolated`,
    "",
  ].join("\n"), "utf8");
  return root;
}

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test capture
  process.stdout.write = (text: string): boolean => ((out += String(text)), true);
  // @ts-expect-error test capture
  process.stderr.write = (text: string): boolean => ((err += String(text)), true);
  try {
    return { code: await run(), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe("US-WS-034 delivery and evidence authority", () => {
  it("keeps attest output isolated for the same Story ID in two Workspaces", async () => {
    const alpha = workspace("alpha", "Alpha delivery");
    const beta = workspace("beta", "Beta delivery");

    const alphaResult = await capture(() => attestCommand(["US-SAME-9"], {
      projectPath: alpha,
      now: () => new Date("2026-07-24T10:00:00Z"),
    }));
    const betaResult = await capture(() => attestCommand(["US-SAME-9"], {
      projectPath: beta,
      now: () => new Date("2026-07-24T10:00:01Z"),
    }));

    expect(alphaResult.code).toBe(0);
    expect(betaResult.code).toBe(0);
    const alphaReport = join(alpha, "features", "delivery", "US-SAME-9", "latest", "US-SAME-9-report.html");
    const betaReport = join(beta, "features", "delivery", "US-SAME-9", "latest", "US-SAME-9-report.html");
    expect(existsSync(alphaReport)).toBe(true);
    expect(existsSync(betaReport)).toBe(true);
    expect(readFileSync(alphaReport, "utf8")).toContain("Alpha delivery");
    expect(readFileSync(alphaReport, "utf8")).not.toContain("Beta delivery");
    expect(readFileSync(betaReport, "utf8")).toContain("Beta delivery");
    expect(readFileSync(betaReport, "utf8")).not.toContain("Alpha delivery");
    expect(existsSync(join(alpha, ".roll"))).toBe(false);
    expect(existsSync(join(beta, ".roll"))).toBe(false);
  });

  it("reports the canonical features authority when a Story is missing", async () => {
    const alpha = workspace("missing", "Missing story fixture");
    const result = await capture(() => attestCommand(["US-NOT-THERE"], { projectPath: alpha }));

    expect(result.code).toBe(1);
    expect(result.err).toContain("not found under features/");
    expect(result.err).not.toContain(".roll/features/");
  });
});
