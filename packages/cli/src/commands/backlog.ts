/**
 * `roll backlog` display mode — TS port of lib/roll-backlog.py (US-CLI-005).
 * Parses .roll/backlog.md and renders items grouped by type; management
 * subcommands (lint/unstick/sync/block/defer/unblock/promote) stay on bash.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateStoryId } from "@roll/core";
import { loadWorkspaceDiscovery } from "@roll/infra";
import { classifyStatus, resolveLang, t, v3Catalog, type Lang } from "@roll/spec";
import { c, pad, renderState, RESET_RAW, row, trunc } from "../render.js";
import {
  askDirectWorkspaceClarification,
  parseWorkspaceInteractionArgs,
  resolveWorkspaceTargetInteraction,
  type WorkspaceInteractionHost,
} from "../lib/workspace-interaction.js";
import { isCanonicalWorkspaceSelectorToken } from "../lib/workspace-selector.js";
import {
  emitBacklogTargetError,
  resolveBacklogCommandTarget,
  workspaceOwnsPath,
  type BacklogAggregateEntry,
  type BacklogOperation,
  type BacklogTargetDecision,
  type ResolvedBacklogTarget,
} from "./backlog-target.js";
import { workspaceRollHome } from "./workspace-target.js";

export const BACKLOG_MGMT_SUBCOMMANDS = [
  "lint",
  "unstick",
  "sync",
  "block",
  "defer",
  "unblock",
  "promote",
];

interface Item {
  id: string;
  link?: string;
  desc: string;
  status: string;
  reason: string;
}

const ID_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const REASON_RE = /\[([^\]]+)\]/;

function parseBacklog(path: string): Item[] {
  const items: Item[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.replace(/\n$/, "");
    if (!line.startsWith("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4) continue;
    const idCell = parts[1] ?? "";
    const descCell = parts[2] ?? "";
    const statusCell = parts[3] ?? "";
    const m = ID_RE.exec(idCell);
    const itemId = m !== null ? (m[1] ?? "") : idCell.trim();
    const link = m?.[2]?.trim();
    if (!/^(US|FIX|REFACTOR|IDEA)-/.test(itemId)) continue;
    let reason = "";
    if (classifyStatus(statusCell) === "hold") {
      const rm = REASON_RE.exec(statusCell);
      reason = rm !== null ? (rm[1] ?? "") : "";
    }
    items.push({ id: itemId, desc: descCell, status: statusCell, reason, ...(link === undefined ? {} : { link }) });
  }
  return items;
}

const MAX_DESC = 62;
const BG_RUN = "\x1b[48;2;40;20;70m";

export interface BacklogCommandDeps {
  readonly resolveTarget: (args: readonly string[], operation: BacklogOperation) => BacklogTargetDecision;
  readonly interaction?: WorkspaceInteractionHost;
}

const realBacklogCommandDeps: BacklogCommandDeps = { resolveTarget: resolveBacklogCommandTarget };

function currentLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function msg(key: string, ...args: ReadonlyArray<string | number>): string {
  return t(v3Catalog, currentLang(), key, ...args);
}

function emitError(
  code: string,
  candidates: readonly BacklogAggregateEntry[] = [],
  nextActions: readonly string[] = [],
): number {
  const key = code === "story_not_found" || code === "invalid_arguments"
    ? `backlog.error.${code}`
    : `workspace.error.${code}`;
  process.stderr.write(`${msg("backlog.error.line", code, msg(key))}\n`);
  if (candidates.length > 0) {
    process.stderr.write(`${msg("backlog.error.candidates", candidates.map((entry) => `${entry.workspaceId}=${entry.workspaceRoot}`).join(", "))}\n`);
  }
  for (const nextAction of nextActions) {
    process.stderr.write(`${msg("backlog.error.migration_command", nextAction)}\n`);
  }
  return 1;
}

function realInteractionHost(): WorkspaceInteractionHost {
  return {
    cwd: process.cwd(),
    capabilities: {
      stdinTTY: process.stdin.isTTY === true,
      stderrTTY: process.stderr.isTTY === true,
      agentQuestionCapable: false,
    },
    ask: askDirectWorkspaceClarification,
    loadDiscovery: () => loadWorkspaceDiscovery({ rollHome: workspaceRollHome() }),
  };
}

function positionalArgs(args: readonly string[]): string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all" || arg === "--no-color") continue;
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      if (args[index + 1] === undefined) return undefined;
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) return undefined;
    if (arg !== undefined) values.push(arg);
  }
  return values;
}

function renderAggregate(entries: readonly BacklogAggregateEntry[]): number {
  const lines = [msg("backlog.header")];
  for (const entry of entries) {
    if (!workspaceOwnsPath(entry.canonicalRoot, entry.backlogPath)) return emitError("invalid_target", entries);
    if (!existsSync(entry.backlogPath)) continue;
    for (const item of parseBacklog(entry.backlogPath)) {
      lines.push([entry.workspaceId, item.id, item.status, item.desc].join("\t"));
    }
  }
  if (lines.length === 1) lines.push(msg("backlog.empty"));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function showStory(target: ResolvedBacklogTarget, storyId: string): number {
  if (!existsSync(target.backlogPath)) return emitError("story_not_found");
  const item = parseBacklog(target.backlogPath).find((candidate) => candidate.id === storyId);
  const linkPath = item?.link?.split("#", 1)[0]?.split("?", 1)[0];
  if (linkPath === undefined || linkPath === "" || isAbsolute(linkPath)) return emitError("story_not_found");
  const path = linkPath.startsWith(".roll/features/")
    ? resolve(target.workspaceRoot, linkPath.slice(".roll/".length))
    : resolve(linkPath.startsWith("backlog/") ? target.workspaceRoot : dirname(target.backlogPath), linkPath);
  if (!existsSync(path)) return emitError("story_not_found");
  const canonicalPath = realpathSync(path);
  if (!contained(target.canonicalRoot, canonicalPath)) return emitError("story_not_found");
  process.stdout.write([
    msg("backlog.show.title", storyId, target.workspaceId),
    msg("backlog.show.path", canonicalPath),
    readFileSync(canonicalPath, "utf8").trimEnd(),
    "",
  ].join("\n"));
  return 0;
}

export function backlogCommand(args: string[], deps: BacklogCommandDeps = realBacklogCommandDeps): number {
  const noColor =
    args.includes("--no-color") || !process.stdout.isTTY || (process.env["NO_COLOR"] ?? "") !== "";
  renderState.useColor = !noColor;

  const interactionHost = deps.interaction ?? realInteractionHost();
  const parsedInteraction = parseWorkspaceInteractionArgs(args, interactionHost.capabilities);
  if (!parsedInteraction.ok) return emitError(parsedInteraction.code);
  const positional = positionalArgs(parsedInteraction.args);
  if (positional === undefined) return emitError("invalid_arguments");
  const show = positional[0] === "show";
  if ((show && (positional.length !== 2 || args.includes("--all"))) || (!show && positional.length !== 0)) {
    return emitError("invalid_arguments");
  }
  const storyId = show ? positional[1] : undefined;
  if (storyId !== undefined && !validateStoryId(storyId).ok) return emitError("invalid_arguments");

  const target = resolveWorkspaceTargetInteraction({
    args,
    operation: "read",
    resolveTarget: deps.resolveTarget,
    host: interactionHost,
    parsedInteraction,
  });
  if (target.kind === "interaction_failure") {
    return emitError(target.code, [], [
      ...(target.nextAction === undefined ? [] : [target.nextAction]),
      ...(target.commands ?? []),
    ]);
  }
  if (target.kind === "target_failure") {
    const failure = target.result;
    if (failure.ok) return emitError("invalid_target");
    return emitBacklogTargetError(failure);
  }
  const decision = target.result;
  if (!decision.ok) return emitBacklogTargetError(decision);
  if ("aggregate" in decision) return renderAggregate(decision.aggregate);
  if (!workspaceOwnsPath(decision.canonicalRoot, decision.backlogPath)) return emitError("invalid_target");
  if (storyId !== undefined) return showStory(decision, storyId);

  const backlog = decision.backlogPath;
  if (!existsSync(backlog)) {
    return emitError("target_missing");
  }

  const items = parseBacklog(backlog);
  const todoFix: Item[] = [];
  const todoUs: Item[] = [];
  const todoRef: Item[] = [];
  const todoIdea: Item[] = [];
  const inProgress: Item[] = [];
  const hold: Item[] = [];
  // Single typed dispatch on StoryStatus (REFACTOR-047): the renderer no longer
  // re-derives status by ad-hoc substring matching. `hold` collapses the legacy
  // 🚫 Hold / 🔒 Blocked / ⏸ Deferred markers the v2 renderer split (and was
  // blind to 🚫 Hold). Unknown markers (classifyStatus → null) drop out — Done
  // included — exactly as a non-pending row should.
  for (const it of items) {
    switch (classifyStatus(it.status)) {
      case "in_progress":
        inProgress.push(it);
        break;
      case "hold":
        hold.push(it);
        break;
      case "todo":
        if (it.id.startsWith("FIX-")) todoFix.push(it);
        else if (it.id.startsWith("US-")) todoUs.push(it);
        else if (it.id.startsWith("REFACTOR-")) todoRef.push(it);
        else if (it.id.startsWith("IDEA-")) todoIdea.push(it);
        break;
    }
  }

  const out: string[] = [];
  const todoTotal = todoFix.length + todoUs.length + todoRef.length + todoIdea.length;

  out.push(msg("backlog.title", decision.workspaceId, decision.canonicalRoot));
  out.push("");
  let tags = c("fg", `${todoTotal + inProgress.length} Pending`, { bold: true });
  if (hold.length > 0) tags += c("muted", " · ") + c("amber", `${hold.length} Hold`);
  const headerLeft =
    "  " + c("pink", "BACKLOG", { bold: true }) + c("muted", "  ·  ") + c("dim", "待处理任务");
  out.push(row(headerLeft, "  " + tags));
  out.push("");

  if (inProgress.length > 0) {
    for (const it of inProgress) {
      if (renderState.useColor) {
        const line = `  ${c("purple", "⏵")} ${c("purple", pad(it.id, 16), { bold: true })}  ${c("purple", trunc(it.desc, MAX_DESC))}`;
        out.push(BG_RUN + line + RESET_RAW);
      } else {
        out.push(`  ⏵ ${it.id}  ${it.desc}`);
      }
    }
    out.push("");
  }

  const renderGroup = (titleEn: string, titleZh: string, color: string, group: Item[]): void => {
    if (group.length === 0) return;
    out.push(
      c(color, `  ${titleEn}`, { bold: true }) + c("muted", "  ·  ") + c("dim", titleZh) +
        c("muted", `  (${group.length})`),
    );
    for (const it of group) {
      out.push(`    ${c(color, pad(it.id, 16))}  ${c(color === "dim" ? "dim" : color, trunc(it.desc, MAX_DESC))}`);
    }
    out.push("");
  };

  renderGroup("Bug Fixes", "缺陷修复", "red", todoFix);
  renderGroup("User Stories", "用户故事", "blue", todoUs);
  renderGroup("Refactors", "重构", "amber", todoRef);
  renderGroup("Ideas", "创意", "dim", todoIdea);

  if (todoTotal === 0 && inProgress.length === 0) {
    out.push(c("green", "  ✓ Nothing pending — backlog is clear  暂无待处理任务"));
    out.push("");
  }

  if (hold.length > 0) {
    out.push(
      c("amber", "  Hold", { bold: true }) + c("muted", "  ·  ") + c("dim", "已阻塞") +
        c("muted", `  (${hold.length})`),
    );
    for (const it of hold) {
      const reasonStr = it.reason !== "" ? c("muted", `  (${it.reason})`) : "";
      out.push(`  🚫 ${c("amber", pad(it.id, 16))}  ${c("dim", trunc(it.desc, 50))}${reasonStr}`);
    }
    out.push("");
  }

  out.push(c("muted", "  ") + c("dim", "triage: ") + c("blue", "roll backlog block/defer/unblock <pattern> [reason]"));
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
