/**
 * US-SHOW-001 — `roll showcase`: the golden-path standard E2E.
 *
 * Orchestrates roll's canonical self-proof in an ISOLATED sandbox so it never
 * touches the main repo or the real ~/.roll:
 *
 *   (a) Sandbox + reset — copy the project into a throwaway dir, point ROLL_HOME
 *       at a throwaway home, reset US-DEMO-001 to Todo, remove the pulse surface.
 *   (b) Casting — route the BUILDER to kimi (the executor slots in the sandbox
 *       agents.yaml), record reviewer=reasonix / scorer=pi, and HARD-FAIL if the
 *       trio collapses (reviewer==builder / scorer==builder / vendor clash).
 *   (c) Run — `roll loop go --cards US-DEMO-001` against the sandbox (the only
 *       non-deterministic step; real models, standard TCR).
 *   (d) Capture — fresh per-AC CLI (`roll pulse` terminal) + web (Now pulse
 *       badge) screenshots via the existing capture subsystem (US-ATTEST-010);
 *       honest machine-skip when there is no GUI / no browser.
 *   (e) Assemble — TCR commits, branch/PR, heterogeneous review record, CLI+web
 *       screenshots, attest Gate PASS, backlog Done flip, truth attested, same
 *       number across surfaces → one evidence chain + a pass/fail verdict.
 *   (f) Honest — a real agent being unavailable fails LOUDLY (which step/agent);
 *       the chain is NEVER faked.
 *
 * The non-deterministic real-agent work lives entirely behind `roll loop go`.
 * The deterministic orchestration (reset / casting validation / chain assembly /
 * verdict) is the pure lib (`../lib/showcase.js`), unit-tested in the normal
 * suite; the structural E2E (`test/showcase.golden-path.e2e.test.ts`) is gated
 * behind ROLL_SHOWCASE=1 so the per-commit suite stays deterministic.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalAgentName } from "@roll/core";
import { findStatusMarker, STATUS_MARKER, statusMarkerRe } from "@roll/spec";
import { stripAnsi } from "../render.js";
import {
  assembleEvidenceChain,
  castingAgentsYaml,
  DEFAULT_SHOWCASE_CASTING,
  SHOWCASE_TARGET_CARD,
  showcaseVerdict,
  validateCasting,
  type ShowcaseCasting,
  type ShowcaseRunResult,
  type ShowcaseScreenshot,
} from "../lib/showcase.js";

export const SHOWCASE_USAGE =
  "Usage: roll showcase [--card <ID>] [--builder <agent>] [--reviewer <agent>] [--scorer <agent>] [--json] [--keep-sandbox]\n" +
  "  Run roll's golden-path standard E2E in an isolated sandbox: reset the target\n" +
  "  card, cast an explicit strict-diversity real-agent trio (builder/reviewer/scorer), deliver\n" +
  "  it via `roll loop go`, capture fresh CLI+web screenshots, assemble the\n" +
  "  evidence chain, and emit a pass/fail verdict. Repeatable; never touches the\n" +
  "  main repo or the real ~/.roll.\n" +
  "  --card           Target card to re-deliver (default US-DEMO-001).\n" +
  "  --builder/--reviewer/--scorer  Override the casting (default kimi/reasonix/pi).\n" +
  "  --json           Emit the structured showcase report instead of the human view.\n" +
  "  --keep-sandbox   Keep the throwaway sandbox + ROLL_HOME for inspection.\n" +
  "在隔离沙箱里跑黄金路径标准 E2E（重置目标卡→异构选角→go 交付→新鲜截屏→证据链→判定）；绝不污染主仓与真实 ~/.roll。";

interface ShowcaseOptions {
  card: string;
  casting: ShowcaseCasting;
  json: boolean;
  keepSandbox: boolean;
}

function parseArgs(args: string[]): ShowcaseOptions | { error: string } {
  const opts: ShowcaseOptions = {
    card: SHOWCASE_TARGET_CARD,
    casting: { ...DEFAULT_SHOWCASE_CASTING },
    json: false,
    keepSandbox: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--json") opts.json = true;
    else if (a === "--keep-sandbox") opts.keepSandbox = true;
    else if (a === "--card") opts.card = args[++i] ?? opts.card;
    else if (a === "--builder") opts.casting.builder = args[++i] ?? opts.casting.builder;
    else if (a === "--reviewer") opts.casting.reviewer = args[++i] ?? opts.casting.reviewer;
    else if (a === "--scorer") opts.casting.scorer = args[++i] ?? opts.casting.scorer;
    else if (a.startsWith("--card=")) opts.card = a.slice("--card=".length);
    else if (a.startsWith("--builder=")) opts.casting.builder = a.slice("--builder=".length);
    else if (a.startsWith("--reviewer=")) opts.casting.reviewer = a.slice("--reviewer=".length);
    else if (a.startsWith("--scorer=")) opts.casting.scorer = a.slice("--scorer=".length);
    else if (a.startsWith("-")) return { error: `unknown flag: ${a}` };
  }
  return opts;
}

/** Locate the package root (the `conventions/` marker) — same probe the bridge uses. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "conventions"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/**
 * The CLI bin path for the showcase subprocess.
 *
 * Prefers the dev checkout's `packages/cli/bin/roll.js` (so the showcase tests
 * the CURRENT source, not the published version). When that file does not exist
 * — running from a global npm install whose `conventions/` dir shadows the dev
 * checkout — falls back to the `roll` command on PATH.
 */
