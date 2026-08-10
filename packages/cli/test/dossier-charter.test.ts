/**
 * US-DOSSIER-033 — Charter markdown browser + About / Conventions machine pages.
 *
 * Structural-fidelity coverage: every reference component the build spec /
 * FIDELITY-BAR names for these surfaces is asserted present —
 *   Charter tab  : a directory tree (Charter · Guide · Plans groups) on the left,
 *                  the selected file rendered as markdown on the right, the
 *                  client doc-selector, and the guide/en↔zh lang-following body.
 *   About page   : injected identity, manifesto + architecture rendered markdown,
 *                  the guide map (rows link to source docs), the shared shell.
 *   Conventions  : the four config.yaml sync targets with in-sync/stale freshness
 *                  (the SAME ok/stale口径 as the agents panel), the AGENTS.md
 *                  rulebook rendered markdown, the shared shell.
 * Plus the pure collectors over injected deps (deterministic, offline).
 */
import { describe, expect, it } from "vitest";
import { GENERATED_INVARIANTS, serializeTruthSnapshot, type TruthSnapshot } from "@roll/spec";
import { renderTruthConsole } from "../src/lib/truth-console.js";
import { collectCharter, type CharterDeps, type CharterVM } from "../src/lib/page-charter.js";
import { collectAbout, renderAboutPage } from "../src/lib/page-about.js";
import { collectConventions, renderConventionsPage } from "../src/lib/page-conventions.js";
import type { AgentPanelRow } from "../src/lib/agent-panel.js";

const SNAP: TruthSnapshot = {
  generatedAt: "2026-06-13T00:00:00Z",
  story: { total: 1, spectrum: { done: 1, wip: 0, hold: 0, todo: 0, fail: 0, unknown: 0 }, legacy: 0 },
  release: { latestTag: "v3.613.1", verdict: "pass" },
};
const BRAND = { name: "roll", slogan: "It just works." };

// A passthrough markdown renderer so tests assert on the SOURCE → render mapping
// without coupling to the markdown engine's exact HTML.
const mdTag = (md: string): string => `<MD>${md}</MD>`;

// ---------------------------------------------------------------- collectors

describe("collectCharter — US-DOSSIER-033 (pure)", () => {
  const tree: Record<string, string[]> = {
    docs: ["docs/manifesto.md", "docs/architecture.md"],
    "guide/en": ["guide/en/loop.md"],
    "guide/zh": ["guide/zh/loop.md"],
    ".roll/features/dossier": [".roll/features/dossier/plan.md"],
  };
  const files: Record<string, string> = {
    "docs/manifesto.md": "# Manifesto\nmain is truth",
    "docs/architecture.md": "# Architecture\nlayered control",
    "guide/INDEX.md": "# Documentation Index\n| Path | Title |",
    "guide/en/loop.md": "# roll loop\nEN body",
    "guide/zh/loop.md": "# roll loop\n中文正文",
    ".roll/features/dossier/plan.md": "# Dossier plan\nthe plan",
  };
  const deps: CharterDeps = {
    readDoc: (rel) => files[rel],
    listMd: (dir) => tree[dir] ?? [],
    listEpics: () => ["dossier"],
    render: mdTag,
  };

  it("groups docs into Charter · Guide · Plans, titles from first heading, default = first", () => {
    const vm = collectCharter(deps);
    expect(vm.groups.map((g) => g.key)).toEqual(["charter", "guide", "plans"]);
    const charter = vm.groups.find((g) => g.key === "charter")!;
    expect(charter.docs.map((d) => d.id)).toEqual(["docs/manifesto.md", "docs/architecture.md"]);
    expect(charter.docs[0]!.title).toBe("Manifesto");
    expect(vm.defaultId).toBe("docs/manifesto.md");
    // INDEX.md leads the guide group, then guide/en docs.
    const guide = vm.groups.find((g) => g.key === "guide")!;
    expect(guide.docs[0]!.id).toBe("guide/INDEX.md");
    expect(guide.docs[1]!.id).toBe("guide/en/loop.md");
    // plans group reads .roll/features/<epic>/*.md
    const plans = vm.groups.find((g) => g.key === "plans")!;
    expect(plans.docs[0]!.id).toBe(".roll/features/dossier/plan.md");
  });

  it("AC2: a guide/en doc carries its guide/zh sibling as a distinct body (lang-aware)", () => {
    const vm = collectCharter(deps);
    const loop = vm.groups.find((g) => g.key === "guide")!.docs.find((d) => d.id === "guide/en/loop.md")!;
    expect(loop.bilingual).toBe(true);
    expect(loop.bodyEn).toContain("EN body");
    expect(loop.bodyZh).toContain("中文正文");
    expect(loop.bodyEn).not.toBe(loop.bodyZh);
  });

  it("AC5: doc bodies are rendered through the injected render path (deterministic)", () => {
    const vm = collectCharter(deps);
    expect(vm.groups[0]!.docs[0]!.bodyEn).toBe("<MD># Manifesto\nmain is truth</MD>");
  });

  it("empty tree → no groups, no default (graceful)", () => {
    const empty = collectCharter({ readDoc: () => undefined, listMd: () => [], listEpics: () => [], render: mdTag });
    expect(empty.groups).toEqual([]);
    expect(empty.defaultId).toBeUndefined();
  });
});

