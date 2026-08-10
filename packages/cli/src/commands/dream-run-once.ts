/**
 * @responsibility Runs the `roll dream run-once` subcommand, driving the nightly code-health scan agent.
 */
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
import { projectIdentity } from "@roll/infra";
import { existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSpawn, realAgentSpawn } from "../runner/agent-spawn.js";
import { readSkillBody } from "../runner/skill-body.js";
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
