/** US-LOOP-129 — managed-runtime help and active-contract documentation. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deltaCommand } from "../src/commands/delta.js";
import { deliveryHelp, supervisorUsage } from "../src/commands/supervisor.js";
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
      deliveryHelp: withLang("en", deliveryHelp),
    };
    const zh = {
      delta: await captureDeltaHelp("zh"),
      worktree: withLang("zh", worktreeUsage),
      audit: withLang("zh", worktreeAuditUsage),
      cleanup: withLang("zh", worktreeCleanupUsage),
      dispatch: withLang("zh", skillDispatchUsage),
      supervisor: withLang("zh", supervisorUsage),
      deliveryHelp: withLang("zh", deliveryHelp),
    };

    expect(en.delta).toContain("managed workspace");
    expect(en.worktree).toContain("managed WorkspaceSet");
    expect(en.supervisor).toContain("DeliveryRun truth");
    expect(en.supervisor).toContain("never routes work, changes priority, or merges");
    expect(zh.delta).toContain("受管工作区");
    expect(zh.worktree).toContain("受管 WorkspaceSet");
    expect(zh.supervisor).toContain("DeliveryRun 真相");
    expect(zh.supervisor).toContain("绝不路由工作、改变优先级或合并");
    expect(en.worktree).not.toMatch(/[\u4e00-\u9fff]/);
    expect(zh.worktree).not.toContain("Usage:");
    // US-DELTA-021 — delivery help leads with the unified view, in one locale.
    expect(en.deliveryHelp).toMatch(/one card has one final delivery\s+conclusion/i);
    expect(en.deliveryHelp).toContain("cannot route an agent");
    expect(en.deliveryHelp).toContain("Safety boundary: this command reads facts only");
    expect(zh.deliveryHelp).toContain("一张卡只有一个最终交付结论");
    expect(zh.deliveryHelp).toContain("不能路由 agent");
    expect(zh.deliveryHelp).toContain("安全边界：本命令只读事实");
    expect(en.deliveryHelp).not.toMatch(/[\u4e00-\u9fff]/);
    expect(zh.deliveryHelp).not.toContain("Usage:");
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

describe("US-DELTA-014 metric documentation contract", () => {
  it("publishes complete bilingual metric dictionaries without retired causal claims", () => {
    const surfaces = [
      "guide/en/delivery-metrics.md",
      "guide/zh/delivery-metrics.md",
      "README.md",
      "README_CN.md",
    ];
    const retiredClaims = [
      /missing artifacts? (?:prove|means?) (?:that )?an? model (?:did not )?run/i,
      /metrics? (?:automatically )?(?:route|select|prioriti[sz]e|merge)/i,
      /指标.*(?:自动|直接).*(?:路由|选择|优先级|合并)/,
      /缺失.*artifact.*(?:证明|表示).*模型.*(?:未)?执行/,
    ];

    for (const surface of surfaces) {
      const text = readFileSync(resolve(projectRoot, surface), "utf8");
      for (const claim of retiredClaims) {
        expect(text, `${surface} must not publish ${claim.source}`).not.toMatch(claim);
      }
    }

    const en = readFileSync(resolve(projectRoot, "guide/en/delivery-metrics.md"), "utf8");
    const zh = readFileSync(resolve(projectRoot, "guide/zh/delivery-metrics.md"), "utf8");
    const readmeZh = readFileSync(resolve(projectRoot, "README_CN.md"), "utf8");
    expect(en).toContain("# Delivery metrics dictionary");
    expect(en).toContain("`roll delta metrics [");
    expect(en).toContain("`roll supervisor metrics [");
    expect(en).toContain("not proof of a model invocation");
    expect(zh).toContain("# 交付指标词典");
    expect(zh).toContain("`roll delta metrics [");
    expect(zh).toContain("`roll supervisor metrics [");
    expect(zh).toContain("不是模型调用的证明");
    expect(readmeZh).toContain("guide/zh/delivery-metrics.md");
  });
});

describe("US-DELTA-021 — unified feature delivery view documentation contract", () => {
  const surfaces = [
    "README.md",
    "README_CN.md",
    "guide/en/delivery-metrics.md",
    "guide/zh/delivery-metrics.md",
    "guide/en/ai-agents.md",
    "guide/zh/ai-agents.md",
    "guide/en/skills.md",
    "guide/zh/skills.md",
    "guide/en/getting-started.md",
    "guide/zh/getting-started.md",
    "docs/architecture.md",
    "docs/acceptance-contract.md",
  ];
  // The guard list is explicit so a future legitimate rewrite updates this test
  // rather than silently weakening it (design contract §6.5).
  const forbiddenStaleDirections = [
    // An operator choice between loop and Delta metric surfaces.
    /(?:pick|choose|select|switch between).*(?:loop|delta).*(?:metrics|views?)/i,
    // Topology-split as the way to read delivery.
    /use (?:roll )?(?:delta|loop) metrics[^\n]*to (?:see|view|check|compare)[^\n]*(?:loop|delta|feature) deliver/i,
    /primary workflow[^\n]*(?:loop|delta) metrics/i,
    /(?:选择|选用|切换).*(?:loop|delta).*(?:指标|metrics|视图)/,
    /(?:用|使用) (?:roll )?(?:delta|loop) metrics[^\n]*(?:查看|观察|比较)[^\n]*(?:交付|delivery)/,
    /(?:主要|首选)工作流[^\n]*(?:delta|loop).*(?:指标|metrics)/,
  ];

  it("never sends feature operators to separate loop/Delta metric surfaces as the primary workflow", () => {
    for (const surface of surfaces) {
      const text = readFileSync(resolve(projectRoot, surface), "utf8");
      for (const pattern of forbiddenStaleDirections) {
        expect(text, `${surface} must not publish ${pattern.source}`).not.toMatch(pattern);
      }
    }
    const rendered = [
      ["rendered EN supervisor usage", withLang("en", supervisorUsage)],
      ["rendered ZH supervisor usage", withLang("zh", supervisorUsage)],
      ["rendered EN delivery help", withLang("en", deliveryHelp)],
      ["rendered ZH delivery help", withLang("zh", deliveryHelp)],
    ] as const;
    for (const [label, text] of rendered) {
      for (const pattern of forbiddenStaleDirections) {
        expect(text, `${label} must not publish ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it("points every delivery-metrics surface at the unified roll supervisor delivery view", () => {
    for (const surface of ["README.md", "README_CN.md", "guide/en/delivery-metrics.md", "guide/zh/delivery-metrics.md"]) {
      const text = readFileSync(resolve(projectRoot, surface), "utf8");
      expect(text, `${surface} must name the unified view`).toContain("roll supervisor delivery");
    }
    expect(readFileSync(resolve(projectRoot, "guide/en/delivery-metrics.md"), "utf8")).toContain("# Feature delivery view");
    expect(readFileSync(resolve(projectRoot, "guide/zh/delivery-metrics.md"), "utf8")).toContain("# 功能交付视图");
  });
});
