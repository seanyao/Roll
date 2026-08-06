/**
 * @responsibility Runs the `cast` subcommand, rendering the role casting table in the terminal.
 */
/**
 * US-DOSSIER-037 — `roll cast`: the same role Casting table the static archive
 * shows (US-DOSSIER-030 Casting grid), brought to the terminal.
 *
 * ONE computation, two surfaces: this command calls the exact `collectCasting()`
 * view-model the web renders — it does NOT re-read the router or recompute slots,
 * so the CLI table and the web Casting grid are one口径 (same agents, same
 * em-dashes, same scenario rows). `--json` emits that same view-model verbatim;
 * the JSON is the data the human table is rendered from, never a re-derivation.
 *
 * Determinism (mirrors router Invariant I10): the table is pure over the injected
 * `CastingDeps` — `defaultCastingDeps` does the best-effort `.roll/` reads once at
 * the call site, then the render is clock/rng-free. Same config → same table.
 */
import { resolveLang } from "@roll/spec";
import { collectCasting, defaultCastingDeps, type CastingRow, type CastingVM } from "../lib/casting.js";
import { c, pad, renderState, strw } from "../render.js";

export const CAST_USAGE =
  "Usage: roll cast [--json]\n" +
  "  Print the role Casting table (same data as the web grid).\n" +
  "打印角色分工表（与 web 网格同源同数据）。";

/** Active language for the human table (same ladder as `roll lang` / siblings). */
function castLang(): "en" | "zh" {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}

/**
 * Render the Casting view-model as a terminal table. The agent column carries
 * the em-dash verbatim for an empty slot (never a guessed agent); a `mono` row
 * is a bare agent token, a non-mono row is the prose rule (peer / onboard). The
 * route-resolve rationale, when present, prints as a dim follow-on line — the
 * SAME audit surfaced in the web grid, nothing inferred where absent.
 */
export function renderCastTable(vm: CastingVM, lang: "en" | "zh"): string {
  const roleHead = lang === "zh" ? "角色" : "Role";
  const agentHead = lang === "zh" ? "出演" : "Agent";
  const noteHead = lang === "zh" ? "说明" : "Note";

  const roleOf = (r: CastingRow): string => (lang === "zh" ? r.roleZh : r.roleEn);
  const agentOf = (r: CastingRow): string => (lang === "zh" ? r.agentZh : r.agentEn);
  const noteOf = (r: CastingRow): string => (lang === "zh" ? r.noteZh : r.noteEn);

  // Column widths sized to the real data (display width, CJK-aware) — not hardcoded.
  const roleW = Math.max(strw(roleHead), ...vm.rows.map((r) => strw(roleOf(r))));
  const agentW = Math.max(strw(agentHead), ...vm.rows.map((r) => strw(agentOf(r))));

  const lines: string[] = [];
  lines.push(
    "  " + c("dim", pad(roleHead, roleW)) + "  " + c("dim", pad(agentHead, agentW)) + "  " + c("dim", noteHead),
  );
  for (const r of vm.rows) {
    const agentText = r.empty ? c("muted", agentOf(r)) : r.mono ? c("blue", agentOf(r)) : c("fg", agentOf(r));
    // pad() measures display width on the colored string, so the column stays aligned.
    lines.push(
      "  " + c("fg", pad(roleOf(r), roleW)) + "  " + pad(agentText, agentW) + "  " + c("muted", noteOf(r)),
    );
    if (r.audit !== "") lines.push("  " + " ".repeat(roleW) + "  " + c("faint", `↳ ${r.audit}`));
  }
  if (!vm.configured) {
    lines.push("");
    lines.push(
      c("muted", lang === "zh" ? "  尚无 legacy route 配置 — 使用 .roll/agents.yaml 维护 scoped roles。" : "  No legacy routes configured — author scoped roles in .roll/agents.yaml."),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function castCommand(args: string[]): number {
  const wantJson = args.includes("--json");
  const noColor = args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${CAST_USAGE}\n`);
    return 0;
  }
  const unknown = args.filter((a) => a.startsWith("-") && a !== "--json" && a !== "--no-color");
  if (unknown.length > 0) {
    process.stderr.write(`[roll] unknown flag: ${unknown[0]}\n${CAST_USAGE}\n`);
    return 1;
  }

  // ONE computation: the same collector the web Casting grid renders from.
  const vm = collectCasting(defaultCastingDeps(process.cwd()));

  if (wantJson) {
    // The JSON IS the human table's source data — emit the view-model verbatim.
    process.stdout.write(`${JSON.stringify(vm, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderCastTable(vm, castLang()));
  return 0;
}
