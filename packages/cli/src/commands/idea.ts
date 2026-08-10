/**
 * @responsibility Runs the `roll idea` subcommand, the single user-facing card-capture entry point.
 */
/**
 * `roll idea <description>` — THE single user-facing card-capture entry point
 * (US-PORT-003 + REFACTOR-050 card-creation unification).
 *
 * Before REFACTOR-050, `roll story new` and `roll idea` were two overlapping
 * "add a card" verbs — idea handled fast capture to backlog, story new handled
 * explicit card-folder minting. REFACTOR-050 unifies them: `roll idea` is now
 * the one user-facing entry that does EVERYTHING:
 *
 *  1. 分类 — classify the text as a bug (→ FIX) or an idea (→ IDEA).
 *  2. 自动编号 — assign the next id in that family (max numeric suffix + 1).
 *  3. 过 lint 规则 — the description must clear the SAME backlog linter the
 *     toolchain enforces (≤120 chars, no code fence / filename / path / function
 *     name). A violation is reported and the row is NOT written.
 *  4. 存取同源 — read + atomic optimistic write both go through `BacklogStore`.
 *  5. 推断 epic — light keyword-matching maps the description to a known epic
 *     slug; falls back to "uncategorized" (AC3).
 *  6. 建完整卡 — creates the full card folder (spec.md + index.html) just like
 *     `story new` did (AC1).
 *  7. 刷新索引 — rebuilds .roll/index.json and dossier aggregate pages so the
 *     new card appears immediately (FIX-231).
 *
 * `roll story new` is retained as an internal/advanced explicit channel (AC2)
 * but is no longer co-advertised as a user entry point.
 *
 * Output follows the resolved locale (single-language).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BacklogItem } from "@roll/core";
import { BacklogStore, ConflictError, IDEA_SECTIONS, appendBacklogRow, appendIdea, inferEpic, parseBacklog, planIdea } from "@roll/core";
import { type Lang, resolveLang, t, v2Catalog, v3Catalog } from "@roll/spec";
import { generateIndex } from "../lib/archive.js";
import { UNCATEGORIZED } from "../lib/archive.js";
import { renderSpecMd, renderStoryPage } from "../lib/story-page.js";
import { c, renderState } from "../render.js";

const BACKLOG_PATH = ".roll/backlog.md";
const STORY_ID_DIR_RE = /^(?:US-[A-Z]+-\d+[a-z]?|FIX-\d+[a-z]?|REFACTOR-\d+[a-z]?|IDEA-\d+[a-z]?|BUG-\d+[a-z]?)$/;

/** Locale label, single-language: v3 keys fall back to v2 keys then the key. */
function label(lang: Lang, key: string, ...args: ReadonlyArray<string | number>): string {
  if (v3Catalog[key] !== undefined) return t(v3Catalog, lang, key, ...args);
  return t(v2Catalog, lang, key, ...args);
}

