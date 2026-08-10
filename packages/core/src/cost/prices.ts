/**
 * @responsibility Resolves model list costs and currency from the faithful price table.
 * Cost / currency resolution — TS port of the frozen python `lib/model_prices.py`
 * (`_resolve` / `_resolve_name` / `compute_list_cost` / `currency_for`).
 *
 * This is the FAITHFUL home of the logic that was first ported in the dashboard
 * batch at `packages/cli/src/commands/prices-cost.ts`. Core may not import cli,
 * so the canonical copy lives here and the cli file re-exports from `@roll/core`.
 *
 * v2 oracle (frozen, read fully before any change):
 *   - `_resolve(model, prices, default)`        (lib/model_prices.py:97-122):
 *     longest-prefix match of a known price key against `model` or its
 *     digit/dash-stripped base; vendor-prefix fallback (`vendor/inner`); else the
 *     `default` model's rates. {@link resolve}.
 *   - `_resolve_name(...)`                       (lib/model_prices.py:125-152):
 *     identical resolution but returns the matched KEY (for currency lookup).
 *     {@link resolveName}.
 *   - `currency_for(model)`                       (lib/model_prices.py:158-169):
 *     resolve the name with a sentinel default; sentinel ⇒ "USD" (FIX-162 — a
 *     genuinely unknown model must not inherit the global default's CNY).
 *     {@link currencyFor}.
 *   - `compute_list_cost(model, *, …)`            (lib/model_prices.py:172-186):
 *     `(in·p.in + out·p.out + cw·p.cache_create + cr·p.cache_read) / 1e6`,
 *     rounded to 4 dp (python `round` = round-half-to-even). {@link computeListCost}.
 *   - snapshot load + merge (later-overrides-earlier), per-model currency
 *     (lib/model_prices.py:33-87): {@link loadTable}.
 *
 * Snapshot directory resolution mirrors the cli bridge `repoRoot()`: walk up
 * from this module until `bin/roll` is found, then read `lib/prices/`. Tests can
 * inject an explicit table via the `prices`/`default` params (same escape hatch
 * the python functions expose).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Snapshot {
  version: string;
  effective_at: string;
  source_url: string;
  prices: Record<string, Record<string, number>>;
  default_model: string;
  currency: string;
}

/** A merged price table: rates + per-model currency + default model name. */
export interface PriceTable {
  prices: Record<string, Record<string, number>>;
  currency: Record<string, string>;
  default: string;
  /** Newest snapshot version string (mirrors python `VERSION`). */
  version: string;
}

let cached: PriceTable | null = null;

/** Walk up from this module to the repo/package root, keyed on the shipped
 *  `lib/prices/` data dir we actually read — the bash engine (`bin/roll`) is
 *  retired (US-PORT-021), so the marker is the data, not the old binary. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "lib", "prices"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("prices: cannot locate repo root (no lib/prices marker)");
}

/**
 * Load + merge all `lib/prices/snapshot-*.json`, later-overrides-earlier, with a
 * per-model currency map (mirrors lib/model_prices.py:70-87). Cached after first
 * load. Pass `dir` to override the snapshot directory (tests).
 */
export function loadTable(dir?: string): PriceTable {
  if (dir === undefined && cached !== null) return cached;
  const snapDir = dir ?? join(repoRoot(), "lib", "prices");
  if (!existsSync(snapDir)) {
    throw new Error(`no price snapshots found in ${snapDir}; run \`roll prices refresh\``);
  }
  const files = readdirSync(snapDir)
    .filter((n) => n.startsWith("snapshot-") && n.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no price snapshots found in ${snapDir}; run \`roll prices refresh\``);
  }
  const snaps: Snapshot[] = files.map((name) => {
    const data = JSON.parse(readFileSync(join(snapDir, name), "utf8")) as Partial<Snapshot>;
    const prices = (data.prices ?? {}) as Snapshot["prices"];
    return {
      version: data.version ?? "",
      effective_at: data.effective_at ?? "",
      source_url: data.source_url ?? "",
      prices,
      default_model: data.default_model ?? Object.keys(prices)[0] ?? "",
      currency: data.currency ?? "USD",
    };
  });
  const prices: Record<string, Record<string, number>> = {};
  const currency: Record<string, string> = {};
  for (const snap of snaps) {
    for (const [model, rates] of Object.entries(snap.prices)) {
      prices[model] = { ...rates };
      currency[model] = snap.currency;
    }
  }
  const last = snaps[snaps.length - 1];
  const table: PriceTable = {
    prices,
    currency,
    default: last ? last.default_model : "",
    version: last ? last.version : "",
  };
  if (dir === undefined) cached = table;
  return table;
}

