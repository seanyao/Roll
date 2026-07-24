/**
 * `roll story new` — the SINGLE channel for minting a card folder
 * (US-META-009). Reverse-derivation audit, 2026-06-08: card creation had no
 * code-enforced shape — `roll idea` generated proper cards, but design-time
 * splits hand-wrote (or skipped) spec.md, producing frontmatter-less specs
 * and backlog rows with no card at all (US-DOSSIER-001a~d, SoloGo). Skills
 * now call this command instead of hand-writing files.
 *
 *   roll story new <ID> --title <text> [--epic <epic>] [--note <text>]
 *
 * Creates `features/<epic>/<ID>/spec.md` (frontmatter via renderSpecMd) and
 * the story page skeleton, then refreshes `.roll/index.json`. Refuses to
 * overwrite an existing spec — cards are born once, evolved by hand after.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNCATEGORIZED, generateIndex } from "../lib/archive.js";
import { BacklogStore, appendBacklogRow } from "@roll/core";
import { STORY_ID_RE } from "../lib/story-page.js";
import { writeStoryCardFiles } from "../lib/story-mint.js";
import { requireWorkspaceAuthorities } from "../lib/workspace-project-authority.js";
import {
  emitBacklogTargetError,
  type BacklogTargetDecision,
} from "./backlog-target.js";

function todayYmd(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse `--flag value` pairs; returns null on malformed input. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

export interface StoryNewCommandDeps {
  readonly resolveTarget: (args: readonly string[], operation: "mutation") => BacklogTargetDecision;
}

interface StoryNewAuthority {
  readonly projectPath: string;
  readonly backlogPath: string;
  readonly featuresDir: string;
  readonly canonical: boolean;
}

function canonicalAuthority(args: readonly string[], deps: StoryNewCommandDeps): StoryNewAuthority | number {
  const target = deps.resolveTarget(args, "mutation");
  if (!target.ok) return emitBacklogTargetError(target);
  if ("aggregate" in target) {
    process.stderr.write("story new: --all is not valid for a mutation\n");
    return 1;
  }
  return {
    projectPath: target.workspaceRoot,
    backlogPath: target.backlogPath,
    featuresDir: join(target.workspaceRoot, "features"),
    canonical: true,
  };
}

function updateCanonicalIndex(authority: StoryNewAuthority, id: string, epic: string): void {
  const path = join(authority.projectPath, "index.json");
  let stories: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const candidate = (raw as Record<string, unknown>)["stories"];
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        stories = Object.fromEntries(Object.entries(candidate).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      }
    }
  } catch {
    // A missing derived index is rebuilt from the current mutation below.
  }
  const content = `${JSON.stringify({ stories: { ...stories, [id]: epic } }, null, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

export function storyNewCommand(args: string[], deps: StoryNewCommandDeps): number {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === undefined) {
    process.stdout.write(
      "Usage: roll story new <ID> --title <text> [--epic <epic>] [--note <text>] [--no-index]\n" +
        "  The ONE card-minting entry: card folder (spec.md + index.html) + backlog row\n" +
        "  + selected Workspace index.json cache refresh (legacy: .roll/index.json). --no-index defers it;\n" +
        "  the cache is best-effort — the live locator resolves cards without it.\n" +
        "  单一建卡入口:卡夹 + backlog 行 + index.json 缓存刷新一步完成。\n" +
        "  批量建卡用 --no-index 延后缓存;缓存是尽力而为,定位器无需它即可解析卡片。\n",
    );
    return args[0] === undefined ? 1 : 0;
  }
  const id = args[0];
  if (!STORY_ID_RE.test(id)) {
    process.stderr.write(`story new: '${id}' is not a story id (US-/FIX-/REFACTOR-/IDEA-…)\nstory new: '${id}' 不是合法故事 ID\n`);
    return 2;
  }
  const title = flagValue(args, "--title");
  if (title === undefined || title === "") {
    process.stderr.write("story new: --title is required\nstory new: 必须提供 --title\n");
    return 2;
  }
  const epic = flagValue(args, "--epic") ?? UNCATEGORIZED;
  const note = flagValue(args, "--note");

  const authority = canonicalAuthority(args, deps);
  if (typeof authority === "number") return authority;
  if (authority.canonical && !requireWorkspaceAuthorities("roll story new", [
    { path: authority.backlogPath, kind: "file" },
    { path: authority.featuresDir, kind: "directory" },
  ])) return 1;
  const dir = join(authority.featuresDir, epic, id);
  if (existsSync(join(dir, "spec.md"))) {
    process.stderr.write(`story new: ${epic}/${id}/spec.md already exists — cards are born once\nstory new: 卡已存在，不可覆盖\n`);
    return 1;
  }
  const meta = {
    id,
    title,
    created: todayYmd(),
    ...(epic !== UNCATEGORIZED ? { epic } : {}),
    ...(note !== undefined && note !== "" ? { note } : {}),
  };
  writeStoryCardFiles(dir, meta);
  // FIX-250: a card is BORN with its backlog row — "单一建卡入口" was only half
  // the chain while agents still hand-appended rows. Optimistically-locked
  // write (I9); an existing row is a no-op so re-runs stay idempotent.
  let rowNote = "";
  try {
    const backlogPath = authority.backlogPath;
    if (existsSync(backlogPath)) {
      const store = new BacklogStore();
      const before = store.readBacklog(backlogPath);
      let appended = false;
      store.writeBacklog(backlogPath, before.hash, (content) => {
        const r = appendBacklogRow(content, {
          id,
          title,
          epic,
          ...(authority.canonical ? { linkPrefix: "../features" } : {}),
        });
        appended = r.appended;
        return r.content;
      });
      rowNote = appended ? `  backlog row appended (📋 Todo)\n` : `  backlog row already present — untouched\n`;
    } else {
      rowNote = "  no .roll/backlog.md — row skipped\n";
    }
  } catch (e) {
    rowNote = `  backlog row append failed (${e instanceof Error ? e.message : "?"}) — append it manually\n`;
  }
  // US-V4-001: maintain the lightweight `.roll/index.json` ID→epic CACHE at card
  // creation (best-effort; the live-first locator works without it). --no-index
  // defers even that for batch minting. The global dossier/epic page refresh is
  // NO LONGER a delivery side effect — run `roll index` to render pages on demand.
  if (!args.includes("--no-index")) {
    try {
      if (authority.canonical) updateCanonicalIndex(authority, id, epic);
      else generateIndex(authority.projectPath);
    } catch {
      /* index cache is best-effort; the locator re-derives via live walk */
    }
  }
  const displayedPath = authority.canonical
    ? `features/${epic}/${id}/spec.md`
    : `.roll/features/${epic}/${id}/spec.md`;
  process.stdout.write(`card minted\n卡已建档\n  ${displayedPath}\n${rowNote}`);
  return 0;
}