function readCardFolderIds(projectPath: string): string[] {
  const featuresDir = join(projectPath, ".roll", "features");
  try {
    const epics = readdirSync(featuresDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const epic of epics) {
      if (!epic.isDirectory()) continue;
      const epicDir = join(featuresDir, epic.name);
      for (const card of readdirSync(epicDir, { withFileTypes: true })) {
        if (!card.isDirectory()) continue;
        if (!STORY_ID_DIR_RE.test(card.name)) continue;
        if (existsSync(join(epicDir, card.name, "spec.md"))) ids.push(card.name);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function cardIdsAsBacklogItems(ids: readonly string[]): BacklogItem[] {
  return ids.map((id) => ({ id, desc: "", status: "" }));
}

/** FIX-1481: injectable seams so id allocation can see the REMOTE authoritative
 *  backlog (not just the possibly-stale local file) and be unit-tested. */
export interface IdeaCommandDeps {
  /** Ids present on the remote (`origin/main`) backlog. Best-effort: returns []
   *  when the remote is unreachable so allocation degrades to local, never blocks.
   *  Called with `fetch:true` for BOTH the allocation pool and the pre-write
   *  collision re-check — the re-check must fetch fresh to see a concurrent
   *  site's just-pushed id. */
  remoteBacklogIds?: (projectPath: string, opts?: { fetch?: boolean }) => string[];
  /** Test seam for the cache refresh. A refresh failure must roll the whole
   * card creation back instead of leaving a row without its card. */
  generateIndex?: (projectPath: string) => Record<string, string>;
  /** Test seam for the atomic directory claim.  A failed claim must never make
   * cleanup remove a directory another invocation owns. */
  renameCard?: (from: string, to: string) => void;
}

type ExplicitType = "us" | "fix" | "idea";

interface ParsedIdeaArgs {
  text: string;
  explicitType?: ExplicitType;
  error?: "missing-type" | "invalid-type";
}

/** Parse the one explicit creation choice without changing legacy no-flag
 * capture behaviour.  Keeping this separate makes invalid input fail before
 * any filesystem work starts. */
function parseIdeaArgs(args: readonly string[]): ParsedIdeaArgs {
  const typeAt = args.indexOf("--type");
  const equals = args.find((arg) => arg.startsWith("--type="));
  if (typeAt !== -1 && equals !== undefined) return { text: "", error: "invalid-type" };
  let rawType: string | undefined;
  const textArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--type") {
      rawType = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--type=")) {
      rawType = arg.slice("--type=".length);
      continue;
    }
    if (!arg.startsWith("-")) textArgs.push(arg);
  }
  if (rawType === undefined && typeAt === -1 && equals === undefined) {
    return { text: textArgs.join(" ").trim() };
  }
  if (rawType === undefined || rawType.startsWith("-")) return { text: "", error: "missing-type" };
  const normalized = rawType.toLowerCase();
  if (normalized !== "us" && normalized !== "fix" && normalized !== "idea") {
    return { text: "", error: "invalid-type" };
  }
  return { text: textArgs.join(" ").trim(), explicitType: normalized };
}

/**
 * FIX-1481: read the ids on the REMOTE authoritative backlog so a new number is
 * allocated past ids that other machines have already taken but this checkout
 * has not synced yet (the multi-site collision that produced FIX-1272/1273/1473).
 * Best-effort across both layouts — nested roll-meta (`.roll` is its own repo,
 * `backlog.md` at its root) and in-repo (`.roll/backlog.md` tracked by the
 * product repo).
 *
 * When `fetch` is true (the default) a FRESH `git fetch origin main` is REQUIRED
 * for a layout to count as reachable: if the fetch fails we do NOT fall back to
 * a stale local `origin/main` ref — that layout is skipped, and if no layout can
 * refresh the result is `[]` (the caller degrades to local-only + a visible
 * hint). This is what makes the pre-write re-check able to see a concurrent
 * site's just-pushed id (AC2) and honours AC1's offline-degrade contract.
 * `fetch:false` reads the already-fetched ref without re-fetching. Any
 * git/parse failure → `[]` (degrade to local; never block capture).
 */
function realRemoteBacklogIds(projectPath: string, opts?: { fetch?: boolean }): string[] {
  const doFetch = opts?.fetch !== false;
  const layouts: Array<{ cwd: string; ref: string }> = [
    { cwd: join(projectPath, ".roll"), ref: "origin/main:backlog.md" },
    { cwd: projectPath, ref: "origin/main:.roll/backlog.md" },
  ];
  for (const { cwd, ref } of layouts) {
    if (!existsSync(cwd)) continue;
    if (doFetch) {
      try {
        execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd, stdio: "ignore", timeout: 15_000 });
      } catch {
        // Could not refresh this layout's origin/main — treat as unreachable
        // (never read a STALE ref and pass it off as authoritative). Try the
        // next layout; if none refreshes, the caller degrades to local-only.
        continue;
      }
    }
    try {
      const content = execFileSync("git", ["show", ref], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      });
      return parseBacklog(content).map((it) => it.id);
    } catch {
      /* wrong layout / no such ref — try the next */
    }
  }
  return [];
}

