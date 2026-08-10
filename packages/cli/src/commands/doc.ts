/**
 * @responsibility Runs the `doc` subcommand, rendering Charter and language guide markdown as readable text.
 */
/**
 * US-DOSSIER-037 — `roll doc [--lang en|zh]`: view the Charter / language guide
 * markdown from the terminal (the same docs the static archive Charter browser
 * renders, US-DOSSIER-033), as readable text rather than HTML.
 *
 * Reuse over re-source:
 *  - the doc tree + bodies come from the SAME `collectCharter()` collector the
 *    web Charter browser renders from (`docs/*.md` Charter group, the
 *    `guide/en`↔`guide/zh` pairs, `guide/INDEX.md`). We inject a markdown→plain
 *    renderer instead of the HTML one so the bodies read in the terminal — the
 *    selection logic and the doc set are identical to the web.
 *  - the lang ladder is the SAME `resolveCurrent()` / `configLang()` path `roll
 *    lang` uses; `--lang` overrides it, an omitted flag falls back to it. There
 *    is no second lang resolver.
 *
 * Read-only by design: this is a viewer, not an editor — it prints docs and
 * resolves lang; it never writes docs or changes config (that stays `roll lang`).
 * An unknown `--lang` value exits non-zero with a bilingual (EN line / 中 line)
 * error.
 */
import { resolveLang } from "@roll/spec";
import { collectCharter, defaultCharterDeps, type CharterVM, type CharterDoc } from "../lib/page-charter.js";
import { resolveCurrent } from "./lang.js";
import { c, hr, renderState } from "../render.js";
import { repoRoot } from "../bridge.js";

export const DOC_USAGE =
  "Usage: roll doc [--lang en|zh] [name]\n" +
  "  View the Charter and language guide markdown in the terminal.\n" +
  "在终端查看 Charter 与语言指南文档。\n" +
  "  --lang en|zh  select the guide tree (default: configured language)\n" +
  "  --lang en|zh  选择指南语言（缺省：配置语言）\n" +
  "  name          show one doc by id/path/basename (default: list the tree)\n" +
  "  name          按 id/路径/文件名查看单篇（缺省：列出全部）";

/** Lang used to render this command's own chrome / errors (follows the ladder). */
function msgLang(): "en" | "zh" {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}

/**
 * Minimal markdown → readable plain text. Strips heading hashes, list bullets to
 * "• ", inline code/bold/italic markers, and link syntax to "text (url)". Pure;
 * no clock / network. Injected into `collectCharter` so the bodies render in the
 * terminal (the web injects the HTML renderer instead — same collector, two skins).
 */
