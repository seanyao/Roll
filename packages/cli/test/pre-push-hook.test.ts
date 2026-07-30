/**
 * US-DELIV-014 — the pre-push guardrail.
 *
 * The product repo cannot have GitHub branch protection (private, Free plan),
 * so the server will happily accept a direct push to main. This hook is the
 * only thing standing between a slip of the hand and unreviewed code on the
 * integration branch — which makes its exit code worth pinning.
 *
 * It is a CLIENT-SIDE guardrail: `--no-verify` bypasses it and a machine that
 * never ran `roll setup` never installs it. That limit is stated in the hook
 * itself, and asserted here so nobody quietly upgrades the claim.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = resolve(__dirname, "../../..", "hooks/pre-push");

/** Feed one `<local ref> <local sha> <remote ref> <remote sha>` line to the hook. */
function push(remoteRef: string): { status: number; stderr: string } {
  const r = spawnSync("bash", [HOOK], {
    input: `refs/heads/x aaa ${remoteRef} bbb\n`,
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("US-DELIV-014 — pre-push refuses main, passes everything else", () => {
  it("blocks a direct push to main", () => {
    const r = push("refs/heads/main");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("main");
    // Tells the pusher what to do instead — a refusal without a route is a wall.
    expect(r.stderr).toMatch(/pr create|PR/i);
  });

  it("allows a feature branch", () => {
    expect(push("refs/heads/feat/whatever").status).toBe(0);
  });

  it("allows the release branch the release flow pushes", () => {
    expect(push("refs/heads/release/v9.9.9").status).toBe(0);
  });

  it("allows a branch whose name merely contains main", () => {
    // `refs/heads/maintenance` is not `main`; a substring match would be wrong.
    expect(push("refs/heads/maintenance").status).toBe(0);
  });

  it("states its own limit rather than posing as branch protection", () => {
    const src = readFileSync(join(HOOK), "utf8");
    expect(src).toMatch(/no-verify/);
    expect(src).toMatch(/NOT branch protection|not branch protection/);
  });
});
