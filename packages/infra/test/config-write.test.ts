/**
 * config write surface (US-PORT-006) — validation, scope→file, and the
 * idempotent yaml writer. Expected values are pinned to the frozen bash oracle
 * (`_config_validate` / `_config_key_file` / `_config_set`, bin/roll) which was
 * probed directly while authoring these cases.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigSet,
  configKeyFile,
  configSet,
  configValidate,
  projectConfigPath,
  rollConfigPath,
} from "../src/config.js";

describe("configValidate — integer range, bilingual lines (no [roll] prefix)", () => {
  it("accepts an in-range integer", () => {
    expect(configValidate("loop_dream_hour", "5")).toEqual({ ok: true });
  });
  it("accepts the min and max boundaries", () => {
    expect(configValidate("loop_dream_hour", "0")).toEqual({ ok: true });
    expect(configValidate("loop_dream_hour", "23")).toEqual({ ok: true });
  });
  it("rejects a non-integer", () => {
    expect(configValidate("loop_dream_hour", "abc")).toEqual({
      ok: false,
      lines: [
        "config: 'loop_dream_hour' expects an integer, got 'abc'",
        "config：'loop_dream_hour' 需要整数，收到 'abc'",
      ],
    });
  });
  it("rejects below min", () => {
    expect(configValidate("loop_dream_hour", "-1")).toEqual({
      ok: false,
      lines: [
        "config: 'loop_dream_hour' must be >= 0 (got -1)",
        "config：'loop_dream_hour' 必须 >= 0（收到 -1）",
      ],
    });
  });
  it("rejects above max", () => {
    expect(configValidate("loop_dream_hour", "99")).toEqual({
      ok: false,
      lines: [
        "config: 'loop_dream_hour' must be <= 23 (got 99)",
        "config：'loop_dream_hour' 必须 <= 23（收到 99）",
      ],
    });
  });
});

describe("configValidate — string keys (type: 'string')", () => {
  it("accepts a git-ref-safe non-empty value", () => {
    expect(configValidate("integration_branch", "origin/main")).toEqual({ ok: true });
    expect(configValidate("integration_branch", "origin/release-2.0")).toEqual({ ok: true });
    expect(configValidate("integration_branch", "main")).toEqual({ ok: true });
    expect(configValidate("integration_branch", "upstream/feature_x.1")).toEqual({ ok: true });
  });
  it("does NOT apply integer validation to a string key (digits are just a valid ref)", () => {
    expect(configValidate("integration_branch", "12345")).toEqual({ ok: true });
  });
  it("rejects an empty value", () => {
    expect(configValidate("integration_branch", "")).toEqual({
      ok: false,
      lines: [
        "config: 'integration_branch' must not be empty",
        "config：'integration_branch' 不能为空",
      ],
    });
  });
  it("rejects git-ref-unsafe characters", () => {
    expect(configValidate("integration_branch", "origin/main; rm -rf")).toEqual({
      ok: false,
      lines: [
        "config: 'integration_branch' has unsafe characters, got 'origin/main; rm -rf'",
        "config：'integration_branch' 含非法字符，收到 'origin/main; rm -rf'",
      ],
    });
    expect(configValidate("integration_branch", "a b").ok).toBe(false);
    expect(configValidate("integration_branch", "a~b").ok).toBe(false);
  });
});

describe("configValidate — enum string keys (E3: publish_mode)", () => {
  it("accepts the two allowed values", () => {
    expect(configValidate("publish_mode", "remote")).toEqual({ ok: true });
    expect(configValidate("publish_mode", "local")).toEqual({ ok: true });
  });
  it("rejects any other value with a bilingual allowed-values message", () => {
    expect(configValidate("publish_mode", "offline")).toEqual({
      ok: false,
      lines: [
        "config: 'publish_mode' must be one of remote|local, got 'offline'",
        "config：'publish_mode' 取值须为 remote|local，收到 'offline'",
      ],
    });
  });
  it("rejects an empty value (empty is not an allowed enum member)", () => {
    expect(configValidate("publish_mode", "").ok).toBe(false);
  });
  it("is case-sensitive — 'Local' / 'REMOTE' are rejected", () => {
    expect(configValidate("publish_mode", "Local").ok).toBe(false);
    expect(configValidate("publish_mode", "REMOTE").ok).toBe(false);
  });
});

describe("configKeyFile — scope → backing yaml file", () => {
  it("global → rollConfigPath", () => {
    expect(configKeyFile("global")).toBe(rollConfigPath());
  });
  it("project → .roll/local.yaml", () => {
    expect(configKeyFile("project")).toBe(projectConfigPath());
  });
});

describe("applyConfigSet — pure idempotent yaml transform (mirrors _config_set awk)", () => {
  it("flat key into empty text", () => {
    expect(applyConfigSet("", "loop_dream_hour", "5")).toBe("loop_dream_hour: 5\n");
  });
  it("flat key replaces existing line, preserves others", () => {
    const src = "loop_dream_hour: 3\nloop_dream_minute: 0\n";
    expect(applyConfigSet(src, "loop_dream_hour", "9")).toBe("loop_dream_hour: 9\nloop_dream_minute: 0\n");
  });
  it("retired scheduler keys leave config text unchanged", () => {
    const src = "loop_schedule:\n  period_minutes: 30\n";
    expect(applyConfigSet(src, "loop_schedule.offset_minute", "7")).toBe(src);
  });
});

describe("configSet — file wrapper (mkdir + write through applyConfigSet)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roll-cfgw-"));
  });
  afterEach(() => {
    // best-effort; tmp dirs are reaped by the OS
  });
  it("creates a missing file and writes the flat key", () => {
    const f = join(dir, "nested", "config.yaml");
    configSet("loop_dream_hour", "5", f);
    expect(readFileSync(f, "utf8")).toBe("loop_dream_hour: 5\n");
  });
  it("does not create a file for a retired scheduler key", () => {
    const f = join(dir, "local.yaml");
    expect(() => readFileSync(f, "utf8")).toThrow();
    configSet("loop_schedule.offset_minute", "7", f);
    expect(() => readFileSync(f, "utf8")).toThrow();
  });
  it("does not modify an existing file for a retired scheduler key", () => {
    const f = join(dir, "local.yaml");
    const src = "loop_schedule:\n  period_minutes: 30\n";
    writeFileSync(f, src);
    configSet("loop_schedule.offset_minute", "7", f);
    expect(readFileSync(f, "utf8")).toBe(src);
  });
});
