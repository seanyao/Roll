/**
 * Regression — `ai_*` config keys with underscored agent names (e.g.
 * `ai_kimi_code`) were silently dropped by the `/^ai_[a-z]+:/` reader regex
 * (`[a-z]+` has no underscore). Effect: `~/.kimi-code` never entered the
 * conventions/skills sync, so `roll-prime` and every newer skill never landed
 * there and dead links were never pruned; `roll status` under-reported too.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAiTools } from "../src/commands/setup-shared.js";
import { parseAiEntries } from "../src/commands/status.js";

const ORIGINAL_ROLL_HOME = process.env["ROLL_HOME"];
const homes: string[] = [];

afterEach(() => {
  if (ORIGINAL_ROLL_HOME === undefined) delete process.env["ROLL_HOME"];
  else process.env["ROLL_HOME"] = ORIGINAL_ROLL_HOME;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function useHome(config: string): void {
  const home = mkdtempSync(join(tmpdir(), "roll-ai-tools-"));
  homes.push(home);
  writeFileSync(join(home, "config.yaml"), config);
  process.env["ROLL_HOME"] = home;
}

describe("ai_* config entries with underscored agent names", () => {
  it("getAiTools includes ai_kimi_code alongside plain names", () => {
    useHome("lang: zh\nai_kimi: ~/.kimi\nai_kimi_code: ~/.kimi-code\nai_cursor: ~/.cursor\n");
    const tools = getAiTools();
    expect(tools).toHaveLength(3);
    expect(tools.some((t) => t.endsWith("/.kimi-code"))).toBe(true);
  });

  it("parseAiEntries includes ai_kimi_code", () => {
    useHome("ai_kimi_code: ~/.kimi-code|AGENTS.md|AGENTS.md\nai_kimi: ~/.kimi|AGENTS.md|AGENTS.md\n");
    const entries = parseAiEntries();
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.ai_dir.endsWith("/.kimi-code"))).toBe(true);
  });
});
