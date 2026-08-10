/**
 * US-DELTA-016 — published Builder preflight procedure.
 *
 * These assertions protect the operator contract in every user-facing Delta
 * surface. The snapshots intentionally freeze EN/ZH help and guide excerpts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deltaCommand } from "../src/commands/delta.js";
import { renderState } from "../src/render.js";

const repo = resolve(__dirname, "../../..");

function read(relativePath: string): string {
  return readFileSync(resolve(repo, relativePath), "utf8");
}

async function captureHelp(lang?: "zh"): Promise<string> {
  const previous = process.env["ROLL_LANG"];
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error capture-only override
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    if (lang === "zh") process.env["ROLL_LANG"] = "zh";
    else delete process.env["ROLL_LANG"];
    expect(await deltaCommand(["help"])).toBe(0);
  } finally {
    process.stdout.write = realWrite;
    renderState.useColor = true;
    if (previous === undefined) delete process.env["ROLL_LANG"];
    else process.env["ROLL_LANG"] = previous;
  }
  return chunks.join("");
}

describe("US-DELTA-016 — Builder preflight published procedure", () => {
  it("freezes the EN/ZH help and guide contract", async () => {
    const enGuide = read("guide/en/ai-agents.md");
    const zhGuide = read("guide/zh/ai-agents.md");
    const readme = read("README.md");
    const zhReadme = read("README_CN.md");
    const skill = read("skills/roll-delta-team/SKILL.md");

    expect(await captureHelp()).toContain("final green TCR commit");
    expect(await captureHelp("zh")).toContain("最后一次 green TCR 提交");
    expect(enGuide.replace(/\s+/g, " ")).toContain("red preflight → repair in the same frame → green preflight → formal validate");
    expect(zhGuide.replace(/\s+/g, "")).toContain("预检失败→在同一帧修复→预检通过→正式validate");
    expect(readme).toContain("after the Builder's final green TCR commit");
    expect(zhReadme).toContain("Builder 完成最后一次 green TCR 提交后");
    expect(skill.replace(/\s+/g, " ")).toContain("After its final green TCR commit, it runs");

    expect({
      help: { en: await captureHelp(), zh: await captureHelp("zh") },
      guide: { en: enGuide.match(/Before handing materials[\s\S]*?\*\*Honest boundaries/)?.[0], zh: zhGuide.match(/在把材料交给独立 Evaluator 之前[\s\S]*?\*\*诚实边界/)?.[0] },
    }).toMatchSnapshot();
  });

  it("guards against the retired direct-validate procedure", () => {
    const surfaces = [
      "README.md",
      "guide/en/ai-agents.md",
      "guide/zh/ai-agents.md",
      "skills/roll-delta-team/SKILL.md",
    ].map(read).join("\n");

    expect(surfaces).not.toContain("Attest it, then validate:");
    expect(surfaces).not.toContain("Attest it, then validate it formally:");
    expect(surfaces).toContain("preflight");
    expect(surfaces).toContain("does not prove that a model executed");
  });
});
