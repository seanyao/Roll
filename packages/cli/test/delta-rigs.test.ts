import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RigReadinessCandidate } from "@roll/spec";
import { computeCandidateFingerprint } from "@roll/core";
import { deltaCommand } from "../src/commands/delta.js";
import {
  RIG_PROBE_TOKEN,
  createRigProbeAdapters,
  runRigReadinessProbes,
  type RigProbeAdapter,
} from "../src/lib/delta-rig-probe.js";
import { renderRigReadiness } from "../src/lib/delta-rig-readiness.js";

let root = "";

afterEach(() => {
  if (root !== "" && existsSync(root)) rmSync(root, { recursive: true, force: true });
  delete process.env["ROLL_HOME"];
  delete process.env["ROLL_LANG"];
  delete process.env["LC_ALL"];
  delete process.env["LANG"];
});

function fixtureRoot(): string {
  root = join(tmpdir(), `roll-delta-rigs-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  process.env["ROLL_HOME"] = root;
  return root;
}

function writeConfiguration(home: string, lang = "en"): void {
  mkdirSync(join(home, "delta-team"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), `lang: ${lang}\ndelta_rig_readiness:\n  probeTimeoutMs: 1000\n  maxConcurrency: 2\n  freshnessTtlMs: 60000\n`);
  writeFileSync(join(home, "delta-team", "presets.yaml"), "schema: roll-delta-preset/v1\npresets:\n  - id: local\n    hostId: local\n    roles:\n      designer:\n        preferredModelIds: [model-a]\n      builder:\n        preferredModelIds: [model-a]\n      evaluator:\n        preferredModelIds: [model-a]\n");
  writeFileSync(join(home, "delta-team", "rig-adapters.yaml"), "schema: roll-delta-rig-adapters/v1\nmappings:\n  - configuredModelId: model-a\n    adapter: codex\n    cliModelId: gpt-test\n");
}

async function capture(argv: string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error test-only stream capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => { stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; };
  // @ts-expect-error test-only stream capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; };
  try {
    return { code: await deltaCommand(argv), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

const candidate: RigReadinessCandidate = {
  adapter: "codex",
  configuredModelId: "model-a",
  cliModelId: "gpt-test",
  roles: ["builder"],
  presetIds: ["local"],
};

describe("US-DELTA-018 — exact-model rig probes", () => {
  it("uses isolated, bounded exact-model argv and never defaults Cursor", async () => {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }> = [];
    const adapters = createRigProbeAdapters({
      makeTempDir: () => "/tmp/isolated-rig-probe",
      removeTempDir: () => undefined,
      now: () => 100,
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        return { code: 0, stdout: `${RIG_PROBE_TOKEN}\n`, stderr: "" };
      },
    });

    for (const adapter of ["claude", "codex", "pi", "kimi", "reasonix"] as const) {
      const result = await adapters.get(adapter)!.probe({ adapter, modelId: "exact/model", timeoutMs: 1000, token: RIG_PROBE_TOKEN });
      expect(result).toMatchObject({ outcome: "ready", reasonCode: "probe_passed" });
    }
    const cursor = await adapters.get("cursor")!.probe({ adapter: "cursor", modelId: "never-default", timeoutMs: 1000, token: RIG_PROBE_TOKEN });
    expect(cursor).toMatchObject({ outcome: "blocked", reasonCode: "adapter_model_selection_unsupported" });
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.args).toContain("--model");
      expect(call.args).toContain("exact/model");
      expect(call.cwd).toBe("/tmp/isolated-rig-probe");
      expect(call.env["PATH"]).toBeDefined();
      expect(call.env["ROLL_HOME"]).toBeUndefined();
    }
    expect(calls.find((call) => call.command === "codex")?.args).toEqual(["exec", "--model", "exact/model", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", RIG_PROBE_TOKEN]);
  });

  it("classifies timeout, unverifiable output, known diagnostics, and unknown failures without retaining secrets", async () => {
    const outcomes = [
      { code: 1, stdout: "", stderr: "", timedOut: true },
      { code: 0, stdout: "not the token", stderr: "" },
      { code: 1, stdout: "", stderr: "401 Authorization: Bearer sk-secret-value /Users/alice/private" },
      { code: 1, stdout: "", stderr: "process exited unexpectedly" },
    ];
    const adapters = createRigProbeAdapters({
      makeTempDir: () => "/tmp/probe",
      removeTempDir: () => undefined,
      now: () => 0,
      run: async () => outcomes.shift()!,
    });
    const request = { adapter: "codex", modelId: "exact", timeoutMs: 1000, token: RIG_PROBE_TOKEN } as const;
    await expect(adapters.get("codex")!.probe(request)).resolves.toMatchObject({ outcome: "unknown", reasonCode: "probe_timeout" });
    await expect(adapters.get("codex")!.probe(request)).resolves.toMatchObject({ outcome: "unknown", reasonCode: "probe_output_unverified" });
    const auth = await adapters.get("codex")!.probe(request);
    expect(auth).toMatchObject({ outcome: "blocked", reasonCode: "auth_required" });
    expect(auth.detail).not.toContain("sk-secret-value");
    expect(auth.detail).not.toContain("/Users/alice");
    await expect(adapters.get("codex")!.probe(request)).resolves.toMatchObject({ outcome: "unknown", reasonCode: "probe_failed" });
    const missing = createRigProbeAdapters({
      makeTempDir: () => "/tmp/probe",
      removeTempDir: () => undefined,
      now: () => 0,
      run: async () => ({ code: null, stdout: "", stderr: "", errorCode: "ENOENT" }),
    });
    await expect(missing.get("codex")!.probe(request)).resolves.toMatchObject({ outcome: "blocked", reasonCode: "adapter_missing" });
  });

  it("classifies quota, rate limit, network, and rejected-model diagnostics", async () => {
    const cases: ReadonlyArray<{ readonly output: string; readonly reasonCode: string }> = [
      { output: "provider quota exhausted: insufficient credits", reasonCode: "quota_exhausted" },
      { output: "HTTP 429 rate limit: too many requests", reasonCode: "rate_limited" },
      { output: "network unreachable: ENOTFOUND api.example.test", reasonCode: "network_unreachable" },
      { output: "model model-does-not-exist not found", reasonCode: "model_rejected" },
    ];
    const adapters = createRigProbeAdapters({
      makeTempDir: () => "/tmp/probe",
      removeTempDir: () => undefined,
      now: () => 0,
      run: async () => ({ code: 1, stdout: "", stderr: cases.shift()!.output }),
    });
    const request = { adapter: "codex", modelId: "exact", timeoutMs: 1000, token: RIG_PROBE_TOKEN } as const;
    for (const expected of ["quota_exhausted", "rate_limited", "network_unreachable", "model_rejected"] as const) {
      await expect(adapters.get("codex")!.probe(request)).resolves.toMatchObject({ outcome: "blocked", reasonCode: expected });
    }
  });

  it("caps parallel probes and treats an aborted worker as a fatal refresh error", async () => {
    let active = 0;
    let peak = 0;
    const adapter: RigProbeAdapter = {
      adapter: "codex",
      async probe() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active--;
        return { outcome: "ready", reasonCode: "probe_passed", detail: "ok" };
      },
    };
    const candidates = Array.from({ length: 4 }, (_, index) => ({ ...candidate, configuredModelId: `model-${index}`, cliModelId: `gpt-${index}` }));
    const observations = await runRigReadinessProbes(candidates, 2, new Map([["codex", adapter]]));
    expect(peak).toBe(2);
    expect(observations).toHaveLength(4);
    await expect(runRigReadinessProbes([candidate], 1, new Map([["codex", { adapter: "codex", probe: async () => { throw new Error("worker aborted"); } }]]))).rejects.toThrow("worker aborted");
  });
});

describe("US-DELTA-018 — rigs command and human projection", () => {
  it("rejects malformed rigs invocations before reading or writing local state", async () => {
    const home = fixtureRoot();
    writeFileSync(join(home, "sentinel"), "unchanged\n");
    for (const argv of [["rigs", "extra"], ["rigs", "--json"], ["rigs", "--refresh", "--refresh"], ["rigs", "--refresh=true"]]) {
      const result = await capture(argv);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toBe("");
    }
    expect(readdirSync(home).sort()).toEqual(["sentinel"]);
    expect(readFileSync(join(home, "sentinel"), "utf8")).toBe("unchanged\n");
  });

  it("renders a side-effect-free cached projection in the persisted locale, with ROLL_LANG overriding it", async () => {
    const home = fixtureRoot();
    writeConfiguration(home, "zh");
    const before = JSON.stringify(readdirSync(home, { recursive: true }).sort());
    const zh = await capture(["rigs"]);
    expect(zh.code).toBe(0);
    expect(zh.stdout).toContain("Delta 模型可派性");
    expect(zh.stdout).toContain("缓存中没有就绪观测");
    expect(JSON.stringify(readdirSync(home, { recursive: true }).sort())).toBe(before);
    process.env["ROLL_LANG"] = "en";
    const en = await capture(["rigs"]);
    expect(en.code).toBe(0);
    expect(en.stdout).toContain("Delta rig readiness");
    expect(en.stdout).not.toContain("Delta 模型可派性");
  });

  it("uses the persisted locale for strict-parser failures too", async () => {
    const home = fixtureRoot();
    writeConfiguration(home, "zh");
    const result = await capture(["rigs", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("未知标志");
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("refreshes a complete empty candidate set without contacting an adapter", async () => {
    const home = fixtureRoot();
    const result = await capture(["rigs", "--refresh"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No configured Delta rig candidates");
    expect(existsSync(join(home, "delta-team", "rig-readiness", "latest.json"))).toBe(true);
  });

  it("freezes English and Chinese current, stale, incompatible, and missing projections", () => {
    const snapshot = {
      schema: "roll-delta-rig-readiness/v1" as const,
      refreshId: "refresh-1",
      candidateFingerprint: computeCandidateFingerprint([candidate]),
      observedAt: "2026-08-05T00:00:00.000Z",
      observations: [{ ...candidate, outcome: "ready" as const, reasonCode: "probe_passed" as const, detail: "exact model answered", latencyMs: 12 }],
    };
    for (const lang of ["en", "zh"] as const) {
      expect(renderRigReadiness({ candidates: [candidate], snapshot, cache: { kind: "current" }, lang })).toMatchSnapshot();
      expect(renderRigReadiness({ candidates: [candidate], snapshot, cache: { kind: "stale", ageMs: 90_000 }, lang })).toMatchSnapshot();
      expect(renderRigReadiness({ candidates: [candidate], snapshot, cache: { kind: "incompatible" }, lang })).toMatchSnapshot();
      expect(renderRigReadiness({ candidates: [candidate], snapshot: null, cache: { kind: "missing" }, lang })).toMatchSnapshot();
    }
  });
});
