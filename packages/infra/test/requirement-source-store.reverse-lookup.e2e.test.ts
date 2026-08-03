import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const infraDist = resolve(here, "../dist/requirement-source-store.js");
const repoRoot = resolve(here, "../../..");
const roots: string[] = [];

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe("US-WS-007 Story reverse lookup — fresh process proof", () => {
  it("resolves a Story's Requirement sources from a genuinely separate child process reading only from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "roll-reverse-lookup-e2e-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    write(join(workspace, "workspace.yaml"), `${JSON.stringify({
      schema: "roll.workspace/v1",
      workspaceId: "ws-e2e",
      displayName: "Reverse Lookup E2E",
      requirements: [{ provider: "jira", ref: "SOT-15499" }],
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
    write(join(workspace, "backlog", "epic", "US-WS-007", "spec.md"), "# US-WS-007\n");
    write(join(workspace, "backlog", "epic", "US-WS-008", "spec.md"), "# US-WS-008\n");
    const body = join(root, "requirement.md");
    write(body, "# Jira requirement\n\nFresh process reverse lookup fixture.\n");

    const infraDistUrl = `file://${infraDist}`;
    const captureScript = `
      import { captureRequirementSource } from ${JSON.stringify(infraDistUrl)};
      captureRequirementSource({
        rollHome: ${JSON.stringify(root)},
        workspaceRoot: ${JSON.stringify(workspace)},
        provider: "jira",
        ref: "SOT-15499",
        revision: "42",
        capturedAt: "2026-07-20T16:00:00.000Z",
        bodyFile: ${JSON.stringify(body)},
        contextPaths: [],
        storyIds: ["US-WS-007", "US-WS-008"],
      });
    `;
    const captureProcess = spawnSync(process.execPath, ["--input-type=module", "-e", captureScript], { encoding: "utf8", cwd: repoRoot });
    expect(captureProcess.status, captureProcess.stderr).toBe(0);

    const lookupScript = `
      import { resolveRequirementSourcesForStoryOnDisk } from ${JSON.stringify(infraDistUrl)};
      const project = (storyId) => resolveRequirementSourcesForStoryOnDisk(${JSON.stringify(workspace)}, storyId)
        .map((m) => ({ provider: m.provider, ref: m.ref, revision: m.revision }));
      process.stdout.write(JSON.stringify({ ws007: project("US-WS-007"), ws008: project("US-WS-008") }));
    `;
    const lookupProcess = spawnSync(process.execPath, ["--input-type=module", "-e", lookupScript], { encoding: "utf8", cwd: repoRoot });
    expect(lookupProcess.status, lookupProcess.stderr).toBe(0);
    const resolved = JSON.parse(lookupProcess.stdout) as Record<string, ReadonlyArray<{ provider: string; ref: string; revision: string }>>;
    const expected = [{ provider: "jira", ref: "SOT-15499", revision: "42" }];
    expect(resolved).toEqual({ ws007: expected, ws008: expected });

    const emptyLookupScript = `
      import { resolveRequirementSourcesForStoryOnDisk } from ${JSON.stringify(infraDistUrl)};
      const resolved = resolveRequirementSourcesForStoryOnDisk(${JSON.stringify(workspace)}, "US-UNKNOWN");
      process.stdout.write(JSON.stringify(resolved));
    `;
    const emptyLookupProcess = spawnSync(process.execPath, ["--input-type=module", "-e", emptyLookupScript], { encoding: "utf8", cwd: repoRoot });
    expect(emptyLookupProcess.status, emptyLookupProcess.stderr).toBe(0);
    expect(JSON.parse(emptyLookupProcess.stdout)).toEqual([]);
  });
});
