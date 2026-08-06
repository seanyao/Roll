/**
 * @responsibility Runs the `roll supervisor journal` subcommand, reading and appending supervisor journal events.
 */
/**
 * US-OBS-048 — `roll supervisor journal` read/write surface.
 *
 * Reads and appends structured `supervisor:journal` events to the project's
 * runtime events.ndjson. This is the first real writer of the supervisor
 * narrative stream; it is intentionally explicit (manual record) so a human or
 * agent on the loop can persist decisions, verifications, and rescues.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildJournalView,
  EventBus,
  latestJournalEntry,
  nodeEventStore,
  renderJournal,
  type JournalFilter,
} from "@roll/core";
import {
  type ArtifactRef,
  type Lang,
  resolveLang,
  type RollEvent,
  SUPERVISOR_JOURNAL_ACTIONS,
  type SupervisorJournalAction,
  t,
  v3Catalog,
} from "@roll/spec";

const JOURNAL_USAGE = t(v3Catalog, "en", "supervisor.journal.usage");

function currentLang(): Lang {
  return resolveLang({
    rollLang: process.env["ROLL_LANG"],
    lcAll: process.env["LC_ALL"],
    lang: process.env["LANG"],
  });
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value !== undefined && !value.startsWith("-") ? value : undefined;
}

function argValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === undefined) continue;
    if (current === flag) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) out.push(value);
    } else if (current.startsWith(`${flag}=`)) {
      out.push(current.slice(flag.length + 1));
    }
  }
  return out;
}

function parseAction(raw: string | undefined): SupervisorJournalAction | undefined {
  if (raw === undefined) return undefined;
  if ((SUPERVISOR_JOURNAL_ACTIONS as readonly string[]).includes(raw)) return raw as SupervisorJournalAction;
  return undefined;
}

function actorFromEnv(): string {
  return process.env["ROLL_SUPERVISOR_ACTOR"] ?? process.env["USER"] ?? "owner";
}

function eventsPath(projectPath: string): string {
  return join(projectPath, ".roll", "loop", "events.ndjson");
}

function readEvents(projectPath: string): RollEvent[] {
  const path = eventsPath(projectPath);
  if (!existsSync(path)) return [];
  return new EventBus(nodeEventStore).readEvents(path);
}

function appendJournalEvent(projectPath: string, event: RollEvent): void {
  const path = eventsPath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  new EventBus(nodeEventStore).appendEvent(path, event);
}

function isoTime(ts: number): string {
  try {
    return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return String(ts);
  }
}

function renderRecordResult(entry: RollEvent & { type: "supervisor:journal" }, lang: Lang): string {
  const label = `${entry.action}@${isoTime(entry.ts)}`;
  return t(v3Catalog, lang, "supervisor.journal.recorded", label) + "\n";
}

function usage(): string {
  const lang = currentLang();
  return t(v3Catalog, lang, "supervisor.journal.usage");
}

export function supervisorJournalCommand(rawArgs: readonly string[], projectPath: string): number {
  const args = rawArgs.filter((a) => a !== "journal");
  const json = args.includes("--json");
  const noColor = args.includes("--no-color") || (process.env["NO_COLOR"] ?? "") !== "";
  if (noColor) {
    // render helpers imported by callers read process.stdout.isTTY; we do not
    // own color state here, so no side effect.
  }
  const lang = currentLang();

  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(usage());
    return 0;
  }

  const sub = args.find((a) => !a.startsWith("-"));

  if (sub === "record") {
    const action = parseAction(argValue(args, "--action"));
    if (action === undefined) {
      const raw = argValue(args, "--action");
      const message = raw === undefined
        ? t(v3Catalog, lang, "supervisor.journal.missing_action")
        : t(v3Catalog, lang, "supervisor.journal.invalid_action", raw);
      process.stderr.write(`${message}\n${usage()}`);
      return 1;
    }
    const note = argValue(args, "--note");
    const storyId = argValue(args, "--story");
    const cycleId = argValue(args, "--cycle-id");
    const evidencePaths = argValues(args, "--evidence");
    const evidence: ArtifactRef[] = evidencePaths.map((path) => ({ path, kind: "evidence" }));
    const event: RollEvent = {
      type: "supervisor:journal",
      ts: Date.now(),
      actor: actorFromEnv(),
      action,
      ...(storyId !== undefined ? { storyId } : {}),
      ...(cycleId !== undefined ? { cycleId } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
    };
    appendJournalEvent(projectPath, event);
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      process.stdout.write(renderRecordResult(event as RollEvent & { type: "supervisor:journal" }, lang));
    }
    return 0;
  }

  // Default: list/view recent entries.
  if (sub !== undefined && sub !== "list") {
    process.stderr.write(`${t(v3Catalog, lang, "supervisor.journal.invalid_action", sub)}\n${usage()}`);
    return 1;
  }

  const limitRaw = argValue(args, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const storyId = argValue(args, "--story");
  const filter: JournalFilter = {
    ...(Number.isFinite(limit) && limit !== undefined ? { limit } : {}),
    ...(storyId !== undefined ? { storyId } : {}),
  };
  const events = readEvents(projectPath);
  const view = buildJournalView(events, filter);

  if (json) {
    process.stdout.write(`${JSON.stringify({ entries: view }, null, 2)}\n`);
    return 0;
  }

  // Reuse core renderer, but prepend a concise latest summary line when a
  // specific story is filtered.
  let output = "";
  if (storyId !== undefined) {
    const latest = latestJournalEntry(events);
    if (latest !== undefined) {
      output += `  ${t(v3Catalog, lang, "supervisor.journal.latest", latest.action, latest.actor, isoTime(latest.ts))}\n`;
    }
  }
  output += renderJournal(view, lang);
  process.stdout.write(output);
  return 0;
}

