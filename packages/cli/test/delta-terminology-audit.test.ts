/**
 * US-DELTA-008 AC8 — Terminology audit / source scan.
 *
 * Locks the health-routing rename (`AgentHealthIssue.routing`) from the retired,
 * overloaded literal `delta_team` to `delivery_team`, and guarantees that the
 * two vocabularies never re-conflate:
 *   - HEALTH routing literal  → `delivery_team`   (underscore)
 *   - delivery TOPOLOGY names  → `delta-team` / `full-delta-team` (hyphen)
 *
 * The ban is specifically on the underscore literal `delta_team` anywhere in
 * production source. Hyphenated topology strings are legitimate and untouched.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");

/** Production source roots to scan (test dirs deliberately excluded). */
const SRC_ROOTS = [
  "packages/spec/src",
  "packages/core/src",
  "packages/cli/src",
];

function collectTsFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip nested test folders and build artifacts if any live under src.
      if (entry === "test" || entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
}

describe("US-DELTA-008 AC8 — health-routing terminology audit", () => {
  it("no `delta_team` health-routing literal survives in production source", () => {
    const offenders: string[] = [];
    for (const root of SRC_ROOTS) {
      const files: string[] = [];
      collectTsFiles(resolve(repo, root), files);
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (text.includes("delta_team")) {
          offenders.push(file.slice(repo.length + 1));
        }
      }
    }
    expect(
      offenders,
      `The retired health-routing literal \`delta_team\` must not appear in production source ` +
        `(use \`delivery_team\` for health routing; \`delta-team\`/\`full-delta-team\` are topology names). ` +
        `Offending files: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the rename target `delivery_team` is present where the routing literal lives", () => {
    const agentHealth = readFileSync(
      resolve(repo, "packages/core/src/supervisor/agent-health.ts"),
      "utf8",
    );
    const agentTypes = readFileSync(
      resolve(repo, "packages/spec/src/types/agent.ts"),
      "utf8",
    );
    expect(agentHealth).toContain('"delivery_team"');
    expect(agentTypes).toContain('"delivery_team"');
    // And the underscore topology-shaped literal is gone from both.
    expect(agentHealth).not.toContain("delta_team");
    expect(agentTypes).not.toContain("delta_team");
  });

  it("topology literals (hyphenated) remain intact — this ban does not touch them", () => {
    const types = readFileSync(resolve(repo, "packages/spec/src/types/delta-team.ts"), "utf8");
    // Sanity: the topology vocabulary still exists in its hyphenated form.
    expect(types).toContain("delta-team");
    expect(types).toContain("full-delta-team");
  });

  it("health-routing docs use `delivery team`, not the topology name, for the FIX target", () => {
    const routingDocs = [
      "guide/en/ai-agents.md",
      "guide/zh/ai-agents.md",
      "guide/en/loop.md",
      "guide/zh/loop.md",
    ].map((p) => readFileSync(resolve(repo, p), "utf8")).join("\n");
    // The remediation route is the "delivery team"; it must not be written as the
    // topology "delta team" in these health-routing sentences.
    expect(routingDocs).toContain("delivery team");
    expect(routingDocs).not.toContain("delta team as a FIX");
    expect(routingDocs).not.toContain("路由给 delta team");
    expect(routingDocs).not.toContain("backlog/delta team");
  });
});
