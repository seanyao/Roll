/**
 * US-BROW-010 — Terminal screenshot evidence for AC4.
 * Captures the exact user-facing output of `roll browser update --check` and
 * `roll browser update --apply --confirm` as physical-terminal screenshot
 * equivalents (headless CI text capture).
 *
 * Run: npx vitest run packages/cli/test/scripts/capture-update-evidence.test.ts
 */
import { describe, it, expect } from "vitest";
import { browserCommand } from "../../src/commands/browser.js";
import { collectBrowserEnvironmentReadiness } from "../../src/lib/browser-readiness-doctor.js";
import { defaultBrowserEnvironmentProbeDeps } from "@roll/infra";
import { NO_UPDATE_AVAILABLE, type VersionSource } from "@roll/core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const EVIDENCE_DIR = join(
  import.meta.dirname,
  "../../../../.roll/features/browser-automation/US-BROW-010/evidence",
);

function capture() {
  let text = "";
  return { stdout: (s: string) => (text += s), read: () => text };
}

function headlessReadiness() {
  return collectBrowserEnvironmentReadiness(
    {
      status: "skip",
      installed: { status: "missing" },
      hostPermission: { status: "skipped", detail: "headless" },
      inbox: { status: "skipped", path: "/tmp/inbox", detail: "headless" },
      detailLines: ["skipped — headless / CI"],
      repairCommands: [],
    },
    { ...defaultBrowserEnvironmentProbeDeps(), env: {}, tcpReachable: () => false },
  );
}

const pinnedCfg = "devtools:\n  package_version: 1.5.0\n";

describe("US-BROW-010 terminal evidence capture", () => {
  it("captures update --check golden-path output", async () => {
    const c = capture();
    const vs: VersionSource = () => "1.6.0";
    const code = await browserCommand(["update", "--check"], {
      configPath: () => "/tmp/should-not-write/browser-operations.yaml",
      writeFile: () => {},
      readFile: () => pinnedCfg,
      fileExists: () => false,
      versionSource: vs,
      stdout: c.stdout,
    });
    expect(code).toBe(0);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, "cmd-update-check.txt"), c.read());
  });

  it("captures update --check no-update output", async () => {
    const c = capture();
    const vs: VersionSource = () => NO_UPDATE_AVAILABLE;
    const code = await browserCommand(["update", "--check"], {
      configPath: () => "/tmp/should-not-write/browser-operations.yaml",
      writeFile: () => {},
      readFile: () => pinnedCfg,
      fileExists: () => false,
      versionSource: vs,
      stdout: c.stdout,
    });
    expect(code).toBe(0);
    writeFileSync(join(EVIDENCE_DIR, "cmd-update-check-no-update.txt"), c.read());
  });

  it("captures update --apply --confirm success output", async () => {
    const c = capture();
    const vs: VersionSource = () => "1.6.0";
    let probeRan = false;
    const code = await browserCommand(["update", "--apply", "--confirm"], {
      configPath: () => "/tmp/roll-test/browser-operations.yaml",
      readFile: () => pinnedCfg,
      writeFile: () => {},
      fileExists: () => true,
      versionSource: vs,
      smokeCheck: async () => true,
      readiness: () => headlessReadiness(),
      // Evidence capture is deliberately headless. Keep the update path real
      // while supplying the successful MCP probe result that CI cannot reach.
      runProbe: async () => {
        probeRan = true;
        return { kind: "passed" as const, version: "1.6.0", tools: ["chrome_devtools_call"] };
      },
      stdout: c.stdout,
    });
    expect(code).toBe(0);
    expect(probeRan).toBe(true);
    writeFileSync(join(EVIDENCE_DIR, "cmd-update-apply-success.txt"), c.read());
  });

  it("captures update --apply --confirm smoke-fail output", async () => {
    const c = capture();
    const vs: VersionSource = () => "1.6.0";
    const code = await browserCommand(["update", "--apply", "--confirm"], {
      configPath: () => "/tmp/roll-test/browser-operations.yaml",
      readFile: () => pinnedCfg,
      writeFile: () => {},
      fileExists: () => true,
      versionSource: vs,
      smokeCheck: async () => false,
      readiness: () => headlessReadiness(),
      stdout: c.stdout,
    });
    expect(code).toBe(1);
    writeFileSync(join(EVIDENCE_DIR, "cmd-update-apply-fail.txt"), c.read());
  });

  it("captures update --apply refusal (no --confirm) output", async () => {
    const c = capture();
    const vs: VersionSource = () => "1.6.0";
    const code = await browserCommand(["update", "--apply"], {
      configPath: () => "/tmp/should-not-write/browser-operations.yaml",
      writeFile: () => {},
      readFile: () => pinnedCfg,
      fileExists: () => false,
      versionSource: vs,
      stdout: c.stdout,
    });
    expect(code).toBe(0);
    writeFileSync(join(EVIDENCE_DIR, "cmd-update-apply-refusal.txt"), c.read());
  });
});
