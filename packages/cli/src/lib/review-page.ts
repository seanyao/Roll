/**
 * @responsibility Renders the design-review page HTML.
 */
import { CHROME_CSS } from "@roll/core";
import type { DesignReviewBlock, DesignReviewPage, Lang } from "@roll/spec";
import { escapeHtml } from "./markdown.js";

export interface DesignReviewRenderInput {
  id: string;
  title: string;
  sourceSpecPath: string;
  status: DesignReviewPage["status"];
  generatedAt: string;
  cardsCreated: number;
  nextAction: string;
  markdown: string;
  lang: Lang;
}

function label(lang: Lang, en: string, zh: string): string {
  return lang === "zh" ? zh : en;
}

function section(markdown: string, names: string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const out: string[] = [];
  let collecting = false;
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      if (collecting) break;
      collecting = wanted.has((heading[2] ?? "").toLowerCase());
      continue;
    }
    if (collecting) out.push(line);
  }
  return out.join("\n").trim();
}

function lines(text: string): string[] {
  return text.split("\n").map((x) => x.replace(/^[-*]\s+/, "").trim()).filter((x) => x !== "");
}

function codeBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const body = match[1]?.trim();
    if (body !== undefined && body !== "") out.push(body);
    match = re.exec(text);
  }
  return out;
}

function withoutCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
}

function architectureBlock(markdown: string): DesignReviewBlock {
  const src = section(markdown, ["Architecture Map", "Architecture", "架构图", "架构"]);
  const graphLines = lines(src).filter((x) => /-{2,}>|->|→/.test(x));
  const nodes = new Map<string, { id: string; label: string }>();
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  for (const line of graphLines) {
    const parts = line.split(/(?:-{2,}>|->|→)/).map((p) => p.replace(/[-|]+/g, " ").trim()).filter((p) => p !== "");
    for (const part of parts) {
      const id = slug(part);
      nodes.set(id, { id, label: part });
    }
    for (let i = 0; i < parts.length - 1; i += 1) {
      const from = slug(parts[i] ?? "");
      const to = slug(parts[i + 1] ?? "");
      if (from !== "" && to !== "") edges.push({ from, to });
    }
  }
  if (nodes.size === 0) {
    const domain = section(markdown, ["Domain Slice", "领域切片"]);
    const fields = lines(domain).map((line) => {
      const [keyRaw, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      return { key: keyRaw?.trim() ?? "", value };
    }).filter((row) => row.key !== "" && row.value !== "");
    for (const row of fields) {
      const valueParts = row.value.split(/[;,]/).map((part) => part.trim()).filter((part) => part !== "");
      for (const value of valueParts) {
        const label = `${row.key}: ${value}`;
        nodes.set(slug(label), { id: slug(label), label });
      }
    }
    const ids = [...nodes.keys()];
    for (let i = 0; i < ids.length - 1; i += 1) {
      const from = ids[i];
      const to = ids[i + 1];
      if (from !== undefined && to !== undefined) edges.push({ from, to });
    }
  }
  return {
    kind: "architecture-map",
    title: "Architecture Map",
    ...(nodes.size > 0 ? { nodes: [...nodes.values()], edges } : { summary: "not enough structure" }),
  };
}

function flowBlock(markdown: string): DesignReviewBlock {
  const src = section(markdown, ["Flow", "Flow Diagram", "流程", "流程图"]);
  const joined = lines(src).join(" ");
  let steps = joined.split(/(?:->|→)/).map((x) => x.trim()).filter((x) => x !== "");
  if (steps.length < 2) {
    const sample = section(markdown, ["Complete Worked Sample", "Worked Sample", "完整样例"]);
    const sampleLines = lines(sample);
    steps = unique([
      sampleLines.find((line) => /creates/i.test(line)),
      sampleLines.find((line) => /invokes/i.test(line)),
      sampleLines.find((line) => /opens/i.test(line)),
      sampleLines.find((line) => /captures/i.test(line)),
      sampleLines.find((line) => /writes/i.test(line)),
      sampleLines.find((line) => /records/i.test(line)),
    ].filter((line): line is string => line !== undefined));
  }
  return {
    kind: "flow",
    title: "Flow Diagram",
    ...(steps.length >= 2 ? { items: steps.map((step, i) => ({ step: String(i + 1), action: step })) } : { summary: "not enough structure" }),
  };
}

function decisionBlock(markdown: string): DesignReviewBlock {
  const src = section(markdown, ["Decision Matrix", "Decision", "决策矩阵", "决策"]);
  const rows = lines(withoutCodeFences(src)).map((line) => {
    const [optionRaw, ...rest] = line.split(":");
    const rationale = rest.join(":").trim();
    const lower = line.toLowerCase();
    const verdict = lower.includes("chosen") || lower.includes("选择") || lower.includes("create a dedicated") ? "chosen" : lower.includes("rejected") || lower.includes("拒绝") ? "rejected" : "noted";
    return { option: optionRaw?.trim() ?? line, verdict, rationale };
  });
  return {
    kind: "decision-matrix",
    title: "Decision Matrix",
    ...(rows.length > 0 ? { items: rows } : { summary: "not enough structure" }),
  };
}

function prototypeBlock(markdown: string): DesignReviewBlock {
  const src = section(markdown, ["Prototype Frames", "Prototype", "Frame Board", "原型", "界面原型"]);
  let body = lines(src);
  if (body.length === 0) {
    const sample = section(markdown, ["Complete Worked Sample", "Worked Sample", "完整样例"]);
    const sampleBlocks = codeBlocks(sample);
    const openCommand = sampleBlocks.find((block) => /open\s+-g\s+-a\s+"Roll Capture"/.test(block));
    const doctorBlock = sampleBlocks.find((block) => /roll doctor --tools/.test(block));
    const first = openCommand ?? doctorBlock ?? sampleBlocks[0];
    if (first !== undefined) body = ["CLI capture request", ...first.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "")];
  }
  return {
    kind: "prototype-frame",
    title: "Prototype Frames",
    ...(body.length > 0 ? { frames: [{ title: body[0] ?? "Frame", surface: "cli", body: body.slice(1) }] } : { summary: "not enough structure" }),
  };
}

