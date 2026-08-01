/** US-LOOP-129 — managed-runtime help and active-contract documentation. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deltaCommand } from "../src/commands/delta.js";
import { supervisorUsage } from "../src/commands/supervisor.js";
import { skillDispatchUsage } from "../src/commands/skill-dispatch.js";
import { worktreeAuditUsage } from "../src/commands/worktree-audit.js";
import { worktreeCleanupUsage } from "../src/commands/worktree-cleanup.js";
import { worktreeUsage } from "../src/commands/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const originalLang = process.env["ROLL_LANG"];

afterEach(() => {
  if (originalLang === undefined) delete process.env["ROLL_LANG"];
  else process.env["ROLL_LANG"] = originalLang;
});

function withLang<T>(lang: "en" | "zh", render: () => T): T {
  process.env["ROLL_LANG"] = lang;
  return render();
}

async function captureDeltaHelp(lang: "en" | "zh"): Promise<string> {
  const output: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // @ts-expect-error capture-only override
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    await withLang(lang, () => deltaCommand(["help"]));
  } finally {
    process.stdout.write = write;
  }
  return output.join("");
}

describe("US-LOOP-129 managed-runtime help", () => {
  it("freezes single-locale EN/ZH delta, worktree, and Supervisor help", async () => {
    const en = {
      delta: await captureDeltaHelp("en"),
      worktree: withLang("en", worktreeUsage),
      audit: withLang("en", worktreeAuditUsage),
      cleanup: withLang("en", worktreeCleanupUsage),
      dispatch: withLang("en", skillDispatchUsage),
      supervisor: withLang("en", supervisorUsage),
    };
    const zh = {
      delta: await captureDeltaHelp("zh"),
      worktree: withLang("zh", worktreeUsage),
      audit: withLang("zh", worktreeAuditUsage),
      cleanup: withLang("zh", worktreeCleanupUsage),
      dispatch: withLang("zh", skillDispatchUsage),
      supervisor: withLang("zh", supervisorUsage),
    };

    expect(en.delta).toContain("managed workspace");
    expect(en.worktree).toContain("managed WorkspaceSet");
    expect(en.supervisor).toContain("DeliveryRun truth");
    expect(zh.delta).toContain("受管工作区");
    expect(zh.worktree).toContain("受管 WorkspaceSet");
    expect(zh.supervisor).toContain("DeliveryRun 真相");
    expect(en.worktree).not.toMatch(/[\u4e00-\u9fff]/);
    expect(zh.worktree).not.toContain("Usage:");
    expect({ en, zh }).toMatchSnapshot();
  });
});

describe("US-LOOP-129 active documentation contract", () => {
  it("does not publish retired Roll-owned worktree recipes", () => {
    const activeSurfaces = [
      "README.md",
      "docs/architecture.md",
      "guide/en/loop.md",
      "guide/zh/loop.md",
      "guide/en/faq.md",
      "guide/zh/faq.md",
      "guide/en/loop-data-layout.md",
      "guide/zh/loop-data-layout.md",
      "skills/roll-build/references/full-contract.md",
      "skills/roll-fix/references/full-contract.md",
      "skills/roll-delta-team/SKILL.md",
    ];
    const retiredRecipes = [
      /git worktree add\s+\.worktrees\//,
      /git worktree add\s+\.\.\/wt-/,
      /\.claude\/worktrees\//,
      /git worktree remove --force/,
      /branch\/worktree canary/,
      /canary 压力/,
      /minimal candidate set/,
      /最小候选集合/,
      /disposable_candidate/,
      /host-delegation lease/,
      /sole builder worktree lease/,
    ];

    const renderedHelp = [
      ["rendered EN worktree help", withLang("en", worktreeUsage)],
      ["rendered ZH worktree help", withLang("zh", worktreeUsage)],
      ["rendered EN cleanup help", withLang("en", worktreeCleanupUsage)],
      ["rendered ZH cleanup help", withLang("zh", worktreeCleanupUsage)],
    ] as const;

    for (const surface of activeSurfaces) {
      const text = readFileSync(resolve(projectRoot, surface), "utf8");
      for (const recipe of retiredRecipes) {
        expect(text, `${surface} must not publish ${recipe.source}`).not.toMatch(recipe);
      }
    }
    for (const [surface, text] of renderedHelp) {
      for (const recipe of retiredRecipes) {
        expect(text, `${surface} must not publish ${recipe.source}`).not.toMatch(recipe);
      }
    }
  });
});
