/**
 * US-PORT-019 — `roll backlog sync` command + HTTP fetch (TS port off bin/roll).
 * Injected opener / loadIssues keep it network-free.
 */
import type { GhIssue } from "@roll/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HttpResponse,
  type SyncDeps,
  backlogSyncCommand,
  fetchIssues,
  resolveToken,
} from "../src/commands/backlog-sync.js";
import { stripAnsi } from "../src/render.js";

let cwd0: string;
let dir: string;
beforeEach(() => {
  cwd0 = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "backlog-sync-"));
  process.chdir(dir);
  mkdirSync(".roll", { recursive: true });
});
afterEach(() => {
  process.chdir(cwd0);
  rmSync(dir, { recursive: true, force: true });
});

function capture(fn: () => Promise<number>): Promise<{ status: number; out: string; err: string }> {
  const o: string[] = [];
  const e: string[] = [];
  const wo = process.stdout.write.bind(process.stdout);
  const we = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((x: string | Uint8Array) => (o.push(String(x)), true)) as typeof process.stdout.write;
  process.stderr.write = ((x: string | Uint8Array) => (e.push(String(x)), true)) as typeof process.stderr.write;
  return fn().then(
    (status) => {
      process.stdout.write = wo;
      process.stderr.write = we;
      return { status, out: stripAnsi(o.join("")), err: stripAnsi(e.join("")) };
    },
    (err) => {
      process.stdout.write = wo;
      process.stderr.write = we;
      throw err;
    },
  );
}

const HEADER = "| ID | Description | Status |\n|----|----|----|\n";
function seedBacklog(rows = ""): void {
  writeFileSync(join(".roll", "backlog.md"), HEADER + rows);
}
function deps(issues: GhIssue[]): SyncDeps {
  return { loadIssues: async () => issues, nowIso: () => "2026-06-09T00:00:00Z" };
}

describe("resolveToken — US-PORT-019", () => {
  it("prefers GITHUB_TOKEN env", () => {
    expect(resolveToken({ GITHUB_TOKEN: "envtok" }, () => "ghtok")).toBe("envtok");
  });
  it("falls back to gh auth token", () => {
    expect(resolveToken({}, () => "ghtok")).toBe("ghtok");
  });
  it("throws when neither is available", () => {
    expect(() => resolveToken({}, () => null)).toThrow(/no GitHub credential/);
  });
});

describe("fetchIssues — US-PORT-019", () => {
  function resp(body: unknown, headers: Record<string, string> = {}): HttpResponse {
    return { status: 200, headers, body: JSON.stringify(body) };
  }

  it("follows Link pagination and filters out PRs", async () => {
    const calls: string[] = [];
    const opener = async (url: string): Promise<HttpResponse> => {
      calls.push(url);
      if (url.includes("page=2")) {
        return resp([{ number: 3, title: "third" }]);
      }
      return resp(
        [
          { number: 1, title: "first" },
          { number: 2, title: "a PR", pull_request: { url: "x" } },
        ],
        { link: '<https://api.github.com/x?page=2>; rel="next"' },
      );
    };
    const issues = await fetchIssues("o", "r", { token: "t", opener });
    expect(issues.map((i) => i.number)).toEqual([1, 3]); // PR #2 dropped, page 2 followed
    expect(calls.length).toBe(2);
  });

  it("401/403 → auth error", async () => {
    const opener = async (): Promise<HttpResponse> => ({ status: 403, headers: {}, body: "" });
    await expect(fetchIssues("o", "r", { token: "t", opener })).rejects.toThrow(/check your token scopes/);
  });

  it("429 → rate-limit error", async () => {
    const opener = async (): Promise<HttpResponse> => ({ status: 429, headers: {}, body: "" });
    await expect(fetchIssues("o", "r", { token: "t", opener })).rejects.toThrow(/rate limit/i);
  });
});

describe("backlogSyncCommand — US-PORT-019", () => {
  it("no --repo and no config → usage, exit 1", async () => {
    seedBacklog();
    const r = await capture(() => backlogSyncCommand([], deps([])));
    expect(r.status).toBe(1);
    expect(r.err).toContain("首次 sync 必须显式 --repo");
  });

  it("invalid --repo → exit 1", async () => {
    seedBacklog();
    const r = await capture(() => backlogSyncCommand(["--repo", "noslash"], deps([])));
    expect(r.status).toBe(1);
    expect(r.err).toContain("expected owner/repo");
  });

  it("--dry-run previews without writing backlog", async () => {
    seedBacklog("| US-GH-1 | existing | 📋 Todo |\n");
    const before = readFileSync(join(".roll", "backlog.md"), "utf8");
    const issues: GhIssue[] = [
      { number: 1, title: "existing", state: "open" },
      { number: 2, title: "new bug", state: "open", labels: [{ name: "bug" }] },
    ];
    const r = await capture(() => backlogSyncCommand(["--repo", "acme/widgets", "--dry-run"], deps(issues)));
    expect(r.status).toBe(0);
    expect(r.out).toContain("+ GH-2 [FIX] new bug");
    expect(r.out).toContain("= GH-1 [US] (skipped, already exists)");
    expect(r.out).toContain("dry-run, no changes written");
    expect(readFileSync(join(".roll", "backlog.md"), "utf8")).toBe(before); // untouched
  });

  it("apply: appends new rows, writes feature stub, persists config", async () => {
    seedBacklog();
    const issues: GhIssue[] = [
      {
        number: 7,
        title: "sync from issues",
        state: "open",
        labels: [{ name: "enhancement" }],
        body: "- [ ] map labels\n- [ ] dedup by id\n",
      },
    ];
    const r = await capture(() => backlogSyncCommand(["--repo", "acme/widgets"], deps(issues)));
    expect(r.status).toBe(0);
    // row appended
    const backlog = readFileSync(join(".roll", "backlog.md"), "utf8");
    expect(backlog).toContain("| US-GH-7 | sync from issues | 📋 Todo |");
    // feature stub with AC
    const stub = readFileSync(join(".roll", "features", "backlog-lifecycle", "GH-7.md"), "utf8");
    expect(stub).toContain("# GH-7 sync from issues");
    expect(stub).toContain("- [ ] map labels");
    // config persisted
    const cfg = readFileSync(join(".roll", "local.yaml"), "utf8");
    expect(cfg).toContain("backlog_sync:");
    expect(cfg).toContain("repo: acme/widgets");
    expect(r.out).toContain("added: 1, skipped: 0");
  });

  it("idempotent re-sync: second run skips the already-present id", async () => {
    seedBacklog();
    const issues: GhIssue[] = [{ number: 9, title: "once", state: "open" }];
    await capture(() => backlogSyncCommand(["--repo", "a/b"], deps(issues)));
    const r2 = await capture(() => backlogSyncCommand(["--repo", "a/b"], deps(issues)));
    expect(r2.out).toContain("skipped (already exists): GH-9");
    expect(r2.out).toContain("added: 0, skipped: 1");
  });

  it("reuses the persisted repo when --repo is omitted", async () => {
    seedBacklog();
    writeFileSync(
      join(".roll", "local.yaml"),
      "backlog_sync:\n  repo: saved/repo\n  labels: []\n",
    );
    const issues: GhIssue[] = [{ number: 5, title: "from saved", state: "open" }];
    const r = await capture(() => backlogSyncCommand([], deps(issues)));
    expect(r.status).toBe(0);
    expect(readFileSync(join(".roll", "backlog.md"), "utf8")).toContain("US-GH-5");
  });
});