function signoffBlock(markdown: string, nextAction: string): DesignReviewBlock {
  const src = section(markdown, ["Sign-off", "Signoff", "Owner Sign-off", "签批"]);
  const items = lines(src).map((line) => ({ action: line }));
  if (items.length === 0) items.push({ action: nextAction });
  return { kind: "signoff", title: "Sign-off", items };
}

function blockGap(block: DesignReviewBlock, source: string, lang: Lang): string {
  if (block.summary !== "not enough structure") return "";
  return `<p class="gap">${escapeHtml(label(lang, "not enough structure", "结构不足"))} · <a href="${escapeHtml(source)}">${escapeHtml(label(lang, "source design", "源设计"))}</a></p>`;
}

function renderArchitecture(block: DesignReviewBlock, source: string, lang: Lang): string {
  if (block.nodes === undefined || block.nodes.length === 0) return blockGap(block, source, lang);
  const nodeHtml = block.nodes.map((n) => `<span class="node">${escapeHtml(n.label)}</span>`).join("");
  const edges = block.edges ?? [];
  const edgeHtml = edges.slice(0, 4).map((e) => `<span class="edge"><code>${escapeHtml(e.from)}</code> → <code>${escapeHtml(e.to)}</code></span>`).join("");
  const more = edges.length > 4 ? `<span class="edge muted">+${edges.length - 4} more</span>` : "";
  return `<div class="nodes">${nodeHtml}</div><div class="edge-strip">${edgeHtml}${more}</div>`;
}