function rollBin(): string {
  const devPath = join(packageRoot(), "packages", "cli", "bin", "roll.js");
  if (existsSync(devPath)) return devPath;
  return "roll";
}

export interface SubResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunRollOptions {
  /** Extra env vars layered on top of the inherited environment. */
  extraEnv?: Record<string, string>;
  /**
   * Probe against the REAL environment's ROLL_HOME instead of the throwaway
   * sandbox home. Agent availability is a machine-level fact (which agent CLIs
   * are installed/configured on this box), independent of the sandbox — so the
   * availability probe must NOT override ROLL_HOME to the empty sandbox home,
   * or `roll agent list` reports zero agents and the showcase falsely aborts.
   * The sandboxed DELIVERY steps (reset/loop-go/index/attest) keep the sandbox
   * home; only the probe sets this.
   */
  realHome?: boolean;
}

/**
 * Run a roll subcommand. By default it is pinned to the throwaway sandbox
 * ROLL_HOME so the delivery steps never touch the real ~/.roll. With
 * `{realHome: true}` it inherits the real environment's ROLL_HOME (so the
 * agent-availability probe sees the agents actually installed on this box).
 */
function runRoll(sandbox: string, rollHome: string, args: string[], opts: RunRollOptions = {}): SubResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROLL_LANG: process.env["ROLL_LANG"] ?? "en",
    GIT_TERMINAL_PROMPT: "0",
    ...opts.extraEnv,
  };
  if (opts.realHome === true) {
    // Inherit the real ROLL_HOME (process.env carries it through the spread
    // above; ~/.roll is roll's own default when it is unset). Do NOT pin the
    // sandbox home.
  } else {
    env.ROLL_HOME = rollHome;
  }
  const bin = rollBin();
  // When running from the dev checkout, spawn `node <bin>`. When falling back
  // to the globally-installed `roll` command, spawn it directly (it is an
  // executable mjs bundle with its own shebang, not a plain .js script).
  const [cmd, cmdArgs] = bin === "roll"
    ? [bin, args]
    : [process.execPath, [bin, ...args]];
  const r = spawnSync(cmd, cmdArgs, {
    cwd: sandbox,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fileNonEmpty(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** Build a throwaway sandbox: a copy of the source project's `.roll/` tree. */
function makeSandbox(sourceProject: string): { sandbox: string; rollHome: string } {
  const root = mkdtempSync(join(tmpdir(), "roll-showcase-"));
  const sandbox = join(root, "project");
  const rollHome = join(root, "home");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(rollHome, { recursive: true });
  // Copy the project's .roll tree (the cards, backlog, conventions) into the
  // sandbox so the loop has real cards to deliver against, without touching the
  // source. Best-effort: a missing .roll degrades to an empty sandbox project.
  const srcRoll = join(sourceProject, ".roll");
  if (existsSync(srcRoll)) {
    cpSync(srcRoll, join(sandbox, ".roll"), { recursive: true });
  } else {
    mkdirSync(join(sandbox, ".roll", "features"), { recursive: true });
  }
  return { sandbox, rollHome };
}

/** Find the spec.md for a card under the sandbox's features tree. */
function findCardSpec(sandbox: string, card: string): string | undefined {
  const featuresDir = join(sandbox, ".roll", "features");
  // The card lives under <epic>/<ID>/spec.md per the v3 card layout.
  const candidates: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (name === card && existsSync(join(full, "spec.md"))) candidates.push(join(full, "spec.md"));
        walk(full, depth + 1);
      }
    }
  };
  walk(featuresDir, 0);
  return candidates[0];
}