/** Reset the module-level snapshot cache (tests). */
export function resetPriceCache(): void {
  cached = null;
}

/** Mirror python `str.rstrip("0123456789-")`. */
function rstripDigitsDash(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1] ?? "";
    if ((ch >= "0" && ch <= "9") || ch === "-") end--;
    else break;
  }
  return s.slice(0, end);
}

const NO_CURRENCY_MATCH = "\x00__no_currency_match__\x00";

/**
 * Mirror `_resolve_name`: return the matched canonical key, or `fallback`.
 * Longest-prefix wins among keys that prefix `model` or its base; vendor-prefix
 * fallback tries the segment after the first `/`.
 */
export function resolveName(
  model: string | null | undefined,
  table: Record<string, Record<string, number>>,
  fallback: string,
): string {
  if (!model) return fallback;
  const base = rstripDigitsDash(model.split("[")[0] ?? "");
  const candidates = Object.keys(table).filter((k) => model.startsWith(k) || base.startsWith(k));
  if (candidates.length > 0) {
    return candidates.reduce((a, b) => (b.length > a.length ? b : a));
  }
  if (model.includes("/")) {
    const inner = model.split("/").slice(1).join("/");
    const innerBase = rstripDigitsDash(inner.split("[")[0] ?? "");
    for (const k of Object.keys(table)) {
      if (inner === k || innerBase === k || inner.startsWith(k) || innerBase.startsWith(k)) {
        return k;
      }
    }
  }
  return fallback;
}

/** Mirror `_resolve`: return the matched rate dict (`{}` when fallback absent). */
export function resolve(
  model: string | null | undefined,
  table: Record<string, Record<string, number>>,
  fallback: string,
): Record<string, number> {
  const name = resolveName(model, table, fallback);
  return table[name] ?? {};
}

/**
 * Native currency code (USD/CNY) for a model. Mirror `currency_for` (FIX-162):
 * resolve with a sentinel default so a genuinely unknown model returns "USD"
 * instead of inheriting the global default's currency.
 */
export function currencyFor(model: string | null | undefined): string {
  const tbl = loadTable();
  const name = resolveName(model, tbl.prices, NO_CURRENCY_MATCH);
  if (name === NO_CURRENCY_MATCH) return "USD";
  return tbl.currency[name] ?? "USD";
}

/**
 * Round to 4 decimals, mirroring python `round(total, 4)`. CPython does
 * CORRECTLY-ROUNDED rounding of the actual binary double (round-half-to-even on
 * the true value, which for a non-exactly-representable `…5` decimal is decided
 * by whether the stored double sits just above or below the half). JS
 * `Number.prototype.toFixed(4)` performs the same correctly-rounded conversion,
 * so `Number(x.toFixed(4))` matches python `round(x, 4)` across the board —
 * including the cases where pre-multiplying by 10000 would have collapsed the
 * tiny binary offset onto an exact `.5` and mis-applied the even rule.
 */
export function round4(x: number): number {
  return Number(x.toFixed(4));
}

/** Token usage inputs for {@link computeListCost} (mirror python kwargs). */
export interface ListCostTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

/**
 * Cost (native currency) at list price for one cycle's token usage. Mirror
 * `compute_list_cost`: weighted sum / 1e6, rounded to 4 dp. Unknown models fall
 * back to the snapshot's default model rates (with no stderr warning here —
 * warnings are a caller concern).
 */
export function computeListCost(
  model: string | null | undefined,
  opts: ListCostTokens = {},
): number {
  const tbl = loadTable();
  const p = resolve(model, tbl.prices, tbl.default);
  const inT = opts.input_tokens ?? 0;
  const outT = opts.output_tokens ?? 0;
  const cwT = opts.cache_creation_tokens ?? 0;
  const crT = opts.cache_read_tokens ?? 0;
  const total =
    (inT * (p["in"] ?? 0) +
      outT * (p["out"] ?? 0) +
      cwT * (p["cache_create"] ?? 0) +
      crT * (p["cache_read"] ?? 0)) /
    1_000_000;
  return round4(total);
}

/** Active snapshot version string (mirror python `VERSION`). */
export function pricesVersion(): string {
  return loadTable().version;
}
