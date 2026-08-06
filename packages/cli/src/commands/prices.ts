/**
 * @responsibility Runs the `prices` subcommand, rendering the versioned price table.
 */
/**
 * `roll prices` — TS port of cmd_prices show/help (US-CLI-004).
 * Loads the versioned price snapshots under lib/prices/ (frozen v2 data),
 * merges them later-overrides-earlier, and renders the same table bytes as
 * the inline-python oracle. `refresh` is TS-owned as of US-PORT-017.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLang, t, v2Catalog } from "@roll/spec";
import { repoRoot } from "../bridge.js";
import { pricesRefreshCommand, type PricesRefreshDeps } from "./prices-refresh.js";

interface Snapshot {
  version: string;
  effective_at: string;
  source_url: string;
  prices: Record<string, Record<string, number>>;
  default_model: string;
  vendor: string;
  currency: string;
}

function loadSnapshots(): Snapshot[] {
  const dir = join(repoRoot(), "lib", "prices");
  if (!existsSync(dir)) {
    throw new Error(`no price snapshots found in ${dir}; run \`roll prices refresh\``);
  }
  const files = readdirSync(dir)
    .filter((n) => n.startsWith("snapshot-") && n.endsWith(".json"))
    .sort();
  return files.map((name) => {
    const data = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<Snapshot>;
    for (const key of ["version", "effective_at", "source_url", "prices"] as const) {
      if (data[key] === undefined) throw new Error(`snapshot ${name} missing required key ${key}`);
    }
    const prices = data.prices as Snapshot["prices"];
    return {
      version: data.version as string,
      effective_at: data.effective_at as string,
      source_url: data.source_url as string,
      prices,
      default_model: data.default_model ?? Object.keys(prices)[0] ?? "",
      vendor: data.vendor ?? "anthropic",
      currency: data.currency ?? "USD",
    };
  });
}

/** Python-format helpers used by the oracle's f-strings. */
const padL = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));
const padR = (s: string, w: number): string => (s.length >= w ? s : " ".repeat(w - s.length) + s);
const f4 = (n: number): string => padR(n.toFixed(4), 10);

const HELP = `Usage: roll prices <subcommand> [--url URL] [--vendor VENDOR]
      roll prices <子命令> [--url 网址] [--vendor 厂商]

Subcommands:
  show     Print the current price snapshot table.
           显示当前价格快照表。
  refresh  Fetch the official pricing docs, diff against the latest snapshot,
           and write a new snapshot only when rates have changed.
           拉取官方价格文档与最新快照对比，有变化才落新快照。

Options:
  --vendor anthropic|deepseek|kimi  Target vendor for refresh (default: anthropic).
                                    指定拉取价格的厂商（默认：anthropic）。
`;

function showCommand(): number {
  const snaps = loadSnapshots();
  const last = snaps[snaps.length - 1];
  if (last === undefined) return 1;

  // Merge: later snapshots override earlier ones; track per-model currency.
  const prices: Record<string, Record<string, number>> = {};
  const currency: Record<string, string> = {};
  for (const snap of snaps) {
    for (const [model, rates] of Object.entries(snap.prices)) {
      prices[model] = rates;
      currency[model] = snap.currency;
    }
  }

  const out: string[] = [];
  out.push("price snapshot  价格快照");
  out.push(`  version        ${last.version}`);
  out.push(`  effective_at   ${last.effective_at}`);
  out.push(`  snapshots      ${snaps.length} loaded  已加载`);
  for (const snap of snaps) {
    out.push(`    ${padL(snap.vendor, 12)} ${padR(snap.currency, 4)}  ${snap.source_url}`);
  }
  out.push("");
  out.push(`  ${padL("model", 24)}${padR("cur", 4)}${padR("in", 10)}${padR("out", 10)}${padR("cw", 10)}${padR("cr", 10)}`);
  for (const model of Object.keys(prices).sort()) {
    const p = prices[model];
    if (p === undefined) continue;
    out.push(
      `  ${padL(model, 24)}${padR(currency[model] ?? "USD", 4)}${f4(p["in"] ?? 0)}${f4(p["out"] ?? 0)}${f4(p["cache_create"] ?? 0)}${f4(p["cache_read"] ?? 0)}`,
    );
  }
  out.push("");
  out.push("rates per million tokens  每百万 token 单价");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

export interface PricesCommandDeps {
  refresh?: PricesRefreshDeps;
}

export function pricesCommand(args: string[], deps: PricesCommandDeps = {}): number | Promise<number> {
  const [sub] = args;
  if (sub === "show") return showCommand();
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub === "refresh") return pricesRefreshCommand(args.slice(1), deps.refresh);
  // Unknown subcommand: bilingual err + help on stderr, exit 1 (mirrors bash).
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const RED = noColor ? "" : "\x1b[0;31m";
  const NC = noColor ? "" : "\x1b[0m";
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
  process.stderr.write(`${RED}[roll]${NC} ${t(v2Catalog, lang, "prices.unknown_subcommand", sub)}\n`);
  process.stderr.write(HELP);
  return 1;
}