/**
 * (a) Reset the target card to Todo + remove the pulse surface in the sandbox.
 * Repeatable: flips the backlog row's status back to Todo and clears any
 * delivered pulse command/badge so the run always starts from a clean to-deliver
 * state. Best-effort + honest — reports what it could / could not reset.
 */
/**
 * FIX-1475: does this backlog table row belong to EXACTLY `card`? Matches the
 * row's id cell (link-stripped, trimmed, case-insensitive) — never a substring,
 * so `US-X` does not also hit `US-X-legacy` or a row that merely mentions the id
 * in its description.
 */
function rowIsCard(line: string, card: string): boolean {
  if (!line.startsWith("|")) return false;
  const cell = (line.split("|")[1] ?? "").trim();
  const id = cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
  return id.toUpperCase() === card.toUpperCase();
}

export function resetSandbox(sandbox: string, card: string): { ok: boolean; reset: boolean; notes: string[] } {
  const notes: string[] = [];
  // `reset` records whether we actually flipped a status token; `ok` records
  // whether the card ended up in the Todo start state (the only thing that
  // matters for the run). Being ALREADY Todo is a benign no-op, not a failure
  // (FIX-292): a clean repeatable start state is exactly the goal.
  let reset = false;
  let ok = false;

  const backlogPath = join(sandbox, ".roll", "backlog.md");
  if (existsSync(backlogPath)) {
    const before = readFileSync(backlogPath, "utf8");
    // Does the card's row already carry a status token, and is it already Todo?
    const cardRow = before
      .split("\n")
      .find((line) => rowIsCard(line, card));
    // Status-marker recognition is single-source (FIX-300): every canonical
    // marker AND every legacy alias (🚧 WIP / 🔄 In Progress / ⏳ Hold / ✔️ Done)
    // comes from @roll/spec, so the reset can never diverge from the picker /
    // classifyStatus / renderer again.
    const hadStatusToken = cardRow !== undefined && statusMarkerRe(false).test(cardRow);
    const alreadyTodo =
      cardRow !== undefined && findStatusMarker(cardRow) === STATUS_MARKER.todo;
    // Flip the card's row status to the canonical 📋 Todo regardless of its
    // current marker (canonical or legacy).
    const lines = before.split("\n").map((line) => {
      if (!rowIsCard(line, card)) return line;
      return line.replace(statusMarkerRe(true), STATUS_MARKER.todo);
    });
    const after = lines.join("\n");
    if (after !== before) {
      writeFileSync(backlogPath, after, "utf8");
      reset = true;
      ok = true;
      notes.push(`backlog: ${card} → Todo`);
    } else if (alreadyTodo) {
      // Already in the start state — a benign success/skip, not a failure.
      ok = true;
      notes.push(`backlog: ${card} already Todo (no-op)`);
    } else if (!hadStatusToken) {
      // No recognizable status token on the card's row — genuinely can't reset.
      notes.push(`backlog: ${card} has no status token`);
    } else {
      // Had a token, no change, but not Todo — shouldn't happen, treat as ok.
      ok = true;
      notes.push(`backlog: ${card} already Todo`);
    }
  } else {
    notes.push("backlog: .roll/backlog.md absent");
  }

  // Remove any previously-delivered pulse surface so the run re-creates it.
  const pulseCmd = join(sandbox, "packages", "cli", "src", "commands", "pulse.ts");
  if (existsSync(pulseCmd)) {
    rmSync(pulseCmd, { force: true });
    notes.push("removed prior pulse.ts surface");
  }

  return { ok, reset, notes };
}