export function markdownToText(src: string): string {
  const out: string[] = [];
  for (const raw of src.split("\n")) {
    let line = raw.replace(/\s+$/, "");
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) line = h[2] ?? "";
    line = line.replace(/^(\s*)[-*]\s+/, "$1• ");
    line = line.replace(/`([^`]+)`/g, "$1");
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
    line = line.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
    line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
    out.push(line);
  }
  // collapse trailing blank lines for a tidy print
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

const GROUP_LABEL: Record<"charter" | "guide" | "plans", { en: string; zh: string }> = {
  charter: { en: "Charter", zh: "宪章" },
  guide: { en: "Guide", zh: "指南" },
  plans: { en: "Plans", zh: "计划" },
};

/** The body for a doc under the selected guide language (guide pairs follow lang). */
function bodyFor(doc: CharterDoc, lang: "en" | "zh"): string {
  return lang === "zh" ? doc.bodyZh : doc.bodyEn;
}

/** Match a doc by exact id/path, or by basename (with/without `.md`). */
export function findDoc(vm: CharterVM, name: string): CharterDoc | undefined {
  const want = name.replace(/\.md$/, "");
  for (const g of vm.groups) {
    for (const d of g.docs) {
      if (d.id === name || d.path === name) return d;
      const base = (d.path.split("/").at(-1) ?? d.path).replace(/\.md$/, "");
      if (base === want) return d;
    }
  }
  return undefined;
}

/** The tree listing: groups, each with its docs' titles + paths. */
export function renderDocTree(vm: CharterVM, lang: "en" | "zh"): string {
  const lines: string[] = [];
  for (const g of vm.groups) {
    const label = GROUP_LABEL[g.key];
    lines.push(c("pink", lang === "zh" ? label.zh : label.en, { bold: true }));
    for (const d of g.docs) {
      lines.push("  " + c("blue", d.path) + c("muted", "  ·  ") + c("dim", d.title));
    }
    lines.push("");
  }
  lines.push(
    c("muted", lang === "zh" ? "用 roll doc <名称> 查看单篇（如 roll doc manifesto）。" : "View one doc with roll doc <name> (e.g. roll doc manifesto)."),
  );
  return `${lines.join("\n")}\n`;
}

/** One doc's readable body, with a title rule. */
export function renderDocBody(doc: CharterDoc, lang: "en" | "zh"): string {
  const lines: string[] = [];
  lines.push(c("fg", doc.title, { bold: true }) + c("muted", `  ·  ${doc.path}`));
  lines.push(hr());
  lines.push(bodyFor(doc, lang));
  return `${lines.join("\n")}\n`;
}

export function docCommand(args: string[]): number {
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${DOC_USAGE}\n`);
    return 0;
  }

  // Parse --lang en|zh (override) and a positional doc name.
  let langFlag: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--lang") {
      langFlag = args[i + 1];
      i++;
      continue;
    }
    const m = /^--lang=(.*)$/.exec(a);
    if (m) {
      langFlag = m[1];
      continue;
    }
    if (a === "--no-color") continue;
    if (a.startsWith("-")) {
      process.stderr.write(`[roll] unknown flag: ${a}\n${DOC_USAGE}\n`);
      return 1;
    }
    positional.push(a);
  }

  // --lang validation: only en|zh. An unknown value is a bilingual error, exit 1.
  if (langFlag !== undefined && langFlag !== "en" && langFlag !== "zh") {
    process.stderr.write(`[roll] unknown --lang value '${langFlag}' (valid: en, zh)\n`);
    process.stderr.write(`[roll] --lang 取值无效 '${langFlag}'（可选：en, zh）\n`);
    return 1;
  }

  // Omitted --lang falls back to the configured language via the SAME ladder
  // `roll lang` uses (resolveCurrent → ROLL_LANG / config / locale / default).
  const docLang: "en" | "zh" = langFlag === "en" || langFlag === "zh" ? langFlag : resolveCurrent();

  // SAME collector the web Charter browser renders from — only the renderer skin
  // differs (plain text here, HTML on the web). Prefer project-local docs when
  // present; installed npm CLIs fall back to the packaged Roll docs/guide tree.
  let vm = collectCharter(defaultCharterDeps(process.cwd(), markdownToText));
  if (vm.groups.length === 0) {
    vm = collectCharter(defaultCharterDeps(repoRoot(), markdownToText));
  }

  if (vm.groups.length === 0) {
    const ml = msgLang();
    process.stderr.write(ml === "zh" ? "[roll] 未找到任何文档（docs/、guide/）。\n" : "[roll] no docs found (docs/, guide/).\n");
    return 1;
  }

  const name = positional[0];
  if (name !== undefined) {
    const doc = findDoc(vm, name);
    if (doc === undefined) {
      const ml = msgLang();
      process.stderr.write(ml === "zh" ? `[roll] 找不到文档 ${name}（用 roll doc 列出全部）\n` : `[roll] no doc matches ${name} (run roll doc to list)\n`);
      return 1;
    }
    process.stdout.write(renderDocBody(doc, docLang));
    return 0;
  }

  process.stdout.write(renderDocTree(vm, docLang));
  return 0;
}
