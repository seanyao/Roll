/**
 * `roll dream run-once` — US-PORT-008: the v3-native heart of the dream service
 * (the nightly code-health scan, skill `roll-.dream`). It is to dream what
 * `roll loop run-once` is to the loop: a thin TS entry that resolves the project,
 * loads the skill body, and drives the agent — so the generated dream runner can
 * be a SELF-CONTAINED launchd wrapper that calls no bash-engine function (the
 * FIX-197 lesson that retired the v2 zombie runner).
 *
 * Unlike `loop run-once` there is no worktree, no story pick, no TCR gate: dream
 * scans the project in place and commits its findings (.roll/dream/<date>.md +
 * appended REFACTOR rows) itself, exactly as the v2 runner did. This command
 * just spawns the agent with CWD = the project and streams its output to the
 * project-local machine log (.roll/dream/cron.log, mirroring loop's FIX-139).
 */
import { projectIdentity, createScheduler } from "@roll/infra";
import { BacklogStore, EventBus, buildDoneIndex, isEligible } from "@roll/core";
import { existsSync, appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type AgentSpawn, realAgentSpawn } from "../runner/agent-spawn.js";
import { readSkillBody } from "../runner/skill-body.js";
import { rearmLoop, type WakeDeps } from "../lib/wake-hook.js";
import { dormantMarkerPath } from "./loop-sched.js";
import { gcCommand } from "./gc.js";

interface DreamStructureScanArtifact {
  schema: "dream-structure.v1";
  generatedAt: string;
  projectRoot: string;
  graphStats: {
    files: number;
    symbols: number;
    imports: number;
    references: number;
  };
  findings: Array<unknown>;
  suppressed: Array<unknown>;
  errors: Array<unknown>;
}

interface DreamStructureScanModule {
  buildStaticProjectGraph: (input: { root: string }) => unknown;
  scanDreamStructure: (graph: unknown) => DreamStructureScanArtifact;
  renderDreamStructureLog: (result: DreamStructureScanArtifact) => string;
}

/** Injectable seams — tests fake identity + agent spawn (no real agent runs). */
export interface DreamRunOnceDeps {
  identity: () => Promise<{ path: string; slug: string }>;
  /** The agent to drive (resolved from env; default claude). */
  agent: () => string;
  /** Resolve the roll-.dream skill body (frontmatter stripped); null when absent. */
  skillBody: (projectPath: string) => string | null;
  spawn: AgentSpawn;
  now: () => Date;
  structureScan: (projectPath: string, generatedAt: string) => Promise<{ json: DreamStructureScanArtifact; log: string }>;
  /** US-LOOP-079j: re-arm a dormant loop after dream finds eligible REFACTOR work. */
  dreamReArm: (projectPath: string, slug: string) => Promise<{ rearmed: boolean; picked?: string }>;
}

function realDeps(): DreamRunOnceDeps {
  return {
    identity: () => projectIdentity(),
    agent: () =>
      (process.env["ROLL_DREAM_AGENT"] ?? process.env["ROLL_LOOP_AGENT"] ?? "claude").trim() || "claude",
    skillBody: (projectPath) =>
      readSkillBody(projectPath, {
        skillName: "roll-.dream",
        envOverride: process.env["ROLL_DREAM_SKILL"],
      }),
    spawn: realAgentSpawn,
    now: () => new Date(),
    structureScan: async (projectPath, generatedAt) => {
      const { buildStaticProjectGraph, renderDreamStructureLog, scanDreamStructure } =
        (await import("@roll/core/dist/dream/structure-scan.js")) as DreamStructureScanModule;
      const graph = buildStaticProjectGraph({ root: projectPath });
      const result = { ...scanDreamStructure(graph), generatedAt };
      return { json: result, log: renderDreamStructureLog(result) };
    },
    dreamReArm: async (projectPath, slug) => {
      // US-LOOP-079j AC1/AC3: check DORMANT marker + structure-scan findings
      // + eligible REFACTOR-DREAM backlog rows, then rearm via 079i rearmLoop.
      const dormant = dormantMarkerPath(projectPath, slug);
      if (!existsSync(dormant)) return { rearmed: false };

      const scanPath = join(projectPath, ".roll", "dream", "structure-scan.json");
      if (!existsSync(scanPath)) return { rearmed: false };

      let hasFindings = false;
      try {
        const raw = readFileSync(scanPath, "utf8");
        const parsed = JSON.parse(raw) as { findings?: unknown[] };
        hasFindings = (parsed.findings?.length ?? 0) > 0;
      } catch {
        return { rearmed: false };
      }
      if (!hasFindings) return { rearmed: false };

      const store = new BacklogStore();
      const snap = store.readBacklog(join(projectPath, ".roll", "backlog.md"));
      const isDone = buildDoneIndex(snap.items);

      for (const item of snap.items) {
        if (!item.id.startsWith("REFACTOR-DREAM-")) continue;
        if (isEligible(item, isDone)) {
          const scheduler = createScheduler(process.platform, { uid: process.getuid?.() ?? 501 });
          const loopDir = join(projectPath, ".roll", "loop");
          const launchdDir = join(homedir(), "Library", "LaunchAgents");
          const label = `com.roll.loop.${slug}`;
          const wakeDeps: WakeDeps = {
            projectPath,
            slug,
            scheduler,
            backlogPath: join(projectPath, ".roll", "backlog.md"),
            eventsPath: join(loopDir, "events.ndjson"),
            eventBus: new EventBus(),
            readBacklog: (p) => new BacklogStore().readBacklog(p),
            probe: (p) => existsSync(p),
            rename: (from, to) => renameSync(from, to),
            unlink: (p) => unlinkSync(p),
            nowSec: () => Math.floor(Date.now() / 1000),
            loopPlistPath: join(launchdDir, `${label}.plist`),
          };
          await rearmLoop("dream", wakeDeps, item.id);
          return { rearmed: true, picked: item.id };
        }
      }
      return { rearmed: false };
    },
  };
}

