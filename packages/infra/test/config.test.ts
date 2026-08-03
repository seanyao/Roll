/**
 * Unit tests for the config module — pure-logic coverage that complements the
 * bash diff-test (config.difftest.test.ts). Exercises tilde expansion, the
 * nested/flat extractors, the layered precedence helper, and registry resolve.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  CONFIG_KEYS,
  configGet,
  configResolve,
  expandLeadingTilde,
  resolveConfig,
  yamlReadFlat,
  yamlReadNested,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "roll-infra-cfg-"));
  dirs.push(d);
  return d;
}
function write(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("expandLeadingTilde", () => {
  it("expands only a leading ~", () => {
    expect(expandLeadingTilde("~/x", "/home/u")).toBe("/home/u/x");
    expect(expandLeadingTilde("~", "/home/u")).toBe("/home/u");
  });
  it("leaves a non-leading ~ untouched", () => {
    expect(expandLeadingTilde("a/~/b", "/home/u")).toBe("a/~/b");
    expect(expandLeadingTilde("", "/home/u")).toBe("");
    expect(expandLeadingTilde("plain", "/home/u")).toBe("plain");
  });
});

describe("yamlReadNested", () => {
  it("reads child under parent, strips comment + whitespace", () => {
    const d = tmp();
    const f = write(d, "c.yaml", ["loop_schedule:", "  period_minutes: 30   # every half hour", ""].join("\n"));
    expect(yamlReadNested(f, "loop_schedule", "period_minutes")).toBe("30");
  });
  it("dedent ends the block — child outside parent is not found", () => {
    const d = tmp();
    const f = write(d, "c.yaml", ["loop_schedule:", "  period: 5", "other:", "  period: 9", ""].join("\n"));
    expect(yamlReadNested(f, "loop_schedule", "period")).toBe("5");
  });
  it("missing parent block → empty", () => {
    const d = tmp();
    const f = write(d, "c.yaml", "unrelated: 1\n");
    expect(yamlReadNested(f, "loop_schedule", "period")).toBe("");
  });
  it("missing file → empty", () => {
    expect(yamlReadNested(join(tmp(), "nope.yaml"), "p", "c")).toBe("");
  });
});

describe("yamlReadFlat", () => {
  it("first matching line wins, comment + ws stripped", () => {
    const d = tmp();
    const f = write(d, "c.yaml", ["loop_dream_hour: 5   # comment", "loop_dream_hour: 9", ""].join("\n"));
    expect(yamlReadFlat(f, "loop_dream_hour")).toBe("5");
  });
  it("absent key → empty", () => {
    const d = tmp();
    const f = write(d, "c.yaml", "other: 1\n");
    expect(yamlReadFlat(f, "loop_dream_hour")).toBe("");
  });
});

describe("configGet (global single-file oracle)", () => {
  it("flat key with default fallback", () => {
    const d = tmp();
    const f = write(d, "config.yaml", "roll_records_remote: git@h:x/y.git\n");
    expect(configGet("roll_records_remote", "", f)).toBe("git@h:x/y.git");
    expect(configGet("absent_key", "fallback", f)).toBe("fallback");
  });
  it("dotted key routes to nested reader", () => {
    const d = tmp();
    const f = write(d, "config.yaml", ["loop_schedule:", "  period_minutes: 42", ""].join("\n"));
    expect(configGet("loop_schedule.period_minutes", "60", f)).toBe("42");
    expect(configGet("loop_schedule.offset_minute", "0", f)).toBe("0");
  });
  it("leading-tilde value is expanded", () => {
    const d = tmp();
    const f = write(d, "config.yaml", "ai_claude: ~/.claude\n");
    const home = process.env["HOME"] ?? "";
    expect(configGet("ai_claude", "", f)).toBe(`${home}/.claude`);
  });
  it("missing file → tilde-expanded default", () => {
    expect(configGet("any", "~/d", join(tmp(), "nope.yaml"))).toBe(`${process.env["HOME"]}/d`);
  });
});

describe("configResolve (scoped registry)", () => {
  it("unknown key → null", () => {
    expect(configResolve("nope")).toBeNull();
  });
  it("global flat key from file, source = path", () => {
    const d = tmp();
    const g = write(d, "config.yaml", "loop_dream_hour: 7\n");
    expect(configResolve("loop_dream_hour", { global: g })).toEqual(["7", g]);
  });
  it("registry retains dream keys plus valid project settings", () => {
    expect(CONFIG_KEYS.map((k) => k.key)).toEqual([
      "loop_dream_hour",
      "loop_dream_minute",
      "integration_branch",
      "publish_mode",
      "default_submodule",
    ]);
  });
  it("E6: default_submodule is a project-scope flat string key defaulting to empty", () => {
    const rec = CONFIG_KEYS.find((k) => k.key === "default_submodule");
    expect(rec).toBeDefined();
    expect(rec?.scope).toBe("project");
    expect(rec?.store).toBe("flat");
    expect(rec?.type).toBe("string");
    expect(rec?.default).toBe("");
  });
  it("integration_branch is a project-scope flat string key defaulting to origin/main", () => {
    const rec = CONFIG_KEYS.find((k) => k.key === "integration_branch");
    expect(rec).toBeDefined();
    expect(rec?.scope).toBe("project");
    expect(rec?.store).toBe("flat");
    expect(rec?.type).toBe("string");
    expect(rec?.default).toBe("origin/main");
  });
  it("the dream keys keep integer semantics (type absent or 'int')", () => {
    // E1 added integration_branch (string); E3 added publish_mode (string enum);
    // E6 added default_submodule (string). All excluded — the assertion is about
    // the remaining integer keys.
    const stringKeys = new Set(["integration_branch", "publish_mode", "default_submodule"]);
    for (const rec of CONFIG_KEYS) {
      if (stringKeys.has(rec.key)) continue;
      expect(rec.type === undefined || rec.type === "int").toBe(true);
    }
  });
  it("integration_branch resolves the configured value from local.yaml", () => {
    const d = tmp();
    const p = write(d, "local.yaml", "integration_branch: origin/dev\n");
    expect(configResolve("integration_branch", { project: p })).toEqual(["origin/dev", p]);
  });
  it("integration_branch falls back to origin/main when unset", () => {
    const d = tmp();
    expect(configResolve("integration_branch", { project: join(d, "absent.yaml") })).toEqual([
      "origin/main",
      "default",
    ]);
  });

  // ── E3: publish_mode ──────────────────────────────────────────────────────
  it("publish_mode is a project-scope flat enum string key defaulting to remote", () => {
    const rec = CONFIG_KEYS.find((k) => k.key === "publish_mode");
    expect(rec).toBeDefined();
    expect(rec?.scope).toBe("project");
    expect(rec?.store).toBe("flat");
    expect(rec?.type).toBe("string");
    expect(rec?.default).toBe("remote");
    expect(rec?.enum).toEqual(["remote", "local"]);
  });
  it("publish_mode resolves the configured value from local.yaml", () => {
    const d = tmp();
    const p = write(d, "local.yaml", "publish_mode: local\n");
    expect(configResolve("publish_mode", { project: p })).toEqual(["local", p]);
  });
  it("publish_mode falls back to remote when unset (zero regression default)", () => {
    const d = tmp();
    expect(configResolve("publish_mode", { project: join(d, "absent.yaml") })).toEqual([
      "remote",
      "default",
    ]);
  });
});

describe("resolveConfig (CLI > env > file > default)", () => {
  it("cli wins over all", () => {
    expect(resolveConfig({ cli: "a", env: "b", file: "c", default: "d" })).toEqual({ value: "a", layer: "cli" });
  });
  it("falls through empties to next layer", () => {
    expect(resolveConfig({ cli: "", env: "b", file: "c" })).toEqual({ value: "b", layer: "env" });
    expect(resolveConfig({ file: "c", default: "d" })).toEqual({ value: "c", layer: "file" });
    expect(resolveConfig({ default: "d" })).toEqual({ value: "d", layer: "default" });
    expect(resolveConfig({})).toEqual({ value: "", layer: "default" });
  });
});
