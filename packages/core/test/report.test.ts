/**
 * US-ATTEST-005 — report renderer pins: the no-evidence red line (forced
 * Claimed + Discrepancies appendix), deletion-not-placeholder for screenshots,
 * single-file self-containment, and the 5-level badge ladder.
 *
 * RL-EVID-003: verification anchor for the registered redline
 * (policy/rules.yaml) — the "red line" describes below prove enforceRedLine()
 * is still alive.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ansiPre } from "../src/attest/ansi-html.js";
import { enforceRedLine, renderReport, type AcReportItem } from "../src/attest/report.js";
import { bi } from "../src/html/chrome.js";

function item(over: Partial<AcReportItem>): AcReportItem {
  return { id: "US-X-001:AC1", text: "默认 AC 文本", status: "pass", evidence: [], ...over };
}

const BASE = { storyId: "US-X-001", title: "示例 Story", generatedAt: "2026-06-06T00:00:00Z" };

describe("red line — no evidence can't stay pass", () => {
  it("pass/readonly/partial with zero evidence are forced to claimed", () => {
    for (const s of ["pass", "readonly", "partial"] as const) {
      const r = enforceRedLine(item({ status: s }));
      expect(r.item.status).toBe("claimed");
      expect(r.downgraded).toBe(true);
    }
  });

  it("missing/claimed stay as-is; evidence-backed pass survives", () => {
    expect(enforceRedLine(item({ status: "missing" })).downgraded).toBe(false);
    expect(enforceRedLine(item({ status: "claimed" })).downgraded).toBe(false);
    const backed = item({ evidence: [{ kind: "commit", label: "tcr: x" }] });
    expect(enforceRedLine(backed)).toEqual({ item: backed, downgraded: false });
  });

  it("downgraded items surface in the Discrepancies appendix with anchors", () => {
    const html = renderReport({ ...BASE, items: [item({ status: "pass" })] });
    expect(html).toContain(bi("Discrepancies", "证据缺口"));
    expect(html).toContain('href="#US-X-001:AC1"');
    expect(html).toContain("🟧 Claimed");
  });

  it("fully-evidenced report has NO Discrepancies section", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "test-pass", label: "suite green" }] })],
    });
    expect(html).not.toContain("Discrepancies");
  });
});

describe("US-META-010 — doc-gap shadow warning", () => {
  it("renders a shadow warning without changing the quality gate verdict", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "test-pass", label: "suite green" }] })],
      docGap: {
        changedFiles: ["packages/cli/src/commands/status.ts"],
        visibleFiles: ["packages/cli/src/commands/status.ts"],
      },
    });
    expect(html).toContain("doc-gap");
    expect(html).toContain("Shadow warning");
    expect(html).toContain("packages/cli/src/commands/status.ts");
    expect(html).toContain("不改变 Gate 结论");
  });
});

describe("deletion-not-placeholder", () => {
  it("screenshot figure renders only when the ref exists", () => {
    const w = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "screenshot", label: "首页", href: "./screenshots/a.png" }] })],
    });
    expect(w).toContain('<img src="./screenshots/a.png"');
    const wo = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(wo).not.toContain("<figure");
    expect(wo).not.toMatch(/placeholder|占位/);
  });
});

describe("US-EVID-012 — dynamic replay evidence", () => {
  it("renders asciinema casts inline and videos as local players", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({
          evidence: [
            { kind: "cast", label: "terminal replay", href: "evidence/demo.cast", inlineHtml: ansiPre("asciinema cast body") },
            { kind: "video", label: "web flow", href: "screenshots/flow.mp4" },
          ],
        }),
      ],
    });
    expect(html).toContain("Dynamic replay");
    expect(html).toContain("terminal replay");
    expect(html).toContain("asciinema cast body");
    expect(html).toContain('href="evidence/demo.cast"');
    expect(html).toContain("<video controls");
    expect(html).toContain('src="screenshots/flow.mp4"');
    expect(html).toContain("@media print");
  });

  it("evidence index includes cast/video locators", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({
          evidence: [
            { kind: "cast", label: "cast", href: "evidence/demo.cast", inlineHtml: ansiPre("{}") },
            { kind: "video", label: "video", href: "screenshots/flow.gif" },
          ],
        }),
      ],
    });
    expect(html).toContain("evidence/demo.cast");
    expect(html).toContain("screenshots/flow.gif");
  });
});

describe("single-file self-containment", () => {
  it("no external loads: no <script src>, no <link rel>, images only relative; chrome script is inline", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({
          evidence: [
            { kind: "screenshot", label: "s", href: "./screenshots/a.png" },
            { kind: "ci", label: "CI run", href: "https://github.com/x/y/actions/runs/1" },
            { kind: "text", label: "vitest", inlineHtml: ansiPre("[32m✓ ok[0m") },
          ],
        }),
      ],
      facts: { tcrCount: 3, ciConclusion: "success", testPassAge: "90s" },
    });
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/<img src="https?:/);
    // the ONLY script is the inline lang/theme chrome — no fetches, no third-party code
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain("localStorage");
    expect(html).toContain(".ansi"); // ANSI_CSS embedded
    expect(html).toContain('<span class="a-fg32">✓ ok</span>'); // text evidence inline
    expect(html).toContain("TCR commits: <b>3</b>");
    expect(html).toContain("@media print");
  });

  it("HTML-escapes AC text and labels", () => {
    const html = renderReport({ ...BASE, items: [item({ text: "a <b> & c", evidence: [{ kind: "commit", label: "<x>" }] })] });
    expect(html).toContain("a &lt;b&gt; &amp; c");
    expect(html).toContain("&lt;x&gt;");
  });
});

describe("US-ATTEST-011 — Gate self-capture section", () => {
  it("renders a figure for an unattended terminal self-capture", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "commit", label: "c" }] })],
      selfCaptures: [{ kind: "screenshot", label: "terminal", href: "./screenshots/terminal.png" }],
    });
    expect(html).toContain(bi("Gate self-capture", "Gate 自产实拍"));
    expect(html).toContain('<img src="./screenshots/terminal.png"');
  });

  it("no self-captures ⇒ block skipped, no placeholder (deletion contract)", () => {
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(html).not.toContain("Gate self-capture");
    const empty = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })], selfCaptures: [] });
    expect(empty).not.toContain("Gate self-capture");
  });
});

describe("US-ATTEST-013 — explicit layering order", () => {
  it("business body (context → badges → AC) precedes the closing (quality gate → evidence index)", () => {
    const html = renderReport({
      ...BASE,
      context: { oneLiner: "卡一句话" },
      items: [item({ id: "A:AC1", evidence: [{ kind: "test-pass", label: "suite green" }] })],
      facts: { tcrCount: 5, ciConclusion: "success", testPassAge: "30s" },
    });
    const ctxAt = html.indexOf("卡上下文");
    const acAt = html.indexOf('class="ac ');
    const gateAt = html.indexOf("质量门禁");
    const idxAt = html.indexOf("证据索引");
    // 主体 leads, 收口 trails — and the quality gate now lives in the closing,
    // after the AC body, not at the top.
    expect(ctxAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeLessThan(acAt);
    expect(acAt).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(idxAt);
    expect(html).toContain("TCR commits: <b>5</b>");
  });
});

describe("US-ATTEST-013 — card context leads the business body", () => {
  it("renders one-liner / epic / summary / backlog status / delivery chain before the AC sections", () => {
    const html = renderReport({
      ...BASE,
      context: {
        oneLiner: "报告分层且自含待办全貌",
        epic: "acceptance-evidence",
        summary: "报告原是工程师向 AC 堆，现按受众分层",
        backlogStatus: "🔨 In Progress",
        delivery: {
          prLinks: [{ label: "#486", href: "https://github.com/seanyao/roll/pull/486" }],
          cycleId: "cycle-20260606-092227-79062",
          timeline: "09:22 → 09:40",
          cost: "$0.42",
        },
      },
      items: [item({ evidence: [{ kind: "commit", label: "c" }] })],
    });
    expect(html).toContain(bi("Context", "卡上下文"));
    expect(html).toContain("报告分层且自含待办全貌");
    expect(html).toContain("acceptance-evidence");
    expect(html).toContain("🔨 In Progress");
    expect(html).toContain("cycle-20260606-092227-79062");
    expect(html).toContain('href="https://github.com/seanyao/roll/pull/486"');
    expect(html).toContain("$0.42");
    // context (business) precedes the first AC section
    expect(html.indexOf("卡上下文")).toBeLessThan(html.indexOf('class="ac '));
  });

  it("absent context ⇒ no context section (trim, no placeholder)", () => {
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(html).not.toContain("卡上下文");
  });

  it("context with only empty sub-fields is trimmed away", () => {
    const html = renderReport({ ...BASE, context: { delivery: {} }, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(html).not.toContain("卡上下文");
  });
});

describe("US-ATTEST-013 — evidence index closing section", () => {
  it("lists every evidence file in one table (AC + before/after + self-capture)", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({
          id: "A:AC1",
          evidence: [
            { kind: "screenshot", label: "首页", href: "./screenshots/a.png" },
            { kind: "ci", label: "CI run", href: "https://github.com/x/y/actions/runs/1" },
          ],
        }),
      ],
      beforeAfter: [
        {
          label: "首屏",
          before: { kind: "screenshot", label: "改前", href: "./screenshots/before.png" },
          after: { kind: "screenshot", label: "改后", href: "./screenshots/after.png" },
        },
      ],
      selfCaptures: [{ kind: "screenshot", label: "terminal", href: "./screenshots/terminal.png" }],
    });
    expect(html).toContain(bi("Evidence index", "证据索引"));
    expect(html).toContain("./screenshots/a.png");
    expect(html).toContain("./screenshots/before.png");
    expect(html).toContain("./screenshots/after.png");
    expect(html).toContain("./screenshots/terminal.png");
    expect(html).toContain("https://github.com/x/y/actions/runs/1");
  });

  it("no evidence at all ⇒ index skipped (no empty table)", () => {
    const html = renderReport({ ...BASE, items: [item({ status: "missing" })] });
    expect(html).not.toContain("证据索引");
  });
});

describe("US-ATTEST-013 — before/after comparison", () => {
  it("renders paired before/after figures side by side", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "commit", label: "c" }] })],
      beforeAfter: [
        {
          label: "报告首屏",
          before: { kind: "screenshot", label: "工程师向 AC 堆", href: "./screenshots/before-home.png" },
          after: { kind: "screenshot", label: "业务分层", href: "./screenshots/after-home.png" },
        },
      ],
    });
    expect(html).toContain(bi("Before / After", "对照实拍"));
    expect(html).toContain('<img src="./screenshots/before-home.png"');
    expect(html).toContain('<img src="./screenshots/after-home.png"');
    expect(html).toContain(bi("Before", "改前"));
    expect(html).toContain(bi("After", "改后"));
  });

  it("empty / absent before-after ⇒ section skipped (全新功能免出)", () => {
    const none = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(none).not.toContain("对照实拍");
    const empty = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })], beforeAfter: [] });
    expect(empty).not.toContain("对照实拍");
  });
});

describe("US-ATTEST-013 — layered IA: technical evidence folds", () => {
  it("text/ANSI evidence sits inside a collapsed <details class=\"tech\">", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({
          evidence: [
            { kind: "screenshot", label: "首页", href: "./screenshots/a.png" },
            { kind: "text", label: "vitest", inlineHtml: ansiPre("plain log line") },
          ],
        }),
      ],
    });
    expect(html).toContain('<details class="tech"');
    // collapsed by default — no `open` attribute on the tech fold
    expect(html).not.toMatch(/<details class="tech" open/);
    // the ANSI pre is INSIDE the fold (business screenshot is outside, before it)
    const detailsAt = html.indexOf('<details class="tech"');
    const ansiAt = html.indexOf('<pre class="ansi">plain log line</pre>');
    const shotAt = html.indexOf('<img src="./screenshots/a.png"');
    expect(detailsAt).toBeGreaterThan(-1);
    expect(ansiAt).toBeGreaterThan(detailsAt); // ANSI after the fold opens
    expect(shotAt).toBeLessThan(detailsAt); // business screenshot before technical fold
  });

  it("no text evidence ⇒ no tech fold (deletion-not-placeholder)", () => {
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(html).not.toContain('<details class="tech"');
  });
});

describe("badge ladder", () => {
  it("summary counts every present status with bilingual badges", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({ id: "A:AC1", evidence: [{ kind: "commit", label: "c" }] }),
        item({ id: "A:AC2", status: "readonly", evidence: [{ kind: "deploy", label: "d" }] }),
        item({ id: "A:AC3", status: "partial", note: "缺移动端验证", evidence: [{ kind: "ci", label: "ci" }] }),
        item({ id: "A:AC4", status: "missing" }),
      ],
    });
    expect(html).toContain(`✅ ${bi("Pass", "通过")} × 1`);
    expect(html).toContain(`🟦 ${bi("Read-only Pass", "只读通过")} × 1`);
    expect(html).toContain(`🟨 ${bi("Partial", "部分满足")} × 1`);
    expect(html).toContain(`🟥 ${bi("Missing", "无证据")} × 1`);
    expect(html).toContain("缺移动端验证");
  });
});

describe("US-ATTEST-012 — fail / blocked status口径", () => {
  it("fail and blocked render with own badge (icon+text, not color-only) and section class", () => {
    const html = renderReport({
      ...BASE,
      items: [
        item({ id: "A:AC1", status: "fail", evidence: [{ kind: "test-pass", label: "red suite" }] }),
        item({ id: "A:AC2", status: "blocked", note: "等 iOS 真机", evidence: [{ kind: "commit", label: "c" }] }),
      ],
    });
    // distinct, non-color marker = icon + bilingual word
    expect(html).toContain(`❌ ${bi("Fail", "未通过")} × 1`);
    expect(html).toContain(`⛔ ${bi("Blocked", "受阻")} × 1`);
    // status colour classes present so the badge ladder is not color-only
    expect(html).toContain("s-fail");
    expect(html).toContain("s-blocked");
    expect(html).toContain(".s-fail { border-left:");
    expect(html).toContain(".s-blocked { border-left:");
  });

  it("fail/blocked are NOT a no-evidence red-line downgrade (verified-and-failed ≠ missing)", () => {
    expect(enforceRedLine(item({ status: "fail", evidence: [] })).downgraded).toBe(false);
    expect(enforceRedLine(item({ status: "blocked", evidence: [] })).downgraded).toBe(false);
    // and they never appear in the Discrepancies appendix
    const html = renderReport({ ...BASE, items: [item({ status: "blocked", evidence: [] })] });
    expect(html).not.toContain("Discrepancies");
  });
});

describe("US-ATTEST-009 — Review Score fold", () => {
  it("renders a collapsed details block with entries", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "commit", label: "c" }] })],
      reviewScores: [
        { skill: "roll-fix", score: 6, verdict: "ok", ts: "2026-06-03T18:32:04Z", note: "Empty flaky CI card" },
        { skill: "roll-build", score: 9, verdict: "good", ts: "2026-06-04T01:00:00Z", note: "" },
      ],
    });
    expect(html).toContain(`${bi("Review Score", "评审分")}（2）`);
    expect(html).toContain("<details");
    expect(html).toContain("<b>6</b>/10 · ok");
    expect(html).toContain("Empty flaky CI card");
  });

  it("no entries ⇒ whole block skipped (no placeholder)", () => {
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(html).not.toContain("<details"); // the CSS rules may ship; the BLOCK must not
    expect(html).not.toContain("Review Score");
  });

  it("US-EVID-013: renders badge, dimensions, trend, full-note link, and discrepancy", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "commit", label: "c" }] })],
      reviewScoreTrend: "review-score: mean 7.0 / min 5 / redo 1 (last 14)",
      reviewScores: [
        {
          skill: "roll-build",
          score: 5,
          verdict: "ok",
          ts: "2026-06-08T12:00:00Z",
          note: "测试覆盖不足，后续要补。",
          href: "notes/2026-06-08-roll-build-US-EVID-013.md",
          dimensions: { "test-quality": 7 },
        },
      ],
    });
    expect(html).toContain('class="reviewscore-badge reviewscore-ok"');
    expect(html).toContain("<b>5</b>/10 · ok");
    expect(html).toContain("<code>test-quality</code>: <b>7</b>");
    expect(html).toContain("review-score: mean 7.0 / min 5 / redo 1 (last 14)");
    expect(html).toContain('href="notes/2026-06-08-roll-build-US-EVID-013.md"');
    expect(html).toContain("Review-score discrepancy");
    expect(html).toContain("low review-score: ok 5/10");
  });
});

describe("US-ATTEST-014 — process trace inline", () => {
  const withEv = [item({ evidence: [{ kind: "commit", label: "c" }] })];

  it("loop-delivered: renders timeline + signal layer + folded transcript with original-path index", () => {
    const html = renderReport({
      ...BASE,
      items: withEv,
      process: {
        delivery: "loop",
        cycleId: "20260606-093000-12345",
        agent: "claude",
        timeline: [
          { offsetSec: 0, layer: "outline", marker: "cycle:start", label: "周期开始 · cycle start" },
          { offsetSec: 20, layer: "signal", marker: "tcr", label: "TCR abcdef123 · add extractor" },
          { offsetSec: 140, layer: "outline", marker: "cycle:end", label: "周期结束 · cycle end · delivered" },
        ],
        transcript: {
          inlineHtml: "<pre class=\"ansi\">log body</pre>",
          truncated: true,
          totalLen: 300000,
          shownLen: 48000,
          originalPath: ".roll/loop/cycle-logs/20260606-093000-12345.agent.log",
        },
      },
    });
    expect(html).toContain(bi("Process trace", "过程档案"));
    expect(html).toContain("20260606-093000-12345");
    expect(html).toContain("claude");
    // timeline entries with offsets
    expect(html).toContain("+00:00");
    expect(html).toContain("+02:20");
    expect(html).toContain("add extractor");
    // signal layer visually distinguished
    expect(html).toContain("tl-signal");
    expect(html).toContain("tl-outline");
    // transcript folded, with truncation note + original-path index
    expect(html).toContain("完整转录");
    expect(html).toContain("log body");
    expect(html).toContain(".roll/loop/cycle-logs/20260606-093000-12345.agent.log");
    expect(html).toMatch(/截断|truncated/);
  });

  it("manual delivery: shows conductor 手工交付, no transcript fold", () => {
    const html = renderReport({
      ...BASE,
      items: withEv,
      process: { delivery: "manual", missing: ["cycle", "transcript"] },
    });
    expect(html).toContain(bi("Process trace", "过程档案"));
    expect(html).toContain("手工交付");
    expect(html).not.toContain("完整转录");
    // degrade markers surface which segments are missing
    expect(html).toContain("transcript");
  });

  it("absent process ⇒ whole section trimmed (no placeholder)", () => {
    const html = renderReport({ ...BASE, items: withEv });
    expect(html).not.toContain("过程档案");
    expect(html).not.toContain("过程数据缺失");
  });

  it("escapes transcript original path and timeline labels", () => {
    const html = renderReport({
      ...BASE,
      items: withEv,
      process: {
        delivery: "loop",
        cycleId: "c1",
        timeline: [{ offsetSec: 0, layer: "signal", marker: "alert", label: "ALERT · <script>" }],
      },
    });
    // the raw label must never land unescaped (the only <script> is the chrome's own)
    expect(html).not.toContain("ALERT · <script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("US-OBS-034 — Execution Cast in attest report", () => {
  it("includes Execution Cast section when cycleRoleSummary is provided", () => {
    const summary = {
      schema: "cycle-role-summary.v1" as const,
      cycleId: "cycle-001",
      storyId: "US-X-001",
      executionProfile: "verified" as const,
      generatedAt: "2026-06-29T12:00:00Z",
      builderSessionId: "ses-001",
      roles: [
        { role: "builder" as const, agent: "pi", model: "claude-4", state: "accepted" as const, acceptedByGate: false, ts: 1000, logPath: "logs/pi.log" },
        { role: "peer_reviewer" as const, agent: "reasonix", state: "accepted" as const, verdict: "refine", findings: 2, artifactPath: "/tmp/peer/cycle-001.pair.json", acceptedByGate: true, ts: 1200 },
        { role: "evaluator" as const, agent: "deepseek", state: "accepted" as const, score: 8, verdict: "ok", artifactPath: "/tmp/peer/cycle-001.score.pair.json", acceptedByGate: true, ts: 1400 },
        { role: "attest_gate" as const, agent: null, state: "accepted" as const, verdict: "produced", acceptedByGate: false, ts: 1500 },
      ],
      gates: { peerGate: "consulted", attestGate: "produced", delivery: "PR #1 merged" },
      sources: ["events.ndjson", "cycle-logs/cycle-001"],
    };
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "test-pass", label: "suite green" }] })],
      cycleRoleSummary: summary,
      cycleRoleSummaryHref: "summary.json",
      cycleRoleArtifactHrefs: {
        "logs/pi.log": "logs/pi.log",
        "/tmp/peer/cycle-001.pair.json": "peer/cycle-001.pair.json",
        "/tmp/peer/cycle-001.score.pair.json": "peer/cycle-001.score.pair.json",
      },
    });
    expect(html).toContain('id="execution-cast"');
    expect(html).toContain("Execution Cast");
    expect(html).toContain("执行阵容");
    expect(html).toContain("pi");          // builder agent
    expect(html).toContain("reasonix");    // peer reviewer
    expect(html).toContain("deepseek");    // evaluator
    expect(html).toContain("produced");    // attest gate verdict
    expect(html).toContain("summary.json"); // artifact link
    expect(html).toContain("summary.md"); // markdown artifact link
    expect(html).toContain("accepted peer artifact");
    expect(html).toContain("accepted evaluator artifact");
    expect(html).toContain("peer/cycle-001.pair.json");
    expect(html).toContain("cycle-001");
  });

  it("degrades gracefully when no cycleRoleSummary is provided", () => {
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "test-pass", label: "suite green" }] })],
    });
    // Should show a degraded message, not crash or omit the section entirely
    expect(html).toContain("Role summary unavailable");
  });

  it("shows failed evaluator attempts as parse failures", () => {
    const summary = {
      schema: "cycle-role-summary.v1" as const,
      cycleId: "cycle-002",
      storyId: "US-X-002",
      executionProfile: "verified" as const,
      generatedAt: "2026-06-29T12:00:00Z",
      roles: [
        { role: "builder" as const, agent: "pi", state: "accepted" as const, acceptedByGate: false, ts: 1000 },
        { role: "evaluator" as const, agent: "agent-a", state: "failed" as const, cause: "score parsing error", acceptedByGate: false, ts: 1300 },
        { role: "evaluator" as const, agent: "agent-b", state: "accepted" as const, score: 7, verdict: "ok", acceptedByGate: true, ts: 1400 },
        { role: "attest_gate" as const, agent: null, state: "accepted" as const, verdict: "produced", acceptedByGate: false, ts: 1500 },
      ],
      gates: { attestGate: "produced" },
      sources: [],
    };
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "test-pass", label: "suite green" }] })],
      cycleRoleSummary: summary,
    });
    expect(html).toContain("parse failure");
    expect(html).toContain("agent-a");
    expect(html).toContain("agent-b");
    expect(html).toContain("score parsing error");
  });

  it("escapes Execution Cast dynamic fields", () => {
    const summary = {
      schema: "cycle-role-summary.v1" as const,
      cycleId: "cycle-003",
      storyId: "US-X-003",
      executionProfile: "verified" as const,
      generatedAt: "2026-06-29T12:00:00Z",
      roles: [
        { role: "builder" as const, agent: "pi<script>alert(1)</script>", model: "model<img>", state: "accepted" as const, acceptedByGate: false, ts: 1000 },
        { role: "evaluator" as const, agent: "scorebot", state: "failed" as const, cause: "bad <score>", acceptedByGate: false, ts: 1300 },
      ],
      gates: { attestGate: "produced<script>" },
      sources: [],
    };
    const html = renderReport({
      ...BASE,
      items: [item({ evidence: [{ kind: "test-pass", label: "suite green" }] })],
      cycleRoleSummary: summary,
    });
    expect(html).not.toContain("pi<script>alert(1)</script>");
    expect(html).not.toContain("model<img>");
    expect(html).not.toContain("bad <score>");
    expect(html).toContain("pi&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("model&lt;img&gt;");
    expect(html).toContain("bad &lt;score&gt;");
  });
});

describe("US-ATTEST-017 — outward verification is never silently green", () => {
  const outItem = { ...BASE, items: [item({ evidence: [{ kind: "test-pass" as const, label: "suite green" }] })] };

  it("renders the unverified-external non-green line and warning banner", () => {
    const html = renderReport({
      ...outItem,
      outwardVerification: [
        { ac: "US-X-001:AC4", mode: "external-smoke", status: "unverified-external", environment: "release", command: "npm i -g github:o/r && r --version" },
      ],
    });
    expect(html).toContain("Outward verification");
    expect(html).toContain("UNVERIFIED — external smoke not run");
    expect(html).toContain('class="ov-banner ov-banner-warn"');
    expect(html).not.toContain('class="ov-banner ov-banner-ok"');
    // the row carries the non-green class, not a pass class
    expect(html).toContain("ov-row ov-unverified");
  });

  it("renders verified-in-simulation distinctly and still non-green", () => {
    const html = renderReport({
      ...outItem,
      outwardVerification: [
        { ac: "US-X-001:AC4", mode: "external-smoke", status: "verified-in-simulation", environment: "release", command: "npm pack" },
      ],
    });
    expect(html).toContain("verified-in-simulation");
    expect(html).toContain("simulation only, NOT accepted");
    expect(html).toContain('class="ov-banner ov-banner-warn"');
    expect(html).toContain("ov-row ov-simulation");
  });

  it("all-verified shows the green complete banner", () => {
    const html = renderReport({
      ...outItem,
      outwardVerification: [
        { ac: "US-X-001:AC4", mode: "external-smoke", status: "verified", environment: "release", command: "r --version", detail: "smoke passed" },
      ],
    });
    expect(html).toContain('class="ov-banner ov-banner-ok"');
    expect(html).not.toContain('class="ov-banner ov-banner-warn"');
    expect(html).toContain("VERIFIED (external smoke)");
  });

  it("owner-attested unverified reads 'owner attestation pending', not smoke wording", () => {
    const html = renderReport({
      ...outItem,
      outwardVerification: [
        { ac: "US-X-001:AC5", mode: "owner-attested", status: "unverified-external", approvalRef: "gh#1343" },
      ],
    });
    expect(html).toContain("UNVERIFIED — owner attestation pending");
    expect(html).toContain('class="ov-banner ov-banner-warn"');
    expect(html).toContain("gh#1343");
  });

  it("mixed states — a single unverified AC forces the whole banner non-green", () => {
    const html = renderReport({
      ...outItem,
      outwardVerification: [
        { ac: "US-X-001:AC3", mode: "external-smoke", status: "verified", environment: "ci", command: "r --help" },
        { ac: "US-X-001:AC4", mode: "external-smoke", status: "unverified-external", environment: "release", command: "npm i -g github:o/r" },
      ],
    });
    expect(html).toContain('class="ov-banner ov-banner-warn"');
    expect(html).not.toContain('class="ov-banner ov-banner-ok"');
    expect(html).toContain("VERIFIED (external smoke)");
    expect(html).toContain("UNVERIFIED — external smoke not run");
  });

  it("absent/empty outward verification trims the section entirely", () => {
    expect(renderReport(outItem)).not.toContain("Outward verification");
    expect(renderReport({ ...outItem, outwardVerification: [] })).not.toContain("Outward verification");
  });

  it("escapes the smoke command (no HTML injection)", () => {
    const html = renderReport({
      ...outItem,
      outwardVerification: [
        { ac: "US-X-001:AC4", mode: "external-smoke", status: "unverified-external", command: "r <script>x</script>" },
      ],
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

// ── US-EVID-031 — visual evidence by surface (AC4, AC6) ──────────────────────
describe("US-EVID-031 — capture surfaces render every image with provenance (AC4/AC6)", () => {
  const TEAM = "http://localhost:3000/team";
  const surfaceReport: import("../src/attest/report.js").CaptureSurfaceReport = {
    surfaceId: TEAM,
    visual: "verified",
    acIds: ["AC2", "AC3"],
    images: [
      {
        source: "roll-capture-window",
        captureClass: "physical",
        label: "Roll Capture · physical · " + TEAM,
        href: "screenshots/team-physical.png",
        sha256: "sha256:" + "a".repeat(64),
        receiptHref: "screenshots/team-physical.png.response.json",
        requestId: "US-X-001-run1-team-roll-capture-window",
      },
      {
        source: "playwright-rendered",
        captureClass: "rendered",
        label: "Playwright · rendered · " + TEAM,
        href: "screenshots/team-rendered.png",
        sha256: "sha256:" + "b".repeat(64),
        receiptHref: "screenshots/team-rendered.png.response.json",
        requestId: "US-X-001-run1-team-playwright-rendered",
      },
    ],
  };

  it("renders BOTH a physical AND a rendered image mapped to the shared declared surface (AC6)", () => {
    const html = renderReport({ ...BASE, items: [item({ status: "pass", evidence: [{ kind: "commit", label: "c" }] })], captureSurfaces: [surfaceReport] });
    // The shared surface heading appears once.
    expect(html).toContain(TEAM);
    // Both provenance labels are present.
    expect(html).toContain("Roll Capture · physical");
    expect(html).toContain("Playwright · rendered");
    // Both images are attached (not hidden because one lane was lower-preference).
    expect(html).toContain("screenshots/team-physical.png");
    expect(html).toContain("screenshots/team-rendered.png");
    // Each image links its receipt + shows its hash (AC4).
    expect(html).toContain("team-physical.png.response.json");
    expect(html).toContain("team-rendered.png.response.json");
    expect(html).toContain("sha256:" + "a".repeat(64));
    expect(html).toContain("sha256:" + "b".repeat(64));
    // provenance class markers.
    expect(html).toContain('data-class="physical"');
    expect(html).toContain('data-class="rendered"');
  });

  it("does NOT hide a lower-preference rendered image when the physical lane failed (AC4)", () => {
    // Physical lane produced no image (host failure) but rendered still captured.
    const degraded: import("../src/attest/report.js").CaptureSurfaceReport = {
      surfaceId: TEAM,
      visual: "verified",
      acIds: ["AC2"],
      images: [
        {
          source: "playwright-rendered",
          captureClass: "rendered",
          label: "Playwright · rendered · " + TEAM,
          href: "screenshots/team-rendered.png",
          sha256: "sha256:" + "c".repeat(64),
          requestId: "rend",
        },
      ],
    };
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })], captureSurfaces: [degraded] });
    expect(html).toContain("screenshots/team-rendered.png");
    expect(html).toContain("Playwright · rendered");
  });

  it("shows a visible degraded / blocked badge for non-verified surfaces (AC5)", () => {
    const degraded = { ...surfaceReport, visual: "degraded-infrastructure" as const, images: [], reason: "all lanes attempted; only host failures" };
    const blocked = { ...surfaceReport, visual: "invalid-target" as const, reason: "a lane reached login" };
    const degradedHtml = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })], captureSurfaces: [degraded] });
    const blockedHtml = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })], captureSurfaces: [blocked] });
    expect(degradedHtml).toContain("vh-degraded");
    expect(degradedHtml).toContain("all lanes attempted; only host failures");
    expect(blockedHtml).toContain("vh-blocked");
    expect(blockedHtml).toContain("a lane reached login");
  });

  it("labels a legacy image as legacy and keeps it visible (builder_notes)", () => {
    const withLegacy: import("../src/attest/report.js").CaptureSurfaceReport = {
      ...surfaceReport,
      images: [{ source: "legacy-native", captureClass: "physical", label: "legacy shot", href: "screenshots/old.png", requestId: "legacy-1", legacy: true }],
    };
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })], captureSurfaces: [withLegacy] });
    expect(html).toContain("screenshots/old.png");
    expect(html).toContain("legacy");
  });

  it("trims the section entirely when no capture surface is present", () => {
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "c" }] })] });
    expect(html).not.toContain("Visual evidence by surface");
  });

  it("writes a rendered acceptance-report fixture showing both provenance labels under a shared surface (AC4/AC6 visual substitute)", () => {
    const html = renderReport({
      storyId: "US-EVID-031",
      title: "US-EVID-031 — Visual evidence by surface (fixture)",
      generatedAt: "2026-07-18T00:00:00Z",
      items: [
        item({ id: "US-EVID-031:AC4", text: "render every accepted image with provenance", status: "pass-with-evidence", evidence: [{ kind: "commit", label: "tcr" }] }),
        item({ id: "US-EVID-031:AC6", text: "one physical and one rendered under a shared surface", status: "pass-with-evidence", evidence: [{ kind: "commit", label: "tcr" }] }),
      ],
      captureSurfaces: [surfaceReport],
    });
    const outDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "evidence-health");
    mkdirSync(outDir, { recursive: true });
    const fixturePath = join(outDir, "US-EVID-031-report.html");
    writeFileSync(fixturePath, html);
    // The fixture is a self-contained, single HTML file with both labels + images.
    expect(html).toContain("Roll Capture · physical");
    expect(html).toContain("Playwright · rendered");
    expect(html).toContain('data-class="physical"');
    expect(html).toContain('data-class="rendered"');
    expect(html).not.toContain("http://localhost:3000/team.png"); // no bogus asset
    expect(existsSync(fixturePath)).toBe(true);
  });
});

// US-EVID-033 — delivery-time facts block: the card's own PR/sha, honest states,
// post-hoc labeling, and deletion-not-placeholder when the fact is absent.
describe("delivery-time facts block (US-EVID-033)", () => {
  const verified = {
    state: "verified" as const,
    prNumber: 1490,
    headSha: "aaaabbbbccccdddd",
    mergeCommit: "32195061fb3e",
    mergedAt: "2026-07-20T10:00:00.000Z",
    collectedAt: "2026-07-27T09:00:00.000Z",
    postHoc: "yes" as const,
    checks: [{ name: "test-ts", conclusion: "success" }],
  };

  it("renders the card's own PR, head sha, merge commit and each check", () => {
    const html = renderReport({ ...BASE, items: [item({ evidence: [{ kind: "commit", label: "tcr: x" }] })], deliveryCi: verified });
    expect(html).toContain(bi("Delivery-time facts", "交付时事实"));
    expect(html).toContain("#1490");
    expect(html).toContain("aaaabbbbccccdddd");
    expect(html).toContain("32195061fb3e");
    expect(html).toContain("test-ts");
    expect(html).toContain("success");
  });

  it("labels a post-hoc collection as such, and does not when it is cycle-time", () => {
    const post = renderReport({ ...BASE, items: [item({})], deliveryCi: verified });
    expect(post).toContain('data-posthoc="yes"');
    expect(post).toContain("事后重建");
    const inCycle = renderReport({ ...BASE, items: [item({})], deliveryCi: { ...verified, postHoc: "no" } });
    expect(inCycle).toContain('data-posthoc="no"');
    expect(inCycle).not.toContain("事后重建");
    // Unknown timing SAYS so — it never reads as cycle-time evidence (codex r1).
    const unknownTiming = renderReport({ ...BASE, items: [item({})], deliveryCi: { ...verified, postHoc: "unknown" } });
    expect(unknownTiming).toContain('data-posthoc="unknown"');
    expect(unknownTiming).toContain("合并时间未知");
  });

  it("states red / unknown with the reason instead of softening it", () => {
    const red = renderReport({
      ...BASE,
      items: [item({})],
      deliveryCi: { ...verified, state: "red", reason: "checks_failed:test-ts", checks: [{ name: "test-ts", conclusion: "failure" }] },
    });
    expect(red).toContain("checks_failed:test-ts");
    expect(red).toContain('data-state="red"');
    const unknown = renderReport({
      ...BASE,
      items: [item({})],
      deliveryCi: { state: "unknown", reason: "no_delivery_record", collectedAt: "2026-07-27T09:00:00.000Z", postHoc: "unknown", checks: [] },
    });
    expect(unknown).toContain("no_delivery_record");
    expect(unknown).toContain('data-state="unknown"');
  });

  it("is trimmed entirely when no delivery fact exists (no placeholder)", () => {
    const html = renderReport({ ...BASE, items: [item({})] });
    expect(html).not.toContain(bi("Delivery-time facts", "交付时事实"));
  });
});

// Codex r4 — the requirement set, its source, and the current-configuration caveat
// must be visible to a human reading the report, not only in the JSON manifest.
describe("delivery-time facts — requirement provenance is rendered (US-EVID-033 r4)", () => {
  const fact = {
    state: "verified" as const,
    prNumber: 1495,
    headSha: "e4978feb585a1124025a02aa5056a937483a81e5",
    mergeCommit: "963a7404",
    mergedAt: "2026-07-24T07:43:21.000Z",
    collectedAt: "2026-07-27T09:00:00.000Z",
    postHoc: "yes" as const,
    checks: [{ name: "test-ts", conclusion: "success" }],
    requiredChecksSource: "protection+ruleset" as const,
    requiredChecks: [{ context: "test-ts", appId: 15368 }],
  };

  it("renders each required context (with its App pin) and the declaring surface", () => {
    const html = renderReport({ ...BASE, items: [item({})], deliveryCi: fact });
    expect(html).toContain("test-ts@app15368");
    expect(html).toContain("protection+ruleset");
  });

  it("states the current-configuration caveat", () => {
    const html = renderReport({ ...BASE, items: [item({})], deliveryCi: fact });
    expect(html).toContain("GitHub 不提供历史视图");
  });

  it("says so plainly when nothing is declared", () => {
    const html = renderReport({
      ...BASE,
      items: [item({})],
      deliveryCi: { ...fact, requiredChecksSource: "none_declared", requiredChecks: [] },
    });
    expect(html).toContain(bi("none declared", "未声明"));
  });
});