/**
 * The `dream run-once` entry. Returns a process exit code (0 ok). Fails LOUD
 * (exit 1, no spawn) when the skill body cannot be resolved — never burns an
 * agent on an empty workflow document (FIX-204A lesson, shared with loop).
 */
export async function dreamRunOnceCommand(
  _args: string[],
  deps: DreamRunOnceDeps = realDeps(),
): Promise<number> {
  const id = await deps.identity();
  const dreamDir = join(id.path, ".roll", "dream");
  const log = join(dreamDir, "cron.log");

  const body = deps.skillBody(id.path);
  if (body === null) {
    process.stderr.write(
      `dream run-once: roll-.dream SKILL.md not found — refusing to spawn a blind agent\n` +
        `dream run-once: 找不到 roll-.dream SKILL.md — 拒绝盲开 agent\n`,
    );
    return 1;
  }

  mkdirSync(dreamDir, { recursive: true });
  const stamp = (): string => deps.now().toISOString();
  const append = (line: string): void => {
    try {
      appendFileSync(log, line, "utf8");
    } catch {
      /* best-effort: the scan still runs */
    }
  };

  const agent = deps.agent();
  append(`[${stamp()}] dream scan start (v3 run-once, agent=${agent})\n`);
  let skillBody = body;
  try {
    append(`[${stamp()}] dream structure pre-scan start\n`);
    const preScan = await deps.structureScan(id.path, deps.now().toISOString());
    writeFileSync(join(dreamDir, "structure-scan.json"), `${JSON.stringify(preScan.json, null, 2)}\n`, "utf8");
    append(preScan.log);
    append(`[${stamp()}] dream structure pre-scan end findings=${preScan.json.findings.length}\n`);
    skillBody = [
      "# Dream deterministic structure pre-scan",
      "",
      "A deterministic TypeScript/AST structure scan has already run before this agent step.",
      "Use `.roll/dream/structure-scan.json` as the source of truth for code-structure findings.",
      "Do not re-run grep-style dead-code, duplicate-pattern, pruning, or env-var scans.",
      "Keep the existing document coverage, document freshness, and existence-drift scans unchanged.",
      "",
      preScan.log.trim(),
      "",
      body,
    ].join("\n");
  } catch (e) {
    append(`[${stamp()}] dream structure pre-scan error: ${String(e)}\n`);
  }
  let exitCode = 1;
  try {
    const result = await deps.spawn(agent, {
      cwd: id.path,
      skillBody,
      onChunk: (chunk) => append(chunk.toString("utf8")),
    });
    exitCode = result.exitCode;
  } catch (e) {
    append(`[${stamp()}] dream scan error: ${String(e)}\n`);
    process.stderr.write(`dream run-once: ${String(e)}\n`);
    return 1;
  }
  append(`[${stamp()}] dream scan end rc=${exitCode}\n`);
  // US-LOOP-113 (codex review r5): the post-scan re-arm is DISARMED. It existed to
  // wake a DORMANT loop by creating and loading `com.roll.loop.<slug>`. With
  // `roll loop off` removed, a dream scan that arms a timer nobody can disarm is the
  // same one-way trap the wake-on-command hook was. The port stays on the deps
  // interface until US-LOOP-114/115 delete the machinery outright.
  void deps.dreamReArm;
  // REFACTOR-049 AC3: auto-gc after each dream scan — best-effort, never blocks.
  try {
    const save = process.cwd();
    try {
      process.chdir(id.path);
      const realOut = process.stdout.write.bind(process.stdout);
      process.stdout.write = (): boolean => true;
      try {
        gcCommand([]);
      } finally {
        process.stdout.write = realOut;
      }
    } finally {
      try { process.chdir(save); } catch { /* best-effort */ }
    }
  } catch {
    /* gc is best-effort — a missing dir / permissions blip must never fail the scan */
  }
  return exitCode;
}