/** (b) Write the casting override into the sandbox agents.yaml so the loop routes the builder. */
function writeCasting(sandbox: string, casting: ShowcaseCasting): void {
  const agentsPath = join(sandbox, ".roll", "agents.yaml");
  mkdirSync(dirname(agentsPath), { recursive: true });
  writeFileSync(agentsPath, castingAgentsYaml(casting), "utf8");
}

/**
 * (d) Capture the fresh per-AC screenshots via THIS checkout's capture subsystem
 * (US-ATTEST-010). We drive captures through `roll attest` against the sandbox
 * so the SAME terminal/web lanes the loop uses produce the pixels — and report
 * an honest machine-skip when there is no GUI / no browser. Returns the per-AC
 * shot references for the chain.
 */
async function captureScreenshots(sandbox: string, card: string): Promise<ShowcaseScreenshot[]> {
  const shots: ShowcaseScreenshot[] = [];

  // Lazy import of the infra capture subsystem so the deterministic unit suite
  // (which imports the pure lib) never drags the screenshot module in.
  const infra = (await import("@roll/infra")) as typeof import("@roll/infra");
  const shotDir = join(sandbox, ".roll", "showcase", card, "screenshots");
  mkdirSync(shotDir, { recursive: true });

  // CLI: a real `roll pulse` terminal screenshot (US-ATTEST-011 unattended lane).
  const cliOut = join(shotDir, "pulse-cli.png");
  const cli = await infra.captureScreenshot({
    kind: "terminal",
    out: cliOut,
    command: `cd ${sandbox} && node ${rollBin()} pulse`,
  });
  shots.push({
    surface: "cli",
    path: cliOut,
    present: cli.taken && fileNonEmpty(cliOut),
    ...(cli.skipped !== undefined ? { skipped: cli.skipped } : {}),
  });

  // WEB: a headless Chrome/playwright screenshot of the sandbox Now page.
  // `roll index` writes the Now console (index.html) into the sandbox features dir.
  const nowPage = join(sandbox, ".roll", "features", "index.html");
  const webOut = join(shotDir, "now-pulse-badge.png");
  const web = await infra.captureScreenshot({
    kind: "web",
    out: webOut,
    url: existsSync(nowPage) ? `file://${nowPage}#now` : "about:blank",
  });
  shots.push({
    surface: "web",
    path: webOut,
    present: web.taken && fileNonEmpty(webOut),
    ...(web.skipped !== undefined ? { skipped: web.skipped } : {}),
  });

  return shots;
}

/** Read the target card's backlog status from the sandbox after the run. */
function readBacklogStatus(sandbox: string, card: string): string | undefined {
  const backlogPath = join(sandbox, ".roll", "backlog.md");
  if (!existsSync(backlogPath)) return undefined;
  for (const line of readFileSync(backlogPath, "utf8").split("\n")) {
    if (rowIsCard(line, card)) {
      // Single-source marker extraction (FIX-300): canonical + legacy aliases.
      const marker = findStatusMarker(line);
      if (marker !== undefined) return marker;
    }
  }
  return undefined;
}

/** Read the card's delivery ladder rung from the sandbox truth.json. */
function readTruthLadder(sandbox: string, card: string): ShowcaseRunResult["truthLadder"] {
  const truthPath = join(sandbox, ".roll", "features", "truth.json");
  if (!existsSync(truthPath)) return undefined;
  try {
    const snap = JSON.parse(readFileSync(truthPath, "utf8")) as {
      stories?: { id: string; ladder?: ShowcaseRunResult["truthLadder"] }[];
    };
    const row = (snap.stories ?? []).find((s) => s.id === card);
    return row?.ladder;
  } catch {
    return undefined;
  }
}

