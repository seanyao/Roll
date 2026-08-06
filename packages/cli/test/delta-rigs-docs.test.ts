/** US-DELTA-019 — published rig readiness procedure and stale-copy guard. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deltaCommand } from "../src/commands/delta.js";

const repo = resolve(__dirname, "../../..");
const originalLang = process.env["ROLL_LANG"];

afterEach(() => {
  if (originalLang === undefined) delete process.env["ROLL_LANG"];
  else process.env["ROLL_LANG"] = originalLang;
});

function read(relativePath: string): string {
  return readFileSync(resolve(repo, relativePath), "utf8");
}

async function help(lang: "en" | "zh"): Promise<string> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // @ts-expect-error capture-only output seam
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; };
  try {
    process.env["ROLL_LANG"] = lang;
    expect(await deltaCommand(["help"])).toBe(0);
  } finally {
    process.stdout.write = write;
  }
  return chunks.join("");
}

function section(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  return start < 0 || end < 0 ? text : text.slice(start, end);
}

describe("US-DELTA-019 — rig readiness operator documentation", () => {
  it("freezes the localized help and aligned active operator copy", async () => {
    const enGuide = read("guide/en/ai-agents.md");
    const zhGuide = read("guide/zh/ai-agents.md");
    const readme = read("README.md");
    expect(readme).toContain("roll delta rigs --refresh");
    expect(enGuide).toContain("`ROLL_LANG=zh roll delta rigs --refresh`");
    expect(zhGuide).toContain("`ROLL_LANG=zh roll delta rigs --refresh`");
    const enHelp = await help("en");
    const zhHelp = await help("zh");
    expect(enHelp).toContain("roll delta rigs [--refresh]");
    expect(zhHelp).toContain("roll delta rigs [--refresh]");
    expect(enHelp).not.toMatch(/[\u4e00-\u9fff]/);
    expect(zhHelp).not.toContain("Usage:");
    expect({
      help: {
        en: enHelp.match(/  roll delta rigs \[--refresh\][\s\S]*?(?=\n  roll delta conclude)/)?.[0],
        zh: zhHelp.match(/  roll delta rigs \[--refresh\][\s\S]*?(?=\n  roll delta conclude)/)?.[0],
      },
      docs: {
        readme: section(readme, "#### Local exact-model rig readiness", "\nHonest boundaries"),
        en: section(enGuide, "### Local exact-model rig readiness", "\nAfter its final green TCR commit"),
        zh: section(zhGuide, "### 本机指定模型就绪状态", "\nBuilder 完成最后一次"),
      },
    }).toMatchSnapshot();
  });

  it("rejects misleading stale operator claims", () => {
    const surfaces = [
      "README.md",
      "guide/en/ai-agents.md",
      "guide/zh/ai-agents.md",
      "skills/roll-delta-team/SKILL.md",
    ].map(read).join("\n");
    const prohibited = [
      /rigs[^.\n]*(?:changes?|modifies?|performs?)[^.\n]*(?:dispatch|allocation|resolution)/i,
      /(?:successful|passing|ready) probe[^.\n]*(?:guarantees?|proves?)[^.\n]*(?:delivery|future long|final role|session freshness)/i,
      /rigs[^。\n]*(?:修改|改变|执行)[^。\n]*(?:派工|分配|解析)/,
      /(?:通过|成功)探测[^。\n]*(?:保证|证明)[^。\n]*(?:交付|长任务|最终角色|会话新鲜度)/,
    ];
    for (const claim of prohibited) expect(surfaces, `misleading copy: ${claim.source}`).not.toMatch(claim);
    expect(surfaces).toContain("never the default model");
    expect(surfaces).toContain("绝不使用默认模型");
  });
});