describe("collectAbout — US-DOSSIER-041 (pure, structured charter)", () => {
  it("AC4: yields the structured charter — creed + 4-phase loop + 7 domains + 4 principle groups + 12 invariants", () => {
    const vm = collectAbout({ docExists: () => true });
    // creed — roll's one-line philosophy
    expect(vm.creed.en).toContain("black box");
    expect(vm.creed.zh).toContain("黑盒");
    // feedback loop — exactly the 4 phases Act → Sense → Score → Correct
    expect(vm.loop.map((s) => s.label.en)).toEqual(["Act", "Sense", "Score", "Correct"]);
    // capability domains — exactly 7, Tool Use among them
    expect(vm.domains).toHaveLength(7);
    expect(vm.domains.map((d) => d.name.en)).toContain("Tool Use");
    // principles — 4 groups, 14 items, numbered 1..14
    expect(vm.principles.map((g) => g.group.en)).toEqual(["Control", "Truth", "Failure", "Structure"]);
    const principleNums = vm.principles.flatMap((g) => g.items.map((p) => p.n));
    expect(principleNums).toHaveLength(14);
    expect(principleNums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // invariants — exactly 12, I1..I12
    expect(vm.invariants).toHaveLength(12);
    expect(vm.invariants.map((iv) => iv.n)).toEqual(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I11", "I12"]);
  });

  it("US-RULE-013: the Invariants section consumes the generated typed data (no local ROLL_INVARIANTS copy)", () => {
    const vm = collectAbout({ docExists: () => true });
    expect(vm.invariants[0]).toEqual({
      n: "I1",
      t: { en: GENERATED_INVARIANTS[0]!.projection.about.en, zh: GENERATED_INVARIANTS[0]!.projection.about.zh },
    });
    expect(vm.invariants[11]).toEqual({
      n: "I12",
      t: { en: GENERATED_INVARIANTS[11]!.projection.about.en, zh: GENERATED_INVARIANTS[11]!.projection.about.zh },
    });
  });

  it("AC2: records whether the source docs (manifesto/architecture) are present, to cite them honestly", () => {
    const present = collectAbout({ docExists: (rel) => rel === "docs/manifesto.md" || rel === "docs/architecture.md" });
    expect(present.manifestoPresent).toBe(true);
    expect(present.architecturePresent).toBe(true);
    const absent = collectAbout({ docExists: () => false });
    expect(absent.manifestoPresent).toBe(false);
    expect(absent.architecturePresent).toBe(false);
    // the structured charter copy is constant — present whether or not docs exist
    expect(absent.invariants).toHaveLength(12);
    expect(absent.domains).toHaveLength(7);
  });
});

const AGENTS: AgentPanelRow[] = [
  { name: "claude", display: "claude", runner: "Claude Code", version: "2.1.0", installed: true, cycles72h: 4, costUsd72h: 1, files: [], syncStale: false },
  { name: "kimi", display: "kimi", runner: "Kimi CLI", version: "—", installed: true, cycles72h: 1, costUsd72h: 0, files: [], syncStale: true, setupCmd: "roll setup -f" },
  // pi / reasonix absent — not installed on this machine.
];

describe("collectConventions — US-DOSSIER-033 (pure)", () => {
  const config: Record<string, string> = {
    sync_claude: "~/.claude/CLAUDE.md",
    sync_kimi: "~/.kimi/AGENTS.md",
    sync_pi: "~/.pi/AGENTS.md",
    sync_reasonix: "~/.reasonix/AGENTS.md",
  };
  const deps = { readConfig: (k: string) => config[k] ?? "", agents: AGENTS, readDoc: (rel: string) => (rel === "AGENTS.md" ? "# Conventions\nrules" : undefined), render: mdTag };

  it("AC4: lists the four sync targets with the SAME ok/stale freshness as the agents panel", () => {
    const vm = collectConventions(deps);
    expect(vm.targets.map((t) => t.configKey)).toEqual(["sync_claude", "sync_kimi", "sync_pi", "sync_reasonix"]);
    const byAgent = Object.fromEntries(vm.targets.map((t) => [t.agent, t.state]));
    expect(byAgent["claude"]).toBe("sync"); // installed + not stale
    expect(byAgent["kimi"]).toBe("stale"); // installed + syncStale
    expect(byAgent["pi"]).toBe("absent"); // not installed
    expect(byAgent["reasonix"]).toBe("absent");
    expect(vm.targets[0]!.dest).toBe("~/.claude/CLAUDE.md");
  });

  it("AC4: the rulebook (AGENTS.md) is rendered markdown via the same path", () => {
    const vm = collectConventions(deps);
    expect(vm.rulebook?.path).toBe("AGENTS.md");
    expect(vm.rulebook?.html).toBe("<MD># Conventions\nrules</MD>");
  });

  it("missing AGENTS.md → rulebook undefined (graceful)", () => {
    const vm = collectConventions({ ...deps, readDoc: () => undefined });
    expect(vm.rulebook).toBeUndefined();
  });
});

// ---------------------------------------------------------------- Charter tab

const CHARTER_VM: CharterVM = {
  defaultId: "docs/manifesto.md",
  groups: [
    {
      key: "charter",
      docs: [
        { id: "docs/manifesto.md", path: "docs/manifesto.md", title: "Manifesto", bodyEn: "<h1>Manifesto</h1>", bodyZh: "<h1>Manifesto</h1>", bilingual: false },
        { id: "docs/architecture.md", path: "docs/architecture.md", title: "Architecture", bodyEn: "<h1>Architecture</h1>", bodyZh: "<h1>Architecture</h1>", bilingual: false },
      ],
    },
    {
      key: "guide",
      docs: [{ id: "guide/en/loop.md", path: "guide/en/loop.md", title: "roll loop", bodyEn: "<p>EN loop body</p>", bodyZh: "<p>ZH loop 正文</p>", bilingual: true }],
    },
    { key: "plans", docs: [{ id: ".roll/features/dossier/plan.md", path: ".roll/features/dossier/plan.md", title: "Dossier plan", bodyEn: "<p>plan</p>", bodyZh: "<p>plan</p>", bilingual: false }] },
  ],
};

function consoleHtml(charter: CharterVM = CHARTER_VM): string {
  return renderTruthConsole({
    snapshot: SNAP,
    snapshotJson: serializeTruthSnapshot(SNAP),
    brand: BRAND,
    backlog: { shipping: [], settled: [] },
    spineKeys: ["definition", "design", "execution", "delivery", "retrospective"],
    cycles: [],
    agents: [],
    releasePanel: { dims: [], total: { fail: 0, warn: 0, unknown: 0 }, blocking: false },
    releaseScope: { pending: [], shipped: [], pendingCount: 0, shippedCount: 0, history: [] },
    skills: { summary: { skills: 0, violations: 0, hubLines: 0 }, groups: [] },
    casting: { rows: [], configured: false },
    charter,
  });
}

describe("Charter project tab — US-DOSSIER-033", () => {
  const html = consoleHtml();

  it("AC1: a Charter tab is hash-routed and present as a pane", () => {
    expect(html).toContain('data-tab="charter"');
    expect(html).toContain('id="tab-charter"');
    expect(html).toContain(">Charter<");
    expect(html).toContain(">章程<");
  });

  it("AC1: a directory tree (Charter · Guide · Plans) on the left, each doc a selectable row", () => {
    expect(html).toContain("charter-tree");
    expect(html).toContain('data-doc="docs/manifesto.md"');
    expect(html).toContain('data-doc="docs/architecture.md"');
    expect(html).toContain('data-doc="guide/en/loop.md"');
    // group labels
    expect(html).toContain(">Guide<");
    expect(html).toContain(">Epic plans<");
  });

  it("AC1: the selected file is rendered as markdown on the right, default doc shown", () => {
    expect(html).toContain("charter-reader");
    expect(html).toContain('class="md-doc on" data-doc="docs/manifesto.md"');
    expect(html).toContain("<h1>Manifesto</h1>");
    expect(html).toContain("md-body");
  });

  it("AC2: a guide/en↔zh doc carries BOTH bodies, each behind a lang class (follows EN/中)", () => {
    expect(html).toContain('<div class="lang-en md-body"><p>EN loop body</p></div>');
    expect(html).toContain('<div class="lang-zh md-body"><p>ZH loop 正文</p></div>');
  });

  it("the client doc-selector + hash route are wired (no fetch — bodies are baked in)", () => {
    expect(html).toContain("function applyCharter");
    expect(html).toContain("#charter/");
    // self-contained: no network markdown lib / fetch for the doc bodies
    expect(html).not.toContain("fetch(");
  });

  it("empty charter degrades to a friendly empty state (no crash)", () => {
    const empty = consoleHtml({ groups: [] });
    expect(empty).toContain("No charter documents found");
    expect(empty).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------- About page

describe("About machine page — US-DOSSIER-041 (structured charter)", () => {
  const aboutVM = collectAbout({ docExists: () => true });
  const html = renderAboutPage({ brand: BRAND, snapshot: SNAP, vm: aboutVM });

  it("AC3: wears the shared machine shell and self-highlights the About breadcrumb", () => {
    expect(html).toContain("background:rgba(27,34,56,.97)"); // sticky dark bar
    expect(html).toContain("height:54px");
    expect(html).toContain('data-machine="about"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-set-lang="zh"'); // lang toggle rides along
  });

  it("AC3: cool design, bilingual EN/中 (separate lines), shared IBM Plex font links", () => {
    // the injected brand rides the top bar (never hardcoded)
    expect(html).toContain(">roll<");
    expect(html).toContain("It just works.");
    // bilingual masthead — EN and 中 each present (rendered on separate lines via bi())
    expect(html).toContain("How roll works");
    expect(html).toContain("roll 怎么运转");
    // FIX-287: About shares the same IBM Plex FONT_LINKS path as the console
    // and the other machine pages.
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain("IBM+Plex+Sans");
    expect(html).toContain("IBM+Plex+Mono");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("undefined");
  });

  it("AC1/AC4: creed — roll's one-line philosophy", () => {
    expect(html).toContain("black box");
    expect(html).toContain("黑盒");
  });

  it("AC1/AC4: feedback loop — the 4 phases Act → Sense → Score → Correct", () => {
    expect(html).toContain(">Act<");
    expect(html).toContain(">Sense<");
    expect(html).toContain(">Score<");
    expect(html).toContain(">Correct<");
    expect(html).toContain("作动");
    expect(html).toContain("反哺");
  });

  it("AC1/AC4: capability domains — all 7 present (Tool Use among them)", () => {
    for (const dm of ["Orchestration", "Execution / Sandbox", "Tool Use", "Context Engineering", "Observability", "Evals", "Guardrails"]) {
      expect(html).toContain(dm);
    }
  });

  it("AC1/AC4: principles — the 4 groups and all 14 numbered lines", () => {
    for (const g of ["Control", "Truth", "Failure", "Structure"]) {
      expect(html).toContain(g);
    }
    expect(html).toContain("Reliability lives in the harness, not the model"); // #1
    expect(html).toContain("Humans on the loop, not in it"); // #14
    expect(html).toContain("不打开黑盒"); // zh copy present
  });

  it("AC1/AC4: invariants — all 12 (I1..I12) present", () => {
    for (let i = 1; i <= 12; i++) {
      expect(html).toContain(`>I${i}<`);
    }
    // US-RULE-013 — the About Invariants section renders the registry
    // projection sentences (I1 about.en, I12 about.zh), not the old short copy.
    expect(html).toContain("heartbeat at least every 60s");
    expect(html).toContain("0 个 TCR 提交");
  });

  it("AC2: cites the source docs when present; degrades gracefully when absent", () => {
    expect(html).toContain("docs/manifesto.md");
    expect(html).toContain("docs/architecture.md");
    const bare = renderAboutPage({ brand: BRAND, snapshot: SNAP, vm: collectAbout({ docExists: () => false }) });
    expect(bare).not.toContain("undefined");
    // structured charter still fully renders even with no source docs
    expect(bare).toContain(">I12<");
    expect(bare).toContain("Tool Use");
  });
});

// -------------------------------------------------------- Conventions page

describe("Conventions machine page — US-DOSSIER-033", () => {
  const convVM = collectConventions({
    readConfig: (k) => ({ sync_claude: "~/.claude/CLAUDE.md", sync_kimi: "~/.kimi/AGENTS.md", sync_pi: "~/.pi/AGENTS.md", sync_reasonix: "~/.reasonix/AGENTS.md" })[k] ?? "",
    agents: AGENTS,
    readDoc: (rel) => (rel === "AGENTS.md" ? "# Conventions\n- main is truth" : undefined),
    render: (md) => `<RB>${md}</RB>`,
  });
  const html = renderConventionsPage({ brand: BRAND, snapshot: SNAP, vm: convVM });

  it("AC2: wears the shared shell, self-highlights Conventions, bilingual crumb", () => {
    expect(html).toContain("background:rgba(27,34,56,.97)");
    expect(html).toContain('data-machine="conventions"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(">Conventions<");
    expect(html).toContain(">约定<");
  });

  it("AC4: lists the four sync targets with in-sync/stale freshness (bilingual labels)", () => {
    expect(html).toContain("sync_claude");
    expect(html).toContain("sync_kimi");
    expect(html).toContain("sync_pi");
    expect(html).toContain("sync_reasonix");
    // freshness labels — the same ok/stale口径 as the agents panel
    expect(html).toContain("in sync");
    expect(html).toContain("已同步");
    expect(html).toContain("stale");
    expect(html).toContain("已过期");
    // claude row in-sync, kimi row stale (driven by the agents panel rows)
    expect(html).toContain('data-target="claude" data-state="sync"');
    expect(html).toContain('data-target="kimi" data-state="stale"');
    expect(html).toContain('data-target="pi" data-state="absent"');
  });

  it("AC4: the rulebook (AGENTS.md) is rendered read-only via the markdown path", () => {
    expect(html).toContain("<RB># Conventions");
    expect(html).toContain("AGENTS.md");
    expect(html).toContain("md-body");
  });

  it("no undefined leaks", () => {
    expect(html).not.toContain("undefined");
  });
});