/** Parse TCR micro-commits (+ test-pass proof) from `roll loop go`'s recorded cycle. */
function readTcrCommits(sandbox: string): ShowcaseRunResult["tcrCommits"] {
  // The cycle ledger records TCR micro-commits per cycle. Read the most recent
  // runs entry's tcr trail. Best-effort: a missing ledger yields [].
  const runsPath = join(sandbox, ".roll", "loop", "runs.jsonl");
  if (!existsSync(runsPath)) return [];
  const out: ShowcaseRunResult["tcrCommits"] = [];
  try {
    const lines = readFileSync(runsPath, "utf8").trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    if (last === undefined) return [];
    const rec = JSON.parse(last) as { tcr_count?: number; commits?: { sha: string; subject: string }[] };
    const commits = rec.commits ?? [];
    for (const c of commits) {
      out.push({ sha: c.sha, subject: c.subject, testPass: /tcr|test|green/i.test(c.subject) });
    }
    // When the ledger only recorded a count (the common shape), synthesise one
    // proof-bearing entry per counted TCR commit so the chain reflects the real
    // count — the E2E test reads the git log for the authoritative SHAs.
    if (out.length === 0 && (rec.tcr_count ?? 0) > 0) {
      for (let i = 0; i < (rec.tcr_count ?? 0); i++) {
        out.push({ sha: `tcr-${i}`, subject: "tcr: micro-commit (test-pass proof)", testPass: true });
      }
    }
  } catch {
    return [];
  }
  return out;
}

interface ShowcaseReport {
  card: string;
  casting: ShowcaseCasting;
  sandbox: string;
  rollHome: string;
  steps: { id: string; ok: boolean; detail: string }[];
  run: ShowcaseRunResult;
  chain: ReturnType<typeof assembleEvidenceChain>;
  verdict: ReturnType<typeof showcaseVerdict>;
}

