/**
 * @responsibility Runs the `prices refresh` subcommand, refreshing the versioned price snapshots.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLang, t, v2Catalog } from "@roll/spec";
import { repoRoot } from "../bridge.js";

export interface Rates {
  in: number;
  out: number;
  cache_create: number;
  cache_read: number;
}

export type PriceMap = Record<string, Rates>;

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export type FetchHtml = (url: string, timeout: number) => Promise<string> | string;

interface VendorConfig {
  name: string;
  sourceUrl: string;
  currency: string;
  parse: (html: string, deps: PricesRefreshDeps) => PriceMap | Promise<PriceMap>;
}

export interface PricesRefreshDeps {
  snapshotDir?: string;
  fetchHtml?: FetchHtml;
  today?: () => string;
  stdoutIsTTY?: () => boolean;
}

export type PriceChange =
  | { kind: "added"; model: string; field: string; oldValue?: undefined; newValue: number }
  | { kind: "removed"; model: string; field: string; oldValue: number; newValue?: undefined }
  | { kind: "changed"; model: string; field: string; oldValue: number; newValue: number };

const DEFAULT_TIMEOUT = 15;
const SNAPSHOT_RE = /^snapshot-(\d{4}-\d{2}-\d{2})(?:-([a-z]+))?\.json$/;

function lang(): "en" | "zh" {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}

function pal(): { RED: string; NC: string } {
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  return { RED: noColor ? "" : "\x1b[0;31m", NC: noColor ? "" : "\x1b[0m" };
}

function err(line: string): void {
  const { RED, NC } = pal();
  process.stderr.write(`${RED}[roll]${NC} ${line}\n`);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(cellMatch[1] ?? ""));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseClaudeHtml(html: string): PriceMap {
  const modelRe = /claude-(?:opus|sonnet|haiku)-[0-9](?:-[0-9])?/;
  const dollarRe = /\$\s*([0-9]+(?:\.[0-9]+)?)/g;
  const prices: PriceMap = {};
  for (const row of tableRows(html)) {
    const text = row.join(" ");
    const model = modelRe.exec(text)?.[0];
    if (model === undefined) continue;
    const amounts = [...text.matchAll(dollarRe)].map((m) => Number(m[1]));
    if (amounts.length < 4) continue;
    const [inRate, cacheCreate, cacheRead, outRate] = amounts;
    if (inRate === undefined || cacheCreate === undefined || cacheRead === undefined || outRate === undefined) continue;
    prices[model] = { in: inRate, out: outRate, cache_create: cacheCreate, cache_read: cacheRead };
  }
  if (Object.keys(prices).length === 0) {
    throw new ParseError("no price rows found in HTML; page layout may have changed");
  }
  return prices;
}

function parseDeepseekHtml(html: string): PriceMap {
  const rows = tableRows(html);
  let modelNames: string[] = [];
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (!row.some((cell) => cell.includes("模型") || cell.includes("MODEL"))) continue;
    const names = row
      .slice(1)
      .map((cell) => cell.replace(/\s*\(\d+\)/g, "").trim())
      .filter((cell) => cell !== "");
    if (names.length >= 2) {
      modelNames = names;
      headerIdx = i;
      break;
    }
  }
  if (modelNames.length < 2) throw new ParseError("no model header row found; page layout may have changed");

  let cacheHit: number[] = [];
  let cacheMiss: number[] = [];
  let output: number[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const text = row.join(" ");
    if (!/(缓存命中|CACHE HIT|缓存未命中|CACHE MISS|输出|OUTPUT)/.test(text)) continue;
    const values = row
      .map((cell) => /(?:\$)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:元|¥)?/.exec(cell)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    if (values.length < modelNames.length) continue;
    if (/(缓存命中|CACHE HIT)/.test(text)) cacheHit = values.slice(0, modelNames.length);
    else if (/(缓存未命中|CACHE MISS)/.test(text)) cacheMiss = values.slice(0, modelNames.length);
    else if (/(输出|OUTPUT)/.test(text)) output = values.slice(0, modelNames.length);
  }
  if (cacheMiss.length === 0 || output.length === 0) {
    throw new ParseError("no price rows found in HTML; page layout may have changed");
  }

  const prices: PriceMap = {};
  for (let i = 0; i < modelNames.length; i++) {
    const model = modelNames[i];
    const miss = cacheMiss[i];
    const out = output[i];
    if (model === undefined || miss === undefined || out === undefined) continue;
    if (model !== "deepseek-v4-flash" && model !== "deepseek-v4-pro") continue;
    prices[model] = {
      in: miss,
      out,
      cache_create: miss,
      cache_read: cacheHit[i] ?? 0,
    };
  }
  if (Object.keys(prices).length === 0) {
    throw new ParseError("no price rows found in HTML; page layout may have changed");
  }
  return prices;
}

function tryParseKimiPricing(html: string): PriceMap | null {
  const prices: PriceMap = {};
  const priceRe = /¥\s*([0-9]+(?:\.[0-9]+)?)/;
  const rowRe =
    /\[\s*"([^"]+)"\s*,\s*"[^"]+"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"[^"]+"\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const model = match[1];
    const hit = priceRe.exec(match[2] ?? "")?.[1];
    const miss = priceRe.exec(match[3] ?? "")?.[1];
    const out = priceRe.exec(match[4] ?? "")?.[1];
    if (model === undefined || hit === undefined || miss === undefined || out === undefined) continue;
    prices[model] = {
      in: Number(miss),
      out: Number(out),
      cache_create: Number(miss),
      cache_read: Number(hit),
    };
  }
  return Object.keys(prices).length === 0 ? null : prices;
}

async function parseKimiHtml(html: string, deps: PricesRefreshDeps): Promise<PriceMap> {
  const direct = tryParseKimiPricing(html);
  if (direct !== null) {
    if (direct["kimi-k2.6"] !== undefined) direct["kimi-for-coding"] = { ...direct["kimi-k2.6"] };
    return direct;
  }
  const fetchHtml = deps.fetchHtml ?? realFetchHtml;
  let combined = html;
  for (const url of [
    "https://platform.kimi.com/docs/pricing/chat-k25.md",
    "https://platform.kimi.com/docs/pricing/chat-k26.md",
  ]) {
    try {
      combined += `\n${await fetchHtml(url, DEFAULT_TIMEOUT)}`;
    } catch (e) {
      throw new ParseError(`could not fetch kimi sub-page ${url}: ${String(e)}`);
    }
  }
  const prices = tryParseKimiPricing(combined);
  if (prices === null) throw new ParseError("no price rows found in kimi pages");
  if (prices["kimi-k2.6"] !== undefined) prices["kimi-for-coding"] = { ...prices["kimi-k2.6"] };
  return prices;
}

const VENDORS: Record<string, VendorConfig> = {
  anthropic: {
    name: "anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    currency: "USD",
    parse: parseClaudeHtml,
  },
  deepseek: {
    name: "deepseek",
    sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    currency: "CNY",
    parse: parseDeepseekHtml,
  },
  kimi: {
    name: "kimi",
    sourceUrl: "https://platform.kimi.com/docs/pricing/chat",
    currency: "CNY",
    parse: parseKimiHtml,
  },
};

async function realFetchHtml(url: string, timeout: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "roll/prices_fetcher" },
      signal: controller.signal,
    });
    if (!resp.ok) throw new FetchError(`could not fetch ${url}: HTTP ${resp.status}`);
    return await resp.text();
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError(`could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function vendorFromSnapshotName(name: string): string | null {
  const match = SNAPSHOT_RE.exec(name);
  if (match === null) return null;
  return match[2] ?? "anthropic";
}

function latestSnapshotPath(snapshotDir: string, vendor: string): string | null {
  if (!existsSync(snapshotDir)) return null;
  const snaps = readdirSync(snapshotDir)
    .filter((name) => SNAPSHOT_RE.test(name) && vendorFromSnapshotName(name) === vendor)
    .sort()
    .map((name) => join(snapshotDir, name));
  return snaps[snaps.length - 1] ?? null;
}

function readPrices(path: string): PriceMap {
  const data = JSON.parse(readFileSync(path, "utf8")) as { prices?: unknown };
  return (data.prices ?? {}) as PriceMap;
}

export function diffPrices(oldPrices: PriceMap, newPrices: PriceMap): PriceChange[] {
  const changes: PriceChange[] = [];
  const models = [...new Set([...Object.keys(oldPrices), ...Object.keys(newPrices)])].sort();
  for (const model of models) {
    const oldRates = oldPrices[model];
    const newRates = newPrices[model];
    if (oldRates === undefined && newRates !== undefined) {
      for (const [field, newValue] of Object.entries(newRates)) {
        changes.push({ kind: "added", model, field, newValue });
      }
      continue;
    }
    if (oldRates !== undefined && newRates === undefined) {
      for (const [field, oldValue] of Object.entries(oldRates)) {
        changes.push({ kind: "removed", model, field, oldValue });
      }
      continue;
    }
    if (oldRates === undefined || newRates === undefined) continue;
    for (const field of [...new Set([...Object.keys(oldRates), ...Object.keys(newRates)])].sort()) {
      const oldValue = oldRates[field as keyof Rates];
      const newValue = newRates[field as keyof Rates];
      if (oldValue !== newValue && oldValue !== undefined && newValue !== undefined) {
        changes.push({ kind: "changed", model, field, oldValue, newValue });
      }
    }
  }
  return changes;
}

function parsedNumber(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function snapshotNumber(n: number): string {
  return String(n);
}

export function formatDiff(changes: PriceChange[], colored: boolean): string {
  if (changes.length === 0) return "";
  const red = colored ? "\x1b[31m" : "";
  const green = colored ? "\x1b[32m" : "";
  const dim = colored ? "\x1b[2m" : "";
  const reset = colored ? "\x1b[0m" : "";
  return changes
    .map((change) => {
      if (change.kind === "added") {
        return `${green}+ ${change.model} ${change.field} = ${parsedNumber(change.newValue)}${reset}`;
      }
      if (change.kind === "removed") {
        return `${red}- ${change.model} ${change.field} = ${snapshotNumber(change.oldValue)}${reset}`;
      }
      return `${dim}~ ${change.model} ${change.field}${reset} ${red}${snapshotNumber(change.oldValue)}${reset} → ${green}${parsedNumber(change.newValue)}${reset}`;
    })
    .join("\n");
}

function pickDefault(prices: PriceMap): string {
  for (const key of Object.keys(prices)) if (key.includes("sonnet")) return key;
  return Object.keys(prices)[0] ?? "";
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}

function snapshotJson(payload: {
  version: string;
  effective_at: string;
  source_url: string;
  vendor: string;
  currency: string;
  default_model: string;
  prices: PriceMap;
}): string {
  const lines: string[] = [
    "{",
    `  "version": ${jsonString(payload.version)},`,
    `  "effective_at": ${jsonString(payload.effective_at)},`,
    `  "source_url": ${jsonString(payload.source_url)},`,
    `  "vendor": ${jsonString(payload.vendor)},`,
    `  "currency": ${jsonString(payload.currency)},`,
    `  "default_model": ${jsonString(payload.default_model)},`,
    `  "prices": {`,
  ];
  const models = Object.entries(payload.prices);
  models.forEach(([model, rates], modelIndex) => {
    lines.push(`    ${jsonString(model)}: {`);
    const fields = Object.entries(rates);
    fields.forEach(([field, value], fieldIndex) => {
      const comma = fieldIndex === fields.length - 1 ? "" : ",";
      lines.push(`      ${jsonString(field)}: ${parsedNumber(value)}${comma}`);
    });
    const comma = modelIndex === models.length - 1 ? "" : ",";
    lines.push(`    }${comma}`);
  });
  lines.push("  }", "}", "");
  return lines.join("\n");
}

function writeSnapshot(input: {
  prices: PriceMap;
  snapshotDir: string;
  sourceUrl: string;
  vendor: string;
  currency: string;
  effectiveAt: string;
}): string {
  mkdirSync(input.snapshotDir, { recursive: true });
  const suffix = input.vendor === "anthropic" ? "" : `-${input.vendor}`;
  const dest = join(input.snapshotDir, `snapshot-${input.effectiveAt}${suffix}.json`);
  writeFileSync(
    dest,
    snapshotJson({
      version: input.effectiveAt,
      effective_at: input.effectiveAt,
      source_url: input.sourceUrl,
      vendor: input.vendor,
      currency: input.currency,
      default_model: pickDefault(input.prices),
      prices: input.prices,
    }),
    "utf8",
  );
  return dest;
}

async function refresh(input: {
  snapshotDir: string;
  vendor: string;
  url: string | null;
  deps: PricesRefreshDeps;
}): Promise<{ action: string; changes: PriceChange[] }> {
  const config = VENDORS[input.vendor];
  if (config === undefined) {
    throw new ParseError(`unknown vendor ${input.vendor}`);
  }
  const sourceUrl = input.url ?? config.sourceUrl;
  const fetchHtml = input.deps.fetchHtml ?? realFetchHtml;
  const html = await fetchHtml(sourceUrl, DEFAULT_TIMEOUT);
  const newPrices = await config.parse(html, input.deps);
  const latest = latestSnapshotPath(input.snapshotDir, input.vendor);
  const effectiveAt = input.deps.today?.() ?? new Date().toISOString().slice(0, 10);
  if (latest === null) {
    const dest = writeSnapshot({
      prices: newPrices,
      snapshotDir: input.snapshotDir,
      sourceUrl,
      vendor: config.name,
      currency: config.currency,
      effectiveAt,
    });
    return { action: `first:${dest}`, changes: diffPrices({}, newPrices) };
  }
  const changes = diffPrices(readPrices(latest), newPrices);
  if (changes.length === 0) return { action: "unchanged", changes: [] };
  const dest = writeSnapshot({
    prices: newPrices,
    snapshotDir: input.snapshotDir,
    sourceUrl,
    vendor: config.name,
    currency: config.currency,
    effectiveAt,
  });
  return { action: `written:${dest}`, changes };
}

export async function pricesRefreshCommand(args: string[], deps: PricesRefreshDeps = {}): Promise<number> {
  let url: string | null = null;
  let vendor = "";
  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === "--url") {
      url = args[i + 1] ?? "";
      i += 2;
    } else if (arg === "--vendor") {
      vendor = args[i + 1] ?? "";
      i += 2;
    } else {
      err(t(v2Catalog, lang(), "prices_refresh.unknown_flag_1"));
      return 1;
    }
  }

  if (vendor !== "") {
    if (VENDORS[vendor] === undefined) {
      process.stderr.write("$(msg prices_refresh.roll_unknown_vendor_vendor)\n");
      process.stderr.write("$(msg prices_refresh.roll_known_vendors_join_sorted_vendor)\n");
      return 1;
    }
  } else {
    vendor = "anthropic";
  }

  const snapshotDir = deps.snapshotDir ?? join(repoRoot(), "lib", "prices");
  try {
    const result = await refresh({ snapshotDir, vendor, url, deps });
    if (result.action === "unchanged") {
      process.stdout.write("[roll] up to date  价格快照已是最新\n");
      return 0;
    }
    const kind = result.action.split(":", 1)[0] ?? "";
    if (kind === "first") process.stdout.write("[roll] baseline snapshot written  写入首份基线快照\n");
    else if (kind === "written") process.stdout.write("[roll] new snapshot written  写入新版价格快照\n");
    process.stdout.write(`${formatDiff(result.changes, deps.stdoutIsTTY?.() ?? Boolean(process.stdout.isTTY))}\n`);
    return 0;
  } catch (e) {
    if (e instanceof FetchError) {
      process.stderr.write(`[roll] fetch failed: ${e.message}\n`);
      process.stderr.write("[roll] keeping existing snapshot, no changes written  保留旧快照，未写入新文件\n");
      return 2;
    }
    if (e instanceof ParseError) {
      process.stderr.write(`[roll] parse failed: ${e.message}\n`);
      process.stderr.write("[roll] keeping existing snapshot, no changes written  保留旧快照，未写入新文件\n");
      return 3;
    }
    process.stderr.write(`[roll] fetch failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.stderr.write("[roll] keeping existing snapshot, no changes written  保留旧快照，未写入新文件\n");
    return 2;
  }
}