function renderItems(block: DesignReviewBlock, source: string, lang: Lang): string {
  if (block.items === undefined || block.items.length === 0) return blockGap(block, source, lang);
  const keys = [...new Set(block.items.flatMap((row) => Object.keys(row)))];
  const head = keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("");
  const body = block.items.map((row) => `<tr>${keys.map((k) => `<td>${escapeHtml(row[k] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderFrames(block: DesignReviewBlock, source: string, lang: Lang): string {
  if (block.frames === undefined || block.frames.length === 0) return blockGap(block, source, lang);
  return block.frames.map((frame) => `<div class="frame"><h3>${escapeHtml(frame.title)}</h3><pre>${escapeHtml(frame.body.join("\n"))}</pre></div>`).join("");
}

function renderBlock(block: DesignReviewBlock, source: string, lang: Lang): string {
  const body =
    block.kind === "architecture-map" ? renderArchitecture(block, source, lang) :
    block.kind === "prototype-frame" ? renderFrames(block, source, lang) :
    renderItems(block, source, lang);
  return `<section class="review-block block-${block.kind}"><h2>${escapeHtml(block.title)}</h2>${body}</section>`;
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.replace(/^[A-Z]+-\d+\s+—\s+/, "").trim() || fallback;
}

export function designReviewModel(input: DesignReviewRenderInput): DesignReviewPage {
  const source = `${input.sourceSpecPath}#detailed-design`;
  return {
    kind: "design",
    id: input.id,
    title: titleFromMarkdown(input.markdown, input.title),
    sourceSpecPath: input.sourceSpecPath,
    status: input.status,
    generatedAt: input.generatedAt,
    blocks: [
      { kind: "summary", title: "Summary" },
      architectureBlock(input.markdown),
      flowBlock(input.markdown),
      decisionBlock(input.markdown),
      prototypeBlock(input.markdown),
      signoffBlock(input.markdown, input.nextAction),
    ],
    artifacts: [
      { label: "source design", path: source, kind: "markdown" },
      { label: "Design Review Page", path: "design-review.html", kind: "html" },
    ],
  };
}

export function renderDesignReviewPageFromMarkdown(input: DesignReviewRenderInput): string {
  const model = designReviewModel(input);
  const lang = input.lang;
  const source = `${input.sourceSpecPath}#detailed-design`;
  const architecture = model.blocks.find((b) => b.kind === "architecture-map");
  const flow = model.blocks.find((b) => b.kind === "flow");
  const decision = model.blocks.find((b) => b.kind === "decision-matrix");
  const prototype = model.blocks.find((b) => b.kind === "prototype-frame");
  const signoff = model.blocks.find((b) => b.kind === "signoff");
  if (
    architecture === undefined ||
    flow === undefined ||
    decision === undefined ||
    prototype === undefined ||
    signoff === undefined
  ) {
    throw new Error("design review model is missing required blocks");
  }
  const status = input.status === "awaiting-signoff" ? label(lang, "awaiting owner sign-off", "等待负责人签批") : input.status;
  return `<!DOCTYPE html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.id)} · Design Review Page</title>
<style>
${CHROME_CSS}
body { max-width:1120px; }
.hero { display:grid; grid-template-columns:1.2fr .8fr; gap:16px; align-items:start; }
.summary-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:12px; }
.metric { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:color-mix(in srgb, var(--accent) 4%, transparent); }
.metric b { display:block; font-size:18px; line-height:1.25; }
.nodes { display:flex; flex-wrap:wrap; gap:10px; margin:8px 0 12px; }
.node { border:1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); background:color-mix(in srgb, var(--accent) 8%, transparent); border-radius:8px; padding:8px 10px; font-family:var(--mono); }
.edge-strip { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; color:var(--muted); font-family:var(--mono); font-size:12px; }
.edge { border:1px solid var(--line); border-radius:999px; padding:4px 8px; background:var(--surface); }
.muted { color:var(--muted); }
table { width:100%; border-collapse:collapse; font-size:13.5px; }
th, td { border-bottom:1px solid var(--line); text-align:left; padding:8px; vertical-align:top; }
.frame pre { white-space:pre-wrap; }
.gap { color:var(--warn); font-family:var(--mono); }
@media (max-width:760px) { .hero { grid-template-columns:1fr; } .summary-grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<p class="kicker">Roll · Design Review Page</p>
<div class="hero">
<section>
<h1>Design Review Page · ${escapeHtml(input.id)}</h1>
<p class="meta">${escapeHtml(model.title)} · ${escapeHtml(input.generatedAt)}</p>
<div class="summary-grid">
<div class="metric"><span>${escapeHtml(label(lang, "Status", "状态"))}</span><b>${escapeHtml(status)}</b></div>
<div class="metric"><span>${escapeHtml(label(lang, "Cards created", "卡片数"))}</span><b>${input.cardsCreated}</b></div>
<div class="metric"><span>${escapeHtml(label(lang, "Raw design", "源设计"))}</span><b><a href="${escapeHtml(source)}">spec.md</a></b></div>
<div class="metric"><span>${escapeHtml(label(lang, "Next action", "下一步"))}</span><b>${escapeHtml(input.nextAction)}</b></div>
</div>
</section>
${renderBlock(architecture, source, lang)}
</div>
${renderBlock(flow, source, lang)}
${renderBlock(decision, source, lang)}
${renderBlock(prototype, source, lang)}
${renderBlock(signoff, source, lang)}
<footer>Roll · Design Review Page · <code>${escapeHtml(input.id)}</code></footer>
</body>
</html>
`;
}