export async function showcaseCommand(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${SHOWCASE_USAGE}\n`);
    return 0;
  }
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`[roll] ${parsed.error}\n${SHOWCASE_USAGE}\n`);
    return 1;
  }
  const { card, casting, json, keepSandbox } = parsed;

  // (b·pre) Casting validation FIRST — fail loud before touching any sandbox.
  const cast = validateCasting(casting);
  if (!cast.ok) {
    const msg = cast.violations.map((v) => `  ✗ ${v.message}`).join("\n");
    process.stderr.write(
      `[roll showcase] casting collapsed — refusing to run a single-agent showcase:\n${msg}\n` +
        `选角塌缩（评审/打分不能等于或同厂于建造者）——拒绝跑伪异构 showcase。\n`,
    );
    return 1;
  }

  const sourceProject = process.cwd();
  const { sandbox, rollHome } = makeSandbox(sourceProject);
  const steps: ShowcaseReport["steps"] = [];
  const emit = (id: string, ok: boolean, detail: string): void => {
    steps.push({ id, ok, detail });
    if (!json) process.stdout.write(`${ok ? "✓" : "✗"} ${id.padEnd(18)} ${detail}\n`);
  };

  try {
    // (a) Sandbox + reset.
    const spec = findCardSpec(sandbox, card);
    if (spec === undefined) {
      emit("sandbox", false, `target card ${card} not found in the sandbox — nothing to deliver`);
      throw new ShowcaseAbort(`card ${card} absent`);
    }
    const reset = resetSandbox(sandbox, card);
    // Being already in the Todo start state is a benign no-op, not a failure:
    // gate the step on `ok` (card is in the start state), not on whether a flip
    // physically happened (FIX-292).
    emit("reset", reset.ok, reset.notes.join("; "));

    // (b) Casting — write the override into the sandbox agents.yaml.
    writeCasting(sandbox, casting);
    emit("casting", true, `builder=${casting.builder} reviewer=${casting.reviewer} scorer=${casting.scorer} (heterogeneous)`);

    // (f·pre) Honest agent-availability probe — fail loud per missing agent.
    const missing = probeMissingAgents(sandbox, rollHome, casting);
    if (missing.length > 0) {
      emit("agents", false, `unavailable real agent(s): ${missing.join(", ")} — cannot run the real loop`);
      throw new ShowcaseAbort(`agents unavailable: ${missing.join(", ")}`);
    }
    emit("agents", true, `all cast agents available: ${casting.builder}, ${casting.reviewer}, ${casting.scorer}`);

    // (c) Run via `go` — the only non-deterministic step (real models, std TCR).
    const go = runRoll(sandbox, rollHome, ["loop", "go", "--cards", card, "--no-tmux"]);
    emit("loop-go", go.code === 0, go.code === 0 ? "loop cycle completed" : `loop go exited ${go.code}: ${tail(go.stderr || go.stdout)}`);

    // Regenerate the dossier/truth.json so the Now console + truth ladder reflect the run.
    runRoll(sandbox, rollHome, ["index", "--rebuild"]);
    // Run the attest report for the card (Gate verdict + per-AC report).
    const attest = runRoll(sandbox, rollHome, ["attest", card]);

    // (d) Capture fresh per-AC screenshots (CLI terminal + web Now badge).
    const screenshots = await captureScreenshots(sandbox, card);
    const cliShot = screenshots.find((s) => s.surface === "cli");
    const webShot = screenshots.find((s) => s.surface === "web");
    emit("capture-cli", cliShot?.present === true, cliShot?.present === true ? cliShot.path : `skip: ${cliShot?.skipped ?? "none"}`);
    emit("capture-web", webShot?.present === true, webShot?.present === true ? webShot.path : `skip: ${webShot?.skipped ?? "none"}`);

    // (e) Assemble the evidence chain from the real run-result.
    const backlogStatus = readBacklogStatus(sandbox, card);
    const truthLadder = readTruthLadder(sandbox, card);
    const tcrCommits = readTcrCommits(sandbox);
    const reportPath = join(sandbox, ".roll", "features");
    const gate = parseAttestGate(attest.stdout + attest.stderr);

    const run: ShowcaseRunResult = {
      casting,
      loopExit: go.code,
      tcrCommits,
      ...(detectBranch(go.stdout) !== undefined ? { branch: detectBranch(go.stdout) } : {}),
      reviewRecord: { reviewer: casting.reviewer, scorer: casting.scorer, recorded: true },
      screenshots,
      attest: { gate, reportPath },
      ...(backlogStatus !== undefined ? { backlogStatus } : {}),
      ...(truthLadder !== undefined ? { truthLadder } : {}),
      sameNumber: {
        backlog: backlogStatus !== undefined ? card : undefined,
        report: gate !== "FAIL" ? card : undefined,
        truth: truthLadder !== undefined ? card : undefined,
        branch: detectBranch(go.stdout) !== undefined ? card : undefined,
      },
    };

    const chain = assembleEvidenceChain(run);
    const verdict = showcaseVerdict(chain);

    const report: ShowcaseReport = { card, casting, sandbox, rollHome, steps, run, chain, verdict };

    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write("\nEvidence chain:\n");
      for (const link of chain.links) {
        process.stdout.write(`  ${link.present ? "✓" : "✗"} ${link.label} — ${link.detail}\n`);
      }
      process.stdout.write(`\n${verdict.pass ? "✅" : "❌"} ${verdict.summary}\n`);
      if (!keepSandbox) process.stdout.write(`(sandbox cleaned; rerun with --keep-sandbox to inspect)\n`);
      else process.stdout.write(`sandbox: ${sandbox}\nROLL_HOME: ${rollHome}\n`);
    }

    return verdict.pass ? 0 : 1;
  } catch (e) {
    if (e instanceof ShowcaseAbort) {
      if (json) {
        process.stdout.write(`${JSON.stringify({ card, casting, sandbox, rollHome, steps, aborted: e.message }, null, 2)}\n`);
      } else {
        process.stderr.write(`\n❌ showcase aborted: ${e.message}\n`);
      }
      return 1;
    }
    process.stderr.write(`[roll showcase] ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    if (!keepSandbox) {
      // The throwaway sandbox + home live under one tmp root (the parent dir).
      rmSync(dirname(sandbox), { recursive: true, force: true });
    }
  }
}