export function ideaCommand(args: string[], deps: IdeaCommandDeps = {}): number {
  const json = args.includes("--json");
  const noColor =
    args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;
  const lang = resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${label(lang, "ideav3.usage")}\n`);
    return 0;
  }

  const parsedArgs = parseIdeaArgs(args);
  if (parsedArgs.error !== undefined) {
    if (json) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: parsedArgs.error, allowedTypes: ["us", "fix", "idea"] })}\n`);
    } else {
      process.stderr.write(`${label(lang, parsedArgs.error === "missing-type" ? "ideav3.type_missing" : "ideav3.type_invalid")}\n${label(lang, "ideav3.usage")}\n`);
    }
    return 1;
  }
  const text = parsedArgs.text;
  if (text === "") {
    process.stderr.write(`${label(lang, "ideav3.empty")}\n${label(lang, "ideav3.usage")}\n`);
    return 1;
  }

  const RED = noColor ? "" : "\x1b[0;31m";
  const NC = noColor ? "" : "\x1b[0m";
  if (!existsSync(BACKLOG_PATH)) {
    process.stderr.write(
      `${RED}[roll]${NC} ${t(v2Catalog, lang, "backlog.roll_backlog_md_not_found_run")}\n`,
    );
    return 1;
  }

  const store = new BacklogStore();
  const snap = store.readBacklog(BACKLOG_PATH);
  const projectPath = process.cwd();
  const occupiedCardItems = cardIdsAsBacklogItems(readCardFolderIds(projectPath));
  const extraOccupiedIds: string[] = [];
  // FIX-1481: fold ids from the REMOTE authoritative backlog into the allocation
  // pool so a new number lands past what other machines have already taken but
  // this checkout has not synced. Unreachable remote → [] (degrade to local).
  const remoteIds = (deps.remoteBacklogIds ?? realRemoteBacklogIds)(projectPath, { fetch: true });
  const remoteItems = cardIdsAsBacklogItems(remoteIds);
  if (remoteIds.length === 0 && !json) {
    process.stderr.write(
      `${c("dim", lang === "zh" ? "· 远端 backlog 不可达,取号仅依据本地(可能与其他现场撞号)" : "· remote backlog unreachable — allocating from local only (may collide with other sites)")}\n`,
    );
  }
  const epic = inferEpic(text) ?? UNCATEGORIZED;
  const explicitKind = parsedArgs.explicitType === "fix" ? "bug" : parsedArgs.explicitType;
  let plan = planIdea([...snap.items, ...occupiedCardItems, ...remoteItems], text, explicitKind, epic);

  if (plan.violations.length > 0) {
    process.stderr.write(
      `${c("amber", "✗ " + label(lang, "ideav3.lint_failed", plan.violations.join(", ")))}\n`,
    );
    process.stderr.write(`  ${c("dim", label(lang, "ideav3.lint_hint"))}\n`);
    return 1;
  }

  // REFACTOR-050 AC1/AC3: create the full story card folder, same as `story new`.
  // Epic is inferred from the description text; falls back to "uncategorized".
  let cardDir = join(projectPath, ".roll", "features", epic, plan.id);
  while (existsSync(join(cardDir, "spec.md"))) {
    extraOccupiedIds.push(plan.id);
    plan = planIdea(
      [...snap.items, ...occupiedCardItems, ...remoteItems, ...cardIdsAsBacklogItems(extraOccupiedIds)],
      text,
      explicitKind,
      epic,
    );
    cardDir = join(projectPath, ".roll", "features", epic, plan.id);
  }

  // FIX-1481 AC2: fail-loud if the chosen id was taken on the remote between the
  // allocation read and now (a concurrent site minted it). This re-check FETCHES
  // fresh (fetch:true) so it actually sees the other site's just-pushed id — a
  // fetch-free read of the stale local origin/main would miss it. If the remote
  // is unreachable the seam returns [] and we proceed (can't verify → don't
  // block offline capture; the local-only degrade hint was already shown).
  const freshRemoteIds = (deps.remoteBacklogIds ?? realRemoteBacklogIds)(projectPath, { fetch: true });
  if (freshRemoteIds.includes(plan.id)) {
    process.stderr.write(
      `${RED}[roll]${NC} ${lang === "zh" ? `取号 ${plan.id} 已被其他现场占用(远端已存在)— 请重跑 roll idea` : `id ${plan.id} was just taken by another site (exists on remote) — re-run roll idea`}\n`,
    );
    return 1;
  }

  const nextBacklog = plan.kind === "us"
    ? appendBacklogRow(snap.content, { id: plan.id, title: text, epic }).content
    : appendIdea(snap.content, plan.id, plan.kind, text).content;
  const stagingRoot = join(projectPath, ".roll");
  let stagingDir: string | undefined;
  let writtenHash: string | undefined;
  let ownsCardDir = false;
  const indexPath = join(stagingRoot, "index.json");
  const previousIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : undefined;
  try {
    // Write a complete card outside its final ID path first.  A failed spec or
    // page write therefore cannot leave a discoverable partial card.
    stagingDir = mkdtempSync(join(stagingRoot, ".idea-card-"));
    const card = {
      id: plan.id,
      title: text,
      type: plan.kind === "bug" ? "bug" : plan.kind,
      epic: epic !== UNCATEGORIZED ? epic : undefined,
      created: new Date().toISOString().slice(0, 10),
    };
    writeFileSync(join(stagingDir, "spec.md"), renderSpecMd(card), "utf8");
    writeFileSync(join(stagingDir, "index.html"), renderStoryPage(card), "utf8");
    mkdirSync(join(projectPath, ".roll", "features", epic), { recursive: true });
    writtenHash = store.writeBacklog(BACKLOG_PATH, snap.hash, () => nextBacklog);
    (deps.renameCard ?? renameSync)(stagingDir, cardDir);
    stagingDir = undefined;
    ownsCardDir = true;
    (deps.generateIndex ?? generateIndex)(projectPath);
  } catch (e) {
    if (stagingDir !== undefined) rmSync(stagingDir, { recursive: true, force: true });
    // Only this invocation's successful atomic rename grants ownership.  In a
    // race, a different invocation can create cardDir between our born-once
    // check and rename; a failed rename must leave that directory untouched.
    if (ownsCardDir && existsSync(cardDir)) rmSync(cardDir, { recursive: true, force: true });
    if (previousIndex === undefined) rmSync(indexPath, { force: true });
    else writeFileSync(indexPath, previousIndex, "utf8");
    if (writtenHash !== undefined) {
      try {
        store.writeBacklog(BACKLOG_PATH, writtenHash, () => snap.content);
      } catch {
        process.stderr.write(`${RED}[roll]${NC} ${label(lang, "ideav3.rollback_failed")}\n`);
        return 1;
      }
    }
    // The optimistic-write guard fired: the backlog changed between read and
    // write. Emit a clean localized message instead of a raw stack trace.
    if (e instanceof ConflictError) {
      process.stderr.write(`${RED}[roll]${NC} ${label(lang, "ideav3.conflict")}\n`);
      return 1;
    }
    if (json) process.stderr.write(`${JSON.stringify({ ok: false, error: "write_failed" })}\n`);
    else process.stderr.write(`${RED}[roll]${NC} ${label(lang, "ideav3.write_failed")}\n`);
    return 1;
  }

  const kindLabel = label(lang, plan.kind === "bug" ? "ideav3.kind_bug" : plan.kind === "us" ? "ideav3.kind_us" : "ideav3.kind_idea");
  const section = plan.kind === "us" ? label(lang, "ideav3.kind_us") : IDEA_SECTIONS[plan.kind].replace(/^#+\s*/, "");
  const family = plan.kind === "us" ? "US" : plan.kind === "bug" ? "FIX" : "IDEA";
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, id: plan.id, family, type: plan.kind, epic, text })}\n`);
    return 0;
  }
  process.stdout.write(`\n${c("green", "📝 " + label(lang, "ideav3.recorded", plan.id))}\n\n`);
  process.stdout.write(`  ${c("dim", label(lang, "ideav3.type") + ":")}    ${kindLabel}\n`);
  process.stdout.write(`  ${c("dim", label(lang, "ideav3.section") + ":")} ${section}\n`);
  process.stdout.write(`  ${c("dim", label(lang, "ideav3.text") + ":")}    ${text}\n\n`);

  process.stdout.write(`  ${c("dim", label(lang, "ideav3.card_created", epic))}\n`);

  return 0;
}