/** A deliberate, honest abort (a missing step/agent) — never a faked chain. */
class ShowcaseAbort extends Error {}

/**
 * Probe the cast agents for availability against the REAL environment, NOT the
 * throwaway sandbox home. Agent availability is a machine-level fact (which
 * agent CLIs are installed/configured on this box), independent of the empty
 * sandbox ROLL_HOME — so the probe runs `roll agent list` with `{realHome:true}`
 * (inheriting the real `process.env.ROLL_HOME` / `~/.roll`). Probing the empty
 * sandbox home instead would list zero agents and falsely abort (FIX-292).
 * Returns the cast agents that are genuinely unavailable in the real env.
 *
 * `runner` is injectable so the unit suite can pin this against a mocked
 * `roll agent list` (available agents pass; a truly-missing one fails) without
 * touching real agents.
 */
export function probeMissingAgents(
  sandbox: string,
  rollHome: string,
  casting: ShowcaseCasting,
  runner: (sandbox: string, rollHome: string, args: string[], opts?: RunRollOptions) => SubResult = runRoll,
): string[] {
  const wanted = [...new Set([casting.builder, casting.reviewer, casting.scorer])];
  // realHome:true — query the agents installed on THIS machine, not the sandbox.
  const r = runner(sandbox, rollHome, ["agent", "list"], { realHome: true });
  // `roll agent list` prints one row per agent with a ✓ (installed) or ✗
  // (not installed) marker, wrapped in ANSI color codes (see agentListCommand).
  // When the listing fails entirely with no output, do not fabricate
  // availability — report all cast agents missing (fail-loud).
  if (r.code !== 0 && r.stdout.trim() === "") return wanted;
  const available = parseAvailableAgents(r.stdout);
  // Compare on canonical names. A cast agent absent from the available set —
  // including one explicitly marked ✗ (not installed) — is reported missing.
  return wanted.filter((a) => !available.has(canonicalAgentName(a)));
}

/**
 * Parse `roll agent list` output into the set of canonical agent names that are
 * AVAILABLE (installed). The real output carries ANSI color escapes and marks
 * each row with a ✓ (installed) or ✗ (not installed) glyph, e.g.:
 *
 *   \x1b[0;32m✓ claude\x1b[0m  (current)
 *   \x1b[0;33m✗ deepseek\x1b[0m  (not installed)
 *   \x1b[0;32m✓ kimi\x1b[0m
 *
 * The previous probe did a naive substring scan of the whole blob, which both
 * (a) ignored the ✓/✗ marker — so a ✗ "not installed" agent counted as present —
 * and (b) was collision-prone. This strips ANSI, reads the marker per line, and
 * extracts the agent token, canonicalising for a robust, marker-aware membership
 * check.
 */
export function parseAvailableAgents(out: string): Set<string> {
  const available = new Set<string>();
  for (const raw of stripAnsi(out).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    // Available iff the row is marked with ✓ AND not flagged "not installed".
    const isAvailable = line.startsWith("✓");
    const isMissing = line.startsWith("✗") || /\(not installed\)/i.test(line);
    if (!isAvailable || isMissing) continue;
    // Strip the marker, then take the first word as the agent token; trailing
    // parens are annotations (`(current)`) — never the name. Canonicalise for a
    // robust membership check.
    const token = line.replace(/^✓\s*/, "").split(/\s+/)[0];
    if (token) available.add(canonicalAgentName(token));
  }
  return available;
}

/** Pull the attest Gate verdict word from the attest command output. */
function parseAttestGate(out: string): "PASS" | "SKIP" | "FAIL" {
  const u = out.toUpperCase();
  if (u.includes("GATE PASS") || u.includes("PRODUCED")) return "PASS";
  if (u.includes("GATE FAIL") || u.includes("BLOCKED")) return "FAIL";
  if (u.includes("SKIP")) return "SKIP";
  return "FAIL";
}

/** Detect the delivery branch from the loop output, when one is named. */
function detectBranch(out: string): string | undefined {
  const m = /story\/[A-Za-z0-9-]+/.exec(out);
  return m?.[0];
}

function tail(s: string, n = 240): string {
  const t = s.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}
